-- Public links for things that aren't a durable entity (DCH-48).
--
-- DCH-46 hung a wishlist's share on the `wishlists` row itself, which works
-- because a wishlist outlives its share. A shared *selection* of listings has
-- no such row: it is five listings someone picked on Tuesday, and the only
-- thing that survives the click is the link. So the share becomes the record.
--
-- `kind` is what the slug points at, so a future share type (a group, a
-- driver's cars) lands here rather than growing another set of columns on
-- another table. Wishlist shares deliberately stay where they are for now —
-- migrating them is a follow-up, and doing it in this ticket would mean
-- rewriting a working feature to prove a point about symmetry.
CREATE TABLE shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    -- User-facing name. A selection has no inherent one, so the dialog
    -- prefills something like "5 listings — Aug 11, 2026" and the user can
    -- overwrite it. NOT NULL: a share with no name is a row nobody can
    -- identify in the Settings list, which is where revoking happens.
    label TEXT NOT NULL,
    -- The slug is the only credential the public page has, so it is also the
    -- handle used to revoke. UNIQUE guards against a Worker that somehow
    -- reissued one; 128 bits of randomness makes that a bug, not a collision.
    slug TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    -- How many items went into the document. Not derivable later: the
    -- listings it was built from can be archived or deleted, and the page
    -- itself is a frozen snapshot on someone else's server.
    item_count INTEGER NOT NULL,
    shared_at INTEGER NOT NULL,
    -- Unix seconds, or NULL if the Worker didn't say. The Worker's KV TTL is
    -- the real lifetime; this copy is what lets the UI show an expiry without
    -- a round trip, and what makes a lapsed share visibly stale.
    expires_at INTEGER
);

CREATE INDEX idx_shares_shared_at ON shares(shared_at DESC);
