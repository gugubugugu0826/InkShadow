import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  CausalEventGraphInput,
  CausalEventNode,
  CausalEventRelation,
  CausalTextEvidence,
} from "@inkshadow/story-core";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  BrowserDevelopmentCausalEventGraphStore,
  DEVELOPMENT_CAUSAL_EVENT_GRAPH_STORE_KEY,
  SqliteCausalEventGraphStore,
  type CausalChapterVersionSource,
  type CausalEvidenceReader,
} from "./causal-event-graph-store";

const migration = [
  readMigration("0001_core.sql"),
  readMigration("0033_causal_event_graph.sql"),
].join("\n");

const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = "project-one";
const CHAPTER_ID = "chapter-one";
const CHAPTER_VERSION_ID = "chapter-version-one";
const SOURCE_TEXT = "序章🌙门开启。钟声响起。余音仍在。";
const EXCERPT = "门开启。";
const openExecutors = new Set<NodeSqliteExecutor>();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  window.localStorage.clear();
  await Promise.all(
    [...openExecutors].map(async (executor) => {
      await executor.close();
      openExecutors.delete(executor);
    }),
  );
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("causal event graph persistence adapters", () => {
  it("round-trips every causal child through SQLite and survives a database restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "inkshadow-causal-store-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "inkshadow.sqlite");
    const input = await richGraph("main", "restart");

    const firstExecutor = await sqliteExecutor(databasePath, true);
    const firstStore = sqliteStore(firstExecutor);
    const written = await firstStore.replace({
      projectId: PROJECT_ID,
      branchId: "main",
      graph: input,
    });
    expect(written.events[0]).toMatchObject({
      participantCharacterIds: ["character-guide", "character-hero"],
      prerequisites: [{ id: "restart-prerequisite" }],
      characterStateChanges: [{ id: "restart-character-change" }],
      relationshipChanges: [{ id: "restart-relationship-change" }],
      itemChanges: [{ id: "restart-item-change" }],
      informedCharacterIds: ["character-guide"],
      foreshadowProgress: [{ id: "restart-foreshadow" }],
    });
    await closeExecutor(firstExecutor);

    const reopenedExecutor = await sqliteExecutor(databasePath, false);
    const reopened = sqliteStore(reopenedExecutor);
    const loaded = await reopened.loadProjectBranch(PROJECT_ID, "main");

    expect(loaded.events).toEqual(written.events);
    expect(loaded.relations).toEqual(written.relations);
    await expect(
      reopenedExecutor.select<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM causal_evidence_sources
         WHERE project_id = ?`,
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ count: 1 }]);
  });

  it("appends new identifiers atomically, rejects replay conflicts, and traces stored impacts", async () => {
    const executor = await sqliteExecutor();
    const store = sqliteStore(executor);
    const evidence = await makeEvidence("append-evidence");
    const first: CausalEventGraphInput = {
      events: [event("append-a", 1, "main", evidence, [])],
      relations: [],
    };
    const delta: CausalEventGraphInput = {
      events: [event("append-b", 2, "main", evidence, [])],
      relations: [relation("append-ab", "append-a", "append-b", "main", evidence)],
    };

    await store.replace({ projectId: PROJECT_ID, branchId: "main", graph: first });
    const appended = await store.append({
      projectId: PROJECT_ID,
      branchId: "main",
      graph: delta,
    });

    expect(appended.events.find(({ id }) => id === "append-a")?.downstreamEventIds).toEqual([
      "append-b",
    ]);
    await expect(
      store.traceImpacts({
        projectId: PROJECT_ID,
        branchId: "main",
        changedEventIds: ["append-a"],
      }),
    ).resolves.toMatchObject({
      impactedEvents: [
        {
          eventId: "append-b",
          depth: 1,
          pathEventIds: ["append-a", "append-b"],
          pathRelationIds: ["append-ab"],
        },
      ],
      truncated: false,
    });
    await expect(
      store.append({ projectId: PROJECT_ID, branchId: "main", graph: delta }),
    ).rejects.toMatchObject({ code: "CAUSAL_GRAPH_CONFLICT" });
    expect((await store.loadProjectBranch(PROJECT_ID, "main")).events).toHaveLength(2);
  });

  it("fails closed on a changed chapter version before replacing any SQLite rows", async () => {
    const executor = await sqliteExecutor();
    const store = sqliteStore(executor);
    const original = await singleEventGraph("main", "original");
    await store.replace({ projectId: PROJECT_ID, branchId: "main", graph: original });

    const tamperedText = SOURCE_TEXT.replace("门开启", "门关闭");
    await executor.execute(
      `UPDATE chapter_versions
       SET content = ?, content_checksum = ?
       WHERE id = ?`,
      [tamperedText, await sha256Hex(tamperedText), CHAPTER_VERSION_ID],
    );
    const replacement = await singleEventGraph("main", "replacement");

    await expect(
      store.replace({ projectId: PROJECT_ID, branchId: "main", graph: replacement }),
    ).rejects.toMatchObject({ code: "CAUSAL_GRAPH_EVIDENCE_INVALID" });
    await expect(
      executor.select<{ id: string }>(
        `SELECT id FROM causal_events
         WHERE project_id = ? AND branch_id = ?`,
        [PROJECT_ID, "main"],
      ),
    ).resolves.toEqual([{ id: "original-event" }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM causal_evidence_sources WHERE id = ?",
        ["replacement-evidence"],
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(store.loadProjectBranch(PROJECT_ID, "main")).rejects.toMatchObject({
      code: "CAUSAL_GRAPH_EVIDENCE_INVALID",
    });
  });

  it("rolls back a branch replacement when a late child-identifier conflict occurs", async () => {
    const executor = await sqliteExecutor();
    const store = sqliteStore(executor);
    await store.replace({
      projectId: PROJECT_ID,
      branchId: "main",
      graph: await singleEventGraph("main", "old-main"),
    });
    await store.replace({
      projectId: PROJECT_ID,
      branchId: "alternate",
      graph: await graphWithPrerequisite("alternate", "alternate", "shared-component"),
    });

    await expect(
      store.replace({
        projectId: PROJECT_ID,
        branchId: "main",
        graph: await graphWithPrerequisite("main", "new-main", "shared-component"),
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_GRAPH_CONFLICT" });

    const rows = await executor.select<{ id: string }>(
      `SELECT id FROM causal_events
       WHERE project_id = ? AND branch_id = ?`,
      [PROJECT_ID, "main"],
    );
    expect(rows).toEqual([{ id: "old-main-event" }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM causal_evidence_sources WHERE id = ?",
        ["new-main-evidence"],
      ),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("keeps SQLite branches isolated and rejects a mismatched write scope", async () => {
    const executor = await sqliteExecutor();
    const store = sqliteStore(executor);
    await store.replace({
      projectId: PROJECT_ID,
      branchId: "main",
      graph: await singleEventGraph("main", "main"),
    });
    await store.replace({
      projectId: PROJECT_ID,
      branchId: "alternate",
      graph: await singleEventGraph("alternate", "alternate"),
    });

    expect((await store.loadProjectBranch(PROJECT_ID, "main")).events.map(({ id }) => id)).toEqual([
      "main-event",
    ]);
    expect(
      (await store.loadProjectBranch(PROJECT_ID, "alternate")).events.map(({ id }) => id),
    ).toEqual(["alternate-event"]);
    await expect(
      store.replace({
        projectId: PROJECT_ID,
        branchId: "main",
        graph: await singleEventGraph("alternate", "wrong-branch"),
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_GRAPH_INVALID" });
    const wrongProject = await singleEventGraph("main", "wrong-project");
    await expect(
      store.replace({
        projectId: PROJECT_ID,
        branchId: "main",
        graph: {
          events: wrongProject.events.map((value) => ({
            ...value,
            projectId: "project-two",
          })),
          relations: wrongProject.relations,
        },
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_GRAPH_INVALID" });
    expect((await store.loadProjectBranch(PROJECT_ID, "main")).events[0]?.id).toBe("main-event");
  });

  it("persists browser-development graphs across store recreation with identical evidence checks", async () => {
    const source = await chapterVersionSource();
    const reader = new MutableEvidenceReader(source);
    const first = new BrowserDevelopmentCausalEventGraphStore(window.localStorage, reader);
    const input = await richGraph("main", "browser");
    const written = await first.replace({
      projectId: PROJECT_ID,
      branchId: "main",
      graph: input,
    });

    const serialized = window.localStorage.getItem(DEVELOPMENT_CAUSAL_EVENT_GRAPH_STORE_KEY);
    expect(serialized).not.toBeNull();
    const reopened = new BrowserDevelopmentCausalEventGraphStore(window.localStorage, reader);
    expect((await reopened.loadProjectBranch(PROJECT_ID, "main")).events).toEqual(written.events);

    const tamperedText = SOURCE_TEXT.replace("钟声", "鼓声");
    reader.source = {
      ...source,
      content: tamperedText,
      contentChecksum: await sha256Hex(tamperedText),
    };
    await expect(reopened.loadProjectBranch(PROJECT_ID, "main")).rejects.toMatchObject({
      code: "CAUSAL_GRAPH_EVIDENCE_INVALID",
    });
    expect(window.localStorage.getItem(DEVELOPMENT_CAUSAL_EVENT_GRAPH_STORE_KEY)).toBe(serialized);
  });

  it("fails closed on missing evidence and cross-branch browser identifiers", async () => {
    const source = await chapterVersionSource();
    const reader = new MutableEvidenceReader(source);
    const store = new BrowserDevelopmentCausalEventGraphStore(window.localStorage, reader);
    const main = await singleEventGraph("main", "browser-main");
    await store.replace({ projectId: PROJECT_ID, branchId: "main", graph: main });

    reader.source = null;
    await expect(
      store.replace({
        projectId: PROJECT_ID,
        branchId: "alternate",
        graph: await singleEventGraph("alternate", "missing"),
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_GRAPH_EVIDENCE_INVALID" });
    reader.source = source;
    const colliding = await singleEventGraph("alternate", "browser-main");
    await expect(
      store.replace({
        projectId: PROJECT_ID,
        branchId: "alternate",
        graph: colliding,
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_GRAPH_CONFLICT" });
    expect((await store.loadProjectBranch(PROJECT_ID, "main")).events[0]?.id).toBe(
      "browser-main-event",
    );
  });
});

class MutableEvidenceReader implements CausalEvidenceReader {
  public constructor(public source: CausalChapterVersionSource | null) {}

  public readChapterVersion(chapterVersionId: string): Promise<CausalChapterVersionSource | null> {
    return Promise.resolve(this.source?.chapterVersionId === chapterVersionId ? this.source : null);
  }
}

async function sqliteExecutor(databasePath = ":memory:", seed = true): Promise<NodeSqliteExecutor> {
  const executor = new NodeSqliteExecutor(migration, databasePath);
  openExecutors.add(executor);
  if (seed) {
    await seedChapter(executor);
  }
  return executor;
}

function sqliteStore(executor: NodeSqliteExecutor): SqliteCausalEventGraphStore {
  return new SqliteCausalEventGraphStore(executor, { now: () => NOW });
}

async function closeExecutor(executor: NodeSqliteExecutor): Promise<void> {
  await executor.close();
  openExecutors.delete(executor);
}

async function seedChapter(executor: NodeSqliteExecutor): Promise<void> {
  const checksum = await sha256Hex(SOURCE_TEXT);
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at,
         archived_at, trashed_at, retention_until, status_before_trash
       ) VALUES (?, 'Causal store project', 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
      [PROJECT_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision, current_version_id,
         created_at, updated_at, trashed_at
       ) VALUES (?, ?, 'Chapter one', ?, 'active', 1, ?, ?, ?, NULL)`,
      [CHAPTER_ID, PROJECT_ID, SOURCE_TEXT, CHAPTER_VERSION_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
      [CHAPTER_VERSION_ID, PROJECT_ID, CHAPTER_ID, SOURCE_TEXT, checksum, NOW],
    );
  });
}

