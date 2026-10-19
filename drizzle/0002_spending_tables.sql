DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE yearly_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  expected_cents INTEGER NOT NULL,
  due_month INTEGER,
  paid_by_type TEXT NOT NULL DEFAULT 'checking',
  paid_by_name TEXT NOT NULL DEFAULT 'Checking',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'checking',
  account_name TEXT NOT NULL DEFAULT 'Checking',
  kind TEXT NOT NULL DEFAULT 'spending',
  category TEXT NOT NULL DEFAULT 'Other',
  yearly_expense_id INTEGER REFERENCES yearly_expenses(id),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
