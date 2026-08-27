import type { ChapterRepository, ChapterVersionRepository } from "@inkshadow/application";
import {
  Chapter,
  ChapterVersion,
  ok as domainOk,
  parseIsoUtcTimestamp,
  parseUuidV7 as parseDomainUuid,
  type UuidV7 as DomainUuidV7,
} from "@inkshadow/domain";
import { CryptoContentHasher, CryptoUuidV7Generator, SystemClock } from "@inkshadow/platform";
import {
  StoryFactApplicationService,
  parseUuidV7 as parseStoryUuid,
  type StoryValue,
} from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import { BrowserDevelopmentStoryFactStore } from "./story-fact-store";
import { DEVELOPMENT_DATABASE_KEY } from "./development-atomic-journal";
import {
  CONTINUOUS_STORY_STATE_EXPLICIT_CLOUD_AUTHORIZATION_REQUIRED,
  ContinuousStoryStateExtractionService,
  ContinuousStoryStateModelUnavailableError,
  shouldRunContinuousStoryStateExtraction,
  type ContinuousStoryStateModelCandidate,
  type ContinuousStoryStateModelInput,
  type ContinuousStoryStateModelOutput,
  type ContinuousStoryStateModelPort,
} from "./continuous-story-state-extraction";
import { ProjectContextPrivacyAuthority } from "./project-context-privacy-authority";

const ids = {
  project: uuid(1),
  chapter1: uuid(2),
  chapter2: uuid(3),
  version1: uuid(4),
  version2: uuid(5),
  version3: uuid(6),
  actor: uuid(7),
  entity1: uuid(8),
  entity2: uuid(9),
  entity3: uuid(10),
};

