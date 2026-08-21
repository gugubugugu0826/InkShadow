import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY,
  NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH,
  deriveIdeaProjectSeed,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type Clock,
  type IsoUtcTimestamp,
} from "@inkshadow/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  GovernedCreativeExtensionSqliteStore,
  calculateMaximumCostMicros,
  computeGovernedExtensionRequestFingerprint,
  type GovernedExtensionRequestSnapshot,
} from "../src/governed-creative-extension-sqlite-store.js";
import { DatabaseMaintenanceService } from "../src/maintenance.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { TeamTemplateApplicationSqliteStore } from "../src/team-template-application-sqlite-store.js";
import type { SqlPrimitive, TransactionExecutor } from "../src/executor.js";
import { fileSqliteIt, NodeSqliteExecutor } from "./node-sqlite-executor.js";

const backupPath = path.join(tmpdir(), `inkshadow-maintenance-${process.pid}.db`);
const incompatibleBackupPath = path.join(
  tmpdir(),
  `inkshadow-maintenance-incompatible-${process.pid}.db`,
);
const corruptedBackupPath = path.join(
  tmpdir(),
  `inkshadow-maintenance-corrupted-${process.pid}.db`,
);
const historicalV73BackupPath = path.join(tmpdir(), `inkshadow-maintenance-v73-${process.pid}.db`);
const capabilityProbeInvocationLedgerMigration = readFileSync(
  new URL("../migrations/0071_model_capability_probe_invocation_ledger.sql", import.meta.url),
  "utf8",
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
  readFileSync(new URL("../migrations/0019_cloud_deletion_journal.sql", import.meta.url), "utf8"),
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
  readFileSync(new URL("../migrations/0030_creative_journeys.sql", import.meta.url), "utf8"),
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
  readFileSync(new URL("../migrations/0038_private_chapters.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0039_project_seeds.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0040_chapter_validation_snapshots.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0041_story_planning_selective_acceptance.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0042_chapter_validation_snapshot_delete_cascade.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0043_story_fact_entity_alias_resolution.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0044_story_planning_selective_acceptance_intent.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0045_project_remote_dispatch_leases.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0046_model_hub_zhipu_glm.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0047_context_compilation_exact_provenance.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0048_candidate_application_intents.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0049_memory_governance_audit.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0050_candidate_revision_authority.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0051_model_hub_connection_commits.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0052_continuous_story_state_route_receipts.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0053_writing_feedback_learning_policy_context.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0054_writing_feedback_explicit_idempotency.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL(
      "../migrations/0055_continuous_story_state_historical_route_receipts.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0056_model_hub_failure_diagnostics.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0057_model_hub_content_quality_task.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0058_story_settings_import_receipts.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0059_generation_preflight_cost_status.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0060_novel_skill_registry.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0061_novel_skill_evaluation_ledger.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0062_project_dispatch_active_guard.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0063_novel_skill_evaluation_paid_runner.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0064_novel_skill_evaluation_predispatch_authority.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0065_model_invocation_dispatch_boundary.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0066_writing_experience_preferences.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0067_consistency_investigation_agent.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0068_writing_disclosure_active_grant_limit.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL(
      "../migrations/0069_consistency_investigation_invocation_reservation.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0070_multigranular_search_retrieval.sql", import.meta.url),
    "utf8",
  ),
  capabilityProbeInvocationLedgerMigration,
].join("\n");
const inkShadowMigrationV73 = inkShadowMigration.replace(
  capabilityProbeInvocationLedgerMigration,
  "",
);
const BACKUP_PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const BACKUP_ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const BACKUP_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const BACKUP_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000103";
const BACKUP_FINE_TUNING_DATASET_ID = "maintenance-fine-tuning-dataset";
const BACKUP_FINE_TUNING_JOB_ID = "maintenance-fine-tuning-job";
const BACKUP_FINE_TUNING_ARTIFACT_ID = "maintenance-fine-tuning-artifact";
const BACKUP_MARKETPLACE_ARTIFACT_ID = "maintenance-marketplace-artifact";
const BACKUP_RETIRED_MODEL_CONNECTION_ID = "maintenance-retired-model";
const BACKUP_CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000201";
const BACKUP_CHAPTER_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000202";
const BACKUP_CURRENT_CHAPTER_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000203";
const BACKUP_VALIDATION_SNAPSHOT_IDS = [
  "019f9f4a-b3c7-7350-9226-000000000211",
  "019f9f4a-b3c7-7350-9226-000000000212",
  "019f9f4a-b3c7-7350-9226-000000000213",
] as const;
const BACKUP_JOURNEY_ID = "019f9f4a-b3c7-7350-9226-000000000301";
const BACKUP_STORY_SETTINGS_IMPORT_RECEIPT_ID = "019f9f4a-b3c7-7350-9226-000000000304";
const BACKUP_JOURNEY_TURN_ID = "019f9f4a-b3c7-7350-9226-000000000302";
const BACKUP_PLANNING_CANDIDATE_ID = "019f9f4a-b3c7-7350-9226-000000000303";
const BACKUP_MEMORY_ID = "019f9f4a-b3c7-7350-9226-000000000311";
const BACKUP_MEMORY_GOVERNANCE_EVENT_ID = "019f9f4a-b3c7-7350-9226-000000000312";
const BACKUP_DELETION_JOURNAL_ID = "019f9f4a-b3c7-7350-9226-000000000401";
const BACKUP_DELETION_MUTATION_ID = "019f9f4a-b3c7-7350-9226-000000000402";
const BACKUP_DELETION_REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000403";
const BACKUP_DELETION_CONFIRMATION_ID = "019f9f4a-b3c7-7350-9226-000000000404";

