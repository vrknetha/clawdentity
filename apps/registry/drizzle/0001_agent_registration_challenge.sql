CREATE TABLE `agent_registration_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`public_key` text NOT NULL,
	`nonce` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_registration_challenges_owner_status` ON `agent_registration_challenges` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_registration_challenges_expires_at` ON `agent_registration_challenges` (`expires_at`);
