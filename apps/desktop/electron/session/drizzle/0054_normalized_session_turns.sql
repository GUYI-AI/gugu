CREATE TABLE session_turn_heads (
  row_id TEXT PRIMARY KEY NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  base TEXT NOT NULL CONSTRAINT session_turn_heads_base CHECK (base IN ('legacy','empty')),
  revision INTEGER NOT NULL DEFAULT 0,
  reference_id TEXT,
  outcome_kind TEXT,
  started_at INTEGER,
  notified_source TEXT,
  text_bytes INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE session_turn_nodes (
  row_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  parent_key TEXT NOT NULL,
  collection TEXT NOT NULL CONSTRAINT session_turn_nodes_collection CHECK (collection IN ('root','items','children','terminals')),
  kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  children INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  reset_fields INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(row_id,node_key)
);
--> statement-breakpoint
CREATE TABLE session_turn_fields (
  row_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT CONSTRAINT session_turn_fields_bytes CHECK (value IS NULL OR length(CAST(value AS BLOB)) <= 8192),
  PRIMARY KEY(row_id,node_key,field),
  FOREIGN KEY(row_id,node_key) REFERENCES session_turn_nodes(row_id,node_key) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE session_turn_payload_objects (
  hash TEXT PRIMARY KEY NOT NULL,
  bytes INTEGER NOT NULL,
  kind INTEGER NOT NULL CONSTRAINT session_turn_payload_kind CHECK (kind IN (0,2,3)),
  inline_data BLOB,
  refs INTEGER NOT NULL DEFAULT 0 CONSTRAINT session_turn_payload_refs CHECK (refs >= 0),
  CONSTRAINT session_turn_payload_storage CHECK ((bytes BETWEEN 1 AND 65536 AND inline_data IS NOT NULL AND length(inline_data)=bytes) OR (bytes>65536 AND inline_data IS NULL))
);
--> statement-breakpoint
CREATE INDEX idx_session_turn_payload_unowned ON session_turn_payload_objects(refs,hash);
--> statement-breakpoint
CREATE TABLE session_turn_payload_chunks (
  hash TEXT NOT NULL REFERENCES session_turn_payload_objects(hash) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CONSTRAINT session_turn_payload_chunk_ordinal CHECK (ordinal>=0),
  digest TEXT NOT NULL CONSTRAINT session_turn_payload_chunk_digest CHECK (length(digest)=64),
  PRIMARY KEY(hash,ordinal)
);
--> statement-breakpoint
CREATE TABLE session_turn_payload_edges (
  parent_hash TEXT NOT NULL REFERENCES session_turn_payload_objects(hash) ON DELETE CASCADE,
  child_hash TEXT NOT NULL REFERENCES session_turn_payload_objects(hash),
  PRIMARY KEY(parent_hash,child_hash)
);
--> statement-breakpoint
CREATE TABLE session_turn_payload_fields (
  row_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  field TEXT NOT NULL,
  hash TEXT NOT NULL REFERENCES session_turn_payload_objects(hash),
  PRIMARY KEY(row_id,node_key,field,hash),
  FOREIGN KEY(row_id,node_key,field) REFERENCES session_turn_fields(row_id,node_key,field) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE session_turn_payload_sources (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES session_window_commit_receipts(source_id) ON DELETE CASCADE,
  hash TEXT NOT NULL REFERENCES session_turn_payload_objects(hash)
);
--> statement-breakpoint
CREATE INDEX idx_session_turn_payload_edge_child ON session_turn_payload_edges(child_hash);
--> statement-breakpoint
CREATE INDEX idx_session_turn_payload_field_hash ON session_turn_payload_fields(hash);
--> statement-breakpoint
CREATE INDEX idx_session_turn_payload_source_hash ON session_turn_payload_sources(hash);
--> statement-breakpoint
CREATE TRIGGER session_turn_payload_edge_add AFTER INSERT ON session_turn_payload_edges BEGIN
  UPDATE session_turn_payload_objects SET refs=refs+1 WHERE hash=NEW.child_hash;
END;
--> statement-breakpoint
CREATE TRIGGER session_turn_payload_edge_remove AFTER DELETE ON session_turn_payload_edges BEGIN
  UPDATE session_turn_payload_objects SET refs=refs-1 WHERE hash=OLD.child_hash;
END;
--> statement-breakpoint
CREATE TRIGGER session_turn_payload_field_add AFTER INSERT ON session_turn_payload_fields BEGIN
  UPDATE session_turn_payload_objects SET refs=refs+1 WHERE hash=NEW.hash;
END;
--> statement-breakpoint
CREATE TRIGGER session_turn_payload_field_remove AFTER DELETE ON session_turn_payload_fields BEGIN
  UPDATE session_turn_payload_objects SET refs=refs-1 WHERE hash=OLD.hash;
END;
--> statement-breakpoint
CREATE TRIGGER session_turn_payload_source_add AFTER INSERT ON session_turn_payload_sources BEGIN
  UPDATE session_turn_payload_objects SET refs=refs+1 WHERE hash=NEW.hash;
END;
--> statement-breakpoint
CREATE TRIGGER session_turn_payload_source_remove AFTER DELETE ON session_turn_payload_sources BEGIN
  UPDATE session_turn_payload_objects SET refs=refs-1 WHERE hash=OLD.hash;
END;