describe("ContinuousStoryStateExtractionService", () => {
  it("keeps save and direct extraction closed even when a legacy preference is enabled", async () => {
    expect(shouldRunContinuousStoryStateExtraction("autosave", true)).toBe(false);
    expect(shouldRunContinuousStoryStateExtraction("manual", false)).toBe(false);
    expect(shouldRunContinuousStoryStateExtraction("manual", true)).toBe(false);
    const harness = await createHarness([]);

    expect(
      await harness.service.extractAfterSave({
        projectId: ids.project,
        chapterId: ids.chapter1,
        versionId: ids.version1,
        reason: "manual",
      }),
    ).toBeNull();
    expect(harness.model.callCount).toBe(0);

    harness.service.setAutomaticOnManualSaveEnabled(ids.project, true);
    expect(harness.service.isAutomaticOnManualSaveEnabled(ids.project)).toBe(false);
    expect(
      await harness.service.extractAfterSave({
        projectId: ids.project,
        chapterId: ids.chapter1,
        versionId: ids.version1,
        reason: "manual",
      }),
    ).toBeNull();
    expect(harness.model.callCount).toBe(0);

    expect(
      await harness.service.extractAfterSave({
        projectId: ids.project,
        chapterId: ids.chapter1,
        versionId: ids.version1,
        reason: "autosave",
      }),
    ).toBeNull();
    expect(harness.model.callCount).toBe(0);

    await expect(
      harness.productionService.extractSavedVersion({
        projectId: ids.project,
        chapterId: ids.chapter1,
        versionId: ids.version1,
        force: true,
      }),
    ).resolves.toMatchObject({
      status: "skipped",
      providerInvocations: [],
      detectedCount: 0,
      skippedTasks: [
        {
          task: "character_extraction",
          code: CONTINUOUS_STORY_STATE_EXPLICIT_CLOUD_AUTHORIZATION_REQUIRED,
        },
        {
          task: "world_extraction",
          code: CONTINUOUS_STORY_STATE_EXPLICIT_CLOUD_AUTHORIZATION_REQUIRED,
        },
      ],
    });
    expect(harness.model.callCount).toBe(0);
  });

  it("stages exact saved-version candidates without silently making them formal", async () => {
    const harness = await createHarness([
      modelCandidate({
        factType: "pov_knowledge",
        contentText: "林夏已经知道门后的钟会倒着走。",
        state: {
          knowledgeStatus: "known",
          information: "门后的钟会倒着走",
          acquiredAt: "第一章雨夜",
          informationSource: "林夏亲眼看见",
        },
      }),
    ]);

    const receipt = await harness.service.extractSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter1,
      versionId: ids.version1,
    });

    expect(receipt).toMatchObject({
      status: "completed",
      detectedCount: 1,
      needsConfirmationCount: 1,
    });
    const facts = await harness.store.listByProjectId(storyUuid(ids.project));
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value).toHaveLength(1);
    const firstFact = facts.value.at(0);
    if (firstFact === undefined) throw new Error("expected one staged story fact");
    const snapshot = firstFact.toSnapshot();
    expect(snapshot).toMatchObject({
      factType: "pov_knowledge",
      status: "unconfirmed",
      origin: "ai_extraction",
      userConfirmed: false,
      needsReview: true,
      source: {
        kind: "chapter_span",
        chapterId: ids.chapter1,
        versionId: ids.version1,
        startOffset: 0,
        endOffset: harness.content.length,
        sourceLength: harness.content.length,
        excerpt: harness.content,
      },
    });
    expect(snapshot.source.reference).toContain(`:${ids.version1}:sha256:`);
    expect(await harness.store.listEvidenceByFactId(firstFact.id)).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          factId: firstFact.id,
          versionId: ids.version1,
          excerpt: harness.content,
        }),
      ],
    });
    expect(snapshot.structuredValue).toMatchObject({
      schemaVersion: "inkshadow.continuous-story-state.v2",
      payload: {
        knowledgeStatus: "known",
        acquiredAt: "第一章雨夜",
        informationSource: "林夏亲眼看见",
      },
    });
  });

  it("merges later chapters only through a unique user-confirmed alias", async () => {
    const firstCandidate = modelCandidate({
      factType: "character_identity",
      contentText: "林夏是钟表匠的女儿。",
      state: { identity: "钟表匠的女儿", attributes: {} },
    });
    const harness = await createHarness([firstCandidate]);
    await harness.service.extractSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter1,
      versionId: ids.version1,
    });
    const firstList = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!firstList.ok) throw firstList.error;
    const first = firstList.value.at(0);
    if (first === undefined) throw new Error("expected one staged identity fact");
    const confirmed = await harness.service.confirmChange({
      factId: first.id,
      actorId: ids.actor,
      expectedRevision: first.revision,
      humanConfirmed: true,
    });
    expect(confirmed.ok).toBe(true);
    const firstSubject = storyRecord(first.toSnapshot().structuredValue)?.subject;
    const firstKey = storyRecord(firstSubject)?.entityKey;

    const secondContent = "林夏在车站收起了旧怀表。";
    const secondVersion = await makeVersion(ids.chapter2, ids.version2, secondContent);
    harness.versions.set(ids.version2, secondVersion);
    harness.chapters.set(ids.chapter2, makeChapter(ids.chapter2, ids.version2, secondContent));
    harness.syncAuthority();
    harness.model.candidates = [
      modelCandidate({
        factType: "character_state",
        contentText: "林夏收起了旧怀表。",
        state: { state: "持有并收起旧怀表", effectiveAt: null },
        excerpt: secondContent,
      }),
    ];
    await harness.service.extractSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter2,
      versionId: ids.version2,
    });

    const all = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!all.ok) throw all.error;
    const second = all.value.find((fact) => fact.toSnapshot().source.versionId === ids.version2);
    const subject = storyRecord(storyRecord(second?.toSnapshot().structuredValue)?.subject);
    expect(subject).toMatchObject({
      entityKey: firstKey,
      canonicalName: "林夏",
      mergeStatus: "unique_confirmed_alias",
      matchedEntityKeys: [firstKey],
      needsReview: true,
    });
  });

  it("marks duplicate confirmed aliases ambiguous instead of guessing by name", async () => {
    const harness = await createHarness([]);
    const ambiguousContent = "阿梨看见门后的钟会倒着走。";
    harness.versions.set(
      ids.version1,
      await makeVersion(ids.chapter1, ids.version1, ambiguousContent),
    );
    harness.chapters.set(ids.chapter1, makeChapter(ids.chapter1, ids.version1, ambiguousContent));
    harness.syncAuthority();
    for (const entityKey of [ids.entity1, ids.entity2]) {
      const created = await harness.factService.createFormalUserFact({
        projectId: ids.project,
        factType: "character_identity",
        contentText: "阿梨是已确认人物。",
        structuredValue: {
          schemaVersion: "inkshadow.continuous-story-state.v2",
          subject: {
            kind: "character" as const,
            entityKey,
            canonicalName: "阿梨",
            aliases: ["阿梨"],
            mergeStatus: "user_created",
            matchedEntityKeys: [],
            needsReview: false,
          },
          payload: { identity: "已确认人物", attributes: {} },
        },
        actorId: ids.actor,
        humanConfirmed: true,
      });
      expect(created.ok).toBe(true);
    }
    harness.model.candidates = [
      modelCandidate({
        factType: "character_state",
        contentText: "阿梨看见门后的钟。",
        state: { state: "看见异常钟表", effectiveAt: null },
        canonicalName: "阿梨",
        excerpt: ambiguousContent,
      }),
    ];
    await harness.service.extractSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter1,
      versionId: ids.version1,
    });
    const listed = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!listed.ok) throw listed.error;
    const candidate = listed.value.find(
      (fact) => fact.toSnapshot().source.versionId === ids.version1 && fact.status === "temporary",
    );
    const subject = storyRecord(storyRecord(candidate?.toSnapshot().structuredValue)?.subject);
    expect(subject).toMatchObject({
      mergeStatus: "ambiguous_confirmed_alias",
      matchedEntityKeys: [ids.entity1, ids.entity2],
      needsReview: true,
    });
    expect(subject?.entityKey).not.toBe(ids.entity1);
    expect(subject?.entityKey).not.toBe(ids.entity2);
  });

  it("refuses to confirm evidence from an older chapter version", async () => {
    const harness = await createHarness([
      modelCandidate({
        factType: "character_state",
        contentText: "林夏看见了钟。",
        state: { state: "看见异常钟表", effectiveAt: null },
      }),
    ]);
    await harness.service.extractSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter1,
      versionId: ids.version1,
    });
    const listed = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!listed.ok) throw listed.error;
    const fact = listed.value.at(0);
    if (fact === undefined) throw new Error("expected one staged state fact");
    harness.chapters.set(
      ids.chapter1,
      makeChapter(ids.chapter1, ids.version3, "林夏离开了钟楼。", 2),
    );

    const confirmation = await harness.service.confirmChange({
      factId: fact.id,
      actorId: ids.actor,
      expectedRevision: fact.revision,
      humanConfirmed: true,
    });

    expect(confirmation.ok).toBe(false);
    if (confirmation.ok) return;
    expect(confirmation.error.code).toBe("EXTRACTION_SOURCE_CHANGED");
    const current = await harness.store.findById(fact.id);
    expect(current.ok && current.value?.status).toBe("temporary");
  });

  it("clearly skips missing routes without creating placeholder facts", async () => {
    const harness = await createHarness([]);
    harness.model.unavailable = true;

    const receipt = await harness.service.extractSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter1,
      versionId: ids.version1,
    });

    expect(receipt).toMatchObject({ status: "skipped", detectedCount: 0 });
    expect(receipt.skippedTasks).toEqual([
      { task: "character_extraction", code: "MODEL_HUB_ROUTE_NOT_CONFIGURED" },
      { task: "world_extraction", code: "MODEL_HUB_ROUTE_NOT_CONFIGURED" },
    ]);
    const listed = await harness.store.listByProjectId(storyUuid(ids.project));
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("keeps separate relationship targets and retires only the matching target on a new version", async () => {
    const firstContent = "林夏把阿棠当作朋友，也仍把顾川视为朋友。";
    const harness = await createHarness([]);
    harness.versions.set(ids.version1, await makeVersion(ids.chapter1, ids.version1, firstContent));
    harness.chapters.set(ids.chapter1, makeChapter(ids.chapter1, ids.version1, firstContent));
    await addConfirmedCharacter(harness.factService, ids.entity1, "林夏");
    await addConfirmedCharacter(harness.factService, ids.entity2, "阿棠");
    await addConfirmedCharacter(harness.factService, ids.entity3, "顾川");
    harness.syncAuthority();
    harness.model.candidates = [
      relationshipCandidate({
        content: firstContent,
        subjectKey: ids.entity1,
        otherEntityKey: ids.entity2,
        otherEntityName: "阿棠",
        change: "关系稳定",
      }),
      relationshipCandidate({
        content: firstContent,
        subjectKey: ids.entity1,
        otherEntityKey: ids.entity3,
        otherEntityName: "顾川",
        change: "关系稳定",
      }),
    ];

    await harness.service.extractSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter1,
      versionId: ids.version1,
    });
    const firstFacts = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!firstFacts.ok) throw firstFacts.error;
    const firstRelationships = firstFacts.value.filter(
      (fact) => fact.toSnapshot().factType === "relationship_change",
    );
    expect(firstRelationships).toHaveLength(2);
    expect(
      new Set(
        firstRelationships.map((fact) => {
          const replacementKey = storyRecord(fact.toSnapshot().structuredValue)?.replacementKey;
          return typeof replacementKey === "string" ? replacementKey : "";
        }),
      ).size,
    ).toBe(2);
    expect(
      firstRelationships.map((fact) => relationshipTargetKey(fact.toSnapshot().structuredValue)),
    ).toEqual(expect.arrayContaining([ids.entity2, ids.entity3]));

    const nextContent = "林夏和阿棠的朋友关系变得更加牢固。";
    harness.versions.set(ids.version3, await makeVersion(ids.chapter1, ids.version3, nextContent));
    harness.chapters.set(ids.chapter1, makeChapter(ids.chapter1, ids.version3, nextContent, 2));
    harness.syncAuthority();
    harness.model.candidates = [
      relationshipCandidate({
        content: nextContent,
        subjectKey: ids.entity1,
        otherEntityKey: ids.entity2,
        otherEntityName: "阿棠",
        change: "关系更加牢固",
      }),
    ];

    await harness.service.extractSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter1,
      versionId: ids.version3,
    });
    const after = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!after.ok) throw after.error;
    const relationships = after.value.filter(
      (fact) => fact.toSnapshot().factType === "relationship_change",
    );
    const oldTargetA = relationships.find(
      (fact) =>
        fact.toSnapshot().source.versionId === ids.version1 &&
        relationshipTargetKey(fact.toSnapshot().structuredValue) === ids.entity2,
    );
    const oldTargetB = relationships.find(
      (fact) =>
        fact.toSnapshot().source.versionId === ids.version1 &&
        relationshipTargetKey(fact.toSnapshot().structuredValue) === ids.entity3,
    );
    const currentTargetA = relationships.find(
      (fact) =>
        fact.toSnapshot().source.versionId === ids.version3 &&
        relationshipTargetKey(fact.toSnapshot().structuredValue) === ids.entity2,
    );
    expect(oldTargetA?.toSnapshot().deprecated).toBe(true);
    expect(oldTargetB?.toSnapshot().deprecated).toBe(false);
    expect(currentTargetA?.toSnapshot().deprecated).toBe(false);
  });

  it("compacts repeated relationship changes to the latest evidence and persists the raw route count", async () => {
    const content = "林夏先和阿棠成为朋友。后来林夏与阿棠发生争执。林夏仍把顾川视为朋友。";
    const harness = await createHarness([]);
    harness.versions.set(ids.version1, await makeVersion(ids.chapter1, ids.version1, content));
    harness.chapters.set(ids.chapter1, makeChapter(ids.chapter1, ids.version1, content));
    await addConfirmedCharacter(harness.factService, ids.entity1, "林夏");
    await addConfirmedCharacter(harness.factService, ids.entity2, "阿棠");
    await addConfirmedCharacter(harness.factService, ids.entity3, "顾川");
    harness.syncAuthority();
    const earlierExcerpt = "林夏先和阿棠成为朋友。";
    const laterExcerpt = "后来林夏与阿棠发生争执。";
    const otherTargetExcerpt = "林夏仍把顾川视为朋友。";
    // Deliberately return the later state first. Compaction must use exact text
    // position rather than provider array order.
    harness.model.candidates = [
      relationshipCandidate({
        content,
        subjectKey: ids.entity1,
        otherEntityKey: ids.entity2,
        otherEntityName: "阿棠",
        change: "发生争执",
        evidence: evidenceFor(content, laterExcerpt),
      }),
      relationshipCandidate({
        content,
        subjectKey: ids.entity1,
        otherEntityKey: ids.entity2,
        otherEntityName: "阿棠",
        change: "成为朋友",
        evidence: evidenceFor(content, earlierExcerpt),
      }),
      relationshipCandidate({
        content,
        subjectKey: ids.entity1,
        otherEntityKey: ids.entity3,
        otherEntityName: "顾川",
        change: "关系稳定",
        evidence: evidenceFor(content, otherTargetExcerpt),
      }),
    ];
    const input = {
      projectId: ids.project,
      chapterId: ids.chapter1,
      versionId: ids.version1,
    } as const;

    expect(await harness.service.extractSavedVersion(input)).toMatchObject({
      status: "completed",
      detectedCount: 2,
      reversibleCount: 2,
    });
    const routeReceipt = await harness.store.findContinuousStoryStateRouteReceipt({
      ...input,
      task: "character_extraction",
    });
    expect(routeReceipt.ok && routeReceipt.value).toMatchObject({
      candidateCount: 3,
      createdFactCount: 2,
    });
    const listed = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!listed.ok) throw listed.error;
    const relationships = listed.value.filter(
      (fact) => fact.toSnapshot().factType === "relationship_change",
    );
    expect(relationships).toHaveLength(2);
    const targetA = relationships.find(
      (fact) => relationshipTargetKey(fact.toSnapshot().structuredValue) === ids.entity2,
    );
    const targetB = relationships.find(
      (fact) => relationshipTargetKey(fact.toSnapshot().structuredValue) === ids.entity3,
    );
    expect(relationshipChange(targetA?.toSnapshot().structuredValue)).toBe("发生争执");
    expect(targetA?.toSnapshot().source.startOffset).toBe(content.indexOf(laterExcerpt));
    expect(targetB).toBeDefined();

    expect((await harness.service.extractSavedVersion(input)).status).toBe("already_processed");
    expect((await harness.service.extractSavedVersion({ ...input, force: true })).status).toBe(
      "already_processed",
    );
    expect((await harness.restart().extractSavedVersion(input)).status).toBe("already_processed");
    expect(harness.model.callCount).toBe(2);
  });

  it("fails closed when a relationship target key is missing or untrusted", async () => {
    const content = "林夏把陌生人当作朋友。";
    const harness = await createHarness([]);
    harness.versions.set(ids.version1, await makeVersion(ids.chapter1, ids.version1, content));
    harness.chapters.set(ids.chapter1, makeChapter(ids.chapter1, ids.version1, content));
    await addConfirmedCharacter(harness.factService, ids.entity1, "林夏");
    harness.syncAuthority();
    harness.model.candidates = [
      relationshipCandidate({
        content,
        subjectKey: ids.entity1,
        otherEntityKey: ids.entity2,
        otherEntityName: "陌生人",
        change: "关系建立",
      }),
    ];

    await expect(
      harness.service.extractSavedVersion({
        projectId: ids.project,
        chapterId: ids.chapter1,
        versionId: ids.version1,
      }),
    ).rejects.toMatchObject({
      code: "STORY_VALIDATION_FAILED",
      details: { reasonCode: "STORY_STATE_RELATIONSHIP_TARGET_UNTRUSTED" },
    });
  });

  it("persists route idempotency across replay, force, and service restart", async () => {
    const harness = await createHarness([
      modelCandidate({
        factType: "character_state",
        contentText: "林夏看见了异常的钟。",
        state: { state: "看见异常钟表", effectiveAt: null },
      }),
    ]);
    const input = {
      projectId: ids.project,
      chapterId: ids.chapter1,
      versionId: ids.version1,
    } as const;

    await harness.service.extractSavedVersion(input);
    const defaultReplay = await harness.service.extractSavedVersion(input);
    expect(defaultReplay.status).toBe("already_processed");
    expect(harness.model.callCount).toBe(2);

    const forced = await harness.service.extractSavedVersion({ ...input, force: true });
    expect(forced.status).toBe("already_processed");
    expect(forced.detectedCount).toBe(0);
    expect(harness.model.callCount).toBe(2);
    const afterRestart = await harness.restart().extractSavedVersion(input);
    expect(afterRestart.status).toBe("already_processed");
    expect(harness.model.callCount).toBe(2);
    const listed = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!listed.ok) throw listed.error;
    expect(listed.value).toHaveLength(1);
  });
});

