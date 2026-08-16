//! Wishlists: named lists of registry entries the user wants to acquire,
//! plus candidate saved listings linked to each entry. See migrations
//! `0017_wishlist.sql` and `0019_multiple_wishlists.sql`.
//!
//! Adding an entry takes a registry-search result and upserts a
//! `registry_entries` stub first (same shape as the pre-warm), so the wish
//! carries full search-page data without needing a detail-page fetch or a
//! DCR login.
//!
//! Naming: `wishlist_id` is always a row in `wishlists` (the list);
//! `entry_id` is a row in `wishlist_entries` (one wished diecast).

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::dcr::ProductionSearchResult;
use crate::error::{AppError, AppResult};
use crate::sync::registry_prewarm;

/// One named list, for the list-management UI.
#[derive(Debug, Clone, Serialize)]
pub struct WishlistInfo {
    pub wishlist_id: i64,
    pub name: String,
    pub created_at: i64,
    pub entry_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WishlistAddResult {
    pub entry_id: i64,
    pub registry_entry_id: i64,
    /// False when the entry was already on this list.
    pub created: bool,
}

/// A saved listing linked to a wishlist entry as a purchase candidate.
#[derive(Debug, Clone, Serialize)]
pub struct WishlistListing {
    pub listing_id: i64,
    pub seller_code: String,
    pub title: String,
    pub url: String,
    pub price_cents: Option<i64>,
    pub shipping_cents: Option<i64>,
    pub currency: String,
    pub status: String,
    pub end_time: Option<i64>,
    pub image_url: Option<String>,
    pub linked_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WishlistEntry {
    pub entry_id: i64,
    pub wishlist_id: i64,
    pub registry_entry_id: i64,
    pub registry_guid: String,
    pub driver_name: Option<String>,
    pub year: Option<i64>,
    pub oem: Option<String>,
    pub brand: Option<String>,
    pub scale: Option<String>,
    pub make: Option<String>,
    pub scheme_text: Option<String>,
    pub production_qty: Option<i64>,
    pub retail_value_cents: Option<i64>,
    pub wholesale_value_cents: Option<i64>,
    /// From raw_json — the search page's thumbnail.
    pub image_url: Option<String>,
    /// Site-relative path on diecastregistry.com to the entry's detail page.
    pub detail_url: Option<String>,
    pub notes: Option<String>,
    pub added_at: i64,
    /// Stack-rank priority within its list; lower = higher priority.
    /// Entries come back already sorted by this, so it's informational.
    pub sort_rank: i64,
    /// Linked candidate listings, oldest link first.
    pub listings: Vec<WishlistListing>,
}

#[derive(sqlx::FromRow)]
struct EntryRow {
    entry_id: i64,
    wishlist_id: i64,
    registry_entry_id: i64,
    registry_guid: Option<String>,
    driver_name: Option<String>,
    year: Option<i64>,
    oem: Option<String>,
    brand: Option<String>,
    scale: Option<String>,
    make: Option<String>,
    scheme_text: Option<String>,
    production_qty: Option<i64>,
    retail_value_cents: Option<i64>,
    wholesale_value_cents: Option<i64>,
    raw_json: Option<String>,
    notes: Option<String>,
    added_at: i64,
    sort_rank: i64,
}

// ---------------------------------------------------------------------------
// List management
// ---------------------------------------------------------------------------

pub async fn list_wishlists(pool: &SqlitePool) -> AppResult<Vec<WishlistInfo>> {
    let rows: Vec<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT w.id, w.name, w.created_at,
                (SELECT COUNT(*) FROM wishlist_entries e WHERE e.wishlist_id = w.id)
         FROM wishlists w
         ORDER BY w.created_at, w.id",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(wishlist_id, name, created_at, entry_count)| WishlistInfo {
                wishlist_id,
                name,
                created_at,
                entry_count,
            },
        )
        .collect())
}

