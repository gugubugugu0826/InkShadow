import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0040_chapter_validation_snapshots.sql", import.meta.url),
  "utf8",
);
const deleteCascadeMigration = readFileSync(
  new URL("../migrations/0042_chapter_validation_snapshot_delete_cascade.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-08T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const SNAPSHOT_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const RERUN_SNAPSHOT_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const SECOND_RERUN_SNAPSHOT_ID = "019f9f4a-b3c7-7350-9226-000000000006";

describe("chapter validation snapshot migration", () => {
  it("stores an immutable version-bound result and is migration-idempotent", async () => {
    const executor = new NodeSqliteExecutor(coreMigration);
    await seedChapter(executor);
    expect(() => executor.database.exec(`${migration}\n${migration}`)).not.toThrow();
    await insertSnapshot(executor);

    expect(
      await executor.select<{
        readonly chapterVersionId: string;
        readonly issueCount: number;
        readonly severity: string;
      }>(
        `SELECT chapter_version_id AS chapterVersionId,
                issue_count AS issueCount,
                json_extract(result_json, '$.issues[0].severity') AS severity
         FROM chapter_validation_snapshots`,
      ),
    ).toEqual([{ chapterVersionId: VERSION_ID, issueCount: 1, severity: "error" }]);
    await expect(
      executor.execute("UPDATE chapter_validation_snapshots SET issue_count = 0 WHERE id = ?", [
        SNAPSHOT_ID,
      ]),
    ).rejects.toThrow(/immutable/iu);
    await executor.close();
  });

  it("rejects inconsistent result metadata and a version from another chapter", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}`);
    await seedChapter(executor);
    await expect(insertSnapshot(executor, { issueCount: 0 })).rejects.toThrow();

    const otherChapterId = "019f9f4a-b3c7-7350-9226-000000000102";
    const otherVersionId = "019f9f4a-b3c7-7350-9226-000000000103";
    await seedAdditionalChapter(executor, otherChapterId, otherVersionId);
    await expect(insertSnapshot(executor, { versionId: otherVersionId })).rejects.toThrow(
      /version binding/iu,
    );
    await executor.close();
  });

  it("requires a rerun to supersede the immediately previous chapter snapshot", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}`);
    await seedChapter(executor);
    await insertSnapshot(executor);
    await expect(
      insertSnapshot(executor, {
        id: "019f9f4a-b3c7-7350-9226-000000000005",
        runSequence: 2,
        runKind: "rerun",
        supersedesSnapshotId: "019f9f4a-b3c7-7350-9226-000000000099",
      }),
    ).rejects.toThrow(/rerun chain/iu);
    await executor.close();
  });

  it("upgrades an existing multi-run chain in one transaction without changing evidence", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}`);
    await seedChapter(executor);
    await insertSnapshot(executor);
    await insertSnapshot(executor, {
      id: RERUN_SNAPSHOT_ID,
      runSequence: 2,
      runKind: "rerun",
      supersedesSnapshotId: SNAPSHOT_ID,
      checksum: "d".repeat(64),
    });
    await insertSnapshot(executor, {
      id: SECOND_RERUN_SNAPSHOT_ID,
      runSequence: 3,
      runKind: "rerun",
      supersedesSnapshotId: RERUN_SNAPSHOT_ID,
      checksum: "e".repeat(64),
    });
    const before = await selectSnapshotEvidence(executor);

    executor.database.exec("BEGIN IMMEDIATE");
    try {
      executor.database.exec(deleteCascadeMigration);
      executor.database.exec("COMMIT");
    } catch (error: unknown) {
      executor.database.exec("ROLLBACK");
      throw error;
    }

    expect(await selectSnapshotEvidence(executor)).toEqual(before);
    await expect(executor.select("PRAGMA foreign_key_check")).resolves.toEqual([]);
    await expect(
      executor.select<{ readonly count: number }>(
        `SELECT COUNT(*) AS count
         FROM sqlite_schema
         WHERE type = 'table'
           AND name = 'chapter_validation_snapshots_0040_legacy'`,
      ),
    ).resolves.toEqual([{ count: 0 }]);
    expect(
      await executor.select<{ readonly onDelete: string }>(
        `SELECT on_delete AS onDelete
         FROM pragma_foreign_key_list('chapter_validation_snapshots')
         WHERE "from" = 'supersedes_snapshot_id'`,
      ),
    ).toEqual([{ onDelete: "CASCADE" }]);
    await expect(
      executor.execute("UPDATE chapter_validation_snapshots SET issue_count = 0 WHERE id = ?", [
        SNAPSHOT_ID,
      ]),
    ).rejects.toThrow(/immutable/iu);
    await executor.close();
  });

  it("cascades a deleted initial snapshot through every rerun and permits delete-all", async () => {
    const executor = new NodeSqliteExecutor(
      `${coreMigration}\n${migration}\n${deleteCascadeMigration}`,
    );
    await seedChapter(executor);
    await insertThreeSnapshotChain(executor);

    await expect(
      executor.execute("DELETE FROM chapter_validation_snapshots WHERE id = ?", [SNAPSHOT_ID]),
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await expect(snapshotCount(executor)).resolves.toBe(0);

    await insertThreeSnapshotChain(executor);
    await expect(
      executor.execute("DELETE FROM chapter_validation_snapshots"),
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await expect(snapshotCount(executor)).resolves.toBe(0);
    await executor.close();
  });

  it("cascades snapshot chains when their chapter or project is deleted", async () => {
    const chapterExecutor = new NodeSqliteExecutor(
      `${coreMigration}\n${migration}\n${deleteCascadeMigration}`,
    );
    await seedChapter(chapterExecutor);
    await insertThreeSnapshotChain(chapterExecutor);
    await chapterExecutor.execute("DELETE FROM chapters WHERE id = ?", [CHAPTER_ID]);
    await expect(snapshotCount(chapterExecutor)).resolves.toBe(0);
    await chapterExecutor.close();

    const projectExecutor = new NodeSqliteExecutor(
      `${coreMigration}\n${migration}\n${deleteCascadeMigration}`,
    );
    await seedChapter(projectExecutor);
    await insertThreeSnapshotChain(projectExecutor);
    await projectExecutor.execute("DELETE FROM projects WHERE id = ?", [PROJECT_ID]);
    await expect(snapshotCount(projectExecutor)).resolves.toBe(0);
    await projectExecutor.close();
  });

  it("still rejects a rerun that does not supersede the immediately previous snapshot", async () => {
    const executor = new NodeSqliteExecutor(
      `${coreMigration}\n${migration}\n${deleteCascadeMigration}`,
    );
    await seedChapter(executor);
    await insertSnapshot(executor);
    await expect(
      insertSnapshot(executor, {
        id: RERUN_SNAPSHOT_ID,
        runSequence: 2,
        runKind: "rerun",
        supersedesSnapshotId: RERUN_SNAPSHOT_ID,
      }),
    ).rejects.toThrow(/rerun chain/iu);
    await executor.close();
  });
});

async function seedChapter(executor: NodeSqliteExecutor): Promise<void> {
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at
       ) VALUES (?, '检查快照测试', 'active', 1, 0, ?, ?)`,
      [PROJECT_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision,
         current_version_id, created_at, updated_at, trashed_at
       ) VALUES (?, ?, '第一章', '林遥已经死去。', 'active', 1, ?, ?, ?, NULL)`,
      [CHAPTER_ID, PROJECT_ID, VERSION_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence,
         content, content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, '林遥已经死去。', ?, 'created', NULL, ?)`,
      [VERSION_ID, PROJECT_ID, CHAPTER_ID, "a".repeat(64), NOW],
    );
  });
}