afterEach(() => {
  rmSync(backupPath, { force: true });
  rmSync(incompatibleBackupPath, { force: true });
  rmSync(corruptedBackupPath, { force: true });
  rmSync(historicalV73BackupPath, { force: true });
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

  fileSqliteIt("creates a standalone consistent backup without overwriting", async () => {
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

  fileSqliteIt("withholds a verified receipt when backup schema verification fails", async () => {
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

  fileSqliteIt(
    "restores a populated version 73 backup after the capability ledger migration",
    async () => {
      const historical = new NodeSqliteExecutor(inkShadowMigrationV73, historicalV73BackupPath);
      await insertHistoricalV73CapabilityRestoreScenario(historical);
      await expect(
        historical.select<{ readonly name: string }>(
          `SELECT name
           FROM pragma_table_info('model_capability_scans')
           WHERE name = 'model_invocation_id'`,
        ),
      ).resolves.toEqual([]);
      await historical.close();

      const current = new RestoreFailureCapturingExecutor(inkShadowMigration);
      const service = new DatabaseMaintenanceService(current);

      const restored = await service.restoreConsistentBackup(historicalV73BackupPath);
      if (!restored.ok && current.lastFailure !== null) throw current.lastFailure;
      expect(restored).toEqual({
        ok: true,
        value: {
          sourceKind: "user_selected_file",
          integrityVerified: true,
          restoredTableCount: 172,
        },
      });
      await expect(
        current.select<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM pragma_foreign_key_check",
        ),
      ).resolves.toEqual([{ count: 0 }]);
      await expect(
        current.select<{
          readonly projectName: string;
          readonly chapterContent: string;
          readonly currentVersionId: string;
          readonly versionContent: string;
          readonly candidateContent: string;
          readonly candidateStatus: string;
          readonly taskStatus: string;
          readonly invocationStatus: string;
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly scanStatus: string;
          readonly modelInvocationId: string | null;
        }>(
          `SELECT project.name AS projectName,
                  chapter.content AS chapterContent,
                  chapter.current_version_id AS currentVersionId,
                  version.content AS versionContent,
                  candidate.content AS candidateContent,
                  candidate.status AS candidateStatus,
                  task.status AS taskStatus,
                  invocation.status AS invocationStatus,
                  invocation.input_tokens AS inputTokens,
                  invocation.output_tokens AS outputTokens,
                  scan.status AS scanStatus,
                  scan.model_invocation_id AS modelInvocationId
           FROM projects AS project
           INNER JOIN chapters AS chapter ON chapter.project_id = project.id
           INNER JOIN chapter_versions AS version ON version.id = chapter.current_version_id
           INNER JOIN ai_candidates AS candidate ON candidate.chapter_id = chapter.id
           INNER JOIN background_tasks AS task
             ON task.id = 'maintenance-v73-background-task'
           INNER JOIN model_invocation_facts AS invocation
             ON invocation.id = 'maintenance-v73-invocation'
           INNER JOIN model_capability_scans AS scan
             ON scan.id = 'maintenance-v73-scan'
           WHERE project.id = '019f9f4a-b3c7-7350-9226-000000000071'`,
        ),
      ).resolves.toEqual([
        {
          projectName: "七十三版恢复项目",
          chapterContent: "七十三版正文必须原样恢复。",
          currentVersionId: "019f9f4a-b3c7-7350-9226-000000000073",
          versionContent: "七十三版正文必须原样恢复。",
          candidateContent: "隔离中的 AI 建议草稿",
          candidateStatus: "ready",
          taskStatus: "succeeded",
          invocationStatus: "succeeded",
          inputTokens: 17,
          outputTokens: 4,
          scanStatus: "succeeded",
          modelInvocationId: null,
        },
      ]);
      await current.close();
    },
  );

  fileSqliteIt("restores a historical story-state receipt after its chapter advances", async () => {
    const executor = new NodeSqliteExecutor(inkShadowMigration);
    const service = new DatabaseMaintenanceService(executor);
    await insertProject(executor, BACKUP_PROJECT_ID, "历史回执恢复项目");
    await insertHistoricalContinuousStoryStateReceiptScenario(executor);
    expect(await service.createConsistentBackup(backupPath)).toMatchObject({ ok: true });
    await executor.execute("DELETE FROM continuous_story_state_route_receipts");

    expect(await service.restoreConsistentBackup(backupPath)).toMatchObject({ ok: true });
    await expect(
      executor.select<{ receiptVersionId: string; currentVersionId: string }>(
        `SELECT receipt.version_id AS receiptVersionId,
                chapter.current_version_id AS currentVersionId
         FROM continuous_story_state_route_receipts AS receipt
         INNER JOIN chapters AS chapter
           ON chapter.id = receipt.chapter_id
          AND chapter.project_id = receipt.project_id
         WHERE receipt.project_id = ? AND receipt.chapter_id = ?`,
        [BACKUP_PROJECT_ID, BACKUP_CHAPTER_ID],
      ),
    ).resolves.toEqual([
      {
        receiptVersionId: BACKUP_CHAPTER_VERSION_ID,
        currentVersionId: BACKUP_CURRENT_CHAPTER_VERSION_ID,
      },
    ]);
    await executor.close();
  });

  fileSqliteIt("restores all supported tables from a healthy backup atomically", async () => {
    const executor = new NodeSqliteExecutor(inkShadowMigration);
    const service = new DatabaseMaintenanceService(executor);
    await insertProject(executor, BACKUP_PROJECT_ID, "备份中的项目");
    await executor.execute(
      `INSERT INTO writing_experience_preferences (
         scope, mode, initialization_source, direct_local_organization_authorized_at,
         revision, created_at, updated_at
       ) VALUES ('global', 'direct', 'new_install', ?, 1, ?, ?)`,
      ["2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"],
    );
    await executor.execute(
      `INSERT INTO writing_provider_disclosure_grants (
         fingerprint, task, provider_id, model_id, sent_scope, sent_scope_hash,
         call_count, retry_limit, cost_status, estimated_cost_micros, currency,
         privacy_policy, state, revision, created_at, updated_at
       ) VALUES (?, 'continuation', 'deepseek', 'deepseek-v4-flash',
         'chapter_and_selected_context', ?, 1, 0, 'unknown', NULL, NULL,
         'cloud_allowed', 'active', 1, ?, ?)`,
      ["e".repeat(64), "f".repeat(64), "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"],
    );
    await insertMemoryGovernanceAudit(executor);
    await insertApplyingStoryPlanningCandidate(executor);
    await insertCloudDeletionJournal(executor);
    await insertTeamTemplateApplication(executor);
    await insertGovernedExtensionMetadata(executor);
    await insertContinuousStoryStateRouteReceipt(executor);
    await insertChapterValidationSnapshots(executor);
    await executor.execute(
      "UPDATE chapters SET privacy_mode = 'local_only', privacy_revision = 2 WHERE id = ?",
      [BACKUP_CHAPTER_ID],
    );
    await insertCreativeJourney(executor);
    await insertProjectSeed(executor);
    await insertStorySettingsImportReceipt(executor);
    await insertCausalEventGraph(executor);
    await insertContextCompilationTrace(executor);
    await insertSyncAndAccessMetadata(executor);
    await insertProjectKeyMetadata(executor);
    await insertModelProfile(executor);
    await insertModelHubExpertConnection(executor);
    await insertConsistencyInvestigationBackup(executor);
    await insertRetiredModelHubConnection(executor);
    await insertNovelSkillBackupScenario(executor);
    await insertSearchSnapshot(executor, "备份中的派生索引");
    await insertVectorProjection(executor);
    await insertGraphProjectionState(executor);
    await setAuthoritativeStoryGraphCheckpoint(executor);
    await insertFineTuningGovernance(executor);
    await insertMarketplaceInstall(executor);
    await insertUnifiedStoryFact(executor);
    await insertWritingFeedbackLearning(executor);
    await executor.execute(
      `INSERT INTO project_remote_dispatch_leases (
         lease_id, project_id, operation_kind, operation_id, owner_runtime_id,
         authority_fingerprint, acquired_at, network_deadline_at
       ) VALUES (?, ?, 'generation', 'crashed-operation', 'previous-runtime-owner', ?, ?, ?)`,
      [
        "019f9f4a-b3c7-7350-9226-000000000901",
        "019f9f4a-b3c7-7350-9226-000000000902",
        "a".repeat(64),
        "2026-07-27T00:00:00.000Z",
        "2026-07-27T00:12:00.000Z",
      ],
    );
    const backup = await service.createConsistentBackup(backupPath);
    expect(backup.ok).toBe(true);
    const backupInspection = new NodeSqliteExecutor("", backupPath);
    await expect(
      backupInspection.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_remote_dispatch_leases",
      ),
    ).resolves.toEqual([{ count: 1 }]);
    await backupInspection.close();
    await executor.execute("DELETE FROM project_remote_dispatch_leases");
    await executor.execute(
      `UPDATE writing_experience_preferences
       SET mode = 'professional', initialization_source = 'user', revision = 2,
           updated_at = '2026-07-27T00:01:00.000Z'
       WHERE scope = 'global' AND revision = 1`,
    );
    await executor.execute(
      `UPDATE writing_provider_disclosure_grants
       SET state = 'revoked', revision = 2,
           updated_at = '2026-07-27T00:01:00.000Z',
           revoked_at = '2026-07-27T00:01:00.000Z'
       WHERE fingerprint = ? AND revision = 1`,
      ["e".repeat(64)],
    );
    await executor.execute("DELETE FROM continuous_story_state_route_receipts");
    await executor.execute("DELETE FROM story_settings_import_receipts");
    await executor.execute("DELETE FROM story_memory_governance_events");
    await executor.execute(
      "UPDATE chapters SET privacy_mode = 'standard', privacy_revision = 3 WHERE id = ?",
      [BACKUP_CHAPTER_ID],
    );
    await executor.execute(
      `UPDATE story_planning_candidates
       SET selective_acceptance_intent_json = NULL, revision = 3,
           updated_at = '2026-07-27T00:01:00.000Z'
       WHERE id = ?`,
      [BACKUP_PLANNING_CANDIDATE_ID],
    );
    await executor.execute("DELETE FROM chapter_validation_snapshots");
    await executor.execute(
      "UPDATE creative_journeys SET snapshot_json = ?, revision = 2 WHERE id = ?",
      [JSON.stringify({ idea: "changed-after-backup" }), BACKUP_JOURNEY_ID],
    );
    const changedProjectSeed = createMaintenanceProjectSeed(
      "changed-after-backup",
      "2026-07-27T00:01:00.000Z",
    );
    await executor.execute(
      `UPDATE project_seeds
       SET payload_json = ?, revision = 2, updated_at = ?
       WHERE project_id = ?`,
      [JSON.stringify(changedProjectSeed), changedProjectSeed.updatedAt, BACKUP_PROJECT_ID],
    );
    await executor.execute("DELETE FROM creative_journey_turns WHERE journey_id = ?", [
      BACKUP_JOURNEY_ID,
    ]);
    await executor.execute(
      "UPDATE cloud_deletion_journals SET recovery_action = 'none' WHERE journal_id = ?",
      [BACKUP_DELETION_JOURNAL_ID],
    );
    await executor.execute(
      `UPDATE authoritative_story_graph_state
       SET authority_epoch = 8
       WHERE project_id = ?`,
      [BACKUP_PROJECT_ID],
    );
    await executor.execute("DELETE FROM consistency_investigation_runs");
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
      `UPDATE model_provider_connections
       SET credential_ref = 'keyring:model-hub:unsafe-reactivation',
           credential_state = 'present', connection_status = 'ready',
           last_error_code = NULL, enabled = 1
       WHERE id = ?`,
      [BACKUP_RETIRED_MODEL_CONNECTION_ID],
    );
    await executor.execute(
      "DELETE FROM model_hub_connection_commits WHERE connection_id = 'maintenance-custom-model'",
    );
    await executor.execute(
      `UPDATE model_capability_scans
       SET finish_reason = 'changed', visible_content_length = 99,
           requested_max_output_tokens = 128
       WHERE id = 'maintenance-failed-probe'`,
    );
    await executor.execute(
      `UPDATE model_invocation_facts
       SET http_status = 502, failure_retryable = 1,
           requested_max_output_tokens = 256
       WHERE id = 'maintenance-failed-invocation'`,
    );
    await executor.execute(
      "DELETE FROM model_capability_evidence WHERE id = 'maintenance-audited-probe-evidence'",
    );
    await executor.execute(
      "DELETE FROM model_capability_scans WHERE id = 'maintenance-audited-probe'",
    );
    await executor.execute(
      "DELETE FROM model_invocation_facts WHERE id = 'maintenance-audited-probe-invocation'",
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
    await executor.execute("DELETE FROM novel_skill_invocation_items WHERE snapshot_id = ?", [
      "019f9f4a-b3c7-7350-9226-000000000753",
    ]);
    await executor.execute("DELETE FROM novel_skill_invocation_snapshots WHERE id = ?", [
      "019f9f4a-b3c7-7350-9226-000000000753",
    ]);
    await executor.execute("DELETE FROM project_novel_skill_bindings");
    await executor.execute(
      "DELETE FROM novel_skill_definitions WHERE skill_id = 'core.maintenance'",
    );
    const restored = await service.restoreConsistentBackup(backupPath);

    expect(restored).toEqual({
      ok: true,
      value: {
        sourceKind: "user_selected_file",
        integrityVerified: true,
        restoredTableCount: 172,
      },
    });
    await expect(
      executor.select<{ count: number }>("SELECT COUNT(*) AS count FROM pragma_foreign_key_check"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{
        invocationId: string;
        task: string;
        status: string;
        inputTokens: number;
        outputTokens: number;
        estimatedCostMicros: string | null;
        scanId: string;
        evidenceCount: number;
      }>(
        `SELECT invocation.id AS invocationId, invocation.task, invocation.status,
                invocation.input_tokens AS inputTokens,
                invocation.output_tokens AS outputTokens,
                invocation.estimated_cost_micros AS estimatedCostMicros,
                scan.id AS scanId,
                (SELECT COUNT(*) FROM model_capability_evidence AS evidence
                  WHERE evidence.scan_id = scan.id) AS evidenceCount
         FROM model_invocation_facts AS invocation
         INNER JOIN model_capability_scans AS scan
           ON scan.model_invocation_id = invocation.id
         WHERE invocation.id = 'maintenance-audited-probe-invocation'`,
      ),
    ).resolves.toEqual([
      {
        invocationId: "maintenance-audited-probe-invocation",
        task: "capability_probe",
        status: "succeeded",
        inputTokens: 7,
        outputTokens: 1,
        estimatedCostMicros: null,
        scanId: "maintenance-audited-probe",
        evidenceCount: 1,
      },
    ]);
    await expect(
      executor.select<{
        readonly mode: string;
        readonly preferenceRevision: number;
        readonly directAuthorization: string | null;
        readonly grantState: string;
        readonly grantRevision: number;
      }>(
        `SELECT
           preference.mode AS mode,
           preference.revision AS preferenceRevision,
           preference.direct_local_organization_authorized_at AS directAuthorization,
           grant.state AS grantState,
           grant.revision AS grantRevision
         FROM writing_experience_preferences AS preference
         CROSS JOIN writing_provider_disclosure_grants AS grant
         WHERE preference.scope = 'global' AND grant.fingerprint = ?`,
        ["e".repeat(64)],
      ),
    ).resolves.toEqual([
      {
        mode: "direct",
        preferenceRevision: 1,
        directAuthorization: "2026-07-27T00:00:00.000Z",
        grantState: "active",
        grantRevision: 1,
      },
    ]);
    await expect(
      executor.select<{
        readonly definitionCount: number;
        readonly bindingCount: number;
        readonly snapshotCount: number;
        readonly itemCount: number;
      }>(
        `SELECT
           (SELECT count(*) FROM novel_skill_definitions) AS definitionCount,
           (SELECT count(*) FROM project_novel_skill_bindings) AS bindingCount,
           (SELECT count(*) FROM novel_skill_invocation_snapshots) AS snapshotCount,
           (SELECT count(*) FROM novel_skill_invocation_items) AS itemCount`,
      ),
    ).resolves.toEqual([{ definitionCount: 3, bindingCount: 1, snapshotCount: 2, itemCount: 2 }]);
    await expect(
      executor.select<{
        readonly runCount: number;
        readonly stepCount: number;
        readonly findingCount: number;
        readonly evidenceCount: number;
      }>(
        `SELECT
           (SELECT count(*) FROM consistency_investigation_runs) AS runCount,
           (SELECT count(*) FROM consistency_investigation_steps) AS stepCount,
           (SELECT count(*) FROM consistency_investigation_findings) AS findingCount,
           (SELECT count(*) FROM consistency_investigation_evidence) AS evidenceCount`,
      ),
    ).resolves.toEqual([{ runCount: 1, stepCount: 7, findingCount: 1, evidenceCount: 1 }]);
    await expect(
      executor.select<{
        readonly suites: number;
        readonly fixtures: number;
        readonly runs: number;
        readonly attempts: number;
        readonly succeededAttempts: number;
        readonly observations: number;
        readonly scores: number;
        readonly decisions: number;
        readonly evaluationCandidates: number;
      }>(
        `SELECT
           (SELECT count(*) FROM novel_skill_evaluation_suites) AS suites,
           (SELECT count(*) FROM novel_skill_evaluation_fixtures) AS fixtures,
           (SELECT count(*) FROM novel_skill_evaluation_runs) AS runs,
           (SELECT count(*) FROM novel_skill_evaluation_attempts) AS attempts,
           (SELECT count(*) FROM novel_skill_evaluation_attempts
             WHERE status = 'succeeded') AS succeededAttempts,
           (SELECT count(*) FROM novel_skill_evaluation_observations) AS observations,
           (SELECT count(*) FROM novel_skill_evaluation_scores) AS scores,
           (SELECT count(*) FROM novel_skill_evaluation_manual_decisions) AS decisions,
           (SELECT count(*) FROM ai_candidates
             WHERE project_id = '019f9f4a-b3c7-7350-9226-000000000760') AS evaluationCandidates`,
      ),
    ).resolves.toEqual([
      {
        suites: 1,
        fixtures: 12,
        runs: 1,
        attempts: 1,
        succeededAttempts: 1,
        observations: 1,
        scores: 13,
        decisions: 1,
        evaluationCandidates: 1,
      },
    ]);
    await expect(
      executor.execute("DELETE FROM novel_skill_evaluation_manual_decisions"),
    ).rejects.toThrow(/cannot be deleted/iu);
    await expect(
      executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_remote_dispatch_leases",
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ operation: string; requestJson: string; afterJson: string }>(
        `SELECT operation, request_json AS requestJson, after_snapshot_json AS afterJson
         FROM story_memory_governance_events WHERE id = ?`,
        [BACKUP_MEMORY_GOVERNANCE_EVENT_ID],
      ),
    ).resolves.toEqual([
      {
        operation: "forget_project",
        requestJson: JSON.stringify({
          operation: "forget_project",
          projectId: BACKUP_PROJECT_ID,
        }),
        afterJson: JSON.stringify({ records: [{ id: BACKUP_MEMORY_ID, excluded: true }] }),
      },
    ]);
    await expect(
      executor.select<{ phase: string; cleanupCredentialProviderId: string }>(
        `SELECT phase,
                cleanup_credential_provider_id AS cleanupCredentialProviderId
         FROM model_hub_connection_commits
         WHERE connection_id = 'maintenance-custom-model'`,
      ),
    ).resolves.toEqual([
      { phase: "cleanup_pending", cleanupCredentialProviderId: "maintenance-old-slot" },
    ]);
    await expect(
      executor.select<{
        id: string;
        finishReason: string;
        visibleContentLength: number;
        requestedMaxOutputTokens: number;
      }>(
        `SELECT id, finish_reason AS finishReason,
                visible_content_length AS visibleContentLength,
                requested_max_output_tokens AS requestedMaxOutputTokens
         FROM model_capability_scans
         WHERE id = 'maintenance-failed-probe'`,
      ),
    ).resolves.toEqual([
      {
        id: "maintenance-failed-probe",
        finishReason: "length",
        visibleContentLength: 0,
        requestedMaxOutputTokens: 64,
      },
    ]);
    await expect(
      executor.select<{
        id: string;
        httpStatus: number;
        retryable: number;
        requestedMaxOutputTokens: number;
      }>(
        `SELECT id, http_status AS httpStatus,
                failure_retryable AS retryable,
                requested_max_output_tokens AS requestedMaxOutputTokens
         FROM model_invocation_facts
         WHERE id = 'maintenance-failed-invocation'`,
      ),
    ).resolves.toEqual([
      {
        id: "maintenance-failed-invocation",
        httpStatus: 504,
        retryable: 0,
        requestedMaxOutputTokens: 512,
      },
    ]);
    await expect(
      executor.select<{ privacyMode: string; privacyRevision: number }>(
        `SELECT privacy_mode AS privacyMode, privacy_revision AS privacyRevision
         FROM chapters WHERE id = ?`,
        [BACKUP_CHAPTER_ID],
      ),
    ).resolves.toEqual([{ privacyMode: "local_only", privacyRevision: 2 }]);
    await expect(
      executor.select<{ revision: number; intentJson: string | null }>(
        `SELECT revision, selective_acceptance_intent_json AS intentJson
         FROM story_planning_candidates WHERE id = ?`,
        [BACKUP_PLANNING_CANDIDATE_ID],
      ),
    ).resolves.toEqual([
      {
        revision: 2,
        intentJson: maintenancePlanningAcceptanceIntentJson(),
      },
    ]);
    await expect(
      executor.select<{
        readonly id: string;
        readonly runSequence: number;
        readonly supersedesSnapshotId: string | null;
        readonly checksum: string;
        readonly resultJson: string;
      }>(
        `SELECT id,
                run_sequence AS runSequence,
                supersedes_snapshot_id AS supersedesSnapshotId,
                result_checksum_sha256 AS checksum,
                result_json AS resultJson
         FROM chapter_validation_snapshots
         ORDER BY run_sequence`,
      ),
    ).resolves.toEqual(
      BACKUP_VALIDATION_SNAPSHOT_IDS.map((id, index) => ({
        id,
        runSequence: index + 1,
        supersedesSnapshotId:
          index === 0 ? null : (BACKUP_VALIDATION_SNAPSHOT_IDS[index - 1] ?? null),
        checksum: String(index + 1).repeat(64),
        resultJson: maintenanceValidationResultJson(),
      })),
    );
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
      { name: "Internal Novel Skill evaluation fixture" },
    ]);
    await expect(
      executor.select<{ snapshotJson: string; revision: number; turnCount: number }>(
        `SELECT journey.snapshot_json AS snapshotJson, journey.revision,
                COUNT(turn.id) AS turnCount
         FROM creative_journeys AS journey
         LEFT JOIN creative_journey_turns AS turn ON turn.journey_id = journey.id
         WHERE journey.id = ?
         GROUP BY journey.id`,
        [BACKUP_JOURNEY_ID],
      ),
    ).resolves.toEqual([
      {
        snapshotJson: JSON.stringify({ idea: "backed-up-idea", step: "opening" }),
        revision: 1,
        turnCount: 1,
      },
    ]);
    const restoredProjectSeeds = await executor.select<{
      readonly payloadJson: string;
      readonly revision: number;
    }>(
      `SELECT payload_json AS payloadJson, revision
       FROM project_seeds WHERE project_id = ?`,
      [BACKUP_PROJECT_ID],
    );
    expect(restoredProjectSeeds).toHaveLength(1);
    expect(restoredProjectSeeds[0]?.revision).toBe(1);
    expect(JSON.parse(restoredProjectSeeds[0]?.payloadJson ?? "null")).toEqual(
      createMaintenanceProjectSeed("backed-up-project-seed", "2026-07-27T00:00:00.000Z"),
    );
    await expect(
      executor.select<{ id: string; status: string; sourceSha256: string }>(
        `SELECT id, status, source_sha256 AS sourceSha256
         FROM story_settings_import_receipts WHERE id = ?`,
        [BACKUP_STORY_SETTINGS_IMPORT_RECEIPT_ID],
      ),
    ).resolves.toEqual([
      {
        id: BACKUP_STORY_SETTINGS_IMPORT_RECEIPT_ID,
        status: "committed",
        sourceSha256: "8".repeat(64),
      },
    ]);
    await expect(
      executor.select<{ recoveryAction: string; mutationState: string }>(
        `SELECT journal.recovery_action AS recoveryAction,
                mutation.state AS mutationState
         FROM cloud_deletion_journals AS journal
         INNER JOIN cloud_deletion_mutations AS mutation
           ON mutation.journal_id = journal.journal_id
         WHERE journal.journal_id = ?`,
        [BACKUP_DELETION_JOURNAL_ID],
      ),
    ).resolves.toEqual([{ recoveryAction: "lookup", mutationState: "accepted" }]);
    await expect(
      executor.select<{
        authorityEpoch: number;
        projectedEpoch: number | null;
        projectedGraphRevision: number | null;
        projectionComplete: number | null;
        diagnosticsJson: string | null;
      }>(
        `SELECT authority_epoch AS authorityEpoch,
                projected_epoch AS projectedEpoch,
                projected_graph_revision AS projectedGraphRevision,
                projection_complete AS projectionComplete,
                diagnostics_json AS diagnosticsJson
         FROM authoritative_story_graph_state
         WHERE project_id = ?`,
        [BACKUP_PROJECT_ID],
      ),
    ).resolves.toEqual([
      {
        authorityEpoch: 7,
        projectedEpoch: null,
        projectedGraphRevision: null,
        projectionComplete: null,
        diagnosticsJson: null,
      },
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
      executor.select<{
        enabled: number;
        connectionStatus: string;
        credentialState: string;
        credentialRef: string | null;
        lastErrorCode: string | null;
      }>(
        `SELECT enabled, connection_status AS connectionStatus,
                credential_state AS credentialState, credential_ref AS credentialRef,
                last_error_code AS lastErrorCode
         FROM model_provider_connections
         WHERE id = ?`,
        [BACKUP_RETIRED_MODEL_CONNECTION_ID],
      ),
    ).resolves.toEqual([
      {
        enabled: 0,
        connectionStatus: "disabled",
        credentialState: "missing",
        credentialRef: null,
        lastErrorCode: "MODEL_HUB_CONNECTION_RETIRED",
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
      executor.select<{ task: string; sourceContentHash: string }>(
        `SELECT task, source_content_hash AS sourceContentHash
         FROM continuous_story_state_route_receipts
         WHERE project_id = ? AND chapter_id = ? AND version_id = ?`,
        [BACKUP_PROJECT_ID, BACKUP_CHAPTER_ID, BACKUP_CHAPTER_VERSION_ID],
      ),
    ).resolves.toEqual([{ task: "character_extraction", sourceContentHash: "1".repeat(64) }]);
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
        generationId: string;
      }>(
        `SELECT
           run.task_type AS taskType,
           entry.layer,
           entry.included,
           source.source_type AS sourceType,
           source.source_id AS sourceId,
           source.locator,
           execution.generation_id AS generationId
         FROM context_compilation_runs AS run
         INNER JOIN context_compilation_entries AS entry
           ON entry.run_id = run.id
         INNER JOIN context_compilation_entry_sources AS source
           ON source.run_id = entry.run_id
          AND source.candidate_id = entry.candidate_id
         INNER JOIN context_compilation_execution_links AS execution
           ON execution.trace_id = run.id
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
        generationId: "019f9f4a-b3c7-7350-9226-000000000701",
      },
      {
        taskType: "next_scene",
        layer: "semantic_retrieval",
        included: 0,
        sourceType: "search_document",
        sourceId: "maintenance-search-document",
        locator: "search-document:maintenance-search-document",
        generationId: "019f9f4a-b3c7-7350-9226-000000000701",
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
             'context_compilation_entry_sources',
             'context_compilation_execution_links',
             'context_compilation_model_invocation_links',
             'context_compilation_output_candidate_links'
           )
           AND lower(p.name) IN (
             'prompt', 'prompt_text', 'content', 'content_text', 'excerpt',
             'embedding', 'vector', 'payload_json', 'body', 'body_text'
           )`,
      ),
    ).resolves.toEqual([]);
    await executor.close();
  });

  fileSqliteIt("leaves the current database unchanged for an incompatible backup", async () => {
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

  fileSqliteIt(
    "rolls back restore-time guard removal when replayed evaluation evidence is invalid",
    async () => {
      const executor = new NodeSqliteExecutor(inkShadowMigration);
      const service = new DatabaseMaintenanceService(executor);
      const ids = await insertMinimalEvaluationLedger(executor);
      expect(await service.createConsistentBackup(backupPath)).toMatchObject({ ok: true });

      const backupInspection = new NodeSqliteExecutor("", backupPath);
      await backupInspection.execute("DROP TRIGGER novel_skill_evaluation_run_revision_guard");
      await backupInspection.execute(
        `UPDATE novel_skill_evaluation_runs
         SET model_assignments_json = ? WHERE id = ?`,
        [
          JSON.stringify([
            {
              slotId: "text_tier_a",
              modelIdentityHash: "8".repeat(64),
              modelArtifactHash: "a".repeat(64),
            },
            {
              slotId: "text_tier_b",
              modelIdentityHash: "9".repeat(64),
              modelArtifactHash: "a".repeat(64),
            },
          ]),
          ids.runId,
        ],
      );
      await backupInspection.close();

      expect(await service.restoreConsistentBackup(backupPath)).toMatchObject({
        ok: false,
        error: { details: { operation: "DATABASE_RESTORE_BACKUP_INCOMPATIBLE" } },
      });
      await expect(
        executor.select<{ readonly count: number }>(
          `SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name IN (
           'novel_skill_evaluation_manual_decision_delete_guard',
           'novel_skill_evaluation_score_delete_guard',
           'novel_skill_evaluation_observation_delete_guard',
           'novel_skill_evaluation_attempt_delete_guard',
           'novel_skill_evaluation_cell_delete_guard',
           'novel_skill_evaluation_run_delete_guard',
           'novel_skill_evaluation_fixture_delete_guard',
           'novel_skill_evaluation_manifest_item_delete_guard',
           'novel_skill_evaluation_suite_delete_guard',
           'novel_skill_evaluation_run_insert_guard',
           'novel_skill_evaluation_cell_plan_guard',
           'novel_skill_evaluation_attempt_insert_guard',
           'novel_skill_evaluation_observation_trace_guard',
           'novel_skill_evaluation_manual_decision_gate',
           'novel_skill_evaluation_suite_content_free_guard',
           'novel_skill_evaluation_no_skill_late_snapshot_guard',
           'novel_skill_evaluation_observed_item_insert_guard',
           'novel_skill_evaluation_observed_item_delete_guard',
           'novel_skill_evaluation_candidate_update_guard',
           'novel_skill_evaluation_candidate_delete_guard',
           'novel_skill_evaluation_trace_update_guard',
           'novel_skill_evaluation_entry_insert_guard',
           'novel_skill_evaluation_entry_delete_guard',
           'novel_skill_evaluation_source_insert_guard',
           'novel_skill_evaluation_source_update_guard',
           'novel_skill_evaluation_source_delete_guard',
           'novel_skill_evaluation_execution_link_delete_guard',
           'novel_skill_evaluation_model_link_delete_guard',
           'novel_skill_evaluation_invocation_update_guard',
           'novel_skill_evaluation_chapter_insert_guard',
           'novel_skill_evaluation_chapter_project_update_guard',
           'novel_skill_evaluation_story_fact_insert_guard',
           'novel_skill_evaluation_story_fact_project_update_guard',
           'novel_skill_evaluation_project_seed_insert_guard',
           'novel_skill_evaluation_project_seed_project_update_guard',
           'novel_skill_evaluation_planning_candidate_insert_guard',
           'novel_skill_evaluation_planning_candidate_project_update_guard',
           'novel_skill_evaluation_writing_preference_insert_guard',
           'novel_skill_evaluation_writing_preference_project_update_guard',
           'novel_skill_evaluation_settings_receipt_insert_guard',
           'novel_skill_evaluation_settings_receipt_project_update_guard',
           'novel_skill_evaluation_skill_binding_insert_guard',
           'novel_skill_evaluation_skill_binding_project_update_guard'
         )`,
        ),
      ).resolves.toEqual([{ count: 43 }]);
      await expect(
        executor.execute("DELETE FROM novel_skill_evaluation_suites WHERE id = ?", [ids.suiteId]),
      ).rejects.toThrow(/cannot be deleted/iu);
      await executor.close();
    },
  );

  fileSqliteIt(
    "rejects a foreign-key-valid backup whose evaluation fixture source was rewritten",
    async () => {
      const executor = new NodeSqliteExecutor(inkShadowMigration);
      const service = new DatabaseMaintenanceService(executor);
      const now = "2026-07-27T00:00:00.000Z";
      await executor.execute(
        `INSERT INTO projects (
           id, name, status, revision, deletion_generation, created_at, updated_at,
           archived_at, trashed_at, retention_until, status_before_trash
         ) VALUES (?, 'Restore semantic audit host', 'active', 1, 0,
                   ?, ?, NULL, NULL, NULL, NULL)`,
        [BACKUP_PROJECT_ID, now, now],
      );
      await insertModelHubExpertConnection(executor);
      await insertNovelSkillBackupScenario(executor);
      expect(await service.createConsistentBackup(backupPath)).toMatchObject({ ok: true });

      const backupInspection = new NodeSqliteExecutor("", backupPath);
      await backupInspection.execute("DROP TRIGGER context_compilation_source_immutable");
      await backupInspection.execute("DROP TRIGGER novel_skill_evaluation_source_update_guard");
      await backupInspection.execute(
        `UPDATE context_compilation_entry_sources SET content_hash = ?
         WHERE locator = 'novel_skill_evaluation_fixture'`,
        ["f".repeat(64)],
      );
      await backupInspection.close();

      expect(await service.restoreConsistentBackup(backupPath)).toMatchObject({
        ok: false,
        error: { details: { operation: "DATABASE_RESTORE_BACKUP_INCOMPATIBLE" } },
      });
      await expect(
        executor.select<{ readonly content_hash: string }>(
          `SELECT content_hash FROM context_compilation_entry_sources
           WHERE locator = 'novel_skill_evaluation_fixture'`,
        ),
      ).resolves.toEqual([
        { content_hash: NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY[0].inputContentHash },
      ]);
      await executor.close();
    },
  );

  for (const [name, tamper] of [
    [
      "rejects restored evaluation evidence truncated by max_output_tokens",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_invocation_update_guard");
        await backup.execute(
          `UPDATE model_invocation_facts SET finish_reason = 'max_output_tokens'
           WHERE id = '019f9f4a-b3c7-7350-9226-000000000767'`,
        );
      },
    ],
    [
      "rejects a substituted fixture registry even when suite hashes are rewritten",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_fixture_immutable");
        await backup.execute("DROP TRIGGER novel_skill_evaluation_suite_immutable");
        await backup.execute(
          `UPDATE novel_skill_evaluation_fixtures SET task_type = 'translation'
           WHERE fixture_id = 'zh.mystery.third_limited.pov'`,
        );
        await backup.execute(
          `UPDATE novel_skill_evaluation_suites SET fixture_set_hash = ?, plan_hash = ?`,
          ["1".repeat(64), "2".repeat(64)],
        );
      },
    ],
    [
      "rejects a restored evaluation Candidate whose frozen status changed",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_candidate_update_guard");
        await backup.execute(
          `UPDATE ai_candidates SET status = 'rejected', decided_at = created_at
           WHERE id = '019f9f4a-b3c7-7350-9226-000000000766'`,
        );
      },
    ],
    [
      "rejects a restored evaluation trace whose output link was deleted",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER context_compilation_output_candidate_immutable");
        await backup.execute("PRAGMA foreign_keys = OFF");
        await backup.execute(
          `DELETE FROM context_compilation_output_candidate_links
           WHERE trace_id = '019f9f4a-b3c7-7350-9226-000000000768'`,
        );
        await backup.execute("PRAGMA foreign_keys = ON");
      },
    ],
    [
      "rejects a restored evaluation Skill snapshot whose selection hash changed",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_invocation_immutable");
        await backup.execute(
          `UPDATE novel_skill_invocation_snapshots SET selection_hash = ?
           WHERE id = '019f9f4a-b3c7-7350-9226-00000000076a'`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a restored observation whose Candidate result hash changed",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_observation_immutable");
        await backup.execute(
          `UPDATE novel_skill_evaluation_observations SET result_hash = ?
           WHERE id = '019f9f4a-b3c7-7350-9226-00000000076b'`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a restored invalidated run forged back to planned",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_run_revision_guard");
        await backup.execute(
          `UPDATE novel_skill_evaluation_runs
           SET status = 'planned', evaluation_status = 'NOT_EVALUATED',
               evaluation_result_hash = NULL, started_at = NULL, completed_at = NULL
           WHERE id = '019f9f4a-b3c7-7350-9226-000000000762'`,
        );
      },
    ],
    [
      "rejects a foreign-key-valid attempt moved to another evaluation cell",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_attempt_revision_guard");
        await backup.execute(
          `UPDATE novel_skill_evaluation_attempts
           SET cell_id = (
             SELECT id FROM novel_skill_evaluation_cells
             WHERE run_id = '019f9f4a-b3c7-7350-9226-000000000762'
               AND id <> '019f9f4a-b3c7-7350-9226-000000000764'
             ORDER BY id LIMIT 1
           )
           WHERE id = '019f9f4a-b3c7-7350-9226-000000000765'`,
        );
      },
    ],
    [
      "rejects an evaluation project polluted by a Novel Skill binding",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_skill_binding_insert_guard");
        await backup.execute("DROP TRIGGER project_novel_skill_binding_active_project_guard");
        await backup.execute(
          `INSERT INTO project_novel_skill_bindings (
             project_id, skill_id, pinned_version, enabled, activation_mode,
             task_overrides_json, revision, created_at, updated_at
           ) VALUES ('019f9f4a-b3c7-7350-9226-000000000760',
                     'core.evaluation_fixture', '1.0.0', 1, 'manual', '{}', 1, ?, ?)`,
          ["2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"],
        );
      },
    ],
    [
      "rejects an incomplete paid evaluation protocol even when remaining hashes are well formed",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_context_baseline_delete_guard");
        await backup.execute(
          `DELETE FROM novel_skill_evaluation_context_baselines
           WHERE suite_id = '019f9f4a-b3c7-7350-9226-000000000761'
             AND fixture_id = (
               SELECT fixture_id FROM novel_skill_evaluation_context_baselines
               WHERE suite_id = '019f9f4a-b3c7-7350-9226-000000000761'
               ORDER BY fixture_id LIMIT 1
             )`,
        );
      },
    ],
  ] as const) {
    fileSqliteIt(name, async () => {
      await expectNovelSkillBackupTamperRejected(tamper);
    });
  }

  for (const state of ["authorized", "running", "settled"] as const) {
    const description =
      state === "settled"
        ? "round-trips a fully reconstructible no-skill paid settled chain"
        : `round-trips a canonical paid ${state} authority chain`;
    fileSqliteIt(description, async () => {
      const executor = new NodeSqliteExecutor(inkShadowMigration);
      const service = new DatabaseMaintenanceService(executor);
      const ids = await insertPaidRestoreScenario(executor, state);
      expect(await service.createConsistentBackup(backupPath)).toMatchObject({ ok: true });

      expect(await service.restoreConsistentBackup(backupPath)).toMatchObject({ ok: true });
      await expect(
        executor.select<{ readonly status: string }>(
          "SELECT status FROM novel_skill_evaluation_runs WHERE id = ?",
          [ids.runId],
        ),
      ).resolves.toEqual([{ status: state === "authorized" ? "planned" : "running" }]);
      await expect(
        executor.select<{ readonly state: string }>(
          `SELECT state FROM novel_skill_evaluation_dispatch_reservations WHERE run_id = ?`,
          [ids.runId],
        ),
      ).resolves.toEqual(state === "settled" ? [{ state: "settled" }] : []);
      await expect(
        executor.select<{ readonly reservation_id: string }>(
          `SELECT authority.reservation_id
           FROM novel_skill_evaluation_predispatch_authority_snapshots AS authority
           INNER JOIN novel_skill_evaluation_dispatch_reservations AS reservation
             ON reservation.id = authority.reservation_id
           WHERE reservation.run_id = ?`,
          [ids.runId],
        ),
      ).resolves.toEqual(state === "settled" ? [{ reservation_id: ids.reservationId }] : []);
      await executor.close();
    });
  }

  for (const [name, tamper] of [
    [
      "rejects a paid protocol hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_protocol_immutable");
        await backup.execute("UPDATE novel_skill_evaluation_protocols SET protocol_hash = ?", [
          "0".repeat(64),
        ]);
      },
    ],
    [
      "rejects a paid request-profile manifest tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_protocol_immutable");
        await backup.execute(
          "UPDATE novel_skill_evaluation_protocols SET request_profile_manifest_hash = ?",
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid context-baseline manifest tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_protocol_immutable");
        await backup.execute(
          "UPDATE novel_skill_evaluation_protocols SET context_baseline_manifest_hash = ?",
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid request profile hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_request_profile_immutable");
        await backup.execute(
          `UPDATE novel_skill_evaluation_request_profiles SET request_profile_hash = ?
           WHERE task_type = 'continuation'`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid context baseline hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_context_baseline_immutable");
        await backup.execute(
          `UPDATE novel_skill_evaluation_context_baselines SET compiled_baseline_hash = ?
           WHERE fixture_id = ?`,
          ["0".repeat(64), NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY[0].fixtureId],
        );
      },
    ],
    [
      "rejects a paid exact target hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_target_immutable");
        await backup.execute(
          `UPDATE novel_skill_evaluation_run_model_targets SET target_hash = ?
           WHERE model_slot_id = 'text_tier_a'`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid pricing snapshot hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_target_immutable");
        await backup.execute(
          `UPDATE novel_skill_evaluation_run_model_targets SET pricing_snapshot_hash = ?
           WHERE model_slot_id = 'text_tier_a'`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid quote hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_authorization_immutable");
        await backup.execute(
          "UPDATE novel_skill_evaluation_dispatch_authorizations SET quote_hash = ?",
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid target manifest tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_authorization_immutable");
        await backup.execute(
          "UPDATE novel_skill_evaluation_dispatch_authorizations SET target_manifest_hash = ?",
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid pricing manifest tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_authorization_immutable");
        await backup.execute(
          "UPDATE novel_skill_evaluation_dispatch_authorizations SET pricing_manifest_hash = ?",
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid commercial confirmation tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_authorization_immutable");
        await backup.execute(
          "UPDATE novel_skill_evaluation_dispatch_authorizations SET confirmation_hash = ?",
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid per-currency limit tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_authorization_limit_immutable");
        await backup.execute(
          `UPDATE novel_skill_evaluation_authorization_limits
           SET estimated_max_cost_micros = '1919'`,
        );
      },
    ],
    [
      "rejects a paid invariant request hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_reservation_revision_guard");
        await backup.execute(
          "UPDATE novel_skill_evaluation_dispatch_reservations SET invariant_request_hash = ?",
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid payload authority hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_reservation_revision_guard");
        await backup.execute(
          `UPDATE novel_skill_evaluation_dispatch_reservations
           SET payload_authority_manifest_hash = ?`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a missing paid predispatch authority snapshot and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute(
          "DROP TRIGGER novel_skill_evaluation_predispatch_authority_immutable_delete",
        );
        await backup.execute("DELETE FROM novel_skill_evaluation_predispatch_authority_snapshots");
      },
    ],
    [
      "rejects a paid payload-authority sub-hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute(
          "DROP TRIGGER novel_skill_evaluation_predispatch_authority_immutable_update",
        );
        await backup.execute(
          `UPDATE novel_skill_evaluation_predispatch_authority_snapshots
           SET genre_tags_hash = ?`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid exact predispatch cost tamper even with a matching execution lock",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute(
          "DROP TRIGGER novel_skill_evaluation_predispatch_authority_immutable_update",
        );
        await backup.execute("DROP TRIGGER novel_skill_evaluation_reservation_revision_guard");
        const rows = await backup.select<{
          readonly target_identity_hash: string;
          readonly request_profile_hash: string;
          readonly request_payload_hash: string;
          readonly currency: string;
        }>(
          `SELECT target_identity_hash, request_profile_hash, request_payload_hash, currency
           FROM novel_skill_evaluation_predispatch_authority_snapshots LIMIT 1`,
        );
        const row = rows[0];
        if (row === undefined) throw new Error("Paid authority fixture is missing.");
        const forgedExecutionLock = await sha256Text(
          canonicalJson({
            version: "model-hub-exact-evaluation-execution-lock@1",
            targetIdentityHash: row.target_identity_hash,
            requestProfileHash: row.request_profile_hash,
            payloadHash: row.request_payload_hash,
            currency: row.currency,
            estimatedMaximumCostMicros: "7",
          }),
        );
        await backup.execute(
          `UPDATE novel_skill_evaluation_predispatch_authority_snapshots
           SET exact_predispatch_estimated_max_cost_micros = '7', execution_lock_hash = ?`,
          [forgedExecutionLock],
        );
        await backup.execute(
          `UPDATE novel_skill_evaluation_dispatch_reservations
           SET execution_lock_hash = ?`,
          [forgedExecutionLock],
        );
      },
    ],
    [
      "rejects a paid capability-evidence authority tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute(
          "DROP TRIGGER novel_skill_evaluation_predispatch_authority_immutable_update",
        );
        await backup.execute(
          `UPDATE novel_skill_evaluation_predispatch_authority_snapshots
           SET capability_evidence_hash = ?`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid provider-receipt shape tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute(
          "DROP TRIGGER novel_skill_evaluation_predispatch_authority_immutable_update",
        );
        await backup.execute(
          `UPDATE novel_skill_evaluation_predispatch_authority_snapshots
           SET provider_receipt_shape_hash = ?`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid final-dispatch authority tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute(
          "DROP TRIGGER novel_skill_evaluation_predispatch_authority_immutable_update",
        );
        await backup.execute(
          `UPDATE novel_skill_evaluation_predispatch_authority_snapshots
           SET final_dispatch_authority_hash = ?`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid aggregate authority snapshot tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute(
          "DROP TRIGGER novel_skill_evaluation_predispatch_authority_immutable_update",
        );
        await backup.execute(
          `UPDATE novel_skill_evaluation_predispatch_authority_snapshots
           SET authority_snapshot_hash = ?`,
          ["0".repeat(64)],
        );
      },
    ],
    [
      "fails closed when a restored Skill arm lacks reconstructible compiled payload sub-hashes",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_attempt_revision_guard");
        await backup.execute("DROP TRIGGER novel_skill_evaluation_reservation_revision_guard");
        await backup.execute(
          `UPDATE novel_skill_evaluation_attempts
           SET cell_id = (
             SELECT core.id
             FROM novel_skill_evaluation_dispatch_reservations AS reservation
             INNER JOIN novel_skill_evaluation_cells AS original
               ON original.id = reservation.cell_id
             INNER JOIN novel_skill_evaluation_cells AS core
               ON core.run_id = original.run_id AND core.fixture_id = original.fixture_id
              AND core.model_slot_id = original.model_slot_id
              AND core.repetition = original.repetition AND core.arm = 'core'
             LIMIT 1
           )`,
        );
        await backup.execute(
          `UPDATE novel_skill_evaluation_dispatch_reservations
           SET cell_id = (SELECT cell_id FROM novel_skill_evaluation_attempts LIMIT 1),
               skill_configuration_hash = (
                 SELECT core_manifest_hash FROM novel_skill_evaluation_suites LIMIT 1
               )`,
        );
      },
    ],
    [
      "fails closed when an execution lock used an unpersisted lower predispatch estimate",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_reservation_revision_guard");
        const rows = await backup.select<{
          readonly target_hash: string;
          readonly request_profile_hash: string;
          readonly request_payload_hash: string;
          readonly currency: string;
        }>(
          `SELECT target_hash, request_profile_hash, request_payload_hash, currency
           FROM novel_skill_evaluation_dispatch_reservations LIMIT 1`,
        );
        const row = rows[0];
        if (row === undefined) throw new Error("Paid execution-lock fixture is missing.");
        const lowerEstimateLock = await sha256Text(
          canonicalJson({
            version: "model-hub-exact-evaluation-execution-lock@1",
            targetIdentityHash: row.target_hash,
            requestProfileHash: row.request_profile_hash,
            payloadHash: row.request_payload_hash,
            currency: row.currency,
            estimatedMaximumCostMicros: "7",
          }),
        );
        await backup.execute(
          "UPDATE novel_skill_evaluation_dispatch_reservations SET execution_lock_hash = ?",
          [lowerEstimateLock],
        );
      },
    ],
    [
      "rejects a paid execution lock hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_reservation_revision_guard");
        await backup.execute(
          "UPDATE novel_skill_evaluation_dispatch_reservations SET execution_lock_hash = ?",
          ["0".repeat(64)],
        );
      },
    ],
    [
      "rejects a paid provider receipt hash tamper and rolls the restore back",
      async (backup: NodeSqliteExecutor) => {
        await backup.execute("DROP TRIGGER novel_skill_evaluation_reservation_revision_guard");
        await backup.execute(
          "UPDATE novel_skill_evaluation_dispatch_reservations SET provider_receipt_hash = ?",
          ["0".repeat(64)],
        );
      },
    ],
  ] as const) {
    fileSqliteIt(name, async () => {
      const executor = new NodeSqliteExecutor(inkShadowMigration);
      const service = new DatabaseMaintenanceService(executor);
      const ids = await insertPaidRestoreScenario(executor, "settled");
      const originalAuthorities = await executor.select<{
        readonly reservation_id: string;
        readonly authority_snapshot_hash: string;
      }>(
        `SELECT reservation_id, authority_snapshot_hash
         FROM novel_skill_evaluation_predispatch_authority_snapshots
         WHERE reservation_id = ?`,
        [ids.reservationId],
      );
      expect(await service.createConsistentBackup(backupPath)).toMatchObject({ ok: true });
      const backup = new NodeSqliteExecutor("", backupPath);
      try {
        await tamper(backup);
      } finally {
        await backup.close();
      }

      expect(await service.restoreConsistentBackup(backupPath)).toMatchObject({
        ok: false,
        error: { details: { operation: "DATABASE_RESTORE_BACKUP_INCOMPATIBLE" } },
      });
      await expect(
        executor.select<{ readonly state: string }>(
          "SELECT state FROM novel_skill_evaluation_dispatch_reservations WHERE id = ?",
          [ids.reservationId],
        ),
      ).resolves.toEqual([{ state: "settled" }]);
      await expect(
        executor.select<{
          readonly reservation_id: string;
          readonly authority_snapshot_hash: string;
        }>(
          `SELECT reservation_id, authority_snapshot_hash
           FROM novel_skill_evaluation_predispatch_authority_snapshots
           WHERE reservation_id = ?`,
          [ids.reservationId],
        ),
      ).resolves.toEqual(originalAuthorities);
      await expect(
        executor.select<{ readonly count: number }>(
          `SELECT count(*) AS count FROM sqlite_schema
           WHERE type = 'trigger' AND name = 'novel_skill_evaluation_reservation_revision_guard'`,
        ),
      ).resolves.toEqual([{ count: 1 }]);
      await expect(
        executor.select<{ readonly count: number }>(
          `SELECT count(*) AS count FROM sqlite_schema
           WHERE type = 'trigger'
             AND name IN (
               'novel_skill_evaluation_predispatch_authority_insert_guard',
               'novel_skill_evaluation_predispatch_authority_immutable_update',
               'novel_skill_evaluation_predispatch_authority_immutable_delete',
               'novel_skill_evaluation_reservation_authority_bind_guard',
               'novel_skill_evaluation_reservation_authority_dispatch_guard',
               'novel_skill_evaluation_reservation_authority_settlement_guard'
             )`,
        ),
      ).resolves.toEqual([{ count: 6 }]);
      await executor.close();
    });
  }

  it("reports positive cloud acknowledgement evidence without claiming that zero proves absence", async () => {
    const executor = new NodeSqliteExecutor(inkShadowMigration);
    const now = "2026-07-27T00:00:00.000Z";
    await insertProject(executor, BACKUP_PROJECT_ID, "Private disclosure evidence");
    await insertGovernedExtensionMetadata(executor);
    await executor.execute(
      `INSERT INTO sync_outbox_operations (
         operation_id, project_id, device_id, device_sequence, object_id,
         object_generation, kind, vector_json, status, attempt, next_attempt_at,
         lease_owner_id, lease_token, lease_expires_at, failure_code,
         acknowledged_at, created_at, updated_at, object_type
       ) VALUES ('019f9f4a-b3c7-7350-9226-000000000500', ?, ?, 1, ?, 1,
                 'upsert', ?, 'acknowledged', 1, NULL, NULL, NULL, NULL, NULL,
                 ?, ?, ?, 'chapter_version')`,
      [
        BACKUP_PROJECT_ID,
        BACKUP_DEVICE_ID,
        BACKUP_CHAPTER_ID,
        JSON.stringify({ [BACKUP_DEVICE_ID]: 1 }),
        now,
        now,
        now,
      ],
    );
    const chapterId = parseUuidV7(BACKUP_CHAPTER_ID);
    const changedAt = parseIsoUtcTimestamp(now);
    if (!chapterId.ok || !changedAt.ok) {
      throw new Error("Private disclosure evidence fixture identity is invalid.");
    }
    const repositories = createSqliteRepositories(executor);
    const current = await repositories.chapters.findById(chapterId.value);
    if (!current.ok || current.value === null) {
      throw new Error("Private disclosure evidence fixture chapter is missing.");
    }
    const changed = current.value.changePrivacy({
      privacyMode: "local_only",
      expectedPrivacyRevision: current.value.privacyRevision,
      now: changedAt.value,
    });
    if (!changed.ok) {
      throw changed.error;
    }

    const receipt = await repositories.chapterPrivacy.updatePrivacy(
      changed.value,
      current.value.privacyRevision,
    );

    expect(receipt).toMatchObject({
      ok: true,
      value: {
        acknowledgedCloudEvidenceCount: 1,
        blockedProjectionCount: 0,
        removedOutboxOperationCount: 0,
      },
    });
    await executor.close();
  });

  it("revokes pending chapter transport and rejects every new local-only upload path", async () => {
    const executor = new NodeSqliteExecutor(inkShadowMigration);
    const now = "2026-07-27T00:00:00.000Z";
    const projectionId = "019f9f4a-b3c7-7350-9226-000000000501";
    const outboxId = "019f9f4a-b3c7-7350-9226-000000000502";
    await insertProject(executor, BACKUP_PROJECT_ID, "Private transport test");
    await insertGovernedExtensionMetadata(executor);
    await executor.execute(
      `INSERT INTO sync_projection_jobs (
         job_id, project_id, account_id, object_type, object_id, object_generation,
         projection_kind, version_id, source_revision, key_version, consent_revision,
         device_id, status, attempt, revision, next_attempt_at, lease_owner_id,
         lease_token, lease_expires_at, operation_id, failure_code, superseded_by_job_id,
         created_at, updated_at, terminal_at
       ) VALUES (?, ?, ?, 'chapter_version', ?, 1, 'upsert', ?, 1, 1, 1, ?,
                 'queued', 0, 1, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      [
        projectionId,
        BACKUP_PROJECT_ID,
        BACKUP_ACCOUNT_ID,
        BACKUP_CHAPTER_ID,
        BACKUP_CHAPTER_VERSION_ID,
        BACKUP_DEVICE_ID,
        now,
        now,
        now,
      ],
    );
    await executor.execute(
      `INSERT INTO sync_outbox_operations (
         operation_id, project_id, device_id, device_sequence, object_id,
         object_generation, kind, vector_json, status, attempt, next_attempt_at,
         lease_owner_id, lease_token, lease_expires_at, failure_code,
         acknowledged_at, created_at, updated_at, object_type
       ) VALUES (?, ?, ?, 1, ?, 1, 'upsert', ?, 'queued', 0, ?,
                 NULL, NULL, NULL, NULL, NULL, ?, ?, 'chapter_version')`,
      [
        outboxId,
        BACKUP_PROJECT_ID,
        BACKUP_DEVICE_ID,
        BACKUP_CHAPTER_ID,
        JSON.stringify({ [BACKUP_DEVICE_ID]: 1 }),
        now,
        now,
        now,
      ],
    );

    await executor.execute(
      `UPDATE chapters
       SET privacy_mode = 'local_only', privacy_revision = 2, updated_at = ?
       WHERE id = ?`,
      [now, BACKUP_CHAPTER_ID],
    );

    await expect(
      executor.select<{ status: string; failureCode: string }>(
        `SELECT status, failure_code AS failureCode
         FROM sync_projection_jobs WHERE job_id = ?`,
        [projectionId],
      ),
    ).resolves.toEqual([{ status: "failed", failureCode: "PRIVATE_CHAPTER_LOCAL_ONLY" }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_outbox_operations WHERE operation_id = ?",
        [outboxId],
      ),
    ).resolves.toEqual([{ count: 0 }]);

    await expect(
      executor.execute(
        `INSERT INTO sync_projection_jobs (
           job_id, project_id, account_id, object_type, object_id, object_generation,
           projection_kind, version_id, source_revision, key_version, consent_revision,
           device_id, status, attempt, revision, next_attempt_at, lease_owner_id,
           lease_token, lease_expires_at, operation_id, failure_code, superseded_by_job_id,
           created_at, updated_at, terminal_at
         ) VALUES ('019f9f4a-b3c7-7350-9226-000000000503', ?, ?, 'chapter_version', ?, 1,
                   'upsert', ?, 1, 1, 1, ?, 'queued', 0, 1, ?, NULL, NULL, NULL,
                   NULL, NULL, NULL, ?, ?, NULL)`,
        [
          BACKUP_PROJECT_ID,
          BACKUP_ACCOUNT_ID,
          BACKUP_CHAPTER_ID,
          BACKUP_CHAPTER_VERSION_ID,
          BACKUP_DEVICE_ID,
          now,
          now,
          now,
        ],
      ),
    ).rejects.toThrow(/local-only chapter cannot enter cloud projection/u);
    await expect(
      executor.execute(
        `INSERT INTO sync_outbox_operations (
           operation_id, project_id, device_id, device_sequence, object_id,
           object_generation, kind, vector_json, status, attempt, next_attempt_at,
           lease_owner_id, lease_token, lease_expires_at, failure_code,
           acknowledged_at, created_at, updated_at, object_type
         ) VALUES ('019f9f4a-b3c7-7350-9226-000000000504', ?, ?, 2, ?, 1,
                   'upsert', ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, NULL,
                   ?, ?, 'chapter_version')`,
        [
          BACKUP_PROJECT_ID,
          BACKUP_DEVICE_ID,
          BACKUP_CHAPTER_ID,
          JSON.stringify({ [BACKUP_DEVICE_ID]: 2 }),
          now,
          now,
          now,
        ],
      ),
    ).rejects.toThrow(/local-only chapter cannot enter cloud outbox/u);
    await expect(
      executor.execute(
        `INSERT INTO sync_ciphertext_chunks (
           chunk_id, project_id, object_type, object_id, version_id, chunk_index,
           key_version, algorithm, nonce, ciphertext, ciphertext_sha256,
           plaintext_bytes, created_at
         ) VALUES ('private-chunk', ?, 'chapter_version', ?, ?, 0, 1,
                   'AES-256-GCM', 'AAAAAAAAAAAAAAAA', ?, ?, 1, ?)`,
        [
          BACKUP_PROJECT_ID,
          BACKUP_CHAPTER_ID,
          BACKUP_CHAPTER_VERSION_ID,
          "A".repeat(22),
          "a".repeat(64),
          now,
        ],
      ),
    ).rejects.toThrow(/local-only chapter cannot be encrypted/u);
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

class RestoreFailureCapturingExecutor extends NodeSqliteExecutor {
  public lastFailure: unknown = null;

  public override async select<Row extends object>(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<Row[]> {
    try {
      return await super.select<Row>(query, bindValues);
    } catch (cause: unknown) {
      this.lastFailure = cause;
      throw cause;
    }
  }

  public override async execute(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<{ rowsAffected: number; lastInsertId?: number }> {
    try {
      return await super.execute(query, bindValues);
    } catch (cause: unknown) {
      this.lastFailure = cause;
      throw cause;
    }
  }
}

async function insertHistoricalV73CapabilityRestoreScenario(
  executor: NodeSqliteExecutor,
): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  const projectId = "019f9f4a-b3c7-7350-9226-000000000071";
  const chapterId = "019f9f4a-b3c7-7350-9226-000000000072";
  const versionId = "019f9f4a-b3c7-7350-9226-000000000073";
  await insertProject(executor, projectId, "七十三版恢复项目");
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision,
         current_version_id, created_at, updated_at, trashed_at
       ) VALUES (?, ?, '第一章', '七十三版正文必须原样恢复。',
         'active', 1, ?, ?, ?, NULL)`,
      [chapterId, projectId, versionId, now, now],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, '七十三版正文必须原样恢复。', ?,
         'created', NULL, ?)`,
      [versionId, projectId, chapterId, "7".repeat(64), now],
    );
  });
  await executor.execute(
    `INSERT INTO ai_candidates (
       id, project_id, chapter_id, source, base_version_id, content,
       content_checksum, status, incomplete, created_at, updated_at, decided_at
     ) VALUES (
       '019f9f4a-b3c7-7350-9226-000000000074', ?, ?, 'generate', ?,
       '隔离中的 AI 建议草稿', ?, 'ready', 0, ?, ?, NULL
     )`,
    [projectId, chapterId, versionId, "8".repeat(64), now, now],
  );
  await executor.execute(
    `INSERT INTO background_tasks (
       id, task_type, idempotency_key, metadata_json, priority, status,
       attempt, max_attempts, sequence, run_after, created_at, updated_at,
       started_at, finished_at
     ) VALUES (
       'maintenance-v73-background-task', 'chapter.summary',
       'maintenance.v73.background-task', ?, 50, 'succeeded',
       1, 1, 1, NULL, ?, ?, ?, ?
     )`,
    [JSON.stringify({ projectId, chapterId }), now, now, now, now],
  );
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, base_url,
       credential_state, connection_status, catalog_sync_status,
       enabled, revision, created_at, updated_at
     ) VALUES (
       'maintenance-v73-connection', 'openai', '七十三版模型服务',
       'openai_compatible', 'https://models.example.test/v1',
       'missing', 'not_tested', 'never', 1, 1, ?, ?
     )`,
    [now, now],
  );
  await executor.execute(
    `INSERT INTO model_catalog_entries (
       id, connection_id, provider_model_id, display_name, catalog_source,
       availability, lifecycle, first_discovered_at, last_seen_at, revision
     ) VALUES (
       'maintenance-v73-catalog', 'maintenance-v73-connection',
       'maintenance-v73-model', '七十三版模型', 'manual',
       'available', 'stable', ?, ?, 1
     )`,
    [now, now],
  );
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, route_task, connection_id, catalog_entry_id,
       provider_kind_snapshot, model_id_snapshot, route_reason, status,
       attempt, privacy_policy, data_destination, input_tokens, output_tokens,
       cached_input_tokens, estimated_cost_micros, started_at, completed_at,
       created_at, provider_dispatch_started_at
     ) VALUES (
       'maintenance-v73-invocation', 'continuation', NULL,
       'maintenance-v73-connection', 'maintenance-v73-catalog',
       'openai', 'maintenance-v73-model', 'user_override', 'succeeded',
       1, 'cloud_allowed', 'remote', 17, 4, NULL, NULL, ?, ?, ?, ?
     )`,
    [now, now, now, now],
  );
  await executor.execute(
    `INSERT INTO model_capability_scans (
       id, catalog_entry_id, scan_kind, status, evidence_version,
       supported_count, requested_at, started_at, completed_at
     ) VALUES (
       'maintenance-v73-scan', 'maintenance-v73-catalog',
       'lightweight_probe', 'succeeded', 'maintenance-v73-probe-v1',
       1, ?, ?, ?
     )`,
    [now, now, now],
  );
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

async function insertMemoryGovernanceAudit(executor: NodeSqliteExecutor): Promise<void> {
  const createdAt = "2026-07-27T00:00:00.000Z";
  const updatedAt = "2026-07-27T00:01:00.000Z";
  const policy = {
    projectId: BACKUP_PROJECT_ID,
    automaticLearningEnabled: false,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const memory = {
    id: BACKUP_MEMORY_ID,
    projectId: BACKUP_PROJECT_ID,
    level: "L2",
    content: "备份必须保留这条已忘掉记忆的来源。",
    source: {
      kind: "user_rule",
      sourceId: BACKUP_MEMORY_ID,
      sourceVersionId: null,
    },
    origin: "user",
    automaticLearningPolicyRevision: null,
    status: "enabled",
    pinned: false,
    excluded: true,
    weight: 0,
    useCount: 0,
    lastUsedAt: null,
    revision: 2,
    createdAt,
    updatedAt,
  };
  await executor.execute(
    `INSERT INTO story_memory_policies (
       project_id, automatic_learning_enabled, revision, created_at, updated_at, snapshot_json
     ) VALUES (?, 0, 1, ?, ?, ?)`,
    [BACKUP_PROJECT_ID, createdAt, createdAt, JSON.stringify(policy)],
  );
  await executor.execute(
    `INSERT INTO story_memory_records (
       id, project_id, level, origin, status, revision, source_kind, source_id,
       source_version_id, automatic_learning_policy_revision, created_at, updated_at,
       snapshot_json
     ) VALUES (?, ?, 'L2', 'user', 'enabled', 2, 'user_rule', ?, NULL, NULL, ?, ?, ?)`,
    [
      BACKUP_MEMORY_ID,
      BACKUP_PROJECT_ID,
      BACKUP_MEMORY_ID,
      createdAt,
      updatedAt,
      JSON.stringify(memory),
    ],
  );
  await executor.execute(
    `INSERT INTO story_memory_governance_events (
       id, project_id, operation, target_record_id, affected_record_count,
       resulting_policy_revision, request_json, before_snapshot_json,
       after_snapshot_json, created_at
     ) VALUES (?, ?, 'forget_project', NULL, 1, 1, ?, ?, ?, ?)`,
    [
      BACKUP_MEMORY_GOVERNANCE_EVENT_ID,
      BACKUP_PROJECT_ID,
      JSON.stringify({ operation: "forget_project", projectId: BACKUP_PROJECT_ID }),
      JSON.stringify({ records: [{ id: BACKUP_MEMORY_ID, excluded: false }] }),
      JSON.stringify({ records: [{ id: BACKUP_MEMORY_ID, excluded: true }] }),
      updatedAt,
    ],
  );
}

async function insertApplyingStoryPlanningCandidate(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO story_planning_candidates (
       id, project_id, task, target_node_id, target_node_title,
       baseline_outline_revision, baseline_target_synopsis, status,
       payload_json, editable_synopsis, context_json, invocation_id,
       connection_id, catalog_entry_id, provider_kind, model_id,
       used_fallback, selective_acceptance_intent_json,
       revision, created_at, updated_at
     ) VALUES (?, ?, 'outline_planning', ?, '备份规划节点', 1, '备份基线简介', 'review',
               ?, '待审阅规划内容', ?, 'maintenance-planning-invocation',
               'maintenance-planning-connection', 'maintenance-planning-catalog',
               'openai', 'maintenance-planning-model', 0, ?, 2, ?, ?)`,
    [
      BACKUP_PLANNING_CANDIDATE_ID,
      BACKUP_PROJECT_ID,
      "019f9f4a-b3c7-7350-9226-000000000304",
      JSON.stringify({
        schemaVersion: 1,
        task: "outline_planning",
        title: "备份规划",
        direction: "保持备份恢复语义",
        beats: [{ title: "恢复", purpose: "验证意图", outcome: "继续同一采纳" }],
        constraintsApplied: [],
        openQuestions: [],
      }),
      JSON.stringify({
        formalFactIds: [],
        lockedFactIds: [],
        causalEventIds: [],
        causalGraphStatus: "empty",
      }),
      maintenancePlanningAcceptanceIntentJson(),
      now,
      now,
    ],
  );
}

function maintenancePlanningAcceptanceIntentJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    selectedItemIds: ["beat:0"],
    selectionSha256: "a".repeat(64),
    baselineOutlineRevision: 1,
    baselineSynopsisSha256: "b".repeat(64),
    proposedSynopsisSha256: "c".repeat(64),
    startedAt: "2026-07-27T00:00:00.000Z",
  });
}

async function insertCreativeJourney(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO creative_journeys (
       id, kind, status, current_state, project_id, chapter_id, candidate_id,
       revision, snapshot_json, created_at, updated_at, completed_at
     ) VALUES (?, 'idea', 'active', 'opening', ?, ?, NULL, 1, ?, ?, ?, NULL)`,
    [
      BACKUP_JOURNEY_ID,
      BACKUP_PROJECT_ID,
      BACKUP_CHAPTER_ID,
      JSON.stringify({ idea: "backed-up-idea", step: "opening" }),
      now,
      now,
    ],
  );
  await executor.execute(
    `INSERT INTO creative_journey_turns (
       id, journey_id, sequence, turn_kind, question_key, generation_source,
       provider_id, model_id, task_key, request_id, snapshot_json, created_at
     ) VALUES (?, ?, 1, 'idea', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [BACKUP_JOURNEY_TURN_ID, BACKUP_JOURNEY_ID, JSON.stringify({ text: "backed-up-idea" }), now],
  );
}

