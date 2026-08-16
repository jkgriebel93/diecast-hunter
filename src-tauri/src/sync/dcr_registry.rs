use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::{parse_detail_page, DcrClient, RegistryDetail};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::settings;
use crate::sync::driver_upsert::{upsert_driver, DriverIdCache};

/// Re-enrich entries last fetched more than this many seconds ago.
const REFRESH_AFTER_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

#[derive(Debug, Default, Serialize, Clone)]
pub struct EnrichSummary {
    pub considered: u32,
    pub enriched: u32,
    pub skipped: u32,
    pub failed: u32,
}

/// Enrich registry_entries rows that are still stubs (no details_fetched_at)
/// or whose details are older than REFRESH_AFTER_SECONDS.
///
/// `client` is expected to already be logged in. The DcrClient's built-in
/// rate limiter paces each detail-page fetch.
///
/// A non-forced pass is capped and prioritized (DCH-53): at most
/// `KEY_ENRICH_MAX_ENTRIES` detail pages per run, entries referenced by
/// the collection, a listing match, or a wishlist first. Each fetch costs
/// ~1.2 s at the DCR rate floor, so an uncapped pass turns into an
/// hours-long walk the first time a bulk-prewarmed cohort ages past the
/// 30-day window — 46k entries did exactly that in July 2026. `force`
/// still walks everything, uncapped: that's the manual "re-enrich all"
/// path, chosen deliberately.
///
/// Manually-added entries (`source = 'local'`, DCH-12) are excluded. They
/// have no DCR detail page, so they would be considered on every run,
/// permanently — they can never gain a `details_fetched_at`. The
/// `external_id IS NOT NULL` clause already keeps them out today, since a
/// local entry has no GUID; the explicit `source` filter is what makes that
/// a guarantee rather than a coincidence of how they happen to be stored.
pub async fn enrich_pending_registry_entries(
    pool: &SqlitePool,
    client: &DcrClient,
    force: bool,
    progress: &ProgressEmitter,
) -> AppResult<EnrichSummary> {
    let cap = if force {
        None
    } else {
        let cap = settings::get(pool, settings::KEY_ENRICH_MAX_ENTRIES)
            .await?
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(settings::DEFAULT_ENRICH_MAX_ENTRIES);
        if cap == 0 {
            tracing::info!("registry enrichment disabled (cap = 0) — skipping");
            return Ok(EnrichSummary::default());
        }
        Some(cap as i64)
    };

    let cutoff = Utc::now().timestamp() - REFRESH_AFTER_SECONDS;
    let rows = select_entries_to_enrich(pool, force, cutoff, cap).await?;

    let total = rows.len() as u32;
    let mut summary = EnrichSummary {
        considered: total,
        ..Default::default()
    };

    for (idx, (id, external_id, raw_json, _details_fetched_at)) in rows.into_iter().enumerate() {
        progress.check_cancelled()?;
        let done = (idx + 1) as u32;
        progress.step(
            format!("Enriching registry entry {} of {}…", done, total),
            Some(done),
            Some(total),
        );

        let detail_url = match extract_detail_url(raw_json.as_deref()) {
            Some(u) => u,
            None => {
                tracing::warn!(
                    "registry_entry {id} ({external_id}): no detail_url in raw_json — skipping"
                );
                summary.skipped += 1;
                continue;
            }
        };

        match enrich_one(pool, client, id, &external_id, &detail_url).await {
            Ok(()) => summary.enriched += 1,
            Err(e) => {
                tracing::warn!("registry_entry {id} ({external_id}): enrichment failed: {e}");
                summary.failed += 1;
            }
        }
    }

    Ok(summary)
}

