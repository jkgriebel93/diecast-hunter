-- Marks `listings.driver_id` as user-pinned, so the auto-association pass
-- in sync::driver_assoc skips it on subsequent refreshes. Without this
-- flag, manually tagging a listing with "Jeff Gordon" would get silently
-- overwritten the next time the listing was refreshed and the title's
-- best-token-match resolved to a different driver.
--
-- 0 = auto-detected (overwritable). 1 = user explicitly set this — also
-- applies when the user clears to NULL on purpose ("this isn't any of the
-- drivers I have, leave it alone").
ALTER TABLE listings
    ADD COLUMN driver_id_user_set INTEGER NOT NULL DEFAULT 0;
