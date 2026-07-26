use std::collections::HashSet;

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::ebay::{
    add_to_watchlist, extract_legacy_item_id, fetch_watchlist_page,
    invalidate_user_token_cache, is_iaf_token_expired_error, legacy_id_from_v1,
    remove_from_watchlist, user_iaf_token,
};
use crate::ebay::trading::WatchlistPage;
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync::ebay_listing;

/// Watchlist items enriched (Browse-fetched) within this window are skipped
/// on subsequent syncs. Follows the staleness pattern of DCR enrichment
/// (`dcr_registry::REFRESH_AFTER_SECONDS`), but much shorter since prices
/// and auction states move faster than registry pages. Keeps the hourly-ish
/// sync cadence from burning ~1 Browse API call per watched item per run,
/// which is what exhausted the 5,000/day app quota.
const SKIP_ENRICH_FRESHER_THAN_SECONDS: i64 = 3 * 24 * 60 * 60; // 3 days

#[derive(Debug, Default, Serialize, Clone)]
pub struct WatchlistSyncSummary {
    pub items_seen: u32,
    pub created: u32,
    pub updated: u32,
    pub failed: u32,
    /// Items still on the watchlist whose local row was enriched within the
    /// last 3 days — left untouched this run (no Browse API call).
    pub skipped_fresh: u32,
    /// Items eBay returned in the watchlist that we filtered out as
    /// non-diecasts before persisting.
    pub filtered: u32,
    pub pages_fetched: u32,
    /// Local eBay listings deleted because they were no longer on the
    /// watchlist. Only populated after a complete successful walk; left at 0
    /// if the sync aborted mid-pagination or eBay returned zero items (to
    /// avoid mass-deletion on a transient empty response).
    pub pruned: u32,
}

/// Walk the user's eBay watchlist via Trading API GetMyeBayBuying, then for
/// each item id call the existing add_listing_from_input pathway so the row
/// gets enriched via the Browse API and a snapshot lands in listing_history.
/// Items enriched within the last 3 days are skipped (no Browse call) to
/// stay under the app's daily quota.
///
/// Idempotent: items already in the local listings table are upserted, not
/// duplicated. Items that fail to enrich are counted as failed and don't
/// abort the whole sync — except a 429 (quota exhausted), which aborts
/// immediately with `AppError::RateLimited`.
pub async fn sync_watchlist(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
) -> AppResult<WatchlistSyncSummary> {
    let mut summary = WatchlistSyncSummary::default();
    let mut seen_legacy_ids: HashSet<String> = HashSet::new();
    let fresh_legacy_ids = load_fresh_legacy_ids(pool).await?;
    let mut walk_complete = true;
    let mut page = 1u32;
    loop {
        progress.check_cancelled()?;
        progress.step(
            format!("Fetching watchlist page {page}…"),
            Some(page),
            None,
        );
        // Re-resolve the user IAF token per page. The token-fetch is cheap
        // when our cache is still warm; if it's stale (within 10 min of
        // expiry), this proactively refreshes. fetch_with_token_retry
        // adds belt-and-suspenders for the case where eBay says the token
        // is expired anyway (clock skew or upstream revocation).
        let result = fetch_with_token_retry(pool, page).await?;
        summary.pages_fetched += 1;
        summary.items_seen += result.item_ids.len() as u32;

        for (i, item_id) in result.item_ids.iter().enumerate() {
            progress.check_cancelled()?;
            seen_legacy_ids.insert(item_id.clone());
            // Fresh rows keep their prune protection (seen-set insert above)
            // but skip the per-item Browse call.
            if fresh_legacy_ids.contains(item_id) {
                summary.skipped_fresh += 1;
                continue;
            }
            progress.step(
                format!(
                    "Importing item {} of {} (id {item_id})…",
                    i + 1,
                    result.item_ids.len()
                ),
                Some((i + 1) as u32),
                Some(result.item_ids.len() as u32),
            );
            match ebay_listing::add_listing_from_input(pool, item_id).await {
                Ok(res) if res.filtered_reason.is_some() => {
                    summary.filtered += 1;
                }
                Ok(res) => {
                    if res.created {
                        summary.created += 1;
                    } else {
                        summary.updated += 1;
                    }
                }
                // Out of daily quota: every remaining call would 429 too.
                // Abort the whole sync (skipping the prune, since the local
                // picture is incomplete) and surface the error to the user.
                Err(e @ AppError::RateLimited(_)) => {
                    tracing::warn!("watchlist sync: aborting — {e}");
                    return Err(e);
                }
                Err(e) => {
                    tracing::warn!(
                        "watchlist sync: failed to enrich item {item_id}: {e}"
                    );
                    summary.failed += 1;
                }
            }
        }

        // Drive pagination off the page we requested, NOT result.current_page.
        // eBay omits <PageNumber> from GetMyeBayBuying responses at
        // DetailLevel=ReturnSummary, so the parser falls back to 1 every
        // time — which earlier set `page = 1 + 1 = 2` on every iteration
        // and infinite-looped on page 2.
        if page >= result.total_pages || result.item_ids.is_empty() {
            break;
        }
        page += 1;
        if page > 100 {
            // Incomplete picture of the watchlist — skip prune so we don't
            // mass-delete legitimately-watched items past page 100.
            tracing::warn!("watchlist sync: page guard hit, aborting");
            walk_complete = false;
            break;
        }
    }

    // Prune only when (a) the walk finished cleanly AND (b) eBay actually
    // returned at least one item. The second condition guards against a
    // transient empty response from wiping the entire local watchlist —
    // users can manually unwatch the last remaining item if they truly
    // have an empty watchlist.
    if walk_complete && !seen_legacy_ids.is_empty() {
        summary.pruned = prune_missing_listings(pool, &seen_legacy_ids).await?;
    }

    settings::set(
        pool,
        "ebay.last_watchlist_sync",
        &Utc::now().timestamp().to_string(),
    )
    .await?;

    progress.done(format!(
        "Watchlist sync done: {} new, {} updated, {} fresh (skipped), {} filtered, {} failed, {} pruned.",
        summary.created,
        summary.updated,
        summary.skipped_fresh,
        summary.filtered,
        summary.failed,
        summary.pruned,
    ));

    Ok(summary)
}

