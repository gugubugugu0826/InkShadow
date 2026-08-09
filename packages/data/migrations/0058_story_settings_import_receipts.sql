-- Durable, privacy-bounded receipts for atomic Story Settings imports.
-- The receipt stores entity identifiers and pre-import revision fences only;
-- it never stores credentials, model responses, prompts or hidden reasoning.

CREATE TABLE IF NOT EXISTS story_settings_import_receipts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('committed', 'undone')),
  created_record_ids_json TEXT NOT NULL
    CHECK (json_valid(created_record_ids_json) AND json_type(created_record_ids_json) = 'array'),
  updated_record_fences_json TEXT NOT NULL
    CHECK (json_valid(updated_record_fences_json) AND json_type(updated_record_fences_json) = 'array'),
  created_fact_ids_json TEXT NOT NULL
    CHECK (json_valid(created_fact_ids_json) AND json_type(created_fact_ids_json) = 'array'),
  created_memory_ids_json TEXT NOT NULL
    CHECK (json_valid(created_memory_ids_json) AND json_type(created_memory_ids_json) = 'array'),
  imported_count INTEGER NOT NULL CHECK (imported_count BETWEEN 0 AND 5000),
  skipped_count INTEGER NOT NULL CHECK (skipped_count BETWEEN 0 AND 5000),
  created_at TEXT NOT NULL,
  undone_at TEXT,
  CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  CHECK (undone_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', undone_at) = undone_at),
  CHECK (
    (status = 'committed' AND undone_at IS NULL) OR
    (status = 'undone' AND undone_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS story_settings_import_receipts_project_source_idx
  ON story_settings_import_receipts (project_id, source_sha256, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS story_settings_import_receipts_project_created_idx
  ON story_settings_import_receipts (project_id, created_at DESC, id DESC);