async function createHarness(candidates: ContinuousStoryStateModelCandidate[]) {
  const content = "林夏看见门后的钟会倒着走。";
  const versions = new Map<string, ChapterVersion>();
  const chapters = new Map<string, Chapter>();
  versions.set(ids.version1, await makeVersion(ids.chapter1, ids.version1, content));
  chapters.set(ids.chapter1, makeChapter(ids.chapter1, ids.version1, content));
  const storage = new MemoryStorage();
  const syncAuthority = () =>
    storage.setItem(
      DEVELOPMENT_DATABASE_KEY,
      JSON.stringify({
        chapters: [...chapters.values()].map((chapter) => chapter.toSnapshot()),
        versions: [...versions.values()].map((version) => version.toSnapshot()),
      }),
    );
  syncAuthority();
  const store = new BrowserDevelopmentStoryFactStore(storage);
  const storyIds = new CryptoUuidV7Generator();
  const clock = new SystemClock();
  const factService = new StoryFactApplicationService({
    facts: store,
    clock,
    ids: storyIds,
  });
  const model = new MutableModel(candidates);
  const preferences = new MemoryContinuousStoryStatePreferences();
  const chapterRepository = new ChapterMapRepository(chapters);
  const hasher = new CryptoContentHasher();
  const productionService = new ContinuousStoryStateExtractionService({
    chapters: chapterRepository,
    chapterVersions: new VersionMapRepository(versions),
    facts: store,
    factService,
    model,
    hasher,
    ids: storyIds,
    clock,
    preferences,
    projectContextPrivacy: new ProjectContextPrivacyAuthority(chapterRepository, hasher),
  });
  const service = exposeLegacyProviderPipelineForTransformationTests(productionService);
  const restart = () =>
    exposeLegacyProviderPipelineForTransformationTests(
      new ContinuousStoryStateExtractionService({
        chapters: chapterRepository,
        chapterVersions: new VersionMapRepository(versions),
        facts: store,
        factService,
        model,
        hasher,
        ids: storyIds,
        clock,
        preferences,
        projectContextPrivacy: new ProjectContextPrivacyAuthority(chapterRepository, hasher),
      }),
    );
  return {
    service,
    productionService,
    restart,
    syncAuthority,
    store,
    factService,
    model,
    chapters,
    versions,
    content,
  };
}

