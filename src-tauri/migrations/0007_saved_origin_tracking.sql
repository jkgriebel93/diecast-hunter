-- Distinguish saved rows that came from an eBay sync from those the user
-- created locally. Sync flows only ever prune rows with ebay_origin = 1, so
-- locally-added searches/sellers are never deleted by a sync.
--
-- ebay_external_id is the stable identifier returned by Trading API
-- GetMyeBayBuying for searches (eBay's saved-search ID). We use it as the
-- upsert key so renames on the eBay side don't create duplicate rows.

ALTER TABLE saved_searches ADD COLUMN ebay_origin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE saved_searches ADD COLUMN ebay_external_id TEXT;
ALTER TABLE saved_searches ADD COLUMN last_synced_at INTEGER;
CREATE UNIQUE INDEX idx_saved_searches_ebay_id
    ON saved_searches(ebay_external_id)
    WHERE ebay_external_id IS NOT NULL;

ALTER TABLE saved_sellers ADD COLUMN ebay_origin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE saved_sellers ADD COLUMN last_synced_at INTEGER;
