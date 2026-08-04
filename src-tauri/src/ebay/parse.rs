use once_cell::sync::Lazy;
use regex::Regex;

/// Match the legacy item id in any common eBay URL shape:
///   https://www.ebay.com/itm/123456789012
///   https://www.ebay.com/itm/Some-Title-Slug/123456789012
///   https://www.ebay.com/itm/123456789012?_skw=...&hash=...
///   123456789012  (just the id)
static ITEM_ID_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|/itm/)(?:[^/?]+/)?(?P<id>\d{9,13})(?:[/?]|$)").unwrap());

pub fn extract_legacy_item_id(input: &str) -> Option<String> {
    let s = input.trim();
    // Bare id case — short-circuit so we don't depend on the regex's anchors.
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) && s.len() >= 9 && s.len() <= 13 {
        return Some(s.to_string());
    }
    ITEM_ID_RE
        .captures(s)?
        .name("id")
        .map(|m| m.as_str().to_string())
}

/// Browse API v1 ids look like "v1|123456789012|0" or
/// "v1|123456789012|987654321"; the middle segment is the legacy id eBay
/// surfaces in URLs and Trading-API requests.
pub fn legacy_id_from_v1(v1: &str) -> Option<String> {
    let mut parts = v1.split('|');
    let _ = parts.next()?;
    let legacy = parts.next()?;
    if !legacy.is_empty() && legacy.chars().all(|c| c.is_ascii_digit()) {
        Some(legacy.to_string())
    } else {
        None
    }
}

/// Why an ended listing ended, derived from the Browse API payload we
/// preserved in `listings.raw_json`: "sold" when eBay reports the item out
/// of stock (fixed-price bought out) or an auction closed with at least one
/// bid; "ended" (unsold — expired or seller-ended) otherwise. Lenient on
/// missing fields so pre-archival rows with older payload shapes still get
/// a reason.
pub fn end_reason_from_raw(raw_json: &str) -> &'static str {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw_json) else {
        return "ended";
    };
    let out_of_stock = v
        .get("estimatedAvailabilities")
        .and_then(|a| a.as_array())
        .is_some_and(|avails| {
            avails.iter().any(|a| {
                a.get("estimatedAvailabilityStatus")
                    .and_then(|s| s.as_str())
                    == Some("OUT_OF_STOCK")
            })
        });
    let has_bids = v
        .get("bidCount")
        .and_then(|b| b.as_i64())
        .is_some_and(|b| b > 0);
    if out_of_stock || has_bids {
        "sold"
    } else {
        "ended"
    }
}

/// True when an eBay API error message (see `client::get`'s
/// "ebay api {url} returned {status}: {body}" format) says the item no
/// longer exists on eBay: HTTP 404, or Browse errorId 11001 ("item Id was
/// not found"). Distinguishes seller-removed/expired-beyond-retention
/// listings from transient failures during watchlist sync.
pub fn is_item_not_found_error(msg: &str) -> bool {
    msg.contains("\"errorId\":11001") || msg.contains(" returned 404")
}

pub fn dollars_string_to_cents(s: &str) -> Option<i64> {
    let cleaned: String = s
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let f: f64 = cleaned.parse().ok()?;
    Some((f * 100.0).round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_clean() {
        assert_eq!(
            extract_legacy_item_id("https://www.ebay.com/itm/123456789012").as_deref(),
            Some("123456789012")
        );
    }

    #[test]
    fn url_with_title_slug() {
        assert_eq!(
            extract_legacy_item_id(
                "https://www.ebay.com/itm/2002-Jeff-Gordon-Pepsi-Daytona/123456789012"
            )
            .as_deref(),
            Some("123456789012")
        );
    }

    #[test]
    fn url_with_query() {
        assert_eq!(
            extract_legacy_item_id("https://www.ebay.com/itm/123456789012?_skw=foo&hash=bar")
                .as_deref(),
            Some("123456789012")
        );
    }

    #[test]
    fn bare_id() {
        assert_eq!(
            extract_legacy_item_id("123456789012").as_deref(),
            Some("123456789012")
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(extract_legacy_item_id("not a url"), None);
        assert_eq!(extract_legacy_item_id(""), None);
        assert_eq!(extract_legacy_item_id("https://example.com/abc"), None);
    }

    #[test]
    fn cents_simple() {
        assert_eq!(dollars_string_to_cents("29.99"), Some(2999));
        assert_eq!(dollars_string_to_cents("100.00"), Some(10000));
        assert_eq!(dollars_string_to_cents("0.50"), Some(50));
    }

    #[test]
    fn end_reason_sold_out_of_stock() {
        // Fixed-price listing bought out: eBay reports OUT_OF_STOCK.
        let raw = r#"{"itemId":"v1|123|0",
            "estimatedAvailabilities":[{"estimatedAvailabilityStatus":"OUT_OF_STOCK"}]}"#;
        assert_eq!(end_reason_from_raw(raw), "sold");
    }

    #[test]
    fn end_reason_sold_auction_with_bids() {
        let raw = r#"{"itemId":"v1|123|0","bidCount":7,
            "estimatedAvailabilities":[{"estimatedAvailabilityStatus":"IN_STOCK"}]}"#;
        assert_eq!(end_reason_from_raw(raw), "sold");
    }

    #[test]
    fn end_reason_ended_unsold() {
        let raw = r#"{"itemId":"v1|123|0","bidCount":0,
            "estimatedAvailabilities":[{"estimatedAvailabilityStatus":"IN_STOCK"}]}"#;
        assert_eq!(end_reason_from_raw(raw), "ended");
    }

    #[test]
    fn end_reason_lenient_on_missing_fields() {
        assert_eq!(end_reason_from_raw(r#"{"itemId":"v1|123|0"}"#), "ended");
        assert_eq!(end_reason_from_raw("not json"), "ended");
        assert_eq!(end_reason_from_raw(""), "ended");
    }

    #[test]
    fn not_found_detection() {
        assert!(is_item_not_found_error(
            "network error: ebay api https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=123 returned 404 Not Found: {\"errors\":[{\"errorId\":11001,\"domain\":\"API_BROWSE\",\"category\":\"REQUEST\",\"message\":\"The specified item Id was not found.\"}]}"
        ));
        assert!(is_item_not_found_error(
            "ebay api https://api.ebay.com/x returned 404 Not Found: gone"
        ));
        assert!(!is_item_not_found_error(
            "ebay api https://api.ebay.com/x returned 500 Internal Server Error: oops"
        ));
        assert!(!is_item_not_found_error(
            "ebay api https://api.ebay.com/x returned 400 Bad Request: {\"errors\":[{\"errorId\":11006}]}"
        ));
    }

    #[test]
    fn legacy_from_v1_id() {
        assert_eq!(
            legacy_id_from_v1("v1|123456789012|0").as_deref(),
            Some("123456789012")
        );
        assert_eq!(
            legacy_id_from_v1("v1|123456789012|987654321").as_deref(),
            Some("123456789012")
        );
        assert_eq!(legacy_id_from_v1("123456789012"), None);
        assert_eq!(legacy_id_from_v1("v1|abc|0"), None);
        assert_eq!(legacy_id_from_v1(""), None);
    }
}