/**
 * The old model-output transformation remains covered with strict fakes, but
 * production callers only receive the fail-closed public API.
 */
function exposeLegacyProviderPipelineForTransformationTests(
  service: ContinuousStoryStateExtractionService,
): ContinuousStoryStateExtractionService {
  return new Proxy(service, {
    get(target, property): unknown {
      if (property === "extractSavedVersion") {
        return (
          input: Readonly<{
            projectId: string;
            chapterId: string;
            versionId: string;
            force?: boolean;
          }>,
        ) =>
          (
            target as unknown as {
              extractSavedVersionOnce(
                request: typeof input,
              ): ReturnType<ContinuousStoryStateExtractionService["extractSavedVersion"]>;
            }
          ).extractSavedVersionOnce(input);
      }
      return Reflect.get(target, property, target) as unknown;
    },
  });
}

class MemoryContinuousStoryStatePreferences {
  private readonly enabledProjects = new Set<string>();

  public isContinuousStoryStateOnManualSaveEnabled(projectId: string): boolean {
    return this.enabledProjects.has(projectId);
  }

  public setContinuousStoryStateOnManualSaveEnabled(projectId: string, enabled: boolean): void {
    if (enabled) {
      this.enabledProjects.add(projectId);
    } else {
      this.enabledProjects.delete(projectId);
    }
  }
}

