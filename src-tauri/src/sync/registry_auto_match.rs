//! Best-effort auto-matching of saved listings to registry entries.
//!
//! Manual linking (`registry_link`) stays the source of truth — this module
//! only fills in suggestions. Candidates are the locally cached
//! `registry_entries` rows for the listing's auto-detected driver (populated
//! by registry pre-warm / collection sync); when a driver has no local
//! entries and the caller allows network, we run the same /Production
//! search the pre-warm flow uses to pull them in first.
//!
//! Scoring reads the listing *title* plus whatever the source payload in
//! `listings.raw_json` offers: eBay Browse `localizedAspects` (seller-filled
//! item specifics like Scale / Year / Brand — higher precision than title
//! regexes) and free-text descriptions, which often quote the production
//! run ("1 of 5,004") even when the title doesn't. Each signal is a named
//! feature in [`MatchFeatures`]; the score is a dot product with
//! [`MatchWeights`], so the weights can later be fit to the verdicts
//! accumulating in `match_feedback` instead of staying hand-tuned.
//! Matches are written to `listing_matches` with `user_confirmed = 0` and
//! `matched_by = 'auto'`, plus a JSON list of reasons so the UI can show
//! *why* we think it fits. Rows the user has confirmed (or explicitly
//! marked no-match) are never touched.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;
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

/// Defines `MatchFeatures` and `MatchWeights` with identical fields so the
/// dot product can't silently miss one. `#[serde(default)]` keeps old
/// `features_json` snapshots loadable after new features are added — a
/// missing field just reads as 0.
macro_rules! match_feature_fields {
    ($($field:ident),* $(,)?) => {
        /// Named signals for one (listing, registry entry) pair. Fields are
        /// 0/1 indicators except `scheme_overlap` (fraction in [0, 1]).
        /// Serialized as `features_json` in `match_feedback` rows.
        #[derive(Debug, Default, Clone, Serialize, serde::Deserialize)]
        #[serde(default)]
        pub struct MatchFeatures {
            $(pub $field: f64,)*
        }

        /// Per-feature points. Conflict weights are negative. Defaults are
        /// hand-tuned; `matcher_training` fits a learned set to the
        /// `match_feedback` verdicts.
        #[derive(Debug, Clone, Serialize, serde::Deserialize)]
        #[serde(default)]
        pub struct MatchWeights {
            $(pub $field: f64,)*
        }

        /// Field names in declaration order — the order `to_vec` /
        /// `from_slice` use.
        pub const FEATURE_NAMES: &[&str] = &[$(stringify!($field),)*];

        impl MatchFeatures {
            pub fn score(&self, w: &MatchWeights) -> f64 {
                0.0 $(+ self.$field * w.$field)*
            }

            pub fn to_vec(&self) -> Vec<f64> {
                vec![$(self.$field,)*]
            }
        }

        impl MatchWeights {
            /// Panics if `v.len() != FEATURE_NAMES.len()` — trainer-internal.
            pub fn from_slice(v: &[f64]) -> Self {
                let mut it = v.iter().copied();
                let w = MatchWeights {
                    $($field: it.next().expect("weight vector too short"),)*
                };
                assert!(it.next().is_none(), "weight vector too long");
                w
            }

            pub fn to_vec(&self) -> Vec<f64> {
                vec![$(self.$field,)*]
            }
        }
    };
}

match_feature_fields!(
    driver_match,
    prod_count_match,
    prod_count_conflict,
    year_match,
    year_conflict,
    scale_match,
    scale_conflict,
    car_number_match,
    car_number_conflict,
    scheme_overlap,
    oem_match,
    brand_match,
    aspect_year_match,
    aspect_scale_match,
    aspect_maker_match,
    attr_oem_match,
    attr_oem_conflict,
    attr_brand_match,
    attr_brand_conflict,
    attr_finish_match,
    attr_finish_conflict,
    attr_make_match,
    attr_make_conflict,
);

impl Default for MatchWeights {
    fn default() -> Self {
        MatchWeights {
            driver_match: 25.0,
            prod_count_match: 30.0,
            prod_count_conflict: -20.0,
            year_match: 15.0,
            year_conflict: -10.0,
            scale_match: 10.0,
            scale_conflict: -15.0,
            car_number_match: 8.0,
            car_number_conflict: -8.0,
            scheme_overlap: 15.0,
            oem_match: 5.0,
            brand_match: 5.0,
            aspect_year_match: 5.0,
            aspect_scale_match: 5.0,
            aspect_maker_match: 3.0,
            attr_oem_match: 6.0,
            attr_oem_conflict: -8.0,
            attr_brand_match: 6.0,
            attr_brand_conflict: -8.0,
            attr_finish_match: 8.0,
            attr_finish_conflict: -10.0,
            attr_make_match: 4.0,
            attr_make_conflict: -6.0,
        }
    }
}

