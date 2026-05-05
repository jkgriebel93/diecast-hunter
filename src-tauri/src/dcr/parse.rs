use once_cell::sync::Lazy;
use regex::Regex;

/// Parse "$88.00" or "$1,013.00" into cents.
pub fn dollars_to_cents(s: &str) -> Option<i64> {
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

static SCALE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?P<scale>\d{1,3}:\d{1,3})\b").unwrap());

#[derive(Debug, PartialEq, Eq)]
pub struct DetailsLine {
    pub year: i32,
    pub oem: String,
    pub brand: Option<String>,
    pub scale: String,
    pub make: String,
}

/// Parses lines like "2002 Action / Lionel ARC 1:24 CWC" or
/// "1998 Racing Champions  1:24 CWC" (note the double space when brand is
/// absent — that's our signal).
///
/// Whitespace MUST be preserved by the caller (do not collapse internal
/// spaces) for this to correctly distinguish "no brand" from "single-word
/// brand".
pub fn parse_details_line(raw: &str) -> Option<DetailsLine> {
    let s = raw.trim_end();
    if s.len() < 4 {
        return None;
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    let after_year = s.get(5..)?; // skip "YYYY "

    let m = SCALE_RE.find(after_year)?;
    let oem_brand_raw = &after_year[..m.start()];
    let scale = m.as_str().to_string();
    let make = after_year[m.end()..].trim().to_string();
    if make.is_empty() {
        return None;
    }

    // If the original text had two-or-more spaces immediately before the
    // scale, the brand slot is empty.
    let no_brand = oem_brand_raw.ends_with("  ");
    let trimmed = oem_brand_raw.trim();
    let (oem, brand) = if no_brand {
        (trimmed.to_string(), None)
    } else {
        split_oem_brand_inner(trimmed)
    };

    Some(DetailsLine {
        year,
        oem,
        brand,
        scale,
        make,
    })
}

/// Split "Action / Lionel ARC" into ("Action / Lionel", Some("ARC")).
/// The brand is the trailing whitespace-delimited token IF it doesn't itself
/// contain '/'; otherwise the whole string is the OEM (e.g. plain "Revell").
fn split_oem_brand_inner(s: &str) -> (String, Option<String>) {
    if let Some(idx) = s.rfind(' ') {
        let (left, right) = s.split_at(idx);
        let right = right.trim();
        let left = left.trim();
        if !right.is_empty()
            && !right.contains('/')
            && !left.is_empty()
        {
            return (left.to_string(), Some(right.to_string()));
        }
    }
    (s.to_string(), None)
}

static SEQ_PRODUCED_RE: Lazy<Regex> = Lazy::new(|| {
    // "(37836)"           → total 37836
    // "(#377 / 1002)"     → seq 377, total 1002
    // "(9999)"            → total 9999
    Regex::new(r"\(\s*(?:#(?P<seq>[\d,]+)\s*/\s*)?(?P<total>[\d,]+)\s*\)").unwrap()
});

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SeqProduced {
    pub sequence: Option<i64>,
    pub total: Option<i64>,
}

pub fn parse_seq_produced(s: &str) -> SeqProduced {
    let mut out = SeqProduced::default();
    if let Some(caps) = SEQ_PRODUCED_RE.captures(s) {
        out.sequence = caps
            .name("seq")
            .and_then(|m| m.as_str().replace(',', "").parse().ok());
        out.total = caps
            .name("total")
            .and_then(|m| m.as_str().replace(',', "").parse().ok());
    }
    out
}

static REGISTRY_INT_ID_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"/diecast/[^/]+/[^/]+/[^/]+/(\d+)").unwrap());

pub fn registry_int_id_from_url(url: &str) -> Option<i64> {
    REGISTRY_INT_ID_RE
        .captures(url)?
        .get(1)?
        .as_str()
        .parse()
        .ok()
}

static FEEDBACK_GUID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"/(?P<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/Feedback/DiecastValue").unwrap()
});

pub fn registry_guid_from_feedback_url(url: &str) -> Option<String> {
    FEEDBACK_GUID_RE
        .captures(url)?
        .name("id")
        .map(|m| m.as_str().to_string())
}

static ASSET_GUID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^asset(?P<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$").unwrap()
});

pub fn asset_guid_from_id_attr(id_attr: &str) -> Option<String> {
    ASSET_GUID_RE
        .captures(id_attr)?
        .name("id")
        .map(|m| m.as_str().to_string())
}

