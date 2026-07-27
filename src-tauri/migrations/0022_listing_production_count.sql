-- Manually entered production-run size for a listing (the "1 of 5,004"
-- number). Sellers rarely put the run in the title or description — it is
-- usually only visible in a photo of the production tag — so this column
-- is filled by the user from that photo via the attribute editor. It feeds
-- the matcher's production-count signal, its single strongest
-- discriminator between variant schemes.
ALTER TABLE listings ADD COLUMN production_count INTEGER;
