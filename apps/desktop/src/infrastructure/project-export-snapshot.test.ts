import {
  Chapter,
  Project,
  ok,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AppError,
  type Clock,
} from "@inkshadow/domain";
import { StoryCoreError, err as storyErr } from "@inkshadow/story-core";
import { describe, expect, it, vi } from "vitest";

import type { GenerationAttemptUsage, GenerationRun } from "./generation-governance-store";
import {
  collectProjectExportSnapshot,
  PROJECT_EXPORT_LIMITS,
  type ProjectExportSnapshotDependencies,
} from "./project-export-snapshot";

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = uuid(1);
const FIRST_CHAPTER_ID = uuid(2);
const SECOND_CHAPTER_ID = uuid(3);

describe("collectProjectExportSnapshot", () => {
  it("builds a deterministic snapshot without generation task or idempotency metadata", async () => {
    const dependencies = createDependencies();
    const result = await collectProjectExportSnapshot(dependencies, domainUuid(PROJECT_ID));

    expect(result).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 1,
        exportedAt: NOW,
        project: { id: PROJECT_ID, name: "墨影长篇" },
      },
    });
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.chapters.map(({ id }) => id)).toEqual([
      FIRST_CHAPTER_ID,
      SECOND_CHAPTER_ID,
    ]);
    expect(result.value.aiUsage.map(({ id }) => id)).toEqual([uuid(8), uuid(9)]);
    expect(result.value.aiUsage[0]?.attempts).toEqual([
      expect.objectContaining({ runId: uuid(8), attempt: 1 }),
    ]);

    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("private-secret-idempotency-marker");
    expect(serialized).not.toContain('"idempotencyKey"');
    expect(serialized).not.toContain('"taskId"');
    expect(serialized).toContain('"providerId":"openai"');
  });

  it("excludes local-only chapters and their AI usage unless inclusion is explicit", async () => {
    const dependencies = createDependencies();
    const publicChapter = createChapter(FIRST_CHAPTER_ID, uuid(4));
    const privateChapter = createChapter(SECOND_CHAPTER_ID, uuid(5), "local_only");
    dependencies.chapters.listByProjectId = vi
      .fn()
      .mockResolvedValue(ok([publicChapter, privateChapter]));
    dependencies.generationGovernance.listRunsByProjectId = vi
      .fn()
      .mockResolvedValue([
        createGenerationRun(8, FIRST_CHAPTER_ID),
        createGenerationRun(9, SECOND_CHAPTER_ID),
      ]);

    const safeDefault = await collectProjectExportSnapshot(dependencies, domainUuid(PROJECT_ID));
    expect(safeDefault.ok && safeDefault.value.chapters.map(({ id }) => id)).toEqual([
      FIRST_CHAPTER_ID,
    ]);
    expect(safeDefault.ok && safeDefault.value.aiUsage.map(({ chapterId }) => chapterId)).toEqual([
      FIRST_CHAPTER_ID,
    ]);

    const explicit = await collectProjectExportSnapshot(dependencies, domainUuid(PROJECT_ID), {
      includeLocalOnlyChapters: true,
    });
    expect(explicit.ok && explicit.value.chapters.map(({ id }) => id)).toEqual([
      FIRST_CHAPTER_ID,
      SECOND_CHAPTER_ID,
    ]);
    expect(explicit.ok && explicit.value.aiUsage.map(({ chapterId }) => chapterId)).toEqual([
      FIRST_CHAPTER_ID,
      SECOND_CHAPTER_ID,
    ]);
  });

  it("fails closed when a story partition cannot be read", async () => {
    const dependencies = createDependencies();
    dependencies.story.outlines.findByProjectId = vi.fn().mockResolvedValue(
      storyErr(
        new StoryCoreError({
          code: "STORY_REPOSITORY_ERROR",
          message: "private database detail",
          retryable: true,
        }),
      ),
    );

    await expect(
      collectProjectExportSnapshot(dependencies, domainUuid(PROJECT_ID)),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        message: "A story data partition could not be loaded for export.",
        details: {
          partition: "outline",
          sourceCode: "STORY_REPOSITORY_ERROR",
        },
      },
    });
  });

  it("rejects an unbounded source partition before creating an artifact", async () => {
    const dependencies = createDependencies();
    const firstChapter = createChapter(FIRST_CHAPTER_ID, uuid(4));
    dependencies.chapters.listByProjectId = vi
      .fn()
      .mockResolvedValue(ok(Array(PROJECT_EXPORT_LIMITS.chapters + 1).fill(firstChapter)));

    await expect(
      collectProjectExportSnapshot(dependencies, domainUuid(PROJECT_ID)),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        details: {
          partition: "chapters",
          maximum: PROJECT_EXPORT_LIMITS.chapters,
        },
      },
    });
  });
});

