//! Manually-added collection entries — cars diecastregistry.com doesn't list
//! (DCH-12).
//!
//! # Why these are registry entries and not standalone rows
//!
//! Every display field on a collection row comes from `registry_entries`:
//! `commands::fetch_collection_rows` reads year, car number, OEM, brand,
//! scale, finish and the values off `re.*`, and the driver name through a
//! join on `re.driver_id`. A `my_collection` row with a NULL
//! `registry_entry_id` would render blank unless `my_collection` grew a
//! parallel column for each of those.
//!
//! So a manual add writes a real `registry_entries` row, flagged
//! `source = 'local'`. It flows through the existing joins untouched and
//! inherits driver normalization, comps eligibility and wishlist links for
//! free. The flag is what keeps DCR-facing flows off it — see the guards in
//! `sync::dcr_registry`, `sync::detail_url_backfill` and
//! `sync::registry_prewarm`.
//!
//! # Why the price is `paid_cents` and not `retail_value_cents`
//!
//! `retail_value_cents` is diecastregistry.com's *appraisal*, and the
//! collection totals sum it. Writing what the user paid into that column
//! would make the totals non-empty for free, at the cost of turning the
//! "retail" figure into an undifferentiated mix of appraisals and purchase
//! prices — unrecoverably, since nothing afterwards records which was which.
//!
//! A manually-added car therefore has no appraisal (`retail_value_cents` and
//! `wholesale_value_cents` stay NULL) and contributes $0 to the retail total.
//! Its cost lives in `my_collection.paid_cents`, which the collection list
//! shows alongside retail so that $0 reads as "not appraised" rather than as
//! a bug.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::dcr::parse::normalize_driver_name;
use crate::error::{AppError, AppResult};

/// `my_collection.source` / `registry_entries.source` for manual entries.
/// Deliberately not 'diecastregistry', which is what
/// `dcr_collection::prune_missing_rows` scopes its DELETE to.
pub const SOURCE_LOCAL: &str = "local";

/// Widest range a release year can plausibly take. Diecast collectibles
/// postdate the sport's early years by decades; the upper bound leaves room
/// for next-season pre-orders without accepting a typo'd 20255.
const MIN_YEAR: i32 = 1900;
const MAX_YEAR: i32 = 2100;

/// One manually-entered car. Every field but the driver and the scheme is
/// optional — the point of this feature is recording something DCR has no
/// data for, so demanding a full spec would defeat it.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntryInput {
    pub driver_name: String,
    pub scheme_text: String,
    pub year: Option<i32>,
    pub year_raced: Option<i32>,
    pub car_number: Option<String>,
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub scale: Option<String>,
    pub make: Option<String>,
    pub finish: Option<String>,
    pub diecast_type: Option<String>,
    pub production_qty: Option<i64>,
    /// What the user paid, in cents. The entry's cost basis — never its
    /// appraisal. See the module docs.
    pub paid_cents: Option<i64>,
    pub condition: Option<String>,
    pub notes: Option<String>,
    pub image_url: Option<String>,
    /// This copy's sequential number — the DIN, which DCR's registration form
    /// calls the chassis number. A property of the item on the shelf, not of
    /// the production run, which is why it is stored on the collection row
    /// rather than on the registry entry that several copies could share.
    pub din: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct LocalEntrySummary {
    pub collection_id: i64,
    pub registry_entry_id: i64,
    pub driver_id: i64,
}