class MutableModel implements ContinuousStoryStateModelPort {
  public unavailable = false;
  public callCount = 0;

  public constructor(public candidates: ContinuousStoryStateModelCandidate[]) {}

  public extract(input: ContinuousStoryStateModelInput): Promise<ContinuousStoryStateModelOutput> {
    this.callCount += 1;
    if (this.unavailable) {
      throw new ContinuousStoryStateModelUnavailableError(
        "MODEL_HUB_ROUTE_NOT_CONFIGURED",
        "not configured",
      );
    }
    const candidates = this.candidates.filter((candidate) =>
      input.task === "character_extraction"
        ? [
            "character_identity",
            "character_state",
            "relationship_change",
            "pov_knowledge",
            "character_voice",
          ].includes(candidate.factType)
        : ![
            "character_identity",
            "character_state",
            "relationship_change",
            "pov_knowledge",
            "character_voice",
          ].includes(candidate.factType),
    );
    return Promise.resolve({
      candidates,
      providerKind: "ollama",
      modelId: "test-model",
      invocationId: uuid(input.task === "character_extraction" ? 20 : 21),
    });
  }
}

class ChapterMapRepository implements Pick<ChapterRepository, "findById" | "listByProjectId"> {
  public constructor(private readonly chapters: ReadonlyMap<string, Chapter>) {}

