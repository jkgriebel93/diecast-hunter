//! User-curated saved searches and saved sellers, persisted to SQLite.
//!
//! These are pure storage + CRUD helpers; the eBay-side fan-out (running a
//! saved search, building the seller feed) lives next to the rest of the
//! Browse-API plumbing in `crate::ebay::search` and is wired up in
//! `crate::commands`.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct SavedSearch {
    pub id: i64,
    pub name: String,
    pub query: String,
    pub conditions: Vec<String>,
    pub buying_options: Vec<String>,
    pub sellers: Vec<String>,
    pub price_min_cents: Option<i64>,
    pub price_max_cents: Option<i64>,
    pub sort: Option<String>,
    pub created_at: i64,
    pub last_run_at: Option<i64>,
    /// True when this row was pulled from eBay (Trading API). Locally-added
    /// rows are origin=false and are never pruned by a sync.
    pub ebay_origin: bool,
    pub ebay_external_id: Option<String>,
    pub last_synced_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SavedSearchInput {
    pub name: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub conditions: Vec<String>,
    #[serde(default)]
    pub buying_options: Vec<String>,
    #[serde(default)]
    pub sellers: Vec<String>,
    pub price_min_cents: Option<i64>,
    pub price_max_cents: Option<i64>,
    pub sort: Option<String>,
}

const SEARCH_COLUMNS: &str = "id, name, query, conditions_json, buying_options_json, sellers_json,
     price_min_cents, price_max_cents, sort, created_at, last_run_at,
     ebay_origin, ebay_external_id, last_synced_at";

pub async fn list_searches(pool: &SqlitePool) -> AppResult<Vec<SavedSearch>> {
    let sql = format!(
        "SELECT {SEARCH_COLUMNS}
           FROM saved_searches
          ORDER BY name COLLATE NOCASE"
    );
    let rows = sqlx::query_as::<_, SavedSearchRow>(&sql)
        .fetch_all(pool)
        .await?;
    rows.into_iter().map(SavedSearchRow::into_model).collect()
}

pub async fn get_search(pool: &SqlitePool, id: i64) -> AppResult<SavedSearch> {
    let sql = format!("SELECT {SEARCH_COLUMNS} FROM saved_searches WHERE id = ?");
    let row = sqlx::query_as::<_, SavedSearchRow>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::Config(format!("no saved search with id {id}")))?;
    row.into_model()
}

pub async fn create_search(pool: &SqlitePool, input: SavedSearchInput) -> AppResult<SavedSearch> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::Config("saved search name is required".into()));
    }
    let now = Utc::now().timestamp();
    let conditions = serialize_strings(&input.conditions)?;
    let buying = serialize_strings(&input.buying_options)?;
    let sellers = serialize_strings(&normalize_sellers(&input.sellers))?;

    let sql = format!(
        "INSERT INTO saved_searches
            (name, query, conditions_json, buying_options_json, sellers_json,
             price_min_cents, price_max_cents, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING {SEARCH_COLUMNS}"
    );
    let row = sqlx::query_as::<_, SavedSearchRow>(&sql)
        .bind(name)
        .bind(input.query.trim())
        .bind(conditions)
        .bind(buying)
        .bind(sellers)
        .bind(input.price_min_cents)
        .bind(input.price_max_cents)
        .bind(
            input
                .sort
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
        )
        .bind(now)
        .fetch_one(pool)
        .await?;
    row.into_model()
}

