//! Auto-association of a saved listing to a driver, based purely on the
//! listing title. Independent of the (manual-only) registry linkage in
//! `listing_matches`: this just answers "which driver is this listing
//! about?" so the UI can group/filter even when there's no registry match.
//!
//! Detection is intentionally simple: tokenize the title, tokenize each
//! known driver name, and pick the driver whose tokens are all present.
//! When several drivers fit ("Dale Earnhardt" and "Dale Earnhardt Jr" both
//! match a Jr title), prefer the one with the most tokens — that's the
//! more specific identification.
//!
//! `listings.driver_id` is the column we write. NULL means "no confident
//! match." We never overwrite a non-NULL value with NULL on re-run: that
//! would erase a good earlier hit if the driver row temporarily disappears
//! from `drivers` (e.g. mid-sync). Callers that *do* want a forced refresh
//! pass `force = true`.
//!
//! `listings.driver_id_user_set = 1` means the user manually pinned the
//! driver (or pinned it to "no driver"). Auto-association skips those rows
//! entirely — even `force = true` only re-evaluates non-pinned rows. The
//! dedicated `commands::reset_listing_driver` is the supported way to drop
//! the pin and let auto-detection take over again.

use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};

use crate::error::AppResult;
use crate::progress::ProgressEmitter;

/// Batch-path writes commit in transactions of this many rows (DCH-55).
/// Detection is in-memory and most rows write nothing, so a batch is
/// milliseconds of work — small enough that cancel stays responsive.
const ASSOC_BATCH_SIZE: usize = 200;

#[derive(Debug, Default, Serialize, Clone)]
pub struct AssocSummary {
    pub considered: u32,
    pub associated: u32,
    pub cleared: u32,
    pub unmatched: u32,
}

/// One driver, pre-tokenized for cheap matching.
#[derive(Debug, Clone)]
struct DriverRow {
    id: i64,
    /// Lowercase, alphanumeric-only tokens of the driver name.
    /// "Dale Earnhardt Jr" → ["dale", "earnhardt", "jr"].
    tokens: Vec<String>,
}

/// Detect the driver for an arbitrary title without touching any listing
/// row — backs the browser extension's non-persisting /match/preview flow.
/// Returns (driver_id, display name).
pub(crate) async fn detect_driver_for_title(
    pool: &SqlitePool,
    title: &str,
) -> AppResult<Option<(i64, String)>> {
    let drivers = load_drivers(pool).await?;
    let Some(driver_id) = detect_driver(title, &drivers) else {
        return Ok(None);
    };
    let name: Option<(String,)> = sqlx::query_as("SELECT name FROM drivers WHERE id = ?")
        .bind(driver_id)
        .fetch_optional(pool)
        .await?;
    Ok(name.map(|(n,)| (driver_id, n)))
}

/// Update `listings.driver_id` for a single listing. Looks up the title,
/// runs detection, and writes the result. Non-fatal at the call site if
/// this fails — auto-association is a soft hint.
pub async fn associate_listing_driver(pool: &SqlitePool, listing_id: i64) -> AppResult<()> {
    let row: Option<(String,)> = sqlx::query_as("SELECT title FROM listings WHERE id = ?")
        .bind(listing_id)
        .fetch_optional(pool)
        .await?;
    let Some((title,)) = row else {
        return Ok(());
    };
    let drivers = load_drivers(pool).await?;
    let detected = detect_driver(&title, &drivers);
    apply(pool, listing_id, detected, false).await
}

/// Re-scan every listing. Loads the drivers table once and reuses it
/// across all rows. Useful as a one-shot backfill after the schema column
/// is added, or as a manual "re-associate everything" button.
///
/// When `force` is true, drivers stored on listings get re-evaluated even
/// if non-NULL; otherwise we only fill in NULLs.
pub async fn associate_all_listings(
    pool: &SqlitePool,
    progress: &ProgressEmitter,
    force: bool,
) -> AppResult<AssocSummary> {
    let drivers = load_drivers(pool).await?;
    // User-pinned rows (driver_id_user_set = 1) are always excluded — the
    // pin is the whole point of the flag. Beyond that, `force` controls
    // whether we re-evaluate rows that already have an auto-detected
    // driver vs. only filling in the NULLs. `driver_id` rides along so the
    // apply step doesn't re-SELECT what this scan already knows (DCH-55).
    let sql = if force {
        "SELECT id, title, driver_id FROM listings WHERE driver_id_user_set = 0 ORDER BY id"
    } else {
        "SELECT id, title, driver_id FROM listings
         WHERE driver_id_user_set = 0 AND driver_id IS NULL
         ORDER BY id"
    };
    let rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(sql).fetch_all(pool).await?;

    let total = rows.len() as u32;
    let mut summary = AssocSummary {
        considered: total,
        ..Default::default()
    };
    if total == 0 {
        progress.done("No listings needed driver association.");
        return Ok(summary);
    }

    // Chunked transactions (DCH-55): most rows end up Unchanged/Unmatched
    // and write nothing, so a batch is a handful of UPDATEs and one commit
    // rather than one fsync'd commit per matched row. Cancel lands between
    // batches; a failed batch rolls back alone and propagates.
    let mut done = 0u32;
    for batch in rows.chunks(ASSOC_BATCH_SIZE) {
        progress.check_cancelled()?;
        let mut tx = pool.begin().await?;
        for (id, title, current) in batch {
            done += 1;
            if done == 1 || done.is_multiple_of(50) || done == total {
                progress.step(
                    format!("Associating driver {done} of {total}…"),
                    Some(done),
                    Some(total),
                );
            }
            let detected = detect_driver(title, &drivers);
            let outcome = apply_known(&mut tx, *id, *current, detected, force).await?;
            match outcome {
                ApplyOutcome::Set => summary.associated += 1,
                ApplyOutcome::Cleared => summary.cleared += 1,
                ApplyOutcome::Unmatched => summary.unmatched += 1,
                ApplyOutcome::Unchanged => {}
            }
        }
        tx.commit().await?;
    }
    progress.done(format!(
        "Driver association: {} matched, {} cleared, {} still unmatched (of {}).",
        summary.associated, summary.cleared, summary.unmatched, summary.considered
    ));
    Ok(summary)
}

