-- Public-link sharing for wishlists (DCH-46).
--
-- One active share per list, tracked here so the UI can offer "copy link /
-- revoke" instead of minting a new URL every time. The slug is the only
-- credential the shared page has, so it is also the handle used to revoke.
--
-- Not a separate table: a list has at most one live share, and a history of
-- expired ones is not something anyone asked to keep. Re-sharing overwrites.
ALTER TABLE wishlists ADD COLUMN share_slug TEXT;
ALTER TABLE wishlists ADD COLUMN share_url TEXT;
ALTER TABLE wishlists ADD COLUMN shared_at INTEGER;
-- Unix seconds. The worker enforces the real lifetime via its KV TTL; this
-- copy is what lets the UI say "expires in 12 days" without a round trip,
-- and what makes an expired share visibly stale rather than silently dead.
ALTER TABLE wishlists ADD COLUMN share_expires_at INTEGER;
