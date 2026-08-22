import {
  AppError,
  NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY,
  NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH,
  err,
  ok,
  type Result,
} from "@inkshadow/domain";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

export interface ForeignKeyViolation {
  readonly table: string;
  readonly rowId: number | null;
  readonly parent: string;
  readonly foreignKeyIndex: number;
}

export interface DatabaseIntegrityReport {
  readonly healthy: boolean;
  readonly integrityMessages: readonly string[];
  readonly foreignKeyViolations: readonly ForeignKeyViolation[];
}

export interface DatabaseBackupReceipt {
  readonly destinationKind: "user_selected_file";
  readonly integrityVerified: true;
}

export interface DatabaseRestoreReceipt {
  readonly sourceKind: "user_selected_file";
  readonly integrityVerified: true;
  readonly restoredTableCount: number;
}

interface IntegrityRow {
  integrity_check: string;
}

interface ForeignKeyRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

interface DatabaseListRow {
  readonly name: string;
  readonly file: string;
}

interface TableNameRow {
  readonly name: string;
}

interface TableColumnRow {
  readonly name: string;
}

interface SchemaContractRow {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}

interface TriggerDefinitionRow {
  readonly name: string;
  readonly sql: string | null;
}

interface FineTuningJobRestoreRow {
  readonly id: string;
  readonly datasetId: string;
  readonly datasetRevision: number;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

interface FineTuningDeploymentRestoreRow {
  readonly id: string;
}

const BACKUP_INCOMPATIBLE_OPERATION = "DATABASE_RESTORE_BACKUP_INCOMPATIBLE";
const MODEL_CAPABILITY_SCAN_V73_COLUMNS = [
  "id",
  "catalog_entry_id",
  "scan_kind",
  "status",
  "evidence_version",
  "supported_count",
  "unsupported_count",
  "unknown_count",
  "error_code",
  "error_summary",
  "requested_at",
  "started_at",
  "completed_at",
  "diagnostic_request_id",
  "failure_stage",
  "failure_retryable",
  "http_status",
  "finish_reason",
  "visible_content_length",
  "reasoning_present",
  "streamed",
  "attempt",
  "requested_max_output_tokens",
] as const;
const RESTORABLE_TABLES = [
  "writing_experience_preferences",
  "writing_provider_disclosure_grants",
  "projects",
  "project_seeds",
  "story_settings_import_receipts",
  "team_template_application_receipts",
  "project_team_template_settings",
  "project_team_template_prompt_refs",
  "project_team_template_prompt_rules",
  "project_team_template_checklist_items",
  "chapters",
  "chapter_versions",
  "continuous_story_state_route_receipts",
  "chapter_validation_snapshots",
  "causal_evidence_sources",
  "causal_events",
  "causal_event_participants",
  "causal_event_prerequisites",
  "causal_event_character_changes",
  "causal_event_relationship_changes",
  "causal_event_item_changes",
  "causal_event_informed_characters",
  "causal_event_foreshadow_progress",
  "causal_event_relations",
  "context_compilation_runs",
  "context_compilation_entries",
  "context_compilation_entry_sources",
  "context_compilation_execution_links",
  "context_compilation_model_invocation_links",
  "context_compilation_output_candidate_links",
  "consistency_investigation_runs",
  "consistency_investigation_steps",
  "consistency_investigation_findings",
  "consistency_investigation_evidence",
  "novel_skill_definitions",
  "project_novel_skill_bindings",
  "novel_skill_invocation_snapshots",
  "novel_skill_invocation_items",
  "novel_skill_evaluation_suites",
  "novel_skill_evaluation_fixtures",
  "novel_skill_evaluation_manifest_items",
  "novel_skill_evaluation_protocols",
  "novel_skill_evaluation_request_profiles",
  "novel_skill_evaluation_context_baselines",
  "novel_skill_evaluation_runs",
  "novel_skill_evaluation_run_model_targets",
  "novel_skill_evaluation_dispatch_authorizations",
  "novel_skill_evaluation_authorization_limits",
  "novel_skill_evaluation_cells",
  "novel_skill_evaluation_attempts",
  "novel_skill_evaluation_dispatch_reservations",
  "novel_skill_evaluation_predispatch_authority_snapshots",
  "novel_skill_evaluation_observations",
  "novel_skill_evaluation_review_batches",
  "novel_skill_evaluation_review_items",
  "novel_skill_evaluation_scores",
  "novel_skill_evaluation_review_receipts",
  "novel_skill_evaluation_manual_decisions",
  "writing_feedback_policies",
  "writing_preferences",
  "writing_preference_revisions",
  "recovery_drafts",
  "ai_candidates",
  "writing_feedback_events",
  "story_planning_candidates",
  "creative_journeys",
  "creative_journey_turns",
  "multi_agent_review_sessions",
  "multi_agent_review_participants",
  "multi_agent_review_turns",
  "multi_agent_review_conclusions",
  "multi_agent_review_source_references",
  "multi_agent_review_candidates",
  "governed_extension_budgets",
  "governed_extension_egress_receipts",
  "governed_extension_requests",
  "governed_extension_candidates",
  "governed_extension_audit_events",
  "chapter_translations",
  "short_drama_scripts",
  "local_audit_events",
  "background_tasks",
  "notifications",
  "story_outlines",
  "story_formal_records",
  "story_timeline_state",
  "story_review_items",
  "story_facts",
  "story_fact_revisions",
  "story_fact_legacy_links",
  "authoritative_story_graph_state",
  "authoritative_extraction_jobs",
  "authoritative_extraction_candidates",
  "authoritative_extraction_evaluations",
  "authoritative_extraction_decision_claims",
  "story_memory_policies",
  "story_memory_governance_events",
  "story_memory_records",
  "story_what_if_branches",
  "story_outline_drafts",
  "story_ideation_drafts",
  "story_materials",
  "story_material_references",
  "sync_ciphertext_chunks",
  "sync_outbox_operations",
  "sync_operation_chunks",
  "sync_tombstones",
  "sync_transfers",
  "sync_transfer_chunks",
  "sync_remote_checkpoints",
  "sync_device_sequences",
  "sync_incoming_batches",
  "sync_incremental_terminal_observations",
  "cloud_deletion_journals",
  "cloud_deletion_mutations",
  "sync_inbox_operations",
  "sync_inbox_operation_chunks",
  "sync_snapshot_staging_sessions",
  "sync_snapshot_staging_pages",
  "sync_snapshot_staging_operations",
  "sync_snapshot_staging_chunks",
  "sync_snapshot_staging_operation_chunks",
  "sync_snapshot_staging_tombstones",
  "sync_snapshot_materialization_receipts",
  "project_sync_registrations",
  "sync_materialized_objects",
  "sync_materialized_checkpoints",
  "sync_content_conflicts",
  "sync_projection_jobs",
  "project_key_versions",
  "team_project_key_receipts",
  "cloud_project_key_checkpoints",
  "cloud_project_key_publications",
  "cloud_account_snapshots",
  "registered_device_snapshots",
  "device_public_key_records",
  "project_device_key_envelopes",
  "project_recovery_key_envelopes",
  "cloud_session_snapshots",
  "entitlement_cache",
  "offline_license_envelopes",
  "team_membership_snapshots",
  "model_profiles",
  "model_pricing_profiles",
  "model_role_routes",
  "model_hub_connection_commits",
  "model_provider_connections",
  "model_catalog_syncs",
  "model_catalog_entries",
  "model_capability_scans",
  "model_capability_evidence",
  "model_cost_privacy_profiles",
  "model_evaluation_results",
  "model_hub_presets",
  "novel_task_routes",
  "model_invocation_facts",
  "ai_budget_policies",
  "ai_generation_runs",
  "ai_generation_route_selections",
  "ai_generation_attempt_usage",
  "ai_deferred_generation_requests",
  "fine_tuning_datasets",
  "fine_tuning_samples",
  "fine_tuning_approvals",
  "fine_tuning_quota_policies",
  "fine_tuning_jobs",
  "fine_tuning_model_artifacts",
  "fine_tuning_evaluations",
  "fine_tuning_deployments",
  "fine_tuning_operation_claims",
  "fine_tuning_audit_events",
  "community_marketplace_installs",
] as const;

// Search snapshots are derived projections, not backup authority. Clearing
// them in the same restore transaction prevents restored source data from
// being paired with an index built from the database that was replaced.
const DERIVED_TABLES_TO_CLEAR = [
  "graph_rag_projection_state",
  "search_vector_index_state",
  "search_index_documents",
  "search_index_state",
] as const;

const RESTORE_DELETE_ORDER = [
  "writing_provider_disclosure_grants",
  "writing_experience_preferences",
  "consistency_investigation_evidence",
  "consistency_investigation_findings",
  "consistency_investigation_steps",
  "consistency_investigation_runs",
  "story_settings_import_receipts",
  "novel_skill_evaluation_manual_decisions",
  "novel_skill_evaluation_review_receipts",
  "novel_skill_evaluation_scores",
  "novel_skill_evaluation_review_items",
  "novel_skill_evaluation_review_batches",
  "novel_skill_evaluation_observations",
  "novel_skill_evaluation_predispatch_authority_snapshots",
  "novel_skill_evaluation_dispatch_reservations",
  "novel_skill_evaluation_attempts",
  "novel_skill_evaluation_cells",
  "novel_skill_evaluation_authorization_limits",
  "novel_skill_evaluation_dispatch_authorizations",
  "novel_skill_evaluation_run_model_targets",
  "novel_skill_evaluation_runs",
  "novel_skill_evaluation_context_baselines",
  "novel_skill_evaluation_request_profiles",
  "novel_skill_evaluation_protocols",
  "novel_skill_evaluation_manifest_items",
  "novel_skill_evaluation_fixtures",
  "novel_skill_evaluation_suites",
  "novel_skill_invocation_items",
  "novel_skill_invocation_snapshots",
  "context_compilation_output_candidate_links",
  "context_compilation_model_invocation_links",
  "context_compilation_execution_links",
  "creative_journey_turns",
  "creative_journeys",
  "story_planning_candidates",
  "writing_preference_revisions",
  "writing_preferences",
  "writing_feedback_events",
  "writing_feedback_policies",
  "context_compilation_entry_sources",
  "context_compilation_entries",
  "context_compilation_runs",
  "causal_event_relations",
  "causal_event_foreshadow_progress",
  "causal_event_informed_characters",
  "causal_event_item_changes",
  "causal_event_relationship_changes",
  "causal_event_character_changes",
  "causal_event_prerequisites",
  "causal_event_participants",
  "causal_events",
  "causal_evidence_sources",
  "community_marketplace_installs",
  "fine_tuning_deployments",
  "fine_tuning_evaluations",
  "fine_tuning_audit_events",
  "fine_tuning_operation_claims",
  "fine_tuning_model_artifacts",
  "fine_tuning_jobs",
  "fine_tuning_samples",
  "fine_tuning_quota_policies",
  "fine_tuning_approvals",
  "fine_tuning_datasets",
  "story_fact_legacy_links",
  "story_fact_revisions",
  "story_facts",
  "authoritative_extraction_decision_claims",
  "authoritative_extraction_candidates",
  "authoritative_extraction_jobs",
  "authoritative_extraction_evaluations",
  "project_team_template_checklist_items",
  "project_team_template_prompt_rules",
  "project_team_template_prompt_refs",
  "project_team_template_settings",
  "team_template_application_receipts",
  "sync_projection_jobs",
  "sync_content_conflicts",
  "sync_materialized_checkpoints",
  "sync_materialized_objects",
  "project_sync_registrations",
  "sync_snapshot_materialization_receipts",
  "sync_snapshot_staging_operation_chunks",
  "sync_snapshot_staging_tombstones",
  "sync_snapshot_staging_chunks",
  "sync_snapshot_staging_operations",
  "sync_snapshot_staging_pages",
  "sync_snapshot_staging_sessions",
  "cloud_project_key_publications",
  "cloud_project_key_checkpoints",
  "team_project_key_receipts",
  "project_recovery_key_envelopes",
  "project_device_key_envelopes",
  "sync_inbox_operation_chunks",
  "sync_inbox_operations",
  "sync_incremental_terminal_observations",
  "cloud_deletion_mutations",
  "cloud_deletion_journals",
  "sync_incoming_batches",
  "sync_remote_checkpoints",
  "sync_device_sequences",
  "ai_generation_attempt_usage",
  "ai_generation_route_selections",
  "ai_deferred_generation_requests",
  "ai_generation_runs",
  "ai_budget_policies",
  "model_invocation_facts",
  "novel_task_routes",
  "model_hub_presets",
  "model_capability_evidence",
  "model_capability_scans",
  "model_evaluation_results",
  "model_cost_privacy_profiles",
  "model_catalog_entries",
  "model_catalog_syncs",
  "model_hub_connection_commits",
  "model_provider_connections",
  "model_role_routes",
  "model_pricing_profiles",
  "model_profiles",
  "multi_agent_review_source_references",
  "multi_agent_review_conclusions",
  "multi_agent_review_candidates",
  "multi_agent_review_turns",
  "multi_agent_review_participants",
  "multi_agent_review_sessions",
  "chapter_translations",
  "short_drama_scripts",
  "governed_extension_audit_events",
  "governed_extension_candidates",
  "governed_extension_requests",
  "governed_extension_egress_receipts",
  "governed_extension_budgets",
  "story_material_references",
  "story_materials",
  "team_membership_snapshots",
  "offline_license_envelopes",
  "entitlement_cache",
  "cloud_session_snapshots",
  "device_public_key_records",
  "registered_device_snapshots",
  "cloud_account_snapshots",
  "sync_transfer_chunks",
  "sync_transfers",
  "sync_operation_chunks",
  "sync_outbox_operations",
  "sync_tombstones",
  "sync_ciphertext_chunks",
  "project_key_versions",
  "story_ideation_drafts",
  "story_outline_drafts",
  "story_what_if_branches",
  "story_memory_governance_events",
  "story_memory_records",
  "story_memory_policies",
  "story_review_items",
  "story_timeline_state",
  "story_formal_records",
  "story_outlines",
  "notifications",
  "background_tasks",
  "recovery_drafts",
  "ai_candidates",
  "local_audit_events",
  "continuous_story_state_route_receipts",
  "chapter_validation_snapshots",
  "chapter_versions",
  "chapters",
  "authoritative_story_graph_state",
  "project_novel_skill_bindings",
  "project_seeds",
  "projects",
  "novel_skill_definitions",
] as const;

const AUTHORIZED_RESTORE_GUARDS = [
  "ai_generation_attempt_usage_privacy_insert_guard",
  "novel_skill_evaluation_review_receipt_delete_guard",
  "novel_skill_evaluation_review_item_delete_guard",
  "novel_skill_evaluation_review_batch_delete_guard",
  "novel_skill_evaluation_predispatch_authority_immutable_delete",
  "novel_skill_evaluation_reservation_delete_guard",
  "novel_skill_evaluation_authorization_limit_delete_guard",
  "novel_skill_evaluation_authorization_delete_guard",
  "novel_skill_evaluation_target_delete_guard",
  "novel_skill_evaluation_context_baseline_delete_guard",
  "novel_skill_evaluation_request_profile_delete_guard",
  "novel_skill_evaluation_protocol_delete_guard",
  "novel_skill_evaluation_manual_decision_delete_guard",
  "novel_skill_evaluation_score_delete_guard",
  "novel_skill_evaluation_observation_delete_guard",
  "novel_skill_evaluation_attempt_delete_guard",
  "novel_skill_evaluation_cell_delete_guard",
  "novel_skill_evaluation_run_delete_guard",
  "novel_skill_evaluation_fixture_delete_guard",
  "novel_skill_evaluation_manifest_item_delete_guard",
  "novel_skill_evaluation_suite_delete_guard",
  // Terminal rows are immutable and cannot be replayed through their normal
  // creation state machines. These exact guards are also removed only inside
  // the same whole-database restore transaction.
  "novel_skill_evaluation_run_insert_guard",
  "novel_skill_evaluation_target_live_insert_guard",
  "novel_skill_evaluation_authorization_insert_guard",
  "novel_skill_evaluation_reservation_insert_guard",
  "novel_skill_evaluation_predispatch_authority_insert_guard",
  "novel_skill_evaluation_trace_ownership_insert_guard",
  "novel_skill_evaluation_candidate_ownership_insert_guard",
  "novel_skill_evaluation_observation_dispatch_guard",
  "novel_skill_paid_settled_candidate_update_guard",
  "novel_skill_paid_settled_candidate_delete_guard",
  "novel_skill_paid_settled_trace_update_guard",
  "novel_skill_paid_settled_trace_delete_guard",
  "novel_skill_paid_settled_entry_insert_guard",
  "novel_skill_paid_settled_entry_update_guard",
  "novel_skill_paid_settled_entry_delete_guard",
  "novel_skill_paid_settled_source_insert_guard",
  "novel_skill_paid_settled_source_update_guard",
  "novel_skill_paid_settled_source_delete_guard",
  "novel_skill_paid_settled_invocation_update_guard",
  "novel_skill_paid_settled_invocation_delete_guard",
  "novel_skill_paid_settled_execution_link_insert_guard",
  "novel_skill_paid_settled_execution_link_delete_guard",
  "novel_skill_paid_settled_model_link_insert_guard",
  "novel_skill_paid_settled_model_link_delete_guard",
  "novel_skill_paid_settled_output_link_insert_guard",
  "novel_skill_paid_settled_output_link_delete_guard",
  "novel_skill_evaluation_review_batch_insert_guard",
  "novel_skill_evaluation_review_item_insert_guard",
  "novel_skill_evaluation_score_review_guard",
  "novel_skill_evaluation_review_receipt_insert_guard",
  "novel_skill_evaluation_cell_plan_guard",
  "novel_skill_evaluation_attempt_insert_guard",
  "novel_skill_evaluation_observation_trace_guard",
  "novel_skill_evaluation_manual_decision_gate",
  "novel_skill_evaluation_suite_content_free_guard",
  "novel_skill_evaluation_no_skill_late_snapshot_guard",
  "novel_skill_evaluation_observed_item_insert_guard",
  "novel_skill_evaluation_observed_item_delete_guard",
  "novel_skill_evaluation_candidate_update_guard",
  "novel_skill_evaluation_candidate_delete_guard",
  "novel_skill_evaluation_trace_update_guard",
  "novel_skill_evaluation_entry_insert_guard",
  "novel_skill_evaluation_entry_delete_guard",
  "novel_skill_evaluation_source_insert_guard",
  "novel_skill_evaluation_source_update_guard",
  "novel_skill_evaluation_source_delete_guard",
  "novel_skill_evaluation_execution_link_delete_guard",
  "novel_skill_evaluation_model_link_delete_guard",
  "novel_skill_evaluation_invocation_update_guard",
  "novel_skill_evaluation_chapter_insert_guard",
  "novel_skill_evaluation_chapter_project_update_guard",
  "novel_skill_evaluation_story_fact_insert_guard",
  "novel_skill_evaluation_story_fact_project_update_guard",
  "novel_skill_evaluation_project_seed_insert_guard",
  "novel_skill_evaluation_project_seed_project_update_guard",
  "novel_skill_evaluation_planning_candidate_insert_guard",
  "novel_skill_evaluation_planning_candidate_project_update_guard",
  "novel_skill_evaluation_writing_preference_insert_guard",
  "novel_skill_evaluation_writing_preference_project_update_guard",
  "novel_skill_evaluation_settings_receipt_insert_guard",
  "novel_skill_evaluation_settings_receipt_project_update_guard",
  "novel_skill_evaluation_skill_binding_insert_guard",
  "novel_skill_evaluation_skill_binding_project_update_guard",
  // A valid non-evaluation project may replay bindings, while an archived
  // evaluation project must be rejected by the semantic audit rather than by
  // an order-dependent insert trigger before that audit can run.
  "project_novel_skill_binding_active_project_guard",
] as const;

const RESTORE_INSERT_ORDER = [
  "writing_experience_preferences",
  "writing_provider_disclosure_grants",
  "novel_skill_definitions",
  "projects",
  "project_novel_skill_bindings",
  "project_seeds",
  "story_settings_import_receipts",
  "cloud_deletion_journals",
  "cloud_deletion_mutations",
  "writing_feedback_policies",
  "writing_preferences",
  "writing_preference_revisions",
  "team_template_application_receipts",
  "project_team_template_settings",
  "project_team_template_prompt_refs",
  "project_team_template_prompt_rules",
  "project_team_template_checklist_items",
  "project_sync_registrations",
  "project_key_versions",
  "team_project_key_receipts",
  "cloud_project_key_publications",
  "cloud_project_key_checkpoints",
  "chapters",
  "chapter_versions",
  "continuous_story_state_route_receipts",
  "chapter_validation_snapshots",
  "causal_evidence_sources",
  "causal_events",
  "causal_event_participants",
  "causal_event_prerequisites",
  "causal_event_character_changes",
  "causal_event_relationship_changes",
  "causal_event_item_changes",
  "causal_event_informed_characters",
  "causal_event_foreshadow_progress",
  "causal_event_relations",
  "context_compilation_runs",
  "context_compilation_entries",
  "context_compilation_entry_sources",
  "recovery_drafts",
  "ai_candidates",
  "creative_journeys",
  "creative_journey_turns",
  "writing_feedback_events",
  "local_audit_events",
  "background_tasks",
  "notifications",
  "story_outlines",
  "story_planning_candidates",
  "multi_agent_review_sessions",
  "multi_agent_review_participants",
  "multi_agent_review_turns",
  "multi_agent_review_conclusions",
  "multi_agent_review_source_references",
  "multi_agent_review_candidates",
  "governed_extension_budgets",
  "governed_extension_egress_receipts",
  "governed_extension_requests",
  "governed_extension_candidates",
  "governed_extension_audit_events",
  "chapter_translations",
  "short_drama_scripts",
  "story_formal_records",
  "story_timeline_state",
  "story_review_items",
  "authoritative_extraction_jobs",
  "authoritative_extraction_candidates",
  "authoritative_extraction_evaluations",
  "authoritative_extraction_decision_claims",
  "story_memory_policies",
  "story_memory_records",
  "story_memory_governance_events",
  "story_facts",
  "story_fact_revisions",
  "story_fact_legacy_links",
  "story_what_if_branches",
  "story_outline_drafts",
  "story_ideation_drafts",
  "story_materials",
  "story_material_references",
  "sync_remote_checkpoints",
  "sync_materialized_checkpoints",
  "sync_materialized_objects",
  "sync_content_conflicts",
  "sync_projection_jobs",
  "sync_device_sequences",
  "sync_snapshot_staging_sessions",
  "sync_snapshot_staging_pages",
  "sync_snapshot_staging_operations",
  "sync_snapshot_staging_chunks",
  "sync_snapshot_staging_operation_chunks",
  "sync_snapshot_staging_tombstones",
  "sync_snapshot_materialization_receipts",
  "sync_ciphertext_chunks",
  "sync_incoming_batches",
  "sync_incremental_terminal_observations",
  "sync_inbox_operations",
  "sync_inbox_operation_chunks",
  "sync_outbox_operations",
  "sync_operation_chunks",
  "sync_tombstones",
  "sync_transfers",
  "sync_transfer_chunks",
  "cloud_account_snapshots",
  "registered_device_snapshots",
  "device_public_key_records",
  "project_device_key_envelopes",
  "project_recovery_key_envelopes",
  "cloud_session_snapshots",
  "entitlement_cache",
  "offline_license_envelopes",
  "team_membership_snapshots",
  "model_profiles",
  "model_pricing_profiles",
  "model_role_routes",
  "model_hub_connection_commits",
  "model_provider_connections",
  "model_catalog_syncs",
  "model_catalog_entries",
  // Capability scan triggers require their exact terminal invocation to exist
  // at insertion time, even while foreign keys are transaction-deferred.
  "model_invocation_facts",
  "model_capability_scans",
  "model_capability_evidence",
  "model_cost_privacy_profiles",
  "model_evaluation_results",
  "model_hub_presets",
  "novel_task_routes",
  "ai_budget_policies",
  "ai_generation_runs",
  "ai_generation_route_selections",
  "ai_generation_attempt_usage",
  "ai_deferred_generation_requests",
  "context_compilation_execution_links",
  "context_compilation_model_invocation_links",
  "context_compilation_output_candidate_links",
  "consistency_investigation_runs",
  "consistency_investigation_steps",
  "consistency_investigation_findings",
  "consistency_investigation_evidence",
  "novel_skill_invocation_snapshots",
  "novel_skill_invocation_items",
  "novel_skill_evaluation_suites",
  "novel_skill_evaluation_fixtures",
  "novel_skill_evaluation_manifest_items",
  "novel_skill_evaluation_protocols",
  "novel_skill_evaluation_request_profiles",
  "novel_skill_evaluation_context_baselines",
  "novel_skill_evaluation_runs",
  "novel_skill_evaluation_run_model_targets",
  "novel_skill_evaluation_dispatch_authorizations",
  "novel_skill_evaluation_authorization_limits",
  "novel_skill_evaluation_cells",
  "novel_skill_evaluation_attempts",
  "novel_skill_evaluation_dispatch_reservations",
  "novel_skill_evaluation_predispatch_authority_snapshots",
  "novel_skill_evaluation_observations",
  "novel_skill_evaluation_review_batches",
  "novel_skill_evaluation_review_items",
  "novel_skill_evaluation_scores",
  "novel_skill_evaluation_review_receipts",
  "novel_skill_evaluation_manual_decisions",
  "fine_tuning_datasets",
  "fine_tuning_samples",
  "fine_tuning_approvals",
  "fine_tuning_quota_policies",
  "fine_tuning_jobs",
  "fine_tuning_model_artifacts",
  "fine_tuning_evaluations",
  "fine_tuning_deployments",
  "fine_tuning_operation_claims",
  "fine_tuning_audit_events",
  "community_marketplace_installs",
  "authoritative_story_graph_state",
] as const;

const FINE_TUNING_JOB_PLACEHOLDER_INSERT = `
  INSERT INTO main.fine_tuning_jobs (
    id,
    project_id,
    dataset_id,
    dataset_revision,
    dataset_manifest_hash,
    dataset_approval_id,
    idempotency_key,
    request_hash,
    plan_hash,
    plan_json,
    provider_location,
    provider_id,
    status,
    revision,
    attempt_count,
    maximum_attempts,
    cancellation_requested,
    lease_owner,
    lease_expires_at,
    reserved_cost_micros,
    settled_cost_micros,
    cost_source,
    currency,
    month_key,
    artifact_id,
    failure_code,
    created_by,
    started_at,
    completed_at,
    created_at,
    updated_at
  )
  SELECT
    id,
    project_id,
    dataset_id,
    dataset_revision,
    dataset_manifest_hash,
    dataset_approval_id,
    idempotency_key,
    request_hash,
    plan_hash,
    plan_json,
    provider_location,
    provider_id,
    'running',
    revision,
    attempt_count,
    maximum_attempts,
    cancellation_requested,
    'inkshadow_restore',
    updated_at,
    reserved_cost_micros,
    settled_cost_micros,
    cost_source,
    currency,
    month_key,
    NULL,
    NULL,
    created_by,
    COALESCE(started_at, created_at),
    NULL,
    created_at,
    updated_at
  FROM restore_source.fine_tuning_jobs
  WHERE id = ?`;

const FINE_TUNING_DATASET_STAGE_FOR_JOB = `
  UPDATE main.fine_tuning_datasets
  SET
    state = 'approved',
    revision = ?,
    approved_by = ?,
    approved_at = ?
  WHERE id = ?`;

const FINE_TUNING_DATASET_FINALIZE = `
  UPDATE main.fine_tuning_datasets AS target
  SET (
    state,
    revision,
    approved_by,
    approved_at,
    updated_at
  ) = (
    SELECT
      source.state,
      source.revision,
      source.approved_by,
      source.approved_at,
      source.updated_at
    FROM restore_source.fine_tuning_datasets AS source
    WHERE source.id = target.id
  )`;

const FINE_TUNING_JOB_FINALIZE = `
  UPDATE main.fine_tuning_jobs AS target
  SET (
    status,
    revision,
    attempt_count,
    cancellation_requested,
    lease_owner,
    lease_expires_at,
    settled_cost_micros,
    cost_source,
    artifact_id,
    failure_code,
    started_at,
    completed_at,
    updated_at
  ) = (
    SELECT
      source.status,
      source.revision,
      source.attempt_count,
      source.cancellation_requested,
      source.lease_owner,
      source.lease_expires_at,
      source.settled_cost_micros,
      source.cost_source,
      source.artifact_id,
      source.failure_code,
      source.started_at,
      source.completed_at,
      source.updated_at
    FROM restore_source.fine_tuning_jobs AS source
    WHERE source.id = target.id
  )`;

const FINE_TUNING_ARTIFACT_PLACEHOLDER_INSERT = `
  INSERT INTO main.fine_tuning_model_artifacts (
    id,
    project_id,
    dataset_id,
    job_id,
    base_model_provider_id,
    base_model_id,
    base_model_revision,
    artifact_digest,
    local_artifact_ref,
    state,
    revision,
    latest_evaluation_id,
    registration_name,
    provider_receipt_digest,
    created_at,
    updated_at
  )
  SELECT
    id,
    project_id,
    dataset_id,
    job_id,
    base_model_provider_id,
    base_model_id,
    base_model_revision,
    artifact_digest,
    local_artifact_ref,
    'candidate',
    revision,
    NULL,
    registration_name,
    provider_receipt_digest,
    created_at,
    updated_at
  FROM restore_source.fine_tuning_model_artifacts`;

const FINE_TUNING_ARTIFACT_FINALIZE = `
  UPDATE main.fine_tuning_model_artifacts AS target
  SET (
    state,
    revision,
    latest_evaluation_id,
    registration_name,
    provider_receipt_digest,
    updated_at
  ) = (
    SELECT
      source.state,
      source.revision,
      source.latest_evaluation_id,
      source.registration_name,
      source.provider_receipt_digest,
      source.updated_at
    FROM restore_source.fine_tuning_model_artifacts AS source
    WHERE source.id = target.id
  )`;

const FINE_TUNING_DEPLOYMENT_ARTIFACT_STAGE = `
  UPDATE main.fine_tuning_model_artifacts
  SET
    state = 'deployment_approved',
    revision = (
      SELECT approval.entity_revision + 1
      FROM restore_source.fine_tuning_deployments AS deployment
      INNER JOIN restore_source.fine_tuning_approvals AS approval
        ON approval.id = deployment.approval_id
      WHERE deployment.id = ?
    )
  WHERE id = (
    SELECT artifact_id
    FROM restore_source.fine_tuning_deployments
    WHERE id = ?
  )`;

const FINE_TUNING_DEPLOYMENT_INSERT = `
  INSERT INTO main.fine_tuning_deployments
  SELECT *
  FROM restore_source.fine_tuning_deployments
  WHERE id = ?`;

export class DatabaseMaintenanceService {
  public constructor(private readonly executor: SqlExecutor) {}

