//! Bulk-populates `registry_entries` for a single driver by walking every
//! page of the /Production search filtered to that driver. Each result
//! becomes an upserted stub row carrying the data the search page itself
//! exposes (year, OEM, brand, scale, scheme, retail/wholesale). The
//! matcher can use those rows immediately — no detail-page fetch required.
//! Full M3 enrichment can run later for fields the search page doesn't
//! expose (production qty, finish, registration #).

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::{
    search_all_pages_with_progress, DcrClient, ProductionSearchFilter, ProductionSearchResult,
};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;

#[derive(Debug, Default, Serialize, Clone)]
pub struct PrewarmSummary {
    pub driver_name: String,
    pub results_seen: u32,
    pub registry_entries_upserted: u32,
    pub pages_fetched: u32,
}

pub async fn prewarm_by_driver(
    pool: &SqlitePool,
    driver_guid: &str,
    progress: &ProgressEmitter,
) -> AppResult<PrewarmSummary> {
    if driver_guid.trim().is_empty() {
        return Err(AppError::Parse("driver_guid is required".into()));
    }

    progress.step("Logging in to diecastregistry.com…", None, None);

    let username = settings::get(pool, settings::KEY_DCR_USERNAME)
        .await?
        .ok_or_else(|| {
            AppError::NotConfigured(
                "diecastregistry.com username not set in Settings".into(),
            )
        })?;
    let password = settings::secret_get(settings::ENTRY_DCR_PASSWORD)?
        .ok_or_else(|| {
            AppError::NotConfigured(
                "diecastregistry.com password not set in Settings".into(),
            )
        })?;
    let client = DcrClient::new()?;
    client.login(&username, &password).await?;

    let driver_display: Option<(String,)> = sqlx::query_as(
        "SELECT display FROM registry_form_options
         WHERE field = 'driver' AND value = ?",
    )
    .bind(driver_guid)
    .fetch_optional(pool)
    .await?;
    let driver_name = driver_display
        .map(|(d,)| d)
        .unwrap_or_else(|| "(unknown driver)".to_string());

    progress.step(
        format!("Searching registry for {driver_name}…"),
        None,
        None,
    );

    let filter = ProductionSearchFilter {
        driver_guids: vec![driver_guid.to_string()],
        ..Default::default()
    };

    let (results, pages_fetched) =
        search_all_pages_with_progress(&client, &filter, progress, Some(&driver_name)).await?;
    let results_seen = results.len() as u32;

    let mut upserted = 0u32;
    for (i, r) in results.iter().enumerate() {
        progress.check_cancelled()?;
        if i % 25 == 0 {
            progress.step(
                format!(
                    "Saving {} of {} entries for {}…",
                    i, results_seen, driver_name
                ),
                Some(i as u32),
                Some(results_seen),
            );
        }
        match upsert_stub_from_search(pool, r).await {
            Ok(()) => upserted += 1,
            Err(e) => tracing::warn!(
                "registry-prewarm: failed to upsert {}: {e}",
                r.registry_guid
            ),
        }
    }

    settings::set(
        pool,
        &format!("dcr.last_prewarm.{driver_guid}"),
        &Utc::now().timestamp().to_string(),
    )
    .await?;

    progress.done(format!(
        "Pre-warm complete: {upserted} entries for {driver_name}."
    ));

    Ok(PrewarmSummary {
        driver_name,
        results_seen,
        registry_entries_upserted: upserted,
        pages_fetched,
    })
}

async fn upsert_stub_from_search(
    pool: &SqlitePool,
    r: &ProductionSearchResult,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    let driver_id = upsert_driver(pool, &r.driver_name, &r.driver_normalized).await?;

    // raw_json carries detail_url so M3 enrichment can find the page later,
    // plus the search-page-only fields we'd otherwise drop.
    let raw_json = serde_json::to_string(&serde_json::json!({
        "detail_url": r.detail_url,
        "image_url": r.image_url,
        "scheme_text": r.scheme_text,
        "seq_produced_total": r.seq_produced_total,
        "source": "registry_prewarm",
    }))
    .unwrap_or_default();

    sqlx::query(
        "INSERT INTO registry_entries
            (external_id, driver_id, year, oem, brand, scale, make,
             scheme_text, production_qty,
             retail_value_cents, wholesale_value_cents,
             raw_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
            driver_id = COALESCE(excluded.driver_id, registry_entries.driver_id),
            year = COALESCE(excluded.year, registry_entries.year),
            oem = COALESCE(excluded.oem, registry_entries.oem),
            brand = COALESCE(excluded.brand, registry_entries.brand),
            scale = COALESCE(excluded.scale, registry_entries.scale),
            make = COALESCE(excluded.make, registry_entries.make),
            scheme_text = COALESCE(excluded.scheme_text, registry_entries.scheme_text),
            production_qty = COALESCE(excluded.production_qty, registry_entries.production_qty),
            retail_value_cents = COALESCE(excluded.retail_value_cents, registry_entries.retail_value_cents),
            wholesale_value_cents = COALESCE(excluded.wholesale_value_cents, registry_entries.wholesale_value_cents),
            raw_json = excluded.raw_json,
            fetched_at = excluded.fetched_at",
    )
    .bind(&r.registry_guid)
    .bind(driver_id)
    .bind(r.year)
    .bind(&r.oem)
    .bind(&r.brand)
    .bind(&r.scale)
    .bind(&r.make)
    .bind(&r.scheme_text)
    .bind(r.seq_produced_total)
    .bind(r.retail_value_cents)
    .bind(r.wholesale_value_cents)
    .bind(&raw_json)
    .bind(now)
    .execute(pool)
    .await?;

    Ok(())
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
    let row: (i64,) = sqlx::query_as("SELECT id FROM drivers WHERE normalized_name = ?")
        .bind(normalized)
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}