/// The candidate set for an enrichment pass, split out so the exclusions,
/// priorities, and cap can be tested without a logged-in client. Returns
/// `(id, external_id, raw_json, details_fetched_at)`.
///
/// The non-forced query encodes the DCH-53 policy:
///
/// - Entries referenced by `my_collection`, `listing_matches`, or a
///   wishlist are refreshed whenever stale (never enriched, or older than
///   the cutoff), and always sort ahead of everything else.
/// - Unreferenced entries — prewarm/presearch cache stubs — are enriched
///   only once (`details_fetched_at IS NULL`), never re-refreshed. Keeping
///   tens of thousands of unreferenced stubs on a 30-day TTL is what
///   produced the ~47k requests/month re-walk; a stub that later becomes
///   referenced joins the first group on the next run.
/// - Oldest `details_fetched_at` first (NULLs sort first in SQLite ASC),
///   so a cohort that expired as one block drains oldest-first across runs
///   instead of blocking everything behind it.
/// - Rows whose raw_json carries no detail_url are excluded: the fetch
///   loop can only skip them, and under a cap each would permanently
///   occupy a slot at the head of the stale queue.
async fn select_entries_to_enrich(
    pool: &SqlitePool,
    force: bool,
    cutoff: i64,
    cap: Option<i64>,
) -> AppResult<Vec<(i64, String, Option<String>, Option<i64>)>> {
    let rows = if force {
        sqlx::query_as(
            "SELECT id, external_id, raw_json, details_fetched_at
             FROM registry_entries
             WHERE external_id IS NOT NULL
               AND source <> 'local'
             ORDER BY id",
        )
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "WITH referenced(entry_id) AS (
                 SELECT registry_entry_id FROM my_collection
                 UNION
                 SELECT registry_entry_id FROM listing_matches
                 UNION
                 SELECT registry_entry_id FROM wishlist_entries
             )
             SELECT re.id, re.external_id, re.raw_json, re.details_fetched_at
             FROM registry_entries re
             LEFT JOIN referenced r ON r.entry_id = re.id
             WHERE re.external_id IS NOT NULL
               AND re.source <> 'local'
               AND json_extract(re.raw_json, '$.detail_url') IS NOT NULL
               AND (
                     (r.entry_id IS NOT NULL
                      AND (re.details_fetched_at IS NULL OR re.details_fetched_at < ?))
                  OR (r.entry_id IS NULL AND re.details_fetched_at IS NULL)
               )
             ORDER BY (r.entry_id IS NOT NULL) DESC, re.details_fetched_at ASC, re.id
             LIMIT ?",
        )
        .bind(cutoff)
        .bind(cap.unwrap_or(i64::MAX))
        .fetch_all(pool)
        .await?
    };
    Ok(rows)
}

pub(crate) async fn enrich_one(
    pool: &SqlitePool,
    client: &DcrClient,
    row_id: i64,
    expected_external_id: &str,
    detail_url: &str,
) -> AppResult<()> {
    let html = client.get_html(detail_url).await?;
    let detail = parse_detail_page(&html)?;

    // Defense in depth: if the detail page resolves a different GUID than
    // what we have on file, refuse to write — something is wrong.
    if let Some(parsed_id) = detail.external_id.as_deref() {
        if parsed_id != expected_external_id {
            return Err(AppError::Parse(format!(
                "external_id mismatch: expected {expected_external_id}, got {parsed_id}"
            )));
        }
    }

    let driver_id = match (&detail.driver_name, &detail.driver_normalized) {
        (Some(name), Some(norm)) => {
            // No cache worth threading here: this loop is paced by one
            // network fetch per entry, so the memo would save microseconds.
            let mut conn = pool.acquire().await?;
            Some(upsert_driver(&mut conn, &mut DriverIdCache::new(), name, norm).await?)
        }
        _ => None,
    };

    apply_detail(pool, row_id, &detail, driver_id, detail_url).await
}

/// Write a parsed detail page over an existing entry.
///
/// Split out of [`enrich_one`] so the merge semantics of `raw_json` can be
/// tested without a network fetch — the interesting behaviour is which keys
/// of a half-populated row survive, and that is pure database work.
async fn apply_detail(
    pool: &SqlitePool,
    row_id: i64,
    detail: &RegistryDetail,
    driver_id: Option<i64>,
    detail_url: &str,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    let raw_json = build_raw_json(detail, detail_url);

    sqlx::query(&format!(
        "UPDATE registry_entries SET
            driver_id = COALESCE(?, driver_id),
            year = COALESCE(?, year),
            year_raced = COALESCE(?, year_raced),
            car_number = COALESCE(?, car_number),
            diecast_type = COALESCE(?, diecast_type),
            registration_number = COALESCE(?, registration_number),
            scheme_text = COALESCE(?, scheme_text),
            scale = COALESCE(?, scale),
            oem = COALESCE(?, oem),
            brand = COALESCE(?, brand),
            make = COALESCE(?, make),
            finish = COALESCE(?, finish),
            production_qty = COALESCE(?, production_qty),
            retail_value_cents = COALESCE(?, retail_value_cents),
            wholesale_value_cents = COALESCE(?, wholesale_value_cents),
            {merge},
            fetched_at = ?,
            details_fetched_at = ?
         WHERE id = ?",
        merge = crate::sync::raw_json::MERGE_UPDATE,
    ))
    .bind(driver_id)
    .bind(detail.year_released)
    .bind(detail.year_raced)
    .bind(&detail.car_number)
    .bind(&detail.diecast_type)
    .bind(&detail.registration_number)
    .bind(&detail.scheme_text)
    .bind(&detail.scale)
    .bind(&detail.oem)
    .bind(&detail.brand)
    .bind(&detail.make)
    .bind(&detail.finish)
    .bind(detail.production_qty)
    .bind(detail.retail_value_cents)
    .bind(detail.wholesale_value_cents)
    .bind(&raw_json)
    .bind(now)
    .bind(now)
    .bind(row_id)
    .execute(pool)
    .await?;

    Ok(())
}