async function chapterVersionSource(): Promise<CausalChapterVersionSource> {
  return {
    chapterVersionId: CHAPTER_VERSION_ID,
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    content: SOURCE_TEXT,
    contentChecksum: await sha256Hex(SOURCE_TEXT),
  };
}

async function richGraph(branchId: string, prefix: string): Promise<CausalEventGraphInput> {
  const evidence = await makeEvidence(`${prefix}-evidence`);
  const first: CausalEventNode = {
    ...event(`${prefix}-a`, 1, branchId, evidence, [`${prefix}-b`]),
    participantCharacterIds: ["character-guide", "character-hero"],
    prerequisites: [
      {
        id: `${prefix}-prerequisite`,
        kind: "state",
        referenceId: "gate-open",
        description: "The gate is open.",
        evidence,
      },
    ],
    characterStateChanges: [
      {
        id: `${prefix}-character-change`,
        characterId: "character-hero",
        attributeKey: "location",
        beforeValue: "outside",
        afterValue: "inside",
        evidence,
      },
    ],
    relationshipChanges: [
      {
        id: `${prefix}-relationship-change`,
        fromCharacterId: "character-guide",
        toCharacterId: "character-hero",
        relationshipKey: "trust",
        beforeValue: 0,
        afterValue: 1,
        evidence,
      },
    ],
    itemChanges: [
      {
        id: `${prefix}-item-change`,
        itemId: "sealed-letter",
        kind: "acquired",
        fromCharacterId: null,
        toCharacterId: "character-hero",
        evidence,
      },
    ],
    informedCharacterIds: ["character-guide"],
    foreshadowProgress: [
      {
        id: `${prefix}-foreshadow`,
        foreshadowId: "missing-prince",
        kind: "planted",
        description: "The seal resembles the missing prince's crest.",
        evidence,
      },
    ],
  };
  return {
    events: [first, event(`${prefix}-b`, 2, branchId, evidence, [])],
    relations: [relation(`${prefix}-relation`, `${prefix}-a`, `${prefix}-b`, branchId, evidence)],
  };
}

