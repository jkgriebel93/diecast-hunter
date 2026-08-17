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

/// Minimum gap between read (GET) request starts. Lowered from the original
/// 800 ms shared floor (DCH-61) after a conscious politeness call: reads are
/// what page walks and enrichment are made of, and the serial 800 ms floor —
/// not network latency — dominated every multi-page operation. This is THE
/// knob to turn back up if DCR ever objects.
const READ_INTERVAL: Duration = Duration::from_millis(300);

/// Minimum gap around mutating requests (login, UpdateFilter, register,
/// delete). Kept at the original conservative 800 ms deliberately — these
/// change server state and there are few of them, so they gain nothing
/// from speed and everything from caution.
const MUTATION_INTERVAL: Duration = Duration::from_millis(800);

/// Most page fetches a walk may have in flight at once — see
/// [`walk_pages_buffered`]. Bounded and small on purpose: pacing stays
/// explicit, never "as fast as the pool allows".
pub(crate) const WALK_CONCURRENCY: usize = 3;

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
    /// The /Production page's anti-forgery form token, captured the first
    /// time a search scrapes it. ASP.NET validates a form token against the
    /// cookie half living in this client's jar and accepts the same pair for
    /// the session's lifetime, so reusing it saves the extra GET /Production
    /// that existed only to read the token (DCH-57). Dies with the client.
    production_token: std::sync::Mutex<Option<String>>,
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
            production_token: std::sync::Mutex::new(None),
        })
    }

    pub(crate) fn cached_production_token(&self) -> Option<String> {
        self.production_token.lock().unwrap().clone()
    }

    pub(crate) fn cache_production_token(&self, token: String) {
        *self.production_token.lock().unwrap() = Some(token);
    }

    pub(crate) fn clear_production_token(&self) {
        *self.production_token.lock().unwrap() = None;
    }

    /// Performs the ASP.NET MVC anti-forgery login dance:
    /// 1. GET /Account/Login → captures the cookie token + the hidden form token.
    /// 2. POST /Account/Login with both tokens and credentials.
    ///
    /// Verifies success by checking the final page isn't still the login form.
    pub async fn login(&self, email: &str, password: &str) -> AppResult<()> {
        let login_url = format!("{BASE}/Account/Login");

        self.wait_for_slot(MUTATION_INTERVAL).await;
        let body = self.http.get(&login_url).send().await?.text().await?;

        let form_token = extract_form_token(&body).ok_or_else(|| {
            AppError::LoginFailed("could not find anti-forgery token on login page".into())
        })?;

        let form = [
            ("__RequestVerificationToken", form_token.as_str()),
            ("Email", email),
            ("Password", password),
        ];

        self.wait_for_slot(MUTATION_INTERVAL).await;
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
        self.get_html_inner(path, false).await
    }

    /// Like `get_html`, but marks the request as an XHR call by setting the
    /// `X-Requested-With` header and an Accept header that matches what
    /// jQuery sends. DCR's MVC controllers gate certain partial-view actions
    /// (e.g. `/MyGarage/RegisterDiecast/{id}`) on `Request.IsAjaxRequest()` —
    /// they return the modal HTML for AJAX callers and 404 everyone else.
    pub async fn get_html_xhr(&self, path: &str) -> AppResult<String> {
        self.get_html_inner(path, true).await
    }

    async fn get_html_inner(&self, path: &str, xhr: bool) -> AppResult<String> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{BASE}{path}")
        };

        let mut backoff = Duration::from_millis(500);
        let mut last_err: Option<AppError> = None;

        for attempt in 0..=MAX_RETRIES {
            self.wait_for_slot(READ_INTERVAL).await;
            tracing::debug!("GET {url} (attempt {}, xhr={xhr})", attempt + 1);
            let mut req = self.http.get(&url);
            if xhr {
                req = req
                    .header("X-Requested-With", "XMLHttpRequest")
                    .header(reqwest::header::ACCEPT, "text/html, */*; q=0.01");
            }
            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let final_url = resp.url().clone();
                    let set_cookies: Vec<String> = resp
                        .headers()
                        .get_all(reqwest::header::SET_COOKIE)
                        .iter()
                        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
                        .collect();
                    if status.is_success() {
                        let body = resp.text().await?;
                        tracing::debug!(
                            "GET {url} → {status} (final: {final_url}); {} bytes; set_cookies={:?}",
                            body.len(),
                            cookie_names(&set_cookies)
                        );
                        return Ok(body);
                    }
                    let body = resp.text().await.unwrap_or_default();
                    let body_excerpt = excerpt(&body, 300);
                    tracing::warn!(
                        "GET {url} → {status} (final: {final_url}); body[0..300]: {body_excerpt}"
                    );
                    if attempt < MAX_RETRIES && is_retryable_status(Some(status)) {
                        tokio::time::sleep(backoff).await;
                        backoff *= 2;
                        last_err =
                            Some(AppError::Network(format!("HTTP {status} for {final_url}")));
                        continue;
                    }
                    return Err(AppError::Network(format!(
                        "HTTP {status} for {final_url}; body: {body_excerpt}"
                    )));
                }
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

    /// POST a path with a form-encoded body. Same rate limiter and retry
    /// behavior as get_html. Adds XHR-style headers (X-Requested-With +
    /// Accept: application/json) — diecastregistry.com's MVC controllers
    /// switch between rendering full pages vs returning JSON envelopes
    /// based on these headers, and the filter-update endpoints we use 404
    /// without them.
    pub async fn post_form(&self, path: &str, form: &[(String, String)]) -> AppResult<String> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{BASE}{path}")
        };

        // Match the Referer the page submitting the form would have set.
        // For our two callers (login and production-search) this is the
        // same-host page they came from; falling back to BASE is harmless.
        let referer = if path.starts_with('/') {
            format!("{BASE}{}", path.trim_end_matches("/UpdateFilter"))
        } else {
            BASE.to_string()
        };

        let mut backoff = Duration::from_millis(500);
        let mut last_err: Option<AppError> = None;
        for attempt in 0..=MAX_RETRIES {
            self.wait_for_slot(MUTATION_INTERVAL).await;
            let field_summary: Vec<String> = form
                .iter()
                .map(|(k, v)| {
                    if k == "__RequestVerificationToken" {
                        format!("{k}=<{} chars>", v.len())
                    } else {
                        format!("{k}={}", excerpt(v, 60))
                    }
                })
                .collect();
            tracing::debug!(
                "POST {url} (attempt {}); referer={referer}; fields=[{}]",
                attempt + 1,
                field_summary.join(", ")
            );
            let mut req = self
                .http
                .post(&url)
                .header(reqwest::header::REFERER, &referer)
                .header(reqwest::header::ORIGIN, BASE)
                .header("X-Requested-With", "XMLHttpRequest")
                .header(
                    reqwest::header::ACCEPT,
                    "application/json, text/javascript, */*; q=0.01",
                )
                .header("Sec-Fetch-Site", "same-origin")
                .header("Sec-Fetch-Mode", "cors")
                .header("Sec-Fetch-Dest", "empty")
                .form(form);
            if form.is_empty() {
                // IIS answers 411 Length Required when a bodyless POST omits
                // Content-Length (e.g. /MyGarage/{id}/Delete). jQuery always
                // sends Content-Length: 0 here; match it.
                req = req.header(reqwest::header::CONTENT_LENGTH, "0");
            }
            let resp = req.send().await;
            match resp {
                Ok(resp) => {
                    let status = resp.status();
                    let final_url = resp.url().clone();
                    let set_cookies: Vec<String> = resp
                        .headers()
                        .get_all(reqwest::header::SET_COOKIE)
                        .iter()
                        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
                        .collect();
                    if status.is_success() {
                        let body = resp.text().await?;
                        tracing::debug!(
                            "POST {url} → {status} (final: {final_url}); {} bytes; set_cookies={:?}; body[0..300]: {}",
                            body.len(),
                            cookie_names(&set_cookies),
                            excerpt(&body, 300)
                        );
                        return Ok(body);
                    }
                    let body = resp.text().await.unwrap_or_default();
                    let body_excerpt = excerpt(&body, 300);
                    tracing::warn!(
                        "POST {url} → {status} (final: {final_url}); set_cookies={:?}; body[0..300]: {body_excerpt}",
                        cookie_names(&set_cookies)
                    );
                    if attempt < MAX_RETRIES && is_retryable_status(Some(status)) {
                        tokio::time::sleep(backoff).await;
                        backoff *= 2;
                        last_err =
                            Some(AppError::Network(format!("HTTP {status} for {final_url}")));
                        continue;
                    }
                    return Err(AppError::Network(format!(
                        "HTTP {status} for {final_url}; body: {body_excerpt}"
                    )));
                }
                Err(e) => {
                    if attempt < MAX_RETRIES && is_retryable_network_err(&e) {
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

    /// Block until enough time has passed since the last request start,
    /// then reserve the next slot `interval` later. One shared gate paces
    /// reads and mutations together (a mutation still can't fire mid-burst);
    /// only the spacing each kind reserves differs (DCH-61).
    async fn wait_for_slot(&self, interval: Duration) {
        let mut next = self.next_send.lock().await;
        let now = Instant::now();
        if *next > now {
            let wait = *next - now;
            drop(next); // release before sleeping
            tokio::time::sleep(wait).await;
            let mut next = self.next_send.lock().await;
            *next = Instant::now() + interval;
        } else {
            *next = now + interval;
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
    let sel = Selector::parse(r#"input[name="__RequestVerificationToken"][type="hidden"]"#).ok()?;
    doc.select(&sel)
        .next()
        .and_then(|el| el.value().attr("value").map(str::to_owned))
}

/// True when `html` is (or contains) the /Account/Login form — what an
/// auth-gated page looks like after the redirect a dead session cookie
/// triggers. Flows running on a cached session use this to tell "expired
/// session" apart from "page with genuinely nothing on it".
pub(crate) fn looks_like_login_page(html: &str) -> bool {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(r#"form[action="/Account/Login"]"#).unwrap();
    doc.select(&sel).next().is_some()
}

/// Compact first-N-chars excerpt with internal whitespace collapsed. Used in
/// log lines so a single response doesn't blow up the log with HTML indents.
fn excerpt(s: &str, n: usize) -> String {
    s.chars()
        .take(n)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Pulls just the cookie names from raw Set-Cookie header values. We don't
/// want to log values — those include session secrets — but the names tell
/// us whether the server refreshed the anti-forgery / auth cookies on this
/// request.
fn cookie_names(set_cookies: &[String]) -> Vec<String> {
    set_cookies
        .iter()
        .filter_map(|c| c.split('=').next().map(|n| n.trim().to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_page_is_detected_and_real_pages_are_not() {
        let login = r#"<html><body>
            <form action="/Account/Login" method="post">
              <input name="__RequestVerificationToken" type="hidden" value="tok">
              <input name="Email"><input name="Password">
            </form></body></html>"#;
        assert!(looks_like_login_page(login));

        let results_page = include_str!("../../fixtures/dcr/production_search_one_result.html");
        assert!(!looks_like_login_page(results_page));
        let garage_page = include_str!("../../fixtures/dcr/mygarage_two_items.html");
        assert!(!looks_like_login_page(garage_page));
    }

    #[test]
    fn production_token_round_trips() {
        let client = DcrClient::new().unwrap();
        assert_eq!(client.cached_production_token(), None);
        client.cache_production_token("abc123".into());
        assert_eq!(client.cached_production_token(), Some("abc123".into()));
        client.clear_production_token();
        assert_eq!(client.cached_production_token(), None);
    }
}
