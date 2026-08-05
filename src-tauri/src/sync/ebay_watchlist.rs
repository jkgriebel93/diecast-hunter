use std::collections::HashSet;

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::ebay::trading::WatchlistPage;
use crate::ebay::{
    add_to_watchlist, end_reason_from_raw, extract_legacy_item_id, fetch_watchlist_page,
    invalidate_user_token_cache, is_iaf_token_expired_error, is_item_not_found_error,
    legacy_id_from_v1, remove_from_watchlist, user_iaf_token,
};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync::ebay_listing;

/// Tiered staleness windows: watchlist items enriched (Browse-fetched)
/// within their tier's window are skipped on subsequent syncs. Follows the
/// staleness pattern of DCR enrichment (`dcr_registry::REFRESH_AFTER_SECONDS`)
/// but much shorter, since prices and auction states move faster than
/// registry pages. Keeps the background sync from burning ~1 Browse API
/// call per watched item per run, which is what exhausted the 5,000/day
/// app quota.
///
/// Fixed-price listings (with or without Best Offer — the listed price is
/// what we track, and offers don't move it): 3 days.
const FIXED_FRESH_SECONDS: i64 = 3 * 24 * 60 * 60; // 3 days
/// Auctions: bids move the price, so re-enrich daily…
const AUCTION_FRESH_SECONDS: i64 = 24 * 60 * 60; // 1 day
/// …and once an auction is inside its final day (or past its recorded end),
/// it is never considered fresh — every sync refreshes it.
const AUCTION_ENDING_SOON_SECONDS: i64 = 24 * 60 * 60; // 1 day

