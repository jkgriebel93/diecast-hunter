use once_cell::sync::Lazy;
use regex::Regex;

/// Match the legacy item id in any common eBay URL shape:
///   https://www.ebay.com/itm/123456789012
///   https://www.ebay.com/itm/Some-Title-Slug/123456789012
///   https://www.ebay.com/itm/123456789012?_skw=...&hash=...
///   123456789012  (just the id)
static ITEM_ID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^|/itm/)(?:[^/?]+/)?(?P<id>\d{9,13})(?:[/?]|$)").unwrap()
});

pub fn extract_legacy_item_id(input: &str) -> Option<String> {
    let s = input.trim();
    // Bare id case — short-circuit so we don't depend on the regex's anchors.
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) && s.len() >= 9 && s.len() <= 13 {
        return Some(s.to_string());
    }
    ITEM_ID_RE.captures(s)?.name("id").map(|m| m.as_str().to_string())
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
            extract_legacy_item_id(
                "https://www.ebay.com/itm/123456789012?_skw=foo&hash=bar"
            )
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
