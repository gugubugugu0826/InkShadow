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
      documentCount: 5,
      embeddingCount: 0,
    });
    expect(runtime.search.synchronizationDiagnostics()).toMatchObject({
      documentCount: 5,
      upsertedCount: 0,
      unchangedCount: 5,
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
      documentCount: 5,
      upsertedCount: 1,
      deletedCount: 0,
      unchangedCount: 4,
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
    expect(firstSearch.ok && firstSearch.value.hits.length).toBeGreaterThan(0);

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
    const database = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as {
      projects?: Record<
        string,
        { documents?: { sourceVersionId: string; currentness: string; sourceId: string }[] }
      >;
    };
    const chapterDocuments =
      database.projects?.[project.value.id]?.documents?.filter(
        ({ sourceId }) => sourceId === created.value.chapter.id,
      ) ?? [];
    expect(chapterDocuments).toHaveLength(4);
    expect(
      chapterDocuments.every(
        ({ currentness, sourceVersionId }) =>
          currentness === "current" && sourceVersionId === saved.value.chapter.currentVersionId,
      ),
    ).toBe(true);
    expect(
      chapterDocuments.some(
        ({ sourceVersionId }) => sourceVersionId === created.value.chapter.currentVersionId,
      ),
    ).toBe(false);
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
          projectId: _projectId,
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
      storyFacts: runtime.story.facts,
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

  it("keeps FTS keyword hits when query embedding or Ollama is unavailable", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "FTS 基线" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "离线时仍可检索白塔密钥。",
    });
    if (!chapter.ok) throw chapter.error;

    let diagnostics = readyEmbeddingDiagnostics(0);
    const vectors: ProjectSearchVectorService = {
      synchronizeProject: (projectId, documents) => {
        diagnostics = readyEmbeddingDiagnostics(documents.length);
        return Promise.resolve({
          projectId,
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
      embedQuery: () =>
        Promise.reject(
          Object.assign(new Error("Ollama is offline"), { code: "OLLAMA_UNAVAILABLE" }),
        ),
      resetProject: () => Promise.resolve(),
      diagnostics: () => diagnostics,
    };
    const search = new LocalProjectSearchService({
      projects: runtime.repositories.projects,
      chapters: runtime.repositories.chapters,
      outlines: runtime.story.outlines,
      storyFacts: runtime.story.facts,
      snapshots: new BrowserDevelopmentProjectSearchSnapshotStore(window.localStorage),
      hasher: runtime.hasher,
      clock: runtime.clock,
      vectors,
    });

    const result = await search.search(project.value.id, "白塔密钥");

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.hits[0]?.document).toMatchObject({
      sourceType: "chapter",
      sourceId: chapter.value.chapter.id,
      sourceVersionId: chapter.value.version.id,
    });
    expect(result.value.hits[0]?.scores.keyword).toBeGreaterThan(0);
    expect(result.value.hits[0]?.scores.vector).toBe(0);
    expect(result.value.capabilities.vector).toBe("degraded");
    expect(result.value.notices).toContain(
      "vector_service_ollama_unavailable_keyword_relation_fallback",
    );
  });

  it("provides a read-only scoped FTS path with zero embedding or gateway calls", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "只读 FTS" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "白塔密钥只存在于已接受正文。",
    });
    if (!chapter.ok) throw chapter.error;
    const prepared = await runtime.search.search(project.value.id, "白塔密钥");
    expect(prepared.ok).toBe(true);
    const before = window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY);
    let providerCalls = 0;
    const neverCall = (): Promise<never> => {
      providerCalls += 1;
      return Promise.reject(new Error("read-only FTS must not call vectors"));
    };
    const vectors: ProjectSearchVectorService = {
      synchronizeProject: neverCall,
      rebuildProject: neverCall,
      embedQuery: neverCall,
      resetProject: () => {
        providerCalls += 1;
        return Promise.resolve();
      },
      diagnostics: () => readyEmbeddingDiagnostics(0),
    };
    const search = new LocalProjectSearchService({
      projects: runtime.repositories.projects,
      chapters: runtime.repositories.chapters,
      outlines: runtime.story.outlines,
      storyFacts: runtime.story.facts,
      snapshots: new BrowserDevelopmentProjectSearchSnapshotStore(window.localStorage),
      hasher: runtime.hasher,
      clock: runtime.clock,
      vectors,
    });

    const continuation = await search.search(project.value.id, "白塔 密钥", 20, {
      projectId: project.value.id,
      taskType: "continuation",
      // A verified local context may combine standard and local-only chapters.
      privacy: "include_local_only",
      currentness: "current",
      branchId: null,
      povCharacterId: null,
      maximumStoryOrder: 1,
    });
    const result = await search.searchFtsOnly(project.value.id, "白塔 密钥", {
      projectId: project.value.id,
      taskType: "agent_fts",
      privacy: "include_local_only",
      currentness: "current",
      branchId: null,
      povCharacterId: null,
      maximumStoryOrder: 1,
    });

    expect(continuation.ok).toBe(true);
    expect(continuation.ok && continuation.value.hits.length).toBeGreaterThan(0);
    expect(continuation.ok && continuation.value.capabilities.vector).toBe("disabled");
    expect(continuation.ok && continuation.value.retrievalScopeTrace).toMatchObject({
      taskType: "continuation",
      omittedHardFilters: [],
      versionMode: "per_source_current",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.hits.length).toBeGreaterThan(0);
    expect(result.ok && result.value.capabilities.vector).toBe("disabled");
    expect(result.ok && result.value.notices).toContain(
      "fts_only_read_only_no_embedding_or_gateway",
    );
    expect(providerCalls).toBe(0);
    expect(window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY)).toBe(before);
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
      upsertedCount: 4,
      hashedDocumentCount: 4,
      changed: true,
    });

    const secondRuntime = createDevelopmentRuntime(window.localStorage);
    const secondSearch = await secondRuntime.search.search(project.value.id, "运行时重启");

    expect(secondSearch.ok && secondSearch.value.hits.length).toBeGreaterThan(0);
    expect(secondRuntime.search.synchronizationDiagnostics()).toMatchObject({
      snapshotRevision: 1,
      upsertedCount: 0,
      unchangedCount: 4,
      reusedSourceCount: 1,
      hashedDocumentCount: 0,
      integrityHashedDocumentCount: 4,
      changed: false,
    });

    const hotSearch = await secondRuntime.search.search(project.value.id, "持久索引");

    expect(hotSearch.ok && hotSearch.value.hits.length).toBeGreaterThan(0);
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
      deletedCount: 4,
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

    expect(stable.ok && stable.value.hits.length).toBeGreaterThan(0);
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

  it("projects stable paragraph and dialogue children with exact UTF-16 evidence across restart", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "多粒度证据" });
    if (!project.ok) throw project.error;
    const content = "雾港沉默。\n林岚说：“不要开门。”\n—我知道。";
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "门外",
      content,
    });
    if (!chapter.ok) throw chapter.error;
    expect((await runtime.search.search(project.value.id, "不要开门")).ok).toBe(true);

    const firstSnapshot = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as {
      projects?: Record<
        string,
        {
          documents?: {
            id: string;
            text: string;
            chunkKind: string;
            parentDocumentId: string | null;
            utf16Start: number;
            utf16End: number;
            sourceVersionId: string;
            currentness: string;
          }[];
        }
      >;
    };
    const documents = firstSnapshot.projects?.[project.value.id]?.documents ?? [];
    const scenes = documents.filter(({ chunkKind }) => chunkKind === "scene");
    const paragraphs = documents.filter(({ chunkKind }) => chunkKind === "paragraph");
    const events = documents.filter(({ chunkKind }) => chunkKind === "event");
    const dialogues = documents.filter(({ chunkKind }) => chunkKind === "dialogue");
    expect(scenes).toHaveLength(1);
    expect(paragraphs).toHaveLength(3);
    expect(events).toHaveLength(3);
    expect(dialogues).toHaveLength(2);
    for (const document of [...scenes, ...paragraphs, ...events, ...dialogues]) {
      expect(content.slice(document.utf16Start, document.utf16End)).toBe(document.text);
      expect(document.sourceVersionId).toBe(chapter.value.chapter.currentVersionId);
      expect(document.currentness).toBe("current");
      const parent = documents.find(({ id }) => id === document.parentDocumentId);
      expect(parent).toBeDefined();
      expect(parent?.utf16Start).toBeLessThanOrEqual(document.utf16Start);
      expect(parent?.utf16End).toBeGreaterThanOrEqual(document.utf16End);
    }
    const stableIds = documents.map(({ id }) => id);
    const restarted = createDevelopmentRuntime(window.localStorage);
    expect((await restarted.search.search(project.value.id, "不要开门")).ok).toBe(true);
    const restartedSnapshot = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
    ) as { projects?: Record<string, { documents?: { id: string }[] }> };
    expect(restartedSnapshot.projects?.[project.value.id]?.documents?.map(({ id }) => id)).toEqual(
      stableIds,
    );
  });

  it("projects all six granularities and only exact current confirmed StoryFact evidence", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "六粒度证据" });
    if (!project.ok) throw project.error;
    const content = "第一幕开始。林岚说：“钥匙藏在白塔。”\n\n***\n\n第二幕风暴降临！";
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "白塔",
      content,
    });
    if (!chapter.ok) throw chapter.error;
    const evidenceText = "钥匙藏在白塔";
    const evidenceStart = content.indexOf(evidenceText);
    const exactFact = await runtime.story.factService.createFormalUserFact({
      projectId: project.value.id,
      factType: "key_location",
      contentText: "钥匙的正式设定只由正文证据支持。",
      source: {
        kind: "chapter_span",
        reference: "project-search-six-granularities",
        chapterId: chapter.value.chapter.id,
        versionId: chapter.value.chapter.currentVersionId,
        startOffset: evidenceStart,
        endOffset: evidenceStart + evidenceText.length,
        sourceLength: content.length,
        excerpt: evidenceText,
      },
      actorId: project.value.id,
      humanConfirmed: true,
    });
    if (!exactFact.ok) throw exactFact.error;
    const mismatchedFact = await runtime.story.factService.createFormalUserFact({
      projectId: project.value.id,
      factType: "rejected_mismatch",
      contentText: "这条内容不能替代原文证据。",
      source: {
        kind: "chapter_span",
        reference: "project-search-mismatched-excerpt",
        chapterId: chapter.value.chapter.id,
        versionId: chapter.value.chapter.currentVersionId,
        startOffset: evidenceStart,
        endOffset: evidenceStart + evidenceText.length,
        sourceLength: content.length,
        excerpt: "不匹配的摘录",
      },
      actorId: project.value.id,
      humanConfirmed: true,
    });
    if (!mismatchedFact.ok) throw mismatchedFact.error;

    const indexed = await runtime.search.search(project.value.id, evidenceText);
    expect(indexed.ok).toBe(true);
    const readDocuments = (): {
      id: string;
      sourceId: string;
      sourceVersionId: string;
      text: string;
      chunkKind: string;
      parentDocumentId: string | null;
      utf16Start: number;
      utf16End: number;
      sourceLength: number;
      sceneId: string | null;
      eventId: string | null;
      characterIds: string[];
      locationIds: string[];
      storyTime: string | null;
      authority: string;
      branchId: string | null;
    }[] => {
      const database = JSON.parse(
        window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY) ?? "{}",
      ) as {
        projects?: Record<
          string,
          {
            documents?: {
              id: string;
              sourceId: string;
              sourceVersionId: string;
              text: string;
              chunkKind: string;
              parentDocumentId: string | null;
              utf16Start: number;
              utf16End: number;
              sourceLength: number;
              sceneId: string | null;
              eventId: string | null;
              characterIds: string[];
              locationIds: string[];
              storyTime: string | null;
              authority: string;
              branchId: string | null;
            }[];
          }
        >;
      };
      return database.projects?.[project.value.id]?.documents ?? [];
    };
    const documents = readDocuments();
    expect(new Set(documents.map(({ chunkKind }) => chunkKind))).toEqual(
      new Set(["chapter", "scene", "event", "paragraph", "dialogue", "story_fact_evidence"]),
    );
    const factEvidence = documents.filter(({ chunkKind }) => chunkKind === "story_fact_evidence");
    expect(factEvidence).toHaveLength(1);
    expect(factEvidence[0]).toMatchObject({
      sourceId: exactFact.value.id,
      text: evidenceText,
      authority: "confirmed_fact",
      branchId: null,
      sourceLength: content.length,
      characterIds: [],
      locationIds: [],
      storyTime: null,
    });
    expect(factEvidence[0]?.text).not.toContain("钥匙的正式设定只由正文证据支持。");
    for (const document of documents.filter(({ parentDocumentId }) => parentDocumentId !== null)) {
      const parent = documents.find(({ id }) => id === document.parentDocumentId);
      expect(parent).toBeDefined();
      expect(parent?.utf16Start).toBeLessThanOrEqual(document.utf16Start);
      expect(parent?.utf16End).toBeGreaterThanOrEqual(document.utf16End);
    }
    expect(
      documents
        .filter(({ chunkKind }) => chunkKind === "scene")
        .every(({ id, sceneId, eventId }) => sceneId === id && eventId === null),
    ).toBe(true);
    expect(
      documents
        .filter(({ chunkKind }) => chunkKind === "event")
        .every(({ id, sceneId, eventId }) => sceneId !== null && eventId === id),
    ).toBe(true);
    expect(runtime.search.synchronizationDiagnostics()?.projectionOmissions).toContainEqual({
      sourceType: "story_fact_evidence",
      sourceId: mismatchedFact.value.id,
      reason: "story_fact_source_excerpt_mismatch",
    });

    const stableIds = documents.map(({ id }) => id);
    const restarted = createDevelopmentRuntime(window.localStorage);
    expect((await restarted.search.search(project.value.id, evidenceText)).ok).toBe(true);
    expect(readDocuments().map(({ id }) => id)).toEqual(stableIds);

    const edited = await restarted.useCases.editChapter.execute({
      chapterId: chapter.value.chapter.id,
      expectedRevision: chapter.value.chapter.revision,
      content: content.replace(evidenceText, "钥匙已经转移"),
      cursorOffset: evidenceStart,
    });
    if (!edited.ok) throw edited.error;
    const saved = await restarted.useCases.saveChapter.execute({
      chapterId: chapter.value.chapter.id,
      expectedRevision: chapter.value.chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;
    expect((await restarted.search.search(project.value.id, "钥匙已经转移")).ok).toBe(true);
    expect(readDocuments().some(({ chunkKind }) => chunkKind === "story_fact_evidence")).toBe(
      false,
    );
    expect(restarted.search.synchronizationDiagnostics()?.projectionOmissions).toContainEqual({
      sourceType: "story_fact_evidence",
      sourceId: exactFact.value.id,
      reason: "story_fact_source_version_not_current",
    });
    expect(
      readDocuments().every(
        ({ sourceId, sourceVersionId }) =>
          sourceId !== chapter.value.chapter.id ||
          sourceVersionId === saved.value.chapter.currentVersionId,
      ),
    ).toBe(true);
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
            chunkKind: string;
            parentDocumentId: string | null;
            utf16Start: number;
            utf16End: number;
            sourceLength: number;
          }[];
        }
      >;
    };
    const documents = database.projects?.[project.value.id]?.documents ?? [];

    const chapterChunks = documents.filter(({ chunkKind }) => chunkKind === "chapter");
    const paragraphChunks = documents.filter(({ chunkKind }) => chunkKind === "paragraph");
    expect(chapterChunks.length).toBeGreaterThan(2);
    expect(paragraphChunks).toHaveLength(chapterChunks.length);
    expect(chapterChunks.map(({ id }) => id)).toEqual(
      chapterChunks.map((_, index) => `chapter:${chapter.value.chapter.id}:${String(index)}`),
    );
    for (const document of documents) {
      expect(document.sourceVersionId).toBe(chapter.value.chapter.currentVersionId);
      expect(document.sourceLength).toBe(content.length);
      expect(content.slice(document.utf16Start, document.utf16End)).toBe(document.text);
      expect(
        new TextEncoder().encode(`${document.title}\n${document.text}`).byteLength,
      ).toBeLessThan(64 * 1024);
      expect(document.text).not.toContain("\uFFFD");
      const first = document.text.charCodeAt(0);
      const last = document.text.charCodeAt(document.text.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      if (document.parentDocumentId !== null) {
        const parent = documents.find(({ id }) => id === document.parentDocumentId);
        expect(parent).toBeDefined();
        expect(parent?.utf16Start).toBeLessThanOrEqual(document.utf16Start);
        expect(parent?.utf16End).toBeGreaterThanOrEqual(document.utf16End);
      }
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
      hashedDocumentCount: 4,
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
    // jsdom's browser quota is intentionally small; use the same Storage
    // contract without an artificial quota for this million-character fixture.
    const runtime = createDevelopmentRuntime(new UnboundedTestStorage());
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
      documentCount: 400,
      upsertedCount: 0,
      unchangedCount: 400,
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

class UnboundedTestStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
