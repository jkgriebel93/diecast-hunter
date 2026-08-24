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
//! - `POST /match/confirm` — persist the previewed match as user-confirmed
//!   (watching/saving the listing first if it isn't local yet). Each
//!   confirm is a labeled positive example for the learned matcher.
//! - `POST /match/reject` — lock the listing as explicitly unmatched
//!   (same save-first behavior); a labeled negative example.
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
pub async fn ensure_secret() -> AppResult<String> {
    if let Some(s) = settings::secret_get(settings::ENTRY_LISTING_RECEIVER_SECRET).await? {
        return Ok(s);
    }
    regenerate_secret().await
}

pub async fn regenerate_secret() -> AppResult<String> {
    let secret: String = (0..32)
        .map(|_| format!("{:02x}", fastrand::u8(..)))
        .collect();
    settings::secret_set(settings::ENTRY_LISTING_RECEIVER_SECRET, &secret).await?;
    Ok(secret)
}

pub async fn run(pool: SqlitePool) -> AppResult<()> {
    let port = configured_port(&pool).await?;
    let _secret = ensure_secret().await?;

    let state = Arc::new(ServerState { pool });

    let app = Router::new()
        .route("/health", get(health))
        .route("/match/preview", post(match_preview))
        .route("/match/confirm", post(match_confirm))
        .route("/match/reject", post(match_reject))
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
    /// What comparable cars actually sold for, from the local archive of
    /// ended listings. None until enough sales have accumulated.
    comps: Option<crate::comps::CompSummary>,
    /// Total cost as a percentage of the comp median. Same shape as
    /// `deal_score`, measured against real sales instead of list value.
    comp_score: Option<f64>,
    /// Set when this eBay item is already saved locally.
    already_listing_id: Option<i64>,
    /// For an already-saved listing: the registry entry its match row
    /// points at (None also covers a confirmed "no match").
    already_matched_entry_id: Option<i64>,
    /// For an already-saved listing: whether its match row (or explicit
    /// no-match) is user-confirmed. The overlay uses this to show a
    /// "already confirmed" state instead of the confirm/reject buttons.
    already_user_confirmed: bool,
}

async fn match_preview(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if let Err(resp) = check_auth(&headers).await {
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
    let match_state = match already_listing_id {
        Some(id) => load_match_state(&state.pool, id).await,
        None => None,
    };

    // Comps for the previewed entry. `already_listing_id` is excluded so a
    // page the user is re-visiting after its listing ended isn't compared
    // against its own sale. A failure here degrades to "no comps" rather than
    // failing the whole overlay — the match verdict is the primary payload.
    let comps = match preview.entry.as_ref() {
        Some(entry) => comps_for_entry(&state.pool, entry.registry_entry_id, already_listing_id)
            .await
            .unwrap_or(None),
        None => None,
    };
    let comp_score = crate::comps::comp_score(total, comps.as_ref());

    (
        StatusCode::OK,
        Json(PreviewResponse {
            preview,
            deal_score,
            comps,
            comp_score,
            already_listing_id,
            already_matched_entry_id: match_state.and_then(|(e, _)| e),
            already_user_confirmed: match_state.is_some_and(|(_, c)| c),
        }),
    )
        .into_response()
}

/// Sold-price comps for one registry entry. Unlike the Listings page, which
/// scores hundreds of rows against one loaded index, the overlay scores
/// exactly one entry per request — but it reuses the same index type so both
/// surfaces apply identical tiering and thresholds.
async fn comps_for_entry(
    pool: &SqlitePool,
    entry_id: i64,
    exclude_listing_id: Option<i64>,
) -> AppResult<Option<crate::comps::CompSummary>> {
    let Some(target) = crate::comps::load_target(pool, entry_id).await? else {
        return Ok(None);
    };
    let index = crate::comps::CompIndex::load(pool, chrono::Utc::now().timestamp()).await?;
    Ok(index.summarize(&target, exclude_listing_id))
}

/// (registry_entry_id, user_confirmed) of a listing's match row, if any.
async fn load_match_state(pool: &SqlitePool, listing_id: i64) -> Option<(Option<i64>, bool)> {
    sqlx::query_as::<_, (Option<i64>, i64)>(
        "SELECT registry_entry_id, user_confirmed
         FROM listing_matches WHERE listing_id = ?",
    )
    .bind(listing_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .map(|(e, c)| (e, c != 0))
}

#[derive(Deserialize)]
struct ConfirmRequest {
    /// eBay item URL or bare legacy item id.
    input: String,
    /// Local registry entry id from the preview response.
    registry_entry_id: i64,
}

#[derive(Serialize)]
struct ConfirmResponse {
    listing_id: i64,
    registry_entry_id: i64,
    /// True when the listing wasn't saved locally yet and this request
    /// watched + saved it first.
    saved_now: bool,
}

async fn match_confirm(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if let Err(resp) = check_auth(&headers).await {
        return resp;
    }
    let req: ConfirmRequest = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => return bad_request(format!("invalid JSON: {e}")),
    };

    // The previewed entry always exists locally (preview scores the local
    // cache), but guard anyway — a stale overlay could reference a pruned
    // row.
    let entry_exists: Option<(i64,)> =
        match sqlx::query_as("SELECT id FROM registry_entries WHERE id = ?")
            .bind(req.registry_entry_id)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal_error(e.into()),
        };
    if entry_exists.is_none() {
        return bad_request(format!(
            "registry entry {} not found — refresh the page and try again",
            req.registry_entry_id
        ));
    }

    let (listing_id, saved_now) = match resolve_or_save_listing(&state.pool, &req.input).await {
        Ok(pair) => pair,
        Err(resp) => return resp,
    };

    if let Err(e) = sync::registry_link::link_listing_to_local_entry(
        &state.pool,
        listing_id,
        req.registry_entry_id,
        "extension_confirm",
    )
    .await
    {
        return internal_error(e);
    }

    (
        StatusCode::OK,
        Json(ConfirmResponse {
            listing_id,
            registry_entry_id: req.registry_entry_id,
            saved_now,
        }),
    )
        .into_response()
}

