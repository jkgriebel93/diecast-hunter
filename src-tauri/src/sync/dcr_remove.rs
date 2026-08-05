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

/// What a removal has to do about diecastregistry.com, decided from the
/// row's `source` alone.
///
/// Split out from `remove_collection_entry` so it can be tested directly.
/// That isn't only tidiness: a test that calls `remove_collection_entry`
/// makes the DCR client path (reqwest, TLS, the keyring) reachable from the
/// test binary, and on Windows that binary then fails to load at all
/// (`STATUS_ENTRYPOINT_NOT_FOUND`, before a single test runs). The app
/// binary links it fine — this is specific to the test executable. Keep the
/// decision logic reachable without the network, and the test stays cheap
/// and portable.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RemovalPlan {
    /// Synced from DCR: delete it there first, since DCR is the source of
    /// truth and a local-only delete would come back on the next sync.
    DeleteOnDcr,
    /// Nothing to ask DCR. `was_local` distinguishes a manually-added entry
    /// (DCH-12) from some other non-DCR source, which changes what the user
    /// is told afterwards.
    LocalOnly { was_local: bool },
}

pub(crate) fn plan_removal(source: &str) -> RemovalPlan {
    match source {
        "diecastregistry" => RemovalPlan::DeleteOnDcr,
        SOURCE_LOCAL => RemovalPlan::LocalOnly { was_local: true },
        _ => RemovalPlan::LocalOnly { was_local: false },
    }
}

/// What to tell the user once the row is gone.
pub(crate) fn outcome_message(found_on_dcr: bool, was_local: bool) -> &'static str {
    match (found_on_dcr, was_local) {
        (true, _) => "Removed from your DCR garage and local collection.",
        // Not a shortfall: no DCR call was made, so "wasn't in your garage"
        // would be warning about the expected outcome.
        (false, true) => "Removed the manually-added entry.",
        (false, false) => "Not found in your DCR garage — removed the local entry.",
    }
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

    let mut was_local = false;
    let found_on_dcr = match plan_removal(&source) {
        RemovalPlan::DeleteOnDcr => {
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
        }
        RemovalPlan::LocalOnly { was_local: local } => {
            was_local = local;
            false
        }
    };

    // Past this point we never bail: if DCR accepted the delete, the local
    // row must go too or the two sides end up out of sync until the next
    // full sync prunes it.
    sqlx::query("DELETE FROM my_collection WHERE id = ?")
        .bind(collection_id)
        .execute(pool)
        .await?;

    progress.done(outcome_message(found_on_dcr, was_local));
    Ok(RemoveEntrySummary {
        found_on_dcr,
        was_local,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A manually-added entry was never on DCR, so removing it must not go
    /// looking. This is the decision that keeps the network out of the path
    /// — see the note on `RemovalPlan` for why it's tested here rather than
    /// through `remove_collection_entry`.
    #[test]
    fn a_manual_entry_never_reaches_dcr() {
        assert_eq!(
            plan_removal(SOURCE_LOCAL),
            RemovalPlan::LocalOnly { was_local: true }
        );
    }

    #[test]
    fn a_synced_entry_is_deleted_on_dcr_first() {
        assert_eq!(plan_removal("diecastregistry"), RemovalPlan::DeleteOnDcr);
    }

    /// Old Facebook Marketplace rows may still exist in user databases. They
    /// aren't manual, but they aren't DCR's either — no call, and no claim
    /// that the user added them by hand.
    #[test]
    fn an_unknown_source_skips_dcr_without_claiming_to_be_manual() {
        assert_eq!(
            plan_removal("fb"),
            RemovalPlan::LocalOnly { was_local: false }
        );
    }

    #[test]
    fn a_manual_removal_reports_success_not_a_not_found_warning() {
        assert_eq!(
            outcome_message(false, true),
            "Removed the manually-added entry."
        );
        // The warning still stands for a DCR row that had gone missing —
        // there, "not found" is genuine information.
        assert!(outcome_message(false, false).contains("Not found"));
        assert!(outcome_message(true, false).contains("DCR garage"));
    }
}
