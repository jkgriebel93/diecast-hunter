//! Parse an eBay saved-search URL (the legacy
//! `https://www.ebay.com/sch/i.html?_nkw=…&LH_BIN=1&_udlo=10&_udhi=75&_sop=10`
//! style) into the same `SearchFilters` shape that the Browse API uses.
//!
//! Lossy on purpose: eBay supports dozens of `_xyz` query params and many
//! aren't expressible in the Browse API's `filter=` syntax. We extract the
//! ones we actually surface in the UI (keywords, price range, condition,
//! buying options, sort) and drop the rest. The caller pairs the extracted
//! filters with the eBay-side search ID and name so renames/edits round-trip.

use std::collections::HashMap;

use crate::ebay::search::SearchFilters;

#[derive(Debug, Clone, Default)]
pub struct ParsedSearchUrl {
    pub keywords: String,
    pub filters: SearchFilters,
}

/// Best-effort parse. Always returns a `ParsedSearchUrl` — missing fields
/// just stay at their defaults.
pub fn parse_search_url(url: &str) -> ParsedSearchUrl {
    let params = query_params(url);

    let keywords = params
        .get("_nkw")
        .map(|s| s.replace('+', " "))
        .unwrap_or_default();

    let mut buying_options = Vec::new();
    if params.get("LH_BIN").map(|s| s.as_str()) == Some("1") {
        buying_options.push("FIXED_PRICE".to_string());
    }
    if params.get("LH_Auction").map(|s| s.as_str()) == Some("1") {
        buying_options.push("AUCTION".to_string());
    }

    let mut conditions = Vec::new();
    // LH_ItemCondition is a comma-separated list of eBay condition IDs.
    // 1000 = New, 3000/4000/5000/6000 = various Used grades; we collapse
    // anything except 1000 to USED so it matches our UI chips.
    if let Some(raw) = params.get("LH_ItemCondition") {
        for id in raw.split(',') {
            match id.trim() {
                "1000" => {
                    if !conditions.iter().any(|c| c == "NEW") {
                        conditions.push("NEW".into());
                    }
                }
                "" => {}
                _ => {
                    if !conditions.iter().any(|c| c == "USED") {
                        conditions.push("USED".into());
                    }
                }
            }
        }
    }

    let price_min_cents = params.get("_udlo").and_then(|s| dollars_to_cents(s));
    let price_max_cents = params.get("_udhi").and_then(|s| dollars_to_cents(s));

    // _sop is eBay's numeric sort code. Common values:
    //   10 = ending soonest, 15 = price low→high, 16 = price high→low,
    //   12 = newly listed (default), 1 = best match.
    let sort = params
        .get("_sop")
        .and_then(|s| match s.as_str() {
            "10" => Some("endingSoonest".to_string()),
            "15" => Some("price".to_string()),
            "16" => Some("-price".to_string()),
            "12" => Some("newlyListed".to_string()),
            _ => None,
        });

    ParsedSearchUrl {
        keywords,
        filters: SearchFilters {
            conditions,
            buying_options,
            sellers: Vec::new(),
            price_min_cents,
            price_max_cents,
            sort,
        },
    }
}

fn query_params(url: &str) -> HashMap<String, String> {
    let qs = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    url::form_urlencoded::parse(qs.as_bytes())
        .into_owned()
        .collect()
}

fn dollars_to_cents(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    let f: f64 = trimmed.parse().ok()?;
    if !f.is_finite() || f < 0.0 {
        return None;
    }
    Some((f * 100.0).round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_url() {
        let url = "https://www.ebay.com/sch/i.html?_nkw=jeff+gordon+dupont+1%3A24&_sacat=222&LH_BIN=1&_udlo=10&_udhi=75&LH_ItemCondition=1000&_sop=12";
        let p = parse_search_url(url);
        assert_eq!(p.keywords, "jeff gordon dupont 1:24");
        assert_eq!(p.filters.buying_options, vec!["FIXED_PRICE"]);
        assert_eq!(p.filters.conditions, vec!["NEW"]);
        assert_eq!(p.filters.price_min_cents, Some(1000));
        assert_eq!(p.filters.price_max_cents, Some(7500));
        assert_eq!(p.filters.sort.as_deref(), Some("newlyListed"));
    }

    #[test]
    fn empty_url_yields_defaults() {
        let p = parse_search_url("");
        assert_eq!(p.keywords, "");
        assert!(p.filters.conditions.is_empty());
        assert!(p.filters.buying_options.is_empty());
        assert!(p.filters.price_min_cents.is_none());
    }

    #[test]
    fn collapses_used_condition_grades() {
        let url = "https://www.ebay.com/sch/i.html?_nkw=test&LH_ItemCondition=3000,4000";
        let p = parse_search_url(url);
        assert_eq!(p.filters.conditions, vec!["USED"]);
    }

    #[test]
    fn mixed_auction_and_bin() {
        let url = "https://www.ebay.com/sch/i.html?_nkw=test&LH_BIN=1&LH_Auction=1";
        let p = parse_search_url(url);
        assert!(p.filters.buying_options.contains(&"FIXED_PRICE".into()));
        assert!(p.filters.buying_options.contains(&"AUCTION".into()));
    }
}
