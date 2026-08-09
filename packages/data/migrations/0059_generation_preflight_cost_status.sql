-- Keep generation and usage provenance honest when a provider can generate
-- text but has not supplied pricing metadata. Numeric zero remains the legacy
-- storage placeholder on ai_generation_runs; cost_status is authoritative and
-- prevents it from being presented as a zero-cost estimate.

ALTER TABLE ai_generation_runs
  ADD COLUMN cost_status TEXT NOT NULL DEFAULT 'estimated'
    CHECK (
      cost_status = 'estimated'
      OR (
        cost_status = 'pricing_unavailable'
        AND estimated_cost_micros = '0'
        AND currency = 'XXX'
        AND pricing_version = 'pricing_unavailable'
      )
    );

CREATE TABLE ai_generation_attempt_usage_next (
  run_id TEXT NOT NULL
    REFERENCES ai_generation_runs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL
    CHECK (attempt BETWEEN 1 AND 100),
  usage_source TEXT NOT NULL
    CHECK (
      usage_source IN (
        'provider_reported',
        'provider_reported_unpriced',
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
  cost_status TEXT NOT NULL
    CHECK (cost_status IN ('estimated', 'pricing_unavailable')),
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
      AND cost_status = 'estimated'
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND (cached_input_tokens IS NULL OR cached_input_tokens <= input_tokens)
      AND usage_priced_estimate_micros IS NOT NULL
    )
    OR (
      usage_source = 'provider_reported_unpriced'
      AND cost_status = 'pricing_unavailable'
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND (cached_input_tokens IS NULL OR cached_input_tokens <= input_tokens)
      AND usage_priced_estimate_micros IS NULL
      AND currency = 'XXX'
      AND pricing_version = 'pricing_unavailable'
    )
    OR (
      usage_source = 'local_demo'
      AND cost_status = 'estimated'
      AND input_tokens = 0
      AND output_tokens = 0
      AND cached_input_tokens = 0
      AND usage_priced_estimate_micros = '0'
    )
  )
);

INSERT INTO ai_generation_attempt_usage_next (
  run_id,
  attempt,
  usage_source,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  usage_priced_estimate_micros,
  cost_status,
  currency,
  pricing_version,
  price_updated_at,
  reported_at
)
SELECT
  run_id,
  attempt,
  usage_source,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  usage_priced_estimate_micros,
  'estimated',
  currency,
  pricing_version,
  price_updated_at,
  reported_at
FROM ai_generation_attempt_usage;

DROP TABLE ai_generation_attempt_usage;
ALTER TABLE ai_generation_attempt_usage_next RENAME TO ai_generation_attempt_usage;

CREATE INDEX ai_generation_attempt_usage_reported_idx
  ON ai_generation_attempt_usage (reported_at DESC, run_id ASC, attempt ASC);
