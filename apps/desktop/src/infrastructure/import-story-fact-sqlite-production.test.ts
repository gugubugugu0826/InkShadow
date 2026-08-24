import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ImportProject } from "@inkshadow/application";
import { createSqliteRepositories } from "@inkshadow/data";
import {
  parseIsoUtcTimestamp,
  parseUuidV7,
  type Clock,
  type IsoUtcTimestamp,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import { CryptoContentHasher } from "@inkshadow/platform";
import {
  SqliteStoryFactStore,
  StoryFactApplicationService,
  parseUuidV7 as parseStoryUuidV7,
} from "@inkshadow/story-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { ensureCurrentSavedVersionStoryFactsForDirectMode } from "./accepted-chapter-fact-preflight";
import {
  ACCEPTED_CHAPTER_PIPELINE_OPERATION,
  ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE,
  type AcceptedChapterPipelineRuntime,
} from "./accepted-chapter-pipeline";
import { AcceptedChapterPipelineWorker } from "./accepted-chapter-pipeline-worker";
import { createAcceptedVersionTaskFactory } from "./runtime";
import { TauriTaskCenterStore } from "./task-center-store";

const NOW = expectTimestamp("2026-08-25T00:00:00.000Z");
const IMPORTED_CONTENT = [
  "周望是钟楼的管理员。",
  "周望五十七岁。",
  "周望担任钟楼管理员。",
  "周望在旧城守了三十一年。",
  "周望和赵伯是多年的老邻居。",
  "钟摆倒转。",
].join("");

const temporaryDirectories: string[] = [];
const openExecutors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  for (const executor of openExecutors.splice(0)) {
    await executor.close().catch(() => undefined);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("imported story facts through the production SQLite boundary", () => {
  it("persists responsibility and task metadata, then organizes idempotently after a process restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "inkshadow-import-facts-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "inkshadow.sqlite");
    const clock = fixedClock();
    const hasher = new CryptoContentHasher();
    const firstExecutor = new NodeSqliteExecutor(readCurrentLocalSchema(), databasePath);
    openExecutors.push(firstExecutor);
    const firstRepositories = createSqliteRepositories(firstExecutor, {
      acceptedVersionTaskFactory: createAcceptedVersionTaskFactory(new SequentialIds(500)),
    });
    const importer = new ImportProject(
      firstRepositories.projects,
      firstRepositories.projectImports,
      new SequentialIds(1),
      clock,
      hasher,
    );

    const imported = expectApplicationOk(
      await importer.execute({
        name: "SQLite 钟楼导入",
        chapters: [{ title: "第一章", content: IMPORTED_CONTENT }],
      }),
    );
    const project = imported.project;
    const chapter = expectPresent(imported.chapters[0]);
    const firstVersion = expectPresent(
      expectApplicationOk(
        await firstRepositories.chapterVersions.findVersionById(chapter.currentVersionId),
      ),
    ).toSnapshot();
    expect(firstVersion).toMatchObject({
      reason: "import",
      content: IMPORTED_CONTENT,
      organizeLocalStoryFacts: true,
    });
    const persistedPipelineRows = await firstExecutor.select<{
      readonly organizeLocalStoryFacts: number;
      readonly taskStatus: string;
      readonly taskType: string;
      readonly idempotencyKey: string;
      readonly metadataJson: string;
    }>(
      `SELECT version.organize_local_story_facts AS organizeLocalStoryFacts,
              task.status AS taskStatus,
              task.task_type AS taskType,
              task.idempotency_key AS idempotencyKey,
              task.metadata_json AS metadataJson
       FROM chapter_versions AS version
       INNER JOIN background_tasks AS task
         ON json_extract(task.metadata_json, '$.versionId') = version.id
       WHERE version.id = ?`,
      [firstVersion.id],
    );
    expect(persistedPipelineRows).toHaveLength(1);
    const persistedPipelineRow = expectPresent(persistedPipelineRows[0]);
    expect(persistedPipelineRow).toMatchObject({
      organizeLocalStoryFacts: 1,
      taskStatus: "queued",
      taskType: ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE,
      idempotencyKey: `story.accepted-version:${firstVersion.id}`,
    });
    expect(typeof persistedPipelineRow.metadataJson).toBe("string");
    const persistedTask = expectPresent(
      (
        await firstExecutor.select<{ readonly metadataJson: string }>(
          `SELECT metadata_json AS metadataJson
           FROM background_tasks
           WHERE idempotency_key = ?`,
          [`story.accepted-version:${firstVersion.id}`],
        )
      )[0],
    );
    expect(JSON.parse(persistedTask.metadataJson)).toEqual({
      projectId: project.id,
      chapterId: chapter.id,
      versionId: firstVersion.id,
      source: "chapter_import",
      acceptedCharacterCount: IMPORTED_CONTENT.length,
      organizeLocalStoryFacts: true,
      runSearch: true,
      runChapterSummary: false,
      runStoryState: false,
      runCausalProjection: true,
      operation: ACCEPTED_CHAPTER_PIPELINE_OPERATION,
    });
    await firstExecutor.close();
    openExecutors.splice(openExecutors.indexOf(firstExecutor), 1);

    const restartedExecutor = new NodeSqliteExecutor("", databasePath);
    openExecutors.push(restartedExecutor);
    try {
      const restartedRepositories = createSqliteRepositories(restartedExecutor, {
        acceptedVersionTaskFactory: createAcceptedVersionTaskFactory(new SequentialIds(600)),
      });
      const taskCenter = new TauriTaskCenterStore(restartedExecutor, clock);
      const facts = new SqliteStoryFactStore(restartedExecutor);
      const factService = new StoryFactApplicationService({
        facts,
        clock,
        ids: new SequentialIds(700),
      });
      const providerStage = vi.fn();
      const pipelineRuntime = {
        taskCenter,
        search: {
          rebuildProject: vi.fn(() => Promise.resolve({ ok: true, value: {} })),
        },
        story: {
          chapterSummaries: { summarizeSavedVersion: providerStage },
          continuousState: { extractSavedVersion: providerStage },
          causalProjector: {
            rebuildProject: vi.fn(() => Promise.resolve({ eventCount: 0, relationCount: 0 })),
          },
        },
        ids: new SequentialIds(800),
        clock,
      } as unknown as AcceptedChapterPipelineRuntime;
      const preflightRuntime = {
        clock,
        hasher,
        repositories: restartedRepositories,
        story: { facts, factService },
      };
      const worker = new AcceptedChapterPipelineWorker(pipelineRuntime, {
        queuedGraceMilliseconds: 0,
        ensureCurrentFacts: (input) =>
          ensureCurrentSavedVersionStoryFactsForDirectMode(preflightRuntime, input),
      });

      expect(
        expectPresent(
          expectApplicationOk(
            await restartedRepositories.chapterVersions.findVersionById(firstVersion.id),
          ),
        ).toSnapshot(),
      ).toEqual(firstVersion);
      expect(expectStoryOk(await facts.listByProjectId(expectStoryUuid(project.id)))).toEqual([]);
      await expect(worker.runDueTasksNow()).resolves.toBe(1);

      const organized = expectStoryOk(await facts.listByProjectId(expectStoryUuid(project.id)))
        .map((fact) => fact.toSnapshot())
        .filter(({ factType }) => factType !== "chapter_summary");
      expect(organized).toHaveLength(7);
      expect(
        organized.every(
          ({ status, needsReview, source }) =>
            status === "unconfirmed" &&
            needsReview &&
            String(source.chapterId) === String(chapter.id) &&
            String(source.versionId) === String(firstVersion.id) &&
            IMPORTED_CONTENT.slice(source.startOffset ?? -1, source.endOffset ?? -1) ===
              source.excerpt,
        ),
      ).toBe(true);
      expect(
        (await taskCenter.load()).tasks.find(
          ({ idempotencyKey }) => idempotencyKey === `story.accepted-version:${firstVersion.id}`,
        ),
      ).toMatchObject({ status: "succeeded" });
      expect(providerStage).not.toHaveBeenCalled();

      const factIds = organized.map(({ id }) => id).sort();
      const queuedTaskCountBeforeRetry = await taskCount(restartedExecutor, firstVersion.id);
      const retryInput = expectPresent(
        (await taskCenter.load()).tasks.find(
          ({ idempotencyKey }) => idempotencyKey === `story.accepted-version:${firstVersion.id}`,
        ),
      ).metadata;
      await ensureCurrentSavedVersionStoryFactsForDirectMode(preflightRuntime, {
        projectId: expectDomainUuid(retryInput.projectId),
        chapterId: expectDomainUuid(retryInput.chapterId),
        versionId: expectDomainUuid(retryInput.versionId),
        source: "chapter_import",
        acceptedCharacterCount: IMPORTED_CONTENT.length,
        organizeLocalStoryFacts: true,
        runSearch: true,
        runChapterSummary: false,
        runStoryState: false,
        runCausalProjection: true,
      });
      expect(
        expectStoryOk(await facts.listByProjectId(expectStoryUuid(project.id)))
          .map((fact) => fact.toSnapshot())
          .filter(({ factType }) => factType !== "chapter_summary")
          .map(({ id }) => id)
          .sort(),
      ).toEqual(factIds);
      await expect(taskCount(restartedExecutor, firstVersion.id)).resolves.toBe(
        queuedTaskCountBeforeRetry,
      );
      expect(providerStage).not.toHaveBeenCalled();
    } finally {
      await restartedExecutor.close();
      openExecutors.splice(openExecutors.indexOf(restartedExecutor), 1);
    }
  });

  it("keeps the imported SQLite authority unchanged when restarted local organization fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "inkshadow-import-facts-failure-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "inkshadow.sqlite");
    const clock = fixedClock();
    const hasher = new CryptoContentHasher();
    const firstExecutor = new NodeSqliteExecutor(readCurrentLocalSchema(), databasePath);
    openExecutors.push(firstExecutor);
    const firstRepositories = createSqliteRepositories(firstExecutor, {
      acceptedVersionTaskFactory: createAcceptedVersionTaskFactory(new SequentialIds(900)),
    });
    const importer = new ImportProject(
      firstRepositories.projects,
      firstRepositories.projectImports,
      new SequentialIds(50),
      clock,
      hasher,
    );
    const imported = expectApplicationOk(
      await importer.execute({
        name: "SQLite 整理失败保护",
        chapters: [{ title: "第一章", content: IMPORTED_CONTENT }],
      }),
    );
    const chapter = expectPresent(imported.chapters[0]);
    const chapterBefore = expectPresent(
      expectApplicationOk(await firstRepositories.chapters.findById(chapter.id)),
    ).toSnapshot();
    const versionBefore = expectPresent(
      expectApplicationOk(
        await firstRepositories.chapterVersions.findVersionById(chapter.currentVersionId),
      ),
    ).toSnapshot();
    await firstExecutor.close();
    openExecutors.splice(openExecutors.indexOf(firstExecutor), 1);

    const restartedExecutor = new NodeSqliteExecutor("", databasePath);
    openExecutors.push(restartedExecutor);
    try {
      const restartedRepositories = createSqliteRepositories(restartedExecutor, {
        acceptedVersionTaskFactory: createAcceptedVersionTaskFactory(new SequentialIds(950)),
      });
      const taskCenter = new TauriTaskCenterStore(restartedExecutor, clock);
      const facts = new SqliteStoryFactStore(restartedExecutor);
      const providerStage = vi.fn();
      const pipelineRuntime = {
        taskCenter,
        search: { rebuildProject: vi.fn(() => Promise.resolve({ ok: true, value: {} })) },
        story: {
          chapterSummaries: { summarizeSavedVersion: providerStage },
          continuousState: { extractSavedVersion: providerStage },
          causalProjector: {
            rebuildProject: vi.fn(() => Promise.resolve({ eventCount: 0, relationCount: 0 })),
          },
        },
        ids: new SequentialIds(1_000),
        clock,
      } as unknown as AcceptedChapterPipelineRuntime;
      const reportError = vi.fn();
      const worker = new AcceptedChapterPipelineWorker(pipelineRuntime, {
        queuedGraceMilliseconds: 0,
        ensureCurrentFacts: vi.fn().mockRejectedValue(new Error("injected local failure")),
        reportError,
      });

      await expect(worker.runDueTasksNow()).resolves.toBe(1);

      expect(
        expectPresent(
          expectApplicationOk(await restartedRepositories.chapters.findById(chapter.id)),
        ).toSnapshot(),
      ).toEqual(chapterBefore);
      expect(
        expectPresent(
          expectApplicationOk(
            await restartedRepositories.chapterVersions.findVersionById(versionBefore.id),
          ),
        ).toSnapshot(),
      ).toEqual(versionBefore);
      expect(
        expectStoryOk(await facts.listByProjectId(expectStoryUuid(imported.project.id))),
      ).toEqual([]);
      expect(
        (await taskCenter.load()).tasks.find(
          ({ idempotencyKey }) => idempotencyKey === "story.accepted-version:" + versionBefore.id,
        ),
      ).toMatchObject({
        status: "waiting_retry",
        failure: {
          code: "ACCEPTED_VERSION_FACT_PREFLIGHT_FAILED",
          causeCode: "CURRENT_SAVED_VERSION_FACTS_UNAVAILABLE",
          retryable: true,
        },
      });
      expect(reportError).toHaveBeenCalledOnce();
      expect(providerStage).not.toHaveBeenCalled();
    } finally {
      await restartedExecutor.close();
      openExecutors.splice(openExecutors.indexOf(restartedExecutor), 1);
    }
  });
});

