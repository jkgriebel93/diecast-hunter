-- Sold-price comparables (DCH-10) read the archive on every Listings page
-- load and on every extension overlay render: "archived eBay listings that
-- sold". Without an index that is a full scan of `listings`, which grows
-- without bound because archived rows are never pruned.
--
-- Partial index rather than a plain one on (is_archived, end_reason): the
-- comp query only ever wants the sold slice, and archived-sold is a small
-- fraction of the table, so the index stays proportional to the comps rather
-- than to every listing ever watched.
CREATE INDEX IF NOT EXISTS idx_listings_sold_comps
    ON listings(end_time, archived_at)
    WHERE is_archived = 1 AND end_reason = 'sold';
