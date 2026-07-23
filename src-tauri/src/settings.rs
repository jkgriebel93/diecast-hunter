use chrono::Utc;
use sqlx::SqlitePool;

use crate::error::AppResult;

const KEYRING_SERVICE: &str = "DiecastHunter";

pub const KEY_DCR_USERNAME: &str = "diecastregistry.username";
pub const KEY_EBAY_ENVIRONMENT: &str = "ebay.environment";
/// "true" / "false". When unset or "true", non-diecast eBay listings are
/// rejected at save time (see ebay::is_diecast).
pub const KEY_EBAY_FILTER_NON_DIECASTS: &str = "ebay.filter_non_diecasts";
/// US zip code sent to the Browse API as the buyer's location
/// (X-EBAY-C-ENDUSERCTX contextualLocation). Without a destination, eBay
/// omits shippingOptions entirely for calculated-shipping listings, leaving
/// shipping_cents NULL.
pub const KEY_EBAY_BUYER_ZIP: &str = "ebay.buyer_zip";

/// How registry searches are answered:
/// - "remote" (or unset): log in to diecastregistry.com and walk the
///   /Production result pages live.
/// - "hybrid": answer from pre-warmed local rows when they can fully cover
///   the query (all filtered drivers pre-warmed, no finish/autographed/raced
///   filter); otherwise fall back to the live search.
/// - "local": answer from pre-warmed local rows only; never hit the network.
pub const KEY_REGISTRY_SEARCH_MODE: &str = "registry.search_mode";

pub const ENTRY_DCR_PASSWORD: &str = "diecastregistry.password";
pub const ENTRY_EBAY_OAUTH: &str = "ebay.oauth_token";
pub const ENTRY_EBAY_APP_ID: &str = "ebay.app_id";
pub const ENTRY_EBAY_CERT_ID: &str = "ebay.cert_id";
pub const ENTRY_LISTING_RECEIVER_SECRET: &str = "listing_receiver.shared_secret";

pub const KEY_LISTING_RECEIVER_PORT: &str = "listing_receiver.port";
/// Default localhost port the embedded listing-receiver binds to. Picked at
/// random in the user-port range; configurable via settings if it conflicts.
pub const DEFAULT_LISTING_RECEIVER_PORT: u16 = 17381;

/// Periodic background sync (see `sync::auto_sync`). When enabled, a startup
/// task syncs My Garage (DCR) and eBay on the configured interval.
/// "true" / "false"; unset = disabled.
pub const KEY_AUTO_SYNC_ENABLED: &str = "auto_sync.enabled";
/// Minutes between background syncs. Unset = `DEFAULT_AUTO_SYNC_INTERVAL_MINUTES`.
pub const KEY_AUTO_SYNC_INTERVAL_MINUTES: &str = "auto_sync.interval_minutes";
/// Unix timestamp of the last background-sync attempt (success or failure).
/// The loop uses this to decide when the interval has elapsed.
pub const KEY_AUTO_SYNC_LAST_RUN: &str = "auto_sync.last_run";
pub const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES: u32 = 60;
/// Floor on the interval so a typo can't turn the background task into a
/// tight network loop against DCR / eBay.
pub const MIN_AUTO_SYNC_INTERVAL_MINUTES: u32 = 15;
/// Ceiling on the interval. `schtasks /SC MINUTE /MO` accepts at most 1439
/// (one minute short of a day); a longer cadence would need a DAILY schedule.
pub const MAX_AUTO_SYNC_INTERVAL_MINUTES: u32 = 1439;

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