  public async inspect(): Promise<Result<DatabaseIntegrityReport, AppError>> {
    try {
      const [integrityRows, foreignKeyRows] = await Promise.all([
        this.executor.select<IntegrityRow>("PRAGMA integrity_check(100)"),
        this.executor.select<ForeignKeyRow>("PRAGMA foreign_key_check"),
      ]);
      const integrityMessages = integrityRows.map((row) => row.integrity_check);
      const foreignKeyViolations = foreignKeyRows.map((row): ForeignKeyViolation => ({
        table: row.table,
        rowId: row.rowid,
        parent: row.parent,
        foreignKeyIndex: row.fkid,
      }));

      return ok({
        healthy:
          integrityMessages.length === 1 &&
          integrityMessages[0] === "ok" &&
          foreignKeyViolations.length === 0,
        integrityMessages,
        foreignKeyViolations,
      });
    } catch {
      return err(maintenanceError("DATABASE_INTEGRITY_CHECK_FAILED"));
    }
  }

  public async createConsistentBackup(
    destinationPath: string,
  ): Promise<Result<DatabaseBackupReceipt, AppError>> {
    if (
      destinationPath.trim().length === 0 ||
      destinationPath.length > 32_767 ||
      destinationPath.includes("\u0000")
    ) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "The selected backup destination is invalid.",
        }),
      );
    }

    const integrity = await this.inspect();
    if (!integrity.ok) {
      return integrity;
    }
    if (!integrity.value.healthy) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "The local database is not healthy enough to create a trusted backup.",
          actions: ["EXPORT_DRAFT", "CONTACT_SUPPORT"],
          details: {
            integrityMessageCount: integrity.value.integrityMessages.length,
            foreignKeyViolationCount: integrity.value.foreignKeyViolations.length,
          },
        }),
      );
    }

    let attached = false;
    let operationError: AppError | undefined;
    try {
      // Binding the path keeps user-selected file names outside SQL syntax.
      // VACUUM INTO creates a transactionally consistent standalone database
      // and fails rather than overwriting an existing non-empty file.
      await this.executor.execute("VACUUM INTO ?", [destinationPath]);
      await this.executor.execute("ATTACH DATABASE ? AS restore_source", [destinationPath]);
      attached = true;

      const [databases, integrityRows, foreignKeyRows, mainSchema, backupSchema] =
        await Promise.all([
          this.executor.select<DatabaseListRow>("PRAGMA database_list"),
          this.executor.select<IntegrityRow>("PRAGMA restore_source.integrity_check(100)"),
          this.executor.select<ForeignKeyRow>("PRAGMA restore_source.foreign_key_check"),
          this.executor.select<SchemaContractRow>(
            `SELECT type, name, tbl_name AS tableName, sql
             FROM main.sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name`,
          ),
          this.executor.select<SchemaContractRow>(
            `SELECT type, name, tbl_name AS tableName, sql
             FROM restore_source.sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name`,
          ),
        ]);
      const main = databases.find(({ name }) => name === "main");
      const backup = databases.find(({ name }) => name === "restore_source");
      if (
        main === undefined ||
        backup === undefined ||
        normalizeDatabasePath(main.file) === normalizeDatabasePath(backup.file) ||
        integrityRows.length !== 1 ||
        integrityRows[0]?.integrity_check !== "ok" ||
        foreignKeyRows.length > 0 ||
        !schemaContractsMatch(mainSchema, backupSchema)
      ) {
        operationError = maintenanceError("DATABASE_BACKUP_VERIFICATION_FAILED");
      }
    } catch {
      operationError = maintenanceError("DATABASE_BACKUP_FAILED");
    }

    if (attached) {
      try {
        await this.executor.execute("DETACH DATABASE restore_source");
      } catch {
        return err(maintenanceError("DATABASE_BACKUP_DETACH_FAILED"));
      }
    }
    if (operationError !== undefined) {
      return err(operationError);
    }
    return ok({
      destinationKind: "user_selected_file",
      integrityVerified: true,
    });
  }

  public async restoreConsistentBackup(
    sourcePath: string,
  ): Promise<Result<DatabaseRestoreReceipt, AppError>> {
    const pathValidation = validateDatabasePath(sourcePath);
    if (!pathValidation.ok) {
      return pathValidation;
    }

    let attached = false;
    let outcome: Result<DatabaseRestoreReceipt, AppError>;
    try {
      await this.executor.execute("ATTACH DATABASE ? AS restore_source", [sourcePath]);
      attached = true;

      const databases = await this.executor.select<DatabaseListRow>("PRAGMA database_list");
      const main = databases.find(({ name }) => name === "main");
      const source = databases.find(({ name }) => name === "restore_source");
      if (
        main === undefined ||
        source === undefined ||
        normalizeDatabasePath(main.file) === normalizeDatabasePath(source.file)
      ) {
        throw restoreError("DATABASE_RESTORE_SOURCE_INVALID");
      }

      const [
        integrityRows,
        foreignKeyRows,
        tableRows,
        capabilityScanColumns,
        candidateColumns,
        chapterVersionColumns,
        generationAttemptUsageColumns,
      ] = await Promise.all([
        this.executor.select<IntegrityRow>("PRAGMA restore_source.integrity_check(100)"),
        this.executor.select<ForeignKeyRow>("PRAGMA restore_source.foreign_key_check"),
        this.executor.select<TableNameRow>(
          `SELECT name
           FROM restore_source.sqlite_schema
           WHERE type = 'table' AND name IN (${RESTORABLE_TABLES.map(() => "?").join(", ")})`,
          RESTORABLE_TABLES,
        ),
        this.executor.select<TableColumnRow>(
          "PRAGMA restore_source.table_info('model_capability_scans')",
        ),
        this.executor.select<TableColumnRow>("PRAGMA restore_source.table_info('ai_candidates')"),
        this.executor.select<TableColumnRow>(
          "PRAGMA restore_source.table_info('chapter_versions')",
        ),
        this.executor.select<TableColumnRow>(
          "PRAGMA restore_source.table_info('ai_generation_attempt_usage')",
        ),
      ]);
      const sourceTables = new Set(tableRows.map(({ name }) => name));
      const sourceCapabilityScanColumns = new Set(capabilityScanColumns.map(({ name }) => name));
      const sourceCandidateColumns = new Set(candidateColumns.map(({ name }) => name));
      const sourceChapterVersionColumns = new Set(chapterVersionColumns.map(({ name }) => name));
      const sourceGenerationAttemptUsageColumns = new Set(
        generationAttemptUsageColumns.map(({ name }) => name),
      );
      const generationAttemptPrivacyColumns = [
        "privacy_snapshot_version",
        "privacy_policy",
        "data_destination",
        "model_invocation_id",
      ] as const;
      const sourceGenerationAttemptPrivacyColumnCount = generationAttemptPrivacyColumns.filter(
        (column) => sourceGenerationAttemptUsageColumns.has(column),
      ).length;
      if (
        integrityRows.length !== 1 ||
        integrityRows[0]?.integrity_check !== "ok" ||
        foreignKeyRows.length > 0 ||
        RESTORABLE_TABLES.some((table) => !sourceTables.has(table)) ||
        !MODEL_CAPABILITY_SCAN_V73_COLUMNS.every((column) =>
          sourceCapabilityScanColumns.has(column),
        ) ||
        (sourceGenerationAttemptPrivacyColumnCount !== 0 &&
          sourceGenerationAttemptPrivacyColumnCount !== generationAttemptPrivacyColumns.length)
      ) {
        throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
      }

      await this.executor.transaction(async (transaction) => {
        // Fine-tuning jobs and artifacts form a valid, intentional cycle once
        // a job has produced an artifact. Deferral remains transaction-local;
        // both the explicit check below and COMMIT still enforce every FK.
        await transaction.execute("PRAGMA defer_foreign_keys = ON");
        // Evaluation evidence is append-only during normal operation. A user-
        // authorized whole-database restore is the sole destructive path. Read
        // and validate the exact allowlisted trigger DDL, drop it transactionally,
        // then recreate it before the transaction can commit. Any intervening
        // failure rolls the schema changes back together with restored rows.
        const evaluationDeleteGuards = await transaction.select<TriggerDefinitionRow>(
          `SELECT name, sql FROM main.sqlite_schema
           WHERE type = 'trigger' AND name IN (${AUTHORIZED_RESTORE_GUARDS.map(() => "?").join(", ")})
           ORDER BY name`,
          AUTHORIZED_RESTORE_GUARDS,
        );
        if (
          evaluationDeleteGuards.length !== AUTHORIZED_RESTORE_GUARDS.length ||
          evaluationDeleteGuards.some(
            ({ name, sql }) =>
              !AUTHORIZED_RESTORE_GUARDS.includes(
                name as (typeof AUTHORIZED_RESTORE_GUARDS)[number],
              ) ||
              sql === null ||
              !/^CREATE TRIGGER\b/iu.test(sql),
          )
        ) {
          throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
        }
        for (const trigger of AUTHORIZED_RESTORE_GUARDS) {
          await transaction.execute(`DROP TRIGGER main.${trigger}`);
        }
        for (const table of DERIVED_TABLES_TO_CLEAR) {
          await transaction.execute(`DELETE FROM main.${table}`);
        }
        for (const table of RESTORE_DELETE_ORDER) {
          await transaction.execute(`DELETE FROM main.${table}`);
        }
        for (const table of RESTORE_INSERT_ORDER) {
          if (table === "authoritative_story_graph_state") {
            // The authority epoch belongs to the restored source history, but
            // the published graph receipt does not: GraphRAG tables are
            // deliberately cleared above and must be rebuilt. Authoritative
            // chapter/story insert triggers create transient rows during the
            // restore, so replace those rows only after every authority table
            // has been copied.
            await transaction.execute("DELETE FROM main.authoritative_story_graph_state");
            await transaction.execute(
              `INSERT INTO main.authoritative_story_graph_state (
                 project_id, schema_version, authority_epoch,
                 projected_epoch, projected_graph_revision,
                 projection_complete, diagnostics_json
               )
               SELECT project_id, schema_version, authority_epoch,
                      NULL, NULL, NULL, NULL
               FROM restore_source.authoritative_story_graph_state`,
            );
          } else if (table === "fine_tuning_jobs") {
            // A completed source job points at its artifact, while the artifact
            // insertion authority requires that job to be running. Restore a
            // content-free transient state, insert the artifact, then put the
            // backed-up mutable job state back exactly.
            const jobs = await transaction.select<FineTuningJobRestoreRow>(
              `SELECT
                 job.id,
                 job.dataset_id AS datasetId,
                 job.dataset_revision AS datasetRevision,
                 approval.actor_id AS approvedBy,
                 approval.created_at AS approvedAt
               FROM restore_source.fine_tuning_jobs AS job
               INNER JOIN restore_source.fine_tuning_approvals AS approval
                 ON approval.id = job.dataset_approval_id
               ORDER BY job.created_at, job.id`,
            );
            for (const job of jobs) {
              // A dataset may have been archived after its jobs completed.
              // Recreate the exact authority state each job originally saw,
              // then return the dataset to its backed-up current state.
              await transaction.execute(FINE_TUNING_DATASET_STAGE_FOR_JOB, [
                job.datasetRevision,
                job.approvedBy,
                job.approvedAt,
                job.datasetId,
              ]);
              await transaction.execute(FINE_TUNING_JOB_PLACEHOLDER_INSERT, [job.id]);
            }
            await transaction.execute(FINE_TUNING_DATASET_FINALIZE);
          } else if (table === "fine_tuning_model_artifacts") {
            // Evaluation authority accepts candidate artifacts, while later
            // deployment authority requires the backed-up post-evaluation
            // state. Restore that mutable state after evaluations are present.
            await transaction.execute(FINE_TUNING_ARTIFACT_PLACEHOLDER_INSERT);
          } else if (table === "fine_tuning_deployments") {
            const deployments = await transaction.select<FineTuningDeploymentRestoreRow>(
              `SELECT id
               FROM restore_source.fine_tuning_deployments
               ORDER BY activated_at, id`,
            );
            for (const deployment of deployments) {
              // Deployment history can contain several approval revisions for
              // one artifact. Replay each row against its own approved
              // authority state, then restore the artifact's latest state.
              await transaction.execute(FINE_TUNING_DEPLOYMENT_ARTIFACT_STAGE, [
                deployment.id,
                deployment.id,
              ]);
              await transaction.execute(FINE_TUNING_DEPLOYMENT_INSERT, [deployment.id]);
            }
            await transaction.execute(FINE_TUNING_ARTIFACT_FINALIZE);
          } else if (table === "chapter_versions") {
            // Save-time responsibility was added after the released backup contract.
            // Older immutable versions cannot prove direct-mode ownership and restore as false.
            await transaction.execute(
              `INSERT INTO main.chapter_versions (
                 id, project_id, chapter_id, parent_version_id, sequence,
                 content, content_checksum, reason, source_candidate_id, created_at,
                 organize_local_story_facts
               )
               SELECT
                 id, project_id, chapter_id, parent_version_id, sequence,
                 content, content_checksum, reason, source_candidate_id, created_at,
                 ${
                   sourceChapterVersionColumns.has("organize_local_story_facts")
                     ? "organize_local_story_facts"
                     : "0"
                 }
               FROM restore_source.chapter_versions`,
            );
          } else if (table === "chapter_validation_snapshots") {
            // Rerun snapshots are immutable and must be restored only after the
            // immediately preceding snapshot in their evidence chain.
            await transaction.execute(
              `INSERT INTO main.chapter_validation_snapshots
               SELECT * FROM restore_source.chapter_validation_snapshots
              ORDER BY project_id, chapter_id, run_sequence`,
            );
          } else if (table === "ai_candidates") {
            // Purpose was added after the version 73 backup contract. Historic
            // rows are prose by definition; newer backups preserve the exact
            // purpose and remain protected by the current insert trigger.
            await transaction.execute(
              `INSERT INTO main.ai_candidates (
                 id, project_id, chapter_id, source, base_version_id,
                 content, content_checksum, status, incomplete,
                 created_at, updated_at, decided_at,
                 task_intent, application_mode, payload_kind,
                 anchor_start_utf16, anchor_end_utf16, revision, purpose
               )
               SELECT
                 id, project_id, chapter_id, source, base_version_id,
                 content, content_checksum, status, incomplete,
                 created_at, updated_at, decided_at,
                 task_intent, application_mode, payload_kind,
                 anchor_start_utf16, anchor_end_utf16, revision,
                 ${sourceCandidateColumns.has("purpose") ? "purpose" : "'prose'"}
               FROM restore_source.ai_candidates`,
            );
          } else if (table === "ai_generation_attempt_usage") {
            // Privacy snapshots were added after the released backup contract.
            // Historical rows remain explicitly unrecorded; current backups
            // preserve the complete versioned snapshot and exact invocation id.
            const hasPrivacySnapshot =
              sourceGenerationAttemptPrivacyColumnCount === generationAttemptPrivacyColumns.length;
            await transaction.execute(
              `INSERT INTO main.ai_generation_attempt_usage (
                 run_id, attempt, usage_source, input_tokens, output_tokens,
                 cached_input_tokens, usage_priced_estimate_micros, cost_status,
                 currency, pricing_version, price_updated_at, reported_at,
                 privacy_snapshot_version, privacy_policy, data_destination,
                 model_invocation_id
               )
               SELECT
                 run_id, attempt, usage_source, input_tokens, output_tokens,
                 cached_input_tokens, usage_priced_estimate_micros, cost_status,
                 currency, pricing_version, price_updated_at, reported_at,
                 ${hasPrivacySnapshot ? "privacy_snapshot_version" : "NULL"},
                 ${hasPrivacySnapshot ? "privacy_policy" : "NULL"},
                 ${hasPrivacySnapshot ? "data_destination" : "NULL"},
                 ${hasPrivacySnapshot ? "model_invocation_id" : "NULL"}
               FROM restore_source.ai_generation_attempt_usage`,
            );
          } else if (table === "model_capability_scans") {
            // Version 74 adds only the nullable invocation link. Older healthy
            // backups remain restorable: their scans truthfully have no exact
            // invocation association, while v74+ sources retain the FK.
            await transaction.execute(
              `INSERT INTO main.model_capability_scans (
                 id, catalog_entry_id, scan_kind, status, evidence_version,
                 supported_count, unsupported_count, unknown_count,
                 error_code, error_summary, requested_at, started_at, completed_at,
                 diagnostic_request_id, failure_stage, failure_retryable,
                 http_status, finish_reason, visible_content_length,
                 reasoning_present, streamed, attempt,
                 requested_max_output_tokens, model_invocation_id
               )
               SELECT
                 id, catalog_entry_id, scan_kind, status, evidence_version,
                 supported_count, unsupported_count, unknown_count,
                 error_code, error_summary, requested_at, started_at, completed_at,
                 diagnostic_request_id, failure_stage, failure_retryable,
                 http_status, finish_reason, visible_content_length,
                 reasoning_present, streamed, attempt,
                 requested_max_output_tokens,
                 ${sourceCapabilityScanColumns.has("model_invocation_id") ? "model_invocation_id" : "NULL"}
               FROM restore_source.model_capability_scans`,
            );
          } else {
            await transaction.execute(
              `INSERT INTO main.${table} SELECT * FROM restore_source.${table}`,
            );
            if (table === "writing_preferences") {
              // The normal insert trigger creates a revision row for every
              // restored preference. Remove those generated rows before the
              // exact immutable revision history is copied from the backup.
              await transaction.execute("DELETE FROM main.writing_preference_revisions");
            }
          }
          if (table === "fine_tuning_model_artifacts") {
            await transaction.execute(FINE_TUNING_JOB_FINALIZE);
          }
        }
        await auditRestoredNovelSkillEvaluationLedger(transaction);
        for (const { sql } of evaluationDeleteGuards) {
          if (sql === null) {
            throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
          }
          await transaction.execute(sql);
        }
        const restoredForeignKeys = await transaction.select<ForeignKeyRow>(
          "PRAGMA foreign_key_check",
        );
        if (restoredForeignKeys.length > 0) {
          throw restoreError("DATABASE_RESTORE_FOREIGN_KEY_FAILED");
        }
      });

      outcome = ok({
        sourceKind: "user_selected_file",
        integrityVerified: true,
        restoredTableCount: RESTORABLE_TABLES.length,
      });
    } catch (cause: unknown) {
      outcome = err(cause instanceof AppError ? cause : restoreError("DATABASE_RESTORE_FAILED"));
    }
    if (attached) {
      try {
        await this.executor.execute("DETACH DATABASE restore_source");
      } catch {
        return err(restoreError("DATABASE_RESTORE_DETACH_FAILED"));
      }
    }
    return outcome;
  }
}

