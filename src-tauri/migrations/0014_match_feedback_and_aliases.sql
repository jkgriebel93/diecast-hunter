-- Append-only log of user verdicts on listing↔registry matches. Unlike
-- listing_matches (one mutable row per listing), rows here are never
-- updated or deleted — they are the training data for tuning the
-- auto-matcher's weights over time. features_json holds the named feature
-- vector for the (listing, entry) pair as computed when the verdict was
-- recorded; score is the scorer's raw output for that vector.
CREATE TABLE match_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    -- NULL only for 'rejected' verdicts where no entry was suggested
    -- (the user marked the listing as having no registry match at all).
    registry_entry_id INTEGER REFERENCES registry_entries(id) ON DELETE CASCADE,
    -- 'confirmed'      — user accepted this pairing (manual link or confirm)
    -- 'rejected'       — user said this pairing (or any pairing) is wrong
    -- 'corrected_away' — an auto-suggestion the user replaced with another entry
    label TEXT NOT NULL CHECK (label IN ('confirmed', 'rejected', 'corrected_away')),
    -- Which UI path produced the verdict: 'manual_link', 'confirm_button',
    -- 'reject_button', … Kept free-form for future surfaces (extension).
    source TEXT NOT NULL,
    features_json TEXT,
    score REAL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_match_feedback_listing ON match_feedback(listing_id);
CREATE INDEX idx_match_feedback_entry ON match_feedback(registry_entry_id);

-- Seller-vocabulary → registry-vocabulary token bridges used by the scheme
-- overlap scorer: a listing-title token `alias` counts as a hit for a
-- scheme_text token `canonical`. source: 'seed' (shipped), 'manual'
-- (user-added), 'learned' (mined from confirmed matches — future).
CREATE TABLE scheme_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL,
    canonical TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'seed',
    created_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(alias, canonical)
);

INSERT INTO scheme_aliases (alias, canonical, source) VALUES
    ('chevy', 'chevrolet', 'seed'),
    ('bud', 'budweiser', 'seed'),
    ('mtn', 'mountain', 'seed'),
    ('coke', 'coca', 'seed'),
    ('coke', 'cola', 'seed'),
    ('jr', 'junior', 'seed'),
    ('sr', 'senior', 'seed'),
    ('natl', 'national', 'seed'),
    ('vette', 'corvette', 'seed'),
    ('lowes', 'lowe', 'seed'),
    ('anniv', 'anniversary', 'seed');
