CREATE TABLE monthly_summaries (
  month TEXT PRIMARY KEY,
  cash_out_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE monthly_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_by TEXT NOT NULL DEFAULT 'Checking',
  notes TEXT,
  created_at INTEGER NOT NULL
);
