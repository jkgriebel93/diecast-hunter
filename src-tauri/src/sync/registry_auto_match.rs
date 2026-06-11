//! Best-effort auto-matching of saved listings to registry entries.
//!
//! Manual linking (`registry_link`) stays the source of truth — this module
//! only fills in suggestions. Candidates are the locally cached
//! `registry_entries` rows for the listing's auto-detected driver (populated
//! by registry pre-warm / collection sync); when a driver has no local
//! entries and the caller allows network, we run the same /Production
//! search the pre-warm flow uses to pull them in first.
//!
//! Scoring works off the listing *title* only. The truly reliable
//! identifiers (part number, production count) usually live in listing
//! photos, which we can't read — but sellers often quote the production
//! run ("1 of 5,004") in the title, and that plus year/scale/scheme/OEM
//! gets us a defensible confidence number. Matches are written to
//! `listing_matches` with `user_confirmed = 0` and `matched_by = 'auto'`,
//! plus a JSON list of reasons so the UI can show *why* we think it fits.
//! Rows the user has confirmed (or explicitly marked no-match) are never
//! touched.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::sync::registry_prewarm;

/// Minimum score required before we persist an auto-match. Driver + year +
/// scale alone lands at exactly 50 — anything weaker stays unmatched.
pub const MIN_CONFIDENCE: f64 = 50.0;
/// Auto-matches never claim certainty; only a manual link gets 100.
const MAX_CONFIDENCE: f64 = 95.0;
/// When the runner-up scores within this margin of the winner the title is
/// genuinely ambiguous, so the confidence takes a penalty.
const AMBIGUITY_MARGIN: f64 = 5.0;
const AMBIGUITY_PENALTY: f64 = 15.0;

#[derive(Debug, Serialize, Clone)]
pub struct AutoMatchOutcome {
    pub matched: bool,
    pub registry_entry_id: Option<i64>,
    pub confidence: Option<f64>,
    pub reasons: Vec<String>,
    /// Why no match was written, when `matched` is false.
    pub skipped_reason: Option<String>,
}

impl AutoMatchOutcome {
    fn skipped(reason: impl Into<String>) -> Self {
        AutoMatchOutcome {
            matched: false,
            registry_entry_id: None,
            confidence: None,
            reasons: Vec::new(),
            skipped_reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Default, Serialize, Clone)]
pub struct AutoMatchSummary {
    pub considered: u32,
    pub matched: u32,
    pub no_driver: u32,
    pub no_candidates: u32,
    pub below_threshold: u32,
    /// Drivers pulled from diecastregistry.com because they had no local
    /// registry entries yet.
    pub prewarmed_drivers: u32,
}

/// One registry entry under consideration for a listing.
#[derive(Debug, Clone, sqlx::FromRow)]
struct Candidate {
    id: i64,
    year: Option<i64>,
    year_raced: Option<i64>,
    oem: Option<String>,
    brand: Option<String>,
    scale: Option<String>,
    car_number: Option<String>,
    scheme_text: Option<String>,
    production_qty: Option<i64>,
}

/// Auto-match a single listing. `network` enables the pull-from-DCR
/// fallback when the listing's driver has no local registry entries; pass
/// `None` for the cheap local-only flavor used after listing add/refresh.
pub async fn auto_match_listing(
    pool: &SqlitePool,
    listing_id: i64,
    network: Option<&ProgressEmitter>,
) -> AppResult<AutoMatchOutcome> {
    let row: Option<(String, Option<i64>)> =
        sqlx::query_as("SELECT title, driver_id FROM listings WHERE id = ?")
            .bind(listing_id)
            .fetch_optional(pool)
            .await?;
    let Some((title, driver_id)) = row else {
        return Err(AppError::Parse(format!("listing {listing_id} not found")));
    };

    if is_user_confirmed(pool, listing_id).await? {
        return Ok(AutoMatchOutcome::skipped(
            "you already confirmed a match (or no-match) for this listing",
        ));
    }
    let Some(driver_id) = driver_id else {
        return Ok(AutoMatchOutcome::skipped(
            "no driver detected — tag a driver first, then retry",
        ));
    };

    let mut candidates = load_candidates(pool, driver_id).await?;
    if candidates.is_empty() {
        if let Some(progress) = network {
            if prewarm_driver(pool, driver_id, progress).await? {
                candidates = load_candidates(pool, driver_id).await?;
            }
        }
    }
    if candidates.is_empty() {
        return Ok(AutoMatchOutcome::skipped(
            "no registry entries for this driver — pre-warm the driver on the Registry page",
        ));
    }

    apply_best(pool, listing_id, &title, &candidates).await
}

/// Auto-match every listing that the user hasn't already confirmed or
/// rejected. Candidates are cached per driver; with `allow_network`, drivers
/// that have zero local registry entries get pre-warmed from DCR first (each
/// at most once per run, and network is dropped entirely after a
/// configuration error so one missing credential doesn't spam failures).
pub async fn auto_match_all(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
    allow_network: bool,
) -> AppResult<AutoMatchSummary> {
    let rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT l.id, l.title, l.driver_id
         FROM listings l
         LEFT JOIN listing_matches lm ON lm.listing_id = l.id
         WHERE COALESCE(lm.user_confirmed, 0) = 0
         ORDER BY l.id",
    )
    .fetch_all(pool)
    .await?;

