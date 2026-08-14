import { describe, expect, it } from "vitest";

import {
  readSafeUiRouteIncidents,
  recordUiRouteIncident,
  recoverUiRouteIncident,
  safeSettingsRoute,
} from "./ui-route-diagnostics";

describe("UI route diagnostics", () => {
  it("records only bounded route metadata and a normalized code", () => {
    const owner = {};
    const rawSecret = "sk-secret-local-path-C:/Users/writer/正文.txt";

    const incident = recordUiRouteIncident(owner, {
      route: "/settings#model-center",
      phase: "render",
      cause: new Error(rawSecret),
      timestamp: "2026-08-13T01:02:03.004Z",
    });

    expect(incident).toMatchObject({
      routeTransitionId: "UI-ROUTE-000001",
      fromRoute: null,
      toRoute: "/settings#model-center",
      route: "/settings#model-center",
      phase: "render",
      errorBoundaryTriggered: true,
      componentName: "SettingsRouteBoundary",
      webviewReloadDetected: "unknown",
      normalizedErrorCode: "UI_RENDER_FAILED",
      recovered: false,
      recoveredAt: null,
      recoveryAction: null,
    });
    expect(JSON.stringify(readSafeUiRouteIncidents(owner))).not.toContain(rawSecret);
  });

  it("keeps an explicit safe error code and records recovery", () => {
    const owner = {};
    const incident = recordUiRouteIncident(owner, {
      route: "/settings#model-routing",
      phase: "lazy_load",
      cause: { code: "UI_CHUNK_LOAD_FAILED", message: "must not be exported" },
      timestamp: "2026-08-13T01:02:03.004Z",
    });

    recoverUiRouteIncident(owner, incident.diagnosticId, "2026-08-13T01:02:04.004Z");

    expect(readSafeUiRouteIncidents(owner)[0]).toMatchObject({
      normalizedErrorCode: "UI_CHUNK_LOAD_FAILED",
      recovered: true,
      recoveredAt: "2026-08-13T01:02:04.004Z",
      recoveryAction: "retry",
    });
  });

  it("rejects arbitrary locations and query strings from diagnostics", () => {
    expect(safeSettingsRoute("/projects/secret", "#model-center")).toBe("/settings#model-center");
    expect(safeSettingsRoute("/settings", "#unknown?key=secret")).toBe("/settings");
  });
});
