use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::ebay::{
    add_to_watchlist, extract_legacy_item_id, fetch_watchlist_page, legacy_id_from_v1,
    remove_from_watchlist, user_iaf_token,
};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync::ebay_listing;

#[derive(Debug, Default, Serialize, Clone)]
pub struct WatchlistSyncSummary {
    pub items_seen: u32,
    pub created: u32,
    pub updated: u32,
    pub failed: u32,
    /// Items eBay returned in the watchlist that we filtered out as
    /// non-diecasts before persisting.
    pub filtered: u32,
    pub pages_fetched: u32,
}

/// Walk the user's eBay watchlist via Trading API GetMyeBayBuying, then for
/// each item id call the existing add_listing_from_input pathway so the row
/// gets enriched via the Browse API and a snapshot lands in listing_history.
///
/// Idempotent: items already in the local listings table are upserted, not
/// duplicated. Items that fail to enrich are counted as failed but don't
/// abort the whole sync.
pub async fn sync_watchlist(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
) -> AppResult<WatchlistSyncSummary> {
    let (env, token) = {
        progress.step("Refreshing eBay user token…", None, None);
        user_iaf_token(pool).await?
    };

    let mut summary = WatchlistSyncSummary::default();
    let mut page = 1u32;
    loop {
        progress.check_cancelled()?;
        progress.step(
            format!("Fetching watchlist page {page}…"),
            Some(page),
            None,
        );
        let result = fetch_watchlist_page(env, &token, page, 200).await?;
        summary.pages_fetched += 1;
        summary.items_seen += result.item_ids.len() as u32;

        for (i, item_id) in result.item_ids.iter().enumerate() {
            progress.check_cancelled()?;
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
            tracing::warn!("watchlist sync: page guard hit, aborting");
            break;
        }
    }

    settings::set(
        pool,
        "ebay.last_watchlist_sync",
        &Utc::now().timestamp().to_string(),
    )
    .await?;

    progress.done(format!(
        "Watchlist sync done: {} new, {} updated, {} filtered, {} failed.",
        summary.created, summary.updated, summary.filtered, summary.failed
    ));

    Ok(summary)
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

    // Local mirror. Reuses the diecast-filter + listing_history + matcher
    // pipeline. If the local save says "filtered" (non-diecast) we still
    // want it on eBay, so we propagate the result rather than rolling back.
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

