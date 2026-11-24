CREATE INDEX `idx_sessions_agent_status` ON `sessions` (`agent_status`);
--> statement-breakpoint
CREATE INDEX `idx_session_run_intervals_open` ON `session_run_intervals` (`ended_at`) WHERE "session_run_intervals"."ended_at" is null;
