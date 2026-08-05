//! App-wide cache of a logged-in `DcrClient`, so back-to-back registry
//! searches skip the login round trips instead of re-authenticating each
//! time. One session lives in `AppState` and is shared by reference.

use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use super::DcrClient;
use crate::error::{AppError, AppResult};
use crate::settings;

/// Conservative idle lifetime for a cached session. ASP.NET auth/session
/// cookies default to a ~20-minute sliding expiration; staying under that
/// makes reuse of an expired cookie unlikely (callers still carry a
/// re-login retry as a safety net).
const SESSION_IDLE_TTL: Duration = Duration::from_secs(15 * 60);

pub struct DcrSession {
    cached: Mutex<Option<Cached>>,
}

struct Cached {
    client: Arc<DcrClient>,
    last_used: Instant,
}

impl DcrSession {
    pub fn new() -> Self {
        Self {
            cached: Mutex::new(None),
        }
    }

    /// Returns a logged-in client, reusing the cached session when it was
    /// last used within the TTL. The bool is `true` when the client came
    /// from the cache — callers use it to decide whether a failure warrants
    /// `invalidate()` and one retry with a fresh login.
    ///
    /// The lock is held across the login so concurrent callers share one
    /// login attempt instead of racing.
    pub async fn get_or_login(&self, pool: &SqlitePool) -> AppResult<(Arc<DcrClient>, bool)> {
        let mut guard = self.cached.lock().await;
        if let Some(c) = guard.as_mut() {
            if c.last_used.elapsed() < SESSION_IDLE_TTL {
                c.last_used = Instant::now();
                return Ok((c.client.clone(), true));
            }
        }

        let username = settings::get(pool, settings::KEY_DCR_USERNAME)
            .await?
            .ok_or_else(|| {
                AppError::NotConfigured("diecastregistry.com username not set in Settings".into())
            })?;
        let password = settings::secret_get(settings::ENTRY_DCR_PASSWORD)?.ok_or_else(|| {
            AppError::NotConfigured("diecastregistry.com password not set in Settings".into())
        })?;
        let client = Arc::new(DcrClient::new()?);
        client.login(&username, &password).await?;
        *guard = Some(Cached {
            client: client.clone(),
            last_used: Instant::now(),
        });
        Ok((client, false))
    }

    /// Drop the cached session. Call after a request through a cached client
    /// fails (cookie likely expired) or when credentials change.
    pub async fn invalidate(&self) {
        *self.cached.lock().await = None;
    }
}