async function seedAdditionalChapter(
  executor: NodeSqliteExecutor,
  chapterId: string,
  versionId: string,
): Promise<void> {
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision,
         current_version_id, created_at, updated_at, trashed_at
       ) VALUES (?, ?, '第二章', '另一段正文。', 'active', 1, ?, ?, ?, NULL)`,
      [chapterId, PROJECT_ID, versionId, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence,
         content, content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, '另一段正文。', ?, 'created', NULL, ?)`,
      [versionId, PROJECT_ID, chapterId, "b".repeat(64), NOW],
    );
  });
}

async function insertSnapshot(
  executor: NodeSqliteExecutor,
  overrides: Readonly<{
    id?: string;
    versionId?: string;
    issueCount?: number;
    runSequence?: number;
    runKind?: "initial" | "rerun";
    supersedesSnapshotId?: string | null;
    checksum?: string;
  }> = {},
): Promise<void> {
  const result = {
    status: "checked",
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    chapterVersionId: overrides.versionId ?? VERSION_ID,
    chapterRevision: 1,
    issues: [{ severity: "error", currentEvidence: [], conflictingEvidence: [] }],
  };
  await executor.execute(
    `INSERT INTO chapter_validation_snapshots (
       id, project_id, chapter_id, chapter_version_id, chapter_revision,
       schema_version, rule_set_version, run_sequence, run_kind,
       supersedes_snapshot_id, result_status, issue_count,
       result_checksum_sha256, result_json, generated_at
     ) VALUES (?, ?, ?, ?, 1, 1, 'deterministic-novel-validator.v1', ?, ?, ?,
               'checked', ?, ?, ?, ?)`,
    [
      overrides.id ?? SNAPSHOT_ID,
      PROJECT_ID,
      CHAPTER_ID,
      overrides.versionId ?? VERSION_ID,
      overrides.runSequence ?? 1,
      overrides.runKind ?? "initial",
      overrides.supersedesSnapshotId ?? null,
      overrides.issueCount ?? 1,
      overrides.checksum ?? "c".repeat(64),
      JSON.stringify(result),
      NOW,
    ],
  );
}

async function insertThreeSnapshotChain(executor: NodeSqliteExecutor): Promise<void> {
  await insertSnapshot(executor);
  await insertSnapshot(executor, {
    id: RERUN_SNAPSHOT_ID,
    runSequence: 2,
    runKind: "rerun",
    supersedesSnapshotId: SNAPSHOT_ID,
    checksum: "d".repeat(64),
  });
  await insertSnapshot(executor, {
    id: SECOND_RERUN_SNAPSHOT_ID,
    runSequence: 3,
    runKind: "rerun",
    supersedesSnapshotId: RERUN_SNAPSHOT_ID,
    checksum: "e".repeat(64),
  });
}

async function snapshotCount(executor: NodeSqliteExecutor): Promise<number> {
  const rows = await executor.select<{ readonly count: number }>(
    "SELECT COUNT(*) AS count FROM chapter_validation_snapshots",
  );
  return rows[0]?.count ?? -1;
}

async function selectSnapshotEvidence(executor: NodeSqliteExecutor): Promise<readonly object[]> {
  return executor.select(
    `SELECT id,
            project_id AS projectId,
            chapter_id AS chapterId,
            chapter_version_id AS chapterVersionId,
            chapter_revision AS chapterRevision,
            schema_version AS schemaVersion,
            rule_set_version AS ruleSetVersion,
            run_sequence AS runSequence,
            run_kind AS runKind,
            supersedes_snapshot_id AS supersedesSnapshotId,
            result_status AS resultStatus,
            issue_count AS issueCount,
            result_checksum_sha256 AS checksum,
            result_json AS resultJson,
            generated_at AS generatedAt
     FROM chapter_validation_snapshots
     ORDER BY run_sequence`,
  );
}
