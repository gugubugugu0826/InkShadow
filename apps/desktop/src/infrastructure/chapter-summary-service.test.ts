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
import { StoryFactApplicationService, parseUuidV7 as parseStoryUuid } from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import { BrowserDevelopmentStoryFactStore } from "./story-fact-store";
import {
  CHAPTER_SUMMARY_MAXIMUM_SOURCE_CHARACTERS,
  BrowserChapterSummaryPreferenceStore,
  ChapterSummaryModelUnavailableError,
  ChapterSummaryService,
  parseStoredChapterSummaryPayload,
  segmentChapterSource,
  shouldRunChapterSummaryAfterSave,
  type ChapterSummaryModelInput,
  type ChapterSummaryModelOutput,
  type ChapterSummaryModelPort,
} from "./chapter-summary-service";
import { ProjectContextPrivacyAuthority } from "./project-context-privacy-authority";

const ids = {
  project: uuid(1),
  chapter: uuid(2),
  version1: uuid(3),
  version2: uuid(4),
  privateChapter: uuid(5),
  privateVersion: uuid(6),
};

describe("ChapterSummaryService", () => {
  it("never runs for autosave and defaults manual-save automation to off", async () => {
    expect(shouldRunChapterSummaryAfterSave("autosave", true)).toBe(false);
    expect(shouldRunChapterSummaryAfterSave("manual", false)).toBe(false);
    expect(shouldRunChapterSummaryAfterSave("manual", true)).toBe(true);

    const harness = await createHarness("A saved chapter.");
    const receipt = await harness.service.summarizeSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter,
      versionId: ids.version1,
      trigger: "manual_save",
    });
    expect(receipt).toMatchObject({
      status: "skipped",
      code: "CHAPTER_SUMMARY_AUTOMATION_PAUSED",
    });
    expect(harness.model.callCount).toBe(0);
  });

  it("generates one reversible system fact from the exact immutable version", async () => {
    const content = `${"A".repeat(1_799)}🙂tail`;
    const harness = await createHarness(content);
    const receipt = await harness.service.summarizeSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter,
      versionId: ids.version1,
      trigger: "user_rebuild",
    });

    expect(receipt.status).toBe("generated");
    expect(harness.model.callCount).toBe(1);
    expect(harness.model.lastInput?.segments).toHaveLength(2);
    expect(harness.model.lastInput?.segments.map(({ text }) => text).join("")).toBe(content);
    expect(harness.model.lastInput?.segments[0]?.text.endsWith("\ud83d")).toBe(false);

    const listed = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!listed.ok) throw listed.error;
    expect(listed.value).toHaveLength(1);
    const fact = listed.value[0];
    if (fact === undefined) throw new Error("expected summary fact");
    expect(fact.toSnapshot()).toMatchObject({
      factType: "chapter_summary",
      contentText: "Chapter summary",
      status: "temporary",
      origin: "system",
      userConfirmed: false,
      locked: false,
      needsReview: false,
      source: {
        chapterId: ids.chapter,
        versionId: ids.version1,
        startOffset: 0,
        sourceLength: content.length,
      },
    });
    const payload = parseStoredChapterSummaryPayload(fact);
    expect(payload).toMatchObject({
      sourceProjectId: ids.project,
      sourceChapterId: ids.chapter,
      sourceVersionId: ids.version1,
      generation: {
        task: "long_memory_compression",
        providerKind: "ollama",
        modelId: "test-model",
      },
      budget: {
        strategy: "bounded_utf16_segments",
        segmentCharacters: 1800,
        maximumSegments: 48,
        tokenEstimate: "model_hub_estimate_not_provider_tokenizer",
      },
    });
  });

  it("replaces and clears only the generated summary for the chapter", async () => {
    const harness = await createHarness("First version text.");
    const first = await harness.service.summarizeSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter,
      versionId: ids.version1,
      trigger: "user_rebuild",
    });
    const second = await harness.service.summarizeSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter,
      versionId: ids.version1,
      trigger: "user_rebuild",
    });
    expect(first.status).toBe("generated");
    expect(second).toMatchObject({ status: "generated", replacedFactIds: [first.fact?.id] });

    const beforeClear = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!beforeClear.ok) throw beforeClear.error;
    expect(
      beforeClear.value.filter((fact) => fact.toSnapshot().status === "temporary"),
    ).toHaveLength(1);
    expect(
      await harness.service.clearChapterSummary({
        projectId: ids.project,
        chapterId: ids.chapter,
      }),
    ).toEqual([second.fact?.id]);
    const afterClear = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!afterClear.ok) throw afterClear.error;
    expect(afterClear.value.every((fact) => fact.toSnapshot().status === "deprecated")).toBe(true);
  });

  it("does not repeat an already-current summary during historical recovery", async () => {
    const harness = await createHarness("Stable historical chapter text.");
    await harness.service.summarizeSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter,
      versionId: ids.version1,
      trigger: "user_rebuild",
    });

    await expect(
      harness.service.summarizeSavedVersion({
        projectId: ids.project,
        chapterId: ids.chapter,
        versionId: ids.version1,
        trigger: "historical_backfill",
      }),
    ).resolves.toMatchObject({
      status: "already_current",
      code: "CHAPTER_SUMMARY_ALREADY_CURRENT",
    });
    expect(harness.model.providerCalls).toBe(1);
  });

  it("does not persist a result when the saved version changes during the model call", async () => {
    const harness = await createHarness("Version one.");
    harness.model.beforeReturn = async () => {
      const changed = "Version two.";
      harness.versions.set(
        ids.version2,
        await makeVersion(ids.chapter, ids.version2, changed, ids.version1, 2),
      );
      harness.chapters.set(ids.chapter, makeChapter(ids.version2, changed, 2));
    };

    const receipt = await harness.service.summarizeSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter,
      versionId: ids.version1,
      trigger: "user_rebuild",
    });
    expect(receipt).toMatchObject({
      status: "skipped",
      code: "CHAPTER_SUMMARY_SOURCE_NOT_CURRENT",
    });
    const facts = await harness.store.listByProjectId(storyUuid(ids.project));
    if (!facts.ok) throw facts.error;
    expect(facts.value).toHaveLength(0);
  });

  it("blocks a standard target when another retained chapter is local-only", async () => {
    const harness = await createHarness("Standard target chapter.");
    harness.chapters.set(
      ids.privateChapter,
      makeSiblingPrivateChapter(ids.privateChapter, ids.privateVersion),
    );
    harness.model.verifiedLocalEligible = false;

    const receipt = await harness.service.summarizeSavedVersion({
      projectId: ids.project,
      chapterId: ids.chapter,
      versionId: ids.version1,
      trigger: "user_rebuild",
    });

    expect(receipt).toMatchObject({
      status: "failed",
      code: "PRIVATE_CHAPTER_LOCAL_ONLY",
    });
    expect(harness.model.lastInput).toMatchObject({ requiresVerifiedLocal: true });
    expect(harness.model.providerCalls).toBe(0);
  });

  it("skips clearly when no model is configured and bounds source size before dispatch", async () => {
    const missing = await createHarness("Short chapter.");
    missing.model.unavailable = true;
    expect(
      await missing.service.summarizeSavedVersion({
        projectId: ids.project,
        chapterId: ids.chapter,
        versionId: ids.version1,
        trigger: "user_rebuild",
      }),
    ).toMatchObject({ status: "skipped", code: "MODEL_HUB_ROUTE_NOT_CONFIGURED" });

    const oversized = await createHarness(
      "x".repeat(CHAPTER_SUMMARY_MAXIMUM_SOURCE_CHARACTERS + 1),
    );
    expect(
      await oversized.service.summarizeSavedVersion({
        projectId: ids.project,
        chapterId: ids.chapter,
        versionId: ids.version1,
        trigger: "user_rebuild",
      }),
    ).toMatchObject({ status: "skipped", code: "CHAPTER_SUMMARY_SOURCE_TOO_LARGE" });
    expect(oversized.model.callCount).toBe(0);
  });

  it("creates contiguous bounded UTF-16 evidence segments", async () => {
    const content = `${"a".repeat(1_799)}🙂${"b".repeat(1_800)}`;
    const checksum = await new CryptoContentHasher().sha256(content);
    if (!checksum.ok) throw checksum.error;
    const segments = segmentChapterSource({
      chapterId: ids.chapter,
      versionId: ids.version1,
      contentHash: checksum.value,
      content,
    });
    expect(segments.map(({ text }) => text).join("")).toBe(content);
    expect(segments.every(({ text }) => text.length <= 1_800)).toBe(true);
    expect(segments[0]?.endOffset).toBe(1_799);
  });
});

