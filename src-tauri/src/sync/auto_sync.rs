//! Periodic background sync of My Garage (DCR) and eBay.
//!
//! A single long-lived task is spawned at startup (see `lib.rs::setup`). It
//! wakes once a minute and, when the `auto_sync.enabled` setting is on and the
//! configured interval has elapsed since the last attempt, runs the DCR
//! collection sync followed by the eBay sync (watchlist + saved). Both phases
//! are best-effort: a failure in one (missing credentials, network blip) is
//! logged and never aborts the loop.
//!
//! The loop is intentionally headless — it uses `ProgressEmitter::null` so it
//! doesn't pop the in-app progress overlay while the user is doing something
//! else. Feedback surfaces as the "Last run" timestamp on the Settings page
//! and in the log file.

use std::time::Duration;

use chrono::Utc;
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync;
use crate::AppState;

/// How often the loop wakes to re-check the settings and the elapsed interval.
/// Decoupled from the sync interval so changes to the interval setting take
/// effect within a minute without restarting the app.
const TICK: Duration = Duration::from_secs(60);

pub async fn run_loop(app: AppHandle, pool: SqlitePool) {
    loop {
        tokio::time::sleep(TICK).await;
        if let Err(e) = tick(&app, &pool).await {
            // Only the settings reads / last_run write can error here; the
            // syncs themselves swallow their own errors. Keep looping.
            tracing::warn!("auto-sync tick error: {e}");
        }
    }
}

async fn tick(app: &AppHandle, pool: &SqlitePool) -> AppResult<()> {
    let enabled = settings::get(pool, settings::KEY_AUTO_SYNC_ENABLED)
        .await?
        .map(|v| v == "true")
        .unwrap_or(false);
    if !enabled {
        return Ok(());
    }

    let interval_minutes = settings::get(pool, settings::KEY_AUTO_SYNC_INTERVAL_MINUTES)
        .await?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(settings::DEFAULT_AUTO_SYNC_INTERVAL_MINUTES as i64)
        .max(settings::MIN_AUTO_SYNC_INTERVAL_MINUTES as i64);

    let now = Utc::now().timestamp();
    let last_run = settings::get(pool, settings::KEY_AUTO_SYNC_LAST_RUN)
        .await?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if now - last_run < interval_minutes * 60 {
        return Ok(());
    }

    // Don't collide with a user-initiated long-running op (manual sync,
    // enrich, prewarm, …). Retry on the next tick.
    if app
        .state::<AppState>()
        .active_op_cancel
        .lock()
        .await
        .is_some()
    {
        tracing::debug!("auto-sync: another operation is running; retrying next tick");
        return Ok(());
    }

    // Stamp the attempt time up front so a source that fails every run (e.g.
    // expired credentials) backs off for a full interval instead of retrying
    // every minute.
    settings::set(pool, settings::KEY_AUTO_SYNC_LAST_RUN, &now.to_string()).await?;

    run_once(app, pool).await;
    Ok(())
}

async fn run_once(app: &AppHandle, pool: &SqlitePool) {
    let progress = ProgressEmitter::null("auto_sync");

    // Register as the active op so a user-initiated sync started mid-run sees
    // us via the same guard `tick` uses, and so the Cancel command can reach
    // this run's cancel token.
    {
        let state = app.state::<AppState>();
        *state.active_op_cancel.lock().await = Some(progress.cancel_handle());
    }

    tracing::info!("auto-sync: starting background sync");

    // My Collection (DCR). enrich=true is self-limiting — enrichment skips
    // entries refreshed within the last 30 days, so most runs enrich nothing.
    match sync::sync_dcr_collection_and_enrich(pool, &progress, true).await {
        Ok(s) => tracing::info!(
            "auto-sync DCR: {} items seen, {} rows upserted, {} removed",
            s.items_seen,
            s.collection_rows_upserted,
            s.collection_rows_removed,
        ),
        Err(e) => tracing::warn!("auto-sync DCR failed: {e}"),
    }

    // eBay (watchlist + saved searches/sellers). Independent of DCR — run it
    // even if the DCR phase failed, unless the run was cancelled.
    if !progress.is_cancelled() {
        match sync::sync_all_ebay(pool, &progress).await {
            Ok(s) => tracing::info!(
                "auto-sync eBay: {} watchlist items, {} searches, {} sellers",
                s.watchlist.items_seen,
                s.saved.searches_seen,
                s.saved.sellers_seen,
            ),
            Err(e) => tracing::warn!("auto-sync eBay failed: {e}"),
        }
    }

    {
        let state = app.state::<AppState>();
        *state.active_op_cancel.lock().await = None;
    }

    tracing::info!("auto-sync: background sync complete");
}
