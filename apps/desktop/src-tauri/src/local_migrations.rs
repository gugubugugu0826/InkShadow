use std::borrow::Cow;

use sqlx::migrate::{Migration, MigrationType, Migrator};

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
        ]),
        ignore_missing: false,
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

    use super::local_migrator;

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

        migrator
            .run_direct(&mut connection)
            .await
            .expect("fresh migration");
        migrator
            .run_direct(&mut connection)
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
