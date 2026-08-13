//! Named registry pre-searches (DCH-14).
//!
//! A pre-search is a saved filter combination — "Action 1:24 Elite CWC", say —
//! whose matching registry entries are pulled down ahead of time so the search
//! screen can answer from local rows instead of a multi-page DCR walk.
//!
//! **What gets cached is `registry_entries`, not a result list.** Refreshing a
//! pre-search runs the DCR production search for its filters and upserts every
//! hit through the same [`crate::sync::registry_prewarm::upsert_stubs_batched`]
//! path the by-driver pre-warm uses. That means:
//!
//! - one refresh benefits every pre-search that overlaps it, and the existing
//!   local/hybrid registry search modes get the same rows for free;
//! - there is no second copy of entry data to prune or reconcile;
//! - "filter instantly" is not a new code path — it is the local search that
//!   already exists, now with rows behind it.
//!
//! Refreshes are driven by the overnight auto-sync ([`refresh_stale`]) and by
//! an explicit button. Per-pre-search failures are recorded on the row rather
//! than raised, because the auto-sync is headless and an error thrown there
//! would only reach a log nobody reads.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::dcr::{search_all_pages_with_progress, DcrClient, ProductionSearchFilter};
use crate::error::{AppError, AppResult};
use crate::progress::ProgressEmitter;
use crate::sync::registry_prewarm::{logged_in_client, upsert_stubs_batched};

/// A pre-search whose last refresh is older than this is due for another.
/// Matches `PREWARM_STALE_AFTER_SECONDS` — both walk the same catalog, which
/// changes on the order of weeks, not hours.
pub const PRESEARCH_STALE_AFTER_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

/// Ceiling on pre-searches refreshed in one auto-sync run. Each is a
/// full multi-page DCR walk, so an unbounded loop over a dozen saved searches
/// would turn a quiet overnight sync into a very long one.
pub const MAX_REFRESH_PER_RUN: usize = 3;

#[derive(Debug, Clone, Serialize)]
pub struct Presearch {
    pub id: i64,
    pub name: String,
    pub filter: ProductionSearchFilter,
    pub created_at: i64,
    pub last_refreshed_at: Option<i64>,
    pub last_result_count: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct PresearchRefreshSummary {
    /// Pre-searches past the staleness window when the run started.
    pub stale: u32,
    /// Actually walked this run, bounded by [`MAX_REFRESH_PER_RUN`].
    pub refreshed: u32,
    pub failed: u32,
    pub registry_entries_upserted: u32,
}

#[derive(Debug, Deserialize)]
pub struct PresearchInput {
    pub name: String,
    pub filter: ProductionSearchFilter,
}

#[derive(sqlx::FromRow)]
struct PresearchRaw {
    id: i64,
    name: String,
    filter_json: String,
    created_at: i64,
    last_refreshed_at: Option<i64>,
    last_result_count: Option<i64>,
    last_error: Option<String>,
}

impl PresearchRaw {
    /// A row whose `filter_json` won't parse is surfaced with an empty filter
    /// and an explanatory `last_error` rather than failing the whole list —
    /// one corrupt row shouldn't hide every other saved search.
    fn into_presearch(self) -> Presearch {
        let (filter, parse_error) =
            match serde_json::from_str::<ProductionSearchFilter>(&self.filter_json) {
                Ok(f) => (f, None),
                Err(e) => (
                    ProductionSearchFilter::default(),
                    Some(format!("saved filter could not be read: {e}")),
                ),
            };
        Presearch {
            id: self.id,
            name: self.name,
            filter,
            created_at: self.created_at,
            last_refreshed_at: self.last_refreshed_at,
            last_result_count: self.last_result_count,
            last_error: parse_error.or(self.last_error),
        }
    }
}

const SELECT_COLUMNS: &str = "id, name, filter_json, created_at,
     last_refreshed_at, last_result_count, last_error";

pub async fn list(pool: &SqlitePool) -> AppResult<Vec<Presearch>> {
    let rows: Vec<PresearchRaw> = sqlx::query_as(&format!(
        "SELECT {SELECT_COLUMNS} FROM registry_presearches ORDER BY name COLLATE NOCASE"
    ))
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(PresearchRaw::into_presearch).collect())
}

