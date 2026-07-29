-- Sync protocol v1 did not carry an object type on operations or tombstones.
-- In particular, a delete has no ciphertext chunks from which a receiver could
-- recover that type.  This is an unrecoverable ambiguity, so the unpublished
-- transport ledger is reset instead of guessing.  Authoritative local project
-- and chapter plaintext, project keys, and cloud-key publication state are not
-- touched by this migration.

DELETE FROM sync_snapshot_staging_operation_chunks;
DELETE FROM sync_snapshot_staging_tombstones;
DELETE FROM sync_snapshot_staging_operations;
DELETE FROM sync_snapshot_staging_chunks;
DELETE FROM sync_snapshot_staging_pages;
DELETE FROM sync_snapshot_staging_sessions;

DELETE FROM sync_inbox_operation_chunks;
DELETE FROM sync_inbox_operations;
DELETE FROM sync_incoming_batches;

DELETE FROM sync_operation_chunks;
DELETE FROM sync_transfer_chunks;
DELETE FROM sync_transfers;
DELETE FROM sync_outbox_operations;
DELETE FROM sync_tombstones;
DELETE FROM sync_ciphertext_chunks;
DELETE FROM sync_remote_checkpoints;
DELETE FROM sync_device_sequences;

-- Rebuild the two chunk stores so the protocol can carry an encrypted
-- project_manifest.  Their dependent link tables are empty and are recreated
-- with the same foreign-key guarantees below.
DROP TABLE sync_snapshot_staging_operation_chunks;
DROP TABLE sync_inbox_operation_chunks;
DROP TABLE sync_operation_chunks;
DROP TABLE sync_transfer_chunks;
DROP TABLE sync_snapshot_staging_chunks;
DROP TABLE sync_ciphertext_chunks;

