import { runGenerationPreflight } from "@inkshadow/ai-core";
import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import {
  BrowserDevelopmentGenerationGovernanceStore,
  DEVELOPMENT_GENERATION_GOVERNANCE_KEY,
} from "./generation-governance-store";

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const TASK_ID = uuid(4);
const RUN_ID = uuid(5);
const REMOTE_PRIVACY = Object.freeze({
  privacySnapshotVersion: 1 as const,
  privacyPolicy: "cloud_allowed" as const,
  dataDestination: "remote" as const,
  modelInvocationId: null,
});

describe("BrowserDevelopmentGenerationGovernanceStore", () => {
  it("persists content-free preflight provenance and deduplicates a run", async () => {
    const store = createStore();
    const preflight = readyPreflight();
    const input = {
      id: RUN_ID,
      taskId: TASK_ID,
      idempotencyKey: `ai.generate:${CHAPTER_ID}:${VERSION_ID}`,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      baseVersionId: VERSION_ID,
      providerId: "openai",
      modelId: "gpt-test",
      preflight,
    } as const;

    await expect(store.createRun(input)).resolves.toMatchObject({ created: true });
    await expect(store.createRun({ ...input, id: uuid(6) })).resolves.toMatchObject({
      created: false,
      run: { id: RUN_ID, estimatedCostMicros: "8000" },
    });
    const serialized = window.localStorage.getItem(DEVELOPMENT_GENERATION_GOVERNANCE_KEY) ?? "";
    expect(serialized).not.toMatch(/chapter content|system prompt|api[_-]?key|secret/iu);
    expect(serialized).toContain('"codes":["READY"]');
  });

  it("tracks estimated retry cost and enforces revisioned lifecycle transitions", async () => {
    const store = createStore();
    const created = await store.createRun({
      id: RUN_ID,
      taskId: TASK_ID,
      idempotencyKey: `ai.generate:${CHAPTER_ID}:${VERSION_ID}`,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      baseVersionId: VERSION_ID,
      providerId: "openai",
      modelId: "gpt-test",
      preflight: readyPreflight(),
    });
    const retrieving = await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: created.run.revision,
      state: "retrieving",
    });
    const generating = await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: retrieving.revision,
      state: "generating",
    });
    const failed = await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: generating.revision,
      state: "failed_retryable",
      failureCode: "MODEL_TIMEOUT",
      addIncurredCost: true,
      attemptUsage: {
        ...REMOTE_PRIVACY,
        source: "provider_unavailable",
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        usagePricedEstimateMicros: null,
      },
    });
    expect(failed).toMatchObject({
      state: "failed_retryable",
      incurredCostMicros: "8000",
      failureCode: "MODEL_TIMEOUT",
    });
    await expect(
      store.transitionRun({
        runId: RUN_ID,
        expectedRevision: generating.revision,
        state: "queued",
      }),
    ).rejects.toMatchObject({ code: "AI_GENERATION_REVISION_CONFLICT" });
    await expect(store.listAttemptUsage(RUN_ID)).resolves.toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        attempt: 1,
        source: "provider_unavailable",
        usagePricedEstimateMicros: null,
      }),
    ]);
  });

  it("appends provider token receipts separately from the preflight upper bound", async () => {
    const store = createStore();
    const created = await store.createRun({
      id: RUN_ID,
      taskId: TASK_ID,
      idempotencyKey: `ai.generate:${CHAPTER_ID}:${VERSION_ID}`,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      baseVersionId: VERSION_ID,
      providerId: "openai",
      modelId: "gpt-test",
      route: {
        role: "high_quality",
        reason: "role_primary",
        fallbackProviderId: "ollama-local",
        fallbackModelId: "qwen-local",
      },
      preflight: readyPreflight(),
    });
    const retrieving = await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: created.run.revision,
      state: "retrieving",
    });
    const generating = await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: retrieving.revision,
      state: "generating",
    });
    const validating = await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: generating.revision,
      state: "validating",
    });
    await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: validating.revision,
      state: "candidate_ready",
      candidateId: uuid(8),
      addIncurredCost: true,
      attemptUsage: {
        ...REMOTE_PRIVACY,
        source: "provider_reported",
        inputTokens: 3_900,
        outputTokens: 650,
        cachedInputTokens: 900,
        usagePricedEstimateMicros: "5200",
      },
    });

    await expect(store.listAttemptUsage(RUN_ID)).resolves.toEqual([
      expect.objectContaining({
        source: "provider_reported",
        inputTokens: 3_900,
        outputTokens: 650,
        cachedInputTokens: 900,
        usagePricedEstimateMicros: "5200",
        pricingVersion: "2026-07",
      }),
    ]);
    await expect(store.findRunById(RUN_ID)).resolves.toMatchObject({
      estimatedCostMicros: "8000",
      incurredCostMicros: "8000",
      route: {
        role: "high_quality",
        reason: "role_primary",
      },
    });
  });

  it("keeps an unpriced generation runnable without fabricating a monetary amount", async () => {
    const store = createStore();
    const created = await store.createRun({
      id: RUN_ID,
      taskId: TASK_ID,
      idempotencyKey: `ai.generate:${CHAPTER_ID}:${VERSION_ID}:unpriced`,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      baseVersionId: VERSION_ID,
      providerId: "deepseek",
      modelId: "deepseek-chat",
      preflight: unpricedPreflight(),
    });

    expect(created.run).toMatchObject({
      costStatus: "pricing_unavailable",
      estimatedCostMicros: "0",
      currency: "XXX",
      preflight: {
        costStatus: "pricing_unavailable",
        estimateMicros: null,
        currency: null,
      },
    });
    let run = await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: created.run.revision,
      state: "retrieving",
    });
    run = await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: run.revision,
      state: "generating",
    });
    await store.transitionRun({
      runId: RUN_ID,
      expectedRevision: run.revision,
      state: "failed_retryable",
      failureCode: "PROVIDER_RESPONSE_INVALID",
      addIncurredCost: true,
      attemptUsage: {
        ...REMOTE_PRIVACY,
        source: "provider_reported_unpriced",
        inputTokens: 2_100,
        outputTokens: 380,
        cachedInputTokens: null,
        usagePricedEstimateMicros: null,
      },
    });

    await expect(store.findRunById(RUN_ID)).resolves.toMatchObject({
      incurredCostMicros: "0",
      costStatus: "pricing_unavailable",
    });
    await expect(store.listAttemptUsage(RUN_ID)).resolves.toEqual([
      expect.objectContaining({
        source: "provider_reported_unpriced",
        costStatus: "pricing_unavailable",
        inputTokens: 2_100,
        outputTokens: 380,
        usagePricedEstimateMicros: null,
      }),
    ]);
  });

  it("lists only a project's generation runs in deterministic creation order", async () => {
    const store = createStore();
    const secondRunId = uuid(7);
    const otherProjectId = uuid(20);

    await store.createRun({
      id: secondRunId,
      taskId: uuid(21),
      idempotencyKey: `ai.generate:${uuid(22)}:${uuid(23)}`,
      projectId: PROJECT_ID,
      chapterId: uuid(22),
      baseVersionId: uuid(23),
      providerId: "openai",
      modelId: "gpt-test",
      preflight: readyPreflight(),
    });
    await store.createRun({
      id: RUN_ID,
      taskId: TASK_ID,
      idempotencyKey: `ai.generate:${CHAPTER_ID}:${VERSION_ID}`,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      baseVersionId: VERSION_ID,
      providerId: "openai",
      modelId: "gpt-test",
      preflight: readyPreflight(),
    });
    await store.createRun({
      id: uuid(24),
      taskId: uuid(25),
      idempotencyKey: `ai.generate:${uuid(26)}:${uuid(27)}`,
      projectId: otherProjectId,
      chapterId: uuid(26),
      baseVersionId: uuid(27),
      providerId: "openai",
      modelId: "gpt-test",
      preflight: readyPreflight(),
    });

    await expect(store.listRunsByProjectId(PROJECT_ID)).resolves.toEqual([
      expect.objectContaining({ id: RUN_ID, projectId: PROJECT_ID }),
      expect.objectContaining({ id: secondRunId, projectId: PROJECT_ID }),
    ]);
    await expect(store.listRunsByProjectId(otherProjectId)).resolves.toHaveLength(1);
    await expect(store.listRunsByProjectId("not-a-uuid")).rejects.toMatchObject({
      code: "AI_GENERATION_INVALID",
    });
  });

  it("stores a network-only deferred request without authored text and guards its lifecycle", async () => {
    const store = createStore();
    const deferred = await store.createDeferredRequest({
      id: uuid(9),
      taskId: uuid(10),
      idempotencyKey: `ai.generate.deferred:${CHAPTER_ID}:${VERSION_ID}`,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      baseVersionId: VERSION_ID,
      modelRole: "high_quality",
      providerId: "openai",
      modelId: "gpt-test",
      maximumOutputTokens: 2_000,
      preflight: offlinePreflight(),
    });

    expect(deferred).toMatchObject({
      created: true,
      request: {
        status: "waiting_network",
        approvedEstimateMicros: "8000",
      },
    });
    await expect(
      store.findWaitingDeferredRequest(CHAPTER_ID, "high_quality"),
    ).resolves.toMatchObject({ id: uuid(9), status: "waiting_network" });
    await expect(
      store.transitionDeferredRequest({
        id: uuid(9),
        expectedRevision: 1,
        status: "blocked_stale",
      }),
    ).resolves.toMatchObject({ status: "blocked_stale", revision: 2 });

    const serialized = window.localStorage.getItem(DEVELOPMENT_GENERATION_GOVERNANCE_KEY) ?? "";
    expect(serialized).not.toMatch(/chapter content|system prompt|messages|api[_-]?key|secret/iu);
  });

  it("calculates project and monthly reservations before hard-cap evaluation", async () => {
    const store = createStore();
    await store.saveBudgetPolicy({
      scope: "project",
      projectId: PROJECT_ID,
      monthKey: null,
      currency: "USD",
      limitMicros: "10000",
      enforcement: "hard",
      expectedRevision: null,
    });
    await store.saveBudgetPolicy({
      scope: "month",
      projectId: null,
      monthKey: "2026-07",
      currency: "USD",
      limitMicros: "20000",
      enforcement: "warn",
      expectedRevision: null,
    });
    await store.createRun({
      id: RUN_ID,
      taskId: TASK_ID,
      idempotencyKey: `ai.generate:${CHAPTER_ID}:${VERSION_ID}`,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      baseVersionId: VERSION_ID,
      providerId: "openai",
      modelId: "gpt-test",
      preflight: readyPreflight(),
    });

    await expect(store.getBudgetLimits(PROJECT_ID, "2026-07", "USD")).resolves.toEqual([
      {
        scope: "month",
        limitMicros: 20_000n,
        spentMicros: 8_000n,
        enforcement: "warn",
      },
      {
        scope: "project",
        limitMicros: 10_000n,
        spentMicros: 8_000n,
        enforcement: "hard",
      },
    ]);
  });

  it("rejects a tampered browser ledger containing authored content", async () => {
    window.localStorage.setItem(
      DEVELOPMENT_GENERATION_GOVERNANCE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        policies: [],
        runs: [{ content: "private chapter" }],
      }),
    );

    await expect(createStore().findRunById(RUN_ID)).rejects.toMatchObject({
      code: "AI_GENERATION_STORE_CORRUPT",
    });
  });
});

