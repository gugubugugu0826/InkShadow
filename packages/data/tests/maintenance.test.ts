import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Clock, IsoUtcTimestamp } from "@inkshadow/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  GovernedCreativeExtensionSqliteStore,
  calculateMaximumCostMicros,
  computeGovernedExtensionRequestFingerprint,
  type GovernedExtensionRequestSnapshot,
} from "../src/governed-creative-extension-sqlite-store.js";
import { DatabaseMaintenanceService } from "../src/maintenance.js";
import { TeamTemplateApplicationSqliteStore } from "../src/team-template-application-sqlite-store.js";
import type { SqlPrimitive } from "../src/executor.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const backupPath = path.join(tmpdir(), `inkshadow-maintenance-${process.pid}.db`);
const incompatibleBackupPath = path.join(
  tmpdir(),
  `inkshadow-maintenance-incompatible-${process.pid}.db`,
);
const corruptedBackupPath = path.join(
  tmpdir(),
  `inkshadow-maintenance-corrupted-${process.pid}.db`,
);
const inkShadowMigration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0002_tasks_notifications.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../story-core/migrations/0001_story_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../story-core/migrations/0002_materials.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../story-core/migrations/0003_ideation.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0003_sync_access.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0004_model_profiles.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0005_ai_generation_governance.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0006_search_index.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0007_model_routing_usage.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0008_project_key_lifecycle.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0009_device_identity_names.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0010_sync_inbox.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0011_cloud_project_key_checkpoints.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0012_cloud_project_key_publications.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0013_sync_snapshot_staging.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0014_sync_protocol_v2_object_types.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0015_sync_materialization_authority.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0016_sync_snapshot_materialization_receipts.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0017_sync_projection_account_authority.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0018_sync_incremental_terminal_observations.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0020_graph_rag_projection.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0021_search_vector_index.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0022_team_project_key_receipts.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0023_authoritative_story_graph_epoch.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0024_multi_agent_review.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0025_governed_creative_extensions.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0026_team_template_applications.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0027_authoritative_extraction.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0028_fine_tuning_governance.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0029_community_marketplace_installs.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0031_model_hub.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0032_unified_story_facts.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0033_causal_event_graph.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0034_context_compilation_trace.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0035_writing_feedback_learning.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0036_story_planning_candidates.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0037_model_hub_expert_options.sql", import.meta.url), "utf8"),
].join("\n");
const BACKUP_PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const BACKUP_ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const BACKUP_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const BACKUP_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000103";
const BACKUP_FINE_TUNING_DATASET_ID = "maintenance-fine-tuning-dataset";
const BACKUP_FINE_TUNING_JOB_ID = "maintenance-fine-tuning-job";
const BACKUP_FINE_TUNING_ARTIFACT_ID = "maintenance-fine-tuning-artifact";
const BACKUP_MARKETPLACE_ARTIFACT_ID = "maintenance-marketplace-artifact";
const BACKUP_CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000201";
const BACKUP_CHAPTER_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000202";

afterEach(() => {
  rmSync(backupPath, { force: true });
  rmSync(incompatibleBackupPath, { force: true });
  rmSync(corruptedBackupPath, { force: true });
});

