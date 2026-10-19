ALTER TABLE `nw_balances` ADD COLUMN `split_hsa_cents` text;
--> statement-breakpoint
ALTER TABLE `nw_balances` ADD COLUMN `split_roth_cents` text;
--> statement-breakpoint
ALTER TABLE `nw_balances` ADD COLUMN `split_taxable_cents` text;
--> statement-breakpoint
ALTER TABLE `nw_balances` ADD COLUMN `split_non_taxable_cents` text;
