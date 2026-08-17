use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Built from `reqwest::Error` via `From`, but flattens the source chain
    /// at conversion time. reqwest's top-level message is generic ("error
    /// sending request"); the actionable detail is in `.source()`.
    #[error("network error: {0}")]
    Network(String),

    /// eBay answered 429 — the app-level daily API quota is exhausted.
    /// Long-running syncs abort on this instead of burning the remaining
    /// quota on calls that are guaranteed to fail.
    #[error("eBay rate limit reached: {0}")]
    RateLimited(String),

    #[error("login failed: {0}")]
    LoginFailed(String),

    /// A DCR request came back as the login page — the session cookie the
    /// request rode on is no longer valid. Distinct from `LoginFailed` (bad
    /// credentials): `DcrSession::with_client` reacts to this by invalidating
    /// the cached session and retrying the operation once on a fresh login.
    #[error("diecastregistry.com session expired")]
    SessionExpired,

    #[error("parse error: {0}")]
    Parse(String),

    #[error("not configured: {0}")]
    NotConfigured(String),

    #[error("operation cancelled")]
    Cancelled,

    #[error("config error: {0}")]
    Config(String),
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network(format_error_chain(&e))
    }
}

fn format_error_chain(top: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![top.to_string()];
    let mut src = top.source();
    while let Some(s) = src {
        let msg = s.to_string();
        if parts.last().is_none_or(|prev| prev != &msg) {
            parts.push(msg);
        }
        src = s.source();
    }
    parts.join(": ")
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
