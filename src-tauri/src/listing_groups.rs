//! Named groups of saved listings (many-to-many). See migration
//! `0008_listing_groups.sql` for schema rationale.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct ListingGroup {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub target_price_cents: Option<i64>,
    pub archived: bool,
    pub created_at: i64,
    /// Distinct listings currently in the group.
    pub member_count: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListingGroupInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub target_price_cents: Option<i64>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(sqlx::FromRow)]
struct GroupRow {
    id: i64,
    name: String,
    description: Option<String>,
    target_price_cents: Option<i64>,
    archived: i64,
    created_at: i64,
    member_count: i64,
}

impl From<GroupRow> for ListingGroup {
    fn from(r: GroupRow) -> Self {
        ListingGroup {
            id: r.id,
            name: r.name,
            description: r.description,
            target_price_cents: r.target_price_cents,
            archived: r.archived != 0,
            created_at: r.created_at,
            member_count: r.member_count,
        }
    }
}

const GROUP_SELECT: &str = "g.id, g.name, g.description, g.target_price_cents,
    g.archived, g.created_at,
    (SELECT COUNT(*) FROM listing_group_members m WHERE m.group_id = g.id) AS member_count";

pub async fn list_groups(pool: &SqlitePool) -> AppResult<Vec<ListingGroup>> {
    let sql = format!(
        "SELECT {GROUP_SELECT}
           FROM listing_groups g
          ORDER BY g.archived ASC, g.name COLLATE NOCASE"
    );
    let rows = sqlx::query_as::<_, GroupRow>(&sql)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

async fn fetch_group(pool: &SqlitePool, id: i64) -> AppResult<ListingGroup> {
    let sql = format!(
        "SELECT {GROUP_SELECT} FROM listing_groups g WHERE g.id = ?"
    );
    let row = sqlx::query_as::<_, GroupRow>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::Config(format!("no listing group with id {id}")))?;
    Ok(row.into())
}

fn clean_name(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Config("group name is required".into()));
    }
    Ok(trimmed.to_string())
}

fn clean_description(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn normalize_target(cents: Option<i64>) -> AppResult<Option<i64>> {
    match cents {
        Some(c) if c < 0 => Err(AppError::Config(
            "target price must be zero or positive".into(),
        )),
        other => Ok(other),
    }
}

pub async fn create_group(
    pool: &SqlitePool,
    input: ListingGroupInput,
) -> AppResult<ListingGroup> {
    let name = clean_name(&input.name)?;
    let description = clean_description(input.description.as_deref());
    let target = normalize_target(input.target_price_cents)?;
    let now = Utc::now().timestamp();

    let id: (i64,) = sqlx::query_as(
        "INSERT INTO listing_groups
            (name, description, target_price_cents, archived, created_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(&name)
    .bind(&description)
    .bind(target)
    .bind(if input.archived { 1 } else { 0 })
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(map_unique_name)?;

    fetch_group(pool, id.0).await
}

pub async fn update_group(
    pool: &SqlitePool,
    id: i64,
    input: ListingGroupInput,
) -> AppResult<ListingGroup> {
    let name = clean_name(&input.name)?;
    let description = clean_description(input.description.as_deref());
    let target = normalize_target(input.target_price_cents)?;

    let affected = sqlx::query(
        "UPDATE listing_groups
            SET name = ?,
                description = ?,
                target_price_cents = ?,
                archived = ?
          WHERE id = ?",
    )
    .bind(&name)
    .bind(&description)
    .bind(target)
    .bind(if input.archived { 1 } else { 0 })
    .bind(id)
    .execute(pool)
    .await
    .map_err(map_unique_name)?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::Config(format!("no listing group with id {id}")));
    }
    fetch_group(pool, id).await
}

pub async fn delete_group(pool: &SqlitePool, id: i64) -> AppResult<()> {
    let affected = sqlx::query("DELETE FROM listing_groups WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::Config(format!("no listing group with id {id}")));
    }
    Ok(())
}

pub async fn add_listing(
    pool: &SqlitePool,
    group_id: i64,
    listing_id: i64,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO listing_group_members (group_id, listing_id, added_at)
         VALUES (?, ?, ?)
         ON CONFLICT(group_id, listing_id) DO NOTHING",
    )
    .bind(group_id)
    .bind(listing_id)
    .bind(now)
    .execute(pool)
    .await
    .map_err(map_fk_violation)?;
    Ok(())
}

