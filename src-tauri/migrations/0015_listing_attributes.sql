-- Structured attributes on saved listings, replacing the old convention of
-- encoding them as listing_groups ("Elite", "Color Chrome", "Autograph", …).
-- Groups stay reserved for user-curated hunts; these are properties a
-- listing *has*.
--
-- brand / finish / make mirror the same-named columns on registry_entries
-- (make is the windowed-car/bank code: CWC, CWB, BWC, BWB). All three are
-- nullable free text — the UI suggests canonical values from the
-- registry_form_options cache but doesn't enforce them. For listings linked
-- to a registry entry the entry's values are authoritative; these columns
-- matter for unmatched rows and as a cross-check signal.
--
-- Manual-only for now: nothing auto-populates these (unlike driver_id).
ALTER TABLE listings ADD COLUMN brand TEXT;
ALTER TABLE listings ADD COLUMN finish TEXT;
ALTER TABLE listings ADD COLUMN make TEXT;
ALTER TABLE listings ADD COLUMN is_race_win INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN is_autographed INTEGER NOT NULL DEFAULT 0;
