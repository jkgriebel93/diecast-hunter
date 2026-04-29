use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::error::AppResult;
use crate::settings;
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