    let total = rows.len() as u32;
    let mut summary = AutoMatchSummary {
        considered: total,
        ..Default::default()
    };
    if total == 0 {
        progress.done("No listings needed auto-matching.");
        return Ok(summary);
    }

    let mut cache: HashMap<i64, Vec<Candidate>> = HashMap::new();
    let mut prewarm_attempted: HashSet<i64> = HashSet::new();
    let mut network_ok = allow_network;

    for (idx, (listing_id, title, driver_id)) in rows.into_iter().enumerate() {
        progress.check_cancelled()?;
        let done = (idx + 1) as u32;
        if done == 1 || done % 25 == 0 || done == total {
            progress.step(
                format!("Auto-matching listing {done} of {total}…"),
                Some(done),
                Some(total),
            );
        }

        let Some(driver_id) = driver_id else {
            summary.no_driver += 1;
            continue;
        };

        if !cache.contains_key(&driver_id) {
            cache.insert(driver_id, load_candidates(pool, driver_id).await?);
        }
        if cache[&driver_id].is_empty() && network_ok && prewarm_attempted.insert(driver_id) {
            match prewarm_driver(pool, driver_id, progress).await {
                Ok(true) => {
                    summary.prewarmed_drivers += 1;
                    cache.insert(driver_id, load_candidates(pool, driver_id).await?);
                }
                Ok(false) => {}
                Err(AppError::Cancelled) => return Err(AppError::Cancelled),
                Err(AppError::NotConfigured(e)) => {
                    tracing::info!("auto-match: skipping DCR pulls ({e})");
                    network_ok = false;
                }
                Err(e) => {
                    tracing::warn!("auto-match: pre-warm for driver {driver_id} failed: {e}");
                }
            }
        }

        let candidates = &cache[&driver_id];
        if candidates.is_empty() {
            summary.no_candidates += 1;
            continue;
        }
        let outcome = apply_best(pool, listing_id, &title, candidates).await?;
        if outcome.matched {
            summary.matched += 1;
        } else {
            summary.below_threshold += 1;
        }
    }

    progress.done(format!(
        "Auto-match: {} matched, {} below threshold, {} without a driver, {} with no registry entries (of {}).",
        summary.matched,
        summary.below_threshold,
        summary.no_driver,
        summary.no_candidates,
        summary.considered
    ));
    Ok(summary)
}

