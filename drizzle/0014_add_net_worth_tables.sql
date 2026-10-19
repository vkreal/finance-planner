CREATE TABLE `nw_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nw_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nw_snapshots_date_unique` ON `nw_snapshots` (`date`);
--> statement-breakpoint
CREATE TABLE `nw_balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL REFERENCES `nw_snapshots`(`id`),
	`account_id` integer NOT NULL REFERENCES `nw_accounts`(`id`),
	`balance_cents` integer NOT NULL
);