interface RestoredEvaluationRunAuditRow {
  readonly id: string;
  readonly suite_id: string;
  readonly status: string;
  readonly evaluation_status: string;
  readonly evaluation_result_hash: string | null;
  readonly model_assignments_json: string;
  readonly model_slots_json: string;
  readonly evaluator_version: string;
  readonly compiler_version: string;
  readonly plan_hash: string;
  readonly fixture_set_hash: string;
  readonly target_manifest_hash: string;
  readonly core_manifest_hash: string;
  readonly core_genre_manifest_hash: string;
  readonly core_genre_preferences_manifest_hash: string;
  readonly preference_configuration_hash: string;
  readonly minimum_repetitions: number;
  readonly revision: number;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly cell_count: number;
  readonly observed_count: number;
  readonly invalidated_count: number;
  readonly observation_count: number;
  readonly score_count: number;
  readonly started_attempt_count: number;
}

interface RestoredEvaluationCellAuditRow {
  readonly id: string;
  readonly run_id: string;
  readonly suite_id: string;
  readonly fixture_id: string;
  readonly arm: RestoredEvaluationArm;
  readonly arm_configuration_hash: string | null;
  readonly model_slot_id: string;
  readonly model_tier: string;
  readonly repetition: number;
  readonly state: string;
  readonly created_at: string;
}

interface RestoredEvaluationAttemptAuditRow {
  readonly id: string;
  readonly run_id: string;
  readonly cell_id: string;
  readonly attempt_number: number;
  readonly status: string;
  readonly context_trace_id: string | null;
  readonly model_invocation_id: string | null;
  readonly error_code: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly observation_id: string | null;
}

interface RestoredEvaluationFixtureAuditRow {
  readonly fixture_id: string;
  readonly language: string;
  readonly origin: string;
  readonly task_type: string;
  readonly invocation_mode: string;
  readonly genre_tags_json: string;
  readonly coverage_dimensions_json: string;
  readonly contract_hash: string;
  readonly input_content_hash: string;
}

interface RestoredEvaluationModelSlot {
  readonly slotId: "text_tier_a" | "text_tier_b";
  readonly modelTier: string;
}

const RESTORED_EVALUATION_ARMS = [
  "no_skill",
  "core",
  "core_genre",
  "core_genre_preferences",
] as const;
type RestoredEvaluationArm = (typeof RESTORED_EVALUATION_ARMS)[number];
const RESTORED_EVALUATION_METRICS = [
  "instruction_following",
  "canon_preservation",
  "character_consistency",
  "pov_preservation",
  "causal_progression",
  "scene_function",
  "dialogue_distinction",
  "specificity",
  "repetition_cliche_control",
  "pacing",
  "user_preference",
  "unnecessary_rewrite_avoidance",
  "evidence_completeness",
] as const;
type RestoredEvaluationMetric = (typeof RESTORED_EVALUATION_METRICS)[number];

interface RestoredEvaluatorObservation {
  readonly observationId: string;
  readonly fixtureId: string;
  readonly arm: RestoredEvaluationArm;
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly modelTier: string;
  readonly repetition: number;
  readonly modelInvocationId: string;
  readonly evaluatorVersion: "novel-skill-ab@1";
  readonly completionStatus: "succeeded";
  readonly visibleContentLength: number;
  readonly finishReason: string | null;
  readonly methodApplicability: Readonly<{ readonly core: boolean; readonly genre: boolean }>;
  readonly scores: Readonly<Record<RestoredEvaluationMetric, number>>;
  readonly latencyMilliseconds: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostMicros: number | null;
}

interface RestoredVerifiedObservation {
  readonly runId: string;
  readonly evaluation: RestoredEvaluatorObservation;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly scores: readonly Readonly<Record<string, unknown>>[];
}

interface RestoredEvaluationObservationAuditRow {
  readonly id: string;
  readonly run_id: string;
  readonly cell_id: string;
  readonly cell_run_id: string;
  readonly cell_suite_id: string;
  readonly run_suite_id: string;
  readonly attempt_id: string;
  readonly attempt_run_id: string;
  readonly attempt_cell_id: string;
  readonly arm: string;
  readonly cell_state: string;
  readonly model_slot_id: string;
  readonly model_tier: string;
  readonly repetition: number;
  readonly cell_arm_configuration_hash: string | null;
  readonly observation_arm_configuration_hash: string | null;
  readonly observation_preference_configuration_hash: string | null;
  readonly evaluator_version: string;
  readonly observation_created_at: string;
  readonly model_assignments_json: string;
  readonly model_identity_hash: string;
  readonly model_artifact_hash: string;
  readonly result_hash: string;
  readonly latency_milliseconds: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly estimated_cost_micros: number | null;
  readonly context_trace_id: string;
  readonly model_invocation_id: string;
  readonly output_candidate_id: string;
  readonly novel_skill_snapshot_id: string | null;
  readonly attempt_status: string;
  readonly attempt_trace_id: string | null;
  readonly attempt_invocation_id: string | null;
  readonly fixture_id: string;
  readonly fixture_task_type: string;
  readonly fixture_invocation_mode: string;
  readonly fixture_genre_tags_json: string;
  readonly fixture_input_hash: string;
  readonly fixture_contract_hash: string;
  readonly suite_compiler_version: string;
  readonly evaluation_project_id: string;
  readonly invocation_task: string;
  readonly invocation_status: string;
  readonly connection_id: string;
  readonly catalog_entry_id: string | null;
  readonly provider_kind_snapshot: string;
  readonly model_id_snapshot: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly error_code: string | null;
  readonly finish_reason: string | null;
  readonly visible_content_length: number | null;
  readonly invocation_input_tokens: number | null;
  readonly invocation_output_tokens: number | null;
  readonly invocation_estimated_cost_micros: string | null;
  readonly trace_project_id: string;
  readonly trace_chapter_id: string | null;
  readonly trace_task_type: string;
  readonly trace_maximum_context_tokens: number;
  readonly trace_required_tokens: number;
  readonly trace_used_tokens: number;
  readonly trace_remaining_tokens: number;
  readonly trace_discarded_tokens: number;
  readonly trace_token_estimate_source: string;
  readonly trace_candidate_count: number;
  readonly trace_included_count: number;
  readonly trace_discarded_count: number;
  readonly trace_created_at: string;
  readonly generation_id: string;
  readonly generation_run_id: string | null;
  readonly execution_created_at: string;
  readonly model_linked_at: string;
  readonly output_linked_at: string;
  readonly candidate_project_id: string;
  readonly candidate_chapter_id: string | null;
  readonly candidate_base_version_id: string | null;
  readonly candidate_content: string;
  readonly candidate_checksum: string;
  readonly candidate_source: string;
  readonly candidate_status: string;
  readonly candidate_incomplete: number;
  readonly candidate_created_at: string;
  readonly candidate_updated_at: string;
  readonly candidate_decided_at: string | null;
  readonly snapshot_project_id: string | null;
  readonly snapshot_task_type: string | null;
  readonly snapshot_invocation_mode: string | null;
  readonly snapshot_compiler_version: string | null;
  readonly snapshot_configuration_json: string | null;
  readonly snapshot_maximum_skill_tokens: number | null;
  readonly snapshot_used_skill_tokens: number | null;
  readonly snapshot_discarded_skill_tokens: number | null;
  readonly snapshot_candidate_count: number | null;
  readonly snapshot_included_count: number | null;
  readonly snapshot_discarded_count: number | null;
  readonly snapshot_selection_hash: string | null;
  readonly snapshot_created_at: string | null;
}

interface RestoredEvaluationSourceAuditRow {
  readonly candidate_id: string;
  readonly layer: string;
  readonly selection_reason: string;
  readonly included: number;
  readonly discarded_reason: string | null;
  readonly estimated_tokens: number;
  readonly evaluation_order: number;
  readonly layer_order: number;
  readonly priority: number;
  readonly relevance_score: number | null;
  readonly required: number;
  readonly budget_remaining_before: number;
  readonly budget_remaining_after: number;
  readonly source_order: number | null;
  readonly source_type: string | null;
  readonly source_id: string | null;
  readonly source_version_id: string | null;
  readonly locator: string | null;
  readonly content_hash: string | null;
}

interface RestoredEvaluationSkillItemAuditRow {
  readonly item_order: number;
  readonly skill_id: string;
  readonly skill_version: string;
  readonly definition_hash: string;
  readonly kind: string;
  readonly status: string;
  readonly included: number;
  readonly selection_reason: string;
  readonly discarded_reason: string | null;
  readonly activation_source: string;
  readonly precedence: number;
  readonly definition_precedence: number;
  readonly estimated_tokens: number;
  readonly task_types_json: string;
  readonly activation_json: string;
  readonly context_requirements_json: string;
}

async function auditRestoredNovelSkillEvaluationLedger(
  transaction: TransactionExecutor,
): Promise<void> {
  const invalidSuites = await transaction.select<{ readonly id: string }>(
    `SELECT suite.id
     FROM novel_skill_evaluation_suites AS suite
     INNER JOIN projects AS project ON project.id = suite.evaluation_project_id
     WHERE project.status <> 'archived' OR project.archived_at IS NULL OR project.trashed_at IS NOT NULL
        OR (SELECT count(*) FROM novel_skill_evaluation_fixtures
            WHERE suite_id = suite.id) <> 12
        OR EXISTS (SELECT 1 FROM chapters WHERE project_id = suite.evaluation_project_id)
        OR EXISTS (SELECT 1 FROM story_facts WHERE project_id = suite.evaluation_project_id)
        OR EXISTS (SELECT 1 FROM project_seeds WHERE project_id = suite.evaluation_project_id)
        OR EXISTS (SELECT 1 FROM story_planning_candidates
                   WHERE project_id = suite.evaluation_project_id)
        OR EXISTS (SELECT 1 FROM writing_preferences
                   WHERE project_id = suite.evaluation_project_id)
        OR EXISTS (SELECT 1 FROM story_settings_import_receipts
                   WHERE project_id = suite.evaluation_project_id)
        OR EXISTS (SELECT 1 FROM project_novel_skill_bindings
                   WHERE project_id = suite.evaluation_project_id)
     LIMIT 1`,
  );
  if (invalidSuites.length > 0) throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);

  const invalidRelationships = await transaction.select<{ readonly id: string }>(
    `SELECT attempt.id
     FROM novel_skill_evaluation_attempts AS attempt
     INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = attempt.cell_id
     WHERE attempt.run_id <> cell.run_id
     UNION ALL
     SELECT observation.id
     FROM novel_skill_evaluation_observations AS observation
     INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = observation.cell_id
     INNER JOIN novel_skill_evaluation_attempts AS attempt ON attempt.id = observation.attempt_id
     WHERE observation.run_id <> cell.run_id
        OR observation.run_id <> attempt.run_id
        OR observation.cell_id <> attempt.cell_id
     LIMIT 1`,
  );
  if (invalidRelationships.length > 0) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }

  const runs = await transaction.select<RestoredEvaluationRunAuditRow>(
    `SELECT run.id, run.suite_id, run.status, run.evaluation_status,
            run.evaluation_result_hash, run.model_assignments_json,
            suite.model_slots_json, suite.evaluator_version, suite.compiler_version,
            suite.plan_hash, suite.fixture_set_hash, suite.target_manifest_hash,
            suite.core_manifest_hash, suite.core_genre_manifest_hash,
            suite.core_genre_preferences_manifest_hash,
            suite.preference_configuration_hash, suite.minimum_repetitions,
            run.revision, run.started_at, run.completed_at, run.created_at,
            count(DISTINCT cell.id) AS cell_count,
            count(DISTINCT CASE WHEN cell.state = 'observed' THEN cell.id END) AS observed_count,
            count(DISTINCT CASE WHEN cell.state = 'invalidated' THEN cell.id END) AS invalidated_count,
            count(DISTINCT observation.id) AS observation_count,
            count(DISTINCT score.observation_id || ':' || score.metric) AS score_count,
            count(DISTINCT CASE WHEN attempt.status = 'started' THEN attempt.id END)
              AS started_attempt_count
     FROM novel_skill_evaluation_runs AS run
     INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
     LEFT JOIN novel_skill_evaluation_cells AS cell ON cell.run_id = run.id
     LEFT JOIN novel_skill_evaluation_observations AS observation ON observation.run_id = run.id
     LEFT JOIN novel_skill_evaluation_scores AS score ON score.observation_id = observation.id
     LEFT JOIN novel_skill_evaluation_attempts AS attempt ON attempt.run_id = run.id
     GROUP BY run.id`,
  );
  for (const run of runs) {
    const assignments = parseRestoredModelAssignments(run.model_assignments_json);
    if (
      assignments === null ||
      run.cell_count !== 192 ||
      (run.status === "completed" &&
        (run.observed_count !== 192 ||
          run.observation_count !== 192 ||
          run.score_count !== 2496)) ||
      (run.status === "invalidated" &&
        (run.observed_count + run.invalidated_count !== 192 || run.started_attempt_count !== 0))
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    await auditRestoredEvaluationRunStructure(transaction, run, assignments);
  }

  const scoreViolations = await transaction.select<{ readonly observation_id: string }>(
    `SELECT observation.id AS observation_id
     FROM novel_skill_evaluation_observations AS observation
     LEFT JOIN novel_skill_evaluation_scores AS score ON score.observation_id = observation.id
     GROUP BY observation.id
     HAVING count(score.metric) NOT IN (0, 13)
        OR count(DISTINCT score.metric) NOT IN (0, 13)
        OR (count(score.metric) = 13 AND min(score.reviewer_id) IS NULL)
        OR (count(score.metric) = 13
            AND min(score.rubric_version) <> 'novel-skill-human-rubric@1')
        OR (count(score.metric) = 13
            AND min(strftime('%Y-%m-%dT%H:%M:%fZ', score.scored_at)) IS NULL)
     LIMIT 1`,
  );
  if (scoreViolations.length > 0) throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);

  const observations = await transaction.select<RestoredEvaluationObservationAuditRow>(
    `SELECT observation.id, observation.run_id, observation.cell_id,
            cell.run_id AS cell_run_id, cell.suite_id AS cell_suite_id,
            run.suite_id AS run_suite_id, observation.attempt_id,
            attempt.run_id AS attempt_run_id, attempt.cell_id AS attempt_cell_id,
            cell.arm, cell.state AS cell_state, cell.model_slot_id, cell.model_tier,
            cell.repetition, cell.arm_configuration_hash AS cell_arm_configuration_hash,
            observation.arm_configuration_hash AS observation_arm_configuration_hash,
            observation.preference_configuration_hash AS observation_preference_configuration_hash,
            observation.evaluator_version, observation.created_at AS observation_created_at,
            run.model_assignments_json, observation.model_identity_hash,
            observation.model_artifact_hash, observation.result_hash,
            observation.latency_milliseconds, observation.input_tokens,
            observation.output_tokens, observation.estimated_cost_micros,
            observation.context_trace_id, observation.model_invocation_id,
            observation.output_candidate_id, observation.novel_skill_snapshot_id,
            attempt.status AS attempt_status, attempt.context_trace_id AS attempt_trace_id,
            attempt.model_invocation_id AS attempt_invocation_id,
            fixture.fixture_id, fixture.task_type AS fixture_task_type,
            fixture.invocation_mode AS fixture_invocation_mode,
            fixture.genre_tags_json AS fixture_genre_tags_json,
            fixture.input_content_hash AS fixture_input_hash,
            fixture.contract_hash AS fixture_contract_hash,
            suite.compiler_version AS suite_compiler_version,
            suite.evaluation_project_id,
            invocation.task AS invocation_task, invocation.status AS invocation_status,
            invocation.connection_id, invocation.catalog_entry_id,
            invocation.provider_kind_snapshot, invocation.model_id_snapshot,
            invocation.started_at, invocation.completed_at, invocation.error_code,
            invocation.finish_reason, invocation.visible_content_length,
            invocation.input_tokens AS invocation_input_tokens,
            invocation.output_tokens AS invocation_output_tokens,
            invocation.estimated_cost_micros AS invocation_estimated_cost_micros,
            trace.project_id AS trace_project_id, trace.chapter_id AS trace_chapter_id,
            trace.task_type AS trace_task_type,
            trace.maximum_context_tokens AS trace_maximum_context_tokens,
            trace.required_tokens AS trace_required_tokens,
            trace.used_tokens AS trace_used_tokens,
            trace.remaining_tokens AS trace_remaining_tokens,
            trace.discarded_tokens AS trace_discarded_tokens,
            trace.token_estimate_source AS trace_token_estimate_source,
            trace.candidate_count AS trace_candidate_count,
            trace.included_count AS trace_included_count,
            trace.discarded_count AS trace_discarded_count,
            trace.created_at AS trace_created_at,
            execution.generation_id, execution.generation_run_id,
            execution.created_at AS execution_created_at,
            model_link.linked_at AS model_linked_at,
            output_link.linked_at AS output_linked_at,
            candidate.project_id AS candidate_project_id,
            candidate.chapter_id AS candidate_chapter_id,
            candidate.base_version_id AS candidate_base_version_id,
            candidate.content AS candidate_content,
            candidate.content_checksum AS candidate_checksum,
            candidate.source AS candidate_source, candidate.status AS candidate_status,
            candidate.incomplete AS candidate_incomplete,
            candidate.created_at AS candidate_created_at,
            candidate.updated_at AS candidate_updated_at,
            candidate.decided_at AS candidate_decided_at,
            snapshot.project_id AS snapshot_project_id,
            snapshot.task_type AS snapshot_task_type,
            snapshot.invocation_mode AS snapshot_invocation_mode,
            snapshot.compiler_version AS snapshot_compiler_version,
            snapshot.configuration_snapshot_json AS snapshot_configuration_json,
            snapshot.maximum_skill_tokens AS snapshot_maximum_skill_tokens,
            snapshot.used_skill_tokens AS snapshot_used_skill_tokens,
            snapshot.discarded_skill_tokens AS snapshot_discarded_skill_tokens,
            snapshot.candidate_count AS snapshot_candidate_count,
            snapshot.included_count AS snapshot_included_count,
            snapshot.discarded_count AS snapshot_discarded_count,
            snapshot.selection_hash AS snapshot_selection_hash,
            snapshot.created_at AS snapshot_created_at
     FROM novel_skill_evaluation_observations AS observation
     INNER JOIN novel_skill_evaluation_cells AS cell
       ON cell.id = observation.cell_id AND cell.run_id = observation.run_id
     INNER JOIN novel_skill_evaluation_runs AS run
       ON run.id = observation.run_id AND run.suite_id = cell.suite_id
     INNER JOIN novel_skill_evaluation_suites AS suite
       ON suite.id = run.suite_id AND suite.id = cell.suite_id
     INNER JOIN novel_skill_evaluation_fixtures AS fixture
       ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
     INNER JOIN novel_skill_evaluation_attempts AS attempt
       ON attempt.id = observation.attempt_id
      AND attempt.run_id = observation.run_id AND attempt.cell_id = observation.cell_id
     INNER JOIN model_invocation_facts AS invocation ON invocation.id = observation.model_invocation_id
     INNER JOIN context_compilation_runs AS trace ON trace.id = observation.context_trace_id
     INNER JOIN context_compilation_execution_links AS execution
       ON execution.trace_id = observation.context_trace_id
     INNER JOIN context_compilation_model_invocation_links AS model_link
       ON model_link.trace_id = observation.context_trace_id
      AND model_link.model_invocation_id = observation.model_invocation_id
     INNER JOIN context_compilation_output_candidate_links AS output_link
       ON output_link.trace_id = observation.context_trace_id
      AND output_link.ai_candidate_id = observation.output_candidate_id
     INNER JOIN ai_candidates AS candidate ON candidate.id = observation.output_candidate_id
     LEFT JOIN novel_skill_invocation_snapshots AS snapshot
       ON snapshot.id = observation.novel_skill_snapshot_id
      AND snapshot.context_trace_id = observation.context_trace_id
      AND snapshot.model_invocation_id = observation.model_invocation_id
     ORDER BY cell.fixture_id, cell.arm, cell.model_slot_id, cell.repetition`,
  );
  const observationCount = await transaction.select<{ readonly count: number }>(
    "SELECT count(*) AS count FROM novel_skill_evaluation_observations",
  );
  if (observations.length !== (observationCount[0]?.count ?? -1)) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const verifiedObservations: RestoredVerifiedObservation[] = [];
  for (const observation of observations) {
    verifiedObservations.push(await auditRestoredEvaluationObservation(transaction, observation));
  }
  for (const run of runs) {
    if (run.status === "completed") {
      await auditRestoredCompletedEvaluationRun(
        transaction,
        run,
        verifiedObservations.filter(({ runId }) => runId === run.id),
      );
    }
  }
  await auditRestoredNovelSkillPaidEvaluationAuthority(transaction);
  const invalidDecisions = await transaction.select<{ readonly id: string }>(
    `SELECT decision.id
     FROM novel_skill_evaluation_manual_decisions AS decision
     INNER JOIN novel_skill_evaluation_runs AS run ON run.id = decision.run_id
     INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
     WHERE decision.target_manifest_hash <> suite.target_manifest_hash
        OR run.status NOT IN ('completed','invalidated')
        OR (decision.decision = 'APPROVE_EXPERIMENTAL_BINDING' AND (
          run.status <> 'completed' OR run.evaluation_status <> 'ELIGIBLE_FOR_REVIEW'
          OR run.evaluation_result_hash IS NULL
        ))
     LIMIT 1`,
  );
  if (invalidDecisions.length > 0) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }

  const unownedArtifacts = await transaction.select<{ readonly id: string }>(
    `SELECT candidate.id
     FROM novel_skill_evaluation_suites AS suite
     INNER JOIN ai_candidates AS candidate ON candidate.project_id = suite.evaluation_project_id
     WHERE NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_observations AS observation
         ON observation.run_id = run.id AND observation.output_candidate_id = candidate.id
       WHERE run.suite_id = suite.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_dispatch_reservations AS reservation
         ON reservation.run_id = run.id
        AND (reservation.planned_candidate_id = candidate.id
          OR reservation.output_candidate_id = candidate.id)
       WHERE run.suite_id = suite.id
     )
     UNION ALL
     SELECT trace.id
     FROM novel_skill_evaluation_suites AS suite
     INNER JOIN context_compilation_runs AS trace
       ON trace.project_id = suite.evaluation_project_id
     WHERE NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_attempts AS attempt
         ON attempt.run_id = run.id AND attempt.context_trace_id = trace.id
       WHERE run.suite_id = suite.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_dispatch_reservations AS reservation
         ON reservation.run_id = run.id
        AND reservation.planned_context_trace_id = trace.id
       WHERE run.suite_id = suite.id
     )
     UNION ALL
     SELECT output_link.ai_candidate_id
     FROM novel_skill_evaluation_suites AS suite
     INNER JOIN context_compilation_runs AS trace
       ON trace.project_id = suite.evaluation_project_id
     INNER JOIN context_compilation_output_candidate_links AS output_link
       ON output_link.trace_id = trace.id
     WHERE NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_observations AS observation
         ON observation.run_id = run.id
        AND observation.context_trace_id = output_link.trace_id
        AND observation.output_candidate_id = output_link.ai_candidate_id
       WHERE run.suite_id = suite.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_dispatch_reservations AS reservation
         ON reservation.run_id = run.id
        AND reservation.planned_context_trace_id = output_link.trace_id
        AND reservation.planned_candidate_id = output_link.ai_candidate_id
       WHERE run.suite_id = suite.id
     )
     UNION ALL
     SELECT model_link.model_invocation_id
     FROM novel_skill_evaluation_suites AS suite
     INNER JOIN context_compilation_runs AS trace
       ON trace.project_id = suite.evaluation_project_id
     INNER JOIN context_compilation_model_invocation_links AS model_link
       ON model_link.trace_id = trace.id
     WHERE NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_attempts AS attempt
         ON attempt.run_id = run.id
        AND attempt.context_trace_id = model_link.trace_id
        AND attempt.model_invocation_id = model_link.model_invocation_id
       WHERE run.suite_id = suite.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_dispatch_reservations AS reservation
         ON reservation.run_id = run.id
        AND reservation.planned_context_trace_id = model_link.trace_id
        AND reservation.planned_model_invocation_id = model_link.model_invocation_id
       WHERE run.suite_id = suite.id
     )
     UNION ALL
     SELECT execution.generation_id
     FROM novel_skill_evaluation_suites AS suite
     INNER JOIN context_compilation_runs AS trace
       ON trace.project_id = suite.evaluation_project_id
     INNER JOIN context_compilation_execution_links AS execution ON execution.trace_id = trace.id
     WHERE NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_attempts AS attempt
         ON attempt.run_id = run.id AND attempt.context_trace_id = execution.trace_id
       WHERE run.suite_id = suite.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_dispatch_reservations AS reservation
         ON reservation.run_id = run.id
        AND reservation.planned_context_trace_id = execution.trace_id
       WHERE run.suite_id = suite.id
     )
     LIMIT 1`,
  );
  if (unownedArtifacts.length > 0) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
}

