//! Public-link wishlist sharing (DCH-46).
//!
//! Renders a wishlist to the same self-contained HTML the file export
//! produces, uploads it to the user's own Cloudflare Worker, and keeps the
//! resulting slug on the `wishlists` row so the UI can offer copy-link and
//! revoke instead of minting a new URL every time.
//!
//! Two things this module is deliberately strict about:
//!
//! 1. **A share is public.** The link is the only credential, so anything
//!    the user would not paste into a group chat is stripped before upload —
//!    see `WishlistRenderOptions::PUBLIC`. The toggle that restores it is in
//!    the share dialog, next to the words describing what it does.
//! 2. **Configuration is checked before any work happens.** Rendering a big
//!    wishlist means downloading and embedding every image; discovering
//!    afterwards that no Worker URL is set would waste a minute and tell the
//!    user nothing useful.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};
use crate::export::{self, ListingRenderOptions, WishlistRenderOptions};
use crate::progress::ProgressEmitter;
use crate::settings;

const USER_AGENT: &str = concat!("DiecastHunter/", env!("CARGO_PKG_VERSION"));
/// Long enough for a multi-megabyte document on a slow uplink; short enough
/// that a wedged endpoint doesn't hang the dialog indefinitely.
const UPLOAD_TIMEOUT_SECS: u64 = 120;

/// The share state of one wishlist, as the UI needs it.
#[derive(Debug, Clone, Serialize)]
pub struct ShareStatus {
    pub wishlist_id: i64,
    /// None when this list has never been shared, or the share was revoked.
    pub slug: Option<String>,
    pub url: Option<String>,
    pub shared_at: Option<i64>,
    pub expires_at: Option<i64>,
    /// True when the app is configured to share at all. The dialog uses this
    /// to explain what's missing rather than offering a button that fails.
    pub configured: bool,
}

/// The four share columns on `wishlists`. A row struct rather than a tuple:
/// four nested Options is exactly the shape clippy's `type_complexity`
/// exists to catch, and the field names are the documentation.
#[derive(sqlx::FromRow)]
struct ShareRow {
    share_slug: Option<String>,
    share_url: Option<String>,
    shared_at: Option<i64>,
    share_expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ShareResponse {
    slug: String,
    url: String,
    expires_at: i64,
}

/// Worker base URL plus the bearer secret, or a message naming what's
/// missing. Both are required; half-configured is not a usable state.
async fn share_config(pool: &SqlitePool) -> AppResult<Option<(String, String)>> {
    let url = settings::get(pool, settings::KEY_SHARE_WORKER_URL).await?;
    let secret = settings::secret_get(settings::ENTRY_SHARE_WORKER_SECRET)?;
    match (url, secret) {
        (Some(u), Some(s)) if !u.trim().is_empty() && !s.trim().is_empty() => {
            Ok(Some((u.trim().trim_end_matches('/').to_string(), s)))
        }
        _ => Ok(None),
    }
}

pub async fn status(pool: &SqlitePool, wishlist_id: i64) -> AppResult<ShareStatus> {
    let row: Option<ShareRow> = sqlx::query_as(
        "SELECT share_slug, share_url, shared_at, share_expires_at
             FROM wishlists WHERE id = ?",
    )
    .bind(wishlist_id)
    .fetch_optional(pool)
    .await?;
    let row = row.ok_or_else(|| AppError::Config("wishlist no longer exists".into()))?;
    Ok(ShareStatus {
        wishlist_id,
        slug: row.share_slug,
        url: row.share_url,
        shared_at: row.shared_at,
        expires_at: row.share_expires_at,
        configured: share_config(pool).await?.is_some(),
    })
}

/// Render the list and upload it, replacing any previous share.
///
/// The old share is revoked *after* the new one is stored: if the upload
/// fails, the user is left with the link they already gave out rather than
/// with nothing. A revoke that fails is logged, not raised — the new link is
/// live and reporting an error would imply it isn't.
pub async fn share(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
    wishlist_id: i64,
    options: WishlistRenderOptions,
    ttl_days: u32,
) -> AppResult<ShareStatus> {
    let Some((base, secret)) = share_config(pool).await? else {
        return Err(AppError::Config(
            "sharing isn't set up — add your Worker URL and shared secret in \
             Settings → Accounts before sharing a wishlist"
                .into(),
        ));
    };

    let (name,): (String,) = sqlx::query_as("SELECT name FROM wishlists WHERE id = ?")
        .bind(wishlist_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::Config("wishlist no longer exists".into()))?;

    let entries = crate::wishlist::list(pool, wishlist_id).await?;
    if entries.is_empty() {
        return Err(AppError::Config(
            "there's nothing on this wishlist to share yet".into(),
        ));
    }

    let rendered = export::render_wishlist(progress, &name, &entries, options).await?;

    progress.step("Uploading…", None, None);
    let client = share_client()?;
    let body = upload_html(&client, &base, &secret, rendered.html, ttl_days).await?;

    let previous: Option<(Option<String>,)> =
        sqlx::query_as("SELECT share_slug FROM wishlists WHERE id = ?")
            .bind(wishlist_id)
            .fetch_optional(pool)
            .await?;
    let previous_slug = previous.and_then(|(s,)| s);

    sqlx::query(
        "UPDATE wishlists
         SET share_slug = ?, share_url = ?, shared_at = ?, share_expires_at = ?
         WHERE id = ?",
    )
    .bind(&body.slug)
    .bind(&body.url)
    .bind(chrono::Utc::now().timestamp())
    .bind(body.expires_at)
    .bind(wishlist_id)
    .execute(pool)
    .await?;

    if let Some(old) = previous_slug {
        if old != body.slug {
            if let Err(e) = delete_remote(&client, &base, &secret, &old).await {
                // The new link works; the old one expires on its own TTL.
                tracing::warn!("share: revoking superseded slug {old} failed: {e}");
            }
        }
    }

    progress.done(format!("Shared \"{name}\"."));
    status(pool, wishlist_id).await
}

/// Take the link out of circulation. Clears the local row even when the
/// remote delete fails, so the UI can't get stuck showing a link the user
/// has already asked to retire — the Worker treats an unknown slug as gone
/// anyway, and the KV TTL is the backstop.
pub async fn revoke(pool: &SqlitePool, wishlist_id: i64) -> AppResult<ShareStatus> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT share_slug FROM wishlists WHERE id = ?")
            .bind(wishlist_id)
            .fetch_optional(pool)
            .await?;
    let slug = row
        .ok_or_else(|| AppError::Config("wishlist no longer exists".into()))?
        .0;

