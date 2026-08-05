//! Remove-from-My-Garage flow for diecastregistry.com.
//!
//! The browser drives this through a confirm modal (`/MyGarage/
//! ConfirmDeleteDiecast/<asset-guid>`, handler in the site's
//! `/Scripts/site/mygarage.diecast.js`), but the modal exists only to ask
//! the human — the actual action is a single XHR POST to
//! `/MyGarage/<asset-guid>/Delete` with an empty body and no anti-forgery
//! token, so we go straight there. IIS requires `Content-Length: 0` on that
//! bodyless POST (411 otherwise) — `DcrClient::post_form` handles it.
//!
//! Captured server responses:
//!   asset in the garage  → {"success":true, ...}
//!   asset not in garage  → {"success":false,"url":"/MyGarage"}   (no message)
//!   rejected for a reason → {"success":false,"message":"..."}
//! (The confirm GET 500s for missing assets, so it can't be used as the
//! not-found signal.)
//!
//! Note the asset GUID here is the *garage asset* id (`my_collection.
//! external_id`), not the registry GUID used by the register flow.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;

use crate::dcr::DcrClient;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteOutcome {
    /// Deleted on diecastregistry.com.
    Deleted,
    /// diecastregistry.com doesn't have this asset in the user's garage.
    NotFound,
}

pub async fn delete_from_garage(client: &DcrClient, asset_guid: &str) -> AppResult<DeleteOutcome> {
    if !is_asset_guid(asset_guid) {
        return Err(AppError::Parse(format!(
            "not a valid garage asset GUID: {asset_guid}"
        )));
    }
    let body = client
        .post_form(&format!("/MyGarage/{asset_guid}/Delete"), &[])
        .await?;
    parse_delete_response(&body)
}

static ASSET_GUID_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
});

fn is_asset_guid(s: &str) -> bool {
    ASSET_GUID_RE.is_match(s)
}

#[derive(Deserialize)]
struct DeleteResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    message: String,
}

pub(crate) fn parse_delete_response(body: &str) -> AppResult<DeleteOutcome> {
    let envelope: DeleteResponse = serde_json::from_str(body).map_err(|e| {
        // Most likely an HTML login/error page — session loss surfaces here.
        AppError::Parse(format!(
            "delete-diecast response was not JSON ({e}); body starts with: {}",
            body.chars().take(120).collect::<String>()
        ))
    })?;
    if envelope.success {
        return Ok(DeleteOutcome::Deleted);
    }
    if envelope.message.is_empty() {
        // Bare {"success":false} is what the server sends when the asset
        // isn't in the caller's garage (verified against the live site).
        return Ok(DeleteOutcome::NotFound);
    }
    Err(AppError::Parse(format!(
        "delete failed: {}",
        envelope.message
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_success_response() {
        assert_eq!(
            parse_delete_response(r#"{"success":true}"#).unwrap(),
            DeleteOutcome::Deleted
        );
    }

    #[test]
    fn bare_failure_means_not_found() {
        // Captured live: POST Delete for an asset not in the garage.
        assert_eq!(
            parse_delete_response(r#"{"success":false,"url":"/MyGarage"}"#).unwrap(),
            DeleteOutcome::NotFound
        );
    }

    #[test]
    fn failure_with_message_is_an_error() {
        let err = parse_delete_response(r#"{"success":false,"message":"Nope."}"#).unwrap_err();
        assert!(err.to_string().contains("Nope."));
    }

    #[test]
    fn rejects_non_json_response() {
        let err = parse_delete_response("<html>not json</html>").unwrap_err();
        assert!(err.to_string().contains("not JSON"));
    }

    #[test]
    fn asset_guid_validation() {
        assert!(is_asset_guid("1bc0d137-617a-4153-9615-b43100f2bbdf"));
        assert!(!is_asset_guid("not-a-guid"));
        assert!(!is_asset_guid("1BC0D137-617A-4153-9615-B43100F2BBDF"));
        assert!(!is_asset_guid(""));
    }

    /// Live check of the not-found path end to end. The GUID is fabricated
    /// (verified absent from the garage when captured), so nothing real can
    /// be deleted. Run manually:
    ///   cargo test live_delete_missing -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_delete_missing_asset_returns_not_found() {
        let data_dir = crate::db::default_data_dir().unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(data_dir.join("diecast-hunter.sqlite"))
            .read_only(true);
        let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
        let (username,): (String,) =
            sqlx::query_as("SELECT value FROM settings WHERE key = 'diecastregistry.username'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let password = crate::settings::secret_get(crate::settings::ENTRY_DCR_PASSWORD)
            .unwrap()
            .expect("DCR password in keyring");

        let client = DcrClient::new().unwrap();
        client.login(&username, &password).await.unwrap();
        let outcome = delete_from_garage(&client, "7d3f2a91-5c4e-4b8a-9f1e-2a6b8c0d4e5f")
            .await
            .unwrap();
        assert_eq!(outcome, DeleteOutcome::NotFound);
    }
}
