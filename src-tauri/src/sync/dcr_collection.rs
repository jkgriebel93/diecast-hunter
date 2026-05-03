use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::{CollectionItem, CollectionPage, DcrClient};
use crate::error::{AppError, AppResult};
use crate::settings;

#[derive(Debug, Default, Serialize, Clone)]
pub struct SyncSummary {
    pub items_seen: u32,
    pub drivers_upserted: u32,
    pub registry_entries_upserted: u32,
    pub collection_rows_upserted: u32,
    pub pages_fetched: u32,
}

pub async fn sync_dcr_collection(pool: &SqlitePool) -> AppResult<SyncSummary> {
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

    let mut summary = SyncSummary::default();
    let mut page_n = 1u32;
    loop {
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
        }

        if page.current_page >= page.total_pages {
            break;
        }
        page_n = page.current_page + 1;
        if page_n > 100 {
            // Sanity guard: nobody owns 100+ pages of diecasts on this site,
            // and a runaway loop means we misread pagination.
            tracing::warn!("aborting collection sync: page guard hit");
            break;
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