  public findById(id: DomainUuidV7) {
    return Promise.resolve(domainOk(this.chapters.get(id) ?? null));
  }

  public listByProjectId(projectId: DomainUuidV7) {
    return Promise.resolve(
      domainOk([...this.chapters.values()].filter((chapter) => chapter.projectId === projectId)),
    );
  }
}

class VersionMapRepository implements Pick<ChapterVersionRepository, "findVersionById"> {
  public constructor(private readonly versions: ReadonlyMap<string, ChapterVersion>) {}

  public findVersionById(id: DomainUuidV7) {
    return Promise.resolve(domainOk(this.versions.get(id) ?? null));
  }
}

async function makeVersion(chapterId: string, versionId: string, content: string) {
  const checksum = await new CryptoContentHasher().sha256(content);
  if (!checksum.ok) throw checksum.error;
  const created = ChapterVersion.create({
    id: domainUuid(versionId),
    projectId: domainUuid(ids.project),
    chapterId: domainUuid(chapterId),
    parentVersionId: null,
    sequence: 1,
    content,
    contentChecksum: checksum.value,
    reason: "created",
    sourceCandidateId: null,
    createdAt: timestamp("2026-08-01T00:00:00.000Z"),
  });
  if (!created.ok) throw created.error;
  return created.value;
}

