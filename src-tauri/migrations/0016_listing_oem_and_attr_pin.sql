-- OEM joins the listing-level attribute set from 0015 (mirrors
-- registry_entries.oem: Action / Lionel, Racing Champions, Revell, …).
ALTER TABLE listings ADD COLUMN oem TEXT;

-- The attributes are no longer manual-only: sync::attribute_assoc detects
-- oem / brand / make / finish and the race-win + autograph flags from the
-- listing title on every add/refresh (vocabulary comes from the
-- registry_form_options cache). Auto-detection only ever fills NULL text
-- columns and flips flags 0→1 — it never overwrites.
--
-- attributes_user_set = 1 means the user saved the attribute editor for
-- this row; auto-detection then skips it entirely, same convention as
-- driver_id_user_set. commands::reset_listing_attributes drops the pin,
-- clears the fields, and re-runs detection.
ALTER TABLE listings ADD COLUMN attributes_user_set INTEGER NOT NULL DEFAULT 0;
