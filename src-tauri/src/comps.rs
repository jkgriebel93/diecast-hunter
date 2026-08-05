//! Sold-price comparables ("comps") derived from our own listing archive.
//!
//! The DCH-9 spike ruled out every external source of completed-sale data:
//! eBay's Marketplace Insights API is a Limited Release effectively closed to
//! new applicants, the Browse API exposes active listings only (the Finding
//! API was decommissioned in Feb 2025), and Terapeak is UI-only. What is left
//! is the one source we control — the archive DCH-8 built: watched listings
//! that ended, kept locally forever with their price, their `end_reason`, and
//! their registry/driver linkage.
//!
//! So a comp here is an archived eBay listing with `end_reason = 'sold'` whose
//! `listing_matches` row points at a registry entry. Coverage is limited to
//! what was actually watched, and it accumulates only as listings end — a
//! brand-new database has no comps at all, which is why every caller treats a
//! missing summary as normal rather than an error.
//!
//! **What the price means.** A comp's value is `price_cents + shipping_cents`
//! — the delivered cost, matching the numerator of the existing retail deal
//! score so the two percentages are directly comparable. It is the *last
//! observed* price, not a receipt: an auction synced 30 minutes before it
//! closed records the bid at sync time, not the winning bid, and an accepted
//! Best Offer records the asking price rather than what was paid. Both skew
//! low. Treat comps as a market-level signal, not an exact sale price.

use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;

use crate::error::AppResult;

/// Sales older than this drop out of the window. Diecast prices drift with
/// driver relevance and re-releases, so an 18-month-old sale is weak evidence
/// about today's market — but the window has to be generous because the
/// archive fills slowly (only watched listings ever enter it).
pub const COMP_WINDOW_SECONDS: i64 = 18 * 30 * 24 * 60 * 60;

/// Sales of the *same registry entry* needed before we report an exact-tier
/// summary. Two is deliberately low: for the same car, two independent sales
/// already beat a single list price, and demanding more would report nothing
/// for most entries given how thin the archive is.
pub const MIN_EXACT_COMPS: usize = 2;

/// Sales needed for the looser same-driver-and-scale tier. Higher than the
/// exact tier because the set is heterogeneous — different seasons, sponsors,
/// and finishes under one driver — so it needs more samples before a median
/// means anything.
pub const MIN_SIMILAR_COMPS: usize = 3;

/// Auto-matches below this confidence are not trusted as comps. The
/// auto-matcher itself ships at `MIN_CONFIDENCE = 50`, which is the right bar
/// for "show the user a suggestion they can reject" and the wrong bar for
/// "silently fold this into a price statistic" — a bad comp corrupts a number
/// the user reads as fact. User-confirmed matches are always trusted
/// regardless of stored confidence.
pub const MIN_COMP_CONFIDENCE: f64 = 80.0;

/// Which set of sales a summary was computed from. `Exact` is the same
/// registry entry — the same car. `Similar` is the same driver at the same
/// scale, used only when the exact tier is too thin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CompTier {
    Exact,
    Similar,
}

/// Sold-price statistics for one listing, plus the provenance a user needs to
/// judge them: how many sales, over what span, and from which tier.
#[derive(Debug, Clone, Serialize)]
pub struct CompSummary {
    pub tier: CompTier,
    pub count: usize,
    pub low_cents: i64,
    pub median_cents: i64,
    pub high_cents: i64,
    /// Unix seconds of the most / least recent sale in the set. The UI shows
    /// the newest one so stale comps are visibly stale.
    pub newest_sold_at: i64,
    pub oldest_sold_at: i64,
}

/// One archived sale, already reduced to the fields the statistics need.
#[derive(Debug, Clone)]
struct SoldComp {
    listing_id: i64,
    total_cents: i64,
    sold_at: i64,
}

/// The registry entry a listing is being priced against. Callers supply the
/// driver and scale because both bulk callers already have them joined; the
/// single-entry path uses [`load_target`].
#[derive(Debug, Clone)]
pub struct CompTarget {
    pub registry_entry_id: i64,
    pub driver_id: Option<i64>,
    pub scale: Option<String>,
}

/// Every usable sale in the archive, indexed both ways a summary can be keyed.
///
/// Loaded once per request rather than queried per listing: the Listings page
/// scores hundreds of rows in one pass, and the archive is small enough
/// (bounded by what the user has ever watched *and* seen end) that holding it
/// in memory is cheaper than the N+1.
pub struct CompIndex {
    by_entry: HashMap<i64, Vec<SoldComp>>,
    by_driver_scale: HashMap<(i64, String), Vec<SoldComp>>,
}

