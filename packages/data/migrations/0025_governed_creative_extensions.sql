PRAGMA foreign_keys = ON;

-- A raw consent token never enters SQLite. Only this digest and the exact,
-- short-lived purpose are durable enough to support one-time consumption.
CREATE TABLE IF NOT EXISTS governed_extension_egress_receipts (
  receipt_digest TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(receipt_digest) = 64
      AND receipt_digest = lower(receipt_digest)
      AND receipt_digest NOT GLOB '*[^0-9a-f]*'
    ),
  kind TEXT NOT NULL
    CHECK (kind IN ('translation', 'short_drama')),
  provider_id TEXT NOT NULL
    CHECK (length(provider_id) BETWEEN 1 AND 128),
  base_url TEXT NOT NULL
    CHECK (length(base_url) BETWEEN 8 AND 2048),
  model_id TEXT NOT NULL
    CHECK (length(model_id) BETWEEN 1 AND 512),
  data_categories_json TEXT NOT NULL
    CHECK (
      json_valid(data_categories_json)
      AND json_type(data_categories_json) = 'array'
      AND length(data_categories_json) BETWEEN 3 AND 2048
    ),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL
    REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  price_version TEXT NOT NULL
    CHECK (length(price_version) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL
    CHECK (
      length(request_fingerprint) = 64
      AND request_fingerprint = lower(request_fingerprint)
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  scope_fingerprint TEXT NOT NULL
    CHECK (
      length(scope_fingerprint) = 64
      AND scope_fingerprint = lower(scope_fingerprint)
      AND scope_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  -- Deliberately not a foreign key: requests reference the receipt digest.
  -- Avoiding a reverse FK keeps project deletion and backup restore acyclic.
  request_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (expires_at > created_at),
  CHECK (
    (consumed_at IS NULL AND request_id IS NULL)
    OR (consumed_at IS NOT NULL AND request_id IS NOT NULL AND consumed_at >= created_at)
  ),
  CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at
    AND (
      consumed_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) = consumed_at
    )
  )
);

CREATE INDEX IF NOT EXISTS governed_extension_receipts_expiry_idx
  ON governed_extension_egress_receipts (expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS governed_extension_budgets (
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL
    CHECK (month_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL
    CHECK (
      length(currency) = 3
      AND currency = upper(currency)
      AND currency GLOB '[A-Z][A-Z][A-Z]'
    ),
  limit_micros INTEGER NOT NULL
    CHECK (limit_micros BETWEEN 0 AND 9007199254740991),
  spent_micros INTEGER NOT NULL DEFAULT 0
    CHECK (spent_micros BETWEEN 0 AND 9007199254740991),
  reserved_micros INTEGER NOT NULL DEFAULT 0
    CHECK (reserved_micros BETWEEN 0 AND 9007199254740991),
  active_requests INTEGER NOT NULL DEFAULT 0
    CHECK (active_requests BETWEEN 0 AND 1000),
  maximum_concurrent INTEGER NOT NULL
    CHECK (maximum_concurrent BETWEEN 1 AND 1000),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, month_key),
  CHECK (updated_at >= created_at),
  CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
  )
);

