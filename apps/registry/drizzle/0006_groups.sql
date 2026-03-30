CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_groups_created_by` ON `groups` (`created_by`);
--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`group_id`, `agent_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_group_members_group` ON `group_members` (`group_id`);
--> statement-breakpoint
CREATE INDEX `idx_group_members_agent` ON `group_members` (`agent_id`);
--> statement-breakpoint
CREATE TABLE `group_join_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`issued_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_by`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_join_tokens_token_hash_unique` ON `group_join_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_group_join_tokens_prefix` ON `group_join_tokens` (`token_prefix`);
--> statement-breakpoint
CREATE INDEX `idx_group_join_tokens_group` ON `group_join_tokens` (`group_id`);
--> statement-breakpoint
CREATE INDEX `idx_group_join_tokens_expires` ON `group_join_tokens` (`expires_at`);
