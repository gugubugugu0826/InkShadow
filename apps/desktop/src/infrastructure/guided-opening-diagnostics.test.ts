import { describe, expect, it } from "vitest";

import {
  readSafeGuidedOpeningStatus,
  recordSafeGuidedOpeningStatus,
} from "./guided-opening-diagnostics";

describe("guided opening diagnostics", () => {
  it("stores only the safe finite-state projection and rejects unsafe error text", () => {
    const runtime = {};
    recordSafeGuidedOpeningStatus(runtime, {
      inputValidation: "valid",
      batchId: "batch-1",
      batchState: "settled",
      slotStates: ["ready", "failed", "failed"],
      selectedSlot: "slot_1",
      plannerMode: "deterministic_fallback",
      questionCount: 2,
      currentQuestion: "conflict",
      lastError: "provider said: leaked prose",
    });

    expect(readSafeGuidedOpeningStatus(runtime)).toEqual({
      inputValidation: "valid",
      batchId: "batch-1",
      batchState: "settled",
      slotStates: ["ready", "failed", "failed"],
      selectedSlot: "slot_1",
      plannerMode: "deterministic_fallback",
      questionCount: 2,
      currentQuestion: "conflict",
      lastError: null,
    });
  });
});
