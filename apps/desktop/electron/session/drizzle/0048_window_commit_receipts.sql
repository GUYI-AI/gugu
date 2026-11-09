CREATE TABLE session_window_commit_receipts (
  source_id text PRIMARY KEY NOT NULL,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  row_id text NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  stored_seq integer NOT NULL,
  reference_id text NOT NULL,
  receipt text NOT NULL CONSTRAINT session_window_receipt_bytes CHECK (length(CAST(receipt AS BLOB)) <= 4096)
);
--> statement-breakpoint
CREATE INDEX session_window_receipts_row ON session_window_commit_receipts(row_id);
--> statement-breakpoint
CREATE TABLE session_window_commit_positions (
  row_id text PRIMARY KEY NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  reference_id text NOT NULL,
  source_id text NOT NULL REFERENCES session_window_commit_receipts(source_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX session_window_positions_reference ON session_window_commit_positions(session_id, reference_id);
--> statement-breakpoint
CREATE TRIGGER session_window_position_invalidated AFTER UPDATE OF data, seq, turn_id ON session_turns
BEGIN
  DELETE FROM session_window_commit_positions WHERE row_id = NEW.id;
END;
