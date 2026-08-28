import { StoryFact, parseIsoUtcTimestamp, parseUuidV7 } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BrowserDevelopmentStoryFactStore,
  DEVELOPMENT_STORY_FACT_STORE_KEY,
} from "./story-fact-store";
import { DEVELOPMENT_DATABASE_KEY } from "./development-storage";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const OTHER_PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000099";
const FACT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const ACTOR_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-01T00:01:00.000Z";
const T2 = "2026-08-01T00:02:00.000Z";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const CHAPTER_CONTENT = "门被打开。随后门被锁上。";

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

  it("allows only a direct-local review draft to become an author revision", async () => {
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const direct = createDirectLocalStagedFact(40);
    expect((await store.create(direct)).ok).toBe(true);
    const edited = unwrap(
      direct.editStagedAsUser({
        contentText: "周望担任钟楼管理员。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: direct.revision,
        now: T1,
      }),
    );

    expect((await store.save(edited, direct.revision)).ok).toBe(true);
    const revisions = unwrap(await store.listRevisions(direct.id));
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.fact.toSnapshot()).toMatchObject({
      structuredValue: direct.toSnapshot().structuredValue,
      source: direct.toSnapshot().source,
      status: "unconfirmed",
    });
    expect(revisions[1]?.fact.toSnapshot()).toMatchObject({
      contentText: "周望担任钟楼管理员。",
      structuredValue: null,
      source: direct.toSnapshot().source,
      status: "formal",
      origin: "user",
    });

    const nonLocal = createDirectLocalStagedFact(41, "chapter:ordinary-local-parser");
    expect((await store.create(nonLocal)).ok).toBe(true);
    const nonLocalSnapshot = nonLocal.toSnapshot();
    const confirmedAt = unwrap(parseIsoUtcTimestamp(T1));
    const forgedNonLocal = unwrap(
      StoryFact.rehydrate({
        ...nonLocalSnapshot,
        contentText: "绕过来源白名单。",
        structuredValue: null,
        confidence: 1,
        status: "formal",
        origin: "user",
        userConfirmed: true,
        needsReview: false,
        confirmedByActorId: unwrap(parseUuidV7(ACTOR_ID)),
        confirmedAt,
        revision: nonLocalSnapshot.revision + 1,
        updatedAt: confirmedAt,
      }),
    );
    expect((await store.save(forgedNonLocal, nonLocal.revision)).ok).toBe(false);

    const evidenceTarget = createDirectLocalStagedFact(42);
    expect((await store.create(evidenceTarget)).ok).toBe(true);
    const evidenceSnapshot = evidenceTarget.toSnapshot();
    const forgedEvidence = unwrap(
      StoryFact.rehydrate({
        ...evidenceSnapshot,
        contentText: "绕过证据不可变边界。",
        structuredValue: null,
        source: {
          ...evidenceSnapshot.source,
          reference: "direct-local:inkshadow.direct-local-story-fact.v1:forged-evidence",
        },
        confidence: 1,
        status: "formal",
        origin: "user",
        userConfirmed: true,
        needsReview: false,
        confirmedByActorId: unwrap(parseUuidV7(ACTOR_ID)),
        confirmedAt,
        revision: evidenceSnapshot.revision + 1,
        updatedAt: confirmedAt,
      }),
    );
    expect((await store.save(forgedEvidence, evidenceTarget.revision)).ok).toBe(false);
    expect(unwrap(await store.listRevisions(nonLocal.id))).toHaveLength(1);
    expect(unwrap(await store.listRevisions(evidenceTarget.id))).toHaveLength(1);
  });

  it("keeps user edit, restore, and duplicate merge revisions across reopening", async () => {
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const original = createFormalFact(20, "灯塔每夜只亮一次。");
    expect((await store.create(original)).ok).toBe(true);
    const edited = unwrap(
      original.editAsUser({
        contentText: "灯塔每夜只亮两次。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await store.save(edited, 1)).ok).toBe(true);
    const deleted = unwrap(
      edited.deprecate({ humanConfirmed: true, expectedRevision: 2, now: T2 }),
    );
    expect((await store.save(deleted, 2)).ok).toBe(true);
    const firstRevision = unwrap(await store.listRevisions(original.id))[0];
    if (firstRevision === undefined) throw new Error("expected initial story fact revision");
    const restored = unwrap(
      deleted.restoreAsUser({
        priorRevision: firstRevision.fact,
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 3,
        now: "2026-08-01T00:03:00.000Z",
      }),
    );
    expect((await store.save(restored, 3)).ok).toBe(true);

    const duplicate = createFormalFact(21, "灯塔每夜只亮一次。");
    expect((await store.create(duplicate)).ok).toBe(true);
    const survivorNext = unwrap(
      restored.recordDuplicateMergeAsUser({
        duplicate,
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 4,
        now: "2026-08-01T00:04:00.000Z",
      }),
    );
    const duplicateNext = unwrap(
      duplicate.deprecate({
        humanConfirmed: true,
        expectedRevision: 1,
        now: "2026-08-01T00:04:00.000Z",
      }),
    );
    expect((await store.mergeUserFactRevisions(survivorNext, 4, duplicateNext, 1)).ok).toBe(true);

    const reopened = new BrowserDevelopmentStoryFactStore(localStorage);
    expect(unwrap(await reopened.findById(original.id))?.toSnapshot()).toMatchObject({
      contentText: "灯塔每夜只亮一次。",
      status: "formal",
      revision: 5,
    });
    expect(unwrap(await reopened.findById(duplicate.id))?.toSnapshot()).toMatchObject({
      status: "deprecated",
      revision: 2,
    });
    expect(unwrap(await reopened.listRevisions(original.id))).toHaveLength(5);
    expect(unwrap(await reopened.listRevisions(duplicate.id))).toHaveLength(2);

    const third = createFormalFact(22, "潮门在黎明关闭。");
    const fourth = createFormalFact(23, "潮门在黎明关闭。");
    expect((await reopened.create(third)).ok).toBe(true);
    expect((await reopened.create(fourth)).ok).toBe(true);
    const thirdNext = unwrap(
      third.recordDuplicateMergeAsUser({
        duplicate: fourth,
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
        now: "2026-08-01T00:05:00.000Z",
      }),
    );
    const fourthNext = unwrap(
      fourth.deprecate({
        humanConfirmed: true,
        expectedRevision: 1,
        now: "2026-08-01T00:05:00.000Z",
      }),
    );
    const conflict = await reopened.mergeUserFactRevisions(thirdNext, 1, fourthNext, 2);
    expect(conflict.ok).toBe(false);
    expect(unwrap(await reopened.findById(third.id))?.revision).toBe(1);
    expect(unwrap(await reopened.findById(fourth.id))?.revision).toBe(1);
  });
  it("rejects structured text edits and merges while preserving deletion recovery", async () => {
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const first = createStructuredFormalFact(24, "event.silver-bell");
    const second = createStructuredFormalFact(25, "event.moonset");
    expect((await store.create(first)).ok).toBe(true);
    expect((await store.create(second)).ok).toBe(true);

    expect(
      first.editAsUser({
        contentText: "把因果事件误改成普通文字。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "STORY_FACT_INVALID_TRANSITION" },
    });
    expect(
      first.recordDuplicateMergeAsUser({
        duplicate: second,
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "STORY_VALIDATION_FAILED" },
    });

    const forgedSurvivor = unwrap(
      first.deprecate({ humanConfirmed: true, expectedRevision: 1, now: T1 }),
    );
    const forgedTimestamp = forgedSurvivor.toSnapshot().updatedAt;
    const forgedTextEdit = unwrap(
      StoryFact.rehydrate({
        ...first.toSnapshot(),
        contentText: "绕过领域层误改结构化事件。",
        confirmedAt: forgedTimestamp,
        revision: 2,
        updatedAt: forgedTimestamp,
      }),
    );
    expect((await store.save(forgedTextEdit, 1)).ok).toBe(false);
    expect(unwrap(await store.listRevisions(first.id))).toHaveLength(1);

    const unknownDraft = createUnknownStructuredDraft(26);
    expect((await store.create(unknownDraft)).ok).toBe(true);
    const unknownSnapshot = unknownDraft.toSnapshot();
    const confirmedActor = unwrap(parseUuidV7(ACTOR_ID));
    const forgedUnknownDraftEdit = unwrap(
      StoryFact.rehydrate({
        ...unknownSnapshot,
        contentText: "林深是望潮崖守潮人。",
        confidence: 1,
        status: "formal",
        origin: "user",
        userConfirmed: true,
        needsReview: false,
        confirmedByActorId: confirmedActor,
        confirmedAt: forgedTimestamp,
        revision: unknownSnapshot.revision + 1,
        updatedAt: forgedTimestamp,
      }),
    );
    expect((await store.save(forgedUnknownDraftEdit, unknownDraft.revision)).ok).toBe(false);
    expect(unwrap(await store.listRevisions(unknownDraft.id))).toHaveLength(1);

    const secondDeleted = unwrap(
      second.deprecate({ humanConfirmed: true, expectedRevision: 1, now: T1 }),
    );
    expect((await store.mergeUserFactRevisions(forgedSurvivor, 1, secondDeleted, 1)).ok).toBe(
      false,
    );
    expect(unwrap(await store.listRevisions(first.id))).toHaveLength(1);
    expect(unwrap(await store.listRevisions(second.id))).toHaveLength(1);

    const firstDeleted = unwrap(
      first.deprecate({ humanConfirmed: true, expectedRevision: 1, now: T1 }),
    );
    expect((await store.save(firstDeleted, 1)).ok).toBe(true);
    expect(
      firstDeleted.restoreAsUser({
        priorRevision: first,
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 2,
        now: T2,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "STORY_FACT_INVALID_TRANSITION" },
    });
    const restored = unwrap(
      firstDeleted.restoreDeletedAsUser({
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 2,
        now: T2,
      }),
    );
    expect((await store.save(restored, 2)).ok).toBe(true);
    const reopened = new BrowserDevelopmentStoryFactStore(localStorage);
    expect(unwrap(await reopened.findById(first.id))?.toSnapshot()).toEqual(restored.toSnapshot());
    expect(unwrap(await reopened.listRevisions(first.id))).toHaveLength(3);
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

  it("reuses normalized pending local evidence even when an internal reference changes", async () => {
    const evidence = "周望是钟楼的管理员。";
    seedDevelopmentChapter(evidence);
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const original = createDirectLocalStagedFact(43);
    const retry = createDirectLocalStagedFact(
      44,
      "direct-local:inkshadow.direct-local-story-fact.v1:test:retry",
      `  ${evidence}  `,
    );
    const fence = { chapterId: CHAPTER_ID, expectedCurrentVersionId: VERSION_ID } as const;

    expect(unwrap(await store.createWithAuthorityFence(original, fence)).created).toBe(true);
    const reused = unwrap(await store.createWithAuthorityFence(retry, fence));
    expect(reused).toMatchObject({ created: false, fact: { id: original.id } });
    expect(unwrap(await store.listByProjectId(unwrap(parseUuidV7(PROJECT_ID))))).toHaveLength(1);

    const distinctContent = createDirectLocalStagedFact(
      45,
      "direct-local:inkshadow.direct-local-story-fact.v1:test:distinct",
      "周望负责钟楼的日常维护。",
    );
    expect(unwrap(await store.createWithAuthorityFence(distinctContent, fence))).toMatchObject({
      created: true,
      fact: { id: distinctContent.id },
    });
    expect(unwrap(await store.listByProjectId(unwrap(parseUuidV7(PROJECT_ID))))).toHaveLength(2);
  });

  it("binds the browser authority fence to the exact source and recovers an identical retry", async () => {
    seedDevelopmentChapter();
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const original = createCausalFact(6, "门被打开。", {
      schemaVersion: "inkshadow.causal-event-fact.v2",
      eventText: "门被打开",
      resultText: "通道开放",
      narrativeTime: { order: 10, label: "先前" },
      location: { locationId: "door", label: "门口" },
      participantCharacterIds: [],
      informedCharacterIds: [],
      knowledgeGains: [],
      prerequisites: [],
      characterStateChanges: [],
      relationshipChanges: [],
      itemChanges: [],
      foreshadowProgress: [],
    });
    const exactFence = { chapterId: CHAPTER_ID, expectedCurrentVersionId: VERSION_ID } as const;
    expect(unwrap(await store.createWithAuthorityFence(original, exactFence)).created).toBe(true);
    const retry = createCausalFact(7, "门被打开。", original.toSnapshot().structuredValue);
    const recovered = unwrap(await store.createWithAuthorityFence(retry, exactFence));
    expect(recovered).toMatchObject({ created: false });
    expect(recovered.fact.id).toBe(original.id);

    const unrelatedFence = await store.createWithAuthorityFence(
      createCausalFact(8, "随后门被锁上。", {
        ...(original.toSnapshot().structuredValue as Readonly<Record<string, unknown>>),
        eventText: "门被锁上",
        narrativeTime: { order: 20, label: "随后" },
      }),
      {
        chapterId: "019f9f4a-b3c7-7350-9226-000000000099",
        expectedCurrentVersionId: VERSION_ID,
      },
    );
    expect(unrelatedFence.ok).toBe(false);
    if (!unrelatedFence.ok) {
      expect(unrelatedFence.error.code).toBe("STORY_FACT_SOURCE_FENCE_FAILED");
    }

    const disguisedEvent = await store.createWithAuthorityFence(
      createCausalFact(
        12,
        "随后门被锁上。",
        original.toSnapshot().structuredValue,
        "world_property",
      ),
      exactFence,
    );
    expect(disguisedEvent.ok).toBe(false);
    if (!disguisedEvent.ok) expect(disguisedEvent.error.code).toBe("STORY_VALIDATION_FAILED");

    const serialized = localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
    if (serialized === null) throw new Error("expected development chapter database");
    const database = JSON.parse(serialized) as { versions: { id: string; content: string }[] };
    const version = database.versions.find(({ id }) => id === VERSION_ID);
    if (version === undefined) throw new Error("expected development chapter version");
    version.content = "被篡改的版本正文";
    localStorage.setItem(DEVELOPMENT_DATABASE_KEY, JSON.stringify(database));
    const changedEvidence = await store.createWithAuthorityFence(
      createCausalFact(9, "随后门被锁上。", {
        ...(original.toSnapshot().structuredValue as Readonly<Record<string, unknown>>),
        eventText: "门被锁上",
        narrativeTime: { order: 20, label: "随后" },
      }),
      exactFence,
    );
    expect(changedEvidence.ok).toBe(false);
    if (!changedEvidence.ok) expect(changedEvidence.error.code).toBe("REVIEW_SOURCE_CHANGED");
  });

  it("rejects causal endpoint and character fences that do not exactly match the fact", async () => {
    seedDevelopmentChapter();
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const event = createCausalFact(10, "门被打开。", {
      schemaVersion: "inkshadow.causal-event-fact.v2",
      eventText: "门被打开",
      resultText: "通道开放",
      narrativeTime: { order: 10, label: "先前" },
      location: { locationId: "door", label: "门口" },
      participantCharacterIds: ["character-linxia"],
      informedCharacterIds: [],
      knowledgeGains: [],
      prerequisites: [],
      characterStateChanges: [],
      relationshipChanges: [],
      itemChanges: [],
      foreshadowProgress: [],
    });
    const omittedCharacter = await store.createWithAuthorityFence(event, {
      chapterId: CHAPTER_ID,
      expectedCurrentVersionId: VERSION_ID,
    });
    expect(omittedCharacter.ok).toBe(false);
    if (!omittedCharacter.ok) {
      expect(omittedCharacter.error.code).toBe("STORY_FACT_CHARACTER_AUTHORITY_INVALID");
    }

    const relation = createCausalFact(
      11,
      CHAPTER_CONTENT,
      {
        schemaVersion: "inkshadow.causal-relation-fact.v1",
        fromEventId: "event-a",
        toEventId: "event-missing",
        kind: "causes",
      },
      "causal_relation",
    );
    const mismatchedEndpoints = await store.createWithAuthorityFence(relation, {
      chapterId: CHAPTER_ID,
      expectedCurrentVersionId: VERSION_ID,
      requiredCausalEventIds: ["event-a", "event-b"],
    });
    expect(mismatchedEndpoints.ok).toBe(false);
    if (!mismatchedEndpoints.ok) {
      expect(mismatchedEndpoints.error.code).toBe("STORY_FACT_RELATION_ENDPOINT_INVALID");
    }

    expect((await store.create(createCharacterFact(20, "character-linxia"))).ok).toBe(true);
    expect((await store.create(createCharacterFact(21, "character-linxia"))).ok).toBe(true);
    const duplicatedCharacter = await store.createWithAuthorityFence(event, {
      chapterId: CHAPTER_ID,
      expectedCurrentVersionId: VERSION_ID,
      requiredCharacterIds: ["character-linxia"],
    });
    expect(duplicatedCharacter.ok).toBe(false);
    if (!duplicatedCharacter.ok) {
      expect(duplicatedCharacter.error.code).toBe("STORY_FACT_CHARACTER_AUTHORITY_INVALID");
    }
  });

  it("atomically undoes a supplemental disposition and recovers the same retry", async () => {
    seedDevelopmentChapter();
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const resolution = createSupplementalResolutionFact(30);
    expect(
      unwrap(
        await store.createWithAuthorityFence(resolution, {
          chapterId: CHAPTER_ID,
          expectedCurrentVersionId: VERSION_ID,
        }),
      ).created,
    ).toBe(true);
    const fence = {
      expectedProjectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      expectedCurrentVersionId: VERSION_ID,
      findingId: "voice:browser-test",
      evidenceSignature: `v2:${VERSION_ID}:${"a".repeat(64)}:0-5`,
      expectedRevision: 1,
      now: T2,
    } as const;

    const first = unwrap(
      await store.deprecateSupplementalResolutionWithAuthorityFence(resolution.id, fence),
    );
    expect(first).toMatchObject({ deprecated: true, fact: { revision: 2 } });
    const retry = unwrap(
      await store.deprecateSupplementalResolutionWithAuthorityFence(resolution.id, fence),
    );
    expect(retry).toMatchObject({ deprecated: false, fact: { revision: 2 } });
    expect(unwrap(await store.listRevisions(resolution.id))).toHaveLength(2);
  });

  it("fails supplemental undo closed on identity mismatch or a switched chapter version", async () => {
    seedDevelopmentChapter();
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const resolution = createSupplementalResolutionFact(31);
    unwrap(
      await store.createWithAuthorityFence(resolution, {
        chapterId: CHAPTER_ID,
        expectedCurrentVersionId: VERSION_ID,
      }),
    );
    const baseFence = {
      expectedProjectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      expectedCurrentVersionId: VERSION_ID,
      findingId: "voice:browser-test",
      evidenceSignature: `v2:${VERSION_ID}:${"a".repeat(64)}:0-5`,
      expectedRevision: 1,
      now: T2,
    } as const;
    const mismatched = await store.deprecateSupplementalResolutionWithAuthorityFence(
      resolution.id,
      { ...baseFence, findingId: "voice:forged" },
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.code).toBe("STORY_VALIDATION_FAILED");

    const crossProject = await store.deprecateSupplementalResolutionWithAuthorityFence(
      resolution.id,
      { ...baseFence, expectedProjectId: OTHER_PROJECT_ID },
    );
    expect(crossProject.ok).toBe(false);
    if (!crossProject.ok) expect(crossProject.error.code).toBe("STORY_VALIDATION_FAILED");
    expect(unwrap(await store.findById(resolution.id))?.toSnapshot()).toMatchObject({
      status: "formal",
      deprecated: false,
      revision: 1,
    });
    expect(unwrap(await store.listRevisions(resolution.id))).toHaveLength(1);

    const serialized = localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
    if (serialized === null) throw new Error("expected development chapter database");
    const database = JSON.parse(serialized) as {
      chapters: { id: string; currentVersionId: string }[];
    };
    const chapter = database.chapters.find(({ id }) => id === CHAPTER_ID);
    if (chapter === undefined) throw new Error("expected development chapter");
    chapter.currentVersionId = "019f9f4a-b3c7-7350-9226-000000000099";
    localStorage.setItem(DEVELOPMENT_DATABASE_KEY, JSON.stringify(database));
    const switched = await store.deprecateSupplementalResolutionWithAuthorityFence(
      resolution.id,
      baseFence,
    );
    expect(switched.ok).toBe(false);
    if (!switched.ok) expect(switched.error.code).toBe("STORY_FACT_SOURCE_FENCE_FAILED");
    expect(unwrap(await store.findById(resolution.id))?.toSnapshot()).toMatchObject({
      status: "formal",
      deprecated: false,
      revision: 1,
    });
  });

  it("persists a bounded unique entity-alias resolution with revision history", async () => {
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const original = createAmbiguousAliasFact();
    expect((await store.create(original)).ok).toBe(true);

    const resolved = unwrap(
      original.resolveEntityAlias({
        resolution: { kind: "existing_entity", targetEntityKey: "character.linzhou.b" },
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await store.save(resolved, 1)).ok).toBe(true);
    expect(unwrap(await store.findById(original.id))?.toSnapshot()).toMatchObject({
      revision: 2,
      structuredValue: {
        subject: {
          entityKey: "character.linzhou.b",
          mergeStatus: "human_resolved_existing_entity",
          matchedEntityKeys: ["character.linzhou.b"],
        },
      },
    });
    expect(
      unwrap(await store.listRevisions(original.id)).map(({ changeKind }) => changeKind),
    ).toEqual(["created", "governance_updated"]);
  });

  it.each([
    ["empty matches", []],
    ["too many matches", Array.from({ length: 65 }, (_, index) => `character.${String(index)}`)],
    ["duplicate matches", ["character.same", "character.same"]],
    ["overlong match", ["x".repeat(201)]],
  ])("fails closed when persisted alias data has %s", async (_label, matchedEntityKeys) => {
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const original = createAmbiguousAliasFact();
    expect((await store.create(original)).ok).toBe(true);
    corruptPersistedAlias((subject) => {
      subject.matchedEntityKeys = matchedEntityKeys;
    });

    const result = await store.findById(original.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "STORY_REPOSITORY_ERROR",
        message: "Stored unified story facts failed integrity validation.",
      });
    }
  });

  it("fails closed when persisted alias data contains a prohibited structure key", async () => {
    const store = new BrowserDevelopmentStoryFactStore(localStorage);
    const original = createAmbiguousAliasFact();
    expect((await store.create(original)).ok).toBe(true);
    corruptPersistedAlias((subject) => {
      Object.defineProperty(subject, "constructor", {
        value: { polluted: true },
        configurable: true,
        enumerable: true,
        writable: true,
      });
    });

    const result = await store.findById(original.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_REPOSITORY_ERROR");
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

function createDirectLocalStagedFact(
  suffix: number,
  reference = "direct-local:inkshadow.direct-local-story-fact.v1:test",
  contentText = "周望是钟楼的管理员。",
): StoryFact {
  const excerpt = "周望是钟楼的管理员。";
  return unwrap(
    StoryFact.create({
      id: "019f9f4a-b3c7-7350-9226-" + String(suffix).padStart(12, "0"),
      projectId: PROJECT_ID,
      factType: "character_profile",
      contentText,
      structuredValue: {
        schemaVersion: "inkshadow.rebuildable-system-fact.v1",
        payload: { schemaVersion: "inkshadow.direct-local-story-fact.v1" },
      },
      source: {
        kind: "chapter_span",
        reference,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        startOffset: 0,
        endOffset: excerpt.length,
        sourceLength: excerpt.length,
        excerpt,
      },
      confidence: 1,
      status: "unconfirmed",
      origin: "system",
      needsReview: true,
      humanConfirmed: false,
      now: T0,
    }),
  );
}

function createStructuredFormalFact(suffix: number, eventId: string): StoryFact {
  return unwrap(
    StoryFact.create({
      id: "019f9f4a-b3c7-7350-9226-" + String(suffix).padStart(12, "0"),
      projectId: PROJECT_ID,
      factType: "timeline_event",
      contentText: "银铃响起，潮门打开。",
      structuredValue: {
        schemaVersion: "inkshadow.causal-event-fact.v2",
        eventId,
        causeEventIds: [eventId + ".cause"],
      },
      source: {
        kind: "user_statement",
        reference: "user-statement:" + ACTOR_ID + ":" + String(suffix),
      },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: T0,
    }),
  );
}

function createUnknownStructuredDraft(suffix: number): StoryFact {
  return unwrap(
    StoryFact.create({
      id: "019f9f4a-b3c7-7350-9226-" + String(suffix).padStart(12, "0"),
      projectId: PROJECT_ID,
      factType: "character_identity",
      contentText: "林深是守潮人。",
      structuredValue: {
        schemaVersion: "inkshadow.semantic-character-profile.v1",
        identity: { name: "林深", role: "守潮人" },
      },
      source: {
        kind: "user_statement",
        reference: "user-statement:draft:" + ACTOR_ID + ":" + String(suffix),
      },
      confidence: 1,
      status: "unconfirmed",
      origin: "user",
      needsReview: true,
      humanConfirmed: false,
      now: T0,
    }),
  );
}

function createFormalFact(suffix: number, contentText: string): StoryFact {
  return unwrap(
    StoryFact.create({
      id: "019f9f4a-b3c7-7350-9226-" + String(suffix).padStart(12, "0"),
      projectId: PROJECT_ID,
      factType: "world_rule",
      contentText,
      source: {
        kind: "user_statement",
        reference: "user-statement:" + ACTOR_ID + ":" + String(suffix),
      },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: T0,
    }),
  );
}
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

function createAmbiguousAliasFact(): StoryFact {
  return unwrap(
    StoryFact.create({
      id: FACT_ID,
      projectId: PROJECT_ID,
      factType: "character_state",
      contentText: "林舟回到了旧宅。",
      structuredValue: {
        subject: {
          entityKey: "character.linzhou.distinct",
          displayName: "林舟",
          mergeStatus: "ambiguous_confirmed_alias",
          matchedEntityKeys: ["character.linzhou.a", "character.linzhou.b"],
        },
        attributeKey: "location",
        valueText: "旧宅",
      },
      source: {
        kind: "system_derivation",
        reference: "extraction-job:browser-alias-test",
      },
      confidence: 0.8,
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
      humanConfirmed: false,
      now: T0,
    }),
  );
}

function createCharacterFact(suffix: number, entityKey: string): StoryFact {
  return unwrap(
    StoryFact.create({
      id: `019f9f4a-b3c7-7350-9226-${String(suffix).padStart(12, "0")}`,
      projectId: PROJECT_ID,
      factType: "character_identity",
      contentText: "已确认人物",
      structuredValue: {
        subject: { kind: "character", entityKey, canonicalName: "林夏" },
      },
      source: { kind: "user_statement", reference: `character:${String(suffix)}` },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: T0,
    }),
  );
}

function createSupplementalResolutionFact(suffix: number): StoryFact {
  return unwrap(
    StoryFact.create({
      id: `019f9f4a-b3c7-7350-9226-${String(suffix).padStart(12, "0")}`,
      projectId: PROJECT_ID,
      factType: "validation_resolution",
      contentText: "用户忽略检查提醒",
      structuredValue: {
        resolutionSchema: "inkshadow.chapter-supplemental-finding-resolution.v1",
        resolutionAction: "ignore",
        resolvedFindingId: "voice:browser-test",
        resolvedFindingCategory: "character_voice",
        resolvedChapterId: CHAPTER_ID,
        resolvedChapterVersionId: VERSION_ID,
        evidenceSignature: `v2:${VERSION_ID}:${"a".repeat(64)}:0-5`,
      },
      source: {
        kind: "review_decision",
        reference: `chapter-supplemental-finding:${CHAPTER_ID}:${VERSION_ID}:voice:browser-test`,
      },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: T0,
    }),
  );
}

function seedDevelopmentChapter(content = CHAPTER_CONTENT): void {
  localStorage.setItem(
    DEVELOPMENT_DATABASE_KEY,
    JSON.stringify({
      schemaVersion: 2,
      projects: [],
      chapters: [
        {
          id: CHAPTER_ID,
          projectId: PROJECT_ID,
          status: "active",
          currentVersionId: VERSION_ID,
        },
      ],
      versions: [
        {
          id: VERSION_ID,
          projectId: PROJECT_ID,
          chapterId: CHAPTER_ID,
          content,
        },
      ],
      drafts: [],
      candidates: [],
      auditEvents: [],
    }),
  );
}

function createCausalFact(
  suffix: number,
  excerpt: string,
  structuredValue: unknown,
  factType = "causal_event",
): StoryFact {
  const startOffset = CHAPTER_CONTENT.indexOf(excerpt);
  return unwrap(
    StoryFact.create({
      id: `019f9f4a-b3c7-7350-9226-${String(suffix).padStart(12, "0")}`,
      projectId: PROJECT_ID,
      factType,
      contentText: "causal fact",
      structuredValue,
      source: {
        kind: "chapter_span",
        reference: `chapter:${CHAPTER_ID}:version:${VERSION_ID}:utf16:${String(startOffset)}-${String(startOffset + excerpt.length)}`,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        startOffset,
        endOffset: startOffset + excerpt.length,
        sourceLength: CHAPTER_CONTENT.length,
        excerpt,
      },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: T0,
    }),
  );
}

function corruptPersistedAlias(mutate: (subject: Record<string, unknown>) => void): void {
  const serialized = localStorage.getItem(DEVELOPMENT_STORY_FACT_STORE_KEY);
  if (serialized === null) {
    throw new Error("expected persisted story fact database");
  }
  const database = JSON.parse(serialized) as {
    facts: Record<string, { structuredValue: { subject: Record<string, unknown> } }>;
    revisions: Record<
      string,
      { snapshot: { structuredValue: { subject: Record<string, unknown> } } }[]
    >;
  };
  const fact = database.facts[FACT_ID];
  const revision = database.revisions[FACT_ID]?.[0];
  if (fact === undefined || revision === undefined) {
    throw new Error("expected persisted alias fact and revision");
  }
  mutate(fact.structuredValue.subject);
  revision.snapshot = structuredClone(fact);
  localStorage.setItem(DEVELOPMENT_STORY_FACT_STORE_KEY, JSON.stringify(database));
}

function unwrap<Value>(result: { ok: true; value: Value } | { ok: false; error: unknown }): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}
