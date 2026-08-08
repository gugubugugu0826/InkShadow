import type { ChapterRepository, ProjectRepository } from "@inkshadow/application";
import {
  AppError,
  err,
  ok,
  type ChapterSnapshot,
  type Clock,
  type ProjectSnapshot,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";
import {
  parseUuidV7 as parseStoryUuidV7,
  type FormalStoryRecordListReader,
  type FormalStoryRecordSnapshot,
  type OutlineRepository,
  type OutlineSnapshot,
  type ReviewItemListReader,
  type StructuredReviewItemSnapshot,
} from "@inkshadow/story-core";

import type {
  GenerationAttemptUsage,
  GenerationGovernanceStore,
  GenerationRun,
  GenerationRouteSelection,
  PersistedGenerationPreflight,
} from "./generation-governance-store";

export const PROJECT_EXPORT_LIMITS = Object.freeze({
  chapters: 10_000,
  formalRecords: 100_000,
  reviewItemsPerKind: 100_000,
  generationRuns: 50_000,
  generationAttempts: 100_000,
});

export interface SafeGenerationRunSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly baseVersionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly state: GenerationRun["state"];
  readonly revision: number;
  readonly attempt: number;
  readonly inputTokens: number;
  readonly maximumOutputTokens: number;
  readonly estimatedCostMicros: string;
  readonly incurredCostMicros: string;
  readonly currency: string;
  readonly pricingVersion: string;
  readonly priceUpdatedAt: string;
  readonly preflight: PersistedGenerationPreflight;
  readonly route: GenerationRouteSelection;
  readonly candidateId: string | null;
  readonly failureCode: string | null;
  readonly cancelledAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: readonly GenerationAttemptUsage[];
}

export interface ProjectExportSnapshot {
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly project: ProjectSnapshot;
  readonly chapters: readonly ChapterSnapshot[];
  readonly outline: OutlineSnapshot | null;
  readonly formalRecords: readonly FormalStoryRecordSnapshot[];
  readonly review: Readonly<{
    extraction: readonly StructuredReviewItemSnapshot<"extraction">[];
    consistency: readonly StructuredReviewItemSnapshot<"consistency">[];
  }>;
  readonly aiUsage: readonly SafeGenerationRunSnapshot[];
}

export interface ProjectExportSnapshotDependencies {
  readonly projects: Pick<ProjectRepository, "findById">;
  readonly chapters: Pick<ChapterRepository, "listByProjectId">;
  readonly story: Readonly<{
    outlines: Pick<OutlineRepository, "findByProjectId">;
    formalRecords: Pick<FormalStoryRecordListReader, "listByProjectId">;
    extractionItems: Pick<ReviewItemListReader<"extraction">, "listByProjectId">;
    consistencyItems: Pick<ReviewItemListReader<"consistency">, "listByProjectId">;
  }>;
  readonly generationGovernance: Pick<
    GenerationGovernanceStore,
    "listRunsByProjectId" | "listAttemptUsage"
  >;
  readonly clock: Clock;
}

export interface ProjectExportPrivacyOptions {
  /**
   * Local-only chapters are excluded unless the user explicitly opts in at
   * the local export boundary. Callers must never infer this from file type.
   */
  readonly includeLocalOnlyChapters?: boolean;
}

