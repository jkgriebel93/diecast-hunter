use chrono::Utc;
use sqlx::SqlitePool;

use crate::error::AppResult;

const KEYRING_SERVICE: &str = "DiecastHunter";

pub const KEY_DCR_USERNAME: &str = "diecastregistry.username";
pub const KEY_EBAY_ENVIRONMENT: &str = "ebay.environment";

pub const ENTRY_DCR_PASSWORD: &str = "diecastregistry.password";
pub const ENTRY_EBAY_OAUTH: &str = "ebay.oauth_token";
pub const ENTRY_EBAY_APP_ID: &str = "ebay.app_id";
pub const ENTRY_EBAY_CERT_ID: &str = "ebay.cert_id";

pub fn ebay_ru_name_key(env: &str) -> String {
    format!("ebay.{env}.ru_name")
}

pub fn ebay_user_access_token_key(env: &str) -> String {
    format!("ebay.{env}.user.access_token")
}

pub fn ebay_user_access_token_expires_key(env: &str) -> String {
    format!("ebay.{env}.user.access_token_expires_at")
}

pub fn ebay_user_granted_scopes_key(env: &str) -> String {
    format!("ebay.{env}.user.granted_scopes")
}

/// Refresh tokens are sensitive (longer-lived than access tokens) so they go
/// in the OS keyring rather than the SQLite settings KV.
pub fn ebay_user_refresh_token_entry(env: &str) -> String {
    format!("ebay.{env}.user.refresh_token")
}

pub async fn get(pool: &SqlitePool, key: &str) -> AppResult<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(v,)| v))
}

pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> AppResult<()> {
    let now = Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, key: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM settings WHERE key = ?")
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}

pub fn secret_set(entry_name: &str, value: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_name)?;
    entry.set_password(value)?;
    Ok(())
}

pub fn secret_get(entry_name: &str) -> AppResult<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_name)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn secret_delete(entry_name: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_name)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
