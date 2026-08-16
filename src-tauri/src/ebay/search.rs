//! Browse API search. Wraps GET /buy/browse/v1/item_summary/search and
//! returns a normalized page of item summaries. Constrains every search to
//! the "Diecast & Toy Vehicles" parent category so results stay aligned
//! with the rest of the app's diecast filter.

use chrono::DateTime;
use serde::{Deserialize, Serialize};

use crate::ebay::client::EbayClient;
use crate::ebay::parse::dollars_string_to_cents;
use crate::error::{AppError, AppResult};

/// "Diecast & Toy Vehicles" — eBay parent category for everything we care
/// about. Subcategories (NASCAR, etc.) inherit.
pub const DIECAST_CATEGORY_ID: &str = "222";

/// User-supplied refinements layered on top of the category constraint.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SearchFilters {
    /// eBay condition tokens: "NEW", "USED", "UNSPECIFIED", etc.
    #[serde(default)]
    pub conditions: Vec<String>,
    /// Inclusive minimum price in cents (USD).
    pub price_min_cents: Option<i64>,
    /// Inclusive maximum price in cents (USD).
    pub price_max_cents: Option<i64>,
    /// "AUCTION", "FIXED_PRICE".
    #[serde(default)]
    pub buying_options: Vec<String>,
    /// Restrict results to one or more eBay seller usernames. Empty → no
    /// restriction.
    #[serde(default)]
    pub sellers: Vec<String>,
    /// "price", "-price", "newlyListed", "endingSoonest". Empty/None →
    /// eBay's default best-match ranking.
    pub sort: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchPage {
    pub items: Vec<SearchItem>,
    pub total: i64,
    pub limit: u32,
    pub offset: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchItem {
    pub item_id: String,
    pub legacy_item_id: Option<String>,
    pub title: String,
    pub price_cents: Option<i64>,
    pub shipping_cents: Option<i64>,
    pub currency: String,
    pub condition: Option<String>,
    pub listing_type: Option<String>,
    pub seller_username: Option<String>,
    pub seller_rating: Option<f64>,
    pub image_url: Option<String>,
    pub web_url: String,
    pub end_time: Option<i64>,
}

pub async fn search_diecasts(
    client: &EbayClient,
    query: &str,
    filters: &SearchFilters,
    limit: u32,
    offset: u32,
) -> AppResult<SearchPage> {
    let limit = limit.clamp(1, 200);
    // eBay caps offset at 10,000 across the search API.
    let offset = offset.min(10_000);

    let path = build_search_path(query, filters, limit, offset);
    let body = client.get(&path).await?;
    let raw: SearchResponseRaw = serde_json::from_str(&body)
        .map_err(|e| AppError::Parse(format!("ebay search response unparseable: {e}: {body}")))?;
    Ok(SearchPage::from_raw(raw, limit, offset))
}

fn build_search_path(query: &str, filters: &SearchFilters, limit: u32, offset: u32) -> String {
    let mut path = format!(
        "/buy/browse/v1/item_summary/search?category_ids={DIECAST_CATEGORY_ID}\
         &limit={limit}&offset={offset}"
    );

    let q = query.trim();
    if !q.is_empty() {
        path.push_str("&q=");
        path.push_str(&urlencode(q));
    }

    if let Some(sort) = filters
        .sort
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        path.push_str("&sort=");
        path.push_str(&urlencode(sort));
    }

    let mut filter_parts: Vec<String> = Vec::new();
    if !filters.conditions.is_empty() {
        let csv = filters.conditions.join("|");
        filter_parts.push(format!("conditions:{{{csv}}}"));
    }
    if !filters.buying_options.is_empty() {
        let csv = filters.buying_options.join("|");
        filter_parts.push(format!("buyingOptions:{{{csv}}}"));
    }
    if !filters.sellers.is_empty() {
        // eBay's `sellers` filter is pipe-delimited and case-insensitive on
        // their side. We pass the usernames through as the user typed them.
        let csv = filters.sellers.join("|");
        filter_parts.push(format!("sellers:{{{csv}}}"));
    }
    if filters.price_min_cents.is_some() || filters.price_max_cents.is_some() {
        let lo = filters
            .price_min_cents
            .map(|c| format!("{:.2}", c as f64 / 100.0))
            .unwrap_or_default();
        let hi = filters
            .price_max_cents
            .map(|c| format!("{:.2}", c as f64 / 100.0))
            .unwrap_or_default();
        filter_parts.push(format!("price:[{lo}..{hi}]"));
        filter_parts.push("priceCurrency:USD".to_string());
    }
    if !filter_parts.is_empty() {
        path.push_str("&filter=");
        path.push_str(&urlencode(&filter_parts.join(",")));
    }

    path
}

