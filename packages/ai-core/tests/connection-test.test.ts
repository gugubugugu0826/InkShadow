import { describe, expect, it } from "vitest";

import { CONNECTION_TEST_STEPS, createConnectionTestReport } from "../src/index.js";

describe("connection test reports", () => {
  it("always returns the nine ordered checks and strips URL details", () => {
    const report = createConnectionTestReport({
      providerId: "provider",
      modelId: "model",
      endpoint: "https://user:password@example.com/v1?token=must-not-appear",
      startedAt: "2026-07-27T00:00:00.000Z",
      completedAt: "2026-07-27T00:00:01.000Z",
      results: [
        {
          step: "url",
          status: "passed",
          durationMs: 1,
        },
        {
          step: "credential",
          status: "failed",
          durationMs: 2,
          errorCode: "MODEL_CREDENTIAL_INVALID",
        },
      ],
    });

    expect(report.steps.map((step) => step.step)).toEqual(CONNECTION_TEST_STEPS);
    expect(report.endpointOrigin).toBe("https://example.com");
    expect(JSON.stringify(report)).not.toContain("must-not-appear");
    expect(report.overallStatus).toBe("failed");
  });

  it("rejects duplicate step observations", () => {
    expect(() =>
      createConnectionTestReport({
        providerId: "provider",
        modelId: "model",
        endpoint: "http://localhost:11434/v1",
        startedAt: "2026-07-27T00:00:00.000Z",
        completedAt: "2026-07-27T00:00:01.000Z",
        results: [
          {
            step: "url",
            status: "passed",
            durationMs: 1,
          },
          {
            step: "url",
            status: "passed",
            durationMs: 1,
          },
        ],
      }),
    ).toThrow("Duplicate connection check step");
  });
});
