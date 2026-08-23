// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetSafeOperationDiagnosticsMemoryForTests,
  readSafeOperationIncidents,
  recordSafeOperationIncident,
  resetSafeOperationDiagnosticsForTests,
} from "./safe-operation-diagnostics";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";

describe("safe operation diagnostics", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSafeOperationDiagnosticsForTests();
  });

  it("persists only a support number, safe identifiers, stage and error-code chain", () => {
    const secret = "test-not-a-real-secret 正文原文 C:/Users/writer/secret.txt";
    const root = Object.assign(new Error(secret), { code: "MODEL_HUB_ROUTE_NOT_CONFIGURED" });
    const outer = Object.assign(new TypeError(`wrapped ${secret}`), {
      code: "STORY_PLANNING_PREPARATION_FAILED",
      cause: root,
    });

    const incident = recordSafeOperationIncident({
      operation: "story_planning",
      stage: "prepare_disclosure",
      cause: outer,
      projectId: PROJECT_ID,
      requestId: `request-${secret}`,
      dispatched: false,
      occurredAt: "2026-08-23T05:06:07.008Z",
    });

    expect(incident).toMatchObject({
      supportId: "墨影-20260823050607-001",
      projectId: PROJECT_ID,
      requestId: null,
      normalizedErrorCode: "STORY_PLANNING_PREPARATION_FAILED",
      stage: "prepare_disclosure",
      dispatched: false,
      automaticRetryCount: 0,
      causeChain: [
        { errorType: "TypeError", errorCode: "STORY_PLANNING_PREPARATION_FAILED" },
        { errorType: "Error", errorCode: "MODEL_HUB_ROUTE_NOT_CONFIGURED" },
      ],
    });
    expect(readSafeOperationIncidents()[0]?.supportId).toBe(incident.supportId);
    const persisted = JSON.stringify(window.localStorage);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("正文原文");
    expect(persisted).not.toContain("C:/Users");
  });

  it("cold-reads the pre-dispatch stage from local storage after memory is cleared", () => {
    const recorded = recordSafeOperationIncident({
      operation: "story_planning",
      stage: "pre_dispatch_check",
      cause: Object.assign(new Error("route changed"), {
        code: "STORY_PLANNING_PRE_DISPATCH_FAILED",
      }),
      projectId: PROJECT_ID,
      dispatched: false,
      occurredAt: "2026-08-23T05:07:08.009Z",
    });

    forgetSafeOperationDiagnosticsMemoryForTests();

    expect(readSafeOperationIncidents()[0]).toEqual(recorded);
    expect(readSafeOperationIncidents()[0]).toMatchObject({
      stage: "pre_dispatch_check",
      dispatched: false,
    });
  });
});