async function insertProjectSeed(executor: NodeSqliteExecutor): Promise<void> {
  const seed = createMaintenanceProjectSeed("backed-up-project-seed", "2026-07-27T00:00:00.000Z");
  await executor.execute(
    `INSERT INTO project_seeds (
       project_id, seed_id, journey_kind, schema_version, payload_json,
       revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      BACKUP_PROJECT_ID,
      seed.seedId,
      seed.journeyKind,
      seed.version,
      JSON.stringify(seed),
      seed.createdAt,
      seed.updatedAt,
    ],
  );
}

async function insertStorySettingsImportReceipt(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO story_settings_import_receipts (
       id, project_id, source_sha256, request_sha256, status,
       created_record_ids_json, updated_record_fences_json,
       created_fact_ids_json, created_memory_ids_json,
       imported_count, skipped_count, created_at, undone_at
     ) VALUES (?, ?, ?, ?, 'committed', '[]', '[]', '[]', '[]', 0, 1, ?, NULL)`,
    [
      BACKUP_STORY_SETTINGS_IMPORT_RECEIPT_ID,
      BACKUP_PROJECT_ID,
      "8".repeat(64),
      "9".repeat(64),
      now,
    ],
  );
}

function createMaintenanceProjectSeed(direction: string, now: string) {
  return deriveIdeaProjectSeed({
    seedId: "idea:maintenance-project-seed",
    idea: direction,
    answers: { tone: "克制" },
    skippedQuestionKeys: [],
    now,
  });
}

async function insertCloudDeletionJournal(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO cloud_deletion_journals (
       journal_id, target_kind, target_id, account_email, active_mutation_id,
       deletion_request_id, latest_request_id, latest_revision,
       latest_receipt_json, recovery_action, last_error_code, created_at, updated_at
     ) VALUES (?, 'project', ?, NULL, ?, ?, ?, 1, ?, 'lookup', NULL, ?, ?)`,
    [
      BACKUP_DELETION_JOURNAL_ID,
      BACKUP_PROJECT_ID,
      BACKUP_DELETION_MUTATION_ID,
      BACKUP_DELETION_REQUEST_ID,
      BACKUP_DELETION_REQUEST_ID,
      JSON.stringify({ requestId: BACKUP_DELETION_REQUEST_ID, revision: 1 }),
      now,
      now,
    ],
  );
  await executor.execute(
    `INSERT INTO cloud_deletion_mutations (
       mutation_id, journal_id, request_type, confirmation_id, idempotency_key,
       expected_revision, request_body_sha256, state, response_request_id,
       response_revision, last_error_code, created_at, updated_at
     ) VALUES (?, ?, 'submission', ?, 'maintenance.delete.project.0001', 1, ?,
               'accepted', ?, 1, NULL, ?, ?)`,
    [
      BACKUP_DELETION_MUTATION_ID,
      BACKUP_DELETION_JOURNAL_ID,
      BACKUP_DELETION_CONFIRMATION_ID,
      "d".repeat(64),
      BACKUP_DELETION_REQUEST_ID,
      now,
      now,
    ],
  );
}

async function setAuthoritativeStoryGraphCheckpoint(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `UPDATE authoritative_story_graph_state
     SET authority_epoch = 7,
         projected_epoch = 7,
         projected_graph_revision = 1,
         projection_complete = 1,
         diagnostics_json = ?
     WHERE project_id = ?`,
    [JSON.stringify({ source: "backed-up-projection" }), BACKUP_PROJECT_ID],
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
    await transaction.execute(
      `INSERT INTO context_compilation_execution_links (
         trace_id, generation_id, generation_run_id, created_at
       ) VALUES (
         'maintenance-context-run',
         '019f9f4a-b3c7-7350-9226-000000000701',
         NULL,
         ?
       )`,
      [now],
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

async function insertContinuousStoryStateRouteReceipt(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO continuous_story_state_route_receipts (
       project_id, chapter_id, version_id, task, source_content_hash,
       provider_kind, model_id, invocation_id, candidate_count,
       created_fact_count, retired_fact_count, completed_at
     ) VALUES (?, ?, ?, 'character_extraction', ?, 'ollama', 'test-model',
               'maintenance-route-invocation', 0, 0, 0, '2026-07-27T00:00:00.000Z')`,
    [BACKUP_PROJECT_ID, BACKUP_CHAPTER_ID, BACKUP_CHAPTER_VERSION_ID, "1".repeat(64)],
  );
}

async function insertHistoricalContinuousStoryStateReceiptScenario(
  executor: NodeSqliteExecutor,
): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision, current_version_id,
         created_at, updated_at, trashed_at
       ) VALUES (?, ?, '历史回执章节', '旧正文', 'active', 1, ?, ?, ?, NULL)`,
      [BACKUP_CHAPTER_ID, BACKUP_PROJECT_ID, BACKUP_CHAPTER_VERSION_ID, now, now],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, '旧正文', ?, 'created', NULL, ?)`,
      [BACKUP_CHAPTER_VERSION_ID, BACKUP_PROJECT_ID, BACKUP_CHAPTER_ID, "1".repeat(64), now],
    );
  });
  await insertContinuousStoryStateRouteReceipt(executor);
  await advanceChapterAfterContinuousStoryStateReceipt(executor);
}