/// Trim, and treat an all-whitespace string as absent. Text inputs hand back
/// `""` for "left blank", which would otherwise be stored as an empty string
/// and displayed as one.
fn clean(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Reject inputs that would produce an unusable row, and normalize the rest.
/// Returns the cleaned input so callers can't accidentally persist the raw
/// one.
fn validate(input: &LocalEntryInput) -> AppResult<LocalEntryInput> {
    let driver_name = input.driver_name.trim();
    if driver_name.is_empty() {
        return Err(AppError::Parse("Driver name is required".into()));
    }
    // The collection list titles each row with its scheme text, falling back
    // to "(no scheme)". A manual entry with no scheme would be an untitled
    // row the user can't tell apart from any other untitled row.
    let scheme_text = input.scheme_text.trim();
    if scheme_text.is_empty() {
        return Err(AppError::Parse("Scheme/description is required".into()));
    }

    for (label, year) in [("Year", input.year), ("Year raced", input.year_raced)] {
        if let Some(y) = year {
            if !(MIN_YEAR..=MAX_YEAR).contains(&y) {
                return Err(AppError::Parse(format!(
                    "{label} must be between {MIN_YEAR} and {MAX_YEAR}"
                )));
            }
        }
    }

    if input.paid_cents.is_some_and(|c| c < 0) {
        return Err(AppError::Parse("Purchase price cannot be negative".into()));
    }
    if input.production_qty.is_some_and(|q| q < 0) {
        return Err(AppError::Parse(
            "Production quantity cannot be negative".into(),
        ));
    }
    // 1-based: DCR's own form numbers a run from #1, and a "#0 of 2500" would
    // render as a real DIN rather than as the mistake it is.
    if input.din.is_some_and(|d| d < 1) {
        return Err(AppError::Parse("DIN must be 1 or greater".into()));
    }
    // Caught here rather than shrugged at, because the pair is what gets
    // displayed — "#3000 of 2500" is visibly wrong and the user is the only
    // one who can say which half is the typo.
    if let (Some(din), Some(qty)) = (input.din, input.production_qty) {
        if qty > 0 && din > qty {
            return Err(AppError::Parse(format!(
                "DIN {din} is higher than the production quantity of {qty}"
            )));
        }
    }

    Ok(LocalEntryInput {
        driver_name: driver_name.to_string(),
        scheme_text: scheme_text.to_string(),
        year: input.year,
        year_raced: input.year_raced,
        car_number: clean(&input.car_number),
        oem: clean(&input.oem),
        brand: clean(&input.brand),
        scale: clean(&input.scale),
        make: clean(&input.make),
        finish: clean(&input.finish),
        diecast_type: clean(&input.diecast_type),
        production_qty: input.production_qty,
        paid_cents: input.paid_cents,
        condition: clean(&input.condition),
        notes: clean(&input.notes),
        image_url: clean(&input.image_url),
        din: input.din,
    })
}

/// The collection row's `raw_json`, which is where `fetch_collection_rows`
/// looks for `image_url`. No `detail_url`: there is no DCR page to link to,
/// and writing one would make the row's "View on diecastregistry.com" link
/// point at a 404.
///
/// The DIN goes under `seq_produced.sequence` — the same key
/// `dcr_collection` writes when it parses My Garage's "(#1832 / 2016)". One
/// key, one meaning, so the collection list reads the DIN off a manual entry
/// and a synced one through the same path.
fn collection_raw_json(input: &LocalEntryInput) -> String {
    serde_json::to_string(&serde_json::json!({
        "source": SOURCE_LOCAL,
        "driver_name": input.driver_name,
        "scheme_text": input.scheme_text,
        "image_url": input.image_url,
        "seq_produced": {
            "sequence": input.din,
            "total": input.production_qty,
        },
    }))
    .unwrap_or_default()
}

/// Same for the registry side. `details_fetched_at` is deliberately left
/// NULL — there are no details to fetch — but the collection list must not
/// therefore label the row "stub, needs registry sync"; that's what
/// `CollectionRow::is_local` is for.
fn registry_raw_json(input: &LocalEntryInput) -> String {
    serde_json::to_string(&serde_json::json!({
        "source": SOURCE_LOCAL,
        "scheme_text": input.scheme_text,
        "image_url": input.image_url,
    }))
    .unwrap_or_default()
}

async fn upsert_driver(pool: &SqlitePool, name: &str) -> AppResult<i64> {
    let normalized = normalize_driver_name(name);
    if normalized.is_empty() {
        return Err(AppError::Parse(
            "Driver name must contain at least one letter or number".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO drivers (name, normalized_name) VALUES (?, ?)
         ON CONFLICT(normalized_name) DO UPDATE SET name = excluded.name",
    )
    .bind(name)
    .bind(&normalized)
    .execute(pool)
    .await?;
    let (id,): (i64,) = sqlx::query_as("SELECT id FROM drivers WHERE normalized_name = ?")
        .bind(&normalized)
        .fetch_one(pool)
        .await?;
    Ok(id)
}

/// Create a manually-added collection entry and the local registry entry
/// backing it.
pub async fn create_local_entry(
    pool: &SqlitePool,
    input: LocalEntryInput,
) -> AppResult<LocalEntrySummary> {
    let input = validate(&input)?;
    let now = Utc::now().timestamp();
    let driver_id = upsert_driver(pool, &input.driver_name).await?;

    // external_id stays NULL: it holds the DCR GUID, and inventing one would
    // let a future DCR sync collide with this row on ON CONFLICT(external_id).
    // SQLite treats NULLs as distinct in a UNIQUE index, so any number of
    // local entries coexist.
    let registry_entry_id = sqlx::query(
        "INSERT INTO registry_entries
            (external_id, source, driver_id, year, year_raced, car_number,
             diecast_type, scheme_text, oem, brand, scale, make, finish,
             production_qty, raw_json, fetched_at)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(SOURCE_LOCAL)
    .bind(driver_id)
    .bind(input.year)
    .bind(input.year_raced)
    .bind(&input.car_number)
    .bind(&input.diecast_type)
    .bind(&input.scheme_text)
    .bind(&input.oem)
    .bind(&input.brand)
    .bind(&input.scale)
    .bind(&input.make)
    .bind(&input.finish)
    .bind(input.production_qty)
    .bind(registry_raw_json(&input))
    .bind(now)
    .execute(pool)
    .await?
    .last_insert_rowid();

    // my_collection.external_id is NOT part of a nullable unique index —
    // idx_my_collection_source_external is UNIQUE(source, external_id), and
    // the collection list surfaces it as `asset_guid`. Derive it from the
    // registry row id so it's unique without a UUID dependency and stays
    // readable in the database.
    let collection_id = sqlx::query(
        "INSERT INTO my_collection
            (registry_entry_id, source, external_id, paid_cents, condition,
             notes, raw_json, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(registry_entry_id)
    .bind(SOURCE_LOCAL)
    .bind(format!("local-{registry_entry_id}"))
    .bind(input.paid_cents)
    .bind(&input.condition)
    .bind(&input.notes)
    .bind(collection_raw_json(&input))
    .bind(now)
    .execute(pool)
    .await?
    .last_insert_rowid();

    Ok(LocalEntrySummary {
        collection_id,
        registry_entry_id,
        driver_id,
    })
}

/// Set or clear the user's note on a collection entry — ANY entry, not just
/// a manually-added one (DCH-63). Notes are user-authored data with no DCR
/// equivalent, the same standing as a photo of the copy on the shelf
/// (`collection_photo`): the column belongs to the user, and the collection
/// sync's upsert never writes it, so nothing here needs the local-only guard
/// that protects the DCR-owned fields below.
pub async fn set_entry_notes(
    pool: &SqlitePool,
    collection_id: i64,
    notes: Option<String>,
) -> AppResult<()> {
    let res = sqlx::query("UPDATE my_collection SET notes = ? WHERE id = ?")
        .bind(clean(&notes))
        .bind(collection_id)
        .execute(pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::Config("collection entry no longer exists".into()));
    }
    Ok(())
}

/// Edit a manually-added entry. Refuses rows that came from DCR: those are
/// a cache of someone else's data, and an edit would be silently reverted by
/// the next sync — a worse outcome than being told no.
pub async fn update_local_entry(
    pool: &SqlitePool,
    collection_id: i64,
    input: LocalEntryInput,
) -> AppResult<LocalEntrySummary> {
    let input = validate(&input)?;

    let existing: Option<(String, Option<i64>)> =
        sqlx::query_as("SELECT source, registry_entry_id FROM my_collection WHERE id = ?")
            .bind(collection_id)
            .fetch_optional(pool)
            .await?;
    let (source, registry_entry_id) = existing
        .ok_or_else(|| AppError::Parse(format!("collection entry {collection_id} not found")))?;
    if source != SOURCE_LOCAL {
        return Err(AppError::Parse(
            "Only manually-added entries can be edited — this one came from \
             diecastregistry.com."
                .into(),
        ));
    }
    let registry_entry_id = registry_entry_id.ok_or_else(|| {
        AppError::Parse(format!(
            "collection entry {collection_id} has no registry entry to update"
        ))
    })?;

    let now = Utc::now().timestamp();
    let driver_id = upsert_driver(pool, &input.driver_name).await?;

    // Straight assignment, not COALESCE: clearing a field the user typed in
    // earlier has to actually clear it. The COALESCE pattern elsewhere exists
    // to stop a thin DCR payload erasing richer data — irrelevant here, where
    // the input *is* the whole record.
    //
    // `source` is re-asserted defensively so a row can never lose its local
    // flag and become eligible for DCR enrichment.
    sqlx::query(
        "UPDATE registry_entries SET
            source = ?,
            driver_id = ?,
            year = ?,
            year_raced = ?,
            car_number = ?,
            diecast_type = ?,
            scheme_text = ?,
            oem = ?,
            brand = ?,
            scale = ?,
            make = ?,
            finish = ?,
            production_qty = ?,
            raw_json = ?,
            fetched_at = ?
         WHERE id = ?",
    )
    .bind(SOURCE_LOCAL)
    .bind(driver_id)
    .bind(input.year)
    .bind(input.year_raced)
    .bind(&input.car_number)
    .bind(&input.diecast_type)
    .bind(&input.scheme_text)
    .bind(&input.oem)
    .bind(&input.brand)
    .bind(&input.scale)
    .bind(&input.make)
    .bind(&input.finish)
    .bind(input.production_qty)
    .bind(registry_raw_json(&input))
    .bind(now)
    .bind(registry_entry_id)
    .execute(pool)
    .await?;

    sqlx::query(
        "UPDATE my_collection SET
            paid_cents = ?,
            condition = ?,
            notes = ?,
            raw_json = ?
         WHERE id = ?",
    )
    .bind(input.paid_cents)
    .bind(&input.condition)
    .bind(&input.notes)
    .bind(collection_raw_json(&input))
    .bind(collection_id)
    .execute(pool)
    .await?;

    Ok(LocalEntrySummary {
        collection_id,
        registry_entry_id,
        driver_id,
    })
}

#[cfg(test)]
mod tests {
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

    fn input(driver: &str, scheme: &str) -> LocalEntryInput {
        LocalEntryInput {
            driver_name: driver.to_string(),
            scheme_text: scheme.to_string(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn create_writes_a_local_registry_entry_and_collection_row() {
        let pool = migrated_pool().await;
        let mut i = input("Dale Earnhardt", "GM Goodwrench");
        i.year = Some(1998);
        i.oem = Some("Action".into());
        i.brand = Some("RCCA".into());
        i.scale = Some("1:24".into());
        i.paid_cents = Some(4500);

        let summary = create_local_entry(&pool, i).await.unwrap();

        let (source, year, oem, scale): (String, Option<i32>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT source, year, oem, scale FROM registry_entries WHERE id = ?")
                .bind(summary.registry_entry_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(source, SOURCE_LOCAL);
        assert_eq!(year, Some(1998));
        assert_eq!(oem.as_deref(), Some("Action"));
        assert_eq!(scale.as_deref(), Some("1:24"));

        // The whole point of the cost-basis decision: no invented appraisal,
        // and nothing that would make an enrichment pass think this row is a
        // stub waiting for a detail page.
        let (retail, wholesale, details): (Option<i64>, Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT retail_value_cents, wholesale_value_cents, details_fetched_at
                 FROM registry_entries WHERE id = ?",
        )
        .bind(summary.registry_entry_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(retail, None);
        assert_eq!(wholesale, None);
        assert_eq!(details, None);

        let (coll_source, paid, external_id): (String, Option<i64>, String) = sqlx::query_as(
            "SELECT source, paid_cents, external_id FROM my_collection WHERE id = ?",
        )
        .bind(summary.collection_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(coll_source, SOURCE_LOCAL);
        assert_eq!(paid, Some(4500));
        assert_eq!(external_id, format!("local-{}", summary.registry_entry_id));
    }

    #[tokio::test]
    async fn several_local_entries_coexist_despite_null_external_id() {
        // registry_entries.external_id is UNIQUE. SQLite treats NULLs as
        // distinct, so leaving it NULL has to work for more than one row —
        // this is the assumption the whole design rests on.
        let pool = migrated_pool().await;
        for n in 0..3 {
            create_local_entry(&pool, input("Jeff Gordon", &format!("scheme {n}")))
                .await
                .unwrap();
        }
        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM registry_entries WHERE source = ?")
                .bind(SOURCE_LOCAL)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn entries_for_one_driver_share_a_driver_row() {
        let pool = migrated_pool().await;
        let a = create_local_entry(&pool, input("Jeff Gordon", "DuPont"))
            .await
            .unwrap();
        // Different spelling, same normalized name.
        let b = create_local_entry(&pool, input("  jeff  gordon ", "Pepsi"))
            .await
            .unwrap();
        assert_eq!(a.driver_id, b.driver_id);
    }

    #[tokio::test]
    async fn update_replaces_fields_including_clearing_them() {
        let pool = migrated_pool().await;
        let mut initial = input("Kyle Busch", "M&Ms");
        initial.oem = Some("Action".into());
        initial.notes = Some("boxed".into());
        initial.paid_cents = Some(9900);
        let created = create_local_entry(&pool, initial).await.unwrap();

        let mut edited = input("Kyle Busch", "Interstate Batteries");
        edited.scale = Some("1:64".into());
        // oem, notes and paid_cents left blank — an edit that clears a field
        // must actually clear it.
        let updated = update_local_entry(&pool, created.collection_id, edited)
            .await
            .unwrap();
        assert_eq!(updated.registry_entry_id, created.registry_entry_id);

        let (scheme, oem, scale, source): (Option<String>, Option<String>, Option<String>, String) =
            sqlx::query_as(
                "SELECT scheme_text, oem, scale, source FROM registry_entries WHERE id = ?",
            )
            .bind(created.registry_entry_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(scheme.as_deref(), Some("Interstate Batteries"));
        assert_eq!(oem, None);
        assert_eq!(scale.as_deref(), Some("1:64"));
        assert_eq!(source, SOURCE_LOCAL);

        let (paid, notes): (Option<i64>, Option<String>) =
            sqlx::query_as("SELECT paid_cents, notes FROM my_collection WHERE id = ?")
                .bind(created.collection_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(paid, None);
        assert_eq!(notes, None);
    }

    #[tokio::test]
    async fn update_refuses_a_dcr_sourced_row() {
        let pool = migrated_pool().await;
        sqlx::query(
            "INSERT INTO registry_entries (external_id, driver_id, fetched_at)
             VALUES ('guid-1', NULL, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let collection_id = sqlx::query(
            "INSERT INTO my_collection
                (registry_entry_id, source, external_id, imported_at)
             VALUES (1, 'diecastregistry', 'asset-1', 1)",
        )
        .execute(&pool)
        .await
        .unwrap()
        .last_insert_rowid();

        let err = update_local_entry(&pool, collection_id, input("Someone", "Something"))
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("manually-added"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn blank_driver_or_scheme_is_rejected() {
        let pool = migrated_pool().await;
        let err = create_local_entry(&pool, input("   ", "Something"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Driver name"), "{err}");

        let err = create_local_entry(&pool, input("Someone", "  "))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Scheme"), "{err}");
    }

    #[tokio::test]
    async fn implausible_numbers_are_rejected() {
        let pool = migrated_pool().await;

        let mut bad_year = input("Someone", "Scheme");
        bad_year.year = Some(20255);
        let err = create_local_entry(&pool, bad_year).await.unwrap_err();
        assert!(err.to_string().contains("Year must be"), "{err}");

        let mut bad_price = input("Someone", "Scheme");
        bad_price.paid_cents = Some(-1);
        let err = create_local_entry(&pool, bad_price).await.unwrap_err();
        assert!(err.to_string().contains("negative"), "{err}");
    }

    #[tokio::test]
    async fn din_is_stored_where_the_dcr_sync_puts_it() {
        // The contract that lets one display path serve both sources: a
        // manual entry's DIN has to land on the same raw_json key
        // `dcr_collection` writes for "(#1832 / 2016)".
        let pool = migrated_pool().await;
        let mut i = input("Jeff Gordon", "DuPont");
        i.din = Some(1832);
        i.production_qty = Some(2016);
        let created = create_local_entry(&pool, i).await.unwrap();

        let (raw,): (String,) = sqlx::query_as("SELECT raw_json FROM my_collection WHERE id = ?")
            .bind(created.collection_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["seq_produced"]["sequence"], 1832);
        assert_eq!(json["seq_produced"]["total"], 2016);
    }

    #[tokio::test]
    async fn a_din_past_the_end_of_the_run_is_rejected() {
        let pool = migrated_pool().await;
        let mut i = input("Jeff Gordon", "DuPont");
        i.din = Some(3000);
        i.production_qty = Some(2500);
        let err = create_local_entry(&pool, i).await.unwrap_err();
        assert!(err.to_string().contains("higher than"), "{err}");

        // Zero production quantity is the prototype convention, not a run of
        // none, so it can't contradict a DIN.
        let pool = migrated_pool().await;
        let mut ok = input("Jeff Gordon", "DuPont");
        ok.din = Some(1);
        ok.production_qty = Some(0);
        create_local_entry(&pool, ok).await.unwrap();
    }

    #[tokio::test]
    async fn blank_optional_text_is_stored_as_null_not_empty_string() {
        // Text inputs submit "" for untouched fields; storing those would
        // put empty strings where the UI expects "unset".
        let pool = migrated_pool().await;
        let mut i = input("Someone", "Scheme");
        i.oem = Some("   ".into());
        i.notes = Some("".into());
        let created = create_local_entry(&pool, i).await.unwrap();

        let (oem,): (Option<String>,) =
            sqlx::query_as("SELECT oem FROM registry_entries WHERE id = ?")
                .bind(created.registry_entry_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(oem, None);
        let (notes,): (Option<String>,) =
            sqlx::query_as("SELECT notes FROM my_collection WHERE id = ?")
                .bind(created.collection_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(notes, None);
    }

    async fn stored_notes(pool: &SqlitePool, collection_id: i64) -> Option<String> {
        let (notes,): (Option<String>,) =
            sqlx::query_as("SELECT notes FROM my_collection WHERE id = ?")
                .bind(collection_id)
                .fetch_one(pool)
                .await
                .unwrap();
        notes
    }

    #[tokio::test]
    async fn set_entry_notes_trims_stores_and_clears() {
        let pool = migrated_pool().await;
        let created = create_local_entry(&pool, input("Jeff Gordon", "DuPont"))
            .await
            .unwrap();

        set_entry_notes(
            &pool,
            created.collection_id,
            Some("  box has shelf wear  ".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            stored_notes(&pool, created.collection_id).await.as_deref(),
            Some("box has shelf wear"),
        );

        // A blanked textarea clears the note rather than storing "".
        set_entry_notes(&pool, created.collection_id, Some("   ".into()))
            .await
            .unwrap();
        assert_eq!(stored_notes(&pool, created.collection_id).await, None);
    }

    #[tokio::test]
    async fn set_entry_notes_rejects_a_missing_row() {
        // A stale dialog (row removed in another pane) should say so, not
        // report success against nothing.
        let pool = migrated_pool().await;
        let err = set_entry_notes(&pool, 9999, Some("note".into()))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no longer exists"), "{err}");
    }
}
