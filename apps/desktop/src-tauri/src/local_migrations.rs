use std::borrow::Cow;

use sqlx::{
    migrate::{MigrateError, Migration, MigrationType, Migrator},
    SqliteConnection,
};

const ZHIPU_GLM_MIGRATION_VERSION: i64 = 49;
const MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION: i64 = 60;

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
        ]),
        ignore_missing: false,
        locking: true,
        no_tx: false,
    }
}

pub(crate) async fn run_local_migrations(
    connection: &mut SqliteConnection,
) -> Result<(), MigrateError> {
    let full = local_migrator();
    let before_zhipu = migration_subset(&full, |migration| {
        migration.version < ZHIPU_GLM_MIGRATION_VERSION
    });
    before_zhipu.run_direct(&mut *connection).await?;

    run_foreign_key_disabled_migration(
        connection,
        &full,
        ZHIPU_GLM_MIGRATION_VERSION,
        "foreign-key violations remained after Model Hub provider migration",
    )
    .await?;

    let before_content_quality = migration_subset(&full, |migration| {
        migration.version > ZHIPU_GLM_MIGRATION_VERSION
            && migration.version < MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
    });
    before_content_quality.run_direct(&mut *connection).await?;

    run_foreign_key_disabled_migration(
        connection,
        &full,
        MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION,
        "foreign-key violations remained after Model Hub task migration",
    )
    .await?;

    let future = migration_subset(&full, |migration| {
        migration.version > MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION
    });
    future.run_direct(connection).await
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
    use std::borrow::Cow;

    use sqlx::{
        migrate::{MigrateError, Migration, MigrationType, Migrator},
        Connection, Row, SqliteConnection,
    };

    use super::{
        local_migrator, migration_subset, run_foreign_key_disabled_migration, run_local_migrations,
        MODEL_HUB_CONTENT_QUALITY_TASK_MIGRATION_VERSION, ZHIPU_GLM_MIGRATION_VERSION,
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
            .expect("restart with version 68 migration history");

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
        let maximum_version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(&mut connection)
            .await
            .expect("maximum migration version");
        assert_eq!(maximum_version, 68);
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
