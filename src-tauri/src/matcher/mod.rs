//! Pure scoring logic for matching eBay listing titles to registry entries.
//!
//! No DB, no I/O. The orchestration in `sync::listing_match` loads drivers
//! and registry entries, calls `best_match` per listing title, and persists
//! the result to `listing_matches`.
//!
//! The score is on a 0–100ish scale. Thresholds (also exposed here so the
//! orchestrator and any future UI agree):
//!   - >= AUTO_MATCH_THRESHOLD: store as a confident auto-match.
//!   - >= REVIEW_THRESHOLD: store as a candidate for user review.
//!   - < REVIEW_THRESHOLD: don't persist (treat as unmatched).

use once_cell::sync::Lazy;
use regex::Regex;

pub const AUTO_MATCH_THRESHOLD: f64 = 60.0;
pub const REVIEW_THRESHOLD: f64 = 35.0;

/// A registry entry, in the minimal shape the matcher needs.
#[derive(Debug, Clone)]
pub struct MatchableEntry {
    pub id: i64,
    pub driver_normalized: Option<String>,
    pub year_released: Option<i32>,
    pub year_raced: Option<i32>,
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub scale: Option<String>,
    pub make: Option<String>,
    pub finish: Option<String>,
    pub scheme_text: Option<String>,
    pub car_number: Option<String>,
}

/// One driver from the drivers table, pre-tokenized for cheap matching.
#[derive(Debug, Clone)]
pub struct DriverInfo {
    pub normalized: String, // "jeff-gordon"
    pub tokens: Vec<String>, // ["jeff", "gordon"], lowercase
}

#[derive(Debug, Clone)]
pub struct MatchResult {
    pub registry_entry_id: i64,
    pub score: f64,
}

/// Score `title` against every entry, return the best match (whatever its
/// score). Caller checks against thresholds.
pub fn best_match(
    title: &str,
    drivers: &[DriverInfo],
    entries: &[MatchableEntry],
) -> Option<MatchResult> {
    if entries.is_empty() {
        return None;
    }

    let lower = title.to_lowercase();
    let title_tokens: Vec<String> = tokenize(&lower);

    let listing_year = extract_year(&lower);
    let listing_scale = extract_scale(&lower);
    let listing_number = extract_car_number(&lower);
    let listing_driver = drivers.iter().find_map(|d| {
        if d.tokens.iter().all(|t| title_tokens.iter().any(|tk| tk == t)) {
            Some(d.normalized.clone())
        } else {
            None
        }
    });

    let mut best: Option<MatchResult> = None;
    for entry in entries {
        let score = score_entry(
            &title_tokens,
            listing_year,
            listing_scale.as_deref(),
            listing_number.as_deref(),
            listing_driver.as_deref(),
            entry,
        );
        let better = match &best {
            Some(b) => score > b.score,
            None => true,
        };
        if better {
            best = Some(MatchResult {
                registry_entry_id: entry.id,
                score,
            });
        }
    }
    best
}