export async function collectProjectExportSnapshot(
  dependencies: ProjectExportSnapshotDependencies,
  projectId: UuidV7,
  options: ProjectExportPrivacyOptions = {},
): Promise<Result<ProjectExportSnapshot, AppError>> {
  try {
    const projectResult = await dependencies.projects.findById(projectId);
    if (!projectResult.ok) {
      return projectResult;
    }
    if (projectResult.value === null) {
      return err(
        new AppError({
          code: "PROJECT_NOT_FOUND",
          message: "The project could not be found for export.",
        }),
      );
    }
    if (projectResult.value.status === "trashed") {
      return err(
        new AppError({
          code: "PROJECT_DELETED",
          message: "Restore the project before exporting it.",
          actions: ["RESTORE"],
        }),
      );
    }

    const storyProjectId = parseStoryUuidV7(projectId);
    if (!storyProjectId.ok) {
      return err(
        new AppError({
          code: "INVALID_UUID",
          message: "The project identifier cannot be used for a story export.",
        }),
      );
    }

    const [
      chaptersResult,
      outlineResult,
      formalRecordsResult,
      extractionResult,
      consistencyResult,
      generationRuns,
    ] = await Promise.all([
      dependencies.chapters.listByProjectId(projectId),
      dependencies.story.outlines.findByProjectId(storyProjectId.value),
      dependencies.story.formalRecords.listByProjectId(storyProjectId.value),
      dependencies.story.extractionItems.listByProjectId(storyProjectId.value),
      dependencies.story.consistencyItems.listByProjectId(storyProjectId.value),
      dependencies.generationGovernance.listRunsByProjectId(projectId),
    ]);

    if (!chaptersResult.ok) {
      return chaptersResult;
    }
    if (!outlineResult.ok) {
      return storySourceError("outline", outlineResult.error);
    }
    if (!formalRecordsResult.ok) {
      return storySourceError("formal_records", formalRecordsResult.error);
    }
    if (!extractionResult.ok) {
      return storySourceError("extraction_review", extractionResult.error);
    }
    if (!consistencyResult.ok) {
      return storySourceError("consistency_review", consistencyResult.error);
    }

    const localOnlyChapterIds = new Set<string>(
      chaptersResult.value
        .filter(({ privacyMode }) => privacyMode === "local_only")
        .map(({ id }) => id),
    );
    const includeLocalOnly = options.includeLocalOnlyChapters === true;
    const exportableGenerationRuns = includeLocalOnly
      ? generationRuns
      : generationRuns.filter(({ chapterId }) => !localOnlyChapterIds.has(chapterId));

    const limitFailure =
      enforceLimit("chapters", chaptersResult.value.length, PROJECT_EXPORT_LIMITS.chapters) ??
      enforceLimit(
        "formal_records",
        formalRecordsResult.value.length,
        PROJECT_EXPORT_LIMITS.formalRecords,
      ) ??
      enforceLimit(
        "extraction_review_items",
        extractionResult.value.length,
        PROJECT_EXPORT_LIMITS.reviewItemsPerKind,
      ) ??
      enforceLimit(
        "consistency_review_items",
        consistencyResult.value.length,
        PROJECT_EXPORT_LIMITS.reviewItemsPerKind,
      ) ??
      enforceLimit(
        "generation_runs",
        exportableGenerationRuns.length,
        PROJECT_EXPORT_LIMITS.generationRuns,
      );
    if (limitFailure !== null) {
      return err(limitFailure);
    }

    const aiUsage = await collectSafeGenerationRuns(
      dependencies.generationGovernance,
      exportableGenerationRuns,
    );
    if (!aiUsage.ok) {
      return aiUsage;
    }

    const chapters = chaptersResult.value
      .filter(
        (chapter) =>
          chapter.status === "active" && (includeLocalOnly || chapter.privacyMode !== "local_only"),
      )
      .map((chapter) => chapter.toSnapshot())
      .sort(compareCreatedSnapshot);
    const formalRecords = formalRecordsResult.value
      .map((record) => record.toSnapshot())
      .sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          left.recordKey.localeCompare(right.recordKey) ||
          left.id.localeCompare(right.id),
      );
    const extraction = extractionResult.value
      .map((item) => item.toSnapshot())
      .filter(
        ({ sourceChapterId }) => includeLocalOnly || !localOnlyChapterIds.has(sourceChapterId),
      )
      .sort(compareCreatedSnapshot);
    const consistency = consistencyResult.value
      .map((item) => item.toSnapshot())
      .filter(
        ({ sourceChapterId }) => includeLocalOnly || !localOnlyChapterIds.has(sourceChapterId),
      )
      .sort(compareCreatedSnapshot);

    return ok({
      schemaVersion: 1,
      exportedAt: dependencies.clock.now(),
      project: projectResult.value.toSnapshot(),
      chapters: Object.freeze(chapters),
      outline:
        outlineResult.value === null
          ? null
          : normalizeOutlineSnapshot(outlineResult.value.toSnapshot()),
      formalRecords: Object.freeze(formalRecords),
      review: Object.freeze({
        extraction: Object.freeze(extraction),
        consistency: Object.freeze(consistency),
      }),
      aiUsage: aiUsage.value,
    });
  } catch (cause: unknown) {
    return err(exportRepositoryError(cause));
  }
}

