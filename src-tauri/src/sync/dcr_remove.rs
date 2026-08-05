//! Remove a single collection entry, treating diecastregistry.com as the
//! source of truth: delete it from the user's My Garage first, then drop the
//! local row. When DCR doesn't have the asset (already deleted on the site,
//! or a stale local row), the local row is still removed — the frontend shows
//! a neutral "wasn't on DCR" notice rather than an error.
//!
//! Manually-added entries (DCH-12) skip the DCR round trip entirely. They
//! were never on the site, so "wasn't in your garage" would be a warning
//! about the expected outcome; `was_local` lets the frontend report a plain
//! success instead.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::{DcrClient, DeleteOutcome};
use crate::error::{AppError, AppResult};
use crate::local_collection::SOURCE_LOCAL;
use crate::progress::ProgressEmitter;
use crate::sync::dcr_collection::load_credentials;

#[derive(Debug, Serialize, Clone)]
pub struct RemoveEntrySummary {
    /// True when the asset existed in the DCR garage and was deleted there.
    /// False means DCR didn't know it — the local row was removed anyway.
    pub found_on_dcr: bool,
    /// True for a manually-added entry: nothing was asked of DCR, and
    /// `found_on_dcr = false` carries no meaning.
    pub was_local: bool,
}

pub async fn remove_collection_entry(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
    collection_id: i64,
) -> AppResult<RemoveEntrySummary> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT external_id, source FROM my_collection WHERE id = ?")
            .bind(collection_id)
            .fetch_optional(pool)
            .await?;
    let (asset_guid, source) =
        row.ok_or_else(|| AppError::Parse(format!("collection entry {collection_id} not found")))?;

    let was_local = source == SOURCE_LOCAL;

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

    progress.done(match (found_on_dcr, was_local) {
        (true, _) => "Removed from your DCR garage and local collection.".to_string(),
        (false, true) => "Removed the manually-added entry.".to_string(),
        (false, false) => "Not found in your DCR garage — removed the local entry.".to_string(),
    });
    Ok(RemoveEntrySummary {
        found_on_dcr,
        was_local,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

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
            .expect("run migrations");
        pool
    }

    /// Removing a manual entry must not touch the network. If it did, this
    /// test would fail on the missing credentials rather than returning —
    /// which is precisely the assertion, since no DCR call is reachable from
    /// an in-memory database with an empty settings table.
    #[tokio::test]
    async fn removing_a_manual_entry_skips_dcr_and_reports_plainly() {
        let pool = migrated_pool().await;
        let created = crate::local_collection::create_local_entry(
            &pool,
            crate::local_collection::LocalEntryInput {
                driver_name: "Bill Elliott".to_string(),
                scheme_text: "Coors Light".to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let progress = ProgressEmitter::null("remove_entry");
        let summary = remove_collection_entry(&pool, &progress, created.collection_id)
            .await
            .unwrap();

        assert!(summary.was_local);
        assert!(!summary.found_on_dcr);

        let (remaining,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM my_collection")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
