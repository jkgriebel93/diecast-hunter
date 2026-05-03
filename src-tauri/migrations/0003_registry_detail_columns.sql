-- Columns populated by the lazy-enrichment of registry_entries from
-- diecastregistry.com detail pages. Photos and the long race-narrative
-- comments stay in raw_json; only fields useful for filtering, searching,
-- or display in lists are promoted to columns.
ALTER TABLE registry_entries ADD COLUMN year_raced INTEGER;
ALTER TABLE registry_entries ADD COLUMN car_number TEXT;
ALTER TABLE registry_entries ADD COLUMN diecast_type TEXT;
ALTER TABLE registry_entries ADD COLUMN registration_number TEXT;
ALTER TABLE registry_entries ADD COLUMN scheme_text TEXT;

-- fetched_at is set at stub-creation time too (when we first see a row in
-- the collection list). details_fetched_at is set only when we've fetched
-- the full detail page, so the enrichment orchestrator can find rows that
-- still need enriching.
ALTER TABLE registry_entries ADD COLUMN details_fetched_at INTEGER;
