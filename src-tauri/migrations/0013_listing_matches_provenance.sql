-- Provenance for listing_matches rows, added with the auto-matcher.
-- matched_by: 'manual' (registry-search dialog) or 'auto'
-- (sync::registry_auto_match). NULL for rows written before this migration —
-- those were all manual links, but we leave them NULL rather than guess.
-- match_reasons: JSON array of human-readable strings explaining which
-- signals contributed to an auto-match's confidence. NULL for manual links.
ALTER TABLE listing_matches ADD COLUMN matched_by TEXT;
ALTER TABLE listing_matches ADD COLUMN match_reasons TEXT;
