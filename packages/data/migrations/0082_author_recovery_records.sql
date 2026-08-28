PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS author_recovery_records (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind),
  CHECK (length(kind) BETWEEN 1 AND 64),
  CHECK (kind NOT GLOB '*[^a-z0-9_]*'),
  CHECK (length(schema_version) BETWEEN 1 AND 128),
  CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  CHECK (revision BETWEEN 1 AND 9007199254740991)
) STRICT;

CREATE INDEX IF NOT EXISTS author_recovery_records_updated_idx
  ON author_recovery_records(updated_at DESC, project_id, kind);
