//! Pull the user's eBay favorite searches + favorite sellers via the
//! Trading API and reconcile them against the local `saved_searches` and
//! `saved_sellers` tables.
//!
//! Prune rules:
//!   * Saved searches with `ebay_origin = 1` that aren't in the latest
//!     eBay response are deleted. Locally-created searches (origin = 0)
//!     are never touched.
//!   * Same for saved sellers, keyed on lowercased username.
//!   * If eBay's response is empty, we still prune — but the watchlist sync
//!     has a different "don't mass-delete on transient empty" guard. The
//!     favorites endpoints don't paginate the same way; if eBay returns no
//!     searches/sellers we treat that as authoritative.

use std::collections::HashSet;

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::ebay::{
    fetch_my_ebay_favorites, invalidate_user_token_cache, is_iaf_token_expired_error, search_url,
    user_iaf_token, MyEbayFavorites,
};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::saved;

#[derive(Debug, Default, Serialize, Clone)]
pub struct SavedSyncSummary {
    /// Saved searches eBay returned.
    pub searches_seen: u32,
    pub searches_created: u32,
    pub searches_updated: u32,
    pub searches_pruned: u32,
    pub sellers_seen: u32,
    pub sellers_created: u32,
    pub sellers_updated: u32,
    pub sellers_pruned: u32,
}

pub async fn sync_saved_from_ebay(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
) -> AppResult<SavedSyncSummary> {
    progress.step(
        "Fetching saved searches + sellers from eBay…".to_string(),
        Some(1),
        Some(3),
    );

    let favorites = fetch_with_token_retry(pool).await?;

    let mut summary = SavedSyncSummary::default();
    let now = Utc::now().timestamp();

    progress.check_cancelled()?;
    progress.step(
        format!("Reconciling {} saved searches…", favorites.searches.len()),
        Some(2),
        Some(3),
    );

    // --- searches --------------------------------------------------------
    let mut seen_search_ids: HashSet<String> = HashSet::new();
    summary.searches_seen = favorites.searches.len() as u32;
    for fav in &favorites.searches {
        progress.check_cancelled()?;
        seen_search_ids.insert(fav.search_id.clone());

        // existed_before tells us whether this is a create or an update for
        // the summary counters; we look up by external id before upsert.
        let existed_before = sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM saved_searches WHERE ebay_external_id = ? LIMIT 1",
        )
        .bind(&fav.search_id)
        .fetch_optional(pool)
        .await?
        .is_some();

        let parsed = fav
            .query_url
            .as_deref()
            .map(search_url::parse_search_url)
            .unwrap_or_default();

        // Prefer the parsed keywords; fall back to eBay's inline
        // <QueryKeywords> when the URL didn't include _nkw (which happens
        // for some legacy advanced-search formats).
        let keywords = if !parsed.keywords.is_empty() {
            parsed.keywords
        } else {
            fav.keywords.clone().unwrap_or_default()
        };

        let upsert = saved::EbaySavedSearchUpsert {
            ebay_external_id: fav.search_id.clone(),
            name: fav.name.clone(),
            query: keywords,
            conditions: parsed.filters.conditions,
            buying_options: parsed.filters.buying_options,
            sellers: parsed.filters.sellers,
            price_min_cents: parsed.filters.price_min_cents,
            price_max_cents: parsed.filters.price_max_cents,
            sort: parsed.filters.sort,
        };
        saved::upsert_search_from_ebay(pool, &upsert, now).await?;

        if existed_before {
            summary.searches_updated += 1;
        } else {
            summary.searches_created += 1;
        }
    }
    summary.searches_pruned = saved::prune_searches_not_in(pool, &seen_search_ids).await?;

    // --- sellers ---------------------------------------------------------
    progress.check_cancelled()?;
    progress.step(
        format!("Reconciling {} saved sellers…", favorites.sellers.len()),
        Some(3),
        Some(3),
    );

    let mut seen_usernames_lower: HashSet<String> = HashSet::new();
    summary.sellers_seen = favorites.sellers.len() as u32;
    for fav in &favorites.sellers {
        progress.check_cancelled()?;
        let lower = fav.user_id.to_lowercase();
        seen_usernames_lower.insert(lower.clone());

        let existed_before = sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM saved_sellers
              WHERE seller_code = 'ebay' AND username_lower = ? LIMIT 1",
        )
        .bind(&lower)
        .fetch_optional(pool)
        .await?
        .is_some();

        saved::upsert_seller_from_ebay(pool, &fav.user_id, fav.store_name.as_deref(), now).await?;
        if existed_before {
            summary.sellers_updated += 1;
        } else {
            summary.sellers_created += 1;
        }
    }
    summary.sellers_pruned = saved::prune_sellers_not_in(pool, &seen_usernames_lower).await?;

    progress.done(format!(
        "Saved sync done: searches +{}/~{}/-{}, sellers +{}/~{}/-{}.",
        summary.searches_created,
        summary.searches_updated,
        summary.searches_pruned,
        summary.sellers_created,
        summary.sellers_updated,
        summary.sellers_pruned,
    ));

    Ok(summary)
}

async fn fetch_with_token_retry(pool: &SqlitePool) -> AppResult<MyEbayFavorites> {
    let (env, token) = user_iaf_token(pool).await?;
    match fetch_my_ebay_favorites(env, &token).await {
        Err(AppError::Network(msg)) if is_iaf_token_expired_error(&msg) => {
            tracing::info!("saved sync: IAF token rejected ({msg}); refreshing and retrying");
            invalidate_user_token_cache(pool, env).await?;
            let (env2, token2) = user_iaf_token(pool).await?;
            fetch_my_ebay_favorites(env2, &token2).await
        }
        other => other,
    }
}
