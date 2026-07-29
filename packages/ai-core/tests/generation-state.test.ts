import { describe, expect, it } from "vitest";

import {
  IllegalGenerationTransitionError,
  canTransitionGenerationState,
  isTerminalGenerationState,
  transitionGenerationState,
} from "../src/index.js";

describe("generation state machine", () => {
  it("allows the complete candidate-first happy path", () => {
    const path = [
      "prechecking",
      "queued",
      "retrieving",
      "generating",
      "validating",
      "candidate_ready",
      "completed",
    ] as const;

    for (let index = 0; index < path.length - 1; index += 1) {
      const current = path[index];
      const next = path[index + 1];
      if (current === undefined || next === undefined) {
        throw new Error("Test path is unexpectedly incomplete.");
      }
      expect(transitionGenerationState(current, next)).toBe(next);
    }
  });

  it("allows a retryable failure to requeue", () => {
    expect(canTransitionGenerationState("generating", "failed_retryable")).toBe(true);
    expect(transitionGenerationState("failed_retryable", "queued")).toBe("queued");
  });

  it("lets an acknowledged cancellation win before a ready candidate is committed", () => {
    expect(transitionGenerationState("candidate_ready", "cancelled")).toBe("cancelled");
  });

  it("rejects direct completion and all transitions from terminal states", () => {
    expect(() => transitionGenerationState("generating", "completed")).toThrow(
      IllegalGenerationTransitionError,
    );
    expect(() => transitionGenerationState("completed", "queued")).toThrow(
      IllegalGenerationTransitionError,
    );
    expect(isTerminalGenerationState("completed")).toBe(true);
    expect(isTerminalGenerationState("candidate_ready")).toBe(false);
  });
});