async function createHarness(content: string) {
  const versions = new Map<string, ChapterVersion>();
  const chapters = new Map<string, Chapter>();
  versions.set(ids.version1, await makeVersion(ids.chapter, ids.version1, content));
  chapters.set(ids.chapter, makeChapter(ids.version1, content));
  const store = new BrowserDevelopmentStoryFactStore(new MemoryStorage());
  const storyIds = new CryptoUuidV7Generator();
  const factService = new StoryFactApplicationService({
    facts: store,
    clock: new SystemClock(),
    ids: storyIds,
  });
  const model = new SummaryModel();
  const chapterRepository = new ChapterMapRepository(chapters);
  const hasher = new CryptoContentHasher();
  const service = new ChapterSummaryService({
    chapters: chapterRepository,
    chapterVersions: new VersionMapRepository(versions),
    facts: store,
    factService,
    hasher,
    model,
    preferences: new BrowserChapterSummaryPreferenceStore(new MemoryStorage()),
    projectContextPrivacy: new ProjectContextPrivacyAuthority(chapterRepository, hasher),
  });
  return { service, store, model, chapters, versions };
}

class SummaryModel implements ChapterSummaryModelPort {
  public callCount = 0;
  public providerCalls = 0;
  public unavailable = false;
  public verifiedLocalEligible = true;
  public beforeReturn: (() => Promise<void>) | null = null;
  public lastInput: ChapterSummaryModelInput | null = null;

