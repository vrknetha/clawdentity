CREATE TABLE `proxy_pairing_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer_origin` text NOT NULL,
	`pkid` text NOT NULL,
	`public_key_x` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_proxy_pairing_keys_issuer_pkid` ON `proxy_pairing_keys` (`issuer_origin`,`pkid`);
--> statement-breakpoint
CREATE INDEX `idx_proxy_pairing_keys_expires_at` ON `proxy_pairing_keys` (`expires_at`);
