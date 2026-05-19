-- Named groups of saved listings — user-curated buckets for tracking
-- specific paint-scheme hunts, build lists, etc. A listing can belong to
-- any number of groups (many-to-many) so a multi-car lot can sit in two
-- hunts at once. `target_price_cents` is a soft ceiling that the UI uses
-- to highlight listings that are at/under the price the user is willing
-- to pay. `archived` lets the user retire resolved hunts without losing
-- the membership history.
CREATE TABLE listing_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    target_price_cents INTEGER,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_listing_groups_archived ON listing_groups(archived);

CREATE TABLE listing_group_members (
    group_id INTEGER NOT NULL REFERENCES listing_groups(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, listing_id)
);

CREATE INDEX idx_listing_group_members_listing ON listing_group_members(listing_id);
