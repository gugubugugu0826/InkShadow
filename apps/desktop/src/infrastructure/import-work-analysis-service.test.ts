import { parseUuidV7, type Chapter } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7 } from "@inkshadow/story-core";
import { describe, expect, it, vi } from "vitest";

import type { NovelAiTask } from "./model-hub-provider-registry";
import type { ModelHubStore } from "./model-hub-store";
import {
  analyzeImportedChapter,
  parseImportedWorkAnalysisResponse,
} from "./import-work-analysis-service";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "./runtime";

describe("import work analysis response protocol", () => {
  it("accepts only exact evidence-bound schema and rejects extra fields or mismatched excerpts", () => {
    const chapterId = uuid("019f1000-0000-7000-8000-000000000001");
    const versionId = uuid("019f1000-0000-7000-8000-000000000002");
    const content = "林夏对周远说：“别走。”";
    const valid = response({
      chapterId,
      versionId,
      content,
      factType: "character_identity",
      statement: "林夏与周远是本段明确出现的人物。",
      subjects: ["林夏", "周远"],
    });

    expect(
      parseImportedWorkAnalysisResponse(valid, {
        chapterId,
        versionId,
        stage: "character",
        chunk: { index: 0, start: 0, text: content },
      }),
    ).toEqual([
      expect.objectContaining({
        factType: "character_identity",
        evidence: { startOffset: 0, endOffset: content.length, excerpt: content },
      }),
    ]);

    const withExtraField = JSON.stringify({ ...JSON.parse(valid), explanation: "trust me" });
    expect(() =>
      parseImportedWorkAnalysisResponse(withExtraField, {
        chapterId,
        versionId,
        stage: "character",
        chunk: { index: 0, start: 0, text: content },
      }),
    ).toThrow(expect.objectContaining({ code: "IMPORT_ANALYSIS_SCHEMA_INVALID" }));

    const wrongEvidence = response({
      chapterId,
      versionId,
      content,
      factType: "character_identity",
      statement: "林夏出现。",
      subjects: ["林夏"],
      excerpt: "正文中不存在的证据",
    });
    expect(() =>
      parseImportedWorkAnalysisResponse(wrongEvidence, {
        chapterId,
        versionId,
        stage: "character",
        chunk: { index: 0, start: 0, text: content },
      }),
    ).toThrow(expect.objectContaining({ code: "IMPORT_ANALYSIS_SCHEMA_INVALID" }));
  });
});

