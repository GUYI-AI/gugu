DROP INDEX IF EXISTS `idx_sessions_archived_at`;
--> statement-breakpoint
CREATE INDEX `idx_sessions_archived_at_id` ON `sessions` (`archived_at`,`id`);
