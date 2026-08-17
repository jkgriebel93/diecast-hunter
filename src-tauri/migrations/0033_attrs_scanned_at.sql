-- DCH-60: high-water mark for the startup attribute backfill. The scan used
-- to re-read and JSON-parse every non-pinned listing's raw_json (~38 KB/row)
-- on every launch; with this stamp it only revisits rows it has never
-- scanned, or rows scanned before the detection vocabulary (the registry
-- form-options cache) was last refreshed — a newer vocabulary can detect
-- things the old one missed, so it earns one full re-scan.
ALTER TABLE listings ADD COLUMN attrs_scanned_at INTEGER;
