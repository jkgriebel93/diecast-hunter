-- Cached dropdown options from diecastregistry.com's /Production filter form.
-- Refreshed periodically (or on demand) so the in-app registry-search dialog
-- can populate driver / OEM / brand / scale / etc. selectors without scraping
-- the form on every render.
--
-- field is the logical kind ('driver', 'oem', 'brand', 'make', 'scale',
-- 'finish', 'diecast_type', 'year'). value is whatever the form expects in
-- the POST body — a GUID for most fields, a plain string for year and
-- diecast_type. display is the human-readable label, normalized is a
-- lowercased+slugified form of display for fuzzy local lookup.
CREATE TABLE registry_form_options (
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    display TEXT NOT NULL,
    normalized TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (field, value)
);

CREATE INDEX idx_form_options_field ON registry_form_options(field);
CREATE INDEX idx_form_options_normalized ON registry_form_options(normalized);
