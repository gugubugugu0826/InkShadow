PRAGMA foreign_keys = ON;

-- A credential vault write and a SQLite transaction cannot share one atomic
-- boundary. This journal keeps the credential slot prepared for a verified
-- connection switch recoverable without ever persisting an API key.
CREATE TABLE IF NOT EXISTS model_hub_connection_commits (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL
    CHECK (phase IN ('prepared', 'cleanup_pending')),
  credential_provider_id TEXT,
  cleanup_credential_provider_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(connection_id) BETWEEN 1 AND 128),
  CHECK (
    credential_provider_id IS NULL
    OR length(credential_provider_id) BETWEEN 1 AND 128
  ),
  CHECK (
    cleanup_credential_provider_id IS NULL
    OR length(cleanup_credential_provider_id) BETWEEN 1 AND 128
  ),
  CHECK (
    (phase = 'prepared' AND cleanup_credential_provider_id IS NULL)
    OR phase = 'cleanup_pending'
  )
);

CREATE INDEX IF NOT EXISTS model_hub_connection_commits_phase_idx
  ON model_hub_connection_commits (phase, updated_at ASC, id ASC);