CREATE TABLE IF NOT EXISTS governed_extension_requests (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL
    REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  source_checksum TEXT NOT NULL
    CHECK (
      length(source_checksum) = 64
      AND source_checksum = lower(source_checksum)
      AND source_checksum NOT GLOB '*[^0-9a-f]*'
    ),
  kind TEXT NOT NULL
    CHECK (kind IN ('translation', 'short_drama')),
  attempt INTEGER NOT NULL
    CHECK (attempt BETWEEN 1 AND 100),
  retry_of_request_id TEXT
    REFERENCES governed_extension_requests(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 8 AND 200
      AND idempotency_key = trim(idempotency_key)
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_fingerprint TEXT NOT NULL
    CHECK (
      length(request_fingerprint) = 64
      AND request_fingerprint = lower(request_fingerprint)
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  request_snapshot_json TEXT NOT NULL
    CHECK (
      json_valid(request_snapshot_json)
      AND json_type(request_snapshot_json) = 'object'
      AND length(request_snapshot_json) BETWEEN 2 AND 6000000
      AND instr(request_snapshot_json, char(0)) = 0
    ),
  provider_location TEXT NOT NULL
    CHECK (provider_location IN ('loopback', 'remote')),
  provider_id TEXT NOT NULL
    CHECK (length(provider_id) BETWEEN 1 AND 128),
  base_url TEXT NOT NULL
    CHECK (length(base_url) BETWEEN 8 AND 2048),
  model_id TEXT NOT NULL
    CHECK (length(model_id) BETWEEN 1 AND 512),
  data_categories_json TEXT NOT NULL
    CHECK (
      json_valid(data_categories_json)
      AND json_type(data_categories_json) = 'array'
      AND length(data_categories_json) BETWEEN 3 AND 2048
    ),
  input_micros_per_million_tokens INTEGER NOT NULL
    CHECK (input_micros_per_million_tokens BETWEEN 0 AND 9000000000000000),
  output_micros_per_million_tokens INTEGER NOT NULL
    CHECK (output_micros_per_million_tokens BETWEEN 0 AND 9000000000000000),
  currency TEXT NOT NULL
    CHECK (
      length(currency) = 3
      AND currency = upper(currency)
      AND currency GLOB '[A-Z][A-Z][A-Z]'
    ),
  price_version TEXT NOT NULL
    CHECK (length(price_version) BETWEEN 1 AND 128),
  price_updated_at TEXT NOT NULL,
  maximum_input_tokens INTEGER NOT NULL
    CHECK (maximum_input_tokens BETWEEN 1 AND 10000000),
  maximum_output_tokens INTEGER NOT NULL
    CHECK (maximum_output_tokens BETWEEN 1 AND 10000000),
  reserved_cost_micros INTEGER NOT NULL
    CHECK (reserved_cost_micros BETWEEN 0 AND 9007199254740991),
  timeout_ms INTEGER NOT NULL
    CHECK (timeout_ms BETWEEN 1000 AND 3600000),
  receipt_digest TEXT
    REFERENCES governed_extension_egress_receipts(receipt_digest) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'running',
        'candidate_ready',
        'cancelled',
        'failed_retryable',
        'failed_final'
      )
    ),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  candidate_id TEXT
    REFERENCES governed_extension_candidates(id)
    DEFERRABLE INITIALLY DEFERRED,
  usage_source TEXT
    CHECK (usage_source IN ('provider_reported', 'provider_unavailable')),
  input_tokens INTEGER
    CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 100000000),
  output_tokens INTEGER
    CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 100000000),
  cached_input_tokens INTEGER
    CHECK (cached_input_tokens IS NULL OR cached_input_tokens BETWEEN 0 AND 100000000),
  calculated_cost_micros INTEGER
    CHECK (
      calculated_cost_micros IS NULL
      OR calculated_cost_micros BETWEEN 0 AND 9007199254740991
    ),
  provider_receipt_digest TEXT
    CHECK (
      provider_receipt_digest IS NULL
      OR (
        length(provider_receipt_digest) = 64
        AND provider_receipt_digest = lower(provider_receipt_digest)
        AND provider_receipt_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
  cancellation_requested INTEGER NOT NULL DEFAULT 0
    CHECK (cancellation_requested IN (0, 1)),
  error_code TEXT
    CHECK (
      error_code IS NULL
      OR (
        length(error_code) BETWEEN 3 AND 128
        AND error_code = upper(error_code)
        AND error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, kind, idempotency_key),
  CHECK (
    (provider_location = 'remote' AND receipt_digest IS NOT NULL)
    OR (provider_location = 'loopback' AND receipt_digest IS NULL)
  ),
  CHECK (
    (attempt = 1 AND retry_of_request_id IS NULL)
    OR (attempt > 1 AND retry_of_request_id IS NOT NULL)
  ),
  CHECK (
    (status = 'running' AND completed_at IS NULL AND candidate_id IS NULL)
    OR (
      status = 'candidate_ready'
      AND completed_at IS NOT NULL
      AND candidate_id IS NOT NULL
      AND error_code IS NULL
    )
    OR (
      status IN ('cancelled', 'failed_retryable', 'failed_final')
      AND completed_at IS NOT NULL
      AND candidate_id IS NULL
      AND error_code IS NOT NULL
    )
  ),
  CHECK (
    (usage_source IS NULL
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND cached_input_tokens IS NULL
      AND calculated_cost_micros IS NULL)
    OR (
      usage_source = 'provider_unavailable'
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND cached_input_tokens IS NULL
      -- Once execution may have reached a provider, unknown usage settles
      -- conservatively at the immutable maximum reservation. This is an
      -- internal budget estimate, never a representation of provider billing.
      AND calculated_cost_micros IS NOT NULL
    )
    OR (
      usage_source = 'provider_reported'
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND (cached_input_tokens IS NULL OR cached_input_tokens <= input_tokens)
      AND calculated_cost_micros IS NOT NULL
    )
  ),
  CHECK (
    (status = 'cancelled' AND cancellation_requested = 1)
    OR status <> 'cancelled'
  ),
  CHECK (updated_at >= created_at AND started_at >= created_at),
  CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', price_updated_at) = price_updated_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    AND (
      completed_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
    )
  )
);

