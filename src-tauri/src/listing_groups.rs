//! Named groups of saved listings (many-to-many). See migration
//! `0008_listing_groups.sql` for schema rationale.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct GroupDriver {
    pub id: i64,
    pub name: String,
}

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
    /// Drivers this group is associated with (many-to-many). Empty = the
    /// group is driverless (e.g. a mixed lot) and buckets under "No driver".
    pub drivers: Vec<GroupDriver>,
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
    /// Driver ids to associate. Replaces the group's existing driver set
    /// on update; ignored rows that don't exist surface as an FK error.
    #[serde(default)]
    pub driver_ids: Vec<i64>,
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
            // Filled in by `attach_drivers` after the base rows load.
            drivers: Vec::new(),
        }
    }
}

/// Load the driver associations for the given groups and attach them in
/// place. One query for the whole set, grouped by `group_id` in memory —
/// avoids an N+1 over the group list.
async fn attach_drivers(pool: &SqlitePool, groups: &mut [ListingGroup]) -> AppResult<()> {
    if groups.is_empty() {
        return Ok(());
    }
    let rows: Vec<(i64, i64, String)> = sqlx::query_as(
        "SELECT gd.group_id, d.id, d.name
           FROM group_drivers gd
           JOIN drivers d ON d.id = gd.driver_id
          ORDER BY d.name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;

    let mut by_group: std::collections::HashMap<i64, Vec<GroupDriver>> =
        std::collections::HashMap::new();
    for (group_id, id, name) in rows {
        by_group
            .entry(group_id)
            .or_default()
            .push(GroupDriver { id, name });
    }
    for g in groups.iter_mut() {
        if let Some(ds) = by_group.remove(&g.id) {
            g.drivers = ds;
        }
    }
    Ok(())
}

/// Replace a group's driver associations with `driver_ids` (de-duplicated).
/// Runs inside the caller's transaction. FK violations (unknown driver id)
/// bubble up via `map_fk_violation`.
async fn set_group_drivers(
    tx: &mut sqlx::SqliteConnection,
    group_id: i64,
    driver_ids: &[i64],
) -> AppResult<()> {
    sqlx::query("DELETE FROM group_drivers WHERE group_id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await?;
    let mut seen = std::collections::HashSet::new();
    for &driver_id in driver_ids {
        if !seen.insert(driver_id) {
            continue;
        }
        sqlx::query(
            "INSERT INTO group_drivers (group_id, driver_id) VALUES (?, ?)
             ON CONFLICT(group_id, driver_id) DO NOTHING",
        )
        .bind(group_id)
        .bind(driver_id)
        .execute(&mut *tx)
        .await
        .map_err(map_fk_violation)?;
    }
    Ok(())
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
    let rows = sqlx::query_as::<_, GroupRow>(&sql).fetch_all(pool).await?;
    let mut groups: Vec<ListingGroup> = rows.into_iter().map(Into::into).collect();
    attach_drivers(pool, &mut groups).await?;
    Ok(groups)
}

async fn fetch_group(pool: &SqlitePool, id: i64) -> AppResult<ListingGroup> {
    let sql = format!("SELECT {GROUP_SELECT} FROM listing_groups g WHERE g.id = ?");
    let row = sqlx::query_as::<_, GroupRow>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::Config(format!("no listing group with id {id}")))?;
    let mut groups = vec![ListingGroup::from(row)];
    attach_drivers(pool, &mut groups).await?;
    Ok(groups.into_iter().next().unwrap())
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

pub async fn create_group(pool: &SqlitePool, input: ListingGroupInput) -> AppResult<ListingGroup> {
    let name = clean_name(&input.name)?;
    let description = clean_description(input.description.as_deref());
    let target = normalize_target(input.target_price_cents)?;
    let now = Utc::now().timestamp();

    let mut tx = pool.begin().await?;
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
    .fetch_one(&mut *tx)
    .await?;
    set_group_drivers(&mut tx, id.0, &input.driver_ids).await?;
    tx.commit().await?;

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

    let mut tx = pool.begin().await?;
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
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::Config(format!("no listing group with id {id}")));
    }
    set_group_drivers(&mut tx, id, &input.driver_ids).await?;
    tx.commit().await?;
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

pub async fn add_listing(pool: &SqlitePool, group_id: i64, listing_id: i64) -> AppResult<()> {
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

pub async fn remove_listing(pool: &SqlitePool, group_id: i64, listing_id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM listing_group_members WHERE group_id = ? AND listing_id = ?")
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
    let group_exists: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM listing_groups WHERE id = ?")
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

// --- Driver-prefix name migration ----------------------------------------
//
// Historically groups were named "<driver last name> <group name>", e.g.
// "Zilisch Rookie Year". Now that groups carry real driver associations the
// prefix is redundant clutter. The migration wizard maps each distinct
// prefix ("handle") to a driver, then strips the handle from every matching
// group name and links the driver. `match_prefix` is the testable core.

pub struct PrefixMatch {
    /// The handle that matched, as supplied by the caller.
    pub handle: String,
    /// The group name with the handle (and following whitespace) removed.
    pub rest: String,
}

/// Longest-prefix match of `name` against `handles`. A handle matches only
/// when it is the whole name or is followed by whitespace — so "Burton"
/// won't match inside "Burtons", and "Dale" won't shadow "Dale Jr" (the
/// longer handle wins). Comparison is ASCII-case-insensitive.
pub fn match_prefix(name: &str, handles: &[String]) -> Option<PrefixMatch> {
    // (handle char length, matched handle, remainder)
    let mut best: Option<(usize, String, String)> = None;
    for h in handles {
        let h_trim = h.trim();
        if h_trim.is_empty() {
            continue;
        }
        let h_len = h_trim.chars().count();
        let name_prefix: String = name.chars().take(h_len).collect();
        if name_prefix.chars().count() < h_len {
            continue; // name shorter than the handle
        }
        if !name_prefix.eq_ignore_ascii_case(h_trim) {
            continue;
        }
        let rest: String = name.chars().skip(h_len).collect();
        let boundary_ok = rest.is_empty() || rest.starts_with(char::is_whitespace);
        let longer = best.as_ref().is_none_or(|(bl, _, _)| h_len > *bl);
        if boundary_ok && longer {
            best = Some((h_len, h_trim.to_string(), rest.trim_start().to_string()));
        }
    }
    best.map(|(_, handle, rest)| PrefixMatch { handle, rest })
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupMigrationProposal {
    pub group_id: i64,
    pub original_name: String,
    /// The handle that matched, if any.
    pub matched_handle: Option<String>,
    /// The proposed new name. Falls back to `original_name` when nothing
    /// matched or the match would leave an empty name.
    pub new_name: String,
    /// True when the handle matched but stripping it leaves nothing — the
    /// UI flags these so the user renames manually rather than blanking it.
    pub empty_remainder: bool,
}

/// Run every group name through `match_prefix` and return the proposed
/// rename for each. Pure preview — writes nothing.
pub async fn propose_migration(
    pool: &SqlitePool,
    handles: Vec<String>,
) -> AppResult<Vec<GroupMigrationProposal>> {
    let rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, name FROM listing_groups ORDER BY name COLLATE NOCASE")
            .fetch_all(pool)
            .await?;

    Ok(rows
        .into_iter()
        .map(|(group_id, name)| match match_prefix(&name, &handles) {
            Some(m) => {
                let empty = m.rest.trim().is_empty();
                GroupMigrationProposal {
                    group_id,
                    new_name: if empty { name.clone() } else { m.rest },
                    matched_handle: Some(m.handle),
                    empty_remainder: empty,
                    original_name: name,
                }
            }
            None => GroupMigrationProposal {
                group_id,
                matched_handle: None,
                new_name: name.clone(),
                empty_remainder: false,
                original_name: name,
            },
        })
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupMigrationItem {
    pub group_id: i64,
    pub new_name: String,
    pub driver_ids: Vec<i64>,
}

/// Apply the finalized rename + driver-link for each item in one
/// transaction. Driver ids must already exist (the UI resolves/creates them
/// via `ensure_driver` before calling). Returns the number of groups
/// updated.
pub async fn apply_migration(pool: &SqlitePool, items: Vec<GroupMigrationItem>) -> AppResult<i64> {
    let mut tx = pool.begin().await?;
    let mut count = 0i64;
    for item in &items {
        let name = clean_name(&item.new_name)?;
        let res = sqlx::query("UPDATE listing_groups SET name = ? WHERE id = ?")
            .bind(&name)
            .bind(item.group_id)
            .execute(&mut *tx)
            .await?;
        if res.rows_affected() == 0 {
            return Err(AppError::Config(format!(
                "no listing group with id {}",
                item.group_id
            )));
        }
        set_group_drivers(&mut tx, item.group_id, &item.driver_ids).await?;
        count += 1;
    }
    tx.commit().await?;
    Ok(count)
}

/// FK failures here mean either `group_id` or `listing_id` doesn't exist.
/// Surface a config error rather than the generic "FOREIGN KEY constraint
/// failed" so the UI can show something useful.
fn map_fk_violation(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &e {
        if db_err.message().contains("FOREIGN KEY") {
            return AppError::Config("group or listing no longer exists".into());
        }
    }
    AppError::Db(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handles(hs: &[&str]) -> Vec<String> {
        hs.iter().map(|s| s.to_string()).collect()
    }

    fn matched(name: &str, hs: &[&str]) -> Option<(String, String)> {
        match_prefix(name, &handles(hs)).map(|m| (m.handle, m.rest))
    }

    #[test]
    fn matches_simple_last_name() {
        assert_eq!(
            matched("Zilisch Rookie Year", &["Zilisch"]),
            Some(("Zilisch".into(), "Rookie Year".into()))
        );
    }

    #[test]
    fn longest_handle_wins() {
        // "Dale Jr" must beat the shorter "Dale" so the remainder is correct.
        let hs = ["Dale", "Dale Jr", "Dale Sr"];
        assert_eq!(
            matched("Dale Jr Throwback", &hs),
            Some(("Dale Jr".into(), "Throwback".into()))
        );
        assert_eq!(
            matched("Dale Sr Wins", &hs),
            Some(("Dale Sr".into(), "Wins".into()))
        );
    }

    #[test]
    fn initials_and_aliases() {
        assert_eq!(
            matched("DW Pepsi", &["DW"]),
            Some(("DW".into(), "Pepsi".into()))
        );
        assert_eq!(
            matched("J Burton Diecast", &["J Burton", "W Burton", "Burton"]),
            Some(("J Burton".into(), "Diecast".into()))
        );
    }

    #[test]
    fn handle_must_be_followed_by_whitespace() {
        // "Burton" should not match the start of "Burtons".
        assert_eq!(matched("Burtons Best", &["Burton"]), None);
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(
            matched("zilisch rookie", &["Zilisch"]),
            Some(("Zilisch".into(), "rookie".into()))
        );
    }

    #[test]
    fn whole_name_is_handle_yields_empty_remainder() {
        assert_eq!(
            matched("Zilisch", &["Zilisch"]),
            Some(("Zilisch".into(), "".into()))
        );
    }

    #[test]
    fn no_match_returns_none() {
        assert_eq!(matched("Lots", &["Zilisch", "DW"]), None);
    }

    // --- DB-backed tests (exercise migrations through 0012) ---------------

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

    async fn insert_driver(pool: &SqlitePool, name: &str, norm: &str) -> i64 {
        sqlx::query("INSERT INTO drivers (name, normalized_name) VALUES (?, ?)")
            .bind(name)
            .bind(norm)
            .execute(pool)
            .await
            .unwrap();
        let (id,): (i64,) = sqlx::query_as("SELECT id FROM drivers WHERE normalized_name = ?")
            .bind(norm)
            .fetch_one(pool)
            .await
            .unwrap();
        id
    }

    fn input(name: &str, driver_ids: Vec<i64>) -> ListingGroupInput {
        ListingGroupInput {
            name: name.into(),
            description: None,
            target_price_cents: None,
            archived: false,
            driver_ids,
        }
    }

    #[tokio::test]
    async fn duplicate_names_allowed_after_unique_drop() {
        // The whole point of migration 0012: two groups may share a name.
        let pool = migrated_pool().await;
        let a = create_group(&pool, input("Rookie Year", vec![]))
            .await
            .unwrap();
        let b = create_group(&pool, input("Rookie Year", vec![]))
            .await
            .unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(list_groups(&pool).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn group_drivers_link_and_cascade_survive_rebuild() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Connor Zilisch", "connor-zilisch").await;
        let g = create_group(&pool, input("Rookie Year", vec![driver]))
            .await
            .unwrap();
        assert_eq!(g.drivers.len(), 1);
        assert_eq!(g.drivers[0].id, driver);

        // Association reads back through list_groups.
        let listed = list_groups(&pool).await.unwrap();
        let reloaded = listed.iter().find(|x| x.id == g.id).unwrap();
        assert_eq!(reloaded.drivers.len(), 1);

        // Deleting the group cascades through the FK rebuilt by 0012; the
        // driver row itself is untouched.
        delete_group(&pool, g.id).await.unwrap();
        let (gd,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM group_drivers WHERE group_id = ?")
            .bind(g.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(gd, 0);
        let (dcnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM drivers WHERE id = ?")
            .bind(driver)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dcnt, 1);
    }

    #[tokio::test]
    async fn update_replaces_driver_set() {
        let pool = migrated_pool().await;
        let d1 = insert_driver(&pool, "Connor Zilisch", "connor-zilisch").await;
        let d2 = insert_driver(&pool, "Jeff Gordon", "jeff-gordon").await;
        let g = create_group(&pool, input("Theme", vec![d1])).await.unwrap();
        let updated = update_group(&pool, g.id, input("Theme", vec![d2]))
            .await
            .unwrap();
        assert_eq!(updated.drivers.len(), 1);
        assert_eq!(updated.drivers[0].id, d2);
    }

    #[tokio::test]
    async fn apply_migration_renames_and_links() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Connor Zilisch", "connor-zilisch").await;
        let g = create_group(&pool, input("Zilisch Rookie Year", vec![]))
            .await
            .unwrap();
        let n = apply_migration(
            &pool,
            vec![GroupMigrationItem {
                group_id: g.id,
                new_name: "Rookie Year".into(),
                driver_ids: vec![driver],
            }],
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let reloaded = fetch_group(&pool, g.id).await.unwrap();
        assert_eq!(reloaded.name, "Rookie Year");
        assert_eq!(reloaded.drivers.len(), 1);
        assert_eq!(reloaded.drivers[0].id, driver);
    }
}
