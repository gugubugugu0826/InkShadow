-- Durable, ciphertext-only cloud pull staging. Signed server cursors remain
-- opaque; this database never stores bearer credentials, project keys, or
-- decrypted object content.

CREATE TABLE IF NOT EXISTS sync_remote_checkpoints (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  signed_remote_cursor TEXT NOT NULL
    CHECK (
      length(signed_remote_cursor) BETWEEN 1 AND 512
      AND signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS sync_device_sequences (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL
    CHECK (length(device_id) BETWEEN 1 AND 200),
  last_allocated_sequence INTEGER NOT NULL
    CHECK (last_allocated_sequence BETWEEN 1 AND 9007199254740991),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (project_id, device_id)
);

-- Preserve monotonicity for databases upgraded after local outbox work was
-- already queued.
INSERT OR IGNORE INTO sync_device_sequences (
  project_id,
  device_id,
  last_allocated_sequence,
  revision,
  updated_at
)
SELECT
  project_id,
  device_id,
  MAX(device_sequence),
  1,
  MAX(updated_at)
FROM sync_outbox_operations
GROUP BY project_id, device_id;

CREATE TABLE IF NOT EXISTS sync_incoming_batches (
  batch_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(batch_id) = 64
      AND batch_id NOT GLOB '*[^0-9a-f]*'
    ),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  prior_signed_remote_cursor TEXT
    CHECK (
      prior_signed_remote_cursor IS NULL
      OR (
        length(prior_signed_remote_cursor) BETWEEN 1 AND 512
        AND prior_signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  next_signed_remote_cursor TEXT NOT NULL
    CHECK (
      length(next_signed_remote_cursor) BETWEEN 1 AND 512
      AND next_signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  response_digest TEXT NOT NULL
    CHECK (
      length(response_digest) = 64
      AND response_digest NOT GLOB '*[^0-9a-f]*'
    ),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  has_more INTEGER NOT NULL CHECK (has_more IN (0, 1)),
  operation_count INTEGER NOT NULL CHECK (operation_count BETWEEN 0 AND 256),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 0 AND 10000),
  tombstone_count INTEGER NOT NULL CHECK (tombstone_count BETWEEN 0 AND 256),
  received_at TEXT NOT NULL CHECK (julianday(received_at) IS NOT NULL),
  UNIQUE (batch_id, project_id),
  UNIQUE (project_id, next_signed_remote_cursor)
);

CREATE INDEX IF NOT EXISTS sync_incoming_batches_project_received_idx
  ON sync_incoming_batches (project_id, received_at, batch_id);

CREATE TABLE IF NOT EXISTS sync_inbox_operations (
  operation_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(operation_id) BETWEEN 1 AND 200),
  batch_id TEXT NOT NULL,
  operation_position INTEGER NOT NULL CHECK (operation_position >= 0),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL
    CHECK (length(device_id) BETWEEN 1 AND 200),
  device_sequence INTEGER NOT NULL
    CHECK (device_sequence BETWEEN 1 AND 9007199254740991),
  object_id TEXT NOT NULL
    CHECK (length(object_id) BETWEEN 1 AND 200),
  object_generation INTEGER NOT NULL CHECK (object_generation >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
  vector_json TEXT NOT NULL
    CHECK (
      json_valid(vector_json)
      AND json_type(vector_json) = 'object'
    ),
  operation_created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'applying', 'applied', 'conflict', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
  next_attempt_at TEXT,
  lease_owner_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  resolution_token TEXT,
  conflict_code TEXT,
  failure_code TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (batch_id, project_id)
    REFERENCES sync_incoming_batches(batch_id, project_id)
    ON DELETE CASCADE,
  UNIQUE (project_id, device_id, device_sequence),
  UNIQUE (batch_id, operation_position),
  CHECK (
    (
      status = 'received'
      AND attempt = 0
      AND next_attempt_at IS NOT NULL
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND resolution_token IS NULL
      AND conflict_code IS NULL
      AND failure_code IS NULL
      AND resolved_at IS NULL
    )
    OR (
      status = 'applying'
      AND attempt >= 1
      AND next_attempt_at IS NULL
      AND lease_owner_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND resolution_token IS NULL
      AND conflict_code IS NULL
      AND failure_code IS NULL
      AND resolved_at IS NULL
    )
    OR (
      status = 'applied'
      AND attempt >= 1
      AND next_attempt_at IS NULL
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND resolution_token IS NOT NULL
      AND conflict_code IS NULL
      AND failure_code IS NULL
      AND resolved_at IS NOT NULL
    )
    OR (
      status = 'conflict'
      AND attempt >= 1
      AND next_attempt_at IS NULL
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND resolution_token IS NOT NULL
      AND conflict_code IS NOT NULL
      AND failure_code IS NULL
      AND resolved_at IS NOT NULL
    )
    OR (
      status = 'failed'
      AND attempt >= 1
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND resolution_token IS NOT NULL
      AND conflict_code IS NULL
      AND failure_code IS NOT NULL
      AND resolved_at IS NOT NULL
      AND (
        next_attempt_at IS NULL
        OR julianday(next_attempt_at) > julianday(resolved_at)
      )
    )
  ),
  CHECK (
    julianday(operation_created_at) IS NOT NULL
    AND julianday(received_at) IS NOT NULL
    AND julianday(updated_at) >= julianday(received_at)
    AND (
      next_attempt_at IS NULL
      OR julianday(next_attempt_at) >= julianday(received_at)
    )
    AND (
      lease_expires_at IS NULL
      OR julianday(lease_expires_at) > julianday(updated_at)
    )
    AND (
      resolved_at IS NULL
      OR julianday(resolved_at) >= julianday(received_at)
    )
  )
);

CREATE INDEX IF NOT EXISTS sync_inbox_runnable_idx
  ON sync_inbox_operations (project_id, status, next_attempt_at, received_at);

CREATE INDEX IF NOT EXISTS sync_inbox_expired_lease_idx
  ON sync_inbox_operations (project_id, status, lease_expires_at)
  WHERE status = 'applying';

CREATE INDEX IF NOT EXISTS sync_inbox_device_sequence_idx
  ON sync_inbox_operations (project_id, device_id, device_sequence, status);

CREATE TABLE IF NOT EXISTS sync_inbox_operation_chunks (
  operation_id TEXT NOT NULL
    REFERENCES sync_inbox_operations(operation_id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL
    REFERENCES sync_ciphertext_chunks(chunk_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (operation_id, chunk_id),
  UNIQUE (operation_id, position)
);
