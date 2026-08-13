//! Bulk-populates `registry_entries` for a single driver by walking every
//! page of the /Production search filtered to that driver. Each result
//! becomes an upserted stub row carrying the data the search page itself
//! exposes (year, OEM, brand, scale, scheme, retail/wholesale), giving the
//! registry-search dialog candidates to surface immediately — no detail-page
//! fetch required. Full M3 enrichment can run later for fields the search
//! page doesn't expose (production qty, finish, registration #).

use chrono::Utc;
use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};

use crate::dcr::{
    search_all_pages_with_progress, DcrClient, ProductionSearchFilter, ProductionSearchResult,
};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync::driver_upsert::{upsert_driver, DriverIdCache};

/// Pre-warmed rows older than this are considered stale and get re-walked by
/// `refresh_stale_prewarms`. Matches the 30-day detail-page enrichment
/// cadence in `dcr_registry`.
const PREWARM_STALE_AFTER_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

/// Search-result upserts commit in transactions of this many rows (DCH-55):
/// commits scale with batches, not with 3× the result count, while a cancel
/// between batches still lands within ~100 rows of local work.
const UPSERT_BATCH_SIZE: usize = 100;

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
    // Stale drivers oldest-first, each with its cached entry count — the best
    // available estimate of how many entries a re-walk will fetch, since the
    // original pre-warm stored them all. Manually-added entries (DCH-12) are
    // excluded: DCR's search won't return them, so counting them would spend
    // budget the walk never uses and could push a driver over the cap for
    // cars that aren't on the site at all.
    let stale: Vec<(String, i64)> = sqlx::query_as(
        "SELECT substr(s.key, length('dcr.last_prewarm.') + 1) AS guid,
                (SELECT COUNT(*)
                   FROM registry_entries re
                   JOIN drivers d ON d.id = re.driver_id
                  WHERE d.normalized_name = o.normalized
                    AND re.source <> 'local') AS entry_count
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
            AppError::NotConfigured("diecastregistry.com username not set in Settings".into())
        })?;
    let password = settings::secret_get(settings::ENTRY_DCR_PASSWORD)?.ok_or_else(|| {
        AppError::NotConfigured("diecastregistry.com password not set in Settings".into())
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

    progress.step(format!("Searching registry for {driver_name}…"), None, None);

    let filter = ProductionSearchFilter {
        driver_guids: vec![driver_guid.to_string()],
        ..Default::default()
    };

    let (results, pages_fetched) =
        search_all_pages_with_progress(client, &filter, progress, Some(&driver_name)).await?;
    let results_seen = results.len() as u32;

    let upserted = upsert_stubs_batched(pool, &results, progress, &driver_name).await?;

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

/// Upsert a full walk's results in [`UPSERT_BATCH_SIZE`]-row transactions
/// (DCH-55). Shared by the pre-warm and pre-search refreshes — the two
/// flows that land thousands of rows per run. A row that fails to upsert is
/// logged and skipped (the batch's other rows still commit — SQLite doesn't
/// poison a transaction on a failed statement); a failed commit loses only
/// that batch and propagates. Cancellation is honored between batches.
pub(crate) async fn upsert_stubs_batched(
    pool: &SqlitePool,
    results: &[ProductionSearchResult],
    progress: &ProgressEmitter,
    label: &str,
) -> AppResult<u32> {
    let total = results.len() as u32;
    let mut upserted = 0u32;
    let mut driver_ids = DriverIdCache::new();
    for (batch_idx, batch) in results.chunks(UPSERT_BATCH_SIZE).enumerate() {
        progress.check_cancelled()?;
        let done = (batch_idx * UPSERT_BATCH_SIZE) as u32;
        progress.step(
            format!("Saving {done} of {total} entries for {label}…"),
            Some(done),
            Some(total),
        );
        let mut tx = pool.begin().await?;
        for r in batch {
            match upsert_stub_on(&mut tx, r, &mut driver_ids).await {
                Ok(()) => upserted += 1,
                Err(e) => tracing::warn!(
                    "registry-prewarm: failed to upsert {}: {e}",
                    r.registry_guid
                ),
            }
        }
        tx.commit().await?;
    }
    Ok(upserted)
}

/// Single-result wrapper. Used by the wishlist add flow so a wish always
/// references a fully-stubbed registry entry.
pub(crate) async fn upsert_stub_from_search(
    pool: &SqlitePool,
    r: &ProductionSearchResult,
) -> AppResult<()> {
    let mut conn = pool.acquire().await?;
    upsert_stub_on(&mut conn, r, &mut DriverIdCache::new()).await
}

async fn upsert_stub_on(
    conn: &mut SqliteConnection,
    r: &ProductionSearchResult,
    driver_ids: &mut DriverIdCache,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    let driver_id = upsert_driver(conn, driver_ids, &r.driver_name, &r.driver_normalized).await?;

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
    .execute(conn)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_collection::{create_local_entry, LocalEntryInput, SOURCE_LOCAL};
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

    fn search_result(guid: &str, driver: &str) -> ProductionSearchResult {
        ProductionSearchResult {
            registry_guid: guid.to_string(),
            detail_url: Some("/diecast/some/where".to_string()),
            image_url: None,
            driver_name: driver.to_string(),
            driver_normalized: driver.to_lowercase().replace(' ', "-"),
            year: Some(2001),
            oem: Some("Action".to_string()),
            brand: None,
            scale: Some("1:24".to_string()),
            make: None,
            scheme_text: Some("From DCR".to_string()),
            seq_produced_total: None,
            retail_value_cents: Some(13998),
            wholesale_value_cents: Some(9000),
        }
    }

    /// A pre-warm walks the DCR production search and upserts what it finds.
    /// A manually-added entry for the same driver shares that driver row, so
    /// the question is whether the upsert can reach across and overwrite it.
    /// It can't: the ON CONFLICT target is `external_id`, which a local entry
    /// leaves NULL, and NULL never conflicts. DCH-12.
    #[tokio::test]
    async fn prewarm_upsert_leaves_manually_added_entries_untouched() {
        let pool = migrated_pool().await;
        let local = create_local_entry(
            &pool,
            LocalEntryInput {
                driver_name: "Jeff Gordon".to_string(),
                scheme_text: "Hand-entered promo".to_string(),
                scale: Some("1:24".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        upsert_stub_from_search(&pool, &search_result("dcr-guid-1", "Jeff Gordon"))
            .await
            .unwrap();

        let (scheme, source, retail): (Option<String>, String, Option<i64>) = sqlx::query_as(
            "SELECT scheme_text, source, retail_value_cents
             FROM registry_entries WHERE id = ?",
        )
        .bind(local.registry_entry_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(scheme.as_deref(), Some("Hand-entered promo"));
        assert_eq!(source, SOURCE_LOCAL);
        // Crucially, it did not inherit DCR's appraisal for a different car.
        assert_eq!(retail, None);

        // And the DCR result still landed, as its own row.
        let (total,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM registry_entries")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, 2);
    }

    /// The batched path (DCH-55) spans multiple transactions on a walk
    /// bigger than one batch, memoizes the shared driver down to one row,
    /// and reports every result upserted.
    #[tokio::test]
    async fn batched_upsert_lands_every_result_across_batches() {
        let pool = migrated_pool().await;
        let results: Vec<ProductionSearchResult> = (0..(UPSERT_BATCH_SIZE * 2 + 50))
            .map(|i| search_result(&format!("guid-{i}"), "Jeff Gordon"))
            .collect();

        let progress = crate::progress::ProgressEmitter::null("test");
        let upserted = upsert_stubs_batched(&pool, &results, &progress, "Jeff Gordon")
            .await
            .unwrap();

        assert_eq!(upserted as usize, results.len());
        let (entries,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM registry_entries")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(entries as usize, results.len());
        let (drivers,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM drivers")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(drivers, 1);
    }

    /// Cancellation is checked between batches, before any work: a cancel
    /// that lands before the walk starts saving means nothing is written —
    /// there is no multi-minute uncancellable transaction to wait out.
    #[tokio::test]
    async fn batched_upsert_honors_cancellation_between_batches() {
        let pool = migrated_pool().await;
        let results = vec![search_result("guid-1", "Jeff Gordon")];

        let progress = crate::progress::ProgressEmitter::null("test");
        progress
            .cancel_handle()
            .store(true, std::sync::atomic::Ordering::Release);

        let err = upsert_stubs_batched(&pool, &results, &progress, "Jeff Gordon")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
        let (entries,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM registry_entries")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(entries, 0);
    }
}