describe("DatabaseMaintenanceService", () => {
  it("reports a healthy database without exposing row content", async () => {
    const executor = new NodeSqliteExecutor("");
    await executor.execute("CREATE TABLE notes (content TEXT NOT NULL)");
    await executor.execute("INSERT INTO notes (content) VALUES (?)", ["private chapter"]);
    const service = new DatabaseMaintenanceService(executor);

    const report = await service.inspect();

    expect(report).toEqual({
      ok: true,
      value: {
        healthy: true,
        integrityMessages: ["ok"],
        foreignKeyViolations: [],
      },
    });
    expect(JSON.stringify(report)).not.toContain("private chapter");
    await executor.close();
  });

  it("creates a standalone consistent backup without overwriting", async () => {
    const executor = new NodeSqliteExecutor("");
    await executor.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
    await executor.execute("INSERT INTO notes (content) VALUES (?)", ["stable"]);
    const service = new DatabaseMaintenanceService(executor);

    const receipt = await service.createConsistentBackup(backupPath);

    expect(receipt).toEqual({
      ok: true,
      value: {
        destinationKind: "user_selected_file",
        integrityVerified: true,
      },
    });
    expect(existsSync(backupPath)).toBe(true);

    const duplicate = await service.createConsistentBackup(backupPath);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe("REPOSITORY_ERROR");
      expect(duplicate.error.details).not.toHaveProperty("path");
    }
    await executor.close();
  });

  it("rejects invalid destinations before asking SQLite to write", async () => {
    const executor = new NodeSqliteExecutor("");
    const service = new DatabaseMaintenanceService(executor);

    const result = await service.createConsistentBackup("\u0000");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
    await executor.close();
  });

  it("does not issue a verified receipt when the generated target fails schema verification", async () => {
    const executor = new CorruptingBackupExecutor("");
    await executor.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
    const service = new DatabaseMaintenanceService(executor);

    const result = await service.createConsistentBackup(corruptedBackupPath);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { operation: "DATABASE_BACKUP_VERIFICATION_FAILED" },
      },
    });
    expect(existsSync(corruptedBackupPath)).toBe(true);
    await executor.close();
  });

  it("restores every supported table from a healthy backup in one transaction", async () => {
    const executor = new NodeSqliteExecutor(inkShadowMigration);
    const service = new DatabaseMaintenanceService(executor);
    await insertProject(executor, BACKUP_PROJECT_ID, "备份中的项目");
    await insertTeamTemplateApplication(executor);
    await insertGovernedExtensionMetadata(executor);
    await insertCausalEventGraph(executor);
    await insertContextCompilationTrace(executor);
    await insertSyncAndAccessMetadata(executor);
    await insertProjectKeyMetadata(executor);
    await insertModelProfile(executor);
    await insertModelHubExpertConnection(executor);
    await insertSearchSnapshot(executor, "备份中的派生索引");
    await insertVectorProjection(executor);
    await insertGraphProjectionState(executor);
    await insertFineTuningGovernance(executor);
    await insertMarketplaceInstall(executor);
    await insertUnifiedStoryFact(executor);
    await insertWritingFeedbackLearning(executor);
    const backup = await service.createConsistentBackup(backupPath);
    expect(backup.ok).toBe(true);
    await executor.execute(
      "DELETE FROM context_compilation_runs WHERE id = 'maintenance-context-run'",
    );
    await executor.execute("DELETE FROM causal_events WHERE project_id = ?", [BACKUP_PROJECT_ID]);
    await executor.execute("DELETE FROM causal_evidence_sources WHERE project_id = ?", [
      BACKUP_PROJECT_ID,
    ]);
    await insertProject(executor, "019f9f4a-b3c7-7350-9226-000000000002", "恢复前新增");
    await executor.execute(
      "UPDATE sync_tombstones SET acknowledged_device_ids_json = ? WHERE project_id = ?",
      [JSON.stringify([BACKUP_DEVICE_ID]), BACKUP_PROJECT_ID],
    );
    await executor.execute("UPDATE entitlement_cache SET tier = 'community' WHERE account_id = ?", [
      BACKUP_ACCOUNT_ID,
    ]);
    await executor.execute(
      "UPDATE model_profiles SET selected_model = 'changed-model' WHERE provider_id = 'openai'",
    );
    await executor.execute(
      `UPDATE model_provider_connections
       SET authentication_mode = 'bearer_keyring', credential_header_name = NULL,
           model_discovery_path = '/changed/models',
           text_generation_path = '/changed/chat', embedding_path = '/changed/embed',
           request_timeout_ms = 120000, retry_limit = 0
       WHERE id = 'maintenance-custom-model'`,
    );
    await executor.execute(
      `UPDATE device_public_key_records
       SET state = 'credential_missing', display_name = '恢复前改名', updated_at = ?
       WHERE device_id = ?`,
      ["2026-07-27T00:01:00.000Z", BACKUP_DEVICE_ID],
    );
    await executor.execute(
      `UPDATE team_project_key_receipts
       SET state = 'credential_missing',
           state_updated_at = '2026-07-27T00:01:00.000Z'
       WHERE project_id = ?`,
      [BACKUP_PROJECT_ID],
    );
    await executor.execute(
      `UPDATE search_index_documents
       SET search_text = '恢复前当前派生索引'
       WHERE project_id = ?`,
      [BACKUP_PROJECT_ID],
    );
    await executor.execute("UPDATE short_drama_scripts SET title = '恢复前被修改' WHERE id = ?", [
      "maintenance-formal-drama",
    ]);
    await executor.execute(
      "UPDATE project_team_template_settings SET value_json = ? WHERE project_id = ?",
      [JSON.stringify("changed-after-backup"), BACKUP_PROJECT_ID],
    );
    await executor.execute(
      "UPDATE fine_tuning_quota_policies SET maximum_dataset_bytes = 999 WHERE project_id = ?",
      [BACKUP_PROJECT_ID],
    );
    await executor.execute(
      "UPDATE community_marketplace_installs SET payload_json = ? WHERE artifact_id = ?",
      [
        marketplaceInstallPayload({
          artifactId: BACKUP_MARKETPLACE_ARTIFACT_ID,
          versionId: "maintenance-marketplace-v1",
          digest: "9".repeat(64),
          installedAt: "2026-07-27T00:00:00.000Z",
          label: "changed-after-backup",
        }),
        BACKUP_MARKETPLACE_ARTIFACT_ID,
      ],
    );
    await executor.execute(
      `UPDATE story_facts
       SET locked = 1, revision = 3, updated_at = '2026-07-27T00:01:00.000Z'
      WHERE id = 'maintenance-story-fact' AND revision = 2`,
    );
    await executor.execute(
      `UPDATE writing_preferences
       SET preference_text = '恢复前被修改', revision = 2,
           updated_at = '2026-07-27T00:01:00.000Z'
       WHERE id = 'maintenance-writing-preference'`,
    );
    await executor.execute(
      "DELETE FROM writing_feedback_events WHERE id = 'maintenance-feedback-event'",
    );

    const restored = await service.restoreConsistentBackup(backupPath);

    expect(restored).toEqual({
      ok: true,
      value: {
        sourceKind: "user_selected_file",
        integrityVerified: true,
        restoredTableCount: 128,
      },
    });
    await expect(
      executor.select<{ text: string; revision: number }>(
        `SELECT preference_text AS text, revision
         FROM writing_preferences
         WHERE id = 'maintenance-writing-preference'`,
      ),
    ).resolves.toEqual([{ text: "减少环境描写。", revision: 1 }]);
    await expect(
      executor.select<{ revision: number; kind: string }>(
        `SELECT revision, change_kind AS kind
         FROM writing_preference_revisions
         WHERE preference_id = 'maintenance-writing-preference'`,
      ),
    ).resolves.toEqual([{ revision: 1, kind: "created" }]);
    await expect(
      executor.select<{ code: string }>(
        `SELECT feedback_code AS code
         FROM writing_feedback_events
         WHERE id = 'maintenance-feedback-event'`,
      ),
    ).resolves.toEqual([{ code: "less_environment_description" }]);
    await expect(executor.select<{ name: string }>("SELECT name FROM projects")).resolves.toEqual([
      { name: "备份中的项目" },
    ]);
    await expect(
      executor.select<{ acknowledged: string }>(
        `SELECT acknowledged_device_ids_json AS acknowledged
         FROM sync_tombstones
         WHERE project_id = ?`,
        [BACKUP_PROJECT_ID],
      ),
    ).resolves.toEqual([{ acknowledged: "[]" }]);
    await expect(
      executor.select<{ tier: string }>("SELECT tier FROM entitlement_cache WHERE account_id = ?", [
        BACKUP_ACCOUNT_ID,
      ]),
    ).resolves.toEqual([{ tier: "pro" }]);
    await expect(
      executor.select<{ selectedModel: string }>(
        "SELECT selected_model AS selectedModel FROM model_profiles WHERE provider_id = 'openai'",
      ),
    ).resolves.toEqual([{ selectedModel: "gpt-test" }]);
    await expect(
      executor.select<{
        authenticationMode: string;
        credentialHeaderName: string;
        modelDiscoveryPath: string;
        textGenerationPath: string;
        embeddingPath: string;
        requestTimeoutMs: number;
        retryLimit: number;
      }>(
        `SELECT authentication_mode AS authenticationMode,
                credential_header_name AS credentialHeaderName,
                model_discovery_path AS modelDiscoveryPath,
                text_generation_path AS textGenerationPath,
                embedding_path AS embeddingPath,
                request_timeout_ms AS requestTimeoutMs,
                retry_limit AS retryLimit
         FROM model_provider_connections
         WHERE id = 'maintenance-custom-model'`,
      ),
    ).resolves.toEqual([
      {
        authenticationMode: "custom_header_keyring",
        credentialHeaderName: "x-api-key",
        modelDiscoveryPath: "/catalog/models",
        textGenerationPath: "/text/chat",
        embeddingPath: "/vectors/embed",
        requestTimeoutMs: 47_000,
        retryLimit: 2,
      },
    ]);
    await expect(
      executor.select<{ state: string; displayName: string }>(
        `SELECT state, display_name AS displayName
         FROM device_public_key_records
         WHERE device_id = ?`,
        [BACKUP_DEVICE_ID],
      ),
    ).resolves.toEqual([{ state: "trusted", displayName: "主力写作设备" }]);
    await expect(
      executor.select<{ status: string }>(
        "SELECT status FROM project_recovery_key_envelopes WHERE project_id = ?",
        [BACKUP_PROJECT_ID],
      ),
    ).resolves.toEqual([{ status: "confirmed" }]);
    await expect(
      executor.select<{ serverRevision: number }>(
        `SELECT server_revision AS serverRevision
         FROM cloud_project_key_checkpoints
         WHERE project_id = ?`,
        [BACKUP_PROJECT_ID],
      ),
    ).resolves.toEqual([{ serverRevision: 1 }]);
    await expect(
      executor.select<{ state: string; nativeStorageRef: string }>(
        `SELECT state, native_storage_ref AS nativeStorageRef
         FROM team_project_key_receipts
         WHERE project_id = ?`,
        [BACKUP_PROJECT_ID],
      ),
    ).resolves.toEqual([
      {
        state: "active",
        nativeStorageRef: `team_project_key_receipt_v1_${"b".repeat(64)}`,
      },
    ]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM search_index_documents"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM search_index_state"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM graph_rag_projection_state",
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM search_vector_index_state"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ title: string; status: string }>(
        `SELECT script.title, candidate.status
         FROM short_drama_scripts AS script
         INNER JOIN governed_extension_candidates AS candidate
           ON candidate.id = script.candidate_id
         WHERE script.id = ?`,
        ["maintenance-formal-drama"],
      ),
    ).resolves.toEqual([{ title: "备份短剧", status: "accepted" }]);
    await expect(
      executor.select<{ valueJson: string }>(
        `SELECT value_json AS valueJson
         FROM project_team_template_settings
         WHERE project_id = ? AND setting_key = 'genre'`,
        [BACKUP_PROJECT_ID],
      ),
    ).resolves.toEqual([{ valueJson: JSON.stringify("mystery") }]);
    await expect(
      executor.select<{ cloudRecordedAt: string | null }>(
        `SELECT cloud_recorded_at AS cloudRecordedAt
         FROM team_template_application_receipts
         WHERE project_id = ?`,
        [BACKUP_PROJECT_ID],
      ),
    ).resolves.toEqual([{ cloudRecordedAt: null }]);
    await expect(
      executor.select<{ maximumDatasetBytes: number }>(
        `SELECT maximum_dataset_bytes AS maximumDatasetBytes
         FROM fine_tuning_quota_policies
         WHERE project_id = ?`,
        [BACKUP_PROJECT_ID],
      ),
    ).resolves.toEqual([{ maximumDatasetBytes: 10_000_000 }]);
    await expect(
      executor.select<{ status: string; artifactId: string | null }>(
        `SELECT status, artifact_id AS artifactId
         FROM fine_tuning_jobs
         WHERE id = ?`,
        [BACKUP_FINE_TUNING_JOB_ID],
      ),
    ).resolves.toEqual([
      {
        status: "artifact_ready",
        artifactId: BACKUP_FINE_TUNING_ARTIFACT_ID,
      },
    ]);
    await expect(
      executor.select<{ datasetState: string; artifactState: string; artifactRevision: number }>(
        `SELECT
           dataset.state AS datasetState,
           artifact.state AS artifactState,
           artifact.revision AS artifactRevision
         FROM fine_tuning_datasets AS dataset
         INNER JOIN fine_tuning_model_artifacts AS artifact
           ON artifact.dataset_id = dataset.id
         WHERE dataset.id = ?`,
        [BACKUP_FINE_TUNING_DATASET_ID],
      ),
    ).resolves.toEqual([
      {
        datasetState: "archived",
        artifactState: "deployed",
        artifactRevision: 3,
      },
    ]);
    await expect(
      executor.select<{ tableName: string; count: number }>(
        `SELECT 'fine_tuning_datasets' AS tableName, COUNT(*) AS count
           FROM fine_tuning_datasets
         UNION ALL
         SELECT 'fine_tuning_samples', COUNT(*) FROM fine_tuning_samples
         UNION ALL
         SELECT 'fine_tuning_approvals', COUNT(*) FROM fine_tuning_approvals
         UNION ALL
         SELECT 'fine_tuning_quota_policies', COUNT(*) FROM fine_tuning_quota_policies
         UNION ALL
         SELECT 'fine_tuning_jobs', COUNT(*) FROM fine_tuning_jobs
         UNION ALL
         SELECT 'fine_tuning_model_artifacts', COUNT(*) FROM fine_tuning_model_artifacts
         UNION ALL
         SELECT 'fine_tuning_evaluations', COUNT(*) FROM fine_tuning_evaluations
         UNION ALL
         SELECT 'fine_tuning_deployments', COUNT(*) FROM fine_tuning_deployments
         UNION ALL
         SELECT 'fine_tuning_operation_claims', COUNT(*) FROM fine_tuning_operation_claims
         UNION ALL
         SELECT 'fine_tuning_audit_events', COUNT(*) FROM fine_tuning_audit_events`,
      ),
    ).resolves.toEqual([
      { tableName: "fine_tuning_datasets", count: 1 },
      { tableName: "fine_tuning_samples", count: 1 },
      { tableName: "fine_tuning_approvals", count: 2 },
      { tableName: "fine_tuning_quota_policies", count: 1 },
      { tableName: "fine_tuning_jobs", count: 1 },
      { tableName: "fine_tuning_model_artifacts", count: 1 },
      { tableName: "fine_tuning_evaluations", count: 1 },
      { tableName: "fine_tuning_deployments", count: 1 },
      { tableName: "fine_tuning_operation_claims", count: 1 },
      { tableName: "fine_tuning_audit_events", count: 1 },
    ]);
    const restoredMarketplace = await executor.select<{ payloadJson: string }>(
      `SELECT payload_json AS payloadJson
       FROM community_marketplace_installs
       WHERE artifact_id = ?`,
      [BACKUP_MARKETPLACE_ARTIFACT_ID],
    );
    expect(JSON.parse(restoredMarketplace[0]?.payloadJson ?? "{}")).toMatchObject({
      label: "backed-up",
    });
    await expect(
      executor.select<{ revision: number; locked: number }>(
        `SELECT revision, locked
         FROM story_facts
         WHERE id = 'maintenance-story-fact'`,
      ),
    ).resolves.toEqual([{ revision: 2, locked: 0 }]);
    await expect(
      executor.select<{ revisionCount: number; linkCount: number }>(
        `SELECT
           (SELECT COUNT(*) FROM story_fact_revisions
            WHERE fact_id = 'maintenance-story-fact') AS revisionCount,
           (SELECT COUNT(*) FROM story_fact_legacy_links
            WHERE fact_id = 'maintenance-story-fact') AS linkCount`,
      ),
    ).resolves.toEqual([{ revisionCount: 2, linkCount: 1 }]);
    await expect(
      executor.select<{ tableName: string; count: number }>(
        `SELECT 'causal_evidence_sources' AS tableName, COUNT(*) AS count
           FROM causal_evidence_sources
         UNION ALL
         SELECT 'causal_events', COUNT(*) FROM causal_events
         UNION ALL
         SELECT 'causal_event_participants', COUNT(*) FROM causal_event_participants
         UNION ALL
         SELECT 'causal_event_prerequisites', COUNT(*) FROM causal_event_prerequisites
         UNION ALL
         SELECT 'causal_event_character_changes', COUNT(*) FROM causal_event_character_changes
         UNION ALL
         SELECT 'causal_event_relationship_changes', COUNT(*) FROM causal_event_relationship_changes
         UNION ALL
         SELECT 'causal_event_item_changes', COUNT(*) FROM causal_event_item_changes
         UNION ALL
         SELECT 'causal_event_informed_characters', COUNT(*) FROM causal_event_informed_characters
         UNION ALL
         SELECT 'causal_event_foreshadow_progress', COUNT(*) FROM causal_event_foreshadow_progress
         UNION ALL
         SELECT 'causal_event_relations', COUNT(*) FROM causal_event_relations`,
      ),
    ).resolves.toEqual([
      { tableName: "causal_evidence_sources", count: 1 },
      { tableName: "causal_events", count: 2 },
      { tableName: "causal_event_participants", count: 1 },
      { tableName: "causal_event_prerequisites", count: 1 },
      { tableName: "causal_event_character_changes", count: 1 },
      { tableName: "causal_event_relationship_changes", count: 1 },
      { tableName: "causal_event_item_changes", count: 1 },
      { tableName: "causal_event_informed_characters", count: 1 },
      { tableName: "causal_event_foreshadow_progress", count: 1 },
      { tableName: "causal_event_relations", count: 1 },
    ]);
    await expect(
      executor.select<{
        eventText: string;
        evidenceLocator: string;
        prerequisiteEventId: string;
        relationKind: string;
      }>(
        `SELECT
           event.event_text AS eventText,
           evidence.locator AS evidenceLocator,
           prerequisite.referenced_event_id AS prerequisiteEventId,
           relation.relation_kind AS relationKind
         FROM causal_events AS event
         INNER JOIN causal_evidence_sources AS evidence
           ON evidence.id = event.evidence_id
         INNER JOIN causal_event_prerequisites AS prerequisite
           ON prerequisite.event_id = event.id
         INNER JOIN causal_event_relations AS relation
           ON relation.to_event_id = event.id
         WHERE event.id = 'maintenance-causal-event-b'`,
      ),
    ).resolves.toEqual([
      {
        eventText: "The guide opens the sealed gate.",
        evidenceLocator: "chapter:maintenance#causal-span",
        prerequisiteEventId: "maintenance-causal-event-a",
        relationKind: "causes",
      },
    ]);
    await expect(
      executor.select<{
        taskType: string;
        layer: string;
        included: number;
        sourceType: string;
        sourceId: string;
        locator: string | null;
      }>(
        `SELECT
           run.task_type AS taskType,
           entry.layer,
           entry.included,
           source.source_type AS sourceType,
           source.source_id AS sourceId,
           source.locator
         FROM context_compilation_runs AS run
         INNER JOIN context_compilation_entries AS entry
           ON entry.run_id = run.id
         INNER JOIN context_compilation_entry_sources AS source
           ON source.run_id = entry.run_id
          AND source.candidate_id = entry.candidate_id
         WHERE run.id = 'maintenance-context-run'
         ORDER BY entry.evaluation_order`,
      ),
    ).resolves.toEqual([
      {
        taskType: "next_scene",
        layer: "related_causal_chain",
        included: 1,
        sourceType: "causal_event",
        sourceId: "maintenance-causal-event-b",
        locator: "causal-event:maintenance-causal-event-b",
      },
      {
        taskType: "next_scene",
        layer: "semantic_retrieval",
        included: 0,
        sourceType: "search_document",
        sourceId: "maintenance-search-document",
        locator: "search-document:maintenance-search-document",
      },
    ]);
    await expect(
      executor.select<{ tableName: string; columnName: string }>(
        `SELECT m.name AS tableName, p.name AS columnName
         FROM sqlite_schema AS m
         INNER JOIN pragma_table_info(m.name) AS p
         WHERE m.type = 'table'
           AND m.name IN (
             'context_compilation_runs',
             'context_compilation_entries',
             'context_compilation_entry_sources'
           )
           AND lower(p.name) IN (
             'prompt', 'prompt_text', 'content', 'content_text', 'excerpt',
             'embedding', 'vector', 'payload_json', 'body', 'body_text'
           )`,
      ),
    ).resolves.toEqual([]);
    await executor.close();
  });

  it("keeps the current database unchanged when the selected backup is incompatible", async () => {
    const executor = new NodeSqliteExecutor(inkShadowMigration);
    const service = new DatabaseMaintenanceService(executor);
    await insertProject(executor, "019f9f4a-b3c7-7350-9226-000000000003", "保留当前项目");
    const incompatible = new NodeSqliteExecutor("");
    await incompatible.execute("CREATE TABLE notes (value TEXT NOT NULL)");
    const incompatibleService = new DatabaseMaintenanceService(incompatible);
    expect((await incompatibleService.createConsistentBackup(incompatibleBackupPath)).ok).toBe(
      true,
    );
    await incompatible.close();

    const restored = await service.restoreConsistentBackup(incompatibleBackupPath);

    expect(restored).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { operation: "DATABASE_RESTORE_BACKUP_INCOMPATIBLE" },
      },
    });
    await expect(executor.select<{ name: string }>("SELECT name FROM projects")).resolves.toEqual([
      { name: "保留当前项目" },
    ]);
    await executor.close();
  });
});

