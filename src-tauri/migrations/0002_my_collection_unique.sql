-- The v1 schema lacked a uniqueness constraint on my_collection's external_id,
-- so the dcr-sync upsert (ON CONFLICT(source, external_id)) couldn't work.
-- Add a composite UNIQUE INDEX. Composite (rather than just external_id)
-- because future sources (ebay, manual entry) may reuse identifiers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_my_collection_source_external
    ON my_collection(source, external_id);
