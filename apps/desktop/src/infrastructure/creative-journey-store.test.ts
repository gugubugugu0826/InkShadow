import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";

import {
  BrowserCreativeJourneyStore,
  CreativeJourneyStoreError,
  DEVELOPMENT_CREATIVE_JOURNEY_KEY,
  SqliteCreativeJourneyStore,
  type CreativeJourneyRecord,
  type CreativeJourneyTurnRecord,
} from "./creative-journey-store";

const JOURNEY_ID = "019fa501-0000-7000-8000-000000000001";
const TURN_ID = "019fa501-0000-7000-8000-000000000002";
const NEXT_TURN_ID = "019fa501-0000-7000-8000-000000000003";
const NOW = "2026-08-01T06:00:00.000Z";
const LATER = "2026-08-01T06:01:00.000Z";

describe("BrowserCreativeJourneyStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists a resumable journey and its ordered turns", async () => {
    const store = new BrowserCreativeJourneyStore(window.localStorage);
    const record = journey();
    await store.create(record, turn());
    const updated = {
      ...record,
      revision: 2,
      currentState: "asking_one_question",
      snapshot: { version: 1, idea: "雨夜来信", preview: "第一段" },
      updatedAt: LATER,
    } satisfies CreativeJourneyRecord;
    await store.update(updated, 1, turn({ id: NEXT_TURN_ID, sequence: 2, kind: "question" }));

    const reopened = new BrowserCreativeJourneyStore(window.localStorage);
    expect(await reopened.listActive("idea")).toEqual([updated]);
    expect((await reopened.listTurns(JOURNEY_ID)).map(({ sequence }) => sequence)).toEqual([1, 2]);
  });

  it("rejects stale revisions without replacing the latest snapshot", async () => {
    const store = new BrowserCreativeJourneyStore(window.localStorage);
    const record = journey();
    await store.create(record, turn());
    const updated = { ...record, revision: 2, updatedAt: LATER } satisfies CreativeJourneyRecord;
    await store.update(updated, 1);

    await expect(store.update({ ...updated, revision: 3 }, 1)).rejects.toMatchObject({
      code: "CREATIVE_JOURNEY_REVISION_CONFLICT",
      retryable: true,
    });
    expect((await store.findById(JOURNEY_ID))?.revision).toBe(2);
  });

  it("refuses to persist credentials inside journey snapshots", async () => {
    const store = new BrowserCreativeJourneyStore(window.localStorage);
    await expect(
      store.create(journey({ snapshot: { version: 1, apiKey: "must-not-be-stored" } }), turn()),
    ).rejects.toBeInstanceOf(CreativeJourneyStoreError);
    expect(window.localStorage.getItem(DEVELOPMENT_CREATIVE_JOURNEY_KEY)).toBeNull();
  });
});

describe("SqliteCreativeJourneyStore", () => {
  it("requires the next exact turn sequence and rolls back a skipped turn", async () => {
    const executor = new NodeSqliteExecutor(`${CORE_MIGRATION}\n${CREATIVE_JOURNEY_MIGRATION}`);
    const store = new SqliteCreativeJourneyStore(executor);
    const record = journey();
    await store.create(record, turn());
    const updated = { ...record, revision: 2, updatedAt: LATER } satisfies CreativeJourneyRecord;

    await expect(
      store.update(updated, 1, turn({ id: NEXT_TURN_ID, sequence: 3, kind: "question" })),
    ).rejects.toMatchObject({
      code: "CREATIVE_JOURNEY_REVISION_CONFLICT",
      retryable: true,
    });
    expect((await store.findById(JOURNEY_ID))?.revision).toBe(1);
    expect(await store.listTurns(JOURNEY_ID)).toHaveLength(1);
  });
});

function journey(overrides: Partial<CreativeJourneyRecord> = {}): CreativeJourneyRecord {
  return {
    id: JOURNEY_ID,
    kind: "idea",
    status: "active",
    currentState: "generating_opening",
    projectId: null,
    chapterId: null,
    candidateId: null,
    revision: 1,
    snapshot: { version: 1, idea: "雨夜来信" },
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function turn(overrides: Partial<CreativeJourneyTurnRecord> = {}): CreativeJourneyTurnRecord {
  return {
    id: TURN_ID,
    journeyId: JOURNEY_ID,
    sequence: 1,
    kind: "idea",
    questionKey: null,
    generationSource: null,
    providerId: null,
    modelId: null,
    taskKey: null,
    requestId: null,
    snapshot: { idea: "雨夜来信" },
    createdAt: NOW,
    ...overrides,
  };
}

const CORE_MIGRATION = readMigration("0001_core.sql");
const CREATIVE_JOURNEY_MIGRATION = readMigration("0030_creative_journeys.sql");

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
