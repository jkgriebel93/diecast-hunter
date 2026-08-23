-- DCH-74: manufacturer part number (Lionel's or any brand's) on a listing.
-- Manual-entry only: no auto-detection or match-backfill writes this column.
-- It arrives via set_listing_attributes (which pins the row) and is wiped by
-- reset_listing_attributes like the rest of the attribute set.
ALTER TABLE listings ADD COLUMN part_number TEXT;
