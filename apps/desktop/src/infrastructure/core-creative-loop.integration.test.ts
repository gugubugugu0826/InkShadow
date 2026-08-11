import { resolveContinuationOutputContract } from "@inkshadow/ai-core";
import { createProjectSeed, updateProjectSeedField } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import { runAcceptedChapterPipeline } from "./accepted-chapter-pipeline";
import { CausalFactAuthoringService } from "./causal-fact-authoring-service";
import {
  BrowserChapterSummaryPreferenceStore,
  ChapterSummaryService,
} from "./chapter-summary-service";
import { ContinuousStoryStateExtractionService } from "./continuous-story-state-extraction";
import { ModelHubChapterSummaryModel } from "./model-hub-chapter-summary-model";
import { ModelHubContinuousStoryStateModel } from "./model-hub-continuous-story-state-model";
import type { NovelAiTask } from "./model-hub-provider-registry";
import type { ModelHubStore } from "./model-hub-store";
import {
  compileChapterStoryContext,
  createConfiguredModelCandidate,
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
  type NativeModelGenerationInput,
  type NativeModelGenerationResult,
} from "./runtime";

const OPENING = "林遥已经死去。钟楼大门被打开。";
const CURRENT_CLAIM = "林遥已经死去";
const CAUSAL_EVIDENCE = "钟楼大门被打开";
const REFERENCE_CONTENT = "正式设定：林遥仍然活着。钟楼仍在等待开启。";
const REFERENCE_EVIDENCE = "林遥仍然活着";
const CHARACTER_ID = "character.lin-yao";
const CONFIRMED_PREMISE = "林遥在永夜港寻找失踪的姐姐。";
const CONFIRMED_BOUNDARY = "人物死亡状态必须服从已确认设定。";
const SUMMARY_TEXT = "林遥死亡，钟楼大门随后开启。";
const STANDARD_CONTINUATION_TOKENS = resolveContinuationOutputContract({
  profile: "standard",
  providerOutputLimit: 20_000,
}).requestedMaxOutputTokens;

/**
 * This is an internal closure test only. Its deterministic in-process gateway
 * is not evidence that Ollama, or any other real provider, has been contacted
 * or verified.
 */
