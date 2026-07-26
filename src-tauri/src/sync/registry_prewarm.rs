//! Bulk-populates `registry_entries` for a single driver by walking every
//! page of the /Production search filtered to that driver. Each result
//! becomes an upserted stub row carrying the data the search page itself
//! exposes (year, OEM, brand, scale, scheme, retail/wholesale), giving the
//! registry-search dialog candidates to surface immediately — no detail-page
//! fetch required. Full M3 enrichment can run later for fields the search
//! page doesn't expose (production qty, finish, registration #).

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::{
    search_all_pages_with_progress, DcrClient, ProductionSearchFilter, ProductionSearchResult,
};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;

/// Pre-warmed rows older than this are considered stale and get re-walked by
/// `refresh_stale_prewarms`. Matches the 30-day detail-page enrichment
/// cadence in `dcr_registry`.
const PREWARM_STALE_AFTER_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

#[derive(Debug, Default, Serialize, Clone)]
pub struct PrewarmSummary {
    pub driver_name: String,
    pub results_seen: u32,
    pub registry_entries_upserted: u32,
    pub pages_fetched: u32,
}

#[derive(Debug, Default, Serialize, Clone)]
pub struct PrewarmRefreshSummary {
    /// Drivers whose last pre-warm was older than the staleness threshold.
    pub drivers_stale: u32,
    /// Drivers actually re-warmed this run (bounded by the entry cap).
    pub drivers_refreshed: u32,
    /// Stale drivers whose entry count alone exceeds the configured cap —
    /// they can never be refreshed until the cap is raised.
    pub drivers_over_cap: u32,
    pub registry_entries_upserted: u32,
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
    let client = logged_in_client(pool).await?;

    let summary = prewarm_driver_with_client(pool, &client, driver_guid, progress).await?;

    progress.done(format!(
        "Pre-warm complete: {} entries for {}.",
        summary.registry_entries_upserted, summary.driver_name
    ));

    Ok(summary)
}

/// Re-walk the production search for pre-warmed drivers whose
/// `dcr.last_prewarm.{guid}` timestamp has gone stale, oldest first, until
/// the configured per-run entry cap (`auto_sync.prewarm_max_entries`) is
/// filled. Used by the background auto-sync so local/hybrid registry
/// searches keep seeing new entries and current values. Per-driver failures
/// are logged and skipped; cancellation propagates.
pub async fn refresh_stale_prewarms(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
) -> AppResult<PrewarmRefreshSummary> {
    let max_entries = settings::get(pool, settings::KEY_PREWARM_REFRESH_MAX_ENTRIES)
        .await?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(settings::DEFAULT_PREWARM_REFRESH_MAX_ENTRIES as i64);
    if max_entries <= 0 {
        progress.done("Pre-warm refresh is disabled (entry cap is 0).");
        return Ok(PrewarmRefreshSummary::default());
    }

    let cutoff = Utc::now().timestamp() - PREWARM_STALE_AFTER_SECONDS;
    // Stale drivers oldest-first, each with its local entry count — the best
    // available estimate of how many entries a re-walk will fetch, since the
    // original pre-warm stored them all.
    let stale: Vec<(String, i64)> = sqlx::query_as(
        "SELECT substr(s.key, length('dcr.last_prewarm.') + 1) AS guid,
                (SELECT COUNT(*)
                   FROM registry_entries re
                   JOIN drivers d ON d.id = re.driver_id
                  WHERE d.normalized_name = o.normalized) AS entry_count
         FROM settings s
         LEFT JOIN registry_form_options o
            ON o.field = 'driver'
           AND o.value = substr(s.key, length('dcr.last_prewarm.') + 1)
         WHERE s.key LIKE 'dcr.last_prewarm.%'
           AND CAST(s.value AS INTEGER) <= ?
         ORDER BY CAST(s.value AS INTEGER)",
    )
    .bind(cutoff)
    .fetch_all(pool)
    .await?;

    let drivers_stale = stale.len() as u32;
    if stale.is_empty() {
        progress.done("All pre-warmed drivers are fresh.");
        return Ok(PrewarmRefreshSummary::default());
    }

    // Fill the entry budget oldest-first. A driver that doesn't fit the
    // remaining budget is left stale for a later run (it stays at the front
    // of the queue); one that exceeds the whole cap by itself can never run
    // and is called out so the user knows to raise the cap.
    let mut batch: Vec<&str> = Vec::new();
    let mut planned = 0i64;
    let mut drivers_over_cap = 0u32;
    for (guid, entry_count) in &stale {
        if *entry_count > max_entries {
            drivers_over_cap += 1;
            tracing::warn!(
                "prewarm refresh: driver {guid} has {entry_count} entries, more than the \
                 {max_entries}-entry cap — raise the cap in Settings to refresh it"
            );
            continue;
        }
        if planned + entry_count > max_entries {
            continue;
        }
        planned += entry_count;
        batch.push(guid);
    }

    let mut summary = PrewarmRefreshSummary {
        drivers_stale,
        drivers_over_cap,
        ..Default::default()
    };
    if batch.is_empty() {
        progress.done(format!(
            "{drivers_stale} stale drivers, but none fit the {max_entries}-entry cap."
        ));
        return Ok(summary);
    }

    progress.step("Logging in to diecastregistry.com…", None, None);
    let client = logged_in_client(pool).await?;

    let total = batch.len() as u32;
    for (i, guid) in batch.iter().enumerate() {
        progress.check_cancelled()?;
        progress.step(
            format!("Refreshing stale pre-warm {} of {total}…", i + 1),
            Some(i as u32),
            Some(total),
        );
        match prewarm_driver_with_client(pool, &client, guid, progress).await {
            Ok(s) => {
                summary.drivers_refreshed += 1;
                summary.registry_entries_upserted += s.registry_entries_upserted;
            }
            Err(AppError::Cancelled) => return Err(AppError::Cancelled),
            Err(e) => tracing::warn!("prewarm refresh: driver {guid} failed: {e}"),
        }
    }

    progress.done(format!(
        "Refreshed {} of {} stale pre-warmed drivers ({} entries updated).",
        summary.drivers_refreshed, drivers_stale, summary.registry_entries_upserted
    ));
    Ok(summary)
}