fn score_entry(
    title_tokens: &[String],
    listing_year: Option<i32>,
    listing_scale: Option<&str>,
    listing_number: Option<&str>,
    listing_driver: Option<&str>,
    entry: &MatchableEntry,
) -> f64 {
    let mut score = 0.0;

    // Year — match against either year released OR year raced; partial credit
    // for off-by-one (sticker year vs catalog year drift).
    if let Some(ly) = listing_year {
        let candidates = [entry.year_released, entry.year_raced];
        let mut year_score: f64 = 0.0;
        for ey in candidates.iter().flatten() {
            if *ey == ly {
                year_score = year_score.max(30.0);
            } else if (*ey - ly).abs() <= 1 {
                year_score = year_score.max(10.0);
            }
        }
        score += year_score;
    }

    // Driver — exact match on normalized form. This is the single most
    // discriminating signal for a NASCAR diecast title.
    if listing_driver.is_some() && listing_driver == entry.driver_normalized.as_deref() {
        score += 30.0;
    }

    // Scale — normalize "1/24" vs "1:24" before comparing.
    if let (Some(ls), Some(es)) = (listing_scale, entry.scale.as_deref()) {
        if normalize_scale(ls) == normalize_scale(es) {
            score += 15.0;
        }
    }

    // Car number — must appear as "#NN" in the entry's scheme text.
    if let (Some(ln), Some(scheme)) = (listing_number, entry.scheme_text.as_deref()) {
        let needle = format!("#{ln}");
        if scheme.to_lowercase().contains(&needle) {
            score += 15.0;
        }
    } else if let (Some(ln), Some(en)) = (listing_number, entry.car_number.as_deref()) {
        if en == ln {
            score += 15.0;
        }
    }

    // OEM / brand / scheme keyword overlap. Capped so a long scheme_text
    // can't dominate the score.
    let mut entry_keywords: Vec<String> = Vec::new();
    for src in [
        entry.oem.as_deref(),
        entry.brand.as_deref(),
        entry.scheme_text.as_deref(),
        entry.make.as_deref(),
        entry.finish.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        for tok in tokenize(&src.to_lowercase()) {
            if !STOPWORDS.contains(&tok.as_str()) && tok.len() >= 3 {
                entry_keywords.push(tok);
            }
        }
    }
    entry_keywords.sort();
    entry_keywords.dedup();

    let mut overlap = 0;
    for kw in &entry_keywords {
        if title_tokens.iter().any(|t| t == kw || t.contains(kw.as_str())) {
            overlap += 1;
        }
    }
    score += (overlap as f64 * 3.0).min(25.0);

    score
}

fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

static YEAR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(19[89]\d|20[0-3]\d)\b").unwrap());
static SCALE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(1)\s*[:/]\s*(\d{2,3})\b").unwrap());
static CAR_NUMBER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"#\s*(\d{1,3}[a-z]?)").unwrap());

fn extract_year(lower: &str) -> Option<i32> {
    YEAR_RE
        .captures(lower)
        .and_then(|c| c.get(1).and_then(|m| m.as_str().parse().ok()))
}

fn extract_scale(lower: &str) -> Option<String> {
    SCALE_RE.captures(lower).map(|c| {
        format!(
            "{}:{}",
            c.get(1).unwrap().as_str(),
            c.get(2).unwrap().as_str()
        )
    })
}

fn extract_car_number(lower: &str) -> Option<String> {
    CAR_NUMBER_RE
        .captures(lower)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

fn normalize_scale(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_digit() || *c == ':')
        .collect::<String>()
        .replace('/', ":")
}

/// Words too generic to count as evidence of a registry-entry match. Mostly
/// vehicle bodies (every Chevy diecast says "chevy" / "monte" / "carlo") and
/// catalog filler.
static STOPWORDS: phf::Set<&'static str> = phf::phf_set! {
    "nascar", "diecast", "stock", "car", "truck", "racing", "race", "the",
    "and", "with", "edition", "series", "new", "rare", "ltd", "limited",
    "chevy", "ford", "toyota", "dodge", "chevrolet", "monte", "carlo",
    "fusion", "camry", "ss", "thunderbird", "intrepid", "taurus", "impala",
    "lumina", "grand", "prix", "1of", "from", "for",
};

#[cfg(test)]
mod tests {
    use super::*;

    fn drv(name: &str, normalized: &str) -> DriverInfo {
        DriverInfo {
            normalized: normalized.to_string(),
            tokens: name
                .to_lowercase()
                .split_whitespace()
                .map(|s| s.to_string())
                .collect(),
        }
    }