pub async fn update_search(
    pool: &SqlitePool,
    id: i64,
    input: SavedSearchInput,
) -> AppResult<SavedSearch> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::Config("saved search name is required".into()));
    }
    let conditions = serialize_strings(&input.conditions)?;
    let buying = serialize_strings(&input.buying_options)?;
    let sellers = serialize_strings(&normalize_sellers(&input.sellers))?;

    let sql = format!(
        "UPDATE saved_searches
            SET name = ?, query = ?, conditions_json = ?, buying_options_json = ?,
                sellers_json = ?, price_min_cents = ?, price_max_cents = ?, sort = ?
          WHERE id = ?
         RETURNING {SEARCH_COLUMNS}"
    );
    let row = sqlx::query_as::<_, SavedSearchRow>(&sql)
        .bind(name)
        .bind(input.query.trim())
        .bind(conditions)
        .bind(buying)
        .bind(sellers)
        .bind(input.price_min_cents)
        .bind(input.price_max_cents)
        .bind(
            input
                .sort
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
        )
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::Config(format!("no saved search with id {id}")))?;
    row.into_model()
}

pub async fn delete_search(pool: &SqlitePool, id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM saved_searches WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn mark_search_ran(pool: &SqlitePool, id: i64) -> AppResult<()> {
    let now = Utc::now().timestamp();
    sqlx::query("UPDATE saved_searches SET last_run_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct SavedSeller {
    pub id: i64,
    pub seller_code: String,
    pub username: String,
    pub display_name: Option<String>,
    pub notes: Option<String>,
    pub created_at: i64,
    pub ebay_origin: bool,
    pub last_synced_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SavedSellerInput {
    #[serde(default = "default_seller_code")]
    pub seller_code: String,
    pub username: String,
    pub display_name: Option<String>,
    pub notes: Option<String>,
}

fn default_seller_code() -> String {
    "ebay".to_string()
}

const SELLER_COLUMNS: &str = "id, seller_code, username, display_name, notes, created_at,
     ebay_origin, last_synced_at";

pub async fn list_sellers(pool: &SqlitePool) -> AppResult<Vec<SavedSeller>> {
    let sql = format!(
        "SELECT {SELLER_COLUMNS} FROM saved_sellers
          ORDER BY username COLLATE NOCASE"
    );
    let rows: Vec<SavedSellerRow> = sqlx::query_as(&sql).fetch_all(pool).await?;
    Ok(rows.into_iter().map(SavedSellerRow::into_model).collect())
}

pub async fn add_seller(pool: &SqlitePool, input: SavedSellerInput) -> AppResult<SavedSeller> {
    let username = input.username.trim();
    if username.is_empty() {
        return Err(AppError::Config("seller username is required".into()));
    }
    let seller_code = if input.seller_code.trim().is_empty() {
        "ebay".to_string()
    } else {
        input.seller_code.trim().to_string()
    };
    let username_lower = username.to_lowercase();
    let now = Utc::now().timestamp();
    let display = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let notes = input
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // Upsert so re-adding an existing seller updates display/notes without
    // erroring out.
    let sql = format!(
        "INSERT INTO saved_sellers
            (seller_code, username, username_lower, display_name, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(seller_code, username_lower) DO UPDATE SET
             username = excluded.username,
             display_name = COALESCE(excluded.display_name, saved_sellers.display_name),
             notes = COALESCE(excluded.notes, saved_sellers.notes)
         RETURNING {SELLER_COLUMNS}"
    );
    let row: SavedSellerRow = sqlx::query_as(&sql)
        .bind(&seller_code)
        .bind(username)
        .bind(&username_lower)
        .bind(display)
        .bind(notes)
        .bind(now)
        .fetch_one(pool)
        .await?;
    Ok(row.into_model())
}

pub async fn update_seller(
    pool: &SqlitePool,
    id: i64,
    input: SavedSellerInput,
) -> AppResult<SavedSeller> {
    let username = input.username.trim();
    if username.is_empty() {
        return Err(AppError::Config("seller username is required".into()));
    }
    let username_lower = username.to_lowercase();
    let display = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let notes = input
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let sql = format!(
        "UPDATE saved_sellers
            SET username = ?, username_lower = ?, display_name = ?, notes = ?
          WHERE id = ?
         RETURNING {SELLER_COLUMNS}"
    );
    let row: SavedSellerRow = sqlx::query_as(&sql)
        .bind(username)
        .bind(&username_lower)
        .bind(display)
        .bind(notes)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::Config(format!("no saved seller with id {id}")))?;
    Ok(row.into_model())
}

pub async fn remove_seller(pool: &SqlitePool, id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM saved_sellers WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Input payload for sync-from-eBay flows. Distinct from
/// `SavedSearchInput` so we can require the eBay-side identifier and stamp
/// `ebay_origin` / `last_synced_at` from a single code path.
#[derive(Debug, Clone, Default)]
pub struct EbaySavedSearchUpsert {
    pub ebay_external_id: String,
    pub name: String,
    pub query: String,
    pub conditions: Vec<String>,
    pub buying_options: Vec<String>,
    pub sellers: Vec<String>,
    pub price_min_cents: Option<i64>,
    pub price_max_cents: Option<i64>,
    pub sort: Option<String>,
}

/// Upsert a saved search pulled from eBay. Re-runs against an existing row
/// preserve the local `id` so anything referencing it (last_run_at, etc.)
/// stays intact. Returns the row id.
pub async fn upsert_search_from_ebay(
    pool: &SqlitePool,
    input: &EbaySavedSearchUpsert,
    synced_at: i64,
) -> AppResult<i64> {
    let conditions = serialize_strings(&input.conditions)?;
    let buying = serialize_strings(&input.buying_options)?;
    let sellers = serialize_strings(&normalize_sellers(&input.sellers))?;
    let sort = input
        .sort
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // `ON CONFLICT(ebay_external_id) WHERE ebay_external_id IS NOT NULL`
    // mirrors the partial unique index from migration 0007. SQLite refuses
    // to bind to a partial index unless the upsert's WHERE clause is
    // verbatim — without it you get "ON CONFLICT clause does not match any
    // PRIMARY KEY or UNIQUE constraint".
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO saved_searches
            (name, query, conditions_json, buying_options_json, sellers_json,
             price_min_cents, price_max_cents, sort, created_at,
             ebay_origin, ebay_external_id, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(ebay_external_id) WHERE ebay_external_id IS NOT NULL
         DO UPDATE SET
             name = excluded.name,
             query = excluded.query,
             conditions_json = excluded.conditions_json,
             buying_options_json = excluded.buying_options_json,
             sellers_json = excluded.sellers_json,
             price_min_cents = excluded.price_min_cents,
             price_max_cents = excluded.price_max_cents,
             sort = excluded.sort,
             ebay_origin = 1,
             last_synced_at = excluded.last_synced_at
         RETURNING id",
    )
    .bind(input.name.trim())
    .bind(input.query.trim())
    .bind(conditions)
    .bind(buying)
    .bind(sellers)
    .bind(input.price_min_cents)
    .bind(input.price_max_cents)
    .bind(sort)
    .bind(synced_at)
    .bind(&input.ebay_external_id)
    .bind(synced_at)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// Delete every saved search where `ebay_origin = 1` whose
/// `ebay_external_id` isn't in the seen set. Locally-added rows are never
/// touched. Returns the count deleted.
pub async fn prune_searches_not_in(
    pool: &SqlitePool,
    seen_ebay_ids: &std::collections::HashSet<String>,
) -> AppResult<u32> {
    let rows: Vec<(i64, Option<String>)> =
        sqlx::query_as("SELECT id, ebay_external_id FROM saved_searches WHERE ebay_origin = 1")
            .fetch_all(pool)
            .await?;
    let mut to_delete = Vec::new();
    for (id, ext) in rows {
        match ext {
            Some(ext) if seen_ebay_ids.contains(&ext) => {}
            _ => to_delete.push(id),
        }
    }
    if to_delete.is_empty() {
        return Ok(0);
    }
    let mut tx = pool.begin().await?;
    for id in &to_delete {
        sqlx::query("DELETE FROM saved_searches WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(to_delete.len() as u32)
}

/// Upsert a favorited eBay seller pulled from a sync. Keyed on lowercased
/// username. Doesn't clobber a locally-added row's display_name/notes — if
/// the row already exists we just flip `ebay_origin = 1` and stamp
/// `last_synced_at` so future prunes know it's eBay-backed.
pub async fn upsert_seller_from_ebay(
    pool: &SqlitePool,
    username: &str,
    display_name: Option<&str>,
    synced_at: i64,
) -> AppResult<i64> {
    let username = username.trim();
    if username.is_empty() {
        return Err(AppError::Config("seller username is required".into()));
    }
    let username_lower = username.to_lowercase();
    let display = display_name.map(str::trim).filter(|s| !s.is_empty());
    // Only fill display_name on insert (so we don't clobber the user's
    // custom label on re-sync). Always flip ebay_origin and stamp
    // last_synced_at.
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO saved_sellers
            (seller_code, username, username_lower, display_name, created_at,
             ebay_origin, last_synced_at)
         VALUES ('ebay', ?, ?, ?, ?, 1, ?)
         ON CONFLICT(seller_code, username_lower) DO UPDATE SET
             username = excluded.username,
             display_name = COALESCE(saved_sellers.display_name, excluded.display_name),
             ebay_origin = 1,
             last_synced_at = excluded.last_synced_at
         RETURNING id",
    )
    .bind(username)
    .bind(&username_lower)
    .bind(display)
    .bind(synced_at)
    .bind(synced_at)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// Delete every `ebay_origin = 1` saved seller whose lowercased username
/// isn't in the seen set.
pub async fn prune_sellers_not_in(
    pool: &SqlitePool,
    seen_usernames_lower: &std::collections::HashSet<String>,
) -> AppResult<u32> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, username_lower FROM saved_sellers
          WHERE seller_code = 'ebay' AND ebay_origin = 1",
    )
    .fetch_all(pool)
    .await?;
    let mut to_delete = Vec::new();
    for (id, lower) in rows {
        if !seen_usernames_lower.contains(&lower) {
            to_delete.push(id);
        }
    }
    if to_delete.is_empty() {
        return Ok(0);
    }
    let mut tx = pool.begin().await?;
    for id in &to_delete {
        sqlx::query("DELETE FROM saved_sellers WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(to_delete.len() as u32)
}

pub async fn list_seller_usernames(pool: &SqlitePool) -> AppResult<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT username FROM saved_sellers WHERE seller_code = 'ebay'
          ORDER BY username COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(u,)| u).collect())
}

#[derive(sqlx::FromRow)]
struct SavedSearchRow {
    id: i64,
    name: String,
    query: String,
    conditions_json: String,
    buying_options_json: String,
    sellers_json: String,
    price_min_cents: Option<i64>,
    price_max_cents: Option<i64>,
    sort: Option<String>,
    created_at: i64,
    last_run_at: Option<i64>,
    ebay_origin: i64,
    ebay_external_id: Option<String>,
    last_synced_at: Option<i64>,
}

impl SavedSearchRow {
    fn into_model(self) -> AppResult<SavedSearch> {
        Ok(SavedSearch {
            id: self.id,
            name: self.name,
            query: self.query,
            conditions: parse_strings(&self.conditions_json)?,
            buying_options: parse_strings(&self.buying_options_json)?,
            sellers: parse_strings(&self.sellers_json)?,
            price_min_cents: self.price_min_cents,
            price_max_cents: self.price_max_cents,
            sort: self.sort,
            created_at: self.created_at,
            last_run_at: self.last_run_at,
            ebay_origin: self.ebay_origin != 0,
            ebay_external_id: self.ebay_external_id,
            last_synced_at: self.last_synced_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct SavedSellerRow {
    id: i64,
    seller_code: String,
    username: String,
    display_name: Option<String>,
    notes: Option<String>,
    created_at: i64,
    ebay_origin: i64,
    last_synced_at: Option<i64>,
}

impl SavedSellerRow {
    fn into_model(self) -> SavedSeller {
        SavedSeller {
            id: self.id,
            seller_code: self.seller_code,
            username: self.username,
            display_name: self.display_name,
            notes: self.notes,
            created_at: self.created_at,
            ebay_origin: self.ebay_origin != 0,
            last_synced_at: self.last_synced_at,
        }
    }
}

fn parse_strings(s: &str) -> AppResult<Vec<String>> {
    serde_json::from_str(s).map_err(|e| AppError::Parse(format!("saved-search json: {e}")))
}

fn serialize_strings(values: &[String]) -> AppResult<String> {
    serde_json::to_string(values).map_err(|e| AppError::Parse(format!("saved-search json: {e}")))
}

/// Trim and dedup (case-insensitive) the seller list provided by the user.
fn normalize_sellers(raw: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for s in raw {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if seen.insert(key) {
            out.push(trimmed.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    //! Regression tests for the sync upsert SQL. Both upserts depend on
    //! either a UNIQUE constraint (sellers) or a partial unique index
    //! (searches); these tests catch the failure mode where the upsert's
    //! `ON CONFLICT(...)` target doesn't bind to the underlying index and
    //! SQLite refuses with "ON CONFLICT clause does not match any PRIMARY
    //! KEY or UNIQUE constraint".
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

    #[tokio::test]
    async fn search_upsert_is_idempotent() {
        let pool = migrated_pool().await;
        let input = EbaySavedSearchUpsert {
            ebay_external_id: "1001".into(),
            name: "Test".into(),
            query: "test query".into(),
            conditions: vec!["NEW".into()],
            buying_options: vec!["FIXED_PRICE".into()],
            sellers: vec![],
            price_min_cents: Some(1000),
            price_max_cents: Some(5000),
            sort: Some("newlyListed".into()),
        };
        let id1 = upsert_search_from_ebay(&pool, &input, 100).await.unwrap();
        // Second upsert with the same ebay_external_id should hit ON CONFLICT
        // and return the same row id.
        let mut updated = input.clone();
        updated.name = "Renamed on eBay".into();
        let id2 = upsert_search_from_ebay(&pool, &updated, 200).await.unwrap();
        assert_eq!(id1, id2, "upsert should return the same row id");

        // And the update path actually wrote the new fields.
        let row = get_search(&pool, id1).await.unwrap();
        assert_eq!(row.name, "Renamed on eBay");
        assert_eq!(row.last_synced_at, Some(200));
        assert!(row.ebay_origin);
    }

    #[tokio::test]
    async fn seller_upsert_is_idempotent() {
        let pool = migrated_pool().await;
        let id1 = upsert_seller_from_ebay(&pool, "TestUser", Some("Test store"), 100)
            .await
            .unwrap();
        // Case-insensitive dedup on username.
        let id2 = upsert_seller_from_ebay(&pool, "testuser", None, 200)
            .await
            .unwrap();
        assert_eq!(id1, id2);
    }

    #[tokio::test]
    async fn prune_only_touches_ebay_origin_rows() {
        let pool = migrated_pool().await;
        // Synced from eBay → eligible for prune.
        upsert_seller_from_ebay(&pool, "kept", None, 1)
            .await
            .unwrap();
        upsert_seller_from_ebay(&pool, "dropped", None, 1)
            .await
            .unwrap();
        // Locally added → must NOT be pruned.
        let _ = add_seller(
            &pool,
            SavedSellerInput {
                seller_code: "ebay".into(),
                username: "local_only".into(),
                display_name: None,
                notes: None,
            },
        )
        .await
        .unwrap();

        let mut seen = std::collections::HashSet::new();
        seen.insert("kept".to_string());
        let pruned = prune_sellers_not_in(&pool, &seen).await.unwrap();
        assert_eq!(
            pruned, 1,
            "only ebay-origin row missing from the set is pruned"
        );

        let names: Vec<String> = list_sellers(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.username)
            .collect();
        assert!(names.contains(&"kept".to_string()));
        assert!(names.contains(&"local_only".to_string()));
        assert!(!names.contains(&"dropped".to_string()));
    }
}
