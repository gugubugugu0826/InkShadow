use std::borrow::Cow;

use sqlx::{
    migrate::{MigrateError, Migration, MigrationType, Migrator},
    SqliteConnection,
};

const ZHIPU_GLM_MIGRATION_VERSION: i64 = 49;

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

    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await?;
    let zhipu_only = migration_subset(&full, |migration| {
        migration.version == ZHIPU_GLM_MIGRATION_VERSION
    });
    let zhipu_result = zhipu_only.run_direct(&mut *connection).await;
    let restore_foreign_keys = sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await;
    zhipu_result?;
    restore_foreign_keys?;

    let violation_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&mut *connection)
        .await?;
    if violation_count != 0 {
        return Err(MigrateError::Execute(sqlx::Error::Protocol(
            "foreign-key violations remained after Model Hub provider migration".into(),
        )));
    }

    full.run_direct(connection).await
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

    use super::{local_migrator, run_local_migrations};

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
        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut connection)
            .await
            .expect("foreign-key enforcement restored");
        assert_eq!(foreign_keys, 1);
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