function makeChapter(chapterId: string, versionId: string, content: string, revision = 1): Chapter {
  const created = Chapter.rehydrate({
    id: domainUuid(chapterId),
    projectId: domainUuid(ids.project),
    title: "第一章",
    content,
    status: "active",
    revision,
    currentVersionId: domainUuid(versionId),
    createdAt: timestamp("2026-08-01T00:00:00.000Z"),
    updatedAt: timestamp(revision === 1 ? "2026-08-01T00:00:00.000Z" : "2026-08-01T00:01:00.000Z"),
    trashedAt: null,
  });
  if (!created.ok) throw created.error;
  return created.value;
}

function modelCandidate(
  overrides: Partial<ContinuousStoryStateModelCandidate> &
    Pick<ContinuousStoryStateModelCandidate, "factType" | "contentText" | "state"> &
    Readonly<{ canonicalName?: string; excerpt?: string }>,
): ContinuousStoryStateModelCandidate {
  const excerpt = overrides.excerpt ?? "林夏看见门后的钟会倒着走。";
  return Object.freeze({
    factType: overrides.factType,
    contentText: overrides.contentText,
    confidence: overrides.confidence ?? 0.9,
    subject:
      overrides.subject === undefined
        ? {
            kind: "character" as const,
            entityKey: null,
            canonicalName: overrides.canonicalName ?? "林夏",
            aliases: [],
          }
        : overrides.subject,
    state: overrides.state,
    evidence: overrides.evidence ?? { start: 0, end: excerpt.length, excerpt },
    effectiveAt: overrides.effectiveAt ?? null,
    invalidatedAt: overrides.invalidatedAt ?? null,
  });
}

