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
/// When the registry form-options cache (the attribute-detection
/// vocabulary) was last refreshed. The attribute backfill compares its
/// per-row `attrs_scanned_at` stamp against this (DCH-60).
pub const KEY_FORM_OPTIONS_REFRESHED: &str = "dcr.last_form_options_refresh";

/// Learned auto-match scoring model (JSON `LearnedModel`), written by
/// `matcher_training::retrain`. Absent → hand-tuned default weights.
pub const KEY_MATCH_MODEL: &str = "matcher.model";

/// COUNT(match_feedback) at the last training *attempt*, stored even when
/// the CV gate declined to activate a model. Without this, a declining
/// gate would make the startup auto-retrain re-run its (expensive)
/// training pass on every single launch.
pub const KEY_MATCH_TRAIN_ATTEMPT: &str = "matcher.last_train_attempt_rows";

/// Unix timestamp of the last training run (manual or automatic), stored
/// even when the run declined to activate a model. Shown on the Settings
/// page as "Last training run".
pub const KEY_MATCH_TRAIN_LAST_AT: &str = "matcher.last_train_at";

/// Keep the app (and its embedded listing receiver) running in the
/// background when the window is closed — the tray icon reopens it.
pub const KEY_RUN_IN_BACKGROUND: &str = "app.run_in_background";

pub const KEY_LISTING_RECEIVER_PORT: &str = "listing_receiver.port";
/// Default localhost port the embedded listing-receiver binds to. Picked at
/// random in the user-port range; configurable via settings if it conflicts.
pub const DEFAULT_LISTING_RECEIVER_PORT: u16 = 17381;

/// Base URL of the user's own Cloudflare Worker, used for wishlist sharing
/// (DCH-46) — e.g. `https://diecast-hunter-ebay.<name>.workers.dev`. Not a
/// secret, so it lives in the settings table; unset means sharing is off and
/// the UI says so rather than failing at click time.
pub const KEY_SHARE_WORKER_URL: &str = "share.worker_url";

pub const ENTRY_DCR_PASSWORD: &str = "diecastregistry.password";
pub const ENTRY_LISTING_RECEIVER_SECRET: &str = "listing_receiver.shared_secret";
/// The Worker's `APP_SHARED_SECRET`. Keyring, never SQLite — it authorizes
/// writing to and revoking from a public endpoint.
pub const ENTRY_SHARE_WORKER_SECRET: &str = "share.worker_secret";
pub const ENTRY_EBAY_OAUTH: &str = "ebay.oauth_token";
pub const ENTRY_EBAY_APP_ID: &str = "ebay.app_id";
pub const ENTRY_EBAY_CERT_ID: &str = "ebay.cert_id";

/// Periodic background sync (see `sync::auto_sync`). When enabled, a startup
/// task syncs My Garage (DCR) and eBay on the configured interval.
/// "true" / "false"; unset = disabled.
pub const KEY_AUTO_SYNC_ENABLED: &str = "auto_sync.enabled";
/// Hours between background syncs. Unset = `DEFAULT_AUTO_SYNC_INTERVAL_HOURS`.
/// (Replaces the old `auto_sync.interval_minutes` key — a stale row for that
/// key is simply ignored; the hourly cadence it encoded is what exhausted
/// the eBay daily quota in the first place.)
pub const KEY_AUTO_SYNC_INTERVAL_HOURS: &str = "auto_sync.interval_hours";
/// Unix timestamp of the last background-sync attempt (success or failure).
/// The loop uses this to decide when the interval has elapsed.
pub const KEY_AUTO_SYNC_LAST_RUN: &str = "auto_sync.last_run";
pub const DEFAULT_AUTO_SYNC_INTERVAL_HOURS: u32 = 12;
/// Cap on how many registry entries the background pre-warm refresh may
/// re-walk in one run (see `sync::registry_prewarm::refresh_stale_prewarms`).
/// The full registry is tens of thousands of entries, so an uncapped refresh
/// is a near-guaranteed mid-run failure — the backlog drains across runs
/// instead. "0" disables the refresh phase entirely. Unset = default.
pub const KEY_PREWARM_REFRESH_MAX_ENTRIES: &str = "auto_sync.prewarm_max_entries";
pub const DEFAULT_PREWARM_REFRESH_MAX_ENTRIES: u32 = 5000;
/// Cap on how many registry detail pages a non-forced enrichment pass may
/// fetch in one run (see `sync::dcr_registry`). Each fetch costs ~1.2 s at
/// the DCR rate floor, so the default keeps a nightly enrichment phase to
/// ~10 minutes; the backlog drains across runs, referenced entries first.
/// "0" disables non-forced enrichment entirely. A forced re-enrich ignores
/// the cap. Unset = default. DCH-53.
pub const KEY_ENRICH_MAX_ENTRIES: &str = "auto_sync.enrich_max_entries";
pub const DEFAULT_ENRICH_MAX_ENTRIES: u32 = 500;
/// Floor on the interval so a typo can't turn the background task into a
/// tight network loop against DCR / eBay.
pub const MIN_AUTO_SYNC_INTERVAL_HOURS: u32 = 1;
/// Ceiling on the interval. `schtasks /SC HOURLY /MO` accepts at most 23;
/// a longer cadence would need a DAILY schedule.
pub const MAX_AUTO_SYNC_INTERVAL_HOURS: u32 = 23;

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

// The keyring talks to the OS credential service synchronously — a slow or
// prompting service stalls whatever thread makes the call. Async contexts
// therefore go through these wrappers, which move the work onto the
// blocking pool (DCH-60) instead of parking an async runtime thread.

fn secret_set_blocking(entry_name: &str, value: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_name)?;
    entry.set_password(value)?;
    Ok(())
}

fn secret_get_blocking(entry_name: &str) -> AppResult<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_name)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn secret_delete_blocking(entry_name: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_name)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn join_err(e: tokio::task::JoinError) -> crate::error::AppError {
    crate::error::AppError::Config(format!("keyring task failed: {e}"))
}

pub async fn secret_set(entry_name: &str, value: &str) -> AppResult<()> {
    let name = entry_name.to_string();
    let value = value.to_string();
    tokio::task::spawn_blocking(move || secret_set_blocking(&name, &value))
        .await
        .map_err(join_err)?
}

pub async fn secret_get(entry_name: &str) -> AppResult<Option<String>> {
    let name = entry_name.to_string();
    tokio::task::spawn_blocking(move || secret_get_blocking(&name))
        .await
        .map_err(join_err)?
}

pub async fn secret_delete(entry_name: &str) -> AppResult<()> {
    let name = entry_name.to_string();
    tokio::task::spawn_blocking(move || secret_delete_blocking(&name))
        .await
        .map_err(join_err)?
}