describe("core creative loop internal closure", () => {
  it("connects confirmed seed, isolated Candidate, accepted version, P41 projections, context, and dual-evidence validation", async () => {
    const harness = createInternalFakeHarness();
    await seedInternalFakeRoutes(harness.runtime.modelHub);

    const projectResult = await harness.runtime.useCases.createProject.execute({
      name: "内部闭环证据",
    });
    if (!projectResult.ok) throw projectResult.error;
    const project = projectResult.value;

    let seed = createProjectSeed({
      seedId: harness.runtime.ids.next(),
      journeyKind: "idea",
      premise: CONFIRMED_PREMISE,
      now: harness.runtime.clock.now(),
    });
    seed = updateProjectSeedField(seed, "boundaries", {
      values: CONFIRMED_BOUNDARY,
      source: "user_input",
      confirmation: "confirmed",
      origin: "internal-closure-author-boundary",
      updatedAt: harness.runtime.clock.now(),
    });
    await harness.runtime.projectSeeds.saveForProject(project.id, seed);

    const referenceResult = await harness.runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "已确认设定证据",
      content: REFERENCE_CONTENT,
    });
    if (!referenceResult.ok) throw referenceResult.error;
    const reference = referenceResult.value;
    const referenceStart = REFERENCE_CONTENT.indexOf(REFERENCE_EVIDENCE);
    expect(referenceStart).toBeGreaterThanOrEqual(0);
    const referenceFactResult = await harness.runtime.story.factService.createFormalUserFact({
      projectId: project.id,
      factType: "character_life_status",
      contentText: `${REFERENCE_EVIDENCE}。`,
      structuredValue: {
        validationRole: "reference_fact",
        subjectId: CHARACTER_ID,
        attributeKey: "life_status",
        value: "alive",
        effectiveRange: { startOrder: 1, endOrder: null },
        subject: {
          kind: "character",
          entityKey: CHARACTER_ID,
          canonicalName: "林遥",
          aliases: ["林遥"],
        },
      },
      source: {
        kind: "chapter_span",
        reference: `internal-confirmed:${reference.chapter.id}:${reference.version.id}`,
        chapterId: reference.chapter.id,
        versionId: reference.version.id,
        startOffset: referenceStart,
        endOffset: referenceStart + REFERENCE_EVIDENCE.length,
        sourceLength: REFERENCE_CONTENT.length,
        excerpt: REFERENCE_EVIDENCE,
      },
      actorId: harness.runtime.story.actorId,
      lock: true,
      humanConfirmed: true,
    });
    if (!referenceFactResult.ok) throw referenceFactResult.error;
    const referenceFact = referenceFactResult.value;

    const targetResult = await harness.runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "第一章",
      content: "",
    });
    if (!targetResult.ok) throw targetResult.error;
    const target = targetResult.value;
    const initialVersionId = target.version.id;

    const candidateResult = await createConfiguredModelCandidate(
      harness.runtime,
      target.chapter.id,
    );
    if (!candidateResult.ok) throw candidateResult.error;
    const candidate = candidateResult.value;

    const afterGeneration = await harness.runtime.repositories.chapters.findById(target.chapter.id);
    if (!afterGeneration.ok || afterGeneration.value === null) {
      throw new Error("target chapter disappeared after Candidate generation");
    }
    expect(afterGeneration.value).toMatchObject({
      content: "",
      currentVersionId: initialVersionId,
    });
    expect(candidate).toMatchObject({
      baseVersionId: initialVersionId,
      content: OPENING,
      status: "ready",
    });
    const continuationCall = harness.generate.mock.calls.find(
      ([input]) => input.maxOutputTokens === STANDARD_CONTINUATION_TOKENS,
    )?.[0];
    expect(joinMessages(continuationCall)).toContain(CONFIRMED_PREMISE);
    expect(joinMessages(continuationCall)).toContain(CONFIRMED_BOUNDARY);

    const versionsBeforeAcceptance =
      await harness.runtime.repositories.chapterVersions.listByChapterId(target.chapter.id);
    if (!versionsBeforeAcceptance.ok) throw versionsBeforeAcceptance.error;
    expect(versionsBeforeAcceptance.value).toHaveLength(1);

    const acceptedResult = await harness.runtime.useCases.acceptCandidate.execute({
      candidateId: candidate.id,
      expectedCandidateRevision: candidate.revision,
    });
    if (!acceptedResult.ok) throw acceptedResult.error;
    const accepted = acceptedResult.value;
    expect(accepted.chapter.content).toBe(OPENING);
    expect(accepted.chapter.content.length).toBeGreaterThan(target.chapter.content.length);
    expect(accepted.version.toSnapshot()).toMatchObject({
      parentVersionId: initialVersionId,
      reason: "candidate_accept",
      sourceCandidateId: candidate.id,
      content: OPENING,
    });
    const versionsAfterAcceptance =
      await harness.runtime.repositories.chapterVersions.listByChapterId(target.chapter.id);
    if (!versionsAfterAcceptance.ok) throw versionsAfterAcceptance.error;
    expect(versionsAfterAcceptance.value).toHaveLength(2);

    const causalAuthoring = new CausalFactAuthoringService({
      chapters: harness.runtime.repositories.chapters,
      chapterVersions: harness.runtime.repositories.chapterVersions,
      facts: harness.runtime.story.factService,
      factStore: harness.runtime.story.facts,
      projector: harness.runtime.story.causalProjector,
    });
    const causalEvent = await causalAuthoring.createEvent({
      projectId: project.id,
      chapterId: target.chapter.id,
      evidenceExcerpt: CAUSAL_EVIDENCE,
      eventText: "钟楼大门被打开",
      resultText: "进入钟楼的道路出现",
      narrativeOrder: 10,
      narrativeLabel: "第一幕",
      locationLabel: "永夜港钟楼",
      actorId: harness.runtime.story.actorId,
    });

    const pipeline = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: project.id,
      chapterId: target.chapter.id,
      versionId: accepted.version.id,
      source: "candidate_accept",
      acceptedCharacterCount: OPENING.length,
    });
    expect(pipeline).toMatchObject({
      status: "completed",
      search: { status: "completed" },
      chapterSummary: { status: "completed" },
      storyState: { status: "completed" },
      causalProjection: { status: "completed" },
      storyStateMetrics: {
        detectedCount: 1,
        needsConfirmationCount: 0,
        reversibleCount: 1,
        skippedTaskCount: 0,
      },
    });

    const listedFacts = await harness.runtime.story.facts.listByProjectId(
      project.id as unknown as Parameters<DesktopRuntime["story"]["facts"]["listByProjectId"]>[0],
    );
    if (!listedFacts.ok) throw listedFacts.error;
    const snapshots = listedFacts.value.map((fact) => fact.toSnapshot());
    const summary = snapshots.find(
      (fact) =>
        fact.factType === "chapter_summary" &&
        String(fact.source.versionId) === String(accepted.version.id),
    );
    const extractedState = snapshots.find(
      (fact) =>
        fact.factType === "character_state" &&
        String(fact.source.versionId) === String(accepted.version.id),
    );
    if (summary === undefined || extractedState === undefined) {
      throw new Error("P41 did not persist both the chapter summary and extracted story state");
    }
    expect(summary).toMatchObject({
      contentText: SUMMARY_TEXT,
      status: "temporary",
      origin: "system",
    });
    expect(extractedState).toMatchObject({
      contentText: `${CURRENT_CLAIM}。`,
      status: "temporary",
      origin: "system",
      source: { excerpt: CURRENT_CLAIM },
    });

    const indexed = await harness.runtime.search.search(project.id, "钟楼", 10);
    if (!indexed.ok) throw indexed.error;
    const indexedTarget = indexed.value.hits.find(
      ({ document }) =>
        document.sourceType === "chapter" &&
        document.sourceId === target.chapter.id &&
        document.sourceVersionId === accepted.version.id,
    );
    expect(indexedTarget?.document.text).toContain("钟楼");

    const graph = await harness.runtime.story.causalGraph.loadProjectBranch(project.id, "main");
    expect(graph.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: causalEvent.fact.id,
          eventText: "钟楼大门被打开",
        }),
      ]),
    );

    const currentChapter = await harness.runtime.repositories.chapters.findById(target.chapter.id);
    if (!currentChapter.ok || currentChapter.value === null) {
      throw new Error("accepted chapter disappeared before context compilation");
    }
    const secondContext = await compileChapterStoryContext(harness.runtime, currentChapter.value, {
      currentTask: {
        id: "internal-closure-next-scene",
        content: "继续钟楼场景。",
        selectionReason: "The integration test explicitly requests the next governed scene.",
        evidence: [
          {
            sourceType: "generation_task",
            sourceId: "internal-closure-next-scene",
            sourceVersionId: accepted.version.id,
            locator: null,
            contentHash: null,
            excerpt: null,
          },
        ],
        priority: 1_000,
      },
      retrievalQuery: "林遥 钟楼",
      maximumContextTokens: 20_000,
      allowRemoteRerank: false,
    });
    const compiledText = secondContext.compiled.entries.map(({ content }) => content).join("\n");
    expect(compiledText).toContain(CONFIRMED_PREMISE);
    expect(compiledText).toContain(CONFIRMED_BOUNDARY);
    expect(compiledText).toContain(REFERENCE_EVIDENCE);
    expect(compiledText).toContain(OPENING);
    expect(compiledText).toContain(SUMMARY_TEXT);
    expect(compiledText).toContain("钟楼大门被打开");
    expect(secondContext.compiled.entries.map(({ layer }) => layer)).toEqual(
      expect.arrayContaining([
        "locked_hard_rules",
        "character_current_state",
        "recent_events",
        "related_causal_chain",
      ]),
    );
    expect(secondContext.includedFactIds).toEqual(
      expect.arrayContaining([
        referenceFact.id,
        summary.id,
        extractedState.id,
        causalEvent.fact.id,
      ]),
    );

    const validation = await harness.runtime.story.chapterValidation.checkChapter({
      projectId: project.id,
      chapterId: target.chapter.id,
    });
    expect(validation.status).toBe("checked");
    const issue = validation.issues.find(({ type }) => type === "character_life_status_conflict");
    expect(issue?.currentTextExcerpt).toBe(CURRENT_CLAIM);
    expect(issue?.conflictingFact.source).toBe("confirmed_fact");
    expect(issue?.conflictingFact.value).toBe("alive");
    expect(
      issue?.currentEvidence.some(
        (evidence) =>
          evidence.sourceId === target.chapter.id &&
          evidence.sourceVersionId === accepted.version.id &&
          evidence.excerpt === CURRENT_CLAIM,
      ),
    ).toBe(true);
    expect(
      issue?.conflictingEvidence.some(
        (evidence) =>
          evidence.sourceId === reference.chapter.id &&
          evidence.sourceVersionId === reference.version.id &&
          evidence.excerpt === REFERENCE_EVIDENCE,
      ),
    ).toBe(true);
    expect(harness.generate).toHaveBeenCalledTimes(4);
  });
});

