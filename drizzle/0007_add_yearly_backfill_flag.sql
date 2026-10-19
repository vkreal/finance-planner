ALTER TABLE yearly_expenses ADD COLUMN backfill_before_first_version INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE yearly_expenses SET backfill_before_first_version = 1;
