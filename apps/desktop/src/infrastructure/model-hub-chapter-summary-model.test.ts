import { describe, expect, it, vi } from "vitest";
import { parseIsoUtcTimestamp } from "@inkshadow/domain";

import { type ChapterSummaryModelInput } from "./chapter-summary-service";
import {
  ModelHubChapterSummaryModel,
  parseChapterSummaryResponse,
} from "./model-hub-chapter-summary-model";
import type {
  ExecuteModelHubTextTaskInput,
  ModelHubTextExecutionDependencies,
  ModelHubTextTaskExecutionResult,
  ModelHubTextTaskInspection,
} from "./model-hub-execution-service";
import type { ModelHubStore } from "./model-hub-store";
import { ProjectContextPrivacyError } from "./project-context-privacy-authority";

const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const HASH = "a".repeat(64);
const EVIDENCE_ID = `chapter:${CHAPTER_ID}:version:${VERSION_ID}:sha256:${HASH}:utf16:0-4`;

describe("ModelHubChapterSummaryModel", () => {
  it("checks routing and both capabilities before dispatch and after response", async () => {
    const inspection = modelInspection();
    const inspectText = vi.fn().mockResolvedValue(inspection);
    const sourceCheck = vi.fn().mockResolvedValue(undefined);
    const projectCheck = vi.fn().mockResolvedValue(undefined);
    const executeText = vi.fn(
      async (
        _dependencies: ModelHubTextExecutionDependencies,
        request: ExecuteModelHubTextTaskInput,
      ) => {
        await request.onBeforeDispatch?.({
          generationId: uuid(20),
          invocationId: uuid(21),
          connectionId: inspection.connectionId,
          catalogEntryId: inspection.catalogEntryId,
          modelId: inspection.modelId,
          usedFallback: inspection.usedFallback,
          privacyPolicy: inspection.privacyPolicy,
          dataDestination: inspection.dataDestination,
        });
        await request.onFinalBeforeProviderDispatch?.({
          generationId: uuid(20),
          invocationId: uuid(21),
          connectionId: inspection.connectionId,
          catalogEntryId: inspection.catalogEntryId,
          modelId: inspection.modelId,
          usedFallback: inspection.usedFallback,
          privacyPolicy: inspection.privacyPolicy,
          dataDestination: inspection.dataDestination,
        });
        return modelExecution();
      },
    );
    const listCapabilityEvidence = vi
      .fn()
      .mockResolvedValue([capability("text_generation", 30), capability("structured_output", 31)]);
    const model = new ModelHubChapterSummaryModel({
      modelHub: { listCapabilityEvidence } as unknown as ModelHubStore,
      modelGateway: { available: true, generate: vi.fn() },
      credentials: { getSummary: vi.fn().mockResolvedValue({ configured: true }) },
      clock: { now: () => timestamp("2026-08-01T00:00:00.000Z") },
      ids: { next: () => uuid(40) as never },
      inspectText: inspectText as never,
      executeText,
    });

    const output = await model.summarize(input(sourceCheck, projectCheck));

    expect(output).toMatchObject({
      authorityMode: "structured_verified",
      summary: "A concise summary.",
      providerKind: "ollama",
      modelId: "model-a",
      invocationId: uuid(21),
      estimatedInputTokens: 500,
    });
    expect(inspectText).toHaveBeenCalledTimes(2);
    expect(executeText).toHaveBeenCalledTimes(1);
    expect(listCapabilityEvidence).toHaveBeenCalledTimes(4);
    expect(sourceCheck.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(projectCheck.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(executeText.mock.calls[0]?.[1]).toMatchObject({
      task: "long_memory_compression",
      maximumOutputTokens: 3500,
      temperature: 0.1,
      reasoningModeOverride: "disabled",
      generationRetryLimitOverride: 0,
    });
    expect(executeText.mock.calls[0]?.[1].responseFormat).toBeUndefined();
  });

  it("rechecks project privacy in the final dispatch hook before provider code runs", async () => {
    const inspection = modelInspection();
    const providerDispatch = vi.fn();
    let dispatchChecks = 0;
    const projectCheck = vi.fn((verifiedLocalEligible?: boolean) => {
      if (verifiedLocalEligible === false) dispatchChecks += 1;
      return dispatchChecks === 2
        ? Promise.reject(
            new ProjectContextPrivacyError(
              "PROJECT_CONTEXT_PRIVACY_CHANGED",
              "project privacy changed",
              true,
            ),
          )
        : Promise.resolve();
    });
    const executeText = vi.fn(
      async (
        _dependencies: ModelHubTextExecutionDependencies,
        request: ExecuteModelHubTextTaskInput,
      ) => {
        await request.onBeforeDispatch?.({
          generationId: uuid(20),
          invocationId: uuid(21),
          connectionId: inspection.connectionId,
          catalogEntryId: inspection.catalogEntryId,
          modelId: inspection.modelId,
          usedFallback: inspection.usedFallback,
          privacyPolicy: inspection.privacyPolicy,
          dataDestination: inspection.dataDestination,
          localOnlyEligible: false,
        });
        await request.onFinalBeforeProviderDispatch?.({
          generationId: uuid(20),
          invocationId: uuid(21),
          connectionId: inspection.connectionId,
          catalogEntryId: inspection.catalogEntryId,
          modelId: inspection.modelId,
          usedFallback: inspection.usedFallback,
          privacyPolicy: inspection.privacyPolicy,
          dataDestination: inspection.dataDestination,
          localOnlyEligible: false,
        });
        providerDispatch();
        return modelExecution();
      },
    );
    const model = new ModelHubChapterSummaryModel({
      modelHub: {
        listCapabilityEvidence: vi
          .fn()
          .mockResolvedValue([
            capability("text_generation", 30),
            capability("structured_output", 31),
          ]),
      } as unknown as ModelHubStore,
      modelGateway: { available: true, generate: vi.fn() },
      credentials: { getSummary: vi.fn().mockResolvedValue({ configured: true }) },
      clock: { now: () => timestamp("2026-08-01T00:00:00.000Z") },
      ids: { next: () => uuid(40) as never },
      inspectText: vi.fn().mockResolvedValue(inspection) as never,
      executeText,
    });

    await expect(
      model.summarize(input(vi.fn().mockResolvedValue(undefined), projectCheck, true)),
    ).rejects.toMatchObject({ code: "PROJECT_CONTEXT_PRIVACY_CHANGED" });

    expect(executeText).toHaveBeenCalledTimes(1);
    expect(executeText.mock.calls[0]?.[1]).toMatchObject({ requiredDataDestination: "local" });
    expect(providerDispatch).not.toHaveBeenCalled();
  });

  it("rechecks structured output evidence at the final latch before provider code runs", async () => {
    const inspection = modelInspection("openai");
    const providerDispatch = vi.fn();
    const executeText = vi.fn(
      async (
        _dependencies: ModelHubTextExecutionDependencies,
        request: ExecuteModelHubTextTaskInput,
      ) => {
        const selection = {
          generationId: uuid(20),
          invocationId: uuid(21),
          connectionId: inspection.connectionId,
          catalogEntryId: inspection.catalogEntryId,
          modelId: inspection.modelId,
          usedFallback: inspection.usedFallback,
          privacyPolicy: inspection.privacyPolicy,
          dataDestination: inspection.dataDestination,
          localOnlyEligible: false,
        } as const;
        await request.onBeforeDispatch?.(selection);
        await request.onFinalBeforeProviderDispatch?.(selection);
        providerDispatch();
        return modelExecution("openai");
      },
    );
    const verified = [capability("text_generation", 30), capability("structured_output", 31)];
    const listCapabilityEvidence = vi
      .fn()
      .mockResolvedValueOnce(verified)
      .mockResolvedValueOnce(verified)
      .mockResolvedValueOnce([capability("text_generation", 30)]);
    const model = new ModelHubChapterSummaryModel({
      modelHub: { listCapabilityEvidence } as unknown as ModelHubStore,
      modelGateway: { available: true, generate: vi.fn() },
      credentials: { getSummary: vi.fn().mockResolvedValue({ configured: true }) },
      clock: { now: () => timestamp("2026-08-01T00:00:00.000Z") },
      ids: { next: () => uuid(40) as never },
      inspectText: vi.fn().mockResolvedValue(inspection) as never,
      executeText,
    });

    await expect(
      model.summarize(
        input(vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined)),
      ),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CHAPTER_SUMMARY_CAPABILITY_CHANGED" });

    expect(listCapabilityEvidence).toHaveBeenCalledTimes(3);
    expect(providerDispatch).not.toHaveBeenCalled();
  });

  it("uses strict local parsing without blocking when structured output is not verified", async () => {
    const inspection = modelInspection();
    const executeText = vi.fn(
      async (
        _dependencies: ModelHubTextExecutionDependencies,
        request: ExecuteModelHubTextTaskInput,
      ) => {
        await request.onBeforeDispatch?.({
          generationId: uuid(20),
          invocationId: uuid(21),
          connectionId: inspection.connectionId,
          catalogEntryId: inspection.catalogEntryId,
          modelId: inspection.modelId,
          usedFallback: inspection.usedFallback,
          privacyPolicy: inspection.privacyPolicy,
          dataDestination: inspection.dataDestination,
          localOnlyEligible: true,
        });
        return modelExecution();
      },
    );
    const model = new ModelHubChapterSummaryModel({
      modelHub: {
        listCapabilityEvidence: vi.fn().mockResolvedValue([capability("text_generation", 30)]),
      } as unknown as ModelHubStore,
      modelGateway: { available: true, generate: vi.fn() },
      credentials: { getSummary: vi.fn().mockResolvedValue({ configured: true }) },
      clock: { now: () => timestamp("2026-08-01T00:00:00.000Z") },
      ids: { next: () => uuid(40) as never },
      inspectText: vi.fn().mockResolvedValue(inspection) as never,
      executeText,
    });

    await expect(
      model.summarize(input(vi.fn().mockResolvedValue(undefined))),
    ).resolves.toMatchObject({
      authorityMode: "plain_non_authoritative",
      summary: "A concise summary.",
      keyEvents: [],
      continuityNotes: [],
    });
    expect(executeText).toHaveBeenCalledOnce();
    expect(executeText.mock.calls[0]?.[1].responseFormat).toBeUndefined();
  });

  it("requests provider JSON mode only for verified OpenAI-compatible structured output", async () => {
    const inspection = modelInspection("deepseek");
    const executeText = vi.fn(
      async (
        _dependencies: ModelHubTextExecutionDependencies,
        request: ExecuteModelHubTextTaskInput,
      ) => {
        await request.onBeforeDispatch?.({
          generationId: uuid(20),
          invocationId: uuid(21),
          connectionId: inspection.connectionId,
          catalogEntryId: inspection.catalogEntryId,
          modelId: inspection.modelId,
          usedFallback: inspection.usedFallback,
          privacyPolicy: inspection.privacyPolicy,
          dataDestination: inspection.dataDestination,
        });
        return modelExecution("deepseek");
      },
    );
    const model = new ModelHubChapterSummaryModel({
      modelHub: {
        listCapabilityEvidence: vi
          .fn()
          .mockResolvedValue([
            capability("text_generation", 30),
            capability("structured_output", 31),
          ]),
      } as unknown as ModelHubStore,
      modelGateway: { available: true, generate: vi.fn() },
      credentials: { getSummary: vi.fn().mockResolvedValue({ configured: true }) },
      clock: { now: () => timestamp("2026-08-01T00:00:00.000Z") },
      ids: { next: () => uuid(40) as never },
      inspectText: vi.fn().mockResolvedValue(inspection) as never,
      executeText,
    });

    await model.summarize(input(vi.fn().mockResolvedValue(undefined)));

    expect(executeText.mock.calls[0]?.[1]).toMatchObject({
      responseFormat: "json_object",
      reasoningModeOverride: "disabled",
      generationRetryLimitOverride: 0,
    });
  });

  it("does not promote malformed text-only output as a plain summary", async () => {
    const inspection = modelInspection();
    const model = new ModelHubChapterSummaryModel({
      modelHub: {
        listCapabilityEvidence: vi.fn().mockResolvedValue([capability("text_generation", 30)]),
      } as unknown as ModelHubStore,
      modelGateway: { available: true, generate: vi.fn() },
      credentials: { getSummary: vi.fn().mockResolvedValue({ configured: true }) },
      clock: { now: () => timestamp("2026-08-01T00:00:00.000Z") },
      ids: { next: () => uuid(40) as never },
      inspectText: vi.fn().mockResolvedValue(inspection) as never,
      executeText: vi.fn().mockResolvedValue({ ...modelExecution(), text: "not-json" }) as never,
    });

    await expect(
      model.summarize(input(vi.fn().mockResolvedValue(undefined))),
    ).rejects.toMatchObject({ code: "CHAPTER_SUMMARY_RESPONSE_INVALID" });
  });

  it("rejects extra fields and invented evidence identifiers", () => {
    const valid = response();
    expect(parseChapterSummaryResponse(valid, new Set([EVIDENCE_ID]))).toMatchObject({
      summary: "A concise summary.",
    });
    expect(() =>
      parseChapterSummaryResponse(
        JSON.stringify({ ...JSON.parse(valid), extra: true }),
        new Set([EVIDENCE_ID]),
      ),
    ).toThrow(/未声明|缺失/u);
    expect(() =>
      parseChapterSummaryResponse(response("invented-evidence"), new Set([EVIDENCE_ID])),
    ).toThrow(/不存在|改写/u);
    expect(() =>
      parseChapterSummaryResponse(`\`\`\`json\n${valid}\n\`\`\``, new Set([EVIDENCE_ID])),
    ).toThrow(/严格 JSON/u);
  });
});

function input(
  assertSourceCurrent: () => Promise<void>,
  assertProjectPrivacyCurrent: (verifiedLocalEligible?: boolean) => Promise<void> = () =>
    Promise.resolve(),
  requiresVerifiedLocal = false,
): ChapterSummaryModelInput {
  return Object.freeze({
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    versionId: VERSION_ID,
    sourceContentHash: HASH,
    sourceLength: 4,
    segments: Object.freeze([
      Object.freeze({ evidenceId: EVIDENCE_ID, startOffset: 0, endOffset: 4, text: "ABCD" }),
    ]),
    projectPrivacy: Object.freeze({
      schemaVersion: 1 as const,
      projectId: PROJECT_ID,
      fingerprint: "a".repeat(64),
      activeChapterCount: 1,
      retainedChapterCount: 1,
      requiresVerifiedLocal,
      chapters: Object.freeze([
        Object.freeze({
          chapterId: CHAPTER_ID,
          currentVersionId: VERSION_ID,
          revision: 1,
          privacyRevision: 1,
          privacyMode: requiresVerifiedLocal ? ("local_only" as const) : ("standard" as const),
          status: "active" as const,
        }),
      ]),
    }),
    requiresVerifiedLocal,
    assertSourceCurrent,
    assertProjectPrivacyCurrent,
  });
}

function response(evidenceId = EVIDENCE_ID): string {
  return JSON.stringify({
    schemaVersion: 1,
    summary: "A concise summary.",
    keyEvents: [{ text: "An event.", evidenceIds: [evidenceId] }],
    continuityNotes: [{ text: "Keep this detail.", evidenceIds: [evidenceId] }],
    evidenceIds: [evidenceId],
  });
}

function modelInspection(
  providerKind: ModelHubTextTaskInspection["providerKind"] = "ollama",
): ModelHubTextTaskInspection {
  return {
    task: "long_memory_compression",
    configuredPrimaryCatalogEntryId: "catalog-a",
    configuredFallbackCatalogEntryId: null,
    selectionKind: "task_primary",
    usedFallback: false,
    attempt: 1,
    connectionId: "connection-a",
    catalogEntryId: "catalog-a",
    providerKind,
    modelId: "model-a",
    dataDestination: "local",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    maximumOutputTokens: 3_500,
    temperature: 0.1,
    estimatedInputTokens: 500,
    estimatedTotalTokens: 4_000,
    inputTokenLimit: 10_000,
    outputTokenLimit: 4_000,
    tokenLimitEvidence: {
      source: "catalog",
      version: "test-catalog-v1",
      updatedAt: "2026-08-01T00:00:00.000Z",
      sourceUrl: null,
      verifiedByInkShadow: true,
    },
    pricing: {
      currency: null,
      inputMicrosPerMillionTokens: null,
      outputMicrosPerMillionTokens: null,
      cachedInputMicrosPerMillionTokens: null,
      pricingVersion: null,
      priceUpdatedAt: null,
      evidenceSource: "user_confirmed",
      evidenceVersion: null,
      evidenceUpdatedAt: "2026-08-01T00:00:00.000Z",
      estimatedMaximumCostMicros: null,
      maximumCostMicros: null,
      maximumCostCurrency: null,
    },
  };
}

function modelExecution(
  providerKind: ModelHubTextTaskInspection["providerKind"] = "ollama",
): ModelHubTextTaskExecutionResult {
  return {
    text: response(),
    usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: null },
    invocation: {
      id: uuid(21),
      task: "long_memory_compression",
      routeTask: "long_memory_compression",
      connectionId: "connection-a",
      catalogEntryId: "catalog-a",
      providerKindSnapshot: providerKind,
      modelIdSnapshot: "model-a",
      routeReason: "task_primary",
      attempt: 1,
      privacyPolicy: "cloud_allowed",
      dataDestination: "local",
      maximumCostMicros: null,
      currency: null,
      status: "succeeded",
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: null,
      estimatedCostMicros: null,
      errorCode: null,
      errorSummary: null,
      providerDispatchStartedAt: "2026-08-01T00:00:00.000Z",
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
      revision: 2,
    },
    connectionId: "connection-a",
    catalogEntryId: "catalog-a",
    providerKind,
    modelId: "model-a",
    usedFallback: false,
    costCeilingExceededAfterDispatch: false,
  } as unknown as ModelHubTextTaskExecutionResult;
}

function capability(capabilityName: "text_generation" | "structured_output", sequence: number) {
  return {
    id: uuid(sequence),
    catalogEntryId: "catalog-a",
    scanId: uuid(sequence + 100),
    capability: capabilityName,
    verdict: "supported",
    evidenceSource: "lightweight_probe",
    evidenceVersion: "probe-v1",
    evidenceSummary: "verified in test",
    observedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: null,
  };
}

function uuid(sequence: number): string {
  return `018f0f00-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function timestamp(value: string) {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}
