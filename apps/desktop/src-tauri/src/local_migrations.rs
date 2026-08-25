use std::borrow::Cow;

use sha2::{Digest, Sha384};
use sqlx::{
    migrate::{MigrateError, Migration, MigrationType, Migrator},
    SqliteConnection,
};

const ZHIPU_GLM_MIGRATION_VERSION: i64 = 49;
const MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION: i64 = 60;
const MODEL_CAPABILITY_PROBE_LEDGER_MIGRATION_VERSION: i64 = 74;

const PUBLISHED_V029_MAXIMUM_MIGRATION_VERSION: i64 = 80;
const PUBLISHED_V029_MIGRATION_MANIFEST_SHA384: [u8; 48] = [
    0x3f, 0xd9, 0x7b, 0xe5, 0xe9, 0x36, 0xed, 0xdc, 0xb4, 0xa5, 0x88, 0x23, 0x5c, 0xcc, 0xc0, 0xde,
    0xaf, 0x22, 0x2e, 0xba, 0xda, 0xc4, 0xaa, 0xd3, 0xca, 0xbb, 0x30, 0xb9, 0x62, 0x03, 0x75, 0xdd,
    0xfe, 0x9b, 0x78, 0x4a, 0xf2, 0x0a, 0x79, 0x1d, 0x3b, 0x50, 0x6d, 0xfd, 0xa4, 0xf9, 0x48, 0xd9,
];

#[derive(Debug)]
pub(crate) struct LocalMigrationError {
    pub(crate) source: Box<MigrateError>,
    pub(crate) stage: &'static str,
    pub(crate) reason_code: &'static str,
    pub(crate) expected_version: i64,
    pub(crate) actual_version: i64,
    pub(crate) migration_version: Option<i64>,
    pub(crate) whitelist_reason_code: &'static str,
}
#[derive(Debug)]
struct AppliedMigrationHistory {
    actual_version: i64,
    accepted_checksums: Vec<(i64, Vec<u8>)>,
}

impl LocalMigrationError {
    fn integrity(
        source: MigrateError,
        reason_code: &'static str,
        expected_version: i64,
        actual_version: i64,
        migration_version: Option<i64>,
        whitelist_reason_code: &'static str,
    ) -> Self {
        Self {
            source: Box::new(source),
            stage: "migration_history_validation",
            reason_code,
            expected_version,
            actual_version,
            migration_version,
            whitelist_reason_code,
        }
    }

    fn execution(source: MigrateError, expected_version: i64, actual_version: i64) -> Self {
        let migration_version = migration_error_version(&source);
        let (stage, reason_code, whitelist_reason_code) = match source {
            MigrateError::VersionMissing(_)
            | MigrateError::VersionMismatch(_)
            | MigrateError::VersionNotPresent(_)
            | MigrateError::VersionTooOld(_, _)
            | MigrateError::VersionTooNew(_, _)
            | MigrateError::Dirty(_) => (
                "migration_history_validation",
                migration_error_reason_code(&source),
                "NO_PUBLISHED_MIGRATION_MATCH",
            ),
            _ => (
                "migration_apply",
                "MIGRATION_FORWARD_APPLY_FAILED",
                "PUBLISHED_HISTORY_ACCEPTED",
            ),
        };
        Self {
            source: Box::new(source),
            stage,
            reason_code,
            expected_version,
            actual_version,
            migration_version,
            whitelist_reason_code,
        }
    }
}

fn migration_error_reason_code(error: &MigrateError) -> &'static str {
    match error {
        MigrateError::VersionMissing(_) => "MIGRATION_VERSION_UNKNOWN",
        MigrateError::VersionMismatch(_) => "MIGRATION_CHECKSUM_UNKNOWN",
        MigrateError::VersionNotPresent(_) => "MIGRATION_HISTORY_MISSING_VERSION",
        MigrateError::VersionTooOld(_, _) => "MIGRATION_VERSION_ORDER_INVALID",
        MigrateError::VersionTooNew(_, _) => "MIGRATION_VERSION_AHEAD_OF_BUILD",
        MigrateError::Dirty(_) => "MIGRATION_HISTORY_DIRTY",
        _ => "MIGRATION_FORWARD_APPLY_FAILED",
    }
}

fn migration_error_version(error: &MigrateError) -> Option<i64> {
    match error {
        MigrateError::VersionMissing(version)
        | MigrateError::VersionMismatch(version)
        | MigrateError::VersionNotPresent(version)
        | MigrateError::Dirty(version) => Some(*version),
        MigrateError::VersionTooOld(version, _) | MigrateError::VersionTooNew(version, _) => {
            Some(*version)
        }
        _ => None,
    }
}
fn migration(version: i64, description: &'static str, sql: &'static str) -> Migration {
    // tauri-plugin-sql represented every prior `MigrationKind::Up` as a
    // SQLx `ReversibleUp` migration. Keeping that exact representation
    // preserves the existing `_sqlx_migrations` checksums and history.
    Migration::new(
        version,
        Cow::Borrowed(description),
        MigrationType::ReversibleUp,
        Cow::Borrowed(sql),
        false,
    )
}

pub(crate) fn local_migrator() -> Migrator {
    Migrator {
        migrations: Cow::Owned(vec![
            migration(
                1,
                "create local project and writing core",
                include_str!("../../../../packages/data/migrations/0001_core.sql"),
            ),
            migration(
                2,
                "create durable task and notification stores",
                include_str!(
                    "../../../../packages/data/migrations/0002_tasks_notifications.sql"
                ),
            ),
            migration(
                3,
                "create story governance, memory, and sandbox stores",
                include_str!(
                    "../../../../packages/story-core/migrations/0001_story_core.sql"
                ),
            ),
            migration(
                4,
                "create encrypted sync outbox and access metadata stores",
                include_str!("../../../../packages/data/migrations/0003_sync_access.sql"),
            ),
            migration(
                5,
                "create non-secret native model profiles",
                include_str!(
                    "../../../../packages/data/migrations/0004_model_profiles.sql"
                ),
            ),
            migration(
                6,
                "create governed material provenance and references",
                include_str!("../../../../packages/story-core/migrations/0002_materials.sql"),
            ),
            migration(
                7,
                "create AI pricing, budget, and generation governance stores",
                include_str!(
                    "../../../../packages/data/migrations/0005_ai_generation_governance.sql"
                ),
            ),
            migration(
                8,
                "create persistent derived project search snapshots",
                include_str!("../../../../packages/data/migrations/0006_search_index.sql"),
            ),
            migration(
                9,
                "create model role routes, deferred generation, and usage facts",
                include_str!(
                    "../../../../packages/data/migrations/0007_model_routing_usage.sql"
                ),
            ),
            migration(
                10,
                "create device public keys and project key envelopes",
                include_str!(
                    "../../../../packages/data/migrations/0008_project_key_lifecycle.sql"
                ),
            ),
            migration(
                11,
                "add local E2EE device display names",
                include_str!(
                    "../../../../packages/data/migrations/0009_device_identity_names.sql"
                ),
            ),
            migration(
                12,
                "create durable ciphertext sync inbox and remote checkpoints",
                include_str!("../../../../packages/data/migrations/0010_sync_inbox.sql"),
            ),
            migration(
                13,
                "create cloud project key publication checkpoints",
                include_str!(
                    "../../../../packages/data/migrations/0011_cloud_project_key_checkpoints.sql"
                ),
            ),
            migration(
                14,
                "create crash-safe cloud project key publications",
                include_str!(
                    "../../../../packages/data/migrations/0012_cloud_project_key_publications.sql"
                ),
            ),
            migration(
                15,
                "create atomic ciphertext sync snapshot staging",
                include_str!(
                    "../../../../packages/data/migrations/0013_sync_snapshot_staging.sql"
                ),
            ),
            migration(
                16,
                "upgrade sync transport ledger to typed protocol v2",
                include_str!(
                    "../../../../packages/data/migrations/0014_sync_protocol_v2_object_types.sql"
                ),
            ),
            migration(
                17,
                "create sync registration and plaintext materialization authority",
                include_str!(
                    "../../../../packages/data/migrations/0015_sync_materialization_authority.sql"
                ),
            ),
            migration(
                18,
                "create durable sync snapshot materialization receipts",
                include_str!(
                    "../../../../packages/data/migrations/0016_sync_snapshot_materialization_receipts.sql"
                ),
            ),
            migration(
                19,
                "bind sync projection jobs to cloud account authority",
                include_str!(
                    "../../../../packages/data/migrations/0017_sync_projection_account_authority.sql"
                ),
            ),
            migration(
                20,
                "record exact incremental terminal pull observations",
                include_str!(
                    "../../../../packages/data/migrations/0018_sync_incremental_terminal_observations.sql"
                ),
            ),
            migration(
                21,
                "create password-free cloud deletion recovery journals",
                include_str!(
                    "../../../../packages/data/migrations/0019_cloud_deletion_journal.sql"
                ),
            ),
            migration(
                22,
                "create rebuildable GraphRAG evidence projections",
                include_str!(
                    "../../../../packages/data/migrations/0020_graph_rag_projection.sql"
                ),
            ),
            migration(
                23,
                "create resumable quick-book and guided ideation drafts",
                include_str!("../../../../packages/story-core/migrations/0003_ideation.sql"),
            ),
            migration(
                24,
                "create rebuildable exact local vector search projections",
                include_str!(
                    "../../../../packages/data/migrations/0021_search_vector_index.sql"
                ),
            ),
            migration(
                25,
                "create non-secret team-managed project-key receipt metadata",
                include_str!(
                    "../../../../packages/data/migrations/0022_team_project_key_receipts.sql"
                ),
            ),
            migration(
                26,
                "track authoritative Story graph epochs for lock-light invalidation",
                include_str!(
                    "../../../../packages/data/migrations/0023_authoritative_story_graph_epoch.sql"
                ),
            ),
            migration(
                27,
                "create bounded public multi-agent review and candidate receipts",
                include_str!(
                    "../../../../packages/data/migrations/0024_multi_agent_review.sql"
                ),
            ),
            migration(
                28,
                "create governed translation and short-drama request ledgers",
                include_str!(
                    "../../../../packages/data/migrations/0025_governed_creative_extensions.sql"
                ),
            ),
            migration(
                29,
                "create crash-safe local team-template application receipts",
                include_str!(
                    "../../../../packages/data/migrations/0026_team_template_applications.sql"
                ),
            ),
            migration(
                30,
                "create authoritative extraction queues and evaluation gates",
                include_str!(
                    "../../../../packages/data/migrations/0027_authoritative_extraction.sql"
                ),
            ),
            migration(
                31,
                "create local fine-tuning data, job, evaluation, and deployment governance",
                include_str!(
                    "../../../../packages/data/migrations/0028_fine_tuning_governance.sql"
                ),
            ),
            migration(
                32,
                "create durable local community marketplace installs",
                include_str!(
                    "../../../../packages/data/migrations/0029_community_marketplace_installs.sql"
                ),
            ),
            migration(
                33,
                "create resumable creative journeys and ordered turns",
                include_str!(
                    "../../../../packages/data/migrations/0030_creative_journeys.sql"
                ),
            ),
            migration(
                34,
                "create Model Hub connections, routing evidence, and invocation facts",
                include_str!(
                    "../../../../packages/data/migrations/0031_model_hub.sql"
                ),
            ),
            migration(
                35,
                "create unified evidence-backed story facts and legacy links",
                include_str!(
                    "../../../../packages/data/migrations/0032_unified_story_facts.sql"
                ),
            ),
            migration(
                36,
                "create evidence-backed causal event graph projections",
                include_str!(
                    "../../../../packages/data/migrations/0033_causal_event_graph.sql"
                ),
            ),
            migration(
                37,
                "create content-free context compilation audit traces",
                include_str!(
                    "../../../../packages/data/migrations/0034_context_compilation_trace.sql"
                ),
            ),
            migration(
                38,
                "create visible user-controlled writing feedback learning",
                include_str!(
                    "../../../../packages/data/migrations/0035_writing_feedback_learning.sql"
                ),
            ),
            migration(
                39,
                "create review-only automatic story planning candidates",
                include_str!(
                    "../../../../packages/data/migrations/0036_story_planning_candidates.sql"
                ),
            ),
            migration(
                40,
                "add safe Model Hub expert connection options",
                include_str!(
                    "../../../../packages/data/migrations/0037_model_hub_expert_options.sql"
                ),
            ),
            migration(
                41,
                "add fail-closed local-only private chapters",
                include_str!(
                    "../../../../packages/data/migrations/0038_private_chapters.sql"
                ),
            ),
            migration(
                42,
                "create project-owned creation seeds and backfill legacy journeys",
                include_str!(
                    "../../../../packages/data/migrations/0039_project_seeds.sql"
                ),
            ),
            migration(
                43,
                "create immutable deterministic chapter validation snapshots",
                include_str!(
                    "../../../../packages/data/migrations/0040_chapter_validation_snapshots.sql"
                ),
            ),
            migration(
                44,
                "add safe selective story planning candidate acceptance",
                include_str!(
                    "../../../../packages/data/migrations/0041_story_planning_selective_acceptance.sql"
                ),
            ),
            migration(
                45,
                "repair immutable chapter validation snapshot deletion cascades",
                include_str!(
                    "../../../../packages/data/migrations/0042_chapter_validation_snapshot_delete_cascade.sql"
                ),
            ),
            migration(
                46,
                "permit only audited story fact entity alias resolutions",
                include_str!(
                    "../../../../packages/data/migrations/0043_story_fact_entity_alias_resolution.sql"
                ),
            ),
            migration(
                47,
                "reserve selective story planning acceptance before outline mutation",
                include_str!(
                    "../../../../packages/data/migrations/0044_story_planning_selective_acceptance_intent.sql"
                ),
            ),
            migration(
                48,
                "guard project privacy during remote model dispatch",
                include_str!(
                    "../../../../packages/data/migrations/0045_project_remote_dispatch_leases.sql"
                ),
            ),
            migration(
                49,
                "allow the registered Zhipu GLM Model Hub provider",
                include_str!(
                    "../../../../packages/data/migrations/0046_model_hub_zhipu_glm.sql"
                ),
            ),
            migration(
                50,
                "link context compilations to exact generations and AI candidates",
                include_str!(
                    "../../../../packages/data/migrations/0047_context_compilation_exact_provenance.sql"
                ),
            ),
            migration(
                51,
                "persist task-semantic AI Candidate application intents",
                include_str!(
                    "../../../../packages/data/migrations/0048_candidate_application_intents.sql"
                ),
            ),
            migration(
                52,
                "audit atomic project memory forgetting and manual merges",
                include_str!(
                    "../../../../packages/data/migrations/0049_memory_governance_audit.sql"
                ),
            ),
            migration(
                53,
                "authorize AI Candidate writes with monotonic revisions",
                include_str!(
                    "../../../../packages/data/migrations/0050_candidate_revision_authority.sql"
                ),
            ),
            migration(
                54,
                "journal recoverable Model Hub connection commits",
                include_str!(
                    "../../../../packages/data/migrations/0051_model_hub_connection_commits.sql"
                ),
            ),
            migration(
                55,
                "commit continuous story-state routes exactly once",
                include_str!(
                    "../../../../packages/data/migrations/0052_continuous_story_state_route_receipts.sql"
                ),
            ),
            migration(
                56,
                "bind writing feedback learning to event-time policy and custom clusters",
                include_str!(
                    "../../../../packages/data/migrations/0053_writing_feedback_learning_policy_context.sql"
                ),
            ),
            migration(
                57,
                "commit explicit writing feedback and learned preferences idempotently",
                include_str!(
                    "../../../../packages/data/migrations/0054_writing_feedback_explicit_idempotency.sql"
                ),
            ),
            migration(
                58,
                "restore historical continuous story-state route receipts safely",
                include_str!(
                    "../../../../packages/data/migrations/0055_continuous_story_state_historical_route_receipts.sql"
                ),
            ),
            migration(
                59,
                "persist redacted Model Hub failure diagnostics",
                include_str!(
                    "../../../../packages/data/migrations/0056_model_hub_failure_diagnostics.sql"
                ),
            ),
            migration(
                60,
                "allow the published Model Hub content quality task",
                include_str!(
                    "../../../../packages/data/migrations/0057_model_hub_content_quality_task.sql"
                ),
            ),
            migration(
                61,
                "persist atomic story settings import receipts",
                include_str!(
                    "../../../../packages/data/migrations/0058_story_settings_import_receipts.sql"
                ),
            ),
            migration(
                62,
                "record generation cost availability without blocking writing",
                include_str!(
                    "../../../../packages/data/migrations/0059_generation_preflight_cost_status.sql"
                ),
            ),
            migration(
                63,
                "persist content-free novel skill registry and invocation receipts",
                include_str!(
                    "../../../../packages/data/migrations/0060_novel_skill_registry.sql"
                ),
            ),
            migration(
                64,
                "persist content-free novel skill evaluation evidence ledger",
                include_str!(
                    "../../../../packages/data/migrations/0061_novel_skill_evaluation_ledger.sql"
                ),
            ),
            migration(
                65,
                "keep projects active for the complete native model dispatch lifecycle",
                include_str!(
                    "../../../../packages/data/migrations/0062_project_dispatch_active_guard.sql"
                ),
            ),
            migration(
                66,
                "persist paid novel skill evaluation dispatch and blind review authority",
                include_str!(
                    "../../../../packages/data/migrations/0063_novel_skill_evaluation_paid_runner.sql"
                ),
            ),
            migration(
                67,
                "freeze content-free paid evaluation predispatch authority",
                include_str!(
                    "../../../../packages/data/migrations/0064_novel_skill_evaluation_predispatch_authority.sql"
                ),
            ),
            migration(
                68,
                "persist the content-free model provider dispatch boundary",
                include_str!(
                    "../../../../packages/data/migrations/0065_model_invocation_dispatch_boundary.sql"
                ),
            ),
            migration(
                69,
                "persist the writing experience and content-free disclosure authority",
                include_str!(
                    "../../../../packages/data/migrations/0066_writing_experience_preferences.sql"
                ),
            ),
            migration(
                70,
                "persist bounded long-form consistency investigation receipts",
                include_str!(
                    "../../../../packages/data/migrations/0067_consistency_investigation_agent.sql"
                ),
            ),
            migration(
                71,
                "retain rotated writing disclosure grants outside the active authority limit",
                include_str!(
                    "../../../../packages/data/migrations/0068_writing_disclosure_active_grant_limit.sql"
                ),
            ),
            migration(
                72,
                "reserve consistency investigation model invocations before ledger start",
                include_str!(
                    "../../../../packages/data/migrations/0069_consistency_investigation_invocation_reservation.sql"
                ),
            ),
            migration(
                73,
                "add scoped multigranular local FTS projections",
                include_str!(
                    "../../../../packages/data/migrations/0070_multigranular_search_retrieval.sql"
                ),
            ),
            migration(
                74,
                "record capability probe calls in the ordinary model invocation ledger",
                include_str!(
                    "../../../../packages/data/migrations/0071_model_capability_probe_invocation_ledger.sql"
                ),
            ),
            migration(
                75,
                "isolate non-prose AI candidate purposes",
                include_str!(
                    "../../../../packages/data/migrations/0072_ai_candidate_purpose.sql"
                ),
            ),
            migration(
                76,
                "allow audited user revisions of story fact content",
                include_str!(
                    "../../../../packages/data/migrations/0073_story_fact_user_revisions.sql"
                ),
            ),
            migration(
                77,
                "persist immutable chapter version story-fact responsibility",
                include_str!(
                    "../../../../packages/data/migrations/0074_chapter_version_story_fact_responsibility.sql"
                ),
            ),
            migration(
                78,
                "persist generation attempt privacy snapshots",
                include_str!(
                    "../../../../packages/data/migrations/0075_generation_attempt_privacy_snapshot.sql"
                ),
            ),
            migration(
                79,
                "allow audited direct-local story fact author revisions",
                include_str!(
                    "../../../../packages/data/migrations/0076_direct_local_story_fact_author_revision.sql"
                ),
            ),
            migration(
                80,
                "persist content-free project display identities",
                include_str!(
                    "../../../../packages/data/migrations/0077_project_display_identities.sql"
                ),
            ),
            migration(
                81,
                "bind governed prose openings to their exact model invocation",
                include_str!(
                    "../../../../packages/data/migrations/0078_generation_attempt_prose_invocation.sql"
                ),
            ),
        ]),
        ignore_missing: false,
        locking: true,
        no_tx: false,
    }
}