impl CompIndex {
    /// Load all sold comps within the window as of `now` (Unix seconds).
    // The row tuple's shape is dictated by the SELECT list immediately below
    // it; aliasing it would separate the columns from the query naming them.
    #[allow(clippy::type_complexity)]
    pub async fn load(pool: &SqlitePool, now: i64) -> AppResult<Self> {
        let cutoff = now - COMP_WINDOW_SECONDS;
        // The sale date is `end_time` when eBay gave us one and `archived_at`
        // otherwise — a listing removed from eBay before we saw its end time
        // still sold at roughly the moment we noticed.
        let rows: Vec<(i64, i64, Option<i64>, Option<String>, i64, i64)> = sqlx::query_as(
            "SELECT l.id,
                    lm.registry_entry_id,
                    re.driver_id,
                    re.scale,
                    l.price_cents + COALESCE(l.shipping_cents, 0) AS total_cents,
                    COALESCE(l.end_time, l.archived_at) AS sold_at
             FROM listings l
             JOIN sellers s ON s.id = l.seller_id
             JOIN listing_matches lm ON lm.listing_id = l.id
             JOIN registry_entries re ON re.id = lm.registry_entry_id
             WHERE s.code = 'ebay'
               AND l.is_archived = 1
               AND l.end_reason = 'sold'
               AND l.price_cents IS NOT NULL
               AND l.price_cents > 0
               AND lm.registry_entry_id IS NOT NULL
               AND (lm.user_confirmed = 1 OR lm.confidence >= ?)
               AND COALESCE(l.end_time, l.archived_at) IS NOT NULL
               AND COALESCE(l.end_time, l.archived_at) >= ?",
        )
        .bind(MIN_COMP_CONFIDENCE)
        .bind(cutoff)
        .fetch_all(pool)
        .await?;

        let mut by_entry: HashMap<i64, Vec<SoldComp>> = HashMap::new();
        let mut by_driver_scale: HashMap<(i64, String), Vec<SoldComp>> = HashMap::new();
        for (listing_id, entry_id, driver_id, scale, total_cents, sold_at) in rows {
            let comp = SoldComp {
                listing_id,
                total_cents,
                sold_at,
            };
            if let (Some(driver_id), Some(scale_key)) =
                (driver_id, scale.as_deref().and_then(normalize_scale))
            {
                by_driver_scale
                    .entry((driver_id, scale_key))
                    .or_default()
                    .push(comp.clone());
            }
            by_entry.entry(entry_id).or_default().push(comp);
        }
        Ok(CompIndex {
            by_entry,
            by_driver_scale,
        })
    }

    /// True when the archive holds no usable sales at all. Test-only: it
    /// distinguishes "the load filters rejected these rows" from "the tier
    /// thresholds rejected them", which `summarize` alone can't.
    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.by_entry.is_empty()
    }

    /// Summarize sales for `target`, excluding `exclude_listing_id` so an
    /// archived sale is never a comp for itself.
    ///
    /// Prefers the exact tier and falls back to same-driver-same-scale only
    /// when exact is below [`MIN_EXACT_COMPS`]. Returns `None` when neither
    /// tier clears its threshold.
    pub fn summarize(
        &self,
        target: &CompTarget,
        exclude_listing_id: Option<i64>,
    ) -> Option<CompSummary> {
        let exact = self
            .by_entry
            .get(&target.registry_entry_id)
            .map(|comps| collect(comps, exclude_listing_id))
            .unwrap_or_default();
        if exact.len() >= MIN_EXACT_COMPS {
            return Some(summarize_set(CompTier::Exact, &exact));
        }

        let key = (
            target.driver_id?,
            normalize_scale(target.scale.as_deref()?)?,
        );
        let similar = self
            .by_driver_scale
            .get(&key)
            .map(|comps| collect(comps, exclude_listing_id))
            .unwrap_or_default();
        if similar.len() >= MIN_SIMILAR_COMPS {
            return Some(summarize_set(CompTier::Similar, &similar));
        }
        None
    }
}

