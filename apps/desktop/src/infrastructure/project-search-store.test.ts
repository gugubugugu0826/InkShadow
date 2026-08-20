import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SearchDocument } from "@inkshadow/search-core";
import { beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  BrowserDevelopmentProjectSearchSnapshotStore,
  DEVELOPMENT_PROJECT_SEARCH_KEY,
  ProjectSearchSnapshotStoreError,
  TauriProjectSearchSnapshotStore,
  defaultProjectSearchRetrievalScope,
} from "./project-search-store";

const migration = [
  readMigration("0001_core.sql"),
  readMigration("0006_search_index.sql"),
  readMigration("0070_multigranular_search_retrieval.sql"),
].join("\n");

const NOW = "2026-07-27T00:00:00.000Z";
const LATER = "2026-07-27T00:01:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const PROJECT_SCOPE = defaultProjectSearchRetrievalScope(PROJECT_ID);

describe("persistent project search snapshot stores", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists SQLite snapshots across store instances and writes only deltas", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor);
    const firstStore = new TauriProjectSearchSnapshotStore(executor);
    const firstDocument = document("version-1", "旧日航标 ＡＢＣ", "a".repeat(64));

    const created = await firstStore.synchronizeProject({
      projectId: PROJECT_ID,
      documents: [firstDocument],
      indexedAt: NOW,
    });
    const firstCandidates = await firstStore.findKeywordCandidates(
      PROJECT_ID,
      "旧日航标",
      PROJECT_SCOPE,
    );
    const normalizedCandidates = await firstStore.findKeywordCandidates(
      PROJECT_ID,
      "abc",
      PROJECT_SCOPE,
    );
    const shortQueryFallback = await firstStore.findKeywordCandidates(
      PROJECT_ID,
      "正文",
      PROJECT_SCOPE,
    );
    const secondStore = new TauriProjectSearchSnapshotStore(executor);
    const loaded = await secondStore.loadProject(PROJECT_ID);
    const unchanged = await secondStore.synchronizeProject({
      projectId: PROJECT_ID,
      documents: [firstDocument],
      indexedAt: LATER,
    });
    const changedDocument = document("version-2", "第二版正文", "b".repeat(64));
    const changed = await secondStore.synchronizeProject({
      projectId: PROJECT_ID,
      documents: [changedDocument],
      indexedAt: LATER,
    });
    const staleCandidates = await secondStore.findKeywordCandidates(
      PROJECT_ID,
      "旧日航标",
      PROJECT_SCOPE,
    );
    const changedCandidates = await secondStore.findKeywordCandidates(
      PROJECT_ID,
      "第二版正文",
      PROJECT_SCOPE,
    );
    const partialCandidates = await secondStore.findKeywordCandidates(
      PROJECT_ID,
      "第二版正文延伸",
      PROJECT_SCOPE,
    );
    const deleted = await secondStore.synchronizeProject({
      projectId: PROJECT_ID,
      documents: [],
      indexedAt: "2026-07-27T00:02:00.000Z",
    });

    expect(created).toMatchObject({
      changed: true,
      unchangedCount: 0,
      snapshot: { revision: 1 },
    });
    expect(firstCandidates).toMatchObject({
      documentIds: [`chapter:${PROJECT_ID}:0`],
      backend: "sqlite_fts5",
      recovered: false,
      degraded: false,
    });
    expect(normalizedCandidates.documentIds).toEqual([`chapter:${PROJECT_ID}:0`]);
    expect(shortQueryFallback).toMatchObject({
      documentIds: [`chapter:${PROJECT_ID}:0`],
      backend: "in_memory",
      recovered: false,
      degraded: false,
    });
    expect(loaded).toMatchObject({
      revision: 1,
      documents: [
        {
          sourceVersionId: "version-1",
          text: "旧日航标 ＡＢＣ",
          sourceLength: "旧日航标 ＡＢＣ".length,
          sceneId: null,
          eventId: null,
          characterIds: [],
          locationIds: [],
          storyTime: null,
        },
      ],
    });
    expect(unchanged).toMatchObject({
      changed: false,
      unchangedCount: 1,
      upsertedDocuments: [],
      deletedDocumentIds: [],
      snapshot: { revision: 1, indexedAt: NOW },
    });
    expect(changed).toMatchObject({
      changed: true,
      unchangedCount: 0,
      snapshot: { revision: 2 },
      upsertedDocuments: [{ sourceVersionId: "version-2" }],
    });
    expect(staleCandidates.documentIds).toEqual([]);
    expect(changedCandidates.documentIds).toEqual([`chapter:${PROJECT_ID}:0`]);
    expect(partialCandidates.documentIds).toEqual([`chapter:${PROJECT_ID}:0`]);
    expect(deleted).toMatchObject({
      changed: true,
      deletedDocumentIds: [`chapter:${PROJECT_ID}:0`],
      snapshot: { revision: 3, documents: [] },
    });
    await executor.close();
  });

  it("detects internally inconsistent SQLite snapshots as recoverable derived corruption", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor);
    const store = new TauriProjectSearchSnapshotStore(executor);
    await store.synchronizeProject({
      projectId: PROJECT_ID,
      documents: [document("version-1", "正文", "a".repeat(64))],
      indexedAt: NOW,
    });
    await executor.execute(
      "UPDATE search_index_state SET document_count = 2 WHERE project_id = ?",
      [PROJECT_ID],
    );

    await expect(store.loadProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SEARCH_SNAPSHOT_CORRUPT",
      retryable: false,
    });
    await store.resetProject(PROJECT_ID);
    await expect(store.loadProject(PROJECT_ID)).resolves.toBeNull();
    await executor.close();
  });

  it("bounds browser corruption and can discard only derived state", async () => {
    const store = new BrowserDevelopmentProjectSearchSnapshotStore(window.localStorage);
    window.localStorage.setItem(DEVELOPMENT_PROJECT_SEARCH_KEY, "{broken");

    await expect(store.loadProject(PROJECT_ID)).rejects.toBeInstanceOf(
      ProjectSearchSnapshotStoreError,
    );
    await store.resetProject(PROJECT_ID);

    expect(window.localStorage.getItem(DEVELOPMENT_PROJECT_SEARCH_KEY)).toBeNull();
    await expect(store.loadProject(PROJECT_ID)).resolves.toBeNull();
  });

  it("hard-filters current version, branch, POV, chronology, privacy, currentness, and task before FTS", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor);
    const store = new TauriProjectSearchSnapshotStore(executor);
    const matching = scopedDocument("matching", {
      sourceVersionId: "version-current-a",
      branchId: "branch-current",
      povCharacterId: "character-alice",
      storyOrder: 2,
      privacy: "standard",
      currentness: "current",
      authority: "accepted_text",
    });
    const previousChapter = scopedDocument("previous-chapter", {
      sourceVersionId: "version-current-b",
      branchId: null,
      povCharacterId: null,
      storyOrder: 1,
    });
    const timelessCanon = scopedDocument("timeless-canon", {
      sourceType: "memory",
      sourceVersionId: "version-current-c",
      chunkKind: "story_fact_evidence",
      branchId: null,
      povCharacterId: null,
      storyOrder: null,
      authority: "confirmed_fact",
    });
    const documents = [
      matching,
      previousChapter,
      timelessCanon,
      scopedDocument("wrong-branch", { branchId: "alternate" }),
      scopedDocument("wrong-pov", { povCharacterId: "character-bob" }),
      scopedDocument("future", { storyOrder: 3 }),
      scopedDocument("private", { privacy: "local_only" }),
      scopedDocument("stale", { currentness: "stale" }),
      scopedDocument("rebuildable", { authority: "rebuildable" }),
    ];
    await store.synchronizeProject({ projectId: PROJECT_ID, documents, indexedAt: NOW });

    const scope = {
      projectId: PROJECT_ID,
      taskType: "agent_fts",
      privacy: "standard_only",
      currentness: "current",
      branchId: "branch-current",
      povCharacterId: "character-alice",
      maximumStoryOrder: 2,
    } as const;
    const result = await store.findKeywordCandidates(PROJECT_ID, "scope marker", scope);
    const injectedBranch = await store.findKeywordCandidates(PROJECT_ID, "scope marker", {
      ...scope,
      branchId: "branch-current' OR 1=1 --",
    });
    const local = await store.findKeywordCandidates(PROJECT_ID, "scope marker", {
      ...scope,
      privacy: "include_local_only",
    });
    const privateOnly = await store.findKeywordCandidates(PROJECT_ID, "scope marker", {
      ...scope,
      privacy: "local_only",
    });
    const singleSource = await store.findKeywordCandidates(PROJECT_ID, "scope marker", {
      ...scope,
      sourceId: matching.sourceId,
      currentVersionId: matching.sourceVersionId,
    });

    expect(result).toMatchObject({
      backend: "sqlite_fts5",
      degraded: false,
      scopeTrace: {
        taskType: "agent_fts",
        omittedHardFilters: [],
        authorityNeutralOmissions: ["branch", "pov", "story_order"],
        versionMode: "per_source_current",
      },
    });
    expect(result.documentIds).toHaveLength(3);
    expect(result.documentIds).toEqual(
      expect.arrayContaining([matching.id, previousChapter.id, timelessCanon.id]),
    );
    expect(injectedBranch.documentIds).toHaveLength(2);
    expect(injectedBranch.documentIds).toEqual(
      expect.arrayContaining([previousChapter.id, timelessCanon.id]),
    );
    expect(injectedBranch.documentIds).not.toContain(matching.id);
    expect(local.documentIds).toHaveLength(4);
    expect(local.documentIds).toContain("paragraph:private");
    expect(privateOnly.documentIds).toEqual(["paragraph:private"]);
    expect(singleSource.documentIds).toEqual([matching.id]);
    expect(singleSource.scopeTrace.versionMode).toBe("single_source_version");
    await expect(
      store.findKeywordCandidates(PROJECT_ID, "scope marker", {
        ...scope,
        currentVersionId: matching.sourceVersionId,
      }),
    ).rejects.toMatchObject({ code: "SEARCH_SCOPE_INVALID" });
    await executor.close();
  });

  it("keeps browser scope filtering deterministic across restart without a provider", async () => {
    const first = new BrowserDevelopmentProjectSearchSnapshotStore(window.localStorage);
    const current = scopedDocument("browser-current", {
      branchId: null,
      povCharacterId: null,
    });
    const stale = scopedDocument("browser-stale", {
      branchId: null,
      povCharacterId: null,
      currentness: "stale",
    });
    await first.synchronizeProject({
      projectId: PROJECT_ID,
      documents: [current, stale],
      indexedAt: NOW,
    });

    const second = new BrowserDevelopmentProjectSearchSnapshotStore(window.localStorage);
    await expect(
      second.findKeywordCandidates(PROJECT_ID, "scope marker", {
        projectId: PROJECT_ID,
        taskType: "agent_fts",
        privacy: "standard_only",
        currentness: "current",
      }),
    ).rejects.toMatchObject({ code: "SEARCH_SCOPE_INVALID", retryable: false });
    const result = await second.findKeywordCandidates(PROJECT_ID, "scope marker", {
      projectId: PROJECT_ID,
      taskType: "agent_fts",
      privacy: "standard_only",
      currentness: "current",
      branchId: null,
      povCharacterId: null,
      maximumStoryOrder: 2,
    });

    expect(result.documentIds).toEqual([current.id]);
    expect(result.backend).toBe("in_memory");
  });

  it("keeps SQLite FTS5 trigram searches over one million synthetic characters below the gate", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor);
    const store = new TauriProjectSearchSnapshotStore(executor);
    const documents: SearchDocument[] = Array.from({ length: 100 }, (_, index) => {
      const marker = index === 99 ? "终局独有信标" : `合成编号${String(index).padStart(4, "0")}`;
      return {
        id: `chapter:${PROJECT_ID}:${String(index)}`,
        projectId: PROJECT_ID,
        sourceType: "chapter",
        sourceId: `source-${String(index)}`,
        sourceVersionId: `version-${String(index)}`,
        title: `合成章节 ${String(index + 1)}`,
        text: `${marker}${"星河边境风暴潮汐".repeat(1_250)}`.slice(0, 10_000),
        contentHash: index.toString(16).padStart(64, "0"),
        updatedAt: NOW,
        chunkKind: "chapter",
        parentDocumentId: null,
        utf16Start: 0,
        utf16End: `${marker}${"星河边境风暴潮汐".repeat(1_250)}`.slice(0, 10_000).length,
        sourceLength: `${marker}${"星河边境风暴潮汐".repeat(1_250)}`.slice(0, 10_000).length,
        sceneId: null,
        eventId: null,
        characterIds: [],
        locationIds: [],
        storyTime: null,
        branchId: null,
        povCharacterId: null,
        storyOrder: index + 1,
        authority: "accepted_text",
        privacy: "standard",
        currentness: "current",
        omittedScopeFields: ["pov", "story_time"],
      };
    });
    await store.synchronizeProject({
      projectId: PROJECT_ID,
      documents,
      indexedAt: NOW,
    });

    const coldStartedAt = performance.now();
    const cold = await store.findKeywordCandidates(PROJECT_ID, "终局独有信标", PROJECT_SCOPE);
    const coldMilliseconds = performance.now() - coldStartedAt;
    const durations: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const startedAt = performance.now();
      const candidates = await store.findKeywordCandidates(
        PROJECT_ID,
        "终局独有信标",
        PROJECT_SCOPE,
      );
      durations.push(performance.now() - startedAt);
      expect(candidates.documentIds).toEqual([`chapter:${PROJECT_ID}:99`]);
    }
    durations.sort((left, right) => left - right);
    const p50 = durations[Math.ceil(durations.length * 0.5) - 1];
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];

    expect(cold).toMatchObject({ backend: "sqlite_fts5", degraded: false });
    expect(coldMilliseconds).toBeLessThan(1_000);
    expect(p95).toBeDefined();
    expect(p95).toBeLessThan(1_000);
    process.stdout.write(
      `[search-fts5-benchmark] chapters=100 characters=1000000 runs=20 cold_ms=${coldMilliseconds.toFixed(
        2,
      )} hot_p50_ms=${p50?.toFixed(2) ?? "n/a"} hot_p95_ms=${p95?.toFixed(2) ?? "n/a"}\n`,
    );
    await executor.close();
  }, 30_000);
});

