-- DCH-56: the watchlist sync used to append a listing_history row per
-- listing per run, unconditionally; measured on the production DB
-- (2026-08-12), 67,062 of 68,841 rows (97.4%) recorded no change in price,
-- shipping, or status versus the previous observation. The sync now skips
-- no-change observations; this one-time cleanup collapses the runs it
-- already wrote.
--
-- Each run of consecutive identical observations keeps its FIRST and LAST
-- row, so the span a value held ("watched 3 weeks at $45") survives — only
-- the interior of each run is deleted. `IS` makes NULLs compare equal,
-- matching the sync's skip comparison. The LAG(id)/LEAD(id) guards pin the
-- partition edges: a first/last row must never count as "same as" the
-- neighbor it doesn't have, even if every compared column is NULL.
DELETE FROM listing_history
WHERE id IN (
    SELECT id
    FROM (
        SELECT id,
               (LAG(id) OVER w IS NOT NULL
                AND price_cents IS LAG(price_cents) OVER w
                AND shipping_cents IS LAG(shipping_cents) OVER w
                AND status IS LAG(status) OVER w) AS same_as_prev,
               (LEAD(id) OVER w IS NOT NULL
                AND price_cents IS LEAD(price_cents) OVER w
                AND shipping_cents IS LEAD(shipping_cents) OVER w
                AND status IS LEAD(status) OVER w) AS same_as_next
        FROM listing_history
        WINDOW w AS (PARTITION BY listing_id ORDER BY observed_at, id)
    )
    WHERE same_as_prev AND same_as_next
);
