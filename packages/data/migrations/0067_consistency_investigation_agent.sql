PRAGMA foreign_keys = ON;

-- Durable, content-free coordination for the first production Agent task.
-- Scheduling remains authoritative in background_tasks, provider usage remains
-- authoritative in model_invocation_facts, and chapter changes remain isolated
-- in ai_candidates. These tables only retain bounded Agent state and findings.
CREATE TABLE IF NOT EXISTS consistency_investigation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL UNIQUE
    REFERENCES background_tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  restart_of_run_id TEXT
    REFERENCES consistency_investigation_runs(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN (
      'planned', 'dispatched', 'observing', 'verifying', 'succeeded',
      'partial', 'failed', 'cancelled', 'not_dispatched', 'ambiguous'
    )),
  chapter_count INTEGER NOT NULL CHECK (chapter_count BETWEEN 1 AND 100000),
  maximum_model_calls INTEGER NOT NULL CHECK (maximum_model_calls = 1),
  maximum_tool_steps INTEGER NOT NULL CHECK (maximum_tool_steps = 5),
  maximum_context_characters INTEGER NOT NULL
    CHECK (maximum_context_characters BETWEEN 1000 AND 2000000),
  maximum_output_tokens INTEGER NOT NULL
    CHECK (maximum_output_tokens BETWEEN 1 AND 100000),
  maximum_duration_ms INTEGER NOT NULL
    CHECK (maximum_duration_ms BETWEEN 1000 AND 900000),
  automatic_retry_count INTEGER NOT NULL CHECK (automatic_retry_count = 0),
  estimated_input_tokens INTEGER NOT NULL
    CHECK (estimated_input_tokens BETWEEN 1 AND 10000000),
  estimated_maximum_cost_micros TEXT,
  currency TEXT,
  connection_id TEXT NOT NULL
    REFERENCES model_provider_connections(id) ON DELETE RESTRICT,
  catalog_entry_id TEXT NOT NULL
    REFERENCES model_catalog_entries(id) ON DELETE RESTRICT,
  provider_kind_snapshot TEXT NOT NULL,
  model_id_snapshot TEXT NOT NULL,
  privacy_fingerprint TEXT NOT NULL,
  context_trace_id TEXT UNIQUE
    REFERENCES context_compilation_runs(id) ON DELETE RESTRICT,
  generation_id TEXT NOT NULL UNIQUE,
  summary TEXT,
  finding_count INTEGER NOT NULL DEFAULT 0
    CHECK (finding_count BETWEEN 0 AND 10000),
  dropped_finding_count INTEGER NOT NULL DEFAULT 0
    CHECK (dropped_finding_count BETWEEN 0 AND 10000),
  cancellation_requested INTEGER NOT NULL DEFAULT 0
    CHECK (cancellation_requested IN (0, 1)),
  failure_code TEXT,
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (project_id, idempotency_key),
  CHECK (length(id) = 36 AND substr(id, 15, 1) = '7'),
  CHECK (length(task_id) = 36 AND substr(task_id, 15, 1) = '7'),
  CHECK (length(generation_id) = 36 AND substr(generation_id, 15, 1) = '7'),
  CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  CHECK (length(request_fingerprint) = 64 AND request_fingerprint = lower(request_fingerprint)),
  CHECK (length(privacy_fingerprint) = 64 AND privacy_fingerprint = lower(privacy_fingerprint)),
  CHECK (request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK (privacy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(provider_kind_snapshot) BETWEEN 1 AND 128),
  CHECK (length(model_id_snapshot) BETWEEN 1 AND 512),
  CHECK (
    estimated_maximum_cost_micros IS NULL
    OR (
      length(estimated_maximum_cost_micros) BETWEEN 1 AND 19
      AND estimated_maximum_cost_micros NOT GLOB '*[^0-9]*'
    )
  ),
  CHECK (
    (estimated_maximum_cost_micros IS NULL AND currency IS NULL)
    OR (estimated_maximum_cost_micros IS NOT NULL AND length(currency) = 3 AND currency = upper(currency))
  ),
  CHECK (summary IS NULL OR (length(summary) BETWEEN 1 AND 12000 AND instr(summary, char(0)) = 0)),
  CHECK (
    failure_code IS NULL
    OR (
      length(failure_code) BETWEEN 2 AND 128
      AND failure_code = upper(failure_code)
      AND failure_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (
    completed_at IS NULL
    OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
  ),
  CHECK (updated_at >= created_at),
  CHECK (
    (status IN ('planned', 'dispatched', 'observing', 'verifying') AND completed_at IS NULL)
    OR (status IN ('succeeded', 'partial', 'failed', 'cancelled', 'not_dispatched', 'ambiguous') AND completed_at IS NOT NULL)
  ),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK (status <> 'cancelled' OR cancellation_requested = 1),
  CHECK (status NOT IN ('succeeded', 'partial') OR summary IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS consistency_investigation_runs_project_idx
  ON consistency_investigation_runs (project_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS consistency_investigation_runs_recovery_idx
  ON consistency_investigation_runs (status, updated_at, id)
  WHERE status IN ('planned', 'dispatched', 'observing', 'verifying');

CREATE TABLE IF NOT EXISTS consistency_investigation_steps (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL
    REFERENCES consistency_investigation_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 7),
  step_kind TEXT NOT NULL CHECK (step_kind IN ('local_tool', 'model', 'verifier')),
  tool_name TEXT NOT NULL CHECK (tool_name IN (
    'read_story_memory', 'search_fts', 'inspect_fact', 'inspect_causal',
    'validate_evidence', 'model_synthesis', 'verify_findings'
  )),
  tool_version TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('local_read_only', 'model_dispatch', 'local_verify')),
  input_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'bound', 'dispatched', 'succeeded', 'failed',
    'cancelled', 'not_dispatched', 'ambiguous'
  )),
  invocation_id TEXT UNIQUE
    REFERENCES model_invocation_facts(id) ON DELETE RESTRICT,
  observation_digest TEXT,
  terminal_cause TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, tool_name),
  CHECK (length(id) = 36 AND substr(id, 15, 1) = '7'),
  CHECK (length(tool_version) BETWEEN 1 AND 64),
  CHECK (length(input_digest) = 64 AND input_digest = lower(input_digest)),
  CHECK (input_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (
    observation_digest IS NULL
    OR (
      length(observation_digest) = 64
      AND observation_digest = lower(observation_digest)
      AND observation_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    terminal_cause IS NULL
    OR (
      length(terminal_cause) BETWEEN 2 AND 128
      AND terminal_cause = upper(terminal_cause)
      AND terminal_cause NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (
    completed_at IS NULL
    OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
  ),
  CHECK (
    (status IN ('reserved', 'bound', 'dispatched') AND completed_at IS NULL)
    OR (status IN ('succeeded', 'failed', 'cancelled', 'not_dispatched', 'ambiguous') AND completed_at IS NOT NULL)
  ),
  CHECK ((step_kind = 'model') = (permission = 'model_dispatch')),
  CHECK ((step_kind = 'model') = (tool_name = 'model_synthesis')),
  CHECK (step_kind = 'model' OR invocation_id IS NULL),
  CHECK (status NOT IN ('succeeded', 'failed', 'cancelled', 'not_dispatched', 'ambiguous') OR terminal_cause IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS consistency_investigation_steps_run_idx
  ON consistency_investigation_steps (run_id, ordinal);

CREATE TABLE IF NOT EXISTS consistency_investigation_findings (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL
    REFERENCES consistency_investigation_runs(id) ON DELETE CASCADE,
  model_step_id TEXT NOT NULL
    REFERENCES consistency_investigation_steps(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 10000),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  authority_group TEXT NOT NULL CHECK (authority_group IN ('accepted_body', 'confirmed_fact', 'mixed')),
  category TEXT NOT NULL CHECK (category IN ('character', 'location', 'timeline', 'pov', 'world', 'causal', 'other')),
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ignored', 'allowed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (run_id, ordinal),
  CHECK (length(id) = 36 AND substr(id, 15, 1) = '7'),
  CHECK (length(title) BETWEEN 1 AND 240 AND instr(title, char(0)) = 0),
  CHECK (length(explanation) BETWEEN 1 AND 12000 AND instr(explanation, char(0)) = 0),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at),
  CHECK (decided_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);

CREATE INDEX IF NOT EXISTS consistency_investigation_findings_filter_idx
  ON consistency_investigation_findings (run_id, status, severity, category, ordinal);

CREATE TABLE IF NOT EXISTS consistency_investigation_evidence (
  finding_id TEXT NOT NULL
    REFERENCES consistency_investigation_findings(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  project_id TEXT NOT NULL,
  chapter_id TEXT,
  immutable_version_id TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('chapter', 'story_fact')),
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json) AND json_type(locator_json) = 'object'),
  excerpt_digest TEXT NOT NULL,
  source_created_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  currentness TEXT NOT NULL CHECK (currentness IN ('current', 'stale')),
  branch_id TEXT,
  privacy TEXT NOT NULL CHECK (privacy IN ('standard', 'local_only')),
  PRIMARY KEY (finding_id, ordinal),
  CHECK (length(excerpt_digest) = 64 AND excerpt_digest = lower(excerpt_digest)),
  CHECK (excerpt_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', source_created_at) = source_created_at),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) = observed_at),
  CHECK (observed_at >= source_created_at),
  CHECK (
    (source_kind = 'chapter' AND chapter_id IS NOT NULL AND immutable_version_id IS NOT NULL)
    OR source_kind = 'story_fact'
  )
);

CREATE INDEX IF NOT EXISTS consistency_investigation_evidence_source_idx
  ON consistency_investigation_evidence (
    project_id, chapter_id, immutable_version_id, source_kind, finding_id, ordinal
  );

CREATE TRIGGER IF NOT EXISTS consistency_investigation_run_task_guard
BEFORE INSERT ON consistency_investigation_runs
WHEN NOT EXISTS (
  SELECT 1 FROM background_tasks AS task
  WHERE task.id = NEW.task_id
    AND task.task_type = 'consistency_investigation'
    AND json_extract(task.metadata_json, '$.operation') = 'long_form_consistency_investigation'
    AND json_extract(task.metadata_json, '$.projectId') = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation task binding mismatch');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_step_model_guard
BEFORE INSERT ON consistency_investigation_steps
WHEN NEW.invocation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM model_invocation_facts AS invocation
  WHERE invocation.id = NEW.invocation_id AND invocation.task = 'contradiction_check'
)
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation invocation mismatch');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_step_model_update_guard
BEFORE UPDATE OF invocation_id ON consistency_investigation_steps
WHEN NEW.invocation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM model_invocation_facts AS invocation
  WHERE invocation.id = NEW.invocation_id AND invocation.task = 'contradiction_check'
)
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation invocation mismatch');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_finding_step_guard
BEFORE INSERT ON consistency_investigation_findings
WHEN NOT EXISTS (
  SELECT 1 FROM consistency_investigation_steps AS step
  WHERE step.id = NEW.model_step_id
    AND step.run_id = NEW.run_id
    AND step.step_kind = 'model'
)
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation finding step mismatch');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_evidence_scope_guard
BEFORE INSERT ON consistency_investigation_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM consistency_investigation_findings AS finding
  INNER JOIN consistency_investigation_runs AS run ON run.id = finding.run_id
  WHERE finding.id = NEW.finding_id
    AND run.project_id = NEW.project_id
    AND NEW.currentness = 'current'
    AND (
      (
        NEW.source_kind = 'chapter'
        AND EXISTS (
          SELECT 1
          FROM chapters AS chapter
          INNER JOIN chapter_versions AS version
            ON version.id = NEW.immutable_version_id
           AND version.chapter_id = chapter.id
           AND version.project_id = chapter.project_id
          WHERE chapter.id = NEW.chapter_id
            AND chapter.project_id = NEW.project_id
            AND chapter.current_version_id = version.id
        )
      )
      OR (
        NEW.source_kind = 'story_fact'
        AND json_extract(NEW.locator_json, '$.kind') = 'stable'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation evidence is not current authority');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_run_identity_immutable
BEFORE UPDATE OF
  task_id, project_id, restart_of_run_id, idempotency_key, request_fingerprint,
  chapter_count, maximum_model_calls, maximum_tool_steps,
  maximum_context_characters, maximum_output_tokens, maximum_duration_ms,
  automatic_retry_count, estimated_input_tokens, estimated_maximum_cost_micros,
  currency, connection_id, catalog_entry_id, provider_kind_snapshot,
  model_id_snapshot, privacy_fingerprint, generation_id, created_at
ON consistency_investigation_runs
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation run authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_run_terminal_immutable
BEFORE UPDATE ON consistency_investigation_runs
WHEN OLD.status IN ('succeeded', 'partial', 'failed', 'cancelled', 'not_dispatched', 'ambiguous')
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation terminal run is immutable');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_step_identity_immutable
BEFORE UPDATE OF
  run_id, ordinal, step_kind, tool_name, tool_version, permission,
  input_digest, created_at
ON consistency_investigation_steps
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation step authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_step_terminal_immutable
BEFORE UPDATE ON consistency_investigation_steps
WHEN OLD.status IN ('succeeded', 'failed', 'cancelled', 'not_dispatched', 'ambiguous')
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation terminal step is immutable');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_finding_identity_immutable
BEFORE UPDATE OF
  run_id, model_step_id, ordinal, severity, authority_group, category,
  title, explanation, created_at
ON consistency_investigation_findings
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation finding authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_finding_terminal_immutable
BEFORE UPDATE ON consistency_investigation_findings
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation finding decision is immutable');
END;

CREATE TRIGGER IF NOT EXISTS consistency_investigation_evidence_immutable_update
BEFORE UPDATE ON consistency_investigation_evidence
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation evidence is immutable');
END;
