-- Archival for ended listings. Instead of letting the watchlist prune
-- delete ended rows (or letting them squat on the eBay watchlist, which
-- caps at ~1000 items), the watchlist sync flags them is_archived = 1 and
-- removes them from the eBay watchlist. The local row — raw_json, price
-- history, driver/registry links — is kept forever as training data for
-- the matching algorithm and future sales-trend analysis.
--
-- No backfill: the next watchlist sync archives any already-ended rows
-- through the same path new ones take (flag, then unwatch on eBay).
ALTER TABLE listings ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN archived_at INTEGER;
