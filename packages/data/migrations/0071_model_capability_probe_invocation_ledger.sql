-- Every real model dispatch must appear in the ordinary invocation ledger.
-- Capability probes are not writing tasks, so give them their own immutable
-- task identity instead of pretending they are book-start generations.
--
-- SQLite cannot alter the published task CHECK in place. The native migration
-- runner executes Tauri migration 74 with foreign keys disabled, then restores
-- them and runs foreign_key_check before opening the application.

PRAGMA foreign_keys = OFF;

CREATE TEMP TABLE _inkshadow_0071_invocation_count (
  before_count INTEGER NOT NULL
);

INSERT INTO _inkshadow_0071_invocation_count (before_count)
SELECT COUNT(*) FROM model_invocation_facts;

CREATE TABLE model_invocation_facts_0071_new (
  id TEXT PRIMARY KEY NOT NULL,
  task TEXT NOT NULL
    CHECK (
      task IN (
        'idea_discussion',
        'book_start_guidance',
        'prose_generation',
        'continuation',
        'rewrite',
        'polish',
        'outline_planning',
        'scene_breakdown',
        'chapter_summary',
        'long_memory_compression',
        'character_extraction',
        'world_extraction',
        'contradiction_check',
        'pov_check',
        'character_voice_check',
        'content_quality_check',
        'what_if_simulation',
        'embedding',
        'rerank',
        'image_generation',
        'vision_understanding',
        'translation',
        'capability_probe'
      )
    ),
  route_task TEXT
    REFERENCES novel_task_routes(task) ON DELETE SET NULL,
  connection_id TEXT NOT NULL
    REFERENCES model_provider_connections(id) ON DELETE RESTRICT,
  catalog_entry_id TEXT
    REFERENCES model_catalog_entries(id) ON DELETE SET NULL,
  provider_kind_snapshot TEXT NOT NULL,
  model_id_snapshot TEXT NOT NULL,
  route_reason TEXT NOT NULL
    CHECK (route_reason IN ('task_primary', 'task_fallback', 'user_override', 'legacy')),
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 100),
  fallback_from_invocation_id TEXT
    REFERENCES model_invocation_facts(id) ON DELETE SET NULL,
  privacy_policy TEXT NOT NULL
    CHECK (privacy_policy IN ('cloud_allowed', 'local_preferred', 'local_only')),
  data_destination TEXT NOT NULL
    CHECK (data_destination IN ('local', 'remote')),
  maximum_cost_micros TEXT,
  currency TEXT,
  input_tokens INTEGER
    CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 1000000000),
  output_tokens INTEGER
    CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 1000000000),
  cached_input_tokens INTEGER
    CHECK (cached_input_tokens IS NULL OR cached_input_tokens BETWEEN 0 AND 1000000000),
  estimated_cost_micros TEXT,
  error_code TEXT,
  error_summary TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  diagnostic_request_id TEXT
    CHECK (
      diagnostic_request_id IS NULL
      OR (
        length(diagnostic_request_id) BETWEEN 8 AND 128
        AND diagnostic_request_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
      )
    ),
  failure_stage TEXT
    CHECK (
      failure_stage IS NULL
      OR failure_stage IN (
        'request_preparation',
        'dispatch',
        'transport',
        'http_response',
        'stream_parse',
        'response_normalization',
        'capability_commit',
        'invocation_commit',
        'unknown'
      )
    ),
  failure_retryable INTEGER
    CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1)),
  http_status INTEGER
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  finish_reason TEXT
    CHECK (
      finish_reason IS NULL
      OR (
        length(finish_reason) BETWEEN 1 AND 64
        AND substr(finish_reason, 1, 1) GLOB '[a-z]'
        AND finish_reason NOT GLOB '*[^a-z0-9_.-]*'
      )
    ),
  visible_content_length INTEGER
    CHECK (
      visible_content_length IS NULL
      OR visible_content_length BETWEEN 0 AND 1000000000
    ),
  reasoning_present INTEGER
    CHECK (reasoning_present IS NULL OR reasoning_present IN (0, 1)),
  streamed INTEGER
    CHECK (streamed IS NULL OR streamed IN (0, 1)),
  requested_max_output_tokens INTEGER
    CHECK (
      requested_max_output_tokens IS NULL
      OR requested_max_output_tokens BETWEEN 1 AND 1000000000
    ),
  provider_dispatch_started_at TEXT,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(provider_kind_snapshot) BETWEEN 1 AND 128),
  CHECK (length(model_id_snapshot) BETWEEN 1 AND 512),
  CHECK (
    maximum_cost_micros IS NULL
    OR (
      length(maximum_cost_micros) BETWEEN 1 AND 19
      AND maximum_cost_micros NOT GLOB '*[^0-9]*'
    )
  ),
  CHECK (
    estimated_cost_micros IS NULL
    OR (
      length(estimated_cost_micros) BETWEEN 1 AND 19
      AND estimated_cost_micros NOT GLOB '*[^0-9]*'
    )
  ),
  CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  CHECK (error_summary IS NULL OR length(error_summary) BETWEEN 1 AND 1000),
  CHECK (cached_input_tokens IS NULL OR input_tokens IS NULL OR cached_input_tokens <= input_tokens),
  CHECK ((maximum_cost_micros IS NULL AND estimated_cost_micros IS NULL) OR currency IS NOT NULL),
  CHECK ((status = 'queued') = (started_at IS NULL)),
  CHECK ((status IN ('succeeded', 'failed', 'cancelled', 'timed_out')) = (completed_at IS NOT NULL)),
  CHECK (
    (status IN ('failed', 'timed_out') AND error_code IS NOT NULL)
    OR (status NOT IN ('failed', 'timed_out') AND error_code IS NULL)
  ),
  CHECK (privacy_policy <> 'local_only' OR data_destination = 'local')
);