async fn get(pool: &SqlitePool, id: i64) -> AppResult<Presearch> {
    let row: Option<PresearchRaw> = sqlx::query_as(&format!(
        "SELECT {SELECT_COLUMNS} FROM registry_presearches WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.map(PresearchRaw::into_presearch)
        .ok_or_else(|| AppError::Parse(format!("pre-search {id} not found")))
}

/// Reject a filter that would match the entire catalog. A pre-search is a
/// *narrowing* — saving an empty one would queue a walk of every page on the
/// site during the overnight sync, which is exactly the cost this feature
/// exists to avoid paying repeatedly.
fn validate(name: &str, filter: &ProductionSearchFilter) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::Parse("a pre-search needs a name".into()));
    }
    let has_filter = !filter.driver_guids.is_empty()
        || !filter.years.is_empty()
        || !filter.oem_guids.is_empty()
        || !filter.brand_guids.is_empty()
        || !filter.make_guids.is_empty()
        || !filter.scale_guids.is_empty()
        || !filter.finish_guids.is_empty()
        || filter.autographed
        || filter.raced;
    if !has_filter {
        return Err(AppError::Parse(
            "pick at least one filter — an empty pre-search would re-walk the whole catalog".into(),
        ));
    }
    Ok(())
}

pub async fn create(pool: &SqlitePool, input: PresearchInput) -> AppResult<i64> {
    validate(&input.name, &input.filter)?;
    let filter_json = serde_json::to_string(&input.filter)
        .map_err(|e| AppError::Parse(format!("could not serialize filter: {e}")))?;
    let id = sqlx::query(
        "INSERT INTO registry_presearches (name, filter_json, created_at)
         VALUES (?, ?, ?)",
    )
    .bind(input.name.trim())
    .bind(filter_json)
    .bind(Utc::now().timestamp())
    .execute(pool)
    .await?
    .last_insert_rowid();
    Ok(id)
}

