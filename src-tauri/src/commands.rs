use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::atomic::Ordering;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::listing_groups;
use crate::local_collection;
use crate::match_feedback::{self, FeedbackLabel};
use crate::progress::ProgressEmitter;
use crate::saved;
use crate::settings;
use crate::sync;
use crate::wishlist;
use crate::AppState;

/// Set the active cancel handle so the `cancel_active_operation` command
/// can find it. Replaces any existing entry — only one long-running op runs
/// at a time in practice (UI buttons gate that).
async fn set_active_cancel(state: &State<'_, AppState>, progress: &ProgressEmitter) {
    *state.active_op_cancel.lock().await = Some(progress.cancel_handle());
}

async fn clear_active_cancel(state: &State<'_, AppState>) {
    *state.active_op_cancel.lock().await = None;
}

/// Emit the right closing progress event based on how the op finished.
/// Successful runs emit their own `done` from inside the sync function;
/// here we only handle errors and cancellations.
fn finish_progress<T>(progress: &ProgressEmitter, result: &AppResult<T>, op_label: &str) {
    match result {
        Err(AppError::Cancelled) => progress.cancelled_event(format!("{op_label} cancelled.")),
        Err(e) => progress.fail(format!("{op_label} failed: {e}")),
        Ok(_) => {}
    }
}