    let mut remote_error: Option<String> = None;
    if let (Some(slug), Some((base, secret))) = (slug.as_deref(), share_config(pool).await?) {
        let client = share_client()?;
        if let Err(e) = delete_remote(&client, &base, &secret, slug).await {
            remote_error = Some(e.to_string());
        }
    }

    sqlx::query(
        "UPDATE wishlists
         SET share_slug = NULL, share_url = NULL, shared_at = NULL,
             share_expires_at = NULL
         WHERE id = ?",
    )
    .bind(wishlist_id)
    .execute(pool)
    .await?;

    if let Some(e) = remote_error {
        tracing::warn!("share: remote revoke failed, local state cleared: {e}");
    }
    status(pool, wishlist_id).await
}

/// The HTTP client every share operation uses. One builder rather than three
/// so a timeout change can't apply to two of them.
fn share_client() -> AppResult<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(UPLOAD_TIMEOUT_SECS))
        .build()?)
}

/// PUT a rendered document and return what the Worker recorded.
///
/// Content-agnostic on purpose — the Worker stores any HTML blob, so a
/// wishlist and a set of listings differ only in what was rendered upstream
/// of here. That is the whole reason DCH-48 needed no Worker changes.
async fn upload_html(
    client: &reqwest::Client,
    base: &str,
    secret: &str,
    html: String,
    ttl_days: u32,
) -> AppResult<ShareResponse> {
    let res = client
        .put(format!("{base}/api/share?ttl_days={ttl_days}"))
        .bearer_auth(secret)
        .header("content-type", "text/html; charset=utf-8")
        .body(html)
        .send()
        .await?;

    let status_code = res.status();
    if !status_code.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(map_upload_failure(status_code.as_u16(), &body));
    }
    // Parsed from text rather than `res.json()`: reqwest's json feature
    // isn't enabled in this crate and one response body doesn't justify it.
    let raw = res.text().await?;
    serde_json::from_str(&raw)
        .map_err(|e| AppError::Parse(format!("worker returned an unreadable share response: {e}")))
}