INSERT INTO model_invocation_facts_0071_new (
  id, task, route_task, connection_id, catalog_entry_id,
  provider_kind_snapshot, model_id_snapshot, route_reason, status, attempt,
  fallback_from_invocation_id, privacy_policy, data_destination,
  maximum_cost_micros, currency, input_tokens, output_tokens,
  cached_input_tokens, estimated_cost_micros, error_code, error_summary,
  started_at, completed_at, created_at, revision, diagnostic_request_id,
  failure_stage, failure_retryable, http_status, finish_reason,
  visible_content_length, reasoning_present, streamed,
  requested_max_output_tokens, provider_dispatch_started_at
)
SELECT
  id, task, route_task, connection_id, catalog_entry_id,
  provider_kind_snapshot, model_id_snapshot, route_reason, status, attempt,
  fallback_from_invocation_id, privacy_policy, data_destination,
  maximum_cost_micros, currency, input_tokens, output_tokens,
  cached_input_tokens, estimated_cost_micros, error_code, error_summary,
  started_at, completed_at, created_at, revision, diagnostic_request_id,
  failure_stage, failure_retryable, http_status, finish_reason,
  visible_content_length, reasoning_present, streamed,
  requested_max_output_tokens, provider_dispatch_started_at
FROM model_invocation_facts;

CREATE TEMP TABLE _inkshadow_0071_invocation_count_guard (
  before_count INTEGER NOT NULL,
  after_count INTEGER NOT NULL,
  CHECK (before_count = after_count)
);

INSERT INTO _inkshadow_0071_invocation_count_guard (before_count, after_count)
SELECT before_count, (SELECT COUNT(*) FROM model_invocation_facts_0071_new)
FROM _inkshadow_0071_invocation_count;

-- These triggers belong to the rebuilt table and must be restored verbatim.
DROP TRIGGER IF EXISTS novel_skill_evaluation_invocation_update_guard;
DROP TRIGGER IF EXISTS novel_skill_paid_settled_invocation_update_guard;
DROP TRIGGER IF EXISTS novel_skill_paid_settled_invocation_delete_guard;
DROP TRIGGER IF EXISTS consistency_investigation_invocation_start_guard;
DROP TRIGGER IF EXISTS consistency_investigation_invocation_bind_after_start;

-- Keep triggers on other tables byte-for-byte intact while the authoritative
-- ledger name is momentarily absent. The five triggers owned by the rebuilt
-- table were dropped above and are recreated below.
PRAGMA legacy_alter_table = ON;
DROP TABLE model_invocation_facts;
ALTER TABLE model_invocation_facts_0071_new RENAME TO model_invocation_facts;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX model_invocation_facts_task_idx
  ON model_invocation_facts (task, created_at DESC, id ASC);

CREATE INDEX model_invocation_facts_connection_idx
  ON model_invocation_facts (connection_id, status, created_at DESC, id ASC);

