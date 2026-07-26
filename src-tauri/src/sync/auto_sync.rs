//! Headless one-shot sync of My Garage (DCR) and eBay.
//!
//! Invoked by the OS scheduled task as `diecast-hunter.exe --sync` — see
//! `crate::run_headless_sync` and `crate::scheduler`. Running out-of-process
//! (rather than an in-app timer) means it fires even when the GUI is closed,
//! as long as the user is logged in.
//!
//! All phases are best-effort: a failure in one (missing credentials, network
//! blip) is logged and doesn't stop the others. The attempt time is recorded
//! in `auto_sync.last_run` so the Settings page can show when it last ran.

use chrono::Utc;
use sqlx::SqlitePool;

use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync;

/// Run the collection + eBay syncs once against `pool`. Never returns an
/// error — phase failures are logged. Returns whether both phases succeeded,
/// which the headless entry point maps to a process exit code.
pub async fn run_once(pool: &SqlitePool) -> bool {
    // Headless: no AppHandle, so no UI progress events. check_cancelled is
    // unused here (nothing flips the token in a one-shot process).
    let progress = ProgressEmitter::null("auto_sync");
    let now = Utc::now().timestamp();

    tracing::info!("auto-sync: starting headless sync");

    let mut ok = true;

    // My Collection (DCR). enrich=true is self-limiting — enrichment skips
    // entries refreshed within the last 30 days, so most runs enrich nothing.
    match sync::sync_dcr_collection_and_enrich(pool, &progress, true).await {
        Ok(s) => tracing::info!(
            "auto-sync DCR: {} items seen, {} rows upserted, {} removed",
            s.items_seen,
            s.collection_rows_upserted,
            s.collection_rows_removed,
        ),
        Err(e) => {
            ok = false;
            tracing::warn!("auto-sync DCR failed: {e}");
        }
    }

    // eBay (watchlist + saved searches/sellers). Independent of DCR — run it
    // even if the DCR phase failed.
    match sync::sync_all_ebay(pool, &progress).await {
        Ok(s) => tracing::info!(
            "auto-sync eBay: {} watchlist items, {} searches, {} sellers",
            s.watchlist.items_seen,
            s.saved.searches_seen,
            s.saved.sellers_seen,
        ),
        Err(e) => {
            ok = false;
            tracing::warn!("auto-sync eBay failed: {e}");
        }
    }

    // Pre-warmed registry refresh. Self-limiting: only drivers whose last
    // pre-warm is older than the staleness threshold, capped per run, so most
    // runs do nothing. Skipping the "0 stale" case keeps quiet runs quiet in
    // the log.
    match sync::refresh_stale_prewarms(pool, &progress).await {
        Ok(s) if s.drivers_stale == 0 => {}
        Ok(s) => tracing::info!(
            "auto-sync prewarm refresh: {} of {} stale drivers refreshed, {} entries upserted",
            s.drivers_refreshed,
            s.drivers_stale,
            s.registry_entries_upserted,
        ),
        Err(e) => {
            ok = false;
            tracing::warn!("auto-sync prewarm refresh failed: {e}");
        }
    }

    // Record the attempt regardless of per-phase success so the Settings page
    // can show recency. Best-effort — failing to write this shouldn't fail the
    // run.
    if let Err(e) = settings::set(pool, settings::KEY_AUTO_SYNC_LAST_RUN, &now.to_string()).await {
        tracing::warn!("auto-sync: could not record last_run: {e}");
    }

    tracing::info!("auto-sync: headless sync complete (ok={ok})");
    ok
}