impl SearchPage {
    fn from_raw(r: SearchResponseRaw, limit: u32, offset: u32) -> Self {
        let items: Vec<SearchItem> = r
            .item_summaries
            .unwrap_or_default()
            .into_iter()
            .map(SearchItem::from_raw)
            .collect();
        let total = r.total.unwrap_or(0);
        let has_more = (offset as i64) + (items.len() as i64) < total;
        SearchPage {
            items,
            total,
            limit,
            offset,
            has_more,
        }
    }
}

impl SearchItem {
    fn from_raw(r: SearchItemRaw) -> Self {
        let price_cents = r
            .price
            .as_ref()
            .and_then(|p| dollars_string_to_cents(&p.value));
        let currency = r
            .price
            .as_ref()
            .map(|p| p.currency.clone())
            .unwrap_or_else(|| "USD".to_string());
        let shipping_cents = r.shipping_options.as_ref().and_then(|opts| {
            opts.iter()
                .filter_map(|o| {
                    o.shipping_cost
                        .as_ref()
                        .and_then(|c| dollars_string_to_cents(&c.value))
                })
                .min()
        });
        let listing_type = r.buying_options.as_ref().and_then(|opts| {
            if opts.iter().any(|o| o == "AUCTION") {
                Some("auction".to_string())
            } else if opts.iter().any(|o| o == "FIXED_PRICE") {
                Some("fixed".to_string())
            } else {
                None
            }
        });
        let end_time = r
            .item_end_date
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp());
        let seller_rating = r
            .seller
            .as_ref()
            .and_then(|s| s.feedback_percentage.as_deref())
            .and_then(|s| s.parse::<f64>().ok());
        let image_url = crate::ebay::parse::pick_image_url([
            r.image.as_ref(),
            r.thumbnail_images.as_deref().and_then(<[_]>::first),
            r.additional_images.as_deref().and_then(<[_]>::first),
        ]);

        Self {
            item_id: r.item_id,
            legacy_item_id: r.legacy_item_id,
            title: r.title,
            price_cents,
            shipping_cents,
            currency,
            condition: r.condition,
            listing_type,
            seller_username: r.seller.as_ref().map(|s| s.username.clone()),
            seller_rating,
            image_url,
            web_url: r.item_web_url,
            end_time,
        }
    }
}

#[derive(Deserialize)]
struct SearchResponseRaw {
    total: Option<i64>,
    #[serde(rename = "itemSummaries")]
    item_summaries: Option<Vec<SearchItemRaw>>,
}

#[derive(Deserialize)]
struct SearchItemRaw {
    #[serde(rename = "itemId")]
    item_id: String,
    #[serde(rename = "legacyItemId")]
    legacy_item_id: Option<String>,
    title: String,
    price: Option<BrowsePrice>,
    #[serde(rename = "shippingOptions")]
    shipping_options: Option<Vec<BrowseShippingOption>>,
    condition: Option<String>,
    #[serde(rename = "buyingOptions")]
    buying_options: Option<Vec<String>>,
    #[serde(rename = "itemEndDate")]
    item_end_date: Option<String>,
    seller: Option<BrowseSeller>,
    image: Option<BrowseImage>,
    #[serde(rename = "thumbnailImages")]
    thumbnail_images: Option<Vec<BrowseImage>>,
    #[serde(rename = "additionalImages")]
    additional_images: Option<Vec<BrowseImage>>,
    #[serde(rename = "itemWebUrl")]
    item_web_url: String,
}

#[derive(Deserialize)]
struct BrowsePrice {
    value: String,
    currency: String,
}