CREATE INDEX model_invocation_facts_fallback_idx
  ON model_invocation_facts (fallback_from_invocation_id, attempt, id)
  WHERE fallback_from_invocation_id IS NOT NULL;

CREATE INDEX model_invocation_facts_recent_failure_idx
  ON model_invocation_facts (completed_at DESC, id ASC)
  WHERE status IN ('failed', 'timed_out') AND error_code IS NOT NULL;

CREATE TRIGGER novel_skill_evaluation_invocation_update_guard
BEFORE UPDATE ON model_invocation_facts
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations
  WHERE model_invocation_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'observed evaluation invocation is frozen'); END;

CREATE TRIGGER novel_skill_paid_settled_invocation_update_guard
BEFORE UPDATE ON model_invocation_facts
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_model_invocation_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation invocation is frozen'); END;

CREATE TRIGGER novel_skill_paid_settled_invocation_delete_guard
BEFORE DELETE ON model_invocation_facts
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_model_invocation_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation invocation cannot be deleted'); END;

CREATE TRIGGER consistency_investigation_invocation_start_guard
BEFORE INSERT ON model_invocation_facts
WHEN EXISTS (
  SELECT 1 FROM consistency_investigation_steps
  WHERE planned_invocation_id = NEW.id
)
AND NOT EXISTS (
  SELECT 1
  FROM consistency_investigation_steps AS step
  INNER JOIN consistency_investigation_runs AS run ON run.id = step.run_id
  WHERE step.planned_invocation_id = NEW.id
    AND step.step_kind = 'model'
    AND step.status = 'bound'
    AND run.status = 'planned'
    AND NEW.task = 'contradiction_check'
)
BEGIN
  SELECT RAISE(ABORT, 'consistency investigation invocation reservation is no longer active');
END;

CREATE TRIGGER consistency_investigation_invocation_bind_after_start
AFTER INSERT ON model_invocation_facts
WHEN NEW.task = 'contradiction_check'
AND EXISTS (
  SELECT 1 FROM consistency_investigation_steps
  WHERE planned_invocation_id = NEW.id AND status = 'bound'
)
BEGIN
  UPDATE consistency_investigation_steps
  SET invocation_id = NEW.id
  WHERE planned_invocation_id = NEW.id
    AND step_kind = 'model'
    AND status = 'bound'
    AND invocation_id IS NULL;

  INSERT INTO context_compilation_model_invocation_links (
    trace_id, model_invocation_id, linked_at
  )
  SELECT run.context_trace_id, NEW.id, run.updated_at
  FROM consistency_investigation_steps AS step
  INNER JOIN consistency_investigation_runs AS run ON run.id = step.run_id
  WHERE step.planned_invocation_id = NEW.id
    AND run.context_trace_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM context_compilation_model_invocation_links AS link
      WHERE link.trace_id = run.context_trace_id
         OR link.model_invocation_id = NEW.id
    );
END;

ALTER TABLE model_capability_scans
  ADD COLUMN model_invocation_id TEXT
    REFERENCES model_invocation_facts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX model_capability_scans_invocation_idx
  ON model_capability_scans (model_invocation_id)
  WHERE model_invocation_id IS NOT NULL;

CREATE TRIGGER model_capability_scans_invocation_insert_guard
BEFORE INSERT ON model_capability_scans
WHEN NEW.model_invocation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM model_invocation_facts AS invocation
    WHERE invocation.id = NEW.model_invocation_id
      AND invocation.task = 'capability_probe'
      AND invocation.catalog_entry_id = NEW.catalog_entry_id
      AND (
        (NEW.status IN ('succeeded', 'partial') AND invocation.status = 'succeeded')
        OR (
          NEW.status = 'failed'
          AND invocation.status IN ('failed', 'cancelled')
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'capability scan requires its exact terminal probe invocation');
END;

CREATE TRIGGER model_capability_scans_invocation_update_guard
BEFORE UPDATE OF model_invocation_id, catalog_entry_id ON model_capability_scans
WHEN NEW.model_invocation_id IS NOT OLD.model_invocation_id
  OR NEW.catalog_entry_id <> OLD.catalog_entry_id
BEGIN
  SELECT RAISE(ABORT, 'capability scan invocation authority is immutable');
END;

DROP TABLE _inkshadow_0071_invocation_count_guard;
DROP TABLE _inkshadow_0071_invocation_count;

PRAGMA foreign_keys = ON;
