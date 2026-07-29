PRAGMA foreign_keys = ON;

-- Embeddings are a rebuildable, local-only projection. They contain no
-- authoritative prose and are deliberately tied to the exact search
-- document version and content hash that produced them.
CREATE TABLE IF NOT EXISTS search_vector_index_state (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES search_index_state(project_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (schema_version = 1),
  generation INTEGER NOT NULL
    CHECK (generation >= 1),
  model_id TEXT NOT NULL
    CHECK (length(trim(model_id)) BETWEEN 1 AND 256),
  dimension INTEGER NOT NULL
    CHECK (dimension BETWEEN 1 AND 4096),
  status TEXT NOT NULL
    CHECK (status IN ('ready', 'rebuild_required', 'degraded')),
  last_rebuilt_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'ready' AND last_rebuilt_at IS NOT NULL)
    OR status <> 'ready'
  )
);

CREATE INDEX IF NOT EXISTS search_vector_index_state_status_idx
  ON search_vector_index_state (status, updated_at DESC, project_id ASC);

CREATE TABLE IF NOT EXISTS search_vector_embeddings (
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL
    CHECK (length(source_version_id) BETWEEN 1 AND 256),
  content_hash TEXT NOT NULL
    CHECK (
      length(content_hash) = 64
      AND content_hash = lower(content_hash)
      AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
  model_id TEXT NOT NULL
    CHECK (length(trim(model_id)) BETWEEN 1 AND 256),
  dimension INTEGER NOT NULL
    CHECK (dimension BETWEEN 1 AND 4096),
  vector_blob BLOB NOT NULL,
  vector_norm REAL NOT NULL
    CHECK (vector_norm > 0),
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, document_id),
  FOREIGN KEY (project_id)
    REFERENCES search_vector_index_state(project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, document_id)
    REFERENCES search_index_documents(project_id, document_id) ON DELETE CASCADE,
  CHECK (length(vector_blob) = dimension * 4)
);

CREATE INDEX IF NOT EXISTS search_vector_embeddings_provenance_idx
  ON search_vector_embeddings (
    project_id,
    model_id,
    source_version_id,
    content_hash,
    document_id
  );
