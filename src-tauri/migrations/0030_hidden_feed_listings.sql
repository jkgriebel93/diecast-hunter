-- "Not interested" dismissals on the Seller Feed (DCH-51). The feed is a
-- live eBay Browse search, not local rows, so a dismissal has to be keyed
-- by the eBay item id and applied as an exclusion after every fetch —
-- otherwise the listing reappears on the next refresh.
--
-- Deliberately its own table rather than a flag on `listings`: most feed
-- items have no local row (a listing only lands in `listings` when
-- watched), and nothing outside the feed reads this table, which is what
-- keeps a dismissal from ever affecting Saved Listings or Browse.
--
-- Title and seller are denormalized at dismissal time purely so the
-- review/un-hide list can say what a row is without asking eBay — the
-- listing may have ended by then. They are display hints, not data.
CREATE TABLE hidden_feed_listings (
  item_id TEXT PRIMARY KEY,
  title TEXT,
  seller_username TEXT,
  hidden_at INTEGER NOT NULL
);