pub async fn remove_listing(
    pool: &SqlitePool,
    group_id: i64,
    listing_id: i64,
) -> AppResult<()> {
    sqlx::query(
        "DELETE FROM listing_group_members WHERE group_id = ? AND listing_id = ?",
    )
    .bind(group_id)
    .bind(listing_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct BulkAddResult {
    /// Rows that were newly inserted.
    pub added: i64,
    /// Listings that were already in the group — skipped via ON CONFLICT.
    pub already_present: i64,
}

/// Insert multiple listings into a group in a single transaction. Skips
/// rows that are already in the group (without erroring), and validates
/// that the group exists up front so an empty `listing_ids` still returns
/// a meaningful error when called against a stale group id.
pub async fn add_listings(
    pool: &SqlitePool,
    group_id: i64,
    listing_ids: &[i64],
) -> AppResult<BulkAddResult> {
    let group_exists: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM listing_groups WHERE id = ?")
            .bind(group_id)
            .fetch_one(pool)
            .await?;
    if group_exists.0 == 0 {
        return Err(AppError::Config(format!(
            "no listing group with id {group_id}"
        )));
    }
    if listing_ids.is_empty() {
        return Ok(BulkAddResult {
            added: 0,
            already_present: 0,
        });
    }

    let now = Utc::now().timestamp();
    let mut tx = pool.begin().await?;
    let mut added: i64 = 0;
    for &listing_id in listing_ids {
        let res = sqlx::query(
            "INSERT INTO listing_group_members (group_id, listing_id, added_at)
             VALUES (?, ?, ?)
             ON CONFLICT(group_id, listing_id) DO NOTHING",
        )
        .bind(group_id)
        .bind(listing_id)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(map_fk_violation)?;
        added += res.rows_affected() as i64;
    }
    tx.commit().await?;

    Ok(BulkAddResult {
        added,
        already_present: (listing_ids.len() as i64) - added,
    })
}

/// Remove multiple listings from a group in a single transaction. Missing
/// memberships are silently skipped — the goal is "make sure none of these
/// are in the group anymore," not "fail if some weren't."
pub async fn remove_listings(
    pool: &SqlitePool,
    group_id: i64,
    listing_ids: &[i64],
) -> AppResult<i64> {
    if listing_ids.is_empty() {
        return Ok(0);
    }
    let mut tx = pool.begin().await?;
    let mut removed: i64 = 0;
    for &listing_id in listing_ids {
        let res = sqlx::query(
            "DELETE FROM listing_group_members
              WHERE group_id = ? AND listing_id = ?",
        )
        .bind(group_id)
        .bind(listing_id)
        .execute(&mut *tx)
        .await?;
        removed += res.rows_affected() as i64;
    }
    tx.commit().await?;
    Ok(removed)
}

/// Translate the sqlite UNIQUE-violation that fires when two groups would
/// share a name into a friendlier message.
fn map_unique_name(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &e {
        let msg = db_err.message();
        if msg.contains("UNIQUE") && msg.contains("listing_groups.name") {
            return AppError::Config(
                "a group with that name already exists".into(),
            );
        }
    }
    AppError::Db(e)
}

/// FK failures here mean either `group_id` or `listing_id` doesn't exist.
/// Surface a config error rather than the generic "FOREIGN KEY constraint
/// failed" so the UI can show something useful.
fn map_fk_violation(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &e {
        if db_err.message().contains("FOREIGN KEY") {
            return AppError::Config(
                "group or listing no longer exists".into(),
            );
        }
    }
    AppError::Db(e)
}