function createInternalFakeHarness(): Readonly<{
  runtime: DesktopRuntime;
  generate: ReturnType<typeof vi.fn<NativeModelGatewayClient["generate"]>>;
}> {
  const storage = new MemoryStorage();
  const developmentRuntime = createDevelopmentRuntime(storage);
  const generate = vi.fn<NativeModelGatewayClient["generate"]>((input) =>
    Promise.resolve(internalFakeGeneration(input)),
  );
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    generate,
    listModels: () => Promise.reject(new Error("not used by configured Model Hub routes")),
    checkConnection: () => Promise.reject(new Error("not used by configured Model Hub routes")),
    embed: () => Promise.reject(new Error("vector capability is intentionally not faked")),
    cancelGeneration: () => Promise.resolve(false),
  };
  const credentials = {
    getSummary: () => Promise.resolve({ configured: false, lastFour: null }),
    save: () => Promise.resolve({ configured: false, lastFour: null }),
    delete: () => Promise.resolve({ configured: false, lastFour: null }),
  };
  const executionDependencies = {
    modelHub: developmentRuntime.modelHub,
    modelGateway,
    credentials,
    clock: developmentRuntime.clock,
    ids: developmentRuntime.ids,
  };
  const preferences = new BrowserChapterSummaryPreferenceStore(storage);
  const chapterSummaries = new ChapterSummaryService({
    projects: developmentRuntime.repositories.projects,
    chapters: developmentRuntime.repositories.chapters,
    chapterVersions: developmentRuntime.repositories.chapterVersions,
    facts: developmentRuntime.story.facts,
    factService: developmentRuntime.story.factService,
    hasher: developmentRuntime.hasher,
    model: new ModelHubChapterSummaryModel(executionDependencies),
    preferences,
    projectContextPrivacy: developmentRuntime.projectContextPrivacy,
  });
  const continuousState = new ContinuousStoryStateExtractionService({
    chapters: developmentRuntime.repositories.chapters,
    chapterVersions: developmentRuntime.repositories.chapterVersions,
    facts: developmentRuntime.story.facts,
    factService: developmentRuntime.story.factService,
    model: new ModelHubContinuousStoryStateModel(executionDependencies),
    hasher: developmentRuntime.hasher,
    ids: developmentRuntime.ids,
    clock: developmentRuntime.clock,
    preferences,
    projectContextPrivacy: developmentRuntime.projectContextPrivacy,
  });
  return Object.freeze({
    generate,
    runtime: {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
      credentials,
      story: {
        ...developmentRuntime.story,
        chapterSummaries,
        continuousState,
      },
    },
  });
}

