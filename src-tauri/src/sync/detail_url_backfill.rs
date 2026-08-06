//! Repairs `registry_entries` rows whose `raw_json` lost its `detail_url`
//! (an older enrichment pass rebuilt raw_json without carrying it forward).
//! The site-relative detail path isn't derivable locally — the slugs and the
//! trailing numeric id only exist on DCR — so the fix is to re-walk the
//! /Production search for each affected driver and let the pre-warm upsert
//! merge `detail_url` back into the stored raw_json. Restoring it brings back
//! the "View on diecastregistry.com" link on matched listings and makes the
//! rows re-enrichable.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::progress::ProgressEmitter;
use crate::sync::registry_prewarm::{logged_in_client, prewarm_driver_with_client};

#[derive(Debug, Default, Serialize, Clone)]
pub struct DetailUrlBackfillSummary {
    pub drivers_processed: u32,
    /// Entries that were missing a detail_url before the run.
    pub missing_before: u32,
    /// Entries recovered by this run.
    pub entries_patched: u32,
    /// Entries still missing a detail_url afterwards (driver not searchable,
    /// entry no longer in the production search, or no driver on file).
    pub still_missing: u32,
}

/// One clause, used consistently everywhere this module decides whether a
/// row "has" a detail_url.
///
/// Manually-added entries (`source = 'local'`, DCH-12) are excluded up front.
/// They have no DCR page, so they'd count as "missing" forever: inflating
/// `missing_before`, then landing in `still_missing` after a run that could
/// never have fixed them, and reporting a repair job that isn't broken.
const MISSING_DETAIL_URL: &str = "re.source <> 'local'
     AND (re.raw_json IS NULL OR re.raw_json = ''
     OR NOT json_valid(re.raw_json)
     OR json_extract(re.raw_json, '$.detail_url') IS NULL)";

pub async fn backfill_detail_urls(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
) -> AppResult<DetailUrlBackfillSummary> {
    let missing_before = count_missing(pool).await?;
    if missing_before == 0 {
        progress.done("All registry entries already have a diecastregistry.com link.");
        return Ok(DetailUrlBackfillSummary::default());
    }

    // Drivers owning the affected entries, resolved to the search-form GUID
    // through the same normalized-name join `list_prewarmed_drivers` uses.
    // Entries whose driver has no cached form option can't be searched and
    // land in `still_missing`.
    let drivers: Vec<(String, String)> = sqlx::query_as(&format!(
        "SELECT DISTINCT o.value, o.display
         FROM registry_entries re
         JOIN drivers d ON d.id = re.driver_id
         JOIN registry_form_options o
           ON o.field = 'driver' AND o.normalized = d.normalized_name
         WHERE {MISSING_DETAIL_URL}
         ORDER BY o.display COLLATE NOCASE"
    ))
    .fetch_all(pool)
    .await?;

    if drivers.is_empty() {
        progress.done(format!(
            "{missing_before} entries lack a link, but none of their drivers are in the \
             cached registry dropdowns — refresh the form options and retry."
        ));
        return Ok(DetailUrlBackfillSummary {
            missing_before,
            still_missing: missing_before,
            ..Default::default()
        });
    }

    progress.step("Logging in to diecastregistry.com…", None, None);
    let client = logged_in_client(pool).await?;

    let total = drivers.len() as u32;
    let mut drivers_processed = 0u32;
    for (i, (guid, name)) in drivers.iter().enumerate() {
        progress.check_cancelled()?;
        progress.step(
            format!("Recovering links for {name} ({} of {total})…", i + 1),
            Some(i as u32),
            Some(total),
        );
        match prewarm_driver_with_client(pool, &client, guid, progress).await {
            Ok(_) => drivers_processed += 1,
            Err(crate::error::AppError::Cancelled) => {
                return Err(crate::error::AppError::Cancelled)
            }
            Err(e) => tracing::warn!("detail-url backfill: {name} failed: {e}"),
        }
    }

    let still_missing = count_missing(pool).await?;
    let entries_patched = missing_before.saturating_sub(still_missing);

    progress.done(format!(
        "Recovered links for {entries_patched} registry entries ({still_missing} still missing)."
    ));

    Ok(DetailUrlBackfillSummary {
        drivers_processed,
        missing_before,
        entries_patched,
        still_missing,
    })
}

async fn count_missing(pool: &SqlitePool) -> AppResult<u32> {
    let (n,): (i64,) = sqlx::query_as(&format!(
        "SELECT COUNT(*) FROM registry_entries re WHERE {MISSING_DETAIL_URL}"
    ))
    .fetch_one(pool)
    .await?;
    Ok(n as u32)
}