#[tauri::command]
pub async fn cancel_active_operation(state: State<'_, AppState>) -> AppResult<bool> {
    let guard = state.active_op_cancel.lock().await;
    if let Some(handle) = guard.as_ref() {
        handle.store(true, Ordering::Release);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[derive(Serialize)]
pub struct AppStatus {
    pub db_path: String,
    pub schema_version: i64,
    pub registry_count: i64,
    pub collection_count: i64,
    pub listing_count: i64,
}

#[derive(Serialize)]
pub struct CredentialState {
    pub diecastregistry_username: Option<String>,
    pub diecastregistry_has_password: bool,
    pub ebay_connected: bool,
}

async fn count(pool: &SqlitePool, table: &str) -> AppResult<i64> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    let row: (i64,) = sqlx::query_as(&sql).fetch_one(pool).await?;
    Ok(row.0)
}

#[tauri::command]
pub async fn app_status(state: State<'_, AppState>) -> AppResult<AppStatus> {
    let pool = &state.db.pool;
    let schema_version: (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
            .fetch_one(pool)
            .await?;
    Ok(AppStatus {
        db_path: state.db.path.to_string_lossy().into_owned(),
        schema_version: schema_version.0,
        registry_count: count(pool, "registry_entries").await?,
        collection_count: count(pool, "my_collection").await?,
        listing_count: count(pool, "listings").await?,
    })
}

#[tauri::command]
pub async fn get_credentials(state: State<'_, AppState>) -> AppResult<CredentialState> {
    let username = settings::get(&state.db.pool, settings::KEY_DCR_USERNAME).await?;
    let has_password = settings::secret_get(settings::ENTRY_DCR_PASSWORD)?.is_some();
    let ebay_connected = settings::secret_get(settings::ENTRY_EBAY_OAUTH)?.is_some();
    Ok(CredentialState {
        diecastregistry_username: username,
        diecastregistry_has_password: has_password,
        ebay_connected,
    })
}

#[tauri::command]
pub async fn save_diecastregistry_credentials(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> AppResult<()> {
    settings::set(&state.db.pool, settings::KEY_DCR_USERNAME, &username).await?;
    settings::secret_set(settings::ENTRY_DCR_PASSWORD, &password)?;
    state.dcr_session.invalidate().await;
    Ok(())
}

#[tauri::command]
pub async fn clear_diecastregistry_credentials(state: State<'_, AppState>) -> AppResult<()> {
    settings::delete(&state.db.pool, settings::KEY_DCR_USERNAME).await?;
    settings::secret_delete(settings::ENTRY_DCR_PASSWORD)?;
    state.dcr_session.invalidate().await;
    Ok(())
}

#[tauri::command]
pub async fn get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    settings::get(&state.db.pool, &key).await
}

#[tauri::command]
pub async fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    settings::set(&state.db.pool, &key, &value).await
}

#[derive(Serialize)]
pub struct AutoSyncSettings {
    pub enabled: bool,
    pub interval_hours: u32,
    /// Unix timestamp of the last background-sync attempt, or null if it has
    /// never run.
    pub last_run: Option<i64>,
    /// Whether the OS scheduled task is actually registered. Lets the UI flag
    /// drift (settings say enabled but the task is gone, e.g. after a manual
    /// deletion in Task Scheduler).
    pub scheduled: bool,
    /// Cap on registry entries the pre-warm refresh re-walks per sync run.
    /// 0 = refresh disabled.
    pub prewarm_max_entries: u32,
}

#[tauri::command]
pub async fn get_auto_sync_settings(state: State<'_, AppState>) -> AppResult<AutoSyncSettings> {
    let pool = &state.db.pool;
    let enabled = settings::get(pool, settings::KEY_AUTO_SYNC_ENABLED)
        .await?
        .map(|v| v == "true")
        .unwrap_or(false);
    let interval_hours = settings::get(pool, settings::KEY_AUTO_SYNC_INTERVAL_HOURS)
        .await?
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(settings::DEFAULT_AUTO_SYNC_INTERVAL_HOURS);
    let last_run = settings::get(pool, settings::KEY_AUTO_SYNC_LAST_RUN)
        .await?
        .and_then(|v| v.parse::<i64>().ok());
    let prewarm_max_entries = settings::get(pool, settings::KEY_PREWARM_REFRESH_MAX_ENTRIES)
        .await?
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(settings::DEFAULT_PREWARM_REFRESH_MAX_ENTRIES);
    Ok(AutoSyncSettings {
        enabled,
        interval_hours,
        last_run,
        scheduled: crate::scheduler::exists(),
        prewarm_max_entries,
    })
}

#[tauri::command]
pub async fn set_auto_sync_settings(
    state: State<'_, AppState>,
    enabled: bool,
    interval_hours: u32,
    prewarm_max_entries: u32,
) -> AppResult<()> {
    let pool = &state.db.pool;
    let clamped = interval_hours.clamp(
        settings::MIN_AUTO_SYNC_INTERVAL_HOURS,
        settings::MAX_AUTO_SYNC_INTERVAL_HOURS,
    );

    // Register/update (or remove) the OS scheduled task first. If that fails
    // — e.g. group policy blocks Task Scheduler — surface the error and leave
    // the persisted settings untouched so the UI keeps reflecting reality.
    crate::scheduler::apply(enabled, clamped)?;

    settings::set(
        pool,
        settings::KEY_AUTO_SYNC_ENABLED,
        if enabled { "true" } else { "false" },
    )
    .await?;
    settings::set(
        pool,
        settings::KEY_AUTO_SYNC_INTERVAL_HOURS,
        &clamped.to_string(),
    )
    .await?;
    settings::set(
        pool,
        settings::KEY_PREWARM_REFRESH_MAX_ENTRIES,
        &prewarm_max_entries.to_string(),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn sync_dcr_collection(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    enrich: bool,
) -> AppResult<sync::SyncSummary> {
    let progress = ProgressEmitter::new(app, "sync");
    set_active_cancel(&state, &progress).await;
    let result = sync::sync_dcr_collection_and_enrich(&state.db.pool, &progress, enrich).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Sync");
    result
}

#[tauri::command]
pub async fn register_diecast_in_garage(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    input: crate::dcr::RegisterDiecastInput,
) -> AppResult<sync::RegisterDiecastSummary> {
    let progress = ProgressEmitter::new(app, "dcr_register");
    set_active_cancel(&state, &progress).await;
    let result = sync::register_in_garage(&state.db.pool, &progress, input).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Register diecast");
    result
}

/// Remove one collection entry, deleting it from the user's DCR garage first
/// (DCR is the source of truth). `found_on_dcr = false` in the result means
/// the asset wasn't in the garage — the local row is removed regardless, and
/// the UI should treat that case as a neutral notice, not an error.
#[tauri::command]
pub async fn remove_collection_entry(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    collection_id: i64,
) -> AppResult<sync::RemoveEntrySummary> {
    let progress = ProgressEmitter::new(app, "remove_entry");
    set_active_cancel(&state, &progress).await;
    let result = sync::remove_collection_entry(&state.db.pool, &progress, collection_id).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Remove entry");
    result
}

#[tauri::command]
pub async fn refresh_registry_details(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    force: bool,
) -> AppResult<sync::EnrichSummary> {
    let progress = ProgressEmitter::new(app, "enrich");
    set_active_cancel(&state, &progress).await;
    let result = sync::enrich_only(&state.db.pool, force, &progress).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Enrichment");
    result
}

// ----- eBay -----

#[derive(Serialize)]
pub struct EbayCredentialsState {
    pub environment: String,
    pub has_app_id: bool,
    pub has_cert_id: bool,
}

#[tauri::command]
pub async fn get_ebay_credentials(state: State<'_, AppState>) -> AppResult<EbayCredentialsState> {
    let environment = settings::get(&state.db.pool, settings::KEY_EBAY_ENVIRONMENT)
        .await?
        .unwrap_or_else(|| "sandbox".to_string());
    let has_app_id = settings::secret_get(settings::ENTRY_EBAY_APP_ID)?.is_some();
    let has_cert_id = settings::secret_get(settings::ENTRY_EBAY_CERT_ID)?.is_some();
    Ok(EbayCredentialsState {
        environment,
        has_app_id,
        has_cert_id,
    })
}

#[tauri::command]
pub async fn save_ebay_credentials(
    state: State<'_, AppState>,
    app_id: String,
    cert_id: String,
    environment: String,
) -> AppResult<()> {
    let env = match environment.as_str() {
        "production" | "sandbox" => environment,
        _ => "sandbox".to_string(),
    };
    settings::set(&state.db.pool, settings::KEY_EBAY_ENVIRONMENT, &env).await?;
    settings::secret_set(settings::ENTRY_EBAY_APP_ID, &app_id)?;
    settings::secret_set(settings::ENTRY_EBAY_CERT_ID, &cert_id)?;
    // Invalidate cached tokens — they were issued against the previous keys.
    let _ = settings::delete(&state.db.pool, "ebay.sandbox.access_token").await;
    let _ = settings::delete(&state.db.pool, "ebay.sandbox.access_token_expires_at").await;
    let _ = settings::delete(&state.db.pool, "ebay.production.access_token").await;
    let _ = settings::delete(&state.db.pool, "ebay.production.access_token_expires_at").await;
    Ok(())
}

#[tauri::command]
pub async fn clear_ebay_credentials(state: State<'_, AppState>) -> AppResult<()> {
    settings::secret_delete(settings::ENTRY_EBAY_APP_ID)?;
    settings::secret_delete(settings::ENTRY_EBAY_CERT_ID)?;
    settings::delete(&state.db.pool, "ebay.sandbox.access_token").await?;
    settings::delete(&state.db.pool, "ebay.sandbox.access_token_expires_at").await?;
    settings::delete(&state.db.pool, "ebay.production.access_token").await?;
    settings::delete(&state.db.pool, "ebay.production.access_token_expires_at").await?;
    Ok(())
}

/// Ping the OAuth endpoint to confirm the saved credentials work.
#[tauri::command]
pub async fn test_ebay_connection(state: State<'_, AppState>) -> AppResult<String> {
    let client = crate::ebay::EbayClient::from_settings(state.db.pool.clone()).await?;
    let _ = client.access_token().await?;
    Ok(format!("connected ({})", client.environment().as_str()))
}

// ----- eBay user OAuth -----

#[tauri::command]
pub async fn save_ebay_ru_name(state: State<'_, AppState>, ru_name: String) -> AppResult<()> {
    let env = settings::get(&state.db.pool, settings::KEY_EBAY_ENVIRONMENT)
        .await?
        .unwrap_or_else(|| "sandbox".to_string());
    settings::set(
        &state.db.pool,
        &settings::ebay_ru_name_key(&env),
        ru_name.trim(),
    )
    .await
}

#[tauri::command]
pub async fn get_ebay_ru_name(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let env = settings::get(&state.db.pool, settings::KEY_EBAY_ENVIRONMENT)
        .await?
        .unwrap_or_else(|| "sandbox".to_string());
    settings::get(&state.db.pool, &settings::ebay_ru_name_key(&env)).await
}

#[tauri::command]
pub async fn get_ebay_oauth_status(
    state: State<'_, AppState>,
) -> AppResult<crate::ebay::OauthStatus> {
    let env_str = settings::get(&state.db.pool, settings::KEY_EBAY_ENVIRONMENT)
        .await?
        .unwrap_or_else(|| "sandbox".to_string());
    let env = crate::ebay::EbayEnvironment::from_str(&env_str);
    crate::ebay::status(&state.db.pool, env).await
}

#[tauri::command]
pub async fn start_ebay_oauth(state: State<'_, AppState>) -> AppResult<String> {
    let env_str = settings::get(&state.db.pool, settings::KEY_EBAY_ENVIRONMENT)
        .await?
        .unwrap_or_else(|| "sandbox".to_string());
    let env = crate::ebay::EbayEnvironment::from_str(&env_str);
    let app_id = settings::secret_get(settings::ENTRY_EBAY_APP_ID)?
        .ok_or_else(|| AppError::NotConfigured("eBay App ID not set".into()))?;
    let ru_name = settings::get(&state.db.pool, &settings::ebay_ru_name_key(env.as_str()))
        .await?
        .ok_or_else(|| {
            AppError::NotConfigured("eBay RuName not set — configure it in Settings first".into())
        })?;

    // 32 random hex chars for CSRF state. Persisted so we can validate on
    // callback (M4c.2 will check this).
    let state_value: String = (0..16)
        .map(|_| format!("{:02x}", fastrand::u8(..)))
        .collect();
    settings::set(&state.db.pool, "ebay.oauth_pending_state", &state_value).await?;

    crate::ebay::authorize_url(
        env,
        &app_id,
        &ru_name,
        crate::ebay::DEFAULT_SCOPES,
        &state_value,
    )
}

#[tauri::command]
pub async fn complete_ebay_oauth(state: State<'_, AppState>, code: String) -> AppResult<()> {
    let env_str = settings::get(&state.db.pool, settings::KEY_EBAY_ENVIRONMENT)
        .await?
        .unwrap_or_else(|| "sandbox".to_string());
    let env = crate::ebay::EbayEnvironment::from_str(&env_str);
    let app_id = settings::secret_get(settings::ENTRY_EBAY_APP_ID)?
        .ok_or_else(|| AppError::NotConfigured("eBay App ID not set".into()))?;
    let cert_id = settings::secret_get(settings::ENTRY_EBAY_CERT_ID)?
        .ok_or_else(|| AppError::NotConfigured("eBay Cert ID not set".into()))?;
    let ru_name = settings::get(&state.db.pool, &settings::ebay_ru_name_key(env.as_str()))
        .await?
        .ok_or_else(|| AppError::NotConfigured("eBay RuName not set".into()))?;

    crate::ebay::exchange_code(
        &state.db.pool,
        env,
        &app_id,
        &cert_id,
        &ru_name,
        code.trim(),
    )
    .await?;

    let _ = settings::delete(&state.db.pool, "ebay.oauth_pending_state").await;
    Ok(())
}

#[tauri::command]
pub async fn disconnect_ebay_oauth(state: State<'_, AppState>) -> AppResult<()> {
    let env_str = settings::get(&state.db.pool, settings::KEY_EBAY_ENVIRONMENT)
        .await?
        .unwrap_or_else(|| "sandbox".to_string());
    let env = crate::ebay::EbayEnvironment::from_str(&env_str);
    crate::ebay::disconnect(&state.db.pool, env).await
}

#[tauri::command]
pub async fn add_ebay_listing(
    state: State<'_, AppState>,
    input: String,
) -> AppResult<sync::AddListingResult> {
    sync::add_listing_from_input(&state.db.pool, &input).await
}

#[tauri::command]
pub async fn search_ebay_listings(
    state: State<'_, AppState>,
    query: String,
    filters: crate::ebay::SearchFilters,
    limit: u32,
    offset: u32,
) -> AppResult<crate::ebay::SearchPage> {
    let client = crate::ebay::EbayClient::from_settings(state.db.pool.clone()).await?;
    crate::ebay::search_diecasts(&client, &query, &filters, limit, offset).await
}

#[tauri::command]
pub async fn watch_ebay_listing(
    state: State<'_, AppState>,
    input: String,
) -> AppResult<sync::AddListingResult> {
    sync::watch_and_save(&state.db.pool, &input).await
}

#[tauri::command]
pub async fn unwatch_ebay_listing(state: State<'_, AppState>, listing_id: i64) -> AppResult<()> {
    sync::unwatch_and_delete(&state.db.pool, listing_id).await
}

#[tauri::command]
pub async fn list_ebay_offers(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::ebay::ReceivedOffer>> {
    let (env, token) = crate::ebay::user_iaf_token(&state.db.pool).await?;
    crate::ebay::fetch_received_offers(&state.db.pool, env, &token).await
}

#[tauri::command]
pub async fn refresh_ebay_listing(state: State<'_, AppState>, listing_id: i64) -> AppResult<()> {
    sync::refresh_listing(&state.db.pool, listing_id).await
}

#[tauri::command]
pub async fn refresh_all_ebay_listings(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<sync::RefreshSummary> {
    let progress = ProgressEmitter::new(app, "ebay_refresh_all");
    set_active_cancel(&state, &progress).await;
    let result = sync::refresh_all_active(&state.db.pool, &progress).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Refresh");
    result
}

#[tauri::command]
pub async fn sync_ebay_watchlist(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<sync::WatchlistSyncSummary> {
    let progress = ProgressEmitter::new(app, "watchlist");
    set_active_cancel(&state, &progress).await;
    let result = sync::sync_watchlist(&state.db.pool, &progress).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Watchlist sync");
    result
}

#[tauri::command]
pub async fn sync_ebay_saved(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<sync::SavedSyncSummary> {
    let progress = ProgressEmitter::new(app, "saved");
    set_active_cancel(&state, &progress).await;
    let result = sync::sync_saved_from_ebay(&state.db.pool, &progress).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Saved sync");
    result
}

#[tauri::command]
pub async fn sync_ebay_all(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<sync::EbaySyncAllSummary> {
    let progress = ProgressEmitter::new(app, "ebay_all");
    set_active_cancel(&state, &progress).await;
    let result = sync::sync_all_ebay(&state.db.pool, &progress).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "eBay sync");
    result
}

#[derive(Serialize)]
pub struct ListingRow {
    pub listing_id: i64,
    pub seller_code: String,
    pub external_id: String,
    pub url: String,
    pub title: String,
    pub price_cents: Option<i64>,
    pub shipping_cents: Option<i64>,
    pub currency: String,
    pub condition: Option<String>,
    pub listing_type: Option<String>,
    /// eBay buyingOptions contains BEST_OFFER. Orthogonal to listing_type:
    /// most fixed-price listings take offers, the odd auction does too.
    pub accepts_offers: bool,
    pub status: String,
    /// Ended listing kept locally as history (match training data, trend
    /// analysis) after the sync removed it from the eBay watchlist. Exempt
    /// from watchlist pruning.
    pub is_archived: bool,
    /// Why an archived listing ended: 'sold', 'ended' (unsold), or 'removed'
    /// (vanished from eBay). None for active rows and pre-0024 archives not
    /// yet backfilled by a sync.
    pub end_reason: Option<String>,
    /// When the sync archived the listing (Unix seconds).
    pub archived_at: Option<i64>,
    pub end_time: Option<i64>,
    pub seller_username: Option<String>,
    pub seller_rating: Option<f64>,
    pub image_url: Option<String>,
    pub saved_at: i64,
    pub last_seen_at: i64,
    pub registry_entry_id: Option<i64>,
    pub match_confidence: Option<f64>,
    pub match_user_confirmed: bool,
    /// 'manual' (registry-search dialog), 'auto' (registry_auto_match), or
    /// None for pre-provenance rows (all manual links historically).
    pub matched_by: Option<String>,
    /// Human-readable signals behind an auto-match's confidence. Empty for
    /// manual links.
    pub match_reasons: Vec<String>,
    pub matched_driver_name: Option<String>,
    pub matched_scheme_text: Option<String>,
    pub matched_year: Option<i32>,
    pub matched_oem: Option<String>,
    pub matched_brand: Option<String>,
    pub matched_scale: Option<String>,
    pub matched_retail_cents: Option<i64>,
    pub matched_wholesale_cents: Option<i64>,
    /// Site-relative path to the registry detail page, parsed out of
    /// `registry_entries.raw_json`. None for stub entries that haven't been
    /// touched by a sync that records the URL.
    pub matched_detail_url: Option<String>,
    /// Total cost (price + shipping) as a percentage of registry retail. None
    /// if either side is missing. Lower = better deal.
    pub deal_score: Option<f64>,
    /// What comparable cars actually sold for, from our own archive of ended
    /// listings (see `crate::comps`). None until the archive holds enough
    /// sales for this entry — the common case on a young database.
    pub comps: Option<crate::comps::CompSummary>,
    /// Total cost as a percentage of the comp median. Same shape as
    /// `deal_score` but measured against real sales instead of list value.
    pub comp_score: Option<f64>,
    /// Auto-associated driver from `listings.driver_id` (populated by
    /// `sync::driver_assoc`). Independent of any registry match: lets the UI
    /// group/filter by driver even when no `listing_matches` row exists.
    pub auto_driver_id: Option<i64>,
    pub auto_driver_name: Option<String>,
    /// True when the user has manually pinned the driver (via
    /// set_listing_driver / clear_listing_driver). Auto-association skips
    /// rows where this is set.
    pub auto_driver_user_set: bool,
    /// ids of the user-curated groups this listing belongs to. Empty when
    /// the listing isn't in any group. See `listing_groups` module.
    pub group_ids: Vec<i64>,
    /// Listing-level attributes (independent of any registry match — for
    /// matched rows the registry entry's values are authoritative).
    /// Auto-filled from the title by `sync::attribute_assoc` unless the
    /// user pinned them; see migrations 0015/0016.
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub finish: Option<String>,
    /// Windowed-car/bank code: CWC, CWB, BWC, BWB.
    pub make: Option<String>,
    pub is_race_win: bool,
    pub is_autographed: bool,
    /// Production-run size entered by the user from the listing's
    /// production-tag photo (migration 0022), or copied from a confirmed
    /// match by the attribute backfill.
    pub production_count: Option<i64>,
    /// True when the attributes were copied from the confirmed registry
    /// match (`attrs_from_entry_id` set) rather than derived from the
    /// listing itself.
    pub attrs_from_match: bool,
    /// True when the user saved the attribute editor — auto-detection
    /// leaves the row alone until `reset_listing_attributes`.
    pub attributes_user_set: bool,
}

#[derive(sqlx::FromRow)]
struct ListingRowRaw {
    id: i64,
    seller_code: String,
    external_id: String,
    url: String,
    title: String,
    price_cents: Option<i64>,
    shipping_cents: Option<i64>,
    currency: String,
    condition: Option<String>,
    listing_type: Option<String>,
    accepts_offers: i64,
    status: String,
    is_archived: i64,
    end_reason: Option<String>,
    archived_at: Option<i64>,
    end_time: Option<i64>,
    seller_username: Option<String>,
    seller_rating: Option<f64>,
    image_url: Option<String>,
    saved_at: i64,
    last_seen_at: i64,
    registry_entry_id: Option<i64>,
    match_confidence: Option<f64>,
    match_user_confirmed: Option<i64>,
    matched_by: Option<String>,
    match_reasons: Option<String>,
    matched_driver_id: Option<i64>,
    matched_driver_name: Option<String>,
    matched_scheme_text: Option<String>,
    matched_year: Option<i32>,
    matched_oem: Option<String>,
    matched_brand: Option<String>,
    matched_scale: Option<String>,
    matched_retail_cents: Option<i64>,
    matched_wholesale_cents: Option<i64>,
    matched_raw_json: Option<String>,
    auto_driver_id: Option<i64>,
    auto_driver_name: Option<String>,
    auto_driver_user_set: i64,
    group_ids_csv: Option<String>,
    oem: Option<String>,
    brand: Option<String>,
    finish: Option<String>,
    make: Option<String>,
    is_race_win: i64,
    is_autographed: i64,
    production_count: Option<i64>,
    attrs_from_entry_id: Option<i64>,
    attributes_user_set: i64,
}

#[tauri::command]
pub async fn list_listings(state: State<'_, AppState>) -> AppResult<Vec<ListingRow>> {
    let rows: Vec<ListingRowRaw> = sqlx::query_as(
        "SELECT l.id, s.code AS seller_code, l.external_id, l.url, l.title,
                l.price_cents, l.shipping_cents, l.currency,
                l.condition, l.listing_type, l.accepts_offers, l.status,
                l.is_archived, l.end_reason, l.archived_at, l.end_time,
                l.seller_username, l.seller_rating, l.image_url,
                l.saved_at, l.last_seen_at,
                lm.registry_entry_id,
                lm.confidence AS match_confidence,
                lm.user_confirmed AS match_user_confirmed,
                lm.matched_by,
                lm.match_reasons,
                re.driver_id AS matched_driver_id,
                d.name AS matched_driver_name,
                re.scheme_text AS matched_scheme_text,
                re.year AS matched_year,
                re.oem AS matched_oem,
                re.brand AS matched_brand,
                re.scale AS matched_scale,
                re.retail_value_cents AS matched_retail_cents,
                re.wholesale_value_cents AS matched_wholesale_cents,
                re.raw_json AS matched_raw_json,
                ad.id AS auto_driver_id,
                ad.name AS auto_driver_name,
                l.driver_id_user_set AS auto_driver_user_set,
                (SELECT GROUP_CONCAT(group_id)
                   FROM listing_group_members
                  WHERE listing_id = l.id) AS group_ids_csv,
                l.oem, l.brand, l.finish, l.make, l.is_race_win, l.is_autographed,
                l.production_count, l.attrs_from_entry_id, l.attributes_user_set
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         LEFT JOIN listing_matches lm ON lm.listing_id = l.id
         LEFT JOIN registry_entries re ON re.id = lm.registry_entry_id
         LEFT JOIN drivers d ON d.id = re.driver_id
         LEFT JOIN drivers ad ON ad.id = l.driver_id
         ORDER BY l.status = 'active' DESC, l.last_seen_at DESC",
    )
    .fetch_all(&state.db.pool)
    .await?;

    // Loaded once for the whole page rather than per row — see `comps` for
    // why the archive is small enough to hold in memory.
    let comp_index = crate::comps::CompIndex::load(&state.db.pool, Utc::now().timestamp()).await?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let total_cents = r.price_cents.map(|p| p + r.shipping_cents.unwrap_or(0));
            let deal_score = match (total_cents, r.matched_retail_cents) {
                (Some(t), Some(retail)) if retail > 0 => Some((t as f64) / (retail as f64) * 100.0),
                _ => None,
            };
            // Comps hang off the registry match: without one there is nothing
            // to say this listing is the same car as any past sale.
            let comps = r.registry_entry_id.and_then(|entry_id| {
                comp_index.summarize(
                    &crate::comps::CompTarget {
                        registry_entry_id: entry_id,
                        driver_id: r.matched_driver_id,
                        scale: r.matched_scale.clone(),
                    },
                    Some(r.id),
                )
            });
            let comp_score = crate::comps::comp_score(total_cents, comps.as_ref());
            let matched_detail_url = r
                .matched_raw_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                .and_then(|v| {
                    v.get("detail_url")
                        .and_then(|x| x.as_str())
                        .map(str::to_owned)
                });
            ListingRow {
                listing_id: r.id,
                seller_code: r.seller_code,
                external_id: r.external_id,
                url: r.url,
                title: r.title,
                price_cents: r.price_cents,
                shipping_cents: r.shipping_cents,
                currency: r.currency,
                condition: r.condition,
                listing_type: r.listing_type,
                accepts_offers: r.accepts_offers != 0,
                status: r.status,
                is_archived: r.is_archived != 0,
                end_reason: r.end_reason,
                archived_at: r.archived_at,
                end_time: r.end_time,
                seller_username: r.seller_username,
                seller_rating: r.seller_rating,
                image_url: r.image_url,
                saved_at: r.saved_at,
                last_seen_at: r.last_seen_at,
                registry_entry_id: r.registry_entry_id,
                match_confidence: r.match_confidence,
                match_user_confirmed: r.match_user_confirmed.unwrap_or(0) != 0,
                matched_by: r.matched_by,
                match_reasons: r
                    .match_reasons
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                    .unwrap_or_default(),
                matched_driver_name: r.matched_driver_name,
                matched_scheme_text: r.matched_scheme_text,
                matched_year: r.matched_year,
                matched_oem: r.matched_oem,
                matched_brand: r.matched_brand,
                matched_scale: r.matched_scale,
                matched_retail_cents: r.matched_retail_cents,
                matched_wholesale_cents: r.matched_wholesale_cents,
                matched_detail_url,
                deal_score,
                comps,
                comp_score,
                auto_driver_id: r.auto_driver_id,
                auto_driver_name: r.auto_driver_name,
                auto_driver_user_set: r.auto_driver_user_set != 0,
                group_ids: r
                    .group_ids_csv
                    .as_deref()
                    .map(|csv| {
                        csv.split(',')
                            .filter_map(|s| s.trim().parse::<i64>().ok())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                oem: r.oem,
                brand: r.brand,
                finish: r.finish,
                make: r.make,
                is_race_win: r.is_race_win != 0,
                is_autographed: r.is_autographed != 0,
                production_count: r.production_count,
                attrs_from_match: r.attrs_from_entry_id.is_some(),
                attributes_user_set: r.attributes_user_set != 0,
            }
        })
        .collect())
}

/// Clear the manual link between this listing and its registry entry.
#[tauri::command]
pub async fn clear_listing_match(state: State<'_, AppState>, listing_id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM listing_matches WHERE listing_id = ?")
        .bind(listing_id)
        .execute(&state.db.pool)
        .await?;
    // Attributes copied from the now-removed match lose their basis.
    if let Err(e) = sync::attribute_assoc::clear_backfilled_attrs(&state.db.pool, listing_id).await
    {
        tracing::warn!("clearing backfilled attrs for listing {listing_id} failed: {e}");
    }
    Ok(())
}

/// Lock the listing as explicitly unmatched (user has reviewed and found
/// no registry entry).
#[tauri::command]
pub async fn reject_listing_match(state: State<'_, AppState>, listing_id: i64) -> AppResult<()> {
    sync::registry_link::mark_no_match(&state.db.pool, listing_id, "reject_button").await
}

/// Promote an auto-match to a user-confirmed one. The confidence value is
/// kept as-is so the row still records how sure the matcher was.
#[tauri::command]
pub async fn confirm_listing_match(state: State<'_, AppState>, listing_id: i64) -> AppResult<()> {
    let row: Option<(Option<i64>, i64)> = sqlx::query_as(
        "SELECT registry_entry_id, user_confirmed
         FROM listing_matches WHERE listing_id = ? AND registry_entry_id IS NOT NULL",
    )
    .bind(listing_id)
    .fetch_optional(&state.db.pool)
    .await?;
    let Some((entry_id, was_confirmed)) = row else {
        return Err(AppError::Parse(format!(
            "listing {listing_id} has no match to confirm"
        )));
    };

    sqlx::query(
        "UPDATE listing_matches SET user_confirmed = 1
         WHERE listing_id = ? AND registry_entry_id IS NOT NULL",
    )
    .bind(listing_id)
    .execute(&state.db.pool)
    .await?;

    if was_confirmed == 0 {
        match_feedback::record_best_effort(
            &state.db.pool,
            listing_id,
            entry_id,
            FeedbackLabel::Confirmed,
            "confirm_button",
        )
        .await;
    }
    if let Err(e) =
        sync::attribute_assoc::backfill_attrs_from_match(&state.db.pool, listing_id).await
    {
        tracing::warn!("attr backfill after confirm of listing {listing_id} failed: {e}");
    }
    Ok(())
}

/// Best-effort auto-match of one listing against the registry. Allowed to
/// hit diecastregistry.com (with progress events) when the listing's driver
/// has no locally cached registry entries yet.
#[tauri::command]
pub async fn auto_match_listing(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    listing_id: i64,
) -> AppResult<sync::AutoMatchOutcome> {
    let progress = ProgressEmitter::new(app, "auto_match");
    set_active_cancel(&state, &progress).await;
    let result =
        sync::registry_auto_match::auto_match_listing(&state.db.pool, listing_id, Some(&progress))
            .await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Auto-match");
    result
}

/// Auto-match every listing the user hasn't already confirmed or rejected.
#[tauri::command]
pub async fn auto_match_all_listings(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<sync::AutoMatchSummary> {
    let progress = ProgressEmitter::new(app, "auto_match_all");
    set_active_cancel(&state, &progress).await;
    let result = sync::registry_auto_match::auto_match_all(&state.db.pool, &progress, true).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Auto-match");
    result
}

/// Fit the auto-match scorer to the accumulated confirm/reject verdicts
/// and re-mine learned scheme aliases. Fast (in-process math over local
/// rows) — no progress plumbing needed.
#[tauri::command]
pub async fn retrain_matcher(
    state: State<'_, AppState>,
) -> AppResult<crate::matcher_training::TrainOutcome> {
    crate::matcher_training::retrain(&state.db.pool).await
}

/// Current scorer state for the Settings page: which weights are active,
/// training provenance, and per-feature default vs learned values.
#[tauri::command]
pub async fn matcher_status(
    state: State<'_, AppState>,
) -> AppResult<crate::matcher_training::MatcherStatus> {
    crate::matcher_training::status(&state.db.pool).await
}

/// Discard the learned scoring model (verdict history and learned aliases
/// are kept); scoring reverts to the built-in weights.
#[tauri::command]
pub async fn reset_matcher_model(state: State<'_, AppState>) -> AppResult<()> {
    crate::matcher_training::reset(&state.db.pool).await
}

// ----- Listing driver tag (independent of registry match) -----

#[derive(Serialize)]
pub struct DriverOption {
    pub id: i64,
    pub name: String,
    pub normalized_name: String,
    /// Saved listings currently linked to this driver (`listings.driver_id`).
    pub listing_count: i64,
}

/// Every driver we know about locally. Populated organically by DCR
/// collection sync, registry pre-warm, and user driver-tag picks below.
/// Ordered by saved-listing count descending so pickers surface the
/// most-used drivers first; ties (including all zero-listing drivers,
/// which land last) break alphabetically by name (case-insensitive).
#[tauri::command]
pub async fn list_drivers(state: State<'_, AppState>) -> AppResult<Vec<DriverOption>> {
    let rows: Vec<(i64, String, String, i64)> = sqlx::query_as(
        "SELECT d.id, d.name, d.normalized_name, COUNT(l.id) AS listing_count
         FROM drivers d
         LEFT JOIN listings l ON l.driver_id = d.id
         GROUP BY d.id, d.name, d.normalized_name
         ORDER BY listing_count DESC, d.name COLLATE NOCASE",
    )
    .fetch_all(&state.db.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, normalized_name, listing_count)| DriverOption {
            id,
            name,
            normalized_name,
            listing_count,
        })
        .collect())
}

/// User manually tags a listing with a driver. Identified by normalized
/// name so the caller can pick from either the local `drivers` table or
/// the DCR form-options cache — if the normalized name doesn't exist
/// locally yet, we insert a stub row so future listings can reuse it.
/// Sets `driver_id_user_set = 1` so the auto-association pass leaves
/// this row alone.
#[tauri::command]
pub async fn set_listing_driver(
    state: State<'_, AppState>,
    listing_id: i64,
    driver_name: String,
    driver_normalized: String,
) -> AppResult<i64> {
    let pool = &state.db.pool;
    let name = driver_name.trim();
    let normalized = driver_normalized.trim();
    if name.is_empty() || normalized.is_empty() {
        return Err(AppError::Parse(
            "driver_name and driver_normalized are required".into(),
        ));
    }

    // Upsert the local driver row. If a row with this normalized name
    // already exists, keep its display name (avoid clobbering the
    // canonical capitalization the rest of the app uses).
    sqlx::query(
        "INSERT INTO drivers (name, normalized_name) VALUES (?, ?)
         ON CONFLICT(normalized_name) DO NOTHING",
    )
    .bind(name)
    .bind(normalized)
    .execute(pool)
    .await?;
    let (driver_id,): (i64,) = sqlx::query_as("SELECT id FROM drivers WHERE normalized_name = ?")
        .bind(normalized)
        .fetch_one(pool)
        .await?;

    sqlx::query(
        "UPDATE listings
         SET driver_id = ?, driver_id_user_set = 1
         WHERE id = ?",
    )
    .bind(driver_id)
    .bind(listing_id)
    .execute(pool)
    .await?;
    Ok(driver_id)
}

/// User explicitly clears the driver tag — pins the listing to "no
/// driver" so auto-association won't try to fill it in. Different from
/// `reset_listing_driver`, which drops the pin and re-runs detection.
#[tauri::command]
pub async fn clear_listing_driver(state: State<'_, AppState>, listing_id: i64) -> AppResult<()> {
    sqlx::query(
        "UPDATE listings
         SET driver_id = NULL, driver_id_user_set = 1
         WHERE id = ?",
    )
    .bind(listing_id)
    .execute(&state.db.pool)
    .await?;
    Ok(())
}

/// Drop the manual pin and re-run auto-detection immediately. The
/// returned `driver_id` is whatever detection landed on (None when the
/// title doesn't contain any known driver name).
#[tauri::command]
pub async fn reset_listing_driver(
    state: State<'_, AppState>,
    listing_id: i64,
) -> AppResult<Option<i64>> {
    let pool = &state.db.pool;
    sqlx::query(
        "UPDATE listings
         SET driver_id = NULL, driver_id_user_set = 0
         WHERE id = ?",
    )
    .bind(listing_id)
    .execute(pool)
    .await?;
    sync::driver_assoc::associate_listing_driver(pool, listing_id).await?;
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT driver_id FROM listings WHERE id = ?")
        .bind(listing_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|(d,)| d))
}

/// Set the attributes on a listing (oem / brand / finish / make plus the
/// race-win and autograph flags). Replaces the full set every call — the UI
/// edits them together in one form. Empty or whitespace-only strings are
/// stored as NULL. Sets `attributes_user_set = 1` so the auto-fill pass in
/// `sync::attribute_assoc` leaves this row alone from now on.
// The argument list IS the IPC contract with the frontend's
// `setListingAttributes` — Tauri maps each named arg from the JS payload.
// Bundling them into a struct would mean a matching Deserialize type on both
// sides for no gain, so the 9 args stay.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn set_listing_attributes(
    state: State<'_, AppState>,
    listing_id: i64,
    oem: Option<String>,
    brand: Option<String>,
    finish: Option<String>,
    make: Option<String>,
    is_race_win: bool,
    is_autographed: bool,
    production_count: Option<i64>,
) -> AppResult<()> {
    fn clean(s: Option<String>) -> Option<String> {
        s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    }
    sqlx::query(
        "UPDATE listings
         SET oem = ?, brand = ?, finish = ?, make = ?,
             is_race_win = ?, is_autographed = ?, production_count = ?,
             attributes_user_set = 1, attrs_from_entry_id = NULL
         WHERE id = ?",
    )
    .bind(clean(oem))
    .bind(clean(brand))
    .bind(clean(finish))
    .bind(clean(make))
    .bind(is_race_win as i64)
    .bind(is_autographed as i64)
    .bind(production_count.filter(|v| *v >= 0))
    .bind(listing_id)
    .execute(&state.db.pool)
    .await?;
    Ok(())
}

/// Drop the manual attribute pin, wipe the attribute fields, and re-run
/// auto-detection on the title. Mirrors `reset_listing_driver`.
#[tauri::command]
pub async fn reset_listing_attributes(
    state: State<'_, AppState>,
    listing_id: i64,
) -> AppResult<()> {
    let pool = &state.db.pool;
    sqlx::query(
        "UPDATE listings
         SET oem = NULL, brand = NULL, finish = NULL, make = NULL,
             is_race_win = 0, is_autographed = 0, production_count = NULL,
             attributes_user_set = 0, attrs_from_entry_id = NULL
         WHERE id = ?",
    )
    .bind(listing_id)
    .execute(pool)
    .await?;
    sync::attribute_assoc::associate_listing_attributes(pool, listing_id).await?;
    Ok(())
}

// ----- Listing receiver (browser-extension backend) -----

#[derive(Serialize)]
pub struct ListingReceiverStatus {
    pub url: String,
    pub port: u16,
    pub has_secret: bool,
}

#[tauri::command]
pub async fn get_listing_receiver_status(
    state: State<'_, AppState>,
) -> AppResult<ListingReceiverStatus> {
    let port = crate::listing_receiver::configured_port(&state.db.pool).await?;
    let has_secret = settings::secret_get(settings::ENTRY_LISTING_RECEIVER_SECRET)?.is_some();
    Ok(ListingReceiverStatus {
        url: format!("http://localhost:{port}"),
        port,
        has_secret,
    })
}

#[tauri::command]
pub fn get_listing_receiver_secret() -> AppResult<String> {
    crate::listing_receiver::ensure_secret()
}

#[tauri::command]
pub fn regenerate_listing_receiver_secret() -> AppResult<String> {
    crate::listing_receiver::regenerate_secret()
}

// ----- Background mode (tray + autostart) -----

#[derive(Serialize)]
pub struct BackgroundSettings {
    pub run_in_background: bool,
    pub autostart: bool,
}

#[tauri::command]
pub async fn get_background_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<BackgroundSettings> {
    use tauri_plugin_autostart::ManagerExt;
    Ok(BackgroundSettings {
        run_in_background: state.run_in_background.load(Ordering::Relaxed),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    })
}

#[tauri::command]
pub async fn set_background_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    run_in_background: bool,
    autostart: bool,
) -> AppResult<()> {
    use tauri_plugin_autostart::ManagerExt;
    settings::set(
        &state.db.pool,
        settings::KEY_RUN_IN_BACKGROUND,
        if run_in_background { "true" } else { "false" },
    )
    .await?;
    state
        .run_in_background
        .store(run_in_background, Ordering::Relaxed);
    let autolaunch = app.autolaunch();
    let result = if autostart {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    if let Err(e) = result {
        // disable() can fail when autostart was never registered — only
        // surface failures to actually enable it.
        if autostart {
            return Err(AppError::Config(format!(
                "couldn't register start-at-login: {e}"
            )));
        }
    }
    Ok(())
}

// ----- eBay listing filter -----

#[tauri::command]
pub async fn get_ebay_filter_non_diecasts(state: State<'_, AppState>) -> AppResult<bool> {
    match settings::get(&state.db.pool, settings::KEY_EBAY_FILTER_NON_DIECASTS).await? {
        Some(s) => Ok(s != "false"),
        None => Ok(true),
    }
}

#[tauri::command]
pub async fn set_ebay_filter_non_diecasts(
    state: State<'_, AppState>,
    enabled: bool,
) -> AppResult<()> {
    settings::set(
        &state.db.pool,
        settings::KEY_EBAY_FILTER_NON_DIECASTS,
        if enabled { "true" } else { "false" },
    )
    .await
}

#[tauri::command]
pub async fn get_ebay_buyer_zip(state: State<'_, AppState>) -> AppResult<Option<String>> {
    settings::get(&state.db.pool, settings::KEY_EBAY_BUYER_ZIP).await
}

/// Empty input clears the setting. Sanitized to alphanumerics and dashes so
/// the value is safe to embed in the X-EBAY-C-ENDUSERCTX header.
#[tauri::command]
pub async fn set_ebay_buyer_zip(state: State<'_, AppState>, zip: String) -> AppResult<()> {
    let cleaned: String = zip
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if cleaned.is_empty() {
        settings::delete(&state.db.pool, settings::KEY_EBAY_BUYER_ZIP).await
    } else {
        settings::set(&state.db.pool, settings::KEY_EBAY_BUYER_ZIP, &cleaned).await
    }
}

#[derive(Serialize)]
pub struct CleanupSummary {
    pub examined: u32,
    pub removed: u32,
}

/// Walk every eBay listing currently in the DB and remove ones whose
/// category_path doesn't pass the diecast filter. Listings without
/// category_path data (saved before M5b.3) are NOT touched — they pre-date
/// the filter, and we can't safely classify them. Refresh those first if
/// you want them considered.
#[tauri::command]
pub async fn remove_non_diecast_listings(state: State<'_, AppState>) -> AppResult<CleanupSummary> {
    let pool = &state.db.pool;
    let rows: Vec<(i64, Option<String>)> = sqlx::query_as(
        "SELECT l.id, l.category_path
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay' AND l.category_path IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let mut summary = CleanupSummary {
        examined: rows.len() as u32,
        removed: 0,
    };
    for (id, path) in rows {
        if !crate::ebay::is_diecast(path.as_deref()) {
            sqlx::query("DELETE FROM listings WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await?;
            summary.removed += 1;
        }
    }
    Ok(summary)
}

// ----- Registry-search dialog (Option C: live search of diecastregistry.com) -----

#[tauri::command]
pub async fn refresh_registry_form_options(
    state: State<'_, AppState>,
) -> AppResult<crate::dcr::RefreshOptionsSummary> {
    let username = settings::get(&state.db.pool, settings::KEY_DCR_USERNAME)
        .await?
        .ok_or_else(|| {
            AppError::NotConfigured("diecastregistry.com username not set in Settings".into())
        })?;
    let password = settings::secret_get(settings::ENTRY_DCR_PASSWORD)?.ok_or_else(|| {
        AppError::NotConfigured("diecastregistry.com password not set in Settings".into())
    })?;
    let client = crate::dcr::DcrClient::new()?;
    client.login(&username, &password).await?;
    crate::dcr::refresh_form_options(&state.db.pool, &client).await
}

#[derive(Serialize)]
pub struct FormOptionRow {
    pub value: String,
    pub display: String,
    pub normalized: String,
}

#[derive(sqlx::FromRow)]
struct FormOptionRowRaw {
    value: String,
    display: String,
    normalized: String,
}

#[tauri::command]
pub async fn list_registry_form_options(
    state: State<'_, AppState>,
    field: String,
) -> AppResult<Vec<FormOptionRow>> {
    let rows: Vec<FormOptionRowRaw> = sqlx::query_as(
        "SELECT value, display, normalized
         FROM registry_form_options
         WHERE field = ?
         ORDER BY display COLLATE NOCASE",
    )
    .bind(&field)
    .fetch_all(&state.db.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| FormOptionRow {
            value: r.value,
            display: r.display,
            normalized: r.normalized,
        })
        .collect())
}

#[tauri::command]
pub async fn search_dcr_production(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    filter: crate::dcr::ProductionSearchFilter,
) -> AppResult<Vec<crate::dcr::ProductionSearchResult>> {
    let progress = ProgressEmitter::new(app, "registry_search");
    set_active_cancel(&state, &progress).await;
    let mode = settings::get(&state.db.pool, settings::KEY_REGISTRY_SEARCH_MODE)
        .await?
        .unwrap_or_default();
    let result = match mode.as_str() {
        "local" => run_local_registry_search(&state.db.pool, &progress, &filter).await,
        "hybrid" => {
            run_hybrid_registry_search(&state.db.pool, &state.dcr_session, &progress, &filter).await
        }
        _ => {
            run_dcr_production_search(&state.db.pool, &state.dcr_session, &progress, &filter).await
        }
    };
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Registry search");
    result
}

#[tauri::command]
pub async fn get_registry_search_mode(state: State<'_, AppState>) -> AppResult<String> {
    Ok(
        settings::get(&state.db.pool, settings::KEY_REGISTRY_SEARCH_MODE)
            .await?
            .unwrap_or_else(|| "remote".to_string()),
    )
}

#[tauri::command]
pub async fn set_registry_search_mode(state: State<'_, AppState>, mode: String) -> AppResult<()> {
    if !matches!(mode.as_str(), "remote" | "hybrid" | "local") {
        return Err(AppError::Parse(format!(
            "unknown registry search mode: {mode}"
        )));
    }
    settings::set(&state.db.pool, settings::KEY_REGISTRY_SEARCH_MODE, &mode).await
}

/// Export the currently displayed registry-search results to a standalone
/// HTML file at `path` (chosen by the user via a save dialog on the JS
/// side). Images are downloaded and embedded, so this can take a while for
/// big result sets — it participates in the shared progress/cancel plumbing.
#[tauri::command]
pub async fn export_registry_search_html(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    results: Vec<crate::dcr::ProductionSearchResult>,
    finish_label: Option<String>,
    path: String,
) -> AppResult<crate::export::ExportSummary> {
    let progress = ProgressEmitter::new(app, "registry_export");
    set_active_cancel(&state, &progress).await;
    let result =
        crate::export::export_registry_results(&progress, &results, finish_label.as_deref(), &path)
            .await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Registry export");
    result
}

/// Export one wishlist (entries, notes, linked candidate listings) to a
/// standalone print-friendly HTML file at `path`. Same image-embedding and
/// progress/cancel behavior as the registry export.
#[tauri::command]
pub async fn export_wishlist_html(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    wishlist_id: i64,
    path: String,
) -> AppResult<crate::export::ExportSummary> {
    let name: Option<(String,)> = sqlx::query_as("SELECT name FROM wishlists WHERE id = ?")
        .bind(wishlist_id)
        .fetch_optional(&state.db.pool)
        .await?;
    let name = name
        .map(|(n,)| n)
        .ok_or_else(|| AppError::Config("wishlist no longer exists".into()))?;
    let entries = crate::wishlist::list(&state.db.pool, wishlist_id).await?;
    let progress = ProgressEmitter::new(app, "wishlist_export");
    set_active_cancel(&state, &progress).await;
    let result = crate::export::export_wishlist(&progress, &name, &entries, &path).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Wishlist export");
    result
}

/// Export the collection rows the My Collection page is currently displaying
/// (post-filter, post-sort — the frontend passes them back) to a standalone
/// print-friendly HTML file at `path`. Same image-embedding and
/// progress/cancel behavior as the registry export.
#[tauri::command]
pub async fn export_collection_html(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    rows: Vec<CollectionRow>,
    path: String,
) -> AppResult<crate::export::ExportSummary> {
    let progress = ProgressEmitter::new(app, "collection_export");
    set_active_cancel(&state, &progress).await;
    let result = crate::export::export_collection(&progress, &rows, &path).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Collection export");
    result
}

/// CSV counterpart of [`export_collection_html`] — no images, so it writes
/// immediately without progress plumbing.
#[tauri::command]
pub async fn export_collection_csv(
    rows: Vec<CollectionRow>,
    path: String,
) -> AppResult<crate::export::ExportSummary> {
    crate::export::export_collection_csv(&rows, &path).await
}

async fn run_dcr_production_search(
    pool: &SqlitePool,
    session: &crate::dcr::DcrSession,
    progress: &ProgressEmitter,
    filter: &crate::dcr::ProductionSearchFilter,
) -> AppResult<Vec<crate::dcr::ProductionSearchResult>> {
    progress.step("Connecting to diecastregistry.com…", None, None);
    let (client, was_cached) = session.get_or_login(pool).await?;

    let subject = resolve_search_subject(pool, filter).await;
    let first =
        crate::dcr::search_all_pages_with_progress(&client, filter, progress, subject.as_deref())
            .await;
    // A cached session that errors — or comes back empty, which is what an
    // expired auth cookie looks like after the redirect to the login page —
    // gets one retry on a fresh login. Costs a duplicate search only when
    // the query genuinely has zero results.
    let stale_suspect = was_cached && !matches!(&first, Ok((r, _)) if !r.is_empty());
    let results = if stale_suspect {
        session.invalidate().await;
        progress.step(
            "Session may have expired — logging in to diecastregistry.com again…",
            None,
            None,
        );
        let (client, _) = session.get_or_login(pool).await?;
        let (results, _) = crate::dcr::search_all_pages_with_progress(
            &client,
            filter,
            progress,
            subject.as_deref(),
        )
        .await?;
        results
    } else {
        first?.0
    };
    progress.done(format!("Found {} results.", results.len()));
    Ok(results)
}

#[derive(sqlx::FromRow)]
struct LocalRegistryRow {
    external_id: String,
    detail_url: Option<String>,
    image_url: Option<String>,
    driver_name: String,
    driver_normalized: String,
    year: Option<i32>,
    oem: Option<String>,
    brand: Option<String>,
    scale: Option<String>,
    make: Option<String>,
    scheme_text: Option<String>,
    production_qty: Option<i64>,
    retail_value_cents: Option<i64>,
    wholesale_value_cents: Option<i64>,
}

/// Local counterpart of `run_dcr_production_search`: answers the search from
/// pre-warmed `registry_entries` rows without touching the network. Filter
/// GUIDs are translated to the stored display text through
/// `registry_form_options`. Autographed and raced aren't stored locally, so
/// those filters are ignored (called out in the done message).
async fn run_local_registry_search(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
    filter: &crate::dcr::ProductionSearchFilter,
) -> AppResult<Vec<crate::dcr::ProductionSearchResult>> {
    progress.step("Searching pre-warmed local registry…", None, None);
    let results = local_registry_query(pool, filter).await?;

    let mut ignored: Vec<&str> = Vec::new();
    if filter.autographed {
        ignored.push("autographed");
    }
    if filter.raced {
        ignored.push("race-win");
    }
    let mut msg = format!("Found {} results in the local registry.", results.len());
    if !ignored.is_empty() {
        msg.push_str(&format!(
            " The {} filter{} not stored locally and {} ignored.",
            ignored.join(" / "),
            if ignored.len() == 1 { " is" } else { "s are" },
            if ignored.len() == 1 { "was" } else { "were" },
        ));
    }
    if results.is_empty() && !filter.driver_guids.is_empty() {
        msg.push_str(
            " If this driver hasn't been pre-warmed yet, pre-warm it in Settings or switch the search mode.",
        );
    }
    progress.done(msg);
    Ok(results)
}

/// Hybrid mode: answer from the pre-warmed local rows when they can fully
/// cover the query, otherwise (or when the local answer is empty) fall
/// through to the live diecastregistry.com search.
async fn run_hybrid_registry_search(
    pool: &SqlitePool,
    session: &crate::dcr::DcrSession,
    progress: &ProgressEmitter,
    filter: &crate::dcr::ProductionSearchFilter,
) -> AppResult<Vec<crate::dcr::ProductionSearchResult>> {
    if local_can_answer(pool, filter).await? {
        progress.step("Searching pre-warmed local registry…", None, None);
        let results = local_registry_query(pool, filter).await?;
        if !results.is_empty() {
            progress.done(format!(
                "Found {} results in the local registry.",
                results.len()
            ));
            return Ok(results);
        }
        progress.step(
            "No local matches — searching diecastregistry.com…",
            None,
            None,
        );
    }
    run_dcr_production_search(pool, session, progress, filter).await
}

/// Local rows can answer a query only when they're guaranteed complete for
/// it: every filtered driver has been pre-warmed, and the filter doesn't use
/// fields the local rows don't store (autographed / race-win). Finish IS
/// stored — detail enrichment fills `registry_entries.finish` — so finish
/// filters stay local. Driverless searches always go remote — local data
/// only covers pre-warmed drivers, so a broad local answer would silently
/// miss everyone else.
async fn local_can_answer(
    pool: &SqlitePool,
    filter: &crate::dcr::ProductionSearchFilter,
) -> AppResult<bool> {
    if filter.driver_guids.is_empty() || filter.autographed || filter.raced {
        return Ok(false);
    }
    for guid in &filter.driver_guids {
        let key = format!("dcr.last_prewarm.{guid}");
        if settings::get(pool, &key).await?.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn local_registry_query(
    pool: &SqlitePool,
    filter: &crate::dcr::ProductionSearchFilter,
) -> AppResult<Vec<crate::dcr::ProductionSearchResult>> {
    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT re.external_id,
                json_extract(re.raw_json, '$.detail_url') AS detail_url,
                -- Pre-warmed stubs carry the search-page thumbnail as
                -- image_url; detail-page-enriched rows only have the
                -- lightbox photos array. Either renders fine in the UI.
                COALESCE(json_extract(re.raw_json, '$.image_url'),
                         json_extract(re.raw_json, '$.photos[0]')) AS image_url,
                COALESCE(d.name, '(unknown driver)') AS driver_name,
                COALESCE(d.normalized_name, '') AS driver_normalized,
                re.year, re.oem, re.brand, re.scale, re.make,
                re.scheme_text, re.production_qty,
                re.retail_value_cents, re.wholesale_value_cents
         FROM registry_entries re
         LEFT JOIN drivers d ON d.id = re.driver_id
         WHERE 1 = 1",
    );

    if !filter.driver_guids.is_empty() {
        qb.push(
            " AND d.normalized_name IN (SELECT normalized FROM registry_form_options
               WHERE field = 'driver' AND value IN (",
        );
        let mut sep = qb.separated(", ");
        for g in &filter.driver_guids {
            sep.push_bind(g);
        }
        qb.push("))");
    }
    if !filter.years.is_empty() {
        qb.push(" AND CAST(re.year AS TEXT) IN (");
        let mut sep = qb.separated(", ");
        for y in &filter.years {
            sep.push_bind(y);
        }
        qb.push(")");
    }
    // Text columns hold the same display strings the dropdowns show, so map
    // GUID → display through the form-options cache and compare loosely.
    for (column, field, guids) in [
        ("re.oem", "oem", &filter.oem_guids),
        ("re.brand", "brand", &filter.brand_guids),
        ("re.make", "make", &filter.make_guids),
        ("re.scale", "scale", &filter.scale_guids),
        // Finish comes from detail-page enrichment rather than the pre-warm
        // stub; entries that were never enriched have NULL finish and drop
        // out of finish-filtered results.
        ("re.finish", "finish", &filter.finish_guids),
    ] {
        if guids.is_empty() {
            continue;
        }
        qb.push(format!(
            " AND {column} COLLATE NOCASE IN (SELECT display FROM registry_form_options
               WHERE field = '{field}' AND value IN ("
        ));
        let mut sep = qb.separated(", ");
        for g in guids {
            sep.push_bind(g);
        }
        qb.push("))");
    }
    qb.push(" ORDER BY driver_name COLLATE NOCASE, re.year DESC, re.brand COLLATE NOCASE");

    let rows: Vec<LocalRegistryRow> = qb.build_query_as().fetch_all(pool).await?;
    let results: Vec<crate::dcr::ProductionSearchResult> = rows
        .into_iter()
        .map(|r| crate::dcr::ProductionSearchResult {
            registry_guid: r.external_id,
            detail_url: r.detail_url,
            image_url: r.image_url,
            driver_name: r.driver_name,
            driver_normalized: r.driver_normalized,
            year: r.year,
            oem: r.oem,
            brand: r.brand,
            scale: r.scale,
            make: r.make,
            scheme_text: r.scheme_text,
            seq_produced_total: r.production_qty,
            retail_value_cents: r.retail_value_cents,
            wholesale_value_cents: r.wholesale_value_cents,
        })
        .collect();
    Ok(results)
}

/// If the filter pins exactly one driver, look up its display name so the
/// per-page progress label reads "Fetching page X of Y for Jeff Gordon…"
/// instead of the more generic "for the registry".
async fn resolve_search_subject(
    pool: &SqlitePool,
    filter: &crate::dcr::ProductionSearchFilter,
) -> Option<String> {
    if filter.driver_guids.len() != 1 {
        return None;
    }
    let guid = &filter.driver_guids[0];
    sqlx::query_as::<_, (String,)>(
        "SELECT display FROM registry_form_options WHERE field = 'driver' AND value = ?",
    )
    .bind(guid)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .map(|(d,)| d)
}

#[tauri::command]
pub async fn link_listing_to_registry(
    state: State<'_, AppState>,
    listing_id: i64,
    registry_guid: String,
    detail_url: Option<String>,
) -> AppResult<sync::LinkResult> {
    sync::link_listing_to_registry(
        &state.db.pool,
        listing_id,
        &registry_guid,
        detail_url.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn prewarm_registry_by_driver(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    driver_guid: String,
) -> AppResult<sync::PrewarmSummary> {
    let progress = ProgressEmitter::new(app, "prewarm");
    set_active_cancel(&state, &progress).await;
    let result = sync::prewarm_by_driver(&state.db.pool, &driver_guid, &progress).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Pre-warm");
    result
}

/// Re-walk the production search for every driver that has registry entries
/// missing a `detail_url` in raw_json, merging the recovered URLs back in.
/// Repairs the "View on diecastregistry.com" link on matched listings for
/// entries enriched before detail_url was carried forward.
#[tauri::command]
pub async fn backfill_registry_detail_urls(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<sync::DetailUrlBackfillSummary> {
    let progress = ProgressEmitter::new(app, "detail-url-backfill");
    set_active_cancel(&state, &progress).await;
    let result = sync::backfill_detail_urls(&state.db.pool, &progress).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Link repair");
    result
}

#[derive(Serialize)]
pub struct PrewarmedDriver {
    pub driver_guid: String,
    pub driver_name: String,
    /// Number of registry entries currently stored locally for this driver.
    pub entry_count: i64,
    /// Unix timestamp of the most recent pre-warm for this driver.
    pub last_prewarmed_at: i64,
}

/// List the drivers that have been pre-warmed into the local registry, ordered
/// by how many registry entries they have. Sourced from the
/// `dcr.last_prewarm.{guid}` settings keys written by `prewarm_by_driver`; the
/// display name is resolved from the cached registry driver options, and the
/// entry count is joined through the shared `normalize_driver_name` key
/// (`registry_form_options.normalized` = `drivers.normalized_name`).
#[tauri::command]
pub async fn list_prewarmed_drivers(state: State<'_, AppState>) -> AppResult<Vec<PrewarmedDriver>> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT
            substr(s.key, length('dcr.last_prewarm.') + 1) AS driver_guid,
            COALESCE(o.display, '(unknown driver)') AS driver_name,
            (SELECT COUNT(*)
               FROM registry_entries re
               JOIN drivers d ON d.id = re.driver_id
              WHERE d.normalized_name = o.normalized
                AND re.source <> 'local') AS entry_count,
            CAST(s.value AS INTEGER) AS last_prewarmed_at
         FROM settings s
         LEFT JOIN registry_form_options o
            ON o.field = 'driver'
           AND o.value = substr(s.key, length('dcr.last_prewarm.') + 1)
         WHERE s.key LIKE 'dcr.last_prewarm.%'
         ORDER BY entry_count DESC, driver_name COLLATE NOCASE",
    )
    .fetch_all(&state.db.pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(driver_guid, driver_name, entry_count, last_prewarmed_at)| PrewarmedDriver {
                driver_guid,
                driver_name,
                entry_count,
                last_prewarmed_at,
            },
        )
        .collect())
}

#[derive(Serialize)]
pub struct DriverGroup {
    pub driver_id: i64,
    pub driver_name: String,
    pub item_count: i64,
    pub retail_total_cents: i64,
    pub wholesale_total_cents: i64,
}

// Deserialize too: the collection exports round-trip the displayed rows
// back from the frontend (see export_collection_html / _csv).
#[derive(Serialize, Deserialize)]
pub struct CollectionRow {
    pub collection_id: i64,
    pub asset_guid: String,
    pub driver_id: Option<i64>,
    pub driver_name: Option<String>,
    pub year: Option<i32>,
    pub year_raced: Option<i32>,
    pub car_number: Option<String>,
    pub diecast_type: Option<String>,
    pub registration_number: Option<String>,
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub scale: Option<String>,
    pub make: Option<String>,
    pub finish: Option<String>,
    pub production_qty: Option<i64>,
    pub scheme_text: Option<String>,
    pub image_url: Option<String>,
    pub detail_url: Option<String>,
    pub retail_value_cents: Option<i64>,
    pub wholesale_value_cents: Option<i64>,
    pub registry_int_id: Option<i64>,
    pub enriched: bool,
    /// Manually added by the user rather than synced from DCR (DCH-12).
    /// Drives the "Manual" badge and the Edit action, and suppresses the
    /// "stub — needs registry sync" hint, which would be false: there are no
    /// registry details to fetch for a car DCR doesn't list.
    #[serde(default)]
    pub is_local: bool,
    /// What the user paid, in cents — a cost basis, not an appraisal. A
    /// manual entry has no `retail_value_cents`, so this is the only figure
    /// standing behind it in the collection totals.
    #[serde(default)]
    pub paid_cents: Option<i64>,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(sqlx::FromRow)]
struct CollectionRowRaw {
    id: i64,
    external_id: String,
    driver_id: Option<i64>,
    driver_name: Option<String>,
    year: Option<i32>,
    year_raced: Option<i32>,
    car_number: Option<String>,
    diecast_type: Option<String>,
    registration_number: Option<String>,
    registry_scheme_text: Option<String>,
    oem: Option<String>,
    brand: Option<String>,
    scale: Option<String>,
    make: Option<String>,
    finish: Option<String>,
    production_qty: Option<i64>,
    retail_value_cents: Option<i64>,
    wholesale_value_cents: Option<i64>,
    details_fetched_at: Option<i64>,
    raw_json: Option<String>,
    collection_source: Option<String>,
    paid_cents: Option<i64>,
    condition: Option<String>,
    notes: Option<String>,
}

// The "complex type" is a sqlx row tuple whose shape is dictated by the
// SELECT list right below it. A type alias would move the column list away
// from the query it describes, which is the opposite of clearer.
#[allow(clippy::type_complexity)]
#[tauri::command]
pub async fn list_drivers_with_counts(state: State<'_, AppState>) -> AppResult<Vec<DriverGroup>> {
    let rows: Vec<(i64, String, i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT d.id,
                d.name,
                COUNT(c.id) AS item_count,
                COALESCE(SUM(re.retail_value_cents), 0) AS retail_total,
                COALESCE(SUM(re.wholesale_value_cents), 0) AS wholesale_total
         FROM drivers d
         JOIN registry_entries re ON re.driver_id = d.id
         JOIN my_collection c ON c.registry_entry_id = re.id
         GROUP BY d.id, d.name
         ORDER BY d.name",
    )
    .fetch_all(&state.db.pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, name, count, retail, wholesale)| DriverGroup {
            driver_id: id,
            driver_name: name,
            item_count: count,
            retail_total_cents: retail.unwrap_or(0),
            wholesale_total_cents: wholesale.unwrap_or(0),
        })
        .collect())
}

#[tauri::command]
pub async fn list_collection_for_driver(
    state: State<'_, AppState>,
    driver_id: i64,
) -> AppResult<Vec<CollectionRow>> {
    fetch_collection_rows(&state.db.pool, Some(driver_id)).await
}

#[tauri::command]
pub async fn list_all_collection_items(
    state: State<'_, AppState>,
) -> AppResult<Vec<CollectionRow>> {
    fetch_collection_rows(&state.db.pool, None).await
}

/// Add a car diecastregistry.com doesn't list. Purely local — no DCR call,
/// and nothing here ever reaches the user's My Garage. See
/// `local_collection` for why the entry is stored as a registry row.
#[tauri::command]
pub async fn create_local_collection_entry(
    state: State<'_, AppState>,
    input: local_collection::LocalEntryInput,
) -> AppResult<local_collection::LocalEntrySummary> {
    local_collection::create_local_entry(&state.db.pool, input).await
}

/// Edit a manually-added entry. Errors on a DCR-sourced row rather than
/// writing a change the next sync would overwrite.
#[tauri::command]
pub async fn update_local_collection_entry(
    state: State<'_, AppState>,
    collection_id: i64,
    input: local_collection::LocalEntryInput,
) -> AppResult<local_collection::LocalEntrySummary> {
    local_collection::update_local_entry(&state.db.pool, collection_id, input).await
}

async fn fetch_collection_rows(
    pool: &SqlitePool,
    driver_id: Option<i64>,
) -> AppResult<Vec<CollectionRow>> {
    let base = "SELECT c.id,
                c.external_id,
                d.id AS driver_id,
                d.name AS driver_name,
                re.year,
                re.year_raced,
                re.car_number,
                re.diecast_type,
                re.registration_number,
                re.scheme_text AS registry_scheme_text,
                re.oem,
                re.brand,
                re.scale,
                re.make,
                re.finish,
                re.production_qty,
                re.retail_value_cents,
                re.wholesale_value_cents,
                re.details_fetched_at,
                c.raw_json,
                c.source AS collection_source,
                c.paid_cents,
                c.condition,
                c.notes
         FROM my_collection c
         JOIN registry_entries re ON re.id = c.registry_entry_id
         JOIN drivers d ON d.id = re.driver_id";
    let rows: Vec<CollectionRowRaw> = match driver_id {
        Some(id) => {
            sqlx::query_as(&format!(
                "{base} WHERE d.id = ? ORDER BY re.year DESC, c.id DESC"
            ))
            .bind(id)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query_as(&format!(
                "{base} ORDER BY d.name COLLATE NOCASE, re.year DESC, c.id DESC"
            ))
            .fetch_all(pool)
            .await?
        }
    };

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let coll_json: serde_json::Value = r
            .raw_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Null);

        let scheme_text = r.registry_scheme_text.clone().or_else(|| {
            coll_json
                .get("scheme_text")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        });
        let image_url = coll_json
            .get("image_url")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let detail_url = coll_json
            .get("detail_url")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let registry_int_id = coll_json.get("registry_int_id").and_then(|v| v.as_i64());

        out.push(CollectionRow {
            collection_id: r.id,
            asset_guid: r.external_id,
            driver_id: r.driver_id,
            driver_name: r.driver_name,
            year: r.year,
            year_raced: r.year_raced,
            car_number: r.car_number,
            diecast_type: r.diecast_type,
            registration_number: r.registration_number,
            oem: r.oem,
            brand: r.brand,
            scale: r.scale,
            make: r.make,
            finish: r.finish,
            production_qty: r.production_qty,
            scheme_text,
            image_url,
            detail_url,
            retail_value_cents: r.retail_value_cents,
            wholesale_value_cents: r.wholesale_value_cents,
            registry_int_id,
            enriched: r.details_fetched_at.is_some(),
            is_local: r.collection_source.as_deref() == Some(local_collection::SOURCE_LOCAL),
            paid_cents: r.paid_cents,
            condition: r.condition,
            notes: r.notes,
        });
    }

    Ok(out)
}

// --- Saved searches + saved sellers ---------------------------------------

#[tauri::command]
pub async fn list_saved_searches(state: State<'_, AppState>) -> AppResult<Vec<saved::SavedSearch>> {
    saved::list_searches(&state.db.pool).await
}

#[tauri::command]
pub async fn create_saved_search(
    state: State<'_, AppState>,
    input: saved::SavedSearchInput,
) -> AppResult<saved::SavedSearch> {
    saved::create_search(&state.db.pool, input).await
}

#[tauri::command]
pub async fn update_saved_search(
    state: State<'_, AppState>,
    id: i64,
    input: saved::SavedSearchInput,
) -> AppResult<saved::SavedSearch> {
    saved::update_search(&state.db.pool, id, input).await
}

#[tauri::command]
pub async fn delete_saved_search(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    saved::delete_search(&state.db.pool, id).await
}

/// Run a saved search against eBay Browse and bump its `last_run_at`. The
/// `limit`/`offset` paginate the same way the Browse page's search does.
#[tauri::command]
pub async fn run_saved_search(
    state: State<'_, AppState>,
    id: i64,
    limit: u32,
    offset: u32,
) -> AppResult<crate::ebay::SearchPage> {
    let search = saved::get_search(&state.db.pool, id).await?;
    let filters = crate::ebay::SearchFilters {
        conditions: search.conditions.clone(),
        buying_options: search.buying_options.clone(),
        sellers: search.sellers.clone(),
        price_min_cents: search.price_min_cents,
        price_max_cents: search.price_max_cents,
        sort: search.sort.clone(),
    };
    let client = crate::ebay::EbayClient::from_settings(state.db.pool.clone()).await?;
    let page =
        crate::ebay::search_diecasts(&client, &search.query, &filters, limit, offset).await?;
    // Only record successful runs — failures don't change "when did I last
    // actually pull results."
    saved::mark_search_ran(&state.db.pool, id).await?;
    Ok(page)
}

#[tauri::command]
pub async fn list_saved_sellers(state: State<'_, AppState>) -> AppResult<Vec<saved::SavedSeller>> {
    saved::list_sellers(&state.db.pool).await
}

#[tauri::command]
pub async fn add_saved_seller(
    state: State<'_, AppState>,
    input: saved::SavedSellerInput,
) -> AppResult<saved::SavedSeller> {
    saved::add_seller(&state.db.pool, input).await
}

#[tauri::command]
pub async fn update_saved_seller(
    state: State<'_, AppState>,
    id: i64,
    input: saved::SavedSellerInput,
) -> AppResult<saved::SavedSeller> {
    saved::update_seller(&state.db.pool, id, input).await
}

#[tauri::command]
pub async fn remove_saved_seller(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    saved::remove_seller(&state.db.pool, id).await
}

/// Aggregated feed of recent listings across every saved eBay seller. The
/// frontend can layer a keyword `query` and condition/price/buying-option
/// filters and a sort on top, and may narrow to a subset of the saved
/// sellers by populating `filters.sellers` — that subset is intersected
/// (case-insensitively) with the saved-sellers list so we never bypass the
/// saved-sellers gate. Returns an empty page with `total = 0` if no saved
/// sellers match — the UI uses that as its empty-state signal.
#[tauri::command]
pub async fn saved_sellers_feed(
    state: State<'_, AppState>,
    query: Option<String>,
    filters: crate::ebay::SearchFilters,
    limit: u32,
    offset: u32,
) -> AppResult<crate::ebay::SearchPage> {
    let saved_sellers = saved::list_seller_usernames(&state.db.pool).await?;
    if saved_sellers.is_empty() {
        return Ok(crate::ebay::SearchPage {
            items: Vec::new(),
            total: 0,
            limit,
            offset,
            has_more: false,
        });
    }

    let sellers = if filters.sellers.is_empty() {
        saved_sellers
    } else {
        let saved_lower: std::collections::HashSet<String> =
            saved_sellers.iter().map(|s| s.to_lowercase()).collect();
        let filtered: Vec<String> = filters
            .sellers
            .iter()
            .filter(|s| saved_lower.contains(&s.to_lowercase()))
            .cloned()
            .collect();
        if filtered.is_empty() {
            return Ok(crate::ebay::SearchPage {
                items: Vec::new(),
                total: 0,
                limit,
                offset,
                has_more: false,
            });
        }
        filtered
    };

    let merged = crate::ebay::SearchFilters {
        conditions: filters.conditions,
        price_min_cents: filters.price_min_cents,
        price_max_cents: filters.price_max_cents,
        buying_options: filters.buying_options,
        sellers,
        sort: filters.sort.or_else(|| Some("newlyListed".to_string())),
    };
    let q = query.as_deref().unwrap_or("").trim();
    let client = crate::ebay::EbayClient::from_settings(state.db.pool.clone()).await?;
    crate::ebay::search_diecasts(&client, q, &merged, limit, offset).await
}

// --- Listing groups -------------------------------------------------------

#[tauri::command]
pub async fn list_listing_groups(
    state: State<'_, AppState>,
) -> AppResult<Vec<listing_groups::ListingGroup>> {
    listing_groups::list_groups(&state.db.pool).await
}

#[tauri::command]
pub async fn create_listing_group(
    state: State<'_, AppState>,
    input: listing_groups::ListingGroupInput,
) -> AppResult<listing_groups::ListingGroup> {
    listing_groups::create_group(&state.db.pool, input).await
}

#[tauri::command]
pub async fn update_listing_group(
    state: State<'_, AppState>,
    id: i64,
    input: listing_groups::ListingGroupInput,
) -> AppResult<listing_groups::ListingGroup> {
    listing_groups::update_group(&state.db.pool, id, input).await
}

#[tauri::command]
pub async fn delete_listing_group(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    listing_groups::delete_group(&state.db.pool, id).await
}

#[tauri::command]
pub async fn add_listing_to_group(
    state: State<'_, AppState>,
    group_id: i64,
    listing_id: i64,
) -> AppResult<()> {
    listing_groups::add_listing(&state.db.pool, group_id, listing_id).await
}

#[tauri::command]
pub async fn remove_listing_from_group(
    state: State<'_, AppState>,
    group_id: i64,
    listing_id: i64,
) -> AppResult<()> {
    listing_groups::remove_listing(&state.db.pool, group_id, listing_id).await
}

#[tauri::command]
pub async fn add_listings_to_group(
    state: State<'_, AppState>,
    group_id: i64,
    listing_ids: Vec<i64>,
) -> AppResult<listing_groups::BulkAddResult> {
    listing_groups::add_listings(&state.db.pool, group_id, &listing_ids).await
}

#[tauri::command]
pub async fn remove_listings_from_group(
    state: State<'_, AppState>,
    group_id: i64,
    listing_ids: Vec<i64>,
) -> AppResult<i64> {
    listing_groups::remove_listings(&state.db.pool, group_id, &listing_ids).await
}

/// Ensure a driver row exists for `name`/`normalized` and return its id.
/// Used by the group editor and the name-migration wizard to attach a
/// driver that may not yet be in the local `drivers` table. Mirrors the
/// upsert in `set_listing_driver` but doesn't touch any listing.
#[tauri::command]
pub async fn ensure_driver(
    state: State<'_, AppState>,
    name: String,
    normalized: String,
) -> AppResult<i64> {
    let pool = &state.db.pool;
    let name = name.trim();
    let normalized = normalized.trim();
    if name.is_empty() || normalized.is_empty() {
        return Err(AppError::Parse("name and normalized are required".into()));
    }
    sqlx::query(
        "INSERT INTO drivers (name, normalized_name) VALUES (?, ?)
         ON CONFLICT(normalized_name) DO NOTHING",
    )
    .bind(name)
    .bind(normalized)
    .execute(pool)
    .await?;
    let (id,): (i64,) = sqlx::query_as("SELECT id FROM drivers WHERE normalized_name = ?")
        .bind(normalized)
        .fetch_one(pool)
        .await?;
    Ok(id)
}

/// Preview the driver-prefix rename for every group given a list of
/// handles. Writes nothing — see `listing_groups::propose_migration`.
#[tauri::command]
pub async fn propose_group_migration(
    state: State<'_, AppState>,
    handles: Vec<String>,
) -> AppResult<Vec<listing_groups::GroupMigrationProposal>> {
    listing_groups::propose_migration(&state.db.pool, handles).await
}

/// Apply the finalized renames + driver links from the migration wizard.
#[tauri::command]
pub async fn apply_group_migration(
    state: State<'_, AppState>,
    items: Vec<listing_groups::GroupMigrationItem>,
) -> AppResult<i64> {
    listing_groups::apply_migration(&state.db.pool, items).await
}

#[tauri::command]
pub async fn list_wishlists(state: State<'_, AppState>) -> AppResult<Vec<wishlist::WishlistInfo>> {
    wishlist::list_wishlists(&state.db.pool).await
}

#[tauri::command]
pub async fn create_wishlist(
    state: State<'_, AppState>,
    name: String,
) -> AppResult<wishlist::WishlistInfo> {
    wishlist::create_wishlist(&state.db.pool, &name).await
}

#[tauri::command]
pub async fn rename_wishlist(
    state: State<'_, AppState>,
    wishlist_id: i64,
    name: String,
) -> AppResult<()> {
    wishlist::rename_wishlist(&state.db.pool, wishlist_id, &name).await
}

/// Delete a list and its entries. Refuses to delete the last remaining
/// list so the add-from-search flow always has a target.
#[tauri::command]
pub async fn delete_wishlist(state: State<'_, AppState>, wishlist_id: i64) -> AppResult<()> {
    wishlist::delete_wishlist(&state.db.pool, wishlist_id).await
}

/// Add a registry-search result to a wishlist. Idempotent — re-adding an
/// entry already on that list returns `created = false`.
#[tauri::command]
pub async fn add_wishlist_entry(
    state: State<'_, AppState>,
    wishlist_id: i64,
    result: crate::dcr::ProductionSearchResult,
) -> AppResult<wishlist::WishlistAddResult> {
    wishlist::add_from_search(&state.db.pool, wishlist_id, &result).await
}

#[tauri::command]
pub async fn list_wishlist(
    state: State<'_, AppState>,
    wishlist_id: i64,
) -> AppResult<Vec<wishlist::WishlistEntry>> {
    wishlist::list(&state.db.pool, wishlist_id).await
}

/// Registry GUIDs wished for on any list — backs the "In wishlist"
/// indicator on registry search results.
#[tauri::command]
pub async fn list_wishlisted_guids(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    wishlist::wishlisted_guids(&state.db.pool).await
}

/// Persist a drag-and-drop stack ranking: `ordered_ids[i]` gets rank `i`.
#[tauri::command]
pub async fn reorder_wishlist(state: State<'_, AppState>, ordered_ids: Vec<i64>) -> AppResult<()> {
    wishlist::reorder(&state.db.pool, &ordered_ids).await
}

#[tauri::command]
pub async fn remove_wishlist_entry(state: State<'_, AppState>, entry_id: i64) -> AppResult<()> {
    wishlist::remove(&state.db.pool, entry_id).await
}

/// Move an entry (with its notes and linked listings) to another list.
#[tauri::command]
pub async fn move_wishlist_entry(
    state: State<'_, AppState>,
    entry_id: i64,
    wishlist_id: i64,
) -> AppResult<()> {
    wishlist::move_entry(&state.db.pool, entry_id, wishlist_id).await
}

#[tauri::command]
pub async fn set_wishlist_notes(
    state: State<'_, AppState>,
    entry_id: i64,
    notes: Option<String>,
) -> AppResult<()> {
    wishlist::set_notes(&state.db.pool, entry_id, notes).await
}

#[tauri::command]
pub async fn link_listing_to_wishlist(
    state: State<'_, AppState>,
    entry_id: i64,
    listing_id: i64,
) -> AppResult<()> {
    wishlist::link_listing(&state.db.pool, entry_id, listing_id).await
}

#[tauri::command]
pub async fn unlink_listing_from_wishlist(
    state: State<'_, AppState>,
    entry_id: i64,
    listing_id: i64,
) -> AppResult<()> {
    wishlist::unlink_listing(&state.db.pool, entry_id, listing_id).await
}

// ---------- wishlist sharing (DCH-46) ----------

/// Sharing config as the Settings screen needs it. The secret is reported
/// as present/absent and never returned — same shape as the DCR password.
#[derive(Debug, Serialize)]
pub struct ShareSettings {
    pub worker_url: Option<String>,
    pub has_secret: bool,
}

#[tauri::command]
pub async fn get_share_settings(state: State<'_, AppState>) -> AppResult<ShareSettings> {
    Ok(ShareSettings {
        worker_url: settings::get(&state.db.pool, settings::KEY_SHARE_WORKER_URL).await?,
        has_secret: settings::secret_get(settings::ENTRY_SHARE_WORKER_SECRET)?.is_some(),
    })
}

/// Save the Worker URL and, when a non-empty one is supplied, the shared
/// secret. An empty `secret` leaves the stored one alone so the user can
/// correct the URL without re-typing the credential.
#[tauri::command]
pub async fn save_share_settings(
    state: State<'_, AppState>,
    worker_url: String,
    secret: String,
) -> AppResult<ShareSettings> {
    let url = worker_url.trim().trim_end_matches('/');
    settings::set(&state.db.pool, settings::KEY_SHARE_WORKER_URL, url).await?;
    if !secret.trim().is_empty() {
        settings::secret_set(settings::ENTRY_SHARE_WORKER_SECRET, secret.trim())?;
    }
    get_share_settings(state).await
}

#[tauri::command]
pub async fn clear_share_settings(state: State<'_, AppState>) -> AppResult<ShareSettings> {
    settings::set(&state.db.pool, settings::KEY_SHARE_WORKER_URL, "").await?;
    settings::secret_delete(settings::ENTRY_SHARE_WORKER_SECRET)?;
    get_share_settings(state).await
}

/// Current share state of one wishlist, including whether sharing is
/// configured at all — the dialog uses that to explain what's missing
/// instead of offering a button that fails.
#[tauri::command]
pub async fn wishlist_share_status(
    state: State<'_, AppState>,
    wishlist_id: i64,
) -> AppResult<crate::share::ShareStatus> {
    crate::share::status(&state.db.pool, wishlist_id).await
}

/// Render the wishlist and publish it under a fresh unguessable slug,
/// replacing any previous share for this list. `include_notes` /
/// `include_candidates` restore the private fields a public link omits by
/// default; both default to off.
#[tauri::command]
pub async fn share_wishlist(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    wishlist_id: i64,
    include_notes: Option<bool>,
    include_candidates: Option<bool>,
    ttl_days: Option<u32>,
) -> AppResult<crate::share::ShareStatus> {
    // Start from what a public link is allowed to carry and let the caller
    // opt back in, so the safe shape is stated once, in export.rs, rather
    // than re-asserted as a pair of `false`s here.
    let default = crate::export::WishlistRenderOptions::PUBLIC;
    let options = crate::export::WishlistRenderOptions {
        include_notes: include_notes.unwrap_or(default.include_notes),
        include_candidates: include_candidates.unwrap_or(default.include_candidates),
    };
    let progress = ProgressEmitter::new(app, "wishlist_share");
    let result = crate::share::share(
        &state.db.pool,
        &progress,
        wishlist_id,
        options,
        ttl_days.unwrap_or(30),
    )
    .await;
    if let Err(e) = &result {
        progress.fail(e.to_string());
    }
    result
}

/// Take a shared link out of circulation.
#[tauri::command]
pub async fn revoke_wishlist_share(
    state: State<'_, AppState>,
    wishlist_id: i64,
) -> AppResult<crate::share::ShareStatus> {
    crate::share::revoke(&state.db.pool, wishlist_id).await
}

/// Bulk-add saved listings to a wishlist as purchase candidates (DCH-45).
/// Resolves each listing through its registry match, find-or-creates the
/// wish, and links the listing — all in one transaction. Listings with no
/// registry match come back in `skipped_no_match` rather than failing the
/// call; the caller reports them as a notice.
#[tauri::command]
pub async fn add_listings_to_wishlist(
    state: State<'_, AppState>,
    wishlist_id: i64,
    listing_ids: Vec<i64>,
) -> AppResult<wishlist::WishlistBulkAddResult> {
    wishlist::add_listings(&state.db.pool, wishlist_id, &listing_ids).await
}

// ---------- registry pre-searches (DCH-14) ----------

#[tauri::command]
pub async fn list_registry_presearches(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::presearch::Presearch>> {
    crate::presearch::list(&state.db.pool).await
}

#[tauri::command]
pub async fn create_registry_presearch(
    state: State<'_, AppState>,
    input: crate::presearch::PresearchInput,
) -> AppResult<i64> {
    crate::presearch::create(&state.db.pool, input).await
}

#[tauri::command]
pub async fn update_registry_presearch(
    state: State<'_, AppState>,
    id: i64,
    input: crate::presearch::PresearchInput,
) -> AppResult<()> {
    crate::presearch::update(&state.db.pool, id, input).await
}

#[tauri::command]
pub async fn delete_registry_presearch(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    crate::presearch::delete(&state.db.pool, id).await
}

/// Walk DCR for one pre-search and cache the results locally. Shares the
/// progress/cancel plumbing with the other long-running syncs, since a broad
/// filter can take several pages.
#[tauri::command]
pub async fn refresh_registry_presearch(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: i64,
) -> AppResult<u32> {
    let progress = ProgressEmitter::new(app, "presearch_refresh");
    set_active_cancel(&state, &progress).await;
    let result = crate::presearch::refresh_one(&state.db.pool, id, &progress).await;
    clear_active_cancel(&state).await;
    if result.is_err() {
        finish_progress(&progress, &result, "Pre-search refresh");
    }
    result
}
