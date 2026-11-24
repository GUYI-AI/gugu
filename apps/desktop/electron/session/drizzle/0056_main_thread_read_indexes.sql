CREATE INDEX `idx_sessions_archived_at` ON `sessions` (`archived_at`);
--> statement-breakpoint
CREATE INDEX `idx_resource_history_timestamp_bytes` ON `resource_history` (`timestamp`,`bytes`);