/// Look up one registry entry's comp key. Used by the extension's
/// `/match/preview` route, which has an entry id from the scorer but none of
/// the joins the Listings query already carries.
pub async fn load_target(pool: &SqlitePool, entry_id: i64) -> AppResult<Option<CompTarget>> {
    let row: Option<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT driver_id, scale FROM registry_entries WHERE id = ?")
            .bind(entry_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(driver_id, scale)| CompTarget {
        registry_entry_id: entry_id,
        driver_id,
        scale,
    }))
}

/// Total cost as a percentage of the comp median, mirroring the retail deal
/// score's shape so the two are read the same way: lower is better, 100 means
/// "priced exactly where these sold".
pub fn comp_score(total_cents: Option<i64>, summary: Option<&CompSummary>) -> Option<f64> {
    let (total, median) = (total_cents?, summary?.median_cents);
    if median <= 0 {
        return None;
    }
    Some(total as f64 / median as f64 * 100.0)
}

fn collect(comps: &[SoldComp], exclude_listing_id: Option<i64>) -> Vec<SoldComp> {
    comps
        .iter()
        .filter(|c| Some(c.listing_id) != exclude_listing_id)
        .cloned()
        .collect()
}

/// Caller guarantees `comps` is non-empty.
fn summarize_set(tier: CompTier, comps: &[SoldComp]) -> CompSummary {
    let mut totals: Vec<i64> = comps.iter().map(|c| c.total_cents).collect();
    totals.sort_unstable();
    CompSummary {
        tier,
        count: totals.len(),
        low_cents: totals[0],
        median_cents: median(&totals),
        high_cents: totals[totals.len() - 1],
        newest_sold_at: comps.iter().map(|c| c.sold_at).max().unwrap_or(0),
        oldest_sold_at: comps.iter().map(|c| c.sold_at).min().unwrap_or(0),
    }
}

/// Median of a pre-sorted, non-empty slice. Even counts average the two
/// middle values; median rather than mean because a single mis-matched or
/// autographed outlier would drag a mean badly at these sample sizes.
fn median(sorted: &[i64]) -> i64 {
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    }
}

