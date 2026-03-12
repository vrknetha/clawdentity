CREATE TABLE `agent_auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`refresh_key_hash` text NOT NULL,
	`refresh_key_prefix` text NOT NULL,
	`refresh_issued_at` text NOT NULL,
	`refresh_expires_at` text NOT NULL,
	`refresh_last_used_at` text,
	`access_key_hash` text NOT NULL,
	`access_key_prefix` text NOT NULL,
	`access_issued_at` text NOT NULL,
	`access_expires_at` text NOT NULL,
	`access_last_used_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_auth_sessions_agent_id_unique` ON `agent_auth_sessions` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_auth_sessions_agent_status` ON `agent_auth_sessions` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_auth_sessions_refresh_prefix` ON `agent_auth_sessions` (`refresh_key_prefix`);--> statement-breakpoint
CREATE INDEX `idx_agent_auth_sessions_access_prefix` ON `agent_auth_sessions` (`access_key_prefix`);--> statement-breakpoint
CREATE TABLE `agent_auth_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`event_type` text NOT NULL,
	`reason` text,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `agent_auth_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_auth_events_agent_created` ON `agent_auth_events` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_auth_events_session_created` ON `agent_auth_events` (`session_id`,`created_at`);