async function auditRestoredNovelSkillPaidEvaluationAuthority(
  transaction: TransactionExecutor,
): Promise<void> {
  await auditRestoredPaidProtocolHashes(transaction);
  const exactTargets = await auditRestoredPaidTargetsAndAuthorizations(transaction);
  await auditRestoredPaidReservationHashes(transaction, exactTargets);

  const invalidProtocols = await transaction.select<{ readonly id: string }>(
    `SELECT protocol.suite_id AS id
     FROM novel_skill_evaluation_protocols AS protocol
     WHERE (SELECT count(*) FROM novel_skill_evaluation_context_baselines AS baseline
            WHERE baseline.suite_id = protocol.suite_id) <> 12
        OR (SELECT count(*) FROM novel_skill_evaluation_request_profiles AS profile
            WHERE profile.suite_id = protocol.suite_id) < 1
        OR EXISTS (
          SELECT 1 FROM novel_skill_evaluation_fixtures AS fixture
          WHERE fixture.suite_id = protocol.suite_id AND NOT EXISTS (
            SELECT 1 FROM novel_skill_evaluation_context_baselines AS baseline
            WHERE baseline.suite_id = fixture.suite_id
              AND baseline.fixture_id = fixture.fixture_id))
        OR EXISTS (
          SELECT 1 FROM novel_skill_evaluation_fixtures AS fixture
          WHERE fixture.suite_id = protocol.suite_id AND NOT EXISTS (
            SELECT 1 FROM novel_skill_evaluation_request_profiles AS profile
            WHERE profile.suite_id = fixture.suite_id
              AND profile.task_type = fixture.task_type))
        OR EXISTS (
          SELECT 1 FROM novel_skill_evaluation_request_profiles AS profile
          WHERE profile.suite_id = protocol.suite_id AND NOT EXISTS (
            SELECT 1 FROM novel_skill_evaluation_fixtures AS fixture
            WHERE fixture.suite_id = profile.suite_id
              AND fixture.task_type = profile.task_type))
     LIMIT 1`,
  );
  if (invalidProtocols.length > 0) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }

  const invalidRuns = await transaction.select<{ readonly id: string }>(
    `SELECT run.id
     FROM novel_skill_evaluation_runs AS run
     INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
     WHERE (
       run.status IN ('running','completed') AND (
         (SELECT count(*) FROM novel_skill_evaluation_run_model_targets AS target
          WHERE target.run_id = run.id) <> 2
         OR (SELECT count(*) FROM novel_skill_evaluation_dispatch_authorizations AS authorization
             WHERE authorization.run_id = run.id AND authorization.protocol_hash = protocol.protocol_hash
               AND authorization.authorized_call_count = 192
               AND authorization.commercial_use_acknowledged = 1) <> 1
       )
     )
     OR EXISTS (
       SELECT 1 FROM novel_skill_evaluation_dispatch_authorizations AS authorization
       WHERE authorization.run_id = run.id AND (
         authorization.protocol_hash <> protocol.protocol_hash
         OR NOT EXISTS (
           SELECT 1 FROM novel_skill_evaluation_run_model_targets AS target
           WHERE target.run_id = run.id)
         OR EXISTS (
           SELECT 1 FROM novel_skill_evaluation_run_model_targets AS target
           WHERE target.run_id = run.id AND NOT EXISTS (
             SELECT 1 FROM novel_skill_evaluation_authorization_limits AS limits
             WHERE limits.authorization_id = authorization.id
               AND limits.currency = target.currency))
         OR EXISTS (
           SELECT 1 FROM novel_skill_evaluation_authorization_limits AS limits
           WHERE limits.authorization_id = authorization.id AND NOT EXISTS (
             SELECT 1 FROM novel_skill_evaluation_run_model_targets AS target
             WHERE target.run_id = run.id AND target.currency = limits.currency))
       )
     )
     OR EXISTS (
       SELECT 1 FROM novel_skill_evaluation_run_model_targets AS target
       WHERE target.run_id = run.id AND (
         NOT EXISTS (
           SELECT 1 FROM json_each(run.model_assignments_json) AS assignment
           WHERE json_extract(assignment.value, '$.slotId') = target.model_slot_id
             AND json_extract(assignment.value, '$.modelIdentityHash') = target.model_identity_hash
             AND json_extract(assignment.value, '$.modelArtifactHash') = target.model_artifact_hash)
         OR NOT EXISTS (
           SELECT 1 FROM model_catalog_entries AS catalog
           INNER JOIN model_provider_connections AS connection
             ON connection.id = catalog.connection_id
           WHERE catalog.id = target.catalog_entry_id
             AND connection.id = target.connection_id
             AND catalog.provider_model_id = target.provider_model_id_snapshot)
         OR (run.status = 'running' AND NOT EXISTS (
           SELECT 1 FROM model_catalog_entries AS catalog
           INNER JOIN model_provider_connections AS connection
             ON connection.id = catalog.connection_id
           INNER JOIN model_cost_privacy_profiles AS cost
             ON cost.catalog_entry_id = catalog.id
           WHERE catalog.id = target.catalog_entry_id
             AND connection.id = target.connection_id
             AND connection.enabled = 1 AND connection.connection_status = 'ready'
             AND connection.credential_state = 'present'
             AND connection.revision = target.connection_revision
             AND catalog.availability = 'available' AND catalog.revision = target.catalog_revision
             AND cost.revision = target.cost_profile_revision
             AND cost.currency = target.currency
             AND cost.input_micros_per_million_tokens = target.input_micros_per_million_tokens
             AND cost.output_micros_per_million_tokens = target.output_micros_per_million_tokens
             AND cost.cached_input_micros_per_million_tokens
                 IS target.cached_input_micros_per_million_tokens
             AND cost.pricing_version = target.pricing_version
             AND cost.price_updated_at = target.price_updated_at))
       )
     )
     LIMIT 1`,
  );
  if (invalidRuns.length > 0) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }

  const invalidReservations = await transaction.select<{ readonly id: string }>(
    `SELECT reservation.id
     FROM novel_skill_evaluation_dispatch_reservations AS reservation
     INNER JOIN novel_skill_evaluation_attempts AS attempt ON attempt.id = reservation.attempt_id
     INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = reservation.cell_id
     INNER JOIN novel_skill_evaluation_runs AS run ON run.id = reservation.run_id
     INNER JOIN novel_skill_evaluation_dispatch_authorizations AS authorization
       ON authorization.id = reservation.authorization_id
     INNER JOIN novel_skill_evaluation_run_model_targets AS target
       ON target.run_id = reservation.run_id
      AND target.model_slot_id = reservation.model_slot_id
     INNER JOIN novel_skill_evaluation_fixtures AS fixture
       ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
     INNER JOIN novel_skill_evaluation_request_profiles AS profile
       ON profile.suite_id = cell.suite_id AND profile.task_type = fixture.task_type
     INNER JOIN novel_skill_evaluation_context_baselines AS baseline
       ON baseline.suite_id = cell.suite_id AND baseline.fixture_id = cell.fixture_id
     INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = cell.suite_id
     WHERE attempt.run_id <> reservation.run_id OR attempt.cell_id <> reservation.cell_id
        OR attempt.attempt_number <> reservation.dispatch_generation
        OR cell.run_id <> reservation.run_id OR run.suite_id <> cell.suite_id
        OR authorization.run_id <> reservation.run_id
        OR target.target_hash <> reservation.target_hash
        OR target.pricing_snapshot_hash <> reservation.pricing_snapshot_hash
        OR target.currency <> reservation.currency
        OR profile.request_profile_hash <> reservation.request_profile_hash
        OR baseline.compiled_baseline_hash <> reservation.context_baseline_hash
        OR protocol.prompt_template_hash <> reservation.prompt_template_hash
        OR (cell.arm = 'no_skill' AND reservation.skill_configuration_hash IS NOT NULL)
        OR (cell.arm <> 'no_skill'
            AND reservation.skill_configuration_hash IS NOT cell.arm_configuration_hash)
        OR (cell.arm = 'core_genre_preferences' AND reservation.preference_configuration_hash IS NOT (
              SELECT preference_configuration_hash FROM novel_skill_evaluation_suites
              WHERE id = cell.suite_id))
        OR (cell.arm <> 'core_genre_preferences'
            AND reservation.preference_configuration_hash IS NOT NULL)
        OR (reservation.state IN ('bound','dispatched','settled','ambiguous') AND (
              attempt.context_trace_id IS NOT reservation.planned_context_trace_id
              OR attempt.model_invocation_id IS NOT reservation.planned_model_invocation_id))
        OR (reservation.state = 'settled' AND reservation.settlement_outcome = 'succeeded'
            AND NOT EXISTS (
              SELECT 1 FROM ai_candidates AS candidate
              INNER JOIN context_compilation_output_candidate_links AS output_link
                ON output_link.ai_candidate_id = candidate.id
              WHERE candidate.id = reservation.output_candidate_id
                AND candidate.id = reservation.planned_candidate_id
                AND candidate.content_checksum = reservation.provider_visible_output_hash
                AND output_link.trace_id = reservation.planned_context_trace_id))
     UNION ALL
     SELECT reservation.id
     FROM novel_skill_evaluation_dispatch_reservations AS reservation
     INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = reservation.cell_id
     INNER JOIN novel_skill_evaluation_dispatch_reservations AS peer
       ON peer.run_id = reservation.run_id AND peer.id <> reservation.id
     INNER JOIN novel_skill_evaluation_cells AS peer_cell ON peer_cell.id = peer.cell_id
     WHERE cell.fixture_id = peer_cell.fixture_id
       AND cell.model_slot_id = peer_cell.model_slot_id
       AND cell.repetition = peer_cell.repetition
       AND (reservation.request_profile_hash <> peer.request_profile_hash
         OR reservation.context_baseline_hash <> peer.context_baseline_hash
         OR reservation.prompt_template_hash <> peer.prompt_template_hash
         OR reservation.invariant_request_hash <> peer.invariant_request_hash)
     UNION ALL
     SELECT min(reservation.id)
     FROM novel_skill_evaluation_dispatch_reservations AS reservation
     WHERE reservation.state IN ('dispatched','settled','ambiguous')
     GROUP BY reservation.cell_id HAVING count(*) > 1
     UNION ALL
     SELECT min(reservation.id)
     FROM novel_skill_evaluation_dispatch_reservations AS reservation
     WHERE reservation.state <> 'not_dispatched'
     GROUP BY reservation.authorization_id HAVING count(*) > 192
     UNION ALL
     SELECT min(reservation.id)
     FROM novel_skill_evaluation_dispatch_reservations AS reservation
     INNER JOIN novel_skill_evaluation_authorization_limits AS limits
       ON limits.authorization_id = reservation.authorization_id
      AND limits.currency = reservation.currency
     WHERE reservation.state <> 'not_dispatched'
     GROUP BY reservation.authorization_id, reservation.currency, limits.hard_ceiling_micros
     HAVING sum(CAST(reservation.reserved_max_cost_micros AS INTEGER))
          > CAST(limits.hard_ceiling_micros AS INTEGER)
     LIMIT 1`,
  );
  if (invalidReservations.length > 0) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }

  const visibleOutputs = await transaction.select<{
    readonly content_checksum: string | null;
    readonly provider_visible_output_hash: string;
  }>(
    `SELECT candidate.content_checksum,
            reservation.provider_visible_output_hash
     FROM novel_skill_evaluation_dispatch_reservations AS reservation
     INNER JOIN ai_candidates AS candidate ON candidate.id = reservation.output_candidate_id
     WHERE reservation.state = 'settled' AND reservation.settlement_outcome = 'succeeded'`,
  );
  for (const output of visibleOutputs) {
    if (output.content_checksum !== output.provider_visible_output_hash) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
  }

  const invalidReviews = await transaction.select<{ readonly id: string }>(
    `SELECT batch.id
     FROM novel_skill_evaluation_review_batches AS batch
     INNER JOIN novel_skill_evaluation_runs AS run ON run.id = batch.run_id
     INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
     LEFT JOIN novel_skill_evaluation_review_items AS item ON item.batch_id = batch.id
     LEFT JOIN novel_skill_evaluation_review_receipts AS receipt
       ON receipt.batch_id = item.batch_id AND receipt.blind_item_id = item.blind_item_id
     GROUP BY batch.id
     HAVING max(CASE WHEN batch.protocol_hash <> protocol.protocol_hash
        OR batch.rubric_version <> protocol.rubric_version
        OR batch.rubric_content_hash <> protocol.rubric_content_hash
        OR batch.blinding_protocol_version <> protocol.blinding_protocol_version
        OR batch.blinding_protocol_hash <> protocol.blinding_protocol_hash
        OR batch.randomization_protocol_version <> protocol.randomization_protocol_version
        OR batch.randomization_protocol_hash <> protocol.randomization_protocol_hash
       THEN 1 ELSE 0 END) = 1
        OR count(DISTINCT item.observation_id) <> 192
        OR count(DISTINCT item.randomized_position) <> 192
        OR min(item.randomized_position) <> 1 OR max(item.randomized_position) <> 192
        OR (run.status = 'completed' AND count(DISTINCT receipt.observation_id) <> 192)
     UNION ALL
     SELECT receipt.observation_id
     FROM novel_skill_evaluation_review_receipts AS receipt
     INNER JOIN novel_skill_evaluation_review_items AS item
       ON item.batch_id = receipt.batch_id AND item.blind_item_id = receipt.blind_item_id
     INNER JOIN novel_skill_evaluation_review_batches AS batch ON batch.id = item.batch_id
     LEFT JOIN novel_skill_evaluation_scores AS score
       ON score.observation_id = receipt.observation_id
      AND score.reviewer_id = receipt.reviewer_id
      AND score.rubric_version = receipt.rubric_version
      AND score.scored_at = receipt.scored_at
     WHERE receipt.observation_id <> item.observation_id
        OR receipt.reviewer_id <> batch.reviewer_id
        OR receipt.rubric_version <> batch.rubric_version
        OR receipt.rubric_content_hash <> batch.rubric_content_hash
     GROUP BY receipt.observation_id HAVING count(DISTINCT score.metric) <> 13
     UNION ALL
     SELECT run.id
     FROM novel_skill_evaluation_runs AS run
     INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
     WHERE run.status = 'completed' AND (
       (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
        WHERE reservation.run_id = run.id AND reservation.state = 'settled'
          AND reservation.settlement_outcome = 'succeeded') <> 192
       OR EXISTS (SELECT 1 FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id
            AND reservation.state IN ('reserved','bound','dispatched','ambiguous'))
       OR (SELECT count(*) FROM novel_skill_evaluation_review_receipts AS receipt
           INNER JOIN novel_skill_evaluation_review_batches AS batch
             ON batch.id = receipt.batch_id WHERE batch.run_id = run.id) <> 192)
     LIMIT 1`,
  );
  if (invalidReviews.length > 0) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
}

interface RestoredPaidProtocolRow {
  readonly suite_id: string;
  readonly schema_version: number;
  readonly execution_protocol_version: string;
  readonly protocol_hash: string;
  readonly request_profile_manifest_hash: string;
  readonly context_baseline_manifest_hash: string;
  readonly prompt_template_version: string;
  readonly prompt_template_hash: string;
  readonly rubric_version: string;
  readonly rubric_content_hash: string;
  readonly evaluator_contract_hash: string;
  readonly blinding_protocol_version: string;
  readonly blinding_protocol_hash: string;
  readonly randomization_protocol_version: string;
  readonly randomization_protocol_hash: string;
}

interface RestoredPaidRequestProfileRow {
  readonly task_type: string;
  readonly profile_version: string;
  readonly request_profile_hash: string;
  readonly maximum_input_tokens: number;
  readonly maximum_output_tokens: number;
  readonly temperature_basis_points: number;
  readonly top_p_basis_points: number;
  readonly reasoning_policy: string;
  readonly response_format: string;
  readonly streaming: number;
  readonly stop_policy_hash: string;
}

interface RestoredPaidContextBaselineRow {
  readonly fixture_id: string;
  readonly baseline_contract_hash: string;
  readonly included_source_manifest_hash: string;
  readonly omitted_source_manifest_hash: string;
  readonly compiled_baseline_hash: string;
  readonly baseline_token_budget: number;
  readonly fixture_contract_hash: string;
}

