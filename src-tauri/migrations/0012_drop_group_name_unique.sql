-- Drop the global UNIQUE(name) constraint on listing_groups. Now that groups
-- are linked to drivers (many-to-many, migration 0011), names no longer need
-- to be globally unique: "Rookie Year" can exist under several drivers, and
-- the driver-clustered UI disambiguates by section. Group identity is `id`
-- everywhere in the app, never name.
--
-- SQLite can't drop a constraint in place, and the auto-index backing a UNIQUE
-- column can't be dropped either, so the table must be rebuilt. The catch:
-- foreign_keys is ON for every connection and can't be turned off inside a
-- transaction (and sqlx's SQLite driver always runs migrations in one), so a
-- plain DROP of listing_groups would fire an implicit DELETE that cascades
-- into listing_group_members and group_drivers and wipes every membership.
-- To avoid that, rebuild the child tables first so they reference the NEW
-- parent, then drop the originals — by which point nothing references the old
-- listing_groups and its drop cascades to nothing.

-- 1. New parent, identical except for the removed UNIQUE on name.
CREATE TABLE listing_groups_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    target_price_cents INTEGER,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
INSERT INTO listing_groups_new (id, name, description, target_price_cents, archived, created_at)
    SELECT id, name, description, target_price_cents, archived, created_at
      FROM listing_groups;

-- 2. Rebuilt children that reference the new parent.
CREATE TABLE listing_group_members_new (
    group_id INTEGER NOT NULL REFERENCES listing_groups_new(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, listing_id)
);
INSERT INTO listing_group_members_new (group_id, listing_id, added_at)
    SELECT group_id, listing_id, added_at FROM listing_group_members;

CREATE TABLE group_drivers_new (
    group_id INTEGER NOT NULL REFERENCES listing_groups_new(id) ON DELETE CASCADE,
    driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, driver_id)
);
INSERT INTO group_drivers_new (group_id, driver_id)
    SELECT group_id, driver_id FROM group_drivers;

-- 3. Drop the originals — children first, then the now-unreferenced parent.
DROP TABLE listing_group_members;
DROP TABLE group_drivers;
DROP TABLE listing_groups;

-- 4. Swap the rebuilt tables into place. Renaming listing_groups_new rewrites
--    the REFERENCES in the *_new children to the final table name.
ALTER TABLE listing_groups_new RENAME TO listing_groups;
ALTER TABLE listing_group_members_new RENAME TO listing_group_members;
ALTER TABLE group_drivers_new RENAME TO group_drivers;

-- 5. Recreate the indexes dropped along with the old tables.
CREATE INDEX idx_listing_groups_archived ON listing_groups(archived);
CREATE INDEX idx_listing_group_members_listing ON listing_group_members(listing_id);
CREATE INDEX idx_group_drivers_driver ON group_drivers(driver_id);
