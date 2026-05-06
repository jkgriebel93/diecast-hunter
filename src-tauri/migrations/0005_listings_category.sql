-- Capture eBay's categorization on each listing so we can filter out
-- non-diecasts at save time (and clean up existing ones on demand). Both
-- columns nullable; populated by future eBay Browse-API saves and refreshes.
ALTER TABLE listings ADD COLUMN category_id TEXT;
ALTER TABLE listings ADD COLUMN category_path TEXT;
