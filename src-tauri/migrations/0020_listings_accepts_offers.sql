-- Whether the listing accepts Best Offers (eBay buyingOptions contains
-- BEST_OFFER). Orthogonal to listing_type: most of a typical watchlist's
-- "fixed" listings also take offers, and auctions occasionally do too.
-- listing_type stays auction/fixed; this flag carries the offer dimension.
ALTER TABLE listings ADD COLUMN accepts_offers INTEGER NOT NULL DEFAULT 0;

-- Backfill from the Browse API payloads already stored in raw_json — no
-- re-fetch needed. Rows with no buyingOptions key (e.g. old Facebook
-- Marketplace imports) simply match zero json_each rows and stay 0.
UPDATE listings
SET accepts_offers = 1
WHERE id IN (
    SELECT v.id
    FROM (SELECT id, raw_json FROM listings
          WHERE raw_json IS NOT NULL AND json_valid(raw_json)) v,
         json_each(v.raw_json, '$.buyingOptions') je
    WHERE je.value = 'BEST_OFFER'
);
