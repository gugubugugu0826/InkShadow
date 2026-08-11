/* eslint-disable @typescript-eslint/require-await -- synchronous in-memory test ports */
import { describe, expect, it, vi } from "vitest";

import type { NovelSkillPaidEvaluationRecoverableRun } from "./novel-skill-paid-evaluation-control-sqlite-store";
import {
  NovelSkillPaidEvaluationCoordinator,
  type NovelSkillPaidEvaluationCoordinatorOptions,
} from "./novel-skill-paid-evaluation-coordinator";
import type {
  NovelSkillPaidEvaluationRuntime,
  NovelSkillPaidEvaluationRuntimeSnapshot,
} from "./novel-skill-paid-evaluation-runtime";

const RUN_A = "019f9f4a-b3c7-7350-9226-066f57e1e2a3";
const RUN_B = "019f9f4a-b3c7-7350-9226-066f57e1e2a4";
const AUTHORIZATION = "019f9f4a-b3c7-7350-9226-066f57e1e2a5";

function snapshot(
  phase: NovelSkillPaidEvaluationRuntimeSnapshot["phase"],
  runId: string | null,
): NovelSkillPaidEvaluationRuntimeSnapshot {
  return Object.freeze({
    phase,
    runId,
    quote:
      phase === "awaiting_authorization" || phase === "authorized_not_started"
        ? {
            quoteId: "a".repeat(64),
            exactTargetIds: ["catalog-a", "catalog-b"] as const,
            currencies: [{ currencyCode: "USD", estimatedCostMicros: 100, hardCeilingMicros: 120 }],
          }
        : null,
    authorizationId: phase === "authorized_not_started" ? AUTHORIZATION : null,
    completedProviderCalls: phase === "running_waiting" ? 1 : 0,
    sealedManualScores: 0,
    blindItem: null,
  });
}