pub async fn create_wishlist(pool: &SqlitePool, name: &str) -> AppResult<WishlistInfo> {
    let name = valid_name(name)?;
    let now = Utc::now().timestamp();
    let res = sqlx::query("INSERT INTO wishlists (name, created_at) VALUES (?, ?)")
        .bind(&name)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(WishlistInfo {
        wishlist_id: res.last_insert_rowid(),
        name,
        created_at: now,
        entry_count: 0,
    })
}

pub async fn rename_wishlist(pool: &SqlitePool, wishlist_id: i64, name: &str) -> AppResult<()> {
    let name = valid_name(name)?;
    let res = sqlx::query("UPDATE wishlists SET name = ? WHERE id = ?")
        .bind(&name)
        .bind(wishlist_id)
        .execute(pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::Config("wishlist no longer exists".into()));
    }
    Ok(())
}

/// Delete a list and (via CASCADE) its entries and listing links. The last
/// remaining list can't be deleted so the add-from-search flow always has a
/// target.
pub async fn delete_wishlist(pool: &SqlitePool, wishlist_id: i64) -> AppResult<()> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM wishlists")
        .fetch_one(pool)
        .await?;
    if count <= 1 {
        return Err(AppError::Config(
            "can't delete the last wishlist — rename it instead".into(),
        ));
    }
    sqlx::query("DELETE FROM wishlists WHERE id = ?")
        .bind(wishlist_id)
        .execute(pool)
        .await?;
    Ok(())
}

fn valid_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Parse("wishlist name is required".into()));
    }
    Ok(name.to_string())
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

pub async fn add_from_search(
    pool: &SqlitePool,
    wishlist_id: i64,
    result: &ProductionSearchResult,
) -> AppResult<WishlistAddResult> {
    if result.registry_guid.trim().is_empty() {
        return Err(AppError::Parse("registry_guid is required".into()));
    }
    registry_prewarm::upsert_stub_from_search(pool, result).await?;
    let (registry_entry_id,): (i64,) =
        sqlx::query_as("SELECT id FROM registry_entries WHERE external_id = ?")
            .bind(&result.registry_guid)
            .fetch_one(pool)
            .await?;

    // New wishes join at the bottom of their list's stack rank — an
    // unranked item shouldn't displace the user's curated #1.
    let res = sqlx::query(
        "INSERT INTO wishlist_entries (wishlist_id, registry_entry_id, added_at, sort_rank)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_rank) + 1, 0)
                           FROM wishlist_entries WHERE wishlist_id = ?))
         ON CONFLICT(wishlist_id, registry_entry_id) DO NOTHING",
    )
    .bind(wishlist_id)
    .bind(registry_entry_id)
    .bind(Utc::now().timestamp())
    .bind(wishlist_id)
    .execute(pool)
    .await
    .map_err(map_fk_violation)?;
    let created = res.rows_affected() > 0;

    let (entry_id,): (i64,) = sqlx::query_as(
        "SELECT id FROM wishlist_entries WHERE wishlist_id = ? AND registry_entry_id = ?",
    )
    .bind(wishlist_id)
    .bind(registry_entry_id)
    .fetch_one(pool)
    .await?;

    Ok(WishlistAddResult {
        entry_id,
        registry_entry_id,
        created,
    })
}

/// Pick a picture for a registry entry out of its `raw_json`.
///
/// Two writers, two keys: the garage and production-search pages supply a
/// thumbnail as `image_url`, while the detail page supplies the `photos`
/// lightbox and no thumbnail at all. An entry may have been reached by only
/// one of those routes, so either key on its own has to be enough — reading
/// `image_url` alone is why enriched wishlist rows rendered an empty box.
///
/// The registry query in `commands.rs` coalesces the same pair in SQL; this
/// is that rule for the callers that already have the blob parsed.
fn entry_image(raw: Option<&serde_json::Value>) -> Option<String> {
    let raw = raw?;
    let thumbnail = raw.get("image_url").and_then(|v| v.as_str());
    let first_photo = || {
        raw.get("photos")
            .and_then(|v| v.as_array())?
            .first()?
            .as_str()
    };
    thumbnail.or_else(first_photo).map(str::to_owned)
}

