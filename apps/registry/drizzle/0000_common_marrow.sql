CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`framework` text,
	`public_key` text NOT NULL,
	`current_jti` text,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text,
	`gateway_hint` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_did_unique` ON `agents` (`did`);--> statement-breakpoint
CREATE INDEX `idx_agents_owner_status` ON `agents` (`owner_id`,`status`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_api_keys_key_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `humans` (
	`id` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `humans_did_unique` ON `humans` (`did`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_by` text NOT NULL,
	`redeemed_by` text,
	`agent_id` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redeemed_by`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_unique` ON `invites` (`code`);--> statement-breakpoint
CREATE TABLE `revocations` (
	`id` text PRIMARY KEY NOT NULL,
	`jti` text NOT NULL,
	`agent_id` text NOT NULL,
	`reason` text,
	`revoked_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revocations_jti_unique` ON `revocations` (`jti`);--> statement-breakpoint
CREATE INDEX `idx_revocations_agent_id` ON `revocations` (`agent_id`);