fn extract_detail_url(raw_json: Option<&str>) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw_json?).ok()?;
    v.get("detail_url")?.as_str().map(|s| s.to_string())
}

/// `detail_url` is carried forward explicitly rather than left to the merge:
/// it is the only place we store the site-relative page path (the slugs
/// aren't derivable from columns), and it is the one key here we want to
/// re-assert even when a previous writer already had one, since this is the
/// URL we just proved resolves to this entry.
///
/// Everything the detail page *doesn't* carry is left out and survives the
/// merge — `image_url` above all, which is the garage/search thumbnail. This
/// function used to be assigned over the whole column, which meant enriching
/// an entry silently deleted that thumbnail; the wishlist reads it, so rows
/// lost their picture the first time they were enriched. See `sync::raw_json`.
fn build_raw_json(detail: &RegistryDetail, detail_url: &str) -> String {
    crate::sync::raw_json::payload(serde_json::json!({
        "source": "registry_detail_page",
        "detail_url": detail_url,
        "external_id": detail.external_id,
        "registration_number": detail.registration_number,
        "registry_int_id": detail.registry_int_id,
        "driver_name": detail.driver_name,
        "scheme_text": detail.scheme_text,
        "comments": detail.comments,
        "photos": detail.photos,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    #[test]
    fn build_raw_json_preserves_detail_url() {
        let url =
            "/diecast/jeff-gordon/action-lionel-elite-24/68acf030-a051-4e24-907f-abf2475e5315";
        let raw_json = build_raw_json(&RegistryDetail::default(), url);
        assert_eq!(extract_detail_url(Some(&raw_json)).as_deref(), Some(url));
    }

    /// The detail page has no thumbnail on it — that lives on the garage and
    /// search listings — so enrichment must leave the `image_url` a previous
    /// writer parsed alone. It used to assign the whole column, which is why
    /// wishlist rows lost their picture the first time they were enriched.
    #[tokio::test]
    async fn enrichment_keeps_the_thumbnail_it_knows_nothing_about() {
        let pool = migrated_pool().await;
        let id = insert_entry(&pool, "guid-1", None, true).await;
        sqlx::query(
            "UPDATE registry_entries
             SET raw_json = json_set(raw_json, '$.image_url', '/img/thumb.jpg')
             WHERE id = ?",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();

        let detail = RegistryDetail {
            photos: vec!["/img/big-1.jpg".into(), "/img/big-2.jpg".into()],
            ..RegistryDetail::default()
        };
        apply_detail(&pool, id, &detail, None, "/diecast/x/y/guid-1")
            .await
            .unwrap();

        let raw: String = sqlx::query_scalar("SELECT raw_json FROM registry_entries WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["image_url"], "/img/thumb.jpg");
        assert_eq!(v["photos"][0], "/img/big-1.jpg");
        assert_eq!(v["detail_url"], "/diecast/x/y/guid-1");
    }

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

    /// Stale/fresh in these tests is relative to this cutoff: a
    /// `details_fetched_at` below it is stale, above it is fresh.
    const CUTOFF: i64 = 1_000;

    async fn insert_entry(
        pool: &SqlitePool,
        external_id: &str,
        details_fetched_at: Option<i64>,
        with_detail_url: bool,
    ) -> i64 {
        let raw_json =
            with_detail_url.then(|| format!(r#"{{"detail_url":"/diecast/x/y/{external_id}"}}"#));
        sqlx::query(
            "INSERT INTO registry_entries
                 (external_id, source, fetched_at, details_fetched_at, raw_json)
             VALUES (?, 'diecastregistry', 1, ?, ?)",
        )
        .bind(external_id)
        .bind(details_fetched_at)
        .bind(raw_json)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    async fn selected_ids(pool: &SqlitePool, force: bool, cap: Option<i64>) -> Vec<String> {
        select_entries_to_enrich(pool, force, CUTOFF, cap)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.1)
            .collect()
    }

    /// A manually-added entry must never enter an enrichment pass — not even
    /// a forced one, which otherwise sweeps every row on file. DCH-12.
    #[tokio::test]
    async fn local_entries_are_never_candidates_for_enrichment() {
        let pool = migrated_pool().await;
        insert_entry(&pool, "dcr-guid", None, true).await;
        // Belt and braces: a local row that somehow *does* carry an
        // external_id still has to be excluded, since the source flag — not
        // the absence of a GUID — is what the guard rests on.
        sqlx::query(
            "INSERT INTO registry_entries (external_id, source, fetched_at, raw_json)
             VALUES ('stray-guid', 'local', 1, '{\"detail_url\":\"/diecast/x/y/stray\"}')",
        )
        .execute(&pool)
        .await
        .unwrap();

        for force in [false, true] {
            let ids = selected_ids(&pool, force, None).await;
            assert_eq!(ids, vec!["dcr-guid"], "force = {force}");
        }
    }

    /// The DCH-53 policy in one scene: referenced entries outrank the
    /// prewarm stubs, stalest first, and the cap cuts from the back.
    #[tokio::test]
    async fn capped_run_selects_referenced_entries_first_oldest_first() {
        let pool = migrated_pool().await;
        // Two unreferenced never-enriched stubs: eligible, but last in line.
        insert_entry(&pool, "stub-a", None, true).await;
        insert_entry(&pool, "stub-b", None, true).await;
        // Referenced entries: one never enriched, two stale of different
        // ages, one fresh.
        let in_collection = insert_entry(&pool, "in-collection", Some(100), true).await;
        let on_wishlist = insert_entry(&pool, "on-wishlist", Some(50), true).await;
        let matched = insert_entry(&pool, "matched", None, true).await;
        let fresh = insert_entry(&pool, "fresh", Some(CUTOFF + 1), true).await;

        sqlx::query("INSERT INTO my_collection (registry_entry_id, imported_at) VALUES (?, 1)")
            .bind(in_collection)
            .execute(&pool)
            .await
            .unwrap();
        // The 0019 migration seeds wishlist id 1.
        sqlx::query(
            "INSERT INTO wishlist_entries (wishlist_id, registry_entry_id, added_at)
             VALUES (1, ?, 1)",
        )
        .bind(on_wishlist)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO listings (seller_id, external_id, url, title, saved_at, last_seen_at)
             VALUES (1, 'lst-1', 'https://example.com', 'a listing', 1, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO listing_matches (listing_id, registry_entry_id, matched_at)
             VALUES ((SELECT id FROM listings WHERE external_id = 'lst-1'), ?, 1)",
        )
        .bind(matched)
        .execute(&pool)
        .await
        .unwrap();
        // A referenced-but-fresh entry stays out entirely.
        sqlx::query("INSERT INTO my_collection (registry_entry_id, imported_at) VALUES (?, 1)")
            .bind(fresh)
            .execute(&pool)
            .await
            .unwrap();

        // Uncapped: every referenced stale entry (never-enriched first, then
        // oldest), then the stubs.
        assert_eq!(
            selected_ids(&pool, false, None).await,
            vec![
                "matched",
                "on-wishlist",
                "in-collection",
                "stub-a",
                "stub-b"
            ],
        );
        // Capped: same order, truncated — the stubs are what gets left for
        // later runs.
        assert_eq!(
            selected_ids(&pool, false, Some(2)).await,
            vec!["matched", "on-wishlist"],
        );
    }

    /// An unreferenced stub is enriched once and then left alone: aging past
    /// the 30-day window no longer re-queues it. That standing re-walk of
    /// the whole prewarm cache is the ~47k-requests/month the ticket exists
    /// to stop. A forced pass still picks it up.
    #[tokio::test]
    async fn unreferenced_enriched_entries_are_not_rerefreshed() {
        let pool = migrated_pool().await;
        insert_entry(&pool, "aged-out-stub", Some(100), true).await;

        assert!(selected_ids(&pool, false, None).await.is_empty());
        assert_eq!(selected_ids(&pool, true, None).await, vec!["aged-out-stub"]);
    }

    /// A row with no detail_url can only ever be skipped by the fetch loop,
    /// and it sorts to the head of the stale queue forever (its
    /// details_fetched_at never advances) — under a cap it would occupy a
    /// slot on every run. It must not be selected at all.
    #[tokio::test]
    async fn rows_without_detail_url_do_not_consume_cap_slots() {
        let pool = migrated_pool().await;
        insert_entry(&pool, "no-url", None, false).await;
        insert_entry(&pool, "has-url", None, true).await;

        assert_eq!(selected_ids(&pool, false, Some(1)).await, vec!["has-url"]);
    }
}
