import { describe, expect, it } from "vitest";
import {
  ConsistencyIssue,
  ExtractionSuggestion,
  FormalStoryRecord,
  ReviewDecisionService,
  parseUuidV7,
  type CreateStructuredReviewItemInput,
} from "../src/index.js";
import { InMemoryReviewDecisionStore } from "./fakes.js";
import { ManualClock, SequenceUuidV7Generator, unwrap, uuid } from "./helpers.js";

const INITIAL_VALUE = Object.freeze({
  name: "Lin",
  allegiance: "north",
});
const SUGGESTED_VALUE = Object.freeze({
  name: "Lin",
  allegiance: "south",
});

describe("structured review and formal records", () => {
  it("retains source provenance and requires explicit human decisions", () => {
    const item = createExtraction(100);
    const snapshot = item.toSnapshot();
    expect(snapshot.sourceChapterId).toBe(uuid(104));
    expect(snapshot.sourceVersionId).toBe(uuid(105));
    expect(snapshot.evidence).toEqual({
      excerpt: "south",
      range: { start: 20, end: 25, sourceLength: 300 },
    });
    expect(snapshot.confidence).toBe(0.82);
    expect(snapshot.originalValue).toEqual(INITIAL_VALUE);
    expect(snapshot.suggestedValue).toEqual(SUGGESTED_VALUE);

    const refused = item.decide({
      kind: "accept",
      decisionId: uuid(106),
      actorId: uuid(107),
      humanConfirmed: false,
      expectedRevision: 1,
      expectedRecordRevision: 1,
      now: "2026-07-27T00:01:00.000Z",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("HUMAN_DECISION_REQUIRED");
    }
    expect(item.status).toBe("pending");

    const spoofed = item.decide({
      kind: "accept",
      decisionId: uuid(108),
      actorId: uuid(107),
      humanConfirmed: "false",
      expectedRevision: 1,
      expectedRecordRevision: 1,
      now: "2026-07-27T00:01:00.000Z",
    });
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) {
      expect(spoofed.error.code).toBe("HUMAN_DECISION_REQUIRED");
    }
  });

  it("supports deferred, resumed, accepted, modified, and rejected states", () => {
    const initial = createExtraction(200);
    const deferred = unwrap(
      initial.decide({
        kind: "defer",
        decisionId: uuid(206),
        actorId: uuid(207),
        humanConfirmed: true,
        expectedRevision: 1,
        remindAt: "2026-07-28T00:00:00.000Z",
        now: "2026-07-27T00:01:00.000Z",
      }),
    );
    expect(deferred.item.status).toBe("deferred");
    expect(deferred.plan).toBeNull();
    expect(deferred.item.toSnapshot().deferredUntil).toBe("2026-07-28T00:00:00.000Z");

    const resumed = unwrap(
      deferred.item.decide({
        kind: "resume",
        decisionId: uuid(208),
        actorId: uuid(207),
        humanConfirmed: true,
        expectedRevision: 2,
        now: "2026-07-27T00:02:00.000Z",
      }),
    );
    expect(resumed.item.status).toBe("pending");
    expect(resumed.item.toSnapshot().deferredUntil).toBeNull();

    const accepted = unwrap(
      resumed.item.decide({
        kind: "accept",
        decisionId: uuid(209),
        actorId: uuid(207),
        humanConfirmed: true,
        expectedRevision: 3,
        expectedRecordRevision: 1,
        now: "2026-07-27T00:03:00.000Z",
      }),
    );
    expect(accepted.item.status).toBe("accepted");
    expect(accepted.item.toSnapshot().finalValue).toEqual(SUGGESTED_VALUE);
    expect(accepted.plan?.toSnapshot().mode).toBe("accepted");

    const modifiedItem = createConsistency(220);
    const finalValue = { name: "Lin", allegiance: "neutral" };
    const modified = unwrap(
      modifiedItem.decide({
        kind: "modify",
        decisionId: uuid(226),
        actorId: uuid(227),
        humanConfirmed: true,
        expectedRevision: 1,
        expectedRecordRevision: 1,
        modifiedValue: finalValue,
        now: "2026-07-27T00:04:00.000Z",
      }),
    );
    expect(modified.item.status).toBe("modified");
    expect(modified.item.toSnapshot().finalValue).toEqual(finalValue);
    expect(modified.plan?.toSnapshot()).toMatchObject({
      mode: "modified",
      originalValue: INITIAL_VALUE,
      suggestedValue: SUGGESTED_VALUE,
      finalValue,
    });

    const rejected = unwrap(
      createExtraction(240).decide({
        kind: "reject",
        decisionId: uuid(246),
        actorId: uuid(247),
        humanConfirmed: true,
        expectedRevision: 1,
        now: "2026-07-27T00:05:00.000Z",
      }),
    );
    expect(rejected.item.status).toBe("rejected");
    expect(rejected.item.toSnapshot().finalValue).toBeNull();
    expect(rejected.plan).toBeNull();
  });

  it("applies a human plan as an append-only version and undoes by compensation", () => {
    const record = createCharacterRecord(300);
    const accepted = unwrap(
      createExtraction(310).decide({
        kind: "accept",
        decisionId: uuid(316),
        actorId: uuid(307),
        humanConfirmed: true,
        expectedRevision: 1,
        expectedRecordRevision: 1,
        now: "2026-07-27T00:01:00.000Z",
      }),
    );
    if (accepted.plan === null) {
      throw new Error("Accepted decision must produce a change plan.");
    }
    const changed = unwrap(record.applyChangePlan(accepted.plan, 1, "2026-07-27T00:01:00.000Z"));
    expect(changed.currentValue).toEqual(SUGGESTED_VALUE);
    expect(changed.toSnapshot().versions).toHaveLength(2);
    expect(changed.toSnapshot().versions[1]).toMatchObject({
      version: 2,
      previousVersion: 1,
      reason: "suggestion_accepted",
      sourceReviewItemId: uuid(311),
    });

    const undone = unwrap(
      changed.undo({
        targetVersion: 1,
        actorId: uuid(308),
        humanConfirmed: true,
        expectedRevision: 2,
        now: "2026-07-27T00:02:00.000Z",
      }),
    );
    expect(undone.currentValue).toEqual(INITIAL_VALUE);
    expect(undone.toSnapshot().versions).toHaveLength(3);
    expect(undone.toSnapshot().versions[2]).toMatchObject({
      version: 3,
      previousVersion: 2,
      restoredFromVersion: 1,
      reason: "undo",
    });
    expect(undone.toSnapshot().versions[1]?.value).toEqual(SUGGESTED_VALUE);
  });
});