pub async fn list(pool: &SqlitePool, wishlist_id: i64) -> AppResult<Vec<WishlistEntry>> {
    let rows: Vec<EntryRow> = sqlx::query_as(
        "SELECT e.id AS entry_id, e.wishlist_id, e.registry_entry_id,
                e.notes, e.added_at, e.sort_rank,
                re.external_id AS registry_guid,
                d.name AS driver_name,
                re.year, re.oem, re.brand, re.scale, re.make,
                re.scheme_text, re.production_qty,
                re.retail_value_cents, re.wholesale_value_cents,
                re.raw_json
         FROM wishlist_entries e
         JOIN registry_entries re ON re.id = e.registry_entry_id
         LEFT JOIN drivers d ON d.id = re.driver_id
         WHERE e.wishlist_id = ?
         ORDER BY e.sort_rank, e.added_at DESC, e.id DESC",
    )
    .bind(wishlist_id)
    .fetch_all(pool)
    .await?;

    let listing_rows: Vec<(i64, WishlistListingRow)> = sqlx::query_as(
        "SELECT el.entry_id, l.id AS listing_id, s.code AS seller_code,
                l.title, l.url, l.price_cents, l.shipping_cents, l.currency,
                l.status, l.end_time, l.image_url, el.linked_at
         FROM wishlist_entry_listings el
         JOIN wishlist_entries e ON e.id = el.entry_id
         JOIN listings l ON l.id = el.listing_id
         JOIN sellers s ON s.id = l.seller_id
         WHERE e.wishlist_id = ?
         ORDER BY el.linked_at, l.id",
    )
    .bind(wishlist_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|r: WishlistListingRow| (r.entry_id, r))
    .collect();

    let mut by_entry: std::collections::HashMap<i64, Vec<WishlistListing>> =
        std::collections::HashMap::new();
    for (entry_id, r) in listing_rows {
        by_entry.entry(entry_id).or_default().push(WishlistListing {
            listing_id: r.listing_id,
            seller_code: r.seller_code,
            title: r.title,
            url: r.url,
            price_cents: r.price_cents,
            shipping_cents: r.shipping_cents,
            currency: r.currency,
            status: r.status,
            end_time: r.end_time,
            image_url: r.image_url,
            linked_at: r.linked_at,
        });
    }

    Ok(rows
        .into_iter()
        .map(|r| {
            // image_url / detail_url live only in raw_json (see the pre-warm
            // stub upsert) — parse leniently, bad JSON just drops them.
            let raw = r
                .raw_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
            let json_str = |key: &str| {
                raw.as_ref()
                    .and_then(|v| v.get(key))
                    .and_then(|x| x.as_str())
                    .map(str::to_owned)
            };
            WishlistEntry {
                entry_id: r.entry_id,
                wishlist_id: r.wishlist_id,
                registry_entry_id: r.registry_entry_id,
                registry_guid: r.registry_guid.unwrap_or_default(),
                driver_name: r.driver_name,
                year: r.year,
                oem: r.oem,
                brand: r.brand,
                scale: r.scale,
                make: r.make,
                scheme_text: r.scheme_text,
                production_qty: r.production_qty,
                retail_value_cents: r.retail_value_cents,
                wholesale_value_cents: r.wholesale_value_cents,
                image_url: entry_image(raw.as_ref()),
                detail_url: json_str("detail_url"),
                notes: r.notes,
                added_at: r.added_at,
                sort_rank: r.sort_rank,
                listings: by_entry.remove(&r.entry_id).unwrap_or_default(),
            }
        })
        .collect())
}

/// Registry GUIDs wished for on any list — backs the "In wishlist"
/// indicator on registry search results.
pub async fn wishlisted_guids(pool: &SqlitePool) -> AppResult<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT re.external_id
         FROM wishlist_entries e
         JOIN registry_entries re ON re.id = e.registry_entry_id
         WHERE re.external_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(g,)| g).collect())
}

