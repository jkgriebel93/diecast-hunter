-- Wishlist: registry entries the user wants to acquire. One row per
-- registry entry — adding the same entry twice is a no-op. Entries are
-- created from registry-search results, which upsert a registry_entries
-- stub first (same path as the pre-warm), so the FK target always exists.
CREATE TABLE wishlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registry_entry_id INTEGER NOT NULL UNIQUE
        REFERENCES registry_entries(id) ON DELETE CASCADE,
    notes TEXT,
    added_at INTEGER NOT NULL
);

-- Saved listings (eBay / FB Marketplace) the user has flagged as candidates
-- for a wishlist entry. Many-to-many: one listing (e.g. a lot) can satisfy
-- several wishes, and one wish usually collects several candidate listings.
CREATE TABLE wishlist_listings (
    wishlist_id INTEGER NOT NULL REFERENCES wishlist(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (wishlist_id, listing_id)
);

CREATE INDEX idx_wishlist_listings_listing ON wishlist_listings(listing_id);
