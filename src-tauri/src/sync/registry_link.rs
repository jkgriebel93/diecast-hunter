//! Backs the registry-search dialog: given a listing + a registry entry
//! GUID (selected from search results), ensure the entry exists locally
//! (creating a stub if needed), enrich it via the M3 detail-page fetcher,
//! then write the manual match into `listing_matches`. The caller can then
//! re-render the listing card with full registry data.

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::DcrClient;
use crate::error::{AppError, AppResult};
use crate::match_feedback::{self, FeedbackLabel};
use crate::settings;
use crate::sync::dcr_registry;

#[derive(Debug, Serialize, Clone)]
pub struct LinkResult {
    pub registry_entry_id: i64,
    pub enriched: bool,
}

pub async fn link_listing_to_registry(
    pool: &SqlitePool,
    listing_id: i64,
    registry_guid: &str,
    detail_url: Option<&str>,
) -> AppResult<LinkResult> {
    // 1. Ensure a registry_entries row exists for this GUID. If we've never
    //    seen it before, insert a near-empty stub with just the detail_url
    //    in raw_json so the enrichment step can find the page.
    let now = Utc::now().timestamp();
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM registry_entries WHERE external_id = ?")
            .bind(registry_guid)
            .fetch_optional(pool)
            .await?;

    let entry_id = if let Some((id,)) = existing {
        // If the row exists but raw_json doesn't carry a detail_url and the
        // caller has one, patch it in so enrichment can locate the page.
        if let Some(u) = detail_url {
            sqlx::query(
                "UPDATE registry_entries
                 SET raw_json = json_patch(COALESCE(raw_json, '{}'),
                     json_object('detail_url', ?))
                 WHERE id = ? AND (raw_json IS NULL
                                   OR json_extract(raw_json, '$.detail_url') IS NULL)",
            )
            .bind(u)
            .bind(id)
            .execute(pool)
            .await?;
        }
        id
    } else {
        let raw_json = serde_json::to_string(&serde_json::json!({
            "detail_url": detail_url,
            "source": "production_search_link",
        }))
        .unwrap_or_default();
        sqlx::query(
            "INSERT INTO registry_entries
                (external_id, raw_json, fetched_at)
             VALUES (?, ?, ?)",
        )
        .bind(registry_guid)
        .bind(&raw_json)
        .bind(now)
        .execute(pool)
        .await?;
        let row: (i64,) = sqlx::query_as("SELECT id FROM registry_entries WHERE external_id = ?")
            .bind(registry_guid)
            .fetch_one(pool)
            .await?;
        row.0
    };

    // 2. Enrich the entry from its detail page (M3 path). We log into DCR
    //    and fetch the single entry's detail page directly — earlier versions
    //    re-used the global "enrich all pending entries" pass, which hangs
    //    for many minutes if there's a backlog of stubs.
    let enriched = run_targeted_enrichment(pool, entry_id, registry_guid, detail_url)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("registry-link: enrichment of entry {entry_id} failed: {e}");
            false
        });

    // 3. Snapshot what this link is replacing, so the verdict log can tell
    //    "user agreed with the auto-suggestion" from "user overrode it".
    let previous: Option<(Option<i64>, i64, Option<String>)> = sqlx::query_as(
        "SELECT registry_entry_id, user_confirmed, matched_by
         FROM listing_matches WHERE listing_id = ?",
    )
    .bind(listing_id)
    .fetch_optional(pool)
    .await?;

    // 4. Lock in the manual match.
    sqlx::query(
        "INSERT INTO listing_matches
            (listing_id, registry_entry_id, confidence, user_confirmed,
             matched_at, matched_by, match_reasons)
         VALUES (?, ?, 100.0, 1, ?, 'manual', NULL)
         ON CONFLICT(listing_id) DO UPDATE SET
            registry_entry_id = excluded.registry_entry_id,
            confidence = excluded.confidence,
            user_confirmed = 1,
            matched_at = excluded.matched_at,
            matched_by = 'manual',
            match_reasons = NULL",
    )
    .bind(listing_id)
    .bind(entry_id)
    .bind(now)
    .execute(pool)
    .await?;

    // 5. Log the verdicts. An auto-suggestion the user linked away from is
    //    a negative example for that entry; the linked entry is a positive
    //    one (unless this is a no-op re-link of an already-confirmed pair).
    let prev_auto_entry = previous.as_ref().and_then(|(e, _, m)| {
        if m.as_deref() == Some("auto") {
            *e
        } else {
            None
        }
    });
    let already_confirmed_same = previous
        .as_ref()
        .is_some_and(|(e, c, _)| *c != 0 && *e == Some(entry_id));
    if let Some(old) = prev_auto_entry.filter(|&old| old != entry_id) {
        match_feedback::record_best_effort(
            pool,
            listing_id,
            Some(old),
            FeedbackLabel::CorrectedAway,
            "manual_link",
        )
        .await;
    }
    if !already_confirmed_same {
        match_feedback::record_best_effort(
            pool,
            listing_id,
            Some(entry_id),
            FeedbackLabel::Confirmed,
            "manual_link",
        )
        .await;
    }

    // 6. The confirmed entry is now the authority on this car's
    //    attributes — copy them onto the listing (provenance-marked).
    if let Err(e) = crate::sync::attribute_assoc::backfill_attrs_from_match(pool, listing_id).await
    {
        tracing::warn!("attr backfill after linking listing {listing_id} failed: {e}");
    }

    Ok(LinkResult {
        registry_entry_id: entry_id,
        enriched,
    })
}

async fn run_targeted_enrichment(
    pool: &SqlitePool,
    entry_id: i64,
    registry_guid: &str,
    detail_url: Option<&str>,
) -> AppResult<bool> {
    let detail_url = match detail_url {
        Some(u) => u.to_string(),
        None => match lookup_detail_url(pool, entry_id).await? {
            Some(u) => u,
            None => {
                tracing::warn!(
                    "registry-link: entry {entry_id} has no detail_url — skipping enrichment"
                );
                return Ok(false);
            }
        },
    };

    let (username, password) = load_dcr_credentials(pool).await?;
    let client = DcrClient::new()?;
    client.login(&username, &password).await?;

    dcr_registry::enrich_one(pool, &client, entry_id, registry_guid, &detail_url).await?;
    Ok(true)
}

async fn lookup_detail_url(pool: &SqlitePool, entry_id: i64) -> AppResult<Option<String>> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT raw_json FROM registry_entries WHERE id = ?")
            .bind(entry_id)
            .fetch_optional(pool)
            .await?;
    let raw_json = match row.and_then(|(rj,)| rj) {
        Some(rj) => rj,
        None => return Ok(None),
    };
    let v: serde_json::Value = match serde_json::from_str(&raw_json) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    Ok(v.get("detail_url")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string()))
}

async fn load_dcr_credentials(pool: &SqlitePool) -> AppResult<(String, String)> {
    let username = settings::get(pool, settings::KEY_DCR_USERNAME)
        .await?
        .ok_or_else(|| {
            AppError::NotConfigured("diecastregistry.com username not set in Settings".into())
        })?;
    let password = settings::secret_get(settings::ENTRY_DCR_PASSWORD)?.ok_or_else(|| {
        AppError::NotConfigured("diecastregistry.com password not set in Settings".into())
    })?;
    Ok((username, password))
}
