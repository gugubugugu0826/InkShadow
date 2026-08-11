import type { ModelCatalogEntry, ModelProviderConnection } from "./model-hub-store";
import type { IsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import {
  ModelHubExactEvaluationError,
  hashModelHubExactEvaluationRequestProfile,
  type ModelHubExactEvaluationDependencies,
  type ModelHubExactEvaluationInspection,
} from "./model-hub-exact-evaluation-target";
import {
  NOVEL_SKILL_PAID_EVALUATION_MAXIMUM_OUTPUT_TOKENS,
  NovelSkillPaidEvaluationPreparation,
  NovelSkillPaidEvaluationPreparationError,
  createNovelSkillPaidEvaluationProtocolContract,
  hashNovelSkillPaidEvaluationPersistedProtocol,
  listNovelSkillPaidEvaluationPreferenceSources,
  novelSkillPaidEvaluationArchivedProjectIdentity,
  type ArchivedEvaluationProjectSnapshot,
  type NovelSkillPaidEvaluationArchivedProjectIdentity,
  type NovelSkillPaidEvaluationPreparationOptions,
} from "./novel-skill-paid-evaluation-preparation";
import type {
  NovelSkillPaidEvaluationControlSnapshot,
  NovelSkillPaidEvaluationControlTarget,
} from "./novel-skill-paid-evaluation-control-sqlite-store";

import type { NativeModelGenerationInput, NativeModelGenerationResult } from "./runtime";

const NOW = "2026-08-11T00:00:00.000Z" as IsoUtcTimestamp;
const RUN_ID = "019f9f4a-b3c7-7350-8000-000000000201";
const SECOND_RUN_ID = "019f9f4a-b3c7-7350-8000-000000000202";
const TARGET_IDS = ["catalog-a", "catalog-b"] as const;

describe("NovelSkillPaidEvaluationPreparation", () => {
  it("prepares the code-owned 12 x 4 x 2 x 2 protocol and exact targets without generating", async () => {
    const harness = await createHarness();

    await harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS });

    expect(harness.calls.suite).toHaveLength(1);
    expect(harness.calls.suite[0]?.plan.cells).toHaveLength(192);
    expect(harness.calls.suite[0]?.manifests.core.length).toBeGreaterThan(0);
    expect(harness.calls.protocol).toHaveLength(1);
    expect(harness.calls.protocol[0]?.requestProfiles).toHaveLength(10);
    expect(harness.calls.protocol[0]?.contextBaselines).toHaveLength(12);
    expect(
      harness.calls.protocol[0]?.requestProfiles.every(
        ({ maximumOutputTokens }) =>
          maximumOutputTokens === NOVEL_SKILL_PAID_EVALUATION_MAXIMUM_OUTPUT_TOKENS,
      ),
    ).toBe(true);
    expect(harness.calls.run[0]?.modelAssignments).toHaveLength(2);
    expect(
      new Set(
        harness.calls.run[0]?.modelAssignments.map(({ modelArtifactHash }) => modelArtifactHash),
      ),
    ).toHaveProperty("size", 2);
    expect(harness.calls.boundTargets).toHaveLength(1);
    expect(harness.inspect).toHaveBeenCalledTimes(2);
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.calls.protocol[0]?.rubricContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(harness.calls.protocol[0]?.evaluatorContractHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is idempotent for the same persisted run and exact targets", async () => {
    const harness = await createHarness();

    await harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS });
    await harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS });

    expect(harness.calls.suite).toHaveLength(1);
    expect(harness.calls.protocol).toHaveLength(1);
    expect(harness.calls.run).toHaveLength(1);
    expect(harness.calls.boundTargets).toHaveLength(1);
    expect(harness.inspect).toHaveBeenCalledTimes(4);
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it.each(["suite", "protocol", "run", "targets"] as const)(
    "resumes exact local preparation after a crash at the %s transaction boundary",
    async (failAfter) => {
      const harness = await createHarness({
        failAfter,
        clockTimes: [NOW, "2026-08-11T00:05:00.000Z" as IsoUtcTimestamp],
      });

      await expect(
        harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS }),
      ).rejects.toThrow(`simulated crash after ${failAfter}`);
      await harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS });

      expect(harness.calls.suite).toHaveLength(1);
      expect(harness.calls.protocol).toHaveLength(1);
      expect(harness.calls.run).toHaveLength(1);
      expect(harness.calls.boundTargets).toHaveLength(1);
      expect(harness.state.control).toMatchObject({
        status: "planned",
        protocolConfigured: true,
        exactTargetCount: 2,
        totalCells: 192,
      });
      expect(harness.generate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["not archived", safeProject({ status: "active", archivedAt: null })],
    [
      "not empty",
      safeProject({
        contentCounts: {
          chapters: 1,
          storyFacts: 0,
          projectSeeds: 0,
          planningCandidates: 0,
          writingPreferences: 0,
          settingsReceipts: 0,
          skillBindings: 0,
        },
      }),
    ],
  ])("rejects an evaluation project that is %s", async (_label, project) => {
    const harness = await createHarness({ project });

    await expect(
      harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS }),
    ).rejects.toMatchObject({
      code: "NOVEL_SKILL_PAID_PREPARATION_PROJECT_UNSAFE",
    });

    expect(harness.calls.suite).toHaveLength(0);
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("rejects selecting the same exact target twice before any local or provider work", async () => {
    const harness = await createHarness();

    await expect(
      harness.preparation.preparePersistedRun({
        runId: RUN_ID,
        exactTargetIds: [TARGET_IDS[0], TARGET_IDS[0]],
      }),
    ).rejects.toMatchObject({
      code: "NOVEL_SKILL_PAID_PREPARATION_INVALID",
    });

    expect(harness.inspect).not.toHaveBeenCalled();
    expect(harness.project).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "not ready",
      new ModelHubExactEvaluationError(
        "MODEL_HUB_EXACT_EVALUATION_CONNECTION_NOT_READY",
        "not ready",
      ),
    ],
    [
      "missing verified pricing",
      new ModelHubExactEvaluationError(
        "MODEL_HUB_EXACT_EVALUATION_COST_UNVERIFIED",
        "missing pricing",
      ),
    ],
  ])(
    "rejects an exact target that is %s and makes zero generation calls",
    async (_label, error) => {
      const harness = await createHarness({ inspectionError: error });

      await expect(
        harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS }),
      ).rejects.toBe(error);

      expect(harness.calls.suite).toHaveLength(0);
      expect(harness.project).not.toHaveBeenCalled();
      expect(harness.generate).not.toHaveBeenCalled();
    },
  );

  it("fails closed when a persisted run's canonical protocol drifts", async () => {
    const harness = await createHarness();
    await harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS });
    harness.state.protocolHash = "f".repeat(64);

    await expect(
      harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS }),
    ).rejects.toMatchObject({
      code: "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
    });

    expect(harness.calls.suite).toHaveLength(1);
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("fails closed when the same run is requested with a different slot-to-target order", async () => {
    const harness = await createHarness();
    await harness.preparation.preparePersistedRun({ runId: RUN_ID, exactTargetIds: TARGET_IDS });

    await expect(
      harness.preparation.preparePersistedRun({
        runId: RUN_ID,
        exactTargetIds: [TARGET_IDS[1], TARGET_IDS[0]],
      }),
    ).rejects.toMatchObject({
      code: "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
    });

    expect(harness.calls.suite).toHaveLength(1);
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("derives stable canonical rubric, evaluator, blinding and randomization hashes", async () => {
    const first = await createNovelSkillPaidEvaluationProtocolContract();
    const second = await createNovelSkillPaidEvaluationProtocolContract();

    expect(first).toEqual(second);
    expect(first.contractHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.rubricContentHash).not.toBe(first.evaluatorContractHash);
    expect(first.blindingProtocolHash).not.toBe(first.randomizationProtocolHash);
    expect(first.requestProfiles).toHaveLength(10);
    expect(first.contextBaselines).toHaveLength(12);
    expect(listNovelSkillPaidEvaluationPreferenceSources()).toHaveLength(4);
    expect(Object.isFrozen(listNovelSkillPaidEvaluationPreferenceSources())).toBe(true);
    expect(first.preferenceConfigurationHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("derives one stable, run-unique and recognizable archived-project identity", async () => {
    const first = await novelSkillPaidEvaluationArchivedProjectIdentity(RUN_ID);
    const repeated = await novelSkillPaidEvaluationArchivedProjectIdentity(RUN_ID);
    const other = await novelSkillPaidEvaluationArchivedProjectIdentity(SECOND_RUN_ID);

    expect(first).toEqual(repeated);
    expect(first.projectId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.displayName).toContain(RUN_ID);
    expect(other.projectId).not.toBe(first.projectId);
    expect(other.displayName).not.toBe(first.displayName);
  });
});

interface HarnessState {
  control: NovelSkillPaidEvaluationControlSnapshot | null;
  targets: readonly NovelSkillPaidEvaluationControlTarget[];
  protocolHash: string;
  suiteAuthority: unknown;
  protocolAuthority: unknown;
  runAuthority: unknown;
  targetAuthority: unknown;
}

async function createHarness(
  overrides: Readonly<{
    project?: ArchivedEvaluationProjectSnapshot;
    inspectionError?: Error;
    failAfter?: "suite" | "protocol" | "run" | "targets";
    clockTimes?: readonly IsoUtcTimestamp[];
  }> = {},
) {
  const contract = await createNovelSkillPaidEvaluationProtocolContract();
  const calls: {
    suite: Parameters<
      NovelSkillPaidEvaluationPreparationOptions["evaluationStore"]["createSuite"]
    >[0][];
    protocol: Parameters<
      NovelSkillPaidEvaluationPreparationOptions["paidStore"]["createExecutionProtocol"]
    >[0][];
    run: Parameters<
      NovelSkillPaidEvaluationPreparationOptions["evaluationStore"]["createRun"]
    >[0][];
    boundTargets: Parameters<
      NovelSkillPaidEvaluationPreparationOptions["paidStore"]["bindExactModelTargets"]
    >[1][];
  } = { suite: [], protocol: [], run: [], boundTargets: [] };
  const state: HarnessState = {
    control: null,
    targets: [],
    protocolHash: "",
    suiteAuthority: null,
    protocolAuthority: null,
    runAuthority: null,
    targetAuthority: null,
  };
  let pendingCrash = overrides.failAfter;
  let clockIndex = 0;
  const maybeCrash = (step: NonNullable<typeof overrides.failAfter>): void => {
    if (pendingCrash !== step) return;
    pendingCrash = undefined;
    throw new Error(`simulated crash after ${step}`);
  };
  const assertReplay = (previous: unknown, next: unknown): boolean => {
    if (previous === null) return false;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new NovelSkillPaidEvaluationPreparationError(
        "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
        "strict fake Store detected canonical authority drift",
      );
    }
    return true;
  };
  const generate = vi.fn(
    (input: NativeModelGenerationInput): Promise<NativeModelGenerationResult> => {
      void input;
      return Promise.reject(new Error("generate must not be called during preparation"));
    },
  );
  const dependencies = exactDependencies(generate);
  const inspect = vi.fn(
    async (
      _dependencies: ModelHubExactEvaluationDependencies,
      input: Parameters<
        NonNullable<NovelSkillPaidEvaluationPreparationOptions["exactTargetPort"]>["inspect"]
      >[1],
    ) => {
      if (overrides.inspectionError !== undefined) throw overrides.inspectionError;
      return inspection(
        input.target,
        input.requestProfile,
        input.target.catalogEntryId.endsWith("a") ? "a" : "b",
      );
    },
  );
  const project = vi.fn((identity: NovelSkillPaidEvaluationArchivedProjectIdentity) =>
    Promise.resolve(overrides.project ?? safeProject(identity)),
  );
  const options: NovelSkillPaidEvaluationPreparationOptions = {
    clock: {
      now: () => {
        const value = overrides.clockTimes?.[clockIndex] ?? overrides.clockTimes?.at(-1) ?? NOW;
        clockIndex += 1;
        return value;
      },
    },
    evaluationStore: {
      createSuite: (input) => {
        if (assertReplay(state.suiteAuthority, input)) return Promise.resolve();
        state.suiteAuthority = structuredClone(input);
        calls.suite.push(input);
        maybeCrash("suite");
        return Promise.resolve();
      },
      createRun: (input) => {
        if (assertReplay(state.runAuthority, input)) return Promise.resolve();
        state.runAuthority = structuredClone(input);
        calls.run.push(input);
        state.control = {
          ...controlSnapshot(input.runId, input.suiteId),
          exactTargetCount: 0,
        };
        maybeCrash("run");
        return Promise.resolve();
      },
    },
    paidStore: {
      createExecutionProtocol: async (input) => {
        const expectedHash = await hashNovelSkillPaidEvaluationPersistedProtocol(
          input.suiteId,
          contract,
        );
        if (assertReplay(state.protocolAuthority, input)) {
          if (state.protocolHash !== expectedHash) {
            throw new NovelSkillPaidEvaluationPreparationError(
              "NOVEL_SKILL_PAID_PREPARATION_AUTHORITY_CHANGED",
              "strict fake Store detected persisted protocol drift",
            );
          }
        } else {
          state.protocolAuthority = structuredClone(input);
          calls.protocol.push(input);
          state.protocolHash = expectedHash;
          maybeCrash("protocol");
        }
        return {
          suiteId: input.suiteId,
          protocolHash: state.protocolHash,
          requestProfileManifestHash: "1".repeat(64),
          contextBaselineManifestHash: "2".repeat(64),
          promptTemplateHash: input.promptTemplateHash,
          rubricContentHash: input.rubricContentHash,
        };
      },
      bindExactModelTargets: (runId, targets) => {
        const authority = { runId, targets };
        if (assertReplay(state.targetAuthority, authority)) {
          return Promise.resolve(
            targets.map(({ modelSlotId, inspection: value }) => ({
              runId,
              modelSlotId,
              connectionId: value.target.connectionId,
              catalogEntryId: value.target.catalogEntryId,
              providerKind: value.target.providerKind,
              providerModelId: value.target.modelId,
              modelIdentityHash: modelSlotId === "text_tier_a" ? "3".repeat(64) : "4".repeat(64),
              modelArtifactHash: modelSlotId === "text_tier_a" ? "5".repeat(64) : "6".repeat(64),
              targetHash: value.target.targetIdentityHash,
              pricingSnapshotHash: value.target.costProfileHash,
              currency: value.pricing.currency,
            })),
          );
        }
        state.targetAuthority = structuredClone(authority);
        calls.boundTargets.push(targets);
        state.targets = targets.map(({ modelSlotId, inspection: value }) =>
          controlTarget(runId, modelSlotId, value),
        );
        const suiteId = calls.suite[0]?.suiteId ?? "";
        state.control = controlSnapshot(runId, suiteId);
        maybeCrash("targets");
        return Promise.resolve(
          targets.map(({ modelSlotId, inspection: value }) => ({
            runId,
            modelSlotId,
            connectionId: value.target.connectionId,
            catalogEntryId: value.target.catalogEntryId,
            providerKind: value.target.providerKind,
            providerModelId: value.target.modelId,
            modelIdentityHash: modelSlotId === "text_tier_a" ? "3".repeat(64) : "4".repeat(64),
            modelArtifactHash: modelSlotId === "text_tier_a" ? "5".repeat(64) : "6".repeat(64),
            targetHash: value.target.targetIdentityHash,
            pricingSnapshotHash: value.target.costProfileHash,
            currency: value.pricing.currency,
          })),
        );
      },
      quoteCommercialRun: (runId) =>
        Promise.resolve({
          runId,
          protocolHash: state.protocolHash,
          targetManifestHash: "7".repeat(64),
          pricingManifestHash: "8".repeat(64),
          quoteHash: "9".repeat(64),
          authorizedCallCount: 192,
          currencies: Object.freeze([
            Object.freeze({ currency: "USD", estimatedMaximumCostMicros: "100000" }),
          ]),
        }),
    },
    controlStore: {
      getControlSnapshot: () => Promise.resolve(state.control),
      listTargets: () => Promise.resolve(state.targets),
    },
    archivedProjectPort: { ensureDedicatedArchivedEmptyProject: project },
    exactTargetDependencies: dependencies,
    exactTargetPort: { inspect },
  };
  return {
    preparation: new NovelSkillPaidEvaluationPreparation(options),
    calls,
    state,
    inspect,
    project,
    generate,
  };
}

function safeProject(
  overrides: Partial<ArchivedEvaluationProjectSnapshot> = {},
): ArchivedEvaluationProjectSnapshot {
  const identity = {
    projectId: overrides.projectId ?? "019f9f4a-b3c7-7350-8000-000000000299",
    displayName: overrides.displayName ?? "unsafe-project-placeholder",
    ownerRunId: overrides.ownerRunId ?? RUN_ID,
  };
  return {
    projectId: identity.projectId,
    displayName: identity.displayName,
    purpose: "novel_skill_paid_evaluation",
    ownerRunId: identity.ownerRunId,
    status: "archived",
    archivedAt: NOW,
    trashedAt: null,
    contentCounts: {
      chapters: 0,
      storyFacts: 0,
      projectSeeds: 0,
      planningCandidates: 0,
      writingPreferences: 0,
      settingsReceipts: 0,
      skillBindings: 0,
    },
    ...overrides,
  };
}

function exactDependencies(
  generate: ModelHubExactEvaluationDependencies["modelGateway"]["generate"],
): NovelSkillPaidEvaluationPreparationOptions["exactTargetDependencies"] {
  const connections = new Map(
    ["a", "b"].map((suffix) => [
      `connection-${suffix}`,
      { id: `connection-${suffix}`, providerKind: "deepseek" } as ModelProviderConnection,
    ]),
  );
  const catalog = new Map(
    ["a", "b"].map((suffix) => [
      `connection-${suffix}`,
      [
        {
          id: `catalog-${suffix}`,
          connectionId: `connection-${suffix}`,
          providerModelId: `model-${suffix}`,
        } as ModelCatalogEntry,
      ],
    ]),
  );
  return {
    modelHub: {
      listConnections: () => Promise.resolve([...connections.values()]),
      findConnection: (connectionId) => Promise.resolve(connections.get(connectionId) ?? null),
      listCatalog: (connectionId) => Promise.resolve(catalog.get(connectionId) ?? []),
      listCapabilityEvidence: () => Promise.resolve([]),
      findCostPrivacyProfile: () => Promise.resolve(null),
    },
    modelGateway: { available: true, generate },
    credentials: { getSummary: () => Promise.resolve({ configured: true }) },
    clock: { now: () => NOW },
  };
}

async function inspection(
  target: Parameters<
    NonNullable<NovelSkillPaidEvaluationPreparationOptions["exactTargetPort"]>["inspect"]
  >[1]["target"],
  requestProfile: Parameters<
    NonNullable<NovelSkillPaidEvaluationPreparationOptions["exactTargetPort"]>["inspect"]
  >[1]["requestProfile"],
  suffix: "a" | "b",
): Promise<ModelHubExactEvaluationInspection> {
  const requestProfileHash = await hashModelHubExactEvaluationRequestProfile(requestProfile);
  return {
    target: {
      ...target,
      connectionRevision: 1,
      catalogRevision: 1,
      costPrivacyRevision: 1,
      capabilityEvidenceHash: suffix.repeat(64),
      costProfileHash: suffix === "a" ? "c".repeat(64) : "d".repeat(64),
      targetIdentityHash: suffix === "a" ? "e".repeat(64) : "f".repeat(64),
    },
    requestProfile,
    requestProfileHash,
    messagePayloadHash: "1".repeat(64),
    payloadHash: suffix === "a" ? "2".repeat(64) : "3".repeat(64),
    executionLockHash: suffix === "a" ? "4".repeat(64) : "5".repeat(64),
    requiredCapabilities: ["text_generation"],
    dataDestination: "remote",
    estimatedInputTokens: 100,
    estimatedTotalTokens: 100 + requestProfile.maximumOutputTokens,
    inputTokenLimit: 64_000,
    outputTokenLimit: 8_192,
    pricing: {
      currency: "USD",
      estimatedMaximumCostMicros: "50000",
      pricingVersion: "2026-08-11",
      priceUpdatedAt: NOW,
      evidenceSource: "user_confirmed",
      evidenceVersion: "v1",
      evidenceUpdatedAt: NOW,
    },
  };
}

function controlSnapshot(runId: string, suiteId: string): NovelSkillPaidEvaluationControlSnapshot {
  return {
    runId,
    suiteId,
    status: "planned",
    evaluationStatus: "NOT_EVALUATED",
    revision: 1,
    protocolConfigured: true,
    exactTargetCount: 2,
    authorizationId: null,
    authorizedCallCount: null,
    totalCells: 192,
    observedCells: 0,
    observationCount: 0,
    reservationCounts: {
      reserved: 0,
      bound: 0,
      dispatched: 0,
      settled: 0,
      ambiguous: 0,
      notDispatched: 0,
    },
    authoritySnapshotCount: 0,
    missingAuthoritySnapshotCount: 0,
    successfulSettlements: 0,
    blindItemCount: 0,
    blindReceiptCount: 0,
    sealedScoreCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: NOW,
  };
}

function controlTarget(
  runId: string,
  modelSlotId: "text_tier_a" | "text_tier_b",
  value: ModelHubExactEvaluationInspection,
): NovelSkillPaidEvaluationControlTarget {
  return {
    runId,
    modelSlotId,
    connectionId: value.target.connectionId,
    catalogEntryId: value.target.catalogEntryId,
    providerKind: value.target.providerKind,
    connectionProtocol: "openai_compatible",
    connectionRevision: value.target.connectionRevision,
    catalogRevision: value.target.catalogRevision,
    providerModelId: value.target.modelId,
    modelIdentityHash: modelSlotId === "text_tier_a" ? "3".repeat(64) : "4".repeat(64),
    modelArtifactHash: modelSlotId === "text_tier_a" ? "5".repeat(64) : "6".repeat(64),
    targetHash: value.target.targetIdentityHash,
    currency: value.pricing.currency,
    inputMicrosPerMillionTokens: "1000",
    outputMicrosPerMillionTokens: "2000",
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: value.pricing.pricingVersion,
    pricingSnapshotHash: value.target.costProfileHash,
  };
}