/// A logistic-regression model fit to `match_feedback` verdicts by
/// `matcher_training::retrain`, stored as JSON under
/// `settings::KEY_MATCH_MODEL`. The extra fields are provenance for the
/// Settings page and the auto-retrain trigger.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct LearnedModel {
    pub weights: MatchWeights,
    pub bias: f64,
    pub trained_at: i64,
    pub positives: u32,
    pub explicit_negatives: u32,
    pub implicit_negatives: u32,
    /// Grouped 5-fold cross-validated accuracy on held-out *explicit*
    /// verdicts, for this model and the hand-tuned baseline, in [0, 1].
    pub cv_accuracy: f64,
    pub cv_accuracy_baseline: f64,
    /// Same folds, ranking metric: fraction of confirmed listings whose
    /// confirmed entry outranked its strongest rivals. None when no
    /// held-out listing had rivals.
    #[serde(default)]
    pub cv_rank_accuracy: Option<f64>,
    #[serde(default)]
    pub cv_rank_accuracy_baseline: Option<f64>,
    /// COUNT(match_feedback) at training time; the auto-retrain check
    /// compares the live count against this.
    pub feedback_rows_at_train: i64,
}

/// The active scorer. Handcrafted mode reproduces the original behavior:
/// confidence is the raw dot product ("points"). Learned mode maps the
/// dot product through a sigmoid onto 0–100, so the existing
/// `MIN_CONFIDENCE = 50` threshold reads as "more likely right than
/// wrong" and the UI's percent framing stays truthful.
pub enum ScoreModel {
    Handcrafted(MatchWeights),
    Learned(LearnedModel),
}

impl Default for ScoreModel {
    fn default() -> Self {
        ScoreModel::Handcrafted(MatchWeights::default())
    }
}

pub fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

impl ScoreModel {
    /// Load the stored learned model, falling back to the hand-tuned
    /// defaults when none exists or it fails to parse (a parse failure is
    /// logged — it means a schema change broke the stored JSON, and
    /// retraining will rewrite it).
    pub async fn load(pool: &SqlitePool) -> Self {
        match settings::get(pool, settings::KEY_MATCH_MODEL).await {
            Ok(Some(json)) => match serde_json::from_str::<LearnedModel>(&json) {
                Ok(m) => ScoreModel::Learned(m),
                Err(e) => {
                    tracing::warn!("stored matcher model unparseable ({e}); using defaults");
                    ScoreModel::default()
                }
            },
            Ok(None) => ScoreModel::default(),
            Err(e) => {
                tracing::warn!("loading matcher model failed ({e}); using defaults");
                ScoreModel::default()
            }
        }
    }

    pub fn confidence(&self, f: &MatchFeatures) -> f64 {
        match self {
            ScoreModel::Handcrafted(w) => f.score(w),
            ScoreModel::Learned(m) => 100.0 * sigmoid(f.score(&m.weights) + m.bias),
        }
    }
}

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
pub(crate) struct Candidate {
    pub(crate) id: i64,
    pub(crate) driver_id: Option<i64>,
    pub(crate) year: Option<i64>,
    pub(crate) year_raced: Option<i64>,
    pub(crate) oem: Option<String>,
    pub(crate) brand: Option<String>,
    pub(crate) scale: Option<String>,
    pub(crate) car_number: Option<String>,
    pub(crate) scheme_text: Option<String>,
    pub(crate) production_qty: Option<i64>,
    pub(crate) finish: Option<String>,
    pub(crate) make: Option<String>,
}

/// Bidirectional token bridges from the `scheme_aliases` table: looking up
/// either side of a row yields the other, so "bud" in a title reaches
/// "budweiser" in a scheme and vice versa.
pub(crate) type AliasMap = HashMap<String, Vec<String>>;

pub(crate) async fn load_aliases(pool: &SqlitePool) -> AppResult<AliasMap> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT alias, canonical FROM scheme_aliases")
        .fetch_all(pool)
        .await?;
    let mut map: AliasMap = HashMap::new();
    for (alias, canonical) in rows {
        let (alias, canonical) = (alias.to_lowercase(), canonical.to_lowercase());
        map.entry(alias.clone())
            .or_default()
            .push(canonical.clone());
        map.entry(canonical).or_default().push(alias);
    }
    Ok(map)
}

