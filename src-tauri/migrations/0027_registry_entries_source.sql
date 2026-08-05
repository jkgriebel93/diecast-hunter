-- Provenance for registry_entries, so manually-added cars (DCH-12) can be
-- told apart from rows that came off diecastregistry.com.
--
-- Until now provenance lived inside raw_json ('$.source' is written by
-- registry_prewarm and the detail-page enrichment). That's fine for
-- bookkeeping but useless as a filter: every DCR-facing flow needs to
-- *exclude* local rows, and json_extract on every row is both slow and
-- silently wrong for rows whose raw_json is NULL or invalid.
--
-- Defaulting to 'diecastregistry' backfills every existing row correctly:
-- before this migration, every registry entry came from DCR.
ALTER TABLE registry_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'diecastregistry';

-- Partial, because the interesting set is the small one. Queries that filter
-- `source <> 'local'` match nearly every row and are better off scanning;
-- the ones that want *only* local entries (the collection list's manual-entry
-- badge) get an index that stays proportional to how many the user typed in.
CREATE INDEX idx_registry_entries_local ON registry_entries(source)
    WHERE source = 'local';