async fn delete_remote(
    client: &reqwest::Client,
    base: &str,
    secret: &str,
    slug: &str,
) -> AppResult<()> {
    let res = client
        .delete(format!("{base}/api/share/{slug}"))
        .bearer_auth(secret)
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(AppError::Config(format!(
            "worker returned {} revoking the share",
            res.status().as_u16()
        )));
    }
    Ok(())
}

/// One row of the `shares` table (DCH-48) — a link with no durable entity
/// behind it, so the row *is* the share.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ShareRecord {
    pub id: i64,
    /// What the slug points at. Only `"listings"` today; the column exists
    /// so the next share type doesn't need another table.
    pub kind: String,
    pub label: String,
    pub slug: String,
    pub url: String,
    pub item_count: i64,
    pub shared_at: i64,
    pub expires_at: Option<i64>,
}

/// What to call a share when the user didn't say.
///
/// The dialog prefills a dated label, but a user can clear the field, and an
/// empty name in the Settings list is a row nobody can identify well enough
/// to revoke. Kept pure and free of the date so it can't disagree with the
/// row's own `shared_at`, which is what the UI actually formats.
pub fn share_label(label: &str, count: usize) -> String {
    let trimmed = label.trim();
    if !trimmed.is_empty() {
        // Bounded because it is a display string in a fixed-width list, and
        // nothing stops a paste. Truncating on a char boundary, not a byte.
        return trimmed.chars().take(120).collect();
    }
    format!("{count} listing{}", if count == 1 { "" } else { "s" })
}

