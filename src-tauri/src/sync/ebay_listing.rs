use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::ebay::{
    extract_legacy_item_id, fetch_item_by_legacy_id, is_diecast, EbayClient, EbayItem,
};
use crate::error::{AppError, AppResult};
use crate::settings;

#[derive(Debug, Serialize, Clone)]
pub struct AddListingResult {
    /// None when the listing was filtered out (see filtered_reason).
    pub listing_id: Option<i64>,
    pub created: bool,
    pub title: String,
    /// When set, the listing was rejected (typically as not-a-diecast) and
    /// nothing was inserted. The caller can decide whether to show this to
    /// the user (manual add) or quietly count it (watchlist sync).
    pub filtered_reason: Option<String>,
}

#[derive(Debug, Default, Serialize, Clone)]
pub struct RefreshSummary {
    pub considered: u32,
    pub refreshed: u32,
    pub failed: u32,
}

/// Add an eBay listing by URL or bare item id. Idempotent: if we've already
/// saved this item, refresh it instead of duplicating.
pub async fn add_listing_from_input(
    pool: &SqlitePool,
    input: &str,
) -> AppResult<AddListingResult> {
    let legacy_id = extract_legacy_item_id(input).ok_or_else(|| {
        AppError::Parse(
            "couldn't pull an eBay item id out of that — paste a full \
             https://www.ebay.com/itm/... URL or just the numeric id"
                .into(),
        )
    })?;

    let client = EbayClient::from_settings(pool.clone()).await?;
    let item = fetch_item_by_legacy_id(&client, &legacy_id).await?;

    // Filter out non-diecast listings unless the user opted out. The check
    // runs against the eBay categoryPath we just fetched; without category
    // data is_diecast() returns false (conservative).
    if filter_non_diecasts_enabled(pool).await? && !is_diecast(item.category_path.as_deref()) {
        let reason = format!(
            "Not a diecast (category: {})",
            item.category_path.as_deref().unwrap_or("unknown")
        );
        tracing::info!(
            "ebay add: filtered item {} as non-diecast (path: {:?})",
            legacy_id,
            item.category_path
        );
        return Ok(AddListingResult {
            listing_id: None,
            created: false,
            title: item.title,
            filtered_reason: Some(reason),
        });
    }

    let (listing_id, created) = upsert_listing(pool, &item).await?;
    insert_history(pool, listing_id, &item).await?;
    if let Err(e) = crate::sync::listing_match::match_listing(pool, listing_id).await {
        // Match failure is non-fatal — the listing is saved either way.
        tracing::warn!("auto-match for listing {listing_id} failed: {e}");
    }

    Ok(AddListingResult {
        listing_id: Some(listing_id),
        created,
        title: item.title,
        filtered_reason: None,
    })
}

async fn filter_non_diecasts_enabled(pool: &SqlitePool) -> AppResult<bool> {
    match settings::get(pool, settings::KEY_EBAY_FILTER_NON_DIECASTS).await? {
        Some(s) => Ok(s != "false"),
        None => Ok(true),
    }
}

/// Re-fetch a single tracked listing's current state.
pub async fn refresh_listing(pool: &SqlitePool, listing_id: i64) -> AppResult<()> {
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT l.external_id, s.id
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE l.id = ? AND s.code = 'ebay'",
    )
    .bind(listing_id)
    .fetch_optional(pool)
    .await?;

    let (external_id, _seller_id) = row.ok_or_else(|| {
        AppError::Parse(format!("listing {listing_id} not found or not an eBay listing"))
    })?;

    // listings.external_id is the eBay v1 id ("v1|123|0"). Pull the legacy id
    // back out for the Browse API call.
    let legacy_id = parse_legacy_from_v1_id(&external_id).unwrap_or(external_id.clone());

    let client = EbayClient::from_settings(pool.clone()).await?;
    let item = fetch_item_by_legacy_id(&client, &legacy_id).await?;
    upsert_listing(pool, &item).await?;
    insert_history(pool, listing_id, &item).await?;
    if let Err(e) = crate::sync::listing_match::match_listing(pool, listing_id).await {
        tracing::warn!("auto-match for listing {listing_id} failed: {e}");
    }
    Ok(())
}

