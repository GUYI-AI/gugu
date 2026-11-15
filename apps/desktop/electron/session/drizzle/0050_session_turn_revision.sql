ALTER TABLE `session_turns` ADD `revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER session_turn_revised AFTER UPDATE OF data ON session_turns
WHEN NEW.data IS NOT OLD.data
BEGIN
  UPDATE session_turns SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