fn latest_local_migration_version(migrator: &Migrator) -> i64 {
    migrator
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0)
}

fn published_v029_manifest_digest(migrator: &Migrator) -> [u8; 48] {
    let mut digest = Sha384::new();
    for migration in migrator
        .iter()
        .filter(|migration| migration.version <= PUBLISHED_V029_MAXIMUM_MIGRATION_VERSION)
    {
        digest.update(migration.version.to_be_bytes());
        digest.update((migration.description.len() as u64).to_be_bytes());
        digest.update(migration.description.as_bytes());
        digest.update((migration.sql.len() as u64).to_be_bytes());
        digest.update(migration.sql.as_bytes());
    }
    digest.finalize().into()
}
fn published_v029_legacy_windows_checksum(migration: &Migration) -> Vec<u8> {
    let windows_sql = migration.sql.replace('\n', "\r\n");
    Sha384::digest(windows_sql.as_bytes()).to_vec()
}

fn is_approved_published_checksum(migration: &Migration, checksum: &[u8]) -> bool {
    checksum == migration.checksum.as_ref()
        || (migration.version <= PUBLISHED_V029_MAXIMUM_MIGRATION_VERSION
            && checksum == published_v029_legacy_windows_checksum(migration))
}

fn bind_accepted_receipt_checksums(migrator: &mut Migrator, history: &AppliedMigrationHistory) {
    for migration in migrator.migrations.to_mut() {
        let Some((_, checksum)) = history
            .accepted_checksums
            .iter()
            .find(|(version, _)| *version == migration.version)
        else {
            continue;
        };
        if migration.checksum.as_ref() != checksum.as_slice() {
            migration.checksum = Cow::Owned(checksum.clone());
        }
    }
}

fn verify_published_v029_manifest(migrator: &Migrator) -> Result<(), LocalMigrationError> {
    let expected_version = latest_local_migration_version(migrator);
    let published: Vec<_> = migrator
        .iter()
        .filter(|migration| migration.version <= PUBLISHED_V029_MAXIMUM_MIGRATION_VERSION)
        .collect();
    let versions_are_exact = published.len() == PUBLISHED_V029_MAXIMUM_MIGRATION_VERSION as usize
        && published
            .iter()
            .enumerate()
            .all(|(index, migration)| migration.version == index as i64 + 1);
    if !versions_are_exact
        || published_v029_manifest_digest(migrator) != PUBLISHED_V029_MIGRATION_MANIFEST_SHA384
    {
        return Err(LocalMigrationError::integrity(
            MigrateError::VersionNotPresent(PUBLISHED_V029_MAXIMUM_MIGRATION_VERSION),
            "PUBLISHED_MIGRATION_BASELINE_INVALID",
            expected_version,
            0,
            None,
            "PUBLISHED_BASELINE_FINGERPRINT_MISMATCH",
        ));
    }
    Ok(())
}

async fn audit_applied_migration_history(
    connection: &mut SqliteConnection,
    migrator: &Migrator,
) -> Result<AppliedMigrationHistory, LocalMigrationError> {
    let expected_version = latest_local_migration_version(migrator);
    let table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_schema
         WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| {
        LocalMigrationError::integrity(
            MigrateError::Execute(error),
            "MIGRATION_HISTORY_UNREADABLE",
            expected_version,
            0,
            None,
            "MIGRATION_HISTORY_NOT_AUDITED",
        )
    })?;
    if table_exists == 0 {
        return Ok(AppliedMigrationHistory {
            actual_version: 0,
            accepted_checksums: Vec::new(),
        });
    }

    let records: Vec<(i64, String, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT version, description, success, checksum
         FROM _sqlx_migrations ORDER BY version ASC",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| {
        LocalMigrationError::integrity(
            MigrateError::Execute(error),
            "MIGRATION_HISTORY_UNREADABLE",
            expected_version,
            0,
            None,
            "MIGRATION_HISTORY_NOT_AUDITED",
        )
    })?;
    let actual_version = records.last().map_or(0, |record| record.0);

    for (index, (version, description, success, checksum)) in records.iter().enumerate() {
        if index > 0 && records[index - 1].0 == *version {
            return Err(LocalMigrationError::integrity(
                MigrateError::VersionNotPresent(*version),
                "MIGRATION_VERSION_DUPLICATE",
                expected_version,
                actual_version,
                Some(*version),
                "PUBLISHED_HISTORY_INCOMPLETE",
            ));
        }
        let required_version = index as i64 + 1;
        if *version != required_version {
            let reason_code = if *version > required_version {
                "MIGRATION_HISTORY_MISSING_VERSION"
            } else {
                "MIGRATION_VERSION_ORDER_INVALID"
            };
            return Err(LocalMigrationError::integrity(
                MigrateError::VersionNotPresent(required_version),
                reason_code,
                expected_version,
                actual_version,
                Some(required_version),
                "PUBLISHED_HISTORY_INCOMPLETE",
            ));
        }
        let Some(expected) = migrator
            .iter()
            .find(|migration| migration.version == *version)
        else {
            return Err(LocalMigrationError::integrity(
                MigrateError::VersionMissing(*version),
                "MIGRATION_VERSION_UNKNOWN",
                expected_version,
                actual_version,
                Some(*version),
                "NO_PUBLISHED_MIGRATION_MATCH",
            ));
        };
        if *success != 1 {
            return Err(LocalMigrationError::integrity(
                MigrateError::Dirty(*version),
                "MIGRATION_HISTORY_DIRTY",
                expected_version,
                actual_version,
                Some(*version),
                "PUBLISHED_HISTORY_NOT_COMPLETED",
            ));
        }
        if description != expected.description.as_ref() {
            return Err(LocalMigrationError::integrity(
                MigrateError::VersionMismatch(*version),
                "MIGRATION_DESCRIPTION_UNKNOWN",
                expected_version,
                actual_version,
                Some(*version),
                "NO_PUBLISHED_MIGRATION_MATCH",
            ));
        }
        if !is_approved_published_checksum(expected, checksum) {
            return Err(LocalMigrationError::integrity(
                MigrateError::VersionMismatch(*version),
                "MIGRATION_CHECKSUM_UNKNOWN",
                expected_version,
                actual_version,
                Some(*version),
                "NO_PUBLISHED_MIGRATION_MATCH",
            ));
        }
    }
    Ok(AppliedMigrationHistory {
        actual_version,
        accepted_checksums: records
            .into_iter()
            .map(|(version, _, _, checksum)| (version, checksum))
            .collect(),
    })
}

pub(crate) async fn run_local_migrations(
    connection: &mut SqliteConnection,
) -> Result<(), LocalMigrationError> {
    let mut full = local_migrator();
    verify_published_v029_manifest(&full)?;
    let expected_version = latest_local_migration_version(&full);
    let history = audit_applied_migration_history(connection, &full).await?;
    let actual_version = history.actual_version;
    bind_accepted_receipt_checksums(&mut full, &history);
    let wrap = |error| LocalMigrationError::execution(error, expected_version, actual_version);

    let before_zhipu = migration_subset(&full, |migration| {
        migration.version < ZHIPU_GLM_MIGRATION_VERSION
    });
    before_zhipu
        .run_direct(&mut *connection)
        .await
        .map_err(&wrap)?;

    run_foreign_key_disabled_migration(
        connection,
        &full,
        ZHIPU_GLM_MIGRATION_VERSION,
        "foreign-key violations remained after Model Hub provider migration",
    )
    .await
    .map_err(&wrap)?;

    let before_content_quality = migration_subset(&full, |migration| {
        migration.version > ZHIPU_GLM_MIGRATION_VERSION
            && migration.version < MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
    });
    before_content_quality
        .run_direct(&mut *connection)
        .await
        .map_err(&wrap)?;

    run_foreign_key_disabled_migration(
        connection,
        &full,
        MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION,
        "foreign-key violations remained after Model Hub task migration",
    )
    .await
    .map_err(&wrap)?;

    let before_capability_probe_ledger = migration_subset(&full, |migration| {
        migration.version > MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
            && migration.version < MODEL_CAPABILITY_PROBE_LEDGER_MIGRATION_VERSION
    });
    before_capability_probe_ledger
        .run_direct(&mut *connection)
        .await
        .map_err(&wrap)?;

    run_foreign_key_disabled_migration(
        connection,
        &full,
        MODEL_CAPABILITY_PROBE_LEDGER_MIGRATION_VERSION,
        "foreign-key violations remained after capability probe ledger migration",
    )
    .await
    .map_err(&wrap)?;

    let future = migration_subset(&full, |migration| {
        migration.version > MODEL_CAPABILITY_PROBE_LEDGER_MIGRATION_VERSION
    });
    future.run_direct(connection).await.map_err(&wrap)
}

async fn run_foreign_key_disabled_migration(
    connection: &mut SqliteConnection,
    full: &Migrator,
    version: i64,
    violation_message: &'static str,
) -> Result<(), MigrateError> {
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await?;
    let selected = migration_subset(full, |migration| migration.version == version);
    let migration_result = selected.run_direct(&mut *connection).await;
    let restore_foreign_keys = sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await;
    migration_result?;
    restore_foreign_keys?;

    let violation_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&mut *connection)
        .await?;
    if violation_count != 0 {
        return Err(MigrateError::Execute(sqlx::Error::Protocol(
            violation_message.into(),
        )));
    }
    Ok(())
}

