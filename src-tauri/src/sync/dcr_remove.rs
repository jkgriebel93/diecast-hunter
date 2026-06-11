//! Remove a single collection entry, treating diecastregistry.com as the
//! source of truth: delete it from the user's My Garage first, then drop the
//! local row. When DCR doesn't have the asset (already deleted on the site,
//! or a stale local row), the local row is still removed — the frontend shows
//! a neutral "wasn't on DCR" notice rather than an error.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::{DcrClient, DeleteOutcome};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::sync::dcr_collection::load_credentials;

#[derive(Debug, Serialize, Clone)]
pub struct RemoveEntrySummary {
    /// True when the asset existed in the DCR garage and was deleted there.
    /// False means DCR didn't know it — the local row was removed anyway.
    pub found_on_dcr: bool,
}

pub async fn remove_collection_entry(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
    collection_id: i64,
) -> AppResult<RemoveEntrySummary> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT external_id, source FROM my_collection WHERE id = ?",
    )
    .bind(collection_id)
    .fetch_optional(pool)
    .await?;
    let (asset_guid, source) = row.ok_or_else(|| {
        AppError::Parse(format!("collection entry {collection_id} not found"))
    })?;

    let found_on_dcr = if source == "diecastregistry" {
        progress.step("Logging in to diecastregistry.com…", None, None);
        let (username, password) = load_credentials(pool).await?;
        let client = DcrClient::new()?;
        client.login(&username, &password).await?;

        progress.check_cancelled()?;
        progress.step("Removing from My Garage…", None, None);
        match crate::dcr::delete_from_garage(&client, &asset_guid).await? {
            DeleteOutcome::Deleted => true,
            DeleteOutcome::NotFound => false,
        }
    } else {
        // Rows from other sources have nothing to delete on DCR.
        false
    };

    // Past this point we never bail: if DCR accepted the delete, the local
    // row must go too or the two sides end up out of sync until the next
    // full sync prunes it.
    sqlx::query("DELETE FROM my_collection WHERE id = ?")
        .bind(collection_id)
        .execute(pool)
        .await?;

    progress.done(if found_on_dcr {
        "Removed from your DCR garage and local collection.".to_string()
    } else {
        "Not found in your DCR garage — removed the local entry.".to_string()
    });
    Ok(RemoveEntrySummary { found_on_dcr })
}