describe("atomic review decision use case", () => {
  it("atomically accepts a fresh-source suggestion", async () => {
    const store = new InMemoryReviewDecisionStore();
    const record = createCharacterRecord(400);
    const item = createExtraction(410);
    store.seedRecord(record);
    store.seedItem(item);
    store.setSourceVersion(
      unwrap(parseUuidV7(uuid(414))),
      unwrap(parseUuidV7(uuid(402))),
      unwrap(parseUuidV7(uuid(415))),
    );
    const service = new ReviewDecisionService({
      items: store.items,
      records: store.records,
      sourceVersions: store.sourceVersions,
      transaction: store.transaction,
      clock: new ManualClock("2026-07-27T01:00:00.000Z"),
      ids: new SequenceUuidV7Generator(500),
    });

    const result = unwrap(
      await service.decide({
        kind: "accept",
        itemId: item.id,
        actorId: uuid(407),
        humanConfirmed: true,
        expectedItemRevision: 1,
        expectedRecordRevision: 1,
      }),
    );
    expect(result.item.status).toBe("accepted");
    expect(result.formalRecord?.currentValue).toEqual(SUGGESTED_VALUE);
    expect(store.getItem(item.id)?.status).toBe("accepted");
    expect(store.getRecord(record.id)?.currentValue).toEqual(SUGGESTED_VALUE);
  });

  it("leaves both aggregates unchanged when CAS loses a race", async () => {
    const store = new InMemoryReviewDecisionStore();
    const record = createCharacterRecord(600);
    const item = createExtraction(610);
    store.seedRecord(record);
    store.seedItem(item);
    store.setSourceVersion(
      unwrap(parseUuidV7(uuid(614))),
      unwrap(parseUuidV7(uuid(602))),
      unwrap(parseUuidV7(uuid(615))),
    );
    store.beforeCommit = () => {
      const concurrent = unwrap(
        record.editManually({
          value: { name: "Lin", allegiance: "east" },
          actorId: uuid(608),
          humanConfirmed: true,
          expectedRevision: 1,
          now: "2026-07-27T01:00:30.000Z",
        }),
      );
      store.seedRecord(concurrent);
    };
    const service = new ReviewDecisionService({
      items: store.items,
      records: store.records,
      sourceVersions: store.sourceVersions,
      transaction: store.transaction,
      clock: new ManualClock("2026-07-27T01:00:00.000Z"),
      ids: new SequenceUuidV7Generator(700),
    });

    const result = await service.decide({
      kind: "accept",
      itemId: item.id,
      actorId: uuid(607),
      humanConfirmed: true,
      expectedItemRevision: 1,
      expectedRecordRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_REVISION_CONFLICT");
    }
    expect(store.getItem(item.id)?.status).toBe("pending");
    expect(store.getRecord(record.id)?.currentValue).toEqual({
      name: "Lin",
      allegiance: "east",
    });
  });

  it("does not apply a formal change when the review item wins a concurrent decision", async () => {
    const store = new InMemoryReviewDecisionStore();
    const record = createCharacterRecord(700);
    const item = createExtraction(710);
    store.seedRecord(record);
    store.seedItem(item);
    store.setSourceVersion(
      unwrap(parseUuidV7(uuid(714))),
      unwrap(parseUuidV7(uuid(702))),
      unwrap(parseUuidV7(uuid(715))),
    );
    store.beforeCommit = () => {
      const concurrent = unwrap(
        item.decide({
          kind: "reject",
          decisionId: uuid(716),
          actorId: uuid(708),
          humanConfirmed: true,
          expectedRevision: 1,
          now: "2026-07-27T00:30:00.000Z",
        }),
      );
      store.seedItem(concurrent.item);
    };
    const service = new ReviewDecisionService({
      items: store.items,
      records: store.records,
      sourceVersions: store.sourceVersions,
      transaction: store.transaction,
      clock: new ManualClock("2026-07-27T01:00:00.000Z"),
      ids: new SequenceUuidV7Generator(750),
    });

    const result = await service.decide({
      kind: "accept",
      itemId: item.id,
      actorId: uuid(707),
      humanConfirmed: true,
      expectedItemRevision: 1,
      expectedRecordRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_REVISION_CONFLICT");
    }
    expect(store.getItem(item.id)?.status).toBe("rejected");
    expect(store.getRecord(record.id)?.revision).toBe(1);
  });

  it("rejects acceptance when the cited source version changed", async () => {
    const store = new InMemoryReviewDecisionStore();
    const record = createCharacterRecord(800);
    const item = createExtraction(810);
    store.seedRecord(record);
    store.seedItem(item);
    store.setSourceVersion(
      unwrap(parseUuidV7(uuid(814))),
      unwrap(parseUuidV7(uuid(802))),
      unwrap(parseUuidV7(uuid(899))),
    );
    const service = new ReviewDecisionService({
      items: store.items,
      records: store.records,
      sourceVersions: store.sourceVersions,
      transaction: store.transaction,
      clock: new ManualClock("2026-07-27T01:00:00.000Z"),
      ids: new SequenceUuidV7Generator(900),
    });

    const result = await service.decide({
      kind: "accept",
      itemId: item.id,
      actorId: uuid(807),
      humanConfirmed: true,
      expectedItemRevision: 1,
      expectedRecordRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REVIEW_SOURCE_CHANGED");
    }
    expect(store.getItem(item.id)?.status).toBe("pending");
    expect(store.getRecord(record.id)?.revision).toBe(1);
  });

  it("rechecks source ownership and version inside the atomic commit", async () => {
    const store = new InMemoryReviewDecisionStore();
    const record = createCharacterRecord(1_000);
    const item = createExtraction(1_010);
    const chapterId = unwrap(parseUuidV7(uuid(1_014)));
    const projectId = unwrap(parseUuidV7(uuid(1_002)));
    store.seedRecord(record);
    store.seedItem(item);
    store.setSourceVersion(chapterId, projectId, unwrap(parseUuidV7(uuid(1_015))));
    store.beforeCommit = () => {
      store.setSourceVersion(chapterId, projectId, unwrap(parseUuidV7(uuid(1_099))));
    };
    const service = new ReviewDecisionService({
      items: store.items,
      records: store.records,
      sourceVersions: store.sourceVersions,
      transaction: store.transaction,
      clock: new ManualClock("2026-07-27T01:00:00.000Z"),
      ids: new SequenceUuidV7Generator(1_100),
    });

    const result = await service.decide({
      kind: "accept",
      itemId: item.id,
      actorId: uuid(1_007),
      humanConfirmed: true,
      expectedItemRevision: 1,
      expectedRecordRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REVIEW_SOURCE_CHANGED");
    }
    expect(store.getItem(item.id)?.status).toBe("pending");
    expect(store.getRecord(record.id)?.revision).toBe(1);
  });

  it("rejects evidence from a chapter owned by another project", async () => {
    const store = new InMemoryReviewDecisionStore();
    const record = createCharacterRecord(1_200);
    const item = createExtraction(1_210);
    store.seedRecord(record);
    store.seedItem(item);
    store.setSourceVersion(
      unwrap(parseUuidV7(uuid(1_214))),
      unwrap(parseUuidV7(uuid(1_299))),
      unwrap(parseUuidV7(uuid(1_215))),
    );
    const service = new ReviewDecisionService({
      items: store.items,
      records: store.records,
      sourceVersions: store.sourceVersions,
      transaction: store.transaction,
      clock: new ManualClock("2026-07-27T01:00:00.000Z"),
      ids: new SequenceUuidV7Generator(1_300),
    });

    const result = await service.decide({
      kind: "accept",
      itemId: item.id,
      actorId: uuid(1_207),
      humanConfirmed: true,
      expectedItemRevision: 1,
      expectedRecordRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REVIEW_SOURCE_CHANGED");
      expect(result.error.details.actualProjectId).toBe(uuid(1_299));
    }
    expect(store.getItem(item.id)?.status).toBe("pending");
    expect(store.getRecord(record.id)?.revision).toBe(1);
  });
});

function createCharacterRecord(base: number): FormalStoryRecord {
  return unwrap(
    FormalStoryRecord.create({
      id: uuid(base + 1),
      projectId: uuid(base + 2),
      kind: "character",
      recordKey: "character.lin",
      value: INITIAL_VALUE,
      actorId: uuid(base + 7),
      humanConfirmed: true,
      now: "2026-07-27T00:00:00.000Z",
    }),
  );
}

function reviewInput(base: number): CreateStructuredReviewItemInput {
  return {
    id: uuid(base + 1),
    projectId: uuid(base - 8),
    category: "character.allegiance",
    severity: "warning",
    targetRecordId: uuid(base + 1 - 10),
    targetRecordKind: "character",
    sourceChapterId: uuid(base + 4),
    sourceVersionId: uuid(base + 5),
    evidence: {
      excerpt: "south",
      start: 20,
      end: 25,
      sourceLength: 300,
    },
    confidence: 0.82,
    originalValue: INITIAL_VALUE,
    suggestedValue: SUGGESTED_VALUE,
    now: "2026-07-27T00:00:00.000Z",
  };
}

function createExtraction(base: number): ExtractionSuggestion {
  return unwrap(ExtractionSuggestion.create(reviewInput(base)));
}

function createConsistency(base: number): ConsistencyIssue {
  return unwrap(ConsistencyIssue.create(reviewInput(base)));
}
