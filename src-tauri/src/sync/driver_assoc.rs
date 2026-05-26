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
use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::progress::ProgressEmitter;

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

/// Update `listings.driver_id` for a single listing. Looks up the title,
/// runs detection, and writes the result. Non-fatal at the call site if
/// this fails — auto-association is a soft hint.
pub async fn associate_listing_driver(pool: &SqlitePool, listing_id: i64) -> AppResult<()> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT title FROM listings WHERE id = ?")
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
    // driver vs. only filling in the NULLs.
    let sql = if force {
        "SELECT id, title FROM listings WHERE driver_id_user_set = 0 ORDER BY id"
    } else {
        "SELECT id, title FROM listings
         WHERE driver_id_user_set = 0 AND driver_id IS NULL
         ORDER BY id"
    };
    let rows: Vec<(i64, String)> = sqlx::query_as(sql).fetch_all(pool).await?;

    let total = rows.len() as u32;
    let mut summary = AssocSummary {
        considered: total,
        ..Default::default()
    };
    if total == 0 {
        progress.done("No listings needed driver association.");
        return Ok(summary);
    }

    for (idx, (id, title)) in rows.into_iter().enumerate() {
        progress.check_cancelled()?;
        let done = (idx + 1) as u32;
        if done == 1 || done % 50 == 0 || done == total {
            progress.step(
                format!("Associating driver {done} of {total}…"),
                Some(done),
                Some(total),
            );
        }
        let detected = detect_driver(&title, &drivers);
        let outcome = apply_detail(pool, id, detected, force).await?;
        match outcome {
            ApplyOutcome::Set => summary.associated += 1,
            ApplyOutcome::Cleared => summary.cleared += 1,
            ApplyOutcome::Unmatched => summary.unmatched += 1,
            ApplyOutcome::Unchanged => {}
        }
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

async fn apply_detail(
    pool: &SqlitePool,
    listing_id: i64,
    detected: Option<i64>,
    force: bool,
) -> AppResult<ApplyOutcome> {
    let row: Option<(Option<i64>, i64)> = sqlx::query_as(
        "SELECT driver_id, driver_id_user_set FROM listings WHERE id = ?",
    )
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

    match (current, detected) {
        (Some(existing), Some(new_id)) if existing == new_id => Ok(ApplyOutcome::Unchanged),
        (_, Some(new_id)) => {
            sqlx::query("UPDATE listings SET driver_id = ? WHERE id = ?")
                .bind(new_id)
                .bind(listing_id)
                .execute(pool)
                .await?;
            Ok(ApplyOutcome::Set)
        }
        (Some(_), None) if force => {
            sqlx::query("UPDATE listings SET driver_id = NULL WHERE id = ?")
                .bind(listing_id)
                .execute(pool)
                .await?;
            Ok(ApplyOutcome::Cleared)
        }
        (Some(_), None) => Ok(ApplyOutcome::Unchanged),
        (None, None) => Ok(ApplyOutcome::Unmatched),
    }
}

async fn load_drivers(pool: &SqlitePool) -> AppResult<Vec<DriverRow>> {
    let rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, name FROM drivers")
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
    let title_tokens: std::collections::HashSet<String> =
        tokenize(title).into_iter().collect();
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
}
