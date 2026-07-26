-- Multiple named wishlists. The 0017 schema hard-coded a single list
-- (`wishlist` rows were the entries, UNIQUE on registry_entry_id). Now
-- `wishlists` holds the lists and entries move to `wishlist_entries`,
-- unique per (list, registry entry) so the same diecast can sit on two
-- different lists. sort_rank stays per-list.
--
-- SQLite can't alter constraints in place, so the entry + link tables are
-- rebuilt under new names and the old ones dropped child-first (dropping
-- the parent first would cascade-delete the link rows). Ids are copied
-- verbatim so nothing external shifts.

CREATE TABLE wishlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Everything existing lands on a seeded default list.
INSERT INTO wishlists (id, name, created_at) VALUES (1, 'Wishlist', strftime('%s', 'now'));

CREATE TABLE wishlist_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wishlist_id INTEGER NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
    registry_entry_id INTEGER NOT NULL REFERENCES registry_entries(id) ON DELETE CASCADE,
    notes TEXT,
    added_at INTEGER NOT NULL,
    sort_rank INTEGER NOT NULL DEFAULT 0,
    UNIQUE(wishlist_id, registry_entry_id)
);

INSERT INTO wishlist_entries (id, wishlist_id, registry_entry_id, notes, added_at, sort_rank)
SELECT id, 1, registry_entry_id, notes, added_at, sort_rank FROM wishlist;

CREATE TABLE wishlist_entry_listings (
    entry_id INTEGER NOT NULL REFERENCES wishlist_entries(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (entry_id, listing_id)
);

INSERT INTO wishlist_entry_listings (entry_id, listing_id, linked_at)
SELECT wishlist_id, listing_id, linked_at FROM wishlist_listings;

DROP TABLE wishlist_listings;
DROP TABLE wishlist;

CREATE INDEX idx_wishlist_entries_list ON wishlist_entries(wishlist_id);
CREATE INDEX idx_wishlist_entry_listings_listing ON wishlist_entry_listings(listing_id);
