import { describe, expect, it, vi } from "vitest";

import type { NovelSkillPaidEvaluationCoordinatorPort } from "./novel-skill-paid-evaluation-coordinator";
import {
  createLazyNovelSkillPaidEvaluationCoordinator,
  createUnavailableNovelSkillPaidEvaluationCoordinator,
} from "./novel-skill-paid-evaluation-lazy-coordinator";
import type { NovelSkillPaidEvaluationRuntimeSnapshot } from "./novel-skill-paid-evaluation-runtime";

const EMPTY: NovelSkillPaidEvaluationRuntimeSnapshot = Object.freeze({
  phase: "not_prepared",
  runId: null,
  quote: null,
  authorizationId: null,
  completedProviderCalls: 0,
  sealedManualScores: 0,
  blindItem: null,
});

describe("lazy paid-evaluation coordinator", () => {
  it("exposes a synchronous local port without loading the Tauri factory", () => {
    const factory = vi.fn<() => Promise<NovelSkillPaidEvaluationCoordinatorPort>>();
    const coordinator = createLazyNovelSkillPaidEvaluationCoordinator(factory);

    expect(coordinator.getSnapshot()).toEqual(EMPTY);
    expect(coordinator.getRecoverableRuns()).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("loads the factory once, awaits initialization, and performs no provider action", async () => {
    const delegate = createDelegate();
    const factory = vi.fn(() => Promise.resolve(delegate.port));
    const coordinator = createLazyNovelSkillPaidEvaluationCoordinator(factory);

    const [first, second] = await Promise.all([coordinator.initialize(), coordinator.initialize()]);
    const prepared = await coordinator.prepareAndQuote({ exactTargetIds: ["model-a", "model-b"] });

    expect(first).toEqual(EMPTY);
    expect(second).toEqual(EMPTY);
    expect(prepared.phase).toBe("awaiting_authorization");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(delegate.initialize).toHaveBeenCalledTimes(2);
    expect(delegate.prepareAndQuote).toHaveBeenCalledTimes(1);
    expect(delegate.startAuthorizedRun).not.toHaveBeenCalled();
  });

  it("isolates a failed dynamic load and permits a local retry", async () => {
    const delegate = createDelegate();
    const factory = vi
      .fn<() => Promise<NovelSkillPaidEvaluationCoordinatorPort>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValue(delegate.port);
    const coordinator = createLazyNovelSkillPaidEvaluationCoordinator(factory);

    const failed = await coordinator.initialize();
    const recovered = await coordinator.initialize();

    expect(failed.phase).toBe("unavailable");
    expect(failed.unavailableReason).toContain("基础写作仍可使用");
    expect(recovered.phase).toBe("not_prepared");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(delegate.startAuthorizedRun).not.toHaveBeenCalled();
  });

  it("keeps the browser port unavailable without dispatching or reporting progress", async () => {
    const progress = vi.fn();
    const coordinator =
      createUnavailableNovelSkillPaidEvaluationCoordinator("仅桌面原生模式可用。");

    const initialized = await coordinator.initialize();
    const prepared = await coordinator.prepareAndQuote({ exactTargetIds: ["model-a", "model-b"] });
    const started = await coordinator.startAuthorizedRun({
      runId: "run-1",
      authorizationId: "authorization-1",
      onProgress: progress,
    });

    expect(initialized.phase).toBe("unavailable");
    expect(prepared).toBe(initialized);
    expect(started).toBe(initialized);
    expect(progress).not.toHaveBeenCalled();
  });
});

function createDelegate(): Readonly<{
  port: NovelSkillPaidEvaluationCoordinatorPort;
  initialize: ReturnType<typeof vi.fn>;
  prepareAndQuote: ReturnType<typeof vi.fn>;
  startAuthorizedRun: ReturnType<typeof vi.fn>;
}> {
  let snapshot = EMPTY;
  const initialize = vi.fn(() => Promise.resolve(snapshot));
  const prepareAndQuote = vi.fn(() => {
    snapshot = Object.freeze({
      ...EMPTY,
      phase: "awaiting_authorization",
      runId: "run-1",
      quote: {
        quoteId: "quote-1",
        exactTargetIds: ["model-a", "model-b"] as const,
        currencies: Object.freeze([]),
      },
    });
    return Promise.resolve(snapshot);
  });
  const startAuthorizedRun = vi.fn(() => Promise.resolve(snapshot));
  const port: NovelSkillPaidEvaluationCoordinatorPort = {
    initialize,
    getSnapshot: () => snapshot,
    getRecoverableRuns: () => Object.freeze([]),
    prepareAndQuote,
    authorizeCommercialRun: () => Promise.resolve(snapshot),
    startAuthorizedRun,
    cancelRun: () => Promise.resolve(snapshot),
    beginBlindReview: () => Promise.resolve(snapshot),
    sealBlindScores: () => Promise.resolve(snapshot),
  };
  return Object.freeze({ port, initialize, prepareAndQuote, startAuthorizedRun });
}
