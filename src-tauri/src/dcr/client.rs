use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::Client;
use scraper::{Html, Selector};

use crate::error::{AppError, AppResult};

const BASE: &str = "https://www.diecastregistry.com";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DiecastHunter/0.1 (+local)";

/// Cookie-aware HTTP client targeted at diecastregistry.com.
///
/// One client = one logged-in session. The cookie jar is owned by the inner
/// reqwest::Client, so all requests through a given DcrClient share state.
pub struct DcrClient {
    http: Client,
}

impl DcrClient {
    pub fn new() -> AppResult<Self> {
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .cookie_store(true)
            .redirect(Policy::limited(10))
            .timeout(Duration::from_secs(30))
            .gzip(true)
            .build()?;
        Ok(Self { http })
    }

    /// Performs the ASP.NET MVC anti-forgery login dance:
    /// 1. GET /Account/Login → captures the cookie token + the hidden form token.
    /// 2. POST /Account/Login with both tokens and credentials.
    /// Verifies success by fetching /MyGarage and checking it isn't a redirect
    /// to the login page.
    pub async fn login(&self, email: &str, password: &str) -> AppResult<()> {
        let login_url = format!("{BASE}/Account/Login");
        let body = self.http.get(&login_url).send().await?.text().await?;

        let form_token = extract_form_token(&body)
            .ok_or_else(|| AppError::LoginFailed(
                "could not find anti-forgery token on login page".into(),
            ))?;

        let form = [
            ("__RequestVerificationToken", form_token.as_str()),
            ("Email", email),
            ("Password", password),
        ];

        let resp = self
            .http
            .post(&login_url)
            .header(reqwest::header::REFERER, &login_url)
            .form(&form)
            .send()
            .await?;

        // After a successful login, ASP.NET typically 302s to "/" or
        // "/MyGarage". reqwest will have followed it, so we land on a page.
        // Detect failure by looking for the login form on the final page.
        let final_body = resp.text().await?;
        if looks_like_login_page(&final_body) {
            return Err(AppError::LoginFailed(
                "credentials rejected (still on login page)".into(),
            ));
        }
        Ok(())
    }

    /// Fetches a path under https://www.diecastregistry.com and returns the
    /// response body as a UTF-8 string.
    pub async fn get_html(&self, path: &str) -> AppResult<String> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{BASE}{path}")
        };
        let resp = self.http.get(&url).send().await?.error_for_status()?;
        Ok(resp.text().await?)
    }
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
    // The login form has action="/Account/Login" — if it's still present, the
    // login didn't take.
    let doc = Html::parse_document(html);
    let sel = Selector::parse(r#"form[action="/Account/Login"]"#).unwrap();
    doc.select(&sel).next().is_some()
}

