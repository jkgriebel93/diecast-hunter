//! Match-orchestration layer: load drivers + registry entries from the DB,
//! call the pure scorer in `crate::matcher`, and persist results to
//! `listing_matches`. Auto-match runs after every listing add/refresh; bulk
//! re-match is exposed as a Tauri command.

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::matcher::{
    best_match, DriverInfo, MatchableEntry, AUTO_MATCH_THRESHOLD, REVIEW_THRESHOLD,
};

#[derive(Debug, Default, Serialize, Clone)]
pub struct MatchSummary {
    pub considered: u32,
    pub auto_matched: u32,
    pub needs_review: u32,
    pub unmatched: u32,
}

/// Match a single listing. Loads the cached driver + entry tables on each
/// call — fine for personal-use volumes; if this becomes a hot path we'll
/// cache them.
pub async fn match_listing(pool: &SqlitePool, listing_id: i64) -> AppResult<()> {
    let title: Option<(String,)> =
        sqlx::query_as("SELECT title FROM listings WHERE id = ?")
            .bind(listing_id)
            .fetch_optional(pool)
            .await?;
    let Some((title,)) = title else {
        return Ok(());
    };
    let drivers = load_drivers(pool).await?;
    let entries = load_entries(pool).await?;
    apply_match(pool, listing_id, &title, &drivers, &entries).await
}

/// Re-match every listing. Loads the driver + entry tables once and reuses
/// across all listings.
pub async fn match_all(pool: &SqlitePool) -> AppResult<MatchSummary> {
    let drivers = load_drivers(pool).await?;
    let entries = load_entries(pool).await?;
    let listings: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, title FROM listings ORDER BY id")
            .fetch_all(pool)
            .await?;

    let mut summary = MatchSummary {
        considered: listings.len() as u32,
        ..Default::default()
    };

    for (id, title) in listings {
        let result = best_match(&title, &drivers, &entries);
        match result {
            Some(m) if m.score >= AUTO_MATCH_THRESHOLD => {
                upsert_match(pool, id, Some(m.registry_entry_id), m.score).await?;
                summary.auto_matched += 1;
            }
            Some(m) if m.score >= REVIEW_THRESHOLD => {
                upsert_match(pool, id, Some(m.registry_entry_id), m.score).await?;
                summary.needs_review += 1;
            }
            _ => {
                upsert_match(pool, id, None, 0.0).await?;
                summary.unmatched += 1;
            }
        }
    }
    Ok(summary)
}

async fn apply_match(
    pool: &SqlitePool,
    listing_id: i64,
    title: &str,
    drivers: &[DriverInfo],
    entries: &[MatchableEntry],
) -> AppResult<()> {
    let result = best_match(title, drivers, entries);
    match result {
        Some(m) if m.score >= REVIEW_THRESHOLD => {
            upsert_match(pool, listing_id, Some(m.registry_entry_id), m.score).await
        }
        _ => upsert_match(pool, listing_id, None, 0.0).await,
    }
}

async fn upsert_match(
    pool: &SqlitePool,
    listing_id: i64,
    registry_entry_id: Option<i64>,
    confidence: f64,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO listing_matches
            (listing_id, registry_entry_id, confidence, user_confirmed, matched_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(listing_id) DO UPDATE SET
            registry_entry_id = excluded.registry_entry_id,
            confidence = excluded.confidence,
            matched_at = excluded.matched_at
         WHERE listing_matches.user_confirmed = 0",
    )
    .bind(listing_id)
    .bind(registry_entry_id)
    .bind(confidence)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

async fn load_drivers(pool: &SqlitePool) -> AppResult<Vec<DriverInfo>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT name, normalized_name FROM drivers")
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(name, normalized)| DriverInfo {
            normalized,
            tokens: name
                .to_lowercase()
                .split_whitespace()
                .map(|s| s.to_string())
                .collect(),
        })
        .collect())
}

#[derive(sqlx::FromRow)]
struct EntryRaw {
    id: i64,
    driver_normalized: Option<String>,
    year_released: Option<i32>,
    year_raced: Option<i32>,
    oem: Option<String>,
    brand: Option<String>,
    scale: Option<String>,
    make: Option<String>,
    finish: Option<String>,
    scheme_text: Option<String>,
    car_number: Option<String>,
}

async fn load_entries(pool: &SqlitePool) -> AppResult<Vec<MatchableEntry>> {
    // year_released maps to registry_entries.year (existing column name from
    // M1) since we never split it; year_raced was added in 0003.
    let rows: Vec<EntryRaw> = sqlx::query_as(
        "SELECT re.id,
                d.normalized_name AS driver_normalized,
                re.year AS year_released,
                re.year_raced,
                re.oem,
                re.brand,
                re.scale,
                re.make,
                re.finish,
                re.scheme_text,
                re.car_number
         FROM registry_entries re
         LEFT JOIN drivers d ON d.id = re.driver_id",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| MatchableEntry {
            id: r.id,
            driver_normalized: r.driver_normalized,
            year_released: r.year_released,
            year_raced: r.year_raced,
            oem: r.oem,
            brand: r.brand,
            scale: r.scale,
            make: r.make,
            finish: r.finish,
            scheme_text: r.scheme_text,
            car_number: r.car_number,
        })
        .collect())
}
