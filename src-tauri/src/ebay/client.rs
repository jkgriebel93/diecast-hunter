use std::error::Error as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use chrono::Utc;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT};
use reqwest::Client;
use serde::Deserialize;
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::settings;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DiecastHunter/0.1 (eBay Client)";
const TOKEN_REFRESH_BUFFER: i64 = 60; // refresh if <60s remaining
const MIN_INTERVAL: Duration = Duration::from_millis(200); // 5 RPS

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EbayEnvironment {
    Sandbox,
    Production,
}

impl EbayEnvironment {
    pub fn from_str(s: &str) -> Self {
        match s {
            "production" | "prod" => EbayEnvironment::Production,
            _ => EbayEnvironment::Sandbox,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            EbayEnvironment::Sandbox => "sandbox",
            EbayEnvironment::Production => "production",
        }
    }
    pub fn api_host(self) -> &'static str {
        match self {
            EbayEnvironment::Sandbox => "https://api.sandbox.ebay.com",
            EbayEnvironment::Production => "https://api.ebay.com",
        }
    }
    fn token_setting_key(self) -> &'static str {
        match self {
            EbayEnvironment::Sandbox => "ebay.sandbox.access_token",
            EbayEnvironment::Production => "ebay.production.access_token",
        }
    }
    fn token_expiry_key(self) -> &'static str {
        match self {
            EbayEnvironment::Sandbox => "ebay.sandbox.access_token_expires_at",
            EbayEnvironment::Production => "ebay.production.access_token_expires_at",
        }
    }
}

/// Rate-limited eBay HTTP client. Tokens are cached in the settings KV so
/// they survive app restarts (they're short-lived — typically 2 hours — so
/// the security risk of disk-cached tokens is bounded).
#[derive(Clone)]
pub struct EbayClient {
    inner: Arc<EbayClientInner>,
}

struct EbayClientInner {
    http: Client,
    pool: SqlitePool,
    env: EbayEnvironment,
    app_id: String,
    cert_id: String,
    next_send: Mutex<Instant>,
}

