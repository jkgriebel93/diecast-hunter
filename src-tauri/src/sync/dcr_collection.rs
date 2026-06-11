use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::{CollectionItem, CollectionPage, DcrClient};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync::dcr_registry::{enrich_pending_registry_entries, EnrichSummary};

#[derive(Debug, Default, Serialize, Clone)]
pub struct SyncSummary {
    pub items_seen: u32,
    pub drivers_upserted: u32,
    pub registry_entries_upserted: u32,
    pub collection_rows_upserted: u32,
    /// Local DCR-sourced rows deleted because they're no longer in the user's
    /// My Garage — diecastregistry.com is the source of truth. Only counted
    /// when every garage page was fetched.
    pub collection_rows_removed: u32,
    pub pages_fetched: u32,
    /// Set once the auto-enrichment pass that follows collection sync
    /// completes. None if it failed or hasn't run.
    pub enrichment: Option<EnrichSummary>,
}

/// Public entry point: pull the user's My Garage, then (optionally) enrich any
/// registry stubs that lack detail-page data. Both steps share one logged-in
/// session (same DcrClient = same cookie jar). When `enrich` is false, only the
/// collection pull runs — the registry detail refresh is skipped.
pub async fn sync_dcr_collection_and_enrich(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
    enrich: bool,
) -> AppResult<SyncSummary> {
    progress.step("Logging in to diecastregistry.com…", None, None);
    let (username, password) = load_credentials(pool).await?;

    let client = DcrClient::new()?;
    client.login(&username, &password).await?;

    let mut summary = run_collection_sync(pool, &client, progress).await?;

    if enrich {
        progress.step("Enriching registry entries…", None, None);
        match enrich_pending_registry_entries(pool, &client, false, progress).await {
            Ok(es) => summary.enrichment = Some(es),
            Err(e) => {
                tracing::warn!("post-sync enrichment failed: {e}");
            }
        }
    }

    progress.done(format!(
        "Sync complete: {} items, {} pages.",
        summary.items_seen, summary.pages_fetched
    ));
    Ok(summary)
}

pub(crate) async fn load_credentials(pool: &SqlitePool) -> AppResult<(String, String)> {
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
    Ok((username, password))
}

async fn run_collection_sync(
    pool: &SqlitePool,
    client: &DcrClient,
    progress: &ProgressEmitter,
) -> AppResult<SyncSummary> {
    let mut summary = SyncSummary::default();
    let mut seen_asset_guids: Vec<String> = Vec::new();
    let mut all_pages_fetched = false;
    let mut page_n = 1u32;
    loop {
        progress.check_cancelled()?;
        progress.step(
            format!("Fetching My Garage page {page_n}…"),
            Some(page_n),
            None,
        );
        let path = if page_n == 1 {
            "/MyGarage".to_string()
        } else {
            format!("/MyGarage/{page_n}")
        };
        let html = client.get_html(&path).await?;
        let page: CollectionPage = crate::dcr::collection::parse_collection_page(&html)?;
        summary.pages_fetched += 1;
        summary.items_seen += page.items.len() as u32;

        for item in &page.items {
            persist_item(pool, item, &mut summary).await?;
            seen_asset_guids.push(item.asset_guid.clone());
        }

        if page.current_page >= page.total_pages {
            all_pages_fetched = true;
            break;
        }
        page_n = page.current_page + 1;
        if page_n > 100 {
            tracing::warn!("aborting collection sync: page guard hit");
            break;
        }
    }

    // diecastregistry.com is the source of truth: anything we have locally
    // that My Garage no longer lists gets dropped. Skipped when the page
    // guard aborted the walk — pruning on a partial listing would delete
    // rows we simply never got to.
    if all_pages_fetched {
        summary.collection_rows_removed =
            prune_missing_rows(pool, &seen_asset_guids).await?;
        if summary.collection_rows_removed > 0 {
            tracing::info!(
                "pruned {} collection rows no longer in My Garage",
                summary.collection_rows_removed
            );
        }
    }

    settings::set(
        pool,
        "dcr.last_collection_sync",
        &Utc::now().timestamp().to_string(),
    )
    .await?;

    Ok(summary)
}

/// Pull just page 1 of /MyGarage and upsert into the local DB. Used by the
/// register-diecast flow to refresh the local collection after adding an
/// item — the newly registered diecast sorts to the top of /MyGarage, so
/// one page is enough to pick it up.
pub(crate) async fn sync_first_page(
    pool: &SqlitePool,
    client: &DcrClient,
    progress: &ProgressEmitter,
) -> AppResult<SyncSummary> {
    progress.check_cancelled()?;
    progress.step("Refreshing My Garage page 1…", Some(1), Some(1));
    let mut summary = SyncSummary::default();
    let html = client.get_html("/MyGarage").await?;
    let page: CollectionPage = crate::dcr::collection::parse_collection_page(&html)?;
    summary.pages_fetched = 1;
    summary.items_seen = page.items.len() as u32;
    for item in &page.items {
        persist_item(pool, item, &mut summary).await?;
    }
    Ok(summary)
}