function recoverable(runId: string): NovelSkillPaidEvaluationRecoverableRun {
  return {
    runId,
    status: "planned",
    revision: 1,
    authorizationId: null,
    authorizedCallCount: null,
    completedProviderCalls: 0,
    observationCount: 0,
    blindReceiptCount: 0,
    reservationCounts: {
      reserved: 0,
      bound: 0,
      dispatched: 0,
      settled: 0,
      ambiguous: 0,
      notDispatched: 0,
    },
    recoveryKind: "preflight_or_authorization",
    requiresManualDispatchDecision: false,
    startedAt: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function runtimeFixture(runId: string) {
  const initialize = vi.fn(async () => snapshot("awaiting_authorization", runId));
  const recoverAfterRestart = vi.fn(async () => snapshot("awaiting_authorization", runId));
  const prepareAndQuote = vi.fn(async () => snapshot("awaiting_authorization", runId));
  const authorizeCommercialRun = vi.fn(async () => snapshot("authorized_not_started", runId));
  const startAuthorizedRun = vi.fn(
    async (input: {
      readonly onProgress: (value: NovelSkillPaidEvaluationRuntimeSnapshot) => void;
    }) => {
      const progress = snapshot("running_waiting", runId);
      input.onProgress(progress);
      return progress;
    },
  );
  const cancelRun = vi.fn(async () => snapshot("invalidated_ambiguous", runId));
  const beginBlindReview = vi.fn(async () => snapshot("blind_reviewing", runId));
  const sealBlindScores = vi.fn(async () => snapshot("blind_reviewing", runId));
  const runtime = {
    runId,
    initialize,
    recoverAfterRestart,
    prepareAndQuote,
    authorizeCommercialRun,
    startAuthorizedRun,
    cancelRun,
    beginBlindReview,
    sealBlindScores,
  } as unknown as NovelSkillPaidEvaluationRuntime;
  return {
    runtime,
    spies: {
      initialize,
      recoverAfterRestart,
      prepareAndQuote,
      authorizeCommercialRun,
      startAuthorizedRun,
    },
  };
}

function createOptions(
  runs: readonly NovelSkillPaidEvaluationRecoverableRun[],
): NovelSkillPaidEvaluationCoordinatorOptions & {
  readonly createRuntime: ReturnType<typeof vi.fn>;
  readonly fixtures: Map<string, ReturnType<typeof runtimeFixture>>;
} {
  const fixtures = new Map<string, ReturnType<typeof runtimeFixture>>();
  const createRuntime = vi.fn((runId: string) => {
    const fixture = runtimeFixture(runId);
    fixtures.set(runId, fixture);
    return fixture.runtime;
  });
  return {
    controlStore: { listRecoverableRuns: vi.fn(async () => runs) },
    nextRunId: () => RUN_A,
    createRuntime,
    fixtures,
  };
}

describe("NovelSkillPaidEvaluationCoordinator", () => {
  it("initializes an empty desktop session without creating a runtime or dispatching", async () => {
    const options = createOptions([]);
    const coordinator = new NovelSkillPaidEvaluationCoordinator(options);

    await expect(coordinator.initialize()).resolves.toMatchObject({
      phase: "not_prepared",
      runId: null,
    });
    expect(options.createRuntime).not.toHaveBeenCalled();
  });

  it("recovers the only persisted run locally without starting provider execution", async () => {
    const options = createOptions([recoverable(RUN_A)]);
    const coordinator = new NovelSkillPaidEvaluationCoordinator(options);

    await expect(coordinator.initialize()).resolves.toMatchObject({
      phase: "awaiting_authorization",
      runId: RUN_A,
    });
    const fixture = options.fixtures.get(RUN_A);
    expect(fixture?.spies.initialize).toHaveBeenCalledOnce();
    expect(fixture?.spies.recoverAfterRestart).toHaveBeenCalledOnce();
    expect(fixture?.spies.startAuthorizedRun).not.toHaveBeenCalled();
  });

  it("fails closed when more than one run requires recovery", async () => {
    const options = createOptions([recoverable(RUN_A), recoverable(RUN_B)]);
    const coordinator = new NovelSkillPaidEvaluationCoordinator(options);

    await expect(coordinator.initialize()).resolves.toMatchObject({
      phase: "unavailable",
      runId: null,
    });
    await expect(
      coordinator.prepareAndQuote({ exactTargetIds: ["catalog-a", "catalog-b"] }),
    ).resolves.toMatchObject({ phase: "unavailable" });
    expect(options.createRuntime).not.toHaveBeenCalled();
    expect(coordinator.getRecoverableRuns()).toHaveLength(2);
  });

  it("isolates a paid-recovery failure from the desktop and allows a local retry", async () => {
    const options = createOptions([]);
    const listRecoverableRuns = vi
      .fn<() => Promise<readonly NovelSkillPaidEvaluationRecoverableRun[]>>()
      .mockRejectedValueOnce(new Error("corrupt paid ledger"))
      .mockResolvedValueOnce([]);
    const coordinator = new NovelSkillPaidEvaluationCoordinator({
      ...options,
      controlStore: { listRecoverableRuns },
    });

    const unavailable = await coordinator.initialize();
    expect(unavailable.phase).toBe("unavailable");
    expect(unavailable.unavailableReason).toContain("基础写作仍可使用");
    await expect(coordinator.initialize()).resolves.toMatchObject({
      phase: "not_prepared",
      runId: null,
    });
    expect(options.createRuntime).not.toHaveBeenCalled();
  });

  it("creates a fresh fixed runtime only after explicit preparation", async () => {
    const options = createOptions([]);
    const coordinator = new NovelSkillPaidEvaluationCoordinator(options);
    await coordinator.initialize();

    await coordinator.prepareAndQuote({ exactTargetIds: ["catalog-a", "catalog-b"] });
    await coordinator.authorizeCommercialRun({
      runId: RUN_A,
      quoteId: "a".repeat(64),
      commercialUseAcknowledged: true,
    });

    expect(options.createRuntime).toHaveBeenCalledExactlyOnceWith(RUN_A);
    expect(options.fixtures.get(RUN_A)?.spies.prepareAndQuote).toHaveBeenCalledOnce();
    expect(options.fixtures.get(RUN_A)?.spies.authorizeCommercialRun).toHaveBeenCalledOnce();
    expect(options.fixtures.get(RUN_A)?.spies.startAuthorizedRun).not.toHaveBeenCalled();
  });

  it("delegates the only provider-capable action and captures progress", async () => {
    const options = createOptions([]);
    const coordinator = new NovelSkillPaidEvaluationCoordinator(options);
    await coordinator.prepareAndQuote({ exactTargetIds: ["catalog-a", "catalog-b"] });
    const onProgress = vi.fn();

    await expect(
      coordinator.startAuthorizedRun({
        runId: RUN_A,
        authorizationId: AUTHORIZATION,
        onProgress,
      }),
    ).resolves.toMatchObject({ phase: "running_waiting", completedProviderCalls: 1 });
    expect(options.fixtures.get(RUN_A)?.spies.startAuthorizedRun).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot()).toMatchObject({ phase: "running_waiting" });
  });

  it("rejects actions for a run other than the selected persisted authority", async () => {
    const options = createOptions([recoverable(RUN_A)]);
    const coordinator = new NovelSkillPaidEvaluationCoordinator(options);
    await coordinator.initialize();

    await expect(coordinator.cancelRun({ runId: RUN_B })).rejects.toThrow(
      "does not match the selected persisted run",
    );
  });
});