/// Score the candidates against the title and persist the winner if it
/// clears the threshold; otherwise drop any stale auto-match row.
async fn apply_best(
    pool: &SqlitePool,
    listing_id: i64,
    title: &str,
    candidates: &[Candidate],
) -> AppResult<AutoMatchOutcome> {
    let Some((entry_id, confidence, reasons)) = pick_best(title, candidates) else {
        return Ok(AutoMatchOutcome::skipped("no candidate scored at all"));
    };

    if confidence < MIN_CONFIDENCE {
        // A previous run may have written a weaker-policy auto match; clear
        // it so the row reflects the current scoring. Manual/confirmed rows
        // are excluded by the WHERE.
        sqlx::query(
            "DELETE FROM listing_matches
             WHERE listing_id = ? AND user_confirmed = 0 AND matched_by = 'auto'",
        )
        .bind(listing_id)
        .execute(pool)
        .await?;
        return Ok(AutoMatchOutcome {
            matched: false,
            registry_entry_id: None,
            confidence: Some(confidence),
            reasons,
            skipped_reason: Some(format!(
                "best candidate scored {confidence:.0}% (below the {MIN_CONFIDENCE:.0}% threshold)"
            )),
        });
    }

    let reasons_json = serde_json::to_string(&reasons).unwrap_or_default();
    let now = Utc::now().timestamp();
    // The WHERE on the upsert is a belt-and-suspenders guard: callers
    // already skip user-confirmed rows, but a manual link landing mid-run
    // must win over us.
    sqlx::query(
        "INSERT INTO listing_matches
            (listing_id, registry_entry_id, confidence, user_confirmed,
             matched_at, matched_by, match_reasons)
         VALUES (?, ?, ?, 0, ?, 'auto', ?)
         ON CONFLICT(listing_id) DO UPDATE SET
            registry_entry_id = excluded.registry_entry_id,
            confidence = excluded.confidence,
            matched_at = excluded.matched_at,
            matched_by = 'auto',
            match_reasons = excluded.match_reasons
         WHERE listing_matches.user_confirmed = 0",
    )
    .bind(listing_id)
    .bind(entry_id)
    .bind(confidence)
    .bind(now)
    .bind(&reasons_json)
    .execute(pool)
    .await?;

    Ok(AutoMatchOutcome {
        matched: true,
        registry_entry_id: Some(entry_id),
        confidence: Some(confidence),
        reasons,
        skipped_reason: None,
    })
}

async fn is_user_confirmed(pool: &SqlitePool, listing_id: i64) -> AppResult<bool> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT user_confirmed FROM listing_matches WHERE listing_id = ?")
            .bind(listing_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(c,)| c != 0).unwrap_or(false))
}

async fn load_candidates(pool: &SqlitePool, driver_id: i64) -> AppResult<Vec<Candidate>> {
    let rows: Vec<Candidate> = sqlx::query_as(
        "SELECT id, year, year_raced, oem, brand, scale, car_number,
                scheme_text, production_qty
         FROM registry_entries WHERE driver_id = ?",
    )
    .bind(driver_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Pull the driver's registry entries from DCR via the pre-warm flow.
/// Returns false when the local driver can't be mapped to a DCR driver GUID
/// (the registry form-options cache hasn't been refreshed, or the driver
/// only exists locally).
async fn prewarm_driver(
    pool: &SqlitePool,
    driver_id: i64,
    progress: &ProgressEmitter,
) -> AppResult<bool> {
    let guid: Option<(String,)> = sqlx::query_as(
        "SELECT rfo.value
         FROM registry_form_options rfo
         JOIN drivers d ON d.normalized_name = rfo.normalized
         WHERE rfo.field = 'driver' AND d.id = ?",
    )
    .bind(driver_id)
    .fetch_optional(pool)
    .await?;
    let Some((guid,)) = guid else {
        return Ok(false);
    };
    registry_prewarm::prewarm_by_driver(pool, &guid, progress).await?;
    Ok(true)
}

// ----- scoring (pure, unit-tested) -----

/// Everything we can read off a listing title.
#[derive(Debug, Default)]
struct TitleSignals {
    tokens: HashSet<String>,
    years: HashSet<i64>,
    /// Normalized "1:24" form.
    scales: HashSet<String>,
    /// Car numbers with leading zeros stripped ("#08" → "8").
    car_numbers: HashSet<String>,
    /// Production-run sizes ("1 of 5,004" → 5004).
    production_counts: HashSet<i64>,
}

static SCALE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b1\s*[:/]\s*(18|24|32|64)\b").unwrap());
static CAR_NUM_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"#\s*(\d{1,3})\b").unwrap());
static PROD_COUNT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(\d{1,3}(?:,\d{3})+|\d+)\s*(?:of|/)\s*(\d{1,3}(?:,\d{3})+|\d+)\b").unwrap()
});
static LIMITED_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:limited(?:\s+edition)?\s+(?:of|to)|only)\s+(\d{1,3}(?:,\d{3})+|\d{3,})(?:\s+made)?\b")
        .unwrap()
});

