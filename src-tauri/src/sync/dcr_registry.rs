use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::{parse_detail_page, DcrClient, RegistryDetail};
use crate::error::{AppError, AppResult};

/// Re-enrich entries last fetched more than this many seconds ago.
const REFRESH_AFTER_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

#[derive(Debug, Default, Serialize, Clone)]
pub struct EnrichSummary {
    pub considered: u32,
    pub enriched: u32,
    pub skipped: u32,
    pub failed: u32,
}

/// Enrich registry_entries rows that are still stubs (no details_fetched_at)
/// or whose details are older than REFRESH_AFTER_SECONDS.
///
/// `client` is expected to already be logged in. The DcrClient's built-in
/// rate limiter paces each detail-page fetch.
pub async fn enrich_pending_registry_entries(
    pool: &SqlitePool,
    client: &DcrClient,
    force: bool,
) -> AppResult<EnrichSummary> {
    let cutoff = Utc::now().timestamp() - REFRESH_AFTER_SECONDS;
    let rows: Vec<(i64, String, Option<String>, Option<i64>)> = if force {
        sqlx::query_as(
            "SELECT id, external_id, raw_json, details_fetched_at
             FROM registry_entries
             WHERE external_id IS NOT NULL
             ORDER BY id",
        )
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, external_id, raw_json, details_fetched_at
             FROM registry_entries
             WHERE external_id IS NOT NULL
               AND (details_fetched_at IS NULL OR details_fetched_at < ?)
             ORDER BY id",
        )
        .bind(cutoff)
        .fetch_all(pool)
        .await?
    };

    let mut summary = EnrichSummary {
        considered: rows.len() as u32,
        ..Default::default()
    };

    for (id, external_id, raw_json, _details_fetched_at) in rows {
        let detail_url = match extract_detail_url(raw_json.as_deref()) {
            Some(u) => u,
            None => {
                tracing::warn!(
                    "registry_entry {id} ({external_id}): no detail_url in raw_json — skipping"
                );
                summary.skipped += 1;
                continue;
            }
        };

        match enrich_one(pool, client, id, &external_id, &detail_url).await {
            Ok(()) => summary.enriched += 1,
            Err(e) => {
                tracing::warn!(
                    "registry_entry {id} ({external_id}): enrichment failed: {e}"
                );
                summary.failed += 1;
            }
        }
    }

    Ok(summary)
}

async fn enrich_one(
    pool: &SqlitePool,
    client: &DcrClient,
    row_id: i64,
    expected_external_id: &str,
    detail_url: &str,
) -> AppResult<()> {
    let html = client.get_html(detail_url).await?;
    let detail = parse_detail_page(&html)?;

    // Defense in depth: if the detail page resolves a different GUID than
    // what we have on file, refuse to write — something is wrong.
    if let Some(parsed_id) = detail.external_id.as_deref() {
        if parsed_id != expected_external_id {
            return Err(AppError::Parse(format!(
                "external_id mismatch: expected {expected_external_id}, got {parsed_id}"
            )));
        }
    }

    let driver_id = match (&detail.driver_name, &detail.driver_normalized) {
        (Some(name), Some(norm)) => Some(upsert_driver(pool, name, norm).await?),
        _ => None,
    };

    let now = Utc::now().timestamp();
    let raw_json = build_raw_json(&detail);

    sqlx::query(
        "UPDATE registry_entries SET
            driver_id = COALESCE(?, driver_id),
            year = COALESCE(?, year),
            year_raced = COALESCE(?, year_raced),
            car_number = COALESCE(?, car_number),
            diecast_type = COALESCE(?, diecast_type),
            registration_number = COALESCE(?, registration_number),
            scheme_text = COALESCE(?, scheme_text),
            scale = COALESCE(?, scale),
            oem = COALESCE(?, oem),
            brand = COALESCE(?, brand),
            make = COALESCE(?, make),
            finish = COALESCE(?, finish),
            production_qty = COALESCE(?, production_qty),
            retail_value_cents = COALESCE(?, retail_value_cents),
            wholesale_value_cents = COALESCE(?, wholesale_value_cents),
            raw_json = ?,
            fetched_at = ?,
            details_fetched_at = ?
         WHERE id = ?",
    )
    .bind(driver_id)
    .bind(detail.year_released)
    .bind(detail.year_raced)
    .bind(&detail.car_number)
    .bind(&detail.diecast_type)
    .bind(&detail.registration_number)
    .bind(&detail.scheme_text)
    .bind(&detail.scale)
    .bind(&detail.oem)
    .bind(&detail.brand)
    .bind(&detail.make)
    .bind(&detail.finish)
    .bind(detail.production_qty)
    .bind(detail.retail_value_cents)
    .bind(detail.wholesale_value_cents)
    .bind(&raw_json)
    .bind(now)
    .bind(now)
    .bind(row_id)
    .execute(pool)
    .await?;

    Ok(())
}

fn extract_detail_url(raw_json: Option<&str>) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw_json?).ok()?;
    v.get("detail_url")?.as_str().map(|s| s.to_string())
}

fn build_raw_json(detail: &RegistryDetail) -> String {
    serde_json::to_string(&serde_json::json!({
        "source": "registry_detail_page",
        "external_id": detail.external_id,
        "registration_number": detail.registration_number,
        "registry_int_id": detail.registry_int_id,
        "driver_name": detail.driver_name,
        "scheme_text": detail.scheme_text,
        "comments": detail.comments,
        "photos": detail.photos,
    }))
    .unwrap_or_default()
}

async fn upsert_driver(
    pool: &SqlitePool,
    name: &str,
    normalized: &str,
) -> AppResult<i64> {
    sqlx::query(
        "INSERT INTO drivers (name, normalized_name) VALUES (?, ?)
         ON CONFLICT(normalized_name) DO UPDATE SET name = excluded.name",
    )
    .bind(name)
    .bind(normalized)
    .execute(pool)
    .await?;
    let row: (i64,) =
        sqlx::query_as("SELECT id FROM drivers WHERE normalized_name = ?")
            .bind(normalized)
            .fetch_one(pool)
            .await?;
    Ok(row.0)
}
