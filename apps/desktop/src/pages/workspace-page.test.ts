import { describe, expect, it } from "vitest";

import { calculateWorkspaceInsights } from "./workspace-insights";

describe("calculateWorkspaceInsights", () => {
  it("derives today's net change, current writing streak, and pending suggestions from real records", () => {
    const now = new Date(2026, 7, 8, 12, 0, 0);
    const result = calculateWorkspaceInsights(
      [
        version("chapter-a", 80, new Date(2026, 7, 6, 20, 0, 0)),
        version("chapter-a", 100, new Date(2026, 7, 7, 20, 0, 0)),
        version("chapter-a", 150, new Date(2026, 7, 8, 9, 0, 0)),
        version("chapter-b", 20, new Date(2026, 7, 8, 10, 0, 0)),
      ],
      2,
      now,
    );

    expect(result).toEqual({
      todayNetCharacters: 70,
      currentStreakDays: 3,
      readyCandidateCount: 2,
    });
  });

  it("shows no current streak after a full missed day and keeps deletions visible as net change", () => {
    const now = new Date(2026, 7, 8, 12, 0, 0);
    const result = calculateWorkspaceInsights(
      [
        version("chapter-a", 100, new Date(2026, 7, 6, 20, 0, 0)),
        version("chapter-a", 60, new Date(2026, 7, 8, 9, 0, 0)),
      ],
      0,
      now,
    );

    expect(result.todayNetCharacters).toBe(-40);
    expect(result.currentStreakDays).toBe(1);
  });
});

function version(chapterId: string, contentLength: number, createdAt: Date) {
  return {
    chapterId,
    contentLength,
    createdAt: createdAt.toISOString(),
  };
}