async function collectSafeGenerationRuns(
  governance: Pick<GenerationGovernanceStore, "listAttemptUsage">,
  generationRuns: readonly GenerationRun[],
): Promise<Result<readonly SafeGenerationRunSnapshot[], AppError>> {
  const orderedRuns = [...generationRuns].sort(compareCreatedSnapshot);
  const safeRuns: SafeGenerationRunSnapshot[] = [];
  let attemptCount = 0;
  for (const run of orderedRuns) {
    const attempts = await governance.listAttemptUsage(run.id);
    attemptCount += attempts.length;
    const limitFailure = enforceLimit(
      "generation_attempts",
      attemptCount,
      PROJECT_EXPORT_LIMITS.generationAttempts,
    );
    if (limitFailure !== null) {
      return err(limitFailure);
    }
    safeRuns.push(
      Object.freeze({
        id: run.id,
        projectId: run.projectId,
        chapterId: run.chapterId,
        baseVersionId: run.baseVersionId,
        providerId: run.providerId,
        modelId: run.modelId,
        state: run.state,
        revision: run.revision,
        attempt: run.attempt,
        inputTokens: run.inputTokens,
        maximumOutputTokens: run.maximumOutputTokens,
        estimatedCostMicros: run.estimatedCostMicros,
        incurredCostMicros: run.incurredCostMicros,
        currency: run.currency,
        pricingVersion: run.pricingVersion,
        priceUpdatedAt: run.priceUpdatedAt,
        preflight: Object.freeze({
          ...run.preflight,
          codes: Object.freeze([...run.preflight.codes]),
        }),
        route: Object.freeze({ ...run.route }),
        candidateId: run.candidateId,
        failureCode: run.failureCode,
        cancelledAt: run.cancelledAt,
        completedAt: run.completedAt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        attempts: Object.freeze([...attempts].sort((left, right) => left.attempt - right.attempt)),
      }),
    );
  }
  return ok(Object.freeze(safeRuns));
}

function normalizeOutlineSnapshot(snapshot: OutlineSnapshot): OutlineSnapshot {
  return Object.freeze({
    ...snapshot,
    nodes: Object.freeze(
      [...snapshot.nodes].sort(
        (left, right) =>
          (left.parentId ?? "").localeCompare(right.parentId ?? "") ||
          left.position - right.position ||
          left.id.localeCompare(right.id),
      ),
    ),
  });
}

function compareCreatedSnapshot(
  left: Readonly<{ readonly createdAt: string; readonly id: string }>,
  right: Readonly<{ readonly createdAt: string; readonly id: string }>,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function enforceLimit(name: string, count: number, maximum: number): AppError | null {
  if (count <= maximum) {
    return null;
  }
  return new AppError({
    code: "VALIDATION_FAILED",
    message: "The project is too large for a safe local export.",
    details: { partition: name, count, maximum },
  });
}

function storySourceError(
  partition: string,
  cause: Readonly<{ readonly code: string; readonly retryable: boolean }>,
): Result<never, AppError> {
  return err(
    new AppError({
      code: "REPOSITORY_ERROR",
      message: "A story data partition could not be loaded for export.",
      retryable: cause.retryable,
      actions: cause.retryable ? ["RETRY"] : ["CONTACT_SUPPORT"],
      details: { partition, sourceCode: cause.code },
    }),
  );
}

function exportRepositoryError(cause: unknown): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The local project export snapshot could not be created.",
    retryable: true,
    actions: ["RETRY"],
  });
}