/// Refresh every active eBay listing. Runs sequentially under the client's
/// rate limiter.
pub async fn refresh_all_active(
    pool: &SqlitePool,
    progress: &crate::progress::ProgressEmitter,
) -> AppResult<RefreshSummary> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT l.id
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay' AND l.status = 'active'
         ORDER BY l.id",
    )
    .fetch_all(pool)
    .await?;

    let total = rows.len() as u32;
    let mut summary = RefreshSummary {
        considered: total,
        ..Default::default()
    };
    for (idx, (id,)) in rows.into_iter().enumerate() {
        progress.check_cancelled()?;
        progress.step(
            format!("Refreshing eBay listing {} of {}…", idx + 1, total),
            Some((idx + 1) as u32),
            Some(total),
        );
        match refresh_listing(pool, id).await {
            Ok(()) => summary.refreshed += 1,
            Err(e) => {
                tracing::warn!("listing {id} refresh failed: {e}");
                summary.failed += 1;
            }
        }
    }
    progress.done(format!(
        "Refresh complete: {} of {} ({} failed).",
        summary.refreshed, summary.considered, summary.failed
    ));
    Ok(summary)
}

async fn upsert_listing(pool: &SqlitePool, item: &EbayItem) -> AppResult<(i64, bool)> {
    let now = Utc::now().timestamp();
    let seller_id = ebay_seller_id(pool).await?;

    // Did we already have this row?
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM listings WHERE seller_id = ? AND external_id = ?",
    )
    .bind(seller_id)
    .bind(&item.item_id)
    .fetch_optional(pool)
    .await?;

    sqlx::query(
        "INSERT INTO listings (
            seller_id, external_id, url, title,
            price_cents, shipping_cents, currency,
            condition, listing_type, status, end_time,
            seller_username, seller_rating, image_url,
            category_id, category_path,
            saved_at, last_seen_at, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(seller_id, external_id) DO UPDATE SET
            url = excluded.url,
            title = excluded.title,
            price_cents = excluded.price_cents,
            shipping_cents = excluded.shipping_cents,
            currency = excluded.currency,
            condition = excluded.condition,
            listing_type = excluded.listing_type,
            status = excluded.status,
            end_time = excluded.end_time,
            seller_username = excluded.seller_username,
            seller_rating = excluded.seller_rating,
            image_url = excluded.image_url,
            category_id = excluded.category_id,
            category_path = excluded.category_path,
            last_seen_at = excluded.last_seen_at,
            raw_json = excluded.raw_json",
    )
    .bind(seller_id)
    .bind(&item.item_id)
    .bind(&item.web_url)
    .bind(&item.title)
    .bind(item.price_cents)
    .bind(item.shipping_cents)
    .bind(&item.currency)
    .bind(&item.condition)
    .bind(&item.listing_type)
    .bind(&item.status)
    .bind(item.end_time)
    .bind(&item.seller_username)
    .bind(item.seller_rating)
    .bind(&item.image_url)
    .bind(&item.category_id)
    .bind(&item.category_path)
    .bind(now)
    .bind(now)
    .bind(&item.raw_json)
    .execute(pool)
    .await?;

    let id_row: (i64,) = sqlx::query_as(
        "SELECT id FROM listings WHERE seller_id = ? AND external_id = ?",
    )
    .bind(seller_id)
    .bind(&item.item_id)
    .fetch_one(pool)
    .await?;

    Ok((id_row.0, existing.is_none()))
}

async fn insert_history(
    pool: &SqlitePool,
    listing_id: i64,
    item: &EbayItem,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO listing_history
            (listing_id, observed_at, price_cents, shipping_cents, status)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(listing_id)
    .bind(now)
    .bind(item.price_cents)
    .bind(item.shipping_cents)
    .bind(&item.status)
    .execute(pool)
    .await?;
    Ok(())
}

async fn ebay_seller_id(pool: &SqlitePool) -> AppResult<i64> {
    let row: (i64,) = sqlx::query_as("SELECT id FROM sellers WHERE code = 'ebay'")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

/// Browse API v1 ids look like "v1|123456789012|0" or
/// "v1|123456789012|987654321". The middle segment is the legacy id.
fn parse_legacy_from_v1_id(v1: &str) -> Option<String> {
    let mut parts = v1.split('|');
    let _v1 = parts.next()?;
    let legacy = parts.next()?;
    if legacy.chars().all(|c| c.is_ascii_digit()) && !legacy.is_empty() {
        Some(legacy.to_string())
    } else {
        None
    }
}
