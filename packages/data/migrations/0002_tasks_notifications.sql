CREATE TABLE IF NOT EXISTS background_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  task_type TEXT NOT NULL
    CHECK (
      length(task_type) BETWEEN 1 AND 64
      AND task_type NOT GLOB '*[^a-z0-9_.-]*'
    ),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'queued',
        'running',
        'waiting_retry',
        'paused',
        'succeeded',
        'failed',
        'cancelled'
      )
    ),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  run_after TEXT,
  lease_owner_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  progress_step TEXT,
  progress_completed_units INTEGER,
  progress_total_units INTEGER,
  progress_updated_at TEXT,
  failure_code TEXT,
  failure_cause_code TEXT,
  failure_retryable INTEGER
    CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1)),
  failure_actions_json TEXT
    CHECK (
      failure_actions_json IS NULL
      OR (
        json_valid(failure_actions_json)
        AND json_type(failure_actions_json) = 'array'
      )
    ),
  failure_request_id TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  CHECK (attempt <= max_attempts),
  CHECK (
    (
      lease_owner_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
    OR (
      lease_owner_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  ),
  CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND run_after IS NULL)
    OR (
      status IN ('queued', 'waiting_retry')
      AND lease_token IS NULL
      AND run_after IS NOT NULL
    )
    OR (
      status IN ('paused', 'succeeded', 'failed', 'cancelled')
      AND lease_token IS NULL
      AND run_after IS NULL
    )
  ),
  CHECK (
    (
      progress_step IS NULL
      AND progress_completed_units IS NULL
      AND progress_total_units IS NULL
      AND progress_updated_at IS NULL
    )
    OR (
      progress_step IS NOT NULL
      AND progress_completed_units IS NOT NULL
      AND progress_completed_units >= 0
      AND (
        progress_total_units IS NULL
        OR (
          progress_total_units >= 1
          AND progress_completed_units <= progress_total_units
        )
      )
      AND progress_updated_at IS NOT NULL
    )
  ),
  CHECK (
    (
      failure_code IS NULL
      AND failure_cause_code IS NULL
      AND failure_retryable IS NULL
      AND failure_actions_json IS NULL
      AND failure_request_id IS NULL
    )
    OR (
      failure_code IS NOT NULL
      AND failure_retryable IS NOT NULL
      AND failure_actions_json IS NOT NULL
      AND failure_request_id IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS background_tasks_runnable_idx
  ON background_tasks (status, run_after, priority DESC, created_at);

CREATE INDEX IF NOT EXISTS background_tasks_expired_lease_idx
  ON background_tasks (status, lease_expires_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE
    CHECK (length(dedupe_key) BETWEEN 8 AND 200),
  message_key TEXT NOT NULL
    CHECK (length(message_key) BETWEEN 3 AND 128),
  level TEXT NOT NULL
    CHECK (level IN ('toast', 'inline', 'inbox', 'blocking')),
  severity TEXT NOT NULL
    CHECK (severity IN ('info', 'success', 'warning', 'error')),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'created',
        'queued',
        'visible',
        'read',
        'acted',
        'dismissed',
        'expired',
        'failed_delivery'
      )
    ),
  route_entity_type TEXT,
  route_entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  requires_resolution INTEGER NOT NULL
    CHECK (requires_resolution IN (0, 1)),
  expires_at TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  visible_at TEXT,
  read_at TEXT,
  acted_at TEXT,
  dismissed_at TEXT,
  expired_at TEXT,
  CHECK (
    (route_entity_type IS NULL AND route_entity_id IS NULL)
    OR (route_entity_type IS NOT NULL AND route_entity_id IS NOT NULL)
  ),
  CHECK (
    (level <> 'blocking' AND requires_resolution = 0)
    OR expires_at IS NULL
  )
);

CREATE INDEX IF NOT EXISTS notifications_status_updated_idx
  ON notifications (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS notifications_expiration_idx
  ON notifications (expires_at, status)
  WHERE expires_at IS NOT NULL;
