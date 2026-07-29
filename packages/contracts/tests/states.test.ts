import { describe, expect, it } from "vitest";

import {
  GENERATION_STATES,
  LICENSE_STATES,
  NOTIFICATION_TRANSITIONS,
  PAGE_STATES,
  SAVE_STATES,
  SAVE_TRANSITIONS,
  SYNC_STATES,
} from "../src/index.js";

describe("frozen state vocabularies", () => {
  it("keeps exactly fourteen top-level page states", () => {
    expect(PAGE_STATES).toHaveLength(14);
    expect(new Set(PAGE_STATES).size).toBe(PAGE_STATES.length);
  });

  it("includes the state-matrix additions to the license contract", () => {
    expect(LICENSE_STATES).toContain("refunded");
    expect(LICENSE_STATES).toContain("offline_expired");
  });

  it("does not invent aliases for save, generation, or sync", () => {
    expect(SAVE_STATES).toEqual([
      "clean",
      "dirty",
      "saving",
      "saved_local",
      "pending_sync",
      "save_failed",
      "conflict",
      "readonly",
    ]);
    expect(GENERATION_STATES).toHaveLength(11);
    expect(SYNC_STATES).toHaveLength(12);
  });

  it("keeps readonly save state terminal and delivery failure recoverable", () => {
    expect(SAVE_TRANSITIONS.readonly).toEqual([]);
    expect(NOTIFICATION_TRANSITIONS.failed_delivery).toEqual(["queued"]);
  });
});
