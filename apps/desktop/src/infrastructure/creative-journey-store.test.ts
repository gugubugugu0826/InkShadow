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

  it("maps quota failures to a stable retryable error without partially committing", async () => {
    const storage = new FaultInjectingStorage(window.localStorage);
    const store = new BrowserCreativeJourneyStore(storage);
    const record = journey();
    await store.create(record, turn());
    const updated = {
      ...record,
      revision: 2,
      currentState: "asking_one_question",
      updatedAt: LATER,
    } satisfies CreativeJourneyRecord;

    storage.failNextWrite(new DOMException("quota reached", "QuotaExceededError"));
    await expect(store.update(updated, 1)).rejects.toMatchObject({
      code: "CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED",
      retryable: true,
    });
    expect((await store.findById(JOURNEY_ID))?.revision).toBe(1);

    await store.update(updated, 1);
    expect((await store.findById(JOURNEY_ID))?.revision).toBe(2);
  });

  it("maps denied browser storage access to a stable retryable error", async () => {
    const storage = new FaultInjectingStorage(window.localStorage);
    const store = new BrowserCreativeJourneyStore(storage);
    storage.failNextRead(new DOMException("storage disabled", "SecurityError"));

    await expect(store.listActive("idea")).rejects.toMatchObject({
      code: "CREATIVE_JOURNEY_STORAGE_ACCESS_DENIED",
      retryable: true,
    });
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

class FaultInjectingStorage implements Storage {
  private nextReadError: Error | null = null;
  private nextWriteError: Error | null = null;

  public constructor(private readonly delegate: Storage) {}

  public get length(): number {
    return this.delegate.length;
  }

  public clear(): void {
    this.delegate.clear();
  }

  public failNextRead(error: Error): void {
    this.nextReadError = error;
  }

  public failNextWrite(error: Error): void {
    this.nextWriteError = error;
  }

  public getItem(key: string): string | null {
    if (this.nextReadError !== null) {
      const error = this.nextReadError;
      this.nextReadError = null;
      throw error;
    }
    return this.delegate.getItem(key);
  }

  public key(index: number): string | null {
    return this.delegate.key(index);
  }

  public removeItem(key: string): void {
    this.delegate.removeItem(key);
  }

  public setItem(key: string, value: string): void {
    if (this.nextWriteError !== null) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    this.delegate.setItem(key, value);
  }
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
