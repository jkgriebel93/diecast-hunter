use chrono::DateTime;
use serde::Deserialize;

use crate::ebay::client::EbayClient;
use crate::ebay::parse::dollars_string_to_cents;
use crate::error::{AppError, AppResult};

/// Browse API GET /buy/browse/v1/item/get_item_by_legacy_id
pub async fn fetch_item_by_legacy_id(
    client: &EbayClient,
    legacy_id: &str,
) -> AppResult<EbayItem> {
    let path =
        format!("/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id={legacy_id}");
    let body = client.get(&path).await?;
    let raw: BrowseItemRaw = serde_json::from_str(&body).map_err(|e| {
        AppError::Parse(format!("ebay browse response unparseable: {e}: {body}"))
    })?;
    Ok(EbayItem::from_raw(raw, body))
}

/// Parsed and normalized eBay item, ready to persist.
#[derive(Debug, Clone)]
pub struct EbayItem {
    pub item_id: String,
    pub legacy_item_id: Option<String>,
    pub web_url: String,
    pub title: String,
    pub price_cents: Option<i64>,
    pub shipping_cents: Option<i64>,
    pub currency: String,
    pub condition: Option<String>,
    pub listing_type: Option<String>,
    pub status: String,
    pub end_time: Option<i64>,
    pub seller_username: Option<String>,
    pub seller_rating: Option<f64>,
    pub image_url: Option<String>,
    pub raw_json: String,
}

impl EbayItem {
    fn from_raw(r: BrowseItemRaw, raw_json: String) -> Self {
        let price_cents = r
            .price
            .as_ref()
            .and_then(|p| dollars_string_to_cents(&p.value));
        let currency = r
            .price
            .as_ref()
            .map(|p| p.currency.clone())
            .unwrap_or_else(|| "USD".to_string());

        // Primary shipping: the cheapest non-null shippingCost in the array.
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

        let now = chrono::Utc::now().timestamp();
        let status = match end_time {
            Some(e) if e <= now => "ended".to_string(),
            _ => "active".to_string(),
        };

        let seller_rating = r
            .seller
            .as_ref()
            .and_then(|s| s.feedback_percentage.as_deref())
            .and_then(|s| s.parse::<f64>().ok());

        let image_url = r.image.as_ref().map(|i| i.image_url.clone());

        Self {
            item_id: r.item_id.clone(),
            legacy_item_id: r.legacy_item_id.clone(),
            web_url: r.item_web_url.clone(),
            title: r.title.clone(),
            price_cents,
            shipping_cents,
            currency,
            condition: r.condition.clone(),
            listing_type,
            status,
            end_time,
            seller_username: r.seller.as_ref().map(|s| s.username.clone()),
            seller_rating,
            image_url,
            raw_json,
        }
    }
}

#[derive(Deserialize)]
struct BrowseItemRaw {
    #[serde(rename = "itemId")]
    item_id: String,
    #[serde(rename = "legacyItemId")]
    legacy_item_id: Option<String>,
    #[serde(rename = "itemWebUrl")]
    item_web_url: String,
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

#[derive(Deserialize)]
struct BrowseImage {
    #[serde(rename = "imageUrl")]
    image_url: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../fixtures/ebay/item_response.json");

    #[test]
    fn parse_fixture() {
        let raw: BrowseItemRaw = serde_json::from_str(FIXTURE).unwrap();
        let item = EbayItem::from_raw(raw, FIXTURE.to_string());
        assert_eq!(item.item_id, "v1|123456789012|0");
        assert_eq!(item.legacy_item_id.as_deref(), Some("123456789012"));
        assert_eq!(item.title, "2002 Jeff Gordon #24 Pepsi Daytona 1:24 Action ARC NASCAR Diecast");
        assert_eq!(item.price_cents, Some(4995));
        assert_eq!(item.shipping_cents, Some(750));
        assert_eq!(item.currency, "USD");
        assert_eq!(item.condition.as_deref(), Some("New"));
        assert_eq!(item.listing_type.as_deref(), Some("fixed"));
        assert_eq!(item.seller_username.as_deref(), Some("diecast_seller_42"));
        assert_eq!(item.seller_rating, Some(99.8));
        assert!(item.image_url.is_some());
    }
}
