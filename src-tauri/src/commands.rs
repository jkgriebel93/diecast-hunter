use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::atomic::Ordering;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync;
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
fn finish_progress<T>(
    progress: &ProgressEmitter,
    result: &AppResult<T>,
    op_label: &str,
) {
    match result {
        Err(AppError::Cancelled) => {
            progress.cancelled_event(format!("{op_label} cancelled."))
        }
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
    Ok(())
}

#[tauri::command]
pub async fn clear_diecastregistry_credentials(
    state: State<'_, AppState>,
) -> AppResult<()> {
    settings::delete(&state.db.pool, settings::KEY_DCR_USERNAME).await?;
    settings::secret_delete(settings::ENTRY_DCR_PASSWORD)?;
    Ok(())
}

#[tauri::command]
pub async fn get_setting(
    state: State<'_, AppState>,
    key: String,
) -> AppResult<Option<String>> {
    settings::get(&state.db.pool, &key).await
}

#[tauri::command]
pub async fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<()> {
    settings::set(&state.db.pool, &key, &value).await
}

#[tauri::command]
pub async fn sync_dcr_collection(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<sync::SyncSummary> {
    let progress = ProgressEmitter::new(app, "sync");
    set_active_cancel(&state, &progress).await;
    let result = sync::sync_dcr_collection_and_enrich(&state.db.pool, &progress).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Sync");
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
pub async fn get_ebay_credentials(
    state: State<'_, AppState>,
) -> AppResult<EbayCredentialsState> {
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
pub async fn clear_ebay_credentials(
    state: State<'_, AppState>,
) -> AppResult<()> {
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
pub async fn test_ebay_connection(
    state: State<'_, AppState>,
) -> AppResult<String> {
    let client = crate::ebay::EbayClient::from_settings(state.db.pool.clone()).await?;
    let _ = client.access_token().await?;
    Ok(format!("connected ({})", client.environment().as_str()))
}

// ----- eBay user OAuth -----

#[tauri::command]
pub async fn save_ebay_ru_name(
    state: State<'_, AppState>,
    ru_name: String,
) -> AppResult<()> {
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
            AppError::NotConfigured(
                "eBay RuName not set — configure it in Settings first".into(),
            )
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
pub async fn complete_ebay_oauth(
    state: State<'_, AppState>,
    code: String,
) -> AppResult<()> {
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
pub async fn refresh_ebay_listing(
    state: State<'_, AppState>,
    listing_id: i64,
) -> AppResult<()> {
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
    pub status: String,
    pub end_time: Option<i64>,
    pub seller_username: Option<String>,
    pub seller_rating: Option<f64>,
    pub image_url: Option<String>,
    pub saved_at: i64,
    pub last_seen_at: i64,
    pub registry_entry_id: Option<i64>,
    pub match_confidence: Option<f64>,
    pub match_user_confirmed: bool,
    pub matched_driver_name: Option<String>,
    pub matched_scheme_text: Option<String>,
    pub matched_year: Option<i32>,
    pub matched_oem: Option<String>,
    pub matched_brand: Option<String>,
    pub matched_scale: Option<String>,
    pub matched_retail_cents: Option<i64>,
    pub matched_wholesale_cents: Option<i64>,
    /// Total cost (price + shipping) as a percentage of registry retail. None
    /// if either side is missing. Lower = better deal.
    pub deal_score: Option<f64>,
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
    status: String,
    end_time: Option<i64>,
    seller_username: Option<String>,
    seller_rating: Option<f64>,
    image_url: Option<String>,
    saved_at: i64,
    last_seen_at: i64,
    registry_entry_id: Option<i64>,
    match_confidence: Option<f64>,
    match_user_confirmed: Option<i64>,
    matched_driver_name: Option<String>,
    matched_scheme_text: Option<String>,
    matched_year: Option<i32>,
    matched_oem: Option<String>,
    matched_brand: Option<String>,
    matched_scale: Option<String>,
    matched_retail_cents: Option<i64>,
    matched_wholesale_cents: Option<i64>,
}

#[tauri::command]
pub async fn list_listings(
    state: State<'_, AppState>,
) -> AppResult<Vec<ListingRow>> {
    let rows: Vec<ListingRowRaw> = sqlx::query_as(
        "SELECT l.id, s.code AS seller_code, l.external_id, l.url, l.title,
                l.price_cents, l.shipping_cents, l.currency,
                l.condition, l.listing_type, l.status, l.end_time,
                l.seller_username, l.seller_rating, l.image_url,
                l.saved_at, l.last_seen_at,
                lm.registry_entry_id,
                lm.confidence AS match_confidence,
                lm.user_confirmed AS match_user_confirmed,
                d.name AS matched_driver_name,
                re.scheme_text AS matched_scheme_text,
                re.year AS matched_year,
                re.oem AS matched_oem,
                re.brand AS matched_brand,
                re.scale AS matched_scale,
                re.retail_value_cents AS matched_retail_cents,
                re.wholesale_value_cents AS matched_wholesale_cents
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         LEFT JOIN listing_matches lm ON lm.listing_id = l.id
         LEFT JOIN registry_entries re ON re.id = lm.registry_entry_id
         LEFT JOIN drivers d ON d.id = re.driver_id
         ORDER BY l.status = 'active' DESC, l.last_seen_at DESC",
    )
    .fetch_all(&state.db.pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let total_cents = r
                .price_cents
                .map(|p| p + r.shipping_cents.unwrap_or(0));
            let deal_score = match (total_cents, r.matched_retail_cents) {
                (Some(t), Some(retail)) if retail > 0 => {
                    Some((t as f64) / (retail as f64) * 100.0)
                }
                _ => None,
            };
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
                status: r.status,
                end_time: r.end_time,
                seller_username: r.seller_username,
                seller_rating: r.seller_rating,
                image_url: r.image_url,
                saved_at: r.saved_at,
                last_seen_at: r.last_seen_at,
                registry_entry_id: r.registry_entry_id,
                match_confidence: r.match_confidence,
                match_user_confirmed: r.match_user_confirmed.unwrap_or(0) != 0,
                matched_driver_name: r.matched_driver_name,
                matched_scheme_text: r.matched_scheme_text,
                matched_year: r.matched_year,
                matched_oem: r.matched_oem,
                matched_brand: r.matched_brand,
                matched_scale: r.matched_scale,
                matched_retail_cents: r.matched_retail_cents,
                matched_wholesale_cents: r.matched_wholesale_cents,
                deal_score,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn rematch_all_listings(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<sync::MatchSummary> {
    let progress = ProgressEmitter::new(app, "rematch");
    set_active_cancel(&state, &progress).await;
    let result = sync::match_all(&state.db.pool, &progress).await;
    clear_active_cancel(&state).await;
    finish_progress(&progress, &result, "Re-match");
    result
}

/// Lock the current auto-match as user-confirmed so re-match-all won't
/// overwrite it. No-op if there's no current match row.
#[tauri::command]
pub async fn confirm_listing_match(
    state: State<'_, AppState>,
    listing_id: i64,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE listing_matches SET user_confirmed = 1, matched_at = ?
         WHERE listing_id = ?",
    )
    .bind(chrono::Utc::now().timestamp())
    .bind(listing_id)
    .execute(&state.db.pool)
    .await?;
    Ok(())
}

/// Set a manual match. user_confirmed=1 protects it from auto-rematch.
#[tauri::command]
pub async fn set_listing_match(
    state: State<'_, AppState>,
    listing_id: i64,
    registry_entry_id: i64,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO listing_matches
            (listing_id, registry_entry_id, confidence, user_confirmed, matched_at)
         VALUES (?, ?, 100.0, 1, ?)
         ON CONFLICT(listing_id) DO UPDATE SET
            registry_entry_id = excluded.registry_entry_id,
            confidence = excluded.confidence,
            user_confirmed = 1,
            matched_at = excluded.matched_at",
    )
    .bind(listing_id)
    .bind(registry_entry_id)
    .bind(now)
    .execute(&state.db.pool)
    .await?;
    Ok(())
}

/// Clear a match and allow auto-rematch to consider it again next time.
#[tauri::command]
pub async fn clear_listing_match(
    state: State<'_, AppState>,
    listing_id: i64,
) -> AppResult<()> {
    sqlx::query("DELETE FROM listing_matches WHERE listing_id = ?")
        .bind(listing_id)
        .execute(&state.db.pool)
        .await?;
    Ok(())
}

/// Lock the listing as explicitly unmatched. Auto-rematch won't touch it
/// until the user clears or sets a match.
#[tauri::command]
pub async fn reject_listing_match(
    state: State<'_, AppState>,
    listing_id: i64,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO listing_matches
            (listing_id, registry_entry_id, confidence, user_confirmed, matched_at)
         VALUES (?, NULL, 0.0, 1, ?)
         ON CONFLICT(listing_id) DO UPDATE SET
            registry_entry_id = NULL,
            confidence = 0.0,
            user_confirmed = 1,
            matched_at = excluded.matched_at",
    )
    .bind(listing_id)
    .bind(now)
    .execute(&state.db.pool)
    .await?;
    Ok(())
}

#[derive(Serialize)]
pub struct RegistryPickerRow {
    pub id: i64,
    pub driver_name: Option<String>,
    pub year: Option<i32>,
    pub year_raced: Option<i32>,
    pub scheme_text: Option<String>,
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub scale: Option<String>,
    pub retail_value_cents: Option<i64>,
    pub wholesale_value_cents: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct RegistryPickerRowRaw {
    id: i64,
    driver_name: Option<String>,
    year: Option<i32>,
    year_raced: Option<i32>,
    scheme_text: Option<String>,
    oem: Option<String>,
    brand: Option<String>,
    scale: Option<String>,
    retail_value_cents: Option<i64>,
    wholesale_value_cents: Option<i64>,
}

// ----- eBay listing filter -----

#[tauri::command]
pub async fn get_ebay_filter_non_diecasts(
    state: State<'_, AppState>,
) -> AppResult<bool> {
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
pub async fn remove_non_diecast_listings(
    state: State<'_, AppState>,
) -> AppResult<CleanupSummary> {
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

// ----- Listing receiver (FB Marketplace browser-extension target) -----

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
    let has_secret =
        settings::secret_get(settings::ENTRY_LISTING_RECEIVER_SECRET)?.is_some();
    Ok(ListingReceiverStatus {
        url: format!("http://localhost:{port}"),
        port,
        has_secret,
    })
}

#[tauri::command]
pub async fn get_listing_receiver_secret(
    _state: State<'_, AppState>,
) -> AppResult<String> {
    crate::listing_receiver::ensure_secret()
}

#[tauri::command]
pub async fn regenerate_listing_receiver_secret(
    _state: State<'_, AppState>,
) -> AppResult<String> {
    crate::listing_receiver::regenerate_secret()
}

// ----- Registry-search dialog (Option C: live search of diecastregistry.com) -----

#[tauri::command]
pub async fn refresh_registry_form_options(
    state: State<'_, AppState>,
) -> AppResult<crate::dcr::RefreshOptionsSummary> {
    let username = settings::get(&state.db.pool, settings::KEY_DCR_USERNAME)
        .await?
        .ok_or_else(|| {
            AppError::NotConfigured(
                "diecastregistry.com username not set in Settings".into(),
            )
        })?;
    let password = settings::secret_get(settings::ENTRY_DCR_PASSWORD)?
        .ok_or_else(|| {
            AppError::NotConfigured(
                "diecastregistry.com password not set in Settings".into(),
            )
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
    filter: crate::dcr::ProductionSearchFilter,
) -> AppResult<Vec<crate::dcr::ProductionSearchResult>> {
    let username = settings::get(&state.db.pool, settings::KEY_DCR_USERNAME)
        .await?
        .ok_or_else(|| {
            AppError::NotConfigured(
                "diecastregistry.com username not set in Settings".into(),
            )
        })?;
    let password = settings::secret_get(settings::ENTRY_DCR_PASSWORD)?
        .ok_or_else(|| {
            AppError::NotConfigured(
                "diecastregistry.com password not set in Settings".into(),
            )
        })?;
    let client = crate::dcr::DcrClient::new()?;
    client.login(&username, &password).await?;
    crate::dcr::search(&client, &filter).await
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

/// Search registry entries for the manual-match picker. Empty `query` returns
/// the most recently fetched entries; otherwise filters by case-insensitive
/// substring match across driver / scheme / year / OEM / brand / scale.
#[tauri::command]
pub async fn search_registry_for_match(
    state: State<'_, AppState>,
    query: String,
    limit: i64,
) -> AppResult<Vec<RegistryPickerRow>> {
    let limit = limit.clamp(1, 500);
    let trimmed = query.trim();
    let rows: Vec<RegistryPickerRowRaw> = if trimmed.is_empty() {
        sqlx::query_as(
            "SELECT re.id,
                    d.name AS driver_name,
                    re.year,
                    re.year_raced,
                    re.scheme_text,
                    re.oem,
                    re.brand,
                    re.scale,
                    re.retail_value_cents,
                    re.wholesale_value_cents
             FROM registry_entries re
             LEFT JOIN drivers d ON d.id = re.driver_id
             ORDER BY d.name, re.year DESC, re.id
             LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&state.db.pool)
        .await?
    } else {
        let needle = format!("%{}%", trimmed.to_lowercase());
        sqlx::query_as(
            "SELECT re.id,
                    d.name AS driver_name,
                    re.year,
                    re.year_raced,
                    re.scheme_text,
                    re.oem,
                    re.brand,
                    re.scale,
                    re.retail_value_cents,
                    re.wholesale_value_cents
             FROM registry_entries re
             LEFT JOIN drivers d ON d.id = re.driver_id
             WHERE LOWER(
                COALESCE(d.name, '') || ' ' ||
                COALESCE(re.scheme_text, '') || ' ' ||
                COALESCE(CAST(re.year AS TEXT), '') || ' ' ||
                COALESCE(re.oem, '') || ' ' ||
                COALESCE(re.brand, '') || ' ' ||
                COALESCE(re.scale, '') || ' ' ||
                COALESCE(re.car_number, '')
             ) LIKE ?
             ORDER BY d.name, re.year DESC, re.id
             LIMIT ?",
        )
        .bind(needle)
        .bind(limit)
        .fetch_all(&state.db.pool)
        .await?
    };

    Ok(rows
        .into_iter()
        .map(|r| RegistryPickerRow {
            id: r.id,
            driver_name: r.driver_name,
            year: r.year,
            year_raced: r.year_raced,
            scheme_text: r.scheme_text,
            oem: r.oem,
            brand: r.brand,
            scale: r.scale,
            retail_value_cents: r.retail_value_cents,
            wholesale_value_cents: r.wholesale_value_cents,
        })
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

#[derive(Serialize)]
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
}

#[tauri::command]
pub async fn list_drivers_with_counts(
    state: State<'_, AppState>,
) -> AppResult<Vec<DriverGroup>> {
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
                c.raw_json
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
        });
    }

    Ok(out)
}
