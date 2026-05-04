use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::error::AppResult;
use crate::settings;
use crate::sync;
use crate::AppState;

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
) -> AppResult<sync::SyncSummary> {
    sync::sync_dcr_collection_and_enrich(&state.db.pool).await
}

#[tauri::command]
pub async fn refresh_registry_details(
    state: State<'_, AppState>,
    force: bool,
) -> AppResult<sync::EnrichSummary> {
    sync::enrich_only(&state.db.pool, force).await
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

#[tauri::command]
pub async fn add_ebay_listing(
    state: State<'_, AppState>,
    input: String,
) -> AppResult<sync::AddListingResult> {
    sync::add_listing_from_input(&state.db.pool, &input).await
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
) -> AppResult<sync::RefreshSummary> {
    sync::refresh_all_active(&state.db.pool).await
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
                l.saved_at, l.last_seen_at
         FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         ORDER BY l.status = 'active' DESC, l.last_seen_at DESC",
    )
    .fetch_all(&state.db.pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ListingRow {
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
    let pool = &state.db.pool;
    let rows: Vec<CollectionRowRaw> = sqlx::query_as(
        "SELECT c.id,
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
         JOIN drivers d ON d.id = re.driver_id
         WHERE d.id = ?
         ORDER BY re.year DESC, c.id DESC",
    )
    .bind(driver_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        // The collection's raw_json is the original list-page scrape; it
        // carries the thumbnail image_url and detail_url (which the registry
        // row doesn't, since enrichment overwrites raw_json with detail-page
        // facts). Fall back to the registry's scheme_text first since
        // detail-page text is authoritative; otherwise use the list-page
        // text we captured originally.
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
