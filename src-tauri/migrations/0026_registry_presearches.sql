-- Named registry pre-searches (DCH-14).
--
-- A pre-search stores a *filter combination*, not a result set. The cache it
-- warms is `registry_entries` itself — refreshing one walks the DCR
-- production search for its filters and upserts every hit through the same
-- `upsert_stub_from_search` path `registry_prewarm` uses. Opening a
-- pre-search then answers from local rows, which is what makes the filtering
-- instant.
--
-- Storing entry ids per pre-search instead would mean a second copy of data
-- that already lives in `registry_entries`, going stale on its own schedule
-- and needing its own pruning. This way one refresh benefits every search
-- that overlaps it, and local/hybrid registry search gets the same rows for
-- free.
--
-- `filter_json` is a serialized ProductionSearchFilter. It is stored whole
-- rather than as columns because the filter has seven multi-value GUID lists
-- plus flags, and the DCR form it targets has changed shape before — a JSON
-- blob absorbs that without a migration.
CREATE TABLE registry_presearches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    filter_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    -- When the DCR walk last completed for this filter. NULL = never run, so
    -- opening it falls back to whatever local rows happen to exist.
    last_refreshed_at INTEGER,
    -- Results the last successful walk saw. Lets the UI show "312 entries"
    -- without re-running anything.
    last_result_count INTEGER,
    -- Why the last refresh failed, if it did. Kept rather than surfaced as an
    -- error at refresh time: the overnight auto-sync is headless, so this is
    -- the only place a failure would otherwise be visible.
    last_error TEXT
);

CREATE INDEX idx_presearches_name ON registry_presearches(name);