class CorruptingBackupExecutor extends NodeSqliteExecutor {
  public override async execute(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<{ rowsAffected: number; lastInsertId?: number }> {
    const result = await super.execute(query, bindValues);
    if (query === "VACUUM INTO ?" && typeof bindValues[0] === "string") {
      const backup = new NodeSqliteExecutor("", bindValues[0]);
      await backup.execute("ALTER TABLE notes ADD COLUMN injected_schema_change TEXT");
      await backup.close();
    }
    return result;
  }
}

async function insertProject(
  executor: NodeSqliteExecutor,
  id: string,
  name: string,
): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO projects (
      id,
      name,
      status,
      revision,
      deletion_generation,
      created_at,
      updated_at,
      archived_at,
      trashed_at,
      retention_until,
      status_before_trash
    ) VALUES (?, ?, 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [id, name, now, now],
  );
}

async function insertFineTuningGovernance(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  const manifestHash = "a".repeat(64);
  const requestHash = "b".repeat(64);
  const planHash = "c".repeat(64);
  const artifactDigest = "d".repeat(64);
  const providerReceiptDigest = "e".repeat(64);
  const datasetApprovalId = "maintenance-fine-tuning-dataset-approval";
  const deploymentApprovalId = "maintenance-fine-tuning-deployment-approval";
  const evaluationId = "maintenance-fine-tuning-evaluation";
  const deploymentId = "maintenance-fine-tuning-deployment";

  await executor.execute(
    `INSERT INTO fine_tuning_datasets (
       id, project_id, name, state, revision, manifest_hash, manifest_json,
       total_content_bytes, included_sample_count, duplicate_sample_count,
       train_sample_count, validation_sample_count, test_sample_count,
       readiness_issues_json, created_by, approved_by, approved_at,
       created_at, updated_at
     ) VALUES (?, ?, 'Maintenance dataset', 'approved', 2, ?, '{}',
               12, 3, 0, 1, 1, 1, '[]', 'local_owner', 'local_owner', ?, ?, ?)`,
    [BACKUP_FINE_TUNING_DATASET_ID, BACKUP_PROJECT_ID, manifestHash, now, now, now],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_samples (
       id, dataset_id, project_id, source_kind, source_entity_id,
       source_revision, source_label, content_text, content_hash,
       content_bytes, rights_kind, rights_basis, rights_confirmed_at,
       allow_training, privacy_scan_version, pii_finding_count,
       sensitive_finding_count, privacy_findings_json, privacy_passed,
       split, duplicate_of_sample_id, created_at
     ) VALUES ('maintenance-fine-tuning-sample', ?, ?, 'material',
               'maintenance-material', 1, 'Owned sample', 'owned sample', ?,
               12, 'user_owned', 'Author-owned test fixture', ?, 1,
               'inkshadow.privacy-scan.v1', 0, 0, '[]', 1, 'train', NULL, ?)`,
    [BACKUP_FINE_TUNING_DATASET_ID, BACKUP_PROJECT_ID, "1".repeat(64), now, now],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_approvals (
       id, project_id, kind, entity_type, entity_id, entity_revision,
       authority_hash, actor_id, declarations_json, created_at
     ) VALUES (?, ?, 'dataset_training', 'dataset', ?, 1, ?,
               'local_owner', '{"humanConfirmed":true}', ?)`,
    [datasetApprovalId, BACKUP_PROJECT_ID, BACKUP_FINE_TUNING_DATASET_ID, manifestHash, now],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_approvals (
       id, project_id, kind, entity_type, entity_id, entity_revision,
       authority_hash, actor_id, declarations_json, created_at
     ) VALUES (?, ?, 'model_deployment', 'artifact', ?, 1, ?,
               'local_owner',
               '{"humanConfirmed":true,"targetRole":"local_private"}', ?)`,
    [deploymentApprovalId, BACKUP_PROJECT_ID, BACKUP_FINE_TUNING_ARTIFACT_ID, "f".repeat(64), now],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_quota_policies (
       project_id, allow_remote_training, maximum_dataset_bytes,
       maximum_concurrent_jobs, maximum_single_job_cost_micros,
       monthly_cost_limit_micros, currency, spent_micros,
       reserved_micros, active_jobs, month_key, revision, created_at, updated_at
     ) VALUES (?, 0, 10000000, 2, 500000, 2000000, 'USD',
               80, 0, 0, '2026-07', 2, ?, ?)`,
    [BACKUP_PROJECT_ID, now, now],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_jobs (
       id, project_id, dataset_id, dataset_revision, dataset_manifest_hash,
       dataset_approval_id, idempotency_key, request_hash, plan_hash,
       plan_json, provider_location, provider_id, status, revision,
       attempt_count, maximum_attempts, cancellation_requested, lease_owner,
       lease_expires_at, reserved_cost_micros, settled_cost_micros, cost_source,
       currency, month_key, artifact_id, failure_code, created_by, started_at,
       completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, 2, ?, ?, 'maintenance-fine-tuning-job-queue', ?, ?,
               ?, 'local', 'maintenance-local', 'running', 1, 1, 2, 0,
               'maintenance-worker', ?, 100, NULL, NULL, 'USD', '2026-07',
               NULL, NULL, 'local_owner', ?, NULL, ?, ?)`,
    [
      BACKUP_FINE_TUNING_JOB_ID,
      BACKUP_PROJECT_ID,
      BACKUP_FINE_TUNING_DATASET_ID,
      manifestHash,
      datasetApprovalId,
      requestHash,
      planHash,
      JSON.stringify({
        provider: { location: "local" },
        baseModel: {
          providerId: "maintenance-provider",
          modelId: "maintenance-model",
          revision: "maintenance-base",
        },
      }),
      now,
      now,
      now,
      now,
    ],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_model_artifacts (
       id, project_id, dataset_id, job_id, base_model_provider_id,
       base_model_id, base_model_revision, artifact_digest, local_artifact_ref,
       state, revision, latest_evaluation_id, registration_name,
       provider_receipt_digest, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'maintenance-provider', 'maintenance-model',
               'maintenance-base', ?, 'maintenance_adapter_001',
               'candidate', 1, NULL, 'Maintenance model', ?, ?, ?)`,
    [
      BACKUP_FINE_TUNING_ARTIFACT_ID,
      BACKUP_PROJECT_ID,
      BACKUP_FINE_TUNING_DATASET_ID,
      BACKUP_FINE_TUNING_JOB_ID,
      artifactDigest,
      providerReceiptDigest,
      now,
      now,
    ],
  );
  await executor.execute(
    `UPDATE fine_tuning_jobs
     SET status = 'artifact_ready',
         revision = 2,
         lease_owner = NULL,
         lease_expires_at = NULL,
         settled_cost_micros = 80,
         cost_source = 'local_resource_estimate',
         artifact_id = ?,
         completed_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [BACKUP_FINE_TUNING_ARTIFACT_ID, now, now, BACKUP_FINE_TUNING_JOB_ID],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_evaluations (
       id, project_id, artifact_id, baseline_model_id, evaluator_id,
       evaluator_version, authority_hash, baseline_metrics_json,
       candidate_metrics_json, rules_json, observations_json, passed,
       created_by, created_at
    ) VALUES (?, ?, ?, 'maintenance-baseline', 'maintenance-evaluator',
               'maintenance-evaluator-v1', ?, '[]', '[]', '[]', '[]',
               1, 'local_owner', ?)`,
    [evaluationId, BACKUP_PROJECT_ID, BACKUP_FINE_TUNING_ARTIFACT_ID, "2".repeat(64), now],
  );
  await executor.execute(
    `UPDATE fine_tuning_model_artifacts
     SET state = 'deployment_approved',
         revision = 2,
         latest_evaluation_id = ?,
         updated_at = ?
     WHERE id = ?`,
    [evaluationId, now, BACKUP_FINE_TUNING_ARTIFACT_ID],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_deployments (
       id, project_id, artifact_id, target_role, previous_deployment_id,
       approval_id, status, provider_receipt_digest, activated_at, ended_at
     ) VALUES (?, ?, ?, 'local_private', NULL, ?, 'active', ?, ?, NULL)`,
    [
      deploymentId,
      BACKUP_PROJECT_ID,
      BACKUP_FINE_TUNING_ARTIFACT_ID,
      deploymentApprovalId,
      providerReceiptDigest,
      now,
    ],
  );
  await executor.execute(
    `UPDATE fine_tuning_model_artifacts
     SET state = 'deployed', revision = 3, updated_at = ?
     WHERE id = ?`,
    [now, BACKUP_FINE_TUNING_ARTIFACT_ID],
  );
  await executor.execute(
    `UPDATE fine_tuning_datasets
     SET state = 'archived',
         revision = 3,
         approved_by = NULL,
         approved_at = NULL,
         updated_at = ?
     WHERE id = ?`,
    [now, BACKUP_FINE_TUNING_DATASET_ID],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_operation_claims (
       idempotency_key, operation, request_hash, project_id,
       result_entity_type, result_entity_id, result_revision, created_at
     ) VALUES ('maintenance-fine-tuning-complete', 'job_complete', ?, ?,
               'artifact', ?, 2, ?)`,
    [requestHash, BACKUP_PROJECT_ID, BACKUP_FINE_TUNING_ARTIFACT_ID, now],
  );
  await executor.execute(
    `INSERT INTO fine_tuning_audit_events (
       id, project_id, entity_type, entity_id, action, actor_id,
       request_id, correlation_id, metadata_json, created_at
     ) VALUES ('maintenance-fine-tuning-audit', ?, 'artifact', ?,
               'artifact_created', 'local_owner', 'maintenance-request',
               'maintenance-correlation', '{}', ?)`,
    [BACKUP_PROJECT_ID, BACKUP_FINE_TUNING_ARTIFACT_ID, now],
  );
}

