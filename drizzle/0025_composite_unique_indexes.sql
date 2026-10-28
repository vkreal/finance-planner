CREATE UNIQUE INDEX `nw_balances_snapshot_account_unique` ON `nw_balances` (`snapshot_id`, `account_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `monthly_bill_versions_bill_effective_unique` ON `monthly_bill_versions` (`bill_id`, `effective_from`);
--> statement-breakpoint
CREATE UNIQUE INDEX `yearly_expense_versions_expense_effective_unique` ON `yearly_expense_versions` (`expense_id`, `effective_from`);