function relationshipCandidate(
  input: Readonly<{
    content: string;
    subjectKey: string;
    otherEntityKey: string;
    otherEntityName: string;
    change: string;
    evidence?: Readonly<{ start: number; end: number; excerpt: string }>;
  }>,
): ContinuousStoryStateModelCandidate {
  return modelCandidate({
    factType: "relationship_change",
    contentText: `${input.otherEntityName}：${input.change}`,
    subject: {
      kind: "character",
      entityKey: input.subjectKey,
      canonicalName: "林夏",
      aliases: [],
    },
    state: {
      otherEntityName: input.otherEntityName,
      otherEntityKey: input.otherEntityKey,
      relationship: "朋友",
      change: input.change,
    },
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    excerpt: input.content,
  });
}

async function addConfirmedCharacter(
  factService: StoryFactApplicationService,
  entityKey: string,
  canonicalName: string,
): Promise<void> {
  const created = await factService.createFormalUserFact({
    projectId: ids.project,
    factType: "character_identity",
    contentText: `${canonicalName}是已确认人物。`,
    structuredValue: {
      schemaVersion: "inkshadow.continuous-story-state.v2",
      subject: {
        kind: "character",
        entityKey,
        canonicalName,
        aliases: [canonicalName],
        mergeStatus: "user_created",
        matchedEntityKeys: [],
        needsReview: false,
      },
      payload: { identity: "已确认人物", attributes: {} },
    },
    actorId: ids.actor,
    humanConfirmed: true,
  });
  if (!created.ok) throw created.error;
}

function relationshipTargetKey(value: StoryValue | undefined): StoryValue | undefined {
  return storyRecord(storyRecord(value)?.payload)?.otherEntityKey;
}

function relationshipChange(value: StoryValue | undefined): StoryValue | undefined {
  return storyRecord(storyRecord(value)?.payload)?.change;
}

function evidenceFor(
  content: string,
  excerpt: string,
): Readonly<{ start: number; end: number; excerpt: string }> {
  const start = content.indexOf(excerpt);
  if (start < 0) throw new Error("expected relationship evidence in test content");
  return Object.freeze({ start, end: start + excerpt.length, excerpt });
}

class MemoryStorage implements Storage {
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

function storyRecord(value: StoryValue | undefined): Readonly<Record<string, StoryValue>> | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, StoryValue>>)
    : null;
}

function uuid(sequence: number): string {
  return `018f0f00-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function domainUuid(value: string) {
  const parsed = parseDomainUuid(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function storyUuid(value: string) {
  const parsed = parseStoryUuid(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function timestamp(value: string) {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}
