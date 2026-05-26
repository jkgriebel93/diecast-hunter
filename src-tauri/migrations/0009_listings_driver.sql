-- Auto-association of saved listings to a driver, independent of any
-- registry-entry match. Populated by sync::driver_assoc whenever a listing
-- is added or refreshed; lets the UI bucket listings by driver even before
-- (or without) a manual registry link.
--
-- NULL = no confident match found (title didn't contain any known driver
-- name). The column is a soft hint, not a foreign-key constraint we lean on
-- — drivers can be deleted in theory, so we use ON DELETE SET NULL.
ALTER TABLE listings
    ADD COLUMN driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL;

CREATE INDEX idx_listings_driver ON listings(driver_id);
