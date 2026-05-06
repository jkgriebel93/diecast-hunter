use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::ebay::{
    fetch_watchlist_page, get_user_access_token, EbayEnvironment, DEFAULT_SCOPES,
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
    let env_str = settings::get(pool, settings::KEY_EBAY_ENVIRONMENT)
        .await?
        .unwrap_or_else(|| "sandbox".to_string());
    let env = EbayEnvironment::from_str(&env_str);

    let app_id = settings::secret_get(settings::ENTRY_EBAY_APP_ID)?
        .ok_or_else(|| AppError::NotConfigured("eBay App ID not set".into()))?;
    let cert_id = settings::secret_get(settings::ENTRY_EBAY_CERT_ID)?
        .ok_or_else(|| AppError::NotConfigured("eBay Cert ID not set".into()))?;

    progress.step("Refreshing eBay user token…", None, None);
    let token = get_user_access_token(pool, env, &app_id, &cert_id, DEFAULT_SCOPES).await?;

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

        if result.current_page >= result.total_pages || result.item_ids.is_empty() {
            break;
        }
        page = result.current_page + 1;
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
        "Watchlist sync done: {} new, {} updated, {} failed.",
        summary.created, summary.updated, summary.failed
    ));

    Ok(summary)
}