/// Standalone enrichment trigger: log in fresh, then run an enrichment pass.
/// Used by the manual "Refresh registry data" button. `force` ignores the
/// 30-day cache.
pub async fn enrich_only(
    pool: &SqlitePool,
    force: bool,
    progress: &ProgressEmitter,
) -> AppResult<EnrichSummary> {
    progress.step("Logging in to diecastregistry.com…", None, None);
    let (username, password) = load_credentials(pool).await?;
    let client = DcrClient::new()?;
    client.login(&username, &password).await?;
    let summary = enrich_pending_registry_entries(pool, &client, force, progress).await?;
    progress.done(format!(
        "Enrichment complete: {} of {} ({} failed, {} skipped).",
        summary.enriched, summary.considered, summary.failed, summary.skipped
    ));
    Ok(summary)
}

/// Delete DCR-sourced `my_collection` rows whose asset GUID wasn't seen on
/// any My Garage page this sync. An empty `seen` list legitimately means an
/// emptied garage, so everything DCR-sourced goes. Linked `registry_entries`
/// and `drivers` rows are left alone — they're a cache of registry data, not
/// part of the collection itself.
async fn prune_missing_rows(pool: &SqlitePool, seen: &[String]) -> AppResult<u32> {
    let mut sql = String::from(
        "DELETE FROM my_collection WHERE source = 'diecastregistry'",
    );
    if !seen.is_empty() {
        sql.push_str(" AND external_id NOT IN (");
        sql.push_str(&vec!["?"; seen.len()].join(","));
        sql.push(')');
    }
    let mut query = sqlx::query(&sql);
    for guid in seen {
        query = query.bind(guid);
    }
    let result = query.execute(pool).await?;
    Ok(result.rows_affected() as u32)
}

async fn persist_item(
    pool: &SqlitePool,
    item: &CollectionItem,
    summary: &mut SyncSummary,
) -> AppResult<()> {
    let now = Utc::now().timestamp();

    let driver_id = upsert_driver(pool, &item.driver_name, &item.driver_normalized).await?;
    summary.drivers_upserted += 1;

    let registry_entry_id = match &item.registry_guid {
        Some(guid) => Some(
            upsert_registry_stub(pool, guid, item, driver_id, now).await?,
        ),
        None => None,
    };
    if registry_entry_id.is_some() {
        summary.registry_entries_upserted += 1;
    }

    let raw_json = serde_json::to_string(&serde_json::json!({
        "driver_name": item.driver_name,
        "scheme_text": item.scheme_text,
        "year": item.year,
        "oem": item.oem,
        "brand": item.brand,
        "scale": item.scale,
        "make": item.make,
        "image_url": item.image_url,
        "detail_url": item.detail_url,
        "registry_int_id": item.registry_int_id,
        "registry_guid": item.registry_guid,
        "seq_produced": {
            "sequence": item.seq_produced.sequence,
            "total": item.seq_produced.total,
        },
        "retail_value_cents": item.retail_value_cents,
        "wholesale_value_cents": item.wholesale_value_cents,
    }))
    .unwrap_or_default();

    sqlx::query(
        "INSERT INTO my_collection
            (registry_entry_id, source, external_id, raw_json, imported_at)
         VALUES (?, 'diecastregistry', ?, ?, ?)
         ON CONFLICT(source, external_id) DO UPDATE SET
            registry_entry_id = excluded.registry_entry_id,
            raw_json = excluded.raw_json,
            imported_at = excluded.imported_at",
    )
    .bind(registry_entry_id)
    .bind(&item.asset_guid)
    .bind(&raw_json)
    .bind(now)
    .execute(pool)
    .await?;

    summary.collection_rows_upserted += 1;
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

async fn upsert_registry_stub(
    pool: &SqlitePool,
    guid: &str,
    item: &CollectionItem,
    driver_id: i64,
    now: i64,
) -> AppResult<i64> {
    let raw_json = serde_json::to_string(&serde_json::json!({
        "registry_int_id": item.registry_int_id,
        "scheme_text": item.scheme_text,
        "image_url": item.image_url,
        "detail_url": item.detail_url,
        "seq_produced_total": item.seq_produced.total,
        "source": "collection_page",
    }))
    .unwrap_or_default();

    sqlx::query(
        "INSERT INTO registry_entries
            (external_id, driver_id, year, oem, brand, scale, make,
             production_qty, retail_value_cents, wholesale_value_cents,
             raw_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
            driver_id = COALESCE(excluded.driver_id, registry_entries.driver_id),
            year = COALESCE(excluded.year, registry_entries.year),
            oem = COALESCE(excluded.oem, registry_entries.oem),
            brand = COALESCE(excluded.brand, registry_entries.brand),
            scale = COALESCE(excluded.scale, registry_entries.scale),
            make = COALESCE(excluded.make, registry_entries.make),
            production_qty = COALESCE(excluded.production_qty, registry_entries.production_qty),
            retail_value_cents = COALESCE(excluded.retail_value_cents, registry_entries.retail_value_cents),
            wholesale_value_cents = COALESCE(excluded.wholesale_value_cents, registry_entries.wholesale_value_cents),
            raw_json = excluded.raw_json,
            fetched_at = excluded.fetched_at",
    )
    .bind(guid)
    .bind(driver_id)
    .bind(item.year)
    .bind(&item.oem)
    .bind(&item.brand)
    .bind(&item.scale)
    .bind(&item.make)
    .bind(item.seq_produced.total)
    .bind(item.retail_value_cents)
    .bind(item.wholesale_value_cents)
    .bind(&raw_json)
    .bind(now)
    .execute(pool)
    .await?;

    let row: (i64,) =
        sqlx::query_as("SELECT id FROM registry_entries WHERE external_id = ?")
            .bind(guid)
            .fetch_one(pool)
            .await?;
    Ok(row.0)
}
