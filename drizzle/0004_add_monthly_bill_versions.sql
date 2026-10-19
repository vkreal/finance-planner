CREATE TABLE monthly_bill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES monthly_bills(id),
  amount_cents INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO monthly_bill_versions (bill_id, amount_cents, effective_from, created_at)
SELECT id, amount_cents, strftime('%Y-%m', created_at / 1000, 'unixepoch'), created_at FROM monthly_bills;
