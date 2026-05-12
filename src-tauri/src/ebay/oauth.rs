//! eBay user OAuth (Authorization Code grant). For watchlist sync and any
//! other action that needs to act as a specific user. Distinct from the
//! Client Credentials flow in client.rs which only authenticates the app.

use std::error::Error as _;

use base64::Engine as _;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use url::Url;

use crate::ebay::client::EbayEnvironment;
use crate::error::{AppError, AppResult};
use crate::settings;

/// How close to expiry we consider a cached access token "stale" and
/// refresh proactively. 10 minutes gives long-running operations like
/// the watchlist sync (~95s for 475 items) plenty of headroom — we
/// don't want a token to expire mid-loop.
const TOKEN_REFRESH_BUFFER: i64 = 600;

/// Default scope set we request. The basic api_scope is enough for IAF token
/// use with the Trading API (GetMyeBayBuying for watchlist sync). Other
/// scopes (buy.item.feed, buy.order.readonly, etc.) require separate eBay
/// approvals and are added on demand if/when we use them.
pub const DEFAULT_SCOPES: &[&str] = &[
    "https://api.ebay.com/oauth/api_scope",
];

#[derive(Debug, Serialize, Clone)]
pub struct OauthStatus {
    pub connected: bool,
    pub environment: String,
    pub has_ru_name: bool,
    pub granted_scopes: Vec<String>,
    pub access_token_expires_at: Option<i64>,
}

