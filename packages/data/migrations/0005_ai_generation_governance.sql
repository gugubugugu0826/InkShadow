PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS model_pricing_profiles (
  provider_id TEXT NOT NULL
    REFERENCES model_profiles(provider_id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  context_window_tokens INTEGER NOT NULL
    CHECK (context_window_tokens BETWEEN 1 AND 100000000),
  currency TEXT NOT NULL
    CHECK (length(currency) = 3 AND currency = upper(currency)),
  input_micros_per_million_tokens INTEGER NOT NULL
    CHECK (input_micros_per_million_tokens BETWEEN 0 AND 9000000000000000),
  output_micros_per_million_tokens INTEGER NOT NULL
    CHECK (output_micros_per_million_tokens BETWEEN 0 AND 9000000000000000),
  cached_input_micros_per_million_tokens INTEGER
    CHECK (
      cached_input_micros_per_million_tokens IS NULL
      OR cached_input_micros_per_million_tokens BETWEEN 0 AND 9000000000000000
    ),
  pricing_version TEXT NOT NULL,
  price_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id),
  CHECK (length(model_id) BETWEEN 1 AND 512),
  CHECK (length(pricing_version) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS model_pricing_profiles_updated_idx
  ON model_pricing_profiles (updated_at DESC, provider_id ASC, model_id ASC);

CREATE TABLE IF NOT EXISTS ai_budget_policies (
  scope_key TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL
    CHECK (scope IN ('project', 'month')),
  project_id TEXT
    REFERENCES projects(id) ON DELETE CASCADE,
  month_key TEXT,
  currency TEXT NOT NULL
    CHECK (length(currency) = 3 AND currency = upper(currency)),
  limit_micros TEXT NOT NULL
    CHECK (
      length(limit_micros) BETWEEN 1 AND 19
      AND limit_micros NOT GLOB '*[^0-9]*'
    ),
  enforcement TEXT NOT NULL
    CHECK (enforcement IN ('warn', 'hard')),
  revision INTEGER NOT NULL
    CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope = 'project' AND project_id IS NOT NULL AND month_key IS NULL)
    OR (
      scope = 'month'
      AND project_id IS NULL
      AND month_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    )
  )
);

CREATE INDEX IF NOT EXISTS ai_budget_policies_scope_idx
  ON ai_budget_policies (scope, project_id, month_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_generation_runs (
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
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (
      state IN (
        'prechecking',
        'blocked',
        'queued',
        'retrieving',
        'generating',
        'validating',
        'candidate_ready',
        'failed_retryable',
        'failed_final',
        'cancelled',
        'completed'
      )
    ),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  attempt INTEGER NOT NULL DEFAULT 1
    CHECK (attempt BETWEEN 1 AND 100),
  input_tokens INTEGER NOT NULL
    CHECK (input_tokens BETWEEN 0 AND 100000000),
  maximum_output_tokens INTEGER NOT NULL
    CHECK (maximum_output_tokens BETWEEN 0 AND 100000000),
  estimated_cost_micros TEXT NOT NULL
    CHECK (
      length(estimated_cost_micros) BETWEEN 1 AND 19
      AND estimated_cost_micros NOT GLOB '*[^0-9]*'
    ),
  incurred_cost_micros TEXT NOT NULL DEFAULT '0'
    CHECK (
      length(incurred_cost_micros) BETWEEN 1 AND 19
      AND incurred_cost_micros NOT GLOB '*[^0-9]*'
    ),
  currency TEXT NOT NULL
    CHECK (length(currency) = 3 AND currency = upper(currency)),
  pricing_version TEXT NOT NULL,
  price_updated_at TEXT NOT NULL,
  preflight_json TEXT NOT NULL
    CHECK (
      json_valid(preflight_json)
      AND json_type(preflight_json) = 'object'
      AND length(preflight_json) <= 65536
      AND json_type(preflight_json, '$.content') IS NULL
      AND json_type(preflight_json, '$.prompt') IS NULL
      AND json_type(preflight_json, '$.messages') IS NULL
      AND json_type(preflight_json, '$.secret') IS NULL
      AND json_type(preflight_json, '$.credential') IS NULL
    ),
  candidate_id TEXT
    REFERENCES ai_candidates(id) ON DELETE SET NULL,
  failure_code TEXT,
  cancelled_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CHECK (length(provider_id) BETWEEN 1 AND 128),
  CHECK (length(model_id) BETWEEN 1 AND 512),
  CHECK (length(pricing_version) BETWEEN 1 AND 128),
  CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 3 AND 80),
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ai_generation_runs_project_created_idx
  ON ai_generation_runs (project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ai_generation_runs_chapter_created_idx
  ON ai_generation_runs (chapter_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ai_generation_runs_budget_idx
  ON ai_generation_runs (state, created_at DESC, currency);
