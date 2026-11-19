-- A group is the only container: folders carry the group they are bound to, sessions the group they live in.
-- The data moves in electron/migrations/group-folders (startup, after this schema step). The project tables and
-- project_id columns stay one release for a rolled-back build (@@@c1-legacy-project) and go in the next.
ALTER TABLE `workspaces` ADD `chat_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `sort` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `gitless` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `base_ref` text;--> statement-breakpoint
CREATE INDEX `idx_workspaces_chat_id` ON `workspaces` (`chat_id`,`sort`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `chat_id` text;--> statement-breakpoint
-- @@@c1-legacy-project The previous release's NOT NULL project_id (sessions, terminals, editor buffers) points here.
INSERT OR IGNORE INTO `projects` (`id`, `name`, `path`, `kind`) VALUES ('c1-placeholder', '', '/.gugu-c1-placeholder-c1-placeholder', 'workspace');--> statement-breakpoint
CREATE INDEX `idx_sessions_chat_id` ON `sessions` (`chat_id`);--> statement-breakpoint
ALTER TABLE `automations` ADD `workspace_id` text;--> statement-breakpoint
ALTER TABLE `activity_events` ADD `chat_id` text;--> statement-breakpoint
CREATE INDEX `activity_events_chat` ON `activity_events` (`chat_id`,`seq`);--> statement-breakpoint
CREATE TABLE `activity_session_chats` (
	`session_id` text PRIMARY KEY NOT NULL,
	`chat_id` text
);--> statement-breakpoint
INSERT INTO `activity_session_chats` SELECT `id`, `chat_id` FROM `sessions`;--> statement-breakpoint
CREATE TRIGGER `activity_session_chats_record` AFTER INSERT ON `sessions` BEGIN
	INSERT OR REPLACE INTO `activity_session_chats` VALUES (NEW.`id`, NEW.`chat_id`);
END;--> statement-breakpoint
CREATE TABLE `workspace_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`base_settings_json` text DEFAULT '{}' NOT NULL,
	`shareable_settings_json` text DEFAULT '{}' NOT NULL,
	`legacy_config_migrated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE TABLE `workspace_remotes` (
	`workspace_id` text NOT NULL,
	`remote_name` text NOT NULL,
	`remote_url` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `remote_name`)
);--> statement-breakpoint
CREATE TABLE `legacy_project_aliases` (
	`project_id` text PRIMARY KEY NOT NULL,
	`root_workspace_id` text,
	`chat_id` text
);--> statement-breakpoint
CREATE TABLE `file_revision_cache` (
	`account_id` text NOT NULL,
	`item_id` text NOT NULL,
	`version` integer NOT NULL,
	`revision_json` text NOT NULL,
	PRIMARY KEY(`account_id`, `item_id`, `version`)
);
