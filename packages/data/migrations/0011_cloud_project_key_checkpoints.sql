-- Monotonic cloud project-key publication checkpoints.
--
-- This table contains public key-version metadata only. Project DEKs,
-- recovery codes, device private keys, and session credentials are forbidden.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cloud_project_key_checkpoints (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  current_key_version INTEGER NOT NULL
    CHECK (current_key_version BETWEEN 1 AND 2147483647),
  server_revision INTEGER NOT NULL
    CHECK (server_revision BETWEEN 1 AND 2147483647),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, current_key_version)
    REFERENCES project_key_versions(project_id, key_version) ON DELETE CASCADE,
  CHECK (julianday(updated_at) IS NOT NULL)
);
