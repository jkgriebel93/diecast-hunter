//! Fits the auto-matcher to the user's own verdicts.
//!
//! Training data comes from `match_feedback`: confirmed pairings are
//! positives, rejected/corrected pairings are negatives, and for every
//! confirmed pair the strongest same-driver runner-up candidates become
//! *implicit* negatives ("the user picked A, so B and C — which the scorer
//! also liked — were wrong"). A tiny logistic regression over the named
//! [`MatchFeatures`] is fit by full-batch gradient descent — deterministic,
//! dependency-free, and instant at this data size.
//!
//! The result only replaces the hand-tuned weights when it earns it:
//! grouped 5-fold cross-validation (folds split by listing so a listing
//! never straddles train/test) must score at least as well as the
//! hand-tuned baseline on the same folds, within a small tolerance. The
//! accepted model is stored as JSON under `settings::KEY_MATCH_MODEL` and
//! picked up by `ScoreModel::load` on the next scoring pass.
//!
//! `mine_aliases` is the second learner: title tokens that reliably
//! co-occur with a scheme word across confirmed matches — but never appear
//! in registry vocabulary themselves — become `scheme_aliases` rows with
//! `source = 'learned'`, bridging seller slang the seeds don't cover.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::settings;
use crate::sync::registry_auto_match::{
    build_signals, extract_features, load_aliases, load_candidates, scheme_tokens, sigmoid,
    tokenize, LearnedModel, MatchFeatures, MatchWeights, ScoreModel, FEATURE_NAMES, MIN_CONFIDENCE,
};

/// Minimum labeled data before a learned model may replace the defaults.
const MIN_POSITIVES: usize = 20;
const MIN_NEGATIVES: usize = 10;
/// The learned model may trail the baseline's CV accuracy by at most this
/// much and still activate (noise allowance at small sample sizes).
const CV_TOLERANCE: f64 = 0.02;
/// Hard negatives harvested per confirmed pair.
const IMPLICIT_NEGATIVES_PER_CONFIRM: usize = 3;
/// Implicit negatives carry less certainty than an explicit verdict.
const IMPLICIT_SAMPLE_WEIGHT: f64 = 0.5;
/// `maybe_retrain` fires once this many verdicts accumulate past the
/// last training run.
const AUTO_RETRAIN_NEW_ROWS: i64 = 25;

/// Learned-alias mining thresholds: a (title token → scheme token) bridge
/// needs at least this many supporting confirmed matches, and the scheme
/// token must appear in at least this fraction of the matches whose titles
/// carry the token.
const ALIAS_MIN_SUPPORT: u32 = 3;
const ALIAS_MIN_RATIO: f64 = 0.8;

/// Listing-title words too generic to ever become aliases.
const ALIAS_STOPWORDS: &[&str] = &[
    "the",
    "and",
    "with",
    "for",
    "from",
    "new",
    "nib",
    "nibs",
    "mint",
    "rare",
    "htf",
    "vintage",
    "diecast",
    "die",
    "cast",
    "nascar",
    "racing",
    "race",
    "raced",
    "car",
    "cars",
    "truck",
    "scale",
    "limited",
    "edition",
    "autographed",
    "signed",
    "box",
    "boxed",
    "sealed",
    "free",
    "shipping",
    "lot",
    "read",
    "look",
    "nice",
    "great",
    "sample",
    "version",
];