CREATE INDEX IF NOT EXISTS governed_extension_requests_history_idx
  ON governed_extension_requests (project_id, kind, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS governed_extension_requests_recovery_idx
  ON governed_extension_requests (status, updated_at, id)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS governed_extension_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE
    REFERENCES governed_extension_requests(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL
    REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  source_checksum TEXT NOT NULL
    CHECK (
      length(source_checksum) = 64
      AND source_checksum = lower(source_checksum)
      AND source_checksum NOT GLOB '*[^0-9a-f]*'
    ),
  kind TEXT NOT NULL
    CHECK (kind IN ('translation', 'short_drama')),
  payload_json TEXT NOT NULL
    CHECK (
      json_valid(payload_json)
      AND json_type(payload_json) = 'object'
      AND length(payload_json) BETWEEN 2 AND 1000000
      AND instr(payload_json, char(0)) = 0
    ),
  payload_checksum TEXT NOT NULL
    CHECK (
      length(payload_checksum) = 64
      AND payload_checksum = lower(payload_checksum)
      AND payload_checksum NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL
    CHECK (status IN ('ready', 'accepted', 'rejected', 'expired')),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  formal_output_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK (
    (status = 'ready' AND decided_at IS NULL AND formal_output_id IS NULL)
    OR (
      status = 'accepted'
      AND decided_at IS NOT NULL
      AND formal_output_id IS NOT NULL
    )
    OR (
      status IN ('rejected', 'expired')
      AND decided_at IS NOT NULL
      AND formal_output_id IS NULL
    )
  ),
  CHECK (updated_at >= created_at),
  CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    AND (
      decided_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at
    )
  )
);

CREATE INDEX IF NOT EXISTS governed_extension_candidates_history_idx
  ON governed_extension_candidates (project_id, kind, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS governed_extension_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('request', 'receipt', 'candidate', 'budget')),
  entity_id TEXT NOT NULL
    CHECK (length(entity_id) BETWEEN 1 AND 256),
  action TEXT NOT NULL
    CHECK (
      action IN (
        'receipt_issued',
        'request_started',
        'request_replayed',
        'request_cancelled',
        'request_failed',
        'candidate_published',
        'candidate_accept',
        'candidate_reject',
        'candidate_expire',
        'reservation_recovered'
      )
    ),
  correlation_id TEXT NOT NULL
    CHECK (length(correlation_id) BETWEEN 1 AND 256),
  provider_id TEXT,
  model_id TEXT,
  base_url_digest TEXT
    CHECK (
      base_url_digest IS NULL
      OR (
        length(base_url_digest) = 64
        AND base_url_digest = lower(base_url_digest)
        AND base_url_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
  request_fingerprint TEXT
    CHECK (
      request_fingerprint IS NULL
      OR (
        length(request_fingerprint) = 64
        AND request_fingerprint = lower(request_fingerprint)
        AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
      )
    ),
  error_code TEXT
    CHECK (
      error_code IS NULL
      OR (
        length(error_code) BETWEEN 3 AND 128
        AND error_code = upper(error_code)
        AND error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      json_valid(metadata_json)
      AND json_type(metadata_json) = 'object'
      AND length(metadata_json) <= 16384
      AND json_type(metadata_json, '$.content') IS NULL
      AND json_type(metadata_json, '$.prompt') IS NULL
      AND json_type(metadata_json, '$.messages') IS NULL
      AND json_type(metadata_json, '$.key') IS NULL
      AND json_type(metadata_json, '$.secret') IS NULL
      AND json_type(metadata_json, '$.credential') IS NULL
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE INDEX IF NOT EXISTS governed_extension_audit_entity_idx
  ON governed_extension_audit_events (entity_type, entity_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS chapter_translations (
  id TEXT PRIMARY KEY NOT NULL,
  candidate_id TEXT NOT NULL UNIQUE
    REFERENCES governed_extension_candidates(id) ON DELETE RESTRICT,
  accept_audit_event_id TEXT NOT NULL UNIQUE
    REFERENCES governed_extension_audit_events(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL
    REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  source_checksum TEXT NOT NULL
    CHECK (length(source_checksum) = 64),
  target_language_code TEXT NOT NULL
    CHECK (length(target_language_code) BETWEEN 2 AND 32),
  target_language_label TEXT NOT NULL
    CHECK (length(target_language_label) BETWEEN 1 AND 80),
  tone TEXT NOT NULL
    CHECK (length(tone) BETWEEN 1 AND 120),
  glossary_version TEXT NOT NULL
    CHECK (length(glossary_version) BETWEEN 1 AND 256),
  payload_json TEXT NOT NULL
    CHECK (
      json_valid(payload_json)
      AND json_type(payload_json) = 'object'
      AND length(payload_json) BETWEEN 2 AND 1000000
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE INDEX IF NOT EXISTS chapter_translations_chapter_idx
  ON chapter_translations (chapter_id, target_language_code, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS short_drama_scripts (
  id TEXT PRIMARY KEY NOT NULL,
  candidate_id TEXT NOT NULL UNIQUE
    REFERENCES governed_extension_candidates(id) ON DELETE RESTRICT,
  accept_audit_event_id TEXT NOT NULL UNIQUE
    REFERENCES governed_extension_audit_events(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL
    REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  source_checksum TEXT NOT NULL
    CHECK (length(source_checksum) = 64),
  title TEXT NOT NULL
    CHECK (length(title) BETWEEN 1 AND 240),
  format TEXT NOT NULL
    CHECK (format IN ('vertical_micro_drama', 'standard_short_drama')),
  payload_json TEXT NOT NULL
    CHECK (
      json_valid(payload_json)
      AND json_type(payload_json) = 'object'
      AND length(payload_json) BETWEEN 2 AND 1000000
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE INDEX IF NOT EXISTS short_drama_scripts_chapter_idx
  ON short_drama_scripts (chapter_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS governed_extension_request_authority_insert
BEFORE INSERT ON governed_extension_requests
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM chapters AS chapter
      INNER JOIN chapter_versions AS version
        ON version.id = NEW.source_version_id
       AND version.chapter_id = chapter.id
       AND version.project_id = chapter.project_id
      WHERE chapter.id = NEW.chapter_id
        AND chapter.project_id = NEW.project_id
        AND chapter.current_version_id = NEW.source_version_id
        AND version.content_checksum = NEW.source_checksum
    )
    THEN RAISE(ABORT, 'governed extension source authority mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS governed_extension_retry_authority_insert
BEFORE INSERT ON governed_extension_requests
WHEN NEW.retry_of_request_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_extension_requests AS previous
      WHERE previous.id = NEW.retry_of_request_id
        AND previous.project_id = NEW.project_id
        AND previous.chapter_id = NEW.chapter_id
        AND previous.source_version_id = NEW.source_version_id
        AND previous.source_checksum = NEW.source_checksum
        AND previous.kind = NEW.kind
        AND previous.attempt + 1 = NEW.attempt
        AND previous.status IN ('cancelled', 'failed_retryable', 'failed_final')
    )
    THEN RAISE(ABORT, 'governed extension retry authority mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS governed_extension_candidate_authority_insert
BEFORE INSERT ON governed_extension_candidates
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_extension_requests AS request
      WHERE request.id = NEW.request_id
        AND request.project_id = NEW.project_id
        AND request.chapter_id = NEW.chapter_id
        AND request.source_version_id = NEW.source_version_id
        AND request.source_checksum = NEW.source_checksum
        AND request.kind = NEW.kind
        AND (
          request.status = 'running'
          OR (
            request.status = 'candidate_ready'
            AND request.candidate_id = NEW.id
          )
        )
    )
    THEN RAISE(ABORT, 'governed extension candidate authority mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS governed_extension_request_authority_immutable
BEFORE UPDATE ON governed_extension_requests
WHEN
  NEW.project_id <> OLD.project_id
  OR NEW.chapter_id <> OLD.chapter_id
  OR NEW.source_version_id <> OLD.source_version_id
  OR NEW.source_checksum <> OLD.source_checksum
  OR NEW.kind <> OLD.kind
  OR NEW.attempt <> OLD.attempt
  OR NEW.retry_of_request_id IS NOT OLD.retry_of_request_id
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.request_fingerprint <> OLD.request_fingerprint
  OR NEW.request_snapshot_json <> OLD.request_snapshot_json
  OR NEW.provider_location <> OLD.provider_location
  OR NEW.provider_id <> OLD.provider_id
  OR NEW.base_url <> OLD.base_url
  OR NEW.model_id <> OLD.model_id
  OR NEW.data_categories_json <> OLD.data_categories_json
  OR NEW.input_micros_per_million_tokens <> OLD.input_micros_per_million_tokens
  OR NEW.output_micros_per_million_tokens <> OLD.output_micros_per_million_tokens
  OR NEW.currency <> OLD.currency
  OR NEW.price_version <> OLD.price_version
  OR NEW.price_updated_at <> OLD.price_updated_at
  OR NEW.maximum_input_tokens <> OLD.maximum_input_tokens
  OR NEW.maximum_output_tokens <> OLD.maximum_output_tokens
  OR NEW.reserved_cost_micros <> OLD.reserved_cost_micros
  OR NEW.timeout_ms <> OLD.timeout_ms
  OR NEW.receipt_digest IS NOT OLD.receipt_digest
  OR NEW.started_at <> OLD.started_at
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'governed extension request authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS governed_extension_request_terminal_immutable
BEFORE UPDATE ON governed_extension_requests
WHEN OLD.status <> 'running'
BEGIN
  SELECT RAISE(ABORT, 'governed extension terminal request is immutable');
END;

CREATE TRIGGER IF NOT EXISTS governed_extension_candidate_authority_immutable
BEFORE UPDATE ON governed_extension_candidates
WHEN
  NEW.request_id <> OLD.request_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.chapter_id <> OLD.chapter_id
  OR NEW.source_version_id <> OLD.source_version_id
  OR NEW.source_checksum <> OLD.source_checksum
  OR NEW.kind <> OLD.kind
  OR NEW.payload_json <> OLD.payload_json
  OR NEW.payload_checksum <> OLD.payload_checksum
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'governed extension candidate authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS governed_extension_candidate_terminal_immutable
BEFORE UPDATE ON governed_extension_candidates
WHEN OLD.status <> 'ready'
BEGIN
  SELECT RAISE(ABORT, 'governed extension terminal candidate is immutable');
END;

CREATE TRIGGER IF NOT EXISTS governed_extension_receipt_authority_immutable
BEFORE UPDATE ON governed_extension_egress_receipts
WHEN
  NEW.kind <> OLD.kind
  OR NEW.provider_id <> OLD.provider_id
  OR NEW.base_url <> OLD.base_url
  OR NEW.model_id <> OLD.model_id
  OR NEW.data_categories_json <> OLD.data_categories_json
  OR NEW.project_id <> OLD.project_id
  OR NEW.chapter_id <> OLD.chapter_id
  OR NEW.source_version_id <> OLD.source_version_id
  OR NEW.price_version <> OLD.price_version
  OR NEW.request_fingerprint <> OLD.request_fingerprint
  OR NEW.scope_fingerprint <> OLD.scope_fingerprint
  OR NEW.created_at <> OLD.created_at
  OR NEW.expires_at <> OLD.expires_at
  OR OLD.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'governed extension consent receipt is immutable or consumed');
END;

CREATE TRIGGER IF NOT EXISTS governed_extension_audit_append_only_update
BEFORE UPDATE ON governed_extension_audit_events
BEGIN
  SELECT RAISE(ABORT, 'governed extension audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS chapter_translation_accept_guard
BEFORE INSERT ON chapter_translations
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_extension_candidates AS candidate
      INNER JOIN governed_extension_audit_events AS audit
        ON audit.id = NEW.accept_audit_event_id
      WHERE candidate.id = NEW.candidate_id
        AND (
          candidate.status = 'ready'
          OR (
            candidate.status = 'accepted'
            AND candidate.formal_output_id = NEW.id
          )
        )
        AND candidate.kind = 'translation'
        AND candidate.project_id = NEW.project_id
        AND candidate.chapter_id = NEW.chapter_id
        AND candidate.source_version_id = NEW.source_version_id
        AND candidate.source_checksum = NEW.source_checksum
        AND candidate.payload_json = NEW.payload_json
        AND audit.project_id = NEW.project_id
        AND audit.entity_type = 'candidate'
        AND audit.entity_id = NEW.candidate_id
        AND audit.action = 'candidate_accept'
    )
    THEN RAISE(ABORT, 'translation acceptance authority mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS short_drama_accept_guard
BEFORE INSERT ON short_drama_scripts
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_extension_candidates AS candidate
      INNER JOIN governed_extension_audit_events AS audit
        ON audit.id = NEW.accept_audit_event_id
      WHERE candidate.id = NEW.candidate_id
        AND (
          candidate.status = 'ready'
          OR (
            candidate.status = 'accepted'
            AND candidate.formal_output_id = NEW.id
          )
        )
        AND candidate.kind = 'short_drama'
        AND candidate.project_id = NEW.project_id
        AND candidate.chapter_id = NEW.chapter_id
        AND candidate.source_version_id = NEW.source_version_id
        AND candidate.source_checksum = NEW.source_checksum
        AND candidate.payload_json = NEW.payload_json
        AND audit.project_id = NEW.project_id
        AND audit.entity_type = 'candidate'
        AND audit.entity_id = NEW.candidate_id
        AND audit.action = 'candidate_accept'
    )
    THEN RAISE(ABORT, 'short-drama acceptance authority mismatch')
  END;
END;
