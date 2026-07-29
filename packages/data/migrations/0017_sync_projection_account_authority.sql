-- Bind every plaintext projection job to the cloud account authority that
-- existed when the job was queued.
--
-- One-time migration contract:
--   * this versioned migration must be executed exactly once by the migration
--     runner inside its normal atomic migration transaction;
--   * 0015_sync_materialization_authority.sql must already be applied;
--   * InkShadow has not shipped a schema that can prove the account that
--     authorized a legacy projection job.
--
-- Therefore no legacy row is copied. This deliberately clears queued, leased,
-- retrying, terminal, and completed projection-job references instead of
-- attributing them to the registration that merely happens to be current at
-- migration time. Completed transport operations, ciphertext, materialized
-- markers, and local plaintext remain in their independent authoritative
-- tables. Current-account projection jobs are regenerated through the
-- consent-gated initial seeder after migration.
--
-- The old table is dropped only inside the host migration transaction, so a
-- later failure rolls the schema and every legacy row back together.

CREATE TABLE sync_projection_jobs_account_authority_new (
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
    account_id,
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

DROP TABLE sync_projection_jobs;
ALTER TABLE sync_projection_jobs_account_authority_new
  RENAME TO sync_projection_jobs;

CREATE INDEX sync_projection_jobs_runnable_idx
  ON sync_projection_jobs (
    project_id,
    status,
    next_attempt_at,
    created_at,
    job_id
  );

CREATE INDEX sync_projection_jobs_identity_idx
  ON sync_projection_jobs (
    project_id,
    object_type,
    object_id,
    object_generation,
    source_revision DESC
  );

CREATE UNIQUE INDEX sync_projection_jobs_operation_idx
  ON sync_projection_jobs (operation_id)
  WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX sync_projection_jobs_lease_token_idx
  ON sync_projection_jobs (lease_token)
  WHERE lease_token IS NOT NULL;
