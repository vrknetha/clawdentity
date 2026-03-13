ALTER TABLE `humans` ADD `onboarding_source` text;
--> statement-breakpoint
ALTER TABLE `humans` ADD `agent_limit` integer;
--> statement-breakpoint
CREATE TABLE `starter_passes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`provider_login` text NOT NULL,
	`display_name` text NOT NULL,
	`redeemed_by` text,
	`issued_at` text NOT NULL,
	`redeemed_at` text,
	`expires_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`redeemed_by`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `starter_passes_code_unique` ON `starter_passes` (`code`);
--> statement-breakpoint
CREATE UNIQUE INDEX `starter_passes_provider_subject_unique` ON `starter_passes` (`provider`,`provider_subject`);
--> statement-breakpoint
CREATE INDEX `idx_starter_passes_code_status` ON `starter_passes` (`code`,`status`);