async function auditRestoredPaidProtocolHashes(transaction: TransactionExecutor): Promise<void> {
  const protocols = await transaction.select<RestoredPaidProtocolRow>(
    `SELECT suite_id, schema_version, execution_protocol_version, protocol_hash,
            request_profile_manifest_hash, context_baseline_manifest_hash,
            prompt_template_version, prompt_template_hash, rubric_version,
            rubric_content_hash, evaluator_contract_hash, blinding_protocol_version,
            blinding_protocol_hash, randomization_protocol_version,
            randomization_protocol_hash
     FROM novel_skill_evaluation_protocols ORDER BY suite_id`,
  );
  for (const protocol of protocols) {
    const profiles = await transaction.select<RestoredPaidRequestProfileRow>(
      `SELECT task_type, profile_version, request_profile_hash, maximum_input_tokens,
              maximum_output_tokens, temperature_basis_points, top_p_basis_points,
              reasoning_policy, response_format, streaming, stop_policy_hash
       FROM novel_skill_evaluation_request_profiles
       WHERE suite_id = ? ORDER BY task_type`,
      [protocol.suite_id],
    );
    const normalizedProfiles = profiles.map((profile) => ({
      taskType: profile.task_type,
      profileVersion: profile.profile_version,
      requestProfileHash: profile.request_profile_hash,
      maximumInputTokens: profile.maximum_input_tokens,
      maximumOutputTokens: profile.maximum_output_tokens,
      temperatureBasisPoints: profile.temperature_basis_points,
      topPBasisPoints: profile.top_p_basis_points,
      streaming: profile.streaming === 1,
      stopPolicyHash: profile.stop_policy_hash,
    }));
    for (const profile of profiles) {
      const requestProfileHash = await sha256Text(
        canonicalJson({
          version: profile.profile_version,
          task: profile.task_type,
          maximumInputTokens: profile.maximum_input_tokens,
          maximumOutputTokens: profile.maximum_output_tokens,
          temperatureBasisPoints: profile.temperature_basis_points,
          topPBasisPoints: profile.top_p_basis_points,
          reasoningMode: profile.reasoning_policy,
          responseFormat: profile.response_format,
          streaming: profile.streaming === 1,
          stopPolicyHash: profile.stop_policy_hash,
          providerCallPolicy: "single_attempt",
        }),
      );
      if (requestProfileHash !== profile.request_profile_hash) {
        throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
      }
      if (profile.maximum_output_tokens > 1_000_000) {
        throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
      }
    }
    const baselines = await transaction.select<RestoredPaidContextBaselineRow>(
      `SELECT baseline.fixture_id, baseline.baseline_contract_hash,
              baseline.included_source_manifest_hash, baseline.omitted_source_manifest_hash,
              baseline.compiled_baseline_hash, baseline.baseline_token_budget,
              fixture.contract_hash AS fixture_contract_hash
       FROM novel_skill_evaluation_context_baselines AS baseline
       INNER JOIN novel_skill_evaluation_fixtures AS fixture
         ON fixture.suite_id = baseline.suite_id AND fixture.fixture_id = baseline.fixture_id
       WHERE baseline.suite_id = ? ORDER BY baseline.fixture_id`,
      [protocol.suite_id],
    );
    if (
      baselines.some(
        (baseline) => baseline.baseline_contract_hash !== baseline.fixture_contract_hash,
      )
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    const normalizedBaselines = baselines.map((baseline) => ({
      fixtureId: baseline.fixture_id,
      baselineContractHash: baseline.baseline_contract_hash,
      includedSourceManifestHash: baseline.included_source_manifest_hash,
      omittedSourceManifestHash: baseline.omitted_source_manifest_hash,
      compiledBaselineHash: baseline.compiled_baseline_hash,
      baselineTokenBudget: baseline.baseline_token_budget,
    }));
    const requestProfileManifestHash = await sha256Text(canonicalJson(normalizedProfiles));
    const contextBaselineManifestHash = await sha256Text(canonicalJson(normalizedBaselines));
    const protocolHash = await sha256Text(
      canonicalJson({
        schemaVersion: protocol.schema_version,
        executionProtocolVersion: protocol.execution_protocol_version,
        suiteId: protocol.suite_id,
        requestProfileManifestHash,
        contextBaselineManifestHash,
        promptTemplateVersion: protocol.prompt_template_version,
        promptTemplateHash: protocol.prompt_template_hash,
        rubricVersion: protocol.rubric_version,
        rubricContentHash: protocol.rubric_content_hash,
        evaluatorContractHash: protocol.evaluator_contract_hash,
        blindingProtocolVersion: protocol.blinding_protocol_version,
        blindingProtocolHash: protocol.blinding_protocol_hash,
        randomizationProtocolVersion: protocol.randomization_protocol_version,
        randomizationProtocolHash: protocol.randomization_protocol_hash,
      }),
    );
    if (
      protocol.schema_version !== 1 ||
      protocol.execution_protocol_version !== "novel-skill-paid-ab@1" ||
      protocol.rubric_version !== "novel-skill-human-rubric@1" ||
      protocol.request_profile_manifest_hash !== requestProfileManifestHash ||
      protocol.context_baseline_manifest_hash !== contextBaselineManifestHash ||
      protocol.protocol_hash !== protocolHash
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
  }
}

interface RestoredPaidTargetRow {
  readonly run_id: string;
  readonly model_slot_id: string;
  readonly connection_id: string;
  readonly catalog_entry_id: string;
  readonly provider_kind_snapshot: string;
  readonly connection_protocol_snapshot: string;
  readonly connection_revision: number;
  readonly connection_configuration_hash: string;
  readonly catalog_revision: number;
  readonly provider_model_id_snapshot: string;
  readonly catalog_identity_hash: string;
  readonly model_identity_hash: string;
  readonly model_artifact_hash: string;
  readonly artifact_identity_source: string;
  readonly cost_profile_revision: number;
  readonly currency: string;
  readonly input_rate: string;
  readonly output_rate: string;
  readonly cached_input_rate: string | null;
  readonly pricing_version: string;
  readonly price_updated_at: string;
  readonly pricing_snapshot_hash: string;
  readonly target_hash: string;
  readonly provider_kind: string;
  readonly protocol: string;
  readonly region: string | null;
  readonly workspace_id: string | null;
  readonly endpoint_id: string | null;
  readonly base_url: string;
  readonly credential_ref: string | null;
  readonly credential_state: string;
  readonly authentication_mode: string;
  readonly credential_header_name: string | null;
  readonly model_discovery_path: string | null;
  readonly text_generation_path: string | null;
  readonly embedding_path: string | null;
  readonly request_timeout_ms: number | null;
  readonly retry_limit: number | null;
  readonly connection_enabled: number;
  readonly connection_status: string;
  readonly live_connection_revision: number;
  readonly catalog_connection_id: string;
  readonly provider_model_id: string;
  readonly catalog_source: string;
  readonly availability: string;
  readonly lifecycle: string;
  readonly input_token_limit: number | null;
  readonly output_token_limit: number | null;
  readonly stale_after: string | null;
  readonly live_catalog_revision: number;
  readonly live_currency: string | null;
  readonly live_input_rate: string | null;
  readonly live_output_rate: string | null;
  readonly live_cached_input_rate: string | null;
  readonly live_pricing_version: string | null;
  readonly live_price_updated_at: string | null;
  readonly data_destination: string;
  readonly retention_policy: string;
  readonly training_policy: string;
  readonly evidence_source: string;
  readonly evidence_version: string | null;
  readonly evidence_summary: string | null;
  readonly evidence_updated_at: string;
  readonly live_cost_revision: number;
  readonly cost_created_at: string;
  readonly cost_updated_at: string;
}

interface RestoredPaidExactTarget {
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: string;
  readonly modelId: string;
  readonly connectionRevision: number;
  readonly catalogRevision: number;
  readonly costPrivacyRevision: number;
  readonly capabilityEvidenceHash: string;
  readonly costProfileHash: string;
  readonly targetIdentityHash: string;
}

interface RestoredPaidCapabilityEvidenceRow {
  readonly id: string;
  readonly catalog_entry_id: string;
  readonly scan_id: string | null;
  readonly capability: string;
  readonly verdict: string;
  readonly evidence_source: string;
  readonly evidence_version: string;
  readonly evidence_summary: string | null;
  readonly observed_at: string;
  readonly expires_at: string | null;
}

interface RestoredPaidAuthorizationRow {
  readonly id: string;
  readonly run_id: string;
  readonly protocol_hash: string;
  readonly target_manifest_hash: string;
  readonly pricing_manifest_hash: string;
  readonly quote_hash: string;
  readonly confirmation_hash: string;
  readonly authorized_call_count: number;
  readonly authorized_by: string;
  readonly commercial_use_acknowledged: number;
}

interface RestoredPaidAuthorizationLimitRow {
  readonly currency: string;
  readonly estimated_max_cost_micros: string;
  readonly hard_ceiling_micros: string;
}

function restoredPaidConnectionProjection(target: RestoredPaidTargetRow) {
  return {
    id: target.connection_id,
    providerKind: target.provider_kind,
    protocol: target.protocol,
    region: target.region,
    workspaceId: target.workspace_id,
    endpointId: target.endpoint_id,
    baseUrl: target.base_url,
    credentialRef: target.credential_ref,
    credentialState: target.credential_state,
    authenticationMode: target.authentication_mode,
    credentialHeaderName: target.credential_header_name,
    modelDiscoveryPath: target.model_discovery_path,
    textGenerationPath: target.text_generation_path,
    embeddingPath: target.embedding_path,
    requestTimeoutMs: target.request_timeout_ms,
    retryLimit: target.retry_limit,
    revision: target.live_connection_revision,
  };
}

function restoredPaidCatalogProjection(target: RestoredPaidTargetRow) {
  return {
    id: target.catalog_entry_id,
    connectionId: target.catalog_connection_id,
    providerModelId: target.provider_model_id,
    catalogSource: target.catalog_source,
    availability: target.availability,
    lifecycle: target.lifecycle,
    inputTokenLimit: target.input_token_limit,
    outputTokenLimit: target.output_token_limit,
    staleAfter: target.stale_after,
    revision: target.live_catalog_revision,
  };
}

function restoredPaidCostProjection(target: RestoredPaidTargetRow) {
  return {
    catalogEntryId: target.catalog_entry_id,
    currency: target.live_currency,
    inputMicrosPerMillionTokens: target.live_input_rate,
    outputMicrosPerMillionTokens: target.live_output_rate,
    cachedInputMicrosPerMillionTokens: target.live_cached_input_rate,
    pricingVersion: target.live_pricing_version,
    priceUpdatedAt: target.live_price_updated_at,
    dataDestination: target.data_destination,
    retentionPolicy: target.retention_policy,
    trainingPolicy: target.training_policy,
    evidenceSource: target.evidence_source,
    evidenceVersion: target.evidence_version,
    evidenceSummary: target.evidence_summary,
    evidenceUpdatedAt: target.evidence_updated_at,
    revision: target.live_cost_revision,
    createdAt: target.cost_created_at,
    updatedAt: target.cost_updated_at,
  };
}

function restoredPaidCredentialProviderId(target: RestoredPaidTargetRow): string | null {
  if (target.authentication_mode === "none") return target.connection_id;
  for (const prefix of ["keyring:model-hub:", "keyring:legacy-model-profile:"]) {
    if (target.credential_ref?.startsWith(prefix) === true) {
      const providerId = target.credential_ref.slice(prefix.length);
      return /^[A-Za-z0-9._-]{1,128}$/u.test(providerId) ? providerId : null;
    }
  }
  return null;
}

function restoredPaidFinalDispatchIdentity(target: RestoredPaidTargetRow): string | null {
  const providerId = restoredPaidCredentialProviderId(target);
  if (providerId === null) return null;
  const custom = target.provider_kind === "custom_openai_compatible";
  const nativeProvider =
    target.protocol === "openai_compatible" ? "open_ai_compatible" : target.protocol;
  return JSON.stringify([
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    target.connection_id,
    target.live_connection_revision,
    target.connection_enabled === 1,
    target.provider_kind,
    target.protocol,
    target.base_url,
    target.credential_ref,
    target.credential_state,
    target.catalog_entry_id,
    target.live_catalog_revision,
    target.catalog_connection_id,
    target.provider_model_id,
    target.availability,
    target.lifecycle,
    target.stale_after,
    target.live_cost_revision,
    providerId,
    nativeProvider,
    target.base_url,
    target.authentication_mode,
    custom ? target.credential_header_name : null,
    custom ? target.model_discovery_path : null,
    custom ? target.text_generation_path : null,
    custom ? target.embedding_path : null,
    target.request_timeout_ms,
    target.retry_limit,
  ]);
}

async function auditRestoredPaidTargetsAndAuthorizations(
  transaction: TransactionExecutor,
): Promise<ReadonlyMap<string, RestoredPaidExactTarget>> {
  const targets = await transaction.select<RestoredPaidTargetRow>(
    `SELECT target.run_id, target.model_slot_id, target.connection_id, target.catalog_entry_id,
            target.provider_kind_snapshot, target.connection_protocol_snapshot,
            target.connection_revision, target.connection_configuration_hash,
            target.catalog_revision, target.provider_model_id_snapshot,
            target.catalog_identity_hash, target.model_identity_hash,
            target.model_artifact_hash, target.artifact_identity_source,
            target.cost_profile_revision, target.currency,
            target.input_micros_per_million_tokens AS input_rate,
            target.output_micros_per_million_tokens AS output_rate,
            target.cached_input_micros_per_million_tokens AS cached_input_rate,
            target.pricing_version, target.price_updated_at,
            target.pricing_snapshot_hash, target.target_hash,
            connection.provider_kind, connection.protocol, connection.region,
            connection.workspace_id, connection.endpoint_id, connection.base_url,
            connection.credential_ref, connection.credential_state,
            connection.authentication_mode, connection.credential_header_name,
            connection.model_discovery_path, connection.text_generation_path,
            connection.embedding_path, connection.request_timeout_ms, connection.retry_limit,
            connection.enabled AS connection_enabled,
            connection.connection_status, connection.revision AS live_connection_revision,
            catalog.connection_id AS catalog_connection_id, catalog.provider_model_id,
            catalog.catalog_source, catalog.availability, catalog.lifecycle,
            catalog.input_token_limit, catalog.output_token_limit, catalog.stale_after,
            catalog.revision AS live_catalog_revision,
            cost.currency AS live_currency,
            cost.input_micros_per_million_tokens AS live_input_rate,
            cost.output_micros_per_million_tokens AS live_output_rate,
            cost.cached_input_micros_per_million_tokens AS live_cached_input_rate,
            cost.pricing_version AS live_pricing_version,
            cost.price_updated_at AS live_price_updated_at,
            cost.data_destination, cost.retention_policy, cost.training_policy,
            cost.evidence_source, cost.evidence_version, cost.evidence_summary,
            cost.evidence_updated_at, cost.revision AS live_cost_revision,
            cost.created_at AS cost_created_at, cost.updated_at AS cost_updated_at
     FROM novel_skill_evaluation_run_model_targets AS target
     INNER JOIN model_provider_connections AS connection ON connection.id = target.connection_id
     INNER JOIN model_catalog_entries AS catalog ON catalog.id = target.catalog_entry_id
     INNER JOIN model_cost_privacy_profiles AS cost ON cost.catalog_entry_id = catalog.id
     ORDER BY target.run_id, target.model_slot_id`,
  );
  const exactTargets = new Map<string, RestoredPaidExactTarget>();
  for (const target of targets) {
    const evidence = await transaction.select<RestoredPaidCapabilityEvidenceRow>(
      `SELECT id, catalog_entry_id, scan_id, capability, verdict, evidence_source,
              evidence_version, evidence_summary, observed_at, expires_at
       FROM model_capability_evidence
       WHERE catalog_entry_id = ? AND capability = 'text_generation'`,
      [target.catalog_entry_id],
    );
    const capabilityEvidenceHash = await sha256Text(
      canonicalJson({
        requiredCapabilities: ["text_generation"],
        evidence: evidence
          .map((item) => ({
            id: item.id,
            catalogEntryId: item.catalog_entry_id,
            scanId: item.scan_id,
            capability: item.capability,
            verdict: item.verdict,
            evidenceSource: item.evidence_source,
            evidenceVersion: item.evidence_version,
            evidenceSummary: item.evidence_summary,
            observedAt: item.observed_at,
            expiresAt: item.expires_at,
          }))
          .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), "en")),
      }),
    );
    const connectionConfigurationHash = await sha256Text(
      canonicalJson(restoredPaidConnectionProjection(target)),
    );
    const catalogIdentityHash = await sha256Text(
      canonicalJson(restoredPaidCatalogProjection(target)),
    );
    const pricingSnapshotHash = await sha256Text(canonicalJson(restoredPaidCostProjection(target)));
    const finalDispatchIdentity = restoredPaidFinalDispatchIdentity(target);
    const targetHash =
      finalDispatchIdentity === null
        ? null
        : await sha256Text(
            canonicalJson({
              version: "model-hub-exact-evaluation-target@1",
              finalDispatchIdentity,
              capabilityEvidenceHash,
              costProfileHash: pricingSnapshotHash,
            }),
          );
    const modelIdentityHash = await sha256Text(
      JSON.stringify({
        catalogEntryId: target.catalog_entry_id,
        connectionId: target.connection_id,
        modelId: target.provider_model_id,
        providerKind: target.provider_kind,
      }),
    );
    const modelArtifactHash = await sha256Text(
      JSON.stringify({ modelId: target.provider_model_id, providerKind: target.provider_kind }),
    );
    if (
      targetHash === null ||
      !evidence.some(({ verdict }) => verdict === "supported") ||
      target.connection_status !== "ready" ||
      target.connection_enabled !== 1 ||
      target.credential_state !== "present" ||
      target.provider_kind_snapshot !== target.provider_kind ||
      target.connection_protocol_snapshot !== target.protocol ||
      target.connection_revision !== target.live_connection_revision ||
      target.connection_configuration_hash !== connectionConfigurationHash ||
      target.catalog_connection_id !== target.connection_id ||
      target.catalog_revision !== target.live_catalog_revision ||
      target.provider_model_id_snapshot !== target.provider_model_id ||
      target.catalog_identity_hash !== catalogIdentityHash ||
      target.model_identity_hash !== modelIdentityHash ||
      target.model_artifact_hash !== modelArtifactHash ||
      target.artifact_identity_source !== "provider_model_id" ||
      target.cost_profile_revision !== target.live_cost_revision ||
      target.currency !== target.live_currency ||
      target.input_rate !== target.live_input_rate ||
      target.output_rate !== target.live_output_rate ||
      target.cached_input_rate !== target.live_cached_input_rate ||
      target.pricing_version !== target.live_pricing_version ||
      target.price_updated_at !== target.live_price_updated_at ||
      target.pricing_snapshot_hash !== pricingSnapshotHash ||
      target.target_hash !== targetHash
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    exactTargets.set(`${target.run_id}/${target.model_slot_id}`, {
      connectionId: target.connection_id,
      catalogEntryId: target.catalog_entry_id,
      providerKind: target.provider_kind,
      modelId: target.provider_model_id,
      connectionRevision: target.connection_revision,
      catalogRevision: target.catalog_revision,
      costPrivacyRevision: target.cost_profile_revision,
      capabilityEvidenceHash,
      costProfileHash: pricingSnapshotHash,
      targetIdentityHash: targetHash,
    });
  }
  await auditRestoredPaidCommercialAuthorizations(transaction, targets);
  return exactTargets;
}

interface RestoredPaidQuoteWorkRow {
  readonly currency: string;
  readonly input_rate: string;
  readonly output_rate: string;
  readonly maximum_input_tokens: number;
  readonly maximum_output_tokens: number;
  readonly input_token_limit: number | null;
  readonly output_token_limit: number | null;
  readonly cell_count: number;
}

function restoredPaidMaximumCost(
  maximumInputTokens: number,
  maximumOutputTokens: number,
  inputRate: string,
  outputRate: string,
): bigint {
  const numerator =
    BigInt(maximumInputTokens) * BigInt(inputRate) +
    BigInt(maximumOutputTokens) * BigInt(outputRate);
  return (numerator + 999_999n) / 1_000_000n;
}

async function auditRestoredPaidCommercialAuthorizations(
  transaction: TransactionExecutor,
  targets: readonly RestoredPaidTargetRow[],
): Promise<void> {
  const authorizations = await transaction.select<RestoredPaidAuthorizationRow>(
    `SELECT id, run_id, protocol_hash, target_manifest_hash, pricing_manifest_hash,
            quote_hash, confirmation_hash, authorized_call_count, authorized_by,
            commercial_use_acknowledged
     FROM novel_skill_evaluation_dispatch_authorizations ORDER BY run_id`,
  );
  for (const authorization of authorizations) {
    const runTargets = targets.filter(({ run_id }) => run_id === authorization.run_id);
    if (runTargets.length !== 2) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    const targetManifestHash = await sha256Text(
      canonicalJson(
        runTargets.map((target) => ({
          modelSlotId: target.model_slot_id,
          connectionId: target.connection_id,
          catalogEntryId: target.catalog_entry_id,
          modelIdentityHash: target.model_identity_hash,
          modelArtifactHash: target.model_artifact_hash,
          targetHash: target.target_hash,
        })),
      ),
    );
    const pricingManifestHash = await sha256Text(
      canonicalJson(
        runTargets.map((target) => ({
          modelSlotId: target.model_slot_id,
          currency: target.currency,
          inputRate: target.input_rate,
          outputRate: target.output_rate,
          pricingSnapshotHash: target.pricing_snapshot_hash,
        })),
      ),
    );
    const work = await transaction.select<RestoredPaidQuoteWorkRow>(
      `SELECT target.currency,
              target.input_micros_per_million_tokens AS input_rate,
              target.output_micros_per_million_tokens AS output_rate,
              profile.maximum_input_tokens, profile.maximum_output_tokens,
              catalog.input_token_limit, catalog.output_token_limit,
              count(*) AS cell_count
       FROM novel_skill_evaluation_cells AS cell
       INNER JOIN novel_skill_evaluation_fixtures AS fixture
         ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
       INNER JOIN novel_skill_evaluation_request_profiles AS profile
         ON profile.suite_id = fixture.suite_id AND profile.task_type = fixture.task_type
       INNER JOIN novel_skill_evaluation_run_model_targets AS target
         ON target.run_id = cell.run_id AND target.model_slot_id = cell.model_slot_id
       INNER JOIN model_catalog_entries AS catalog ON catalog.id = target.catalog_entry_id
       WHERE cell.run_id = ?
       GROUP BY target.model_slot_id, target.currency,
                target.input_micros_per_million_tokens,
                target.output_micros_per_million_tokens,
                fixture.task_type, profile.maximum_input_tokens,
                profile.maximum_output_tokens, catalog.input_token_limit,
                catalog.output_token_limit
       ORDER BY target.model_slot_id, fixture.task_type`,
      [authorization.run_id],
    );
    if (work.reduce((total, row) => total + row.cell_count, 0) !== 192) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    const totals = new Map<string, bigint>();
    for (const row of work) {
      if (
        row.input_token_limit === null ||
        row.output_token_limit === null ||
        row.maximum_output_tokens > row.output_token_limit ||
        row.maximum_input_tokens + row.maximum_output_tokens > row.input_token_limit
      ) {
        throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
      }
      const maximumPerCall = restoredPaidMaximumCost(
        row.maximum_input_tokens,
        row.maximum_output_tokens,
        row.input_rate,
        row.output_rate,
      );
      totals.set(
        row.currency,
        (totals.get(row.currency) ?? 0n) + maximumPerCall * BigInt(row.cell_count),
      );
    }
    const currencies = [...totals]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([currency, estimatedMaximumCost]) => ({
        currency,
        estimatedMaximumCostMicros: estimatedMaximumCost.toString(),
      }));
    const quoteHash = await sha256Text(
      canonicalJson({
        version: "novel-skill-paid-evaluation-quote@1",
        runId: authorization.run_id,
        protocolHash: authorization.protocol_hash,
        targetManifestHash,
        pricingManifestHash,
        authorizedCallCount: 192,
        currencies,
      }),
    );
    const limits = await transaction.select<RestoredPaidAuthorizationLimitRow>(
      `SELECT currency, estimated_max_cost_micros, hard_ceiling_micros
       FROM novel_skill_evaluation_authorization_limits
       WHERE authorization_id = ? ORDER BY currency`,
      [authorization.id],
    );
    const confirmationCurrencies = currencies.map((currency) => {
      const limit = limits.find((candidate) => candidate.currency === currency.currency);
      if (limit === undefined) {
        throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
      }
      if (
        limit.estimated_max_cost_micros !== currency.estimatedMaximumCostMicros ||
        BigInt(limit.hard_ceiling_micros) < BigInt(currency.estimatedMaximumCostMicros)
      ) {
        throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
      }
      return { ...currency, hardCeilingMicros: limit.hard_ceiling_micros };
    });
    const confirmationHash = await sha256Text(
      canonicalJson({
        version: "novel-skill-paid-commercial-confirmation@1",
        runId: authorization.run_id,
        protocolHash: authorization.protocol_hash,
        targetManifestHash,
        pricingManifestHash,
        quoteHash,
        authorizedCallCount: 192,
        currencies: confirmationCurrencies,
        acknowledgements: {
          commercialUse: true,
          exactTargetsOnly: true,
          fallbackAllowed: false,
          automaticRetryAllowed: false,
          automaticResumeAfterRestart: false,
          perCurrencyHardCeilings: true,
        },
      }),
    );
    if (
      limits.length !== currencies.length ||
      authorization.authorized_call_count !== 192 ||
      authorization.authorized_by !== "local_user" ||
      authorization.commercial_use_acknowledged !== 1 ||
      authorization.target_manifest_hash !== targetManifestHash ||
      authorization.pricing_manifest_hash !== pricingManifestHash ||
      authorization.quote_hash !== quoteHash ||
      authorization.confirmation_hash !== confirmationHash
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
  }
}

interface RestoredPaidReservationHashRow {
  readonly id: string;
  readonly authorization_id: string;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly suite_id: string;
  readonly cell_id: string;
  readonly fixture_id: string;
  readonly fixture_contract_hash: string;
  readonly fixture_input_content_hash: string;
  readonly task_type: string;
  readonly invocation_mode: string;
  readonly genre_tags_json: string;
  readonly coverage_dimensions_json: string;
  readonly arm: string;
  readonly arm_configuration_hash: string | null;
  readonly model_slot_id: string;
  readonly dispatch_generation: number;
  readonly repetition: number;
  readonly state: string;
  readonly protocol_hash: string;
  readonly prompt_template_version: string;
  readonly prompt_template_hash: string;
  readonly baseline_contract_hash: string;
  readonly included_source_manifest_hash: string;
  readonly omitted_source_manifest_hash: string;
  readonly compiled_baseline_hash: string;
  readonly baseline_token_budget: number;
  readonly request_profile_hash: string;
  readonly maximum_input_tokens: number;
  readonly maximum_output_tokens: number;
  readonly invariant_request_hash: string;
  readonly request_payload_hash: string;
  readonly execution_lock_hash: string;
  readonly message_payload_hash: string;
  readonly payload_authority_version: string;
  readonly payload_authority_manifest_hash: string;
  readonly data_destination: string;
  readonly skill_configuration_hash: string | null;
  readonly preference_configuration_hash: string | null;
  readonly currency: string;
  readonly reserved_max_cost_micros: string;
  readonly settlement_outcome: string | null;
  readonly provider_receipt_hash: string | null;
  readonly provider_visible_output_hash: string | null;
  readonly output_candidate_id: string | null;
  readonly actual_cost_micros: string | null;
  readonly planned_context_trace_id: string;
  readonly planned_model_invocation_id: string;
  readonly planned_candidate_id: string;
  readonly idempotency_key_hash: string;
  readonly reserved_at: string;
  readonly terminal_at: string | null;
  readonly invocation_status: string | null;
  readonly invocation_error_code: string | null;
  readonly invocation_input_tokens: number | null;
  readonly invocation_output_tokens: number | null;
  readonly invocation_cached_input_tokens: number | null;
  readonly invocation_cost_micros: string | null;
  readonly invocation_currency: string | null;
  readonly invocation_completed_at: string | null;
  readonly invocation_visible_content_length: number | null;
  readonly invocation_streamed: number | null;
  readonly invocation_requested_max_output_tokens: number | null;
  readonly attempt_error_code: string | null;
  readonly candidate_checksum: string | null;
  readonly target_input_rate: string;
  readonly target_output_rate: string;
  readonly target_cached_input_rate: string | null;
}

interface RestoredPaidPredispatchAuthorityRow {
  readonly reservation_id: string;
  readonly schema_version: number;
  readonly authority_snapshot_version: string;
  readonly payload_authority_schema_version: number;
  readonly payload_authority_version: string;
  readonly payload_authority_manifest_hash: string;
  readonly run_id: string;
  readonly suite_id: string;
  readonly cell_id: string;
  readonly fixture_id: string;
  readonly fixture_contract_hash: string;
  readonly fixture_input_content_hash: string;
  readonly task_type: string;
  readonly invocation_mode: string;
  readonly genre_tags_hash: string;
  readonly coverage_dimensions_hash: string;
  readonly arm: string;
  readonly arm_configuration_hash: string | null;
  readonly model_slot_id: string;
  readonly repetition: number;
  readonly prompt_template_version: string;
  readonly prompt_template_hash: string;
  readonly context_baseline_hash: string;
  readonly context_baseline_projection_hash: string;
  readonly available_context_layers_hash: string;
  readonly skill_compiler_version: string;
  readonly skill_selection_hash: string | null;
  readonly compiled_skill_snapshot_hash: string | null;
  readonly rendered_skill_section_hash: string | null;
  readonly preference_configuration_hash: string | null;
  readonly preference_projection_hash: string | null;
  readonly rendered_preference_section_hash: string | null;
  readonly base_message_payload_hash: string;
  readonly message_payload_hash: string;
  readonly generation_id: string;
  readonly connection_id: string;
  readonly catalog_entry_id: string;
  readonly provider_kind: string;
  readonly provider_model_id: string;
  readonly connection_revision: number;
  readonly catalog_revision: number;
  readonly cost_privacy_revision: number;
  readonly capability_evidence_hash: string;
  readonly cost_profile_hash: string;
  readonly target_identity_hash: string;
  readonly request_profile_hash: string;
  readonly request_payload_hash: string;
  readonly execution_lock_hash: string;
  readonly currency: string;
  readonly exact_predispatch_estimated_max_cost_micros: string;
  readonly data_destination: string;
  readonly provider_receipt_shape_version: string;
  readonly provider_receipt_shape_hash: string;
  readonly final_dispatch_authority_version: string;
  readonly final_dispatch_authority_hash: string;
  readonly authority_snapshot_hash: string;
  readonly captured_at: string;
}

interface RestoredPaidTraceRow {
  readonly task_type: string;
  readonly maximum_context_tokens: number;
  readonly required_tokens: number;
  readonly used_tokens: number;
  readonly remaining_tokens: number;
  readonly discarded_tokens: number;
  readonly token_estimate_source: string;
}

interface RestoredPaidTraceEntryRow {
  readonly candidate_id: string;
  readonly layer: string;
  readonly selection_reason: string;
  readonly included: number;
  readonly discarded_reason: string | null;
  readonly estimated_tokens: number;
  readonly evaluation_order: number;
  readonly layer_order: number;
  readonly priority: number;
  readonly relevance_score: number | null;
  readonly required: number;
  readonly budget_remaining_before: number;
  readonly budget_remaining_after: number;
  readonly source_order: number | null;
  readonly source_type: string | null;
  readonly source_id: string | null;
  readonly source_version_id: string | null;
  readonly locator: string | null;
  readonly content_hash: string | null;
}