function internalFakeGeneration(input: NativeModelGenerationInput): NativeModelGenerationResult {
  if (input.maxOutputTokens === STANDARD_CONTINUATION_TOKENS) {
    return { text: OPENING, usage: null };
  }
  if (input.maxOutputTokens === 3_500) {
    const evidenceId = requireSummaryEvidenceId(input);
    return {
      text: JSON.stringify({
        schemaVersion: 1,
        summary: SUMMARY_TEXT,
        keyEvents: [{ text: "钟楼大门开启。", evidenceIds: [evidenceId] }],
        continuityNotes: [{ text: "下一场景可进入钟楼。", evidenceIds: [evidenceId] }],
        evidenceIds: [evidenceId],
      }),
      usage: null,
    };
  }
  if (input.maxOutputTokens === 12_000) {
    if (!joinMessages(input).includes("commonWords")) {
      return { text: JSON.stringify({ schemaVersion: 2, candidates: [] }), usage: null };
    }
    const start = OPENING.indexOf(CURRENT_CLAIM);
    return {
      text: JSON.stringify({
        schemaVersion: 2,
        candidates: [
          {
            factType: "character_state",
            contentText: `${CURRENT_CLAIM}。`,
            confidence: 0.99,
            subject: {
              kind: "character",
              entityKey: CHARACTER_ID,
              canonicalName: "林遥",
              aliases: [],
            },
            state: { state: "dead", effectiveAt: null },
            evidence: {
              start,
              end: start + CURRENT_CLAIM.length,
              excerpt: CURRENT_CLAIM,
            },
            effectiveAt: null,
            invalidatedAt: null,
            projection: {
              validation: {
                factType: "character_life_status",
                subjectId: CHARACTER_ID,
                attributeKey: "life_status",
                value: "dead",
                effectiveRange: { startOrder: 10, endOrder: null },
              },
              pov: null,
              voice: null,
              narrative: null,
            },
          },
        ],
      }),
      usage: null,
    };
  }
  throw new Error(`Unexpected internal fake request: ${String(input.maxOutputTokens)} tokens`);
}

