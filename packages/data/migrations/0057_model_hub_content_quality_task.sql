-- `content_quality_check` is a published Model Hub task, but the original
-- Model Hub migration omitted it from three SQLite CHECK constraints. SQLite
-- cannot alter a CHECK in place, so rebuild the affected tables without
-- changing any published row, provenance link, diagnostic column or guard.
--
-- The native migration runner disables foreign_keys before starting this
-- migration transaction and restores/checks them afterwards. These PRAGMAs
-- provide the same contract for the standalone Node SQLite migration harness.

PRAGMA foreign_keys = OFF;

CREATE TEMP TABLE _inkshadow_0057_counts (
  table_name TEXT PRIMARY KEY NOT NULL,
  before_count INTEGER NOT NULL
);

INSERT INTO _inkshadow_0057_counts (table_name, before_count)
VALUES
  ('model_evaluation_results', (SELECT COUNT(*) FROM model_evaluation_results)),
  ('novel_task_routes', (SELECT COUNT(*) FROM novel_task_routes)),
  ('model_invocation_facts', (SELECT COUNT(*) FROM model_invocation_facts));

CREATE TABLE model_evaluation_results_0057_new (
  id TEXT PRIMARY KEY NOT NULL,
  catalog_entry_id TEXT NOT NULL
    REFERENCES model_catalog_entries(id) ON DELETE CASCADE,
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
        'translation'
      )
    ),
  score_basis_points INTEGER NOT NULL
    CHECK (score_basis_points BETWEEN 0 AND 10000),
  latency_p50_ms INTEGER NOT NULL
    CHECK (latency_p50_ms BETWEEN 0 AND 86400000),
  sample_count INTEGER NOT NULL
    CHECK (sample_count BETWEEN 1 AND 1000000),
  evaluation_source TEXT NOT NULL
    CHECK (
      evaluation_source IN (
        'official_benchmark',
        'local_evaluation',
        'user_feedback',
        'imported',
        'legacy'
      )
    ),
  evaluation_version TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(evaluation_version) BETWEEN 1 AND 128),
  CHECK (expires_at IS NULL OR expires_at > observed_at),
  UNIQUE (catalog_entry_id, task, evaluation_source, evaluation_version)
);

INSERT INTO model_evaluation_results_0057_new (
  id,
  catalog_entry_id,
  task,
  score_basis_points,
  latency_p50_ms,
  sample_count,
  evaluation_source,
  evaluation_version,
  observed_at,
  expires_at
)
SELECT
  id,
  catalog_entry_id,
  task,
  score_basis_points,
  latency_p50_ms,
  sample_count,
  evaluation_source,
  evaluation_version,
  observed_at,
  expires_at
FROM model_evaluation_results;

CREATE TABLE novel_task_routes_0057_new (
  task TEXT PRIMARY KEY NOT NULL
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
        'translation'
      )
    ),
  primary_catalog_entry_id TEXT NOT NULL
    REFERENCES model_catalog_entries(id) ON DELETE RESTRICT,
  fallback_catalog_entry_id TEXT
    REFERENCES model_catalog_entries(id) ON DELETE RESTRICT,
  preset_id TEXT
    REFERENCES model_hub_presets(id) ON DELETE SET NULL,
  parameter_policy_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(parameter_policy_json) AND length(parameter_policy_json) <= 16000),
  maximum_cost_micros TEXT
    CHECK (
      maximum_cost_micros IS NULL
      OR (
        length(maximum_cost_micros) BETWEEN 1 AND 19
        AND maximum_cost_micros NOT GLOB '*[^0-9]*'
      )
    ),
  currency TEXT
    CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  privacy_policy TEXT NOT NULL
    CHECK (privacy_policy IN ('cloud_allowed', 'local_preferred', 'local_only')),
  failure_policy TEXT NOT NULL
    CHECK (failure_policy IN ('use_fallback', 'ask_user', 'stop')),
  route_origin TEXT NOT NULL
    CHECK (route_origin IN ('automatic', 'user', 'legacy')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    fallback_catalog_entry_id IS NULL
    OR fallback_catalog_entry_id <> primary_catalog_entry_id
  ),
  CHECK (failure_policy <> 'use_fallback' OR fallback_catalog_entry_id IS NOT NULL),
  CHECK ((maximum_cost_micros IS NULL) = (currency IS NULL))
);

