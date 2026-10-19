CREATE TABLE yearly_expense_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER NOT NULL REFERENCES yearly_expenses(id),
  expected_cents INTEGER NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'yearly',
  effective_from TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO yearly_expense_versions (expense_id, expected_cents, frequency, effective_from, created_at)
SELECT id, expected_cents, frequency, strftime('%Y-%m', created_at / 1000, 'unixepoch'), created_at FROM yearly_expenses;