async function insertMarketplaceInstall(executor: NodeSqliteExecutor): Promise<void> {
  const versionId = "maintenance-marketplace-v1";
  const digest = "9".repeat(64);
  const installedAt = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO community_marketplace_installs (
       artifact_id, version_id, content_digest_sha256, installed_at, payload_json
     ) VALUES (?, ?, ?, ?, ?)`,
    [
      BACKUP_MARKETPLACE_ARTIFACT_ID,
      versionId,
      digest,
      installedAt,
      marketplaceInstallPayload({
        artifactId: BACKUP_MARKETPLACE_ARTIFACT_ID,
        versionId,
        digest,
        installedAt,
        label: "backed-up",
      }),
    ],
  );
}

async function insertUnifiedStoryFact(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO story_facts (
       id, project_id, fact_type, content_text, value_json,
       source_kind, evidence_reference, source_chapter_id, source_version_id,
       source_start_offset, source_end_offset, source_length, source_excerpt,
       effective_at, invalidated_at, branch_id, confidence, status, origin,
       user_confirmed, locked, deprecated, needs_review,
       confirmed_by_actor_id, confirmed_at, revision, created_at, updated_at
     ) VALUES (
       'maintenance-story-fact', ?, 'world_rule', '施法会遗忘一个名字。', NULL,
       'legacy_record', 'legacy:story_formal_records:maintenance-formal:r1',
       NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, 0.5, 'formal', 'legacy',
       1, 0, 0, 0, ?, ?, 2, ?, ?
     )`,
    [BACKUP_PROJECT_ID, "019f9f4a-b3c7-7350-9226-000000000170", now, now, now],
  );
  await executor.execute(
    `INSERT INTO story_fact_revisions (
       fact_id, project_id, revision, change_kind, recorded_at, snapshot_json
     ) VALUES
       ('maintenance-story-fact', ?, 1, 'legacy_backfill', ?, '{"revision":1}'),
       ('maintenance-story-fact', ?, 2, 'confirmed', ?, '{"revision":2}')`,
    [BACKUP_PROJECT_ID, now, BACKUP_PROJECT_ID, now],
  );
  await executor.execute(
    `INSERT INTO story_fact_legacy_links (
       fact_id, project_id, legacy_kind, legacy_id, legacy_revision,
       link_mode, created_at
     ) VALUES (
       'maintenance-story-fact', ?, 'formal_record', 'maintenance-formal',
       1, 'backfill', ?
     )`,
    [BACKUP_PROJECT_ID, now],
  );
}

