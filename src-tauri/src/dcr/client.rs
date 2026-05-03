use std::error::Error as _;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE};
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode};
use scraper::{Html, Selector};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};

const BASE: &str = "https://www.diecastregistry.com";
/// Pose as a real Chrome on Windows. The site's WAF resets connections that
/// don't look like a browser at the TLS or HTTP layer.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Minimum gap between outbound requests to the same host. Bulk operations
/// (e.g. registry-detail enrichment) flow through this limiter.
const MIN_INTERVAL: Duration = Duration::from_millis(800);

/// Max retry attempts for transient errors (429 / 503 / connection reset).
const MAX_RETRIES: u32 = 3;

/// Cookie-aware HTTP client targeted at diecastregistry.com.
///
/// One client = one logged-in session. The cookie jar is owned by the inner
/// reqwest::Client, so all requests through a given DcrClient share state.
/// `next_send` enforces a minimum gap between requests; `get_html_with_retry`
/// adds exponential backoff on top.
pub struct DcrClient {
    http: Client,
    next_send: Mutex<Instant>,
}

impl DcrClient {
    pub fn new() -> AppResult<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static(
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            ),
        );
        headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));

        let http = Client::builder()
            .user_agent(USER_AGENT)
            .default_headers(headers)
            .cookie_store(true)
            .redirect(Policy::limited(10))
            .timeout(Duration::from_secs(30))
            .gzip(true)
            // ASP.NET MVC + IIS: stick to HTTP/1.1. ALPN h2 has triggered
            // mid-handshake resets against this host.
            .http1_only()
            .build()?;
        Ok(Self {
            http,
            next_send: Mutex::new(Instant::now()),
        })
    }

    /// Performs the ASP.NET MVC anti-forgery login dance:
    /// 1. GET /Account/Login → captures the cookie token + the hidden form token.
    /// 2. POST /Account/Login with both tokens and credentials.
    /// Verifies success by checking the final page isn't still the login form.
    pub async fn login(&self, email: &str, password: &str) -> AppResult<()> {
        let login_url = format!("{BASE}/Account/Login");

        self.wait_for_slot().await;
        let body = self.http.get(&login_url).send().await?.text().await?;

        let form_token = extract_form_token(&body).ok_or_else(|| {
            AppError::LoginFailed(
                "could not find anti-forgery token on login page".into(),
            )
        })?;

        let form = [
            ("__RequestVerificationToken", form_token.as_str()),
            ("Email", email),
            ("Password", password),
        ];

        self.wait_for_slot().await;
        let resp = self
            .http
            .post(&login_url)
            .header(reqwest::header::REFERER, &login_url)
            .form(&form)
            .send()
            .await?;

        let final_body = resp.text().await?;
        if looks_like_login_page(&final_body) {
            return Err(AppError::LoginFailed(
                "credentials rejected (still on login page)".into(),
            ));
        }
        Ok(())
    }

    /// Fetches a path and returns the response body, with rate limiting and
    /// retry-with-backoff for transient errors.
    pub async fn get_html(&self, path: &str) -> AppResult<String> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{BASE}{path}")
        };

        let mut backoff = Duration::from_millis(500);
        let mut last_err: Option<AppError> = None;

        for attempt in 0..=MAX_RETRIES {
            self.wait_for_slot().await;
            match self.http.get(&url).send().await {
                Ok(resp) => match resp.error_for_status() {
                    Ok(ok) => return Ok(ok.text().await?),
                    Err(e) => {
                        let status = e.status();
                        if attempt < MAX_RETRIES && is_retryable_status(status) {
                            tracing::warn!(
                                "retryable {}: {} for {} (attempt {}/{}) — sleeping {:?}",
                                status.map(|s| s.as_u16()).unwrap_or(0),
                                e,
                                url,
                                attempt + 1,
                                MAX_RETRIES,
                                backoff,
                            );
                            tokio::time::sleep(backoff).await;
                            backoff *= 2;
                            last_err = Some(e.into());
                            continue;
                        }
                        return Err(e.into());
                    }
                },
                Err(e) => {
                    if attempt < MAX_RETRIES && is_retryable_network_err(&e) {
                        tracing::warn!(
                            "retryable network error: {} for {} (attempt {}/{}) — sleeping {:?}",
                            e,
                            url,
                            attempt + 1,
                            MAX_RETRIES,
                            backoff,
                        );
                        tokio::time::sleep(backoff).await;
                        backoff *= 2;
                        last_err = Some(e.into());
                        continue;
                    }
                    return Err(e.into());
                }
            }
        }
        Err(last_err.unwrap_or_else(|| AppError::Network("retries exhausted".into())))
    }

    /// Block until enough time has passed since the last request, then mark
    /// the next earliest send time.
    async fn wait_for_slot(&self) {
        let mut next = self.next_send.lock().await;
        let now = Instant::now();
        if *next > now {
            let wait = *next - now;
            drop(next); // release before sleeping
            tokio::time::sleep(wait).await;
            let mut next = self.next_send.lock().await;
            *next = Instant::now() + MIN_INTERVAL;
        } else {
            *next = now + MIN_INTERVAL;
        }
    }
}

fn is_retryable_status(status: Option<StatusCode>) -> bool {
    matches!(
        status.map(|s| s.as_u16()),
        Some(429) | Some(502) | Some(503) | Some(504)
    )
}

fn is_retryable_network_err(e: &reqwest::Error) -> bool {
    if e.is_timeout() || e.is_connect() {
        return true;
    }
    // Walk the source chain looking for hyper's IncompleteMessage or io errors
    // like ConnectionReset that imply the server hung up mid-stream.
    let mut src: Option<&dyn std::error::Error> = e.source();
    while let Some(s) = src {
        let msg = s.to_string();
        if msg.contains("ConnectionReset")
            || msg.contains("forcibly closed")
            || msg.contains("connection closed")
            || msg.contains("IncompleteMessage")
        {
            return true;
        }
        src = s.source();
    }
    false
}

pub fn extract_form_token(html: &str) -> Option<String> {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(
        r#"input[name="__RequestVerificationToken"][type="hidden"]"#,
    )
    .ok()?;
    doc.select(&sel)
        .next()
        .and_then(|el| el.value().attr("value").map(str::to_owned))
}

fn looks_like_login_page(html: &str) -> bool {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(r#"form[action="/Account/Login"]"#).unwrap();
    doc.select(&sel).next().is_some()
}
