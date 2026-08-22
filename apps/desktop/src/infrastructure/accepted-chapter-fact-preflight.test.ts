import { describe, expect, it, vi } from "vitest";

import type { AcceptedChapterPipelineInput } from "./accepted-chapter-pipeline";
import { ensureCurrentSavedVersionStoryFactsForDirectMode } from "./accepted-chapter-fact-preflight";
import type { DesktopRuntime } from "./runtime";

const BASE_INPUT = Object.freeze({
  projectId: "018f0000-0000-7000-8000-000000000001",
  chapterId: "018f0000-0000-7000-8000-000000000002",
  versionId: "018f0000-0000-7000-8000-000000000003",
  source: "candidate_accept",
  acceptedCharacterCount: 12,
}) as AcceptedChapterPipelineInput;

describe("accepted chapter fact preflight", () => {
  it("uses the persisted responsibility after restart without consulting the current mode", async () => {
    const findById = vi.fn().mockRejectedValue(new Error("CURRENT_VERSION_UNAVAILABLE"));
    const modeRead = vi.fn().mockResolvedValue({ mode: "professional" });
    const runtime = stubRuntime(findById, modeRead);

    await expect(
      ensureCurrentSavedVersionStoryFactsForDirectMode(runtime, {
        ...BASE_INPUT,
        organizeLocalStoryFacts: true,
      }),
    ).rejects.toThrow("CURRENT_VERSION_UNAVAILABLE");
    expect(findById).toHaveBeenCalledWith(BASE_INPUT.chapterId);
    expect(modeRead).not.toHaveBeenCalled();
  });

  it.each([
    ["an old task without the field", BASE_INPUT],
    ["an explicit non-owner task", { ...BASE_INPUT, organizeLocalStoryFacts: false }],
  ])("does not guess responsibility for %s", async (_name, input) => {
    const findById = vi.fn();
    const modeRead = vi.fn().mockResolvedValue({ mode: "direct" });
    const runtime = stubRuntime(findById, modeRead);

    await expect(
      ensureCurrentSavedVersionStoryFactsForDirectMode(runtime, input),
    ).resolves.toBeUndefined();
    expect(findById).not.toHaveBeenCalled();
    expect(modeRead).not.toHaveBeenCalled();
  });
});

function stubRuntime(
  findById: ReturnType<typeof vi.fn>,
  modeRead: ReturnType<typeof vi.fn>,
): Pick<DesktopRuntime, "clock" | "hasher" | "repositories" | "story"> {
  return {
    writingExperience: { getOrInitialize: modeRead },
    repositories: {
      chapters: { findById },
      chapterVersions: {},
    },
    story: {
      facts: {},
      factService: {},
    },
    hasher: {},
    clock: {
      now: vi.fn().mockReturnValue("2026-08-22T00:00:00.000Z"),
    },
  } as unknown as Pick<DesktopRuntime, "clock" | "hasher" | "repositories" | "story">;
}