async function singleEventGraph(branchId: string, prefix: string): Promise<CausalEventGraphInput> {
  const evidence = await makeEvidence(`${prefix}-evidence`);
  return {
    events: [event(`${prefix}-event`, 1, branchId, evidence, [])],
    relations: [],
  };
}

async function graphWithPrerequisite(
  branchId: string,
  prefix: string,
  prerequisiteId: string,
): Promise<CausalEventGraphInput> {
  const evidence = await makeEvidence(`${prefix}-evidence`);
  return {
    events: [
      {
        ...event(`${prefix}-event`, 1, branchId, evidence, []),
        prerequisites: [
          {
            id: prerequisiteId,
            kind: "state",
            referenceId: `${prefix}-state`,
            description: "The required state exists.",
            evidence,
          },
        ],
      },
    ],
    relations: [],
  };
}

function event(
  id: string,
  order: number,
  branchId: string,
  evidence: CausalTextEvidence,
  downstreamEventIds: readonly string[],
): CausalEventNode {
  return {
    id,
    projectId: PROJECT_ID,
    branchId,
    status: "confirmed",
    participantCharacterIds: [],
    narrativeTime: { order, label: `Beat ${String(order)}` },
    location: { locationId: "old-gate", label: "Old gate" },
    prerequisites: [],
    eventText: `${id} occurs.`,
    resultText: `${id} changes the story.`,
    characterStateChanges: [],
    relationshipChanges: [],
    itemChanges: [],
    informedCharacterIds: [],
    foreshadowProgress: [],
    downstreamEventIds,
    evidence,
  };
}

function relation(
  id: string,
  fromEventId: string,
  toEventId: string,
  branchId: string,
  evidence: CausalTextEvidence,
): CausalEventRelation {
  return {
    id,
    projectId: PROJECT_ID,
    branchId,
    fromEventId,
    toEventId,
    kind: "causes",
    evidence,
  };
}

async function makeEvidence(id: string): Promise<CausalTextEvidence> {
  const startOffset = SOURCE_TEXT.indexOf(EXCERPT);
  if (startOffset < 0) {
    throw new Error("Expected the evidence excerpt in the source fixture.");
  }
  return {
    id,
    chapterId: CHAPTER_ID,
    chapterVersionId: CHAPTER_VERSION_ID,
    contentHash: await sha256Hex(SOURCE_TEXT),
    locator: `chapter:${CHAPTER_ID}#${String(startOffset)}-${String(startOffset + EXCERPT.length)}`,
    excerpt: EXCERPT,
    startOffset,
    endOffset: startOffset + EXCERPT.length,
    sourceLength: SOURCE_TEXT.length,
  };
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