/// Structured attribute columns on the listing row, auto-detected by
/// `sync::attribute_assoc` from DCR vocabulary (or pinned by the user).
/// Both sides of the comparison use the same canonical vocabulary, so a
/// normalized string comparison against candidate columns is meaningful.
#[derive(Debug, Default, Clone, sqlx::FromRow)]
pub(crate) struct ListingAttrs {
    pub(crate) oem: Option<String>,
    pub(crate) brand: Option<String>,
    pub(crate) finish: Option<String>,
    pub(crate) make: Option<String>,
}

/// Everything the scorer reads from a listing row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct ListingForMatching {
    pub(crate) title: String,
    pub(crate) driver_id: Option<i64>,
    pub(crate) raw_json: Option<String>,
    #[sqlx(flatten)]
    pub(crate) attrs: ListingAttrs,
}

pub(crate) async fn load_listing_for_matching(
    pool: &SqlitePool,
    listing_id: i64,
) -> AppResult<Option<ListingForMatching>> {
    Ok(sqlx::query_as(
        "SELECT title, driver_id, raw_json, oem, brand, finish, make
         FROM listings WHERE id = ?",
    )
    .bind(listing_id)
    .fetch_optional(pool)
    .await?)
}

pub(crate) async fn load_candidate(
    pool: &SqlitePool,
    entry_id: i64,
) -> AppResult<Option<Candidate>> {
    Ok(sqlx::query_as(
        "SELECT id, driver_id, year, year_raced, oem, brand, scale, car_number,
                scheme_text, production_qty, finish, make
         FROM registry_entries WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(pool)
    .await?)
}

/// Auto-match a single listing. `network` enables the pull-from-DCR
/// fallback when the listing's driver has no local registry entries; pass
/// `None` for the cheap local-only flavor used after listing add/refresh.
pub async fn auto_match_listing(
    pool: &SqlitePool,
    listing_id: i64,
    network: Option<&ProgressEmitter>,
) -> AppResult<AutoMatchOutcome> {
    let Some(listing) = load_listing_for_matching(pool, listing_id).await? else {
        return Err(AppError::Parse(format!("listing {listing_id} not found")));
    };

    if is_user_confirmed(pool, listing_id).await? {
        return Ok(AutoMatchOutcome::skipped(
            "you already confirmed a match (or no-match) for this listing",
        ));
    }
    let Some(driver_id) = listing.driver_id else {
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

    let aliases = load_aliases(pool).await?;
    let model = ScoreModel::load(pool).await;
    let sig = build_signals(
        &listing.title,
        listing.raw_json.as_deref(),
        &aliases,
        &listing.attrs,
    );
    apply_best(pool, listing_id, &sig, &candidates, &model).await
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
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT l.id
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

    let aliases = load_aliases(pool).await?;
    let model = ScoreModel::load(pool).await;
    let mut cache: HashMap<i64, Vec<Candidate>> = HashMap::new();
    let mut prewarm_attempted: HashSet<i64> = HashSet::new();
    let mut network_ok = allow_network;

    for (idx, (listing_id,)) in rows.into_iter().enumerate() {
        progress.check_cancelled()?;
        let done = (idx + 1) as u32;
        if done == 1 || done % 25 == 0 || done == total {
            progress.step(
                format!("Auto-matching listing {done} of {total}…"),
                Some(done),
                Some(total),
            );
        }

        let Some(listing) = load_listing_for_matching(pool, listing_id).await? else {
            continue;
        };
        let Some(driver_id) = listing.driver_id else {
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
        let sig = build_signals(
            &listing.title,
            listing.raw_json.as_deref(),
            &aliases,
            &listing.attrs,
        );
        let outcome = apply_best(pool, listing_id, &sig, candidates, &model).await?;
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

/// Compute the feature vector and raw score for an arbitrary
/// (listing, registry entry) pair — the hook `match_feedback` uses to
/// snapshot *why* a pairing looked the way it did when the user passed a
/// verdict on it. Unlike the auto-match path, the entry may belong to a
/// different driver than the listing (or no driver), so the driver signal
/// is computed rather than assumed. Returns None when either row is gone.
pub async fn features_for_pair(
    pool: &SqlitePool,
    listing_id: i64,
    entry_id: i64,
) -> AppResult<Option<(MatchFeatures, f64)>> {
    let Some(listing) = load_listing_for_matching(pool, listing_id).await? else {
        return Ok(None);
    };
    let Some(candidate) = load_candidate(pool, entry_id).await? else {
        return Ok(None);
    };

    let aliases = load_aliases(pool).await?;
    let model = ScoreModel::load(pool).await;
    let sig = build_signals(
        &listing.title,
        listing.raw_json.as_deref(),
        &aliases,
        &listing.attrs,
    );
    let driver_match = listing.driver_id.is_some() && listing.driver_id == candidate.driver_id;
    let (features, _reasons) = extract_features(&sig, &candidate, driver_match);
    let score = model.confidence(&features);
    Ok(Some((features, score)))
}

/// Score the candidates against the listing signals and persist the winner
/// if it clears the threshold; otherwise drop any stale auto-match row.
async fn apply_best(
    pool: &SqlitePool,
    listing_id: i64,
    sig: &ListingSignals,
    candidates: &[Candidate],
    model: &ScoreModel,
) -> AppResult<AutoMatchOutcome> {
    let Some((entry_id, confidence, reasons)) = pick_best(sig, candidates, model) else {
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

pub(crate) async fn load_candidates(
    pool: &SqlitePool,
    driver_id: i64,
) -> AppResult<Vec<Candidate>> {
    let rows: Vec<Candidate> = sqlx::query_as(
        "SELECT id, driver_id, year, year_raced, oem, brand, scale, car_number,
                scheme_text, production_qty, finish, make
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

// ----- signal extraction and scoring (pure, unit-tested) -----

/// Everything we can read off a listing: title, plus item specifics and
/// description text from the stored source payload.
#[derive(Debug, Default)]
pub(crate) struct ListingSignals {
    /// Title tokens, expanded with scheme-alias bridges (both directions).
    tokens: HashSet<String>,
    years: HashSet<i64>,
    /// Normalized "1:24" form.
    scales: HashSet<String>,
    /// Car numbers with leading zeros stripped ("#08" → "8").
    car_numbers: HashSet<String>,
    /// Production-run sizes ("1 of 5,004" → 5004).
    production_counts: HashSet<i64>,
    /// Subsets of the above that came from structured eBay item specifics
    /// (`localizedAspects`) — seller-filled fields, more trustworthy than a
    /// regex hit in free text, so they earn a scoring bonus.
    aspect_years: HashSet<i64>,
    aspect_scales: HashSet<String>,
    /// Tokens from Brand / Manufacturer / Make aspects.
    aspect_maker_tokens: HashSet<String>,
    /// Normalized structured attribute columns from the listing row
    /// ([`ListingAttrs`]), compared against the same columns on candidates.
    attr_oem: Option<String>,
    attr_brand: Option<String>,
    attr_finish: Option<String>,
    attr_make: Option<String>,
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

fn year_from_token(t: &str) -> Option<i64> {
    if t.len() != 4 {
        return None;
    }
    let y: i64 = t.parse().ok()?;
    (1948..=2035).contains(&y).then_some(y)
}

/// Build the full signal set for a listing: title first, then whatever the
/// stored source payload adds (see [`merge_raw_json_signals`]), then the
/// alias expansion of the title tokens.
pub(crate) fn build_signals(
    title: &str,
    raw_json: Option<&str>,
    aliases: &AliasMap,
    attrs: &ListingAttrs,
) -> ListingSignals {
    let mut sig = ListingSignals {
        tokens: tokenize(title).into_iter().collect(),
        attr_oem: attrs.oem.as_deref().and_then(norm_attr),
        attr_brand: attrs.brand.as_deref().and_then(norm_attr),
        attr_finish: attrs.finish.as_deref().and_then(norm_attr),
        attr_make: attrs.make.as_deref().and_then(norm_attr),
        ..Default::default()
    };
    merge_text_signals(&mut sig, title);
    if let Some(raw) = raw_json {
        merge_raw_json_signals(&mut sig, raw);
    }
    let expansions: Vec<String> = sig
        .tokens
        .iter()
        .filter_map(|t| aliases.get(t))
        .flatten()
        .cloned()
        .collect();
    sig.tokens.extend(expansions);
    sig
}

/// Regex-extract years / scales / car numbers / production counts from a
/// chunk of free text into the general signal sets. Deliberately does NOT
/// add the text's tokens to `sig.tokens`: descriptions often mention a
/// seller's *other* cars, and letting those words into the scheme-overlap
/// pool would reward wrong candidates.
fn merge_text_signals(sig: &mut ListingSignals, text: &str) {
    for t in tokenize(text) {
        if let Some(y) = year_from_token(&t) {
            sig.years.insert(y);
        }
    }
    for c in SCALE_RE.captures_iter(text) {
        sig.scales.insert(format!("1:{}", &c[1]));
    }
    for c in CAR_NUM_RE.captures_iter(text) {
        sig.car_numbers
            .insert(c[1].trim_start_matches('0').to_string());
    }
    for c in PROD_COUNT_RE.captures_iter(text) {
        // Denominator ≥ 100 keeps scale fractions ("1/24") and lot counts
        // ("2 of 3") out; production runs are practically always larger.
        if let (Some(num), Some(den)) = (parse_count(&c[1]), parse_count(&c[2])) {
            if den >= 100 && num <= den {
                sig.production_counts.insert(den);
            }
        }
    }
    for c in LIMITED_RE.captures_iter(text) {
        if let Some(den) = parse_count(&c[1]) {
            if den >= 100 {
                sig.production_counts.insert(den);
            }
        }
    }
}

/// Mine the stored source payload. eBay Browse responses carry
/// `localizedAspects` (structured item specifics) and `shortDescription`;
/// other payloads may carry a plain `description`.
fn merge_raw_json_signals(sig: &mut ListingSignals, raw_json: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw_json) else {
        return;
    };

    if let Some(aspects) = v.get("localizedAspects").and_then(|a| a.as_array()) {
        for aspect in aspects {
            let name = aspect.get("name").and_then(|n| n.as_str());
            let value = aspect.get("value").and_then(|n| n.as_str());
            let (Some(name), Some(value)) = (name, value) else {
                continue;
            };
            let name = name.to_lowercase();
            if name.contains("scale") {
                for c in SCALE_RE.captures_iter(value) {
                    let s = format!("1:{}", &c[1]);
                    sig.scales.insert(s.clone());
                    sig.aspect_scales.insert(s);
                }
            } else if name.contains("year") {
                for t in tokenize(value) {
                    if let Some(y) = year_from_token(&t) {
                        sig.years.insert(y);
                        sig.aspect_years.insert(y);
                    }
                }
            } else if name.contains("brand") || name.contains("manufacturer") || name == "make" {
                for t in tokenize(value) {
                    if t.len() >= 3 {
                        sig.aspect_maker_tokens.insert(t.clone());
                        sig.tokens.insert(t);
                    }
                }
            }
        }
    }

    for key in ["shortDescription", "description"] {
        if let Some(text) = v.get(key).and_then(|s| s.as_str()) {
            merge_text_signals(sig, text);
        }
    }
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
pub(crate) fn scheme_tokens(scheme_text: &str) -> HashSet<String> {
    tokenize(scheme_text)
        .into_iter()
        .filter(|t| t.len() >= 2 && !t.chars().all(|ch| ch.is_ascii_digit()))
        .collect()
}

/// The feature vector for one candidate, plus human-readable reasons for
/// every signal that fired. `driver_match` is passed in because the
/// auto-match path pre-filters candidates to the listing's driver (always
/// true) while `features_for_pair` compares arbitrary pairs.
pub(crate) fn extract_features(
    sig: &ListingSignals,
    c: &Candidate,
    driver_match: bool,
) -> (MatchFeatures, Vec<String>) {
    let mut f = MatchFeatures::default();
    let mut reasons = Vec::new();

    if driver_match {
        f.driver_match = 1.0;
        reasons.push("driver matches".to_string());
    }

    // Production run — the strongest signal a listing can carry.
    if let Some(qty) = c.production_qty {
        if sig.production_counts.contains(&qty) {
            f.prod_count_match = 1.0;
            reasons.push(format!("production run of {qty} in listing"));
        } else if !sig.production_counts.is_empty() {
            f.prod_count_conflict = 1.0;
            reasons.push("production count in listing differs".to_string());
        }
    }

    if !sig.years.is_empty() {
        let candidate_years: Vec<i64> = [c.year, c.year_raced].into_iter().flatten().collect();
        if let Some(y) = candidate_years.iter().find(|y| sig.years.contains(y)) {
            f.year_match = 1.0;
            reasons.push(format!("year {y} matches"));
            if sig.aspect_years.contains(y) {
                f.aspect_year_match = 1.0;
                reasons.push("year confirmed by item specifics".to_string());
            }
        } else if !candidate_years.is_empty() {
            f.year_conflict = 1.0;
            reasons.push("year in listing differs".to_string());
        }
    }

    if let Some(scale) = c.scale.as_deref() {
        if sig.scales.contains(scale) {
            f.scale_match = 1.0;
            reasons.push(format!("scale {scale} matches"));
            if sig.aspect_scales.contains(scale) {
                f.aspect_scale_match = 1.0;
                reasons.push("scale confirmed by item specifics".to_string());
            }
        } else if !sig.scales.is_empty() {
            f.scale_conflict = 1.0;
            reasons.push("scale in listing differs".to_string());
        }
    }

    if let (Some(cn), false) = (candidate_car_number(c), sig.car_numbers.is_empty()) {
        if sig.car_numbers.contains(&cn) {
            f.car_number_match = 1.0;
            reasons.push(format!("car #{cn} matches"));
        } else {
            f.car_number_conflict = 1.0;
            reasons.push("car number in listing differs".to_string());
        }
    }

    if let Some(scheme) = c.scheme_text.as_deref() {
        let toks = scheme_tokens(scheme);
        if !toks.is_empty() {
            let hits = toks.iter().filter(|t| sig.tokens.contains(*t)).count();
            if hits > 0 {
                f.scheme_overlap = hits as f64 / toks.len() as f64;
                reasons.push(format!("scheme overlap ({hits} of {} words)", toks.len()));
            }
        }
    }

    // Returns the matching token so the caller can check it against the
    // structured Brand/Manufacturer aspects.
    let maker_hit = |field: Option<&str>| -> Option<String> {
        tokenize(field?)
            .into_iter()
            .find(|t| t.len() >= 3 && sig.tokens.contains(t))
    };
    let mut aspect_confirmed = false;
    if let Some(t) = maker_hit(c.oem.as_deref()) {
        f.oem_match = 1.0;
        reasons.push(format!("OEM \"{}\" in listing", c.oem.as_deref().unwrap()));
        aspect_confirmed |= sig.aspect_maker_tokens.contains(&t);
    }
    if let Some(t) = maker_hit(c.brand.as_deref()) {
        f.brand_match = 1.0;
        reasons.push(format!(
            "brand \"{}\" in listing",
            c.brand.as_deref().unwrap()
        ));
        aspect_confirmed |= sig.aspect_maker_tokens.contains(&t);
    }
    if aspect_confirmed {
        f.aspect_maker_match = 1.0;
        reasons.push("maker confirmed by item specifics".to_string());
    }

    // Structured attribute columns - a conflict is only scored when both
    // sides carry a value.
    let attr_cmp = |l: &Option<String>, r: &Option<String>| -> Option<bool> {
        let l = l.as_deref()?;
        let r = r.as_deref().and_then(norm_attr)?;
        Some(l == r)
    };
    match attr_cmp(&sig.attr_oem, &c.oem) {
        Some(true) => {
            f.attr_oem_match = 1.0;
            reasons.push("OEM attribute matches".to_string());
        }
        Some(false) => {
            f.attr_oem_conflict = 1.0;
            reasons.push("OEM attribute differs".to_string());
        }
        None => {}
    }
    match attr_cmp(&sig.attr_brand, &c.brand) {
        Some(true) => {
            f.attr_brand_match = 1.0;
            reasons.push("brand attribute matches".to_string());
        }
        Some(false) => {
            f.attr_brand_conflict = 1.0;
            reasons.push("brand attribute differs".to_string());
        }
        None => {}
    }
    match attr_cmp(&sig.attr_finish, &c.finish) {
        Some(true) => {
            f.attr_finish_match = 1.0;
            reasons.push("finish attribute matches".to_string());
        }
        Some(false) => {
            f.attr_finish_conflict = 1.0;
            reasons.push("finish attribute differs".to_string());
        }
        None => {}
    }
    match attr_cmp(&sig.attr_make, &c.make) {
        Some(true) => {
            f.attr_make_match = 1.0;
            reasons.push("make attribute matches".to_string());
        }
        Some(false) => {
            f.attr_make_conflict = 1.0;
            reasons.push("make attribute differs".to_string());
        }
        None => {}
    }

    (f, reasons)
}

/// Returns the winning candidate's (entry id, confidence, reasons), or None
/// when there are no candidates. Confidence is the model's output minus an
/// ambiguity penalty when the runner-up is close, clamped to [0, 95].
fn pick_best(
    sig: &ListingSignals,
    candidates: &[Candidate],
    model: &ScoreModel,
) -> Option<(i64, f64, Vec<String>)> {
    let mut scored: Vec<(f64, &Candidate, Vec<String>)> = candidates
        .iter()
        .map(|c| {
            let (f, r) = extract_features(sig, c, true);
            (model.confidence(&f), c, r)
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

/// Attribute values come from DCR vocabulary on both sides but can differ
/// in spacing/punctuation ("Action / Lionel" vs "Action/Lionel") - compare
/// them as normalized token strings.
fn norm_attr(s: &str) -> Option<String> {
    let t = tokenize(s).join(" ");
    (!t.is_empty()).then_some(t)
}

pub(crate) fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signals(title: &str) -> ListingSignals {
        build_signals(title, None, &AliasMap::new(), &ListingAttrs::default())
    }

    /// pick_best under the default hand-tuned model, which is what these
    /// behavior tests pin down.
    fn pick(sig: &ListingSignals, candidates: &[Candidate]) -> Option<(i64, f64, Vec<String>)> {
        pick_best(sig, candidates, &ScoreModel::default())
    }

    fn cand(id: i64) -> Candidate {
        Candidate {
            id,
            driver_id: Some(1),
            year: None,
            year_raced: None,
            oem: None,
            brand: None,
            scale: None,
            car_number: None,
            scheme_text: None,
            production_qty: None,
            finish: None,
            make: None,
        }
    }

    fn full_cand(id: i64, year: i64, scale: &str, scheme: &str, qty: Option<i64>) -> Candidate {
        Candidate {
            id,
            driver_id: Some(1),
            year: Some(year),
            year_raced: Some(year),
            oem: Some("Action / Lionel".into()),
            brand: Some("Elite".into()),
            scale: Some(scale.into()),
            car_number: None,
            scheme_text: Some(scheme.into()),
            production_qty: qty,
            finish: None,
            make: None,
        }
    }

    #[test]
    fn extracts_production_counts_but_not_scales() {
        let sig = signals("1:24 Jeff Gordon DuPont 1/24 scale 1 of 5,004 made");
        assert!(sig.production_counts.contains(&5004));
        assert!(!sig.production_counts.contains(&24));
        assert!(sig.scales.contains("1:24"));
    }

    #[test]
    fn extracts_limited_edition_counts() {
        let sig = signals("Dale Jr Budweiser limited edition of 3,500");
        assert!(sig.production_counts.contains(&3500));
        let sig2 = signals("rare! only 504 made");
        assert!(sig2.production_counts.contains(&504));
    }

    #[test]
    fn extracts_years_scales_car_numbers() {
        let sig = signals("2007 Jeff Gordon #24 Nicorette 1/24 Action");
        assert!(sig.years.contains(&2007));
        assert!(sig.scales.contains("1:24"));
        assert!(sig.car_numbers.contains("24"));
    }

    #[test]
    fn mines_ebay_aspects_and_description() {
        let raw = serde_json::json!({
            "localizedAspects": [
                {"type": "STRING", "name": "Scale", "value": "1:24"},
                {"type": "STRING", "name": "Year of Manufacture", "value": "2007"},
                {"type": "STRING", "name": "Brand", "value": "Action Racing"},
            ],
            "shortDescription": "Mint in box, 1 of 2,508 produced.",
        })
        .to_string();
        let sig = build_signals(
            "Jeff Gordon Nicorette diecast",
            Some(&raw),
            &AliasMap::new(),
            &ListingAttrs::default(),
        );
        assert!(sig.scales.contains("1:24"));
        assert!(sig.aspect_scales.contains("1:24"));
        assert!(sig.years.contains(&2007));
        assert!(sig.aspect_years.contains(&2007));
        assert!(sig.aspect_maker_tokens.contains("action"));
        assert!(sig.tokens.contains("action"));
        assert!(sig.production_counts.contains(&2508));
    }

    #[test]
    fn mines_plain_description() {
        let raw = serde_json::json!({
            "description": "1998 Chromalusion, 1/24 scale, limited edition of 5,004",
        })
        .to_string();
        let sig = build_signals(
            "Jeff Gordon DuPont diecast",
            Some(&raw),
            &AliasMap::new(),
            &ListingAttrs::default(),
        );
        assert!(sig.years.contains(&1998));
        assert!(sig.scales.contains("1:24"));
        assert!(sig.production_counts.contains(&5004));
        // Description words must not leak into the scheme-overlap pool.
        assert!(!sig.tokens.contains("chromalusion"));
    }

    #[test]
    fn aspect_confirmation_outscores_title_only() {
        let c = full_cand(1, 2007, "1:24", "#24 Nicorette", None);
        let title_sig = signals("2007 Jeff Gordon Nicorette 1:24");
        let raw = serde_json::json!({
            "localizedAspects": [
                {"name": "Scale", "value": "1:24"},
                {"name": "Year", "value": "2007"},
            ],
        })
        .to_string();
        let aspect_sig = build_signals(
            "2007 Jeff Gordon Nicorette 1:24",
            Some(&raw),
            &AliasMap::new(),
            &ListingAttrs::default(),
        );
        let w = MatchWeights::default();
        let (tf, _) = extract_features(&title_sig, &c, true);
        let (af, ar) = extract_features(&aspect_sig, &c, true);
        assert!(af.score(&w) > tf.score(&w));
        assert!(ar.iter().any(|r| r.contains("item specifics")));
    }

    #[test]
    fn aliases_bridge_title_abbreviations_to_scheme_words() {
        let mut aliases = AliasMap::new();
        aliases.insert("bud".into(), vec!["budweiser".into()]);
        aliases.insert("budweiser".into(), vec!["bud".into()]);
        let c = Candidate {
            scheme_text: Some("Budweiser 2001 Monte Carlo".into()),
            ..cand(1)
        };
        let with = build_signals(
            "Dale Jr #8 Bud 1:24",
            None,
            &aliases,
            &ListingAttrs::default(),
        );
        let without = build_signals(
            "Dale Jr #8 Bud 1:24",
            None,
            &AliasMap::new(),
            &ListingAttrs::default(),
        );
        let (f_with, _) = extract_features(&with, &c, true);
        let (f_without, _) = extract_features(&without, &c, true);
        assert!(f_with.scheme_overlap > f_without.scheme_overlap);
    }

    #[test]
    fn attribute_columns_match_and_conflict() {
        let c = Candidate {
            oem: Some("Action / Lionel".into()),
            finish: Some("Color Chrome".into()),
            ..cand(1)
        };
        let attrs = ListingAttrs {
            oem: Some("Action/Lionel".into()),
            finish: Some("Standard".into()),
            ..Default::default()
        };
        let sig = build_signals("Jeff Gordon diecast", None, &AliasMap::new(), &attrs);
        let (f, reasons) = extract_features(&sig, &c, true);
        assert_eq!(f.attr_oem_match, 1.0, "spacing-insensitive OEM match");
        assert_eq!(f.attr_finish_conflict, 1.0);
        assert_eq!(f.attr_brand_match, 0.0, "absent on one side is no signal");
        assert!(reasons.iter().any(|r| r.contains("OEM attribute matches")));
        assert!(reasons
            .iter()
            .any(|r| r.contains("finish attribute differs")));
    }

    #[test]
    fn features_serialize_with_named_fields() {
        let (f, _) = extract_features(
            &signals("2007 Jeff Gordon #24 Nicorette 1:24"),
            &full_cand(1, 2007, "1:24", "#24 Nicorette", None),
            true,
        );
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(json["driver_match"], 1.0);
        assert_eq!(json["year_match"], 1.0);
        assert_eq!(json["scale_match"], 1.0);
        assert_eq!(json["prod_count_match"], 0.0);
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
        let (id, conf, _reasons) = pick(
            &signals("2007 Jeff Gordon #24 Nicorette 1:24 Action Elite 1 of 504"),
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
        let (id, _conf, _r) = pick(
            &signals("2007 Jeff Gordon #24 DuPont Flames 1:24 — 1 of 2,508"),
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
        let sig = signals("2007 Jeff Gordon #24 DuPont 1:24");
        let (_, conf_ambig, reasons) = pick(&sig, &candidates).unwrap();
        let (_, conf_clear, _) = pick(&sig, &candidates[..1].to_vec()).unwrap();
        assert!(conf_ambig < conf_clear);
        assert!(reasons.iter().any(|r| r.contains("almost equally")));
    }

    #[test]
    fn driver_only_match_stays_below_threshold() {
        // A bare title with nothing but the driver name shouldn't clear 50.
        let candidates = vec![full_cand(1, 2007, "1:24", "#24 Nicorette", Some(504))];
        let (_, conf, _) = pick(&signals("Jeff Gordon diecast lot"), &candidates).unwrap();
        assert!(conf < MIN_CONFIDENCE, "confidence was {conf}");
    }

    #[test]
    fn contradictory_scale_and_year_are_penalized() {
        let right = full_cand(1, 1998, "1:64", "#24 DuPont Chromalusion", None);
        let wrong = full_cand(2, 2005, "1:24", "#24 DuPont Flames", None);
        let sig = signals("1998 Jeff Gordon #24 DuPont Chromalusion 1:64");
        let (id, _, _) = pick(&sig, &vec![right.clone(), wrong.clone()]).unwrap();
        assert_eq!(id, 1);
        let w = MatchWeights::default();
        let (f_wrong, _) = extract_features(&sig, &wrong, true);
        let (f_right, _) = extract_features(&sig, &right, true);
        assert!(f_right.score(&w) - f_wrong.score(&w) > 30.0);
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
        assert!(pick(&signals("anything"), &[]).is_none());
    }
}