/// Replacing the filter clears the refresh bookkeeping: the recorded count and
/// timestamp describe the *old* filter, and leaving them would claim a cache
/// that was never warmed for these criteria.
pub async fn update(pool: &SqlitePool, id: i64, input: PresearchInput) -> AppResult<()> {
    validate(&input.name, &input.filter)?;
    let filter_json = serde_json::to_string(&input.filter)
        .map_err(|e| AppError::Parse(format!("could not serialize filter: {e}")))?;
    let existing = get(pool, id).await?;
    let filter_changed = serde_json::to_string(&existing.filter).unwrap_or_default() != filter_json;
    if filter_changed {
        sqlx::query(
            "UPDATE registry_presearches
                SET name = ?, filter_json = ?,
                    last_refreshed_at = NULL, last_result_count = NULL, last_error = NULL
              WHERE id = ?",
        )
        .bind(input.name.trim())
        .bind(filter_json)
        .bind(id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query("UPDATE registry_presearches SET name = ? WHERE id = ?")
            .bind(input.name.trim())
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM registry_presearches WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Walk DCR for one pre-search and upsert every hit. Returns entries upserted.
pub async fn refresh_one(pool: &SqlitePool, id: i64, progress: &ProgressEmitter) -> AppResult<u32> {
    let client = logged_in_client(pool).await?;
    let ps = get(pool, id).await?;
    let upserted = refresh_with_client(pool, &client, &ps, progress).await?;
    progress.done(format!(
        "\"{}\" cached: {upserted} entries ready to filter locally.",
        ps.name
    ));
    Ok(upserted)
}

/// The shared walk-and-upsert. Records success or failure on the row either
/// way, so a headless caller doesn't have to.
async fn refresh_with_client(
    pool: &SqlitePool,
    client: &DcrClient,
    ps: &Presearch,
    progress: &ProgressEmitter,
) -> AppResult<u32> {
    progress.step(
        format!("Searching registry for \"{}\"…", ps.name),
        None,
        None,
    );
    let walk = search_all_pages_with_progress(client, &ps.filter, progress, Some(&ps.name)).await;
    let (results, _pages) = match walk {
        Ok(v) => v,
        Err(e) => {
            record_failure(pool, ps.id, &e.to_string()).await;
            return Err(e);
        }
    };

    let seen = results.len() as u32;
    let upserted =
        upsert_stubs_batched(pool, &results, progress, &format!("\"{}\"", ps.name)).await?;

    sqlx::query(
        "UPDATE registry_presearches
            SET last_refreshed_at = ?, last_result_count = ?, last_error = NULL
          WHERE id = ?",
    )
    .bind(Utc::now().timestamp())
    .bind(seen as i64)
    .bind(ps.id)
    .execute(pool)
    .await?;

    Ok(upserted)
}

/// Best-effort: if we can't even record why a refresh failed, log and move on
/// rather than masking the original error with a write error.
async fn record_failure(pool: &SqlitePool, id: i64, message: &str) {
    if let Err(e) = sqlx::query("UPDATE registry_presearches SET last_error = ? WHERE id = ?")
        .bind(message)
        .bind(id)
        .execute(pool)
        .await
    {
        tracing::warn!("presearch: could not record failure for {id}: {e}");
    }
}

/// Re-walk pre-searches whose cache has gone stale, oldest first, up to
/// [`MAX_REFRESH_PER_RUN`]. Never-refreshed ones sort first — a saved search
/// that has never been warmed is the one most worth warming.
///
/// One pre-search failing doesn't stop the rest: each records its own error
/// and the run continues, so a single bad filter can't starve the others.
pub async fn refresh_stale(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
) -> AppResult<PresearchRefreshSummary> {
    let cutoff = Utc::now().timestamp() - PRESEARCH_STALE_AFTER_SECONDS;
    let rows: Vec<PresearchRaw> = sqlx::query_as(&format!(
        "SELECT {SELECT_COLUMNS} FROM registry_presearches
          WHERE last_refreshed_at IS NULL OR last_refreshed_at <= ?
          ORDER BY last_refreshed_at IS NOT NULL, last_refreshed_at"
    ))
    .bind(cutoff)
    .fetch_all(pool)
    .await?;

    let mut summary = PresearchRefreshSummary {
        stale: rows.len() as u32,
        ..Default::default()
    };
    if rows.is_empty() {
        return Ok(summary);
    }

    // Log in once for the whole batch rather than per pre-search.
    let client = logged_in_client(pool).await?;
    for raw in rows.into_iter().take(MAX_REFRESH_PER_RUN) {
        let ps = raw.into_presearch();
        progress.check_cancelled()?;
        match refresh_with_client(pool, &client, &ps, progress).await {
            Ok(n) => {
                summary.refreshed += 1;
                summary.registry_entries_upserted += n;
            }
            Err(e) => {
                summary.failed += 1;
                tracing::warn!("presearch refresh failed for \"{}\": {e}", ps.name);
            }
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    //! Covers the persistence rules that aren't obvious from the schema: what
    //! a filter change does to the cached bookkeeping, and what we refuse to
    //! save at all.
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

    fn filter_with_scale(scale: &str) -> ProductionSearchFilter {
        ProductionSearchFilter {
            scale_guids: vec![scale.to_string()],
            ..Default::default()
        }
    }

    async fn mark_refreshed(pool: &SqlitePool, id: i64) {
        sqlx::query(
            "UPDATE registry_presearches
                SET last_refreshed_at = 1700000000, last_result_count = 312
              WHERE id = ?",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn round_trips_a_filter_through_json() {
        let pool = migrated_pool().await;
        let id = create(
            &pool,
            PresearchInput {
                name: "Elite 1:24".into(),
                filter: ProductionSearchFilter {
                    scale_guids: vec!["scale-guid".into()],
                    brand_guids: vec!["brand-guid".into()],
                    years: vec!["2001".into()],
                    autographed: true,
                    ..Default::default()
                },
            },
        )
        .await
        .unwrap();

        let ps = get(&pool, id).await.unwrap();
        assert_eq!(ps.name, "Elite 1:24");
        assert_eq!(ps.filter.scale_guids, vec!["scale-guid"]);
        assert_eq!(ps.filter.brand_guids, vec!["brand-guid"]);
        assert_eq!(ps.filter.years, vec!["2001"]);
        assert!(ps.filter.autographed);
        assert!(ps.last_refreshed_at.is_none());
    }

    #[tokio::test]
    async fn refuses_a_pre_search_that_matches_everything() {
        let pool = migrated_pool().await;
        let err = create(
            &pool,
            PresearchInput {
                name: "Everything".into(),
                filter: ProductionSearchFilter::default(),
            },
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("at least one filter"),
            "unexpected error: {err}"
        );
        assert!(list(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_a_nameless_pre_search() {
        let pool = migrated_pool().await;
        let err = create(
            &pool,
            PresearchInput {
                name: "   ".into(),
                filter: filter_with_scale("s1"),
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("needs a name"), "was: {err}");
    }

    #[tokio::test]
    async fn changing_the_filter_invalidates_the_cached_bookkeeping() {
        let pool = migrated_pool().await;
        let id = create(
            &pool,
            PresearchInput {
                name: "Elite".into(),
                filter: filter_with_scale("s1"),
            },
        )
        .await
        .unwrap();
        mark_refreshed(&pool, id).await;
        assert!(get(&pool, id).await.unwrap().last_refreshed_at.is_some());

        update(
            &pool,
            id,
            PresearchInput {
                name: "Elite".into(),
                filter: filter_with_scale("s2"),
            },
        )
        .await
        .unwrap();

        // The recorded count described the old filter; keeping it would claim
        // a cache that was never warmed for the new one.
        let ps = get(&pool, id).await.unwrap();
        assert!(ps.last_refreshed_at.is_none());
        assert!(ps.last_result_count.is_none());
    }

    #[tokio::test]
    async fn renaming_alone_keeps_the_cache() {
        let pool = migrated_pool().await;
        let id = create(
            &pool,
            PresearchInput {
                name: "Elite".into(),
                filter: filter_with_scale("s1"),
            },
        )
        .await
        .unwrap();
        mark_refreshed(&pool, id).await;

        update(
            &pool,
            id,
            PresearchInput {
                name: "Elite 1:24".into(),
                filter: filter_with_scale("s1"),
            },
        )
        .await
        .unwrap();

        let ps = get(&pool, id).await.unwrap();
        assert_eq!(ps.name, "Elite 1:24");
        // Same criteria, so the warm cache still describes them.
        assert_eq!(ps.last_result_count, Some(312));
    }

    #[tokio::test]
    async fn never_refreshed_pre_searches_sort_ahead_of_merely_stale_ones() {
        let pool = migrated_pool().await;
        let old = create(
            &pool,
            PresearchInput {
                name: "Stale".into(),
                filter: filter_with_scale("s1"),
            },
        )
        .await
        .unwrap();
        mark_refreshed(&pool, old).await;
        create(
            &pool,
            PresearchInput {
                name: "Never".into(),
                filter: filter_with_scale("s2"),
            },
        )
        .await
        .unwrap();

        // Same ordering refresh_stale uses.
        let order: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM registry_presearches
              WHERE last_refreshed_at IS NULL OR last_refreshed_at <= 1800000000
              ORDER BY last_refreshed_at IS NOT NULL, last_refreshed_at",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            order.into_iter().map(|(n,)| n).collect::<Vec<_>>(),
            vec!["Never", "Stale"]
        );
    }

    #[tokio::test]
    async fn a_corrupt_filter_surfaces_as_an_error_not_a_missing_row() {
        let pool = migrated_pool().await;
        sqlx::query(
            "INSERT INTO registry_presearches (name, filter_json, created_at)
             VALUES ('Broken', '{not json', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let all = list(&pool).await.unwrap();
        assert_eq!(all.len(), 1, "the row must still be listed");
        assert!(all[0]
            .last_error
            .as_deref()
            .unwrap()
            .contains("could not be read"));
    }

    #[tokio::test]
    async fn delete_removes_only_the_named_row() {
        let pool = migrated_pool().await;
        let a = create(
            &pool,
            PresearchInput {
                name: "A".into(),
                filter: filter_with_scale("s1"),
            },
        )
        .await
        .unwrap();
        create(
            &pool,
            PresearchInput {
                name: "B".into(),
                filter: filter_with_scale("s2"),
            },
        )
        .await
        .unwrap();
        delete(&pool, a).await.unwrap();
        let names: Vec<String> = list(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["B"]);
    }
}