async function insertWritingFeedbackLearning(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO writing_feedback_policies (
       project_id, learning_enabled, revision, created_at, updated_at
     ) VALUES (?, 1, 1, ?, ?)`,
    [BACKUP_PROJECT_ID, now, now],
  );
  await executor.execute(
    `INSERT INTO writing_preferences (
       id, project_id, preference_text, source, source_feedback_code,
       evidence_count, enabled, revision, created_at, updated_at, deleted_at
     ) VALUES (
       'maintenance-writing-preference', ?, '减少环境描写。', 'feedback_pattern',
       'less_environment_description', 2, 1, 1, ?, ?, NULL
     )`,
    [BACKUP_PROJECT_ID, now, now],
  );
  await executor.execute(
    `INSERT INTO writing_feedback_events (
       id, project_id, chapter_id, candidate_id, action, feedback_code,
       custom_feedback, application_strategy, accepted_change_count,
       rejected_change_count, created_at
     ) VALUES (
       'maintenance-feedback-event', ?, NULL, NULL, 'explicit_feedback',
       'less_environment_description', NULL, NULL, NULL, NULL, ?
     )`,
    [BACKUP_PROJECT_ID, now],
  );
}

async function insertCausalEventGraph(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  const evidenceId = "maintenance-causal-evidence";
  const evidenceExcerpt = "causal evidence";
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO causal_evidence_sources (
         id, project_id, chapter_id, chapter_version_id, content_hash,
         locator, excerpt, start_offset, end_offset, source_length, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        evidenceId,
        BACKUP_PROJECT_ID,
        BACKUP_CHAPTER_ID,
        BACKUP_CHAPTER_VERSION_ID,
        "1".repeat(64),
        "chapter:maintenance#causal-span",
        evidenceExcerpt,
        evidenceExcerpt.length,
        evidenceExcerpt.length,
        now,
      ],
    );
    await transaction.execute(
      `INSERT INTO causal_events (
         id, project_id, branch_id, status, narrative_order, narrative_label,
         location_id, location_label, event_text, result_text, evidence_id,
         created_at, updated_at
       ) VALUES
         ('maintenance-causal-event-a', ?, 'main', 'confirmed', 1, 'First bell',
          'sealed-gate', 'The sealed gate', 'The hero presents the seal.',
          'The guide recognizes the royal mark.', ?, ?, ?),
         ('maintenance-causal-event-b', ?, 'main', 'confirmed', 2, 'Second bell',
          'sealed-gate', 'The sealed gate', 'The guide opens the sealed gate.',
          'The hero enters the old city.', ?, ?, ?)`,
      [BACKUP_PROJECT_ID, evidenceId, now, now, BACKUP_PROJECT_ID, evidenceId, now, now],
    );
    await transaction.execute(
      `INSERT INTO causal_event_participants (
         event_id, project_id, branch_id, character_id
       ) VALUES ('maintenance-causal-event-a', ?, 'main', 'character-hero')`,
      [BACKUP_PROJECT_ID],
    );
    await transaction.execute(
      `INSERT INTO causal_event_prerequisites (
         id, event_id, project_id, branch_id, prerequisite_kind,
         reference_id, referenced_event_id, description, evidence_id
       ) VALUES (
         'maintenance-causal-prerequisite', 'maintenance-causal-event-b', ?, 'main',
         'event', 'maintenance-causal-event-a', 'maintenance-causal-event-a',
         'The seal must be presented before the gate opens.', ?
       )`,
      [BACKUP_PROJECT_ID, evidenceId],
    );
    await transaction.execute(
      `INSERT INTO causal_event_character_changes (
         id, event_id, project_id, branch_id, character_id, attribute_key,
         before_value_json, after_value_json, evidence_id
       ) VALUES (
         'maintenance-causal-character-change', 'maintenance-causal-event-a', ?, 'main',
         'character-hero', 'location', '"outside"', '"at_gate"', ?
       )`,
      [BACKUP_PROJECT_ID, evidenceId],
    );
    await transaction.execute(
      `INSERT INTO causal_event_relationship_changes (
         id, event_id, project_id, branch_id, from_character_id, to_character_id,
         relationship_key, before_value_json, after_value_json, evidence_id
       ) VALUES (
         'maintenance-causal-relationship-change', 'maintenance-causal-event-a', ?, 'main',
         'character-guide', 'character-hero', 'trust', '0', '1', ?
       )`,
      [BACKUP_PROJECT_ID, evidenceId],
    );
    await transaction.execute(
      `INSERT INTO causal_event_item_changes (
         id, event_id, project_id, branch_id, item_id, change_kind,
         from_character_id, to_character_id, evidence_id
       ) VALUES (
         'maintenance-causal-item-change', 'maintenance-causal-event-a', ?, 'main',
         'royal-seal', 'acquired', NULL, 'character-hero', ?
       )`,
      [BACKUP_PROJECT_ID, evidenceId],
    );
    await transaction.execute(
      `INSERT INTO causal_event_informed_characters (
         event_id, project_id, branch_id, character_id
       ) VALUES ('maintenance-causal-event-a', ?, 'main', 'character-guide')`,
      [BACKUP_PROJECT_ID],
    );
    await transaction.execute(
      `INSERT INTO causal_event_foreshadow_progress (
         id, event_id, project_id, branch_id, foreshadow_id,
         progress_kind, description, evidence_id
       ) VALUES (
         'maintenance-causal-foreshadow', 'maintenance-causal-event-a', ?, 'main',
         'missing-prince', 'advanced', 'The guide recognizes the royal seal.', ?
       )`,
      [BACKUP_PROJECT_ID, evidenceId],
    );
    await transaction.execute(
      `INSERT INTO causal_event_relations (
         id, project_id, branch_id, from_event_id, to_event_id,
         relation_kind, evidence_id, created_at
       ) VALUES (
         'maintenance-causal-relation', ?, 'main', 'maintenance-causal-event-a',
         'maintenance-causal-event-b', 'causes', ?, ?
       )`,
      [BACKUP_PROJECT_ID, evidenceId, now],
    );
  });
}

async function insertContextCompilationTrace(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO context_compilation_runs (
         id, project_id, chapter_id, task_type, maximum_context_tokens,
         required_tokens, used_tokens, remaining_tokens, discarded_tokens,
         token_estimate_source, candidate_count, included_count, discarded_count,
         created_at
       ) VALUES (
         'maintenance-context-run', ?, ?, 'next_scene', 1000,
         300, 300, 700, 100, 'utf8_conservative', 2, 1, 1, ?
       )`,
      [BACKUP_PROJECT_ID, BACKUP_CHAPTER_ID, now],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_entries (
         run_id, candidate_id, layer, selection_reason, included,
         discarded_reason, estimated_tokens, evaluation_order, layer_order,
         priority, relevance_score, required, budget_remaining_before,
         budget_remaining_after
       ) VALUES
         ('maintenance-context-run', 'maintenance-context-causal',
          'related_causal_chain', 'Directly affects the requested next scene.',
          1, NULL, 300, 1, 7, 100, 0.95, 1, 1000, 700),
         ('maintenance-context-run', 'maintenance-context-search',
          'semantic_retrieval', 'Relevant but outside the remaining token budget.',
          0, 'token_budget_exceeded', 100, 2, 11, 10, 0.60, 0, 700, 700)`,
    );
    await transaction.execute(
      `INSERT INTO context_compilation_entry_sources (
         run_id, candidate_id, source_order, source_type, source_id,
         source_version_id, locator, content_hash
       ) VALUES
         ('maintenance-context-run', 'maintenance-context-causal', 1,
          'causal_event', 'maintenance-causal-event-b', NULL,
          'causal-event:maintenance-causal-event-b', ?),
         ('maintenance-context-run', 'maintenance-context-search', 1,
          'search_document', 'maintenance-search-document', NULL,
          'search-document:maintenance-search-document', ?)`,
      ["1".repeat(64), "2".repeat(64)],
    );
  });
}

function marketplaceInstallPayload(input: {
  readonly artifactId: string;
  readonly versionId: string;
  readonly digest: string;
  readonly installedAt: string;
  readonly label: string;
}): string {
  return JSON.stringify({
    artifact: { artifactId: input.artifactId },
    version: {
      versionId: input.versionId,
      contentDigestSha256: input.digest,
    },
    installedAt: input.installedAt,
    label: input.label,
  });
}

async function insertTeamTemplateApplication(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  const store = new TeamTemplateApplicationSqliteStore(executor, {
    now: () => now as IsoUtcTimestamp,
  });
  await store.applyAtomically({
    applicationId: "019f9f4a-b3c7-7350-9226-000000000150",
    tenantId: "019f9f4a-b3c7-7350-9226-000000000151",
    teamId: "019f9f4a-b3c7-7350-9226-000000000152",
    projectId: BACKUP_PROJECT_ID,
    templateId: "019f9f4a-b3c7-7350-9226-000000000153",
    templateRevision: 2,
    versionId: "019f9f4a-b3c7-7350-9226-000000000154",
    versionNumber: 1,
    contentDigest: "a".repeat(64),
    expectedProjectRevision: 1,
    cloudIdempotencyKey: "maintenance.team-template.apply.0001",
    requestedByMembershipId: "019f9f4a-b3c7-7350-9226-000000000155",
    payload: {
      projectSettings: [{ key: "genre", value: "mystery" }],
      promptRegistryRefs: [
        {
          registryId: "019f9f4a-b3c7-7350-9226-000000000156",
          revision: 1,
        },
      ],
      promptRules: [
        {
          ruleId: "019f9f4a-b3c7-7350-9226-000000000157",
          label: "Voice",
          instruction: "Keep the restored template rule.",
        },
      ],
      reviewChecklist: [
        {
          itemId: "019f9f4a-b3c7-7350-9226-000000000158",
          label: "Continuity checked",
          required: true,
        },
      ],
    },
  });
}

async function insertGovernedExtensionMetadata(executor: NodeSqliteExecutor): Promise<void> {
  const chapterId = "019f9f4a-b3c7-7350-9226-000000000201";
  const versionId = "019f9f4a-b3c7-7350-9226-000000000202";
  const checksum = "1".repeat(64);
  const now = "2026-07-27T00:00:00.000Z";
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision, current_version_id,
         created_at, updated_at, trashed_at
       ) VALUES (?, ?, '备份章节', '备份源正文', 'active', 1, ?, ?, ?, NULL)`,
      [chapterId, BACKUP_PROJECT_ID, versionId, now, now],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, '备份源正文', ?, 'created', NULL, ?)`,
      [versionId, BACKUP_PROJECT_ID, chapterId, checksum, now],
    );
  });

  const clock: Clock = {
    now: () => now as IsoUtcTimestamp,
  };
  const store = new GovernedCreativeExtensionSqliteStore(executor, clock);
  await store.configureBudget({
    projectId: BACKUP_PROJECT_ID,
    monthKey: "2026-07",
    currency: "USD",
    limitMicros: 10_000,
    maximumConcurrent: 1,
  });
  const snapshot: GovernedExtensionRequestSnapshot = {
    schemaVersion: 1,
    kind: "short_drama",
    projectId: BACKUP_PROJECT_ID,
    chapterId,
    sourceVersionId: versionId,
    sourceChecksum: checksum,
    sourceText: "备份源正文",
    settings: {
      format: "vertical_micro_drama",
      targetEpisodeCount: 1,
      targetEpisodeDurationSeconds: 60,
      tone: "suspense",
    },
    provider: {
      location: "loopback",
      providerId: "maintenance-local",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "maintenance-screenplay",
    },
    dataCategories: ["chapter_text", "short_drama_settings"],
    pricing: {
      inputMicrosPerMillionTokens: 1_000,
      outputMicrosPerMillionTokens: 2_000,
      currency: "USD",
      priceVersion: "maintenance-price-1",
      priceUpdatedAt: now,
    },
    limits: {
      maximumInputTokens: 1_000,
      maximumOutputTokens: 1_000,
      timeoutMs: 30_000,
    },
  };
  const requestFingerprint = await computeGovernedExtensionRequestFingerprint(snapshot);
  const request = await store.startRequest({
    id: "maintenance-request-drama",
    idempotencyKey: "maintenance-drama-1",
    requestFingerprint,
    snapshot,
    reservedCostMicros: calculateMaximumCostMicros(snapshot),
    monthKey: "2026-07",
    auditEventId: "maintenance-audit-start",
    correlationId: "maintenance-correlation",
  });
  const payloadJson = JSON.stringify({
    schemaVersion: 1,
    kind: "short_drama",
    source: {
      chapterId,
      sourceVersionId: versionId,
      sourceChecksum: checksum,
    },
    title: "备份短剧",
    format: "vertical_micro_drama",
    episodes: [],
  });
  const payloadChecksum = await sha256Text(payloadJson);
  await store.completeRequest({
    requestId: request.request.id,
    expectedRevision: request.request.revision,
    candidateId: "maintenance-candidate-drama",
    payloadJson,
    payloadChecksum,
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: null,
    },
    auditEventId: "maintenance-audit-publish",
    correlationId: "maintenance-correlation",
  });
  await store.acceptCandidate({
    candidateId: "maintenance-candidate-drama",
    expectedRevision: 1,
    formalOutputId: "maintenance-formal-drama",
    auditEventId: "maintenance-audit-accept",
    correlationId: "maintenance-correlation",
  });
}

async function sha256Text(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function insertSyncAndAccessMetadata(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO sync_tombstones (
      project_id,
      object_type,
      object_id,
      object_generation,
      deleted_by_device_id,
      vector_json,
      deleted_at,
      retain_until,
      acknowledged_device_ids_json,
      updated_at
    ) VALUES (?, 'chapter_version', ?, 1, ?, ?, ?, ?, '[]', ?)`,
    [
      BACKUP_PROJECT_ID,
      BACKUP_OBJECT_ID,
      BACKUP_DEVICE_ID,
      JSON.stringify({ [BACKUP_DEVICE_ID]: 1 }),
      now,
      "2027-07-27T00:00:00.000Z",
      now,
    ],
  );
  await executor.execute(
    `INSERT INTO cloud_account_snapshots (
      account_id,
      schema_version,
      state,
      revision,
      verified_at,
      deletion_scheduled_for,
      created_at,
      updated_at
    ) VALUES (?, 1, 'active', 2, ?, NULL, ?, ?)`,
    [BACKUP_ACCOUNT_ID, now, now, now],
  );
  await executor.execute(
    `INSERT INTO entitlement_cache (
      account_id,
      tier,
      subscription_state,
      granted_capabilities_json,
      enabled_flags_json,
      observed_at
    ) VALUES (?, 'pro', 'active', ?, ?, ?)`,
    [BACKUP_ACCOUNT_ID, JSON.stringify(["sync.e2ee"]), JSON.stringify(["sync.e2ee"]), now],
  );
}

