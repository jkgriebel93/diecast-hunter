//! Append-only recording of user verdicts on listing↔registry pairings.
//!
//! `listing_matches` keeps one mutable row per listing, so every confirm,
//! reject, or re-link *destroys* the evidence of what the user decided.
//! This module writes that evidence to `match_feedback` instead — one row
//! per verdict, never updated — together with the pair's feature vector as
//! computed by the auto-matcher at verdict time. That log is the training
//! data for fitting [`MatchWeights`](crate::sync::registry_auto_match::MatchWeights)
//! to real decisions instead of hand-tuned points.
//!
//! Recording is always best-effort from the callers' point of view: a
//! failed insert must never fail the confirm/reject/link that triggered it.
//! Use [`record_best_effort`] unless you have a reason to see the error.

use chrono::Utc;
use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::sync::registry_auto_match;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedbackLabel {
    /// The user accepted this pairing (manual link or confirming an
    /// auto-suggestion).
    Confirmed,
    /// The user said this pairing is wrong — or, with no entry, that the
    /// listing has no registry match at all.
    Rejected,
    /// An auto-suggestion the user replaced by manually linking a
    /// different entry.
    CorrectedAway,
}

impl FeedbackLabel {
    fn as_str(self) -> &'static str {
        match self {
            FeedbackLabel::Confirmed => "confirmed",
            FeedbackLabel::Rejected => "rejected",
            FeedbackLabel::CorrectedAway => "corrected_away",
        }
    }
}

