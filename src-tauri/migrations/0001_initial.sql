-- Settings: simple key/value, secrets live in OS keyring instead.
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Drivers normalized once so registry entries, listings, and the collection
-- can all reference the same driver row.
CREATE TABLE drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    normalized_name TEXT NOT NULL UNIQUE
);

-- A "paint scheme" is a driver/season/sponsor combo. Multiple registry
-- entries (different scales, finishes, OEMs) can share one paint scheme.
CREATE TABLE paint_schemes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sponsor TEXT,
    season INTEGER,
    UNIQUE(driver_id, name, season)
);

-- Master registry imported from diecastregistry.com.
CREATE TABLE registry_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE,
    driver_id INTEGER REFERENCES drivers(id),
    paint_scheme_id INTEGER REFERENCES paint_schemes(id),
    year INTEGER,
    oem TEXT,
    brand TEXT,
    make TEXT,
    scale TEXT,
    finish TEXT,
    production_qty INTEGER,
    retail_value_cents INTEGER,
    wholesale_value_cents INTEGER,
    raw_json TEXT,
    fetched_at INTEGER
);

CREATE INDEX idx_registry_driver ON registry_entries(driver_id);
CREATE INDEX idx_registry_paint_scheme ON registry_entries(paint_scheme_id);
CREATE INDEX idx_registry_year ON registry_entries(year);

-- The user's personal collection, imported from diecastregistry.com.
CREATE TABLE my_collection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registry_entry_id INTEGER REFERENCES registry_entries(id),
    acquired_at INTEGER,
    paid_cents INTEGER,
    condition TEXT,
    notes TEXT,
    source TEXT,
    external_id TEXT,
    raw_json TEXT,
    imported_at INTEGER NOT NULL
);

CREATE INDEX idx_collection_registry ON my_collection(registry_entry_id);

-- Sources of saved listings. Seed eBay and Facebook Marketplace.
CREATE TABLE sellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL
);

INSERT INTO sellers (code, display_name) VALUES
    ('ebay', 'eBay'),
    ('fb', 'Facebook Marketplace');

CREATE TABLE listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL REFERENCES sellers(id),
    external_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    price_cents INTEGER,
    shipping_cents INTEGER,
    currency TEXT NOT NULL DEFAULT 'USD',
    condition TEXT,
    listing_type TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    end_time INTEGER,
    seller_username TEXT,
    seller_rating REAL,
    image_url TEXT,
    saved_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    raw_json TEXT,
    raw_html TEXT,
    UNIQUE(seller_id, external_id)
);

CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_seller ON listings(seller_id);

-- Mapping from a listing to a registry entry. Confidence + user_confirmed
-- lets the matcher learn over time.
CREATE TABLE listing_matches (
    listing_id INTEGER PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
    registry_entry_id INTEGER REFERENCES registry_entries(id),
    confidence REAL NOT NULL DEFAULT 0.0,
    user_confirmed INTEGER NOT NULL DEFAULT 0,
    matched_at INTEGER NOT NULL
);

CREATE INDEX idx_matches_registry ON listing_matches(registry_entry_id);

-- Time series of price/status snapshots so we can show "watched 3 weeks,
-- dropped $20."
CREATE TABLE listing_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    observed_at INTEGER NOT NULL,
    price_cents INTEGER,
    shipping_cents INTEGER,
    status TEXT
);

CREATE INDEX idx_history_listing ON listing_history(listing_id);