/// Collapse the scale spellings DCR and eBay sellers use ("1:24", "1/24",
/// "1:24 Scale") to one key, so the similar tier doesn't split a driver's
/// sales across notations. Returns `None` for a blank scale, which then can't
/// key the similar tier at all — correct, since comparing across unknown
/// scales would mix $10 1:64s with $100 1:24s.
fn normalize_scale(scale: &str) -> Option<String> {
    let key: String = scale
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    let key = key.strip_suffix("scale").unwrap_or(&key).to_string();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

#[cfg(test)]
mod tests {
    //! Exercises the tiering rules, the statistics, and every filter that
    //! decides whether an archived row is allowed to influence a price.
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 24 * 60 * 60;

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

    async fn insert_driver(pool: &SqlitePool, name: &str) -> i64 {
        sqlx::query("INSERT INTO drivers (name, normalized_name) VALUES (?, ?)")
            .bind(name)
            .bind(name.to_lowercase())
            .execute(pool)
            .await
            .unwrap()
            .last_insert_rowid()
    }

    async fn insert_entry(pool: &SqlitePool, driver_id: i64, scale: &str) -> i64 {
        sqlx::query(
            "INSERT INTO registry_entries (external_id, driver_id, scale, fetched_at)
             VALUES (?, ?, ?, 1)",
        )
        .bind(format!("entry-{driver_id}-{scale}-{}", rand_suffix()))
        .bind(driver_id)
        .bind(scale)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    /// External ids only have to be unique, not meaningful.
    fn rand_suffix() -> String {
        use std::sync::atomic::{AtomicI64, Ordering};
        static N: AtomicI64 = AtomicI64::new(0);
        N.fetch_add(1, Ordering::Relaxed).to_string()
    }

    struct SoldSpec {
        entry_id: i64,
        price_cents: i64,
        shipping_cents: i64,
        sold_at: i64,
        end_reason: &'static str,
        user_confirmed: i64,
        confidence: f64,
    }

    impl SoldSpec {
        fn new(entry_id: i64, price_cents: i64, sold_at: i64) -> Self {
            SoldSpec {
                entry_id,
                price_cents,
                shipping_cents: 0,
                sold_at,
                end_reason: "sold",
                user_confirmed: 1,
                confidence: 100.0,
            }
        }
    }

    async fn insert_sold(pool: &SqlitePool, spec: SoldSpec) -> i64 {
        let listing_id: i64 = sqlx::query(
            "INSERT INTO listings
                (seller_id, external_id, url, title, price_cents, shipping_cents,
                 status, is_archived, archived_at, end_time, end_reason,
                 saved_at, last_seen_at)
             VALUES ((SELECT id FROM sellers WHERE code = 'ebay'),
                     ?, 'https://example.test/itm/1', 'sold listing', ?, ?,
                     'ended', 1, ?, ?, ?, 1, 1)",
        )
        .bind(format!("v1|{}|0", rand_suffix()))
        .bind(spec.price_cents)
        .bind(spec.shipping_cents)
        .bind(spec.sold_at)
        .bind(spec.sold_at)
        .bind(spec.end_reason)
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid();

        sqlx::query(
            "INSERT INTO listing_matches
                (listing_id, registry_entry_id, confidence, user_confirmed, matched_at)
             VALUES (?, ?, ?, ?, 1)",
        )
        .bind(listing_id)
        .bind(spec.entry_id)
        .bind(spec.confidence)
        .bind(spec.user_confirmed)
        .execute(pool)
        .await
        .unwrap();
        listing_id
    }

    async fn target(pool: &SqlitePool, entry_id: i64) -> CompTarget {
        load_target(pool, entry_id).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn exact_tier_wins_with_two_sales_of_the_same_entry() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Dale Earnhardt").await;
        let entry = insert_entry(&pool, driver, "1:24").await;
        insert_sold(&pool, SoldSpec::new(entry, 3000, NOW - DAY)).await;
        insert_sold(&pool, SoldSpec::new(entry, 5000, NOW - 2 * DAY)).await;

        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        let s = idx.summarize(&target(&pool, entry).await, None).unwrap();
        assert_eq!(s.tier, CompTier::Exact);
        assert_eq!(s.count, 2);
        assert_eq!(s.low_cents, 3000);
        assert_eq!(s.high_cents, 5000);
        // Even count: mean of the two middle values.
        assert_eq!(s.median_cents, 4000);
        assert_eq!(s.newest_sold_at, NOW - DAY);
        assert_eq!(s.oldest_sold_at, NOW - 2 * DAY);
    }

    #[tokio::test]
    async fn shipping_is_part_of_the_comp_price() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Jeff Gordon").await;
        let entry = insert_entry(&pool, driver, "1:24").await;
        for price in [3000, 3000] {
            let mut spec = SoldSpec::new(entry, price, NOW - DAY);
            spec.shipping_cents = 995;
            insert_sold(&pool, spec).await;
        }
        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        let s = idx.summarize(&target(&pool, entry).await, None).unwrap();
        assert_eq!(s.median_cents, 3995);
    }

    #[tokio::test]
    async fn one_exact_sale_is_not_enough() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Bill Elliott").await;
        let entry = insert_entry(&pool, driver, "1:24").await;
        insert_sold(&pool, SoldSpec::new(entry, 3000, NOW - DAY)).await;

        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        assert!(idx.summarize(&target(&pool, entry).await, None).is_none());
    }

    #[tokio::test]
    async fn falls_back_to_same_driver_and_scale_when_exact_is_thin() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Rusty Wallace").await;
        let target_entry = insert_entry(&pool, driver, "1:24").await;
        // One sale of the exact car — below MIN_EXACT_COMPS…
        insert_sold(&pool, SoldSpec::new(target_entry, 9000, NOW - DAY)).await;
        // …plus three of other cars by the same driver at the same scale,
        // written in a spelling variant the normalizer has to collapse.
        let sibling = insert_entry(&pool, driver, "1/24 Scale").await;
        for price in [2000, 4000, 6000] {
            insert_sold(&pool, SoldSpec::new(sibling, price, NOW - DAY)).await;
        }

        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        let s = idx
            .summarize(&target(&pool, target_entry).await, None)
            .unwrap();
        assert_eq!(s.tier, CompTier::Similar);
        // The exact car's own sale counts in the similar set too.
        assert_eq!(s.count, 4);
        assert_eq!(s.median_cents, 5000);
    }

    #[tokio::test]
    async fn a_different_scale_is_never_a_comp() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Mark Martin").await;
        let target_entry = insert_entry(&pool, driver, "1:24").await;
        let other_scale = insert_entry(&pool, driver, "1:64").await;
        for price in [500, 700, 900] {
            insert_sold(&pool, SoldSpec::new(other_scale, price, NOW - DAY)).await;
        }
        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        assert!(idx
            .summarize(&target(&pool, target_entry).await, None)
            .is_none());
    }

    #[tokio::test]
    async fn a_listing_is_not_its_own_comp() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Terry Labonte").await;
        let entry = insert_entry(&pool, driver, "1:24").await;
        let self_id = insert_sold(&pool, SoldSpec::new(entry, 3000, NOW - DAY)).await;
        insert_sold(&pool, SoldSpec::new(entry, 5000, NOW - DAY)).await;

        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        let t = target(&pool, entry).await;
        assert_eq!(idx.summarize(&t, None).unwrap().count, 2);
        // Excluding itself drops the set below the exact threshold, and there
        // is no similar-tier set to fall back to.
        assert!(idx.summarize(&t, Some(self_id)).is_none());
    }

    #[tokio::test]
    async fn unsold_and_removed_archives_are_not_comps() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Ricky Rudd").await;
        let entry = insert_entry(&pool, driver, "1:24").await;
        for reason in ["ended", "removed"] {
            let mut spec = SoldSpec::new(entry, 3000, NOW - DAY);
            spec.end_reason = reason;
            insert_sold(&pool, spec).await;
        }
        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        assert!(idx.is_empty());
        assert!(idx.summarize(&target(&pool, entry).await, None).is_none());
    }

    #[tokio::test]
    async fn sales_outside_the_window_are_excluded() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Davey Allison").await;
        let entry = insert_entry(&pool, driver, "1:24").await;
        insert_sold(&pool, SoldSpec::new(entry, 3000, NOW - DAY)).await;
        insert_sold(
            &pool,
            SoldSpec::new(entry, 5000, NOW - COMP_WINDOW_SECONDS - DAY),
        )
        .await;

        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        // Only the in-window sale survives, which is one short of the bar.
        assert!(idx.summarize(&target(&pool, entry).await, None).is_none());
    }

    #[tokio::test]
    async fn low_confidence_auto_matches_do_not_set_prices() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Ernie Irvan").await;
        let entry = insert_entry(&pool, driver, "1:24").await;
        // Two sales the auto-matcher linked at a confidence it considers a
        // match (>= 50) but we do not consider evidence of a price.
        for price in [3000, 5000] {
            let mut spec = SoldSpec::new(entry, price, NOW - DAY);
            spec.user_confirmed = 0;
            spec.confidence = MIN_COMP_CONFIDENCE - 10.0;
            insert_sold(&pool, spec).await;
        }
        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        assert!(idx.summarize(&target(&pool, entry).await, None).is_none());

        // The same links at or above the bar do count.
        let confident = insert_entry(&pool, driver, "1:32").await;
        for price in [3000, 5000] {
            let mut spec = SoldSpec::new(confident, price, NOW - DAY);
            spec.user_confirmed = 0;
            spec.confidence = MIN_COMP_CONFIDENCE;
            insert_sold(&pool, spec).await;
        }
        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        assert_eq!(
            idx.summarize(&target(&pool, confident).await, None)
                .unwrap()
                .count,
            2
        );
    }

    #[tokio::test]
    async fn empty_archive_summarizes_to_nothing() {
        let pool = migrated_pool().await;
        let driver = insert_driver(&pool, "Alan Kulwicki").await;
        let entry = insert_entry(&pool, driver, "1:24").await;
        let idx = CompIndex::load(&pool, NOW).await.unwrap();
        assert!(idx.is_empty());
        assert!(idx.summarize(&target(&pool, entry).await, None).is_none());
    }

    #[test]
    fn median_of_odd_count_is_the_middle_value() {
        assert_eq!(median(&[100, 300, 1000]), 300);
    }

    #[test]
    fn scale_spellings_collapse_to_one_key() {
        let key = normalize_scale("1:24").unwrap();
        assert_eq!(normalize_scale("1/24").unwrap(), key);
        assert_eq!(normalize_scale(" 1:24 Scale ").unwrap(), key);
        assert_ne!(normalize_scale("1:64").unwrap(), key);
        assert!(normalize_scale("   ").is_none());
    }

    #[test]
    fn comp_score_is_total_over_median() {
        let summary = CompSummary {
            tier: CompTier::Exact,
            count: 3,
            low_cents: 2000,
            median_cents: 4000,
            high_cents: 6000,
            newest_sold_at: NOW,
            oldest_sold_at: NOW,
        };
        assert_eq!(comp_score(Some(2000), Some(&summary)), Some(50.0));
        assert_eq!(comp_score(None, Some(&summary)), None);
        assert_eq!(comp_score(Some(2000), None), None);
    }
}
