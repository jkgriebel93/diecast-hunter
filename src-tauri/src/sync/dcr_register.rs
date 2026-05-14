//! Orchestrates the "add diecast to My Garage" flow: log in, POST the
//! register form, then re-pull /MyGarage page 1 so the new item appears in
//! the local DB without waiting for a full collection sync.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::{register_diecast, DcrClient, RegisterDiecastInput, RegisterDiecastResult};
use crate::error::AppResult;
use crate::progress::ProgressEmitter;
use crate::sync::dcr_collection::{load_credentials, sync_first_page};

#[derive(Debug, Serialize, Clone)]
pub struct RegisterDiecastSummary {
    pub registration_number: String,
    pub registry_int_id: i64,
    /// Items pulled from /MyGarage page 1 after the add. Useful as a sanity
    /// check that the new item is now visible to subsequent syncs.
    pub refreshed_items_seen: u32,
}

pub async fn register_in_garage(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
    input: RegisterDiecastInput,
) -> AppResult<RegisterDiecastSummary> {
    progress.step("Logging in to diecastregistry.com…", None, None);
    let (username, password) = load_credentials(pool).await?;
    let client = DcrClient::new()?;
    client.login(&username, &password).await?;

    progress.step("Submitting registration…", None, None);
    let RegisterDiecastResult {
        registration_number,
        registry_int_id,
    } = register_diecast(&client, &input).await?;

    let refresh = sync_first_page(pool, &client, progress).await?;

    progress.done(format!(
        "Added to My Garage. DCR registration #{registration_number}."
    ));

    Ok(RegisterDiecastSummary {
        registration_number,
        registry_int_id,
        refreshed_items_seen: refresh.items_seen,
    })
}
