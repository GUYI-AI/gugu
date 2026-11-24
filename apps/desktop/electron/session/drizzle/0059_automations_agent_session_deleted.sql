DROP INDEX IF EXISTS `idx_automations_agent_session_id`;
--> statement-breakpoint
CREATE INDEX `idx_automations_agent_session_deleted` ON `automations` (`agent_session_id`,`deleted_at`);