#[derive(Debug, Default, Serialize, Clone)]
pub struct WatchlistSyncSummary {
    pub items_seen: u32,
    pub created: u32,
    pub updated: u32,
    pub failed: u32,
    /// Items still on the watchlist whose local row is within its tier's
    /// staleness window (3 days fixed / 1 day auction) — left untouched this
    /// run (no Browse API call).
    pub skipped_fresh: u32,
    /// Ended listings newly flagged `is_archived` this run. Archived rows are
    /// kept locally forever (match training data, sales-trend history).
    pub archived: u32,
    /// Watched listings that vanished from eBay entirely (Browse 404) and
    /// were archived this run with `end_reason = 'removed'`.
    pub removed: u32,
    /// Archived listings removed from the eBay watchlist this run, freeing
    /// slots against eBay's ~1000-item cap.
    pub unwatched: u32,
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
/// Items within their tier's staleness window (3 days fixed-price, 1 day
/// auction, always-refresh for auctions in their final day) are skipped —
/// no Browse call — to stay under the app's daily quota.
///
/// After the walk, ended listings are archived: flagged `is_archived`
/// locally (the row and its history are kept as match-training / trend
/// data, exempt from pruning) and removed from the eBay watchlist so they
/// stop consuming slots against eBay's ~1000-item cap.
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
        progress.step(format!("Fetching watchlist page {page}…"), Some(page), None);
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
                // The listing no longer exists on eBay (seller-removed, or
                // ended long enough ago that Browse dropped it). Archive the
                // local row instead of failing forever — its raw_json, final
                // price, and history are the last observation we'll ever get.
                Err(AppError::Network(msg)) if is_item_not_found_error(&msg) => {
                    match archive_removed_listing(pool, item_id).await {
                        Ok(true) => summary.removed += 1,
                        // No local row to preserve — nothing to archive.
                        Ok(false) => summary.failed += 1,
                        Err(e) => {
                            tracing::warn!(
                                "watchlist sync: failed to archive removed item {item_id}: {e}"
                            );
                            summary.failed += 1;
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("watchlist sync: failed to enrich item {item_id}: {e}");
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

    // Archive ended listings BEFORE the prune so their rows are flagged (and
    // thereby prune-exempt) in the same run that unwatches them on eBay.
    // Safe on an incomplete walk: flagging is driven by local status, and
    // the unwatch half only touches ids actually seen on the watchlist.
    let (archived, unwatched) = archive_ended_listings(pool, &seen_legacy_ids).await?;
    summary.archived = archived;
    summary.unwatched = unwatched;

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
        "Watchlist sync done: {} new, {} updated, {} fresh (skipped), {} filtered, {} failed, {} archived, {} removed from eBay, {} pruned.",
        summary.created,
        summary.updated,
        summary.skipped_fresh,
        summary.filtered,
        summary.failed,
        summary.archived,
        summary.removed,
        summary.pruned,
    ));

    Ok(summary)
}

/// Archive a watched listing that no longer exists on eBay (Browse 404):
/// flag it ended + archived with `end_reason = 'removed'`, preserving the
/// row (raw_json, last observed price, history, matches) as-is. Returns
/// false when no local row matches the legacy id — nothing to preserve.
/// The flagged row lands in the unwatch pass below via the seen-set, so it
/// also stops consuming an eBay watchlist slot.
async fn archive_removed_listing(pool: &SqlitePool, legacy_id: &str) -> AppResult<bool> {
    let now = Utc::now().timestamp();
    // external_id is the Browse v1 form "v1|{legacy}|{variant}" (or, for
    // rows saved before the v1 convention, the bare legacy id).
    let updated = sqlx::query(
        "UPDATE listings SET status = 'ended', is_archived = 1,
                archived_at = COALESCE(archived_at, ?), end_reason = 'removed'
         WHERE is_archived = 0
           AND seller_id = (SELECT id FROM sellers WHERE code = 'ebay')
           AND (external_id = ? OR external_id LIKE 'v1|' || ? || '|%')",
    )
    .bind(now)
    .bind(legacy_id)
    .bind(legacy_id)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(updated > 0)
}

/// Flag every ended, not-yet-archived eBay listing as archived — recording
/// why it ended (sold / ended unsold), derived from the preserved raw_json —
/// then remove archived listings that are still on the eBay watchlist (i.e.
/// were seen this walk) from the watchlist. Also backfills `end_reason` on
/// rows archived before the column existed. Removal failures are logged and
/// retried naturally on the next sync — the item stays on the watchlist, so
/// it shows up in the next walk's seen-set again. Returns (newly archived,
/// unwatched).
async fn archive_ended_listings(
    pool: &SqlitePool,
    seen_legacy_ids: &HashSet<String>,
) -> AppResult<(u32, u32)> {
    let now = Utc::now().timestamp();
    // Rows to archive plus already-archived rows missing an end_reason
    // (pre-0024 archives). Reason derivation needs raw_json, so this is a
    // select-then-update rather than one bulk UPDATE.
    let rows: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT l.id, l.raw_json, l.is_archived
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay'
           AND l.status = 'ended'
           AND (l.is_archived = 0 OR l.end_reason IS NULL)",
    )
    .fetch_all(pool)
    .await?;

    let mut archived = 0u32;
    for (id, raw_json, was_archived) in rows {
        let reason = end_reason_from_raw(&raw_json);
        sqlx::query(
            "UPDATE listings SET is_archived = 1,
                    archived_at = COALESCE(archived_at, ?),
                    end_reason = COALESCE(end_reason, ?)
             WHERE id = ?",
        )
        .bind(now)
        .bind(reason)
        .bind(id)
        .execute(pool)
        .await?;
        if was_archived == 0 {
            archived += 1;
        }
    }

    // Every archived row still on the watchlist — including ones archived in
    // earlier runs whose removal failed then.
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT l.external_id
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay' AND l.is_archived = 1",
    )
    .fetch_all(pool)
    .await?;
    let to_remove: Vec<String> = rows
        .into_iter()
        .map(|(ext,)| legacy_id_from_v1(&ext).unwrap_or(ext))
        .filter(|legacy| seen_legacy_ids.contains(legacy))
        .collect();

    let mut unwatched = 0u32;
    if !to_remove.is_empty() {
        let (env, token) = user_iaf_token(pool).await?;
        for legacy in &to_remove {
            match remove_from_watchlist(env, &token, legacy).await {
                Ok(()) => unwatched += 1,
                Err(e) => {
                    tracing::warn!("archive: failed to unwatch item {legacy}: {e}")
                }
            }
        }
    }
    Ok((archived, unwatched))
}