async function seedInternalFakeRoutes(modelHub: ModelHubStore): Promise<void> {
  const connection = await modelHub.saveConnection({
    id: "internal-closure-local-fake",
    providerKind: "ollama",
    displayName: "Internal deterministic closure fake",
    credentialState: "missing",
    authenticationMode: "none",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await modelHub.syncCatalog({
    syncId: "internal-closure-local-fake-sync",
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: "internal-closure-local-fake-catalog",
        providerModelId: "internal-deterministic-fixture",
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter: "2027-08-08T00:00:00.000Z",
      },
    ],
  });
  await modelHub.recordCapabilityScan({
    scanId: "internal-closure-local-fake-scan",
    catalogEntryId: "internal-closure-local-fake-catalog",
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "internal-closure-fixture-v1-not-provider-evidence",
    evidence: [
      {
        id: "internal-closure-text-fixture",
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
      {
        id: "internal-closure-structured-fixture",
        capability: "structured_output",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: "internal-closure-local-fake-catalog",
    currency: "USD",
    inputMicrosPerMillionTokens: "0",
    outputMicrosPerMillionTokens: "0",
    cachedInputMicrosPerMillionTokens: "0",
    pricingVersion: "internal-closure-zero-cost-fixture-v1",
    priceUpdatedAt: "2026-08-08T00:00:00.000Z",
    dataDestination: "local",
    retentionPolicy: "none",
    trainingPolicy: "not_used",
    evidenceSource: "user_confirmed",
    evidenceVersion: "internal-closure-fixture-v1-not-provider-evidence",
    expectedRevision: null,
  });
  for (const task of [
    "continuation",
    "long_memory_compression",
    "character_extraction",
    "world_extraction",
  ] as const satisfies readonly NovelAiTask[]) {
    await modelHub.saveTaskRoute({
      task,
      primaryCatalogEntryId: "internal-closure-local-fake-catalog",
      privacyPolicy: "local_only",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    });
  }
}

function requireSummaryEvidenceId(input: NativeModelGenerationInput): string {
  const match = /"evidenceId":"([^"]+)"/u.exec(joinMessages(input));
  const evidenceId = match?.[1];
  if (evidenceId === undefined) {
    throw new Error("chapter summary request did not contain a bounded evidence id");
  }
  return evidenceId;
}

function joinMessages(input: NativeModelGenerationInput | undefined): string {
  return input?.messages.map(({ content }) => content).join("\n") ?? "";
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