async function advanceChapterAfterContinuousStoryStateReceipt(
  executor: NodeSqliteExecutor,
): Promise<void> {
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
      ) VALUES (?, ?, ?, ?, 2, '备份中的新正文', ?, 'manual', NULL,
                '2026-07-27T00:01:00.000Z')`,
      [
        BACKUP_CURRENT_CHAPTER_VERSION_ID,
        BACKUP_PROJECT_ID,
        BACKUP_CHAPTER_ID,
        BACKUP_CHAPTER_VERSION_ID,
        "2".repeat(64),
      ],
    );
    await transaction.execute(
      `UPDATE chapters
       SET content = '备份中的新正文', current_version_id = ?, revision = 2,
           updated_at = '2026-07-27T00:01:00.000Z'
       WHERE project_id = ? AND id = ?`,
      [BACKUP_CURRENT_CHAPTER_VERSION_ID, BACKUP_PROJECT_ID, BACKUP_CHAPTER_ID],
    );
  });
}

async function insertChapterValidationSnapshots(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  for (const [index, id] of BACKUP_VALIDATION_SNAPSHOT_IDS.entries()) {
    const runSequence = index + 1;
    await executor.execute(
      `INSERT INTO chapter_validation_snapshots (
         id, project_id, chapter_id, chapter_version_id, chapter_revision,
         schema_version, rule_set_version, run_sequence, run_kind,
         supersedes_snapshot_id, result_status, issue_count,
         result_checksum_sha256, result_json, generated_at
       ) VALUES (?, ?, ?, ?, 1, 1, 'deterministic-novel-validator.v1', ?, ?, ?,
                 'checked', 1, ?, ?, ?)`,
      [
        id,
        BACKUP_PROJECT_ID,
        BACKUP_CHAPTER_ID,
        BACKUP_CHAPTER_VERSION_ID,
        runSequence,
        index === 0 ? "initial" : "rerun",
        index === 0 ? null : (BACKUP_VALIDATION_SNAPSHOT_IDS[index - 1] ?? null),
        String(runSequence).repeat(64),
        maintenanceValidationResultJson(),
        now,
      ],
    );
  }
}

function maintenanceValidationResultJson(): string {
  return JSON.stringify({
    status: "checked",
    projectId: BACKUP_PROJECT_ID,
    chapterId: BACKUP_CHAPTER_ID,
    chapterVersionId: BACKUP_CHAPTER_VERSION_ID,
    chapterRevision: 1,
    issues: [{ severity: "warning", currentEvidence: [], conflictingEvidence: [] }],
  });
}

async function sha256Text(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function evaluationManifestHashes(): Promise<{
  readonly core: string;
  readonly coreGenre: string;
  readonly coreGenrePreferences: string;
}> {
  const core = [
    {
      skillId: "core.evaluation_fixture",
      version: "1.0.0",
      definitionHash: "e".repeat(64),
      kind: "core",
    },
  ];
  const coreGenre = [
    ...core,
    {
      skillId: "genre.evaluation_fixture",
      version: "1.0.0",
      definitionHash: "f".repeat(64),
      kind: "genre",
    },
  ];
  return {
    core: await sha256Text(canonicalJson(core)),
    coreGenre: await sha256Text(canonicalJson(coreGenre)),
    coreGenrePreferences: await sha256Text(canonicalJson(coreGenre)),
  };
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
  await executor.execute(
    `INSERT INTO model_hub_connection_commits (
       id, connection_id, phase, credential_provider_id,
       cleanup_credential_provider_id, created_at, updated_at
     ) VALUES (
       'maintenance-model-commit', 'maintenance-custom-model', 'cleanup_pending',
       'maintenance-current-slot', 'maintenance-old-slot', ?, ?
     )`,
    [now, now],
  );
  await executor.execute(
    `INSERT INTO model_catalog_syncs (
       id, connection_id, source, status, discovered_model_count,
       next_page_token_present, started_at, completed_at
     ) VALUES (
       'maintenance-model-sync', 'maintenance-custom-model', 'manual', 'succeeded',
       1, 0, ?, ?
     )`,
    [now, now],
  );
  await executor.execute(
    `INSERT INTO model_catalog_entries (
       id, connection_id, provider_model_id, display_name, catalog_source,
       availability, lifecycle, first_discovered_at, last_seen_at, last_sync_id
     ) VALUES (
       'maintenance-model-catalog', 'maintenance-custom-model', 'maintenance-writer',
       'Maintenance writer', 'manual', 'available', 'stable', ?, ?,
       'maintenance-model-sync'
     )`,
    [now, now],
  );
  await executor.execute(
    `INSERT INTO model_capability_scans (
       id, catalog_entry_id, scan_kind, status, evidence_version,
       error_code, requested_at, started_at, completed_at,
       diagnostic_request_id, failure_stage, failure_retryable, http_status,
       finish_reason, visible_content_length, reasoning_present, streamed,
       attempt, requested_max_output_tokens
     ) VALUES (
       'maintenance-failed-probe', 'maintenance-model-catalog',
       'lightweight_probe', 'failed', 'maintenance-probe-v1',
       'MODEL_OUTPUT_TRUNCATED', ?, ?, ?, 'maintenance-probe-request-0001',
       'response_normalization', 0, 200, 'length', 0, 1, 1, 1, 64
     )`,
    [now, now, now],
  );
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
       model_id_snapshot, route_reason, status, attempt, privacy_policy,
       data_destination, error_code, started_at, completed_at, created_at,
       diagnostic_request_id, failure_stage, failure_retryable, http_status,
       finish_reason, visible_content_length, reasoning_present, streamed,
       requested_max_output_tokens
     ) VALUES (
       'maintenance-failed-invocation', 'prose_generation',
       'maintenance-custom-model', 'maintenance-model-catalog',
       'custom_openai_compatible', 'maintenance-writer', 'user_override',
       'failed', 1, 'cloud_allowed', 'remote', 'MODEL_TIMEOUT', ?, ?, ?,
       'maintenance-invocation-request-0001', 'http_response', 0, 504,
       NULL, 0, 0, 1, 512
     )`,
    [now, now, now],
  );
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
       model_id_snapshot, route_reason, status, attempt, privacy_policy,
       data_destination, input_tokens, output_tokens, cached_input_tokens,
       estimated_cost_micros, started_at, completed_at, created_at,
       finish_reason, visible_content_length, reasoning_present, streamed,
       requested_max_output_tokens, provider_dispatch_started_at
     ) VALUES (
       'maintenance-audited-probe-invocation', 'capability_probe',
       'maintenance-custom-model', 'maintenance-model-catalog',
       'custom_openai_compatible', 'maintenance-writer', 'user_override',
       'succeeded', 1, 'cloud_allowed', 'remote', 7, 1, 0, NULL, ?, ?, ?,
       'stop', 2, 0, 0, 64, ?
     )`,
    [now, now, now, now],
  );
  await executor.execute(
    `INSERT INTO model_capability_scans (
       id, catalog_entry_id, model_invocation_id, scan_kind, status,
       evidence_version, supported_count, requested_at, started_at, completed_at,
       visible_content_length, reasoning_present, streamed, attempt,
       requested_max_output_tokens
     ) VALUES (
       'maintenance-audited-probe', 'maintenance-model-catalog',
       'maintenance-audited-probe-invocation', 'lightweight_probe', 'succeeded',
       'maintenance-audited-probe-v1', 1, ?, ?, ?, 2, 0, 0, 1, 64
     )`,
    [now, now, now],
  );
  await executor.execute(
    `INSERT INTO model_capability_evidence (
       id, catalog_entry_id, scan_id, capability, verdict, evidence_source,
       evidence_version, evidence_summary, observed_at, expires_at
     ) VALUES (
       'maintenance-audited-probe-evidence', 'maintenance-model-catalog',
       'maintenance-audited-probe', 'text_generation', 'supported',
       'lightweight_probe', 'maintenance-audited-probe-v1',
       'content-free audited capability probe backup fixture', ?, NULL
     )`,
    [now],
  );
}

async function insertConsistencyInvestigationBackup(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  const runId = "019f9f4a-b3c7-7350-9226-000000000910";
  const taskId = "019f9f4a-b3c7-7350-9226-000000000911";
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO background_tasks (
         id, task_type, idempotency_key, metadata_json, priority, status,
         attempt, max_attempts, sequence, run_after, created_at, updated_at,
         started_at, finished_at
       ) VALUES (?, 'consistency_investigation', 'maintenance.consistency.0001', ?,
         50, 'succeeded', 1, 1, 3, NULL, ?, ?, ?, ?)`,
      [
        taskId,
        JSON.stringify({
          operation: "long_form_consistency_investigation",
          projectId: BACKUP_PROJECT_ID,
          runId,
        }),
        now,
        now,
        now,
        now,
      ],
    );
    await transaction.execute(
      `INSERT INTO consistency_investigation_runs (
         id, task_id, project_id, restart_of_run_id, idempotency_key,
         request_fingerprint, status, chapter_count, maximum_model_calls,
         maximum_tool_steps, maximum_context_characters, maximum_output_tokens,
         maximum_duration_ms, automatic_retry_count, estimated_input_tokens,
         estimated_maximum_cost_micros, currency, connection_id, catalog_entry_id,
         provider_kind_snapshot, model_id_snapshot, privacy_fingerprint,
         context_trace_id, generation_id, summary, finding_count,
         dropped_finding_count, cancellation_requested, failure_code, revision,
         created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, NULL, 'maintenance.consistency.0001', ?, 'succeeded',
         2, 1, 5, 120000, 4096, 120000, 0, 800, '42', 'USD',
         'maintenance-custom-model', 'maintenance-model-catalog',
         'custom_openai_compatible', 'maintenance-writer', ?,
         'maintenance-context-run', ?, '备份中的长篇一致性调查。', 1, 0, 0, NULL, 5,
         ?, ?, ?)`,
      [
        runId,
        taskId,
        BACKUP_PROJECT_ID,
        "a".repeat(64),
        "b".repeat(64),
        "019f9f4a-b3c7-7350-9226-000000000912",
        now,
        now,
        now,
      ],
    );
    const names = [
      ["read_story_memory", "local_tool", "local_read_only"],
      ["inspect_fact", "local_tool", "local_read_only"],
      ["search_fts", "local_tool", "local_read_only"],
      ["inspect_causal", "local_tool", "local_read_only"],
      ["validate_evidence", "local_tool", "local_read_only"],
      ["model_synthesis", "model", "model_dispatch"],
      ["verify_findings", "verifier", "local_verify"],
    ] as const;
    for (const [index, [name, kind, permission]] of names.entries()) {
      await transaction.execute(
        `INSERT INTO consistency_investigation_steps (
           id, run_id, ordinal, step_kind, tool_name, tool_version, permission,
           input_digest, status, invocation_id, observation_digest,
           terminal_cause, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, '1', ?, ?, 'succeeded', NULL, ?,
           'BACKUP_FIXTURE_COMPLETED', ?, ?, ?)`,
        [
          `019f9f4a-b3c7-7350-9226-${(920 + index).toString().padStart(12, "0")}`,
          runId,
          index + 1,
          kind,
          name,
          permission,
          (index + 1).toString(16).repeat(64).slice(0, 64),
          (index + 8).toString(16).repeat(64).slice(0, 64),
          now,
          now,
          now,
        ],
      );
    }
    const modelStepId = "019f9f4a-b3c7-7350-9226-000000000925";
    const findingId = "019f9f4a-b3c7-7350-9226-000000000930";
    await transaction.execute(
      `INSERT INTO consistency_investigation_findings (
         id, run_id, model_step_id, ordinal, severity, authority_group,
         category, title, explanation, status, revision, created_at, updated_at, decided_at
       ) VALUES (?, ?, ?, 1, 'warning', 'accepted_body', 'timeline',
         '备份中的时间线提醒', '这条说明只用于验证调查结论和用户决策能够恢复。',
         'allowed', 2, ?, ?, ?)`,
      [findingId, runId, modelStepId, now, now, now],
    );
    await transaction.execute(
      `INSERT INTO consistency_investigation_evidence (
         finding_id, ordinal, project_id, chapter_id, immutable_version_id,
         source_kind, locator_json, excerpt_digest, source_created_at,
         observed_at, currentness, branch_id, privacy
       ) VALUES (?, 0, ?, ?, ?, 'chapter', ?, ?, ?, ?, 'current', NULL, 'local_only')`,
      [
        findingId,
        BACKUP_PROJECT_ID,
        BACKUP_CHAPTER_ID,
        BACKUP_CHAPTER_VERSION_ID,
        JSON.stringify({ kind: "utf16", startOffset: 0, endOffset: 4, sourceLength: 4 }),
        "e".repeat(64),
        now,
        now,
      ],
    );
  });
}

async function insertRetiredModelHubConnection(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, base_url,
       credential_ref, credential_state, connection_status, authentication_mode,
       last_error_code, last_error_summary, enabled, revision, created_at, updated_at
     ) VALUES (
       ?, 'deepseek', 'Retired DeepSeek', 'openai_compatible', 'https://api.deepseek.com',
       NULL, 'missing', 'disabled', 'bearer_keyring',
       'MODEL_HUB_CONNECTION_RETIRED',
       'The connection was retired while immutable invocation history was retained.',
       0, 3, ?, ?
     )`,
    [BACKUP_RETIRED_MODEL_CONNECTION_ID, now, now],
  );
}

async function insertEvaluationManifestFixtures(
  executor: TransactionExecutor,
  suiteId: string,
  now: string,
): Promise<void> {
  const definitions = [
    {
      skillId: "core.evaluation_fixture",
      kind: "core",
      definitionHash: "e".repeat(64),
      precedence: 200,
      activation: '{"allowedModes":["draft"],"genreTags":[]}',
    },
    {
      skillId: "genre.evaluation_fixture",
      kind: "genre",
      definitionHash: "f".repeat(64),
      precedence: 300,
      activation: '{"allowedModes":["draft"],"genreTags":["campus_romance"]}',
    },
  ] as const;
  for (const definition of definitions) {
    await executor.execute(
      `INSERT OR IGNORE INTO novel_skill_definitions (
         skill_id, version, display_name, summary, kind, owner_scope, status, default_enabled,
         precedence, task_types_json, activation_json, context_requirements_json,
         instructions_json, output_contract_json, validation_json, definition_hash,
         provenance_url, provenance_commit, provenance_license, created_at
       ) VALUES (?, '1.0.0', ?, 'restore evaluation manifest fixture', ?, 'builtin',
                 'experimental', 0, ?, '["continuation"]', ?, '{}', '{}', '{}', '{}',
                 ?, NULL, NULL, NULL, ?)`,
      [
        definition.skillId,
        definition.skillId,
        definition.kind,
        definition.precedence,
        definition.activation,
        definition.definitionHash,
        now,
      ],
    );
  }
  for (const [arm, items] of [
    ["core", [definitions[0]]],
    ["core_genre", definitions],
    ["core_genre_preferences", definitions],
  ] as const) {
    for (const [index, definition] of items.entries()) {
      await executor.execute(
        `INSERT INTO novel_skill_evaluation_manifest_items (
           suite_id, arm, item_order, skill_id, skill_version, definition_hash, kind
         ) VALUES (?, ?, ?, ?, '1.0.0', ?, ?)`,
        [suiteId, arm, index + 1, definition.skillId, definition.definitionHash, definition.kind],
      );
    }
  }
}

async function insertMinimalEvaluationLedger(
  executor: NodeSqliteExecutor,
  modelAssignments:
    | readonly Readonly<{
        readonly slotId: string;
        readonly modelIdentityHash: string;
        readonly modelArtifactHash: string;
      }>[]
    | null = null,
): Promise<{
  readonly projectId: string;
  readonly suiteId: string;
  readonly runId: string;
}> {
  const now = "2026-07-27T00:00:00.000Z";
  const projectId = "019f9f4a-b3c7-7350-9226-000000000770";
  const suiteId = "019f9f4a-b3c7-7350-9226-000000000771";
  const runId = "019f9f4a-b3c7-7350-9226-000000000772";
  const manifests = await evaluationManifestHashes();
  const preferenceConfigurationHash = "7".repeat(64);
  const modelSlots = [
    { slotId: "text_tier_a", modelTier: "economy" },
    { slotId: "text_tier_b", modelTier: "quality" },
  ] as const;
  const targetManifestHash = await sha256Text(
    canonicalJson({
      coreManifestHash: manifests.core,
      coreGenreManifestHash: manifests.coreGenre,
      coreGenrePreferencesManifestHash: manifests.coreGenrePreferences,
      preferenceConfigurationHash,
    }),
  );
  const planHash = await sha256Text(
    canonicalJson({
      compilerVersion: "novel-skill-compiler@1",
      evaluatorVersion: "novel-skill-ab@1",
      fixtureSetHash: NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH,
      minimumRepetitions: 2,
      modelSlots,
      targetManifestHash,
    }),
  );
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, 'Restore rollback evaluation fixture', 'archived', 1, 0,
               ?, ?, ?, NULL, NULL, NULL)`,
    [projectId, now, now, now],
  );
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_suites (
       id, schema_version, evaluator_version, compiler_version, evaluation_project_id,
       plan_hash, fixture_set_hash, target_manifest_hash, core_manifest_hash,
       core_genre_manifest_hash, core_genre_preferences_manifest_hash,
       preference_configuration_hash, model_slots_json, minimum_repetitions, created_at
     ) VALUES (?, 1, 'novel-skill-ab@1', 'novel-skill-compiler@1',
               ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
    [
      suiteId,
      projectId,
      planHash,
      NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH,
      targetManifestHash,
      manifests.core,
      manifests.coreGenre,
      manifests.coreGenrePreferences,
      preferenceConfigurationHash,
      JSON.stringify(modelSlots),
      now,
    ],
  );
  await insertEvaluationManifestFixtures(executor, suiteId, now);
  for (const fixture of NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY) {
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_fixtures (
         suite_id, fixture_id, language, origin, task_type, invocation_mode,
         genre_tags_json, coverage_dimensions_json, contract_hash, input_content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        suiteId,
        fixture.fixtureId,
        fixture.language,
        fixture.origin,
        fixture.taskType,
        fixture.invocationMode,
        JSON.stringify(fixture.genreTags),
        JSON.stringify(fixture.coverageDimensions),
        fixture.contractHash,
        fixture.inputContentHash,
      ],
    );
  }
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_runs (
       id, suite_id, status, evaluation_status, model_assignments_json,
       revision, started_at, completed_at, created_at
     ) VALUES (?, ?, 'planned', 'NOT_EVALUATED', ?, 1, NULL, NULL, ?)`,
    [
      runId,
      suiteId,
      JSON.stringify(
        modelAssignments ?? [
          {
            slotId: "text_tier_a",
            modelIdentityHash: "8".repeat(64),
            modelArtifactHash: "a".repeat(64),
          },
          {
            slotId: "text_tier_b",
            modelIdentityHash: "9".repeat(64),
            modelArtifactHash: "b".repeat(64),
          },
        ],
      ),
      now,
    ],
  );
  let cellSequence = 0x2000;
  for (const { fixtureId } of NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY) {
    for (const [arm, armHash] of [
      ["no_skill", null],
      ["core", manifests.core],
      ["core_genre", manifests.coreGenre],
      ["core_genre_preferences", manifests.coreGenrePreferences],
    ] as const) {
      for (const [slotId, modelTier] of [
        ["text_tier_a", "economy"],
        ["text_tier_b", "quality"],
      ] as const) {
        for (const repetition of [1, 2] as const) {
          const cellId = `019f9f4a-b3c7-7350-9226-${cellSequence.toString(16).padStart(12, "0")}`;
          cellSequence += 1;
          await executor.execute(
            `INSERT INTO novel_skill_evaluation_cells (
               id, run_id, suite_id, fixture_id, arm, arm_configuration_hash,
               model_slot_id, model_tier, repetition, state, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
            [cellId, runId, suiteId, fixtureId, arm, armHash, slotId, modelTier, repetition, now],
          );
        }
      }
    }
  }
  return { projectId, suiteId, runId };
}

interface PaidRestoreTargetFixture {
  readonly slotId: "text_tier_a" | "text_tier_b";
  readonly catalogEntryId: string;
  readonly modelId: string;
  readonly modelIdentityHash: string;
  readonly modelArtifactHash: string;
  readonly connectionConfigurationHash: string;
  readonly catalogIdentityHash: string;
  readonly pricingSnapshotHash: string;
  readonly capabilityEvidenceHash: string;
  readonly targetHash: string;
  readonly exactTarget: Readonly<Record<string, unknown>>;
}