async function insertModelProfile(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO model_profiles (
      provider_id,
      provider,
      base_url,
      authentication,
      selected_model,
      revision,
      created_at,
      updated_at
    ) VALUES ('openai', 'open_ai_compatible', 'https://api.openai.com/v1', 'bearer_keyring', 'gpt-test', 1, ?, ?)`,
    [now, now],
  );
}

async function insertModelHubExpertConnection(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, base_url,
       credential_ref, credential_state, authentication_mode,
       credential_header_name, model_discovery_path, text_generation_path,
       embedding_path, request_timeout_ms, retry_limit, enabled,
       revision, created_at, updated_at
     ) VALUES (
       'maintenance-custom-model', 'custom_openai_compatible', 'Maintenance custom model',
       'openai_compatible', 'https://models.example.test/v1',
       'keyring:model-hub:maintenance-custom-model', 'present', 'custom_header_keyring',
       'x-api-key', '/catalog/models', '/text/chat', '/vectors/embed',
       47000, 2, 1, 1, ?, ?
     )`,
    [now, now],
  );
}

async function insertProjectKeyMetadata(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  const envelopeId = "019f9f4a-b3c7-7350-9226-000000000104";
  const recoveryId = "019f9f4a-b3c7-7350-9226-000000000105";
  await executor.execute(
    `INSERT INTO device_public_key_records (
       device_id, account_id, schema_version, algorithm, public_key,
        public_key_fingerprint, display_name, key_origin, state,
        created_at, updated_at, revoked_at
      ) VALUES (?, ?, 1, 'DHKEM-P256-HKDF-SHA256', ?, ?, ?,
        'local_os_credential', 'trusted', ?, ?, NULL)`,
    [BACKUP_DEVICE_ID, BACKUP_ACCOUNT_ID, "A".repeat(87), "a".repeat(64), "主力写作设备", now, now],
  );
  await executor.execute(
    `INSERT INTO project_key_versions (
       project_id, key_version, schema_version, algorithm, state,
       revision, created_at, retired_at
     ) VALUES (?, 1, 1, 'AES-256-GCM', 'active', 2, ?, NULL)`,
    [BACKUP_PROJECT_ID, now],
  );
  await executor.execute(
    `INSERT INTO cloud_project_key_checkpoints (
       project_id, current_key_version, server_revision, updated_at
     ) VALUES (?, 1, 1, ?)`,
    [BACKUP_PROJECT_ID, now],
  );
  await executor.execute(
    `INSERT INTO team_project_key_receipts (
       native_storage_ref, schema_version, receipt_kind, team_id, project_id,
       key_version, account_id, device_id, envelope_id, membership_id,
       membership_revision, assignment_id, assignment_revision, sender_device_id,
       sender_public_key_fingerprint, recipient_public_key_fingerprint,
       project_key_fingerprint, native_receipt_fingerprint, current_server_revision,
       current_key_updated_at, envelope_created_at, state, received_at,
       last_verified_at, state_updated_at
     ) VALUES (?, 1, 'team_managed_device_envelope', ?, ?, 1, ?, ?, ?, ?, 1, ?, 1, ?,
       ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?, ?)`,
    [
      `team_project_key_receipt_v1_${"b".repeat(64)}`,
      "019f9f4a-b3c7-7350-9226-000000000106",
      BACKUP_PROJECT_ID,
      BACKUP_ACCOUNT_ID,
      BACKUP_DEVICE_ID,
      "019f9f4a-b3c7-7350-9226-000000000107",
      "019f9f4a-b3c7-7350-9226-000000000108",
      "019f9f4a-b3c7-7350-9226-000000000109",
      BACKUP_DEVICE_ID,
      "c".repeat(64),
      "a".repeat(64),
      "d".repeat(64),
      "e".repeat(64),
      now,
      now,
      now,
      now,
      now,
    ],
  );
  await executor.execute(
    `INSERT INTO project_device_key_envelopes (
       envelope_id, project_id, key_version, schema_version, algorithm,
       sender_device_id, sender_public_key, sender_public_key_fingerprint,
       recipient_device_id, recipient_public_key, recipient_public_key_fingerprint,
       encapsulated_key, ciphertext, created_at, revoked_at
     ) VALUES (?, ?, 1, 1, 'HPKE-AUTH-P256-HKDF-SHA256-AES128GCM',
       ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      envelopeId,
      BACKUP_PROJECT_ID,
      BACKUP_DEVICE_ID,
      "A".repeat(87),
      "a".repeat(64),
      BACKUP_DEVICE_ID,
      "A".repeat(87),
      "a".repeat(64),
      "B".repeat(87),
      "C".repeat(64),
      now,
    ],
  );
  await executor.execute(
    `INSERT INTO project_recovery_key_envelopes (
       recovery_id, project_id, key_version, schema_version, algorithm,
       kdf_algorithm, kdf_version, memory_kib, time_cost, parallelism,
       output_bytes, salt, nonce, ciphertext, verifier, status,
       created_at, confirmed_at, revoked_at
     ) VALUES (?, ?, 1, 1, 'ARGON2ID-AES256GCM',
       'ARGON2ID', 19, 65536, 3, 4, 64, ?, ?, ?, ?,
       'confirmed', ?, ?, NULL)`,
    [
      recoveryId,
      BACKUP_PROJECT_ID,
      "D".repeat(22),
      "E".repeat(16),
      "F".repeat(64),
      "G".repeat(43),
      now,
      now,
    ],
  );
}

async function insertSearchSnapshot(
  executor: NodeSqliteExecutor,
  searchText: string,
): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO search_index_state (
       project_id, document_count, content_characters, indexed_at, updated_at
     ) VALUES (?, 1, ?, ?, ?)`,
    [BACKUP_PROJECT_ID, searchText.length, now, now],
  );
  await executor.execute(
    `INSERT INTO search_index_documents (
       project_id, document_id, source_type, source_id, source_version_id,
       title, search_text, normalized_title, normalized_search_text,
       content_hash, source_updated_at, indexed_at
     ) VALUES (?, ?, 'chapter', ?, ?, '第一章', ?, '第一章', ?, ?, ?, ?)`,
    [
      BACKUP_PROJECT_ID,
      `chapter:${BACKUP_OBJECT_ID}:0`,
      BACKUP_OBJECT_ID,
      `${BACKUP_OBJECT_ID}:version`,
      searchText,
      searchText,
      "a".repeat(64),
      now,
      now,
    ],
  );
}

