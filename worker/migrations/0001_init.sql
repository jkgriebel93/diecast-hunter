CREATE TABLE IF NOT EXISTS marketplace_deletions (
  notification_id TEXT PRIMARY KEY,
  received_at     INTEGER NOT NULL,   -- ms epoch
  acked_at        INTEGER,            -- ms epoch; NULL = pending
  user_id         TEXT,               -- notification.userId
  username        TEXT,               -- notification.username (anonymized form)
  eias_token      TEXT,               -- notification.eiasToken
  raw             TEXT NOT NULL       -- full JSON of body.notification
);

CREATE INDEX IF NOT EXISTS idx_md_pending
  ON marketplace_deletions(acked_at, received_at);

CREATE INDEX IF NOT EXISTS idx_md_user_id
  ON marketplace_deletions(user_id);
