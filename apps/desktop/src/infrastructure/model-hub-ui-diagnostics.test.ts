import { describe, expect, it } from "vitest";

import {
  ModelHubOperationCoordinator,
  createInitialModelHubPageSnapshot,
} from "./model-hub-page-hydration";
import {
  finishModelHubDiagnosticAction,
  readSafeModelHubSessionDiagnostics,
  recordModelHubUiSnapshot,
  startModelHubDiagnosticAction,
} from "./model-hub-ui-diagnostics";

describe("safe Model Hub UI diagnostics", () => {
  it("preserves bootstrap start when the production effect order records the initial snapshot second", () => {
    const owner = {};
    const coordinator = new ModelHubOperationCoordinator();
    const initial = createInitialModelHubPageSnapshot();
    const bootstrap = coordinator.begin("bootstrap");

    startModelHubDiagnosticAction(owner, bootstrap, "2026-08-10T00:00:00.000Z");
    recordModelHubUiSnapshot(owner, initial, "2026-08-10T00:00:00.010Z");

    expect(
      readSafeModelHubSessionDiagnostics(owner, "2026-08-10T00:00:00.020Z").modelHubUiSnapshot,
    ).toMatchObject({
      pageMountedAt: "2026-08-10T00:00:00.010Z",
      hydrationPhase: "UNINITIALIZED",
      hydrationStartedAt: "2026-08-10T00:00:00.000Z",
      hydrationCompletedAt: null,
    });
  });

  it("starts a fresh timeline when a new mount bootstrap precedes its initial snapshot", () => {
    const owner = {};
    const firstMount = new ModelHubOperationCoordinator();
    const firstInitial = createInitialModelHubPageSnapshot();
    const firstBootstrap = firstMount.begin("bootstrap");
    startModelHubDiagnosticAction(owner, firstBootstrap, "2026-08-10T00:00:00.000Z");
    recordModelHubUiSnapshot(owner, firstInitial, "2026-08-10T00:00:00.010Z");
    recordModelHubUiSnapshot(
      owner,
      {
        ...firstInitial,
        phase: "READY",
        lastAction: "bootstrap",
        hydratedAt: "2026-08-10T00:00:01.000Z",
        snapshotRevision: 1,
      },
      "2026-08-10T00:00:01.000Z",
    );

    const secondMount = new ModelHubOperationCoordinator();
    const secondInitial = createInitialModelHubPageSnapshot();
    const secondBootstrap = secondMount.begin("bootstrap");
    startModelHubDiagnosticAction(owner, secondBootstrap, "2026-08-10T00:01:00.000Z");
    recordModelHubUiSnapshot(owner, secondInitial, "2026-08-10T00:01:00.010Z");

    expect(
      readSafeModelHubSessionDiagnostics(owner, "2026-08-10T00:01:00.020Z").modelHubUiSnapshot,
    ).toMatchObject({
      pageMountedAt: "2026-08-10T00:01:00.010Z",
      hydrationPhase: "UNINITIALIZED",
      phaseStartedAt: "2026-08-10T00:01:00.010Z",
      hydrationStartedAt: "2026-08-10T00:01:00.000Z",
      hydrationCompletedAt: null,
    });
  });

  it("records hydration and stale operations without credentials or content", () => {
    const owner = {};
    const coordinator = new ModelHubOperationCoordinator();
    const token = coordinator.begin("discover_models", {
      providerKind: "deepseek",
      connectionId: "deepseek",
      modelId: "deepseek-model",
    });
    startModelHubDiagnosticAction(owner, token, "2026-08-10T00:00:00.000Z");
    finishModelHubDiagnosticAction(owner, token, {
      completedAt: "2026-08-10T00:00:01.000Z",
      outcome: "stale_ignored",
      staleResultIgnored: true,
      errorCode: "MODEL_HUB_STALE_RESULT_IGNORED",
      catalogCount: 2,
    });
    recordModelHubUiSnapshot(
      owner,
      {
        ...createInitialModelHubPageSnapshot(),
        phase: "READY",
        providerKind: "deepseek",
        selectedConnectionId: "deepseek",
        credentialStatus: "configured",
        catalogStatus: "ready",
        selectedModelId: "deepseek-model",
        hydratedAt: "2026-08-10T00:00:01.000Z",
        snapshotRevision: 2,
      },
      "2026-08-10T00:00:01.000Z",
    );

    const diagnostic = readSafeModelHubSessionDiagnostics(owner, "2026-08-10T00:00:02.000Z");

    expect(diagnostic.modelHubUiSnapshot).toMatchObject({
      pageMounted: true,
      pageMountedAt: "2026-08-10T00:00:01.000Z",
      hydrationPhase: "READY",
      phaseStartedAt: "2026-08-10T00:00:01.000Z",
      hydrationStartedAt: null,
      credentialUiStatus: "configured",
      catalogUiStatus: "ready",
      selectedConnectionId: "deepseek",
      selectedModelIdInUi: "deepseek-model",
      lastSnapshotRevision: 2,
    });
    expect(diagnostic.recentModelHubActions).toEqual([
      expect.objectContaining({
        action: "discover_models",
        outcome: "stale_ignored",
        staleResultIgnored: true,
        catalogCount: 2,
      }),
    ]);
    expect(diagnostic.currentSessionErrorCodes).toEqual(["MODEL_HUB_STALE_RESULT_IGNORED"]);
    expect(JSON.stringify(diagnostic)).not.toContain("apiKey");
    expect(JSON.stringify(diagnostic)).not.toContain("Authorization");
    expect(JSON.stringify(diagnostic)).not.toContain("prompt");
  });

  it("keeps a new mount bootstrap distinct when the old mount finishes late", () => {
    const owner = {};
    const firstMount = new ModelHubOperationCoordinator();
    const secondMount = new ModelHubOperationCoordinator();
    const firstInitial = createInitialModelHubPageSnapshot();
    recordModelHubUiSnapshot(owner, firstInitial, "2026-08-10T00:00:00.000Z");
    const firstBootstrap = firstMount.begin("bootstrap");
    startModelHubDiagnosticAction(owner, firstBootstrap, "2026-08-10T00:00:01.000Z");

    const secondInitial = createInitialModelHubPageSnapshot();
    recordModelHubUiSnapshot(owner, secondInitial, "2026-08-10T00:00:02.000Z");
    const secondBootstrap = secondMount.begin("bootstrap");
    startModelHubDiagnosticAction(owner, secondBootstrap, "2026-08-10T00:00:03.000Z");
    recordModelHubUiSnapshot(
      owner,
      {
        ...secondInitial,
        phase: "BOOTSTRAPPING",
        lastAction: "bootstrap",
      },
      "2026-08-10T00:00:03.000Z",
    );
    finishModelHubDiagnosticAction(owner, secondBootstrap, {
      completedAt: "2026-08-10T00:00:04.000Z",
      outcome: "succeeded",
      storeRefreshed: true,
    });
    recordModelHubUiSnapshot(
      owner,
      {
        ...secondInitial,
        phase: "READY",
        lastAction: "bootstrap",
        hydratedAt: "2026-08-10T00:00:04.000Z",
        snapshotRevision: 1,
      },
      "2026-08-10T00:00:04.000Z",
    );

    finishModelHubDiagnosticAction(owner, firstBootstrap, {
      completedAt: "2026-08-10T00:00:05.000Z",
      outcome: "stale_ignored",
      staleResultIgnored: true,
    });

    const diagnostic = readSafeModelHubSessionDiagnostics(owner, "2026-08-10T00:00:06.000Z");
    expect(firstBootstrap.operationId).not.toBe(secondBootstrap.operationId);
    expect(diagnostic.modelHubUiSnapshot).toMatchObject({
      pageMountedAt: "2026-08-10T00:00:02.000Z",
      hydrationPhase: "READY",
      phaseStartedAt: "2026-08-10T00:00:04.000Z",
      hydrationStartedAt: "2026-08-10T00:00:03.000Z",
      hydrationCompletedAt: "2026-08-10T00:00:04.000Z",
    });
    expect(diagnostic.recentModelHubActions).toHaveLength(2);
    expect(
      diagnostic.recentModelHubActions.find(
        ({ operationId }) => operationId === secondBootstrap.operationId,
      ),
    ).toMatchObject({ outcome: "succeeded", storeRefreshed: true });
    expect(
      diagnostic.recentModelHubActions.find(
        ({ operationId }) => operationId === firstBootstrap.operationId,
      ),
    ).toMatchObject({ outcome: "stale_ignored", staleResultIgnored: true });
  });
});
