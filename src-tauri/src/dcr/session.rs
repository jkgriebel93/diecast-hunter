//! App-wide cache of a logged-in `DcrClient`, so back-to-back registry
//! searches skip the login round trips instead of re-authenticating each
//! time. One session lives in `AppState` and is shared by reference.

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use super::DcrClient;
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
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

    /// Run `op` on a session client, retrying once on a fresh login when a
    /// *cached* session turns out to be dead (`AppError::SessionExpired`,
    /// raised by the DCR fetch paths when a page comes back as the login
    /// form). Any other error — and an expiry reported through a client that
    /// just logged in, which means something stranger than a stale cookie —
    /// passes through untouched.
    ///
    /// `op` must be safe to run twice from scratch; the flows using this
    /// detect expiry on their first fetch, before any writes.
    pub async fn with_client<T, F, Fut>(
        &self,
        pool: &SqlitePool,
        progress: &ProgressEmitter,
        op: F,
    ) -> AppResult<T>
    where
        F: Fn(Arc<DcrClient>) -> Fut,
        Fut: Future<Output = AppResult<T>>,
    {
        let (client, was_cached) = self.get_or_login(pool).await?;
        match op(client).await {
            Err(AppError::SessionExpired) if was_cached => {
                self.invalidate().await;
                progress.step(
                    "Session expired — logging in to diecastregistry.com again…",
                    None,
                    None,
                );
                let (client, _) = self.get_or_login(pool).await?;
                op(client).await
            }
            other => other,
        }
    }

    /// Test-only: pretend a login already happened so tests can exercise the
    /// cache and retry paths without credentials or network.
    #[cfg(test)]
    pub(crate) async fn seed_for_test(&self, client: Arc<DcrClient>) {
        *self.cached.lock().await = Some(Cached {
            client,
            last_used: Instant::now(),
        });
    }
}

#[cfg(test)]
mod tests {
    //! Exercises the cache/retry contract without network or keyring: the
    //! test pool has no DCR username stored, so any path that *would* log in
    //! fails with `NotConfigured` before ever touching the keyring — which
    //! makes "did it try to log in?" directly observable.
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU32, Ordering};

    async fn migrated_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open in-memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations");
        pool
    }

    fn test_client() -> Arc<DcrClient> {
        Arc::new(DcrClient::new().unwrap())
    }

    #[tokio::test]
    async fn cached_session_skips_login_entirely() {
        let pool = migrated_pool().await;
        let session = DcrSession::new();
        session.seed_for_test(test_client()).await;

        // No credentials exist, so this can only succeed by reusing the cache.
        let (_, was_cached) = session.get_or_login(&pool).await.unwrap();
        assert!(was_cached);

        session.invalidate().await;
        assert!(matches!(
            session.get_or_login(&pool).await,
            Err(AppError::NotConfigured(_))
        ));
    }

    #[tokio::test]
    async fn with_client_retries_on_expired_cached_session() {
        let pool = migrated_pool().await;
        let session = DcrSession::new();
        session.seed_for_test(test_client()).await;

        let calls = AtomicU32::new(0);
        let result: AppResult<()> = session
            .with_client(&pool, &ProgressEmitter::null("test"), |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(AppError::SessionExpired) }
            })
            .await;

        // The expiry invalidated the cache and a re-login was attempted —
        // which is exactly the NotConfigured failure, since no credentials
        // are stored. op ran once; the retry died before reaching it.
        assert!(matches!(result, Err(AppError::NotConfigured(_))));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn with_client_passes_other_errors_through_and_keeps_the_session() {
        let pool = migrated_pool().await;
        let session = DcrSession::new();
        session.seed_for_test(test_client()).await;

        let calls = AtomicU32::new(0);
        let result: AppResult<()> = session
            .with_client(&pool, &ProgressEmitter::null("test"), |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(AppError::Parse("bad html".into())) }
            })
            .await;

        assert!(matches!(result, Err(AppError::Parse(_))));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // A non-expiry error must not cost us the session.
        let (_, was_cached) = session.get_or_login(&pool).await.unwrap();
        assert!(was_cached);
    }

    #[tokio::test]
    async fn with_client_returns_the_op_result() {
        let pool = migrated_pool().await;
        let session = DcrSession::new();
        session.seed_for_test(test_client()).await;

        let result = session
            .with_client(&pool, &ProgressEmitter::null("test"), |_| async {
                Ok(42u32)
            })
            .await;
        assert_eq!(result.unwrap(), 42);
    }
}
