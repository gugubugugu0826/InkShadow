PRAGMA foreign_keys = ON;

-- Paid Novel Skill evaluation execution authority.  These rows contain only
-- bounded configuration metadata, locators, hashes, counts, prices and state.
-- Prompt text, fixture bodies, provider output, reasoning and credentials are
-- deliberately excluded.

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_protocols (
  suite_id TEXT PRIMARY KEY NOT NULL
    REFERENCES novel_skill_evaluation_suites(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  execution_protocol_version TEXT NOT NULL
    CHECK (execution_protocol_version = 'novel-skill-paid-ab@1'),
  protocol_hash TEXT NOT NULL CHECK (length(protocol_hash) = 64
    AND protocol_hash = lower(protocol_hash) AND protocol_hash NOT GLOB '*[^0-9a-f]*'),
  request_profile_manifest_hash TEXT NOT NULL CHECK (length(request_profile_manifest_hash) = 64
    AND request_profile_manifest_hash = lower(request_profile_manifest_hash)
    AND request_profile_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  context_baseline_manifest_hash TEXT NOT NULL CHECK (length(context_baseline_manifest_hash) = 64
    AND context_baseline_manifest_hash = lower(context_baseline_manifest_hash)
    AND context_baseline_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  prompt_template_version TEXT NOT NULL CHECK (length(prompt_template_version) BETWEEN 3 AND 96
    AND prompt_template_version NOT GLOB '*[^A-Za-z0-9._:@/-]*'),
  prompt_template_hash TEXT NOT NULL CHECK (length(prompt_template_hash) = 64
    AND prompt_template_hash = lower(prompt_template_hash)
    AND prompt_template_hash NOT GLOB '*[^0-9a-f]*'),
  rubric_version TEXT NOT NULL CHECK (rubric_version = 'novel-skill-human-rubric@1'),
  rubric_content_hash TEXT NOT NULL CHECK (length(rubric_content_hash) = 64
    AND rubric_content_hash = lower(rubric_content_hash)
    AND rubric_content_hash NOT GLOB '*[^0-9a-f]*'),
  evaluator_contract_hash TEXT NOT NULL CHECK (length(evaluator_contract_hash) = 64
    AND evaluator_contract_hash = lower(evaluator_contract_hash)
    AND evaluator_contract_hash NOT GLOB '*[^0-9a-f]*'),
  blinding_protocol_version TEXT NOT NULL CHECK (length(blinding_protocol_version) BETWEEN 3 AND 96
    AND blinding_protocol_version NOT GLOB '*[^A-Za-z0-9._:@/-]*'),
  blinding_protocol_hash TEXT NOT NULL CHECK (length(blinding_protocol_hash) = 64
    AND blinding_protocol_hash = lower(blinding_protocol_hash)
    AND blinding_protocol_hash NOT GLOB '*[^0-9a-f]*'),
  randomization_protocol_version TEXT NOT NULL
    CHECK (length(randomization_protocol_version) BETWEEN 3 AND 96
      AND randomization_protocol_version NOT GLOB '*[^A-Za-z0-9._:@/-]*'),
  randomization_protocol_hash TEXT NOT NULL CHECK (length(randomization_protocol_hash) = 64
    AND randomization_protocol_hash = lower(randomization_protocol_hash)
    AND randomization_protocol_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_request_profiles (
  suite_id TEXT NOT NULL
    REFERENCES novel_skill_evaluation_protocols(suite_id) ON DELETE RESTRICT,
  task_type TEXT NOT NULL CHECK (task_type IN (
    'idea_discussion','book_start_guidance','prose_generation','continuation','rewrite','polish',
    'outline_planning','scene_breakdown','chapter_summary','long_memory_compression',
    'character_extraction','world_extraction','contradiction_check','pov_check',
    'character_voice_check','content_quality_check','what_if_simulation','embedding','rerank',
    'image_generation','vision_understanding','translation'
  )),
  profile_version TEXT NOT NULL
    CHECK (profile_version = 'model-hub-exact-evaluation-request@1'),
  request_profile_hash TEXT NOT NULL CHECK (length(request_profile_hash) = 64
    AND request_profile_hash = lower(request_profile_hash)
    AND request_profile_hash NOT GLOB '*[^0-9a-f]*'),
  maximum_input_tokens INTEGER NOT NULL CHECK (maximum_input_tokens BETWEEN 1 AND 1000000000),
  maximum_output_tokens INTEGER NOT NULL CHECK (maximum_output_tokens BETWEEN 1 AND 1000000000),
  temperature_basis_points INTEGER NOT NULL CHECK (temperature_basis_points BETWEEN 0 AND 20000),
  top_p_basis_points INTEGER NOT NULL CHECK (top_p_basis_points BETWEEN 0 AND 10000),
  reasoning_policy TEXT NOT NULL CHECK (reasoning_policy = 'disabled'),
  response_format TEXT NOT NULL CHECK (response_format = 'text'),
  streaming INTEGER NOT NULL CHECK (streaming = 1),
  stop_policy_hash TEXT NOT NULL
    CHECK (stop_policy_hash = '896247754b670bf5c4ac89424e7c5f2fffa598df9adcdc1377d8fcf0868831a6'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  PRIMARY KEY (suite_id, task_type)
);

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_context_baselines (
  suite_id TEXT NOT NULL
    REFERENCES novel_skill_evaluation_protocols(suite_id) ON DELETE RESTRICT,
  fixture_id TEXT NOT NULL,
  baseline_contract_hash TEXT NOT NULL CHECK (length(baseline_contract_hash) = 64
    AND baseline_contract_hash = lower(baseline_contract_hash)
    AND baseline_contract_hash NOT GLOB '*[^0-9a-f]*'),
  included_source_manifest_hash TEXT NOT NULL CHECK (length(included_source_manifest_hash) = 64
    AND included_source_manifest_hash = lower(included_source_manifest_hash)
    AND included_source_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  omitted_source_manifest_hash TEXT NOT NULL CHECK (length(omitted_source_manifest_hash) = 64
    AND omitted_source_manifest_hash = lower(omitted_source_manifest_hash)
    AND omitted_source_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  compiled_baseline_hash TEXT NOT NULL CHECK (length(compiled_baseline_hash) = 64
    AND compiled_baseline_hash = lower(compiled_baseline_hash)
    AND compiled_baseline_hash NOT GLOB '*[^0-9a-f]*'),
  baseline_token_budget INTEGER NOT NULL CHECK (baseline_token_budget BETWEEN 1 AND 1000000000),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  PRIMARY KEY (suite_id, fixture_id),
  FOREIGN KEY (suite_id, fixture_id)
    REFERENCES novel_skill_evaluation_fixtures(suite_id, fixture_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_run_model_targets (
  run_id TEXT NOT NULL REFERENCES novel_skill_evaluation_runs(id) ON DELETE RESTRICT,
  model_slot_id TEXT NOT NULL CHECK (model_slot_id IN ('text_tier_a','text_tier_b')),
  connection_id TEXT NOT NULL REFERENCES model_provider_connections(id) ON DELETE RESTRICT,
  catalog_entry_id TEXT NOT NULL REFERENCES model_catalog_entries(id) ON DELETE RESTRICT,
  provider_kind_snapshot TEXT NOT NULL CHECK (length(provider_kind_snapshot) BETWEEN 1 AND 128
    AND provider_kind_snapshot NOT GLOB '*[^a-z0-9_]*'),
  connection_protocol_snapshot TEXT NOT NULL
    CHECK (connection_protocol_snapshot IN ('openai_compatible','anthropic','gemini','ollama')),
  connection_revision INTEGER NOT NULL CHECK (connection_revision >= 1),
  connection_configuration_hash TEXT NOT NULL CHECK (length(connection_configuration_hash) = 64
    AND connection_configuration_hash = lower(connection_configuration_hash)
    AND connection_configuration_hash NOT GLOB '*[^0-9a-f]*'),
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision >= 1),
  provider_model_id_snapshot TEXT NOT NULL CHECK (length(provider_model_id_snapshot) BETWEEN 1 AND 512),
  catalog_identity_hash TEXT NOT NULL CHECK (length(catalog_identity_hash) = 64
    AND catalog_identity_hash = lower(catalog_identity_hash)
    AND catalog_identity_hash NOT GLOB '*[^0-9a-f]*'),
  model_identity_hash TEXT NOT NULL CHECK (length(model_identity_hash) = 64
    AND model_identity_hash = lower(model_identity_hash)
    AND model_identity_hash NOT GLOB '*[^0-9a-f]*'),
  model_artifact_hash TEXT NOT NULL CHECK (length(model_artifact_hash) = 64
    AND model_artifact_hash = lower(model_artifact_hash)
    AND model_artifact_hash NOT GLOB '*[^0-9a-f]*'),
  artifact_identity_source TEXT NOT NULL
    CHECK (artifact_identity_source = 'provider_model_id'),
  cost_profile_revision INTEGER NOT NULL CHECK (cost_profile_revision >= 1),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  input_micros_per_million_tokens TEXT NOT NULL CHECK (length(input_micros_per_million_tokens) BETWEEN 1 AND 18
    AND input_micros_per_million_tokens NOT GLOB '*[^0-9]*'),
  output_micros_per_million_tokens TEXT NOT NULL CHECK (length(output_micros_per_million_tokens) BETWEEN 1 AND 18
    AND output_micros_per_million_tokens NOT GLOB '*[^0-9]*'),
  cached_input_micros_per_million_tokens TEXT CHECK (cached_input_micros_per_million_tokens IS NULL OR (
    length(cached_input_micros_per_million_tokens) BETWEEN 1 AND 18
    AND cached_input_micros_per_million_tokens NOT GLOB '*[^0-9]*'
    AND CAST(cached_input_micros_per_million_tokens AS INTEGER)
      <= CAST(input_micros_per_million_tokens AS INTEGER))),
  pricing_version TEXT NOT NULL CHECK (length(pricing_version) BETWEEN 1 AND 128),
  price_updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', price_updated_at) = price_updated_at),
  pricing_snapshot_hash TEXT NOT NULL CHECK (length(pricing_snapshot_hash) = 64
    AND pricing_snapshot_hash = lower(pricing_snapshot_hash)
    AND pricing_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  target_hash TEXT NOT NULL CHECK (length(target_hash) = 64 AND target_hash = lower(target_hash)
    AND target_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  PRIMARY KEY (run_id, model_slot_id),
  UNIQUE (run_id, catalog_entry_id),
  UNIQUE (run_id, model_identity_hash),
  UNIQUE (run_id, model_artifact_hash)
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_target_live_insert_guard
BEFORE INSERT ON novel_skill_evaluation_run_model_targets
WHEN NOT EXISTS (
  SELECT 1
  FROM novel_skill_evaluation_runs AS run
  INNER JOIN model_provider_connections AS connection ON connection.id = NEW.connection_id
  INNER JOIN model_catalog_entries AS catalog ON catalog.id = NEW.catalog_entry_id
  INNER JOIN model_cost_privacy_profiles AS cost ON cost.catalog_entry_id = catalog.id
  WHERE run.id = NEW.run_id AND run.status = 'planned'
    AND connection.enabled = 1 AND connection.connection_status = 'ready'
    AND connection.credential_state = 'present'
    AND connection.provider_kind = NEW.provider_kind_snapshot
    AND connection.protocol = NEW.connection_protocol_snapshot
    AND connection.revision = NEW.connection_revision
    AND catalog.connection_id = connection.id AND catalog.availability = 'available'
    AND catalog.revision = NEW.catalog_revision
    AND catalog.provider_model_id = NEW.provider_model_id_snapshot
    AND cost.revision = NEW.cost_profile_revision AND cost.currency = NEW.currency
    AND cost.input_micros_per_million_tokens = NEW.input_micros_per_million_tokens
    AND cost.output_micros_per_million_tokens = NEW.output_micros_per_million_tokens
    AND cost.cached_input_micros_per_million_tokens IS NEW.cached_input_micros_per_million_tokens
    AND cost.pricing_version = NEW.pricing_version AND cost.price_updated_at = NEW.price_updated_at
)
OR NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_runs AS run,
       json_each(run.model_assignments_json) AS assignment
  WHERE run.id = NEW.run_id
    AND json_extract(assignment.value, '$.slotId') = NEW.model_slot_id
    AND json_extract(assignment.value, '$.modelIdentityHash') = NEW.model_identity_hash
    AND json_extract(assignment.value, '$.modelArtifactHash') = NEW.model_artifact_hash
)
BEGIN SELECT RAISE(ABORT, 'evaluation target is not a live exact priced model assignment'); END;

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_dispatch_authorizations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36 AND id = lower(id)
    AND substr(id, 15, 1) = '7' AND substr(id, 20, 1) IN ('8','9','a','b')
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT NOT NULL UNIQUE REFERENCES novel_skill_evaluation_runs(id) ON DELETE RESTRICT,
  protocol_hash TEXT NOT NULL CHECK (length(protocol_hash) = 64 AND protocol_hash = lower(protocol_hash)
    AND protocol_hash NOT GLOB '*[^0-9a-f]*'),
  target_manifest_hash TEXT NOT NULL CHECK (length(target_manifest_hash) = 64
    AND target_manifest_hash = lower(target_manifest_hash)
    AND target_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  pricing_manifest_hash TEXT NOT NULL CHECK (length(pricing_manifest_hash) = 64
    AND pricing_manifest_hash = lower(pricing_manifest_hash)
    AND pricing_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  quote_hash TEXT NOT NULL CHECK (length(quote_hash) = 64 AND quote_hash = lower(quote_hash)
    AND quote_hash NOT GLOB '*[^0-9a-f]*'),
  confirmation_hash TEXT NOT NULL CHECK (length(confirmation_hash) = 64
    AND confirmation_hash = lower(confirmation_hash)
    AND confirmation_hash NOT GLOB '*[^0-9a-f]*'),
  authorized_call_count INTEGER NOT NULL CHECK (authorized_call_count = 192),
  authorized_by TEXT NOT NULL CHECK (authorized_by = 'local_user'),
  commercial_use_acknowledged INTEGER NOT NULL CHECK (commercial_use_acknowledged = 1),
  authorized_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', authorized_at) = authorized_at)
);

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_authorization_limits (
  authorization_id TEXT NOT NULL
    REFERENCES novel_skill_evaluation_dispatch_authorizations(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  estimated_max_cost_micros TEXT NOT NULL CHECK (length(estimated_max_cost_micros) BETWEEN 1 AND 18
    AND estimated_max_cost_micros NOT GLOB '*[^0-9]*'),
  hard_ceiling_micros TEXT NOT NULL CHECK (length(hard_ceiling_micros) BETWEEN 1 AND 18
    AND hard_ceiling_micros NOT GLOB '*[^0-9]*'
    AND CAST(hard_ceiling_micros AS INTEGER) >= CAST(estimated_max_cost_micros AS INTEGER)),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  PRIMARY KEY (authorization_id, currency)
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_authorization_insert_guard
BEFORE INSERT ON novel_skill_evaluation_dispatch_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_runs AS run
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
  WHERE run.id = NEW.run_id AND run.status = 'planned'
    AND protocol.protocol_hash = NEW.protocol_hash
    AND (SELECT count(*) FROM novel_skill_evaluation_run_model_targets
         WHERE run_id = run.id) = 2
    AND (SELECT count(*) FROM novel_skill_evaluation_cells WHERE run_id = run.id) = 192
)
BEGIN SELECT RAISE(ABORT, 'commercial authorization lacks an exact 192-cell protocol and targets'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_authorized_run_start_guard
BEFORE UPDATE OF status ON novel_skill_evaluation_runs
WHEN OLD.status = 'planned' AND NEW.status = 'running'
AND EXISTS (
  SELECT 1 FROM novel_skill_evaluation_protocols WHERE suite_id = OLD.suite_id
)
AND NOT EXISTS (
  SELECT 1
  FROM novel_skill_evaluation_protocols AS protocol
  INNER JOIN novel_skill_evaluation_dispatch_authorizations AS authorization
    ON authorization.run_id = OLD.id AND authorization.protocol_hash = protocol.protocol_hash
  WHERE protocol.suite_id = OLD.suite_id AND authorization.authorized_call_count = 192
    AND (SELECT count(*) FROM novel_skill_evaluation_request_profiles AS profile
         WHERE profile.suite_id = OLD.suite_id) =
        (SELECT count(DISTINCT fixture.task_type) FROM novel_skill_evaluation_fixtures AS fixture
         WHERE fixture.suite_id = OLD.suite_id)
    AND NOT EXISTS (
      SELECT 1 FROM novel_skill_evaluation_fixtures AS fixture
      WHERE fixture.suite_id = OLD.suite_id AND NOT EXISTS (
        SELECT 1 FROM novel_skill_evaluation_request_profiles AS profile
        WHERE profile.suite_id = fixture.suite_id AND profile.task_type = fixture.task_type))
    AND (SELECT count(*) FROM novel_skill_evaluation_context_baselines
         WHERE suite_id = OLD.suite_id) = 12
    AND (SELECT count(*) FROM novel_skill_evaluation_run_model_targets
         WHERE run_id = OLD.id) = 2
    AND NOT EXISTS (
      SELECT 1 FROM novel_skill_evaluation_run_model_targets AS target
      WHERE target.run_id = OLD.id AND NOT EXISTS (
        SELECT 1
        FROM model_provider_connections AS connection
        INNER JOIN model_catalog_entries AS catalog
          ON catalog.id = target.catalog_entry_id AND catalog.connection_id = connection.id
        INNER JOIN model_cost_privacy_profiles AS cost ON cost.catalog_entry_id = catalog.id
        WHERE connection.id = target.connection_id
          AND connection.enabled = 1 AND connection.connection_status = 'ready'
          AND connection.credential_state = 'present'
          AND connection.revision = target.connection_revision
          AND connection.provider_kind = target.provider_kind_snapshot
          AND connection.protocol = target.connection_protocol_snapshot
          AND catalog.availability = 'available' AND catalog.revision = target.catalog_revision
          AND catalog.provider_model_id = target.provider_model_id_snapshot
          AND cost.revision = target.cost_profile_revision AND cost.currency = target.currency
          AND cost.input_micros_per_million_tokens = target.input_micros_per_million_tokens
          AND cost.output_micros_per_million_tokens = target.output_micros_per_million_tokens
          AND cost.cached_input_micros_per_million_tokens
              IS target.cached_input_micros_per_million_tokens
          AND cost.pricing_version = target.pricing_version
          AND cost.price_updated_at = target.price_updated_at
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM novel_skill_evaluation_run_model_targets AS target
      WHERE target.run_id = OLD.id AND NOT EXISTS (
        SELECT 1 FROM novel_skill_evaluation_authorization_limits AS limits
        WHERE limits.authorization_id = authorization.id AND limits.currency = target.currency))
    AND NOT EXISTS (
      SELECT 1 FROM novel_skill_evaluation_authorization_limits AS limits
      WHERE limits.authorization_id = authorization.id AND NOT EXISTS (
        SELECT 1 FROM novel_skill_evaluation_run_model_targets AS target
        WHERE target.run_id = OLD.id AND target.currency = limits.currency))
)
BEGIN SELECT RAISE(ABORT, 'evaluation run lacks complete commercial dispatch authority'); END;

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_dispatch_reservations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36 AND id = lower(id)
    AND substr(id, 15, 1) = '7' AND substr(id, 20, 1) IN ('8','9','a','b')
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  authorization_id TEXT NOT NULL
    REFERENCES novel_skill_evaluation_dispatch_authorizations(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES novel_skill_evaluation_runs(id) ON DELETE RESTRICT,
  cell_id TEXT NOT NULL REFERENCES novel_skill_evaluation_cells(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES novel_skill_evaluation_attempts(id) ON DELETE RESTRICT,
  model_slot_id TEXT NOT NULL CHECK (model_slot_id IN ('text_tier_a','text_tier_b')),
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation BETWEEN 1 AND 8),
  planned_context_trace_id TEXT NOT NULL UNIQUE CHECK (length(planned_context_trace_id) BETWEEN 1 AND 128),
  planned_model_invocation_id TEXT NOT NULL UNIQUE CHECK (length(planned_model_invocation_id) BETWEEN 1 AND 128),
  planned_candidate_id TEXT NOT NULL UNIQUE CHECK (length(planned_candidate_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN (
    'reserved','bound','dispatched','settled','ambiguous','not_dispatched')),
  target_hash TEXT NOT NULL CHECK (length(target_hash) = 64 AND target_hash = lower(target_hash)
    AND target_hash NOT GLOB '*[^0-9a-f]*'),
  pricing_snapshot_hash TEXT NOT NULL CHECK (length(pricing_snapshot_hash) = 64
    AND pricing_snapshot_hash = lower(pricing_snapshot_hash)
    AND pricing_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  request_profile_hash TEXT NOT NULL CHECK (length(request_profile_hash) = 64
    AND request_profile_hash = lower(request_profile_hash)
    AND request_profile_hash NOT GLOB '*[^0-9a-f]*'),
  context_baseline_hash TEXT NOT NULL CHECK (length(context_baseline_hash) = 64
    AND context_baseline_hash = lower(context_baseline_hash)
    AND context_baseline_hash NOT GLOB '*[^0-9a-f]*'),
  prompt_template_hash TEXT NOT NULL CHECK (length(prompt_template_hash) = 64
    AND prompt_template_hash = lower(prompt_template_hash)
    AND prompt_template_hash NOT GLOB '*[^0-9a-f]*'),
  invariant_request_hash TEXT NOT NULL CHECK (length(invariant_request_hash) = 64
    AND invariant_request_hash = lower(invariant_request_hash)
    AND invariant_request_hash NOT GLOB '*[^0-9a-f]*'),
  request_payload_hash TEXT NOT NULL CHECK (length(request_payload_hash) = 64
    AND request_payload_hash = lower(request_payload_hash)
    AND request_payload_hash NOT GLOB '*[^0-9a-f]*'),
  execution_lock_hash TEXT NOT NULL CHECK (length(execution_lock_hash) = 64
    AND execution_lock_hash = lower(execution_lock_hash)
    AND execution_lock_hash NOT GLOB '*[^0-9a-f]*'),
  message_payload_hash TEXT NOT NULL CHECK (length(message_payload_hash) = 64
    AND message_payload_hash = lower(message_payload_hash)
    AND message_payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_authority_version TEXT NOT NULL
    CHECK (payload_authority_version = 'novel-skill-paid-payload-authority@1'),
  payload_authority_manifest_hash TEXT NOT NULL
    CHECK (length(payload_authority_manifest_hash) = 64
      AND payload_authority_manifest_hash = lower(payload_authority_manifest_hash)
      AND payload_authority_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  data_destination TEXT NOT NULL CHECK (data_destination IN ('local','remote')),
  skill_configuration_hash TEXT CHECK (skill_configuration_hash IS NULL OR (
    length(skill_configuration_hash) = 64 AND skill_configuration_hash = lower(skill_configuration_hash)
    AND skill_configuration_hash NOT GLOB '*[^0-9a-f]*')),
  preference_configuration_hash TEXT CHECK (preference_configuration_hash IS NULL OR (
    length(preference_configuration_hash) = 64
    AND preference_configuration_hash = lower(preference_configuration_hash)
    AND preference_configuration_hash NOT GLOB '*[^0-9a-f]*')),
  idempotency_key_hash TEXT NOT NULL UNIQUE CHECK (length(idempotency_key_hash) = 64
    AND idempotency_key_hash = lower(idempotency_key_hash)
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  reserved_max_cost_micros TEXT NOT NULL CHECK (length(reserved_max_cost_micros) BETWEEN 1 AND 18
    AND reserved_max_cost_micros NOT GLOB '*[^0-9]*'),
  settlement_outcome TEXT CHECK (settlement_outcome IS NULL OR settlement_outcome IN (
    'succeeded','failed','cancelled','timed_out','policy_blocked')),
  provider_receipt_hash TEXT CHECK (provider_receipt_hash IS NULL OR (
    length(provider_receipt_hash) = 64 AND provider_receipt_hash = lower(provider_receipt_hash)
    AND provider_receipt_hash NOT GLOB '*[^0-9a-f]*')),
  provider_visible_output_hash TEXT CHECK (provider_visible_output_hash IS NULL OR (
    length(provider_visible_output_hash) = 64
    AND provider_visible_output_hash = lower(provider_visible_output_hash)
    AND provider_visible_output_hash NOT GLOB '*[^0-9a-f]*')),
  output_candidate_id TEXT REFERENCES ai_candidates(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  actual_cost_micros TEXT CHECK (actual_cost_micros IS NULL OR (
    length(actual_cost_micros) BETWEEN 1 AND 18 AND actual_cost_micros NOT GLOB '*[^0-9]*'
    AND CAST(actual_cost_micros AS INTEGER) <= CAST(reserved_max_cost_micros AS INTEGER))),
  reserved_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', reserved_at) = reserved_at),
  bound_at TEXT CHECK (bound_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', bound_at) = bound_at),
  dispatched_at TEXT CHECK (dispatched_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', dispatched_at) = dispatched_at),
  terminal_at TEXT CHECK (terminal_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at) = terminal_at),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  CHECK (
    (state = 'reserved' AND bound_at IS NULL AND dispatched_at IS NULL AND terminal_at IS NULL
      AND settlement_outcome IS NULL AND provider_receipt_hash IS NULL
      AND provider_visible_output_hash IS NULL AND output_candidate_id IS NULL AND actual_cost_micros IS NULL)
    OR (state = 'bound' AND bound_at IS NOT NULL AND dispatched_at IS NULL AND terminal_at IS NULL
      AND settlement_outcome IS NULL AND provider_receipt_hash IS NULL
      AND provider_visible_output_hash IS NULL AND output_candidate_id IS NULL AND actual_cost_micros IS NULL)
    OR (state = 'dispatched' AND bound_at IS NOT NULL AND dispatched_at IS NOT NULL
      AND terminal_at IS NULL AND settlement_outcome IS NULL AND provider_receipt_hash IS NULL
      AND provider_visible_output_hash IS NULL AND output_candidate_id IS NULL AND actual_cost_micros IS NULL)
    OR (state = 'not_dispatched' AND dispatched_at IS NULL AND terminal_at IS NOT NULL
      AND settlement_outcome IS NULL AND provider_receipt_hash IS NULL
      AND provider_visible_output_hash IS NULL AND output_candidate_id IS NULL AND actual_cost_micros IS NULL)
    OR (state = 'ambiguous' AND bound_at IS NOT NULL AND dispatched_at IS NOT NULL
      AND terminal_at IS NOT NULL AND settlement_outcome IS NULL
      AND provider_visible_output_hash IS NULL AND output_candidate_id IS NULL)
    OR (state = 'settled' AND bound_at IS NOT NULL AND dispatched_at IS NOT NULL
      AND terminal_at IS NOT NULL AND settlement_outcome IS NOT NULL
      AND provider_receipt_hash IS NOT NULL
      AND ((settlement_outcome = 'succeeded' AND provider_visible_output_hash IS NOT NULL
            AND output_candidate_id IS NOT NULL)
        OR (settlement_outcome <> 'succeeded' AND provider_visible_output_hash IS NULL
            AND output_candidate_id IS NULL)))
  )
);

CREATE INDEX IF NOT EXISTS novel_skill_evaluation_reservations_run_state_idx
  ON novel_skill_evaluation_dispatch_reservations (run_id, state, cell_id);

-- The paid evaluator is deliberately serial.  Keep this invariant in SQLite
-- as well as in the in-memory runner so that two windows/runtime instances
-- cannot reserve or dispatch different cells from the same commercial run.
CREATE UNIQUE INDEX IF NOT EXISTS novel_skill_evaluation_reservations_one_active_per_run_idx
  ON novel_skill_evaluation_dispatch_reservations (run_id)
  WHERE state IN ('reserved','bound','dispatched');

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_reservation_insert_guard
BEFORE INSERT ON novel_skill_evaluation_dispatch_reservations
WHEN NEW.state <> 'reserved' OR NEW.revision <> 1
  OR NOT EXISTS (
    SELECT 1
    FROM novel_skill_evaluation_attempts AS attempt
    INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = attempt.cell_id
    INNER JOIN novel_skill_evaluation_runs AS run ON run.id = attempt.run_id
    INNER JOIN novel_skill_evaluation_fixtures AS fixture
      ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
    INNER JOIN novel_skill_evaluation_request_profiles AS profile
      ON profile.suite_id = cell.suite_id AND profile.task_type = fixture.task_type
    INNER JOIN novel_skill_evaluation_context_baselines AS baseline
      ON baseline.suite_id = cell.suite_id AND baseline.fixture_id = cell.fixture_id
    INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = cell.suite_id
    INNER JOIN novel_skill_evaluation_dispatch_authorizations AS authorization
      ON authorization.id = NEW.authorization_id AND authorization.run_id = run.id
    INNER JOIN novel_skill_evaluation_run_model_targets AS target
      ON target.run_id = run.id AND target.model_slot_id = cell.model_slot_id
    INNER JOIN novel_skill_evaluation_authorization_limits AS limits
      ON limits.authorization_id = authorization.id AND limits.currency = target.currency
    INNER JOIN model_provider_connections AS connection ON connection.id = target.connection_id
    INNER JOIN model_catalog_entries AS catalog ON catalog.id = target.catalog_entry_id
    INNER JOIN model_cost_privacy_profiles AS cost ON cost.catalog_entry_id = catalog.id
    WHERE attempt.id = NEW.attempt_id AND attempt.run_id = NEW.run_id
      AND attempt.cell_id = NEW.cell_id AND attempt.attempt_number = NEW.dispatch_generation
      AND attempt.status = 'started' AND attempt.context_trace_id IS NULL
      AND attempt.model_invocation_id IS NULL AND cell.state = 'planned' AND run.status = 'running'
      AND cell.model_slot_id = NEW.model_slot_id
      AND target.target_hash = NEW.target_hash
      AND target.pricing_snapshot_hash = NEW.pricing_snapshot_hash
      AND target.currency = NEW.currency
      AND profile.request_profile_hash = NEW.request_profile_hash
      AND baseline.compiled_baseline_hash = NEW.context_baseline_hash
      AND protocol.prompt_template_hash = NEW.prompt_template_hash
      AND ((cell.arm = 'no_skill' AND NEW.skill_configuration_hash IS NULL)
        OR (cell.arm <> 'no_skill' AND NEW.skill_configuration_hash = cell.arm_configuration_hash))
      AND ((cell.arm = 'core_genre_preferences'
            AND NEW.preference_configuration_hash = (
              SELECT preference_configuration_hash FROM novel_skill_evaluation_suites
              WHERE id = cell.suite_id))
        OR (cell.arm <> 'core_genre_preferences' AND NEW.preference_configuration_hash IS NULL))
      AND CAST(NEW.reserved_max_cost_micros AS INTEGER) <= CAST(limits.hard_ceiling_micros AS INTEGER)
      AND connection.enabled = 1 AND connection.connection_status = 'ready'
      AND connection.credential_state = 'present'
      AND connection.revision = target.connection_revision
      AND connection.provider_kind = target.provider_kind_snapshot
      AND connection.protocol = target.connection_protocol_snapshot
      AND catalog.connection_id = connection.id AND catalog.availability = 'available'
      AND catalog.revision = target.catalog_revision
      AND catalog.provider_model_id = target.provider_model_id_snapshot
      AND cost.revision = target.cost_profile_revision AND cost.currency = target.currency
      AND cost.input_micros_per_million_tokens = target.input_micros_per_million_tokens
      AND cost.output_micros_per_million_tokens = target.output_micros_per_million_tokens
      AND cost.cached_input_micros_per_million_tokens IS target.cached_input_micros_per_million_tokens
      AND cost.data_destination = NEW.data_destination
      AND cost.pricing_version = target.pricing_version AND cost.price_updated_at = target.price_updated_at
  )
  OR EXISTS (
    SELECT 1 FROM novel_skill_evaluation_dispatch_reservations AS prior
    WHERE prior.cell_id = NEW.cell_id AND prior.state IN ('reserved','bound','dispatched','settled','ambiguous'))
  OR (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations
      WHERE authorization_id = NEW.authorization_id AND state <> 'not_dispatched') >= 192
  OR CAST(NEW.reserved_max_cost_micros AS INTEGER) + COALESCE((
       SELECT sum(CAST(reserved_max_cost_micros AS INTEGER))
       FROM novel_skill_evaluation_dispatch_reservations
       WHERE authorization_id = NEW.authorization_id AND currency = NEW.currency
         AND state <> 'not_dispatched'), 0) > CAST((
       SELECT hard_ceiling_micros FROM novel_skill_evaluation_authorization_limits
       WHERE authorization_id = NEW.authorization_id AND currency = NEW.currency) AS INTEGER)
  OR EXISTS (
    SELECT 1 FROM novel_skill_evaluation_dispatch_reservations AS peer
    INNER JOIN novel_skill_evaluation_cells AS peer_cell ON peer_cell.id = peer.cell_id
    INNER JOIN novel_skill_evaluation_cells AS new_cell ON new_cell.id = NEW.cell_id
    WHERE peer.run_id = NEW.run_id AND peer_cell.fixture_id = new_cell.fixture_id
      AND peer_cell.model_slot_id = new_cell.model_slot_id
      AND peer_cell.repetition = new_cell.repetition
      AND (peer.request_profile_hash <> NEW.request_profile_hash
        OR peer.context_baseline_hash <> NEW.context_baseline_hash
        OR peer.prompt_template_hash <> NEW.prompt_template_hash
        OR peer.invariant_request_hash <> NEW.invariant_request_hash)
  )
BEGIN SELECT RAISE(ABORT, 'evaluation dispatch reservation violates authority or only-variable controls'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_attempt_reservation_bind_guard
BEFORE UPDATE OF context_trace_id, model_invocation_id ON novel_skill_evaluation_attempts
WHEN NEW.context_trace_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM novel_skill_evaluation_runs AS run
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
  WHERE run.id = NEW.run_id
)
AND NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations AS reservation
  WHERE reservation.attempt_id = NEW.id AND reservation.state = 'reserved'
    AND reservation.planned_context_trace_id = NEW.context_trace_id
    AND reservation.planned_model_invocation_id = NEW.model_invocation_id
)
BEGIN SELECT RAISE(ABORT, 'evaluation attempt lacks its exact reserved dispatch'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_reservation_revision_guard
BEFORE UPDATE ON novel_skill_evaluation_dispatch_reservations
WHEN NEW.id <> OLD.id OR NEW.authorization_id <> OLD.authorization_id
  OR NEW.run_id <> OLD.run_id OR NEW.cell_id <> OLD.cell_id OR NEW.attempt_id <> OLD.attempt_id
  OR NEW.model_slot_id <> OLD.model_slot_id OR NEW.dispatch_generation <> OLD.dispatch_generation
  OR NEW.planned_context_trace_id <> OLD.planned_context_trace_id
  OR NEW.planned_model_invocation_id <> OLD.planned_model_invocation_id
  OR NEW.planned_candidate_id <> OLD.planned_candidate_id
  OR NEW.target_hash <> OLD.target_hash OR NEW.pricing_snapshot_hash <> OLD.pricing_snapshot_hash
  OR NEW.request_profile_hash <> OLD.request_profile_hash
  OR NEW.context_baseline_hash <> OLD.context_baseline_hash
  OR NEW.prompt_template_hash <> OLD.prompt_template_hash
  OR NEW.invariant_request_hash <> OLD.invariant_request_hash
  OR NEW.request_payload_hash <> OLD.request_payload_hash
  OR NEW.execution_lock_hash <> OLD.execution_lock_hash
  OR NEW.message_payload_hash <> OLD.message_payload_hash
  OR NEW.payload_authority_version <> OLD.payload_authority_version
  OR NEW.payload_authority_manifest_hash <> OLD.payload_authority_manifest_hash
  OR NEW.data_destination <> OLD.data_destination
  OR NEW.skill_configuration_hash IS NOT OLD.skill_configuration_hash
  OR NEW.preference_configuration_hash IS NOT OLD.preference_configuration_hash
  OR NEW.idempotency_key_hash <> OLD.idempotency_key_hash OR NEW.currency <> OLD.currency
  OR NEW.reserved_max_cost_micros <> OLD.reserved_max_cost_micros
  OR NEW.reserved_at <> OLD.reserved_at OR NEW.revision <> OLD.revision + 1
  OR (OLD.bound_at IS NOT NULL AND NEW.bound_at IS NOT OLD.bound_at)
  OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
  OR (NEW.bound_at IS NOT NULL AND NEW.bound_at < OLD.reserved_at)
  OR (NEW.dispatched_at IS NOT NULL
      AND (NEW.bound_at IS NULL OR NEW.dispatched_at < NEW.bound_at))
  OR (NEW.terminal_at IS NOT NULL
      AND NEW.terminal_at < COALESCE(NEW.dispatched_at, NEW.bound_at, OLD.reserved_at))
  OR OLD.state IN ('settled','ambiguous','not_dispatched')
  OR NOT (
    (OLD.state = 'reserved' AND NEW.state = 'bound' AND NEW.bound_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM novel_skill_evaluation_attempts AS attempt
        WHERE attempt.id = OLD.attempt_id
          AND attempt.context_trace_id = OLD.planned_context_trace_id
          AND attempt.model_invocation_id = OLD.planned_model_invocation_id))
    OR (OLD.state = 'bound' AND NEW.state = 'dispatched' AND NEW.dispatched_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM novel_skill_evaluation_runs AS run
        WHERE run.id = OLD.run_id AND run.status = 'running'
      )
      AND EXISTS (
        SELECT 1
        FROM novel_skill_evaluation_run_model_targets AS target
        INNER JOIN model_provider_connections AS connection ON connection.id = target.connection_id
        INNER JOIN model_catalog_entries AS catalog ON catalog.id = target.catalog_entry_id
        INNER JOIN model_cost_privacy_profiles AS cost ON cost.catalog_entry_id = catalog.id
        WHERE target.run_id = OLD.run_id AND target.model_slot_id = OLD.model_slot_id
          AND target.target_hash = OLD.target_hash
          AND target.pricing_snapshot_hash = OLD.pricing_snapshot_hash
          AND connection.enabled = 1 AND connection.connection_status = 'ready'
          AND connection.credential_state = 'present'
          AND connection.revision = target.connection_revision
          AND connection.provider_kind = target.provider_kind_snapshot
          AND connection.protocol = target.connection_protocol_snapshot
          AND catalog.connection_id = connection.id AND catalog.availability = 'available'
          AND catalog.revision = target.catalog_revision
          AND catalog.provider_model_id = target.provider_model_id_snapshot
          AND cost.revision = target.cost_profile_revision AND cost.currency = target.currency
          AND cost.input_micros_per_million_tokens = target.input_micros_per_million_tokens
          AND cost.output_micros_per_million_tokens = target.output_micros_per_million_tokens
          AND cost.cached_input_micros_per_million_tokens
              IS target.cached_input_micros_per_million_tokens
          AND cost.pricing_version = target.pricing_version
          AND cost.price_updated_at = target.price_updated_at
      ))
    OR (OLD.state IN ('reserved','bound') AND NEW.state = 'not_dispatched'
      AND ((OLD.state = 'reserved' AND NEW.bound_at IS NULL)
        OR (OLD.state = 'bound' AND NEW.bound_at IS OLD.bound_at))
      AND EXISTS (
        SELECT 1 FROM novel_skill_evaluation_attempts AS attempt
        WHERE attempt.id = OLD.attempt_id AND attempt.status = 'cancelled'
          AND attempt.error_code = 'PRE_DISPATCH_CANCELLED'
          AND ((OLD.state = 'reserved' AND attempt.context_trace_id IS NULL
                AND attempt.model_invocation_id IS NULL)
            OR (OLD.state = 'bound'
                AND attempt.context_trace_id = OLD.planned_context_trace_id
                AND attempt.model_invocation_id = OLD.planned_model_invocation_id
                AND EXISTS (
                  SELECT 1 FROM model_invocation_facts AS invocation
                  WHERE invocation.id = OLD.planned_model_invocation_id
                    AND invocation.status = 'cancelled'
                    AND invocation.started_at IS NOT NULL
                    AND invocation.completed_at IS NOT NULL)))))
    OR (OLD.state = 'dispatched' AND NEW.state = 'ambiguous'
      AND EXISTS (
        SELECT 1 FROM novel_skill_evaluation_attempts AS attempt
        INNER JOIN model_invocation_facts AS invocation
          ON invocation.id = OLD.planned_model_invocation_id
        WHERE attempt.id = OLD.attempt_id AND attempt.status = 'cancelled'
          AND attempt.error_code = 'DISPATCH_INTERRUPTED'
          AND invocation.status = 'failed'
          AND invocation.error_code = 'DISPATCH_INTERRUPTED'))
    OR (OLD.state = 'dispatched' AND NEW.state = 'settled')
  )
BEGIN SELECT RAISE(ABORT, 'evaluation dispatch reservation transition is invalid'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_settlement_evidence_guard
BEFORE UPDATE OF state ON novel_skill_evaluation_dispatch_reservations
WHEN OLD.state = 'dispatched' AND NEW.state = 'settled'
AND (
  (NEW.settlement_outcome = 'succeeded' AND NOT EXISTS (
    SELECT 1
    FROM ai_candidates AS candidate
    INNER JOIN context_compilation_output_candidate_links AS output_link
      ON output_link.ai_candidate_id = candidate.id
    INNER JOIN model_invocation_facts AS invocation
      ON invocation.id = NEW.planned_model_invocation_id
    INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = NEW.cell_id
    INNER JOIN novel_skill_evaluation_fixtures AS fixture
      ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
    INNER JOIN novel_skill_evaluation_request_profiles AS profile
      ON profile.suite_id = fixture.suite_id AND profile.task_type = fixture.task_type
    WHERE candidate.id = NEW.output_candidate_id
      AND candidate.id = NEW.planned_candidate_id
      AND candidate.chapter_id IS NULL AND candidate.base_version_id IS NULL
      AND candidate.status = 'ready' AND candidate.incomplete = 0
      AND candidate.content_checksum = NEW.provider_visible_output_hash
      AND output_link.trace_id = NEW.planned_context_trace_id
      AND invocation.status = 'succeeded' AND invocation.visible_content_length > 0
      AND invocation.error_code IS NULL AND invocation.streamed = profile.streaming
      AND invocation.requested_max_output_tokens = profile.maximum_output_tokens
      AND profile.request_profile_hash = NEW.request_profile_hash
  ))
  OR (NEW.settlement_outcome <> 'succeeded' AND EXISTS (
    SELECT 1 FROM ai_candidates WHERE id = NEW.planned_candidate_id
  ))
  OR NOT EXISTS (
    SELECT 1
    FROM novel_skill_evaluation_attempts AS attempt
    INNER JOIN model_invocation_facts AS invocation
      ON invocation.id = NEW.planned_model_invocation_id
    WHERE attempt.id = NEW.attempt_id
      AND attempt.context_trace_id = NEW.planned_context_trace_id
      AND attempt.model_invocation_id = NEW.planned_model_invocation_id
      AND ((NEW.settlement_outcome = 'succeeded'
            AND attempt.status = 'succeeded' AND attempt.error_code IS NULL
            AND invocation.status = 'succeeded' AND invocation.error_code IS NULL)
        OR (NEW.settlement_outcome = 'cancelled'
            AND attempt.status = 'cancelled' AND attempt.error_code = 'USER_CANCELLED'
            AND invocation.status = 'cancelled' AND invocation.error_code IS NULL)
        OR (NEW.settlement_outcome = 'timed_out'
            AND attempt.status = 'failed' AND attempt.error_code = 'MODEL_TIMEOUT'
            AND invocation.status = 'timed_out' AND invocation.error_code = 'MODEL_TIMEOUT')
        OR (NEW.settlement_outcome = 'policy_blocked'
            AND attempt.status = 'failed' AND attempt.error_code = 'MODEL_POLICY_BLOCKED'
            AND invocation.status = 'failed' AND invocation.error_code = 'MODEL_POLICY_BLOCKED')
        OR (NEW.settlement_outcome = 'failed'
            AND attempt.status = 'failed'
            AND attempt.error_code NOT IN ('MODEL_TIMEOUT','MODEL_POLICY_BLOCKED')
            AND invocation.status = 'failed'
            AND invocation.error_code = attempt.error_code))
  )
)
BEGIN SELECT RAISE(ABORT, 'evaluation settlement lacks exact visible Candidate evidence'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_trace_ownership_insert_guard
BEFORE INSERT ON context_compilation_runs
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites AS suite
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = suite.id
  WHERE suite.evaluation_project_id = NEW.project_id
)
AND NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations AS reservation
  INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = reservation.cell_id
  INNER JOIN novel_skill_evaluation_fixtures AS fixture
    ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
  WHERE reservation.planned_context_trace_id = NEW.id AND reservation.state = 'reserved'
    AND reservation.run_id = cell.run_id AND fixture.task_type = NEW.task_type
    AND NEW.chapter_id IS NULL
)
BEGIN SELECT RAISE(ABORT, 'evaluation trace lacks a reserved owner'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_trace_ownership_update_guard
BEFORE UPDATE OF project_id ON context_compilation_runs
WHEN NEW.project_id IS NOT OLD.project_id AND (
  EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = suite.id
    WHERE suite.evaluation_project_id = OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = suite.id
    WHERE suite.evaluation_project_id = NEW.project_id
  )
)
BEGIN SELECT RAISE(ABORT, 'evaluation trace ownership cannot move between projects'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_candidate_ownership_insert_guard
BEFORE INSERT ON ai_candidates
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_suites AS suite
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = suite.id
  WHERE suite.evaluation_project_id = NEW.project_id
)
AND NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations AS reservation
  INNER JOIN novel_skill_evaluation_runs AS run ON run.id = reservation.run_id
  INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
  WHERE reservation.planned_candidate_id = NEW.id AND reservation.state = 'dispatched'
    AND suite.evaluation_project_id = NEW.project_id AND NEW.chapter_id IS NULL
    AND NEW.base_version_id IS NULL
)
BEGIN SELECT RAISE(ABORT, 'evaluation Candidate lacks a dispatched owner'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_candidate_ownership_update_guard
BEFORE UPDATE OF project_id ON ai_candidates
WHEN NEW.project_id IS NOT OLD.project_id AND (
  EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = suite.id
    WHERE suite.evaluation_project_id = OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM novel_skill_evaluation_suites AS suite
    INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = suite.id
    WHERE suite.evaluation_project_id = NEW.project_id
  )
)
BEGIN SELECT RAISE(ABORT, 'evaluation Candidate ownership cannot move between projects'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_model_link_ownership_insert_guard
BEFORE INSERT ON context_compilation_model_invocation_links
WHEN EXISTS (
  SELECT 1 FROM context_compilation_runs AS trace
  INNER JOIN novel_skill_evaluation_suites AS suite ON suite.evaluation_project_id = trace.project_id
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = suite.id
  WHERE trace.id = NEW.trace_id
)
AND NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations AS reservation
  WHERE reservation.planned_context_trace_id = NEW.trace_id
    AND reservation.planned_model_invocation_id = NEW.model_invocation_id
    AND reservation.state IN ('reserved','bound')
)
BEGIN SELECT RAISE(ABORT, 'evaluation model link lacks its reserved owner'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_output_link_ownership_insert_guard
BEFORE INSERT ON context_compilation_output_candidate_links
WHEN EXISTS (
  SELECT 1 FROM context_compilation_runs AS trace
  INNER JOIN novel_skill_evaluation_suites AS suite ON suite.evaluation_project_id = trace.project_id
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = suite.id
  WHERE trace.id = NEW.trace_id
)
AND NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations AS reservation
  WHERE reservation.planned_context_trace_id = NEW.trace_id
    AND reservation.planned_candidate_id = NEW.ai_candidate_id
    AND reservation.state = 'dispatched'
)
BEGIN SELECT RAISE(ABORT, 'evaluation output link lacks its dispatched owner'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_observation_dispatch_guard
BEFORE INSERT ON novel_skill_evaluation_observations
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_runs AS run
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
  WHERE run.id = NEW.run_id
)
AND NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations AS reservation
  INNER JOIN ai_candidates AS candidate ON candidate.id = reservation.output_candidate_id
  WHERE reservation.run_id = NEW.run_id AND reservation.cell_id = NEW.cell_id
    AND reservation.attempt_id = NEW.attempt_id AND reservation.state = 'settled'
    AND reservation.settlement_outcome = 'succeeded'
    AND reservation.planned_context_trace_id = NEW.context_trace_id
    AND reservation.planned_model_invocation_id = NEW.model_invocation_id
    AND reservation.output_candidate_id = NEW.output_candidate_id
    AND reservation.planned_candidate_id = NEW.output_candidate_id
    AND reservation.provider_visible_output_hash = candidate.content_checksum
)
BEGIN SELECT RAISE(ABORT, 'evaluation observation lacks exact settled visible output evidence'); END;

-- A successful provider settlement is already a paid evidence boundary.  The
-- 0061 observation may be materialized in a later local transaction after a
-- restart, so freeze the exact Candidate/trace/invocation chain immediately at
-- settlement rather than leaving a mutation window until that observation is
-- written.
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_candidate_update_guard
BEFORE UPDATE ON ai_candidates
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND output_candidate_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation Candidate is frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_candidate_delete_guard
BEFORE DELETE ON ai_candidates
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND output_candidate_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation Candidate cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_trace_update_guard
BEFORE UPDATE ON context_compilation_runs
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation trace is frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_trace_delete_guard
BEFORE DELETE ON context_compilation_runs
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation trace cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_entry_insert_guard
BEFORE INSERT ON context_compilation_entries
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = NEW.run_id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation trace cannot gain entries'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_entry_update_guard
BEFORE UPDATE ON context_compilation_entries
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = OLD.run_id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation entries are frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_entry_delete_guard
BEFORE DELETE ON context_compilation_entries
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = OLD.run_id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation entries cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_source_insert_guard
BEFORE INSERT ON context_compilation_entry_sources
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = NEW.run_id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation trace cannot gain sources'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_source_update_guard
BEFORE UPDATE ON context_compilation_entry_sources
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = OLD.run_id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation sources are frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_source_delete_guard
BEFORE DELETE ON context_compilation_entry_sources
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = OLD.run_id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation sources cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_invocation_update_guard
BEFORE UPDATE ON model_invocation_facts
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_model_invocation_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation invocation is frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_invocation_delete_guard
BEFORE DELETE ON model_invocation_facts
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_model_invocation_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation invocation cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_execution_link_insert_guard
BEFORE INSERT ON context_compilation_execution_links
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = NEW.trace_id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation execution links are frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_execution_link_delete_guard
BEFORE DELETE ON context_compilation_execution_links
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND planned_context_trace_id = OLD.trace_id
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation execution links cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_model_link_insert_guard
BEFORE INSERT ON context_compilation_model_invocation_links
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND (planned_context_trace_id = NEW.trace_id
      OR planned_model_invocation_id = NEW.model_invocation_id)
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation model links are frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_model_link_delete_guard
BEFORE DELETE ON context_compilation_model_invocation_links
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND (planned_context_trace_id = OLD.trace_id
      OR planned_model_invocation_id = OLD.model_invocation_id)
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation model links cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_output_link_insert_guard
BEFORE INSERT ON context_compilation_output_candidate_links
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND (planned_context_trace_id = NEW.trace_id OR output_candidate_id = NEW.ai_candidate_id)
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation output links are frozen'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_paid_settled_output_link_delete_guard
BEFORE DELETE ON context_compilation_output_candidate_links
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
  WHERE state = 'settled' AND settlement_outcome = 'succeeded'
    AND (planned_context_trace_id = OLD.trace_id OR output_candidate_id = OLD.ai_candidate_id)
)
BEGIN SELECT RAISE(ABORT, 'settled evaluation output links cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_review_batches (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36 AND id = lower(id)
    AND substr(id, 15, 1) = '7' AND substr(id, 20, 1) IN ('8','9','a','b')
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT NOT NULL UNIQUE REFERENCES novel_skill_evaluation_runs(id) ON DELETE RESTRICT,
  protocol_hash TEXT NOT NULL CHECK (length(protocol_hash) = 64 AND protocol_hash = lower(protocol_hash)
    AND protocol_hash NOT GLOB '*[^0-9a-f]*'),
  rubric_version TEXT NOT NULL CHECK (rubric_version = 'novel-skill-human-rubric@1'),
  rubric_content_hash TEXT NOT NULL CHECK (length(rubric_content_hash) = 64
    AND rubric_content_hash = lower(rubric_content_hash)
    AND rubric_content_hash NOT GLOB '*[^0-9a-f]*'),
  blinding_protocol_version TEXT NOT NULL CHECK (length(blinding_protocol_version) BETWEEN 3 AND 96),
  blinding_protocol_hash TEXT NOT NULL CHECK (length(blinding_protocol_hash) = 64
    AND blinding_protocol_hash = lower(blinding_protocol_hash)
    AND blinding_protocol_hash NOT GLOB '*[^0-9a-f]*'),
  randomization_protocol_version TEXT NOT NULL CHECK (length(randomization_protocol_version) BETWEEN 3 AND 96),
  randomization_protocol_hash TEXT NOT NULL CHECK (length(randomization_protocol_hash) = 64
    AND randomization_protocol_hash = lower(randomization_protocol_hash)
    AND randomization_protocol_hash NOT GLOB '*[^0-9a-f]*'),
  randomization_seed_hash TEXT NOT NULL CHECK (length(randomization_seed_hash) = 64
    AND randomization_seed_hash = lower(randomization_seed_hash)
    AND randomization_seed_hash NOT GLOB '*[^0-9a-f]*'),
  observation_set_hash TEXT NOT NULL CHECK (length(observation_set_hash) = 64
    AND observation_set_hash = lower(observation_set_hash)
    AND observation_set_hash NOT GLOB '*[^0-9a-f]*'),
  assignment_manifest_hash TEXT NOT NULL CHECK (length(assignment_manifest_hash) = 64
    AND assignment_manifest_hash = lower(assignment_manifest_hash)
    AND assignment_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  reviewer_id TEXT NOT NULL CHECK (length(reviewer_id) BETWEEN 3 AND 128
    AND reviewer_id GLOB '[a-z0-9]*' AND reviewer_id NOT GLOB '*[^a-z0-9._:-]*'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
);

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_review_items (
  batch_id TEXT NOT NULL REFERENCES novel_skill_evaluation_review_batches(id) ON DELETE RESTRICT,
  blind_item_id TEXT NOT NULL CHECK (length(blind_item_id) BETWEEN 16 AND 128
    AND blind_item_id NOT GLOB '*[^A-Za-z0-9_.:-]*'),
  observation_id TEXT NOT NULL UNIQUE
    REFERENCES novel_skill_evaluation_observations(id) ON DELETE RESTRICT,
  randomized_position INTEGER NOT NULL CHECK (randomized_position BETWEEN 1 AND 192),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64 AND evidence_hash = lower(evidence_hash)
    AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  assigned_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', assigned_at) = assigned_at),
  PRIMARY KEY (batch_id, blind_item_id),
  UNIQUE (batch_id, randomized_position)
);

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_review_receipts (
  batch_id TEXT NOT NULL,
  blind_item_id TEXT NOT NULL,
  observation_id TEXT NOT NULL UNIQUE
    REFERENCES novel_skill_evaluation_observations(id) ON DELETE RESTRICT,
  reviewer_id TEXT NOT NULL CHECK (length(reviewer_id) BETWEEN 3 AND 128
    AND reviewer_id GLOB '[a-z0-9]*' AND reviewer_id NOT GLOB '*[^a-z0-9._:-]*'),
  rubric_version TEXT NOT NULL CHECK (rubric_version = 'novel-skill-human-rubric@1'),
  rubric_content_hash TEXT NOT NULL CHECK (length(rubric_content_hash) = 64
    AND rubric_content_hash = lower(rubric_content_hash)
    AND rubric_content_hash NOT GLOB '*[^0-9a-f]*'),
  scores_manifest_hash TEXT NOT NULL CHECK (length(scores_manifest_hash) = 64
    AND scores_manifest_hash = lower(scores_manifest_hash)
    AND scores_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  scored_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', scored_at) = scored_at),
  sealed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', sealed_at) = sealed_at),
  PRIMARY KEY (batch_id, blind_item_id),
  FOREIGN KEY (batch_id, blind_item_id)
    REFERENCES novel_skill_evaluation_review_items(batch_id, blind_item_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_review_batch_insert_guard
BEFORE INSERT ON novel_skill_evaluation_review_batches
WHEN NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_runs AS run
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
  WHERE run.id = NEW.run_id AND run.status = 'running'
    AND protocol.protocol_hash = NEW.protocol_hash
    AND protocol.rubric_version = NEW.rubric_version
    AND protocol.rubric_content_hash = NEW.rubric_content_hash
    AND protocol.blinding_protocol_version = NEW.blinding_protocol_version
    AND protocol.blinding_protocol_hash = NEW.blinding_protocol_hash
    AND protocol.randomization_protocol_version = NEW.randomization_protocol_version
    AND protocol.randomization_protocol_hash = NEW.randomization_protocol_hash
    AND (SELECT count(*) FROM novel_skill_evaluation_observations
         WHERE run_id = run.id) = 192
)
BEGIN SELECT RAISE(ABORT, 'review batch lacks complete blinded protocol evidence'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_review_item_insert_guard
BEFORE INSERT ON novel_skill_evaluation_review_items
WHEN NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_review_batches AS batch
  INNER JOIN novel_skill_evaluation_observations AS observation
    ON observation.id = NEW.observation_id AND observation.run_id = batch.run_id
  WHERE batch.id = NEW.batch_id
)
BEGIN SELECT RAISE(ABORT, 'blind review item is outside its exact run'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_score_review_guard
BEFORE INSERT ON novel_skill_evaluation_scores
WHEN EXISTS (
  SELECT 1 FROM novel_skill_evaluation_observations AS observation
  INNER JOIN novel_skill_evaluation_runs AS run ON run.id = observation.run_id
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
  WHERE observation.id = NEW.observation_id
)
AND NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_review_items AS item
  INNER JOIN novel_skill_evaluation_review_batches AS batch ON batch.id = item.batch_id
  WHERE item.observation_id = NEW.observation_id
    AND batch.reviewer_id = NEW.reviewer_id AND batch.rubric_version = NEW.rubric_version
    AND NEW.scored_at >= item.assigned_at
)
BEGIN SELECT RAISE(ABORT, 'evaluation score lacks its blinded randomized assignment'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_review_receipt_insert_guard
BEFORE INSERT ON novel_skill_evaluation_review_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_review_items AS item
  INNER JOIN novel_skill_evaluation_review_batches AS batch ON batch.id = item.batch_id
  WHERE item.batch_id = NEW.batch_id AND item.blind_item_id = NEW.blind_item_id
    AND item.observation_id = NEW.observation_id
    AND batch.reviewer_id = NEW.reviewer_id AND batch.rubric_version = NEW.rubric_version
    AND batch.rubric_content_hash = NEW.rubric_content_hash
    AND NEW.scored_at >= item.assigned_at AND NEW.sealed_at >= NEW.scored_at
    AND (SELECT count(*) FROM novel_skill_evaluation_scores AS score
         WHERE score.observation_id = NEW.observation_id
           AND score.reviewer_id = NEW.reviewer_id
           AND score.rubric_version = NEW.rubric_version
           AND score.scored_at = NEW.scored_at) = 13
)
BEGIN SELECT RAISE(ABORT, 'review receipt lacks exact 13-metric blinded evidence'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_cell_review_receipt_guard
BEFORE UPDATE OF state ON novel_skill_evaluation_cells
WHEN OLD.state = 'planned' AND NEW.state = 'observed'
  AND EXISTS (
    SELECT 1 FROM novel_skill_evaluation_runs AS run
    INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
    WHERE run.id = OLD.run_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM novel_skill_evaluation_observations AS observation
    INNER JOIN novel_skill_evaluation_review_receipts AS receipt
      ON receipt.observation_id = observation.id
    WHERE observation.cell_id = OLD.id AND observation.run_id = OLD.run_id
  )
BEGIN SELECT RAISE(ABORT, 'observed evaluation cell lacks a sealed blind review'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_paid_run_complete_guard
BEFORE UPDATE OF status ON novel_skill_evaluation_runs
WHEN OLD.status = 'running' AND NEW.status = 'completed'
  AND EXISTS (SELECT 1 FROM novel_skill_evaluation_protocols WHERE suite_id = OLD.suite_id)
  AND (
    (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations
     WHERE run_id = OLD.id AND state = 'settled' AND settlement_outcome = 'succeeded') <> 192
    OR EXISTS (SELECT 1 FROM novel_skill_evaluation_dispatch_reservations
       WHERE run_id = OLD.id AND state IN ('reserved','bound','dispatched','ambiguous'))
    OR (SELECT count(*) FROM novel_skill_evaluation_review_items AS item
        INNER JOIN novel_skill_evaluation_review_batches AS batch ON batch.id = item.batch_id
        WHERE batch.run_id = OLD.id) <> 192
    OR (SELECT count(*) FROM novel_skill_evaluation_review_receipts AS receipt
        INNER JOIN novel_skill_evaluation_review_batches AS batch ON batch.id = receipt.batch_id
        WHERE batch.run_id = OLD.id) <> 192
  )
BEGIN SELECT RAISE(ABORT, 'paid evaluation run lacks exact dispatch and blind review evidence'); END;

-- Every new authority/evidence row is append-only. Workflow mutation is
-- limited to the reservation transition trigger above.
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_protocol_immutable
BEFORE UPDATE ON novel_skill_evaluation_protocols BEGIN SELECT RAISE(ABORT, 'evaluation protocol is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_protocol_delete_guard
BEFORE DELETE ON novel_skill_evaluation_protocols BEGIN SELECT RAISE(ABORT, 'evaluation protocol cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_request_profile_immutable
BEFORE UPDATE ON novel_skill_evaluation_request_profiles BEGIN SELECT RAISE(ABORT, 'evaluation request profile is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_request_profile_delete_guard
BEFORE DELETE ON novel_skill_evaluation_request_profiles BEGIN SELECT RAISE(ABORT, 'evaluation request profile cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_context_baseline_immutable
BEFORE UPDATE ON novel_skill_evaluation_context_baselines BEGIN SELECT RAISE(ABORT, 'evaluation baseline is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_context_baseline_delete_guard
BEFORE DELETE ON novel_skill_evaluation_context_baselines BEGIN SELECT RAISE(ABORT, 'evaluation baseline cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_target_immutable
BEFORE UPDATE ON novel_skill_evaluation_run_model_targets BEGIN SELECT RAISE(ABORT, 'evaluation target is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_target_delete_guard
BEFORE DELETE ON novel_skill_evaluation_run_model_targets BEGIN SELECT RAISE(ABORT, 'evaluation target cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_authorization_immutable
BEFORE UPDATE ON novel_skill_evaluation_dispatch_authorizations BEGIN SELECT RAISE(ABORT, 'evaluation authorization is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_authorization_delete_guard
BEFORE DELETE ON novel_skill_evaluation_dispatch_authorizations BEGIN SELECT RAISE(ABORT, 'evaluation authorization cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_authorization_limit_immutable
BEFORE UPDATE ON novel_skill_evaluation_authorization_limits BEGIN SELECT RAISE(ABORT, 'evaluation authorization limit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_authorization_limit_delete_guard
BEFORE DELETE ON novel_skill_evaluation_authorization_limits BEGIN SELECT RAISE(ABORT, 'evaluation authorization limit cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_reservation_delete_guard
BEFORE DELETE ON novel_skill_evaluation_dispatch_reservations BEGIN SELECT RAISE(ABORT, 'evaluation reservation cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_review_batch_immutable
BEFORE UPDATE ON novel_skill_evaluation_review_batches BEGIN SELECT RAISE(ABORT, 'evaluation review batch is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_review_batch_delete_guard
BEFORE DELETE ON novel_skill_evaluation_review_batches BEGIN SELECT RAISE(ABORT, 'evaluation review batch cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_review_item_immutable
BEFORE UPDATE ON novel_skill_evaluation_review_items BEGIN SELECT RAISE(ABORT, 'evaluation review item is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_review_item_delete_guard
BEFORE DELETE ON novel_skill_evaluation_review_items BEGIN SELECT RAISE(ABORT, 'evaluation review item cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_review_receipt_immutable
BEFORE UPDATE ON novel_skill_evaluation_review_receipts BEGIN SELECT RAISE(ABORT, 'evaluation review receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_review_receipt_delete_guard
BEFORE DELETE ON novel_skill_evaluation_review_receipts BEGIN SELECT RAISE(ABORT, 'evaluation review receipt cannot be deleted'); END;
