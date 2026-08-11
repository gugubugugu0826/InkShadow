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
      hydrationPhase: "READY",
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
});