/// Build a `DcrClient` logged in with the credentials from Settings. Shared
/// with flows that pre-warm several drivers in one session (e.g. the
/// detail-url backfill).
pub(crate) async fn logged_in_client(pool: &SqlitePool) -> AppResult<DcrClient> {
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
    Ok(client)
}

/// Search + upsert for one driver on an already-logged-in client. Emits
/// `step` progress only — the caller owns the closing `done` event.
pub(crate) async fn prewarm_driver_with_client(
    pool: &SqlitePool,
    client: &DcrClient,
    driver_guid: &str,
    progress: &ProgressEmitter,
) -> AppResult<PrewarmSummary> {
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
        search_all_pages_with_progress(client, &filter, progress, Some(&driver_name)).await?;
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

    Ok(PrewarmSummary {
        driver_name,
        results_seen,
        registry_entries_upserted: upserted,
        pages_fetched,
    })
}

/// Also used by the wishlist add flow so a wish always references a
/// fully-stubbed registry entry.
pub(crate) async fn upsert_stub_from_search(
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
            -- Overwriting raw_json wholesale would wipe enriched detail-page
            -- data (comments, photos). Replace stubs/invalid JSON; for
            -- enriched rows only refresh the search-derived keys.
            raw_json = CASE
                WHEN registry_entries.raw_json IS NULL
                     OR registry_entries.raw_json = ''
                     OR NOT json_valid(registry_entries.raw_json)
                     OR json_extract(registry_entries.raw_json, '$.source') = 'registry_prewarm'
                  THEN excluded.raw_json
                ELSE json_set(registry_entries.raw_json,
                              '$.detail_url', COALESCE(json_extract(excluded.raw_json, '$.detail_url'),
                                                       json_extract(registry_entries.raw_json, '$.detail_url')),
                              '$.image_url', COALESCE(json_extract(excluded.raw_json, '$.image_url'),
                                                      json_extract(registry_entries.raw_json, '$.image_url')))
            END,
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
