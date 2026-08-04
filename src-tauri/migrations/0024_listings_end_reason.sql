-- Why an archived listing ended: 'sold' (bought / auction won),
-- 'ended' (expired or seller-ended without a sale), or 'removed'
-- (the listing vanished from eBay — Browse API 404s it). Derived from
-- the row's preserved raw_json where possible; NULL for rows archived
-- before this column existed until the next watchlist sync backfills
-- them through the same derivation.
ALTER TABLE listings ADD COLUMN end_reason TEXT;