fn parse_count(s: &str) -> Option<i64> {
    s.replace(',', "").parse().ok()
}

fn extract_signals(title: &str) -> TitleSignals {
    let mut sig = TitleSignals {
        tokens: tokenize(title).into_iter().collect(),
        ..Default::default()
    };
    for t in &sig.tokens {
        if t.len() == 4 {
            if let Ok(y) = t.parse::<i64>() {
                if (1948..=2035).contains(&y) {
                    sig.years.insert(y);
                }
            }
        }
    }
    for c in SCALE_RE.captures_iter(title) {
        sig.scales.insert(format!("1:{}", &c[1]));
    }
    for c in CAR_NUM_RE.captures_iter(title) {
        sig.car_numbers
            .insert(c[1].trim_start_matches('0').to_string());
    }
    for c in PROD_COUNT_RE.captures_iter(title) {
        // Denominator ≥ 100 keeps scale fractions ("1/24") and lot counts
        // ("2 of 3") out; production runs are practically always larger.
        if let (Some(num), Some(den)) = (parse_count(&c[1]), parse_count(&c[2])) {
            if den >= 100 && num <= den {
                sig.production_counts.insert(den);
            }
        }
    }
    for c in LIMITED_RE.captures_iter(title) {
        if let Some(den) = parse_count(&c[1]) {
            if den >= 100 {
                sig.production_counts.insert(den);
            }
        }
    }
    sig
}