function readCurrentLocalSchema(): string {
  const workspaceRoot = findWorkspaceRoot();
  const dataDirectory = path.join(workspaceRoot, "packages", "data", "migrations");
  const sql: string[] = [];
  for (const fileName of readdirSync(dataDirectory)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort()) {
    sql.push(readFileSync(path.join(dataDirectory, fileName), "utf8"));
    if (fileName === "0002_tasks_notifications.sql") {
      sql.push(
        readFileSync(
          path.join(workspaceRoot, "packages", "story-core", "migrations", "0001_story_core.sql"),
          "utf8",
        ),
      );
    }
    if (fileName === "0004_model_profiles.sql") {
      sql.push(
        readFileSync(
          path.join(workspaceRoot, "packages", "story-core", "migrations", "0002_materials.sql"),
          "utf8",
        ),
      );
    }
    if (fileName === "0020_graph_rag_projection.sql") {
      sql.push(
        readFileSync(
          path.join(workspaceRoot, "packages", "story-core", "migrations", "0003_ideation.sql"),
          "utf8",
        ),
      );
    }
  }
  return sql.join("\n");
}

function findWorkspaceRoot(): string {
  let current = path.resolve(process.cwd());
  while (!existsSync(path.join(current, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("InkShadow workspace root could not be located.");
    current = parent;
  }
  return current;
}

function fixedClock(): Clock {
  return Object.freeze({ now: () => NOW });
}

class SequentialIds implements UuidV7Generator {
  public constructor(private sequence: number) {}

  public next(): UuidV7 {
    const value = expectDomainUuid(
      `019f9f4a-b3c7-7350-9226-${this.sequence.toString(16).padStart(12, "0")}`,
    );
    this.sequence += 1;
    return value;
  }
}

function taskCount(executor: NodeSqliteExecutor, versionId: string): Promise<number> {
  return executor
    .select<{ readonly count: number }>(
      `SELECT COUNT(*) AS count FROM background_tasks
       WHERE json_extract(metadata_json, '$.versionId') = ?`,
      [versionId],
    )
    .then((rows) => expectPresent(rows[0]).count);
}

function expectTimestamp(value: string): IsoUtcTimestamp {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function expectDomainUuid(value: unknown): UuidV7 {
  if (typeof value !== "string") throw new Error("Expected a UUID string.");
  const parsed = parseUuidV7(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function expectStoryUuid(value: string) {
  const parsed = parseStoryUuidV7(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function expectApplicationOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: Error },
): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function expectStoryOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: Error },
): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function expectPresent<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error("Expected a persisted value.");
  return value;
}
