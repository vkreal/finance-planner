ALTER TABLE `monthly_cash_out_items` ADD COLUMN `day` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `monthly_cash_out_items` SET `day` = 1;