/// Candidate-side car number: the dedicated column when enriched, else the
/// leading "#24" of the scheme text.
fn candidate_car_number(c: &Candidate) -> Option<String> {
    let raw = c.car_number.as_deref().map(str::to_string).or_else(|| {
        c.scheme_text
            .as_deref()
            .and_then(|s| CAR_NUM_RE.captures(s))
            .map(|m| m[1].to_string())
    })?;
    let trimmed: String = raw
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .trim_start_matches('0')
        .to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Scheme tokens worth matching: alphabetic words (sponsor/paint names),
/// not the car number or years which are scored separately.
fn scheme_tokens(scheme_text: &str) -> HashSet<String> {
    tokenize(scheme_text)
        .into_iter()
        .filter(|t| t.len() >= 2 && !t.chars().all(|ch| ch.is_ascii_digit()))
        .collect()
}

fn score_candidate(sig: &TitleSignals, c: &Candidate) -> (f64, Vec<String>) {
    // Candidates are pre-filtered to the listing's detected driver, so every
    // one starts with that signal banked.
    let mut score = 25.0;
    let mut reasons = vec!["driver matches".to_string()];

    // Production run — the strongest signal a title can carry.
    if let Some(qty) = c.production_qty {
        if sig.production_counts.contains(&qty) {
            score += 30.0;
            reasons.push(format!("production run of {qty} in title"));
        } else if !sig.production_counts.is_empty() {
            score -= 20.0;
            reasons.push("production count in title differs".to_string());
        }
    }

    if !sig.years.is_empty() {
        let candidate_years: Vec<i64> = [c.year, c.year_raced].into_iter().flatten().collect();
        if let Some(y) = candidate_years.iter().find(|y| sig.years.contains(y)) {
            score += 15.0;
            reasons.push(format!("year {y} matches"));
        } else if !candidate_years.is_empty() {
            score -= 10.0;
            reasons.push("year in title differs".to_string());
        }
    }

    if let Some(scale) = c.scale.as_deref() {
        if sig.scales.contains(scale) {
            score += 10.0;
            reasons.push(format!("scale {scale} matches"));
        } else if !sig.scales.is_empty() {
            score -= 15.0;
            reasons.push("scale in title differs".to_string());
        }
    }

    if let (Some(cn), false) = (candidate_car_number(c), sig.car_numbers.is_empty()) {
        if sig.car_numbers.contains(&cn) {
            score += 8.0;
            reasons.push(format!("car #{cn} matches"));
        } else {
            score -= 8.0;
            reasons.push("car number in title differs".to_string());
        }
    }

    if let Some(scheme) = c.scheme_text.as_deref() {
        let toks = scheme_tokens(scheme);
        if !toks.is_empty() {
            let hits = toks.iter().filter(|t| sig.tokens.contains(*t)).count();
            if hits > 0 {
                let frac = hits as f64 / toks.len() as f64;
                score += 15.0 * frac;
                reasons.push(format!("scheme overlap ({hits} of {} words)", toks.len()));
            }
        }
    }

    for (field, label, pts) in [(&c.oem, "OEM", 5.0), (&c.brand, "brand", 5.0)] {
        if let Some(v) = field.as_deref() {
            let hit = tokenize(v)
                .into_iter()
                .any(|t| t.len() >= 3 && sig.tokens.contains(&t));
            if hit {
                score += pts;
                reasons.push(format!("{label} \"{v}\" in title"));
            }
        }
    }

    (score, reasons)
}

/// Returns the winning candidate's (entry id, confidence, reasons), or None
/// when there are no candidates. Confidence is the raw score minus an
/// ambiguity penalty when the runner-up is close, clamped to [0, 95].
fn pick_best(title: &str, candidates: &[Candidate]) -> Option<(i64, f64, Vec<String>)> {
    let sig = extract_signals(title);
    let mut scored: Vec<(f64, &Candidate, Vec<String>)> = candidates
        .iter()
        .map(|c| {
            let (s, r) = score_candidate(&sig, c);
            (s, c, r)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    if scored.is_empty() {
        return None;
    }
    let (best_score, best, mut reasons) = scored.remove(0);
    let mut confidence = best_score;
    if let Some((second, _, _)) = scored.first() {
        if best_score - second < AMBIGUITY_MARGIN {
            confidence -= AMBIGUITY_PENALTY;
            reasons.push("several registry entries fit almost equally".to_string());
        }
    }
    Some((best.id, confidence.clamp(0.0, MAX_CONFIDENCE), reasons))
}

fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: i64) -> Candidate {
        Candidate {
            id,
            year: None,
            year_raced: None,
            oem: None,
            brand: None,
            scale: None,
            car_number: None,
            scheme_text: None,
            production_qty: None,
        }
    }

    fn full_cand(id: i64, year: i64, scale: &str, scheme: &str, qty: Option<i64>) -> Candidate {
        Candidate {
            id,
            year: Some(year),
            year_raced: Some(year),
            oem: Some("Action / Lionel".into()),
            brand: Some("Elite".into()),
            scale: Some(scale.into()),
            car_number: None,
            scheme_text: Some(scheme.into()),
            production_qty: qty,
        }
    }

    #[test]
    fn extracts_production_counts_but_not_scales() {
        let sig = extract_signals("1:24 Jeff Gordon DuPont 1/24 scale 1 of 5,004 made");
        assert!(sig.production_counts.contains(&5004));
        assert!(!sig.production_counts.contains(&24));
        assert!(sig.scales.contains("1:24"));
    }

    #[test]
    fn extracts_limited_edition_counts() {
        let sig = extract_signals("Dale Jr Budweiser limited edition of 3,500");
        assert!(sig.production_counts.contains(&3500));
        let sig2 = extract_signals("rare! only 504 made");
        assert!(sig2.production_counts.contains(&504));
    }

    #[test]
    fn extracts_years_scales_car_numbers() {
        let sig = extract_signals("2007 Jeff Gordon #24 Nicorette 1/24 Action");
        assert!(sig.years.contains(&2007));
        assert!(sig.scales.contains("1:24"));
        assert!(sig.car_numbers.contains("24"));
    }

    #[test]
    fn picks_the_matching_year_and_scheme() {
        let candidates = vec![
            full_cand(
                1,
                2007,
                "1:24",
                "#24 Nicorette 2007 Chevy Monte Carlo",
                Some(504),
            ),
            full_cand(
                2,
                2002,
                "1:24",
                "#24 Pepsi Talladega 2002 Monte Carlo",
                Some(3000),
            ),
        ];
        let (id, conf, _reasons) = pick_best(
            "2007 Jeff Gordon #24 Nicorette 1:24 Action Elite 1 of 504",
            &candidates,
        )
        .unwrap();
        assert_eq!(id, 1);
        assert!(conf >= 80.0, "confidence was {conf}");
    }

    #[test]
    fn production_count_dominates_over_scheme_noise() {
        let candidates = vec![
            full_cand(1, 2007, "1:24", "#24 DuPont Flames", Some(504)),
            full_cand(
                2,
                2007,
                "1:24",
                "#24 DuPont Flames Color Chrome",
                Some(2508),
            ),
        ];
        let (id, _conf, _r) = pick_best(
            "2007 Jeff Gordon #24 DuPont Flames 1:24 — 1 of 2,508",
            &candidates,
        )
        .unwrap();
        assert_eq!(id, 2);
    }

    #[test]
    fn ambiguous_candidates_take_a_confidence_penalty() {
        let candidates = vec![
            full_cand(1, 2007, "1:24", "#24 DuPont", None),
            full_cand(2, 2007, "1:24", "#24 DuPont", None),
        ];
        let (_, conf_ambig, reasons) =
            pick_best("2007 Jeff Gordon #24 DuPont 1:24", &candidates).unwrap();
        let (_, conf_clear, _) = pick_best(
            "2007 Jeff Gordon #24 DuPont 1:24",
            &candidates[..1].to_vec(),
        )
        .unwrap();
        assert!(conf_ambig < conf_clear);
        assert!(reasons.iter().any(|r| r.contains("almost equally")));
    }

    #[test]
    fn driver_only_match_stays_below_threshold() {
        // A bare title with nothing but the driver name shouldn't clear 50.
        let candidates = vec![full_cand(1, 2007, "1:24", "#24 Nicorette", Some(504))];
        let (_, conf, _) = pick_best("Jeff Gordon diecast lot", &candidates).unwrap();
        assert!(conf < MIN_CONFIDENCE, "confidence was {conf}");
    }

    #[test]
    fn contradictory_scale_and_year_are_penalized() {
        let right = full_cand(1, 1998, "1:64", "#24 DuPont Chromalusion", None);
        let wrong = full_cand(2, 2005, "1:24", "#24 DuPont Flames", None);
        let title = "1998 Jeff Gordon #24 DuPont Chromalusion 1:64";
        let (id, _, _) = pick_best(title, &vec![right.clone(), wrong.clone()]).unwrap();
        assert_eq!(id, 1);
        let sig = extract_signals(title);
        let (s_wrong, _) = score_candidate(&sig, &wrong);
        let (s_right, _) = score_candidate(&sig, &right);
        assert!(s_right - s_wrong > 30.0);
    }

    #[test]
    fn car_number_from_scheme_text_fallback() {
        let c = Candidate {
            scheme_text: Some("#08 Delphi 2000 Taurus".into()),
            ..cand(1)
        };
        assert_eq!(candidate_car_number(&c), Some("8".to_string()));
    }

    #[test]
    fn empty_candidates_returns_none() {
        assert!(pick_best("anything", &[]).is_none());
    }
}