function createStore(): BrowserDevelopmentGenerationGovernanceStore {
  const parsedNow = parseIsoUtcTimestamp(NOW);
  if (!parsedNow.ok) {
    throw parsedNow.error;
  }
  return new BrowserDevelopmentGenerationGovernanceStore(window.localStorage, {
    now: () => parsedNow.value,
  });
}

function readyPreflight() {
  return runGenerationPreflight({
    now: NOW,
    migrationReady: true,
    chapterExists: true,
    chapterSaved: true,
    projectWritable: true,
    gatewayAvailable: true,
    networkAvailable: true,
    providerLocation: "remote",
    profileConfigured: true,
    modelSelected: true,
    credentialConfigured: true,
    connectionStatus: "verified",
    selectedModelAvailable: true,
    inputBytes: 12_000,
    maximumInputBytes: 1_000_000,
    inputTokens: 4_000,
    maximumOutputTokens: 2_000,
    contextWindowTokens: 16_000,
    pricing: {
      currency: "USD",
      pricingVersion: "2026-07",
      updatedAt: NOW,
      inputMicrosPerMillionTokens: 1_000_000n,
      outputMicrosPerMillionTokens: 2_000_000n,
    },
    budgets: [],
  });
}

function offlinePreflight() {
  return runGenerationPreflight({
    now: NOW,
    migrationReady: true,
    chapterExists: true,
    chapterSaved: true,
    projectWritable: true,
    gatewayAvailable: true,
    networkAvailable: false,
    providerLocation: "remote",
    routeResolved: true,
    profileConfigured: true,
    modelSelected: true,
    credentialConfigured: true,
    connectionStatus: "not_checked",
    selectedModelAvailable: true,
    inputBytes: 12_000,
    maximumInputBytes: 1_000_000,
    inputTokens: 4_000,
    maximumOutputTokens: 2_000,
    contextWindowTokens: 16_000,
    pricing: {
      currency: "USD",
      pricingVersion: "2026-07",
      updatedAt: NOW,
      inputMicrosPerMillionTokens: 1_000_000n,
      outputMicrosPerMillionTokens: 2_000_000n,
    },
    budgets: [],
  });
}

function unpricedPreflight() {
  return runGenerationPreflight({
    ...readyPreflightInput(),
    pricing: null,
    contextWindowTokens: null,
    tokenizerStatus: "approximate",
  });
}

function readyPreflightInput() {
  return {
    now: NOW,
    migrationReady: true,
    chapterExists: true,
    chapterSaved: true,
    projectWritable: true,
    gatewayAvailable: true,
    networkAvailable: true,
    providerLocation: "remote" as const,
    profileConfigured: true,
    modelSelected: true,
    credentialConfigured: true,
    connectionStatus: "verified" as const,
    selectedModelAvailable: true,
    inputBytes: 12_000,
    maximumInputBytes: 1_000_000,
    inputTokens: 4_000,
    maximumOutputTokens: 2_000,
    contextWindowTokens: 16_000,
    pricing: {
      currency: "USD",
      pricingVersion: "2026-07",
      updatedAt: NOW,
      inputMicrosPerMillionTokens: 1_000_000n,
      outputMicrosPerMillionTokens: 2_000_000n,
    },
    budgets: [],
  };
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}
