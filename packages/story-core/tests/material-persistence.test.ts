import { afterEach, describe, expect, it } from "vitest";

import {
  MaterialApplicationService,
  STORY_CORE_SQLITE_MIGRATION_0002,
  SqliteMaterialDispositionUnitOfWork,
  SqliteMaterialReferenceRepository,
  SqliteMaterialRepository,
  ok,
  parseUuidV7,
  type ChapterVersionReader,
} from "../src/index.js";
import { ManualClock, SequenceUuidV7Generator, unwrap, uuid } from "./helpers.js";
import { NodeStorySqliteExecutor } from "./node-sqlite-executor.js";

const T0 = "2026-07-27T00:00:00.000Z";
const T1 = "2026-07-27T00:01:00.000Z";
const T2 = "2026-07-27T00:02:00.000Z";
const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const executors: NodeStorySqliteExecutor[] = [];

afterEach(() => {
  for (const executor of executors.splice(0)) {
    executor.close();
  }
});

describe("material SQLite vertical slice", () => {
  it("deduplicates, preserves citations, rechecks delete impact, restores, and merges", async () => {
    const executor = createExecutor();
    const materials = new SqliteMaterialRepository(executor);
    const references = new SqliteMaterialReferenceRepository(executor);
    const dispositions = new SqliteMaterialDispositionUnitOfWork(executor);
    const clock = new ManualClock(T0);
    const service = new MaterialApplicationService({
      materials,
      references,
      dispositions,
      chapterVersions: currentChapterVersionReader(),
      clock,
      ids: new SequenceUuidV7Generator(100),
    });

    const created = unwrap(
      await service.create({
        ...materialFields("a".repeat(64)),
        projectId: PROJECT_ID,
        humanConfirmed: true,
      }),
    );
    const duplicate = await service.create({
      ...materialFields("a".repeat(64)),
      title: "重复标题不会绕过去重",
      projectId: PROJECT_ID,
      humanConfirmed: true,
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe("MATERIAL_DUPLICATE_FOUND");
      expect(duplicate.error.details.existingMaterialId).toBe(created.id);
    }

    const firstReference = unwrap(
      await service.createReference({
        materialId: created.id,
        targetChapterId: CHAPTER_ID,
        expectedTargetVersionId: VERSION_ID,
        excerptStart: 0,
        excerptEnd: 4,
        note: "第一处引用",
        humanConfirmed: true,
      }),
    );
    expect(firstReference.toSnapshot().provenance.materialId).toBe(created.id);

    const previewedDelete = unwrap(
      created.softDelete({
        expectedRevision: 1,
        expectedReferenceCount: 1,
        actualReferenceCount: 1,
        humanConfirmed: true,
        now: T1,
      }),
    );
    await service.createReference({
      materialId: created.id,
      targetChapterId: CHAPTER_ID,
      expectedTargetVersionId: VERSION_ID,
      excerptStart: 4,
      excerptEnd: 8,
      note: "预览后新增的第二处引用",
      humanConfirmed: true,
    });
    const staleDisposition = await dispositions.commit({
      material: previewedDelete,
      expectedMaterialRevision: 1,
      expectedReferenceCount: 1,
      survivorId: null,
      expectedSurvivorRevision: null,
    });
    expect(staleDisposition.ok).toBe(false);
    if (!staleDisposition.ok) {
      expect(staleDisposition.error.code).toBe("MATERIAL_REFERENCE_IMPACT_CHANGED");
    }
    expect(unwrap(await materials.findById(created.id))?.status).toBe("active");

    clock.set(T1);
    const deleted = unwrap(
      await service.softDelete({
        materialId: created.id,
        expectedRevision: 1,
        expectedReferenceCount: 2,
        humanConfirmed: true,
      }),
    );
    expect(deleted.status).toBe("deleted");
    expect(unwrap(await references.listByMaterialId(created.id))).toHaveLength(2);
    expect(unwrap(await materials.listByProjectId(created.projectId, false))).toHaveLength(0);

    clock.set(T2);
    const restored = unwrap(
      await service.restore({
        materialId: created.id,
        expectedRevision: 2,
        humanConfirmed: true,
      }),
    );
    expect(restored.status).toBe("active");

    const survivor = unwrap(
      await service.create({
        ...materialFields("b".repeat(64)),
        title: "合并后保留项",
        projectId: PROJECT_ID,
        humanConfirmed: true,
      }),
    );
    const merged = unwrap(
      await service.merge({
        sourceMaterialId: restored.id,
        survivorMaterialId: survivor.id,
        expectedSourceRevision: 3,
        expectedSurvivorRevision: 1,
        expectedReferenceCount: 2,
        humanConfirmed: true,
      }),
    );
    expect(merged.status).toBe("merged");
    expect(merged.toSnapshot().mergedIntoId).toBe(survivor.id);
    expect(unwrap(await references.listByMaterialId(created.id))).toHaveLength(2);
    expect(
      unwrap(await materials.listByProjectId(created.projectId, false)).map(({ id }) => id),
    ).toEqual([survivor.id]);
  });

  it("rejects a citation when the target chapter version changed", async () => {
    const executor = createExecutor();
    const materials = new SqliteMaterialRepository(executor);
    const service = new MaterialApplicationService({
      materials,
      references: new SqliteMaterialReferenceRepository(executor),
      dispositions: new SqliteMaterialDispositionUnitOfWork(executor),
      chapterVersions: currentChapterVersionReader(),
      clock: new ManualClock(T0),
      ids: new SequenceUuidV7Generator(200),
    });
    const created = unwrap(
      await service.create({
        ...materialFields("c".repeat(64)),
        projectId: PROJECT_ID,
        humanConfirmed: true,
      }),
    );

    const result = await service.createReference({
      materialId: created.id,
      targetChapterId: CHAPTER_ID,
      expectedTargetVersionId: uuid(999),
      excerptStart: 0,
      excerptEnd: 4,
      note: "过期目标版本",
      humanConfirmed: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REVIEW_SOURCE_CHANGED");
    }
  });
});

function createExecutor(): NodeStorySqliteExecutor {
  const executor = new NodeStorySqliteExecutor(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE chapter_versions (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE
    );
    ${STORY_CORE_SQLITE_MIGRATION_0002}
  `);
  executor.database.prepare("INSERT INTO projects (id) VALUES (?)").run(PROJECT_ID);
  executor.database
    .prepare("INSERT INTO chapters (id, project_id) VALUES (?, ?)")
    .run(CHAPTER_ID, PROJECT_ID);
  executor.database
    .prepare("INSERT INTO chapter_versions (id, project_id, chapter_id) VALUES (?, ?, ?)")
    .run(VERSION_ID, PROJECT_ID, CHAPTER_ID);
  executors.push(executor);
  return executor;
}

function currentChapterVersionReader(): ChapterVersionReader {
  const chapterId = unwrap(parseUuidV7(CHAPTER_ID));
  const projectId = unwrap(parseUuidV7(PROJECT_ID));
  const versionId = unwrap(parseUuidV7(VERSION_ID));
  return {
    findCurrent: (requestedChapterId) =>
      Promise.resolve(
        ok(
          requestedChapterId === chapterId
            ? {
                chapterId,
                projectId,
                versionId,
              }
            : null,
        ),
      ),
  };
}

function materialFields(contentFingerprint: string) {
  return {
    title: "雨夜石板路",
    sourceName: "用户提供笔记",
    author: "测试作者",
    sourceUrl: "https://example.test/reference",
    license: "owned" as const,
    rightsBasis: "用户确认拥有并可在当前项目使用。",
    rightsConfirmed: true,
    allowGeneration: true,
    allowTraining: false,
    tags: ["场景", "雨夜"],
    summary: "用于雨夜场景的气氛参考。",
    body: "参考素材：雨夜的石板路泛着微光。",
    contentFingerprint,
  };
}