CREATE TABLE sync_ciphertext_chunks (
  chunk_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(chunk_id) BETWEEN 1 AND 200),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL
    CHECK (
      object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    ),
  object_id TEXT NOT NULL
    CHECK (length(object_id) BETWEEN 1 AND 200),
  version_id TEXT NOT NULL
    CHECK (length(version_id) BETWEEN 1 AND 200),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  nonce TEXT NOT NULL
    CHECK (
      length(nonce) = 16
      AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ciphertext TEXT NOT NULL
    CHECK (
      length(ciphertext) BETWEEN 22 AND 8000000
      AND ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ciphertext_sha256 TEXT NOT NULL
    CHECK (
      length(ciphertext_sha256) = 64
      AND ciphertext_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  plaintext_bytes INTEGER NOT NULL
    CHECK (plaintext_bytes BETWEEN 0 AND 4194304),
  created_at TEXT NOT NULL,
  UNIQUE (
    project_id,
    object_type,
    object_id,
    version_id,
    chunk_index,
    key_version
  )
);

CREATE INDEX sync_ciphertext_chunks_object_idx
  ON sync_ciphertext_chunks (
    project_id,
    object_type,
    object_id,
    version_id,
    chunk_index
  );

CREATE TABLE sync_snapshot_staging_chunks (
  snapshot_id TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  chunk_id TEXT NOT NULL CHECK (length(chunk_id) BETWEEN 1 AND 200),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 200),
  object_type TEXT NOT NULL
    CHECK (
      object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    ),
  object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 200),
  version_id TEXT NOT NULL CHECK (length(version_id) BETWEEN 1 AND 200),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  nonce TEXT NOT NULL
    CHECK (
      length(nonce) = 16
      AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ciphertext TEXT NOT NULL
    CHECK (
      length(ciphertext) BETWEEN 22 AND 8000000
      AND ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ciphertext_sha256 TEXT NOT NULL
    CHECK (
      length(ciphertext_sha256) = 64
      AND ciphertext_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  plaintext_bytes INTEGER NOT NULL
    CHECK (plaintext_bytes BETWEEN 0 AND 4194304),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (snapshot_id, chunk_id),
  FOREIGN KEY (snapshot_id, page_index)
    REFERENCES sync_snapshot_staging_pages(snapshot_id, page_index)
    ON DELETE CASCADE,
  UNIQUE (
    snapshot_id,
    project_id,
    object_type,
    object_id,
    version_id,
    chunk_index,
    key_version
  )
);

CREATE INDEX sync_snapshot_staging_chunks_project_idx
  ON sync_snapshot_staging_chunks (snapshot_id, project_id, object_type, object_id, chunk_index);

-- SQLite requires a default when a NOT NULL column is added to an existing
-- table.  A deliberately invalid sentinel allows the ALTER while the triggers
-- below make omission fail closed for every future write.
ALTER TABLE sync_outbox_operations
  ADD COLUMN object_type TEXT NOT NULL DEFAULT '__sync_protocol_v2_required__'
    CHECK (
      object_type = '__sync_protocol_v2_required__'
      OR object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    );

ALTER TABLE sync_inbox_operations
  ADD COLUMN object_type TEXT NOT NULL DEFAULT '__sync_protocol_v2_required__'
    CHECK (
      object_type = '__sync_protocol_v2_required__'
      OR object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    );

ALTER TABLE sync_snapshot_staging_operations
  ADD COLUMN object_type TEXT NOT NULL DEFAULT '__sync_protocol_v2_required__'
    CHECK (
      object_type = '__sync_protocol_v2_required__'
      OR object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    );

CREATE TABLE sync_operation_chunks (
  operation_id TEXT NOT NULL
    REFERENCES sync_outbox_operations(operation_id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL
    REFERENCES sync_ciphertext_chunks(chunk_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (operation_id, chunk_id),
  UNIQUE (operation_id, position)
);

CREATE TABLE sync_inbox_operation_chunks (
  operation_id TEXT NOT NULL
    REFERENCES sync_inbox_operations(operation_id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL
    REFERENCES sync_ciphertext_chunks(chunk_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (operation_id, chunk_id),
  UNIQUE (operation_id, position)
);

CREATE TABLE sync_transfer_chunks (
  transfer_id TEXT NOT NULL
    REFERENCES sync_transfers(transfer_id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL
    REFERENCES sync_ciphertext_chunks(chunk_id) ON DELETE RESTRICT,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes >= 1),
  ciphertext_sha256 TEXT NOT NULL
    CHECK (
      length(ciphertext_sha256) = 64
      AND ciphertext_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  remote_etag TEXT,
  acknowledged_at TEXT,
  PRIMARY KEY (transfer_id, chunk_id),
  UNIQUE (transfer_id, chunk_index),
  CHECK (
    (remote_etag IS NULL AND acknowledged_at IS NULL)
    OR (remote_etag IS NOT NULL AND acknowledged_at IS NOT NULL)
  )
);

CREATE TABLE sync_snapshot_staging_operation_chunks (
  snapshot_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (snapshot_id, operation_id, chunk_id),
  FOREIGN KEY (snapshot_id, operation_id)
    REFERENCES sync_snapshot_staging_operations(snapshot_id, operation_id)
    ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, chunk_id)
    REFERENCES sync_snapshot_staging_chunks(snapshot_id, chunk_id)
    ON DELETE CASCADE,
  UNIQUE (snapshot_id, operation_id, position)
);

CREATE TRIGGER sync_outbox_operations_require_v2_object_type_insert
BEFORE INSERT ON sync_outbox_operations
WHEN NEW.object_type = '__sync_protocol_v2_required__'
BEGIN
  SELECT RAISE(ABORT, 'sync protocol v2 object_type is required');
END;

CREATE TRIGGER sync_outbox_operations_require_v2_object_type_update
BEFORE UPDATE OF object_type ON sync_outbox_operations
WHEN NEW.object_type = '__sync_protocol_v2_required__'
BEGIN
  SELECT RAISE(ABORT, 'sync protocol v2 object_type is required');
END;

CREATE TRIGGER sync_inbox_operations_require_v2_object_type_insert
BEFORE INSERT ON sync_inbox_operations
WHEN NEW.object_type = '__sync_protocol_v2_required__'
BEGIN
  SELECT RAISE(ABORT, 'sync protocol v2 object_type is required');
END;

CREATE TRIGGER sync_inbox_operations_require_v2_object_type_update
BEFORE UPDATE OF object_type ON sync_inbox_operations
WHEN NEW.object_type = '__sync_protocol_v2_required__'
BEGIN
  SELECT RAISE(ABORT, 'sync protocol v2 object_type is required');
END;

CREATE TRIGGER sync_snapshot_operations_require_v2_object_type_insert
BEFORE INSERT ON sync_snapshot_staging_operations
WHEN NEW.object_type = '__sync_protocol_v2_required__'
BEGIN
  SELECT RAISE(ABORT, 'sync protocol v2 object_type is required');
END;

CREATE TRIGGER sync_snapshot_operations_require_v2_object_type_update
BEFORE UPDATE OF object_type ON sync_snapshot_staging_operations
WHEN NEW.object_type = '__sync_protocol_v2_required__'
BEGIN
  SELECT RAISE(ABORT, 'sync protocol v2 object_type is required');
END;

-- Tombstones survive independently of operations, so their logical identity
-- includes object_type in the primary key instead of relying on a related row.
DROP INDEX IF EXISTS sync_tombstones_retention_idx;
DROP TABLE sync_tombstones;

CREATE TABLE sync_tombstones (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL
    CHECK (
      object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    ),
  object_id TEXT NOT NULL
    CHECK (length(object_id) BETWEEN 1 AND 200),
  object_generation INTEGER NOT NULL CHECK (object_generation >= 1),
  deleted_by_device_id TEXT NOT NULL
    CHECK (length(deleted_by_device_id) BETWEEN 1 AND 200),
  vector_json TEXT NOT NULL
    CHECK (
      json_valid(vector_json)
      AND json_type(vector_json) = 'object'
    ),
  deleted_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  acknowledged_device_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(acknowledged_device_ids_json)
      AND json_type(acknowledged_device_ids_json) = 'array'
    ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, object_type, object_id, object_generation),
  CHECK (
    julianday(deleted_at) IS NOT NULL
    AND julianday(retain_until) IS NOT NULL
    AND julianday(retain_until) - julianday(deleted_at) >= 365
  )
);

CREATE INDEX sync_tombstones_retention_idx
  ON sync_tombstones (retain_until, project_id, object_type);

DROP TABLE sync_snapshot_staging_tombstones;

CREATE TABLE sync_snapshot_staging_tombstones (
  snapshot_id TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  tombstone_position INTEGER NOT NULL CHECK (tombstone_position >= 0),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 200),
  object_type TEXT NOT NULL
    CHECK (
      object_type IN (
        'project_manifest',
        'chapter_version',
        'story_record',
        'outline',
        'memory',
        'material',
        'attachment'
      )
    ),
  object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 200),
  object_generation INTEGER NOT NULL CHECK (object_generation >= 1),
  deleted_by_device_id TEXT NOT NULL CHECK (length(deleted_by_device_id) BETWEEN 1 AND 200),
  vector_json TEXT NOT NULL
    CHECK (json_valid(vector_json) AND json_type(vector_json) = 'object'),
  deleted_at TEXT NOT NULL CHECK (julianday(deleted_at) IS NOT NULL),
  retain_until TEXT NOT NULL CHECK (julianday(retain_until) IS NOT NULL),
  acknowledged_device_ids_json TEXT NOT NULL
    CHECK (
      json_valid(acknowledged_device_ids_json)
      AND json_type(acknowledged_device_ids_json) = 'array'
    ),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (snapshot_id, project_id, object_type, object_id, object_generation),
  FOREIGN KEY (snapshot_id, page_index)
    REFERENCES sync_snapshot_staging_pages(snapshot_id, page_index)
    ON DELETE CASCADE,
  UNIQUE (snapshot_id, page_index, tombstone_position),
  CHECK (julianday(retain_until) - julianday(deleted_at) >= 365)
);

-- Persisted operation/chunk mappings must agree on their full object identity.
CREATE TRIGGER sync_operation_chunks_require_matching_object_type
BEFORE INSERT ON sync_operation_chunks
WHEN NOT EXISTS (
  SELECT 1
  FROM sync_outbox_operations AS operation
  JOIN sync_ciphertext_chunks AS chunk
    ON chunk.chunk_id = NEW.chunk_id
  WHERE operation.operation_id = NEW.operation_id
    AND operation.project_id = chunk.project_id
    AND operation.object_type = chunk.object_type
    AND operation.object_id = chunk.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'sync operation and chunk object identity must match');
END;

CREATE TRIGGER sync_inbox_operation_chunks_require_matching_object_type
BEFORE INSERT ON sync_inbox_operation_chunks
WHEN NOT EXISTS (
  SELECT 1
  FROM sync_inbox_operations AS operation
  JOIN sync_ciphertext_chunks AS chunk
    ON chunk.chunk_id = NEW.chunk_id
  WHERE operation.operation_id = NEW.operation_id
    AND operation.project_id = chunk.project_id
    AND operation.object_type = chunk.object_type
    AND operation.object_id = chunk.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'sync operation and chunk object identity must match');
END;

CREATE TRIGGER sync_snapshot_operation_chunks_require_matching_object_type
BEFORE INSERT ON sync_snapshot_staging_operation_chunks
WHEN NOT EXISTS (
  SELECT 1
  FROM sync_snapshot_staging_operations AS operation
  JOIN sync_snapshot_staging_chunks AS chunk
    ON chunk.snapshot_id = NEW.snapshot_id
    AND chunk.chunk_id = NEW.chunk_id
  WHERE operation.snapshot_id = NEW.snapshot_id
    AND operation.operation_id = NEW.operation_id
    AND operation.project_id = chunk.project_id
    AND operation.object_type = chunk.object_type
    AND operation.object_id = chunk.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'sync snapshot operation and chunk object identity must match');
END;
