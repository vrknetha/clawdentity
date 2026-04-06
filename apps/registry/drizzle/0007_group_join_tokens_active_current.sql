ALTER TABLE `group_join_tokens`
ADD COLUMN `token_ciphertext` text NOT NULL DEFAULT '';
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_group_join_tokens_expires`;
--> statement-breakpoint
ALTER TABLE `group_join_tokens`
DROP COLUMN `max_uses`;
--> statement-breakpoint
ALTER TABLE `group_join_tokens`
DROP COLUMN `used_count`;
--> statement-breakpoint
ALTER TABLE `group_join_tokens`
DROP COLUMN `expires_at`;
--> statement-breakpoint
CREATE INDEX `idx_group_join_tokens_revoked` ON `group_join_tokens` (`revoked_at`);