INSERT INTO novel_task_routes_0057_new (
  task,
  primary_catalog_entry_id,
  fallback_catalog_entry_id,
  preset_id,
  parameter_policy_json,
  maximum_cost_micros,
  currency,
  privacy_policy,
  failure_policy,
  route_origin,
  enabled,
  revision,
  created_at,
  updated_at
)
SELECT
  task,
  primary_catalog_entry_id,
  fallback_catalog_entry_id,
  preset_id,
  parameter_policy_json,
  maximum_cost_micros,
  currency,
  privacy_policy,
  failure_policy,
  route_origin,
  enabled,
  revision,
  created_at,
  updated_at
FROM novel_task_routes;

CREATE TABLE model_invocation_facts_0057_new (
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
        'translation'
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

INSERT INTO model_invocation_facts_0057_new (
  id,
  task,
  route_task,
  connection_id,
  catalog_entry_id,
  provider_kind_snapshot,
  model_id_snapshot,
  route_reason,
  status,
  attempt,
  fallback_from_invocation_id,
  privacy_policy,
  data_destination,
  maximum_cost_micros,
  currency,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  estimated_cost_micros,
  error_code,
  error_summary,
  started_at,
  completed_at,
  created_at,
  revision,
  diagnostic_request_id,
  failure_stage,
  failure_retryable,
  http_status,
  finish_reason,
  visible_content_length,
  reasoning_present,
  streamed,
  requested_max_output_tokens
)
SELECT
  id,
  task,
  route_task,
  connection_id,
  catalog_entry_id,
  provider_kind_snapshot,
  model_id_snapshot,
  route_reason,
  status,
  attempt,
  fallback_from_invocation_id,
  privacy_policy,
  data_destination,
  maximum_cost_micros,
  currency,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  estimated_cost_micros,
  error_code,
  error_summary,
  started_at,
  completed_at,
  created_at,
  revision,
  diagnostic_request_id,
  failure_stage,
  failure_retryable,
  http_status,
  finish_reason,
  visible_content_length,
  reasoning_present,
  streamed,
  requested_max_output_tokens
FROM model_invocation_facts;

CREATE TEMP TABLE _inkshadow_0057_count_guard (
  table_name TEXT PRIMARY KEY NOT NULL,
  before_count INTEGER NOT NULL,
  after_count INTEGER NOT NULL,
  CHECK (before_count = after_count)
);

INSERT INTO _inkshadow_0057_count_guard (table_name, before_count, after_count)
SELECT table_name, before_count,
  CASE table_name
    WHEN 'model_evaluation_results' THEN (SELECT COUNT(*) FROM model_evaluation_results_0057_new)
    WHEN 'novel_task_routes' THEN (SELECT COUNT(*) FROM novel_task_routes_0057_new)
    WHEN 'model_invocation_facts' THEN (SELECT COUNT(*) FROM model_invocation_facts_0057_new)
  END
FROM _inkshadow_0057_counts;

-- Prove all three rebuilt CHECK constraints accept the missing published task
-- before replacing any published table name.
INSERT INTO model_evaluation_results_0057_new (
  id, catalog_entry_id, task, score_basis_points, latency_p50_ms, sample_count,
  evaluation_source, evaluation_version, observed_at
) VALUES (
  '__inkshadow_0057_quality_evaluation_probe__', '__inkshadow_0057_catalog_probe__',
  'content_quality_check', 0, 0, 1, 'local_evaluation', 'migration-probe-v1',
  '1970-01-01T00:00:00.000Z'
);

INSERT INTO novel_task_routes_0057_new (
  task, primary_catalog_entry_id, parameter_policy_json, privacy_policy,
  failure_policy, route_origin, created_at, updated_at
) VALUES (
  'content_quality_check', '__inkshadow_0057_catalog_probe__', '{}',
  'cloud_allowed', 'ask_user', 'automatic',
  '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
);

INSERT INTO model_invocation_facts_0057_new (
  id, task, route_task, connection_id, provider_kind_snapshot,
  model_id_snapshot, route_reason, status, attempt, privacy_policy,
  data_destination, created_at
) VALUES (
  '__inkshadow_0057_quality_invocation_probe__', 'content_quality_check',
  'content_quality_check', '__inkshadow_0057_connection_probe__', 'deepseek',
  '__inkshadow_0057_model_probe__', 'task_primary', 'queued', 1,
  'cloud_allowed', 'remote', '1970-01-01T00:00:00.000Z'
);

DELETE FROM model_invocation_facts_0057_new
WHERE id = '__inkshadow_0057_quality_invocation_probe__';
DELETE FROM novel_task_routes_0057_new
WHERE task = 'content_quality_check'
  AND primary_catalog_entry_id = '__inkshadow_0057_catalog_probe__';
DELETE FROM model_evaluation_results_0057_new
WHERE id = '__inkshadow_0057_quality_evaluation_probe__';

-- These two triggers belong to the cost/privacy table but reference the route
-- table by name. Drop them before the route-table swap so SQLite never has to
-- compile a trigger against the short interval where that name is absent.
DROP TRIGGER model_cost_privacy_local_route_update_guard;
DROP TRIGGER model_cost_privacy_local_route_delete_guard;

DROP TABLE model_invocation_facts;
DROP TABLE novel_task_routes;
DROP TABLE model_evaluation_results;

ALTER TABLE model_evaluation_results_0057_new RENAME TO model_evaluation_results;
ALTER TABLE novel_task_routes_0057_new RENAME TO novel_task_routes;
ALTER TABLE model_invocation_facts_0057_new RENAME TO model_invocation_facts;

CREATE INDEX model_evaluation_results_routing_idx
  ON model_evaluation_results (
    task,
    score_basis_points DESC,
    latency_p50_ms ASC,
    observed_at DESC,
    catalog_entry_id
  );

CREATE INDEX model_evaluation_results_model_idx
  ON model_evaluation_results (catalog_entry_id, task, observed_at DESC, id ASC);

CREATE INDEX novel_task_routes_models_idx
  ON novel_task_routes (
    primary_catalog_entry_id,
    fallback_catalog_entry_id,
    enabled DESC,
    task
  );

CREATE TRIGGER novel_task_routes_local_only_insert_guard
BEFORE INSERT ON novel_task_routes
WHEN NEW.privacy_policy = 'local_only'
  AND (
    NOT EXISTS (
      SELECT 1
      FROM model_cost_privacy_profiles
      WHERE catalog_entry_id = NEW.primary_catalog_entry_id
        AND data_destination = 'local'
        AND evidence_source <> 'unknown'
    )
    OR (
      NEW.fallback_catalog_entry_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM model_cost_privacy_profiles
        WHERE catalog_entry_id = NEW.fallback_catalog_entry_id
          AND data_destination = 'local'
          AND evidence_source <> 'unknown'
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'local-only route requires evidence-confirmed local models');
END;

CREATE TRIGGER novel_task_routes_local_only_update_guard
BEFORE UPDATE OF primary_catalog_entry_id, fallback_catalog_entry_id, privacy_policy
ON novel_task_routes
WHEN NEW.privacy_policy = 'local_only'
  AND (
    NOT EXISTS (
      SELECT 1
      FROM model_cost_privacy_profiles
      WHERE catalog_entry_id = NEW.primary_catalog_entry_id
        AND data_destination = 'local'
        AND evidence_source <> 'unknown'
    )
    OR (
      NEW.fallback_catalog_entry_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM model_cost_privacy_profiles
        WHERE catalog_entry_id = NEW.fallback_catalog_entry_id
          AND data_destination = 'local'
          AND evidence_source <> 'unknown'
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'local-only route requires evidence-confirmed local models');
END;

CREATE TRIGGER model_cost_privacy_local_route_update_guard
BEFORE UPDATE OF data_destination, evidence_source ON model_cost_privacy_profiles
WHEN (NEW.data_destination <> 'local' OR NEW.evidence_source = 'unknown')
  AND EXISTS (
    SELECT 1
    FROM novel_task_routes
    WHERE privacy_policy = 'local_only'
      AND (
        primary_catalog_entry_id = OLD.catalog_entry_id
        OR fallback_catalog_entry_id = OLD.catalog_entry_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'cannot remove local evidence used by a local-only route');
END;

CREATE TRIGGER model_cost_privacy_local_route_delete_guard
BEFORE DELETE ON model_cost_privacy_profiles
WHEN EXISTS (
  SELECT 1
  FROM novel_task_routes
  WHERE privacy_policy = 'local_only'
    AND (
      primary_catalog_entry_id = OLD.catalog_entry_id
      OR fallback_catalog_entry_id = OLD.catalog_entry_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete local evidence used by a local-only route');
END;

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

DROP TABLE _inkshadow_0057_count_guard;
DROP TABLE _inkshadow_0057_counts;

PRAGMA foreign_keys = ON;
