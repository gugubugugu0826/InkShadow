PRAGMA foreign_keys = ON;

-- Model Hub stores only connection metadata. API keys and custom authorization
-- header values remain in the operating-system credential vault and are
-- referenced by an opaque credential_ref.
CREATE TABLE IF NOT EXISTS model_provider_connections (
  id TEXT PRIMARY KEY NOT NULL,
  provider_kind TEXT NOT NULL
    CHECK (
      provider_kind IN (
        'openai',
        'deepseek',
        'alibaba_qwen',
        'volcengine_doubao',
        'google_gemini',
        'anthropic_claude',
        'ollama',
        'custom_openai_compatible'
      )
    ),
  display_name TEXT NOT NULL,
  protocol TEXT NOT NULL
    CHECK (protocol IN ('openai_compatible', 'anthropic', 'gemini', 'ollama')),
  region TEXT,
  workspace_id TEXT,
  endpoint_id TEXT,
  base_url TEXT NOT NULL,
  credential_ref TEXT,
  credential_state TEXT NOT NULL DEFAULT 'missing'
    CHECK (credential_state IN ('missing', 'present', 'unavailable')),
  connection_status TEXT NOT NULL DEFAULT 'not_tested'
    CHECK (
      connection_status IN (
        'not_tested',
        'checking',
        'ready',
        'degraded',
        'error',
        'disabled'
      )
    ),
  catalog_sync_status TEXT NOT NULL DEFAULT 'never'
    CHECK (
      catalog_sync_status IN (
        'never',
        'syncing',
        'succeeded',
        'partial',
        'failed'
      )
    ),
  last_tested_at TEXT,
  last_catalog_synced_at TEXT,
  last_error_code TEXT,
  last_error_summary TEXT,
  legacy_provider_id TEXT UNIQUE
    REFERENCES model_profiles(provider_id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(display_name) BETWEEN 1 AND 160),
  CHECK (length(base_url) BETWEEN 1 AND 2048),
  CHECK (region IS NULL OR length(region) BETWEEN 1 AND 128),
  CHECK (workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 256),
  CHECK (endpoint_id IS NULL OR length(endpoint_id) BETWEEN 1 AND 512),
  CHECK (credential_ref IS NULL OR length(credential_ref) BETWEEN 1 AND 256),
  CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
  CHECK (last_error_summary IS NULL OR length(last_error_summary) BETWEEN 1 AND 1000),
  CHECK (credential_ref IS NOT NULL OR credential_state <> 'present')
);

