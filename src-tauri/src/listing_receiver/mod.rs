//! Embedded HTTP server backing the browser extension. Binds to 127.0.0.1
//! only; everything except /health is gated by a bearer-token shared
//! secret stored in the OS keyring.
//!
//! Routes:
//! - `GET  /health` — liveness probe, no auth; the content script uses it
//!   to show a quiet "app not running" state.
//! - `POST /match/preview` — non-persisting: run driver detection + the
//!   full match scorer (learned weights included) against the local
//!   registry cache for a title the app has never seen, returning the top
//!   candidate, confidence, reasons, entry valuation, and a deal score.
//! - `POST /listings/watch` — add the item to the eBay watchlist and save
//!   it locally via the same flow as the in-app Watch button.
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
use serde::{Deserialize, Serialize};
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
    regenerate_secret()
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
        .route("/match/preview", post(match_preview))
        .route("/listings/watch", post(watch_listing))
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
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
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

#[derive(Deserialize)]
struct PreviewRequest {
    title: String,
    /// Item URL (or bare id) — used only to check whether the listing is
    /// already saved locally.
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    price_cents: Option<i64>,
    #[serde(default)]
    shipping_cents: Option<i64>,
}

#[derive(Serialize)]
struct PreviewResponse {
    #[serde(flatten)]
    preview: sync::registry_auto_match::MatchPreview,
    /// Total cost as a percentage of the matched entry's retail value —
    /// same computation as the Listings page. Lower = better deal.
    deal_score: Option<f64>,
    /// Set when this eBay item is already saved locally.
    already_listing_id: Option<i64>,
}

async fn match_preview(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if let Err(resp) = check_auth(&headers) {
        return resp;
    }
    let req: PreviewRequest = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => return bad_request(format!("invalid JSON: {e}")),
    };

    let preview = match sync::registry_auto_match::preview_match(&state.pool, &req.title).await {
        Ok(p) => p,
        Err(e) => return internal_error(e),
    };

    let total = req.price_cents.map(|p| p + req.shipping_cents.unwrap_or(0));
    let retail = preview.entry.as_ref().and_then(|e| e.retail_value_cents);
    let deal_score = match (total, retail) {
        (Some(t), Some(r)) if r > 0 => Some(t as f64 / r as f64 * 100.0),
        _ => None,
    };

    let already_listing_id = match &req.url {
        Some(u) => find_saved_ebay_listing(&state.pool, u).await,
        None => None,
    };

    (
        StatusCode::OK,
        Json(PreviewResponse {
            preview,
            deal_score,
            already_listing_id,
        }),
    )
        .into_response()
}

#[derive(Deserialize)]
struct WatchRequest {
    /// eBay item URL or bare legacy item id.
    input: String,
}

async fn watch_listing(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if let Err(resp) = check_auth(&headers) {
        return resp;
    }
    let req: WatchRequest = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => return bad_request(format!("invalid JSON: {e}")),
    };
    match sync::watch_and_save(&state.pool, &req.input).await {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(e) => internal_error(e),
    }
}

/// Best-effort lookup: is this eBay item already saved locally? The stored
/// external_id is the v1 form ("v1|<legacy>|0" — or the group id for
/// multi-variation listings), so a LIKE on the legacy id covers both.
async fn find_saved_ebay_listing(pool: &SqlitePool, url_or_id: &str) -> Option<i64> {
    let legacy = crate::ebay::extract_legacy_item_id(url_or_id)?;
    sqlx::query_as::<_, (i64,)>(
        "SELECT l.id FROM listings l
         JOIN sellers s ON s.id = l.seller_id
         WHERE s.code = 'ebay' AND l.external_id LIKE ?",
    )
    .bind(format!("v1|{legacy}|%"))
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .map(|(id,)| id)
}

fn bad_request(msg: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(ErrorBody { error: msg })).into_response()
}

fn internal_error(e: AppError) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorBody {
            error: e.to_string(),
        }),
    )
        .into_response()
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
