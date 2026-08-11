-- Forward-only content-free predispatch authority for paid Novel Skill A/B runs.
--
-- One immutable row freezes the complete hash-only payload authority manifest,
-- exact target/capability lock, exact predispatch maximum cost, and the
-- recomputable provider-receipt/final-dispatch authority shapes.  It never
-- stores prompts, chapter or fixture prose, provider output, reasoning, or
-- credentials.

CREATE TABLE IF NOT EXISTS novel_skill_evaluation_predispatch_authority_snapshots (
  reservation_id TEXT PRIMARY KEY NOT NULL
    REFERENCES novel_skill_evaluation_dispatch_reservations(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  authority_snapshot_version TEXT NOT NULL
    CHECK (authority_snapshot_version = 'novel-skill-paid-predispatch-authority@1'),

  payload_authority_schema_version INTEGER NOT NULL
    CHECK (payload_authority_schema_version = 1),
  payload_authority_version TEXT NOT NULL
    CHECK (payload_authority_version = 'novel-skill-paid-payload-authority@1'),
  payload_authority_manifest_hash TEXT NOT NULL CHECK (
    length(payload_authority_manifest_hash) = 64
    AND payload_authority_manifest_hash = lower(payload_authority_manifest_hash)
    AND payload_authority_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT NOT NULL CHECK (length(run_id) = 36),
  suite_id TEXT NOT NULL CHECK (length(suite_id) = 36),
  cell_id TEXT NOT NULL CHECK (length(cell_id) = 36),
  fixture_id TEXT NOT NULL CHECK (length(fixture_id) BETWEEN 1 AND 128),
  fixture_contract_hash TEXT NOT NULL CHECK (
    length(fixture_contract_hash) = 64 AND fixture_contract_hash = lower(fixture_contract_hash)
    AND fixture_contract_hash NOT GLOB '*[^0-9a-f]*'),
  fixture_input_content_hash TEXT NOT NULL CHECK (
    length(fixture_input_content_hash) = 64
    AND fixture_input_content_hash = lower(fixture_input_content_hash)
    AND fixture_input_content_hash NOT GLOB '*[^0-9a-f]*'),
  task_type TEXT NOT NULL CHECK (length(task_type) BETWEEN 1 AND 128),
  invocation_mode TEXT NOT NULL CHECK (length(invocation_mode) BETWEEN 1 AND 128),
  genre_tags_hash TEXT NOT NULL CHECK (
    length(genre_tags_hash) = 64 AND genre_tags_hash = lower(genre_tags_hash)
    AND genre_tags_hash NOT GLOB '*[^0-9a-f]*'),
  coverage_dimensions_hash TEXT NOT NULL CHECK (
    length(coverage_dimensions_hash) = 64
    AND coverage_dimensions_hash = lower(coverage_dimensions_hash)
    AND coverage_dimensions_hash NOT GLOB '*[^0-9a-f]*'),
  arm TEXT NOT NULL CHECK (arm IN ('no_skill','core','core_genre','core_genre_preferences')),
  arm_configuration_hash TEXT CHECK (arm_configuration_hash IS NULL OR (
    length(arm_configuration_hash) = 64
    AND arm_configuration_hash = lower(arm_configuration_hash)
    AND arm_configuration_hash NOT GLOB '*[^0-9a-f]*')),
  model_slot_id TEXT NOT NULL CHECK (model_slot_id IN ('text_tier_a','text_tier_b')),
  repetition INTEGER NOT NULL CHECK (repetition IN (1,2)),
  prompt_template_version TEXT NOT NULL
    CHECK (prompt_template_version = 'novel-skill-paid-prompt@1'),
  prompt_template_hash TEXT NOT NULL CHECK (
    length(prompt_template_hash) = 64 AND prompt_template_hash = lower(prompt_template_hash)
    AND prompt_template_hash NOT GLOB '*[^0-9a-f]*'),
  context_baseline_hash TEXT NOT NULL CHECK (
    length(context_baseline_hash) = 64 AND context_baseline_hash = lower(context_baseline_hash)
    AND context_baseline_hash NOT GLOB '*[^0-9a-f]*'),
  context_baseline_projection_hash TEXT NOT NULL CHECK (
    length(context_baseline_projection_hash) = 64
    AND context_baseline_projection_hash = lower(context_baseline_projection_hash)
    AND context_baseline_projection_hash NOT GLOB '*[^0-9a-f]*'),
  available_context_layers_hash TEXT NOT NULL CHECK (
    length(available_context_layers_hash) = 64
    AND available_context_layers_hash = lower(available_context_layers_hash)
    AND available_context_layers_hash NOT GLOB '*[^0-9a-f]*'),
  skill_compiler_version TEXT NOT NULL CHECK (skill_compiler_version = 'novel-skill-compiler@1'),
  skill_selection_hash TEXT CHECK (skill_selection_hash IS NULL OR (
    length(skill_selection_hash) = 64 AND skill_selection_hash = lower(skill_selection_hash)
    AND skill_selection_hash NOT GLOB '*[^0-9a-f]*')),
  compiled_skill_snapshot_hash TEXT CHECK (compiled_skill_snapshot_hash IS NULL OR (
    length(compiled_skill_snapshot_hash) = 64
    AND compiled_skill_snapshot_hash = lower(compiled_skill_snapshot_hash)
    AND compiled_skill_snapshot_hash NOT GLOB '*[^0-9a-f]*')),
  rendered_skill_section_hash TEXT CHECK (rendered_skill_section_hash IS NULL OR (
    length(rendered_skill_section_hash) = 64
    AND rendered_skill_section_hash = lower(rendered_skill_section_hash)
    AND rendered_skill_section_hash NOT GLOB '*[^0-9a-f]*')),
  preference_configuration_hash TEXT CHECK (preference_configuration_hash IS NULL OR (
    length(preference_configuration_hash) = 64
    AND preference_configuration_hash = lower(preference_configuration_hash)
    AND preference_configuration_hash NOT GLOB '*[^0-9a-f]*')),
  preference_projection_hash TEXT CHECK (preference_projection_hash IS NULL OR (
    length(preference_projection_hash) = 64
    AND preference_projection_hash = lower(preference_projection_hash)
    AND preference_projection_hash NOT GLOB '*[^0-9a-f]*')),
  rendered_preference_section_hash TEXT CHECK (rendered_preference_section_hash IS NULL OR (
    length(rendered_preference_section_hash) = 64
    AND rendered_preference_section_hash = lower(rendered_preference_section_hash)
    AND rendered_preference_section_hash NOT GLOB '*[^0-9a-f]*')),
  base_message_payload_hash TEXT NOT NULL CHECK (
    length(base_message_payload_hash) = 64
    AND base_message_payload_hash = lower(base_message_payload_hash)
    AND base_message_payload_hash NOT GLOB '*[^0-9a-f]*'),
  message_payload_hash TEXT NOT NULL CHECK (
    length(message_payload_hash) = 64 AND message_payload_hash = lower(message_payload_hash)
    AND message_payload_hash NOT GLOB '*[^0-9a-f]*'),

  generation_id TEXT NOT NULL CHECK (length(generation_id) BETWEEN 1 AND 128),
  connection_id TEXT NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 128),
  catalog_entry_id TEXT NOT NULL CHECK (length(catalog_entry_id) BETWEEN 1 AND 128),
  provider_kind TEXT NOT NULL CHECK (length(provider_kind) BETWEEN 1 AND 128),
  provider_model_id TEXT NOT NULL CHECK (length(provider_model_id) BETWEEN 1 AND 512),
  connection_revision INTEGER NOT NULL CHECK (connection_revision >= 1),
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision >= 1),
  cost_privacy_revision INTEGER NOT NULL CHECK (cost_privacy_revision >= 1),
  capability_evidence_hash TEXT NOT NULL CHECK (
    length(capability_evidence_hash) = 64
    AND capability_evidence_hash = lower(capability_evidence_hash)
    AND capability_evidence_hash NOT GLOB '*[^0-9a-f]*'),
  cost_profile_hash TEXT NOT NULL CHECK (
    length(cost_profile_hash) = 64 AND cost_profile_hash = lower(cost_profile_hash)
    AND cost_profile_hash NOT GLOB '*[^0-9a-f]*'),
  target_identity_hash TEXT NOT NULL CHECK (
    length(target_identity_hash) = 64 AND target_identity_hash = lower(target_identity_hash)
    AND target_identity_hash NOT GLOB '*[^0-9a-f]*'),
  request_profile_hash TEXT NOT NULL CHECK (
    length(request_profile_hash) = 64 AND request_profile_hash = lower(request_profile_hash)
    AND request_profile_hash NOT GLOB '*[^0-9a-f]*'),
  request_payload_hash TEXT NOT NULL CHECK (
    length(request_payload_hash) = 64 AND request_payload_hash = lower(request_payload_hash)
    AND request_payload_hash NOT GLOB '*[^0-9a-f]*'),
  execution_lock_hash TEXT NOT NULL CHECK (
    length(execution_lock_hash) = 64 AND execution_lock_hash = lower(execution_lock_hash)
    AND execution_lock_hash NOT GLOB '*[^0-9a-f]*'),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  exact_predispatch_estimated_max_cost_micros TEXT NOT NULL CHECK (
    length(exact_predispatch_estimated_max_cost_micros) BETWEEN 1 AND 18
    AND exact_predispatch_estimated_max_cost_micros NOT GLOB '*[^0-9]*'
    AND (exact_predispatch_estimated_max_cost_micros = '0'
      OR substr(exact_predispatch_estimated_max_cost_micros, 1, 1) GLOB '[1-9]')),
  data_destination TEXT NOT NULL CHECK (data_destination IN ('local','remote')),

  provider_receipt_shape_version TEXT NOT NULL
    CHECK (provider_receipt_shape_version = 'model-hub-exact-evaluation-predispatch-receipt@1'),
  provider_receipt_shape_hash TEXT NOT NULL CHECK (
    length(provider_receipt_shape_hash) = 64
    AND provider_receipt_shape_hash = lower(provider_receipt_shape_hash)
    AND provider_receipt_shape_hash NOT GLOB '*[^0-9a-f]*'),
  final_dispatch_authority_version TEXT NOT NULL
    CHECK (final_dispatch_authority_version = 'novel-skill-paid-final-dispatch-authority@1'),
  final_dispatch_authority_hash TEXT NOT NULL CHECK (
    length(final_dispatch_authority_hash) = 64
    AND final_dispatch_authority_hash = lower(final_dispatch_authority_hash)
    AND final_dispatch_authority_hash NOT GLOB '*[^0-9a-f]*'),
  authority_snapshot_hash TEXT NOT NULL CHECK (
    length(authority_snapshot_hash) = 64
    AND authority_snapshot_hash = lower(authority_snapshot_hash)
    AND authority_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  captured_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', captured_at) = captured_at),

  CHECK (
    (arm = 'no_skill' AND arm_configuration_hash IS NULL
      AND skill_selection_hash IS NULL AND compiled_skill_snapshot_hash IS NULL
      AND rendered_skill_section_hash IS NULL AND preference_configuration_hash IS NULL
      AND preference_projection_hash IS NULL AND rendered_preference_section_hash IS NULL
      AND base_message_payload_hash = message_payload_hash)
    OR (arm IN ('core','core_genre') AND arm_configuration_hash IS NOT NULL
      AND skill_selection_hash IS NOT NULL AND compiled_skill_snapshot_hash IS NOT NULL
      AND rendered_skill_section_hash IS NOT NULL AND preference_configuration_hash IS NULL
      AND preference_projection_hash IS NULL AND rendered_preference_section_hash IS NULL)
    OR (arm = 'core_genre_preferences' AND arm_configuration_hash IS NOT NULL
      AND skill_selection_hash IS NOT NULL AND compiled_skill_snapshot_hash IS NOT NULL
      AND rendered_skill_section_hash IS NOT NULL AND preference_configuration_hash IS NOT NULL
      AND preference_projection_hash IS NOT NULL AND rendered_preference_section_hash IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS novel_skill_evaluation_predispatch_authority_run_idx
  ON novel_skill_evaluation_predispatch_authority_snapshots (run_id, cell_id);

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_predispatch_authority_insert_guard
BEFORE INSERT ON novel_skill_evaluation_predispatch_authority_snapshots
WHEN NOT EXISTS (
  SELECT 1
  FROM novel_skill_evaluation_dispatch_reservations AS reservation
  INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = reservation.cell_id
  INNER JOIN novel_skill_evaluation_fixtures AS fixture
    ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = cell.suite_id
  INNER JOIN novel_skill_evaluation_context_baselines AS baseline
    ON baseline.suite_id = cell.suite_id AND baseline.fixture_id = cell.fixture_id
  INNER JOIN novel_skill_evaluation_run_model_targets AS target
    ON target.run_id = reservation.run_id AND target.model_slot_id = reservation.model_slot_id
  WHERE reservation.id = NEW.reservation_id AND reservation.state = 'reserved'
    AND reservation.run_id = NEW.run_id AND cell.suite_id = NEW.suite_id
    AND reservation.cell_id = NEW.cell_id AND cell.fixture_id = NEW.fixture_id
    AND reservation.planned_model_invocation_id = NEW.generation_id
    AND fixture.contract_hash = NEW.fixture_contract_hash
    AND fixture.input_content_hash = NEW.fixture_input_content_hash
    AND fixture.task_type = NEW.task_type AND fixture.invocation_mode = NEW.invocation_mode
    AND cell.arm = NEW.arm AND cell.arm_configuration_hash IS NEW.arm_configuration_hash
    AND reservation.model_slot_id = NEW.model_slot_id AND cell.repetition = NEW.repetition
    AND protocol.prompt_template_version = NEW.prompt_template_version
    AND protocol.prompt_template_hash = NEW.prompt_template_hash
    AND baseline.compiled_baseline_hash = NEW.context_baseline_hash
    AND reservation.payload_authority_version = NEW.payload_authority_version
    AND reservation.payload_authority_manifest_hash = NEW.payload_authority_manifest_hash
    AND reservation.skill_configuration_hash IS NEW.arm_configuration_hash
    AND reservation.preference_configuration_hash IS NEW.preference_configuration_hash
    AND reservation.message_payload_hash = NEW.message_payload_hash
    AND reservation.request_profile_hash = NEW.request_profile_hash
    AND reservation.request_payload_hash = NEW.request_payload_hash
    AND reservation.execution_lock_hash = NEW.execution_lock_hash
    AND reservation.currency = NEW.currency AND reservation.data_destination = NEW.data_destination
    AND reservation.reserved_at = NEW.captured_at
    AND CAST(NEW.exact_predispatch_estimated_max_cost_micros AS INTEGER)
      <= CAST(reservation.reserved_max_cost_micros AS INTEGER)
    AND target.connection_id = NEW.connection_id
    AND target.catalog_entry_id = NEW.catalog_entry_id
    AND target.provider_kind_snapshot = NEW.provider_kind
    AND target.provider_model_id_snapshot = NEW.provider_model_id
    AND target.connection_revision = NEW.connection_revision
    AND target.catalog_revision = NEW.catalog_revision
    AND target.cost_profile_revision = NEW.cost_privacy_revision
    AND target.pricing_snapshot_hash = NEW.cost_profile_hash
    AND target.target_hash = NEW.target_identity_hash
)
BEGIN SELECT RAISE(ABORT, 'evaluation predispatch authority does not match its exact reservation'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_predispatch_authority_immutable_update
BEFORE UPDATE ON novel_skill_evaluation_predispatch_authority_snapshots
BEGIN SELECT RAISE(ABORT, 'evaluation predispatch authority is immutable'); END;

CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_predispatch_authority_immutable_delete
BEFORE DELETE ON novel_skill_evaluation_predispatch_authority_snapshots
BEGIN SELECT RAISE(ABORT, 'evaluation predispatch authority cannot be deleted'); END;

-- Binding is the last entirely local transition.  Requiring the sidecar here
-- ensures a legacy 0063 reservation can never drift into a provider-capable
-- state, while still allowing restart recovery to release it safely.
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_reservation_authority_bind_guard
BEFORE UPDATE OF state ON novel_skill_evaluation_dispatch_reservations
WHEN OLD.state = 'reserved' AND NEW.state = 'bound'
AND NOT EXISTS (
  SELECT 1
  FROM novel_skill_evaluation_predispatch_authority_snapshots AS snapshot
  INNER JOIN context_compilation_execution_links AS execution
    ON execution.trace_id = OLD.planned_context_trace_id
   AND execution.generation_id = snapshot.generation_id
  WHERE snapshot.reservation_id = OLD.id
    AND snapshot.run_id = OLD.run_id AND snapshot.cell_id = OLD.cell_id
    AND snapshot.model_slot_id = OLD.model_slot_id
    AND snapshot.generation_id = OLD.planned_model_invocation_id
    AND snapshot.payload_authority_manifest_hash = OLD.payload_authority_manifest_hash
    AND snapshot.request_profile_hash = OLD.request_profile_hash
    AND snapshot.message_payload_hash = OLD.message_payload_hash
    AND snapshot.request_payload_hash = OLD.request_payload_hash
    AND snapshot.execution_lock_hash = OLD.execution_lock_hash
)
BEGIN SELECT RAISE(ABORT, 'evaluation reservation lacks frozen predispatch authority'); END;

-- This transition is committed immediately before the native gateway call.
-- It is the authoritative hard gate for every real paid provider start.
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_reservation_authority_dispatch_guard
BEFORE UPDATE OF state ON novel_skill_evaluation_dispatch_reservations
WHEN OLD.state = 'bound' AND NEW.state = 'dispatched'
AND NOT EXISTS (
  SELECT 1
  FROM novel_skill_evaluation_predispatch_authority_snapshots AS snapshot
  INNER JOIN novel_skill_evaluation_run_model_targets AS target
    ON target.run_id = OLD.run_id AND target.model_slot_id = OLD.model_slot_id
  WHERE snapshot.reservation_id = OLD.id
    AND snapshot.run_id = OLD.run_id AND snapshot.cell_id = OLD.cell_id
    AND snapshot.model_slot_id = OLD.model_slot_id
    AND snapshot.generation_id = OLD.planned_model_invocation_id
    AND snapshot.payload_authority_manifest_hash = OLD.payload_authority_manifest_hash
    AND snapshot.target_identity_hash = OLD.target_hash
    AND snapshot.cost_profile_hash = OLD.pricing_snapshot_hash
    AND snapshot.request_profile_hash = OLD.request_profile_hash
    AND snapshot.message_payload_hash = OLD.message_payload_hash
    AND snapshot.request_payload_hash = OLD.request_payload_hash
    AND snapshot.execution_lock_hash = OLD.execution_lock_hash
    AND snapshot.currency = OLD.currency AND snapshot.data_destination = OLD.data_destination
    AND target.connection_id = snapshot.connection_id
    AND target.catalog_entry_id = snapshot.catalog_entry_id
    AND target.connection_revision = snapshot.connection_revision
    AND target.catalog_revision = snapshot.catalog_revision
    AND target.cost_profile_revision = snapshot.cost_privacy_revision
    AND target.target_hash = snapshot.target_identity_hash
    AND target.pricing_snapshot_hash = snapshot.cost_profile_hash
)
BEGIN SELECT RAISE(ABORT, 'evaluation provider dispatch lacks verifiable predispatch authority'); END;

-- A legacy dispatched row may only be closed as ambiguous.  It cannot be
-- represented as a verified provider settlement without the exact sidecar.
CREATE TRIGGER IF NOT EXISTS novel_skill_evaluation_reservation_authority_settlement_guard
BEFORE UPDATE OF state ON novel_skill_evaluation_dispatch_reservations
WHEN OLD.state = 'dispatched' AND NEW.state = 'settled'
AND NOT EXISTS (
  SELECT 1 FROM novel_skill_evaluation_predispatch_authority_snapshots AS snapshot
  WHERE snapshot.reservation_id = OLD.id
    AND snapshot.generation_id = OLD.planned_model_invocation_id
    AND snapshot.target_identity_hash = OLD.target_hash
    AND snapshot.request_profile_hash = OLD.request_profile_hash
    AND snapshot.request_payload_hash = OLD.request_payload_hash
    AND snapshot.execution_lock_hash = OLD.execution_lock_hash
)
BEGIN SELECT RAISE(ABORT, 'evaluation settlement lacks verifiable predispatch authority'); END;
