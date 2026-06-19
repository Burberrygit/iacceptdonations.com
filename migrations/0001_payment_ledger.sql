CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payment_id TEXT,
  amount_cents INTEGER,
  currency TEXT,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_provider_payment
  ON donations (provider, payment_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_type
  ON webhook_events (provider, event_type);

CREATE INDEX IF NOT EXISTS idx_donations_status
  ON donations (status);