CREATE INDEX IF NOT EXISTS model_provider_connections_status_idx
  ON model_provider_connections (enabled DESC, connection_status, updated_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS model_provider_connections_provider_idx
  ON model_provider_connections (provider_kind, updated_at DESC, id ASC);

-- A sync receipt distinguishes a successful authoritative provider response
-- from a partial preset/manual import. This prevents a failed refresh from
-- making previously usable catalog entries disappear.
CREATE TABLE IF NOT EXISTS model_catalog_syncs (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL
    REFERENCES model_provider_connections(id) ON DELETE CASCADE,
  source TEXT NOT NULL
    CHECK (source IN ('provider_api', 'official_preset', 'manual', 'legacy')),
  status TEXT NOT NULL
    CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'cancelled')),
  discovered_model_count INTEGER NOT NULL DEFAULT 0
    CHECK (discovered_model_count BETWEEN 0 AND 1000000),
  next_page_token_present INTEGER NOT NULL DEFAULT 0
    CHECK (next_page_token_present IN (0, 1)),
  error_code TEXT,
  error_summary TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  CHECK (error_summary IS NULL OR length(error_summary) BETWEEN 1 AND 1000),
  CHECK ((status = 'running') = (completed_at IS NULL)),
  CHECK (
    (status IN ('failed', 'partial') AND error_code IS NOT NULL)
    OR (status NOT IN ('failed', 'partial') AND error_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS model_catalog_syncs_connection_idx
  ON model_catalog_syncs (connection_id, started_at DESC, id ASC);

-- Catalog rows are dynamic discovery results. No specific model identifier is
-- seeded or treated as the permanent best model for any task.
CREATE TABLE IF NOT EXISTS model_catalog_entries (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL
    REFERENCES model_provider_connections(id) ON DELETE CASCADE,
  provider_model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  owned_by TEXT,
  catalog_source TEXT NOT NULL
    CHECK (catalog_source IN ('provider_api', 'official_preset', 'manual', 'legacy')),
  availability TEXT NOT NULL
    CHECK (availability IN ('unknown', 'available', 'unavailable')),
  lifecycle TEXT NOT NULL DEFAULT 'unknown'
    CHECK (lifecycle IN ('unknown', 'stable', 'preview', 'deprecated')),
  input_token_limit INTEGER
    CHECK (input_token_limit IS NULL OR input_token_limit BETWEEN 1 AND 1000000000),
  output_token_limit INTEGER
    CHECK (output_token_limit IS NULL OR output_token_limit BETWEEN 1 AND 1000000000),
  first_discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  stale_after TEXT,
  last_sync_id TEXT
    REFERENCES model_catalog_syncs(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(provider_model_id) BETWEEN 1 AND 512),
  CHECK (length(display_name) BETWEEN 1 AND 512),
  CHECK (owned_by IS NULL OR length(owned_by) BETWEEN 1 AND 256),
  UNIQUE (connection_id, provider_model_id)
);

CREATE INDEX IF NOT EXISTS model_catalog_entries_connection_idx
  ON model_catalog_entries (
    connection_id,
    availability,
    last_seen_at DESC,
    provider_model_id ASC
  );

CREATE INDEX IF NOT EXISTS model_catalog_entries_stale_idx
  ON model_catalog_entries (stale_after, connection_id, id)
  WHERE stale_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS model_capability_scans (
  id TEXT PRIMARY KEY NOT NULL,
  catalog_entry_id TEXT NOT NULL
    REFERENCES model_catalog_entries(id) ON DELETE CASCADE,
  scan_kind TEXT NOT NULL
    CHECK (scan_kind IN ('provider_metadata', 'official_preset', 'lightweight_probe', 'user_review')),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  evidence_version TEXT NOT NULL,
  supported_count INTEGER NOT NULL DEFAULT 0
    CHECK (supported_count BETWEEN 0 AND 12),
  unsupported_count INTEGER NOT NULL DEFAULT 0
    CHECK (unsupported_count BETWEEN 0 AND 12),
  unknown_count INTEGER NOT NULL DEFAULT 0
    CHECK (unknown_count BETWEEN 0 AND 12),
  error_code TEXT,
  error_summary TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(evidence_version) BETWEEN 1 AND 128),
  CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  CHECK (error_summary IS NULL OR length(error_summary) BETWEEN 1 AND 1000),
  CHECK (supported_count + unsupported_count + unknown_count <= 12),
  CHECK ((status IN ('succeeded', 'partial', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),
  CHECK ((status IN ('running', 'succeeded', 'partial', 'failed', 'cancelled')) = (started_at IS NOT NULL)),
  CHECK (
    (status IN ('partial', 'failed') AND error_code IS NOT NULL)
    OR (status NOT IN ('partial', 'failed') AND error_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS model_capability_scans_model_idx
  ON model_capability_scans (catalog_entry_id, requested_at DESC, id ASC);

CREATE TABLE IF NOT EXISTS model_capability_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  catalog_entry_id TEXT NOT NULL
    REFERENCES model_catalog_entries(id) ON DELETE CASCADE,
  scan_id TEXT
    REFERENCES model_capability_scans(id) ON DELETE SET NULL,
  capability TEXT NOT NULL
    CHECK (
      capability IN (
        'text_generation',
        'reasoning',
        'structured_output',
        'embedding',
        'rerank',
        'image_generation',
        'vision',
        'translation',
        'tool_calling',
        'token_counting',
        'streaming',
        'long_context'
      )
    ),
  verdict TEXT NOT NULL
    CHECK (verdict IN ('supported', 'unsupported', 'unknown')),
  evidence_source TEXT NOT NULL
    CHECK (
      evidence_source IN (
        'provider_metadata',
        'official_preset',
        'lightweight_probe',
        'user_confirmed',
        'legacy'
      )
    ),
  evidence_version TEXT NOT NULL,
  evidence_summary TEXT,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(evidence_version) BETWEEN 1 AND 128),
  CHECK (evidence_summary IS NULL OR length(evidence_summary) BETWEEN 1 AND 1000),
  UNIQUE (catalog_entry_id, capability, evidence_source, evidence_version)
);

CREATE INDEX IF NOT EXISTS model_capability_evidence_resolution_idx
  ON model_capability_evidence (
    catalog_entry_id,
    capability,
    observed_at DESC,
    id ASC
  );

-- Cost and privacy are model-level routing evidence. Unknown values remain
-- explicit rather than being inferred from a provider or model name.
CREATE TABLE IF NOT EXISTS model_cost_privacy_profiles (
  catalog_entry_id TEXT PRIMARY KEY NOT NULL
    REFERENCES model_catalog_entries(id) ON DELETE CASCADE,
  currency TEXT
    CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  input_micros_per_million_tokens TEXT,
  output_micros_per_million_tokens TEXT,
  cached_input_micros_per_million_tokens TEXT,
  pricing_version TEXT,
  price_updated_at TEXT,
  data_destination TEXT NOT NULL DEFAULT 'unknown'
    CHECK (data_destination IN ('local', 'remote', 'unknown')),
  retention_policy TEXT NOT NULL DEFAULT 'unknown'
    CHECK (
      retention_policy IN (
        'none',
        'temporary',
        'provider_default',
        'unknown'
      )
    ),
  training_policy TEXT NOT NULL DEFAULT 'unknown'
    CHECK (
      training_policy IN (
        'not_used',
        'opt_out',
        'may_be_used',
        'provider_default',
        'unknown'
      )
    ),
  evidence_source TEXT NOT NULL
    CHECK (
      evidence_source IN (
        'provider_metadata',
        'official_preset',
        'provider_policy',
        'user_confirmed',
        'legacy',
        'unknown'
      )
    ),
  evidence_version TEXT,
  evidence_summary TEXT,
  evidence_updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    input_micros_per_million_tokens IS NULL
    OR (
      length(input_micros_per_million_tokens) BETWEEN 1 AND 19
      AND input_micros_per_million_tokens NOT GLOB '*[^0-9]*'
    )
  ),
  CHECK (
    output_micros_per_million_tokens IS NULL
    OR (
      length(output_micros_per_million_tokens) BETWEEN 1 AND 19
      AND output_micros_per_million_tokens NOT GLOB '*[^0-9]*'
    )
  ),
  CHECK (
    cached_input_micros_per_million_tokens IS NULL
    OR (
      length(cached_input_micros_per_million_tokens) BETWEEN 1 AND 19
      AND cached_input_micros_per_million_tokens NOT GLOB '*[^0-9]*'
    )
  ),
  CHECK (pricing_version IS NULL OR length(pricing_version) BETWEEN 1 AND 128),
  CHECK (evidence_version IS NULL OR length(evidence_version) BETWEEN 1 AND 128),
  CHECK (evidence_summary IS NULL OR length(evidence_summary) BETWEEN 1 AND 1000),
  CHECK (
    (
      input_micros_per_million_tokens IS NULL
      AND output_micros_per_million_tokens IS NULL
      AND cached_input_micros_per_million_tokens IS NULL
      AND currency IS NULL
      AND pricing_version IS NULL
      AND price_updated_at IS NULL
    )
    OR (
      input_micros_per_million_tokens IS NOT NULL
      AND output_micros_per_million_tokens IS NOT NULL
      AND currency IS NOT NULL
      AND pricing_version IS NOT NULL
      AND price_updated_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS model_cost_privacy_profiles_routing_idx
  ON model_cost_privacy_profiles (
    data_destination,
    training_policy,
    retention_policy,
    evidence_updated_at DESC,
    catalog_entry_id
  );

-- Evaluation results are immutable, aggregate routing evidence. They contain
-- no prompts, sample text or model responses. A changed benchmark must publish
-- a new evaluation_version instead of silently replacing old evidence.
CREATE TABLE IF NOT EXISTS model_evaluation_results (
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

CREATE INDEX IF NOT EXISTS model_evaluation_results_routing_idx
  ON model_evaluation_results (
    task,
    score_basis_points DESC,
    latency_p50_ms ASC,
    observed_at DESC,
    catalog_entry_id
  );

CREATE INDEX IF NOT EXISTS model_evaluation_results_model_idx
  ON model_evaluation_results (catalog_entry_id, task, observed_at DESC, id ASC);

CREATE TABLE IF NOT EXISTS model_hub_presets (
  id TEXT PRIMARY KEY NOT NULL,
  scheme TEXT NOT NULL
    CHECK (scheme IN ('smart', 'quality', 'economy', 'local_privacy', 'custom')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'active', 'superseded')),
  privacy_policy TEXT NOT NULL
    CHECK (privacy_policy IN ('cloud_allowed', 'local_preferred', 'local_only')),
  cost_priority TEXT NOT NULL
    CHECK (cost_priority IN ('quality_first', 'balanced', 'cost_first')),
  route_generation_version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(display_name) BETWEEN 1 AND 160),
  CHECK (length(route_generation_version) BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS model_hub_presets_one_active_idx
  ON model_hub_presets (status)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS novel_task_routes (
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

CREATE INDEX IF NOT EXISTS novel_task_routes_models_idx
  ON novel_task_routes (
    primary_catalog_entry_id,
    fallback_catalog_entry_id,
    enabled DESC,
    task
  );

CREATE TRIGGER IF NOT EXISTS novel_task_routes_local_only_insert_guard
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

CREATE TRIGGER IF NOT EXISTS novel_task_routes_local_only_update_guard
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

CREATE TRIGGER IF NOT EXISTS model_cost_privacy_local_route_update_guard
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

CREATE TRIGGER IF NOT EXISTS model_cost_privacy_local_route_delete_guard
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

-- The universal invocation ledger intentionally excludes prompts, messages,
-- chapter text, model responses and credentials. It is provenance and usage
-- metadata only.
CREATE TABLE IF NOT EXISTS model_invocation_facts (
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

CREATE INDEX IF NOT EXISTS model_invocation_facts_task_idx
  ON model_invocation_facts (task, created_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS model_invocation_facts_connection_idx
  ON model_invocation_facts (connection_id, status, created_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS model_invocation_facts_fallback_idx
  ON model_invocation_facts (fallback_from_invocation_id, attempt, id)
  WHERE fallback_from_invocation_id IS NOT NULL;