#[derive(sqlx::FromRow)]
struct WishlistListingRow {
    entry_id: i64,
    listing_id: i64,
    seller_code: String,
    title: String,
    url: String,
    price_cents: Option<i64>,
    shipping_cents: Option<i64>,
    currency: String,
    status: String,
    end_time: Option<i64>,
    image_url: Option<String>,
    linked_at: i64,
}

/// Rewrite a list's stack rank so `ordered_ids[i]` gets rank `i`. The
/// frontend sends the full list after a drag-and-drop; ids it doesn't
/// mention (e.g. added concurrently in another pane) keep their old rank
/// and fall in via the added_at tiebreaker on the next list.
pub async fn reorder(pool: &SqlitePool, ordered_ids: &[i64]) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for (rank, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE wishlist_entries SET sort_rank = ? WHERE id = ?")
            .bind(rank as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn remove(pool: &SqlitePool, entry_id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM wishlist_entries WHERE id = ?")
        .bind(entry_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Move an entry (with its notes and linked listings) to another list,
/// joining at the bottom of that list's ranking.
pub async fn move_entry(
    pool: &SqlitePool,
    entry_id: i64,
    target_wishlist_id: i64,
) -> AppResult<()> {
    let res = sqlx::query(
        "UPDATE wishlist_entries
         SET wishlist_id = ?,
             sort_rank = (SELECT COALESCE(MAX(sort_rank) + 1, 0)
                          FROM wishlist_entries WHERE wishlist_id = ?)
         WHERE id = ?",
    )
    .bind(target_wishlist_id)
    .bind(target_wishlist_id)
    .bind(entry_id)
    .execute(pool)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db_err) = &e {
            if db_err.message().contains("UNIQUE") {
                return AppError::Config("that diecast is already on the target wishlist".into());
            }
        }
        map_fk_violation(e)
    })?;
    if res.rows_affected() == 0 {
        return Err(AppError::Config("wishlist entry no longer exists".into()));
    }
    Ok(())
}

/// Replace the entry's notes. Empty/whitespace-only clears them.
pub async fn set_notes(pool: &SqlitePool, entry_id: i64, notes: Option<String>) -> AppResult<()> {
    let notes = notes
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    let res = sqlx::query("UPDATE wishlist_entries SET notes = ? WHERE id = ?")
        .bind(notes)
        .bind(entry_id)
        .execute(pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::Config("wishlist entry no longer exists".into()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Bulk add from Saved Listings (DCH-45)
// ---------------------------------------------------------------------------

/// What happened to one selected listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListingWishOutcome {
    /// Newly linked as a candidate. `entry_created` separates "this list
    /// didn't have the car yet" from "added a second candidate to a wish
    /// that was already there" — both are success, but only the first
    /// changes what the list contains.
    Linked { entry_created: bool },
    /// Already a candidate on this list. A no-op, not an error.
    AlreadyPresent,
    /// No confirmed or auto registry match, so there is no wish for the
    /// listing to be a candidate *for*. Also covers a listing that has
    /// vanished since the user selected it: the match row cascades with it,
    /// and either way there is nothing to add.
    NoRegistryMatch,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct WishlistBulkAddResult {
    /// Listings newly linked to an entry on this list.
    pub linked: i64,
    /// Listings that were already candidates — skipped without erroring.
    pub already_present: i64,
    /// Wishes created because the list didn't have that diecast yet. Always
    /// ≤ `linked`; several listings can land on one new entry.
    pub entries_created: i64,
    /// Listings that can't be represented as a wish.
    pub skipped_no_match: i64,
}

/// Counting, split out from the SQL so it can be tested. The arithmetic is
/// where this goes quietly wrong — an `already_present` derived by
/// subtraction (the way the group bulk-add does it) would silently absorb
/// the skipped rows and report that nothing was skipped.
pub fn tally_wish_outcomes(outcomes: &[ListingWishOutcome]) -> WishlistBulkAddResult {
    let mut out = WishlistBulkAddResult::default();
    for outcome in outcomes {
        match outcome {
            ListingWishOutcome::Linked { entry_created } => {
                out.linked += 1;
                if *entry_created {
                    out.entries_created += 1;
                }
            }
            ListingWishOutcome::AlreadyPresent => out.already_present += 1,
            ListingWishOutcome::NoRegistryMatch => out.skipped_no_match += 1,
        }
    }
    out
}

/// Add saved listings to a wishlist as purchase candidates, in one
/// transaction.
///
/// A wishlist entry is a *registry entry*, not a listing, so each listing
/// has to be resolved through its registry match first: find-or-create the
/// wish for that diecast on this list, then link the listing to it. Doing
/// that per listing from the frontend would mean two round trips each and a
/// half-applied list if one failed midway.
///
/// Listings without a registry match are skipped rather than rejected — the
/// caller reports them, because a partial add is a notice, not a failure.
pub async fn add_listings(
    pool: &SqlitePool,
    wishlist_id: i64,
    listing_ids: &[i64],
) -> AppResult<WishlistBulkAddResult> {
    // Checked up front so a stale list id is an error even when the
    // selection is empty, matching listing_groups::add_listings.
    let (exists,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM wishlists WHERE id = ?")
        .bind(wishlist_id)
        .fetch_one(pool)
        .await?;
    if exists == 0 {
        return Err(AppError::Config("wishlist no longer exists".into()));
    }
    if listing_ids.is_empty() {
        return Ok(WishlistBulkAddResult::default());
    }

    let now = Utc::now().timestamp();
    let mut tx = pool.begin().await?;
    let mut outcomes = Vec::with_capacity(listing_ids.len());

    for &listing_id in listing_ids {
        let matched: Option<(i64,)> = sqlx::query_as(
            "SELECT registry_entry_id FROM listing_matches
             WHERE listing_id = ? AND registry_entry_id IS NOT NULL",
        )
        .bind(listing_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((registry_entry_id,)) = matched else {
            outcomes.push(ListingWishOutcome::NoRegistryMatch);
            continue;
        };

        // Same insert as add_from_search: a new wish joins at the bottom of
        // the stack rank rather than displacing the user's curated #1.
        let entry_res = sqlx::query(
            "INSERT INTO wishlist_entries (wishlist_id, registry_entry_id, added_at, sort_rank)
             VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_rank) + 1, 0)
                               FROM wishlist_entries WHERE wishlist_id = ?))
             ON CONFLICT(wishlist_id, registry_entry_id) DO NOTHING",
        )
        .bind(wishlist_id)
        .bind(registry_entry_id)
        .bind(now)
        .bind(wishlist_id)
        .execute(&mut *tx)
        .await
        .map_err(map_fk_violation)?;
        let entry_created = entry_res.rows_affected() > 0;

        let (entry_id,): (i64,) = sqlx::query_as(
            "SELECT id FROM wishlist_entries WHERE wishlist_id = ? AND registry_entry_id = ?",
        )
        .bind(wishlist_id)
        .bind(registry_entry_id)
        .fetch_one(&mut *tx)
        .await?;

        let link_res = sqlx::query(
            "INSERT INTO wishlist_entry_listings (entry_id, listing_id, linked_at)
             VALUES (?, ?, ?)
             ON CONFLICT(entry_id, listing_id) DO NOTHING",
        )
        .bind(entry_id)
        .bind(listing_id)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(map_fk_violation)?;

        outcomes.push(if link_res.rows_affected() > 0 {
            ListingWishOutcome::Linked { entry_created }
        } else {
            ListingWishOutcome::AlreadyPresent
        });
    }

    tx.commit().await?;
    Ok(tally_wish_outcomes(&outcomes))
}

/// Link a saved listing to a wishlist entry. Re-linking is a no-op.
pub async fn link_listing(pool: &SqlitePool, entry_id: i64, listing_id: i64) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO wishlist_entry_listings (entry_id, listing_id, linked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(entry_id, listing_id) DO NOTHING",
    )
    .bind(entry_id)
    .bind(listing_id)
    .bind(Utc::now().timestamp())
    .execute(pool)
    .await
    .map_err(map_fk_violation)?;
    Ok(())
}

pub async fn unlink_listing(pool: &SqlitePool, entry_id: i64, listing_id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM wishlist_entry_listings WHERE entry_id = ? AND listing_id = ?")
        .bind(entry_id)
        .bind(listing_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// FK failures here mean a wishlist, entry, or listing id doesn't exist.
/// Surface a config error rather than the generic "FOREIGN KEY constraint
/// failed" so the UI can show something useful.
fn map_fk_violation(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &e {
        if db_err.message().contains("FOREIGN KEY") {
            return AppError::Config("wishlist, entry, or listing no longer exists".into());
        }
    }
    AppError::Db(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linked(entry_created: bool) -> ListingWishOutcome {
        ListingWishOutcome::Linked { entry_created }
    }

    mod entry_image {
        use super::*;
        use serde_json::json;

        #[test]
        fn prefers_the_thumbnail_when_both_are_present() {
            let raw = json!({ "image_url": "/thumb.jpg", "photos": ["/big.jpg"] });
            assert_eq!(entry_image(Some(&raw)).as_deref(), Some("/thumb.jpg"));
        }

        /// The regression: an enriched entry has only the lightbox, and used
        /// to render an empty box on the wishlist while the registry page
        /// showed it fine.
        #[test]
        fn falls_back_to_the_first_lightbox_photo() {
            let raw = json!({ "photos": ["/big-1.jpg", "/big-2.jpg"] });
            assert_eq!(entry_image(Some(&raw)).as_deref(), Some("/big-1.jpg"));
        }

        #[test]
        fn a_stub_with_neither_key_has_no_picture() {
            let raw = json!({ "detail_url": "/diecast/x/y/z" });
            assert_eq!(entry_image(Some(&raw)), None);
        }

        /// An empty array is not a picture, and `photos[0]` on it must not
        /// become a Some("") that renders as a broken image.
        #[test]
        fn an_empty_photos_array_is_not_a_picture() {
            let raw = json!({ "photos": [] });
            assert_eq!(entry_image(Some(&raw)), None);
        }

        #[test]
        fn unparseable_raw_json_is_not_a_picture() {
            assert_eq!(entry_image(None), None);
        }
    }

    #[test]
    fn tally_counts_nothing_for_an_empty_selection() {
        assert_eq!(tally_wish_outcomes(&[]), WishlistBulkAddResult::default());
    }

    #[test]
    fn tally_counts_each_outcome_in_its_own_bucket() {
        let out = tally_wish_outcomes(&[
            linked(true),
            linked(false),
            ListingWishOutcome::AlreadyPresent,
            ListingWishOutcome::NoRegistryMatch,
            ListingWishOutcome::NoRegistryMatch,
        ]);
        assert_eq!(
            out,
            WishlistBulkAddResult {
                linked: 2,
                already_present: 1,
                entries_created: 1,
                skipped_no_match: 2,
            }
        );
    }

    #[test]
    fn skipped_listings_never_count_as_already_present() {
        // The bug this guards: deriving already_present as
        // `selected - linked` (the shape listing_groups uses, where every
        // row is addable) would absorb the skips and report that nothing
        // was skipped — the one fact the user needs from a partial add.
        let out = tally_wish_outcomes(&[linked(true), ListingWishOutcome::NoRegistryMatch]);
        assert_eq!(out.already_present, 0);
        assert_eq!(out.skipped_no_match, 1);
    }

    #[test]
    fn several_listings_can_share_one_new_wish() {
        // Two listings for the same diecast create one entry, so
        // entries_created trails linked rather than matching it.
        let out = tally_wish_outcomes(&[linked(true), linked(false)]);
        assert_eq!(out.linked, 2);
        assert_eq!(out.entries_created, 1);
    }

    #[test]
    fn entries_created_never_exceeds_linked() {
        let out = tally_wish_outcomes(&[linked(true), linked(true), linked(false)]);
        assert!(out.entries_created <= out.linked);
    }
}
