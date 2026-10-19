ALTER TABLE `yearly_expenses` ADD `category` text DEFAULT 'Uncategorized' NOT NULL;
--> statement-breakpoint
ALTER TABLE `monthly_bills` ADD `category` text DEFAULT 'Uncategorized' NOT NULL;
--> statement-breakpoint
ALTER TABLE `yearly_expenses` DROP COLUMN `keep_lights_on`;
--> statement-breakpoint
ALTER TABLE `monthly_bills` DROP COLUMN `keep_lights_on`;