/// Legacy ids of local eBay listings considered fresh enough to skip this
/// run, per the tiered windows above. `last_seen_at` is only bumped by the
/// upsert after a successful Browse fetch, so rows that kept failing (e.g.
/// during a quota outage) don't count as fresh.
///
/// Ended and archived rows are always "fresh": their state is final, and
/// re-enriching them would waste quota on history we've already captured.
// Row tuple shaped by the SELECT list below; see the note on
// `CompIndex::load` for why these aren't aliased.
#[allow(clippy::type_complexity)]
async fn load_fresh_legacy_ids(pool: &SqlitePool) -> AppResult<HashSet<String>> {
    let now = Utc::now().timestamp();
    let rows: Vec<(String, Option<String>, i64, Option<i64>, String, i64)> = sqlx::query_as(
        "SELECT l.external_id, l.listing_type, l.last_seen_at, l.end_time,
                l.status, l.is_archived
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay'",
    )
    .fetch_all(pool)
    .await?;

    let mut fresh = HashSet::new();
    for (external_id, listing_type, last_seen_at, end_time, status, is_archived) in rows {
        let is_fresh = if is_archived != 0 || status == "ended" {
            true
        } else if listing_type.as_deref() == Some("auction") {
            // Final-day auctions (and ones already past their recorded end,
            // which this sync will flip to ended) always refresh.
            let ending_soon = end_time.is_some_and(|e| e - now <= AUCTION_ENDING_SOON_SECONDS);
            !ending_soon && last_seen_at >= now - AUCTION_FRESH_SECONDS
        } else {
            last_seen_at >= now - FIXED_FRESH_SECONDS
        };
        if is_fresh {
            fresh.insert(legacy_id_from_v1(&external_id).unwrap_or(external_id));
        }
    }
    Ok(fresh)
}