impl EbayClient {
    pub async fn from_settings(pool: SqlitePool) -> AppResult<Self> {
        let env_str = settings::get(&pool, settings::KEY_EBAY_ENVIRONMENT)
            .await?
            .unwrap_or_else(|| "sandbox".to_string());
        let env = EbayEnvironment::from_str(&env_str);
        let app_id = settings::secret_get(settings::ENTRY_EBAY_APP_ID)?
            .ok_or_else(|| AppError::NotConfigured("eBay App ID not set in Settings".into()))?;
        let cert_id = settings::secret_get(settings::ENTRY_EBAY_CERT_ID)?
            .ok_or_else(|| AppError::NotConfigured("eBay Cert ID not set in Settings".into()))?;

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));

        let http = Client::builder()
            .user_agent(USER_AGENT)
            .default_headers(headers)
            .timeout(Duration::from_secs(30))
            .gzip(true)
            .http1_only()
            .build()?;

        Ok(Self {
            inner: Arc::new(EbayClientInner {
                http,
                pool,
                env,
                app_id,
                cert_id,
                next_send: Mutex::new(Instant::now()),
            }),
        })
    }

    pub fn environment(&self) -> EbayEnvironment {
        self.inner.env
    }

    /// Returns a valid access token, refreshing it if missing or close to
    /// expiry. Tokens are cached in the settings KV.
    pub async fn access_token(&self) -> AppResult<String> {
        let now = Utc::now().timestamp();
        let cached = settings::get(&self.inner.pool, self.inner.env.token_setting_key()).await?;
        let expires_at: Option<i64> =
            settings::get(&self.inner.pool, self.inner.env.token_expiry_key())
                .await?
                .and_then(|s| s.parse().ok());

        if let (Some(token), Some(exp)) = (cached, expires_at) {
            if exp - now > TOKEN_REFRESH_BUFFER {
                return Ok(token);
            }
        }

        self.fetch_and_cache_token().await
    }

    async fn fetch_and_cache_token(&self) -> AppResult<String> {
        self.wait_for_slot().await;

        let url = format!("{}/identity/v1/oauth2/token", self.inner.env.api_host());
        let basic = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", self.inner.app_id, self.inner.cert_id));

        let resp = self
            .inner
            .http
            .post(&url)
            .header("Authorization", format!("Basic {basic}"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(
                "grant_type=client_credentials\
                &scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
            )
            .send()
            .await
            .map_err(map_reqwest_err)?;

        let status = resp.status();
        let body = resp.text().await.map_err(map_reqwest_err)?;

        if !status.is_success() {
            return Err(AppError::Network(format!(
                "ebay oauth token request failed ({status}): {body}"
            )));
        }

        let token: TokenResponse = serde_json::from_str(&body).map_err(|e| {
            AppError::Parse(format!("ebay token response unparseable: {e}: {body}"))
        })?;

        let expires_at = Utc::now().timestamp() + token.expires_in;
        settings::set(
            &self.inner.pool,
            self.inner.env.token_setting_key(),
            &token.access_token,
        )
        .await?;
        settings::set(
            &self.inner.pool,
            self.inner.env.token_expiry_key(),
            &expires_at.to_string(),
        )
        .await?;

        Ok(token.access_token)
    }

    /// Bearer-authed GET against the eBay API. Returns the response body as a
    /// string for the caller to parse (Browse API responses are JSON).
    pub async fn get(&self, path: &str) -> AppResult<String> {
        let token = self.access_token().await?;
        let url = format!("{}{}", self.inner.env.api_host(), path);

        // Buyer location for shipping quotes. Listings with calculated
        // (destination-based) shipping come back with NO shippingOptions at
        // all unless eBay knows where the buyer is; the zip makes those
        // quotes possible. set_ebay_buyer_zip sanitizes to alphanumerics, so
        // the value is header- and URL-safe. Inner `=` and `,` are
        // percent-encoded per the X-EBAY-C-ENDUSERCTX format.
        let zip = settings::get(&self.inner.pool, settings::KEY_EBAY_BUYER_ZIP)
            .await?
            .filter(|z| !z.trim().is_empty());
        let enduserctx = match zip {
            Some(z) => format!("contextualLocation=country%3DUS%2Czip%3D{}", z.trim()),
            None => "contextualLocation=country%3DUS".to_string(),
        };

        self.wait_for_slot().await;

        let resp = self
            .inner
            .http
            .get(&url)
            .bearer_auth(&token)
            .header("X-EBAY-C-MARKETPLACE-ID", "EBAY_US")
            .header("X-EBAY-C-ENDUSERCTX", enduserctx)
            .send()
            .await
            .map_err(map_reqwest_err)?;

        let status = resp.status();
        let body = resp.text().await.map_err(map_reqwest_err)?;

        if !status.is_success() {
            // 429 = the keyset's daily quota is gone; every further call will
            // fail until eBay resets it. Surface a dedicated variant so sync
            // loops can stop instead of hammering the API.
            if status.as_u16() == 429 {
                return Err(AppError::RateLimited(format!(
                    "eBay's daily API quota is used up (HTTP 429 from {url}). \
                     Syncing will work again after the quota resets."
                )));
            }
            // Treat 401 specially: invalidate cache so the next call refreshes.
            if status.as_u16() == 401 {
                let _ =
                    settings::delete(&self.inner.pool, self.inner.env.token_setting_key()).await;
                let _ = settings::delete(&self.inner.pool, self.inner.env.token_expiry_key()).await;
            }
            return Err(AppError::Network(format!(
                "ebay api {url} returned {status}: {body}"
            )));
        }

        Ok(body)
    }

    async fn wait_for_slot(&self) {
        let mut next = self.inner.next_send.lock().await;
        let now = Instant::now();
        if *next > now {
            let wait = *next - now;
            drop(next);
            tokio::time::sleep(wait).await;
            let mut next = self.inner.next_send.lock().await;
            *next = Instant::now() + MIN_INTERVAL;
        } else {
            *next = now + MIN_INTERVAL;
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    #[allow(dead_code)]
    token_type: String,
}

fn map_reqwest_err(e: reqwest::Error) -> AppError {
    let mut parts = vec![e.to_string()];
    let mut src: Option<&dyn std::error::Error> = e.source();
    while let Some(s) = src {
        parts.push(s.to_string());
        src = s.source();
    }
    AppError::Network(parts.join(": "))
}
