PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cloud_project_key_publications (
  project_id TEXT NOT NULL,
  key_version INTEGER NOT NULL
    CHECK (key_version BETWEEN 1 AND 2147483647),
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) = 36),
  expected_server_revision INTEGER
    CHECK (
      expected_server_revision IS NULL
      OR expected_server_revision BETWEEN 1 AND 2147483647
    ),
  request_json TEXT NOT NULL
    CHECK (length(request_json) BETWEEN 2 AND 4194304),
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'conflicted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error_code TEXT,
  PRIMARY KEY (project_id, key_version),
  FOREIGN KEY (project_id, key_version)
    REFERENCES project_key_versions(project_id, key_version)
    ON DELETE CASCADE,
  CHECK (
    (key_version = 1 AND expected_server_revision IS NULL)
    OR (key_version > 1 AND expected_server_revision IS NOT NULL)
  ),
  CHECK (
    (state = 'pending' AND last_error_code IS NULL)
    OR (state = 'conflicted' AND last_error_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_project_key_publications_idempotency_idx
  ON cloud_project_key_publications (idempotency_key);

CREATE INDEX IF NOT EXISTS cloud_project_key_publications_state_idx
  ON cloud_project_key_publications (state, updated_at);
