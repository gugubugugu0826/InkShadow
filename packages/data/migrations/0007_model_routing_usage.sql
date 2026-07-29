PRAGMA foreign_keys = ON;

-- User-authored role bindings are configuration, not an implicit provider
-- preference. The selected model identifier is snapshotted so changing a
-- profile cannot silently retarget an existing role.
CREATE TABLE IF NOT EXISTS model_role_routes (
  role TEXT PRIMARY KEY NOT NULL
    CHECK (
      role IN (
        'fast',
        'high_quality',
        'long_context',
        'embedding',
        'validation',
        'translation',
        'local_private'
      )
    ),
  primary_provider_id TEXT NOT NULL
    REFERENCES model_profiles(provider_id) ON DELETE RESTRICT,
  primary_model_id TEXT NOT NULL,
  fallback_provider_id TEXT
    REFERENCES model_profiles(provider_id) ON DELETE RESTRICT,
  fallback_model_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(primary_model_id) BETWEEN 1 AND 512),
  CHECK (
    (fallback_provider_id IS NULL AND fallback_model_id IS NULL)
    OR (
      fallback_provider_id IS NOT NULL
      AND fallback_model_id IS NOT NULL
      AND length(fallback_model_id) BETWEEN 1 AND 512
      AND (
        fallback_provider_id <> primary_provider_id
        OR fallback_model_id <> primary_model_id
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS model_role_routes_updated_idx
  ON model_role_routes (updated_at DESC, role ASC);

-- Route selection is immutable provenance for a generation run. Keeping it
-- separate lets pre-migration runs remain readable without rewriting history.
CREATE TABLE IF NOT EXISTS ai_generation_route_selections (
  run_id TEXT PRIMARY KEY NOT NULL
    REFERENCES ai_generation_runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (
      role IN (
        'fast',
        'high_quality',
        'long_context',
        'embedding',
        'validation',
        'translation',
        'local_private'
      )
    ),
  reason TEXT NOT NULL
    CHECK (
      reason IN (
        'legacy_default',
        'role_primary',
        'role_fallback',
        'local_demo'
      )
    ),
  fallback_provider_id TEXT,
  fallback_model_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (fallback_provider_id IS NULL AND fallback_model_id IS NULL)
    OR (
      fallback_provider_id IS NOT NULL
      AND fallback_model_id IS NOT NULL
      AND length(fallback_provider_id) BETWEEN 1 AND 128
      AND length(fallback_model_id) BETWEEN 1 AND 512
    )
  )
);

CREATE INDEX IF NOT EXISTS ai_generation_route_selections_role_idx
  ON ai_generation_route_selections (role, created_at DESC, run_id ASC);

-- One append-only usage fact is accepted per run attempt. Monetary values are
-- deliberately named estimates: providers report token usage, not the final
-- amount charged on their invoice.
CREATE TABLE IF NOT EXISTS ai_generation_attempt_usage (
  run_id TEXT NOT NULL
    REFERENCES ai_generation_runs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL
    CHECK (attempt BETWEEN 1 AND 100),
  usage_source TEXT NOT NULL
    CHECK (
      usage_source IN (
        'provider_reported',
        'provider_unavailable',
        'local_demo'
      )
    ),
  input_tokens INTEGER
    CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 100000000),
  output_tokens INTEGER
    CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 100000000),
  cached_input_tokens INTEGER
    CHECK (
      cached_input_tokens IS NULL
      OR cached_input_tokens BETWEEN 0 AND 100000000
    ),
  usage_priced_estimate_micros TEXT
    CHECK (
      usage_priced_estimate_micros IS NULL
      OR (
        length(usage_priced_estimate_micros) BETWEEN 1 AND 19
        AND usage_priced_estimate_micros NOT GLOB '*[^0-9]*'
      )
    ),
  currency TEXT NOT NULL
    CHECK (length(currency) = 3 AND currency = upper(currency)),
  pricing_version TEXT NOT NULL,
  price_updated_at TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (run_id, attempt),
  CHECK (length(pricing_version) BETWEEN 1 AND 128),
  CHECK (
    (
      usage_source = 'provider_unavailable'
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND cached_input_tokens IS NULL
      AND usage_priced_estimate_micros IS NULL
    )
    OR (
      usage_source = 'provider_reported'
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND (
        cached_input_tokens IS NULL
        OR cached_input_tokens <= input_tokens
      )
      AND usage_priced_estimate_micros IS NOT NULL
    )
    OR (
      usage_source = 'local_demo'
      AND input_tokens = 0
      AND output_tokens = 0
      AND cached_input_tokens = 0
      AND usage_priced_estimate_micros = '0'
    )
  )
);

CREATE INDEX IF NOT EXISTS ai_generation_attempt_usage_reported_idx
  ON ai_generation_attempt_usage (reported_at DESC, run_id ASC, attempt ASC);

-- Deferred requests contain only stable identifiers, route/cost approval and
-- lifecycle metadata. Prompt messages, chapter text and credentials are
-- intentionally reconstructed only after a fresh online preflight.
CREATE TABLE IF NOT EXISTS ai_deferred_generation_requests (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL UNIQUE
    REFERENCES background_tasks(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL
    REFERENCES chapters(id) ON DELETE CASCADE,
  base_version_id TEXT NOT NULL
    REFERENCES chapter_versions(id) ON DELETE RESTRICT,
  model_role TEXT NOT NULL
    CHECK (
      model_role IN (
        'fast',
        'high_quality',
        'long_context',
        'embedding',
        'validation',
        'translation',
        'local_private'
      )
    ),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  maximum_output_tokens INTEGER NOT NULL
    CHECK (maximum_output_tokens BETWEEN 0 AND 100000000),
  approved_input_tokens INTEGER NOT NULL
    CHECK (approved_input_tokens BETWEEN 0 AND 100000000),
  approved_estimate_micros TEXT NOT NULL
    CHECK (
      length(approved_estimate_micros) BETWEEN 1 AND 19
      AND approved_estimate_micros NOT GLOB '*[^0-9]*'
    ),
  currency TEXT NOT NULL
    CHECK (length(currency) = 3 AND currency = upper(currency)),
  pricing_version TEXT NOT NULL,
  price_updated_at TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'waiting_network',
        'blocked_stale',
        'cancelled',
        'consumed'
      )
    ),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  consumed_run_id TEXT
    REFERENCES ai_generation_runs(id) ON DELETE SET NULL,
  cancelled_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CHECK (length(provider_id) BETWEEN 1 AND 128),
  CHECK (length(model_id) BETWEEN 1 AND 512),
  CHECK (length(pricing_version) BETWEEN 1 AND 128),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (
    (status = 'consumed' AND consumed_at IS NOT NULL AND consumed_run_id IS NOT NULL)
    OR (status <> 'consumed' AND consumed_at IS NULL AND consumed_run_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_deferred_generation_chapter_idx
  ON ai_deferred_generation_requests (
    chapter_id,
    status,
    updated_at DESC,
    id DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS ai_deferred_generation_active_unique
  ON ai_deferred_generation_requests (chapter_id, model_role)
  WHERE status = 'waiting_network';
