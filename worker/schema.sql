-- Inbound email store for the cloudmail worker.
CREATE TABLE IF NOT EXISTS emails (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender       TEXT NOT NULL,            -- envelope MAIL FROM (trustworthy)
  recipient    TEXT NOT NULL,            -- envelope RCPT TO
  subject      TEXT,
  text         TEXT,                     -- plain-text body
  html         TEXT,                     -- html body (if any)
  message_id   TEXT,
  in_reply_to  TEXT,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  read         INTEGER NOT NULL DEFAULT 0,
  intent       TEXT                      -- optional Workers-AI classification JSON ({kind,service,action_url,confidence}); null when unavailable
);

CREATE INDEX IF NOT EXISTS idx_emails_recipient_received
  ON emails (recipient, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_emails_received
  ON emails (received_at DESC);