/// Record one verdict. `source` names the UI path ('manual_link',
/// 'confirm_button', 'reject_button', …). The feature snapshot is itself
/// best-effort — a listing or entry that vanished mid-flight just leaves
/// `features_json` NULL rather than dropping the verdict.
pub async fn record(
    pool: &SqlitePool,
    listing_id: i64,
    registry_entry_id: Option<i64>,
    label: FeedbackLabel,
    source: &str,
) -> AppResult<()> {
    let (features_json, score) = match registry_entry_id {
        Some(entry_id) => {
            match registry_auto_match::features_for_pair(pool, listing_id, entry_id).await {
                Ok(Some((features, score))) => (serde_json::to_string(&features).ok(), Some(score)),
                Ok(None) => (None, None),
                Err(e) => {
                    tracing::warn!(
                        "match-feedback: feature snapshot for listing {listing_id} / entry {entry_id} failed: {e}"
                    );
                    (None, None)
                }
            }
        }
        None => (None, None),
    };

    sqlx::query(
        "INSERT INTO match_feedback
            (listing_id, registry_entry_id, label, source,
             features_json, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(listing_id)
    .bind(registry_entry_id)
    .bind(label.as_str())
    .bind(source)
    .bind(features_json)
    .bind(score)
    .bind(Utc::now().timestamp())
    .execute(pool)
    .await?;
    Ok(())
}

/// [`record`], but a failure only logs — for call sites where feedback
/// bookkeeping must never break the user-facing operation.
pub async fn record_best_effort(
    pool: &SqlitePool,
    listing_id: i64,
    registry_entry_id: Option<i64>,
    label: FeedbackLabel,
    source: &str,
) {
    if let Err(e) = record(pool, listing_id, registry_entry_id, label, source).await {
        tracing::warn!(
            "match-feedback: recording {} for listing {listing_id} failed: {e}",
            label.as_str()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    async fn insert_driver(pool: &SqlitePool, name: &str, norm: &str) -> i64 {
        sqlx::query("INSERT INTO drivers (name, normalized_name) VALUES (?, ?)")
            .bind(name)
            .bind(norm)
            .execute(pool)
            .await
            .unwrap()
            .last_insert_rowid()
    }

    async fn insert_entry(pool: &SqlitePool, driver_id: i64) -> i64 {
        sqlx::query(
            "INSERT INTO registry_entries
                (external_id, driver_id, year, scale, scheme_text, fetched_at)
             VALUES ('guid-1', ?, 2007, '1:24', '#24 Nicorette', 0)",
        )
        .bind(driver_id)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    async fn insert_listing(pool: &SqlitePool, driver_id: Option<i64>) -> i64 {
        sqlx::query(
            "INSERT INTO listings
                (seller_id, external_id, url, title, driver_id, saved_at, last_seen_at)
             VALUES (1, 'v1|1|0', 'https://example.com', '2007 Jeff Gordon #24 Nicorette 1:24', ?, 0, 0)",
        )
        .bind(driver_id)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    #[tokio::test]
    async fn confirmed_verdict_snapshots_features() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Jeff Gordon", "jeff gordon").await;
        let entry = insert_entry(&pool, driver).await;
        let listing = insert_listing(&pool, Some(driver)).await;

        record(
            &pool,
            listing,
            Some(entry),
            FeedbackLabel::Confirmed,
            "manual_link",
        )
        .await
        .unwrap();

        let (label, entry_id, features_json, score): (
            String,
            Option<i64>,
            Option<String>,
            Option<f64>,
        ) = sqlx::query_as(
            "SELECT label, registry_entry_id, features_json, score
                 FROM match_feedback WHERE listing_id = ?",
        )
        .bind(listing)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(label, "confirmed");
        assert_eq!(entry_id, Some(entry));
        let features: serde_json::Value =
            serde_json::from_str(&features_json.expect("features snapshot")).unwrap();
        assert_eq!(features["driver_match"], 1.0);
        assert_eq!(features["year_match"], 1.0);
        assert_eq!(features["scale_match"], 1.0);
        assert!(score.unwrap() >= 50.0);
    }

    #[tokio::test]
    async fn driver_mismatch_is_captured_in_the_snapshot() {
        let pool = migrated_pool().await;
        let d1 = insert_driver(&pool, "Jeff Gordon", "jeff gordon").await;
        let d2 = insert_driver(&pool, "Dale Earnhardt Jr", "dale earnhardt jr").await;
        let entry = insert_entry(&pool, d1).await;
        let listing = insert_listing(&pool, Some(d2)).await;

        record(
            &pool,
            listing,
            Some(entry),
            FeedbackLabel::CorrectedAway,
            "manual_link",
        )
        .await
        .unwrap();

        let (features_json,): (Option<String>,) =
            sqlx::query_as("SELECT features_json FROM match_feedback WHERE listing_id = ?")
                .bind(listing)
                .fetch_one(&pool)
                .await
                .unwrap();
        let features: serde_json::Value = serde_json::from_str(&features_json.unwrap()).unwrap();
        assert_eq!(features["driver_match"], 0.0);
    }

    #[tokio::test]
    async fn bare_rejection_has_no_entry_and_no_features() {
        let pool = migrated_pool().await;
        let listing = insert_listing(&pool, None).await;

        record(
            &pool,
            listing,
            None,
            FeedbackLabel::Rejected,
            "reject_button",
        )
        .await
        .unwrap();

        let (label, entry_id, features_json): (String, Option<i64>, Option<String>) =
            sqlx::query_as(
                "SELECT label, registry_entry_id, features_json
                 FROM match_feedback WHERE listing_id = ?",
            )
            .bind(listing)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(label, "rejected");
        assert_eq!(entry_id, None);
        assert_eq!(features_json, None);
    }

    #[tokio::test]
    async fn verdicts_append_rather_than_overwrite() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Jeff Gordon", "jeff gordon").await;
        let entry = insert_entry(&pool, driver).await;
        let listing = insert_listing(&pool, Some(driver)).await;

        record(
            &pool,
            listing,
            Some(entry),
            FeedbackLabel::Rejected,
            "reject_button",
        )
        .await
        .unwrap();
        record(
            &pool,
            listing,
            Some(entry),
            FeedbackLabel::Confirmed,
            "manual_link",
        )
        .await
        .unwrap();

        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM match_feedback WHERE listing_id = ?")
                .bind(listing)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 2);
    }
}
