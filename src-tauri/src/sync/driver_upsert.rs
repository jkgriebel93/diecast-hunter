//! The one driver upsert (DCH-55). Three sync flows used to carry their own
//! private copy, each an INSERT followed by a SELECT — two statements, and
//! in autocommit mode two fsync'd commits — per item, even when a 1,000-car
//! garage only spans 60 distinct drivers. This version is a single
//! `RETURNING id` statement behind a per-run memo.

use std::collections::HashMap;

use sqlx::SqliteConnection;

use crate::error::AppResult;

/// Per-run memo of `normalized_name` → `drivers.id`. Callers create one per
/// sync (not per item) and thread it through, so a driver is written once
/// per run no matter how many items reference it. Deliberately not a global
/// cache: driver ids are stable, but a run-scoped map can't go stale.
pub(crate) type DriverIdCache = HashMap<String, i64>;

/// Upsert one driver row and return its id, consulting `cache` first. On a
/// miss this is exactly one statement — `RETURNING id` covers both the
/// insert and the conflict-update path.
pub(crate) async fn upsert_driver(
    conn: &mut SqliteConnection,
    cache: &mut DriverIdCache,
    name: &str,
    normalized: &str,
) -> AppResult<i64> {
    if let Some(id) = cache.get(normalized) {
        return Ok(*id);
    }
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO drivers (name, normalized_name) VALUES (?, ?)
         ON CONFLICT(normalized_name) DO UPDATE SET name = excluded.name
         RETURNING id",
    )
    .bind(name)
    .bind(normalized)
    .fetch_one(&mut *conn)
    .await?;
    cache.insert(normalized.to_string(), id);
    Ok(id)
}
