use chrono::Utc;
use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};

use crate::dcr::client::looks_like_login_page;
use crate::dcr::{CollectionItem, CollectionPage, DcrClient, DcrSession};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync::dcr_registry::{enrich_pending_registry_entries, EnrichSummary};
use crate::sync::driver_upsert::{upsert_driver, DriverIdCache};

#[derive(Debug, Default, Serialize, Clone)]
pub struct SyncSummary {
    pub items_seen: u32,
    /// Distinct drivers written this sync. Driver upserts are memoized per
    /// run (DCH-55), so this counts drivers, not items-with-a-driver.
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
/// registry stubs that lack detail-page data. Both steps run on the shared
/// cached session (DCH-57) — same DcrClient = same cookie jar — so back-to-back
/// syncs and searches skip the login round trips. When `enrich` is false, only
/// the collection pull runs — the registry detail refresh is skipped.
pub async fn sync_dcr_collection_and_enrich(
    pool: &SqlitePool,
    session: &DcrSession,
    progress: &ProgressEmitter,
    enrich: bool,
) -> AppResult<SyncSummary> {
    progress.step("Connecting to diecastregistry.com…", None, None);
    let summary = session
        .with_client(pool, progress, |client| async move {
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
            Ok(summary)
        })
        .await?;

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
            AppError::NotConfigured("diecastregistry.com username not set in Settings".into())
        })?;
    let password = settings::secret_get(settings::ENTRY_DCR_PASSWORD)
        .await?
        .ok_or_else(|| {
            AppError::NotConfigured("diecastregistry.com password not set in Settings".into())
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
    let mut driver_ids = DriverIdCache::new();
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
        // Load-bearing guard, not just a nicety: on a cached session with a
        // dead cookie this fetch is the login form, which parses as an empty
        // garage — and an "empty garage" that reached the end of the walk
        // would prune the user's entire local collection. Surface the expiry
        // (before anything is written) so with_client re-logs-in and retries.
        if looks_like_login_page(&html) {
            return Err(AppError::SessionExpired);
        }
        let page: CollectionPage = crate::dcr::collection::parse_collection_page(&html)?;
        summary.pages_fetched += 1;
        summary.items_seen += page.items.len() as u32;

        persist_page(pool, &page.items, &mut driver_ids, &mut summary).await?;
        for item in &page.items {
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
        summary.collection_rows_removed = prune_missing_rows(pool, &seen_asset_guids).await?;
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
    if looks_like_login_page(&html) {
        return Err(AppError::SessionExpired);
    }
    let page: CollectionPage = crate::dcr::collection::parse_collection_page(&html)?;
    summary.pages_fetched = 1;
    summary.items_seen = page.items.len() as u32;
    persist_page(pool, &page.items, &mut DriverIdCache::new(), &mut summary).await?;
    Ok(summary)
}

/// Standalone enrichment trigger on the shared cached session. Used by the
/// manual "Refresh registry data" button. `force` ignores the 30-day cache.
pub async fn enrich_only(
    pool: &SqlitePool,
    session: &DcrSession,
    force: bool,
    progress: &ProgressEmitter,
) -> AppResult<EnrichSummary> {
    progress.step("Connecting to diecastregistry.com…", None, None);
    let summary = session
        .with_client(pool, progress, |client| async move {
            enrich_pending_registry_entries(pool, &client, force, progress).await
        })
        .await?;
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
///
/// The `source = 'diecastregistry'` scope is load-bearing, not decorative:
/// it's the only thing keeping a manually-added entry (DCH-12) — which by
/// definition can never appear in My Garage — from being pruned on the very
/// next sync.
async fn prune_missing_rows(pool: &SqlitePool, seen: &[String]) -> AppResult<u32> {
    let mut sql = String::from("DELETE FROM my_collection WHERE source = 'diecastregistry'");
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

/// Persist one My Garage page inside a single transaction (DCH-55): ~3
/// statements per item but one commit — and so one fsync — per page. An
/// error on any item rolls back this page alone (earlier pages are already
/// committed) and propagates, which is the sync's existing failure mode.
async fn persist_page(
    pool: &SqlitePool,
    items: &[CollectionItem],
    driver_ids: &mut DriverIdCache,
    summary: &mut SyncSummary,
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for item in items {
        persist_item(&mut tx, item, driver_ids, summary).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn persist_item(
    conn: &mut SqliteConnection,
    item: &CollectionItem,
    driver_ids: &mut DriverIdCache,
    summary: &mut SyncSummary,
) -> AppResult<()> {
    let now = Utc::now().timestamp();

    if !driver_ids.contains_key(&item.driver_normalized) {
        summary.drivers_upserted += 1;
    }
    let driver_id =
        upsert_driver(conn, driver_ids, &item.driver_name, &item.driver_normalized).await?;

    let registry_entry_id = match &item.registry_guid {
        Some(guid) => Some(upsert_registry_stub(conn, guid, item, driver_id, now).await?),
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
    .execute(conn)
    .await?;

    summary.collection_rows_upserted += 1;
    Ok(())
}

async fn upsert_registry_stub(
    conn: &mut SqliteConnection,
    guid: &str,
    item: &CollectionItem,
    driver_id: i64,
    now: i64,
) -> AppResult<i64> {
    // Merged, not assigned: the garage list has no lightbox, so overwriting
    // would drop the `photos` of an already-enriched entry. See
    // `sync::raw_json`.
    let raw_json = crate::sync::raw_json::payload(serde_json::json!({
        "registry_int_id": item.registry_int_id,
        "scheme_text": item.scheme_text,
        "image_url": item.image_url,
        "detail_url": item.detail_url,
        "seq_produced_total": item.seq_produced.total,
        "source": "collection_page",
    }));

    let row: (i64,) = sqlx::query_as(&format!(
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
            {merge},
            fetched_at = excluded.fetched_at
         RETURNING id",
        merge = crate::sync::raw_json::MERGE_ON_CONFLICT,
    ))
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
    .fetch_one(conn)
    .await?;
    Ok(row.0)
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

    async fn insert_collection_row(pool: &SqlitePool, source: &str, external_id: &str) {
        sqlx::query(
            "INSERT INTO my_collection (source, external_id, imported_at)
             VALUES (?, ?, 1)",
        )
        .bind(source)
        .bind(external_id)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn surviving_external_ids(pool: &SqlitePool) -> Vec<String> {
        sqlx::query_as("SELECT external_id FROM my_collection ORDER BY external_id")
            .fetch_all(pool)
            .await
            .unwrap()
            .into_iter()
            .map(|(id,): (String,)| id)
            .collect()
    }

    #[tokio::test]
    async fn prune_drops_dcr_rows_the_garage_no_longer_lists() {
        let pool = migrated_pool().await;
        insert_collection_row(&pool, "diecastregistry", "kept").await;
        insert_collection_row(&pool, "diecastregistry", "gone").await;

        let removed = prune_missing_rows(&pool, &["kept".to_string()])
            .await
            .unwrap();

        assert_eq!(removed, 1);
        assert_eq!(surviving_external_ids(&pool).await, vec!["kept"]);
    }

    /// A manually-added car is never in My Garage, so every full sync sees it
    /// as "missing". Without the source scope this is exactly the sync that
    /// would silently delete the user's hand-entered collection. DCH-12.
    #[tokio::test]
    async fn prune_leaves_manually_added_entries_alone() {
        let pool = migrated_pool().await;
        insert_collection_row(&pool, "diecastregistry", "from-dcr").await;
        insert_collection_row(&pool, crate::local_collection::SOURCE_LOCAL, "local-1").await;

        // The harshest case: an emptied garage, where the seen list is empty
        // and every DCR-sourced row goes.
        let removed = prune_missing_rows(&pool, &[]).await.unwrap();

        assert_eq!(removed, 1);
        assert_eq!(surviving_external_ids(&pool).await, vec!["local-1"]);
    }

    fn garage_item(asset: &str, registry: Option<&str>, driver: &str) -> CollectionItem {
        CollectionItem {
            asset_guid: asset.to_string(),
            registry_guid: registry.map(|s| s.to_string()),
            registry_int_id: None,
            detail_url: Some("/diecast/x/y/z".to_string()),
            image_url: None,
            driver_name: driver.to_string(),
            driver_normalized: driver.to_lowercase().replace(' ', "-"),
            year: Some(2002),
            oem: None,
            brand: None,
            scale: Some("1:24".to_string()),
            make: None,
            scheme_text: None,
            seq_produced: Default::default(),
            retail_value_cents: None,
            wholesale_value_cents: None,
        }
    }

    /// The mirror of `enrichment_keeps_the_thumbnail_it_knows_nothing_about`
    /// over in `dcr_registry`: the garage list has the thumbnail but no
    /// lightbox and no comments, so a routine sync must not undo an
    /// enrichment that already ran. Both writers used to assign `raw_json`
    /// wholesale, so whichever ran last won and the other's keys vanished.
    #[tokio::test]
    async fn a_garage_sync_keeps_detail_page_data_it_cannot_see() {
        let pool = migrated_pool().await;
        let mut summary = SyncSummary::default();
        let mut driver_ids = DriverIdCache::new();
        let mut item = garage_item("asset-1", Some("guid-1"), "Jeff Gordon");

        persist_page(&pool, &[item.clone()], &mut driver_ids, &mut summary)
            .await
            .unwrap();

        // Stand in for an enrichment pass having run against this entry.
        sqlx::query(
            "UPDATE registry_entries
             SET raw_json = json_set(raw_json,
                     '$.photos', json_array('/img/big.jpg'),
                     '$.comments', 'nice car')
             WHERE external_id = 'guid-1'",
        )
        .execute(&pool)
        .await
        .unwrap();

        item.image_url = Some("/img/thumb.jpg".to_string());
        persist_page(&pool, &[item], &mut driver_ids, &mut summary)
            .await
            .unwrap();

        let raw: String = sqlx::query_scalar(
            "SELECT raw_json FROM registry_entries WHERE external_id = 'guid-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["image_url"], "/img/thumb.jpg");
        assert_eq!(v["photos"][0], "/img/big.jpg");
        assert_eq!(v["comments"], "nice car");
    }

    /// A garage row with no thumbnail says nothing about the image; it must
    /// not erase one another writer parsed. This is the null-stripping in
    /// `sync::raw_json` — as a merge patch, an explicit null deletes.
    #[tokio::test]
    async fn a_garage_row_without_a_thumbnail_does_not_erase_one() {
        let pool = migrated_pool().await;
        let mut summary = SyncSummary::default();
        let mut driver_ids = DriverIdCache::new();
        let mut item = garage_item("asset-1", Some("guid-1"), "Jeff Gordon");
        item.image_url = Some("/img/thumb.jpg".to_string());

        persist_page(&pool, &[item.clone()], &mut driver_ids, &mut summary)
            .await
            .unwrap();

        item.image_url = None;
        persist_page(&pool, &[item], &mut driver_ids, &mut summary)
            .await
            .unwrap();

        let raw: String = sqlx::query_scalar(
            "SELECT raw_json FROM registry_entries WHERE external_id = 'guid-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["image_url"], "/img/thumb.jpg");
    }

    /// One garage page persists as one unit, and the driver memo spans
    /// pages: items sharing a driver write that driver once per sync, and
    /// `drivers_upserted` counts drivers, not items. DCH-55.
    #[tokio::test]
    async fn persist_page_upserts_items_and_memoizes_drivers() {
        let pool = migrated_pool().await;
        let mut summary = SyncSummary::default();
        let mut driver_ids = DriverIdCache::new();

        persist_page(
            &pool,
            &[
                garage_item("asset-1", Some("guid-1"), "Jeff Gordon"),
                garage_item("asset-2", Some("guid-2"), "Jeff Gordon"),
                garage_item("asset-3", None, "Kyle Busch"),
            ],
            &mut driver_ids,
            &mut summary,
        )
        .await
        .unwrap();

        assert_eq!(summary.collection_rows_upserted, 3);
        assert_eq!(summary.registry_entries_upserted, 2);
        assert_eq!(summary.drivers_upserted, 2);
        let (driver_rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM drivers")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(driver_rows, 2);

        // A later page reuses the same cache — no new driver write, and the
        // count stays a count of distinct drivers.
        persist_page(
            &pool,
            &[garage_item("asset-4", None, "Jeff Gordon")],
            &mut driver_ids,
            &mut summary,
        )
        .await
        .unwrap();
        assert_eq!(summary.drivers_upserted, 2);
        assert_eq!(summary.collection_rows_upserted, 4);
    }
}
