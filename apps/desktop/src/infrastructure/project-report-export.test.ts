import { Project, parseIsoUtcTimestamp, parseUuidV7, type AppError } from "@inkshadow/domain";
import { FormalStoryRecord, Outline } from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import { createProjectReportArtifact } from "./project-report-export";
import type { ProjectExportSnapshot } from "./project-export-snapshot";

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = uuid(1);

describe("createProjectReportArtifact", () => {
  it("exports only the selected formal domain with stable metadata", () => {
    const snapshot = createSnapshot();
    const artifact = createProjectReportArtifact(snapshot, "characters");
    const payload = JSON.parse(artifact.content) as {
      readonly kind: string;
      readonly count: number;
      readonly data: readonly { readonly kind: string; readonly recordKey: string }[];
    };

    expect(artifact).toMatchObject({
      fileName: "墨影-角色.json",
      mediaType: "application/json",
      kind: "characters",
      recordCount: 1,
    });
    expect(payload).toMatchObject({
      kind: "characters",
      count: 1,
      data: [{ kind: "character", recordKey: "lin-yue" }],
    });
    expect(artifact.content.endsWith("\n")).toBe(true);
  });

  it("keeps review and AI usage reports partitioned", () => {
    const snapshot = createSnapshot();
    const review = createProjectReportArtifact(snapshot, "review");
    const usage = createProjectReportArtifact(snapshot, "ai_usage");

    expect(review.recordCount).toBe(0);
    expect(usage.recordCount).toBe(1);
    expect(usage.content).toContain('"providerId": "openai"');
    expect(usage.content).not.toMatch(/idempotency|taskId|credential|prompt/iu);
  });
});

function createSnapshot(): ProjectExportSnapshot {
  const project = expectDomain(
    Project.create({
      id: expectDomain(parseUuidV7(PROJECT_ID)),
      name: "墨影",
      now: expectDomain(parseIsoUtcTimestamp(NOW)),
    }),
  );
  const character = expectStory(
    FormalStoryRecord.create({
      id: uuid(2),
      projectId: PROJECT_ID,
      kind: "character",
      recordKey: "lin-yue",
      value: { name: "林月", role: "protagonist" },
      actorId: uuid(3),
      humanConfirmed: true,
      now: NOW,
    }),
  );
  const world = expectStory(
    FormalStoryRecord.create({
      id: uuid(4),
      projectId: PROJECT_ID,
      kind: "world_rule",
      recordKey: "moon-law",
      value: { rule: "月影不可跨越城墙" },
      actorId: uuid(3),
      humanConfirmed: true,
      now: NOW,
    }),
  );
  const outline = expectStory(
    Outline.create({
      projectId: PROJECT_ID,
      bookId: uuid(5),
      title: "墨影",
      now: NOW,
    }),
  );
  return {
    schemaVersion: 1,
    exportedAt: NOW,
    project: project.toSnapshot(),
    chapters: [],
    outline: outline.toSnapshot(),
    formalRecords: [world.toSnapshot(), character.toSnapshot()],
    review: {
      extraction: [],
      consistency: [],
    },
    aiUsage: [
      {
        id: uuid(6),
        projectId: PROJECT_ID,
        chapterId: uuid(7),
        baseVersionId: uuid(8),
        providerId: "openai",
        modelId: "gpt-test",
        state: "candidate_ready",
        revision: 4,
        attempt: 1,
        inputTokens: 1_000,
        maximumOutputTokens: 2_000,
        estimatedCostMicros: "2000",
        incurredCostMicros: "1800",
        currency: "USD",
        pricingVersion: "2026-07",
        priceUpdatedAt: NOW,
        preflight: {
          checkedAt: NOW,
          canStart: true,
          requiresConfirmation: false,
          codes: ["READY"],
          estimateMicros: "2000",
          currency: "USD",
          pricingVersion: "2026-07",
          priceUpdatedAt: NOW,
          inputBytes: 4_000,
          inputTokens: 1_000,
          maximumOutputTokens: 2_000,
          contextWindowTokens: 8_000,
        },
        route: {
          role: "high_quality",
          reason: "role_primary",
          fallbackProviderId: null,
          fallbackModelId: null,
        },
        candidateId: uuid(9),
        failureCode: null,
        cancelledAt: null,
        completedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        attempts: [],
      },
    ],
  };
}

function expectStory<T>(
  result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Error }>,
): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function expectDomain<T>(
  result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: AppError }>,
): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}
