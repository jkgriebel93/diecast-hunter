//! "Not interested" dismissals for the Seller Feed (DCH-51).
//!
//! Pure storage helpers: the feed itself stays a live Browse search, and
//! the frontend subtracts these ids from each fetched page. Nothing else
//! reads this table — dismissing a listing here must never change what
//! Saved Listings, Browse, or the watchlist show, and un-hiding is a plain
//! DELETE, which is what makes the control reversible enough to skip a
//! confirmation under the DCH-33 conventions.

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct HiddenFeedListing {
    pub item_id: String,
    /// Snapshot for the review list only — the listing may be gone from
    /// eBay by the time the user looks, so this is what names the row.
    pub title: Option<String>,
    pub seller_username: Option<String>,
    pub hidden_at: i64,
}

pub async fn list(pool: &SqlitePool) -> AppResult<Vec<HiddenFeedListing>> {
    let rows = sqlx::query_as::<_, HiddenFeedListing>(
        "SELECT item_id, title, seller_username, hidden_at
           FROM hidden_feed_listings
          ORDER BY hidden_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Idempotent: dismissing an already-hidden item refreshes its snapshot
/// rather than erroring, so a double-click can't surface a failure.
pub async fn hide(
    pool: &SqlitePool,
    item_id: &str,
    title: Option<&str>,
    seller_username: Option<&str>,
) -> AppResult<HiddenFeedListing> {
    let hidden_at = Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO hidden_feed_listings (item_id, title, seller_username, hidden_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(item_id) DO UPDATE
            SET title = excluded.title,
                seller_username = excluded.seller_username,
                hidden_at = excluded.hidden_at",
    )
    .bind(item_id)
    .bind(title)
    .bind(seller_username)
    .bind(hidden_at)
    .execute(pool)
    .await?;
    Ok(HiddenFeedListing {
        item_id: item_id.to_string(),
        title: title.map(str::to_string),
        seller_username: seller_username.map(str::to_string),
        hidden_at,
    })
}

/// Also idempotent — un-hiding something already visible is a no-op, not
/// an error, for the same double-click reason as `hide`.
pub async fn unhide(pool: &SqlitePool, item_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM hidden_feed_listings WHERE item_id = ?1")
        .bind(item_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Round-trip tests against the real migrations: hide → listed newest
    //! first, re-hide refreshes the snapshot instead of erroring, unhide
    //! deletes, and none of it touches the `listings` table — the
    //! feed-only scoping the DCH-51 acceptance criteria hang on.
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
    async fn hide_list_unhide_round_trip() {
        let pool = migrated_pool().await;

        assert!(list(&pool).await.unwrap().is_empty());

        hide(&pool, "v1|100|0", Some("Larson #5"), Some("diecast_depot"))
            .await
            .unwrap();
        hide(&pool, "v1|200|0", None, None).await.unwrap();

        let rows = list(&pool).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.item_id == "v1|100|0"
            && r.title.as_deref() == Some("Larson #5")
            && r.seller_username.as_deref() == Some("diecast_depot")));

        unhide(&pool, "v1|100|0").await.unwrap();
        let rows = list(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].item_id, "v1|200|0");
    }

    #[tokio::test]
    async fn hide_is_idempotent_and_refreshes_the_snapshot() {
        let pool = migrated_pool().await;

        hide(&pool, "v1|100|0", Some("old title"), None)
            .await
            .unwrap();
        // A second dismissal of the same item must not error, and the
        // snapshot follows the latest sighting of the listing.
        hide(&pool, "v1|100|0", Some("new title"), Some("someone"))
            .await
            .unwrap();

        let rows = list(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title.as_deref(), Some("new title"));
        assert_eq!(rows[0].seller_username.as_deref(), Some("someone"));
    }

    #[tokio::test]
    async fn unhide_of_a_visible_item_is_a_no_op() {
        let pool = migrated_pool().await;
        unhide(&pool, "v1|does-not-exist|0").await.unwrap();
        assert!(list(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn dismissals_never_touch_the_listings_table() {
        let pool = migrated_pool().await;
        hide(&pool, "v1|100|0", Some("t"), None).await.unwrap();
        unhide(&pool, "v1|100|0").await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM listings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }
}
