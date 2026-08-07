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
import {
  ContinuousStoryStateExtractionService,
  ContinuousStoryStateModelUnavailableError,
  shouldRunContinuousStoryStateExtraction,
  type ContinuousStoryStateModelCandidate,
  type ContinuousStoryStateModelInput,
  type ContinuousStoryStateModelOutput,
  type ContinuousStoryStateModelPort,
} from "./continuous-story-state-extraction";

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
};

describe("ContinuousStoryStateExtractionService", () => {
  it("defaults save-triggered extraction off and runs only after project opt-in", async () => {
    expect(shouldRunContinuousStoryStateExtraction("autosave", true)).toBe(false);
    expect(shouldRunContinuousStoryStateExtraction("manual", false)).toBe(false);
    expect(shouldRunContinuousStoryStateExtraction("manual", true)).toBe(true);
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
    expect(
      await harness.service.extractAfterSave({
        projectId: ids.project,
        chapterId: ids.chapter1,
        versionId: ids.version1,
        reason: "manual",
      }),
    ).toMatchObject({ status: "completed" });
    expect(harness.model.callCount).toBe(2);

    expect(
      await harness.service.extractAfterSave({
        projectId: ids.project,
        chapterId: ids.chapter1,
        versionId: ids.version1,
        reason: "autosave",
      }),
    ).toBeNull();
    expect(harness.model.callCount).toBe(2);
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

  it("is idempotent by default but reruns an explicit force request without duplicate facts", async () => {
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
    expect(forced.status).toBe("completed");
    expect(forced.detectedCount).toBe(0);
    expect(harness.model.callCount).toBe(4);
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
  const store = new BrowserDevelopmentStoryFactStore(new MemoryStorage());
  const storyIds = new CryptoUuidV7Generator();
  const factService = new StoryFactApplicationService({
    facts: store,
    clock: new SystemClock(),
    ids: storyIds,
  });
  const model = new MutableModel(candidates);
  const preferences = new MemoryContinuousStoryStatePreferences();
  const service = new ContinuousStoryStateExtractionService({
    chapters: new ChapterMapRepository(chapters),
    chapterVersions: new VersionMapRepository(versions),
    facts: store,
    factService,
    model,
    hasher: new CryptoContentHasher(),
    ids: storyIds,
    preferences,
  });
  return { service, store, factService, model, chapters, versions, content };
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

class ChapterMapRepository implements Pick<ChapterRepository, "findById"> {
  public constructor(private readonly chapters: ReadonlyMap<string, Chapter>) {}

  public findById(id: DomainUuidV7) {
    return Promise.resolve(domainOk(this.chapters.get(id) ?? null));
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