function createDependencies(): ProjectExportSnapshotDependencies {
  const project = expectValue(
    Project.create({
      id: domainUuid(PROJECT_ID),
      name: "墨影长篇",
      now: timestamp(NOW),
    }),
  );
  const firstChapter = createChapter(FIRST_CHAPTER_ID, uuid(4));
  const secondChapter = createChapter(SECOND_CHAPTER_ID, uuid(5));
  const generationRuns = [createGenerationRun(9), createGenerationRun(8)];
  const attempts = new Map<string, readonly GenerationAttemptUsage[]>([
    [
      uuid(8),
      [
        {
          runId: uuid(8),
          attempt: 1,
          source: "provider_reported",
          inputTokens: 1_000,
          outputTokens: 200,
          cachedInputTokens: 100,
          usagePricedEstimateMicros: "1200",
          currency: "USD",
          pricingVersion: "2026-07",
          priceUpdatedAt: NOW,
          reportedAt: NOW,
        },
      ],
    ],
  ]);
  const clock: Clock = { now: () => timestamp(NOW) };

  return {
    projects: {
      findById: vi.fn().mockResolvedValue(ok(project)),
    },
    chapters: {
      listByProjectId: vi.fn().mockResolvedValue(ok([secondChapter, firstChapter])),
    },
    story: {
      outlines: {
        findByProjectId: vi.fn().mockResolvedValue(ok(null)),
      },
      formalRecords: {
        listByProjectId: vi.fn().mockResolvedValue(ok([])),
      },
      extractionItems: {
        listByProjectId: vi.fn().mockResolvedValue(ok([])),
      },
      consistencyItems: {
        listByProjectId: vi.fn().mockResolvedValue(ok([])),
      },
    },
    generationGovernance: {
      listRunsByProjectId: vi.fn().mockResolvedValue(generationRuns),
      listAttemptUsage: vi
        .fn()
        .mockImplementation((runId: string) => Promise.resolve(attempts.get(runId) ?? [])),
    },
    clock,
  };
}

function createChapter(
  id: string,
  versionId: string,
  privacyMode: "standard" | "local_only" = "standard",
): Chapter {
  return expectValue(
    Chapter.create({
      id: domainUuid(id),
      projectId: domainUuid(PROJECT_ID),
      title: `章节 ${id.slice(-1)}`,
      content: `正文 ${id.slice(-1)}`,
      privacyMode,
      initialVersionId: domainUuid(versionId),
      now: timestamp(NOW),
    }),
  );
}

function createGenerationRun(
  sequence: number,
  chapterId: string = FIRST_CHAPTER_ID,
): GenerationRun {
  return {
    id: uuid(sequence),
    taskId: uuid(sequence + 20),
    idempotencyKey: `private-secret-idempotency-marker-${String(sequence)}`,
    projectId: PROJECT_ID,
    chapterId,
    baseVersionId: uuid(4),
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
    candidateId: uuid(sequence + 40),
    failureCode: null,
    cancelledAt: null,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function domainUuid(value: string) {
  return expectValue(parseUuidV7(value));
}

function timestamp(value: string) {
  return expectValue(parseIsoUtcTimestamp(value));
}

function expectValue<T>(
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
