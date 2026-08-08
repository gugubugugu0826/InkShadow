import { describe, expect, it } from "vitest";

import type { StoryPlanningPayload } from "./story-planning-candidate-store";
import {
  buildSelectiveStoryPlanningSynopsisForIntentVersion,
  buildSelectiveStoryPlanningSynopsisV1,
  createStoryPlanningSelectiveAcceptanceIntent,
  STORY_PLANNING_SELECTIVE_ACCEPTANCE_RENDERER_VERSION,
} from "./story-planning-selective-acceptance";

const V1_CONTRACT_OUTPUT =
  "原始简介\n\n已采纳的 AI 规划条目：\n雨夜之后\n故事方向：两人同行\n\n1. 相遇\n目标：建立冲突\n结果：决定同行\n\n待作者决定：幕后人是谁";
const V1_CONTRACT_SHA256 = "50e80cd12d1fe9b494b1607c15144f781ed8ca65259231c0c26e6302adbab723";

describe("story planning selective acceptance renderer", () => {
  it("freezes durable intent schema v1 to one byte-stable synopsis renderer", async () => {
    const payload = planningPayload();
    const selection = ["overview", "beat:0", "question:0"] as const;
    const rendered = buildSelectiveStoryPlanningSynopsisV1("原始简介", payload, selection);

    expect(STORY_PLANNING_SELECTIVE_ACCEPTANCE_RENDERER_VERSION).toBe(1);
    expect(rendered).toBe(V1_CONTRACT_OUTPUT);
    expect(await sha256Hex(rendered)).toBe(V1_CONTRACT_SHA256);
    expect(
      buildSelectiveStoryPlanningSynopsisForIntentVersion(1, "原始简介", payload, selection),
    ).toBe(V1_CONTRACT_OUTPUT);

    const intent = await createStoryPlanningSelectiveAcceptanceIntent({
      selectedItemIds: selection,
      baselineOutlineRevision: 7,
      baselineSynopsis: "原始简介",
      proposedSynopsis: rendered,
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(intent).toMatchObject({
      schemaVersion: 1,
      proposedSynopsisSha256: V1_CONTRACT_SHA256,
    });
  });

  it("fails closed instead of silently using a newer renderer for an unknown intent version", () => {
    expect(() =>
      buildSelectiveStoryPlanningSynopsisForIntentVersion(2, "原始简介", planningPayload(), [
        "overview",
      ]),
    ).toThrow(/Unsupported story planning synopsis renderer v2/u);
  });
});

function planningPayload(): StoryPlanningPayload {
  return {
    schemaVersion: 1,
    task: "outline_planning",
    title: "雨夜之后",
    direction: "两人同行",
    beats: [{ title: "相遇", purpose: "建立冲突", outcome: "决定同行" }],
    constraintsApplied: ["不新增超自然设定"],
    openQuestions: ["幕后人是谁"],
  };
}

async function sha256Hex(value: string): Promise<string> {
  const source = new TextEncoder().encode(value);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