async function restoredPaidTraceBaselineProjection(
  transaction: TransactionExecutor,
  traceId: string,
): Promise<{
  readonly availableContextLayers: readonly string[];
  readonly traceBaseline: Readonly<Record<string, unknown>>;
}> {
  const traces = await transaction.select<RestoredPaidTraceRow>(
    `SELECT task_type, maximum_context_tokens, required_tokens, used_tokens,
            remaining_tokens, discarded_tokens, token_estimate_source
     FROM context_compilation_runs WHERE id = ?`,
    [traceId],
  );
  const trace = traces[0];
  if (trace === undefined) throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  const rows = await transaction.select<RestoredPaidTraceEntryRow>(
    `SELECT entry.candidate_id, entry.layer, entry.selection_reason, entry.included,
            entry.discarded_reason, entry.estimated_tokens, entry.evaluation_order,
            entry.layer_order, entry.priority, entry.relevance_score, entry.required,
            entry.budget_remaining_before, entry.budget_remaining_after,
            source.source_order, source.source_type, source.source_id,
            source.source_version_id, source.locator, source.content_hash
     FROM context_compilation_entries AS entry
     LEFT JOIN context_compilation_entry_sources AS source
       ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
     WHERE entry.run_id = ? AND entry.candidate_id NOT GLOB 'writing-preference:*'
     ORDER BY entry.evaluation_order, entry.candidate_id, source.source_order`,
    [traceId],
  );
  const entries = new Map<string, RestoredPaidTraceEntryRow[]>();
  for (const row of rows) {
    const group = entries.get(row.candidate_id) ?? [];
    group.push(row);
    entries.set(row.candidate_id, group);
  }
  const projectedEntries = [...entries.values()].map((group) => {
    const entry = group[0];
    if (entry === undefined || group.some((candidate) => candidate.layer !== entry.layer)) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    const sources = group.map((source) => {
      if (
        source.source_order === null ||
        source.source_type === null ||
        source.source_id === null ||
        source.content_hash === null
      ) {
        throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
      }
      return {
        sourceOrder: source.source_order,
        sourceType: source.source_type,
        sourceId: source.source_id,
        sourceVersionId: source.source_version_id,
        locator: source.locator,
        contentHash: source.content_hash,
      };
    });
    return {
      contextCandidateId: entry.candidate_id,
      layer: entry.layer,
      selectionReason: entry.selection_reason,
      included: entry.included === 1,
      discardedReason: entry.discarded_reason,
      estimatedTokens: entry.estimated_tokens,
      evaluationOrder: entry.evaluation_order,
      layerOrder: entry.layer_order,
      priority: entry.priority,
      relevanceScore: entry.relevance_score,
      required: entry.required === 1,
      budgetRemainingBefore: entry.budget_remaining_before,
      budgetRemainingAfter: entry.budget_remaining_after,
      sources,
    };
  });
  const availableContextLayers = projectedEntries.map(({ layer }) => layer);
  return {
    availableContextLayers,
    traceBaseline: {
      version: "novel-skill-paid-evaluation-trace-baseline@1",
      taskType: trace.task_type,
      maximumContextTokens: trace.maximum_context_tokens,
      requiredTokens: trace.required_tokens,
      usedTokens: trace.used_tokens,
      remainingTokens: trace.remaining_tokens,
      discardedTokens: trace.discarded_tokens,
      tokenEstimateSource: trace.token_estimate_source,
      entries: projectedEntries,
    },
  };
}

