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
    sync::sync_dcr_collection(&state.db.pool).await
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
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub scale: Option<String>,
    pub make: Option<String>,
    pub scheme_text: Option<String>,
    pub image_url: Option<String>,
    pub detail_url: Option<String>,
    pub retail_value_cents: Option<i64>,
    pub wholesale_value_cents: Option<i64>,
    pub registry_int_id: Option<i64>,
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
    let rows: Vec<(
        i64,
        String,
        Option<i64>,
        Option<String>,
        Option<i32>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT c.id,
                c.external_id,
                d.id AS driver_id,
                d.name AS driver_name,
                re.year,
                re.oem,
                re.brand,
                re.scale,
                re.make,
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
    for (id, asset_guid, driver_id, driver_name, year, oem, brand, scale, make, raw_json) in rows {
        let json: serde_json::Value = raw_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Null);

        let retail_value_cents = json
            .get("retail_value_cents")
            .and_then(|v| v.as_i64());
        let wholesale_value_cents = json
            .get("wholesale_value_cents")
            .and_then(|v| v.as_i64());
        let scheme_text = json
            .get("scheme_text")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let image_url = json
            .get("image_url")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let detail_url = json
            .get("detail_url")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let registry_int_id = json.get("registry_int_id").and_then(|v| v.as_i64());

        out.push(CollectionRow {
            collection_id: id,
            asset_guid,
            driver_id,
            driver_name,
            year,
            oem,
            brand,
            scale,
            make,
            scheme_text,
            image_url,
            detail_url,
            retail_value_cents,
            wholesale_value_cents,
            registry_int_id,
        });
    }

    Ok(out)
}