async function insertGraphProjectionState(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO graph_rag_projection_state (
       project_id, revision, status, source_version_count, entity_count,
       relation_count, evidence_count, updated_at
     ) VALUES (?, 1, 'ready', 0, 0, 0, 0, ?)`,
    [BACKUP_PROJECT_ID, "2026-07-27T00:00:00.000Z"],
  );
}

async function insertVectorProjection(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO search_vector_index_state (
       project_id, generation, model_id, dimension, status, last_rebuilt_at, updated_at
     ) VALUES (?, 1, 'embed-local-v1', 2, 'ready', ?, ?)`,
    [BACKUP_PROJECT_ID, now, now],
  );
  await executor.execute(
    `INSERT INTO search_vector_embeddings (
       project_id, document_id, source_version_id, content_hash, model_id,
       dimension, vector_blob, vector_norm, indexed_at
     ) VALUES (?, ?, ?, ?, 'embed-local-v1', 2, ?, 1, ?)`,
    [
      BACKUP_PROJECT_ID,
      `chapter:${BACKUP_OBJECT_ID}:0`,
      `${BACKUP_OBJECT_ID}:version`,
      "a".repeat(64),
      Uint8Array.from([0, 0, 128, 63, 0, 0, 0, 0]),
      now,
    ],
  );
}