/// Legacy ids of local eBay listings whose last successful enrichment is
/// newer than `SKIP_ENRICH_FRESHER_THAN_SECONDS`. `last_seen_at` is only
/// bumped by the upsert after a successful Browse fetch, so rows that kept
/// failing (e.g. during a quota outage) don't count as fresh.
async fn load_fresh_legacy_ids(pool: &SqlitePool) -> AppResult<HashSet<String>> {
    let cutoff = Utc::now().timestamp() - SKIP_ENRICH_FRESHER_THAN_SECONDS;
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT l.external_id
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay' AND l.last_seen_at >= ?",
    )
    .bind(cutoff)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(external_id,)| legacy_id_from_v1(&external_id).unwrap_or(external_id))
        .collect())
}

/// Delete every local eBay listing whose legacy id isn't in the seen set.
/// Cascades to listing_history and listing_matches (FK ON DELETE CASCADE).
async fn prune_missing_listings(
    pool: &SqlitePool,
    seen_legacy_ids: &HashSet<String>,
) -> AppResult<u32> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT l.id, l.external_id
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay'",
    )
    .fetch_all(pool)
    .await?;

    let mut to_delete = Vec::new();
    for (id, external_id) in rows {
        let legacy = legacy_id_from_v1(&external_id).unwrap_or(external_id);
        if !seen_legacy_ids.contains(&legacy) {
            to_delete.push(id);
        }
    }

    if to_delete.is_empty() {
        return Ok(0);
    }

    let mut tx = pool.begin().await?;
    for id in &to_delete {
        sqlx::query("DELETE FROM listings WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(to_delete.len() as u32)
}

/// User-initiated "Watch this listing": add it to the user's eBay watchlist
/// via Trading API, then mirror it into the local listings table via the
/// existing add-listing path so the rest of the app can track it.
pub async fn watch_and_save(
    pool: &SqlitePool,
    input: &str,
) -> AppResult<ebay_listing::AddListingResult> {
    let legacy_id = extract_legacy_item_id(input).ok_or_else(|| {
        AppError::Parse(
            "couldn't pull an eBay item id out of that — paste a full \
             https://www.ebay.com/itm/... URL or just the numeric id"
                .into(),
        )
    })?;

    let (env, token) = user_iaf_token(pool).await?;
    add_to_watchlist(env, &token, &legacy_id).await?;

    // Local mirror. Reuses the diecast-filter + listing_history pipeline.
    // If the local save says "filtered" (non-diecast) we still want it on
    // eBay, so we propagate the result rather than rolling back.
    ebay_listing::add_listing_from_input(pool, input).await
}

/// User-initiated "Unwatch": remove from the user's eBay watchlist (best
/// effort — "not on watchlist" is treated as success), then delete the
/// local row. Cascade drops listing_history and listing_matches.
pub async fn unwatch_and_delete(pool: &SqlitePool, listing_id: i64) -> AppResult<()> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT l.external_id
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE l.id = ? AND s.code = 'ebay'",
    )
    .bind(listing_id)
    .fetch_optional(pool)
    .await?;
    let external_id = row.map(|(s,)| s).ok_or_else(|| {
        AppError::Parse(format!("listing {listing_id} not found or not an eBay listing"))
    })?;
    let legacy_id = legacy_id_from_v1(&external_id).unwrap_or_else(|| external_id.clone());

    let (env, token) = user_iaf_token(pool).await?;
    remove_from_watchlist(env, &token, &legacy_id).await?;

    sqlx::query("DELETE FROM listings WHERE id = ?")
        .bind(listing_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Fetch one watchlist page, retrying once if eBay rejects the IAF
/// token as expired. The proactive 10-minute refresh buffer in
/// `user_iaf_token` should make this rare, but we keep the retry for
/// the case where our local expiry guess drifts (clock skew) or the
/// token gets revoked upstream.
async fn fetch_with_token_retry(
    pool: &SqlitePool,
    page: u32,
) -> AppResult<WatchlistPage> {
    let (env, token) = user_iaf_token(pool).await?;
    match fetch_watchlist_page(env, &token, page, 200).await {
        Err(AppError::Network(msg)) if is_iaf_token_expired_error(&msg) => {
            tracing::info!(
                "watchlist sync: IAF token rejected ({msg}); refreshing and retrying"
            );
            invalidate_user_token_cache(pool, env).await?;
            let (env2, token2) = user_iaf_token(pool).await?;
            fetch_watchlist_page(env2, &token2, page, 200).await
        }
        other => other,
    }
}