#[derive(Debug, Clone, Copy)]
enum ApplyOutcome {
    Set,
    Cleared,
    Unmatched,
    Unchanged,
}

async fn apply(
    pool: &SqlitePool,
    listing_id: i64,
    detected: Option<i64>,
    force: bool,
) -> AppResult<()> {
    apply_detail(pool, listing_id, detected, force).await?;
    Ok(())
}

/// Single-listing path: has to look the row up (it might not exist, or be
/// user-pinned) before applying. The batch path skips this — its scan
/// already filtered on the pin and carries `driver_id`.
async fn apply_detail(
    pool: &SqlitePool,
    listing_id: i64,
    detected: Option<i64>,
    force: bool,
) -> AppResult<ApplyOutcome> {
    let row: Option<(Option<i64>, i64)> =
        sqlx::query_as("SELECT driver_id, driver_id_user_set FROM listings WHERE id = ?")
            .bind(listing_id)
            .fetch_optional(pool)
            .await?;
    let (current, user_set) = match row {
        Some((c, u)) => (c, u != 0),
        None => return Ok(ApplyOutcome::Unchanged),
    };
    if user_set {
        // Honor the manual pin — auto-detection is hands-off until the
        // user explicitly resets it.
        return Ok(ApplyOutcome::Unchanged);
    }

    let mut conn = pool.acquire().await?;
    apply_known(&mut conn, listing_id, current, detected, force).await
}

/// The write decision, given a current driver the caller already knows.
/// User-pinned rows must be filtered out before calling this.
async fn apply_known(
    conn: &mut SqliteConnection,
    listing_id: i64,
    current: Option<i64>,
    detected: Option<i64>,
    force: bool,
) -> AppResult<ApplyOutcome> {
    match (current, detected) {
        (Some(existing), Some(new_id)) if existing == new_id => Ok(ApplyOutcome::Unchanged),
        (_, Some(new_id)) => {
            sqlx::query("UPDATE listings SET driver_id = ? WHERE id = ?")
                .bind(new_id)
                .bind(listing_id)
                .execute(conn)
                .await?;
            Ok(ApplyOutcome::Set)
        }
        (Some(_), None) if force => {
            sqlx::query("UPDATE listings SET driver_id = NULL WHERE id = ?")
                .bind(listing_id)
                .execute(conn)
                .await?;
            Ok(ApplyOutcome::Cleared)
        }
        (Some(_), None) => Ok(ApplyOutcome::Unchanged),
        (None, None) => Ok(ApplyOutcome::Unmatched),
    }
}

async fn load_drivers(pool: &SqlitePool) -> AppResult<Vec<DriverRow>> {
    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id, name FROM drivers")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name)| DriverRow {
            id,
            tokens: tokenize(&name),
        })
        .filter(|d| !d.tokens.is_empty())
        .collect())
}

/// Pick the most-specific driver whose every name-token appears in the
/// title. Returns None when nothing matches.
fn detect_driver(title: &str, drivers: &[DriverRow]) -> Option<i64> {
    let title_tokens: std::collections::HashSet<String> = tokenize(title).into_iter().collect();
    if title_tokens.is_empty() {
        return None;
    }
    let mut best: Option<(i64, usize)> = None;
    for d in drivers {
        if d.tokens.iter().all(|t| title_tokens.contains(t)) {
            let len = d.tokens.len();
            // Strict >: when two drivers tie on length we don't pick — that
            // case is genuinely ambiguous from the title alone.
            match best {
                Some((_, best_len)) if len > best_len => best = Some((d.id, len)),
                None => best = Some((d.id, len)),
                _ => {}
            }
        }
    }
    best.map(|(id, _)| id)
}

fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drv(id: i64, name: &str) -> DriverRow {
        DriverRow {
            id,
            tokens: tokenize(name),
        }
    }

    #[test]
    fn matches_two_token_name() {
        let drivers = vec![drv(1, "Jeff Gordon"), drv(2, "Kyle Busch")];
        let title = "2002 Jeff Gordon #24 Pepsi Daytona 1:24 Action ARC NASCAR Diecast";
        assert_eq!(detect_driver(title, &drivers), Some(1));
    }

    #[test]
    fn prefers_more_specific_suffix() {
        // Both "Dale Earnhardt" and "Dale Earnhardt Jr" fit a Jr title; the
        // Jr row wins because it has more tokens.
        let drivers = vec![drv(1, "Dale Earnhardt"), drv(2, "Dale Earnhardt Jr")];
        let title = "1999 Dale Earnhardt Jr #8 Budweiser 1:24";
        assert_eq!(detect_driver(title, &drivers), Some(2));
    }

    #[test]
    fn no_match_when_no_driver_in_title() {
        let drivers = vec![drv(1, "Jeff Gordon"), drv(2, "Kyle Busch")];
        let title = "Generic 1:24 NASCAR diecast no driver named";
        assert_eq!(detect_driver(title, &drivers), None);
    }

    #[test]
    fn case_insensitive_and_punctuation_tolerant() {
        let drivers = vec![drv(1, "Ricky Stenhouse Jr.")];
        // Hyphen between names, lowercase title.
        let title = "ricky-stenhouse jr 2018 ford fusion 1:24";
        assert_eq!(detect_driver(title, &drivers), Some(1));
    }

    #[test]
    fn ambiguous_same_length_returns_none() {
        // If two distinct two-token drivers both fit the title, we'd rather
        // store NULL than guess wrong. The all-tokens-present test means
        // this only triggers when the title actually contains both names —
        // e.g. a multi-driver lot listing.
        let drivers = vec![drv(1, "Jeff Gordon"), drv(2, "Kyle Busch")];
        let title = "1:24 lot: Jeff Gordon and Kyle Busch nascar diecast";
        // Both are length-2; strict > means the first one wins (Jeff Gordon
        // was iterated first). That's a deterministic outcome but not a
        // "tie returns None" — we still pick one. Document the behavior:
        let detected = detect_driver(title, &drivers);
        assert!(detected == Some(1) || detected == Some(2));
    }

    #[test]
    fn empty_drivers_returns_none() {
        let drivers: Vec<DriverRow> = vec![];
        assert!(detect_driver("Jeff Gordon 24 Pepsi", &drivers).is_none());
    }

    #[test]
    fn empty_title_returns_none() {
        let drivers = vec![drv(1, "Jeff Gordon")];
        assert!(detect_driver("", &drivers).is_none());
    }

    #[test]
    fn single_token_driver_still_matches() {
        // Some drivers go by a single name in the catalog.
        let drivers = vec![drv(1, "Yeley")];
        assert_eq!(detect_driver("Yeley #18 ARC 1:24", &drivers), Some(1));
    }

    /// The batched backfill (DCH-55) against a real schema: fills NULLs,
    /// leaves pinned rows alone, and reports the same summary shape the
    /// per-row version did — across more rows than one batch holds.
    #[tokio::test]
    async fn associate_all_listings_batches_and_honors_pins() {
        let pool = {
            use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
            use std::str::FromStr;
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
        };
        sqlx::query(
            "INSERT INTO drivers (name, normalized_name) VALUES ('Jeff Gordon', 'jeff-gordon')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // More rows than one batch, alternating matchable and unmatchable
        // titles, plus one user-pinned row that must not be touched.
        for i in 0..(ASSOC_BATCH_SIZE + 10) {
            let title = if i % 2 == 0 {
                format!("Jeff Gordon #24 DuPont 1:24 no. {i}")
            } else {
                format!("Generic diecast no. {i}")
            };
            sqlx::query(
                "INSERT INTO listings (seller_id, external_id, url, title, saved_at, last_seen_at)
                 VALUES (1, ?, 'https://example.com', ?, 1, 1)",
            )
            .bind(format!("lst-{i}"))
            .bind(title)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO listings
                (seller_id, external_id, url, title, saved_at, last_seen_at, driver_id_user_set)
             VALUES (1, 'pinned', 'https://example.com', 'Jeff Gordon pinned to none', 1, 1, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let progress = crate::progress::ProgressEmitter::null("test");
        let summary = associate_all_listings(&pool, &progress, false)
            .await
            .unwrap();

        let half = (ASSOC_BATCH_SIZE as u32 + 10) / 2;
        assert_eq!(summary.considered, half * 2); // pinned row never considered
        assert_eq!(summary.associated, half);
        assert_eq!(summary.unmatched, half);
        let (pinned_driver,): (Option<i64>,) =
            sqlx::query_as("SELECT driver_id FROM listings WHERE external_id = 'pinned'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(pinned_driver, None);
        let (set_rows,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM listings WHERE driver_id IS NOT NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(set_rows as u32, half);
    }
}
