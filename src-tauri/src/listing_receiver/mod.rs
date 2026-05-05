//! Embedded HTTP server that the browser extension POSTs FB Marketplace
//! listings to. Binds to 127.0.0.1 only, gates writes with a bearer-token
//! shared secret stored in the OS keyring.
//!
//! The server runs for the life of the app; it's spawned from lib.rs::run
//! after the DB pool is ready. Auto-generates the shared secret on first
//! launch.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use sqlx::SqlitePool;
use tower_http::cors::{Any, CorsLayer};

use crate::error::{AppError, AppResult};
use crate::settings;
use crate::sync;

const HOST: [u8; 4] = [127, 0, 0, 1];

struct ServerState {
    pool: SqlitePool,
}

/// Resolve the configured port (defaults to DEFAULT_LISTING_RECEIVER_PORT).
pub async fn configured_port(pool: &SqlitePool) -> AppResult<u16> {
    if let Some(s) = settings::get(pool, settings::KEY_LISTING_RECEIVER_PORT).await? {
        if let Ok(p) = s.parse::<u16>() {
            return Ok(p);
        }
    }
    Ok(settings::DEFAULT_LISTING_RECEIVER_PORT)
}

/// Generate-on-first-use accessor. Returns the existing keyring entry if
/// present; otherwise generates a 32-hex-char secret, stores it, and
/// returns it.
pub fn ensure_secret() -> AppResult<String> {
    if let Some(s) = settings::secret_get(settings::ENTRY_LISTING_RECEIVER_SECRET)? {
        return Ok(s);
    }
    let secret: String = (0..32)
        .map(|_| format!("{:02x}", fastrand::u8(..)))
        .collect();
    settings::secret_set(settings::ENTRY_LISTING_RECEIVER_SECRET, &secret)?;
    Ok(secret)
}

pub fn regenerate_secret() -> AppResult<String> {
    let secret: String = (0..32)
        .map(|_| format!("{:02x}", fastrand::u8(..)))
        .collect();
    settings::secret_set(settings::ENTRY_LISTING_RECEIVER_SECRET, &secret)?;
    Ok(secret)
}

pub async fn run(pool: SqlitePool) -> AppResult<()> {
    let port = configured_port(&pool).await?;
    let _secret = ensure_secret()?;

    let state = Arc::new(ServerState { pool });

    let app = Router::new()
        .route("/health", get(health))
        .route("/listings/save", post(save_listing))
        .layer(
            // Permissive CORS — the bearer token gates everything that
            // matters. Browser extensions on Chrome/Firefox use unique
            // origins per install, so an exact-match origin allowlist would
            // be impractical.
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let addr = SocketAddr::from((HOST, port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| {
            AppError::Config(format!(
                "listing receiver couldn't bind {addr}: {e} \
                 (port in use? change listing_receiver.port in settings)"
            ))
        })?;
    tracing::info!("listing receiver listening on http://{addr}");
    axum::serve(listener, app)
        .await
        .map_err(|e| AppError::Config(format!("listing receiver crashed: {e}")))?;
    Ok(())
}

async fn health() -> &'static str {
    "ok"
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

async fn save_listing(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if let Err(resp) = check_auth(&headers) {
        return resp;
    }

    let payload: sync::FbListingPayload = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: format!("invalid JSON: {e}"),
                }),
            )
                .into_response();
        }
    };

    match sync::upsert_from_payload(&state.pool, &payload).await {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

fn check_auth(headers: &HeaderMap) -> Result<(), Response> {
    let secret = match settings::secret_get(settings::ENTRY_LISTING_RECEIVER_SECRET) {
        Ok(Some(s)) => s,
        _ => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorBody {
                    error: "receiver not configured".into(),
                }),
            )
                .into_response());
        }
    };

    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let expected = format!("Bearer {secret}");
    if !timing_safe_eq(auth, &expected) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                error: "unauthorized".into(),
            }),
        )
            .into_response());
    }
    Ok(())
}

fn timing_safe_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}
