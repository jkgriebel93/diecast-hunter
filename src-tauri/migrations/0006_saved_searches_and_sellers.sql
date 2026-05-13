-- User-curated saved searches against the eBay Browse API. Filters are
-- stored as scalar columns where they're well-defined, and as JSON arrays
-- for the multi-value chip filters (conditions, buying options, sellers)
-- so we don't need a side table per filter. `last_run_at` is updated when
-- the user runs the search from the UI; it's purely informational.
CREATE TABLE saved_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    query TEXT NOT NULL DEFAULT '',
    conditions_json TEXT NOT NULL DEFAULT '[]',
    buying_options_json TEXT NOT NULL DEFAULT '[]',
    sellers_json TEXT NOT NULL DEFAULT '[]',
    price_min_cents INTEGER,
    price_max_cents INTEGER,
    sort TEXT,
    created_at INTEGER NOT NULL,
    last_run_at INTEGER
);

CREATE INDEX idx_saved_searches_name ON saved_searches(name);

-- Per-marketplace seller bookmarks. `seller_code` lets us add Facebook or
-- other sources later without a schema change; today everything is 'ebay'.
-- We dedup case-insensitively on the username because eBay usernames are
-- case-insensitive in practice.
CREATE TABLE saved_sellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_code TEXT NOT NULL,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL,
    display_name TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(seller_code, username_lower)
);

CREATE INDEX idx_saved_sellers_code ON saved_sellers(seller_code);