#[derive(Debug, Serialize, Clone)]
pub struct TrainOutcome {
    /// True when a learned model was stored (data gate + CV gate passed).
    pub activated: bool,
    pub positives: u32,
    pub explicit_negatives: u32,
    pub implicit_negatives: u32,
    pub cv_accuracy: Option<f64>,
    pub cv_accuracy_baseline: Option<f64>,
    pub cv_rank_accuracy: Option<f64>,
    pub cv_rank_accuracy_baseline: Option<f64>,
    pub learned_aliases: u32,
    /// Human-readable outcome for the Settings page.
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct WeightRow {
    pub name: String,
    pub default_weight: f64,
    pub learned_weight: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MatcherStatus {
    /// False → hand-tuned defaults are scoring.
    pub learned: bool,
    pub trained_at: Option<i64>,
    pub positives: Option<u32>,
    pub explicit_negatives: Option<u32>,
    pub implicit_negatives: Option<u32>,
    pub cv_accuracy: Option<f64>,
    pub cv_accuracy_baseline: Option<f64>,
    pub cv_rank_accuracy: Option<f64>,
    pub cv_rank_accuracy_baseline: Option<f64>,
    /// Live COUNT(match_feedback) and how many arrived since training.
    pub feedback_rows: i64,
    pub new_since_train: Option<i64>,
    pub learned_aliases: i64,
    pub weights: Vec<WeightRow>,
}

struct Example {
    x: Vec<f64>,
    y: f64,
    /// Listing id — CV folds split on this so one listing's examples never
    /// straddle train/test.
    group: i64,
    implicit: bool,
}

/// Retrain from all accumulated feedback, then re-mine learned aliases.
pub async fn retrain(pool: &SqlitePool) -> AppResult<TrainOutcome> {
    let examples = assemble_examples(pool).await?;
    let positives = examples.iter().filter(|e| e.y > 0.5).count();
    let explicit_negatives = examples.iter().filter(|e| e.y < 0.5 && !e.implicit).count();
    let implicit_negatives = examples.iter().filter(|e| e.y < 0.5 && e.implicit).count();
    let learned_aliases = mine_aliases(pool).await?;

    let mut outcome = TrainOutcome {
        activated: false,
        positives: positives as u32,
        explicit_negatives: explicit_negatives as u32,
        implicit_negatives: implicit_negatives as u32,
        cv_accuracy: None,
        cv_accuracy_baseline: None,
        cv_rank_accuracy: None,
        cv_rank_accuracy_baseline: None,
        learned_aliases,
        message: String::new(),
    };

    if positives < MIN_POSITIVES || explicit_negatives + implicit_negatives < MIN_NEGATIVES {
        outcome.message = format!(
            "Not enough feedback yet ({positives} confirms, {} rejections — need at least \
             {MIN_POSITIVES} and {MIN_NEGATIVES}). Keep confirming and rejecting matches.",
            explicit_negatives + implicit_negatives
        );
        return Ok(outcome);
    }

    let cv = cross_validate(&examples);
    outcome.cv_accuracy = Some(cv.point);
    outcome.cv_accuracy_baseline = Some(cv.point_baseline);
    outcome.cv_rank_accuracy = cv.rank;
    outcome.cv_rank_accuracy_baseline = cv.rank_baseline;

    let point_ok = cv.point + CV_TOLERANCE >= cv.point_baseline;
    let rank_ok = match (cv.rank, cv.rank_baseline) {
        (Some(r), Some(rb)) => r + CV_TOLERANCE >= rb,
        _ => true,
    };
    if !point_ok || !rank_ok {
        outcome.message = format!(
            "Learned weights didn't beat the built-ins in cross-validation \
             (verdict accuracy {:.0}% vs {:.0}%, ranking accuracy {} vs {}), \
             so the built-in weights stay active. More feedback usually fixes this.",
            cv.point * 100.0,
            cv.point_baseline * 100.0,
            fmt_pct(cv.rank),
            fmt_pct(cv.rank_baseline),
        );
        return Ok(outcome);
    }

    let (w, b) = fit(&examples.iter().collect::<Vec<_>>());
    let feedback_rows: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM match_feedback")
        .fetch_one(pool)
        .await?;
    let model = LearnedModel {
        weights: MatchWeights::from_slice(&w),
        bias: b,
        trained_at: Utc::now().timestamp(),
        positives: positives as u32,
        explicit_negatives: explicit_negatives as u32,
        implicit_negatives: implicit_negatives as u32,
        cv_accuracy: cv.point,
        cv_accuracy_baseline: cv.point_baseline,
        cv_rank_accuracy: cv.rank,
        cv_rank_accuracy_baseline: cv.rank_baseline,
        feedback_rows_at_train: feedback_rows.0,
    };
    settings::set(
        pool,
        settings::KEY_MATCH_MODEL,
        &serde_json::to_string(&model).expect("model serializes"),
    )
    .await?;

    outcome.activated = true;
    outcome.message = format!(
        "Learned weights active: {:.0}% cross-validated verdict accuracy \
         (built-ins: {:.0}%), ranking accuracy {} (built-ins: {}), trained on \
         {} confirms and {} rejections.",
        cv.point * 100.0,
        cv.point_baseline * 100.0,
        fmt_pct(cv.rank),
        fmt_pct(cv.rank_baseline),
        positives,
        explicit_negatives + implicit_negatives
    );
    Ok(outcome)
}

fn fmt_pct(v: Option<f64>) -> String {
    match v {
        Some(v) => format!("{:.0}%", v * 100.0),
        None => "n/a".to_string(),
    }
}

/// Drop the learned model, returning scoring to the hand-tuned defaults.
/// Feedback and learned aliases are kept.
pub async fn reset(pool: &SqlitePool) -> AppResult<()> {
    settings::delete(pool, settings::KEY_MATCH_MODEL).await
}

/// Current state for the Settings page.
pub async fn status(pool: &SqlitePool) -> AppResult<MatcherStatus> {
    let (feedback_rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM match_feedback")
        .fetch_one(pool)
        .await?;
    let (learned_aliases,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM scheme_aliases WHERE source = 'learned'")
            .fetch_one(pool)
            .await?;

    let defaults = MatchWeights::default().to_vec();
    let model = match ScoreModel::load(pool).await {
        ScoreModel::Learned(m) => Some(m),
        ScoreModel::Handcrafted(_) => None,
    };
    let learned_vec = model.as_ref().map(|m| m.weights.to_vec());
    let weights = FEATURE_NAMES
        .iter()
        .enumerate()
        .map(|(i, name)| WeightRow {
            name: name.to_string(),
            default_weight: defaults[i],
            learned_weight: learned_vec.as_ref().map(|v| v[i]),
        })
        .collect();

    Ok(MatcherStatus {
        learned: model.is_some(),
        trained_at: model.as_ref().map(|m| m.trained_at),
        positives: model.as_ref().map(|m| m.positives),
        explicit_negatives: model.as_ref().map(|m| m.explicit_negatives),
        implicit_negatives: model.as_ref().map(|m| m.implicit_negatives),
        cv_accuracy: model.as_ref().map(|m| m.cv_accuracy),
        cv_accuracy_baseline: model.as_ref().map(|m| m.cv_accuracy_baseline),
        cv_rank_accuracy: model.as_ref().and_then(|m| m.cv_rank_accuracy),
        cv_rank_accuracy_baseline: model.as_ref().and_then(|m| m.cv_rank_accuracy_baseline),
        new_since_train: model
            .as_ref()
            .map(|m| feedback_rows - m.feedback_rows_at_train),
        feedback_rows,
        learned_aliases,
        weights,
    })
}

/// Startup hook: retrain when enough new verdicts piled up since the last
/// run (or ever, if no model exists yet). Best-effort — failures only log.
pub async fn maybe_retrain(pool: &SqlitePool) {
    let count: Result<(i64,), _> = sqlx::query_as("SELECT COUNT(*) FROM match_feedback")
        .fetch_one(pool)
        .await;
    let Ok((count,)) = count else { return };
    let baseline = match ScoreModel::load(pool).await {
        ScoreModel::Learned(m) => m.feedback_rows_at_train,
        ScoreModel::Handcrafted(_) => 0,
    };
    if count - baseline < AUTO_RETRAIN_NEW_ROWS {
        return;
    }
    match retrain(pool).await {
        Ok(o) => tracing::info!("matcher auto-retrain: {}", o.message),
        Err(e) => tracing::warn!("matcher auto-retrain failed: {e}"),
    }
}

// ----- training-set assembly -----

/// Explicit examples use the feature snapshot taken at verdict time (the
/// append-only log is the ground truth of what the user saw). When the
/// same pair was judged more than once, the latest verdict wins. Implicit
/// negatives are computed fresh against today's registry data.
async fn assemble_examples(pool: &SqlitePool) -> AppResult<Vec<Example>> {
    let rows: Vec<(i64, i64, i64, String, String)> = sqlx::query_as(
        "SELECT id, listing_id, registry_entry_id, label, features_json
         FROM match_feedback
         WHERE features_json IS NOT NULL AND registry_entry_id IS NOT NULL
         ORDER BY id",
    )
    .fetch_all(pool)
    .await?;

    // Latest verdict per (listing, entry) pair.
    let mut latest: HashMap<(i64, i64), (i64, String, String)> = HashMap::new();
    for (id, listing_id, entry_id, label, features_json) in rows {
        latest.insert((listing_id, entry_id), (id, label, features_json));
    }

    let mut examples = Vec::new();
    let mut confirmed_pairs: Vec<(i64, i64)> = Vec::new();
    for ((listing_id, entry_id), (_, label, features_json)) in &latest {
        let Ok(features) = serde_json::from_str::<MatchFeatures>(features_json) else {
            tracing::warn!(
                "matcher training: unreadable features for listing {listing_id} / entry {entry_id}; skipping"
            );
            continue;
        };
        let y = if label == "confirmed" { 1.0 } else { 0.0 };
        if y > 0.5 {
            confirmed_pairs.push((*listing_id, *entry_id));
        }
        examples.push(Example {
            x: features.to_vec(),
            y,
            group: *listing_id,
            implicit: false,
        });
    }

    // Implicit negatives: the confirmed entry's strongest same-driver
    // rivals, minus anything already explicitly judged.
    let aliases = load_aliases(pool).await?;
    let default_weights = MatchWeights::default();
    for (listing_id, confirmed_entry) in confirmed_pairs {
        let listing: Option<(String, Option<i64>, Option<String>)> =
            sqlx::query_as("SELECT title, driver_id, raw_json FROM listings WHERE id = ?")
                .bind(listing_id)
                .fetch_optional(pool)
                .await?;
        let Some((title, Some(driver_id), raw_json)) = listing else {
            continue;
        };
        let sig = build_signals(&title, raw_json.as_deref(), &aliases);
        let mut rivals: Vec<(f64, MatchFeatures)> = load_candidates(pool, driver_id)
            .await?
            .iter()
            .filter(|c| c.id != confirmed_entry && !latest.contains_key(&(listing_id, c.id)))
            .map(|c| {
                let (f, _) = extract_features(&sig, c, true);
                (f.score(&default_weights), f)
            })
            .collect();
        rivals.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, f) in rivals.into_iter().take(IMPLICIT_NEGATIVES_PER_CONFIRM) {
            examples.push(Example {
                x: f.to_vec(),
                y: 0.0,
                group: listing_id,
                implicit: true,
            });
        }
    }

    Ok(examples)
}

// ----- logistic regression (pure, unit-tested) -----

/// Class-balanced sample weights so 3× more negatives than positives (or
/// vice versa) doesn't just teach the model the base rate; implicit
/// negatives are additionally discounted.
fn sample_weights(examples: &[&Example]) -> Vec<f64> {
    let n = examples.len() as f64;
    let n_pos = examples.iter().filter(|e| e.y > 0.5).count().max(1) as f64;
    let n_neg = (examples.len() - examples.iter().filter(|e| e.y > 0.5).count()).max(1) as f64;
    examples
        .iter()
        .map(|e| {
            let class = if e.y > 0.5 {
                n / (2.0 * n_pos)
            } else {
                n / (2.0 * n_neg)
            };
            if e.implicit {
                class * IMPLICIT_SAMPLE_WEIGHT
            } else {
                class
            }
        })
        .collect()
}

/// Full-batch gradient descent, zero-initialized (deterministic), L2 on
/// weights but not bias. Returns (weights, bias).
fn fit(examples: &[&Example]) -> (Vec<f64>, f64) {
    let dims = FEATURE_NAMES.len();
    let sw = sample_weights(examples);
    let mut w = vec![0.0; dims];
    let mut b = 0.0;
    let lr = 0.5;
    let l2 = 0.001;
    let n = examples.len() as f64;
    for _ in 0..2000 {
        let mut gw = vec![0.0; dims];
        let mut gb = 0.0;
        for (e, &s) in examples.iter().zip(&sw) {
            let z: f64 = e.x.iter().zip(&w).map(|(x, w)| x * w).sum::<f64>() + b;
            let err = (sigmoid(z) - e.y) * s;
            for (g, x) in gw.iter_mut().zip(&e.x) {
                *g += err * x;
            }
            gb += err;
        }
        for (wi, gi) in w.iter_mut().zip(&gw) {
            *wi -= lr * (gi / n + l2 * *wi);
        }
        b -= lr * gb / n;
    }
    (w, b)
}

struct CvMetrics {
    /// Accuracy on held-out *explicit* verdicts (what the user judged).
    /// Implicit negatives train the folds but are excluded here — they are
    /// selected to be the hardest cases, so scoring on them stacks the
    /// test set and makes both models look meaninglessly bad.
    point: f64,
    point_baseline: f64,
    /// Fraction of held-out confirmed listings whose confirmed entry
    /// outranks all of its implicit rivals — the decision `pick_best`
    /// actually makes. None when no held-out listing has rivals.
    rank: Option<f64>,
    rank_baseline: Option<f64>,
}

/// Grouped 5-fold CV (folds split by listing). The baseline is the
/// hand-tuned weights with the shipping decision rule (score ≥
/// `MIN_CONFIDENCE` → match); the learned rule is sigmoid ≥ 0.5, i.e.
/// z ≥ 0.
fn cross_validate(examples: &[Example]) -> CvMetrics {
    let defaults = MatchWeights::default().to_vec();
    let dot = |x: &[f64], w: &[f64]| -> f64 { x.iter().zip(w).map(|(a, b)| a * b).sum() };
    let (mut point_c, mut point_cb, mut point_n) = (0usize, 0usize, 0usize);
    let (mut rank_c, mut rank_cb, mut rank_n) = (0usize, 0usize, 0usize);

    for fold in 0..5i64 {
        let (train, test): (Vec<&Example>, Vec<&Example>) =
            examples.iter().partition(|e| e.group.rem_euclid(5) != fold);
        if test.is_empty() || train.is_empty() {
            continue;
        }
        let (w, b) = fit(&train);

        for e in test.iter().filter(|e| !e.implicit) {
            if (dot(&e.x, &w) + b >= 0.0) == (e.y > 0.5) {
                point_c += 1;
            }
            if (dot(&e.x, &defaults) >= MIN_CONFIDENCE) == (e.y > 0.5) {
                point_cb += 1;
            }
            point_n += 1;
        }

        // Ranking: group the held-out examples by listing; a listing with a
        // confirmed positive and at least one implicit rival scores when
        // the positive beats every rival.
        let mut groups: HashMap<i64, (Vec<&Example>, Vec<&Example>)> = HashMap::new();
        for e in &test {
            let entry = groups.entry(e.group).or_default();
            if e.y > 0.5 {
                entry.0.push(e);
            } else if e.implicit {
                entry.1.push(e);
            }
        }
        for (_, (positives, rivals)) in groups {
            if rivals.is_empty() {
                continue;
            }
            for p in positives {
                let learned_top = rivals.iter().all(|r| dot(&p.x, &w) > dot(&r.x, &w));
                let baseline_top = rivals
                    .iter()
                    .all(|r| dot(&p.x, &defaults) > dot(&r.x, &defaults));
                if learned_top {
                    rank_c += 1;
                }
                if baseline_top {
                    rank_cb += 1;
                }
                rank_n += 1;
            }
        }
    }

    CvMetrics {
        point: if point_n == 0 {
            0.0
        } else {
            point_c as f64 / point_n as f64
        },
        point_baseline: if point_n == 0 {
            0.0
        } else {
            point_cb as f64 / point_n as f64
        },
        rank: (rank_n > 0).then(|| rank_c as f64 / rank_n as f64),
        rank_baseline: (rank_n > 0).then(|| rank_cb as f64 / rank_n as f64),
    }
}

// ----- learned scheme aliases -----

/// Mine (title token → scheme token) bridges from confirmed matches and
/// replace the `source = 'learned'` alias rows with the current crop.
/// Conservative by construction: a token must be pure seller vocabulary
/// (absent from every scheme/OEM/brand/driver name in the registry), must
/// co-occur with the scheme token in at least `ALIAS_MIN_SUPPORT` distinct
/// confirmed matches, and in at least `ALIAS_MIN_RATIO` of all confirmed
/// matches whose titles carry it.
pub async fn mine_aliases(pool: &SqlitePool) -> AppResult<u32> {
    let pairs: Vec<(String, String)> = sqlx::query_as(
        "SELECT l.title, re.scheme_text
         FROM listing_matches lm
         JOIN listings l ON l.id = lm.listing_id
         JOIN registry_entries re ON re.id = lm.registry_entry_id
         WHERE lm.user_confirmed = 1 AND lm.registry_entry_id IS NOT NULL
           AND re.scheme_text IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;

    let registry_vocab = registry_vocabulary(pool).await?;
    let stop: HashSet<&str> = ALIAS_STOPWORDS.iter().copied().collect();

    let mut co: HashMap<(String, String), u32> = HashMap::new();
    let mut t_count: HashMap<String, u32> = HashMap::new();
    for (title, scheme) in &pairs {
        let title_tokens: HashSet<String> = tokenize(title)
            .into_iter()
            .filter(|t| {
                t.len() >= 3
                    && !t.chars().all(|c| c.is_ascii_digit())
                    && !registry_vocab.contains(t)
                    && !stop.contains(t.as_str())
            })
            .collect();
        let s_tokens: HashSet<String> = scheme_tokens(scheme)
            .into_iter()
            .filter(|s| s.len() >= 3)
            .collect();
        for t in &title_tokens {
            *t_count.entry(t.clone()).or_default() += 1;
            for s in &s_tokens {
                *co.entry((t.clone(), s.clone())).or_default() += 1;
            }
        }
    }

    sqlx::query("DELETE FROM scheme_aliases WHERE source = 'learned'")
        .execute(pool)
        .await?;

    let now = Utc::now().timestamp();
    let mut inserted = 0u32;
    for ((t, s), support) in co {
        if support < ALIAS_MIN_SUPPORT || t == s {
            continue;
        }
        let ratio = support as f64 / t_count[&t] as f64;
        if ratio < ALIAS_MIN_RATIO {
            continue;
        }
        let res = sqlx::query(
            "INSERT OR IGNORE INTO scheme_aliases (alias, canonical, source, created_at)
             VALUES (?, ?, 'learned', ?)",
        )
        .bind(&t)
        .bind(&s)
        .bind(now)
        .execute(pool)
        .await?;
        inserted += res.rows_affected() as u32;
    }
    if inserted > 0 {
        tracing::info!("alias mining: learned {inserted} scheme aliases");
    }
    Ok(inserted)
}

/// Every token the registry itself uses — scheme texts, OEMs, brands, and
/// driver names. A title token that exists here is registry vocabulary and
/// doesn't need an alias bridge.
async fn registry_vocabulary(pool: &SqlitePool) -> AppResult<HashSet<String>> {
    let mut vocab = HashSet::new();
    let entry_rows: Vec<(Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT scheme_text, oem, brand FROM registry_entries")
            .fetch_all(pool)
            .await?;
    for (scheme, oem, brand) in entry_rows {
        for text in [scheme, oem, brand].into_iter().flatten() {
            vocab.extend(tokenize(&text));
        }
    }
    let driver_rows: Vec<(String,)> = sqlx::query_as("SELECT name FROM drivers")
        .fetch_all(pool)
        .await?;
    for (name,) in driver_rows {
        vocab.extend(tokenize(&name));
    }
    Ok(vocab)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex(x: Vec<f64>, y: f64, group: i64) -> Example {
        Example {
            x,
            y,
            group,
            implicit: false,
        }
    }

    /// Pad a short feature prefix out to the full width.
    fn padded(prefix: &[f64]) -> Vec<f64> {
        let mut v = prefix.to_vec();
        v.resize(FEATURE_NAMES.len(), 0.0);
        v
    }

    #[test]
    fn fit_separates_a_predictive_feature() {
        // Feature 1 present → positive, feature 2 present → negative.
        let mut examples = Vec::new();
        for i in 0..30 {
            examples.push(ex(padded(&[1.0, 1.0]), 1.0, i));
            examples.push(ex(padded(&[1.0, 0.0, 1.0]), 0.0, i + 100));
        }
        let (w, b) = fit(&examples.iter().collect::<Vec<_>>());
        let pos = sigmoid(
            padded(&[1.0, 1.0])
                .iter()
                .zip(&w)
                .map(|(x, w)| x * w)
                .sum::<f64>()
                + b,
        );
        let neg = sigmoid(
            padded(&[1.0, 0.0, 1.0])
                .iter()
                .zip(&w)
                .map(|(x, w)| x * w)
                .sum::<f64>()
                + b,
        );
        assert!(pos > 0.9, "positive pattern scored {pos}");
        assert!(neg < 0.1, "negative pattern scored {neg}");
        assert!(w[1] > 0.0 && w[2] < 0.0);
    }

    #[test]
    fn cross_validate_scores_a_learnable_set_high() {
        let mut examples = Vec::new();
        for i in 0..50 {
            examples.push(ex(padded(&[1.0, 1.0]), 1.0, i));
            examples.push(ex(padded(&[1.0, 0.0, 1.0]), 0.0, i + 1000));
        }
        let cv = cross_validate(&examples);
        assert!(cv.point > 0.9, "cv accuracy was {}", cv.point);
    }

    #[test]
    fn sample_weights_balance_classes() {
        let mut examples = Vec::new();
        for i in 0..10 {
            examples.push(ex(padded(&[1.0]), 1.0, i));
        }
        for i in 0..30 {
            examples.push(ex(padded(&[1.0]), 0.0, i + 100));
        }
        let sw = sample_weights(&examples.iter().collect::<Vec<_>>());
        let pos_total: f64 = sw[..10].iter().sum();
        let neg_total: f64 = sw[10..].iter().sum();
        assert!((pos_total - neg_total).abs() < 1e-9);
    }

    // --- DB-backed tests -------------------------------------------------

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    async fn migrated_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open in-memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn insert_listing(pool: &SqlitePool, title: &str) -> i64 {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM listings")
            .fetch_one(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO listings
                (seller_id, external_id, url, title, saved_at, last_seen_at)
             VALUES (1, ?, 'https://example.com', ?, 0, 0)",
        )
        .bind(format!("v1|{n}|0"))
        .bind(title)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    async fn insert_entry(pool: &SqlitePool, guid: &str, scheme: &str) -> i64 {
        sqlx::query(
            "INSERT INTO registry_entries (external_id, scheme_text, fetched_at)
             VALUES (?, ?, 0)",
        )
        .bind(guid)
        .bind(scheme)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    async fn insert_feedback(
        pool: &SqlitePool,
        listing_id: i64,
        entry_id: i64,
        label: &str,
        features: &MatchFeatures,
    ) {
        sqlx::query(
            "INSERT INTO match_feedback
                (listing_id, registry_entry_id, label, source, features_json, score, created_at)
             VALUES (?, ?, ?, 'test', ?, 0.0, 0)",
        )
        .bind(listing_id)
        .bind(entry_id)
        .bind(label)
        .bind(serde_json::to_string(features).unwrap())
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn retrain_below_data_gate_stays_on_defaults() {
        let pool = migrated_pool().await;
        let outcome = retrain(&pool).await.unwrap();
        assert!(!outcome.activated);
        assert!(outcome.message.contains("Not enough feedback"));
        assert!(matches!(
            ScoreModel::load(&pool).await,
            ScoreModel::Handcrafted(_)
        ));
    }

    #[tokio::test]
    async fn retrain_learns_and_activates_from_verdicts() {
        let pool = migrated_pool().await;
        let entry = insert_entry(&pool, "guid-train", "#24 DuPont").await;

        // Positives look like year+scale matches; negatives like conflicts.
        let pos = MatchFeatures {
            driver_match: 1.0,
            year_match: 1.0,
            scale_match: 1.0,
            ..Default::default()
        };
        let neg = MatchFeatures {
            driver_match: 1.0,
            year_conflict: 1.0,
            scale_conflict: 1.0,
            ..Default::default()
        };
        for i in 0..30 {
            let l = insert_listing(&pool, &format!("pos listing {i}")).await;
            insert_feedback(&pool, l, entry, "confirmed", &pos).await;
        }
        for i in 0..15 {
            let l = insert_listing(&pool, &format!("neg listing {i}")).await;
            insert_feedback(&pool, l, entry, "rejected", &neg).await;
        }

        let outcome = retrain(&pool).await.unwrap();
        assert!(outcome.activated, "message: {}", outcome.message);
        assert_eq!(outcome.positives, 30);
        assert_eq!(outcome.explicit_negatives, 15);
        assert!(outcome.cv_accuracy.unwrap() > 0.9);

        // The stored model now scores the two patterns on opposite sides
        // of the 50 threshold.
        let model = ScoreModel::load(&pool).await;
        assert!(matches!(model, ScoreModel::Learned(_)));
        assert!(model.confidence(&pos) > MIN_CONFIDENCE);
        assert!(model.confidence(&neg) < MIN_CONFIDENCE);

        // Reset drops back to the defaults.
        reset(&pool).await.unwrap();
        assert!(matches!(
            ScoreModel::load(&pool).await,
            ScoreModel::Handcrafted(_)
        ));
    }

    #[tokio::test]
    async fn mines_seller_vocabulary_aliases() {
        let pool = migrated_pool().await;
        // "budcar" is seller slang: in titles, never in registry vocabulary.
        // "diecast" is stopworded even though it also co-occurs.
        for i in 0..3 {
            let entry = insert_entry(&pool, &format!("guid-{i}"), "Budweiser Racing").await;
            let l = insert_listing(&pool, &format!("Dale budcar diecast red {i}")).await;
            sqlx::query(
                "INSERT INTO listing_matches
                    (listing_id, registry_entry_id, confidence, user_confirmed, matched_at)
                 VALUES (?, ?, 100.0, 1, 0)",
            )
            .bind(l)
            .bind(entry)
            .execute(&pool)
            .await
            .unwrap();
        }

        let inserted = mine_aliases(&pool).await.unwrap();
        assert!(inserted > 0);
        let (budcar,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheme_aliases
             WHERE alias = 'budcar' AND canonical = 'budweiser' AND source = 'learned'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(budcar, 1);
        let (stopworded,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM scheme_aliases WHERE alias = 'diecast'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stopworded, 0);
        // Re-mining replaces rather than duplicates.
        mine_aliases(&pool).await.unwrap();
        let (budcar2,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM scheme_aliases WHERE alias = 'budcar' AND canonical = 'budweiser'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(budcar2, 1);
    }
}
