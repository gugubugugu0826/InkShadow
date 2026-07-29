import { describe, expect, it } from "vitest";

import { DEVELOPMENT_DATABASE_KEY } from "./development-storage";
import { LocalProjectSearchService } from "./project-search";
import {
  BrowserDevelopmentProjectSearchSnapshotStore,
  DEVELOPMENT_PROJECT_SEARCH_KEY,
} from "./project-search-store";
import type {
  ProjectEmbeddingDiagnostics,
  ProjectSearchVectorService,
} from "./project-search-vector-service";
import { createDevelopmentRuntime, createLocalDemoCandidate } from "./runtime";

describe("local project search", () => {
  it("rebuilds chapter and outline documents with source provenance", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "雾港纪事" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "潮汐钟",
      content: "守塔人听见雾港深处传来第十三声钟响。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    const outline = await runtime.story.outlineService.create({
      projectId: project.value.id,
      title: "雾港总纲",
      synopsis: "失落的潮汐仪重新启动。",
    });
    if (!outline.ok) {
      throw outline.error;
    }

    const chapterSearch = await runtime.search.search(project.value.id, "第十三声钟响");
    const outlineSearch = await runtime.search.search(project.value.id, "潮汐仪");

    expect(chapterSearch.ok && chapterSearch.value.hits[0]?.document).toMatchObject({
      sourceType: "chapter",
      sourceId: chapter.value.chapter.id,
      sourceVersionId: chapter.value.chapter.currentVersionId,
    });
    expect(outlineSearch.ok && outlineSearch.value.hits[0]?.document).toMatchObject({
      sourceType: "outline",
      sourceId: outline.value.toSnapshot().nodes[0]?.id,
    });
    expect(runtime.search.health()).toMatchObject({
      mutationStatus: "ready",
      vectorStatus: "disabled",
      documentCount: 2,
      embeddingCount: 0,
    });
    expect(runtime.search.synchronizationDiagnostics()).toMatchObject({
      documentCount: 2,
      upsertedCount: 0,
      unchangedCount: 2,
      reusedSourceCount: 2,
      hashedDocumentCount: 0,
      changed: false,
    });

    const outlineNodeId = outline.value.toSnapshot().nodes[0]?.id;
    if (outlineNodeId === undefined) {
      throw new Error("Outline root node was not created.");
    }
    const revisedOutline = await runtime.story.outlineService.apply({
      projectId: project.value.id,
      expectedRevision: outline.value.revision,
      change: {
        kind: "update_synopsis",
        nodeId: outlineNodeId,
        synopsis: "失落的潮汐仪已被盗走。",
      },
    });
    if (!revisedOutline.ok) {
      throw revisedOutline.error;
    }
    const revisedSearch = await runtime.search.search(project.value.id, "已被盗走");
    expect(revisedSearch.ok && revisedSearch.value.hits[0]?.document.sourceVersionId).toBe(
      `outline:${outlineNodeId}:r2`,
    );
    expect(runtime.search.synchronizationDiagnostics()).toMatchObject({
      documentCount: 2,
      upsertedCount: 1,
      deletedCount: 0,
      unchangedCount: 1,
      reusedSourceCount: 1,
      hashedDocumentCount: 1,
      changed: true,
    });
  });

  it("atomically refreshes stale chapter text before each query", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "索引刷新" });
    if (!project.ok) {
      throw project.error;
    }
    const created = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "旧线索藏在桥下。",
    });
    if (!created.ok) {
      throw created.error;
    }
    const firstSearch = await runtime.search.search(project.value.id, "旧线索");
    expect(firstSearch.ok && firstSearch.value.hits).toHaveLength(1);

    const edited = await runtime.useCases.editChapter.execute({
      chapterId: created.value.chapter.id,
      expectedRevision: created.value.chapter.revision,
      content: "新线索藏在灯塔顶层。",
      cursorOffset: 10,
    });
    if (!edited.ok) {
      throw edited.error;
    }
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: created.value.chapter.id,
      expectedRevision: created.value.chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) {
      throw saved.error;
    }

    const stale = await runtime.search.search(project.value.id, "旧线索");
    const current = await runtime.search.search(project.value.id, "灯塔顶层");

    expect(
      stale.ok &&
        stale.value.hits.every(
          ({ document, scores }) => !document.text.includes("旧线索") && scores.keyword === 0,
        ),
    ).toBe(true);
    expect(current.ok && current.value.hits[0]?.document.sourceVersionId).toBe(
      saved.value.chapter.currentVersionId,
    );
  });

  it("returns a bounded validation error for an empty query", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "查询校验" });
    if (!project.ok) {
      throw project.error;
    }

    const result = await runtime.search.search(project.value.id, "   ");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("空查询不应成功。");
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("drops a cached ready vector load when synchronization later fails", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "向量失败回退" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "只依赖本地关键词也能找到的稳定线索。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    let failSynchronization = false;
    let queryEmbeddingCalls = 0;
    let diagnostics = readyEmbeddingDiagnostics(0);
    const vectors: ProjectSearchVectorService = {
      synchronizeProject: (_projectId, documents) => {
        if (failSynchronization) {
          return Promise.reject(
            Object.assign(new Error("provider metadata failed"), {
              code: "VECTOR_INDEX_UNAVAILABLE",
            }),
          );
        }
        diagnostics = readyEmbeddingDiagnostics(documents.length);
        return Promise.resolve({
          diagnostics,
          configuration: {
            modelId: diagnostics.confirmationId ?? "embedding-profile:test",
            dimension: 2,
          },
          embeddings: documents.map((document) => ({
            documentId: document.id,
            projectId: document.projectId,
            sourceVersionId: document.sourceVersionId,
            contentHash: document.contentHash,
            modelId: diagnostics.confirmationId ?? "embedding-profile:test",
            values: [1, 1],
          })),
        });
      },
      rebuildProject: () => Promise.reject(new Error("not used")),
      embedQuery: (load) => {
        queryEmbeddingCalls += 1;
        return Promise.resolve({
          embedding: {
            modelId: load.configuration?.modelId ?? "embedding-profile:test",
            values: [1, 1],
          },
          notice: null,
          diagnostics,
        });
      },
      resetProject: () => Promise.resolve(),
      diagnostics: () => diagnostics,
    };
    const search = new LocalProjectSearchService({
      projects: runtime.repositories.projects,
      chapters: runtime.repositories.chapters,
      outlines: runtime.story.outlines,
      snapshots: new BrowserDevelopmentProjectSearchSnapshotStore(window.localStorage),
      hasher: runtime.hasher,
      clock: runtime.clock,
      vectors,
    });

    const ready = await search.search(project.value.id, "稳定线索");
    expect(ready.ok && ready.value.capabilities.vector).toBe("ready");
    expect(queryEmbeddingCalls).toBe(1);

    failSynchronization = true;
    const fallback = await search.search(project.value.id, "稳定线索");

    expect(fallback.ok).toBe(true);
    if (!fallback.ok) {
      throw fallback.error;
    }
    expect(queryEmbeddingCalls).toBe(1);
    expect(fallback.value.capabilities.vector).toBe("degraded");
    expect(fallback.value.notices).toContain(
      "vector_service_vector_index_unavailable_keyword_relation_fallback",
    );
    expect(fallback.value.hits[0]?.scores.vector).toBe(0);
  });

  it("rehashes a persisted snapshot once after restart, then reuses verified stable sources", async () => {
    const firstRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await firstRuntime.useCases.createProject.execute({ name: "重启增量" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await firstRuntime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "持久索引跨越运行时重启。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    const firstSearch = await firstRuntime.search.search(project.value.id, "持久索引");
    expect(firstSearch.ok).toBe(true);
    expect(firstRuntime.search.synchronizationDiagnostics()).toMatchObject({
      snapshotRevision: 1,
      upsertedCount: 1,
      hashedDocumentCount: 1,
      changed: true,
    });

    const secondRuntime = createDevelopmentRuntime(window.localStorage);
    const secondSearch = await secondRuntime.search.search(project.value.id, "运行时重启");

    expect(secondSearch.ok && secondSearch.value.hits).toHaveLength(1);
    expect(secondRuntime.search.synchronizationDiagnostics()).toMatchObject({
      snapshotRevision: 1,
      upsertedCount: 0,
      unchangedCount: 1,
      reusedSourceCount: 1,
      hashedDocumentCount: 0,
      integrityHashedDocumentCount: 1,
      changed: false,
    });

    const hotSearch = await secondRuntime.search.search(project.value.id, "持久索引");

    expect(hotSearch.ok && hotSearch.value.hits).toHaveLength(1);
    expect(secondRuntime.search.synchronizationDiagnostics()).toMatchObject({
      reusedSourceCount: 1,
      hashedDocumentCount: 0,
      integrityHashedDocumentCount: 0,
      changed: false,
    });
  });

  it("removes soft-deleted chapter documents from memory and persistent snapshots", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "删除传播" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "待删除章节",
      content: "应当立刻退出检索的线索。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    expect((await runtime.search.search(project.value.id, "退出检索")).ok).toBe(true);

    const serialized = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
    if (serialized === null) {
      throw new Error("Development database was not persisted.");
    }
    const database = JSON.parse(serialized) as {
      chapters: { id: string; status: string; trashedAt: string | null }[];
    };
    const storedChapter = database.chapters.find(({ id }) => id === chapter.value.chapter.id);
    if (storedChapter === undefined) {
      throw new Error("Stored chapter was not found.");
    }
    storedChapter.status = "trashed";
    storedChapter.trashedAt = "2026-07-27T00:00:00.000Z";
    window.localStorage.setItem(DEVELOPMENT_DATABASE_KEY, JSON.stringify(database));

    const removed = await runtime.search.search(project.value.id, "退出检索");

    expect(removed.ok && removed.value.hits).toHaveLength(0);
    expect(runtime.search.synchronizationDiagnostics()).toMatchObject({
      documentCount: 0,
      upsertedCount: 0,
      deletedCount: 1,
      changed: true,
    });
    const searchDatabase = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as { projects?: Record<string, { documents?: unknown[] }> };
    expect(searchDatabase.projects?.[project.value.id]?.documents).toEqual([]);
  });

  it("blocks trashed projects and removes their derived snapshots", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "项目删除边界" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "回收站项目不可通过检索旁路读取。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    expect((await runtime.search.search(project.value.id, "旁路读取")).ok).toBe(true);
    const trashed = await runtime.useCases.trashProject.execute({
      projectId: project.value.id,
    });
    if (!trashed.ok) {
      throw trashed.error;
    }

    const searched = await runtime.search.search(project.value.id, "旁路读取");

    expect(searched.ok).toBe(false);
    if (searched.ok) {
      throw new Error("Trashed project search should not succeed.");
    }
    expect(searched.error.code).toBe("PROJECT_DELETED");
    const searchDatabase = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as { projects?: Record<string, unknown> };
    expect(searchDatabase.projects?.[project.value.id]).toBeUndefined();
    expect(runtime.search.health().documentCount).toBe(0);
  });

  it("rebuilds corrupted derived snapshots from stable sources without indexing drafts or candidates", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "安全恢复" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "稳定正文",
      content: "正式版本只包含蓝色灯塔。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: chapter.value.chapter.id,
      expectedRevision: chapter.value.chapter.revision,
      content: "未保存恢复草稿包含红色彗星。",
      cursorOffset: 10,
    });
    if (!edited.ok) {
      throw edited.error;
    }
    const candidate = await createLocalDemoCandidate(runtime, chapter.value.chapter.id);
    if (!candidate.ok) {
      throw candidate.error;
    }
    window.localStorage.setItem(DEVELOPMENT_PROJECT_SEARCH_KEY, "{corrupt");

    const stable = await runtime.search.search(project.value.id, "蓝色灯塔");
    const draft = await runtime.search.search(project.value.id, "红色彗星");
    const generated = await runtime.search.search(project.value.id, "本地演示候选");

    expect(stable.ok && stable.value.hits).toHaveLength(1);
    expect(stable.ok && stable.value.notices).toContain(
      "persistent_index_recovered_from_authoritative_sources",
    );
    expect(draft.ok && draft.value.hits).toHaveLength(0);
    expect(generated.ok && generated.value.hits).toHaveLength(0);
    expect(runtime.search.synchronizationDiagnostics()).toMatchObject({
      recoveredFromCorruption: false,
      reusedSourceCount: 1,
      hashedDocumentCount: 0,
    });
  });

  it("creates embedding-safe deterministic UTF-8 chunks across CJK and astral boundaries", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "UTF-8 向量分片" });
    if (!project.ok) {
      throw project.error;
    }
    const content = `${"雾".repeat(17_000)}𠮷${"港".repeat(17_000)}`;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "长篇边界",
      content,
    });
    if (!chapter.ok) {
      throw chapter.error;
    }

    const searched = await runtime.search.search(project.value.id, "雾港");
    expect(searched.ok).toBe(true);
    const database = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as {
      projects?: Record<
        string,
        {
          documents?: {
            id: string;
            title: string;
            text: string;
            sourceVersionId: string;
          }[];
        }
      >;
    };
    const documents = database.projects?.[project.value.id]?.documents ?? [];

    expect(documents.length).toBeGreaterThan(2);
    expect(documents.map(({ id }) => id)).toEqual(
      documents.map((_, index) => `chapter:${chapter.value.chapter.id}:${String(index)}`),
    );
    for (const document of documents) {
      expect(document.sourceVersionId).toBe(chapter.value.chapter.currentVersionId);
      expect(
        new TextEncoder().encode(`${document.title}\n${document.text}`).byteLength,
      ).toBeLessThan(64 * 1024);
      expect(document.text).not.toContain("\uFFFD");
      const first = document.text.charCodeAt(0);
      const last = document.text.charCodeAt(document.text.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("replaces a pre-existing oversized search snapshot after restart", async () => {
    const firstRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await firstRuntime.useCases.createProject.execute({
      name: "旧分片迁移",
    });
    if (!project.ok) {
      throw project.error;
    }
    const content = "雾港旧分片".repeat(14_000);
    const chapter = await firstRuntime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "旧版长章",
      content,
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    const seeded = await firstRuntime.search.search(project.value.id, "旧分片");
    expect(seeded.ok).toBe(true);
    const checksum = await firstRuntime.hasher.sha256(content);
    if (!checksum.ok) {
      throw checksum.error;
    }
    const database = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as {
      schemaVersion: 1;
      projects: Record<
        string,
        {
          schemaVersion: 1;
          projectId: string;
          revision: number;
          indexedAt: string;
          documents: unknown[];
        }
      >;
    };
    const snapshot = database.projects[project.value.id];
    if (snapshot === undefined) {
      throw new Error("Seeded search snapshot is missing.");
    }
    snapshot.documents = [
      {
        id: `chapter:${chapter.value.chapter.id}:0`,
        projectId: project.value.id,
        sourceType: "chapter",
        sourceId: chapter.value.chapter.id,
        sourceVersionId: chapter.value.chapter.currentVersionId,
        title: chapter.value.chapter.title,
        text: content,
        contentHash: checksum.value,
        updatedAt: chapter.value.chapter.toSnapshot().updatedAt,
      },
    ];
    window.localStorage.setItem(DEVELOPMENT_PROJECT_SEARCH_KEY, JSON.stringify(database));

    const restarted = createDevelopmentRuntime(window.localStorage);
    const migrated = await restarted.search.search(project.value.id, "旧分片");
    expect(migrated.ok).toBe(true);
    expect(restarted.search.synchronizationDiagnostics()).toMatchObject({
      reusedSourceCount: 0,
      changed: true,
    });
    const migratedDatabase = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as { projects?: Record<string, { documents?: { title: string; text: string }[] }> };
    const documents = migratedDatabase.projects?.[project.value.id]?.documents ?? [];
    expect(documents.length).toBeGreaterThan(1);
    for (const document of documents) {
      expect(
        new TextEncoder().encode(`${document.title}\n${document.text}`).byteLength,
      ).toBeLessThan(64 * 1024);
    }
  });

  it("rehashes reusable sources after restart and repairs a forged persisted content hash", async () => {
    const firstRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await firstRuntime.useCases.createProject.execute({
      name: "哈希完整性恢复",
    });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await firstRuntime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "可信正文",
      content: "稳定正文必须与派生快照中的内容哈希一致。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    const seeded = await firstRuntime.search.search(project.value.id, "稳定正文");
    expect(seeded.ok).toBe(true);
    const database = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as {
      projects?: Record<
        string,
        {
          documents?: {
            id: string;
            contentHash: string;
            text: string;
          }[];
        }
      >;
    };
    const forged = database.projects?.[project.value.id]?.documents?.[0];
    if (forged === undefined) {
      throw new Error("Seeded search document is missing.");
    }
    const originalText = forged.text;
    forged.contentHash = "f".repeat(64);
    window.localStorage.setItem(DEVELOPMENT_PROJECT_SEARCH_KEY, JSON.stringify(database));

    const restarted = createDevelopmentRuntime(window.localStorage);
    const recovered = await restarted.search.search(project.value.id, "稳定正文");

    expect(recovered.ok).toBe(true);
    expect(restarted.search.synchronizationDiagnostics()).toMatchObject({
      recoveredFromCorruption: true,
      recoveredFromIntegrityMismatch: true,
      integrityHashedDocumentCount: 1,
      hashedDocumentCount: 1,
      changed: true,
    });
    const expectedHash = await restarted.hasher.sha256(originalText);
    if (!expectedHash.ok) {
      throw expectedHash.error;
    }
    const repairedDatabase = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as {
      projects?: Record<string, { documents?: { contentHash: string }[] }>;
    };
    expect(repairedDatabase.projects?.[project.value.id]?.documents?.[0]?.contentHash).toBe(
      expectedHash.value,
    );
  });

  it("repairs a forged persisted outline hash from authoritative outline fields after restart", async () => {
    const firstRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await firstRuntime.useCases.createProject.execute({
      name: "大纲哈希完整性恢复",
    });
    if (!project.ok) {
      throw project.error;
    }
    const outline = await firstRuntime.story.outlineService.create({
      projectId: project.value.id,
      title: "可信总纲",
      synopsis: "稳定大纲必须与其派生内容哈希一致。",
    });
    if (!outline.ok) {
      throw outline.error;
    }
    const node = outline.value.toSnapshot().nodes[0];
    if (node === undefined) {
      throw new Error("Outline root node was not created.");
    }
    const seeded = await firstRuntime.search.search(project.value.id, "稳定大纲");
    expect(seeded.ok).toBe(true);
    const database = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as {
      projects?: Record<
        string,
        {
          documents?: {
            id: string;
            contentHash: string;
          }[];
        }
      >;
    };
    const forged = database.projects?.[project.value.id]?.documents?.find(
      ({ id }) => id === `outline:${node.id}`,
    );
    if (forged === undefined) {
      throw new Error("Seeded outline search document is missing.");
    }
    forged.contentHash = "e".repeat(64);
    window.localStorage.setItem(DEVELOPMENT_PROJECT_SEARCH_KEY, JSON.stringify(database));

    const restarted = createDevelopmentRuntime(window.localStorage);
    const recovered = await restarted.search.search(project.value.id, "稳定大纲");

    expect(recovered.ok).toBe(true);
    expect(restarted.search.synchronizationDiagnostics()).toMatchObject({
      recoveredFromCorruption: true,
      recoveredFromIntegrityMismatch: true,
      integrityHashedDocumentCount: 1,
      hashedDocumentCount: 1,
      changed: true,
    });
    const expectedHash = await restarted.hasher.sha256(
      `${node.title}\n${node.synopsis}\n${node.kind}\n${String(node.locked)}`,
    );
    if (!expectedHash.ok) {
      throw expectedHash.error;
    }
    const repairedDatabase = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as {
      projects?: Record<string, { documents?: { id: string; contentHash: string }[] }>;
    };
    expect(
      repairedDatabase.projects?.[project.value.id]?.documents?.find(
        ({ id }) => id === `outline:${node.id}`,
      )?.contentHash,
    ).toBe(expectedHash.value);
  });

  it("keeps twenty hot searches over one million synthetic Chinese characters below the one-second gate", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "百万字性能夹具" });
    if (!project.ok) {
      throw project.error;
    }
    for (let index = 0; index < 100; index += 1) {
      const marker = `合成锚点${String(index).padStart(4, "0")}`;
      const content = `${marker}${"星河边境风暴潮汐".repeat(1_250)}`.slice(0, 10_000);
      const chapter = await runtime.useCases.createChapter.execute({
        projectId: project.value.id,
        title: `合成章节 ${String(index + 1)}`,
        content,
      });
      if (!chapter.ok) {
        throw chapter.error;
      }
    }
    const coldStartedAt = performance.now();
    const cold = await runtime.search.search(project.value.id, "合成锚点0099");
    const coldMilliseconds = performance.now() - coldStartedAt;
    expect(cold.ok && cold.value.hits[0]?.document.title).toBe("合成章节 100");

    const durations: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const startedAt = performance.now();
      const result = await runtime.search.search(project.value.id, "合成锚点0099");
      durations.push(performance.now() - startedAt);
      expect(result.ok).toBe(true);
    }
    durations.sort((left, right) => left - right);
    const p50 = durations[Math.ceil(durations.length * 0.5) - 1];
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];

    expect(coldMilliseconds).toBeLessThan(1_000);
    expect(p50).toBeDefined();
    expect(p95).toBeDefined();
    expect(p95).toBeLessThan(1_000);
    process.stdout.write(
      `[search-benchmark] chapters=100 characters=1000000 runs=20 cold_ms=${coldMilliseconds.toFixed(
        2,
      )} hot_p50_ms=${p50?.toFixed(2) ?? "n/a"} hot_p95_ms=${p95?.toFixed(2) ?? "n/a"}\n`,
    );
    expect(runtime.search.synchronizationDiagnostics()).toMatchObject({
      documentCount: 100,
      upsertedCount: 0,
      unchangedCount: 100,
      reusedSourceCount: 100,
      hashedDocumentCount: 0,
      changed: false,
    });
  }, 30_000);
});

function readyEmbeddingDiagnostics(embeddingCount: number): ProjectEmbeddingDiagnostics {
  return {
    status: "ready",
    reason: null,
    providerId: "local-ollama",
    provider: "ollama",
    model: "nomic-embed-text",
    dimension: 2,
    embeddingCount,
    generation: 1,
    destination: "local_ollama",
    endpointOrigin: "http://127.0.0.1:11434",
    endpointUrl: "http://127.0.0.1:11434/api/embed",
    confirmationId: "embedding-profile:test",
    lastRebuiltAt: "2026-07-28T00:00:00.000Z",
    queryFailureCode: null,
  };
}
