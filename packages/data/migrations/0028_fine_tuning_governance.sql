PRAGMA foreign_keys = ON;

-- Fine-tuning is local-only in this migration. Source text is kept in the
-- desktop database; no upload receipt or remote endpoint exists in this slice.
CREATE TABLE IF NOT EXISTS fine_tuning_datasets (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 200 AND instr(name, char(0)) = 0),
  state TEXT NOT NULL
    CHECK (state IN ('draft', 'review_required', 'approved', 'archived')),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  manifest_hash TEXT NOT NULL
    CHECK (
      length(manifest_hash) = 64
      AND manifest_hash = lower(manifest_hash)
      AND manifest_hash NOT GLOB '*[^0-9a-f]*'
    ),
  manifest_json TEXT NOT NULL
    CHECK (
      json_valid(manifest_json)
      AND json_type(manifest_json) = 'object'
      AND length(manifest_json) BETWEEN 2 AND 4000000
      AND json_type(manifest_json, '$.content') IS NULL
      AND json_type(manifest_json, '$.sourceText') IS NULL
    ),
  total_content_bytes INTEGER NOT NULL
    CHECK (total_content_bytes BETWEEN 1 AND 2000000000),
  included_sample_count INTEGER NOT NULL
    CHECK (included_sample_count BETWEEN 0 AND 20000),
  duplicate_sample_count INTEGER NOT NULL
    CHECK (duplicate_sample_count BETWEEN 0 AND 20000),
  train_sample_count INTEGER NOT NULL
    CHECK (train_sample_count BETWEEN 0 AND 20000),
  validation_sample_count INTEGER NOT NULL
    CHECK (validation_sample_count BETWEEN 0 AND 20000),
  test_sample_count INTEGER NOT NULL
    CHECK (test_sample_count BETWEEN 0 AND 20000),
  readiness_issues_json TEXT NOT NULL
    CHECK (
      json_valid(readiness_issues_json)
      AND json_type(readiness_issues_json) = 'array'
      AND length(readiness_issues_json) BETWEEN 2 AND 1000000
    ),
  created_by TEXT NOT NULL
    CHECK (length(created_by) BETWEEN 1 AND 96),
  approved_by TEXT,
  approved_at TEXT
    CHECK (
      approved_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', approved_at) = approved_at
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (
      state = 'approved'
      AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND json_array_length(readiness_issues_json) = 0
      AND included_sample_count >= 3
      AND train_sample_count >= 1
      AND validation_sample_count >= 1
      AND test_sample_count >= 1
    )
    OR (
      state <> 'approved'
      AND approved_by IS NULL
      AND approved_at IS NULL
    )
  ),
  CHECK (
    included_sample_count =
      train_sample_count + validation_sample_count + test_sample_count
  ),
  UNIQUE (id, project_id)
);

