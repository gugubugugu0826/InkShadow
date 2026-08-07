import { StoryFact, parseUuidV7 } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BrowserDevelopmentStoryFactStore,
  DEVELOPMENT_STORY_FACT_STORE_KEY,
} from "./story-fact-store";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const FACT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const ACTOR_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-01T00:01:00.000Z";

beforeEach(() => {
  localStorage.clear();
});

describe("BrowserDevelopmentStoryFactStore", () => {
  it("matches SQLite lifecycle, filters, CAS, and revision behavior", async () => {
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const original = createFact();
    expect((await store.create(original)).ok).toBe(true);

    const projectId = unwrap(parseUuidV7(PROJECT_ID));
    expect(unwrap(await store.listByProjectId(projectId, { needsReview: true }))).toHaveLength(1);
    expect(unwrap(await store.listByProjectId(projectId, { status: "formal" }))).toHaveLength(0);

    const confirmed = unwrap(
      original.confirm({
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
        lock: true,
        now: T1,
      }),
    );
    expect((await store.save(confirmed, 1)).ok).toBe(true);
    const stale = await store.save(confirmed, 1);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("STORY_REVISION_CONFLICT");
    }

    expect(unwrap(await store.findById(confirmed.id))?.toSnapshot()).toMatchObject({
      status: "formal",
      userConfirmed: true,
      locked: true,
      revision: 2,
    });
    expect(
      unwrap(await store.listRevisions(confirmed.id)).map(({ changeKind }) => changeKind),
    ).toEqual(["created", "confirmed"]);
  });

  it("fails closed when persisted fact data is corrupt", async () => {
    localStorage.setItem(
      DEVELOPMENT_STORY_FACT_STORE_KEY,
      JSON.stringify({ schemaVersion: 1, facts: { [FACT_ID]: {} }, revisions: {} }),
    );
    const store = new BrowserDevelopmentStoryFactStore(localStorage);

    const result = await store.findById(unwrap(parseUuidV7(FACT_ID)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_REPOSITORY_ERROR");
    }
  });
});

function createFact(): StoryFact {
  return unwrap(
    StoryFact.create({
      id: FACT_ID,
      projectId: PROJECT_ID,
      factType: "world_rule",
      contentText: "雨停后，遗忘的名字会短暂归来。",
      source: {
        kind: "system_derivation",
        reference: "extraction-job:browser-test",
      },
      confidence: 0.76,
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
      humanConfirmed: false,
      now: T0,
    }),
  );
}

function unwrap<Value>(result: { ok: true; value: Value } | { ok: false; error: unknown }): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}
