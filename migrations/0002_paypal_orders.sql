CREATE TABLE IF NOT EXISTS paypal_orders (
  order_id TEXT PRIMARY KEY,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  capture_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_paypal_orders_status
  ON paypal_orders (status);
