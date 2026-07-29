-- Atomic, ciphertext-only bootstrap snapshot staging. Snapshot pages remain
-- isolated from the ordinary incoming inbox and cannot advance the durable
-- remote checkpoint until the complete snapshot is committed.

CREATE TABLE IF NOT EXISTS sync_snapshot_staging_sessions (
  snapshot_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(snapshot_id) BETWEEN 1 AND 200
      AND snapshot_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  project_id TEXT NOT NULL UNIQUE
    REFERENCES projects(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'staging'
    CHECK (state IN ('staging', 'committed')),
  base_signed_remote_cursor TEXT
    CHECK (
      base_signed_remote_cursor IS NULL
      OR (
        length(base_signed_remote_cursor) BETWEEN 1 AND 512
        AND base_signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  base_checkpoint_revision INTEGER NOT NULL
    CHECK (base_checkpoint_revision BETWEEN 0 AND 9007199254740991),
  base_checkpoint_updated_at TEXT
    CHECK (
      base_checkpoint_updated_at IS NULL
      OR julianday(base_checkpoint_updated_at) IS NOT NULL
    ),
  snapshot_signed_remote_cursor TEXT NOT NULL
    CHECK (
      length(snapshot_signed_remote_cursor) BETWEEN 1 AND 512
      AND snapshot_signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  snapshot_expires_at TEXT NOT NULL
    CHECK (julianday(snapshot_expires_at) IS NOT NULL),
  next_page_index INTEGER NOT NULL
    CHECK (next_page_index BETWEEN 1 AND 9007199254740991),
  next_snapshot_cursor TEXT
    CHECK (
      next_snapshot_cursor IS NULL
      OR (
        length(next_snapshot_cursor) BETWEEN 1 AND 512
        AND next_snapshot_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  pages_complete INTEGER NOT NULL CHECK (pages_complete IN (0, 1)),
  final_signed_remote_cursor TEXT
    CHECK (
      final_signed_remote_cursor IS NULL
      OR (
        length(final_signed_remote_cursor) BETWEEN 1 AND 512
        AND final_signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  total_operation_count INTEGER NOT NULL
    CHECK (total_operation_count BETWEEN 0 AND 9007199254740991),
  total_chunk_count INTEGER NOT NULL
    CHECK (total_chunk_count BETWEEN 0 AND 9007199254740991),
  total_tombstone_count INTEGER NOT NULL
    CHECK (total_tombstone_count BETWEEN 0 AND 9007199254740991),
  committed_checkpoint_revision INTEGER
    CHECK (
      committed_checkpoint_revision IS NULL
      OR committed_checkpoint_revision BETWEEN 1 AND 9007199254740991
    ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  committed_at TEXT CHECK (committed_at IS NULL OR julianday(committed_at) IS NOT NULL),
  CHECK (
    (
      base_checkpoint_revision = 0
      AND base_signed_remote_cursor IS NULL
      AND base_checkpoint_updated_at IS NULL
    )
    OR (
      base_checkpoint_revision > 0
      AND base_signed_remote_cursor IS NOT NULL
      AND base_checkpoint_updated_at IS NOT NULL
    )
  ),
  CHECK (
    (
      state = 'staging'
      AND committed_checkpoint_revision IS NULL
      AND committed_at IS NULL
      AND (
        (
          pages_complete = 0
          AND next_snapshot_cursor IS NOT NULL
          AND final_signed_remote_cursor IS NULL
        )
        OR (
          pages_complete = 1
          AND next_snapshot_cursor IS NULL
          AND final_signed_remote_cursor IS NOT NULL
        )
      )
    )
    OR (
      state = 'committed'
      AND pages_complete = 1
      AND next_snapshot_cursor IS NULL
      AND final_signed_remote_cursor IS NOT NULL
      AND committed_checkpoint_revision IS NOT NULL
      AND committed_at IS NOT NULL
    )
  ),
  CHECK (
    julianday(updated_at) >= julianday(created_at)
    AND julianday(created_at) < julianday(snapshot_expires_at)
    AND julianday(updated_at) < julianday(snapshot_expires_at)
    AND (
      committed_at IS NULL
      OR (
        julianday(committed_at) >= julianday(created_at)
        AND julianday(committed_at) < julianday(snapshot_expires_at)
      )
    )
  ),
  CHECK (
    final_signed_remote_cursor IS NULL
    OR final_signed_remote_cursor = snapshot_signed_remote_cursor
  )
);

CREATE TABLE IF NOT EXISTS sync_snapshot_staging_pages (
  snapshot_id TEXT NOT NULL
    REFERENCES sync_snapshot_staging_sessions(snapshot_id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL
    CHECK (page_index BETWEEN 0 AND 9007199254740990),
  resume_cursor TEXT
    CHECK (
      resume_cursor IS NULL
      OR (
        length(resume_cursor) BETWEEN 1 AND 512
        AND resume_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  snapshot_signed_remote_cursor TEXT NOT NULL
    CHECK (
      length(snapshot_signed_remote_cursor) BETWEEN 1 AND 512
      AND snapshot_signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  snapshot_expires_at TEXT NOT NULL
    CHECK (julianday(snapshot_expires_at) IS NOT NULL),
  next_snapshot_cursor TEXT
    CHECK (
      next_snapshot_cursor IS NULL
      OR (
        length(next_snapshot_cursor) BETWEEN 1 AND 512
        AND next_snapshot_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  final_signed_remote_cursor TEXT
    CHECK (
      final_signed_remote_cursor IS NULL
      OR (
        length(final_signed_remote_cursor) BETWEEN 1 AND 512
        AND final_signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  response_digest TEXT NOT NULL
    CHECK (
      length(response_digest) = 64
      AND response_digest NOT GLOB '*[^0-9a-f]*'
    ),
  operation_count INTEGER NOT NULL CHECK (operation_count BETWEEN 0 AND 256),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 0 AND 10000),
  tombstone_count INTEGER NOT NULL CHECK (tombstone_count BETWEEN 0 AND 256),
  received_at TEXT NOT NULL CHECK (julianday(received_at) IS NOT NULL),
  PRIMARY KEY (snapshot_id, page_index),
  CHECK (
    (page_index = 0 AND resume_cursor IS NULL)
    OR (page_index > 0 AND resume_cursor IS NOT NULL)
  ),
  CHECK (
    (
      next_snapshot_cursor IS NOT NULL
      AND final_signed_remote_cursor IS NULL
      AND (resume_cursor IS NULL OR next_snapshot_cursor <> resume_cursor)
    )
    OR (
      next_snapshot_cursor IS NULL
      AND final_signed_remote_cursor IS NOT NULL
    )
  ),
  CHECK (
    final_signed_remote_cursor IS NULL
    OR final_signed_remote_cursor = snapshot_signed_remote_cursor
  ),
  CHECK (
    julianday(received_at) < julianday(snapshot_expires_at)
  )
);

CREATE TABLE IF NOT EXISTS sync_snapshot_staging_operations (
  snapshot_id TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  operation_position INTEGER NOT NULL CHECK (operation_position >= 0),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 200),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 200),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 200),
  device_sequence INTEGER NOT NULL
    CHECK (device_sequence BETWEEN 1 AND 9007199254740991),
  object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 200),
  object_generation INTEGER NOT NULL CHECK (object_generation >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
  vector_json TEXT NOT NULL
    CHECK (json_valid(vector_json) AND json_type(vector_json) = 'object'),
  operation_created_at TEXT NOT NULL CHECK (julianday(operation_created_at) IS NOT NULL),
  PRIMARY KEY (snapshot_id, operation_id),
  FOREIGN KEY (snapshot_id, page_index)
    REFERENCES sync_snapshot_staging_pages(snapshot_id, page_index)
    ON DELETE CASCADE,
  UNIQUE (snapshot_id, page_index, operation_position),
  UNIQUE (snapshot_id, project_id, device_id, device_sequence)
);

CREATE TABLE IF NOT EXISTS sync_snapshot_staging_chunks (
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

CREATE TABLE IF NOT EXISTS sync_snapshot_staging_operation_chunks (
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

CREATE TABLE IF NOT EXISTS sync_snapshot_staging_tombstones (
  snapshot_id TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  tombstone_position INTEGER NOT NULL CHECK (tombstone_position >= 0),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 200),
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
  PRIMARY KEY (snapshot_id, project_id, object_id, object_generation),
  FOREIGN KEY (snapshot_id, page_index)
    REFERENCES sync_snapshot_staging_pages(snapshot_id, page_index)
    ON DELETE CASCADE,
  UNIQUE (snapshot_id, page_index, tombstone_position),
  CHECK (julianday(retain_until) - julianday(deleted_at) >= 365)
);

CREATE INDEX IF NOT EXISTS sync_snapshot_staging_operations_device_idx
  ON sync_snapshot_staging_operations (snapshot_id, device_id, device_sequence);

CREATE INDEX IF NOT EXISTS sync_snapshot_staging_chunks_project_idx
  ON sync_snapshot_staging_chunks (
    snapshot_id,
    project_id,
    object_type,
    object_id,
    chunk_index
  );