/// Render the selected listings and publish them under a fresh slug.
///
/// Unlike the wishlist share there is nothing to replace: each call mints a
/// new link and a new row. Two shares of the same listings are two different
/// conversations with two different people, and revoking one shouldn't
/// silently kill the other.
pub async fn share_listings(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
    rows: &[crate::commands::ListingRow],
    label: &str,
    options: ListingRenderOptions,
    ttl_days: u32,
) -> AppResult<ShareRecord> {
    // Before any rendering: embedding images for a dozen listings takes real
    // time, and discovering afterwards that no Worker is configured would
    // waste it and teach the user nothing.
    let Some((base, secret)) = share_config(pool).await? else {
        return Err(AppError::Config(
            "sharing isn't set up — add your Worker URL and shared secret in \
             Settings → Accounts before sharing listings"
                .into(),
        ));
    };
    if rows.is_empty() {
        return Err(AppError::Config("nothing selected to share".into()));
    }

    let title = share_label(label, rows.len());
    let rendered = export::render_listings(progress, &title, rows, options).await?;

    progress.step("Uploading…", None, None);
    let client = share_client()?;
    let body = upload_html(&client, &base, &secret, rendered.html, ttl_days).await?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO shares (kind, label, slug, url, item_count, shared_at, expires_at)
         VALUES ('listings', ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(&title)
    .bind(&body.slug)
    .bind(&body.url)
    .bind(rows.len() as i64)
    .bind(chrono::Utc::now().timestamp())
    .bind(body.expires_at)
    .fetch_one(pool)
    .await?;

    progress.done(format!("Shared {}.", title));
    sqlx::query_as("SELECT * FROM shares WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// Every live share, newest first. Expired rows are still returned — the
/// Worker's TTL has already made the link dead, and showing the row is how
/// the user finds out rather than discovering it from whoever they sent it
/// to. The UI marks them expired and offers the same Remove.
pub async fn list_shares(pool: &SqlitePool) -> AppResult<Vec<ShareRecord>> {
    sqlx::query_as("SELECT * FROM shares ORDER BY shared_at DESC")
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// Take one share out of circulation.
///
/// Same semantics as the wishlist revoke: the local row goes even when the
/// remote delete fails, so the list can't get stuck showing a link the user
/// has already asked to retire. The Worker treats an unknown slug as gone,
/// and the KV TTL is the backstop.
pub async fn revoke_share(pool: &SqlitePool, share_id: i64) -> AppResult<()> {
    let row: Option<(String,)> = sqlx::query_as("SELECT slug FROM shares WHERE id = ?")
        .bind(share_id)
        .fetch_optional(pool)
        .await?;
    let Some((slug,)) = row else {
        // Already gone. Revoke is the user asking for the link to stop
        // working, and it already has — erroring would make a double-click
        // look like a failure.
        return Ok(());
    };

    let mut remote_error: Option<String> = None;
    if let Some((base, secret)) = share_config(pool).await? {
        let client = share_client()?;
        if let Err(e) = delete_remote(&client, &base, &secret, &slug).await {
            remote_error = Some(e.to_string());
        }
    }

    sqlx::query("DELETE FROM shares WHERE id = ?")
        .bind(share_id)
        .execute(pool)
        .await?;

    if let Some(e) = remote_error {
        tracing::warn!("share: remote revoke failed, local row removed: {e}");
    }
    Ok(())
}

/// Turn the worker's status into something a person can act on. These are
/// the three failures a correctly-built request can still hit, and each has
/// a different fix.
pub fn map_upload_failure(status: u16, body: &str) -> AppError {
    match status {
        401 | 403 => AppError::Config(
            "the Worker rejected the shared secret — check it matches \
             APP_SHARED_SECRET on the Worker"
                .into(),
        ),
        413 => AppError::Config(
            "this wishlist is too large to share — it embeds every image, so \
             a shorter list or fewer entries will fit"
                .into(),
        ),
        404 => AppError::Config(
            "the Worker has no /api/share route — deploy the current worker/ \
             with `wrangler deploy`"
                .into(),
        ),
        _ => AppError::Config(format!(
            "the Worker returned {status} uploading the share{}",
            if body.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", body.trim().chars().take(200).collect::<String>())
            }
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(e: AppError) -> String {
        match e {
            AppError::Config(m) => m,
            other => panic!("expected Config, got {other:?}"),
        }
    }

    #[test]
    fn a_rejected_secret_names_the_thing_to_fix() {
        // "401 Unauthorized" is true and useless: the user has two secrets
        // and needs to know which one is wrong and where it lives.
        let m = message(map_upload_failure(401, ""));
        assert!(m.contains("APP_SHARED_SECRET"), "{m}");
    }

    #[test]
    fn forbidden_reads_the_same_as_unauthorized() {
        assert_eq!(
            message(map_upload_failure(401, "")),
            message(map_upload_failure(403, ""))
        );
    }

    #[test]
    fn too_large_explains_why_a_wishlist_can_be_too_large() {
        let m = message(map_upload_failure(413, ""));
        assert!(m.contains("embeds every image"), "{m}");
    }

    #[test]
    fn a_missing_route_points_at_deploying_the_worker() {
        // The likeliest cause by far: the desktop app updated, the Worker
        // didn't.
        let m = message(map_upload_failure(404, ""));
        assert!(m.contains("wrangler deploy"), "{m}");
    }

    #[test]
    fn an_unknown_status_carries_the_body_for_diagnosis() {
        let m = message(map_upload_failure(500, "kv put failed"));
        assert!(m.contains("500"), "{m}");
        assert!(m.contains("kv put failed"), "{m}");
    }

    #[test]
    fn an_unknown_status_without_a_body_doesnt_dangle_a_colon() {
        let m = message(map_upload_failure(502, "   "));
        assert!(!m.trim_end().ends_with(':'), "{m}");
    }

    #[test]
    fn a_blank_label_falls_back_to_the_item_count() {
        // An unnamed row in the Settings list is a link nobody can identify
        // well enough to revoke, which is where revoking happens.
        assert_eq!(share_label("", 5), "5 listings");
        assert_eq!(share_label("   ", 1), "1 listing");
    }

    #[test]
    fn a_supplied_label_wins_and_is_trimmed() {
        assert_eq!(share_label("  Auctions for Dad  ", 3), "Auctions for Dad");
    }

    #[test]
    fn a_pasted_label_is_bounded_on_a_char_boundary() {
        // Multi-byte on purpose: a byte-wise truncate would panic here.
        let long = "é".repeat(500);
        let out = share_label(&long, 2);
        assert_eq!(out.chars().count(), 120);
    }

    #[test]
    fn a_long_body_is_truncated_rather_than_pasted_whole() {
        // An HTML error page from a misconfigured proxy would otherwise
        // become the entire banner.
        let m = message(map_upload_failure(500, &"x".repeat(5_000)));
        assert!(m.len() < 300, "message was {} chars", m.len());
    }
}
