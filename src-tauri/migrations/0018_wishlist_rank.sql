-- Stack-rank priority for wishlist entries, maintained by drag-and-drop on
-- the Wishlist page. Lower rank = higher priority. reorder_wishlist rewrites
-- ranks as 0..n-1 for the whole list, so gaps/collisions only exist
-- transiently (added_at is the tiebreaker).
ALTER TABLE wishlist ADD COLUMN sort_rank INTEGER NOT NULL DEFAULT 0;

-- Backfill: keep the pre-rank display order (newest first) as the initial
-- priority order so nothing appears to move.
UPDATE wishlist SET sort_rank = (
    SELECT COUNT(*) FROM wishlist w2
    WHERE w2.added_at > wishlist.added_at
       OR (w2.added_at = wishlist.added_at AND w2.id > wishlist.id)
);