/// Builds the URL the user should open in their browser to authorize the app.
pub fn authorize_url(
    env: EbayEnvironment,
    app_id: &str,
    ru_name: &str,
    scopes: &[&str],
    state: &str,
) -> AppResult<String> {
    let host = match env {
        EbayEnvironment::Sandbox => "https://auth.sandbox.ebay.com",
        EbayEnvironment::Production => "https://auth.ebay.com",
    };
    let mut url = Url::parse(&format!("{host}/oauth2/authorize"))
        .map_err(|e| AppError::Config(format!("invalid authorize URL: {e}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", app_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", ru_name)
        .append_pair("scope", &scopes.join(" "))
        .append_pair("state", state);
    Ok(url.into())
}

/// Exchange an authorization code for access + refresh tokens.
pub async fn exchange_code(
    pool: &SqlitePool,
    env: EbayEnvironment,
    app_id: &str,
    cert_id: &str,
    ru_name: &str,
    code: &str,
) -> AppResult<()> {
    let body = format!(
        "grant_type=authorization_code\
         &code={}\
         &redirect_uri={}",
        urlencode(code),
        urlencode(ru_name)
    );

    let token = post_token_endpoint(env, app_id, cert_id, &body).await?;

    persist_tokens(pool, env, &token).await?;
    Ok(())
}

/// Refresh the access token using the stored refresh token.
pub async fn refresh_access_token(
    pool: &SqlitePool,
    env: EbayEnvironment,
    app_id: &str,
    cert_id: &str,
    scopes: &[&str],
) -> AppResult<()> {
    let refresh_token = settings::secret_get(&settings::ebay_user_refresh_token_entry(
        env.as_str(),
    ))?
    .ok_or_else(|| AppError::NotConfigured("eBay account not connected".into()))?;

    let body = format!(
        "grant_type=refresh_token\
         &refresh_token={}\
         &scope={}",
        urlencode(&refresh_token),
        urlencode(&scopes.join(" "))
    );

    let token = post_token_endpoint(env, app_id, cert_id, &body).await?;

    // Refresh-token exchange usually omits the refresh_token field (the old
    // one stays valid). Preserve it.
    let now = Utc::now().timestamp();
    settings::set(
        pool,
        &settings::ebay_user_access_token_key(env.as_str()),
        &token.access_token,
    )
    .await?;
    settings::set(
        pool,
        &settings::ebay_user_access_token_expires_key(env.as_str()),
        &(now + token.expires_in).to_string(),
    )
    .await?;
    if let Some(rt) = token.refresh_token {
        // eBay may issue a new refresh token; update if so.
        settings::secret_set(
            &settings::ebay_user_refresh_token_entry(env.as_str()),
            &rt,
        )?;
    }
    Ok(())
}

/// Returns a valid user access token, refreshing it via the refresh token if
/// it's missing or close to expiry.
pub async fn get_user_access_token(
    pool: &SqlitePool,
    env: EbayEnvironment,
    app_id: &str,
    cert_id: &str,
    scopes: &[&str],
) -> AppResult<String> {
    let now = Utc::now().timestamp();
    let cached = settings::get(pool, &settings::ebay_user_access_token_key(env.as_str())).await?;
    let expires_at: Option<i64> = settings::get(
        pool,
        &settings::ebay_user_access_token_expires_key(env.as_str()),
    )
    .await?
    .and_then(|s| s.parse().ok());

    if let (Some(token), Some(exp)) = (cached, expires_at) {
        if exp - now > TOKEN_REFRESH_BUFFER {
            return Ok(token);
        }
    }

    refresh_access_token(pool, env, app_id, cert_id, scopes).await?;
    settings::get(pool, &settings::ebay_user_access_token_key(env.as_str()))
        .await?
        .ok_or_else(|| AppError::Config("user access token missing after refresh".into()))
}

/// Convenience: resolve the configured environment + app credentials and
/// return a refreshed user IAF token suitable for Trading API calls.
/// Centralizes the boilerplate used by every Trading-API entry point.
pub async fn user_iaf_token(pool: &SqlitePool) -> AppResult<(EbayEnvironment, String)> {
    let env_str = settings::get(pool, settings::KEY_EBAY_ENVIRONMENT)
        .await?
        .unwrap_or_else(|| "sandbox".to_string());
    let env = EbayEnvironment::from_str(&env_str);
    let app_id = settings::secret_get(settings::ENTRY_EBAY_APP_ID)?
        .ok_or_else(|| AppError::NotConfigured("eBay App ID not set".into()))?;
    let cert_id = settings::secret_get(settings::ENTRY_EBAY_CERT_ID)?
        .ok_or_else(|| AppError::NotConfigured("eBay Cert ID not set".into()))?;
    let token = get_user_access_token(pool, env, &app_id, &cert_id, DEFAULT_SCOPES).await?;
    Ok((env, token))
}

/// Drop the cached access token + expiry so the next `user_iaf_token`
/// call is forced to refresh. Used as the recovery action when eBay
/// returns "IAF token supplied is expired" — our local expiry guess
/// must have drifted from theirs (clock skew or a token revoked
/// upstream).
pub async fn invalidate_user_token_cache(
    pool: &SqlitePool,
    env: EbayEnvironment,
) -> AppResult<()> {
    settings::delete(pool, &settings::ebay_user_access_token_key(env.as_str())).await?;
    settings::delete(
        pool,
        &settings::ebay_user_access_token_expires_key(env.as_str()),
    )
    .await?;
    Ok(())
}

/// True for the family of Trading-API error messages that mean "your
/// IAF token is no longer valid" — the recovery is to invalidate the
/// cache and re-fetch.
pub fn is_iaf_token_expired_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("iaf token") && (lower.contains("expired") || lower.contains("invalid"))
}

pub async fn disconnect(pool: &SqlitePool, env: EbayEnvironment) -> AppResult<()> {
    settings::secret_delete(&settings::ebay_user_refresh_token_entry(env.as_str()))?;
    settings::delete(pool, &settings::ebay_user_access_token_key(env.as_str())).await?;
    settings::delete(
        pool,
        &settings::ebay_user_access_token_expires_key(env.as_str()),
    )
    .await?;
    settings::delete(pool, &settings::ebay_user_granted_scopes_key(env.as_str())).await?;
    Ok(())
}

pub async fn status(pool: &SqlitePool, env: EbayEnvironment) -> AppResult<OauthStatus> {
    let has_refresh =
        settings::secret_get(&settings::ebay_user_refresh_token_entry(env.as_str()))?
            .is_some();
    let has_ru_name = settings::get(pool, &settings::ebay_ru_name_key(env.as_str()))
        .await?
        .is_some();
    let granted = settings::get(pool, &settings::ebay_user_granted_scopes_key(env.as_str()))
        .await?
        .map(|s| {
            s.split_whitespace()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let expires_at: Option<i64> = settings::get(
        pool,
        &settings::ebay_user_access_token_expires_key(env.as_str()),
    )
    .await?
    .and_then(|s| s.parse().ok());

    Ok(OauthStatus {
        connected: has_refresh,
        environment: env.as_str().to_string(),
        has_ru_name,
        granted_scopes: granted,
        access_token_expires_at: expires_at,
    })
}

async fn post_token_endpoint(
    env: EbayEnvironment,
    app_id: &str,
    cert_id: &str,
    body: &str,
) -> AppResult<TokenResponse> {
    let url = format!("{}/identity/v1/oauth2/token", env.api_host());
    let basic = base64::engine::general_purpose::STANDARD
        .encode(format!("{app_id}:{cert_id}"));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .gzip(true)
        .http1_only()
        .build()
        .map_err(map_reqwest)?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Basic {basic}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body.to_string())
        .send()
        .await
        .map_err(map_reqwest)?;

    let status = resp.status();
    let text = resp.text().await.map_err(map_reqwest)?;
    if !status.is_success() {
        return Err(AppError::Network(format!(
            "ebay oauth token endpoint returned {status}: {text}"
        )));
    }
    serde_json::from_str(&text).map_err(|e| {
        AppError::Parse(format!("ebay token response unparseable: {e}: {text}"))
    })
}

async fn persist_tokens(
    pool: &SqlitePool,
    env: EbayEnvironment,
    token: &TokenResponse,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    settings::set(
        pool,
        &settings::ebay_user_access_token_key(env.as_str()),
        &token.access_token,
    )
    .await?;
    settings::set(
        pool,
        &settings::ebay_user_access_token_expires_key(env.as_str()),
        &(now + token.expires_in).to_string(),
    )
    .await?;
    if let Some(scope) = &token.scope {
        settings::set(
            pool,
            &settings::ebay_user_granted_scopes_key(env.as_str()),
            scope,
        )
        .await?;
    }
    if let Some(rt) = &token.refresh_token {
        settings::secret_set(
            &settings::ebay_user_refresh_token_entry(env.as_str()),
            rt,
        )?;
    } else {
        return Err(AppError::Parse(
            "eBay didn't return a refresh_token — nothing to persist for future use".into(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
    scope: Option<String>,
    #[allow(dead_code)]
    token_type: Option<String>,
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn map_reqwest(e: reqwest::Error) -> AppError {
    let mut parts = vec![e.to_string()];
    let mut src: Option<&dyn std::error::Error> = e.source();
    while let Some(s) = src {
        parts.push(s.to_string());
        src = s.source();
    }
    AppError::Network(parts.join(": "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_expired_iaf_token_errors() {
        assert!(is_iaf_token_expired_error(
            "trading api: IAF token supplied is expired."
        ));
        assert!(is_iaf_token_expired_error(
            "trading api GetMyeBayBuying returned 401: IAF Token is invalid"
        ));
        assert!(is_iaf_token_expired_error(
            "trading api: The IAF token has expired"
        ));
    }

    #[test]
    fn other_errors_not_token_expired() {
        assert!(!is_iaf_token_expired_error("network timed out"));
        assert!(!is_iaf_token_expired_error("trading api: rate limit exceeded"));
        assert!(!is_iaf_token_expired_error(
            "your watchlist is empty"
        ));
        // "expired" without "iaf token" — could be the listing, not the token.
        assert!(!is_iaf_token_expired_error("offer has expired"));
    }
}