#[derive(Deserialize)]
struct BrowseShippingOption {
    #[serde(rename = "shippingCost")]
    shipping_cost: Option<BrowsePrice>,
}

#[derive(Deserialize)]
struct BrowseSeller {
    username: String,
    #[serde(rename = "feedbackPercentage")]
    feedback_percentage: Option<String>,
}

use crate::ebay::parse::EbayImage as BrowseImage;

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../fixtures/ebay/search_response.json");

    #[test]
    fn parse_fixture() {
        let raw: SearchResponseRaw = serde_json::from_str(FIXTURE).unwrap();
        let page = SearchPage::from_raw(raw, 2, 0);
        assert_eq!(page.total, 314);
        assert_eq!(page.items.len(), 2);
        assert!(page.has_more);

        let first = &page.items[0];
        assert_eq!(first.item_id, "v1|123456789012|0");
        assert_eq!(first.legacy_item_id.as_deref(), Some("123456789012"));
        assert_eq!(first.price_cents, Some(4995));
        assert_eq!(first.shipping_cents, Some(750));
        assert_eq!(first.condition.as_deref(), Some("New"));
        assert_eq!(first.listing_type.as_deref(), Some("fixed"));
        assert_eq!(first.seller_username.as_deref(), Some("diecast_seller_42"));
        assert_eq!(first.seller_rating, Some(99.8));
        assert!(first.image_url.is_some());

        let second = &page.items[1];
        assert_eq!(second.listing_type.as_deref(), Some("auction"));
        assert_eq!(second.shipping_cents, None);
    }

    #[test]
    fn has_more_false_on_last_page() {
        let raw: SearchResponseRaw = serde_json::from_str(FIXTURE).unwrap();
        // Pretend offset puts us at the tail.
        let page = SearchPage::from_raw(raw, 2, 312);
        assert!(!page.has_more);
    }

    #[test]
    fn build_path_no_query_no_filters() {
        let path = build_search_path("", &SearchFilters::default(), 50, 0);
        assert_eq!(
            path,
            "/buy/browse/v1/item_summary/search?category_ids=222&limit=50&offset=0"
        );
    }

    #[test]
    fn build_path_with_query_and_sort() {
        let filters = SearchFilters {
            sort: Some("newlyListed".to_string()),
            ..Default::default()
        };
        let path = build_search_path("jeff gordon", &filters, 25, 50);
        assert!(path.contains("&q=jeff+gordon"));
        assert!(path.contains("&sort=newlyListed"));
        assert!(path.contains("&limit=25"));
        assert!(path.contains("&offset=50"));
    }

    #[test]
    fn build_path_with_sellers() {
        let filters = SearchFilters {
            sellers: vec!["seller_a".into(), "seller_b".into()],
            sort: Some("newlyListed".into()),
            ..Default::default()
        };
        let path = build_search_path("", &filters, 50, 0);
        let decoded = url::form_urlencoded::parse(path.split('?').nth(1).unwrap().as_bytes())
            .into_owned()
            .collect::<std::collections::HashMap<_, _>>();
        let filter = decoded.get("filter").expect("filter param missing");
        assert!(
            filter.contains("sellers:{seller_a|seller_b}"),
            "got: {filter}"
        );
    }

    #[test]
    fn build_path_with_conditions_and_price() {
        let filters = SearchFilters {
            conditions: vec!["NEW".into(), "USED".into()],
            buying_options: vec!["FIXED_PRICE".into()],
            sellers: vec![],
            price_min_cents: Some(1000),
            price_max_cents: Some(5000),
            sort: None,
        };
        let path = build_search_path("", &filters, 50, 0);
        let decoded = url::form_urlencoded::parse(path.split('?').nth(1).unwrap().as_bytes())
            .into_owned()
            .collect::<std::collections::HashMap<_, _>>();
        let filter = decoded.get("filter").expect("filter param missing");
        assert!(filter.contains("conditions:{NEW|USED}"), "got: {filter}");
        assert!(
            filter.contains("buyingOptions:{FIXED_PRICE}"),
            "got: {filter}"
        );
        assert!(filter.contains("price:[10.00..50.00]"), "got: {filter}");
        assert!(filter.contains("priceCurrency:USD"), "got: {filter}");
    }
}