CREATE INDEX IF NOT EXISTS fine_tuning_datasets_project_history_idx
  ON fine_tuning_datasets (project_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS fine_tuning_samples (
  id TEXT PRIMARY KEY NOT NULL,
  dataset_id TEXT NOT NULL
    REFERENCES fine_tuning_datasets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('chapter_version', 'material', 'local_import')),
  source_entity_id TEXT NOT NULL
    CHECK (length(source_entity_id) BETWEEN 1 AND 256),
  source_revision INTEGER NOT NULL
    CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  source_label TEXT NOT NULL
    CHECK (
      length(source_label) BETWEEN 1 AND 300
      AND instr(source_label, char(0)) = 0
    ),
  content_text TEXT NOT NULL
    CHECK (
      length(content_text) BETWEEN 1 AND 1000000
      AND instr(content_text, char(0)) = 0
    ),
  content_hash TEXT NOT NULL
    CHECK (
      length(content_hash) = 64
      AND content_hash = lower(content_hash)
      AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
  content_bytes INTEGER NOT NULL
    CHECK (content_bytes BETWEEN 1 AND 4000000),
  rights_kind TEXT NOT NULL
    CHECK (
      rights_kind IN (
        'user_owned',
        'licensed_for_training',
        'public_domain',
        'unknown'
      )
    ),
  rights_basis TEXT NOT NULL
    CHECK (
      length(rights_basis) BETWEEN 1 AND 1000
      AND instr(rights_basis, char(0)) = 0
    ),
  rights_confirmed_at TEXT
    CHECK (
      rights_confirmed_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', rights_confirmed_at) = rights_confirmed_at
    ),
  allow_training INTEGER NOT NULL
    CHECK (allow_training IN (0, 1)),
  privacy_scan_version TEXT NOT NULL
    CHECK (privacy_scan_version = 'inkshadow.privacy-scan.v1'),
  pii_finding_count INTEGER NOT NULL
    CHECK (pii_finding_count BETWEEN 0 AND 1000000),
  sensitive_finding_count INTEGER NOT NULL
    CHECK (sensitive_finding_count BETWEEN 0 AND 1000000),
  privacy_findings_json TEXT NOT NULL
    CHECK (
      json_valid(privacy_findings_json)
      AND json_type(privacy_findings_json) = 'array'
      AND length(privacy_findings_json) BETWEEN 2 AND 65536
      AND json_type(privacy_findings_json, '$[0].excerpt') IS NULL
      AND json_type(privacy_findings_json, '$[0].value') IS NULL
    ),
  privacy_passed INTEGER NOT NULL
    CHECK (privacy_passed IN (0, 1)),
  split TEXT NOT NULL
    CHECK (split IN ('train', 'validation', 'test', 'excluded')),
  duplicate_of_sample_id TEXT
    REFERENCES fine_tuning_samples(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  UNIQUE (dataset_id, source_kind, source_entity_id, source_revision, content_hash),
  CHECK (duplicate_of_sample_id IS NULL OR duplicate_of_sample_id <> id),
  CHECK (
    (split = 'excluded' AND duplicate_of_sample_id IS NOT NULL)
    OR duplicate_of_sample_id IS NULL
  ),
  CHECK (
    privacy_passed =
      CASE
        WHEN pii_finding_count = 0 AND sensitive_finding_count = 0 THEN 1
        ELSE 0
      END
  ),
  CHECK (
    rights_kind <> 'unknown'
    OR (rights_confirmed_at IS NULL AND allow_training = 0)
  ),
  FOREIGN KEY (dataset_id, project_id)
    REFERENCES fine_tuning_datasets(id, project_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS fine_tuning_samples_included_hash_unique
  ON fine_tuning_samples (dataset_id, content_hash)
  WHERE split <> 'excluded';

CREATE INDEX IF NOT EXISTS fine_tuning_samples_dataset_split_idx
  ON fine_tuning_samples (dataset_id, split, id);

CREATE TABLE IF NOT EXISTS fine_tuning_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (
      kind IN (
        'dataset_training',
        'model_registration',
        'model_deployment',
        'model_rollback',
        'model_revocation'
      )
    ),
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('dataset', 'artifact', 'deployment')),
  entity_id TEXT NOT NULL
    CHECK (length(entity_id) BETWEEN 1 AND 256),
  entity_revision INTEGER NOT NULL
    CHECK (entity_revision BETWEEN 1 AND 9007199254740991),
  authority_hash TEXT NOT NULL
    CHECK (
      length(authority_hash) = 64
      AND authority_hash = lower(authority_hash)
      AND authority_hash NOT GLOB '*[^0-9a-f]*'
    ),
  actor_id TEXT NOT NULL
    CHECK (length(actor_id) BETWEEN 1 AND 96),
  declarations_json TEXT NOT NULL
    CHECK (
      json_valid(declarations_json)
      AND json_type(declarations_json) = 'object'
      AND length(declarations_json) BETWEEN 2 AND 16384
      AND json_type(declarations_json, '$.content') IS NULL
      AND json_type(declarations_json, '$.credential') IS NULL
      AND json_type(declarations_json, '$.secret') IS NULL
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  UNIQUE (kind, entity_id, entity_revision, authority_hash)
);

CREATE INDEX IF NOT EXISTS fine_tuning_approvals_entity_idx
  ON fine_tuning_approvals (entity_type, entity_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS fine_tuning_quota_policies (
  project_id TEXT PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  allow_remote_training INTEGER NOT NULL DEFAULT 0
    CHECK (allow_remote_training = 0),
  maximum_dataset_bytes INTEGER NOT NULL
    CHECK (maximum_dataset_bytes BETWEEN 1 AND 2000000000),
  maximum_concurrent_jobs INTEGER NOT NULL
    CHECK (maximum_concurrent_jobs BETWEEN 1 AND 128),
  maximum_single_job_cost_micros INTEGER NOT NULL
    CHECK (maximum_single_job_cost_micros BETWEEN 0 AND 9007199254740991),
  monthly_cost_limit_micros INTEGER NOT NULL
    CHECK (monthly_cost_limit_micros BETWEEN 0 AND 9007199254740991),
  currency TEXT NOT NULL
    CHECK (
      length(currency) = 3
      AND currency = upper(currency)
      AND currency GLOB '[A-Z][A-Z][A-Z]'
    ),
  spent_micros INTEGER NOT NULL DEFAULT 0
    CHECK (spent_micros BETWEEN 0 AND 9007199254740991),
  reserved_micros INTEGER NOT NULL DEFAULT 0
    CHECK (reserved_micros BETWEEN 0 AND 9007199254740991),
  active_jobs INTEGER NOT NULL DEFAULT 0
    CHECK (active_jobs BETWEEN 0 AND 128),
  month_key TEXT NOT NULL
    CHECK (
      length(month_key) = 7
      AND substr(month_key, 5, 1) = '-'
      AND CAST(substr(month_key, 1, 4) AS INTEGER) BETWEEN 2000 AND 9999
      AND CAST(substr(month_key, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    ),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (spent_micros + reserved_micros <= monthly_cost_limit_micros),
  CHECK (active_jobs <= maximum_concurrent_jobs),
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS fine_tuning_model_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL
    REFERENCES fine_tuning_datasets(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL UNIQUE
    REFERENCES fine_tuning_jobs(id) ON DELETE RESTRICT,
  base_model_provider_id TEXT NOT NULL
    CHECK (length(base_model_provider_id) BETWEEN 1 AND 96),
  base_model_id TEXT NOT NULL
    CHECK (length(base_model_id) BETWEEN 1 AND 256),
  base_model_revision TEXT NOT NULL
    CHECK (length(base_model_revision) BETWEEN 1 AND 256),
  artifact_digest TEXT NOT NULL
    CHECK (
      length(artifact_digest) = 64
      AND artifact_digest = lower(artifact_digest)
      AND artifact_digest NOT GLOB '*[^0-9a-f]*'
    ),
  local_artifact_ref TEXT NOT NULL
    CHECK (
      length(local_artifact_ref) BETWEEN 1 AND 256
      AND local_artifact_ref NOT LIKE '%/%'
      AND local_artifact_ref NOT LIKE '%\%'
    ),
  state TEXT NOT NULL
    CHECK (
      state IN (
        'candidate',
        'evaluation_failed',
        'evaluation_passed',
        'registration_approved',
        'registered',
        'deployment_approved',
        'deployed',
        'rolled_back',
        'revoked'
      )
    ),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  latest_evaluation_id TEXT,
  registration_name TEXT
    CHECK (
      registration_name IS NULL
      OR (
        length(registration_name) BETWEEN 1 AND 200
        AND instr(registration_name, char(0)) = 0
      )
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
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS fine_tuning_artifacts_project_state_idx
  ON fine_tuning_model_artifacts (project_id, state, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS fine_tuning_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL
    REFERENCES fine_tuning_datasets(id) ON DELETE RESTRICT,
  dataset_revision INTEGER NOT NULL
    CHECK (dataset_revision BETWEEN 1 AND 9007199254740991),
  dataset_manifest_hash TEXT NOT NULL
    CHECK (
      length(dataset_manifest_hash) = 64
      AND dataset_manifest_hash = lower(dataset_manifest_hash)
      AND dataset_manifest_hash NOT GLOB '*[^0-9a-f]*'
    ),
  dataset_approval_id TEXT NOT NULL
    REFERENCES fine_tuning_approvals(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash = lower(request_hash)
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  plan_hash TEXT NOT NULL
    CHECK (
      length(plan_hash) = 64
      AND plan_hash = lower(plan_hash)
      AND plan_hash NOT GLOB '*[^0-9a-f]*'
    ),
  plan_json TEXT NOT NULL
    CHECK (
      json_valid(plan_json)
      AND json_type(plan_json) = 'object'
      AND length(plan_json) BETWEEN 2 AND 1000000
      AND json_extract(plan_json, '$.provider.location') = 'local'
      AND json_type(plan_json, '$.content') IS NULL
      AND json_type(plan_json, '$.sourceText') IS NULL
      AND json_type(plan_json, '$.credential') IS NULL
      AND json_type(plan_json, '$.secret') IS NULL
    ),
  provider_location TEXT NOT NULL
    CHECK (provider_location = 'local'),
  provider_id TEXT NOT NULL
    CHECK (length(provider_id) BETWEEN 1 AND 96),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'queued',
        'running',
        'cancelling',
        'cancelled',
        'failed_retryable',
        'failed_final',
        'artifact_ready'
      )
    ),
  revision INTEGER NOT NULL
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  attempt_count INTEGER NOT NULL
    CHECK (attempt_count BETWEEN 0 AND 100),
  maximum_attempts INTEGER NOT NULL
    CHECK (maximum_attempts BETWEEN 1 AND 100),
  cancellation_requested INTEGER NOT NULL DEFAULT 0
    CHECK (cancellation_requested IN (0, 1)),
  lease_owner TEXT,
  lease_expires_at TEXT
    CHECK (
      lease_expires_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) = lease_expires_at
    ),
  reserved_cost_micros INTEGER NOT NULL
    CHECK (reserved_cost_micros BETWEEN 0 AND 9007199254740991),
  settled_cost_micros INTEGER
    CHECK (settled_cost_micros BETWEEN 0 AND 9007199254740991),
  cost_source TEXT
    CHECK (
      cost_source IS NULL
      OR cost_source IN ('local_resource_estimate', 'provider_reported')
    ),
  currency TEXT NOT NULL
    CHECK (
      length(currency) = 3
      AND currency = upper(currency)
      AND currency GLOB '[A-Z][A-Z][A-Z]'
    ),
  month_key TEXT NOT NULL
    CHECK (length(month_key) = 7 AND substr(month_key, 5, 1) = '-'),
  artifact_id TEXT
    REFERENCES fine_tuning_model_artifacts(id) ON DELETE RESTRICT,
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR (
        length(failure_code) BETWEEN 3 AND 128
        AND failure_code = upper(failure_code)
        AND failure_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
  created_by TEXT NOT NULL
    CHECK (length(created_by) BETWEEN 1 AND 96),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (attempt_count <= maximum_attempts),
  CHECK (updated_at >= created_at),
  CHECK (
    (
      status IN ('running', 'cancelling')
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND started_at IS NOT NULL
      AND completed_at IS NULL
    )
    OR (
      status NOT IN ('running', 'cancelling')
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CHECK (
    (status = 'artifact_ready' AND artifact_id IS NOT NULL)
    OR (status <> 'artifact_ready' AND artifact_id IS NULL)
  ),
  CHECK (
    (
      status IN ('cancelled', 'failed_retryable', 'failed_final', 'artifact_ready')
      AND completed_at IS NOT NULL
    )
    OR (
      status IN ('queued', 'running', 'cancelling')
      AND completed_at IS NULL
    )
  ),
  CHECK (
    (
      status IN ('failed_retryable', 'failed_final')
      AND failure_code IS NOT NULL
    )
    OR (
      status NOT IN ('failed_retryable', 'failed_final')
      AND failure_code IS NULL
    )
  ),
  CHECK (
    (cost_source IS NULL AND settled_cost_micros IS NULL)
    OR (cost_source IS NOT NULL AND settled_cost_micros IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS fine_tuning_jobs_recovery_idx
  ON fine_tuning_jobs (status, lease_expires_at, created_at, id)
  WHERE status IN ('queued', 'running', 'cancelling', 'failed_retryable');

CREATE INDEX IF NOT EXISTS fine_tuning_jobs_project_history_idx
  ON fine_tuning_jobs (project_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS fine_tuning_evaluations (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL
    REFERENCES fine_tuning_model_artifacts(id) ON DELETE RESTRICT,
  baseline_model_id TEXT NOT NULL
    CHECK (length(baseline_model_id) BETWEEN 1 AND 256),
  evaluator_id TEXT NOT NULL
    CHECK (length(evaluator_id) BETWEEN 1 AND 96),
  evaluator_version TEXT NOT NULL
    CHECK (length(evaluator_version) BETWEEN 1 AND 256),
  authority_hash TEXT NOT NULL
    CHECK (
      length(authority_hash) = 64
      AND authority_hash = lower(authority_hash)
      AND authority_hash NOT GLOB '*[^0-9a-f]*'
    ),
  baseline_metrics_json TEXT NOT NULL
    CHECK (json_valid(baseline_metrics_json) AND json_type(baseline_metrics_json) = 'array'),
  candidate_metrics_json TEXT NOT NULL
    CHECK (json_valid(candidate_metrics_json) AND json_type(candidate_metrics_json) = 'array'),
  rules_json TEXT NOT NULL
    CHECK (json_valid(rules_json) AND json_type(rules_json) = 'array'),
  observations_json TEXT NOT NULL
    CHECK (json_valid(observations_json) AND json_type(observations_json) = 'array'),
  passed INTEGER NOT NULL
    CHECK (passed IN (0, 1)),
  created_by TEXT NOT NULL
    CHECK (length(created_by) BETWEEN 1 AND 96),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  UNIQUE (artifact_id, authority_hash)
);

CREATE INDEX IF NOT EXISTS fine_tuning_evaluations_artifact_idx
  ON fine_tuning_evaluations (artifact_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS fine_tuning_deployments (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL
    REFERENCES fine_tuning_model_artifacts(id) ON DELETE RESTRICT,
  target_role TEXT NOT NULL
    CHECK (target_role IN ('local_private', 'fast', 'high_quality', 'validation')),
  previous_deployment_id TEXT
    REFERENCES fine_tuning_deployments(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL
    REFERENCES fine_tuning_approvals(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'rolled_back', 'revoked')),
  provider_receipt_digest TEXT NOT NULL
    CHECK (
      length(provider_receipt_digest) = 64
      AND provider_receipt_digest = lower(provider_receipt_digest)
      AND provider_receipt_digest NOT GLOB '*[^0-9a-f]*'
    ),
  activated_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) = activated_at),
  ended_at TEXT
    CHECK (
      ended_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', ended_at) = ended_at
    ),
  CHECK (
    (status = 'active' AND ended_at IS NULL)
    OR (status <> 'active' AND ended_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS fine_tuning_deployments_active_role_unique
  ON fine_tuning_deployments (project_id, target_role)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS fine_tuning_deployments_history_idx
  ON fine_tuning_deployments (project_id, target_role, activated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS fine_tuning_operation_claims (
  idempotency_key TEXT PRIMARY KEY NOT NULL
    CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  operation TEXT NOT NULL
    CHECK (
      operation IN (
        'dataset_create',
        'dataset_approve',
        'policy_configure',
        'job_queue',
        'job_claim',
        'job_cancel',
        'job_complete',
        'job_fail',
        'job_recover',
        'evaluation_record',
        'registration_approve',
        'artifact_register',
        'deployment_approve',
        'deployment_activate',
        'deployment_rollback',
        'artifact_revoke'
      )
    ),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash = lower(request_hash)
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  result_entity_type TEXT NOT NULL
    CHECK (
      result_entity_type IN (
        'dataset',
        'policy',
        'job',
        'artifact',
        'evaluation',
        'deployment'
      )
    ),
  result_entity_id TEXT NOT NULL
    CHECK (length(result_entity_id) BETWEEN 1 AND 256),
  result_revision INTEGER NOT NULL
    CHECK (result_revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE INDEX IF NOT EXISTS fine_tuning_claims_result_idx
  ON fine_tuning_operation_claims (result_entity_type, result_entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fine_tuning_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL
    CHECK (
      entity_type IN (
        'dataset',
        'policy',
        'job',
        'artifact',
        'evaluation',
        'deployment'
      )
    ),
  entity_id TEXT NOT NULL
    CHECK (length(entity_id) BETWEEN 1 AND 256),
  action TEXT NOT NULL
    CHECK (
      action IN (
        'dataset_created',
        'dataset_approved',
        'policy_configured',
        'job_queued',
        'job_claimed',
        'job_cancel_requested',
        'job_cancelled',
        'job_failed',
        'job_recovered',
        'artifact_created',
        'evaluation_passed',
        'evaluation_failed',
        'registration_approved',
        'artifact_registered',
        'deployment_approved',
        'deployment_activated',
        'deployment_rolled_back',
        'artifact_revoked'
      )
    ),
  actor_id TEXT NOT NULL
    CHECK (length(actor_id) BETWEEN 1 AND 96),
  request_id TEXT NOT NULL
    CHECK (length(request_id) BETWEEN 1 AND 256),
  correlation_id TEXT NOT NULL
    CHECK (length(correlation_id) BETWEEN 1 AND 256),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      json_valid(metadata_json)
      AND json_type(metadata_json) = 'object'
      AND length(metadata_json) <= 16384
      AND json_type(metadata_json, '$.content') IS NULL
      AND json_type(metadata_json, '$.sourceText') IS NULL
      AND json_type(metadata_json, '$.prompt') IS NULL
      AND json_type(metadata_json, '$.messages') IS NULL
      AND json_type(metadata_json, '$.key') IS NULL
      AND json_type(metadata_json, '$.secret') IS NULL
      AND json_type(metadata_json, '$.credential') IS NULL
    ),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE INDEX IF NOT EXISTS fine_tuning_audit_entity_idx
  ON fine_tuning_audit_events (entity_type, entity_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS fine_tuning_dataset_authority_immutable
BEFORE UPDATE ON fine_tuning_datasets
WHEN
  NEW.project_id <> OLD.project_id
  OR NEW.name <> OLD.name
  OR NEW.manifest_hash <> OLD.manifest_hash
  OR NEW.manifest_json <> OLD.manifest_json
  OR NEW.total_content_bytes <> OLD.total_content_bytes
  OR NEW.included_sample_count <> OLD.included_sample_count
  OR NEW.duplicate_sample_count <> OLD.duplicate_sample_count
  OR NEW.train_sample_count <> OLD.train_sample_count
  OR NEW.validation_sample_count <> OLD.validation_sample_count
  OR NEW.test_sample_count <> OLD.test_sample_count
  OR NEW.readiness_issues_json <> OLD.readiness_issues_json
  OR NEW.created_by <> OLD.created_by
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'fine-tuning dataset authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_sample_immutable
BEFORE UPDATE ON fine_tuning_samples
BEGIN
  SELECT RAISE(ABORT, 'fine-tuning samples are immutable');
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_approval_append_only
BEFORE UPDATE ON fine_tuning_approvals
BEGIN
  SELECT RAISE(ABORT, 'fine-tuning approvals are append-only');
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_evaluation_append_only
BEFORE UPDATE ON fine_tuning_evaluations
BEGIN
  SELECT RAISE(ABORT, 'fine-tuning evaluations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_claim_append_only
BEFORE UPDATE ON fine_tuning_operation_claims
BEGIN
  SELECT RAISE(ABORT, 'fine-tuning idempotency claims are append-only');
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_audit_append_only
BEFORE UPDATE ON fine_tuning_audit_events
BEGIN
  SELECT RAISE(ABORT, 'fine-tuning audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_job_authority_immutable
BEFORE UPDATE ON fine_tuning_jobs
WHEN
  NEW.project_id <> OLD.project_id
  OR NEW.dataset_id <> OLD.dataset_id
  OR NEW.dataset_revision <> OLD.dataset_revision
  OR NEW.dataset_manifest_hash <> OLD.dataset_manifest_hash
  OR NEW.dataset_approval_id <> OLD.dataset_approval_id
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.request_hash <> OLD.request_hash
  OR NEW.plan_hash <> OLD.plan_hash
  OR NEW.plan_json <> OLD.plan_json
  OR NEW.provider_location <> OLD.provider_location
  OR NEW.provider_id <> OLD.provider_id
  OR NEW.maximum_attempts <> OLD.maximum_attempts
  OR NEW.reserved_cost_micros <> OLD.reserved_cost_micros
  OR NEW.currency <> OLD.currency
  OR NEW.month_key <> OLD.month_key
  OR NEW.created_by <> OLD.created_by
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'fine-tuning job authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_artifact_authority_immutable
BEFORE UPDATE ON fine_tuning_model_artifacts
WHEN
  NEW.project_id <> OLD.project_id
  OR NEW.dataset_id <> OLD.dataset_id
  OR NEW.job_id <> OLD.job_id
  OR NEW.base_model_provider_id <> OLD.base_model_provider_id
  OR NEW.base_model_id <> OLD.base_model_id
  OR NEW.base_model_revision <> OLD.base_model_revision
  OR NEW.artifact_digest <> OLD.artifact_digest
  OR NEW.local_artifact_ref <> OLD.local_artifact_ref
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'fine-tuning artifact authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_job_insert_authority
BEFORE INSERT ON fine_tuning_jobs
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM fine_tuning_datasets AS dataset
      INNER JOIN fine_tuning_approvals AS approval
        ON approval.id = NEW.dataset_approval_id
      WHERE dataset.id = NEW.dataset_id
        AND dataset.project_id = NEW.project_id
        AND dataset.state = 'approved'
        AND dataset.revision = NEW.dataset_revision
        AND dataset.manifest_hash = NEW.dataset_manifest_hash
        AND approval.project_id = NEW.project_id
        AND approval.kind = 'dataset_training'
        AND approval.entity_type = 'dataset'
        AND approval.entity_id = NEW.dataset_id
        AND approval.entity_revision = NEW.dataset_revision - 1
        AND approval.authority_hash = NEW.dataset_manifest_hash
    )
    THEN RAISE(ABORT, 'fine-tuning job dataset approval mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_evaluation_authority
BEFORE INSERT ON fine_tuning_evaluations
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM fine_tuning_model_artifacts AS artifact
      WHERE artifact.id = NEW.artifact_id
        AND artifact.project_id = NEW.project_id
        AND artifact.state IN (
          'candidate',
          'evaluation_failed',
          'evaluation_passed'
        )
    )
    THEN RAISE(ABORT, 'fine-tuning evaluation artifact mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_artifact_job_authority
BEFORE INSERT ON fine_tuning_model_artifacts
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM fine_tuning_jobs AS job
      WHERE job.id = NEW.job_id
        AND job.project_id = NEW.project_id
        AND job.dataset_id = NEW.dataset_id
        AND job.status = 'running'
        AND job.artifact_id IS NULL
        AND json_extract(job.plan_json, '$.baseModel.providerId') =
          NEW.base_model_provider_id
        AND json_extract(job.plan_json, '$.baseModel.modelId') =
          NEW.base_model_id
        AND json_extract(job.plan_json, '$.baseModel.revision') =
          NEW.base_model_revision
    )
    THEN RAISE(ABORT, 'fine-tuning artifact job authority mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS fine_tuning_deployment_authority
BEFORE INSERT ON fine_tuning_deployments
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM fine_tuning_model_artifacts AS artifact
      INNER JOIN fine_tuning_approvals AS approval
        ON approval.id = NEW.approval_id
      WHERE artifact.id = NEW.artifact_id
        AND artifact.project_id = NEW.project_id
        AND artifact.state = 'deployment_approved'
        AND approval.project_id = NEW.project_id
        AND approval.kind = 'model_deployment'
        AND approval.entity_type = 'artifact'
        AND approval.entity_id = NEW.artifact_id
        AND approval.entity_revision = artifact.revision - 1
        AND json_extract(approval.declarations_json, '$.humanConfirmed') = 1
        AND json_extract(approval.declarations_json, '$.targetRole') =
          NEW.target_role
    )
    THEN RAISE(ABORT, 'fine-tuning deployment approval mismatch')
  END;
END;
