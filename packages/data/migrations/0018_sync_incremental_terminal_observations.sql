-- Durable, plaintext-free evidence that the cloud returned an empty terminal
-- page at an already downloaded incremental cursor.
--
-- A terminal empty page does not advance the remote cursor, so it cannot be
-- represented by sync_incoming_batches without overwriting the immutable
-- response evidence for the preceding page. This table binds that terminal
-- observation to the exact local remote-checkpoint revision that was current
-- when the response was accepted.

CREATE TABLE IF NOT EXISTS sync_incremental_terminal_observations (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  signed_remote_cursor TEXT NOT NULL
    CHECK (
      length(signed_remote_cursor) BETWEEN 1 AND 512
      AND signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  downloaded_checkpoint_revision INTEGER NOT NULL
    CHECK (downloaded_checkpoint_revision BETWEEN 1 AND 9007199254740991),
  response_digest TEXT NOT NULL
    CHECK (
      length(response_digest) = 64
      AND response_digest NOT GLOB '*[^0-9a-f]*'
    ),
  request_id TEXT NOT NULL
    CHECK (length(request_id) BETWEEN 1 AND 200),
  observed_at TEXT NOT NULL
    CHECK (julianday(observed_at) IS NOT NULL),
  PRIMARY KEY (
    project_id,
    signed_remote_cursor,
    downloaded_checkpoint_revision
  ),
  UNIQUE (project_id, downloaded_checkpoint_revision)
);

CREATE INDEX IF NOT EXISTS sync_incremental_terminal_observations_project_observed_idx
  ON sync_incremental_terminal_observations (
    project_id,
    observed_at,
    downloaded_checkpoint_revision
  );
