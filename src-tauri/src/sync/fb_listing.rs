//! Persistence for Facebook Marketplace listings handed to the embedded
//! listing-receiver by the browser extension.
//!
//! There's no API for FB Marketplace, so unlike the eBay path we never
//! re-fetch — every refresh is the user re-clicking the extension on a
//! listing page. The receiver just upserts whatever payload arrives.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FbListingPayload {
    /// FB Marketplace item id (numeric string from the URL).
    pub external_id: String,
    pub url: String,
    pub title: String,
    pub price_cents: Option<i64>,
    pub currency: Option<String>,
    pub condition: Option<String>,
    pub image_url: Option<String>,
    pub description: Option<String>,
    pub seller_username: Option<String>,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FbSaveResult {
    pub listing_id: i64,
    pub created: bool,
    pub matched_registry_entry_id: Option<i64>,
}

pub async fn upsert_from_payload(
    pool: &SqlitePool,
    payload: &FbListingPayload,
) -> AppResult<FbSaveResult> {
    if payload.external_id.trim().is_empty() {
        return Err(AppError::Parse("missing external_id".into()));
    }
    if payload.title.trim().is_empty() {
        return Err(AppError::Parse("missing title".into()));
    }

    let now = Utc::now().timestamp();
    let seller_id = fb_seller_id(pool).await?;

    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM listings WHERE seller_id = ? AND external_id = ?",
    )
    .bind(seller_id)
    .bind(&payload.external_id)
    .fetch_optional(pool)
    .await?;

    let raw_json = serde_json::to_string(&serde_json::json!({
        "description": payload.description,
        "location": payload.location,
        "source": "fb_extension",
    }))
    .unwrap_or_default();

    let currency = payload
        .currency
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "USD".to_string());

    sqlx::query(
        "INSERT INTO listings (
            seller_id, external_id, url, title,
            price_cents, currency, condition, status,
            seller_username, image_url,
            saved_at, last_seen_at, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
         ON CONFLICT(seller_id, external_id) DO UPDATE SET
            url = excluded.url,
            title = excluded.title,
            price_cents = excluded.price_cents,
            currency = excluded.currency,
            condition = excluded.condition,
            seller_username = excluded.seller_username,
            image_url = excluded.image_url,
            last_seen_at = excluded.last_seen_at,
            raw_json = excluded.raw_json",
    )
    .bind(seller_id)
    .bind(&payload.external_id)
    .bind(&payload.url)
    .bind(&payload.title)
    .bind(payload.price_cents)
    .bind(&currency)
    .bind(&payload.condition)
    .bind(&payload.seller_username)
    .bind(&payload.image_url)
    .bind(now)
    .bind(now)
    .bind(&raw_json)
    .execute(pool)
    .await?;

    let id_row: (i64,) = sqlx::query_as(
        "SELECT id FROM listings WHERE seller_id = ? AND external_id = ?",
    )
    .bind(seller_id)
    .bind(&payload.external_id)
    .fetch_one(pool)
    .await?;
    let listing_id = id_row.0;

    sqlx::query(
        "INSERT INTO listing_history
            (listing_id, observed_at, price_cents, shipping_cents, status)
         VALUES (?, ?, ?, NULL, 'active')",
    )
    .bind(listing_id)
    .bind(now)
    .bind(payload.price_cents)
    .execute(pool)
    .await?;

    if let Err(e) = crate::sync::driver_assoc::associate_listing_driver(pool, listing_id).await {
        tracing::warn!("driver auto-assoc for fb listing {listing_id} failed: {e}");
    }

    let matched_registry_entry_id: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT registry_entry_id FROM listing_matches WHERE listing_id = ?",
    )
    .bind(listing_id)
    .fetch_optional(pool)
    .await?;

    Ok(FbSaveResult {
        listing_id,
        created: existing.is_none(),
        matched_registry_entry_id: matched_registry_entry_id.and_then(|t| t.0),
    })
}

async fn fb_seller_id(pool: &SqlitePool) -> AppResult<i64> {
    let row: (i64,) = sqlx::query_as("SELECT id FROM sellers WHERE code = 'fb'")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}