pub fn normalize_driver_name(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

/// Shared pagination parser for the diecastregistry.com Bootstrap pager
/// markup that's used on /MyGarage, /Production, and the registry views.
/// Returns (current_page, total_pages); both default to 1 when no pager
/// is rendered (e.g. single-page result).
pub fn parse_pagination(doc: &scraper::Html) -> (u32, u32) {
    use scraper::Selector;
    let pagination_sel = Selector::parse("ul.pagination").unwrap();
    let li_sel = Selector::parse("li").unwrap();
    let a_sel = Selector::parse("a").unwrap();

    let mut current = 1u32;
    let mut max = 1u32;

    if let Some(ul) = doc.select(&pagination_sel).next() {
        for li in ul.select(&li_sel) {
            let is_active = li.value().classes().any(|c| c == "active");
            if let Some(a) = li.select(&a_sel).next() {
                let text: String = a.text().collect();
                if let Ok(n) = text.trim().parse::<u32>() {
                    if is_active {
                        current = n;
                    }
                    if n > max {
                        max = n;
                    }
                }
            }
        }
    }

    (current, max.max(current))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dollars() {
        assert_eq!(dollars_to_cents("$88.00"), Some(8800));
        assert_eq!(dollars_to_cents("$1,013.00"), Some(101300));
        assert_eq!(dollars_to_cents("$0.50"), Some(50));
    }

    #[test]
    fn details_with_brand() {
        let d = parse_details_line("2002 Action / Lionel ARC 1:24 CWC").unwrap();
        assert_eq!(d.year, 2002);
        assert_eq!(d.oem, "Action / Lionel");
        assert_eq!(d.brand.as_deref(), Some("ARC"));
        assert_eq!(d.scale, "1:24");
        assert_eq!(d.make, "CWC");
    }

    #[test]
    fn details_make_with_space() {
        let d = parse_details_line("2000 Action / Lionel RCCA 1:24 Bank CWB").unwrap();
        assert_eq!(d.oem, "Action / Lionel");
        assert_eq!(d.brand.as_deref(), Some("RCCA"));
        assert_eq!(d.make, "Bank CWB");
    }

    #[test]
    fn details_no_brand_double_space() {
        // Note the two spaces between "Champions" and "1:24" — that's the
        // signal that the brand slot is empty.
        let d = parse_details_line("1998 Racing Champions  1:24 CWC").unwrap();
        assert_eq!(d.oem, "Racing Champions");
        assert_eq!(d.brand, None);
        assert_eq!(d.scale, "1:24");
    }

    #[test]
    fn details_brand_with_separator() {
        let d = parse_details_line("1995 Racing Champions RC - Premier 1:24 Supertruck").unwrap();
        assert_eq!(d.oem, "Racing Champions RC -");
        assert_eq!(d.brand.as_deref(), Some("Premier"));
        // Imperfect: "RC - Premier" is really one brand. Master-registry sync
        // (M3) supplies authoritative OEM/brand from the detail page; this
        // collection-row parser is best-effort.
    }

    #[test]
    fn seq_produced_total_only() {
        let s = parse_seq_produced("(37836)");
        assert_eq!(s.total, Some(37836));
        assert_eq!(s.sequence, None);
    }

    #[test]
    fn seq_produced_full() {
        let s = parse_seq_produced("(#1832 / 2016)");
        assert_eq!(s.sequence, Some(1832));
        assert_eq!(s.total, Some(2016));
    }

    #[test]
    fn registry_int_id() {
        let url = "/diecast/nascar-diecast/jeff-gordon/action-lionel-arc-24-pepsi-daytona-2002-chevy-monte-carlo-stock-car/427374";
        assert_eq!(registry_int_id_from_url(url), Some(427374));
    }

    #[test]
    fn registry_guid() {
        let url = "/6f961f98-f59e-4c14-b7a3-5573807d9866/Feedback/DiecastValue";
        assert_eq!(
            registry_guid_from_feedback_url(url).as_deref(),
            Some("6f961f98-f59e-4c14-b7a3-5573807d9866")
        );
    }

    #[test]
    fn asset_guid() {
        assert_eq!(
            asset_guid_from_id_attr("asset1bc0d137-617a-4153-9615-b43100f2bbdf").as_deref(),
            Some("1bc0d137-617a-4153-9615-b43100f2bbdf")
        );
    }

    #[test]
    fn driver_norm() {
        assert_eq!(normalize_driver_name("Jeff Gordon"), "jeff-gordon");
        assert_eq!(normalize_driver_name("Dale Earnhardt Jr."), "dale-earnhardt-jr");
    }
}
