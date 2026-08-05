//! "Sync everything" orchestrator: runs the watchlist sync and the
//! saved-searches/sellers sync back to back and returns a combined summary.
//!
//! The two underlying flows each emit their own progress events; this
//! wrapper emits a top-level event so the UI can show a single progress
//! bar that walks through both phases.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::progress::ProgressEmitter;
use crate::sync::ebay_saved::{sync_saved_from_ebay, SavedSyncSummary};
use crate::sync::ebay_watchlist::{sync_watchlist, WatchlistSyncSummary};

#[derive(Debug, Default, Serialize, Clone)]
pub struct EbaySyncAllSummary {
    pub watchlist: WatchlistSyncSummary,
    pub saved: SavedSyncSummary,
}

pub async fn sync_all(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
) -> AppResult<EbaySyncAllSummary> {
    // Two-phase: watchlist first (longest, involves enriching each item),
    // then saved searches + sellers (one-shot Trading API call).
    progress.step("Syncing eBay watchlist…".to_string(), Some(1), Some(2));
    let watchlist = sync_watchlist(pool, progress).await?;

    progress.check_cancelled()?;
    progress.step(
        "Syncing saved searches + sellers…".to_string(),
        Some(2),
        Some(2),
    );
    let saved = sync_saved_from_ebay(pool, progress).await?;

    progress.done(format!(
        "eBay sync done: {} listings (+{}/~{}/-{}); searches +{}/-{}; sellers +{}/-{}.",
        watchlist.items_seen,
        watchlist.created,
        watchlist.updated,
        watchlist.pruned,
        saved.searches_created,
        saved.searches_pruned,
        saved.sellers_created,
        saved.sellers_pruned,
    ));

    Ok(EbaySyncAllSummary { watchlist, saved })
}