/// Delete every local eBay listing whose legacy id isn't in the seen set.
/// Cascades to listing_history and listing_matches (FK ON DELETE CASCADE).
/// Archived rows are exempt — we removed them from the watchlist ourselves
/// and keep them locally as history.
async fn prune_missing_listings(
    pool: &SqlitePool,
    seen_legacy_ids: &HashSet<String>,
) -> AppResult<u32> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT l.id, l.external_id
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay' AND l.is_archived = 0",
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
    let result = ebay_listing::add_listing_from_input(pool, input).await?;

    // Explicitly watching a listing un-archives it — otherwise the next sync
    // would see the stale flag and immediately unwatch it again (matters when
    // a listing we thought ended was extended/revived).
    if let Some(listing_id) = result.listing_id {
        sqlx::query(
            "UPDATE listings SET is_archived = 0, archived_at = NULL, end_reason = NULL
             WHERE id = ?",
        )
        .bind(listing_id)
        .execute(pool)
        .await?;
    }
    Ok(result)
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
        AppError::Parse(format!(
            "listing {listing_id} not found or not an eBay listing"
        ))
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
async fn fetch_with_token_retry(pool: &SqlitePool, page: u32) -> AppResult<WatchlistPage> {
    let (env, token) = user_iaf_token(pool).await?;
    match fetch_watchlist_page(env, &token, page, 200).await {
        Err(AppError::Network(msg)) if is_iaf_token_expired_error(&msg) => {
            tracing::info!("watchlist sync: IAF token rejected ({msg}); refreshing and retrying");
            invalidate_user_token_cache(pool, env).await?;
            let (env2, token2) = user_iaf_token(pool).await?;
            fetch_watchlist_page(env2, &token2, page, 200).await
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    //! Tests for the archival SQL: end-reason derivation lands on the row,
    //! pre-0024 archives get their NULL end_reason backfilled without being
    //! recounted, and Browse-404 (removed-from-eBay) rows are archived in
    //! place with everything preserved.
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

    async fn insert_listing(
        pool: &SqlitePool,
        external_id: &str,
        status: &str,
        raw_json: &str,
    ) -> i64 {
        sqlx::query(
            "INSERT INTO listings (seller_id, external_id, url, title, status,
                                   saved_at, last_seen_at, raw_json)
             VALUES ((SELECT id FROM sellers WHERE code = 'ebay'),
                     ?, 'https://example.com', 'test listing', ?, 1, 1, ?)",
        )
        .bind(external_id)
        .bind(status)
        .bind(raw_json)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    async fn row_state(pool: &SqlitePool, id: i64) -> (String, i64, Option<String>, Option<i64>) {
        sqlx::query_as(
            "SELECT status, is_archived, end_reason, archived_at FROM listings WHERE id = ?",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn archive_ended_derives_reason_from_raw_json() {
        let pool = migrated_pool().await;
        let sold = insert_listing(
            &pool,
            "v1|111111111111|0",
            "ended",
            r#"{"estimatedAvailabilities":[{"estimatedAvailabilityStatus":"OUT_OF_STOCK"}]}"#,
        )
        .await;
        let unsold = insert_listing(&pool, "v1|222222222222|0", "ended", "{}").await;
        let active = insert_listing(&pool, "v1|333333333333|0", "active", "{}").await;

        // Empty seen-set: nothing qualifies for the eBay unwatch call, so no
        // network is touched.
        let (archived, unwatched) = archive_ended_listings(&pool, &HashSet::new())
            .await
            .unwrap();
        assert_eq!((archived, unwatched), (2, 0));

        let (_, arch, reason, at) = row_state(&pool, sold).await;
        assert_eq!((arch, reason.as_deref()), (1, Some("sold")));
        assert!(at.is_some());
        let (_, arch, reason, _) = row_state(&pool, unsold).await;
        assert_eq!((arch, reason.as_deref()), (1, Some("ended")));
        let (_, arch, reason, at) = row_state(&pool, active).await;
        assert_eq!((arch, reason, at), (0, None, None));
    }

    #[tokio::test]
    async fn archive_ended_backfills_reason_without_recounting() {
        let pool = migrated_pool().await;
        // A pre-0024 archive: flagged, timestamped, but no end_reason.
        let old = insert_listing(&pool, "v1|444444444444|0", "ended", r#"{"bidCount":3}"#).await;
        sqlx::query("UPDATE listings SET is_archived = 1, archived_at = 42 WHERE id = ?")
            .bind(old)
            .execute(&pool)
            .await
            .unwrap();

        let (archived, _) = archive_ended_listings(&pool, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(archived, 0, "backfill must not count as newly archived");

        let (_, _, reason, at) = row_state(&pool, old).await;
        assert_eq!(reason.as_deref(), Some("sold"));
        assert_eq!(at, Some(42), "existing archived_at must be preserved");
    }

    #[tokio::test]
    async fn archive_removed_flags_row_in_place() {
        let pool = migrated_pool().await;
        let id = insert_listing(&pool, "v1|555555555555|0", "active", r#"{"k":"v"}"#).await;

        assert!(archive_removed_listing(&pool, "555555555555")
            .await
            .unwrap());
        let (status, arch, reason, at) = row_state(&pool, id).await;
        assert_eq!(
            (status.as_str(), arch, reason.as_deref()),
            ("ended", 1, Some("removed"))
        );
        assert!(at.is_some());
        // raw_json untouched — it's the last observation we'll ever get.
        let (raw,): (Option<String>,) =
            sqlx::query_as("SELECT raw_json FROM listings WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(raw.as_deref(), Some(r#"{"k":"v"}"#));

        // Already archived → no-op; unknown id → no row.
        assert!(!archive_removed_listing(&pool, "555555555555")
            .await
            .unwrap());
        assert!(!archive_removed_listing(&pool, "999999999999")
            .await
            .unwrap());
    }
}
