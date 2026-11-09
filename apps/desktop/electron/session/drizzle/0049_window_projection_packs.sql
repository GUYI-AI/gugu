CREATE TABLE session_window_pack_groups (
  group_id text PRIMARY KEY NOT NULL,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('building','complete','invalid','abandoned')),
  physical text CHECK (physical IS NULL OR length(CAST(physical AS BLOB)) <= 512)
);
--> statement-breakpoint
CREATE INDEX session_window_pack_recovery ON session_window_pack_groups(state,group_id);
--> statement-breakpoint
CREATE TABLE session_window_pack_sources (
  group_id text NOT NULL REFERENCES session_window_pack_groups(group_id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES session_window_commit_receipts(source_id) ON DELETE CASCADE,
  PRIMARY KEY(group_id,source_id)
);
--> statement-breakpoint
CREATE TABLE session_window_pack_frames (
  group_id text NOT NULL REFERENCES session_window_pack_groups(group_id) ON DELETE CASCADE,
  frame_name text NOT NULL,
  source_id text NOT NULL REFERENCES session_window_commit_receipts(source_id) ON DELETE CASCADE,
  offset integer NOT NULL CHECK(offset >= 0),
  length integer NOT NULL CHECK(length >= 48 AND length <= 65584),
  sha256 text NOT NULL CHECK(length(sha256) = 64),
  PRIMARY KEY(group_id,frame_name)
);
--> statement-breakpoint
CREATE TABLE session_window_pack_positions (
  frame_name text PRIMARY KEY NOT NULL,
  group_id text NOT NULL,
  FOREIGN KEY(group_id,frame_name) REFERENCES session_window_pack_frames(group_id,frame_name) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE session_window_pack_dependencies (
  group_id text NOT NULL REFERENCES session_window_pack_groups(group_id) ON DELETE CASCADE,
  dependency_id text NOT NULL,
  frame_name text NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY(group_id,dependency_id,frame_name),
  FOREIGN KEY(dependency_id,frame_name) REFERENCES session_window_pack_frames(group_id,frame_name) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TRIGGER session_window_pack_dependency_invalidated BEFORE DELETE ON session_window_pack_frames
BEGIN
  UPDATE session_window_pack_groups SET state='invalid' WHERE group_id=OLD.group_id;
  UPDATE session_window_pack_groups SET state='invalid' WHERE group_id IN (
    SELECT group_id FROM session_window_pack_dependencies WHERE dependency_id=OLD.group_id AND frame_name=OLD.frame_name
  );
END;
--> statement-breakpoint
CREATE TRIGGER session_window_pack_frame_immutable BEFORE UPDATE ON session_window_pack_frames
BEGIN
  SELECT RAISE(ABORT,'Committed pack frame positions are immutable');
END;