async function auditRestoredPaidReservationPayloadAuthority(
  transaction: TransactionExecutor,
  reservation: RestoredPaidReservationHashRow,
  exactTarget: RestoredPaidExactTarget,
): Promise<void> {
  const authorities = await transaction.select<RestoredPaidPredispatchAuthorityRow>(
    `SELECT * FROM novel_skill_evaluation_predispatch_authority_snapshots
     WHERE reservation_id = ?`,
    [reservation.id],
  );
  const authority = authorities[0];
  if (authorities.length !== 1 || authority === undefined) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const { availableContextLayers, traceBaseline } = await restoredPaidTraceBaselineProjection(
    transaction,
    reservation.planned_context_trace_id,
  );
  const traceBaselineHash = await sha256Text(canonicalJson(traceBaseline));
  const contextBaselineProjectionHash = await sha256Text(
    canonicalJson({
      schemaVersion: 1,
      version: "novel-skill-paid-context-baseline@1",
      fixtureId: reservation.fixture_id,
      baselineContractHash: reservation.baseline_contract_hash,
      includedSourceManifestHash: reservation.included_source_manifest_hash,
      omittedSourceManifestHash: reservation.omitted_source_manifest_hash,
      compiledBaselineHash: reservation.compiled_baseline_hash,
      baselineTokenBudget: reservation.baseline_token_budget,
      availableContextLayers,
      traceBaseline,
    }),
  );
  const genreTags = parseStringArray(reservation.genre_tags_json);
  const coverageDimensions = parseStringArray(reservation.coverage_dimensions_json);
  const manifest = {
    schemaVersion: authority.payload_authority_schema_version,
    authorityVersion: authority.payload_authority_version,
    runId: authority.run_id,
    suiteId: authority.suite_id,
    cellId: authority.cell_id,
    fixtureId: authority.fixture_id,
    fixtureContractHash: authority.fixture_contract_hash,
    fixtureInputContentHash: authority.fixture_input_content_hash,
    taskType: authority.task_type,
    invocationMode: authority.invocation_mode,
    genreTagsHash: authority.genre_tags_hash,
    coverageDimensionsHash: authority.coverage_dimensions_hash,
    arm: authority.arm,
    armConfigurationHash: authority.arm_configuration_hash,
    modelSlotId: authority.model_slot_id,
    repetition: authority.repetition,
    promptTemplateVersion: authority.prompt_template_version,
    promptTemplateHash: authority.prompt_template_hash,
    contextBaselineHash: authority.context_baseline_hash,
    contextBaselineProjectionHash: authority.context_baseline_projection_hash,
    availableContextLayersHash: authority.available_context_layers_hash,
    skillCompilerVersion: authority.skill_compiler_version,
    skillSelectionHash: authority.skill_selection_hash,
    compiledSkillSnapshotHash: authority.compiled_skill_snapshot_hash,
    renderedSkillSectionHash: authority.rendered_skill_section_hash,
    preferenceConfigurationHash: authority.preference_configuration_hash,
    preferenceProjectionHash: authority.preference_projection_hash,
    renderedPreferenceSectionHash: authority.rendered_preference_section_hash,
    baseMessagePayloadHash: authority.base_message_payload_hash,
    messagePayloadHash: authority.message_payload_hash,
  };
  const manifestHash = await sha256Text(canonicalJson(manifest));
  const providerReceiptShape = {
    version: "model-hub-exact-evaluation-predispatch-receipt@1",
    generationId: authority.generation_id,
    target: {
      connectionId: authority.connection_id,
      catalogEntryId: authority.catalog_entry_id,
      providerKind: authority.provider_kind,
      modelId: authority.provider_model_id,
      connectionRevision: authority.connection_revision,
      catalogRevision: authority.catalog_revision,
      costPrivacyRevision: authority.cost_privacy_revision,
      capabilityEvidenceHash: authority.capability_evidence_hash,
      costProfileHash: authority.cost_profile_hash,
      targetIdentityHash: authority.target_identity_hash,
    },
    requestProfileHash: authority.request_profile_hash,
    messagePayloadHash: authority.message_payload_hash,
    payloadHash: authority.request_payload_hash,
    executionLockHash: authority.execution_lock_hash,
    currency: authority.currency,
    estimatedMaximumCostMicros: authority.exact_predispatch_estimated_max_cost_micros,
    dataDestination: authority.data_destination,
  };
  const providerReceiptShapeHash = await sha256Text(canonicalJson(providerReceiptShape));
  const finalDispatchAuthority = {
    version: "novel-skill-paid-final-dispatch-authority@1",
    reservationId: reservation.id,
    authorizationId: reservation.authorization_id,
    runId: reservation.run_id,
    cellId: reservation.cell_id,
    attemptId: reservation.attempt_id,
    modelSlotId: reservation.model_slot_id,
    dispatchGeneration: reservation.dispatch_generation,
    plannedContextTraceId: reservation.planned_context_trace_id,
    plannedModelInvocationId: reservation.planned_model_invocation_id,
    plannedCandidateId: reservation.planned_candidate_id,
    idempotencyKeyHash: reservation.idempotency_key_hash,
    payloadAuthorityManifestHash: authority.payload_authority_manifest_hash,
    providerReceiptShapeHash: authority.provider_receipt_shape_hash,
  };
  const finalDispatchAuthorityHash = await sha256Text(canonicalJson(finalDispatchAuthority));
  const snapshot = {
    schemaVersion: 1,
    version: "novel-skill-paid-predispatch-authority@1",
    reservationId: reservation.id,
    payloadAuthorityManifest: manifest,
    payloadAuthorityManifestHash: authority.payload_authority_manifest_hash,
    providerReceiptShapeVersion: "model-hub-exact-evaluation-predispatch-receipt@1",
    providerReceiptShapeHash: authority.provider_receipt_shape_hash,
    finalDispatchAuthorityVersion: "novel-skill-paid-final-dispatch-authority@1",
    finalDispatchAuthorityHash: authority.final_dispatch_authority_hash,
    exactPredispatchEstimatedMaximumCostMicros:
      authority.exact_predispatch_estimated_max_cost_micros,
    capturedAt: authority.captured_at,
  };
  const snapshotHash = await sha256Text(canonicalJson(snapshot));
  const executionLockHash = await sha256Text(
    canonicalJson({
      version: "model-hub-exact-evaluation-execution-lock@1",
      targetIdentityHash: exactTarget.targetIdentityHash,
      requestProfileHash: reservation.request_profile_hash,
      payloadHash: reservation.request_payload_hash,
      currency: reservation.currency,
      estimatedMaximumCostMicros: authority.exact_predispatch_estimated_max_cost_micros,
    }),
  );
  if (
    traceBaselineHash !== reservation.compiled_baseline_hash ||
    authority.schema_version !== 1 ||
    authority.authority_snapshot_version !== "novel-skill-paid-predispatch-authority@1" ||
    authority.payload_authority_schema_version !== 1 ||
    reservation.payload_authority_version !== "novel-skill-paid-payload-authority@1" ||
    authority.payload_authority_version !== reservation.payload_authority_version ||
    authority.reservation_id !== reservation.id ||
    authority.run_id !== reservation.run_id ||
    authority.suite_id !== reservation.suite_id ||
    authority.cell_id !== reservation.cell_id ||
    authority.fixture_id !== reservation.fixture_id ||
    authority.fixture_contract_hash !== reservation.fixture_contract_hash ||
    authority.fixture_input_content_hash !== reservation.fixture_input_content_hash ||
    authority.task_type !== reservation.task_type ||
    authority.invocation_mode !== reservation.invocation_mode ||
    authority.genre_tags_hash !== (await sha256Text(canonicalJson(genreTags))) ||
    authority.coverage_dimensions_hash !== (await sha256Text(canonicalJson(coverageDimensions))) ||
    authority.arm !== reservation.arm ||
    authority.arm_configuration_hash !== reservation.arm_configuration_hash ||
    authority.model_slot_id !== reservation.model_slot_id ||
    authority.repetition !== reservation.repetition ||
    authority.prompt_template_version !== reservation.prompt_template_version ||
    authority.prompt_template_hash !== reservation.prompt_template_hash ||
    authority.context_baseline_hash !== reservation.compiled_baseline_hash ||
    authority.context_baseline_projection_hash !== contextBaselineProjectionHash ||
    authority.available_context_layers_hash !==
      (await sha256Text(canonicalJson(availableContextLayers))) ||
    authority.skill_compiler_version !== "novel-skill-compiler@1" ||
    authority.arm_configuration_hash !== reservation.skill_configuration_hash ||
    authority.preference_configuration_hash !== reservation.preference_configuration_hash ||
    authority.message_payload_hash !== reservation.message_payload_hash ||
    authority.generation_id !== reservation.planned_model_invocation_id ||
    authority.connection_id !== exactTarget.connectionId ||
    authority.catalog_entry_id !== exactTarget.catalogEntryId ||
    authority.provider_kind !== exactTarget.providerKind ||
    authority.provider_model_id !== exactTarget.modelId ||
    authority.connection_revision !== exactTarget.connectionRevision ||
    authority.catalog_revision !== exactTarget.catalogRevision ||
    authority.cost_privacy_revision !== exactTarget.costPrivacyRevision ||
    authority.capability_evidence_hash !== exactTarget.capabilityEvidenceHash ||
    authority.cost_profile_hash !== exactTarget.costProfileHash ||
    authority.target_identity_hash !== exactTarget.targetIdentityHash ||
    authority.request_profile_hash !== reservation.request_profile_hash ||
    authority.request_payload_hash !== reservation.request_payload_hash ||
    authority.execution_lock_hash !== reservation.execution_lock_hash ||
    authority.execution_lock_hash !== executionLockHash ||
    authority.currency !== reservation.currency ||
    authority.data_destination !== reservation.data_destination ||
    !/^(0|[1-9][0-9]{0,17})$/u.test(authority.exact_predispatch_estimated_max_cost_micros) ||
    BigInt(authority.exact_predispatch_estimated_max_cost_micros) >
      BigInt(reservation.reserved_max_cost_micros) ||
    authority.provider_receipt_shape_version !==
      "model-hub-exact-evaluation-predispatch-receipt@1" ||
    authority.provider_receipt_shape_hash !== providerReceiptShapeHash ||
    authority.final_dispatch_authority_version !== "novel-skill-paid-final-dispatch-authority@1" ||
    authority.final_dispatch_authority_hash !== finalDispatchAuthorityHash ||
    authority.captured_at !== reservation.reserved_at ||
    authority.payload_authority_manifest_hash !== manifestHash ||
    reservation.payload_authority_manifest_hash !== manifestHash ||
    authority.authority_snapshot_hash !== snapshotHash
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
}

function restoredPaidUsage(
  inputTokens: number | null,
  outputTokens: number | null,
  cachedInputTokens: number | null,
): Readonly<Record<string, number>> | null {
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null;
  if (
    inputTokens === null ||
    outputTokens === null ||
    (cachedInputTokens !== null && cachedInputTokens > inputTokens)
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
  };
}

function restoredPaidSettledCost(
  usage: Readonly<Record<string, number>>,
  inputRate: string,
  outputRate: string,
  cachedInputRate: string | null,
): string {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const numerator =
    BigInt(inputTokens - cachedInputTokens) * BigInt(inputRate) +
    BigInt(outputTokens) * BigInt(outputRate) +
    BigInt(cachedInputTokens) * BigInt(cachedInputRate ?? inputRate);
  return ((numerator + 999_999n) / 1_000_000n).toString();
}

async function auditRestoredPaidProviderReceipt(
  reservation: RestoredPaidReservationHashRow,
  exactTarget: RestoredPaidExactTarget,
): Promise<void> {
  if (reservation.state !== "settled") {
    if (
      !["ambiguous", "not_dispatched"].includes(reservation.state) &&
      reservation.provider_receipt_hash !== null
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    return;
  }
  if (
    reservation.provider_receipt_hash === null ||
    reservation.settlement_outcome === null ||
    reservation.terminal_at === null ||
    reservation.invocation_completed_at !== reservation.terminal_at ||
    reservation.invocation_currency !== reservation.currency ||
    reservation.invocation_requested_max_output_tokens !== reservation.maximum_output_tokens
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const usage = restoredPaidUsage(
    reservation.invocation_input_tokens,
    reservation.invocation_output_tokens,
    reservation.invocation_cached_input_tokens,
  );
  if (
    (usage?.inputTokens ?? 0) > reservation.maximum_input_tokens ||
    (usage?.outputTokens ?? 0) > reservation.maximum_output_tokens
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  if (reservation.settlement_outcome === "succeeded") {
    if (
      reservation.provider_visible_output_hash === null ||
      reservation.actual_cost_micros === null ||
      reservation.invocation_visible_content_length === null ||
      reservation.invocation_status !== "succeeded" ||
      reservation.invocation_error_code !== null ||
      reservation.invocation_streamed !== 1 ||
      reservation.invocation_cost_micros !== reservation.actual_cost_micros ||
      reservation.candidate_checksum !== reservation.provider_visible_output_hash ||
      usage === null ||
      restoredPaidSettledCost(
        usage,
        reservation.target_input_rate,
        reservation.target_output_rate,
        reservation.target_cached_input_rate,
      ) !== reservation.actual_cost_micros
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    const providerReceiptHash = await sha256Text(
      canonicalJson({
        version: "novel-skill-paid-evaluation-provider-receipt@1",
        target: exactTarget,
        requestProfileHash: reservation.request_profile_hash,
        payloadHash: reservation.request_payload_hash,
        executionLockHash: reservation.execution_lock_hash,
        visibleOutputHash: reservation.provider_visible_output_hash,
        visibleContentLength: reservation.invocation_visible_content_length,
        usage,
        streamed: true,
        actualCostMicros: reservation.actual_cost_micros,
        currency: reservation.currency,
        completedAt: reservation.terminal_at,
      }),
    );
    if (providerReceiptHash !== reservation.provider_receipt_hash) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    return;
  }
  if (
    reservation.provider_visible_output_hash !== null ||
    reservation.output_candidate_id !== null ||
    reservation.attempt_error_code === null
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const expectedOutcome =
    reservation.attempt_error_code === "USER_CANCELLED"
      ? "cancelled"
      : reservation.attempt_error_code === "MODEL_TIMEOUT"
        ? "timed_out"
        : reservation.attempt_error_code === "MODEL_POLICY_BLOCKED"
          ? "policy_blocked"
          : "failed";
  const expectedInvocationStatus =
    expectedOutcome === "cancelled"
      ? "cancelled"
      : expectedOutcome === "timed_out"
        ? "timed_out"
        : "failed";
  const expectedInvocationErrorCode =
    expectedOutcome === "cancelled" ? null : reservation.attempt_error_code;
  if (
    reservation.settlement_outcome !== expectedOutcome ||
    reservation.invocation_status !== expectedInvocationStatus ||
    reservation.invocation_error_code !== expectedInvocationErrorCode ||
    reservation.invocation_cost_micros !== reservation.actual_cost_micros
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  if (
    usage !== null &&
    reservation.actual_cost_micros !==
      restoredPaidSettledCost(
        usage,
        reservation.target_input_rate,
        reservation.target_output_rate,
        reservation.target_cached_input_rate,
      )
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  if (usage === null && reservation.actual_cost_micros !== null) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const providerReceiptHash = await sha256Text(
    canonicalJson({
      version: "novel-skill-paid-evaluation-local-failure-receipt@1",
      reservationId: reservation.id,
      targetHash: exactTarget.targetIdentityHash,
      pricingSnapshotHash: exactTarget.costProfileHash,
      requestProfileHash: reservation.request_profile_hash,
      requestPayloadHash: reservation.request_payload_hash,
      outcome: reservation.settlement_outcome,
      errorCode: reservation.attempt_error_code,
      usage,
      actualCostMicros: reservation.actual_cost_micros,
      currency: reservation.currency,
      completedAt: reservation.terminal_at,
    }),
  );
  if (providerReceiptHash !== reservation.provider_receipt_hash) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
}

async function auditRestoredPaidReservationHashes(
  transaction: TransactionExecutor,
  exactTargets: ReadonlyMap<string, RestoredPaidExactTarget>,
): Promise<void> {
  const reservations = await transaction.select<RestoredPaidReservationHashRow>(
    `SELECT reservation.id, reservation.authorization_id, reservation.run_id,
            reservation.attempt_id,
            cell.suite_id, reservation.cell_id,
            cell.fixture_id, fixture.contract_hash AS fixture_contract_hash,
            fixture.input_content_hash AS fixture_input_content_hash,
            fixture.task_type, fixture.invocation_mode, fixture.genre_tags_json,
            fixture.coverage_dimensions_json, cell.arm, cell.arm_configuration_hash,
            reservation.model_slot_id, reservation.dispatch_generation,
            cell.repetition, reservation.state,
            protocol.protocol_hash, protocol.prompt_template_version,
            protocol.prompt_template_hash, baseline.baseline_contract_hash,
            baseline.included_source_manifest_hash, baseline.omitted_source_manifest_hash,
            baseline.compiled_baseline_hash, baseline.baseline_token_budget,
            profile.request_profile_hash, profile.maximum_input_tokens,
            profile.maximum_output_tokens, reservation.invariant_request_hash,
            reservation.request_payload_hash, reservation.execution_lock_hash,
            reservation.message_payload_hash, reservation.payload_authority_version,
            reservation.payload_authority_manifest_hash, reservation.data_destination,
            reservation.skill_configuration_hash, reservation.preference_configuration_hash,
            reservation.currency, reservation.reserved_max_cost_micros,
            reservation.settlement_outcome, reservation.provider_receipt_hash,
            reservation.provider_visible_output_hash, reservation.output_candidate_id,
            reservation.actual_cost_micros, reservation.planned_context_trace_id,
            reservation.planned_model_invocation_id, reservation.planned_candidate_id,
            reservation.idempotency_key_hash, reservation.reserved_at,
            reservation.terminal_at, invocation.status AS invocation_status,
            invocation.error_code AS invocation_error_code,
            invocation.input_tokens AS invocation_input_tokens,
            invocation.output_tokens AS invocation_output_tokens,
            invocation.cached_input_tokens AS invocation_cached_input_tokens,
            invocation.estimated_cost_micros AS invocation_cost_micros,
            invocation.currency AS invocation_currency,
            invocation.completed_at AS invocation_completed_at,
            invocation.visible_content_length AS invocation_visible_content_length,
            invocation.streamed AS invocation_streamed,
            invocation.requested_max_output_tokens AS invocation_requested_max_output_tokens,
            attempt.error_code AS attempt_error_code,
            candidate.content_checksum AS candidate_checksum,
            target.input_micros_per_million_tokens AS target_input_rate,
            target.output_micros_per_million_tokens AS target_output_rate,
            target.cached_input_micros_per_million_tokens AS target_cached_input_rate
     FROM novel_skill_evaluation_dispatch_reservations AS reservation
     INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = reservation.cell_id
     INNER JOIN novel_skill_evaluation_fixtures AS fixture
       ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
     INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = cell.suite_id
     INNER JOIN novel_skill_evaluation_context_baselines AS baseline
       ON baseline.suite_id = cell.suite_id AND baseline.fixture_id = cell.fixture_id
     INNER JOIN novel_skill_evaluation_request_profiles AS profile
       ON profile.suite_id = cell.suite_id AND profile.task_type = fixture.task_type
     INNER JOIN novel_skill_evaluation_attempts AS attempt ON attempt.id = reservation.attempt_id
     INNER JOIN novel_skill_evaluation_run_model_targets AS target
       ON target.run_id = reservation.run_id AND target.model_slot_id = reservation.model_slot_id
     LEFT JOIN model_invocation_facts AS invocation
       ON invocation.id = reservation.planned_model_invocation_id
     LEFT JOIN ai_candidates AS candidate ON candidate.id = reservation.output_candidate_id
     ORDER BY reservation.run_id, reservation.id`,
  );
  for (const reservation of reservations) {
    const exactTarget = exactTargets.get(`${reservation.run_id}/${reservation.model_slot_id}`);
    if (exactTarget === undefined) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    const invariantRequestHash = await sha256Text(
      canonicalJson({
        version: "novel-skill-paid-evaluation-invariant-request@1",
        runId: reservation.run_id,
        suiteId: reservation.suite_id,
        fixtureId: reservation.fixture_id,
        taskType: reservation.task_type,
        modelSlotId: reservation.model_slot_id,
        repetition: reservation.repetition,
        protocolHash: reservation.protocol_hash,
        requestProfileHash: reservation.request_profile_hash,
        contextBaselineHash: reservation.compiled_baseline_hash,
        promptTemplateHash: reservation.prompt_template_hash,
      }),
    );
    if (
      reservation.invariant_request_hash !== invariantRequestHash ||
      reservation.payload_authority_version !== "novel-skill-paid-payload-authority@1"
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    await auditRestoredPaidReservationPayloadAuthority(transaction, reservation, exactTarget);
    await auditRestoredPaidProviderReceipt(reservation, exactTarget);
  }
}

function parseRestoredModelAssignments(serialized: string):
  | readonly {
      readonly slotId: string;
      readonly modelIdentityHash: string;
      readonly modelArtifactHash: string;
    }[]
  | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value) || value.length !== 2) return null;
    const assignments = value as Record<string, unknown>[];
    if (
      assignments.some(
        (assignment) =>
          Object.keys(assignment).sort().join(",") !==
            "modelArtifactHash,modelIdentityHash,slotId" ||
          !["text_tier_a", "text_tier_b"].includes(String(assignment.slotId)) ||
          !isSha256(String(assignment.modelIdentityHash)) ||
          !isSha256(String(assignment.modelArtifactHash)),
      ) ||
      new Set(assignments.map(({ slotId }) => slotId)).size !== 2 ||
      new Set(assignments.map(({ modelIdentityHash }) => modelIdentityHash)).size !== 2 ||
      new Set(assignments.map(({ modelArtifactHash }) => modelArtifactHash)).size !== 2
    ) {
      return null;
    }
    return assignments as {
      readonly slotId: string;
      readonly modelIdentityHash: string;
      readonly modelArtifactHash: string;
    }[];
  } catch {
    return null;
  }
}

function parseRestoredModelSlots(
  serialized: string,
): readonly RestoredEvaluationModelSlot[] | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value) || value.length !== 2) return null;
    const slots = value as Record<string, unknown>[];
    if (
      slots.some(
        (slot) =>
          Object.keys(slot).sort().join(",") !== "modelTier,slotId" ||
          !["text_tier_a", "text_tier_b"].includes(String(slot.slotId)) ||
          typeof slot.modelTier !== "string" ||
          !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(slot.modelTier),
      ) ||
      new Set(slots.map(({ slotId }) => slotId)).size !== 2 ||
      new Set(slots.map(({ modelTier }) => modelTier)).size !== 2
    ) {
      return null;
    }
    return slots as unknown as readonly RestoredEvaluationModelSlot[];
  } catch {
    return null;
  }
}

async function auditRestoredEvaluationRunStructure(
  transaction: TransactionExecutor,
  run: RestoredEvaluationRunAuditRow,
  assignments: readonly {
    readonly slotId: string;
    readonly modelIdentityHash: string;
    readonly modelArtifactHash: string;
  }[],
): Promise<void> {
  const slots = parseRestoredModelSlots(run.model_slots_json);
  if (
    slots === null ||
    slots.some((slot) => !assignments.some((assignment) => assignment.slotId === slot.slotId))
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const fixtures = await transaction.select<RestoredEvaluationFixtureAuditRow>(
    `SELECT fixture_id, language, origin, task_type, invocation_mode,
            genre_tags_json, coverage_dimensions_json, contract_hash, input_content_hash
     FROM novel_skill_evaluation_fixtures
     WHERE suite_id = ? ORDER BY fixture_id`,
    [run.suite_id],
  );
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.fixture_id, fixture] as const));
  const registryMatches = NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY.every((expected) => {
    const actual = fixturesById.get(expected.fixtureId);
    return (
      actual?.language === expected.language &&
      actual.origin === expected.origin &&
      actual.task_type === expected.taskType &&
      actual.invocation_mode === expected.invocationMode &&
      actual.genre_tags_json === JSON.stringify(expected.genreTags) &&
      actual.coverage_dimensions_json === JSON.stringify(expected.coverageDimensions) &&
      actual.contract_hash === expected.contractHash &&
      actual.input_content_hash === expected.inputContentHash
    );
  });
  const manifests = await transaction.select<{
    readonly arm: string;
    readonly item_order: number;
    readonly skill_id: string;
    readonly skill_version: string;
    readonly definition_hash: string;
    readonly kind: string;
  }>(
    `SELECT arm, item_order, skill_id, skill_version, definition_hash, kind
     FROM novel_skill_evaluation_manifest_items
     WHERE suite_id = ? ORDER BY arm, item_order`,
    [run.suite_id],
  );
  const manifestHashFor = async (arm: string): Promise<string | null> => {
    const items = manifests
      .filter((item) => item.arm === arm)
      .map((item) => ({
        skillId: item.skill_id,
        version: item.skill_version,
        definitionHash: item.definition_hash,
        kind: item.kind,
      }))
      .sort((left, right) =>
        `${left.skillId}/${left.version}`.localeCompare(`${right.skillId}/${right.version}`, "en"),
      );
    return items.length === 0 ? null : sha256Text(canonicalJson(items));
  };
  const coreManifestHash = await manifestHashFor("core");
  const coreGenreManifestHash = await manifestHashFor("core_genre");
  const coreGenrePreferencesManifestHash = await manifestHashFor("core_genre_preferences");
  const targetManifestHash = await sha256Text(
    canonicalJson({
      coreManifestHash,
      coreGenreManifestHash,
      coreGenrePreferencesManifestHash,
      preferenceConfigurationHash: run.preference_configuration_hash,
    }),
  );
  const orderedSlots = [...slots].sort((left, right) =>
    left.slotId.localeCompare(right.slotId, "en"),
  );
  const planHash = await sha256Text(
    canonicalJson({
      compilerVersion: run.compiler_version,
      evaluatorVersion: run.evaluator_version,
      fixtureSetHash: NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH,
      minimumRepetitions: 2,
      modelSlots: orderedSlots,
      targetManifestHash,
    }),
  );
  if (
    fixtures.length !== NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY.length ||
    !registryMatches ||
    run.fixture_set_hash !== NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH ||
    run.minimum_repetitions !== 2 ||
    coreManifestHash === null ||
    coreGenreManifestHash === null ||
    coreGenrePreferencesManifestHash === null ||
    run.core_manifest_hash !== coreManifestHash ||
    run.core_genre_manifest_hash !== coreGenreManifestHash ||
    run.core_genre_preferences_manifest_hash !== coreGenrePreferencesManifestHash ||
    run.target_manifest_hash !== targetManifestHash ||
    run.plan_hash !== planHash
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const cells = await transaction.select<RestoredEvaluationCellAuditRow>(
    `SELECT id, run_id, suite_id, fixture_id, arm, arm_configuration_hash,
            model_slot_id, model_tier, repetition, state, created_at
     FROM novel_skill_evaluation_cells
     WHERE run_id = ? ORDER BY fixture_id, arm, model_slot_id, repetition`,
    [run.id],
  );
  const expectedCells = new Set<string>();
  for (const fixture of fixtures) {
    for (const arm of RESTORED_EVALUATION_ARMS) {
      for (const slot of slots) {
        for (const repetition of [1, 2]) {
          expectedCells.add(`${fixture.fixture_id}/${arm}/${slot.slotId}/${String(repetition)}`);
        }
      }
    }
  }
  const slotById = new Map<string, RestoredEvaluationModelSlot>(
    slots.map((slot) => [slot.slotId, slot] as const),
  );
  for (const cell of cells) {
    const cellKey = `${cell.fixture_id}/${cell.arm}/${cell.model_slot_id}/${String(cell.repetition)}`;
    const expectedArmHash =
      cell.arm === "no_skill"
        ? null
        : cell.arm === "core"
          ? run.core_manifest_hash
          : cell.arm === "core_genre"
            ? run.core_genre_manifest_hash
            : run.core_genre_preferences_manifest_hash;
    const validState =
      (run.status === "planned" && cell.state === "planned") ||
      (run.status === "running" && ["planned", "observed"].includes(cell.state)) ||
      (run.status === "completed" && cell.state === "observed") ||
      (run.status === "invalidated" && ["observed", "invalidated"].includes(cell.state));
    if (
      !expectedCells.delete(cellKey) ||
      cell.run_id !== run.id ||
      cell.suite_id !== run.suite_id ||
      cell.arm_configuration_hash !== expectedArmHash ||
      slotById.get(cell.model_slot_id)?.modelTier !== cell.model_tier ||
      cell.created_at !== run.created_at ||
      !validState
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
  }
  if (cells.length !== 192 || expectedCells.size !== 0) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }

  const attempts = await transaction.select<RestoredEvaluationAttemptAuditRow>(
    `SELECT attempt.id, attempt.run_id, attempt.cell_id, attempt.attempt_number,
            attempt.status, attempt.context_trace_id, attempt.model_invocation_id,
            attempt.error_code, attempt.started_at, attempt.completed_at,
            observation.id AS observation_id
     FROM novel_skill_evaluation_attempts AS attempt
     LEFT JOIN novel_skill_evaluation_observations AS observation
       ON observation.attempt_id = attempt.id
     WHERE attempt.run_id = ?
     ORDER BY attempt.cell_id, attempt.attempt_number`,
    [run.id],
  );
  const cellsById = new Map(cells.map((cell) => [cell.id, cell] as const));
  const nextAttemptByCell = new Map<string, number>();
  for (const attempt of attempts) {
    const cell = cellsById.get(attempt.cell_id);
    const expectedAttempt = nextAttemptByCell.get(attempt.cell_id) ?? 1;
    const started = Date.parse(attempt.started_at);
    const completed = Date.parse(attempt.completed_at ?? "");
    const receiptBound = attempt.context_trace_id !== null && attempt.model_invocation_id !== null;
    const receiptEmpty = attempt.context_trace_id === null && attempt.model_invocation_id === null;
    const statusCompatible =
      (attempt.status === "started" &&
        run.status === "running" &&
        cell?.state === "planned" &&
        attempt.observation_id === null &&
        attempt.error_code === null &&
        attempt.completed_at === null) ||
      (attempt.status === "succeeded" &&
        receiptBound &&
        attempt.error_code === null &&
        attempt.completed_at !== null &&
        (cell?.state === "planned" || cell?.state === "observed")) ||
      (["failed", "cancelled"].includes(attempt.status) &&
        attempt.observation_id === null &&
        attempt.error_code !== null &&
        attempt.completed_at !== null &&
        ((run.status === "running" && cell?.state === "planned") ||
          (run.status === "invalidated" && cell?.state === "invalidated")));
    if (
      cell === undefined ||
      attempt.run_id !== run.id ||
      attempt.attempt_number !== expectedAttempt ||
      attempt.attempt_number > 8 ||
      !Number.isFinite(started) ||
      (attempt.completed_at !== null && (!Number.isFinite(completed) || completed < started)) ||
      (!receiptBound && !receiptEmpty) ||
      (attempt.status === "succeeded" &&
        attempt.observation_id === null &&
        run.status !== "running") ||
      !statusCompatible
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    nextAttemptByCell.set(attempt.cell_id, expectedAttempt + 1);
    if (receiptBound) {
      await auditRestoredEvaluationAttemptReceipt(transaction, run, cell, attempt);
    }
  }
  if (
    run.status === "completed" &&
    (attempts.length !== 192 ||
      attempts.some(
        (attempt) =>
          attempt.attempt_number !== 1 ||
          attempt.status !== "succeeded" ||
          attempt.error_code !== null ||
          attempt.completed_at === null ||
          attempt.observation_id === null,
      ))
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
}

async function auditRestoredEvaluationAttemptReceipt(
  transaction: TransactionExecutor,
  run: RestoredEvaluationRunAuditRow,
  cell: RestoredEvaluationCellAuditRow,
  attempt: RestoredEvaluationAttemptAuditRow,
): Promise<void> {
  const receipts = await transaction.select<{
    readonly trace_project_id: string;
    readonly trace_chapter_id: string | null;
    readonly trace_task_type: string;
    readonly fixture_task_type: string;
    readonly fixture_input_hash: string;
    readonly fixture_contract_hash: string;
    readonly invocation_task: string;
    readonly invocation_status: string;
    readonly invocation_connection_id: string;
    readonly invocation_catalog_entry_id: string | null;
    readonly invocation_provider_kind: string;
    readonly invocation_model_id: string;
    readonly connection_provider_kind: string;
    readonly catalog_connection_id: string | null;
    readonly catalog_provider_model_id: string | null;
  }>(
    `SELECT trace.project_id AS trace_project_id, trace.chapter_id AS trace_chapter_id,
            trace.task_type AS trace_task_type, fixture.task_type AS fixture_task_type,
            fixture.input_content_hash AS fixture_input_hash,
            fixture.contract_hash AS fixture_contract_hash,
            invocation.task AS invocation_task, invocation.status AS invocation_status,
            invocation.connection_id AS invocation_connection_id,
            invocation.catalog_entry_id AS invocation_catalog_entry_id,
            invocation.provider_kind_snapshot AS invocation_provider_kind,
            invocation.model_id_snapshot AS invocation_model_id,
            connection.provider_kind AS connection_provider_kind,
            catalog.connection_id AS catalog_connection_id,
            catalog.provider_model_id AS catalog_provider_model_id
     FROM context_compilation_runs AS trace
     INNER JOIN model_invocation_facts AS invocation ON invocation.id = ?
     INNER JOIN context_compilation_model_invocation_links AS model_link
       ON model_link.trace_id = trace.id AND model_link.model_invocation_id = invocation.id
     INNER JOIN novel_skill_evaluation_fixtures AS fixture
       ON fixture.suite_id = ? AND fixture.fixture_id = ?
     INNER JOIN model_provider_connections AS connection
       ON connection.id = invocation.connection_id
     LEFT JOIN model_catalog_entries AS catalog ON catalog.id = invocation.catalog_entry_id
     WHERE trace.id = ?`,
    [attempt.model_invocation_id, run.suite_id, cell.fixture_id, attempt.context_trace_id],
  );
  const receipt = receipts[0];
  const sourceViolations =
    receipt === undefined
      ? [{ violation: 1 }]
      : await transaction.select<{ readonly violation: number }>(
          `SELECT CASE WHEN
             NOT EXISTS (
               SELECT 1 FROM context_compilation_entries AS entry
               INNER JOIN context_compilation_entry_sources AS source
                 ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
               WHERE entry.run_id = ? AND entry.included = 1
                 AND entry.layer = 'current_task'
                 AND entry.candidate_id = 'evaluation-fixture:' || ?
                 AND source.source_type = 'user_input' AND source.source_id = ?
                 AND source.source_version_id IS NULL
                 AND source.locator = 'novel_skill_evaluation_fixture'
                 AND source.content_hash = ?
             ) OR EXISTS (
               SELECT 1 FROM context_compilation_entries AS entry
               LEFT JOIN context_compilation_entry_sources AS source
                 ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
               WHERE entry.run_id = ? AND NOT (
                 (entry.layer = 'current_task'
                  AND entry.candidate_id = 'evaluation-fixture:' || ?
                  AND source.source_type = 'user_input' AND source.source_id = ?
                  AND source.source_version_id IS NULL
                  AND source.locator = 'novel_skill_evaluation_fixture'
                  AND source.content_hash = ?)
                 OR (entry.layer <> 'current_task'
                  AND entry.candidate_id = 'evaluation-fixture-layer:' || ? || ':' || entry.layer
                  AND source.source_type = 'user_input' AND source.source_id = ?
                  AND source.source_version_id IS NULL
                  AND source.locator = 'novel_skill_evaluation_fixture_contract'
                  AND source.content_hash = ?)
                 OR (? = 'core_genre_preferences'
                  AND entry.candidate_id GLOB 'writing-preference:*'
                  AND source.source_type = 'user_input'
                  AND source.locator = 'writing_preference'
                  AND source.content_hash IS NOT NULL)
               )
             ) OR (? = 'core_genre_preferences' AND NOT EXISTS (
               SELECT 1 FROM context_compilation_entries AS entry
               INNER JOIN context_compilation_entry_sources AS source
                 ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
               WHERE entry.run_id = ? AND entry.included = 1
                 AND entry.candidate_id GLOB 'writing-preference:*'
                 AND source.source_type = 'user_input'
                 AND source.locator = 'writing_preference'
                 AND source.content_hash IS NOT NULL
             )) THEN 1 ELSE 0 END AS violation`,
          [
            attempt.context_trace_id,
            cell.fixture_id,
            cell.fixture_id,
            receipt.fixture_input_hash,
            attempt.context_trace_id,
            cell.fixture_id,
            cell.fixture_id,
            receipt.fixture_input_hash,
            cell.fixture_id,
            cell.fixture_id,
            receipt.fixture_contract_hash,
            cell.arm,
            cell.arm,
            attempt.context_trace_id,
          ],
        );
  if (receipts.length !== 1 || receipt === undefined) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  if (
    receipt.trace_project_id !== (await restoredEvaluationProjectId(transaction, run.suite_id)) ||
    receipt.trace_chapter_id !== null ||
    receipt.trace_task_type !== receipt.fixture_task_type ||
    receipt.invocation_task !== receipt.fixture_task_type ||
    receipt.invocation_catalog_entry_id === null ||
    receipt.catalog_connection_id !== receipt.invocation_connection_id ||
    receipt.catalog_provider_model_id !== receipt.invocation_model_id ||
    receipt.connection_provider_kind !== receipt.invocation_provider_kind ||
    sourceViolations[0]?.violation !== 0 ||
    (attempt.status === "succeeded" && receipt.invocation_status !== "succeeded") ||
    (["failed", "cancelled"].includes(attempt.status) &&
      ["queued", "running"].includes(receipt.invocation_status))
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
}

async function restoredEvaluationProjectId(
  transaction: TransactionExecutor,
  suiteId: string,
): Promise<string> {
  const rows = await transaction.select<{ readonly evaluation_project_id: string }>(
    "SELECT evaluation_project_id FROM novel_skill_evaluation_suites WHERE id = ?",
    [suiteId],
  );
  const projectId = rows[0]?.evaluation_project_id;
  if (projectId === undefined) throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  return projectId;
}

async function auditRestoredEvaluationObservation(
  transaction: TransactionExecutor,
  observation: RestoredEvaluationObservationAuditRow,
): Promise<RestoredVerifiedObservation> {
  const assignments = parseRestoredModelAssignments(observation.model_assignments_json);
  const assignment = assignments?.find(({ slotId }) => slotId === observation.model_slot_id);
  const identityHash = await sha256Text(
    JSON.stringify({
      catalogEntryId: observation.catalog_entry_id,
      connectionId: observation.connection_id,
      modelId: observation.model_id_snapshot,
      providerKind: observation.provider_kind_snapshot,
    }),
  );
  const artifactHash = await sha256Text(
    JSON.stringify({
      modelId: observation.model_id_snapshot,
      providerKind: observation.provider_kind_snapshot,
    }),
  );
  const started = Date.parse(observation.started_at ?? "");
  const completed = Date.parse(observation.completed_at ?? "");
  const cost = parseSafeInteger(observation.invocation_estimated_cost_micros);
  const candidateHash = await sha256Text(observation.candidate_content);
  const sources = await transaction.select<RestoredEvaluationSourceAuditRow>(
    `SELECT entry.candidate_id, entry.layer, entry.selection_reason, entry.included,
            entry.discarded_reason, entry.estimated_tokens, entry.evaluation_order,
            entry.layer_order, entry.priority, entry.relevance_score, entry.required,
            entry.budget_remaining_before, entry.budget_remaining_after, source.source_order,
            source.source_type, source.source_id, source.source_version_id,
            source.locator, source.content_hash
     FROM context_compilation_entries AS entry
     LEFT JOIN context_compilation_entry_sources AS source
       ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
     WHERE entry.run_id = ?
     ORDER BY entry.layer_order, entry.evaluation_order, source.source_order`,
    [observation.context_trace_id],
  );
  const includedEntries = new Set(
    sources.filter(({ included }) => included === 1).map(({ candidate_id }) => candidate_id),
  );
  const allEntries = new Set(sources.map(({ candidate_id }) => candidate_id));
  const currentTask = sources.some(
    (source) =>
      source.included === 1 &&
      source.layer === "current_task" &&
      source.candidate_id === `evaluation-fixture:${observation.fixture_id}` &&
      source.source_type === "user_input" &&
      source.source_id === observation.fixture_id &&
      source.source_version_id === null &&
      source.locator === "novel_skill_evaluation_fixture" &&
      source.content_hash === observation.fixture_input_hash,
  );
  const invalidSource = sources.some((source) => {
    if (source.source_order === null || source.source_type === null || source.source_id === null) {
      return true;
    }
    const fixtureTask =
      source.layer === "current_task" &&
      source.candidate_id === `evaluation-fixture:${observation.fixture_id}` &&
      source.source_type === "user_input" &&
      source.source_id === observation.fixture_id &&
      source.source_version_id === null &&
      source.locator === "novel_skill_evaluation_fixture" &&
      source.content_hash === observation.fixture_input_hash;
    const fixtureLayer =
      source.layer !== "current_task" &&
      source.candidate_id ===
        `evaluation-fixture-layer:${observation.fixture_id}:${source.layer}` &&
      source.source_type === "user_input" &&
      source.source_id === observation.fixture_id &&
      source.source_version_id === null &&
      source.locator === "novel_skill_evaluation_fixture_contract" &&
      source.content_hash === observation.fixture_contract_hash;
    const preference =
      observation.arm === "core_genre_preferences" &&
      source.candidate_id.startsWith("writing-preference:") &&
      source.source_type === "user_input" &&
      source.locator === "writing_preference" &&
      isSha256(source.content_hash ?? "");
    return !fixtureTask && !fixtureLayer && !preference;
  });
  const includedPreferences = sources.filter(
    (source) =>
      source.included === 1 &&
      source.candidate_id.startsWith("writing-preference:") &&
      source.source_type === "user_input" &&
      source.locator === "writing_preference" &&
      isSha256(source.content_hash ?? ""),
  );
  const preferenceHash =
    includedPreferences.length === 0
      ? null
      : await sha256Text(
          canonicalJson(
            includedPreferences
              .map((source) => ({
                sourceId: source.source_id,
                sourceVersionId: source.source_version_id,
                contentHash: source.content_hash,
              }))
              .sort((left, right) =>
                `${left.sourceId ?? ""}/${left.sourceVersionId ?? ""}`.localeCompare(
                  `${right.sourceId ?? ""}/${right.sourceVersionId ?? ""}`,
                  "en",
                ),
              ),
          ),
        );
  const traceEntries = new Map<string, RestoredEvaluationSourceAuditRow>();
  for (const source of sources) {
    const existing = traceEntries.get(source.candidate_id);
    if (
      existing !== undefined &&
      (existing.layer !== source.layer ||
        existing.selection_reason !== source.selection_reason ||
        existing.included !== source.included ||
        existing.discarded_reason !== source.discarded_reason ||
        existing.estimated_tokens !== source.estimated_tokens ||
        existing.evaluation_order !== source.evaluation_order ||
        existing.layer_order !== source.layer_order ||
        existing.priority !== source.priority ||
        existing.relevance_score !== source.relevance_score ||
        existing.required !== source.required ||
        existing.budget_remaining_before !== source.budget_remaining_before ||
        existing.budget_remaining_after !== source.budget_remaining_after)
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    traceEntries.set(source.candidate_id, source);
  }
  if (
    observation.run_id !== observation.cell_run_id ||
    observation.run_id !== observation.attempt_run_id ||
    observation.cell_id !== observation.attempt_cell_id ||
    observation.cell_suite_id !== observation.run_suite_id ||
    observation.cell_state !== "observed" ||
    observation.evaluator_version !== "novel-skill-ab@1" ||
    assignment?.modelIdentityHash !== identityHash ||
    assignment.modelArtifactHash !== artifactHash ||
    observation.model_identity_hash !== identityHash ||
    observation.model_artifact_hash !== artifactHash ||
    observation.attempt_status !== "succeeded" ||
    observation.attempt_trace_id !== observation.context_trace_id ||
    observation.attempt_invocation_id !== observation.model_invocation_id ||
    observation.invocation_status !== "succeeded" ||
    observation.invocation_task !== observation.fixture_task_type ||
    observation.error_code !== null ||
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    completed < started ||
    completed - started !== observation.latency_milliseconds ||
    observation.visible_content_length === null ||
    observation.visible_content_length <= 0 ||
    ["length", "max_tokens", "max_output_tokens"].includes(observation.finish_reason ?? "") ||
    observation.input_tokens !== observation.invocation_input_tokens ||
    observation.output_tokens !== observation.invocation_output_tokens ||
    observation.estimated_cost_micros !== cost ||
    observation.trace_project_id !== observation.evaluation_project_id ||
    observation.trace_chapter_id !== null ||
    observation.trace_task_type !== observation.fixture_task_type ||
    observation.trace_maximum_context_tokens < 1 ||
    observation.trace_required_tokens < 0 ||
    observation.trace_used_tokens < observation.trace_required_tokens ||
    observation.trace_used_tokens + observation.trace_remaining_tokens !==
      observation.trace_maximum_context_tokens ||
    observation.trace_discarded_tokens < 0 ||
    observation.trace_token_estimate_source.length === 0 ||
    observation.trace_candidate_count !== allEntries.size ||
    observation.trace_included_count !== includedEntries.size ||
    observation.trace_discarded_count !== allEntries.size - includedEntries.size ||
    observation.candidate_project_id !== observation.evaluation_project_id ||
    observation.candidate_chapter_id !== null ||
    observation.candidate_base_version_id !== null ||
    observation.candidate_source !== "generate" ||
    observation.candidate_status !== "ready" ||
    observation.candidate_incomplete !== 0 ||
    observation.candidate_content.length === 0 ||
    observation.candidate_decided_at !== null ||
    observation.candidate_created_at !== observation.candidate_updated_at ||
    candidateHash !== observation.candidate_checksum ||
    observation.candidate_checksum !== observation.result_hash ||
    Array.from(observation.candidate_content).length !== observation.visible_content_length ||
    sources.length === 0 ||
    !currentTask ||
    invalidSource ||
    (observation.arm === "core_genre_preferences"
      ? includedPreferences.length < 1 ||
        preferenceHash !== observation.observation_preference_configuration_hash
      : includedPreferences.length !== 0 ||
        observation.observation_preference_configuration_hash !== null)
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  if (observation.arm === "no_skill") {
    const hidden = await transaction.select<{ readonly id: string }>(
      "SELECT id FROM novel_skill_invocation_snapshots WHERE model_invocation_id = ? LIMIT 1",
      [observation.model_invocation_id],
    );
    if (
      observation.novel_skill_snapshot_id !== null ||
      observation.cell_arm_configuration_hash !== null ||
      observation.observation_arm_configuration_hash !== null ||
      hidden.length > 0
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    return buildRestoredVerifiedObservation(transaction, observation, sources, [], {
      core: false,
      genre: false,
    });
  }
  if (
    observation.novel_skill_snapshot_id === null ||
    observation.snapshot_compiler_version !== observation.suite_compiler_version ||
    observation.snapshot_configuration_json === null
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const manifestMismatch = await transaction.select<{ readonly mismatch: number }>(
    `SELECT CASE WHEN
       EXISTS (
         SELECT 1 FROM novel_skill_evaluation_manifest_items AS manifest
         LEFT JOIN novel_skill_invocation_items AS item
           ON item.snapshot_id = ? AND item.skill_id = manifest.skill_id
          AND item.skill_version = manifest.skill_version
          AND item.definition_hash = manifest.definition_hash
         INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = ?
         WHERE manifest.suite_id = cell.suite_id AND manifest.arm = cell.arm
           AND item.snapshot_id IS NULL
       ) OR EXISTS (
         SELECT 1 FROM novel_skill_invocation_items AS item
         INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = ?
         LEFT JOIN novel_skill_evaluation_manifest_items AS manifest
           ON manifest.suite_id = cell.suite_id AND manifest.arm = cell.arm
          AND manifest.skill_id = item.skill_id AND manifest.skill_version = item.skill_version
          AND manifest.definition_hash = item.definition_hash
         WHERE item.snapshot_id = ? AND manifest.skill_id IS NULL
       ) THEN 1 ELSE 0 END AS mismatch`,
    [
      observation.novel_skill_snapshot_id,
      observation.cell_id,
      observation.cell_id,
      observation.novel_skill_snapshot_id,
    ],
  );
  if (manifestMismatch[0]?.mismatch !== 0) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const items = await transaction.select<RestoredEvaluationSkillItemAuditRow>(
    `SELECT item.item_order, item.skill_id, item.skill_version, item.definition_hash,
            definition.kind, definition.status, item.included, item.selection_reason,
            item.discarded_reason, item.activation_source, item.precedence,
            definition.precedence AS definition_precedence, item.estimated_tokens,
            definition.task_types_json, definition.activation_json,
            definition.context_requirements_json
     FROM novel_skill_invocation_items AS item
     INNER JOIN novel_skill_definitions AS definition
       ON definition.skill_id = item.skill_id AND definition.version = item.skill_version
     WHERE item.snapshot_id = ? ORDER BY item.item_order`,
    [observation.novel_skill_snapshot_id],
  );
  const normalizedManifest = items
    .map((item) => ({
      skillId: item.skill_id,
      version: item.skill_version,
      definitionHash: item.definition_hash,
      kind: item.kind,
    }))
    .sort((left, right) =>
      `${left.skillId}/${left.version}`.localeCompare(`${right.skillId}/${right.version}`, "en"),
    );
  const actualArmHash = await sha256Text(canonicalJson(normalizedManifest));
  if (
    observation.cell_arm_configuration_hash !== actualArmHash ||
    observation.observation_arm_configuration_hash !== actualArmHash
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  let configuration: Record<string, unknown>;
  let fixtureGenres: unknown;
  try {
    configuration = JSON.parse(observation.snapshot_configuration_json) as Record<string, unknown>;
    fixtureGenres = JSON.parse(observation.fixture_genre_tags_json);
  } catch {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const includedLayers = [
    ...new Set(sources.filter(({ included }) => included === 1).map(({ layer }) => layer)),
  ].sort();
  const configuredLayers = isStringArray(configuration.availableContextLayers)
    ? configuration.availableContextLayers.slice().sort()
    : null;
  const configuredGenres = isStringArray(configuration.genreTags)
    ? configuration.genreTags.slice()
    : null;
  const considered = Array.isArray(configuration.consideredDefinitions)
    ? configuration.consideredDefinitions
    : null;
  const expectedConsidered = items.map((item) => ({
    skillId: item.skill_id,
    version: item.skill_version,
    definitionHash: item.definition_hash,
    kind: item.kind,
    status: item.status,
  }));
  if (
    observation.snapshot_project_id !== observation.evaluation_project_id ||
    observation.snapshot_task_type !== observation.fixture_task_type ||
    observation.snapshot_invocation_mode !== observation.fixture_invocation_mode ||
    observation.snapshot_maximum_skill_tokens === null ||
    observation.snapshot_used_skill_tokens === null ||
    observation.snapshot_discarded_skill_tokens === null ||
    observation.snapshot_candidate_count !== items.length ||
    observation.snapshot_included_count !== items.filter(({ included }) => included === 1).length ||
    observation.snapshot_discarded_count !==
      items.filter(({ included }) => included === 0).length ||
    observation.snapshot_used_skill_tokens > observation.snapshot_maximum_skill_tokens ||
    observation.snapshot_discarded_skill_tokens !==
      items
        .filter(({ included }) => included === 0)
        .reduce((total, { estimated_tokens: tokens }) => total + tokens, 0) ||
    observation.snapshot_selection_hash !== (await sha256Text(canonicalJson(configuration))) ||
    configuration.compilerVersion !== observation.suite_compiler_version ||
    configuration.taskType !== observation.fixture_task_type ||
    configuration.invocationMode !== observation.fixture_invocation_mode ||
    JSON.stringify(configuredGenres) !== JSON.stringify(fixtureGenres) ||
    JSON.stringify(configuredLayers) !== JSON.stringify(includedLayers) ||
    JSON.stringify(considered) !== JSON.stringify(expectedConsidered)
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  for (const [index, item] of items.entries()) {
    const taskTypes = parseStringArray(item.task_types_json);
    const activation = parseJsonRecord(item.activation_json);
    const requirements = parseJsonRecord(item.context_requirements_json);
    const allowedModes = Array.isArray(activation?.allowedModes)
      ? activation.allowedModes.map(String)
      : [];
    const targetGenres = Array.isArray(activation?.genreTags)
      ? activation.genreTags.map(String)
      : [];
    const requiredLayers = Array.isArray(requirements?.requiredLayers)
      ? requirements.requiredLayers.map(String)
      : [];
    const genres = Array.isArray(fixtureGenres) ? fixtureGenres.map(String) : [];
    const taskApplicable = taskTypes.includes(observation.fixture_task_type);
    const modeApplicable = allowedModes.includes(observation.fixture_invocation_mode);
    const genreApplicable =
      targetGenres.length === 0 || targetGenres.some((genre) => genres.includes(genre));
    const contextApplicable = requiredLayers.every((layer) => includedLayers.includes(layer));
    const expectedReason = !taskApplicable
      ? "task_mismatch"
      : !modeApplicable
        ? "mode_mismatch"
        : !genreApplicable
          ? "genre_mismatch"
          : !contextApplicable
            ? "missing_context"
            : "selected";
    if (
      item.item_order !== index + 1 ||
      item.precedence !== item.definition_precedence ||
      item.included !== (expectedReason === "selected" ? 1 : 0) ||
      item.selection_reason !== expectedReason ||
      item.discarded_reason !== (expectedReason === "selected" ? null : expectedReason)
    ) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
  }
  return buildRestoredVerifiedObservation(transaction, observation, sources, items, {
    core: items.some(({ kind, included }) => kind === "core" && included === 1),
    genre: items.some(({ kind, included }) => kind === "genre" && included === 1),
  });
}

async function buildRestoredVerifiedObservation(
  transaction: TransactionExecutor,
  observation: RestoredEvaluationObservationAuditRow,
  sources: readonly RestoredEvaluationSourceAuditRow[],
  items: readonly RestoredEvaluationSkillItemAuditRow[],
  methodApplicability: Readonly<{ readonly core: boolean; readonly genre: boolean }>,
): Promise<RestoredVerifiedObservation> {
  const scoreRows = await transaction.select<{
    readonly observation_id: string;
    readonly metric: string;
    readonly score_basis_points: number;
    readonly reviewer_id: string;
    readonly rubric_version: string;
    readonly scored_at: string;
  }>(
    `SELECT observation_id, metric, score_basis_points, reviewer_id, rubric_version, scored_at
     FROM novel_skill_evaluation_scores WHERE observation_id = ? ORDER BY metric`,
    [observation.id],
  );
  if (
    scoreRows.length !== RESTORED_EVALUATION_METRICS.length ||
    scoreRows.some(
      (score) =>
        !RESTORED_EVALUATION_METRICS.includes(score.metric as RestoredEvaluationMetric) ||
        !Number.isSafeInteger(score.score_basis_points) ||
        score.score_basis_points < 0 ||
        score.score_basis_points > 10_000 ||
        score.rubric_version !== "novel-skill-human-rubric@1" ||
        !Number.isFinite(Date.parse(score.scored_at)),
    )
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const scores = Object.fromEntries(
    scoreRows.map((score) => [score.metric, score.score_basis_points / 10_000]),
  ) as Record<RestoredEvaluationMetric, number>;
  const normalizedSources = sources.map((source) => {
    if (source.source_order === null || source.source_type === null || source.source_id === null) {
      throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
    }
    return {
      candidateId: source.candidate_id,
      layer: source.layer,
      selectionReason: source.selection_reason,
      included: source.included === 1,
      discardedReason: source.discarded_reason,
      estimatedTokens: source.estimated_tokens,
      evaluationOrder: source.evaluation_order,
      layerOrder: source.layer_order,
      priority: source.priority,
      relevanceScore: source.relevance_score,
      required: source.required === 1,
      budgetRemainingBefore: source.budget_remaining_before,
      budgetRemainingAfter: source.budget_remaining_after,
      sourceOrder: source.source_order,
      sourceType: source.source_type,
      sourceId: source.source_id,
      sourceVersionId: source.source_version_id,
      locator: source.locator,
      contentHash: source.content_hash,
    };
  });
  const skillItems = items.map((item) => ({
    item_order: item.item_order,
    skill_id: item.skill_id,
    skill_version: item.skill_version,
    definition_hash: item.definition_hash,
    activation_source: item.activation_source,
    selection_reason: item.selection_reason,
    precedence: item.precedence,
    included: item.included,
    discarded_reason: item.discarded_reason,
    estimated_tokens: item.estimated_tokens,
  }));
  return {
    runId: observation.run_id,
    evaluation: {
      observationId: observation.id,
      fixtureId: observation.fixture_id,
      arm: observation.arm as RestoredEvaluationArm,
      modelSlotId: observation.model_slot_id as "text_tier_a" | "text_tier_b",
      modelTier: observation.model_tier,
      repetition: observation.repetition,
      modelInvocationId: observation.model_invocation_id,
      evaluatorVersion: "novel-skill-ab@1",
      completionStatus: "succeeded",
      visibleContentLength: observation.visible_content_length ?? 0,
      finishReason: observation.finish_reason,
      methodApplicability,
      scores,
      latencyMilliseconds: observation.latency_milliseconds,
      inputTokens: observation.input_tokens,
      outputTokens: observation.output_tokens,
      estimatedCostMicros: observation.estimated_cost_micros,
    },
    evidence: {
      observationId: observation.id,
      cellId: observation.cell_id,
      attemptId: observation.attempt_id,
      contextTraceId: observation.context_trace_id,
      modelInvocationId: observation.model_invocation_id,
      outputCandidateId: observation.output_candidate_id,
      novelSkillSnapshotId: observation.novel_skill_snapshot_id,
      modelIdentityHash: observation.model_identity_hash,
      modelArtifactHash: observation.model_artifact_hash,
      armConfigurationHash: observation.observation_arm_configuration_hash,
      preferenceConfigurationHash: observation.observation_preference_configuration_hash,
      resultHash: observation.result_hash,
      latencyMilliseconds: observation.latency_milliseconds,
      inputTokens: observation.input_tokens,
      outputTokens: observation.output_tokens,
      estimatedCostMicros: observation.estimated_cost_micros,
      execution: {
        generationId: observation.generation_id,
        generationRunId: observation.generation_run_id,
        createdAt: observation.execution_created_at,
      },
      trace: {
        maximumContextTokens: observation.trace_maximum_context_tokens,
        requiredTokens: observation.trace_required_tokens,
        usedTokens: observation.trace_used_tokens,
        remainingTokens: observation.trace_remaining_tokens,
        discardedTokens: observation.trace_discarded_tokens,
        tokenEstimateSource: observation.trace_token_estimate_source,
        candidateCount: observation.trace_candidate_count,
        includedCount: observation.trace_included_count,
        discardedCount: observation.trace_discarded_count,
      },
      sources: normalizedSources,
      skillItems,
    },
    scores: scoreRows,
  };
}

async function auditRestoredCompletedEvaluationRun(
  transaction: TransactionExecutor,
  run: RestoredEvaluationRunAuditRow,
  verified: readonly RestoredVerifiedObservation[],
): Promise<void> {
  if (verified.length !== 192) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
  const attempts = await transaction.select<{
    readonly id: string;
    readonly cell_id: string;
    readonly attempt_number: number;
    readonly status: string;
    readonly context_trace_id: string | null;
    readonly model_invocation_id: string | null;
    readonly error_code: string | null;
    readonly started_at: string;
    readonly completed_at: string | null;
  }>(
    `SELECT id, cell_id, attempt_number, status, context_trace_id,
            model_invocation_id, error_code, started_at, completed_at
     FROM novel_skill_evaluation_attempts
     WHERE run_id = ? ORDER BY cell_id, attempt_number`,
    [run.id],
  );
  const scoreDigest = verified
    .flatMap(({ scores }) => scores)
    .sort((left, right) =>
      `${String(left.observation_id)}/${String(left.metric)}`.localeCompare(
        `${String(right.observation_id)}/${String(right.metric)}`,
        "en",
      ),
    );
  const evidenceDigest = await sha256Text(
    canonicalJson({
      attempts,
      evidence: verified.map(({ evidence }) => evidence),
      scores: scoreDigest,
    }),
  );
  const slots = parseRestoredModelSlots(run.model_slots_json);
  if (slots === null) throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  const result = evaluateRestoredNovelSkillEvidence(
    verified.map(({ evaluation }) => evaluation),
    slots,
  );
  const resultHash = await sha256Text(canonicalJson({ evaluationResult: result, evidenceDigest }));
  if (
    result.status !== run.evaluation_status ||
    run.evaluation_result_hash !== resultHash ||
    !["FAILED", "ELIGIBLE_FOR_REVIEW"].includes(result.status)
  ) {
    throw restoreError(BACKUP_INCOMPATIBLE_OPERATION);
  }
}

function evaluateRestoredNovelSkillEvidence(
  observations: readonly RestoredEvaluatorObservation[],
  slots: readonly RestoredEvaluationModelSlot[],
): Readonly<Record<string, unknown>> {
  const expectedCells = NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY.flatMap(({ fixtureId }) =>
    RESTORED_EVALUATION_ARMS.flatMap((arm) =>
      slots.flatMap(({ slotId }) =>
        [1, 2].map((repetition) => `${fixtureId}/${arm}/${slotId}/${String(repetition)}`),
      ),
    ),
  );
  const completed = new Set(
    observations.map(
      (observation) =>
        `${observation.fixtureId}/${observation.arm}/${observation.modelSlotId}/${String(observation.repetition)}`,
    ),
  );
  const missingCells = expectedCells.filter((cell) => !completed.has(cell));
  const armMetricMeans = restoredEvaluationMeans(observations);
  const modelArmMetricMeans = Object.fromEntries(
    slots.map(({ slotId }) => [
      slotId,
      restoredEvaluationMeans(
        observations.filter((observation) => observation.modelSlotId === slotId),
      ),
    ]),
  );
  const regressions = restoredEvaluationRegressions(observations, slots);
  const status =
    observations.length === 0
      ? "NOT_EVALUATED"
      : missingCells.length > 0
        ? "EVIDENCE_INCOMPLETE"
        : regressions.length > 0
          ? "FAILED"
          : "ELIGIBLE_FOR_REVIEW";
  return {
    status,
    defaultEnablement: "KEEP_DISABLED",
    observationCount: observations.length,
    expectedCellCount: expectedCells.length,
    completedCellCount: expectedCells.length - missingCells.length,
    missingCells,
    armMetricMeans,
    modelArmMetricMeans,
    regressions,
    note:
      status === "ELIGIBLE_FOR_REVIEW"
        ? "Quantitative gates passed, but a product review is still required before changing defaults."
        : "Novel Skills remain experimental and disabled by default.",
  };
}

function restoredEvaluationMeans(
  observations: readonly RestoredEvaluatorObservation[],
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const arm of RESTORED_EVALUATION_ARMS) {
    const armObservations = observations.filter((observation) => observation.arm === arm);
    const means: Record<string, number> = {};
    for (const metric of RESTORED_EVALUATION_METRICS) {
      const values = armObservations.map(({ scores }) => scores[metric]);
      if (values.length > 0) means[metric] = restoredRound(restoredMean(values));
    }
    if (Object.keys(means).length > 0) result[arm] = means;
  }
  return result;
}

function restoredEvaluationRegressions(
  observations: readonly RestoredEvaluatorObservation[],
  slots: readonly RestoredEvaluationModelSlot[],
): string[] {
  const regressions: string[] = [];
  const baselines = [
    ["core", "no_skill"],
    ["core_genre", "core"],
    ["core_genre_preferences", "core_genre"],
  ] as const;
  for (const { slotId } of slots) {
    for (const [arm, baselineArm] of baselines) {
      const candidates = observations.filter(
        (observation) => observation.modelSlotId === slotId && observation.arm === arm,
      );
      const applicable = candidates.filter((observation) =>
        arm === "core"
          ? observation.methodApplicability.core
          : arm === "core_genre"
            ? observation.methodApplicability.genre
            : true,
      );
      const nonApplicable = candidates.filter((observation) => !applicable.includes(observation));
      if (applicable.length === 0) {
        regressions.push(`${slotId}:improvement:${arm}_no_applicable_evidence`);
      }
      for (const [candidateSet, suffix] of [
        [applicable, ""],
        [nonApplicable, "non_applicable_safety"],
      ] as const) {
        if (candidateSet.length === 0) continue;
        const keys = new Set(
          candidateSet.map(({ fixtureId, repetition }) => `${fixtureId}/${String(repetition)}`),
        );
        const baselineSet = observations.filter(
          (observation) =>
            observation.modelSlotId === slotId &&
            observation.arm === baselineArm &&
            keys.has(`${observation.fixtureId}/${String(observation.repetition)}`),
        );
        restoredEvaluateIncrement(
          regressions,
          slotId,
          arm,
          baselineArm,
          baselineSet,
          candidateSet,
          suffix,
        );
      }
    }
  }
  return regressions;
}

function restoredEvaluateIncrement(
  regressions: string[],
  slotId: string,
  arm: Exclude<RestoredEvaluationArm, "no_skill">,
  baselineArm: RestoredEvaluationArm,
  baseline: readonly RestoredEvaluatorObservation[],
  candidates: readonly RestoredEvaluatorObservation[],
  suffix: string,
): void {
  const label = suffix === "" ? `${arm}_below_${baselineArm}` : `${arm}_${suffix}`;
  const guardLabel = suffix === "" ? `${arm}_above_${baselineArm}` : `${arm}_${suffix}`;
  const costLabel = suffix === "" ? arm : `${arm}_${suffix}`;
  for (const metric of RESTORED_EVALUATION_METRICS) {
    if (
      baseline.length > 0 &&
      candidates.length > 0 &&
      restoredMean(candidates.map(({ scores }) => scores[metric])) + 0.02 <
        restoredMean(baseline.map(({ scores }) => scores[metric]))
    ) {
      regressions.push(`${slotId}:${metric}:${label}`);
    }
  }
  if (suffix === "") {
    const baselineOverall = restoredMeanAllScores(baseline);
    const candidateOverall = restoredMeanAllScores(candidates);
    if (
      baseline.length !== candidates.length ||
      baselineOverall === null ||
      candidateOverall === null ||
      candidateOverall < baselineOverall + 0.02
    ) {
      regressions.push(`${slotId}:improvement:${arm}_no_demonstrated_improvement`);
    }
    for (const repetition of [1, 2]) {
      const baselineRepetition = restoredMeanAllScores(
        baseline.filter((observation) => observation.repetition === repetition),
      );
      const candidateRepetition = restoredMeanAllScores(
        candidates.filter((observation) => observation.repetition === repetition),
      );
      if (
        baselineRepetition === null ||
        candidateRepetition === null ||
        candidateRepetition <= baselineRepetition
      ) {
        regressions.push(
          `${slotId}:improvement:${arm}_repetition_${String(repetition)}_not_positive`,
        );
      }
    }
  }
  const baselineLatency = restoredMean(
    baseline.map(({ latencyMilliseconds }) => latencyMilliseconds),
  );
  const candidateLatency = restoredMean(
    candidates.map(({ latencyMilliseconds }) => latencyMilliseconds),
  );
  if (candidateLatency > Math.max(baselineLatency * 2, baselineLatency + 5_000)) {
    regressions.push(`${slotId}:latency:${guardLabel}`);
  }
  const baselineCosts = baseline.map(({ estimatedCostMicros }) => estimatedCostMicros);
  const candidateCosts = candidates.map(({ estimatedCostMicros }) => estimatedCostMicros);
  const baselineCost = restoredNullableMean(baselineCosts);
  const candidateCost = restoredNullableMean(candidateCosts);
  if (
    baselineCosts.some((cost) => cost === null) ||
    candidateCosts.some((cost) => cost === null) ||
    baselineCost === null ||
    candidateCost === null
  ) {
    regressions.push(`${slotId}:cost:${costLabel}_evidence_missing`);
  } else if (candidateCost > Math.max(baselineCost * 2, baselineCost + 1_000)) {
    regressions.push(`${slotId}:cost:${guardLabel}`);
  }
}

function restoredMean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function restoredNullableMean(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : restoredMean(present);
}

function restoredMeanAllScores(
  observations: readonly RestoredEvaluatorObservation[],
): number | null {
  if (observations.length === 0) return null;
  return restoredMean(
    observations.flatMap(({ scores }) =>
      RESTORED_EVALUATION_METRICS.map((metric) => scores[metric]),
    ),
  );
}

function restoredRound(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function parseSafeInteger(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateDatabasePath(path: string): Result<true, AppError> {
  if (path.trim().length === 0 || path.length > 32_767 || path.includes("\u0000")) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "The selected backup source is invalid.",
      }),
    );
  }
  return ok(true);
}

function normalizeDatabasePath(path: string): string {
  return path.replaceAll("\\", "/").toLocaleLowerCase();
}

function schemaContractsMatch(
  mainSchema: readonly SchemaContractRow[],
  backupSchema: readonly SchemaContractRow[],
): boolean {
  return (
    mainSchema.length === backupSchema.length &&
    mainSchema.every((mainEntry, index) => {
      const backupEntry = backupSchema[index];
      return (
        mainEntry.type === backupEntry?.type &&
        mainEntry.name === backupEntry.name &&
        mainEntry.tableName === backupEntry.tableName &&
        mainEntry.sql === backupEntry.sql
      );
    })
  );
}

function restoreError(operation: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The selected backup could not be restored safely.",
    retryable: operation === "DATABASE_RESTORE_FAILED",
    actions: ["RETRY", "CONTACT_SUPPORT"],
    details: { operation },
  });
}

function maintenanceError(operation: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The local database maintenance operation could not complete.",
    retryable: true,
    actions: ["RETRY", "EXPORT_DRAFT"],
    details: { operation },
  });
}
