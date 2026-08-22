// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetUiRouteDiagnosticsMemoryForTests,
  readSafeUiRouteIncidents,
  recordUiRouteIncident,
  recoverUiRouteIncident,
  safeSettingsRoute,
} from "./ui-route-diagnostics";

const PROJECT_ID = "018f0000-0000-7000-8000-000000000001";
const CHAPTER_ID = "018f0000-0000-7000-8000-000000000002";
const CANDIDATE_ID = "018f0000-0000-7000-8000-000000000003";

describe("UI route diagnostics", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

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

  it("persists known trigger ids, sanitized stacks, and a stable fingerprint across reload", () => {
    const owner = {};
    const sensitiveMessage = "sk-secret 正文 C:/Users/writer/private-name.txt";
    const cause = Object.assign(new TypeError(sensitiveMessage), {
      code: "LEGACY_CANDIDATE_METADATA_INVALID",
    });
    cause.stack = [
      `TypeError: ${sensitiveMessage}`,
      "    at EditorPage (C:/Users/writer/InkShadow/apps/desktop/src/pages/editor-page.tsx:77:9)",
      "    at secret (C:/Users/writer/private-name.ts:1:2)",
    ].join("\n");

    const first = recordUiRouteIncident(owner, {
      route: `https://local.invalid/#/projects/${PROJECT_ID}/chapters/${CHAPTER_ID}?candidate=${CANDIDATE_ID}&token=never-save`,
      phase: "render",
      cause,
      componentName: "AppErrorBoundary",
      componentStack:
        "\n    at EditorPage (D:/InkShadow/apps/desktop/src/pages/editor-page.tsx:77:9)\n    at SecretName (C:/Users/writer/private.tsx:1:2)",
      timestamp: "2026-08-13T01:02:03.004Z",
    });
    const second = recordUiRouteIncident(
      {},
      {
        route: `#/projects/${PROJECT_ID}/chapters/${CHAPTER_ID}?candidate=${CANDIDATE_ID}`,
        phase: "render",
        cause,
        componentName: "AppErrorBoundary",
        componentStack:
          "\n    at EditorPage (D:/InkShadow/apps/desktop/src/pages/editor-page.tsx:77:9)\n    at SecretName (C:/Users/writer/private.tsx:1:2)",
        timestamp: "2026-08-13T01:02:04.004Z",
      },
    );

    expect(first).toMatchObject({
      route: "/projects/:projectId/chapters/:chapterId?candidate=:candidateId",
      triggerIds: { projectId: PROJECT_ID, chapterId: CHAPTER_ID, candidateId: CANDIDATE_ID },
      normalizedErrorCode: "LEGACY_CANDIDATE_METADATA_INVALID",
      errorType: "TypeError",
      applicationStack: [
        "TypeError: LEGACY_CANDIDATE_METADATA_INVALID",
        "at EditorPage (apps/desktop/src/pages/editor-page.tsx:77:9)",
      ],
      reactComponentStack: [
        "at EditorPage (apps/desktop/src/pages/editor-page.tsx:77:9)",
        "at SecretName",
      ],
    });
    expect(second.fingerprint).toBe(first.fingerprint);

    const persisted = JSON.stringify(window.localStorage);
    expect(persisted).not.toContain("sk-secret");
    expect(persisted).not.toContain("正文");
    expect(persisted).not.toContain("C:/Users");
    expect(persisted).not.toContain("D:/InkShadow");
    expect(persisted).not.toContain("never-save");

    forgetUiRouteDiagnosticsMemoryForTests(owner);
    expect(readSafeUiRouteIncidents(owner)).toEqual(
      expect.arrayContaining([expect.objectContaining({ diagnosticId: first.diagnosticId })]),
    );
  });

  it("reduces arbitrary names, tokens, absolute paths, and query data to unknown", () => {
    const owner = {};
    recordUiRouteIncident(owner, {
      route: `#/private-secret/作者名字?token=sk-secret&path=C%3A%2FUsers%2Fwriter%2F正文.txt&candidate=${CANDIDATE_ID}`,
      phase: "render",
      cause: new Error("private"),
      timestamp: "2026-08-13T01:02:03.004Z",
    });

    expect(readSafeUiRouteIncidents(owner)[0]).toMatchObject({
      route: "/unknown",
      triggerIds: { projectId: null, chapterId: null, candidateId: null },
    });
    const persisted = JSON.stringify(window.localStorage);
    for (const secret of [
      "private-secret",
      "作者名字",
      "sk-secret",
      "C:/Users",
      "正文.txt",
      CANDIDATE_ID,
    ]) {
      expect(persisted).not.toContain(secret);
    }
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

  it("rejects arbitrary settings locations and query strings from diagnostics", () => {
    expect(safeSettingsRoute("/projects/secret", "#model-center")).toBe("/settings#model-center");
    expect(safeSettingsRoute("/settings", "#unknown?key=secret")).toBe("/settings");
  });
});