  public async summarize(input: ChapterSummaryModelInput): Promise<ChapterSummaryModelOutput> {
    this.callCount += 1;
    this.lastInput = input;
    if (this.unavailable) {
      throw new ChapterSummaryModelUnavailableError(
        "MODEL_HUB_ROUTE_NOT_CONFIGURED",
        "请先为长程记忆压缩配置模型。",
      );
    }
    await input.assertProjectPrivacyCurrent?.();
    await input.assertSourceCurrent();
    await input.assertProjectPrivacyCurrent?.(this.verifiedLocalEligible);
    this.providerCalls += 1;
    await this.beforeReturn?.();
    const evidenceId = input.segments[0]?.evidenceId;
    if (evidenceId === undefined) throw new Error("missing segment");
    return Object.freeze({
      summary: "Chapter summary",
      keyEvents: Object.freeze([{ text: "An event", evidenceIds: Object.freeze([evidenceId]) }]),
      continuityNotes: Object.freeze([
        { text: "A continuity note", evidenceIds: Object.freeze([evidenceId]) },
      ]),
      evidenceIds: Object.freeze([evidenceId]),
      providerKind: "ollama",
      modelId: "test-model",
      invocationId: uuid(100),
      estimatedInputTokens: 200,
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

async function makeVersion(
  chapterId: string,
  versionId: string,
  content: string,
  parentVersionId: string | null = null,
  sequence = 1,
): Promise<ChapterVersion> {
  const checksum = await new CryptoContentHasher().sha256(content);
  if (!checksum.ok) throw checksum.error;
  const created = ChapterVersion.create({
    id: domainUuid(versionId),
    projectId: domainUuid(ids.project),
    chapterId: domainUuid(chapterId),
    parentVersionId: parentVersionId === null ? null : domainUuid(parentVersionId),
    sequence,
    content,
    contentChecksum: checksum.value,
    reason: sequence === 1 ? "created" : "manual",
    sourceCandidateId: null,
    createdAt: timestamp(sequence === 1 ? "2026-08-01T00:00:00.000Z" : "2026-08-01T00:01:00.000Z"),
  });
  if (!created.ok) throw created.error;
  return created.value;
}

function makeChapter(versionId: string, content: string, revision = 1): Chapter {
  const created = Chapter.rehydrate({
    id: domainUuid(ids.chapter),
    projectId: domainUuid(ids.project),
    title: "Chapter one",
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

function makeSiblingPrivateChapter(chapterId: string, versionId: string): Chapter {
  const created = Chapter.create({
    id: domainUuid(chapterId),
    projectId: domainUuid(ids.project),
    title: "Private sibling",
    content: "This retained sibling must stay local.",
    initialVersionId: domainUuid(versionId),
    privacyMode: "local_only",
    now: timestamp("2026-08-01T00:00:00.000Z"),
  });
  if (!created.ok) throw created.error;
  return created.value;
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

function uuid(sequence: number): string {
  return `018f0f00-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}
