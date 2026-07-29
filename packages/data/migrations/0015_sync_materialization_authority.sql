-- Per-project cloud-sync consent and plaintext-materialization authority.
--
-- These tables deliberately separate:
--   * downloaded ciphertext cursors from successfully materialized plaintext;
--   * user consent from the mere presence of cloud/account metadata; and
--   * durable business-object references from plaintext projection payloads.
--
-- No title, chapter body, prompt, model output, project key, bearer credential,
-- or decrypted payload may be persisted in this slice.

CREATE TABLE IF NOT EXISTS project_sync_registrations (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL
    CHECK (
      length(account_id) = 36
      AND substr(account_id, 9, 1) = '-'
      AND substr(account_id, 14, 1) = '-'
      AND substr(account_id, 15, 1) = '7'
      AND substr(account_id, 19, 1) = '-'
      AND substr(account_id, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(account_id, 24, 1) = '-'
      AND length(replace(account_id, '-', '')) = 32
      AND replace(account_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) = 36
      AND substr(device_id, 9, 1) = '-'
      AND substr(device_id, 14, 1) = '-'
      AND substr(device_id, 15, 1) = '7'
      AND substr(device_id, 19, 1) = '-'
      AND substr(device_id, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(device_id, 24, 1) = '-'
      AND length(replace(device_id, '-', '')) = 32
      AND replace(device_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL
    CHECK (
      state IN (
        'enabled',
        'enabling',
        'paused',
        'bootstrap_required',
        'error',
        'disabled'
      )
    ),
  consent_revision INTEGER NOT NULL
    CHECK (consent_revision BETWEEN 1 AND 9007199254740991),
  key_version INTEGER NOT NULL
    CHECK (key_version BETWEEN 1 AND 2147483647),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  plaintext_bootstrap_completed INTEGER NOT NULL DEFAULT 0
    CHECK (plaintext_bootstrap_completed IN (0, 1)),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        length(last_error_code) BETWEEN 1 AND 120
        AND last_error_code NOT GLOB '*[^A-Z0-9_.:-]*'
      )
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  enabled_at TEXT,
  paused_at TEXT,
  CHECK (
    julianday(created_at) IS NOT NULL
    AND julianday(updated_at) >= julianday(created_at)
    AND (
      enabled_at IS NULL
      OR (
        julianday(enabled_at) >= julianday(created_at)
        AND julianday(enabled_at) <= julianday(updated_at)
      )
    )
    AND (
      paused_at IS NULL
      OR (
        julianday(paused_at) >= julianday(created_at)
        AND julianday(paused_at) <= julianday(updated_at)
      )
    )
  ),
  CHECK (
    (
      state = 'disabled'
      AND plaintext_bootstrap_completed = 0
      AND last_error_code IS NULL
      AND enabled_at IS NULL
      AND paused_at IS NULL
    )
    OR (
      state IN ('enabling', 'bootstrap_required')
      AND plaintext_bootstrap_completed = 0
      AND last_error_code IS NULL
      AND enabled_at IS NULL
      AND paused_at IS NULL
    )
    OR (
      state = 'enabled'
      AND plaintext_bootstrap_completed = 1
      AND last_error_code IS NULL
      AND enabled_at IS NOT NULL
      AND paused_at IS NULL
    )
    OR (
      state = 'paused'
      AND last_error_code IS NULL
      AND paused_at IS NOT NULL
      AND (
        (
          plaintext_bootstrap_completed = 0
          AND enabled_at IS NULL
        )
        OR (
          plaintext_bootstrap_completed = 1
          AND enabled_at IS NOT NULL
          AND julianday(paused_at) >= julianday(enabled_at)
        )
      )
    )
    OR (
      state = 'error'
      AND last_error_code IS NOT NULL
      AND paused_at IS NULL
      AND (
        (
          plaintext_bootstrap_completed = 0
          AND enabled_at IS NULL
        )
        OR (
          plaintext_bootstrap_completed = 1
          AND enabled_at IS NOT NULL
        )
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS project_sync_registrations_state_idx
  ON project_sync_registrations (state, updated_at, project_id);

CREATE TABLE IF NOT EXISTS sync_materialized_objects (
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
  object_generation INTEGER NOT NULL
    CHECK (object_generation BETWEEN 1 AND 9007199254740991),
  version_id TEXT
    CHECK (
      version_id IS NULL
      OR length(version_id) BETWEEN 1 AND 200
    ),
  vector_json TEXT NOT NULL
    CHECK (
      json_valid(vector_json)
      AND json_type(vector_json) = 'object'
    ),
  payload_sha256 TEXT
    CHECK (
      payload_sha256 IS NULL
      OR (
        length(payload_sha256) = 64
        AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  source_operation_id TEXT NOT NULL
    CHECK (length(source_operation_id) BETWEEN 1 AND 200),
  source_device_id TEXT NOT NULL
    CHECK (length(source_device_id) BETWEEN 1 AND 200),
  source_device_sequence INTEGER NOT NULL
    CHECK (source_device_sequence BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL
    CHECK (state IN ('present', 'deleted')),
  materialized_at TEXT NOT NULL
    CHECK (julianday(materialized_at) IS NOT NULL),
  PRIMARY KEY (
    project_id,
    object_type,
    object_id,
    object_generation
  ),
  UNIQUE (project_id, source_operation_id),
  CHECK (
    (
      state = 'present'
      AND version_id IS NOT NULL
      AND payload_sha256 IS NOT NULL
    )
    OR (
      state = 'deleted'
      AND version_id IS NULL
      AND payload_sha256 IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS sync_materialized_objects_current_idx
  ON sync_materialized_objects (
    project_id,
    object_type,
    object_id,
    object_generation DESC
  );

CREATE TABLE IF NOT EXISTS sync_materialized_checkpoints (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  signed_remote_cursor TEXT NOT NULL
    CHECK (
      length(signed_remote_cursor) BETWEEN 1 AND 512
      AND signed_remote_cursor NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  downloaded_checkpoint_revision INTEGER NOT NULL
    CHECK (
      downloaded_checkpoint_revision BETWEEN 1 AND 9007199254740991
    ),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL
    CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS sync_content_conflicts (
  conflict_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(conflict_id) BETWEEN 1 AND 200),
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
  object_generation INTEGER NOT NULL
    CHECK (object_generation BETWEEN 1 AND 9007199254740991),
  local_vector_json TEXT NOT NULL
    CHECK (
      json_valid(local_vector_json)
      AND json_type(local_vector_json) = 'object'
    ),
  remote_vector_json TEXT NOT NULL
    CHECK (
      json_valid(remote_vector_json)
      AND json_type(remote_vector_json) = 'object'
    ),
  remote_operation_id TEXT NOT NULL
    CHECK (length(remote_operation_id) BETWEEN 1 AND 200),
  remote_kind TEXT NOT NULL
    CHECK (remote_kind IN ('upsert', 'delete')),
  remote_payload_sha256 TEXT
    CHECK (
      remote_payload_sha256 IS NULL
      OR (
        length(remote_payload_sha256) = 64
        AND remote_payload_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  status TEXT NOT NULL
    CHECK (status IN ('unresolved', 'resolved')),
  resolution TEXT
    CHECK (
      resolution IS NULL
      OR resolution IN (
        'accept_local',
        'accept_remote',
        'merged',
        'dismissed'
      )
    ),
  resolution_operation_id TEXT
    CHECK (
      resolution_operation_id IS NULL
      OR length(resolution_operation_id) BETWEEN 1 AND 200
    ),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (
    (remote_kind = 'upsert' AND remote_payload_sha256 IS NOT NULL)
    OR (remote_kind = 'delete' AND remote_payload_sha256 IS NULL)
  ),
  CHECK (
    (
      status = 'unresolved'
      AND resolution IS NULL
      AND resolution_operation_id IS NULL
      AND resolved_at IS NULL
    )
    OR (
      status = 'resolved'
      AND resolution IS NOT NULL
      AND resolved_at IS NOT NULL
    )
  ),
  CHECK (
    julianday(created_at) IS NOT NULL
    AND julianday(updated_at) >= julianday(created_at)
    AND (
      resolved_at IS NULL
      OR (
        julianday(resolved_at) >= julianday(created_at)
        AND julianday(resolved_at) <= julianday(updated_at)
      )
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sync_content_conflicts_remote_operation_idx
  ON sync_content_conflicts (project_id, remote_operation_id);

CREATE INDEX IF NOT EXISTS sync_content_conflicts_status_idx
  ON sync_content_conflicts (project_id, status, created_at);

CREATE INDEX IF NOT EXISTS sync_content_conflicts_identity_idx
  ON sync_content_conflicts (
    project_id,
    object_type,
    object_id,
    object_generation,
    status,
    created_at
  );

CREATE TABLE IF NOT EXISTS sync_projection_jobs (
  job_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(job_id) = 36
      AND substr(job_id, 9, 1) = '-'
      AND substr(job_id, 14, 1) = '-'
      AND substr(job_id, 15, 1) = '7'
      AND substr(job_id, 19, 1) = '-'
      AND substr(job_id, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(job_id, 24, 1) = '-'
      AND length(replace(job_id, '-', '')) = 32
      AND replace(job_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
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
    CHECK (
      length(object_id) = 36
      AND substr(object_id, 9, 1) = '-'
      AND substr(object_id, 14, 1) = '-'
      AND substr(object_id, 15, 1) = '7'
      AND substr(object_id, 19, 1) = '-'
      AND substr(object_id, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(object_id, 24, 1) = '-'
      AND length(replace(object_id, '-', '')) = 32
      AND replace(object_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  object_generation INTEGER NOT NULL
    CHECK (object_generation BETWEEN 1 AND 9007199254740991),
  projection_kind TEXT NOT NULL
    CHECK (projection_kind IN ('upsert', 'delete')),
  version_id TEXT
    CHECK (
      version_id IS NULL
      OR (
        length(version_id) = 36
        AND substr(version_id, 9, 1) = '-'
        AND substr(version_id, 14, 1) = '-'
        AND substr(version_id, 15, 1) = '7'
        AND substr(version_id, 19, 1) = '-'
        AND substr(version_id, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(version_id, 24, 1) = '-'
        AND length(replace(version_id, '-', '')) = 32
        AND replace(version_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      )
    ),
  source_revision INTEGER NOT NULL
    CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  key_version INTEGER NOT NULL
    CHECK (key_version BETWEEN 1 AND 2147483647),
  consent_revision INTEGER NOT NULL
    CHECK (consent_revision BETWEEN 1 AND 9007199254740991),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) = 36
      AND substr(device_id, 9, 1) = '-'
      AND substr(device_id, 14, 1) = '-'
      AND substr(device_id, 15, 1) = '7'
      AND substr(device_id, 19, 1) = '-'
      AND substr(device_id, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(device_id, 24, 1) = '-'
      AND length(replace(device_id, '-', '')) = 32
      AND replace(device_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'queued',
        'leased',
        'retry_wait',
        'completed',
        'failed',
        'superseded'
      )
    ),
  attempt INTEGER NOT NULL
    CHECK (attempt BETWEEN 0 AND 100),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  next_attempt_at TEXT,
  lease_owner_id TEXT
    CHECK (
      lease_owner_id IS NULL
      OR (
        length(lease_owner_id) = 36
        AND substr(lease_owner_id, 9, 1) = '-'
        AND substr(lease_owner_id, 14, 1) = '-'
        AND substr(lease_owner_id, 15, 1) = '7'
        AND substr(lease_owner_id, 19, 1) = '-'
        AND substr(lease_owner_id, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(lease_owner_id, 24, 1) = '-'
        AND length(replace(lease_owner_id, '-', '')) = 32
        AND replace(lease_owner_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      )
    ),
  lease_token TEXT
    CHECK (
      lease_token IS NULL
      OR (
        length(lease_token) = 36
        AND substr(lease_token, 9, 1) = '-'
        AND substr(lease_token, 14, 1) = '-'
        AND substr(lease_token, 15, 1) = '7'
        AND substr(lease_token, 19, 1) = '-'
        AND substr(lease_token, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(lease_token, 24, 1) = '-'
        AND length(replace(lease_token, '-', '')) = 32
        AND replace(lease_token, '-', '') NOT GLOB '*[^0-9a-f]*'
      )
    ),
  lease_expires_at TEXT,
  operation_id TEXT
    CHECK (
      operation_id IS NULL
      OR (
        length(operation_id) = 36
        AND substr(operation_id, 9, 1) = '-'
        AND substr(operation_id, 14, 1) = '-'
        AND substr(operation_id, 15, 1) = '7'
        AND substr(operation_id, 19, 1) = '-'
        AND substr(operation_id, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(operation_id, 24, 1) = '-'
        AND length(replace(operation_id, '-', '')) = 32
        AND replace(operation_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      )
    ),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR (
        length(failure_code) BETWEEN 1 AND 120
        AND failure_code NOT GLOB '*[^A-Z0-9_.:-]*'
      )
    ),
  superseded_by_job_id TEXT
    CHECK (
      superseded_by_job_id IS NULL
      OR (
        length(superseded_by_job_id) = 36
        AND substr(superseded_by_job_id, 9, 1) = '-'
        AND substr(superseded_by_job_id, 14, 1) = '-'
        AND substr(superseded_by_job_id, 15, 1) = '7'
        AND substr(superseded_by_job_id, 19, 1) = '-'
        AND substr(superseded_by_job_id, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(superseded_by_job_id, 24, 1) = '-'
        AND length(replace(superseded_by_job_id, '-', '')) = 32
        AND replace(superseded_by_job_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      )
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE (
    project_id,
    object_type,
    object_id,
    object_generation,
    projection_kind,
    source_revision,
    key_version,
    consent_revision,
    device_id
  ),
  CHECK (
    (projection_kind = 'upsert' AND version_id IS NOT NULL)
    OR (projection_kind = 'delete' AND version_id IS NULL)
  ),
  CHECK (
    (
      status = 'queued'
      AND attempt = 0
      AND next_attempt_at IS NOT NULL
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND operation_id IS NULL
      AND failure_code IS NULL
      AND superseded_by_job_id IS NULL
      AND terminal_at IS NULL
    )
    OR (
      status = 'leased'
      AND attempt >= 1
      AND next_attempt_at IS NULL
      AND lease_owner_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND operation_id IS NULL
      AND failure_code IS NULL
      AND superseded_by_job_id IS NULL
      AND terminal_at IS NULL
    )
    OR (
      status = 'retry_wait'
      AND attempt >= 1
      AND next_attempt_at IS NOT NULL
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND operation_id IS NULL
      AND failure_code IS NOT NULL
      AND superseded_by_job_id IS NULL
      AND terminal_at IS NULL
    )
    OR (
      status = 'completed'
      AND attempt >= 1
      AND next_attempt_at IS NULL
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND operation_id IS NOT NULL
      AND failure_code IS NULL
      AND superseded_by_job_id IS NULL
      AND terminal_at IS NOT NULL
    )
    OR (
      status = 'failed'
      AND attempt >= 1
      AND next_attempt_at IS NULL
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND operation_id IS NULL
      AND failure_code IS NOT NULL
      AND superseded_by_job_id IS NULL
      AND terminal_at IS NOT NULL
    )
    OR (
      status = 'superseded'
      AND next_attempt_at IS NULL
      AND lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND operation_id IS NULL
      AND failure_code IS NULL
      AND superseded_by_job_id IS NOT NULL
      AND terminal_at IS NOT NULL
    )
  ),
  CHECK (
    julianday(created_at) IS NOT NULL
    AND julianday(updated_at) >= julianday(created_at)
    AND (
      next_attempt_at IS NULL
      OR julianday(next_attempt_at) >= julianday(created_at)
    )
    AND (
      lease_expires_at IS NULL
      OR julianday(lease_expires_at) > julianday(updated_at)
    )
    AND (
      terminal_at IS NULL
      OR (
        julianday(terminal_at) >= julianday(created_at)
        AND julianday(terminal_at) <= julianday(updated_at)
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS sync_projection_jobs_runnable_idx
  ON sync_projection_jobs (
    project_id,
    status,
    next_attempt_at,
    created_at,
    job_id
  );

CREATE INDEX IF NOT EXISTS sync_projection_jobs_identity_idx
  ON sync_projection_jobs (
    project_id,
    object_type,
    object_id,
    object_generation,
    source_revision DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS sync_projection_jobs_operation_idx
  ON sync_projection_jobs (operation_id)
  WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sync_projection_jobs_lease_token_idx
  ON sync_projection_jobs (lease_token)
  WHERE lease_token IS NOT NULL;