function document(sourceVersionId: string, text: string, contentHash: string): SearchDocument {
  return {
    id: `chapter:${PROJECT_ID}:0`,
    projectId: PROJECT_ID,
    sourceType: "chapter",
    sourceId: PROJECT_ID,
    sourceVersionId,
    title: "第一章",
    text,
    contentHash,
    updatedAt: NOW,
    chunkKind: "chapter",
    parentDocumentId: null,
    utf16Start: 0,
    utf16End: text.length,
    sourceLength: text.length,
    sceneId: null,
    eventId: null,
    characterIds: [],
    locationIds: [],
    storyTime: null,
    branchId: null,
    povCharacterId: null,
    storyOrder: 1,
    authority: "accepted_text",
    privacy: "standard",
    currentness: "current",
    omittedScopeFields: ["pov", "story_time"],
  };
}

function scopedDocument(suffix: string, overrides: Partial<SearchDocument> = {}): SearchDocument {
  const text = "scope marker evidence";
  return {
    id: `paragraph:${suffix}`,
    projectId: PROJECT_ID,
    sourceType: "chapter",
    sourceId: `chapter-${suffix}`,
    sourceVersionId: "version-current",
    title: `Scope ${suffix}`,
    text,
    contentHash: suffix.codePointAt(0)?.toString(16).padStart(64, "0") ?? "a".repeat(64),
    updatedAt: NOW,
    chunkKind: "paragraph",
    parentDocumentId: null,
    utf16Start: 0,
    utf16End: text.length,
    sourceLength: text.length,
    sceneId: `scene:${suffix}`,
    eventId: null,
    characterIds: [],
    locationIds: [],
    storyTime: null,
    branchId: "branch-current",
    povCharacterId: "character-alice",
    storyOrder: 2,
    authority: "accepted_text",
    privacy: "standard",
    currentness: "current",
    omittedScopeFields: ["event", "characters", "locations", "story_time"],
    ...overrides,
  };
}

async function seedProject(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Project', ?, ?)",
    [PROJECT_ID, NOW, NOW],
  );
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