describe("analyzeImportedChapter", () => {
  it("routes through verified structured Model Hub capability and stages only unconfirmed facts", async () => {
    const harness = createHarness();
    const { projectId, chapter } = await createChapter(harness.runtime, "林夏对周远说：“别走。”");
    await seedAnalysisRoute(harness.runtime.modelHub, "character_extraction", true);
    harness.generate.mockResolvedValue({
      text: response({
        chapterId: chapter.id,
        versionId: chapter.currentVersionId,
        content: chapter.content,
        factType: "core_relationship",
        statement: "林夏试图挽留周远。",
        subjects: ["林夏", "周远"],
        relation: "挽留",
        confidence: 0.91,
      }),
      usage: null,
    });
    const beforeDispatch = vi.fn();

    const result = await analyzeImportedChapter(harness.runtime, {
      projectId,
      chapter,
      chapterIndex: 0,
      stage: "character",
      onBeforeDispatch: beforeDispatch,
    });

    expect(result).toMatchObject({
      projectId,
      chapterId: chapter.id,
      sourceVersionId: chapter.currentVersionId,
      factTypeCounts: { core_relationship: 1 },
      criticalFactCount: 1,
      requestCount: 1,
    });
    expect(beforeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "character-connection",
        modelId: "character-model",
        stage: "character",
        chunkIndex: 0,
        chunkCount: 1,
      }),
    );
    expect(harness.generate).toHaveBeenCalledOnce();

    const storyProjectId = parseStoryUuidV7(projectId);
    if (!storyProjectId.ok) throw storyProjectId.error;
    const facts = await harness.runtime.story.facts.listByProjectId(storyProjectId.value);
    expect(facts.ok).toBe(true);
    if (!facts.ok) throw facts.error;
    expect(facts.value).toHaveLength(1);
    expect(facts.value[0]?.toSnapshot()).toMatchObject({
      factType: "core_relationship",
      contentText: "林夏试图挽留周远。",
      confidence: 0.91,
      status: "unconfirmed",
      origin: "ai_extraction",
      userConfirmed: false,
      locked: false,
      needsReview: true,
      source: {
        kind: "chapter_span",
        chapterId: chapter.id,
        versionId: chapter.currentVersionId,
        startOffset: 0,
        endOffset: chapter.content.length,
        sourceLength: chapter.content.length,
        excerpt: chapter.content,
      },
    });
    const stable = await harness.runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe(chapter.content);
  });

  it("writes events as unconfirmed causal_event facts with projection-ready structure", async () => {
    const harness = createHarness();
    const { projectId, chapter } = await createChapter(
      harness.runtime,
      "午夜停电，仓库的监控随即失效。",
    );
    await seedAnalysisRoute(harness.runtime.modelHub, "world_extraction", true);
    harness.generate.mockResolvedValue({
      text: response({
        chapterId: chapter.id,
        versionId: chapter.currentVersionId,
        content: chapter.content,
        factType: "causal_event",
        statement: "午夜停电导致仓库监控失效。",
        subjects: [],
        relation: "仓库监控失效",
      }),
      usage: null,
    });

    await analyzeImportedChapter(harness.runtime, {
      projectId,
      chapter,
      chapterIndex: 2,
      stage: "story",
    });

    const storyProjectId = parseStoryUuidV7(projectId);
    if (!storyProjectId.ok) throw storyProjectId.error;
    const facts = await harness.runtime.story.facts.listByProjectId(storyProjectId.value);
    if (!facts.ok) throw facts.error;
    const event = facts.value[0]?.toSnapshot();
    expect(event).toMatchObject({
      factType: "causal_event",
      status: "unconfirmed",
      needsReview: true,
      structuredValue: {
        schemaVersion: "inkshadow.causal-event-fact.v1",
        participantCharacterIds: [],
        narrativeTime: { order: 2_000_000, label: "第一章" },
        location: { locationId: "unresolved-location", label: "未标注地点" },
        eventText: "午夜停电导致仓库监控失效。",
        resultText: "仓库监控失效",
        informedCharacterIds: [],
        prerequisites: [],
        characterStateChanges: [],
        relationshipChanges: [],
        itemChanges: [],
        foreshadowProgress: [],
        downstreamEventIds: [],
      },
    });
    expect((event?.structuredValue as { eventId?: string } | null)?.eventId).toContain(
      chapter.currentVersionId,
    );
  });

  it("blocks before dispatch when structured-output capability is not evidence-verified", async () => {
    const harness = createHarness();
    const { projectId, chapter } = await createChapter(harness.runtime, "她站在钟楼下。 ");
    await seedAnalysisRoute(harness.runtime.modelHub, "character_extraction", false);

    await expect(
      analyzeImportedChapter(harness.runtime, {
        projectId,
        chapter,
        chapterIndex: 0,
        stage: "character",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_ANALYSIS_STRUCTURED_OUTPUT_UNVERIFIED" });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("rejects invalid model JSON without changing original text or staging facts", async () => {
    const harness = createHarness();
    const { projectId, chapter } = await createChapter(harness.runtime, "雨停了。她离开车站。 ");
    await seedAnalysisRoute(harness.runtime.modelHub, "world_extraction", true);
    harness.generate.mockResolvedValue({ text: "```json\n{}\n```", usage: null });

    await expect(
      analyzeImportedChapter(harness.runtime, {
        projectId,
        chapter,
        chapterIndex: 0,
        stage: "story",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_ANALYSIS_SCHEMA_INVALID" });

    const stable = await harness.runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe(chapter.content);
    const storyProjectId = parseStoryUuidV7(projectId);
    if (!storyProjectId.ok) throw storyProjectId.error;
    const facts = await harness.runtime.story.facts.listByProjectId(storyProjectId.value);
    expect(facts.ok && facts.value).toHaveLength(0);
  });

  it("is idempotent when a recoverable unit retries the same validated result", async () => {
    const harness = createHarness();
    const { projectId, chapter } = await createChapter(harness.runtime, "顾遥只知道门已经锁上。 ");
    await seedAnalysisRoute(harness.runtime.modelHub, "character_extraction", true);
    const generated = response({
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      content: chapter.content,
      factType: "narrative_pov",
      statement: "本段限制在顾遥当前知道的信息内。",
      subjects: ["顾遥"],
    });
    harness.generate.mockResolvedValue({ text: generated, usage: null });

    const request = {
      projectId,
      chapter,
      chapterIndex: 0,
      stage: "character" as const,
    };
    const first = await analyzeImportedChapter(harness.runtime, request);
    const second = await analyzeImportedChapter(harness.runtime, request);

    expect(second.factIds).toEqual(first.factIds);
    const storyProjectId = parseStoryUuidV7(projectId);
    if (!storyProjectId.ok) throw storyProjectId.error;
    const facts = await harness.runtime.story.facts.listByProjectId(storyProjectId.value);
    expect(facts.ok && facts.value).toHaveLength(1);
  });
});

function createHarness(): Readonly<{
  runtime: DesktopRuntime;
  generate: ReturnType<typeof vi.fn<NativeModelGatewayClient["generate"]>>;
}> {
  const developmentRuntime = createDevelopmentRuntime(new MemoryStorage());
  const generate = vi.fn<NativeModelGatewayClient["generate"]>();
  const gateway: NativeModelGatewayClient = {
    available: true,
    generate,
    listModels: () => Promise.reject(new Error("not used")),
    checkConnection: () => Promise.reject(new Error("not used")),
    embed: () => Promise.reject(new Error("not used")),
    cancelGeneration: () => Promise.resolve(false),
  };
  return Object.freeze({
    generate,
    runtime: {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway: gateway,
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    },
  });
}

async function seedAnalysisRoute(
  modelHub: ModelHubStore,
  task: Extract<NovelAiTask, "character_extraction" | "world_extraction">,
  includeStructuredOutput: boolean,
): Promise<void> {
  const prefix = task === "character_extraction" ? "character" : "story";
  const connection = await modelHub.saveConnection({
    id: `${prefix}-connection`,
    providerKind: "google_gemini",
    displayName: `${prefix} connection`,
    credentialRef: `keyring:test:${prefix}`,
    credentialState: "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await modelHub.syncCatalog({
    syncId: `${prefix}-sync`,
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: `${prefix}-catalog`,
        providerModelId: `${prefix}-model`,
        lifecycle: "stable",
        inputTokenLimit: 500_000,
        outputTokenLimit: 20_000,
        staleAfter: "2030-01-01T00:00:00.000Z",
      },
    ],
  });
  await modelHub.recordCapabilityScan({
    scanId: `${prefix}-scan`,
    catalogEntryId: `${prefix}-catalog`,
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "import-analysis-test-v1",
    evidence: [
      {
        id: `${prefix}-text-evidence`,
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
      ...(includeStructuredOutput
        ? [
            {
              id: `${prefix}-structured-evidence`,
              capability: "structured_output" as const,
              verdict: "supported" as const,
              evidenceSource: "lightweight_probe" as const,
            },
          ]
        : []),
    ],
  });
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: `${prefix}-catalog`,
    currency: "USD",
    inputMicrosPerMillionTokens: "0",
    outputMicrosPerMillionTokens: "0",
    cachedInputMicrosPerMillionTokens: "0",
    pricingVersion: "zero-cost-v1",
    priceUpdatedAt: "2026-08-01T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "import-analysis-test-v1",
    expectedRevision: null,
  });
  await modelHub.saveTaskRoute({
    task,
    primaryCatalogEntryId: `${prefix}-catalog`,
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
}

async function createChapter(
  runtime: DesktopRuntime,
  content: string,
): Promise<Readonly<{ projectId: ReturnType<typeof uuid>; chapter: Chapter }>> {
  const project = await runtime.useCases.createProject.execute({ name: "导入分析测试" });
  if (!project.ok) throw project.error;
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content,
  });
  if (!chapter.ok) throw chapter.error;
  return Object.freeze({ projectId: project.value.id, chapter: chapter.value.chapter });
}

function response(
  input: Readonly<{
    chapterId: ReturnType<typeof uuid>;
    versionId: ReturnType<typeof uuid>;
    content: string;
    factType: string;
    statement: string;
    subjects: readonly string[];
    relation?: string | null;
    confidence?: number;
    excerpt?: string;
  }>,
): string {
  const excerpt = input.excerpt ?? input.content;
  return JSON.stringify({
    schemaVersion: 1,
    source: {
      chapterId: input.chapterId,
      versionId: input.versionId,
      chunkIndex: 0,
      chunkStart: 0,
      chunkLength: input.content.length,
    },
    findings: [
      {
        factType: input.factType,
        statement: input.statement,
        subjects: input.subjects,
        relation: input.relation ?? null,
        confidence: input.confidence ?? 0.9,
        evidence: {
          startOffset: 0,
          endOffset: excerpt.length,
          excerpt,
        },
      },
    ],
  });
}

function uuid(value: string) {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
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