#[derive(Deserialize)]
struct RejectRequest {
    /// eBay item URL or bare legacy item id.
    input: String,
}

#[derive(Serialize)]
struct RejectResponse {
    listing_id: i64,
    saved_now: bool,
}

async fn match_reject(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if let Err(resp) = check_auth(&headers).await {
        return resp;
    }
    let req: RejectRequest = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => return bad_request(format!("invalid JSON: {e}")),
    };

    let (listing_id, saved_now) = match resolve_or_save_listing(&state.pool, &req.input).await {
        Ok(pair) => pair,
        Err(resp) => return resp,
    };

    if let Err(e) =
        sync::registry_link::mark_no_match(&state.pool, listing_id, "extension_reject").await
    {
        return internal_error(e);
    }

    (
        StatusCode::OK,
        Json(RejectResponse {
            listing_id,
            saved_now,
        }),
    )
        .into_response()
}

/// The listing a confirm/reject verdict lands on: the already-saved local
/// row when there is one, otherwise watch + save it first (same flow as
/// the Watch button — training verdicts need a listings row to attach to,
/// and a listing worth a verdict is worth tracking). Returns
/// (listing_id, saved_now) or a ready-to-return error response — notably
/// when the non-diecast filter rejects the save.
// The Err deliberately IS the HTTP response for the early-return path:
// built once per failed request, on a cold path, so the large-variant cost
// clippy worries about never occurs in a loop, and boxing it would add
// unwrapping noise at both call sites for no measurable win. Flagged by
// clippy 1.98, which extended this lint to async fns.
#[allow(clippy::result_large_err)]
async fn resolve_or_save_listing(pool: &SqlitePool, input: &str) -> Result<(i64, bool), Response> {
    if let Some(id) = find_saved_ebay_listing(pool, input).await {
        return Ok((id, false));
    }
    match sync::watch_and_save(pool, input).await {
        Ok(result) => match result.listing_id {
            Some(id) => Ok((id, true)),
            None => Err(bad_request(format!(
                "listing was filtered, not saved: {}",
                result
                    .filtered_reason
                    .unwrap_or_else(|| "unknown reason".into())
            ))),
        },
        Err(e) => Err(internal_error(e)),
    }
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
    if let Err(resp) = check_auth(&headers).await {
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

// The `Err` variant is an axum `Response`, which is large by nature. Boxing
// it to satisfy the lint would add an allocation to every unauthorized
// request and buy nothing — this is a local control-flow type, never stored
// or returned across a boundary.
#[allow(clippy::result_large_err)]
async fn check_auth(headers: &HeaderMap) -> Result<(), Response> {
    let secret = match settings::secret_get(settings::ENTRY_LISTING_RECEIVER_SECRET).await {
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
