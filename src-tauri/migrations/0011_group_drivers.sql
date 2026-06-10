-- Associate listing groups with drivers (many-to-many). Most groups map to
-- a single driver, but a multi-car lot ("Lots") or a cross-driver theme
-- ("2024 Rookies") can carry several drivers — or none, in which case the
-- group is driverless and lands in the "No driver" bucket of the grouped
-- views. This replaces the old convention of prefixing every group name with
-- the driver's last name; see the migration wizard in the Listings UI.
CREATE TABLE group_drivers (
    group_id  INTEGER NOT NULL REFERENCES listing_groups(id) ON DELETE CASCADE,
    driver_id INTEGER NOT NULL REFERENCES drivers(id)        ON DELETE CASCADE,
    PRIMARY KEY (group_id, driver_id)
);

CREATE INDEX idx_group_drivers_driver ON group_drivers(driver_id);