fn migration_subset(migrator: &Migrator, include: impl Fn(&Migration) -> bool) -> Migrator {
    Migrator {
        migrations: Cow::Owned(
            migrator
                .iter()
                .filter(|migration| include(migration))
                .cloned()
                .collect(),
        ),
        ignore_missing: true,
        locking: true,
        no_tx: false,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        borrow::Cow,
        collections::BTreeMap,
        fmt::Write as _,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use sha2::{Digest, Sha256, Sha384};

    use sqlx::{
        migrate::{MigrateError, Migration, MigrationType, Migrator},
        sqlite::SqliteConnectOptions,
        Connection, Row, SqliteConnection,
    };

    use super::{
        local_migrator, migration_subset, published_v029_manifest_digest,
        run_foreign_key_disabled_migration, run_local_migrations,
        MODEL_CAPABILITY_PROBE_LEDGER_MIGRATION_VERSION,
        MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION, PUBLISHED_V029_MAXIMUM_MIGRATION_VERSION,
        PUBLISHED_V029_MIGRATION_MANIFEST_SHA384, ZHIPU_GLM_MIGRATION_VERSION,
    };

    fn test_migrator(migrations: Vec<Migration>) -> Migrator {
        Migrator {
            migrations: Cow::Owned(migrations),
            ignore_missing: false,
            locking: true,
            no_tx: false,
        }
    }

    fn test_migration(version: i64, sql: &'static str) -> Migration {
        Migration::new(
            version,
            Cow::Borrowed("test migration"),
            MigrationType::ReversibleUp,
            Cow::Borrowed(sql),
            false,
        )
    }

    const PUBLISHED_V023_MAXIMUM_MIGRATION_VERSION: i64 = 67;
    const SYNTHETIC_V029_PROJECT_COUNT: i64 = 14;
    const SYNTHETIC_V029_CHAPTER_COUNT: i64 = 19;
    const SYNTHETIC_V029_VERSION_COUNT: i64 = 36;
    const SYNTHETIC_V029_CANDIDATE_COUNT: i64 = 18;
    const SYNTHETIC_V029_CHAPTER_CHARACTER_COUNT: i64 = 115_000;
    const SYNTHETIC_V029_APPLICATION_TABLE_COUNT: usize = 190;
    const REQUIRED_V029_CREATIVE_AND_TRACE_TABLES: &[&str] = &[
        "projects",
        "project_display_identities",
        "project_display_identity_revisions",
        "project_seeds",
        "story_ideation_drafts",
        "story_outlines",
        "story_outline_drafts",
        "story_formal_records",
        "story_review_items",
        "story_memory_policies",
        "story_memory_records",
        "story_timeline_state",
        "story_what_if_branches",
        "story_materials",
        "story_material_references",
        "chapters",
        "chapter_versions",
        "recovery_drafts",
        "ai_candidates",
        "story_planning_candidates",
        "story_facts",
        "story_fact_revisions",
        "story_fact_legacy_links",
        "creative_journeys",
        "creative_journey_turns",
        "background_tasks",
        "notifications",
        "ai_generation_runs",
        "ai_generation_route_selections",
        "ai_generation_attempt_usage",
        "ai_deferred_generation_requests",
        "model_invocation_facts",
        "context_compilation_runs",
        "context_compilation_entries",
        "context_compilation_entry_sources",
        "local_audit_events",
        "story_settings_import_receipts",
        "writing_experience_preferences",
        "writing_provider_disclosure_grants",
        "writing_preferences",
        "writing_preference_revisions",
    ];

    struct PublishedLibraryDatabase {
        path: PathBuf,
    }

    impl PublishedLibraryDatabase {
        fn create() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock after the Unix epoch")
                .as_nanos();
            Self {
                path: std::env::temp_dir().join(format!(
                    "inkshadow-v029-scale-{}-{nonce}.db",
                    std::process::id()
                )),
            }
        }

        async fn open(&self) -> SqliteConnection {
            let options = SqliteConnectOptions::new()
                .filename(&self.path)
                .create_if_missing(true)
                .foreign_keys(true);
            SqliteConnection::connect_with(&options)
                .await
                .expect("open test-owned published database")
        }

        fn sidecar_path(&self, suffix: &str) -> PathBuf {
            let mut path = self.path.as_os_str().to_os_string();
            path.push(suffix);
            path.into()
        }
    }

    impl Drop for PublishedLibraryDatabase {
        fn drop(&mut self) {
            for path in [
                self.path.clone(),
                self.sidecar_path("-wal"),
                self.sidecar_path("-shm"),
            ] {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    #[derive(Debug, Eq, PartialEq)]
    struct TableSnapshot {
        row_count: i64,
        sha256: String,
    }

    type MigrationReceipt = (i64, String, String, i64, Vec<u8>, i64);

    #[derive(Debug, Eq, PartialEq)]
    struct PublishedLibrarySnapshot {
        projects: TableSnapshot,
        chapters: TableSnapshot,
        chapter_versions: TableSnapshot,
        candidates: TableSnapshot,
        chapter_character_count: i64,
        chapter_body_sha256: String,
        protected_tables: BTreeMap<String, TableSnapshot>,
        migration_receipts: Vec<MigrationReceipt>,
    }

    fn bytes_to_hex(bytes: &[u8]) -> String {
        let mut encoded = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            write!(&mut encoded, "{byte:02x}").expect("write hexadecimal digest");
        }
        encoded
    }

    fn sha256_hex(value: &str) -> String {
        bytes_to_hex(&Sha256::digest(value.as_bytes()))
    }

    fn digest_ordered_rows(rows: &[String]) -> String {
        let mut digest = Sha256::new();
        for row in rows {
            digest.update((row.len() as u64).to_be_bytes());
            digest.update(row.as_bytes());
        }
        bytes_to_hex(&digest.finalize())
    }

    async fn table_snapshot(connection: &mut SqliteConnection, query: &str) -> TableSnapshot {
        let rows: Vec<String> = sqlx::query_scalar(query)
            .fetch_all(connection)
            .await
            .expect("read ordered table summary rows");
        TableSnapshot {
            row_count: rows.len() as i64,
            sha256: digest_ordered_rows(&rows),
        }
    }

    fn quoted_identifier(value: &str) -> String {
        format!("\"{}\"", value.replace('"', "\"\""))
    }

    async fn complete_table_snapshot(
        connection: &mut SqliteConnection,
        table_name: &str,
    ) -> TableSnapshot {
        let table = quoted_identifier(table_name);
        let columns: Vec<(i64, String, String, i64, Option<String>, i64)> =
            sqlx::query_as(&format!("PRAGMA table_info({table})"))
                .fetch_all(&mut *connection)
                .await
                .expect("read protected table columns");
        assert!(
            !columns.is_empty(),
            "protected table {table_name} must exist"
        );

        let encoded_row = columns
            .iter()
            .map(|(_, name, _, _, _, _)| format!("quote({})", quoted_identifier(name)))
            .collect::<Vec<_>>()
            .join(" || char(31) || ");
        let mut primary_key = columns
            .iter()
            .filter(|(_, _, _, _, _, primary_key_order)| *primary_key_order > 0)
            .map(|(_, name, _, _, _, primary_key_order)| {
                (*primary_key_order, quoted_identifier(name))
            })
            .collect::<Vec<_>>();
        if primary_key.is_empty() {
            primary_key = columns
                .iter()
                .map(|(ordinal, name, _, _, _, _)| (*ordinal + 1, quoted_identifier(name)))
                .collect();
        }
        primary_key.sort_by_key(|(order, _)| *order);
        let order_by = primary_key
            .into_iter()
            .map(|(_, column)| column)
            .collect::<Vec<_>>()
            .join(", ");
        table_snapshot(
            connection,
            &format!("SELECT {encoded_row} FROM {table} ORDER BY {order_by}"),
        )
        .await
    }

    async fn protected_table_snapshots(
        connection: &mut SqliteConnection,
    ) -> BTreeMap<String, TableSnapshot> {
        let table_names: Vec<String> = sqlx::query_scalar(
            "SELECT name
             FROM sqlite_schema
             WHERE type = 'table'
               AND name NOT LIKE 'sqlite_%'
               AND name <> '_sqlx_migrations'
             ORDER BY name",
        )
        .fetch_all(&mut *connection)
        .await
        .expect("list every application-owned table");
        let mut snapshots = BTreeMap::new();
        for table_name in table_names {
            let snapshot = complete_table_snapshot(connection, &table_name).await;
            snapshots.insert(table_name, snapshot);
        }
        snapshots
    }

    async fn replace_published_v029_receipts_with_legacy_windows_checksums(
        connection: &mut SqliteConnection,
    ) {
        let migrator = local_migrator();
        for migration in migrator
            .iter()
            .filter(|migration| migration.version <= PUBLISHED_V029_MAXIMUM_MIGRATION_VERSION)
        {
            let legacy_sql = migration.sql.replace('\n', "\r\n");
            let legacy_checksum = Sha384::digest(legacy_sql.as_bytes()).to_vec();
            sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
                .bind(legacy_checksum)
                .bind(migration.version)
                .execute(&mut *connection)
                .await
                .expect("replace receipt with the released Windows text checksum");
        }
    }

    async fn published_library_snapshot(
        connection: &mut SqliteConnection,
    ) -> PublishedLibrarySnapshot {
        let projects = table_snapshot(
            connection,
            "SELECT json_object(
               'id', id, 'name', name, 'status', status, 'revision', revision,
               'deletion_generation', deletion_generation, 'created_at', created_at,
               'updated_at', updated_at, 'archived_at', archived_at,
               'trashed_at', trashed_at, 'retention_until', retention_until,
               'status_before_trash', status_before_trash
             ) FROM projects ORDER BY id",
        )
        .await;
        let chapters = table_snapshot(
            connection,
            "SELECT json_object(
               'id', id, 'project_id', project_id, 'title', title, 'content', content,
               'status', status, 'revision', revision, 'current_version_id', current_version_id,
               'created_at', created_at, 'updated_at', updated_at, 'trashed_at', trashed_at,
               'privacy_mode', privacy_mode, 'privacy_revision', privacy_revision
             ) FROM chapters ORDER BY id",
        )
        .await;
        let chapter_versions = table_snapshot(
            connection,
            "SELECT json_object(
               'id', id, 'project_id', project_id, 'chapter_id', chapter_id,
               'parent_version_id', parent_version_id, 'sequence', sequence,
               'content', content, 'content_checksum', content_checksum, 'reason', reason,
               'source_candidate_id', source_candidate_id, 'created_at', created_at,
               'organize_local_story_facts', organize_local_story_facts
             ) FROM chapter_versions ORDER BY id",
        )
        .await;
        let candidates = table_snapshot(
            connection,
            "SELECT json_object(
               'id', id, 'project_id', project_id, 'chapter_id', chapter_id,
               'source', source, 'base_version_id', base_version_id, 'content', content,
               'content_checksum', content_checksum, 'status', status, 'incomplete', incomplete,
               'created_at', created_at, 'updated_at', updated_at, 'decided_at', decided_at,
               'task_intent', task_intent, 'application_mode', application_mode,
               'payload_kind', payload_kind, 'anchor_start_utf16', anchor_start_utf16,
               'anchor_end_utf16', anchor_end_utf16, 'revision', revision, 'purpose', purpose
             ) FROM ai_candidates ORDER BY id",
        )
        .await;

        let bodies: Vec<(String, String)> =
            sqlx::query_as("SELECT id, content FROM chapters ORDER BY id")
                .fetch_all(&mut *connection)
                .await
                .expect("read authoritative chapter bodies");
        let mut body_digest = Sha256::new();
        for (id, content) in &bodies {
            body_digest.update((id.len() as u64).to_be_bytes());
            body_digest.update(id.as_bytes());
            body_digest.update((content.len() as u64).to_be_bytes());
            body_digest.update(content.as_bytes());
        }
        let chapter_character_count: i64 =
            sqlx::query_scalar("SELECT COALESCE(SUM(length(content)), 0) FROM chapters")
                .fetch_one(&mut *connection)
                .await
                .expect("count authoritative chapter characters");
        let protected_tables = protected_table_snapshots(&mut *connection).await;
        let migration_receipts: Vec<MigrationReceipt> = sqlx::query_as(
            "SELECT version, description, CAST(installed_on AS TEXT), success, checksum,
                    execution_time
             FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&mut *connection)
        .await
        .expect("read complete migration receipts");

        PublishedLibrarySnapshot {
            projects,
            chapters,
            chapter_versions,
            candidates,
            chapter_character_count,
            chapter_body_sha256: bytes_to_hex(&body_digest.finalize()),
            migration_receipts,
            protected_tables,
        }
    }

    fn synthetic_project_id(project_index: usize) -> String {
        format!("synthetic-v029-project-{project_index:02}")
    }

    fn synthetic_chapter_project_id(chapter_index: usize) -> String {
        let project_index = if chapter_index < 10 {
            chapter_index / 2
        } else {
            chapter_index - 5
        };
        synthetic_project_id(project_index)
    }

    fn synthetic_current_version_id(chapter_index: usize) -> String {
        let sequence = if chapter_index < 17 { 2 } else { 1 };
        format!("synthetic-v029-version-{chapter_index:02}-{sequence}")
    }

    async fn seed_v029_scale_library(connection: &mut SqliteConnection) {
        const NOW: &str = "2026-08-24T00:00:00.000Z";

        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .expect("begin synthetic library transaction");

        for project_index in 0..SYNTHETIC_V029_PROJECT_COUNT as usize {
            sqlx::query(
                "INSERT INTO projects (
                   id, name, status, revision, deletion_generation, created_at, updated_at
                 ) VALUES (?, ?, 'active', 1, 0, ?, ?)",
            )
            .bind(synthetic_project_id(project_index))
            .bind(format!("合成作品 {:02}", project_index + 1))
            .bind(NOW)
            .bind(NOW)
            .execute(&mut *connection)
            .await
            .expect("insert synthetic project");
        }

        for chapter_index in 0..SYNTHETIC_V029_CHAPTER_COUNT as usize {
            let chapter_id = format!("synthetic-v029-chapter-{chapter_index:02}");
            let project_id = synthetic_chapter_project_id(chapter_index);
            let current_version_id = synthetic_current_version_id(chapter_index);
            let character_count = 6_052 + usize::from(chapter_index < 12);
            let content = "墨".repeat(character_count);

            sqlx::query(
                "INSERT INTO chapters (
                   id, project_id, title, content, status, revision, current_version_id,
                   created_at, updated_at, trashed_at
                 ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL)",
            )
            .bind(&chapter_id)
            .bind(&project_id)
            .bind(format!("第 {} 章", chapter_index + 1))
            .bind(&content)
            .bind(&current_version_id)
            .bind(NOW)
            .bind(NOW)
            .execute(&mut *connection)
            .await
            .expect("insert synthetic chapter");

            let has_second_version = chapter_index < 17;
            let first_content = if has_second_version {
                "旧".repeat(128 + chapter_index)
            } else {
                content.clone()
            };
            let first_version_id = format!("synthetic-v029-version-{chapter_index:02}-1");
            sqlx::query(
                "INSERT INTO chapter_versions (
                   id, project_id, chapter_id, parent_version_id, sequence, content,
                   content_checksum, reason, source_candidate_id, created_at
                 ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)",
            )
            .bind(&first_version_id)
            .bind(&project_id)
            .bind(&chapter_id)
            .bind(&first_content)
            .bind(sha256_hex(&first_content))
            .bind(NOW)
            .execute(&mut *connection)
            .await
            .expect("insert first immutable version");

            if has_second_version {
                sqlx::query(
                    "INSERT INTO chapter_versions (
                       id, project_id, chapter_id, parent_version_id, sequence, content,
                       content_checksum, reason, source_candidate_id, created_at
                     ) VALUES (?, ?, ?, ?, 2, ?, ?, 'manual', NULL, ?)",
                )
                .bind(&current_version_id)
                .bind(&project_id)
                .bind(&chapter_id)
                .bind(&first_version_id)
                .bind(&content)
                .bind(sha256_hex(&content))
                .bind(NOW)
                .execute(&mut *connection)
                .await
                .expect("insert current immutable version");
            }
        }

        for candidate_index in 0..SYNTHETIC_V029_CANDIDATE_COUNT as usize {
            let chapter_id = format!("synthetic-v029-chapter-{candidate_index:02}");
            let project_id = synthetic_chapter_project_id(candidate_index);
            let content = format!(
                "隔离候选 {} {}",
                candidate_index + 1,
                "候".repeat(96 + candidate_index)
            );
            let (status, decided_at) = match candidate_index {
                0..=13 => ("ready", None),
                14..=15 => ("rejected", Some(NOW)),
                _ => ("expired", Some(NOW)),
            };
            sqlx::query(
                "INSERT INTO ai_candidates (
                   id, project_id, chapter_id, source, base_version_id, content,
                   content_checksum, status, incomplete, created_at, updated_at, decided_at
                 ) VALUES (?, ?, ?, 'generate', ?, ?, ?, ?, 0, ?, ?, ?)",
            )
            .bind(format!("synthetic-v029-candidate-{candidate_index:02}"))
            .bind(project_id)
            .bind(chapter_id)
            .bind(synthetic_current_version_id(candidate_index))
            .bind(&content)
            .bind(sha256_hex(&content))
            .bind(status)
            .bind(NOW)
            .bind(NOW)
            .bind(decided_at)
            .execute(&mut *connection)
            .await
            .expect("insert isolated synthetic candidate");
        }

        seed_v029_creative_and_trace_chain(&mut *connection, NOW).await;

        sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .expect("commit synthetic library transaction");
        let foreign_key_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(connection)
                .await
                .expect("verify synthetic library foreign keys");
        assert_eq!(foreign_key_violations, 0);
    }

    async fn seed_v029_creative_and_trace_chain(connection: &mut SqliteConnection, now: &str) {
        let first_project = synthetic_project_id(0);
        let first_chapter = "synthetic-v029-chapter-00";
        let first_version = synthetic_current_version_id(0);
        let first_candidate = "synthetic-v029-candidate-00";

        for project_index in 0..SYNTHETIC_V029_PROJECT_COUNT as usize {
            let project_id = synthetic_project_id(project_index);
            let seed_id = format!("synthetic-v029-seed-{project_index:02}");
            let seed_payload = format!(
                "{{\"seedId\":\"{seed_id}\",\"journeyKind\":\"idea\",\"version\":1,\"premise\":{{\"text\":\"合成灵感 {}\"}}}}",
                project_index + 1
            );
            sqlx::query(
                "INSERT INTO project_display_identities (
                   project_id, display_kind, provenance, revision, created_at, updated_at
                 ) VALUES (?, 'author_work', 'explicit_creation', 1, ?, ?)",
            )
            .bind(&project_id)
            .bind(now)
            .bind(now)
            .execute(&mut *connection)
            .await
            .expect("insert project display identity");
            sqlx::query(
                "INSERT INTO project_seeds (
                   project_id, seed_id, journey_kind, schema_version, payload_json,
                   revision, created_at, updated_at
                 ) VALUES (?, ?, 'idea', 1, ?, 1, ?, ?)",
            )
            .bind(project_id)
            .bind(seed_id)
            .bind(seed_payload)
            .bind(now)
            .bind(now)
            .execute(&mut *connection)
            .await
            .expect("insert project seed");
        }

        sqlx::query(
            "INSERT INTO story_ideation_drafts (
               id, mode, status, project_id, revision, updated_at, snapshot_json
             ) VALUES
               ('synthetic-v029-idea-active', 'quick', 'active', NULL, 2, ?,
                '{\"idea\":\"尚未创建的本地灵感\"}'),
               ('synthetic-v029-idea-finalized', 'guided', 'finalized', ?, 3, ?,
                '{\"idea\":\"已绑定项目的灵感\"}')",
        )
        .bind(now)
        .bind(&first_project)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert active and finalized ideation drafts");

        sqlx::query(
            "INSERT INTO story_outlines (project_id, revision, snapshot_json)
             VALUES (?, 2, '{\"title\":\"合成规划\",\"nodes\":[]}')",
        )
        .bind(&first_project)
        .execute(&mut *connection)
        .await
        .expect("insert authoritative outline");
        sqlx::query(
            "INSERT INTO story_formal_records (
               id, project_id, kind, record_key, revision, current_version,
               created_at, updated_at, snapshot_json
             ) VALUES ('synthetic-v029-formal-record', ?, 'character', 'zhou-wang', 1, 1,
                       ?, ?, '{\"name\":\"周望\"}')",
        )
        .bind(&first_project)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert legacy formal setting");
        sqlx::query(
            "INSERT INTO story_review_items (
               id, project_id, item_type, status, revision, target_record_id,
               source_chapter_id, source_version_id, deferred_until,
               created_at, updated_at, snapshot_json
             ) VALUES ('synthetic-v029-review-setting', ?, 'extraction', 'pending', 1,
                       'synthetic-v029-formal-record', ?, ?, NULL, ?, ?,
                       '{\"claim\":\"钟楼位于旧城\"}')",
        )
        .bind(&first_project)
        .bind(first_chapter)
        .bind(&first_version)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert pending legacy setting");
        sqlx::query(
            "INSERT INTO story_memory_policies (
               project_id, automatic_learning_enabled, revision, created_at, updated_at,
               snapshot_json
             ) VALUES (?, 0, 1, ?, ?, '{\"automaticLearningEnabled\":false}')",
        )
        .bind(&first_project)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert story memory policy");
        sqlx::query(
            "INSERT INTO story_memory_records (
               id, project_id, level, origin, status, revision, source_kind, source_id,
               source_version_id, automatic_learning_policy_revision,
               created_at, updated_at, snapshot_json
             ) VALUES ('synthetic-v029-memory', ?, 'L1', 'user', 'enabled', 1,
                       'user_rule', 'synthetic-v029-user-rule', NULL, NULL, ?, ?,
                       '{\"rule\":\"钟摆只能在午夜倒转\"}')",
        )
        .bind(&first_project)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert user memory record");

        sqlx::query(
            "INSERT INTO recovery_drafts (
               id, project_id, chapter_id, base_revision, content, cursor_offset,
               created_at, updated_at
             ) VALUES ('synthetic-v029-recovery', ?, ?, 1, 'recoverable draft', 17, ?, ?)",
        )
        .bind(&first_project)
        .bind(first_chapter)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert recovery draft");

        sqlx::query(
            "INSERT INTO story_facts (
               id, project_id, fact_type, content_text, value_json, source_kind,
               evidence_reference, confidence, status, origin, user_confirmed, locked,
               deprecated, needs_review, confirmed_by_actor_id, confirmed_at,
               revision, created_at, updated_at
             ) VALUES (
               'synthetic-v029-formal-fact', ?, 'person.identity',
               '周望是钟楼管理员', NULL, 'user_statement', '用户明确添加的设定',
               1.0, 'formal', 'user', 1, 0, 0, 0, 'local-author', ?, 1, ?, ?
             )",
        )
        .bind(&first_project)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert confirmed user story fact");
        sqlx::query(
            "INSERT INTO story_facts (
               id, project_id, fact_type, content_text, value_json, source_kind,
               evidence_reference, confidence, status, origin, user_confirmed, locked,
               deprecated, needs_review, confirmed_by_actor_id, confirmed_at,
               revision, created_at, updated_at
             ) VALUES (
               'synthetic-v029-pending-fact', ?, 'place.location',
               '钟楼位于旧城', NULL, 'system_derivation', '本地整理后等待作者确认',
               0.8, 'unconfirmed', 'ai_extraction', 0, 0, 0, 1, NULL, NULL, 1, ?, ?
             )",
        )
        .bind(&first_project)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert pending story fact");
        sqlx::query(
            "INSERT INTO story_fact_revisions (
               fact_id, project_id, revision, change_kind, recorded_at, snapshot_json
             ) VALUES
               ('synthetic-v029-formal-fact', ?, 1, 'created', ?,
                '{\"status\":\"formal\",\"contentText\":\"周望是钟楼管理员\"}'),
               ('synthetic-v029-pending-fact', ?, 1, 'created', ?,
                '{\"status\":\"unconfirmed\",\"contentText\":\"钟楼位于旧城\"}')",
        )
        .bind(&first_project)
        .bind(now)
        .bind(&first_project)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert immutable story fact revisions");

        sqlx::query(
            "INSERT INTO writing_preferences (
               id, project_id, preference_text, source, source_feedback_code,
               evidence_count, enabled, revision, created_at, updated_at, deleted_at
             ) VALUES ('synthetic-v029-writing-preference', ?, '保留克制的叙述语气',
                       'manual', NULL, 0, 1, 1, ?, ?, NULL)",
        )
        .bind(&first_project)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert user writing preference");
        sqlx::query(
            "INSERT INTO writing_experience_preferences (
               scope, mode, initialization_source, direct_local_organization_authorized_at,
               revision, created_at, updated_at
             ) VALUES ('global', 'direct', 'user', ?, 2, ?, ?)",
        )
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert writing experience preference");

        sqlx::query(
            "INSERT INTO creative_journeys (
               id, kind, status, current_state, project_id, chapter_id, candidate_id,
               revision, snapshot_json, created_at, updated_at, completed_at
             ) VALUES ('synthetic-v029-journey', 'idea', 'completed', 'candidate_ready',
                       ?, ?, ?, 4, '{\"recoverable\":true}', ?, ?, ?)",
        )
        .bind(&first_project)
        .bind(first_chapter)
        .bind(first_candidate)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert recoverable creation journey");
        sqlx::query(
            "INSERT INTO creative_journey_turns (
               id, journey_id, sequence, turn_kind, question_key, generation_source,
               provider_id, model_id, task_key, request_id, snapshot_json, created_at
             ) VALUES ('synthetic-v029-journey-turn', 'synthetic-v029-journey', 1,
                       'idea', NULL, 'provider', 'synthetic-provider', 'synthetic-model',
                       'book_start_guidance', 'synthetic-request',
                       '{\"state\":\"completed\"}', ?)",
        )
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert creation journey turn");

        sqlx::query(
            "INSERT INTO model_provider_connections (
               id, provider_kind, display_name, protocol, base_url, created_at, updated_at
             ) VALUES ('synthetic-provider', 'deepseek', '合成服务商', 'openai_compatible',
                       'https://example.invalid/v1', ?, ?)",
        )
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert content-free provider connection");
        sqlx::query(
            "INSERT INTO model_invocation_facts (
               id, task, route_task, connection_id, catalog_entry_id,
               provider_kind_snapshot, model_id_snapshot, route_reason, status, attempt,
               fallback_from_invocation_id, privacy_policy, data_destination,
               input_tokens, output_tokens, cached_input_tokens, error_code, error_summary,
               started_at, completed_at, created_at, revision, diagnostic_request_id,
               failure_stage, failure_retryable, http_status, finish_reason,
               visible_content_length, reasoning_present, streamed,
               requested_max_output_tokens, provider_dispatch_started_at
             ) VALUES (
               'synthetic-v029-invocation', 'continuation', NULL, 'synthetic-provider', NULL,
               'deepseek', 'synthetic-model', 'user_override', 'succeeded', 1, NULL,
               'cloud_allowed', 'remote', 10, 20, 0, NULL, NULL, ?, ?, ?, 1,
               'synthetic-request', NULL, NULL, 200, 'stop', 128, 0, 1, 256, ?
             )",
        )
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert universal invocation ledger row");

        sqlx::query(
            "INSERT INTO background_tasks (
               id, task_type, idempotency_key, metadata_json, priority, status,
               attempt, max_attempts, sequence, run_after,
               created_at, updated_at, started_at, finished_at
             ) VALUES ('synthetic-v029-task', 'ai.generate', 'synthetic-v029-task-key',
                       '{\"projectId\":\"synthetic-v029-project-00\"}', 50, 'succeeded',
                       1, 1, 1, NULL, ?, ?, ?, ?)",
        )
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert completed background task");
        sqlx::query(
            "INSERT INTO ai_generation_runs (
               id, task_id, idempotency_key, project_id, chapter_id, base_version_id,
               provider_id, model_id, state, revision, attempt, input_tokens,
               maximum_output_tokens, estimated_cost_micros, incurred_cost_micros,
               currency, pricing_version, price_updated_at, preflight_json,
               candidate_id, failure_code, cancelled_at, completed_at, created_at, updated_at
             ) VALUES ('synthetic-v029-generation', 'synthetic-v029-task',
                       'synthetic-v029-generation-key', ?, ?, ?, 'synthetic-provider',
                       'synthetic-model', 'completed', 1, 1, 10, 256, '0', '0', 'CNY',
                       'synthetic-pricing-v1', ?, '{}', ?, NULL, NULL, ?, ?, ?)",
        )
        .bind(&first_project)
        .bind(first_chapter)
        .bind(&first_version)
        .bind(now)
        .bind(first_candidate)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert generation run");
        sqlx::query(
            "INSERT INTO ai_generation_route_selections (
               run_id, role, reason, fallback_provider_id, fallback_model_id, created_at
             ) VALUES ('synthetic-v029-generation', 'fast', 'role_primary', NULL, NULL, ?)",
        )
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert generation route selection");
        sqlx::query(
            "INSERT INTO ai_generation_attempt_usage (
               run_id, attempt, usage_source, input_tokens, output_tokens,
               cached_input_tokens, usage_priced_estimate_micros, cost_status,
               currency, pricing_version, price_updated_at, reported_at,
               privacy_snapshot_version, privacy_policy, data_destination,
               model_invocation_id
             ) VALUES ('synthetic-v029-generation', 1, 'provider_reported', 10, 20, 0,
                       '0', 'estimated', 'CNY', 'synthetic-pricing-v1', ?, ?, 1,
                       'cloud_allowed', 'remote', 'synthetic-v029-invocation')",
        )
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert privacy-bound generation usage");

        sqlx::query(
            "INSERT INTO story_planning_candidates (
               id, project_id, task, target_node_id, target_node_title,
               baseline_outline_revision, status, payload_json, editable_synopsis,
               context_json, invocation_id, connection_id, catalog_entry_id,
               provider_kind, model_id, used_fallback, accepted_outline_revision,
               revision, created_at, updated_at, decided_at
             ) VALUES ('synthetic-v029-planning-candidate', ?, 'outline_planning',
                       'root', '故事根节点', 2, 'review', '{\"nodes\":[]}',
                       '等待作者决定的故事方向', '{}', 'synthetic-v029-invocation',
                       'synthetic-provider', 'synthetic-catalog', 'deepseek',
                       'synthetic-model', 0, NULL, 1, ?, ?, NULL)",
        )
        .bind(&first_project)
        .bind(now)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert historical planning candidate");
        sqlx::query(
            "INSERT INTO local_audit_events (
               id, project_id, entity_type, entity_id, action, request_id,
               metadata_json, created_at
             ) VALUES ('synthetic-v029-audit', ?, 'ai_candidate', ?, 'generated',
                       'synthetic-request', '{\"isolated\":true}', ?)",
        )
        .bind(&first_project)
        .bind(first_candidate)
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert local audit event");
        sqlx::query(
            "INSERT INTO story_settings_import_receipts (
               id, project_id, source_sha256, request_sha256, status,
               created_record_ids_json, updated_record_fences_json,
               created_fact_ids_json, created_memory_ids_json,
               imported_count, skipped_count, created_at, undone_at
             ) VALUES ('synthetic-v029-settings-receipt', ?, ?, ?, 'committed',
                       '[\"synthetic-v029-formal-record\"]', '[]',
                       '[\"synthetic-v029-formal-fact\"]', '[\"synthetic-v029-memory\"]',
                       3, 0, ?, NULL)",
        )
        .bind(first_project)
        .bind("1".repeat(64))
        .bind("2".repeat(64))
        .bind(now)
        .execute(&mut *connection)
        .await
        .expect("insert story settings import receipt");
    }

    async fn apply_published_v023_history(connection: &mut SqliteConnection) {
        let full = local_migrator();
        let through_v023 = test_migrator(
            full.iter()
                .filter(|migration| migration.version <= PUBLISHED_V023_MAXIMUM_MIGRATION_VERSION)
                .cloned()
                .collect(),
        );
        assert_eq!(through_v023.iter().count(), 67);

        migration_subset(&through_v023, |migration| {
            migration.version < ZHIPU_GLM_MIGRATION_VERSION
        })
        .run_direct(&mut *connection)
        .await
        .expect("apply v0.2.3 history before Zhipu migration");
        run_foreign_key_disabled_migration(
            connection,
            &through_v023,
            ZHIPU_GLM_MIGRATION_VERSION,
            "foreign-key violations remained after v0.2.3 Zhipu migration",
        )
        .await
        .expect("apply v0.2.3 Zhipu migration");
        migration_subset(&through_v023, |migration| {
            migration.version > ZHIPU_GLM_MIGRATION_VERSION
                && migration.version < MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        })
        .run_direct(&mut *connection)
        .await
        .expect("apply v0.2.3 history before content-quality migration");
        run_foreign_key_disabled_migration(
            connection,
            &through_v023,
            MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION,
            "foreign-key violations remained after v0.2.3 content-quality migration",
        )
        .await
        .expect("apply v0.2.3 content-quality migration");
        migration_subset(&through_v023, |migration| {
            migration.version > MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        })
        .run_direct(connection)
        .await
        .expect("apply remaining v0.2.3 history");
    }

    #[test]
    fn preserves_the_published_sync_access_migration_checksum() {
        let migrator = local_migrator();
        let migration = migrator
            .iter()
            .find(|migration| migration.version == 4)
            .expect("sync access migration");

        assert_eq!(
            migration.checksum.as_ref(),
            &[
                0x0d, 0xc3, 0x05, 0xea, 0xda, 0xfd, 0x5f, 0x66, 0xf8, 0xe7, 0x04, 0x1e, 0x81, 0xcc,
                0xca, 0xfe, 0x32, 0x65, 0xd7, 0xc8, 0x1d, 0xb5, 0x73, 0xc2, 0xc4, 0x5d, 0xca, 0x0e,
                0x6b, 0x64, 0xfb, 0xa0, 0xb4, 0xf9, 0xd2, 0x70, 0x25, 0xf5, 0x48, 0xba, 0xc7, 0x5f,
                0x09, 0x60, 0x6f, 0x8e, 0xd5, 0x74,
            ],
        );
    }

    #[test]
    fn pins_every_published_v029_migration_name_order_and_sql_byte() {
        let migrator = local_migrator();
        let published: Vec<_> = migrator
            .iter()
            .filter(|migration| migration.version <= PUBLISHED_V029_MAXIMUM_MIGRATION_VERSION)
            .collect();
        assert_eq!(published.len(), 80);
        assert!(published
            .iter()
            .enumerate()
            .all(|(index, migration)| migration.version == index as i64 + 1));
        assert_eq!(
            published_v029_manifest_digest(&migrator),
            PUBLISHED_V029_MIGRATION_MANIFEST_SHA384
        );
    }

    #[tokio::test]
    async fn accepts_the_exact_published_v029_history_without_rewriting_its_receipts() {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        run_local_migrations(&mut connection)
            .await
            .expect("apply published history");
        let before: Vec<(i64, String, i64, Vec<u8>)> = sqlx::query_as(
            "SELECT version, description, success, checksum
             FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&mut connection)
        .await
        .expect("read published receipts");

        run_local_migrations(&mut connection)
            .await
            .expect("accept exact published history");
        let after: Vec<(i64, String, i64, Vec<u8>)> = sqlx::query_as(
            "SELECT version, description, success, checksum
             FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&mut connection)
        .await
        .expect("read accepted receipts");
        assert_eq!(before, after);
        assert_eq!(before.len(), 81);
    }

    #[tokio::test]
    async fn accepts_legacy_windows_published_receipts_without_rewriting_them() {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open legacy receipt fixture");
        run_local_migrations(&mut connection)
            .await
            .expect("create canonical published history");
        replace_published_v029_receipts_with_legacy_windows_checksums(&mut connection).await;
        let before: Vec<(i64, String, i64, Vec<u8>)> = sqlx::query_as(
            "SELECT version, description, success, checksum
             FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&mut connection)
        .await
        .expect("read legacy Windows receipts");

        run_local_migrations(&mut connection)
            .await
            .expect("accept the exact released Windows receipt whitelist");
        let after: Vec<(i64, String, i64, Vec<u8>)> = sqlx::query_as(
            "SELECT version, description, success, checksum
             FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&mut connection)
        .await
        .expect("read accepted legacy receipts");
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn preserves_a_v029_scale_library_across_upgrade_and_restart() {
        let database = PublishedLibraryDatabase::create();
        let mut published = database.open().await;
        run_local_migrations(&mut published)
            .await
            .expect("create the exact published v0.2.9 migration history");
        seed_v029_scale_library(&mut published).await;
        replace_published_v029_receipts_with_legacy_windows_checksums(&mut published).await;

        let before = published_library_snapshot(&mut published).await;

        assert_eq!(before.projects.row_count, SYNTHETIC_V029_PROJECT_COUNT);
        assert_eq!(before.chapters.row_count, SYNTHETIC_V029_CHAPTER_COUNT);
        assert_eq!(
            before.chapter_versions.row_count,
            SYNTHETIC_V029_VERSION_COUNT
        );
        assert_eq!(before.candidates.row_count, SYNTHETIC_V029_CANDIDATE_COUNT);
        assert_eq!(
            before.chapter_character_count,
            SYNTHETIC_V029_CHAPTER_CHARACTER_COUNT
        );
        assert_eq!(before.chapter_body_sha256.len(), 64);
        assert_eq!(before.migration_receipts.len(), 81);
        published.close().await.expect("close published database");

        let mut upgraded = database.open().await;
        run_local_migrations(&mut upgraded)
            .await
            .expect("accept and upgrade the published v0.2.9 database");
        let after_upgrade = published_library_snapshot(&mut upgraded).await;
        assert_eq!(after_upgrade, before);
        upgraded.close().await.expect("close upgraded database");

        let mut restarted = database.open().await;
        run_local_migrations(&mut restarted)
            .await
            .expect("reopen the upgraded database without rewriting it");
        let after_restart = published_library_snapshot(&mut restarted).await;
        assert_eq!(after_restart, before);
        restarted.close().await.expect("close restarted database");
    }

    #[tokio::test]
    async fn preserves_the_complete_v029_creative_and_trace_chain() {
        let database = PublishedLibraryDatabase::create();
        let mut connection = database.open().await;
        run_local_migrations(&mut connection)
            .await
            .expect("create the published v0.2.9 history");
        seed_v029_scale_library(&mut connection).await;
        let snapshot = published_library_snapshot(&mut connection).await;

        assert_eq!(
            snapshot.protected_tables.len(),
            SYNTHETIC_V029_APPLICATION_TABLE_COUNT
        );
        assert!(
            snapshot.protected_tables.len() >= REQUIRED_V029_CREATIVE_AND_TRACE_TABLES.len(),
            "the full application schema must include every required creative and trace table"
        );
        println!(
            "snapshotted {} application-owned tables",
            snapshot.protected_tables.len()
        );
        for table_name in REQUIRED_V029_CREATIVE_AND_TRACE_TABLES {
            let table = snapshot
                .protected_tables
                .get(*table_name)
                .unwrap_or_else(|| panic!("missing protected snapshot for {table_name}"));
            assert_eq!(table.sha256.len(), 64, "invalid digest for {table_name}");
        }
        for (table_name, expected_count) in [
            ("projects", 14),
            ("project_display_identities", 14),
            ("project_display_identity_revisions", 14),
            ("project_seeds", 14),
            ("story_ideation_drafts", 2),
            ("story_formal_records", 1),
            ("story_review_items", 1),
            ("story_memory_records", 1),
            ("chapters", 19),
            ("chapter_versions", 36),
            ("recovery_drafts", 1),
            ("ai_candidates", 18),
            ("story_planning_candidates", 1),
            ("story_facts", 2),
            ("story_fact_revisions", 2),
            ("creative_journeys", 1),
            ("creative_journey_turns", 1),
            ("background_tasks", 1),
            ("ai_generation_runs", 1),
            ("ai_generation_route_selections", 1),
            ("ai_generation_attempt_usage", 1),
            ("model_invocation_facts", 1),
            ("local_audit_events", 1),
            ("story_settings_import_receipts", 1),
            ("writing_experience_preferences", 1),
            ("writing_preferences", 1),
            ("writing_preference_revisions", 1),
        ] {
            assert_eq!(
                snapshot.protected_tables[table_name].row_count, expected_count,
                "unexpected protected row count for {table_name}"
            );
        }
        let historical_candidates: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ai_candidates WHERE status IN ('rejected', 'expired')",
        )
        .fetch_one(&mut connection)
        .await
        .expect("count retained historical candidates");
        assert_eq!(historical_candidates, 4);
        connection.close().await.expect("close protected fixture");
    }

    #[tokio::test]
    async fn upgrades_the_exact_v023_history_contiguously_and_restarts() {
        const PROJECT_ID: &str = "synthetic-v023-upgrade-project";
        const NOW: &str = "2026-08-20T00:00:00.000Z";

        let database = PublishedLibraryDatabase::create();
        let mut published = database.open().await;
        apply_published_v023_history(&mut published).await;
        sqlx::query(
            "INSERT INTO projects (
               id, name, status, revision, deletion_generation, created_at, updated_at
             ) VALUES (?, 'v0.2.3 连续升级保护', 'active', 1, 0, ?, ?)",
        )
        .bind(PROJECT_ID)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut published)
        .await
        .expect("seed v0.2.3 authority sentinel");
        let published_receipts: Vec<MigrationReceipt> = sqlx::query_as(
            "SELECT version, description, CAST(installed_on AS TEXT), success, checksum,
                    execution_time
             FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&mut published)
        .await
        .expect("read v0.2.3 migration receipts");
        assert_eq!(published_receipts.len(), 67);
        assert!(published_receipts
            .iter()
            .enumerate()
            .all(|(index, receipt)| receipt.0 == index as i64 + 1));
        published.close().await.expect("close v0.2.3 database");

        let mut upgraded = database.open().await;
        run_local_migrations(&mut upgraded)
            .await
            .expect("upgrade v0.2.3 history to the current schema");
        let upgraded_receipts: Vec<MigrationReceipt> = sqlx::query_as(
            "SELECT version, description, CAST(installed_on AS TEXT), success, checksum,
                    execution_time
             FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&mut upgraded)
        .await
        .expect("read upgraded receipts");
        assert_eq!(upgraded_receipts.len(), 81);
        assert_eq!(
            &upgraded_receipts[..published_receipts.len()],
            published_receipts.as_slice()
        );
        let project_name: String = sqlx::query_scalar("SELECT name FROM projects WHERE id = ?")
            .bind(PROJECT_ID)
            .fetch_one(&mut upgraded)
            .await
            .expect("read upgraded v0.2.3 authority sentinel");
        assert_eq!(project_name, "v0.2.3 连续升级保护");
        upgraded.close().await.expect("close upgraded database");

        let mut restarted = database.open().await;
        run_local_migrations(&mut restarted)
            .await
            .expect("restart the continuously upgraded database");
        let restarted_receipts: Vec<MigrationReceipt> = sqlx::query_as(
            "SELECT version, description, CAST(installed_on AS TEXT), success, checksum,
                    execution_time
             FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&mut restarted)
        .await
        .expect("read restarted receipts");
        assert_eq!(restarted_receipts, upgraded_receipts);
        let foreign_key_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&mut restarted)
                .await
                .expect("verify continuously upgraded foreign keys");
        assert_eq!(foreign_key_violations, 0);
        restarted.close().await.expect("close restarted database");
    }

    #[tokio::test]
    async fn rejects_non_whitelisted_history_before_any_forward_write() {
        for case in ["missing", "duplicate", "unknown", "renamed", "dirty"] {
            let mut connection = SqliteConnection::connect("sqlite::memory:")
                .await
                .expect("open sqlite");
            run_local_migrations(&mut connection)
                .await
                .expect("apply published history");
            sqlx::query("CREATE TABLE migration_audit_sentinel (value TEXT NOT NULL)")
                .execute(&mut connection)
                .await
                .expect("create sentinel");
            sqlx::query("INSERT INTO migration_audit_sentinel (value) VALUES ('preserved')")
                .execute(&mut connection)
                .await
                .expect("seed sentinel");

            match case {
                "missing" => {
                    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 40")
                        .execute(&mut connection)
                        .await
                        .expect("remove one receipt");
                }
                "duplicate" => {
                    sqlx::query(
                        "CREATE TABLE duplicated_migration_history AS
                         SELECT version, description, installed_on, success, checksum, execution_time
                         FROM _sqlx_migrations",
                    )
                    .execute(&mut connection)
                    .await
                    .expect("copy migration history without its unique constraint");
                    sqlx::query(
                        "INSERT INTO duplicated_migration_history
                         SELECT version, description, installed_on, success, checksum, execution_time
                         FROM _sqlx_migrations WHERE version = 40",
                    )
                    .execute(&mut connection)
                    .await
                    .expect("duplicate one migration receipt");
                    sqlx::query("DROP TABLE _sqlx_migrations")
                        .execute(&mut connection)
                        .await
                        .expect("replace constrained migration history");
                    sqlx::query(
                        "ALTER TABLE duplicated_migration_history RENAME TO _sqlx_migrations",
                    )
                    .execute(&mut connection)
                    .await
                    .expect("install duplicated history fixture");
                }
                "unknown" => {
                    sqlx::query(
                        "INSERT INTO _sqlx_migrations (
                           version, description, installed_on, success, checksum, execution_time
                         ) VALUES ((SELECT MAX(version) + 1 FROM _sqlx_migrations),
                                   'unknown', CURRENT_TIMESTAMP, 1, x'00', 0)",
                    )
                    .execute(&mut connection)
                    .await
                    .expect("insert unknown receipt");
                }
                "renamed" => {
                    sqlx::query(
                        "UPDATE _sqlx_migrations SET description = 'renamed' WHERE version = 37",
                    )
                    .execute(&mut connection)
                    .await
                    .expect("rename one migration receipt");
                }
                "dirty" => {
                    sqlx::query(
                        "UPDATE _sqlx_migrations SET success = 0
                         WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)",
                    )
                    .execute(&mut connection)
                    .await
                    .expect("mark dirty receipt");
                }
                _ => unreachable!(),
            }

            let error = run_local_migrations(&mut connection)
                .await
                .expect_err("unsafe history must stop before migration execution");
            assert_eq!(error.stage, "migration_history_validation");
            assert!(matches!(
                error.reason_code,
                "MIGRATION_HISTORY_MISSING_VERSION"
                    | "MIGRATION_VERSION_UNKNOWN"
                    | "MIGRATION_VERSION_ORDER_INVALID"
                    | "MIGRATION_VERSION_DUPLICATE"
                    | "MIGRATION_DESCRIPTION_UNKNOWN"
                    | "MIGRATION_HISTORY_DIRTY"
            ));
            let sentinel: String = sqlx::query_scalar("SELECT value FROM migration_audit_sentinel")
                .fetch_one(&mut connection)
                .await
                .expect("read preserved sentinel");
            assert_eq!(sentinel, "preserved");
        }
    }

    #[tokio::test]
    async fn migrates_a_fresh_database_and_reuses_the_existing_history() {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let migrator = local_migrator();

        run_local_migrations(&mut connection)
            .await
            .expect("fresh migration");
        run_local_migrations(&mut connection)
            .await
            .expect("existing migration history");

        let applied: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1")
                .fetch_one(&mut connection)
                .await
                .expect("applied migration count");
        assert_eq!(applied as usize, migrator.iter().count());

        let projects: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'projects'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("core schema");
        assert_eq!(projects, 1);
        let dispatch_leases: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table' AND name = 'project_remote_dispatch_leases'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("native dispatch lease schema");
        assert_eq!(dispatch_leases, 1);
        let project_dispatch_status_guard: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'trigger' AND name = 'project_remote_dispatch_project_status_guard'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("project dispatch lifecycle guard");
        assert_eq!(project_dispatch_status_guard, 1);
        let story_settings_receipts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table' AND name = 'story_settings_import_receipts'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("story settings import receipt schema");
        assert_eq!(story_settings_receipts, 1);
        let generation_cost_status: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('ai_generation_runs')
             WHERE name = 'cost_status'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("generation cost status schema");
        assert_eq!(generation_cost_status, 1);
        let novel_skill_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table'
               AND name IN (
                 'novel_skill_definitions',
                 'project_novel_skill_bindings',
                 'novel_skill_invocation_snapshots',
                 'novel_skill_invocation_items'
               )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("novel skill schema");
        assert_eq!(novel_skill_tables, 4);
        let (novel_skill_migration_succeeded, novel_skill_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 63")
                .fetch_one(&mut connection)
                .await
                .expect("novel skill migration receipt");
        assert_eq!(novel_skill_migration_succeeded, 1);
        assert_eq!(novel_skill_checksum.len(), 48);
        let predispatch_authority_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table'
               AND name = 'novel_skill_evaluation_predispatch_authority_snapshots'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("predispatch authority schema");
        assert_eq!(predispatch_authority_table, 1);
        let predispatch_authority_guards: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'trigger'
               AND name IN (
                 'novel_skill_evaluation_predispatch_authority_insert_guard',
                 'novel_skill_evaluation_predispatch_authority_immutable_update',
                 'novel_skill_evaluation_predispatch_authority_immutable_delete',
                 'novel_skill_evaluation_reservation_authority_bind_guard',
                 'novel_skill_evaluation_reservation_authority_dispatch_guard',
                 'novel_skill_evaluation_reservation_authority_settlement_guard'
               )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("predispatch authority guards");
        assert_eq!(predispatch_authority_guards, 6);
        let (authority_migration_succeeded, authority_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 67")
                .fetch_one(&mut connection)
                .await
                .expect("predispatch authority migration receipt");
        assert_eq!(authority_migration_succeeded, 1);
        assert_eq!(authority_checksum.len(), 48);
        let forbidden_authority_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)
             FROM pragma_table_info('novel_skill_evaluation_predispatch_authority_snapshots')
             WHERE lower(name) IN (
               'prompt_text', 'prompt_body', 'request_body', 'response_text', 'response_body',
               'output_text', 'reasoning_text', 'reasoning_body', 'credential_ref', 'api_key',
               'secret'
             )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("content-free predispatch authority columns");
        assert_eq!(forbidden_authority_columns, 0);

        sqlx::query(
            "INSERT INTO model_provider_connections (
               id, provider_kind, display_name, protocol, base_url, created_at, updated_at
             ) VALUES ('native-zhipu', 'zhipu_glm', 'Zhipu GLM', 'openai_compatible',
                       'https://open.bigmodel.cn/api/paas/v4',
                       '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
        )
        .execute(&mut connection)
        .await
        .expect("persist registered Zhipu provider");
        sqlx::query(
            "INSERT INTO model_catalog_entries (
               id, connection_id, provider_model_id, display_name, catalog_source,
               availability, lifecycle, first_discovered_at, last_seen_at
             ) VALUES ('native-zhipu-model', 'native-zhipu', 'glm-writer', 'GLM writer',
                       'manual', 'available', 'unknown',
                       '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
        )
        .execute(&mut connection)
        .await
        .expect("persist native catalog entry");
        sqlx::query(
            "INSERT INTO model_evaluation_results (
               id, catalog_entry_id, task, score_basis_points, latency_p50_ms,
               sample_count, evaluation_source, evaluation_version, observed_at
             ) VALUES ('native-quality-evaluation', 'native-zhipu-model',
                       'content_quality_check', 5000, 1, 1, 'local_evaluation',
                       'native-v1', '2026-08-08T00:00:00.000Z')",
        )
        .execute(&mut connection)
        .await
        .expect("persist content quality evaluation");
        sqlx::query(
            "INSERT INTO novel_task_routes (
               task, primary_catalog_entry_id, parameter_policy_json, privacy_policy,
               failure_policy, route_origin, created_at, updated_at
             ) VALUES ('content_quality_check', 'native-zhipu-model', '{}',
                       'cloud_allowed', 'ask_user', 'automatic',
                       '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
        )
        .execute(&mut connection)
        .await
        .expect("persist content quality route");
        sqlx::query(
            "INSERT INTO model_invocation_facts (
               id, task, route_task, connection_id, catalog_entry_id,
               provider_kind_snapshot, model_id_snapshot, route_reason, status,
               attempt, privacy_policy, data_destination, created_at
             ) VALUES ('native-quality-invocation', 'content_quality_check',
                       'content_quality_check', 'native-zhipu', 'native-zhipu-model',
                       'zhipu_glm', 'glm-writer', 'task_primary', 'queued', 1,
                       'cloud_allowed', 'remote', '2026-08-08T00:00:00.000Z')",
        )
        .execute(&mut connection)
        .await
        .expect("persist content quality invocation");
        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut connection)
            .await
            .expect("foreign-key enforcement restored");
        assert_eq!(foreign_keys, 1);
    }

    #[tokio::test]
    async fn upgrades_a_populated_version_73_ledger_without_losing_authority() {
        const NOW: &str = "2026-08-20T00:00:00.000Z";
        const PROJECT_ID: &str = "capability-probe-upgrade-project";
        const CONNECTION_ID: &str = "capability-probe-upgrade-connection";
        const CATALOG_ID: &str = "capability-probe-upgrade-catalog";
        const TRACE_ID: &str = "019f9f4a-b3c7-7350-9226-000000000201";
        const INVOCATION_ID: &str = "capability-probe-upgrade-invocation";
        const FALLBACK_INVOCATION_ID: &str = "capability-probe-upgrade-fallback";
        const TASK_ID: &str = "019f9f4a-b3c7-7350-9226-000000000202";
        const RUN_ID: &str = "019f9f4a-b3c7-7350-9226-000000000203";
        const STEP_ID: &str = "019f9f4a-b3c7-7350-9226-000000000204";
        const GENERATION_ID: &str = "019f9f4a-b3c7-7350-9226-000000000205";
        const SCAN_ID: &str = "capability-probe-upgrade-scan";

        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let full = local_migrator();
        let through_version_73 = test_migrator(
            full.iter()
                .filter(|migration| migration.version <= 73)
                .cloned()
                .collect(),
        );

        let before_zhipu = migration_subset(&through_version_73, |migration| {
            migration.version < ZHIPU_GLM_MIGRATION_VERSION
        });
        before_zhipu
            .run_direct(&mut connection)
            .await
            .expect("migrate populated fixture before Zhipu registry");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_version_73,
            ZHIPU_GLM_MIGRATION_VERSION,
            "foreign-key violations remained after test Zhipu migration",
        )
        .await
        .expect("migrate populated fixture through Zhipu registry");
        let before_content_quality = migration_subset(&through_version_73, |migration| {
            migration.version > ZHIPU_GLM_MIGRATION_VERSION
                && migration.version < MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        before_content_quality
            .run_direct(&mut connection)
            .await
            .expect("migrate populated fixture before content-quality task");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_version_73,
            MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION,
            "foreign-key violations remained after test content-quality migration",
        )
        .await
        .expect("migrate populated fixture through content-quality task");
        let after_content_quality = migration_subset(&through_version_73, |migration| {
            migration.version > MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        after_content_quality
            .run_direct(&mut connection)
            .await
            .expect("migrate populated fixture through version 73");

        sqlx::query(
            "INSERT INTO projects (
               id, name, status, revision, deletion_generation, created_at, updated_at
             ) VALUES (?, 'Capability probe upgrade', 'active', 1, 0, ?, ?)",
        )
        .bind(PROJECT_ID)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade project");
        sqlx::query(
            "INSERT INTO model_provider_connections (
               id, provider_kind, display_name, protocol, base_url, created_at, updated_at
             ) VALUES (?, 'custom_openai_compatible', 'Upgrade provider',
                       'openai_compatible', 'https://models.example.test/v1', ?, ?)",
        )
        .bind(CONNECTION_ID)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade provider");
        sqlx::query(
            "INSERT INTO model_catalog_entries (
               id, connection_id, provider_model_id, display_name, catalog_source,
               availability, lifecycle, first_discovered_at, last_seen_at
             ) VALUES (?, ?, 'upgrade-writer', 'Upgrade writer', 'manual',
                       'available', 'stable', ?, ?)",
        )
        .bind(CATALOG_ID)
        .bind(CONNECTION_ID)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade catalog entry");
        sqlx::query(
            "INSERT INTO model_evaluation_results (
               id, catalog_entry_id, task, score_basis_points, latency_p50_ms,
               sample_count, evaluation_source, evaluation_version, observed_at
             ) VALUES ('capability-probe-upgrade-evaluation', ?, 'contradiction_check',
                       7500, 120, 2, 'local_evaluation', 'upgrade-v1', ?)",
        )
        .bind(CATALOG_ID)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade evaluation");
        sqlx::query(
            "INSERT INTO context_compilation_runs (
               id, project_id, chapter_id, task_type, maximum_context_tokens,
               required_tokens, used_tokens, remaining_tokens, discarded_tokens,
               token_estimate_source, candidate_count, included_count, discarded_count,
               created_at
             ) VALUES (?, ?, NULL, 'contradiction_check', 1000, 1, 1, 999, 0,
                       'utf8_conservative', 1, 1, 0, ?)",
        )
        .bind(TRACE_ID)
        .bind(PROJECT_ID)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade context trace");
        sqlx::query(
            "INSERT INTO model_invocation_facts (
               id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
               model_id_snapshot, route_reason, status, attempt, privacy_policy,
               data_destination, input_tokens, output_tokens, started_at,
               completed_at, created_at, finish_reason, visible_content_length,
               reasoning_present, streamed, requested_max_output_tokens,
               provider_dispatch_started_at
             ) VALUES (?, 'contradiction_check', ?, ?, 'custom_openai_compatible',
                       'upgrade-writer', 'user_override', 'succeeded', 1,
                       'cloud_allowed', 'remote', 11, 3, ?, ?, ?, 'stop', 12, 0, 0,
                       128, ?)",
        )
        .bind(INVOCATION_ID)
        .bind(CONNECTION_ID)
        .bind(CATALOG_ID)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist authoritative invocation");
        sqlx::query(
            "INSERT INTO model_invocation_facts (
               id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
               model_id_snapshot, route_reason, status, attempt,
               fallback_from_invocation_id, privacy_policy, data_destination,
               error_code, started_at, completed_at, created_at, failure_stage,
               failure_retryable, http_status, visible_content_length,
               reasoning_present, streamed, requested_max_output_tokens,
               provider_dispatch_started_at
             ) VALUES (?, 'contradiction_check', ?, ?, 'custom_openai_compatible',
                       'upgrade-writer', 'task_fallback', 'failed', 2, ?,
                       'cloud_allowed', 'remote', 'MODEL_PROVIDER_ERROR', ?, ?, ?,
                       'http_response', 0, 503, 0, 0, 0, 128, ?)",
        )
        .bind(FALLBACK_INVOCATION_ID)
        .bind(CONNECTION_ID)
        .bind(CATALOG_ID)
        .bind(INVOCATION_ID)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist fallback invocation");
        sqlx::query(
            "INSERT INTO context_compilation_execution_links (
               trace_id, generation_id, generation_run_id, created_at
             ) VALUES (?, ?, NULL, ?)",
        )
        .bind(TRACE_ID)
        .bind(GENERATION_ID)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade execution link");
        sqlx::query(
            "INSERT INTO context_compilation_model_invocation_links (
               trace_id, model_invocation_id, linked_at
             ) VALUES (?, ?, ?)",
        )
        .bind(TRACE_ID)
        .bind(INVOCATION_ID)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade invocation link");
        sqlx::query(
            "INSERT INTO background_tasks (
               id, task_type, idempotency_key, metadata_json, priority, status,
               attempt, max_attempts, sequence, run_after, created_at, updated_at,
               started_at, finished_at
             ) VALUES (?, 'consistency_investigation', 'upgrade.consistency.0001', ?,
                       50, 'succeeded', 1, 1, 1, NULL, ?, ?, ?, ?)",
        )
        .bind(TASK_ID)
        .bind(format!(
            "{{\"operation\":\"long_form_consistency_investigation\",\"projectId\":\"{PROJECT_ID}\"}}"
        ))
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade background task");
        sqlx::query(
            "INSERT INTO consistency_investigation_runs (
               id, task_id, project_id, restart_of_run_id, idempotency_key,
               request_fingerprint, status, chapter_count, maximum_model_calls,
               maximum_tool_steps, maximum_context_characters, maximum_output_tokens,
               maximum_duration_ms, automatic_retry_count, estimated_input_tokens,
               estimated_maximum_cost_micros, currency, connection_id, catalog_entry_id,
               provider_kind_snapshot, model_id_snapshot, privacy_fingerprint,
               context_trace_id, generation_id, summary, finding_count,
               dropped_finding_count, cancellation_requested, failure_code, revision,
               created_at, updated_at, completed_at
             ) VALUES (?, ?, ?, NULL, 'upgrade.consistency.0001', ?, 'succeeded',
                       1, 1, 5, 1000, 128, 1000, 0, 10, NULL, NULL, ?, ?,
                       'custom_openai_compatible', 'upgrade-writer', ?, ?, ?,
                       'Upgrade consistency result', 0, 0, 0, NULL, 1, ?, ?, ?)",
        )
        .bind(RUN_ID)
        .bind(TASK_ID)
        .bind(PROJECT_ID)
        .bind("a".repeat(64))
        .bind(CONNECTION_ID)
        .bind(CATALOG_ID)
        .bind("b".repeat(64))
        .bind(TRACE_ID)
        .bind(GENERATION_ID)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade consistency run");
        sqlx::query(
            "INSERT INTO consistency_investigation_steps (
               id, run_id, ordinal, step_kind, tool_name, tool_version, permission,
               input_digest, status, invocation_id, observation_digest,
               terminal_cause, created_at, updated_at, completed_at
             ) VALUES (?, ?, 1, 'model', 'model_synthesis', '1', 'model_dispatch',
                       ?, 'succeeded', ?, ?, 'UPGRADE_TEST_COMPLETED', ?, ?, ?)",
        )
        .bind(STEP_ID)
        .bind(RUN_ID)
        .bind("c".repeat(64))
        .bind(INVOCATION_ID)
        .bind("d".repeat(64))
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade consistency step");
        sqlx::query(
            "INSERT INTO model_capability_scans (
               id, catalog_entry_id, scan_kind, status, evidence_version,
               supported_count, requested_at, started_at, completed_at,
               visible_content_length, reasoning_present, streamed, attempt,
               requested_max_output_tokens
             ) VALUES (?, ?, 'lightweight_probe', 'succeeded', 'upgrade-probe-v1',
                       1, ?, ?, ?, 2, 0, 0, 1, 8)",
        )
        .bind(SCAN_ID)
        .bind(CATALOG_ID)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade capability scan");
        sqlx::query(
            "INSERT INTO model_capability_evidence (
               id, catalog_entry_id, scan_id, capability, verdict, evidence_source,
               evidence_version, evidence_summary, observed_at
             ) VALUES ('capability-probe-upgrade-evidence', ?, ?, 'text_generation',
                       'supported', 'lightweight_probe', 'upgrade-probe-v1',
                       'content-free upgrade fixture', ?)",
        )
        .bind(CATALOG_ID)
        .bind(SCAN_ID)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist upgrade capability evidence");

        run_foreign_key_disabled_migration(
            &mut connection,
            &full,
            MODEL_CAPABILITY_PROBE_LEDGER_MIGRATION_VERSION,
            "foreign-key violations remained after populated capability probe migration",
        )
        .await
        .expect("upgrade populated version 73 ledger");

        let preserved_invocations: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM model_invocation_facts
             WHERE id IN (?, ?) AND task = 'contradiction_check'",
        )
        .bind(INVOCATION_ID)
        .bind(FALLBACK_INVOCATION_ID)
        .fetch_one(&mut connection)
        .await
        .expect("preserved invocations");
        assert_eq!(preserved_invocations, 2);
        let preserved_fallback: Option<String> = sqlx::query_scalar(
            "SELECT fallback_from_invocation_id FROM model_invocation_facts WHERE id = ?",
        )
        .bind(FALLBACK_INVOCATION_ID)
        .fetch_one(&mut connection)
        .await
        .expect("preserved fallback link");
        assert_eq!(preserved_fallback.as_deref(), Some(INVOCATION_ID));
        let preserved_trace_link: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM context_compilation_model_invocation_links
             WHERE trace_id = ? AND model_invocation_id = ?",
        )
        .bind(TRACE_ID)
        .bind(INVOCATION_ID)
        .fetch_one(&mut connection)
        .await
        .expect("preserved context invocation link");
        assert_eq!(preserved_trace_link, 1);
        let preserved_evaluation: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM model_evaluation_results
             WHERE id = 'capability-probe-upgrade-evaluation' AND catalog_entry_id = ?",
        )
        .bind(CATALOG_ID)
        .fetch_one(&mut connection)
        .await
        .expect("preserved model evaluation");
        assert_eq!(preserved_evaluation, 1);
        let preserved_consistency_step: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM consistency_investigation_steps
             WHERE id = ? AND invocation_id = ? AND status = 'succeeded'",
        )
        .bind(STEP_ID)
        .bind(INVOCATION_ID)
        .fetch_one(&mut connection)
        .await
        .expect("preserved consistency step");
        assert_eq!(preserved_consistency_step, 1);
        let preserved_probe_evidence: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)
             FROM model_capability_scans AS scan
             INNER JOIN model_capability_evidence AS evidence ON evidence.scan_id = scan.id
             WHERE scan.id = ? AND scan.model_invocation_id IS NULL",
        )
        .bind(SCAN_ID)
        .fetch_one(&mut connection)
        .await
        .expect("preserved unlinked historical capability evidence");
        assert_eq!(preserved_probe_evidence, 1);

        let invocation_indexes: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'index' AND name IN (
               'model_invocation_facts_task_idx',
               'model_invocation_facts_connection_idx',
               'model_invocation_facts_fallback_idx',
               'model_invocation_facts_recent_failure_idx'
             )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("preserved 0031 and 0056 invocation indexes");
        assert_eq!(invocation_indexes, 4);
        let invocation_authority_triggers: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'trigger' AND name IN (
               'novel_skill_invocation_exact_trace_guard',
               'novel_skill_evaluation_attempt_revision_guard',
               'novel_skill_evaluation_observation_trace_guard',
               'novel_skill_evaluation_invocation_update_guard',
               'novel_skill_evaluation_reservation_revision_guard',
               'novel_skill_evaluation_settlement_evidence_guard',
               'novel_skill_paid_settled_invocation_update_guard',
               'novel_skill_paid_settled_invocation_delete_guard',
               'consistency_investigation_step_model_guard',
               'consistency_investigation_step_model_update_guard',
               'consistency_investigation_invocation_start_guard',
               'consistency_investigation_invocation_bind_after_start'
             )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("preserved invocation authority triggers");
        assert_eq!(invocation_authority_triggers, 12);
        let self_reference: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('model_invocation_facts')
             WHERE \"from\" = 'fallback_from_invocation_id'
               AND \"table\" = 'model_invocation_facts'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("preserved invocation self reference");
        assert_eq!(self_reference, 1);
        let foreign_key_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&mut connection)
                .await
                .expect("populated version 74 foreign-key check");
        assert_eq!(foreign_key_violations, 0);

        sqlx::query(
            "INSERT INTO model_invocation_facts (
               id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
               model_id_snapshot, route_reason, status, attempt, privacy_policy,
               data_destination, started_at, created_at,
               requested_max_output_tokens, provider_dispatch_started_at
             ) VALUES ('capability-probe-upgrade-running-invocation', 'capability_probe',
                       ?, ?, 'custom_openai_compatible', 'upgrade-writer',
                       'user_override', 'running', 1, 'cloud_allowed', 'remote',
                       ?, ?, 8, ?)",
        )
        .bind(CONNECTION_ID)
        .bind(CATALOG_ID)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist interrupted capability probe after upgrade");
        let premature_scan = sqlx::query(
            "INSERT INTO model_capability_scans (
               id, catalog_entry_id, scan_kind, status, evidence_version,
               error_code, requested_at, started_at, completed_at,
               attempt, requested_max_output_tokens, model_invocation_id
             ) VALUES ('capability-probe-upgrade-premature-scan', ?,
                       'lightweight_probe', 'failed', 'upgrade-probe-v2',
                       'PROVIDER_RESULT_AMBIGUOUS', ?, ?, ?, 1, 8,
                       'capability-probe-upgrade-running-invocation')",
        )
        .bind(CATALOG_ID)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await;
        assert!(
            premature_scan.is_err(),
            "a scan must not link to a running capability invocation"
        );

        sqlx::query(
            "UPDATE model_invocation_facts
             SET status = 'timed_out', completed_at = ?,
                 error_code = 'PROVIDER_RESULT_AMBIGUOUS'
             WHERE id = 'capability-probe-upgrade-running-invocation'",
        )
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("terminalize uncertain capability probe after upgrade");
        let ambiguous_scan = sqlx::query(
            "INSERT INTO model_capability_scans (
               id, catalog_entry_id, scan_kind, status, evidence_version,
               error_code, requested_at, started_at, completed_at,
               attempt, requested_max_output_tokens, model_invocation_id
             ) VALUES ('capability-probe-upgrade-ambiguous-scan', ?,
                       'lightweight_probe', 'failed', 'upgrade-probe-v2',
                       'PROVIDER_RESULT_AMBIGUOUS', ?, ?, ?, 1, 8,
                       'capability-probe-upgrade-running-invocation')",
        )
        .bind(CATALOG_ID)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await;
        assert!(
            ambiguous_scan.is_err(),
            "an uncertain timed-out invocation must never become a failed capability scan"
        );

        sqlx::query(
            "INSERT INTO model_invocation_facts (
               id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
               model_id_snapshot, route_reason, status, attempt, privacy_policy,
               data_destination, started_at, completed_at, created_at,
               visible_content_length, reasoning_present, streamed,
               requested_max_output_tokens, provider_dispatch_started_at
             ) VALUES ('capability-probe-upgrade-new-invocation', 'capability_probe',
                       ?, ?, 'custom_openai_compatible', 'upgrade-writer',
                       'user_override', 'succeeded', 1, 'cloud_allowed', 'remote',
                       ?, ?, ?, 2, 0, 0, 8, ?)",
        )
        .bind(CONNECTION_ID)
        .bind(CATALOG_ID)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("persist capability probe invocation after upgrade");
        sqlx::query(
            "INSERT INTO model_capability_scans (
               id, catalog_entry_id, scan_kind, status, evidence_version,
               supported_count, requested_at, started_at, completed_at,
               visible_content_length, reasoning_present, streamed, attempt,
               requested_max_output_tokens, model_invocation_id
             ) VALUES ('capability-probe-upgrade-new-scan', ?, 'lightweight_probe',
                       'succeeded', 'upgrade-probe-v2', 1, ?, ?, ?, 2, 0, 0, 1, 8,
                       'capability-probe-upgrade-new-invocation')",
        )
        .bind(CATALOG_ID)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .execute(&mut connection)
        .await
        .expect("link capability evidence to its exact invocation after upgrade");
        let exact_probe_links: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM model_capability_scans AS scan
             INNER JOIN model_invocation_facts AS invocation
               ON invocation.id = scan.model_invocation_id
             WHERE invocation.task = 'capability_probe' AND scan.catalog_entry_id = ?",
        )
        .bind(CATALOG_ID)
        .fetch_one(&mut connection)
        .await
        .expect("exact capability probe invocation link");
        assert_eq!(exact_probe_links, 1);
    }

    #[tokio::test]
    async fn upgrades_a_version_62_database_to_the_novel_skill_registry_and_restarts() {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let full = local_migrator();
        let through_generation_cost_status = test_migrator(
            full.iter()
                .filter(|migration| migration.version <= 62)
                .cloned()
                .collect(),
        );
        let before_zhipu = migration_subset(&through_generation_cost_status, |migration| {
            migration.version < ZHIPU_GLM_MIGRATION_VERSION
        });
        before_zhipu
            .run_direct(&mut connection)
            .await
            .expect("migrate before Zhipu provider registry");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_generation_cost_status,
            ZHIPU_GLM_MIGRATION_VERSION,
            "foreign-key violations remained after test Zhipu migration",
        )
        .await
        .expect("migrate Zhipu provider registry");
        let before_content_quality =
            migration_subset(&through_generation_cost_status, |migration| {
                migration.version > ZHIPU_GLM_MIGRATION_VERSION
                    && migration.version < MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
            });
        before_content_quality
            .run_direct(&mut connection)
            .await
            .expect("migrate before Model Hub content quality task");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_generation_cost_status,
            MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION,
            "foreign-key violations remained after test Model Hub task migration",
        )
        .await
        .expect("migrate Model Hub content quality task");
        let through_version_62 = migration_subset(&through_generation_cost_status, |migration| {
            migration.version > MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        through_version_62
            .run_direct(&mut connection)
            .await
            .expect("migrate through version 62");

        sqlx::query(
            "INSERT INTO projects (
               id, name, status, revision, deletion_generation, created_at, updated_at
             ) VALUES (
               'native-skill-project', 'Novel skill migration', 'active', 1, 0,
               '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
             )",
        )
        .execute(&mut connection)
        .await
        .expect("insert pre-migration project");

        run_local_migrations(&mut connection)
            .await
            .expect("upgrade through version 63");
        run_local_migrations(&mut connection)
            .await
            .expect("reuse version 63 migration history");

        sqlx::query(
            "INSERT INTO novel_skill_definitions (
               skill_id, version, display_name, summary, kind, owner_scope, status,
               default_enabled, precedence, task_types_json, activation_json,
               context_requirements_json, instructions_json, output_contract_json,
               validation_json, definition_hash, created_at
             ) VALUES (
               'core.native_test', '1.0.0', 'Native test', 'Native migration fixture.',
               'core', 'builtin', 'experimental', 0, 500, '[\"continuation\"]',
               '{}', '{}', '{}', '{}', '{}', ?, '2026-08-10T00:00:00.000Z'
             )",
        )
        .bind("a".repeat(64))
        .execute(&mut connection)
        .await
        .expect("insert immutable skill definition");
        sqlx::query(
            "INSERT INTO project_novel_skill_bindings (
               project_id, skill_id, pinned_version, enabled, activation_mode,
               task_overrides_json, revision, created_at, updated_at
             ) VALUES (
               'native-skill-project', 'core.native_test', '1.0.0', 1, 'manual',
               '{}', 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
             )",
        )
        .execute(&mut connection)
        .await
        .expect("bind migrated skill to active project");

        let project_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE id = 'native-skill-project'")
                .fetch_one(&mut connection)
                .await
                .expect("pre-migration project retained");
        assert_eq!(project_count, 1);
        let binding_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM project_novel_skill_bindings
             WHERE project_id = 'native-skill-project'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("novel skill binding retained");
        assert_eq!(binding_count, 1);
        let foreign_key_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&mut connection)
                .await
                .expect("foreign-key check");
        assert_eq!(foreign_key_violations, 0);
    }

    #[tokio::test]
    async fn upgrades_a_version_63_database_to_the_novel_skill_evaluation_ledger_and_restarts() {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let full = local_migrator();
        let through_registry = test_migrator(
            full.iter()
                .filter(|migration| migration.version <= 63)
                .cloned()
                .collect(),
        );
        let before_zhipu = migration_subset(&through_registry, |migration| {
            migration.version < ZHIPU_GLM_MIGRATION_VERSION
        });
        before_zhipu
            .run_direct(&mut connection)
            .await
            .expect("migrate before Zhipu registry");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_registry,
            ZHIPU_GLM_MIGRATION_VERSION,
            "foreign-key violations remained after test Zhipu migration",
        )
        .await
        .expect("migrate Zhipu registry");
        let before_content_quality = migration_subset(&through_registry, |migration| {
            migration.version > ZHIPU_GLM_MIGRATION_VERSION
                && migration.version < MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        before_content_quality
            .run_direct(&mut connection)
            .await
            .expect("migrate before content quality task");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_registry,
            MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION,
            "foreign-key violations remained after test content quality migration",
        )
        .await
        .expect("migrate content quality task");
        let after_content_quality = migration_subset(&through_registry, |migration| {
            migration.version > MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        after_content_quality
            .run_direct(&mut connection)
            .await
            .expect("migrate through published registry");
        let registry_receipt: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 63 AND success = 1",
        )
        .fetch_one(&mut connection)
        .await
        .expect("registry receipt");
        assert_eq!(registry_receipt, 1);

        run_local_migrations(&mut connection)
            .await
            .expect("upgrade version 63 database through evaluation ledger");
        run_local_migrations(&mut connection)
            .await
            .expect("restart with evaluation ledger history");
        let evaluation_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (
              'novel_skill_evaluation_suites', 'novel_skill_evaluation_fixtures',
              'novel_skill_evaluation_runs', 'novel_skill_evaluation_cells',
              'novel_skill_evaluation_attempts',
              'novel_skill_evaluation_observations', 'novel_skill_evaluation_scores',
              'novel_skill_evaluation_manual_decisions'
            )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("evaluation ledger tables");
        assert_eq!(evaluation_tables, 8);
        let evaluation_receipt: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 64 AND success = 1",
        )
        .fetch_one(&mut connection)
        .await
        .expect("evaluation receipt");
        assert_eq!(evaluation_receipt, 1);
        let foreign_key_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&mut connection)
                .await
                .expect("foreign-key check");
        assert_eq!(foreign_key_violations, 0);
    }

    #[tokio::test]
    async fn upgrades_a_version_64_database_to_the_project_dispatch_active_guard_and_restarts() {
        const PROJECT_ID: &str = "019f9f4a-b3c7-7350-9226-000000000065";
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let full = local_migrator();
        let through_evaluation = test_migrator(
            full.iter()
                .filter(|migration| migration.version <= 64)
                .cloned()
                .collect(),
        );
        let before_zhipu = migration_subset(&through_evaluation, |migration| {
            migration.version < ZHIPU_GLM_MIGRATION_VERSION
        });
        before_zhipu
            .run_direct(&mut connection)
            .await
            .expect("migrate before Zhipu registry");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_evaluation,
            ZHIPU_GLM_MIGRATION_VERSION,
            "foreign-key violations remained after test Zhipu migration",
        )
        .await
        .expect("migrate Zhipu registry");
        let before_content_quality = migration_subset(&through_evaluation, |migration| {
            migration.version > ZHIPU_GLM_MIGRATION_VERSION
                && migration.version < MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        before_content_quality
            .run_direct(&mut connection)
            .await
            .expect("migrate before content quality task");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_evaluation,
            MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION,
            "foreign-key violations remained after test content quality migration",
        )
        .await
        .expect("migrate content quality task");
        let after_content_quality = migration_subset(&through_evaluation, |migration| {
            migration.version > MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        after_content_quality
            .run_direct(&mut connection)
            .await
            .expect("migrate through version 64");

        sqlx::query(
            "INSERT INTO projects (id, name, status, revision, deletion_generation, created_at, updated_at)
             VALUES (?, 'Dispatch guard upgrade', 'active', 1, 0,
                     '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')",
        )
        .bind(PROJECT_ID)
        .execute(&mut connection)
        .await
        .expect("seed active project before version 65");
        sqlx::query(
            "INSERT INTO project_remote_dispatch_leases (
               lease_id, project_id, operation_kind, operation_id, owner_runtime_id,
               authority_fingerprint, acquired_at, network_deadline_at
             ) VALUES (
               '019f9f4a-b3c7-7350-9226-000000000066', ?, 'generation',
               'migration-65-dispatch', 'migration-65-runtime', ?,
               '2026-08-10T00:00:00.000Z', '2026-08-10T00:12:00.000Z'
             )",
        )
        .bind(PROJECT_ID)
        .bind("a".repeat(64))
        .execute(&mut connection)
        .await
        .expect("seed active dispatch lease before version 65");

        run_local_migrations(&mut connection)
            .await
            .expect("upgrade version 64 database through project lifecycle guard");
        let blocked = sqlx::query(
            "UPDATE projects
             SET status = 'archived', archived_at = '2026-08-10T00:01:00.000Z'
             WHERE id = ?",
        )
        .bind(PROJECT_ID)
        .execute(&mut connection)
        .await
        .expect_err("version 65 guard blocks archive while dispatch is live");
        assert!(blocked
            .as_database_error()
            .is_some_and(|error| error.message().contains("INKSHADOW_REMOTE_DISPATCH_ACTIVE")));
        sqlx::query("DELETE FROM project_remote_dispatch_leases WHERE project_id = ?")
            .bind(PROJECT_ID)
            .execute(&mut connection)
            .await
            .expect("release migration fixture lease");
        sqlx::query(
            "UPDATE projects
             SET status = 'archived', archived_at = '2026-08-10T00:01:00.000Z'
             WHERE id = ?",
        )
        .bind(PROJECT_ID)
        .execute(&mut connection)
        .await
        .expect("archive succeeds after lease release");
        run_local_migrations(&mut connection)
            .await
            .expect("restart with version 65 migration history");
        let guard_receipt: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 65 AND success = 1",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 65 migration receipt");
        assert_eq!(guard_receipt, 1);
    }

    #[tokio::test]
    async fn upgrades_a_version_65_database_to_paid_novel_skill_evaluation_authority_and_restarts()
    {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let full = local_migrator();
        let through_dispatch_guard = test_migrator(
            full.iter()
                .filter(|migration| migration.version <= 65)
                .cloned()
                .collect(),
        );
        let before_zhipu = migration_subset(&through_dispatch_guard, |migration| {
            migration.version < ZHIPU_GLM_MIGRATION_VERSION
        });
        before_zhipu
            .run_direct(&mut connection)
            .await
            .expect("migrate before Zhipu registry");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_dispatch_guard,
            ZHIPU_GLM_MIGRATION_VERSION,
            "foreign-key violations remained after test Zhipu migration",
        )
        .await
        .expect("migrate Zhipu registry");
        let before_content_quality = migration_subset(&through_dispatch_guard, |migration| {
            migration.version > ZHIPU_GLM_MIGRATION_VERSION
                && migration.version < MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        before_content_quality
            .run_direct(&mut connection)
            .await
            .expect("migrate before content quality task");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_dispatch_guard,
            MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION,
            "foreign-key violations remained after test content quality migration",
        )
        .await
        .expect("migrate content quality task");
        let through_version_65 = migration_subset(&through_dispatch_guard, |migration| {
            migration.version > MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        through_version_65
            .run_direct(&mut connection)
            .await
            .expect("migrate through version 65");

        run_local_migrations(&mut connection)
            .await
            .expect("upgrade version 65 database through paid evaluation authority");
        run_local_migrations(&mut connection)
            .await
            .expect("restart with version 66 migration history");

        let authority_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (
              'novel_skill_evaluation_protocols',
              'novel_skill_evaluation_request_profiles',
              'novel_skill_evaluation_context_baselines',
              'novel_skill_evaluation_run_model_targets',
              'novel_skill_evaluation_dispatch_authorizations',
              'novel_skill_evaluation_authorization_limits',
              'novel_skill_evaluation_dispatch_reservations',
              'novel_skill_evaluation_review_batches',
              'novel_skill_evaluation_review_items',
              'novel_skill_evaluation_review_receipts'
            )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("paid evaluation authority tables");
        assert_eq!(authority_tables, 10);
        let migration_receipt: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 66 AND success = 1",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 66 migration receipt");
        assert_eq!(migration_receipt, 1);
        let foreign_key_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&mut connection)
                .await
                .expect("foreign-key check");
        assert_eq!(foreign_key_violations, 0);
    }

    #[tokio::test]
    async fn upgrades_a_version_66_database_to_content_free_predispatch_authority_and_restarts() {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let full = local_migrator();
        let through_paid_authority = test_migrator(
            full.iter()
                .filter(|migration| migration.version <= 66)
                .cloned()
                .collect(),
        );
        let before_zhipu = migration_subset(&through_paid_authority, |migration| {
            migration.version < ZHIPU_GLM_MIGRATION_VERSION
        });
        before_zhipu
            .run_direct(&mut connection)
            .await
            .expect("migrate before Zhipu registry");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_paid_authority,
            ZHIPU_GLM_MIGRATION_VERSION,
            "foreign-key violations remained after test Zhipu migration",
        )
        .await
        .expect("migrate Zhipu registry");
        let before_content_quality = migration_subset(&through_paid_authority, |migration| {
            migration.version > ZHIPU_GLM_MIGRATION_VERSION
                && migration.version < MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        before_content_quality
            .run_direct(&mut connection)
            .await
            .expect("migrate before content quality task");
        run_foreign_key_disabled_migration(
            &mut connection,
            &through_paid_authority,
            MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION,
            "foreign-key violations remained after test content quality migration",
        )
        .await
        .expect("migrate content quality task");
        let through_version_66 = migration_subset(&through_paid_authority, |migration| {
            migration.version > MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
        });
        through_version_66
            .run_direct(&mut connection)
            .await
            .expect("migrate through version 66");

        let authority_before_upgrade: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table'
               AND name = 'novel_skill_evaluation_predispatch_authority_snapshots'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 66 predispatch authority absence");
        assert_eq!(authority_before_upgrade, 0);

        run_local_migrations(&mut connection)
            .await
            .expect("upgrade version 66 database through predispatch authority");
        run_local_migrations(&mut connection)
            .await
            .expect("restart with version 73 migration history");

        let authority_after_upgrade: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table'
               AND name = 'novel_skill_evaluation_predispatch_authority_snapshots'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 67 predispatch authority schema");
        assert_eq!(authority_after_upgrade, 1);
        let authority_guards: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'trigger'
               AND name IN (
                 'novel_skill_evaluation_predispatch_authority_insert_guard',
                 'novel_skill_evaluation_predispatch_authority_immutable_update',
                 'novel_skill_evaluation_predispatch_authority_immutable_delete',
                 'novel_skill_evaluation_reservation_authority_bind_guard',
                 'novel_skill_evaluation_reservation_authority_dispatch_guard',
                 'novel_skill_evaluation_reservation_authority_settlement_guard'
               )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 67 authority guards");
        assert_eq!(authority_guards, 6);
        let (success, checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 67")
                .fetch_one(&mut connection)
                .await
                .expect("version 67 migration receipt");
        assert_eq!(success, 1);
        assert_eq!(checksum.len(), 48);
        let (dispatch_success, dispatch_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 68")
                .fetch_one(&mut connection)
                .await
                .expect("version 68 migration receipt");
        assert_eq!(dispatch_success, 1);
        assert_eq!(dispatch_checksum.len(), 48);
        let dispatch_boundary_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('model_invocation_facts')
             WHERE name = 'provider_dispatch_started_at'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 68 provider dispatch boundary column");
        assert_eq!(dispatch_boundary_columns, 1);
        let (writing_success, writing_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 69")
                .fetch_one(&mut connection)
                .await
                .expect("version 69 writing experience migration receipt");
        assert_eq!(writing_success, 1);
        assert_eq!(writing_checksum.len(), 48);
        let writing_authority_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table'
               AND name IN (
                 'writing_experience_preferences',
                 'writing_provider_disclosure_grants'
               )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 69 writing experience authority tables");
        assert_eq!(writing_authority_tables, 2);
        let (investigation_success, investigation_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 70")
                .fetch_one(&mut connection)
                .await
                .expect("version 70 consistency investigation migration receipt");
        assert_eq!(investigation_success, 1);
        assert_eq!(investigation_checksum.len(), 48);
        let investigation_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table'
               AND name IN (
                 'consistency_investigation_runs',
                 'consistency_investigation_steps',
                 'consistency_investigation_findings',
                 'consistency_investigation_evidence'
               )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 70 consistency investigation authority tables");
        assert_eq!(investigation_tables, 4);
        let (writing_rotation_success, writing_rotation_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 71")
                .fetch_one(&mut connection)
                .await
                .expect("version 71 writing disclosure rotation migration receipt");
        assert_eq!(writing_rotation_success, 1);
        assert_eq!(writing_rotation_checksum.len(), 48);
        let active_limit_trigger: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_schema
             WHERE type = 'trigger'
               AND name = 'writing_provider_disclosure_grants_limit'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 71 active disclosure limit trigger");
        assert!(active_limit_trigger.contains("WHERE state = 'active'"));
        let (investigation_reservation_success, investigation_reservation_checksum): (
            i64,
            Vec<u8>,
        ) = sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 72")
            .fetch_one(&mut connection)
            .await
            .expect("version 72 consistency invocation reservation migration receipt");
        assert_eq!(investigation_reservation_success, 1);
        assert_eq!(investigation_reservation_checksum.len(), 48);
        let planned_invocation_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('consistency_investigation_steps')
             WHERE name = 'planned_invocation_id'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 72 planned invocation column");
        assert_eq!(planned_invocation_columns, 1);
        let (search_scope_success, search_scope_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 73")
                .fetch_one(&mut connection)
                .await
                .expect("version 73 multigranular search migration receipt");
        assert_eq!(search_scope_success, 1);
        assert_eq!(search_scope_checksum.len(), 48);
        let search_scope_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('search_index_documents')
             WHERE name IN (
               'chunk_kind', 'parent_document_id', 'utf16_start', 'utf16_end',
               'source_length', 'scene_id', 'event_id', 'character_ids_json',
               'location_ids_json', 'story_time',
               'branch_id', 'pov_character_id', 'story_order', 'authority',
               'privacy', 'currentness', 'omitted_scope_fields_json'
             )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 73 multigranular search columns");
        assert_eq!(search_scope_columns, 17);
        let (probe_ledger_success, probe_ledger_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 74")
                .fetch_one(&mut connection)
                .await
                .expect("version 74 capability probe ledger migration receipt");
        assert_eq!(probe_ledger_success, 1);
        assert_eq!(probe_ledger_checksum.len(), 48);
        let probe_ledger_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('model_capability_scans')
             WHERE name = 'model_invocation_id'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 74 capability probe invocation link");
        assert_eq!(probe_ledger_columns, 1);
        let (story_fact_revision_success, story_fact_revision_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 76")
                .fetch_one(&mut connection)
                .await
                .expect("version 76 story fact user revision migration receipt");
        assert_eq!(story_fact_revision_success, 1);
        assert_eq!(story_fact_revision_checksum.len(), 48);
        let story_fact_revision_guards: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'trigger'
               AND name IN (
                 'story_fact_user_content_revision_guard',
                 'story_fact_governance_transition_guard'
               )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 76 story fact user revision guards");
        assert_eq!(story_fact_revision_guards, 2);

        let (responsibility_success, responsibility_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 77")
                .fetch_one(&mut connection)
                .await
                .expect("version 77 chapter responsibility migration receipt");
        assert_eq!(responsibility_success, 1);
        assert_eq!(responsibility_checksum.len(), 48);
        let responsibility_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('chapter_versions')
             WHERE name = 'organize_local_story_facts'
               AND type = 'INTEGER'
               AND \"notnull\" = 1
               AND dflt_value = '0'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 77 chapter responsibility column");
        assert_eq!(responsibility_columns, 1);
        let responsibility_guards: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'trigger'
               AND name = 'chapter_version_story_fact_responsibility_immutable'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 77 chapter responsibility guard");
        assert_eq!(responsibility_guards, 1);

        let (privacy_success, privacy_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 78")
                .fetch_one(&mut connection)
                .await
                .expect("version 78 generation attempt privacy snapshot migration receipt");
        assert_eq!(privacy_success, 1);
        assert_eq!(privacy_checksum.len(), 48);
        let privacy_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('ai_generation_attempt_usage')
             WHERE name IN (
               'privacy_snapshot_version', 'privacy_policy', 'data_destination',
               'model_invocation_id'
             )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 78 generation attempt privacy columns");
        assert_eq!(privacy_columns, 4);
        let privacy_guards: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'trigger'
               AND name IN (
                 'ai_generation_attempt_usage_privacy_insert_guard',
                 'ai_generation_attempt_usage_privacy_immutable'
               )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 78 generation attempt privacy guards");
        assert_eq!(privacy_guards, 2);
        let (direct_revision_success, direct_revision_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 79")
                .fetch_one(&mut connection)
                .await
                .expect("version 79 direct-local author revision migration receipt");
        assert_eq!(direct_revision_success, 1);
        assert_eq!(direct_revision_checksum.len(), 48);
        let direct_revision_guards: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'trigger'
               AND name IN (
                 'story_fact_entity_alias_resolution_guard',
                 'story_fact_user_content_revision_guard'
               )
               AND instr(
                 sql,
                 'direct-local:inkshadow.direct-local-story-fact.v1:'
               ) > 0",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 79 direct-local author revision guards");
        assert_eq!(direct_revision_guards, 2);

        let (display_identity_success, display_identity_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 80")
                .fetch_one(&mut connection)
                .await
                .expect("version 80 project display identity migration receipt");
        assert_eq!(display_identity_success, 1);
        assert_eq!(display_identity_checksum.len(), 48);
        let display_identity_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table'
               AND name IN (
                 'project_display_identities',
                 'project_display_identity_revisions'
               )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 80 project display identity tables");
        assert_eq!(display_identity_tables, 2);
        let (prose_invocation_success, prose_invocation_checksum): (i64, Vec<u8>) =
            sqlx::query_as("SELECT success, checksum FROM _sqlx_migrations WHERE version = 81")
                .fetch_one(&mut connection)
                .await
                .expect("version 81 prose invocation privacy migration receipt");
        assert_eq!(prose_invocation_success, 1);
        assert_eq!(prose_invocation_checksum.len(), 48);
        let prose_invocation_guard: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'trigger'
               AND name = 'ai_generation_attempt_usage_privacy_insert_guard'
               AND instr(sql, '''prose_generation''') > 0",
        )
        .fetch_one(&mut connection)
        .await
        .expect("version 81 prose invocation privacy guard");
        assert_eq!(prose_invocation_guard, 1);

        let maximum_version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(&mut connection)
            .await
            .expect("maximum migration version");
        assert_eq!(maximum_version, 81);
        let forbidden_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)
             FROM pragma_table_info('novel_skill_evaluation_predispatch_authority_snapshots')
             WHERE lower(name) IN (
               'prompt_text', 'prompt_body', 'request_body', 'response_text', 'response_body',
               'output_text', 'reasoning_text', 'reasoning_body', 'credential_ref', 'api_key',
               'secret'
             )",
        )
        .fetch_one(&mut connection)
        .await
        .expect("content-free version 67 columns");
        assert_eq!(forbidden_columns, 0);
        let foreign_key_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&mut connection)
                .await
                .expect("version 67 foreign-key check");
        assert_eq!(foreign_key_violations, 0);
    }

    #[tokio::test]
    async fn upgrades_an_existing_validation_snapshot_chain_and_cascades_project_delete() {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let full = local_migrator();
        let before_repair = test_migrator(
            full.iter()
                .filter(|migration| migration.version <= 44)
                .cloned()
                .collect(),
        );
        before_repair
            .run_direct(&mut connection)
            .await
            .expect("migrate through the published snapshot schema");

        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut connection)
            .await
            .expect("begin fixture transaction");
        sqlx::query(
            "INSERT INTO projects (
               id, name, status, revision, deletion_generation, created_at, updated_at
             ) VALUES ('snapshot-project', 'Snapshot migration', 'active', 1, 0,
                       '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
        )
        .execute(&mut connection)
        .await
        .expect("insert project");
        sqlx::query(
            "INSERT INTO chapters (
               id, project_id, title, content, status, revision, current_version_id,
               created_at, updated_at, trashed_at
             ) VALUES ('snapshot-chapter', 'snapshot-project', 'Chapter', 'Body', 'active', 1,
                       'snapshot-version', '2026-08-08T00:00:00.000Z',
                       '2026-08-08T00:00:00.000Z', NULL)",
        )
        .execute(&mut connection)
        .await
        .expect("insert chapter");
        sqlx::query(
            "INSERT INTO chapter_versions (
               id, project_id, chapter_id, parent_version_id, sequence, content,
               content_checksum, reason, source_candidate_id, created_at
             ) VALUES ('snapshot-version', 'snapshot-project', 'snapshot-chapter', NULL, 1,
                       'Body', ?, 'created', NULL, '2026-08-08T00:00:00.000Z')",
        )
        .bind("a".repeat(64))
        .execute(&mut connection)
        .await
        .expect("insert chapter version");
        for sequence in 1..=3_i64 {
            let id = format!("snapshot-{sequence}");
            let supersedes = (sequence > 1).then(|| format!("snapshot-{}", sequence - 1));
            let run_kind = if sequence == 1 { "initial" } else { "rerun" };
            let result_json = String::from(
                "{\"status\":\"checked\",\"projectId\":\"snapshot-project\",\"chapterId\":\"snapshot-chapter\",\"chapterVersionId\":\"snapshot-version\",\"chapterRevision\":1,\"issues\":[]}",
            );
            sqlx::query(
                "INSERT INTO chapter_validation_snapshots (
                   id, project_id, chapter_id, chapter_version_id, chapter_revision,
                   schema_version, rule_set_version, run_sequence, run_kind,
                   supersedes_snapshot_id, result_status, issue_count,
                   result_checksum_sha256, result_json, generated_at
                 ) VALUES (?, 'snapshot-project', 'snapshot-chapter', 'snapshot-version', 1,
                           1, 'deterministic-novel-validator.v1', ?, ?, ?, 'checked', 0, ?, ?,
                           '2026-08-08T00:00:00.000Z')",
            )
            .bind(id)
            .bind(sequence)
            .bind(run_kind)
            .bind(supersedes)
            .bind(sequence.to_string().repeat(64))
            .bind(result_json)
            .execute(&mut connection)
            .await
            .expect("insert validation snapshot");
        }
        sqlx::query("COMMIT")
            .execute(&mut connection)
            .await
            .expect("commit fixture transaction");

        run_local_migrations(&mut connection)
            .await
            .expect("apply the forward-only cascade repair");
        let snapshot_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chapter_validation_snapshots")
                .fetch_one(&mut connection)
                .await
                .expect("count migrated snapshots");
        assert_eq!(snapshot_count, 3);

        sqlx::query("DELETE FROM projects WHERE id = 'snapshot-project'")
            .execute(&mut connection)
            .await
            .expect("cascade project deletion");
        let remaining: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chapter_validation_snapshots")
                .fetch_one(&mut connection)
                .await
                .expect("count remaining snapshots");
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn rejects_an_existing_checksum_mismatch() {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let original = test_migrator(vec![test_migration(
            1,
            "CREATE TABLE checksum_guard (id INTEGER PRIMARY KEY);",
        )]);
        original
            .run_direct(&mut connection)
            .await
            .expect("original migration");

        let changed = test_migrator(vec![test_migration(
            1,
            "CREATE TABLE checksum_guard (id INTEGER PRIMARY KEY, changed TEXT);",
        )]);
        let error = changed
            .run_direct(&mut connection)
            .await
            .expect_err("checksum mismatch");
        assert!(matches!(error, MigrateError::VersionMismatch(1)));
    }

    #[tokio::test]
    async fn rolls_back_a_failed_migration_without_losing_prior_schema() {
        let mut connection = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        let migrator = test_migrator(vec![
            test_migration(1, "CREATE TABLE preserved_schema (id INTEGER PRIMARY KEY);"),
            test_migration(
                2,
                "CREATE TABLE must_roll_back (id INTEGER PRIMARY KEY);
                 INSERT INTO missing_table (id) VALUES (1);",
            ),
        ]);

        migrator
            .run_direct(&mut connection)
            .await
            .expect_err("second migration fails");

        let preserved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'preserved_schema'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("preserved schema");
        let rolled_back: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'must_roll_back'",
        )
        .fetch_one(&mut connection)
        .await
        .expect("rolled back schema");
        assert_eq!(preserved, 1);
        assert_eq!(rolled_back, 0);

        let applied = sqlx::query("SELECT version, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut connection)
            .await
            .expect("migration history");
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0].get::<i64, _>("version"), 1);
        assert!(applied[0].get::<bool, _>("success"));
    }
}
