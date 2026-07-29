PRAGMA foreign_keys = ON;

-- Durable metadata-only queue for authoritative chapter extraction. Deliberately
-- absent: chapter content, prompt body, provider response text, messages, and
-- credentials. Workers rehydrate the current source and revalidate its digest.
CREATE TABLE IF NOT EXISTS authoritative_extraction_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  source_checksum_sha256 TEXT NOT NULL
    CHECK (
      length(source_checksum_sha256) = 64
      AND source_checksum_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  scope_start INTEGER NOT NULL CHECK (scope_start >= 0),
  scope_end INTEGER NOT NULL CHECK (scope_end > scope_start),
  source_length INTEGER NOT NULL
    CHECK (source_length >= scope_end AND source_length <= 5000000),
  prompt_registry_id TEXT NOT NULL,
  prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
  prompt_checksum_sha256 TEXT NOT NULL
    CHECK (
      length(prompt_checksum_sha256) = 64
      AND prompt_checksum_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  evaluation_suite_id TEXT NOT NULL,
  evaluation_version TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('local', 'remote')),
  state TEXT NOT NULL CHECK (
    state IN (
      'queued',
      'running',
      'waiting_for_network',
      'blocked_evaluation',
      'materialization_pending',
      'materializing',
      'awaiting_review',
      'completed',
      'failed_retryable',
      'failed_final',
      'blocked_stale',
      'cancelled'
    )
  ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
  lease_owner TEXT,
  lease_expires_at TEXT,
  failure_code TEXT,
  failure_retryable INTEGER CHECK (failure_retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  CHECK (
    (
      state IN ('running', 'materializing')
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      state NOT IN ('running', 'materializing')
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CHECK (cancel_requested = 0 OR state = 'running'),
  CHECK (
    (failure_code IS NULL AND failure_retryable IS NULL)
    OR (failure_code IS NOT NULL AND failure_retryable IS NOT NULL)
  ),
  UNIQUE (
    project_id,
    chapter_id,
    source_version_id,
    scope_start,
    scope_end,
    prompt_registry_id,
    prompt_version,
    prompt_checksum_sha256,
    model_provider,
    model_id,
    model_revision,
    evaluation_suite_id,
    evaluation_version
  )
);

CREATE INDEX IF NOT EXISTS authoritative_extraction_jobs_claim_idx
  ON authoritative_extraction_jobs (project_id, state, created_at, id);

CREATE INDEX IF NOT EXISTS authoritative_extraction_jobs_lease_idx
  ON authoritative_extraction_jobs (state, lease_expires_at, id)
  WHERE state IN ('running', 'materializing');

CREATE TABLE IF NOT EXISTS authoritative_extraction_candidates (
  job_id TEXT NOT NULL
    REFERENCES authoritative_extraction_jobs(id) ON DELETE CASCADE,
  candidate_key TEXT NOT NULL,
  review_item_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  source_checksum_sha256 TEXT NOT NULL
    CHECK (
      length(source_checksum_sha256) = 64
      AND source_checksum_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  evidence_start INTEGER NOT NULL CHECK (evidence_start >= 0),
  evidence_end INTEGER NOT NULL CHECK (evidence_end > evidence_start),
  prompt_registry_id TEXT NOT NULL,
  prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
  prompt_checksum_sha256 TEXT NOT NULL
    CHECK (
      length(prompt_checksum_sha256) = 64
      AND prompt_checksum_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  evaluation_version TEXT NOT NULL,
  target_record_id TEXT NOT NULL REFERENCES story_formal_records(id) ON DELETE RESTRICT,
  target_record_kind TEXT NOT NULL
    CHECK (target_record_kind IN ('character', 'world_rule', 'foreshadow', 'timeline_event')),
  target_expected_revision INTEGER NOT NULL CHECK (target_expected_revision >= 1),
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  PRIMARY KEY (job_id, candidate_key),
  CHECK (evidence_end <= 5000000)
);

CREATE INDEX IF NOT EXISTS authoritative_extraction_candidates_project_idx
  ON authoritative_extraction_candidates (project_id, created_at DESC, job_id, candidate_key);

CREATE TABLE IF NOT EXISTS authoritative_extraction_evaluations (
  id TEXT PRIMARY KEY NOT NULL,
  suite_id TEXT NOT NULL,
  prompt_registry_id TEXT NOT NULL,
  prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
  prompt_checksum_sha256 TEXT NOT NULL
    CHECK (
      length(prompt_checksum_sha256) = 64
      AND prompt_checksum_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  evaluation_version TEXT NOT NULL,
  fixture_count INTEGER NOT NULL CHECK (fixture_count >= 1),
  protocol_failure_count INTEGER NOT NULL
    CHECK (protocol_failure_count BETWEEN 0 AND fixture_count),
  true_positive_count INTEGER NOT NULL CHECK (true_positive_count >= 0),
  false_positive_count INTEGER NOT NULL CHECK (false_positive_count >= 0),
  false_negative_count INTEGER NOT NULL CHECK (false_negative_count >= 0),
  precision REAL NOT NULL CHECK (precision BETWEEN 0.0 AND 1.0),
  recall REAL NOT NULL CHECK (recall BETWEEN 0.0 AND 1.0),
  minimum_precision REAL NOT NULL CHECK (minimum_precision BETWEEN 0.0 AND 1.0),
  minimum_recall REAL NOT NULL CHECK (minimum_recall BETWEEN 0.0 AND 1.0),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object')
);

CREATE INDEX IF NOT EXISTS authoritative_extraction_eval_gate_idx
  ON authoritative_extraction_evaluations (
    suite_id,
    prompt_registry_id,
    prompt_version,
    prompt_checksum_sha256,
    model_provider,
    model_id,
    model_revision,
    evaluation_version,
    passed,
    created_at DESC,
    id
  );

CREATE TABLE IF NOT EXISTS authoritative_extraction_decision_claims (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  decision_id TEXT NOT NULL UNIQUE,
  decision_kind TEXT NOT NULL
    CHECK (decision_kind IN ('accept', 'modify', 'reject', 'defer', 'resume')),
  payload_checksum_sha256 TEXT NOT NULL
    CHECK (
      length(payload_checksum_sha256) = 64
      AND payload_checksum_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL
    CHECK (state IN ('claimed', 'committed', 'projection_pending', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id, candidate_key)
    REFERENCES authoritative_extraction_candidates(job_id, candidate_key)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS authoritative_extraction_decisions_pending_idx
  ON authoritative_extraction_decision_claims (state, updated_at, idempotency_key);

-- A job can cite historical chapter versions, but the citation must have been
-- internally consistent at enqueue time.
CREATE TRIGGER IF NOT EXISTS authoritative_extraction_job_source_guard
BEFORE INSERT ON authoritative_extraction_jobs
WHEN NOT EXISTS (
  SELECT 1
  FROM chapter_versions AS version
  INNER JOIN chapters AS chapter ON chapter.id = version.chapter_id
  WHERE version.id = NEW.source_version_id
    AND version.chapter_id = NEW.chapter_id
    AND version.project_id = NEW.project_id
    AND chapter.project_id = NEW.project_id
    AND version.content_checksum = NEW.source_checksum_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'authoritative extraction source binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS authoritative_extraction_candidate_binding_guard
BEFORE INSERT ON authoritative_extraction_candidates
WHEN NOT EXISTS (
  SELECT 1
  FROM authoritative_extraction_jobs AS job
  WHERE job.id = NEW.job_id
    AND job.project_id = NEW.project_id
    AND job.chapter_id = NEW.chapter_id
    AND job.source_version_id = NEW.source_version_id
    AND job.source_checksum_sha256 = NEW.source_checksum_sha256
    AND job.prompt_registry_id = NEW.prompt_registry_id
    AND job.prompt_version = NEW.prompt_version
    AND job.prompt_checksum_sha256 = NEW.prompt_checksum_sha256
    AND job.model_provider = NEW.model_provider
    AND job.model_id = NEW.model_id
    AND job.model_revision = NEW.model_revision
    AND job.evaluation_version = NEW.evaluation_version
)
OR NOT EXISTS (
  SELECT 1
  FROM story_formal_records AS target
  WHERE target.id = NEW.target_record_id
    AND target.project_id = NEW.project_id
    AND target.kind = NEW.target_record_kind
)
BEGIN
  SELECT RAISE(ABORT, 'authoritative extraction candidate binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS authoritative_extraction_job_authority_immutable
BEFORE UPDATE OF
  project_id,
  chapter_id,
  source_version_id,
  source_checksum_sha256,
  scope_start,
  scope_end,
  source_length,
  prompt_registry_id,
  prompt_version,
  prompt_checksum_sha256,
  model_provider,
  model_id,
  model_revision,
  evaluation_suite_id,
  evaluation_version,
  execution_mode
ON authoritative_extraction_jobs
BEGIN
  SELECT RAISE(ABORT, 'authoritative extraction authority metadata is immutable');
END;