    fn entry(
        id: i64,
        driver: &str,
        year: i32,
        oem: &str,
        brand: &str,
        scale: &str,
        scheme: &str,
    ) -> MatchableEntry {
        MatchableEntry {
            id,
            driver_normalized: Some(driver.to_string()),
            year_released: Some(year),
            year_raced: Some(year),
            oem: Some(oem.to_string()),
            brand: Some(brand.to_string()),
            scale: Some(scale.to_string()),
            make: None,
            finish: None,
            scheme_text: Some(scheme.to_string()),
            car_number: None,
        }
    }

    #[test]
    fn year_extraction() {
        assert_eq!(extract_year("2002 jeff gordon"), Some(2002));
        assert_eq!(extract_year("vintage 1995 dupont"), Some(1995));
        assert_eq!(extract_year("no year here"), None);
    }

    #[test]
    fn scale_extraction() {
        assert_eq!(extract_scale("1:24 action"), Some("1:24".into()));
        assert_eq!(extract_scale("1/24 diecast"), Some("1:24".into()));
        assert_eq!(extract_scale("scale 1 / 64"), Some("1:64".into()));
        assert_eq!(extract_scale("nothing here"), None);
    }

    #[test]
    fn car_number_extraction() {
        assert_eq!(extract_car_number("#24 pepsi"), Some("24".into()));
        assert_eq!(extract_car_number("# 5 kelloggs"), Some("5".into()));
        assert_eq!(extract_car_number("no number"), None);
    }

    #[test]
    fn high_confidence_match() {
        let drivers = vec![drv("Jeff Gordon", "jeff-gordon")];
        let entries = vec![
            entry(
                1,
                "jeff-gordon",
                2002,
                "Action / Lionel",
                "ARC",
                "1:24",
                "#24 Pepsi Daytona 2002 Chevy Monte Carlo",
            ),
            entry(
                2,
                "jeff-gordon",
                1998,
                "Action / Lionel",
                "ARC",
                "1:24",
                "#24 ChromaLusion 1998 Chevy Monte Carlo",
            ),
        ];
        let title = "2002 Jeff Gordon #24 Pepsi Daytona 1:24 Action ARC NASCAR Diecast";
        let m = best_match(title, &drivers, &entries).unwrap();
        assert_eq!(m.registry_entry_id, 1);
        assert!(
            m.score >= AUTO_MATCH_THRESHOLD,
            "score {} should auto-match",
            m.score
        );
    }

    #[test]
    fn picks_best_among_same_driver() {
        let drivers = vec![drv("Jeff Gordon", "jeff-gordon")];
        let entries = vec![
            entry(
                1,
                "jeff-gordon",
                2002,
                "Action / Lionel",
                "ARC",
                "1:24",
                "#24 Pepsi Daytona 2002 Chevy Monte Carlo",
            ),
            entry(
                2,
                "jeff-gordon",
                2002,
                "Action / Lionel",
                "ARC",
                "1:24",
                "#24 DuPont 200 Years 2002 Chevy Monte Carlo",
            ),
        ];
        let title = "Jeff Gordon 24 DuPont 200 Years 2002 1:24";
        let m = best_match(title, &drivers, &entries).unwrap();
        assert_eq!(m.registry_entry_id, 2);
    }

    #[test]
    fn no_driver_in_title_lowers_score() {
        let drivers = vec![drv("Jeff Gordon", "jeff-gordon")];
        let entries = vec![entry(
            1,
            "jeff-gordon",
            2002,
            "Action",
            "ARC",
            "1:24",
            "#24 Pepsi Daytona",
        )];
        // No driver, no scale, no number — basically just keyword overlap on
        // "pepsi action" (years stripped).
        let title = "Pepsi promotional sticker car 2002 Action";
        let m = best_match(title, &drivers, &entries).unwrap();
        assert!(m.score < AUTO_MATCH_THRESHOLD);
    }

    #[test]
    fn empty_entries_returns_none() {
        let drivers = vec![drv("Jeff Gordon", "jeff-gordon")];
        let entries: Vec<MatchableEntry> = vec![];
        assert!(best_match("anything", &drivers, &entries).is_none());
    }
}