async function insertPaidRestoreModelHub(
  executor: NodeSqliteExecutor,
): Promise<readonly PaidRestoreTargetFixture[]> {
  const now = "2026-07-27T00:00:00.000Z";
  const connectionId = "paid-restore-connection";
  const credentialRef = `keyring:model-hub:${connectionId}`;
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, base_url, credential_ref,
       credential_state, connection_status, authentication_mode,
       credential_header_name, model_discovery_path, text_generation_path,
       embedding_path, request_timeout_ms, retry_limit, enabled, revision,
       created_at, updated_at
     ) VALUES (?, 'custom_openai_compatible', 'Paid restore models',
               'openai_compatible', 'https://paid-restore.example.test/v1', ?,
               'present', 'ready', 'custom_header_keyring', 'x-api-key',
               '/models', '/chat/completions', '/embeddings', 30000, 0, 1, 1, ?, ?)`,
    [connectionId, credentialRef, now, now],
  );
  const connectionProjection = {
    id: connectionId,
    providerKind: "custom_openai_compatible",
    protocol: "openai_compatible",
    region: null,
    workspaceId: null,
    endpointId: null,
    baseUrl: "https://paid-restore.example.test/v1",
    credentialRef,
    credentialState: "present",
    authenticationMode: "custom_header_keyring",
    credentialHeaderName: "x-api-key",
    modelDiscoveryPath: "/models",
    textGenerationPath: "/chat/completions",
    embeddingPath: "/embeddings",
    requestTimeoutMs: 30000,
    retryLimit: 0,
    revision: 1,
  };
  const connectionConfigurationHash = await sha256Text(canonicalJson(connectionProjection));
  const result: PaidRestoreTargetFixture[] = [];
  for (const [index, slotId, modelId] of [
    [1, "text_tier_a", "paid-restore-writer-a"],
    [2, "text_tier_b", "paid-restore-writer-b"],
  ] as const) {
    const catalogEntryId = `paid-restore-catalog-${index}`;
    const evidenceId = `paid-restore-evidence-${index}`;
    await executor.execute(
      `INSERT INTO model_catalog_entries (
         id, connection_id, provider_model_id, display_name, catalog_source,
         availability, lifecycle, input_token_limit, output_token_limit,
         first_discovered_at, last_seen_at, stale_after, revision
       ) VALUES (?, ?, ?, ?, 'manual', 'available', 'stable', 100000, 100000,
                 ?, ?, NULL, 1)`,
      [catalogEntryId, connectionId, modelId, modelId, now, now],
    );
    await executor.execute(
      `INSERT INTO model_capability_evidence (
         id, catalog_entry_id, scan_id, capability, verdict, evidence_source,
         evidence_version, evidence_summary, observed_at, expires_at
       ) VALUES (?, ?, NULL, 'text_generation', 'supported', 'user_confirmed',
                 'paid-restore@1', 'content-free restore fixture', ?, NULL)`,
      [evidenceId, catalogEntryId, now],
    );
    await executor.execute(
      `INSERT INTO model_cost_privacy_profiles (
         catalog_entry_id, currency, input_micros_per_million_tokens,
         output_micros_per_million_tokens, cached_input_micros_per_million_tokens,
         pricing_version, price_updated_at, data_destination, retention_policy,
         training_policy, evidence_source, evidence_version, evidence_summary,
         evidence_updated_at, revision, created_at, updated_at
       ) VALUES (?, 'USD', '1000000', '1000000', '500000', 'paid-restore@1', ?,
                 'remote', 'none', 'not_used', 'user_confirmed', 'paid-restore@1',
                 'content-free restore fixture', ?, 1, ?, ?)`,
      [catalogEntryId, now, now, now, now],
    );
    const catalogProjection = {
      id: catalogEntryId,
      connectionId,
      providerModelId: modelId,
      catalogSource: "manual",
      availability: "available",
      lifecycle: "stable",
      inputTokenLimit: 100000,
      outputTokenLimit: 100000,
      staleAfter: null,
      revision: 1,
    };
    const costProjection = {
      catalogEntryId,
      currency: "USD",
      inputMicrosPerMillionTokens: "1000000",
      outputMicrosPerMillionTokens: "1000000",
      cachedInputMicrosPerMillionTokens: "500000",
      pricingVersion: "paid-restore@1",
      priceUpdatedAt: now,
      dataDestination: "remote",
      retentionPolicy: "none",
      trainingPolicy: "not_used",
      evidenceSource: "user_confirmed",
      evidenceVersion: "paid-restore@1",
      evidenceSummary: "content-free restore fixture",
      evidenceUpdatedAt: now,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const catalogIdentityHash = await sha256Text(canonicalJson(catalogProjection));
    const pricingSnapshotHash = await sha256Text(canonicalJson(costProjection));
    const capabilityEvidenceHash = await sha256Text(
      canonicalJson({
        requiredCapabilities: ["text_generation"],
        evidence: [
          {
            id: evidenceId,
            catalogEntryId,
            scanId: null,
            capability: "text_generation",
            verdict: "supported",
            evidenceSource: "user_confirmed",
            evidenceVersion: "paid-restore@1",
            evidenceSummary: "content-free restore fixture",
            observedAt: now,
            expiresAt: null,
          },
        ],
      }),
    );
    const finalDispatchIdentity = JSON.stringify([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      connectionId,
      1,
      true,
      "custom_openai_compatible",
      "openai_compatible",
      "https://paid-restore.example.test/v1",
      credentialRef,
      "present",
      catalogEntryId,
      1,
      connectionId,
      modelId,
      "available",
      "stable",
      null,
      1,
      connectionId,
      "open_ai_compatible",
      "https://paid-restore.example.test/v1",
      "custom_header_keyring",
      "x-api-key",
      "/models",
      "/chat/completions",
      "/embeddings",
      30000,
      0,
    ]);
    const targetHash = await sha256Text(
      canonicalJson({
        version: "model-hub-exact-evaluation-target@1",
        finalDispatchIdentity,
        capabilityEvidenceHash,
        costProfileHash: pricingSnapshotHash,
      }),
    );
    const modelIdentityHash = await sha256Text(
      JSON.stringify({
        catalogEntryId,
        connectionId,
        modelId,
        providerKind: "custom_openai_compatible",
      }),
    );
    const modelArtifactHash = await sha256Text(
      JSON.stringify({ modelId, providerKind: "custom_openai_compatible" }),
    );
    result.push({
      slotId,
      catalogEntryId,
      modelId,
      modelIdentityHash,
      modelArtifactHash,
      connectionConfigurationHash,
      catalogIdentityHash,
      pricingSnapshotHash,
      capabilityEvidenceHash,
      targetHash,
      exactTarget: {
        connectionId,
        catalogEntryId,
        providerKind: "custom_openai_compatible",
        modelId,
        connectionRevision: 1,
        catalogRevision: 1,
        costPrivacyRevision: 1,
        capabilityEvidenceHash,
        costProfileHash: pricingSnapshotHash,
        targetIdentityHash: targetHash,
      },
    });
  }
  return result;
}

interface PaidRestoreScenarioIds {
  readonly projectId: string;
  readonly suiteId: string;
  readonly runId: string;
  readonly authorizationId: string;
  readonly reservationId: string | null;
  readonly targetCatalogId: string;
}

async function insertPaidRestoreScenario(
  executor: NodeSqliteExecutor,
  state: "authorized" | "running" | "settled",
): Promise<PaidRestoreScenarioIds> {
  const now = "2026-07-27T00:00:00.000Z";
  const completedAt = "2026-07-27T00:00:01.000Z";
  const authorizationId = "019f9f4a-b3c7-7350-9226-000000003001";
  const reservationId = "019f9f4a-b3c7-7350-9226-000000003002";
  const attemptId = "019f9f4a-b3c7-7350-9226-000000003003";
  const traceId = "019f9f4a-b3c7-7350-9226-000000003004";
  const invocationId = "019f9f4a-b3c7-7350-9226-000000003005";
  const candidateId = "019f9f4a-b3c7-7350-9226-000000003006";
  const targets = await insertPaidRestoreModelHub(executor);
  const ledger = await insertMinimalEvaluationLedger(
    executor,
    targets.map((target) => ({
      slotId: target.slotId,
      modelIdentityHash: target.modelIdentityHash,
      modelArtifactHash: target.modelArtifactHash,
    })),
  );
  const selectedFixture = NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY[0];
  const baselineEntry = {
    contextCandidateId: `evaluation-fixture:${selectedFixture.fixtureId}`,
    layer: "current_task",
    selectionReason: "fixed_evaluation_context",
    included: true,
    discardedReason: null,
    estimatedTokens: 1,
    evaluationOrder: 1,
    layerOrder: 2,
    priority: 100,
    relevanceScore: null,
    required: true,
    budgetRemainingBefore: 8,
    budgetRemainingAfter: 7,
    sources: [
      {
        sourceOrder: 1,
        sourceType: "user_input",
        sourceId: selectedFixture.fixtureId,
        sourceVersionId: null,
        locator: "novel_skill_evaluation_fixture",
        contentHash: selectedFixture.inputContentHash,
      },
    ],
  };
  const traceBaseline = {
    version: "novel-skill-paid-evaluation-trace-baseline@1",
    taskType: selectedFixture.taskType,
    maximumContextTokens: 8,
    requiredTokens: 1,
    usedTokens: 1,
    remainingTokens: 7,
    discardedTokens: 0,
    tokenEstimateSource: "utf8_conservative",
    entries: [baselineEntry],
  };
  const selectedBaselineHash = await sha256Text(canonicalJson(traceBaseline));
  const stopPolicyHash = "896247754b670bf5c4ac89424e7c5f2fffa598df9adcdc1377d8fcf0868831a6";
  const profiles = await Promise.all(
    [...new Set(NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY.map(({ taskType }) => taskType))]
      .sort((left, right) => left.localeCompare(right, "en"))
      .map(async (taskType) => ({
        taskType,
        profileVersion: "model-hub-exact-evaluation-request@1",
        requestProfileHash: await sha256Text(
          canonicalJson({
            version: "model-hub-exact-evaluation-request@1",
            task: taskType,
            maximumInputTokens: 8,
            maximumOutputTokens: 2,
            temperatureBasisPoints: 0,
            topPBasisPoints: 10000,
            reasoningMode: "disabled",
            responseFormat: "text",
            streaming: true,
            stopPolicyHash,
            providerCallPolicy: "single_attempt",
          }),
        ),
        maximumInputTokens: 8,
        maximumOutputTokens: 2,
        temperatureBasisPoints: 0,
        topPBasisPoints: 10000,
        streaming: true,
        stopPolicyHash,
      })),
  );
  const baselines = await Promise.all(
    [...NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY]
      .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId, "en"))
      .map(async (fixture) => ({
        fixtureId: fixture.fixtureId,
        baselineContractHash: fixture.contractHash,
        includedSourceManifestHash: await sha256Text(`paid-included:${fixture.fixtureId}`),
        omittedSourceManifestHash: await sha256Text(`paid-omitted:${fixture.fixtureId}`),
        compiledBaselineHash:
          fixture.fixtureId === selectedFixture.fixtureId
            ? selectedBaselineHash
            : await sha256Text(`paid-baseline:${fixture.fixtureId}`),
        baselineTokenBudget: 8,
      })),
  );
  const requestProfileManifestHash = await sha256Text(canonicalJson(profiles));
  const contextBaselineManifestHash = await sha256Text(canonicalJson(baselines));
  const promptTemplateHash = await sha256Text("paid-restore-prompt-template");
  const rubricContentHash = await sha256Text("paid-restore-rubric");
  const evaluatorContractHash = await sha256Text("paid-restore-evaluator");
  const blindingProtocolHash = await sha256Text("paid-restore-blinding");
  const randomizationProtocolHash = await sha256Text("paid-restore-randomization");
  const protocolHash = await sha256Text(
    canonicalJson({
      schemaVersion: 1,
      executionProtocolVersion: "novel-skill-paid-ab@1",
      suiteId: ledger.suiteId,
      requestProfileManifestHash,
      contextBaselineManifestHash,
      promptTemplateVersion: "novel-skill-paid-prompt@1",
      promptTemplateHash,
      rubricVersion: "novel-skill-human-rubric@1",
      rubricContentHash,
      evaluatorContractHash,
      blindingProtocolVersion: "paid-restore-blind@1",
      blindingProtocolHash,
      randomizationProtocolVersion: "paid-restore-random@1",
      randomizationProtocolHash,
    }),
  );
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_protocols (
       suite_id, schema_version, execution_protocol_version, protocol_hash,
       request_profile_manifest_hash, context_baseline_manifest_hash,
       prompt_template_version, prompt_template_hash, rubric_version,
       rubric_content_hash, evaluator_contract_hash, blinding_protocol_version,
       blinding_protocol_hash, randomization_protocol_version,
       randomization_protocol_hash, created_at
     ) VALUES (?, 1, 'novel-skill-paid-ab@1', ?, ?, ?, 'novel-skill-paid-prompt@1', ?,
               'novel-skill-human-rubric@1', ?, ?, 'paid-restore-blind@1', ?,
               'paid-restore-random@1', ?, ?)`,
    [
      ledger.suiteId,
      protocolHash,
      requestProfileManifestHash,
      contextBaselineManifestHash,
      promptTemplateHash,
      rubricContentHash,
      evaluatorContractHash,
      blindingProtocolHash,
      randomizationProtocolHash,
      now,
    ],
  );
  for (const profile of profiles) {
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_request_profiles (
         suite_id, task_type, profile_version, request_profile_hash,
         maximum_input_tokens, maximum_output_tokens, temperature_basis_points,
         top_p_basis_points, reasoning_policy, response_format, streaming,
         stop_policy_hash, created_at
       ) VALUES (?, ?, 'model-hub-exact-evaluation-request@1', ?, 8, 2, 0, 10000,
                 'disabled', 'text', 1, ?, ?)`,
      [ledger.suiteId, profile.taskType, profile.requestProfileHash, stopPolicyHash, now],
    );
  }
  for (const baseline of baselines) {
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_context_baselines (
         suite_id, fixture_id, baseline_contract_hash, included_source_manifest_hash,
         omitted_source_manifest_hash, compiled_baseline_hash, baseline_token_budget, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 8, ?)`,
      [
        ledger.suiteId,
        baseline.fixtureId,
        baseline.baselineContractHash,
        baseline.includedSourceManifestHash,
        baseline.omittedSourceManifestHash,
        baseline.compiledBaselineHash,
        now,
      ],
    );
  }
  for (const target of targets) {
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_run_model_targets (
         run_id, model_slot_id, connection_id, catalog_entry_id,
         provider_kind_snapshot, connection_protocol_snapshot, connection_revision,
         connection_configuration_hash, catalog_revision, provider_model_id_snapshot,
         catalog_identity_hash, model_identity_hash, model_artifact_hash,
         artifact_identity_source, cost_profile_revision, currency,
         input_micros_per_million_tokens, output_micros_per_million_tokens,
         cached_input_micros_per_million_tokens, pricing_version, price_updated_at,
         pricing_snapshot_hash, target_hash, created_at
       ) VALUES (?, ?, 'paid-restore-connection', ?, 'custom_openai_compatible',
                 'openai_compatible', 1, ?, 1, ?, ?, ?, ?, 'provider_model_id', 1,
                 'USD', '1000000', '1000000', '500000', 'paid-restore@1', ?, ?, ?, ?)`,
      [
        ledger.runId,
        target.slotId,
        target.catalogEntryId,
        target.connectionConfigurationHash,
        target.modelId,
        target.catalogIdentityHash,
        target.modelIdentityHash,
        target.modelArtifactHash,
        now,
        target.pricingSnapshotHash,
        target.targetHash,
        now,
      ],
    );
  }
  const targetManifestHash = await sha256Text(
    canonicalJson(
      targets.map((target) => ({
        modelSlotId: target.slotId,
        connectionId: "paid-restore-connection",
        catalogEntryId: target.catalogEntryId,
        modelIdentityHash: target.modelIdentityHash,
        modelArtifactHash: target.modelArtifactHash,
        targetHash: target.targetHash,
      })),
    ),
  );
  const pricingManifestHash = await sha256Text(
    canonicalJson(
      targets.map((target) => ({
        modelSlotId: target.slotId,
        currency: "USD",
        inputRate: "1000000",
        outputRate: "1000000",
        pricingSnapshotHash: target.pricingSnapshotHash,
      })),
    ),
  );
  const currencies = [{ currency: "USD", estimatedMaximumCostMicros: "1920" }];
  const quoteHash = await sha256Text(
    canonicalJson({
      version: "novel-skill-paid-evaluation-quote@1",
      runId: ledger.runId,
      protocolHash,
      targetManifestHash,
      pricingManifestHash,
      authorizedCallCount: 192,
      currencies,
    }),
  );
  const confirmationHash = await sha256Text(
    canonicalJson({
      version: "novel-skill-paid-commercial-confirmation@1",
      runId: ledger.runId,
      protocolHash,
      targetManifestHash,
      pricingManifestHash,
      quoteHash,
      authorizedCallCount: 192,
      currencies: [{ ...currencies[0], hardCeilingMicros: "2500" }],
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
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_dispatch_authorizations (
       id, run_id, protocol_hash, target_manifest_hash, pricing_manifest_hash,
       quote_hash, confirmation_hash, authorized_call_count, authorized_by,
       commercial_use_acknowledged, authorized_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 192, 'local_user', 1, ?)`,
    [
      authorizationId,
      ledger.runId,
      protocolHash,
      targetManifestHash,
      pricingManifestHash,
      quoteHash,
      confirmationHash,
      now,
    ],
  );
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_authorization_limits (
       authorization_id, currency, estimated_max_cost_micros, hard_ceiling_micros, created_at
     ) VALUES (?, 'USD', '1920', '2500', ?)`,
    [authorizationId, now],
  );
  if (state === "authorized") {
    return {
      ...ledger,
      authorizationId,
      reservationId: null,
      targetCatalogId: targets[0]?.catalogEntryId ?? "",
    };
  }
  await executor.execute(
    `UPDATE novel_skill_evaluation_runs
     SET status = 'running', started_at = ?, revision = revision + 1 WHERE id = ?`,
    [now, ledger.runId],
  );
  if (state === "running") {
    return {
      ...ledger,
      authorizationId,
      reservationId: null,
      targetCatalogId: targets[0]?.catalogEntryId ?? "",
    };
  }
  const cells = await executor.select<{ readonly id: string }>(
    `SELECT id FROM novel_skill_evaluation_cells
     WHERE run_id = ? AND fixture_id = ? AND arm = 'no_skill'
       AND model_slot_id = 'text_tier_a' AND repetition = 1`,
    [ledger.runId, selectedFixture.fixtureId],
  );
  const cellId = cells[0]?.id;
  const selectedProfile = profiles.find(({ taskType }) => taskType === selectedFixture.taskType);
  const selectedBaseline = baselines.find(
    ({ fixtureId }) => fixtureId === selectedFixture.fixtureId,
  );
  const target = targets[0];
  if (
    cellId === undefined ||
    selectedProfile === undefined ||
    selectedBaseline === undefined ||
    target === undefined
  ) {
    throw new Error("Paid restore fixture is incomplete.");
  }
  const invariantRequestHash = await sha256Text(
    canonicalJson({
      version: "novel-skill-paid-evaluation-invariant-request@1",
      runId: ledger.runId,
      suiteId: ledger.suiteId,
      fixtureId: selectedFixture.fixtureId,
      taskType: selectedFixture.taskType,
      modelSlotId: "text_tier_a",
      repetition: 1,
      protocolHash,
      requestProfileHash: selectedProfile.requestProfileHash,
      contextBaselineHash: selectedBaseline.compiledBaselineHash,
      promptTemplateHash,
    }),
  );
  const messagePayloadHash = await sha256Text("paid-restore-message-payload");
  const requestPayloadHash = await sha256Text("paid-restore-request-payload");
  const executionLockHash = await sha256Text(
    canonicalJson({
      version: "model-hub-exact-evaluation-execution-lock@1",
      targetIdentityHash: target.targetHash,
      requestProfileHash: selectedProfile.requestProfileHash,
      payloadHash: requestPayloadHash,
      currency: "USD",
      estimatedMaximumCostMicros: "10",
    }),
  );
  const contextBaselineProjectionHash = await sha256Text(
    canonicalJson({
      schemaVersion: 1,
      version: "novel-skill-paid-context-baseline@1",
      fixtureId: selectedFixture.fixtureId,
      baselineContractHash: selectedBaseline.baselineContractHash,
      includedSourceManifestHash: selectedBaseline.includedSourceManifestHash,
      omittedSourceManifestHash: selectedBaseline.omittedSourceManifestHash,
      compiledBaselineHash: selectedBaseline.compiledBaselineHash,
      baselineTokenBudget: 8,
      availableContextLayers: ["current_task"],
      traceBaseline,
    }),
  );
  const payloadAuthorityManifest = {
    schemaVersion: 1,
    authorityVersion: "novel-skill-paid-payload-authority@1",
    runId: ledger.runId,
    suiteId: ledger.suiteId,
    cellId,
    fixtureId: selectedFixture.fixtureId,
    fixtureContractHash: selectedFixture.contractHash,
    fixtureInputContentHash: selectedFixture.inputContentHash,
    taskType: selectedFixture.taskType,
    invocationMode: selectedFixture.invocationMode,
    genreTagsHash: await sha256Text(canonicalJson(selectedFixture.genreTags)),
    coverageDimensionsHash: await sha256Text(canonicalJson(selectedFixture.coverageDimensions)),
    arm: "no_skill",
    armConfigurationHash: null,
    modelSlotId: "text_tier_a",
    repetition: 1,
    promptTemplateVersion: "novel-skill-paid-prompt@1",
    promptTemplateHash,
    contextBaselineHash: selectedBaseline.compiledBaselineHash,
    contextBaselineProjectionHash,
    availableContextLayersHash: await sha256Text(canonicalJson(["current_task"])),
    skillCompilerVersion: "novel-skill-compiler@1",
    skillSelectionHash: null,
    compiledSkillSnapshotHash: null,
    renderedSkillSectionHash: null,
    preferenceConfigurationHash: null,
    preferenceProjectionHash: null,
    renderedPreferenceSectionHash: null,
    baseMessagePayloadHash: messagePayloadHash,
    messagePayloadHash,
  } as const;
  const payloadAuthorityManifestHash = await sha256Text(canonicalJson(payloadAuthorityManifest));
  const idempotencyKeyHash = await sha256Text("paid-restore-idempotency-key");
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_attempts (
       id, run_id, cell_id, attempt_number, status, context_trace_id,
       model_invocation_id, error_code, started_at, completed_at
     ) VALUES (?, ?, ?, 1, 'started', NULL, NULL, NULL, ?, NULL)`,
    [attemptId, ledger.runId, cellId, now],
  );
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_dispatch_reservations (
       id, authorization_id, run_id, cell_id, attempt_id, model_slot_id,
       dispatch_generation, planned_context_trace_id, planned_model_invocation_id,
       planned_candidate_id, state, target_hash, pricing_snapshot_hash,
       request_profile_hash, context_baseline_hash, prompt_template_hash,
       invariant_request_hash, request_payload_hash, execution_lock_hash,
       message_payload_hash, payload_authority_version,
       payload_authority_manifest_hash, data_destination, skill_configuration_hash,
       preference_configuration_hash, idempotency_key_hash, currency,
       reserved_max_cost_micros, reserved_at, revision
     ) VALUES (?, ?, ?, ?, ?, 'text_tier_a', 1, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?,
               ?, ?, ?, ?, 'novel-skill-paid-payload-authority@1', ?, 'remote', NULL,
               NULL, ?, 'USD', '10', ?, 1)`,
    [
      reservationId,
      authorizationId,
      ledger.runId,
      cellId,
      attemptId,
      traceId,
      invocationId,
      candidateId,
      target.targetHash,
      target.pricingSnapshotHash,
      selectedProfile.requestProfileHash,
      selectedBaseline.compiledBaselineHash,
      promptTemplateHash,
      invariantRequestHash,
      requestPayloadHash,
      executionLockHash,
      messagePayloadHash,
      payloadAuthorityManifestHash,
      idempotencyKeyHash,
      now,
    ],
  );
  const providerReceiptShape = {
    version: "model-hub-exact-evaluation-predispatch-receipt@1",
    generationId: invocationId,
    target: target.exactTarget,
    requestProfileHash: selectedProfile.requestProfileHash,
    messagePayloadHash,
    payloadHash: requestPayloadHash,
    executionLockHash,
    currency: "USD",
    estimatedMaximumCostMicros: "10",
    dataDestination: "remote",
  } as const;
  const providerReceiptShapeHash = await sha256Text(canonicalJson(providerReceiptShape));
  const finalDispatchAuthority = {
    version: "novel-skill-paid-final-dispatch-authority@1",
    reservationId,
    authorizationId,
    runId: ledger.runId,
    cellId,
    attemptId,
    modelSlotId: "text_tier_a",
    dispatchGeneration: 1,
    plannedContextTraceId: traceId,
    plannedModelInvocationId: invocationId,
    plannedCandidateId: candidateId,
    idempotencyKeyHash,
    payloadAuthorityManifestHash,
    providerReceiptShapeHash,
  } as const;
  const finalDispatchAuthorityHash = await sha256Text(canonicalJson(finalDispatchAuthority));
  const authoritySnapshot = {
    schemaVersion: 1,
    version: "novel-skill-paid-predispatch-authority@1",
    reservationId,
    payloadAuthorityManifest,
    payloadAuthorityManifestHash,
    providerReceiptShapeVersion: "model-hub-exact-evaluation-predispatch-receipt@1",
    providerReceiptShapeHash,
    finalDispatchAuthorityVersion: "novel-skill-paid-final-dispatch-authority@1",
    finalDispatchAuthorityHash,
    exactPredispatchEstimatedMaximumCostMicros: "10",
    capturedAt: now,
  } as const;
  const authoritySnapshotHash = await sha256Text(canonicalJson(authoritySnapshot));
  const sidecar = {
    reservation_id: reservationId,
    schema_version: 1,
    authority_snapshot_version: "novel-skill-paid-predispatch-authority@1",
    payload_authority_schema_version: 1,
    payload_authority_version: payloadAuthorityManifest.authorityVersion,
    payload_authority_manifest_hash: payloadAuthorityManifestHash,
    run_id: payloadAuthorityManifest.runId,
    suite_id: payloadAuthorityManifest.suiteId,
    cell_id: payloadAuthorityManifest.cellId,
    fixture_id: payloadAuthorityManifest.fixtureId,
    fixture_contract_hash: payloadAuthorityManifest.fixtureContractHash,
    fixture_input_content_hash: payloadAuthorityManifest.fixtureInputContentHash,
    task_type: payloadAuthorityManifest.taskType,
    invocation_mode: payloadAuthorityManifest.invocationMode,
    genre_tags_hash: payloadAuthorityManifest.genreTagsHash,
    coverage_dimensions_hash: payloadAuthorityManifest.coverageDimensionsHash,
    arm: payloadAuthorityManifest.arm,
    arm_configuration_hash: payloadAuthorityManifest.armConfigurationHash,
    model_slot_id: payloadAuthorityManifest.modelSlotId,
    repetition: payloadAuthorityManifest.repetition,
    prompt_template_version: payloadAuthorityManifest.promptTemplateVersion,
    prompt_template_hash: payloadAuthorityManifest.promptTemplateHash,
    context_baseline_hash: payloadAuthorityManifest.contextBaselineHash,
    context_baseline_projection_hash: payloadAuthorityManifest.contextBaselineProjectionHash,
    available_context_layers_hash: payloadAuthorityManifest.availableContextLayersHash,
    skill_compiler_version: payloadAuthorityManifest.skillCompilerVersion,
    skill_selection_hash: payloadAuthorityManifest.skillSelectionHash,
    compiled_skill_snapshot_hash: payloadAuthorityManifest.compiledSkillSnapshotHash,
    rendered_skill_section_hash: payloadAuthorityManifest.renderedSkillSectionHash,
    preference_configuration_hash: payloadAuthorityManifest.preferenceConfigurationHash,
    preference_projection_hash: payloadAuthorityManifest.preferenceProjectionHash,
    rendered_preference_section_hash: payloadAuthorityManifest.renderedPreferenceSectionHash,
    base_message_payload_hash: payloadAuthorityManifest.baseMessagePayloadHash,
    message_payload_hash: payloadAuthorityManifest.messagePayloadHash,
    generation_id: invocationId,
    connection_id: "paid-restore-connection",
    catalog_entry_id: target.catalogEntryId,
    provider_kind: "custom_openai_compatible",
    provider_model_id: target.modelId,
    connection_revision: 1,
    catalog_revision: 1,
    cost_privacy_revision: 1,
    capability_evidence_hash: target.capabilityEvidenceHash,
    cost_profile_hash: target.pricingSnapshotHash,
    target_identity_hash: target.targetHash,
    request_profile_hash: selectedProfile.requestProfileHash,
    request_payload_hash: requestPayloadHash,
    execution_lock_hash: executionLockHash,
    currency: "USD",
    exact_predispatch_estimated_max_cost_micros: "10",
    data_destination: "remote",
    provider_receipt_shape_version: "model-hub-exact-evaluation-predispatch-receipt@1",
    provider_receipt_shape_hash: providerReceiptShapeHash,
    final_dispatch_authority_version: "novel-skill-paid-final-dispatch-authority@1",
    final_dispatch_authority_hash: finalDispatchAuthorityHash,
    authority_snapshot_hash: authoritySnapshotHash,
    captured_at: now,
  } as const;
  const sidecarColumns = Object.keys(sidecar);
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_predispatch_authority_snapshots
       (${sidecarColumns.join(", ")}) VALUES (${sidecarColumns.map(() => "?").join(", ")})`,
    Object.values(sidecar),
  );
  await executor.execute(
    `INSERT INTO context_compilation_runs (
       id, project_id, chapter_id, task_type, maximum_context_tokens,
       required_tokens, used_tokens, remaining_tokens, discarded_tokens,
       token_estimate_source, candidate_count, included_count, discarded_count, created_at
     ) VALUES (?, ?, NULL, ?, 8, 1, 1, 7, 0, 'utf8_conservative', 1, 1, 0, ?)`,
    [traceId, ledger.projectId, selectedFixture.taskType, now],
  );
  await executor.execute(
    `INSERT INTO context_compilation_entries (
       run_id, candidate_id, layer, selection_reason, included, discarded_reason,
       estimated_tokens, evaluation_order, layer_order, priority, relevance_score,
       required, budget_remaining_before, budget_remaining_after
     ) VALUES (?, ?, 'current_task', 'fixed_evaluation_context', 1, NULL,
               1, 1, 2, 100, NULL, 1, 8, 7)`,
    [traceId, baselineEntry.contextCandidateId],
  );
  await executor.execute(
    `INSERT INTO context_compilation_entry_sources (
       run_id, candidate_id, source_order, source_type, source_id,
       source_version_id, locator, content_hash
     ) VALUES (?, ?, 1, 'user_input', ?, NULL, 'novel_skill_evaluation_fixture', ?)`,
    [
      traceId,
      baselineEntry.contextCandidateId,
      selectedFixture.fixtureId,
      selectedFixture.inputContentHash,
    ],
  );
  await executor.execute(
    `INSERT INTO context_compilation_execution_links (
       trace_id, generation_id, generation_run_id, created_at
     ) VALUES (?, ?, NULL, ?)`,
    [traceId, invocationId, now],
  );
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
       model_id_snapshot, route_reason, status, attempt, privacy_policy,
       data_destination, maximum_cost_micros, currency, created_at,
       requested_max_output_tokens, streamed
     ) VALUES (?, ?, 'paid-restore-connection', ?, 'custom_openai_compatible', ?,
               'user_override', 'queued', 1, 'cloud_allowed', 'remote', '10', 'USD', ?, 2, 1)`,
    [invocationId, selectedFixture.taskType, target.catalogEntryId, target.modelId, now],
  );
  await executor.execute(
    `INSERT INTO context_compilation_model_invocation_links (
       trace_id, model_invocation_id, linked_at
     ) VALUES (?, ?, ?)`,
    [traceId, invocationId, now],
  );
  await executor.execute(
    `UPDATE novel_skill_evaluation_attempts
     SET context_trace_id = ?, model_invocation_id = ? WHERE id = ?`,
    [traceId, invocationId, attemptId],
  );
  await executor.execute(
    `UPDATE novel_skill_evaluation_dispatch_reservations
     SET state = 'bound', bound_at = ?, revision = revision + 1 WHERE id = ?`,
    [now, reservationId],
  );
  await executor.execute(
    `UPDATE model_invocation_facts
     SET status = 'running', started_at = ?, revision = revision + 1 WHERE id = ?`,
    [now, invocationId],
  );
  await executor.execute(
    `UPDATE novel_skill_evaluation_dispatch_reservations
     SET state = 'dispatched', dispatched_at = ?, revision = revision + 1 WHERE id = ?`,
    [now, reservationId],
  );
  const content = "paid restore output";
  const visibleOutputHash = await sha256Text(content);
  await executor.execute(
    `INSERT INTO ai_candidates (
       id, project_id, chapter_id, source, base_version_id, content, content_checksum,
       status, incomplete, created_at, updated_at, decided_at
     ) VALUES (?, ?, NULL, 'generate', NULL, ?, ?, 'ready', 0, ?, ?, NULL)`,
    [candidateId, ledger.projectId, content, visibleOutputHash, completedAt, completedAt],
  );
  await executor.execute(
    `INSERT INTO context_compilation_output_candidate_links (
       trace_id, ai_candidate_id, linked_at
     ) VALUES (?, ?, ?)`,
    [traceId, candidateId, completedAt],
  );
  await executor.execute(
    `UPDATE model_invocation_facts
     SET status = 'succeeded', input_tokens = 3, output_tokens = 2,
         cached_input_tokens = 1, estimated_cost_micros = '5', currency = 'USD',
         finish_reason = 'stop', visible_content_length = ?, completed_at = ?,
         revision = revision + 1 WHERE id = ?`,
    [Array.from(content).length, completedAt, invocationId],
  );
  await executor.execute(
    `UPDATE novel_skill_evaluation_attempts
     SET status = 'succeeded', completed_at = ? WHERE id = ?`,
    [completedAt, attemptId],
  );
  const providerReceiptHash = await sha256Text(
    canonicalJson({
      version: "novel-skill-paid-evaluation-provider-receipt@1",
      target: target.exactTarget,
      requestProfileHash: selectedProfile.requestProfileHash,
      payloadHash: requestPayloadHash,
      executionLockHash,
      visibleOutputHash,
      visibleContentLength: Array.from(content).length,
      usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
      streamed: true,
      actualCostMicros: "5",
      currency: "USD",
      completedAt,
    }),
  );
  await executor.execute(
    `UPDATE novel_skill_evaluation_dispatch_reservations
     SET state = 'settled', settlement_outcome = 'succeeded',
         provider_receipt_hash = ?, provider_visible_output_hash = ?,
         output_candidate_id = ?, actual_cost_micros = '5', terminal_at = ?,
         revision = revision + 1 WHERE id = ?`,
    [providerReceiptHash, visibleOutputHash, candidateId, completedAt, reservationId],
  );
  return {
    ...ledger,
    authorizationId,
    reservationId,
    targetCatalogId: target.catalogEntryId,
  };
}

async function insertNovelSkillBackupScenario(executor: NodeSqliteExecutor): Promise<void> {
  const now = "2026-07-27T00:00:00.000Z";
  const completedAt = "2026-07-27T00:00:01.250Z";
  const definitionHash = "a".repeat(64);
  const selectionHash = "b".repeat(64);
  const modelInvocationId = "019f9f4a-b3c7-7350-9226-000000000751";
  const generationId = "019f9f4a-b3c7-7350-9226-000000000752";
  const snapshotId = "019f9f4a-b3c7-7350-9226-000000000753";
  const contextTraceId = "maintenance-novel-skill-context";
  const evaluationProjectId = "019f9f4a-b3c7-7350-9226-000000000760";
  const evaluationSuiteId = "019f9f4a-b3c7-7350-9226-000000000761";
  const evaluationRunId = "019f9f4a-b3c7-7350-9226-000000000762";
  const evaluationCellId = "019f9f4a-b3c7-7350-9226-000000000764";
  const evaluationAttemptId = "019f9f4a-b3c7-7350-9226-000000000765";
  const evaluationCandidateId = "019f9f4a-b3c7-7350-9226-000000000766";
  const evaluationModelInvocationId = "019f9f4a-b3c7-7350-9226-000000000767";
  const evaluationContextTraceId = "019f9f4a-b3c7-7350-9226-000000000768";
  const evaluationGenerationId = "019f9f4a-b3c7-7350-9226-000000000769";
  const evaluationSnapshotId = "019f9f4a-b3c7-7350-9226-00000000076a";
  const evaluationObservationId = "019f9f4a-b3c7-7350-9226-00000000076b";
  const evaluationContent = "isolated evaluation output";
  const evaluationFixture = NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY[0];
  const manifests = await evaluationManifestHashes();
  const preferenceConfigurationHash = "7".repeat(64);
  const modelSlots = [
    { slotId: "text_tier_a", modelTier: "economy" },
    { slotId: "text_tier_b", modelTier: "quality" },
  ] as const;
  const targetManifestHash = await sha256Text(
    canonicalJson({
      coreManifestHash: manifests.core,
      coreGenreManifestHash: manifests.coreGenre,
      coreGenrePreferencesManifestHash: manifests.coreGenrePreferences,
      preferenceConfigurationHash,
    }),
  );
  const planHash = await sha256Text(
    canonicalJson({
      compilerVersion: "novel-skill-compiler@1",
      evaluatorVersion: "novel-skill-ab@1",
      fixtureSetHash: NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH,
      minimumRepetitions: 2,
      modelSlots,
      targetManifestHash,
    }),
  );
  const evaluationContentHash = await sha256Text(evaluationContent);
  const evaluationVisibleLength = Array.from(evaluationContent).length;
  const evaluationModelIdentityHash = await sha256Text(
    JSON.stringify({
      catalogEntryId: "maintenance-model-catalog",
      connectionId: "maintenance-custom-model",
      modelId: "maintenance-writer",
      providerKind: "custom_openai_compatible",
    }),
  );
  const evaluationModelArtifactHash = await sha256Text(
    JSON.stringify({
      modelId: "maintenance-writer",
      providerKind: "custom_openai_compatible",
    }),
  );
  const paidStopPolicyHash = "896247754b670bf5c4ac89424e7c5f2fffa598df9adcdc1377d8fcf0868831a6";
  const paidProfiles = await Promise.all(
    [...new Set(NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY.map(({ taskType }) => taskType))]
      .sort((left, right) => left.localeCompare(right, "en"))
      .map(async (taskType) => ({
        taskType,
        profileVersion: "model-hub-exact-evaluation-request@1",
        requestProfileHash: await sha256Text(
          canonicalJson({
            version: "model-hub-exact-evaluation-request@1",
            task: taskType,
            maximumInputTokens: 7000,
            maximumOutputTokens: 2048,
            temperatureBasisPoints: 0,
            topPBasisPoints: 10000,
            reasoningMode: "disabled",
            responseFormat: "text",
            streaming: true,
            stopPolicyHash: paidStopPolicyHash,
            providerCallPolicy: "single_attempt",
          }),
        ),
        maximumInputTokens: 7000,
        maximumOutputTokens: 2048,
        temperatureBasisPoints: 0,
        topPBasisPoints: 10000,
        streaming: true,
        stopPolicyHash: paidStopPolicyHash,
      })),
  );
  const paidBaselines = await Promise.all(
    [...NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY]
      .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId, "en"))
      .map(async (fixture) => ({
        fixtureId: fixture.fixtureId,
        baselineContractHash: fixture.contractHash,
        includedSourceManifestHash: await sha256Text(`included:${fixture.fixtureId}`),
        omittedSourceManifestHash: await sha256Text(`omitted:${fixture.fixtureId}`),
        compiledBaselineHash: await sha256Text(`baseline:${fixture.fixtureId}`),
        baselineTokenBudget: 7000,
      })),
  );
  const paidRequestProfileManifestHash = await sha256Text(canonicalJson(paidProfiles));
  const paidContextBaselineManifestHash = await sha256Text(canonicalJson(paidBaselines));
  const paidProtocolHash = await sha256Text(
    canonicalJson({
      schemaVersion: 1,
      executionProtocolVersion: "novel-skill-paid-ab@1",
      suiteId: evaluationSuiteId,
      requestProfileManifestHash: paidRequestProfileManifestHash,
      contextBaselineManifestHash: paidContextBaselineManifestHash,
      promptTemplateVersion: "evaluation-template@1",
      promptTemplateHash: "4".repeat(64),
      rubricVersion: "novel-skill-human-rubric@1",
      rubricContentHash: "5".repeat(64),
      evaluatorContractHash: "6".repeat(64),
      blindingProtocolVersion: "blind-review@1",
      blindingProtocolHash: "7".repeat(64),
      randomizationProtocolVersion: "randomized-review@1",
      randomizationProtocolHash: "8".repeat(64),
    }),
  );
  const configurationSnapshot = {
    schemaVersion: 1,
    compilerVersion: "novel-skill-compiler@1",
    taskType: "continuation",
    invocationMode: "draft",
    maximumSkillTokens: 100,
    experimentalAllowed: true,
    genreTags: [],
    explicitSkillIds: ["core.maintenance"],
    availableContextLayers: ["current_task"],
    consideredDefinitions: [
      {
        skillId: "core.maintenance",
        version: "1.0.0",
        definitionHash,
        kind: "core",
        status: "experimental",
      },
    ],
    bindings: [
      {
        skillId: "core.maintenance",
        version: "1.0.0",
        enabled: true,
        activationMode: "manual",
        taskEnabled: null,
        taskInvocationMode: null,
        revision: 1,
      },
    ],
  };

  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO novel_skill_definitions (
         skill_id, version, display_name, summary, kind, owner_scope, status,
         default_enabled, precedence, task_types_json, activation_json,
         context_requirements_json, instructions_json, output_contract_json,
         validation_json, definition_hash, provenance_url, provenance_commit,
         provenance_license, created_at
       ) VALUES (
         'core.maintenance', '1.0.0', 'Maintenance core skill',
         'Content-free backup and restore fixture.', 'core', 'builtin',
         'experimental', 0, 500, '["continuation"]',
         '{"invocationModes":["draft"]}',
         '{"requiredLayers":["current_task"]}',
         '{"rules":[{"id":"maintenance-rule","text":"fixture"}]}',
         '{"format":"prose"}',
         '{"checks":["candidate_isolated"]}',
         ?, NULL, NULL, NULL, ?
       )`,
      [definitionHash, now],
    );
    await transaction.execute(
      `INSERT INTO project_novel_skill_bindings (
         project_id, skill_id, pinned_version, enabled, activation_mode,
         task_overrides_json, revision, created_at, updated_at
       ) VALUES (?, 'core.maintenance', '1.0.0', 1, 'manual', '{}', 1, ?, ?)`,
      [BACKUP_PROJECT_ID, now, now],
    );
    await transaction.execute(
      `INSERT INTO model_invocation_facts (
         id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
         model_id_snapshot, route_reason, status, attempt, privacy_policy,
         data_destination, created_at
       ) VALUES (
         ?, 'continuation', 'maintenance-custom-model', 'maintenance-model-catalog',
         'custom_openai_compatible', 'maintenance-writer', 'user_override',
         'queued', 1, 'cloud_allowed', 'remote', ?
       )`,
      [modelInvocationId, now],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_runs (
         id, project_id, chapter_id, task_type, maximum_context_tokens,
         required_tokens, used_tokens, remaining_tokens, discarded_tokens,
         token_estimate_source, candidate_count, included_count, discarded_count,
         created_at
       ) VALUES (
         ?, ?, NULL, 'continuation', 1000, 1, 1, 999, 0,
         'utf8_conservative', 1, 1, 0, ?
       )`,
      [contextTraceId, BACKUP_PROJECT_ID, now],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_entries (
         run_id, candidate_id, layer, selection_reason, included,
         discarded_reason, estimated_tokens, evaluation_order, layer_order,
         priority, relevance_score, required, budget_remaining_before,
         budget_remaining_after
       ) VALUES (
         ?, 'maintenance-novel-skill-task', 'current_task',
         'The explicit continuation task is required.', 1, NULL, 1, 1, 2,
         100, 1.0, 1, 1000, 999
       )`,
      [contextTraceId],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_execution_links (
         trace_id, generation_id, generation_run_id, created_at
       ) VALUES (?, ?, NULL, ?)`,
      [contextTraceId, generationId, now],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_model_invocation_links (
         trace_id, model_invocation_id, linked_at
       ) VALUES (?, ?, ?)`,
      [contextTraceId, modelInvocationId, now],
    );
    await transaction.execute(
      `INSERT INTO novel_skill_invocation_snapshots (
         id, project_id, context_trace_id, model_invocation_id, task_type,
         invocation_mode, compiler_version, maximum_skill_tokens,
         used_skill_tokens, discarded_skill_tokens, candidate_count,
         included_count, discarded_count, selection_hash,
         configuration_snapshot_json, created_at
       ) VALUES (
         ?, ?, ?, ?, 'continuation', 'draft', 'novel-skill-compiler@1',
         100, 10, 0, 1, 1, 0, ?, ?, ?
       )`,
      [
        snapshotId,
        BACKUP_PROJECT_ID,
        contextTraceId,
        modelInvocationId,
        selectionHash,
        JSON.stringify(configurationSnapshot),
        now,
      ],
    );
    await transaction.execute(
      `INSERT INTO novel_skill_invocation_items (
         snapshot_id, item_order, skill_id, skill_version, definition_hash,
         activation_source, selection_reason, precedence, included,
         discarded_reason, estimated_tokens
       ) VALUES (
         ?, 1, 'core.maintenance', '1.0.0', ?, 'explicit', 'selected',
         500, 1, NULL, 10
       )`,
      [snapshotId, definitionHash],
    );
    await transaction.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at,
         archived_at, trashed_at, retention_until, status_before_trash
       ) VALUES (?, 'Internal Novel Skill evaluation fixture', 'archived', 1, 0,
                 ?, ?, ?, NULL, NULL, NULL)`,
      [evaluationProjectId, now, now, now],
    );
    await transaction.execute(
      `INSERT INTO novel_skill_evaluation_suites (
         id, schema_version, evaluator_version, compiler_version, evaluation_project_id,
         plan_hash, fixture_set_hash, target_manifest_hash, core_manifest_hash,
         core_genre_manifest_hash, core_genre_preferences_manifest_hash,
         preference_configuration_hash, model_slots_json, minimum_repetitions, created_at
       ) VALUES (?, 1, 'novel-skill-ab@1', 'novel-skill-compiler@1',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
      [
        evaluationSuiteId,
        evaluationProjectId,
        planHash,
        NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH,
        targetManifestHash,
        manifests.core,
        manifests.coreGenre,
        manifests.coreGenrePreferences,
        preferenceConfigurationHash,
        JSON.stringify(modelSlots),
        now,
      ],
    );
    await insertEvaluationManifestFixtures(transaction, evaluationSuiteId, now);
    for (const fixture of NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY) {
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_fixtures (
           suite_id, fixture_id, language, origin, task_type, invocation_mode,
           genre_tags_json, coverage_dimensions_json, contract_hash, input_content_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          evaluationSuiteId,
          fixture.fixtureId,
          fixture.language,
          fixture.origin,
          fixture.taskType,
          fixture.invocationMode,
          JSON.stringify(fixture.genreTags),
          JSON.stringify(fixture.coverageDimensions),
          fixture.contractHash,
          fixture.inputContentHash,
        ],
      );
    }
    await transaction.execute(
      `INSERT INTO novel_skill_evaluation_runs (
         id, suite_id, status, evaluation_status, model_assignments_json,
         revision, started_at, completed_at, created_at
       ) VALUES (?, ?, 'planned', 'NOT_EVALUATED', ?, 1, NULL, NULL, ?)`,
      [
        evaluationRunId,
        evaluationSuiteId,
        JSON.stringify([
          {
            slotId: "text_tier_a",
            modelIdentityHash: evaluationModelIdentityHash,
            modelArtifactHash: evaluationModelArtifactHash,
          },
          {
            slotId: "text_tier_b",
            modelIdentityHash: "a".repeat(64),
            modelArtifactHash: "d".repeat(64),
          },
        ]),
        now,
      ],
    );
    await transaction.execute(
      `UPDATE novel_skill_evaluation_runs
       SET status = 'running', started_at = ?, revision = revision + 1
       WHERE id = ?`,
      [now, evaluationRunId],
    );
    await transaction.execute(
      `INSERT INTO novel_skill_evaluation_cells (
         id, run_id, suite_id, fixture_id, arm, arm_configuration_hash,
         model_slot_id, model_tier, repetition, state, created_at
       ) VALUES (?, ?, ?, ?, 'core', ?,
                 'text_tier_a', 'economy', 1, 'planned', ?)`,
      [
        evaluationCellId,
        evaluationRunId,
        evaluationSuiteId,
        evaluationFixture.fixtureId,
        manifests.core,
        now,
      ],
    );
    let generatedCellId = 0x1000;
    for (const { fixtureId } of NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY) {
      for (const [arm, armHash] of [
        ["no_skill", null],
        ["core", manifests.core],
        ["core_genre", manifests.coreGenre],
        ["core_genre_preferences", manifests.coreGenrePreferences],
      ] as const) {
        for (const [slotId, modelTier] of [
          ["text_tier_a", "economy"],
          ["text_tier_b", "quality"],
        ] as const) {
          for (const repetition of [1, 2] as const) {
            if (
              fixtureId === evaluationFixture.fixtureId &&
              arm === "core" &&
              slotId === "text_tier_a" &&
              repetition === 1
            ) {
              continue;
            }
            const cellId = `019f9f4a-b3c7-7350-9226-${generatedCellId
              .toString(16)
              .padStart(12, "0")}`;
            generatedCellId += 1;
            await transaction.execute(
              `INSERT INTO novel_skill_evaluation_cells (
                 id, run_id, suite_id, fixture_id, arm, arm_configuration_hash,
                 model_slot_id, model_tier, repetition, state, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
              [
                cellId,
                evaluationRunId,
                evaluationSuiteId,
                fixtureId,
                arm,
                armHash,
                slotId,
                modelTier,
                repetition,
                now,
              ],
            );
          }
        }
      }
    }
    await transaction.execute(
      `INSERT INTO novel_skill_evaluation_attempts (
         id, run_id, cell_id, attempt_number, status, context_trace_id,
         model_invocation_id, error_code, started_at, completed_at
       ) VALUES (?, ?, ?, 1, 'started', NULL, NULL, NULL, ?, NULL)`,
      [evaluationAttemptId, evaluationRunId, evaluationCellId, now],
    );
    await transaction.execute(
      `INSERT INTO ai_candidates (
         id, project_id, chapter_id, source, base_version_id, content, content_checksum,
         status, incomplete, created_at, updated_at, decided_at
       ) VALUES (?, ?, NULL, 'generate', NULL, ?, ?,
                 'ready', 0, ?, ?, NULL)`,
      [
        evaluationCandidateId,
        evaluationProjectId,
        evaluationContent,
        evaluationContentHash,
        now,
        now,
      ],
    );
    await transaction.execute(
      `INSERT INTO model_invocation_facts (
         id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
         model_id_snapshot, route_reason, status, attempt, privacy_policy,
         data_destination, input_tokens, output_tokens, estimated_cost_micros, currency,
         started_at, completed_at, created_at, finish_reason, visible_content_length, streamed
       ) VALUES (?, 'continuation', 'maintenance-custom-model', 'maintenance-model-catalog',
                 'custom_openai_compatible', 'maintenance-writer', 'user_override',
                 'succeeded', 1, 'cloud_allowed', 'remote', 10, 20, '30', 'USD',
                 ?, ?, ?, 'stop', ?, 0)`,
      [evaluationModelInvocationId, now, completedAt, now, evaluationVisibleLength],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_runs (
         id, project_id, chapter_id, task_type, maximum_context_tokens,
         required_tokens, used_tokens, remaining_tokens, discarded_tokens,
         token_estimate_source, candidate_count, included_count, discarded_count,
         created_at
       ) VALUES (?, ?, NULL, 'continuation', 1000, 1, 1, 999, 0,
                 'utf8_conservative', 1, 1, 0, ?)`,
      [evaluationContextTraceId, evaluationProjectId, now],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_entries (
         run_id, candidate_id, layer, selection_reason, included,
         discarded_reason, estimated_tokens, evaluation_order, layer_order,
         priority, relevance_score, required, budget_remaining_before,
         budget_remaining_after
       ) VALUES (?, ?, 'current_task',
                 'Fixed evaluation task contract.', 1, NULL, 1, 1, 2,
                 100, 1.0, 1, 1000, 999)`,
      [evaluationContextTraceId, `evaluation-fixture:${evaluationFixture.fixtureId}`],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_entry_sources (
         run_id, candidate_id, source_order, source_type, source_id,
         source_version_id, locator, content_hash
       ) VALUES (?, ?, 1, 'user_input', ?, NULL, 'novel_skill_evaluation_fixture', ?)`,
      [
        evaluationContextTraceId,
        `evaluation-fixture:${evaluationFixture.fixtureId}`,
        evaluationFixture.fixtureId,
        evaluationFixture.inputContentHash,
      ],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_execution_links (
         trace_id, generation_id, generation_run_id, created_at
       ) VALUES (?, ?, NULL, ?)`,
      [evaluationContextTraceId, evaluationGenerationId, now],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_model_invocation_links (
         trace_id, model_invocation_id, linked_at
       ) VALUES (?, ?, ?)`,
      [evaluationContextTraceId, evaluationModelInvocationId, now],
    );
    await transaction.execute(
      `INSERT INTO context_compilation_output_candidate_links (
         trace_id, ai_candidate_id, linked_at
       ) VALUES (?, ?, ?)`,
      [evaluationContextTraceId, evaluationCandidateId, now],
    );
    const evaluationConfigurationSnapshot = {
      schemaVersion: 1,
      compilerVersion: "novel-skill-compiler@1",
      taskType: "continuation",
      invocationMode: "draft",
      maximumSkillTokens: 100,
      experimentalAllowed: true,
      genreTags: [...evaluationFixture.genreTags],
      explicitSkillIds: ["core.evaluation_fixture"],
      availableContextLayers: ["current_task"],
      consideredDefinitions: [
        {
          skillId: "core.evaluation_fixture",
          version: "1.0.0",
          definitionHash: "e".repeat(64),
          kind: "core",
          status: "experimental",
        },
      ],
      bindings: [],
    };
    await transaction.execute(
      `INSERT INTO novel_skill_invocation_snapshots (
         id, project_id, context_trace_id, model_invocation_id, task_type,
         invocation_mode, compiler_version, maximum_skill_tokens,
         used_skill_tokens, discarded_skill_tokens, candidate_count,
         included_count, discarded_count, selection_hash,
         configuration_snapshot_json, created_at
       ) VALUES (?, ?, ?, ?, 'continuation', 'draft', 'novel-skill-compiler@1',
                 100, 10, 0, 1, 1, 0, ?, ?, ?)`,
      [
        evaluationSnapshotId,
        evaluationProjectId,
        evaluationContextTraceId,
        evaluationModelInvocationId,
        await sha256Text(canonicalJson(evaluationConfigurationSnapshot)),
        JSON.stringify(evaluationConfigurationSnapshot),
        now,
      ],
    );
    await transaction.execute(
      `INSERT INTO novel_skill_invocation_items (
         snapshot_id, item_order, skill_id, skill_version, definition_hash,
         activation_source, selection_reason, precedence, included,
         discarded_reason, estimated_tokens
       ) VALUES (?, 1, 'core.evaluation_fixture', '1.0.0', ?, 'explicit',
                 'selected', 200, 1, NULL, 10)`,
      [evaluationSnapshotId, "e".repeat(64)],
    );
    await transaction.execute(
      `UPDATE novel_skill_evaluation_attempts
       SET context_trace_id = ?, model_invocation_id = ?
       WHERE id = ? AND status = 'started'`,
      [evaluationContextTraceId, evaluationModelInvocationId, evaluationAttemptId],
    );
    await transaction.execute(
      `UPDATE novel_skill_evaluation_attempts
       SET status = 'succeeded', context_trace_id = ?, model_invocation_id = ?,
           error_code = NULL, completed_at = ?
       WHERE id = ?`,
      [evaluationContextTraceId, evaluationModelInvocationId, completedAt, evaluationAttemptId],
    );
    await transaction.execute(
      `INSERT INTO novel_skill_evaluation_observations (
         id, run_id, cell_id, attempt_id, context_trace_id, model_invocation_id,
         output_candidate_id, novel_skill_snapshot_id, model_identity_hash,
         model_artifact_hash,
         arm_configuration_hash, preference_configuration_hash, evaluator_version,
         result_hash, latency_milliseconds, input_tokens, output_tokens,
         estimated_cost_micros, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'novel-skill-ab@1',
                 ?, 1250, 10, 20, 30, ?)`,
      [
        evaluationObservationId,
        evaluationRunId,
        evaluationCellId,
        evaluationAttemptId,
        evaluationContextTraceId,
        evaluationModelInvocationId,
        evaluationCandidateId,
        evaluationSnapshotId,
        evaluationModelIdentityHash,
        evaluationModelArtifactHash,
        manifests.core,
        evaluationContentHash,
        now,
      ],
    );
    for (const metric of [
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
    ] as const) {
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_scores (
           observation_id, metric, score_basis_points, reviewer_id, rubric_version, scored_at
         ) VALUES (?, ?, 9000, 'reviewer:maintenance', 'novel-skill-human-rubric@1', ?)`,
        [evaluationObservationId, metric, now],
      );
    }
    await transaction.execute(
      `UPDATE novel_skill_evaluation_cells SET state = 'observed' WHERE id = ?`,
      [evaluationCellId],
    );
    await transaction.execute(
      `UPDATE novel_skill_evaluation_runs
       SET status = 'invalidated', evaluation_status = 'EVIDENCE_INCOMPLETE',
           completed_at = ?, revision = revision + 1 WHERE id = ?`,
      [now, evaluationRunId],
    );
    await transaction.execute(
      `UPDATE novel_skill_evaluation_cells SET state = 'invalidated'
       WHERE run_id = ? AND state = 'planned'`,
      [evaluationRunId],
    );
    await transaction.execute(
      `INSERT INTO novel_skill_evaluation_manual_decisions (
         id, run_id, target_manifest_hash, decision, rationale_hash, created_at
       ) VALUES ('019f9f4a-b3c7-7350-9226-000000000763', ?, ?,
                 'KEEP_DISABLED', ?, ?)`,
      [evaluationRunId, targetManifestHash, "b".repeat(64), now],
    );
    await transaction.execute(
      `INSERT INTO novel_skill_evaluation_protocols (
         suite_id, schema_version, execution_protocol_version, protocol_hash,
         request_profile_manifest_hash, context_baseline_manifest_hash,
         prompt_template_version, prompt_template_hash, rubric_version,
         rubric_content_hash, evaluator_contract_hash, blinding_protocol_version,
         blinding_protocol_hash, randomization_protocol_version,
         randomization_protocol_hash, created_at
       ) VALUES (?, 1, 'novel-skill-paid-ab@1', ?, ?, ?, 'evaluation-template@1', ?,
                 'novel-skill-human-rubric@1', ?, ?, 'blind-review@1', ?,
                 'randomized-review@1', ?, ?)`,
      [
        evaluationSuiteId,
        paidProtocolHash,
        paidRequestProfileManifestHash,
        paidContextBaselineManifestHash,
        "4".repeat(64),
        "5".repeat(64),
        "6".repeat(64),
        "7".repeat(64),
        "8".repeat(64),
        now,
      ],
    );
    for (const profile of paidProfiles) {
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_request_profiles (
           suite_id, task_type, profile_version, request_profile_hash,
           maximum_input_tokens, maximum_output_tokens, temperature_basis_points,
           top_p_basis_points, reasoning_policy, response_format, streaming,
           stop_policy_hash, created_at
         ) VALUES (?, ?, 'model-hub-exact-evaluation-request@1', ?, 7000, 2048, 0, 10000,
                   'disabled', 'text', 1, ?, ?)`,
        [evaluationSuiteId, profile.taskType, profile.requestProfileHash, paidStopPolicyHash, now],
      );
    }
    for (const baseline of paidBaselines) {
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_context_baselines (
           suite_id, fixture_id, baseline_contract_hash,
           included_source_manifest_hash, omitted_source_manifest_hash,
           compiled_baseline_hash, baseline_token_budget, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 7000, ?)`,
        [
          evaluationSuiteId,
          baseline.fixtureId,
          baseline.baselineContractHash,
          baseline.includedSourceManifestHash,
          baseline.omittedSourceManifestHash,
          baseline.compiledBaselineHash,
          now,
        ],
      );
    }
  });
}

async function expectNovelSkillBackupTamperRejected(
  tamper: (backup: NodeSqliteExecutor) => Promise<void>,
): Promise<void> {
  const executor = new NodeSqliteExecutor(inkShadowMigration);
  const service = new DatabaseMaintenanceService(executor);
  const now = "2026-07-27T00:00:00.000Z";
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, 'Restore semantic tamper host', 'active', 1, 0,
               ?, ?, NULL, NULL, NULL, NULL)`,
    [BACKUP_PROJECT_ID, now, now],
  );
  await insertModelHubExpertConnection(executor);
  await insertNovelSkillBackupScenario(executor);
  expect(await service.createConsistentBackup(backupPath)).toMatchObject({ ok: true });
  const backup = new NodeSqliteExecutor("", backupPath);
  try {
    await tamper(backup);
  } finally {
    await backup.close();
  }
  expect(await service.restoreConsistentBackup(backupPath)).toMatchObject({
    ok: false,
    error: { details: { operation: "DATABASE_RESTORE_BACKUP_INCOMPATIBLE" } },
  });
  await executor.close();
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
       content_hash, source_updated_at, indexed_at, chunk_kind,
       parent_document_id, utf16_start, utf16_end, source_length,
       scene_id, event_id, character_ids_json, location_ids_json, story_time, branch_id,
       pov_character_id, story_order, authority, privacy, currentness,
       omitted_scope_fields_json
     ) VALUES (?, ?, 'chapter', ?, ?, '第一章', ?, '第一章', ?, ?, ?, ?,
               'chapter', NULL, 0, ?, ?, NULL, NULL, '[]', '[]', NULL, NULL, NULL, 1,
               'accepted_text', 'standard', 'current',
               '["scene","event","pov","characters","locations","story_time"]')`,
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
      searchText.length,
      searchText.length,
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
