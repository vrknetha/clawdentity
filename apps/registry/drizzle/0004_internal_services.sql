DROP TABLE IF EXISTS `proxy_pairing_keys`;
--> statement-breakpoint
CREATE TABLE `internal_services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`secret_prefix` text NOT NULL,
	`scopes_json` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`rotated_at` text,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internal_services_name_unique` ON `internal_services` (`name`);
--> statement-breakpoint
CREATE INDEX `idx_internal_services_secret_prefix` ON `internal_services` (`secret_prefix`);
--> statement-breakpoint
CREATE INDEX `idx_internal_services_status` ON `internal_services` (`status`);
