import {
  AppError,
  Chapter,
  ChapterVersion,
  err,
  ok,
  parseUuidV7 as parseDomainUuidV7,
  type Clock,
  type Result,
  type UuidV7 as DomainUuidV7,
} from "@inkshadow/domain";
import {
  graphSourceContentIssue,
  graphEvidenceSpanHash,
  InMemoryGraphRagIndex,
  isUtf16CodePointBoundary,
  type GraphEntity,
  type GraphRagProjectSnapshot,
  type GraphRelation,
  type GraphSourceContentIssue,
  type GraphSourceVersion,
} from "@inkshadow/search-core";
import {
  FormalStoryRecord,
  StructuredReviewItem,
  parseUuidV7 as parseStoryUuidV7,
  storyValuesEqual,
  type FormalStoryRecordListReader,
  type FormalStoryRecordSnapshot,
  type ReviewItemListReader,
  type StoryCoreError,
  type StructuredReviewItemSnapshot,
  type UuidV7 as StoryUuidV7,
} from "@inkshadow/story-core";

import type { ChapterRepository, ChapterVersionRepository } from "../ports/chapter-repositories.js";
import type { ContentHasher } from "../ports/content-hasher.js";
import type { GraphRagProjectionRepository } from "../ports/graph-rag-repository.js";

export const AUTHORITATIVE_STORY_GRAPH_LIMITS = Object.freeze({
  formalRecords: 20_000,
  reviewItems: 40_000,
  chapters: 40_000,
  totalFormalVersions: 200_000,
  totalReviewDecisions: 200_000,
  projectionSourceUtf8Bytes: 64 * 1024 * 1024,
  storedAuthorityUtf8Bytes: 256 * 1024 * 1024,
});
const MAX_FORMAL_RECORDS = AUTHORITATIVE_STORY_GRAPH_LIMITS.formalRecords;
const MAX_REVIEW_ITEMS = AUTHORITATIVE_STORY_GRAPH_LIMITS.reviewItems;
const MAX_CHAPTERS = AUTHORITATIVE_STORY_GRAPH_LIMITS.chapters;
const MAX_TOTAL_FORMAL_VERSIONS = AUTHORITATIVE_STORY_GRAPH_LIMITS.totalFormalVersions;
const MAX_TOTAL_REVIEW_DECISIONS = AUTHORITATIVE_STORY_GRAPH_LIMITS.totalReviewDecisions;
const MAX_PROJECTION_SOURCE_UTF8_BYTES = AUTHORITATIVE_STORY_GRAPH_LIMITS.projectionSourceUtf8Bytes;
const STALE_SKIP_REASONS = new Set<AuthoritativeStoryGraphSkipReason>([
  "current_chapter_missing",
  "current_chapter_trashed",
  "current_chapter_version_changed",
]);

export const AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS = 3;
export const AUTHORITATIVE_STORY_GRAPH_RELATION_KIND = "extraction_supports";

export type AuthoritativeStoryGraphSkipReason =
  | "chapter_source_ill_formed_utf16"
  | "chapter_source_too_large"
  | "chapter_source_unsafe_control"
  | "current_chapter_missing"
  | "current_chapter_trashed"
  | "current_chapter_version_changed";

export interface AuthoritativeStoryGraphSkipDiagnostic {
  readonly reason: AuthoritativeStoryGraphSkipReason;
  readonly count: number;
}

export interface AuthoritativeStoryGraphBuildDiagnostics {
  readonly formalRecordCount: number;
  readonly reviewItemCount: number;
  readonly chapterCount: number;
  readonly formalEntityCount: number;
  readonly chapterEntityCount: number;
  readonly relationCount: number;
  readonly sourceVersionCount: number;
  readonly skippedRelationCount: number;
  readonly invalidatedSupportCount: number;
  readonly projectionOmissionCount: number;
  readonly nonReviewDerivedFormalCount: number;
  readonly nonExtractionReviewFormalCount: number;
  readonly skipped: readonly AuthoritativeStoryGraphSkipDiagnostic[];
  readonly partial: boolean;
  readonly stale: boolean;
}

export interface AuthoritativeStoryGraphProjectionBuild {
  readonly snapshot: GraphRagProjectSnapshot;
  readonly diagnostics: AuthoritativeStoryGraphBuildDiagnostics;
}

export interface AuthoritativeStoryGraphRebuildReceipt extends AuthoritativeStoryGraphBuildDiagnostics {
  readonly projectId: string;
  readonly previousRevision: number;
  readonly revision: number;
  readonly rebuiltAt: string;
  readonly casAttempts: number;
}

/**
 * These are intentionally readers only. The graph projection has no formal
 * story writer or content commit dependency and therefore cannot publish back
 * into accepted story state.
 */
export interface AuthoritativeStoryGraphReadSources {
  readonly formalRecords: FormalStoryRecordListReader;
  readonly extractionReviews: ReviewItemListReader<"extraction">;
  readonly consistencyReviews: ReviewItemListReader<"consistency">;
  readonly chapters: ChapterRepository;
  readonly chapterVersions: ChapterVersionRepository;
}

/**
 * Builds a deterministic, rebuildable Story -> GraphRAG projection.
 *
 * Formal records remain the source of truth. The only derived edge means
 * "this accepted extraction was supported by this exact chapter span"; no
 * story-world relationship is inferred from prose.
 */
export class BuildAuthoritativeStoryGraphProjection {
  public constructor(
    private readonly sources: AuthoritativeStoryGraphReadSources,
    private readonly hasher: ContentHasher,
  ) {}

  public async execute(
    projectIdValue: string,
  ): Promise<Result<AuthoritativeStoryGraphProjectionBuild, AppError>> {
    const domainProjectId = parseDomainUuidV7(projectIdValue);
    if (!domainProjectId.ok) {
      return domainProjectId;
    }
    const storyProjectId = parseStoryUuidV7(projectIdValue);
    if (!storyProjectId.ok) {
      return err(
        new AppError({
          code: "INVALID_UUID",
          message: "The Story graph project identifier is invalid.",
        }),
      );
    }

    try {
      return ok(await this.build(domainProjectId.value, storyProjectId.value));
    } catch (cause: unknown) {
      return err(normalizeBuildFailure(cause, domainProjectId.value));
    }
  }

  private async build(
    domainProjectId: DomainUuidV7,
    storyProjectId: StoryUuidV7,
  ): Promise<AuthoritativeStoryGraphProjectionBuild> {
    const [formalResult, extractionResult, consistencyResult, chapterResult] = await Promise.all([
      this.sources.formalRecords.listByProjectId(storyProjectId),
      this.sources.extractionReviews.listByProjectId(storyProjectId),
      this.sources.consistencyReviews.listByProjectId(storyProjectId),
      this.sources.chapters.listByProjectId(domainProjectId),
    ]);
    if (!formalResult.ok) {
      throw normalizeStoryReadFailure(formalResult.error, "FORMAL_RECORD_LIST");
    }
    if (!extractionResult.ok) {
      throw normalizeStoryReadFailure(extractionResult.error, "EXTRACTION_REVIEW_ITEM_LIST");
    }
    if (!consistencyResult.ok) {
      throw normalizeStoryReadFailure(consistencyResult.error, "CONSISTENCY_REVIEW_ITEM_LIST");
    }
    if (!chapterResult.ok) {
      throw chapterResult.error;
    }
    if (formalResult.value.length > MAX_FORMAL_RECORDS) {
      throw new ProjectionCapacityFailure(
        "formal_records",
        MAX_FORMAL_RECORDS,
        formalResult.value.length,
      );
    }
    const reviewItemCount = extractionResult.value.length + consistencyResult.value.length;
    if (reviewItemCount > MAX_REVIEW_ITEMS) {
      throw new ProjectionCapacityFailure("review_items", MAX_REVIEW_ITEMS, reviewItemCount);
    }
    if (chapterResult.value.length > MAX_CHAPTERS) {
      throw new ProjectionCapacityFailure("chapters", MAX_CHAPTERS, chapterResult.value.length);
    }

    const records = validateFormalRecords(formalResult.value, storyProjectId);
    const reviews = validateReviewItems(
      [...extractionResult.value, ...consistencyResult.value],
      storyProjectId,
    );
    const chapters = validateChapters(chapterResult.value, domainProjectId);
    const reviewById = new Map<string, StructuredReviewItemSnapshot>(
      reviews.map((review) => [review.id, review]),
    );
    const chapterById = new Map<string, ReturnType<Chapter["toSnapshot"]>>(
      chapters.map((chapter) => [chapter.id, chapter]),
    );
    const sourceVersions: GraphSourceVersion[] = [];
    const entities: GraphEntity[] = [];
    const relations: GraphRelation[] = [];
    const skipCounts = new Map<AuthoritativeStoryGraphSkipReason, number>();
    const projectedChapters = new Set<string>();
    const usedReviewIds = new Set<string>();
    const chapterProjectionCache = new Map<
      string,
      | Readonly<{
          status: "valid";
          version: Awaited<ReturnType<typeof loadVersionSnapshot>>;
          contentHash: string;
        }>
      | Readonly<{
          status: "unsupported";
          issue: GraphSourceContentIssue;
          version: Awaited<ReturnType<typeof loadVersionSnapshot>>;
          contentHash: string;
        }>
    >();
    let sourceUtf8Bytes = 0;
    let nonReviewDerivedFormalCount = 0;
    let nonExtractionReviewFormalCount = 0;

    for (const record of records) {
      const currentVersion = requireFormalCurrentVersion(record);
      const formalContent = canonicalJson({
        currentValue: currentVersion.value,
        currentVersion: record.currentVersion,
        kind: record.kind,
        projectId: record.projectId,
        recordId: record.id,
        recordKey: record.recordKey,
        schema: "inkshadow.authoritative-formal-graph-source/v1",
      });
      if (graphSourceContentIssue(formalContent) !== null) {
        throw new ProjectionIntegrityFailure("FORMAL_GRAPH_SOURCE_CONTENT_UNSUPPORTED");
      }
      sourceUtf8Bytes = consumeSourceBudget(sourceUtf8Bytes, formalContent);
      const formalHash = await this.requireHash(formalContent);
      const formalSourceId = formalSourceIdentity(record.id);
      const formalSourceVersionId = `${formalSourceId}:version:${String(record.currentVersion)}`;
      sourceVersions.push({
        projectId: record.projectId,
        sourceId: formalSourceId,
        sourceVersionId: formalSourceVersionId,
        contentHash: formalHash,
        content: formalContent,
        createdAt: currentVersion.createdAt,
      });
      entities.push({
        id: formalEntityIdentity(record.id),
        projectId: record.projectId,
        kind: record.kind,
        label: record.recordKey,
        source: {
          sourceId: formalSourceId,
          sourceVersionId: formalSourceVersionId,
          contentHash: formalHash,
        },
        documentId: `formal-record:${record.id}`,
        updatedAt: record.updatedAt,
      });

      if (
        currentVersion.reason !== "suggestion_accepted" &&
        currentVersion.reason !== "suggestion_modified"
      ) {
        nonReviewDerivedFormalCount += 1;
        continue;
      }
      if (currentVersion.sourceReviewItemId === null) {
        throw new ProjectionIntegrityFailure("FORMAL_REVIEW_LINK_MISSING");
      }
      if (usedReviewIds.has(currentVersion.sourceReviewItemId)) {
        throw new ProjectionIntegrityFailure("REVIEW_ITEM_REUSED_BY_FORMAL_RECORDS");
      }
      usedReviewIds.add(currentVersion.sourceReviewItemId);

      const review = reviewById.get(currentVersion.sourceReviewItemId);
      if (review === undefined) {
        throw new ProjectionIntegrityFailure("FORMAL_REVIEW_ROW_MISSING");
      }
      assertReviewBindsCurrentFormalVersion(review, record, currentVersion);
      if (review.itemType !== "extraction") {
        nonExtractionReviewFormalCount += 1;
        continue;
      }

      const chapter = await resolveCurrentChapter(
        review.sourceChapterId,
        chapterById,
        this.sources.chapters,
        domainProjectId,
      );
      if (chapter === undefined) {
        incrementSkip(skipCounts, "current_chapter_missing");
        continue;
      }
      if (chapter.status === "trashed") {
        incrementSkip(skipCounts, "current_chapter_trashed");
        continue;
      }
      if (String(chapter.currentVersionId) !== String(review.sourceVersionId)) {
        incrementSkip(skipCounts, "current_chapter_version_changed");
        continue;
      }
      const chapterVersionKey = `${chapter.projectId}:${chapter.id}:${chapter.currentVersionId}`;
      let chapterProjection = chapterProjectionCache.get(chapterVersionKey);
      if (chapterProjection === undefined) {
        const version = await loadVersionSnapshot(
          this.sources.chapterVersions,
          chapter.currentVersionId,
        );
        assertCurrentChapterVersion(version, chapter, domainProjectId);
        const contentHash = await this.requireHash(chapter.content);
        if (version.contentChecksum !== contentHash) {
          throw new ProjectionIntegrityFailure("CHAPTER_VERSION_CHECKSUM_MISMATCH");
        }
        const chapterSourceIssue = graphSourceContentIssue(chapter.content);
        if (chapterSourceIssue !== null) {
          chapterProjection = Object.freeze({
            status: "unsupported" as const,
            issue: chapterSourceIssue,
            version,
            contentHash,
          });
        } else {
          chapterProjection = Object.freeze({
            status: "valid" as const,
            version,
            contentHash,
          });
        }
        chapterProjectionCache.set(chapterVersionKey, chapterProjection);
      }
      if (chapterProjection.status === "unsupported") {
        incrementSkip(skipCounts, chapterSourceSkipReason(chapterProjection.issue));
        continue;
      }
      const { version: chapterVersion, contentHash: chapterHash } = chapterProjection;
      assertExactUtf16Evidence(review, chapter.content);
      if (!projectedChapters.has(chapter.id)) {
        sourceUtf8Bytes = consumeSourceBudget(sourceUtf8Bytes, chapter.content);
      }

      const chapterSourceId = chapterSourceIdentity(chapter.id);
      if (!projectedChapters.has(chapter.id)) {
        projectedChapters.add(chapter.id);
        sourceVersions.push({
          projectId: chapter.projectId,
          sourceId: chapterSourceId,
          sourceVersionId: chapter.currentVersionId,
          contentHash: chapterHash,
          content: chapter.content,
          createdAt: chapterVersion.createdAt,
        });
        entities.push({
          id: chapterEntityIdentity(chapter.id),
          projectId: chapter.projectId,
          kind: "chapter",
          label: chapter.title,
          source: {
            sourceId: chapterSourceId,
            sourceVersionId: chapter.currentVersionId,
            contentHash: chapterHash,
          },
          documentId: `chapter:${chapter.id}`,
          updatedAt: chapter.updatedAt,
        });
      }

      relations.push({
        id: `extraction-review:${review.id}`,
        projectId: record.projectId,
        fromEntityId: chapterEntityIdentity(chapter.id),
        toEntityId: formalEntityIdentity(record.id),
        kind: AUTHORITATIVE_STORY_GRAPH_RELATION_KIND,
        polarity: "affirmed",
        // This is the authority of an explicit human decision, not the
        // model's pre-review confidence.
        confidence: 1,
        evidence: [
          {
            id: `extraction-review-evidence:${review.id}`,
            projectId: record.projectId,
            sourceId: chapterSourceId,
            sourceVersionId: chapter.currentVersionId,
            contentHash: chapterHash,
            span: {
              startOffset: review.evidence.range.start,
              endOffset: review.evidence.range.end,
              encoding: "utf16",
            },
            quote: review.evidence.excerpt,
            spanHash: graphEvidenceSpanHash(review.evidence.excerpt),
            citation: {
              label: chapter.title,
              locator: `utf16:${String(review.evidence.range.start)}-${String(
                review.evidence.range.end,
              )}`,
            },
          },
        ],
        updatedAt: review.updatedAt,
      });
    }

    const candidate: GraphRagProjectSnapshot = {
      projectId: domainProjectId,
      sourceVersions: sourceVersions.map((source) => ({ source, state: "current" as const })),
      entities,
      relations,
    };
    const index = new InMemoryGraphRagIndex();
    try {
      index.restoreProject(candidate);
    } catch {
      throw new ProjectionIntegrityFailure("DERIVED_GRAPH_SELF_VALIDATION_FAILED");
    }
    const snapshot = index.snapshotProject(domainProjectId);
    if (snapshot === undefined) {
      throw new ProjectionIntegrityFailure("DERIVED_GRAPH_SNAPSHOT_MISSING");
    }

    const skipped = [...skipCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => Object.freeze({ reason, count }));
    const skippedRelationCount = skipped.reduce((total, item) => total + item.count, 0);
    const invalidatedSupportCount = skipped
      .filter(({ reason }) => STALE_SKIP_REASONS.has(reason))
      .reduce((total, item) => total + item.count, 0);
    const projectionOmissionCount = skippedRelationCount - invalidatedSupportCount;
    return {
      snapshot,
      diagnostics: Object.freeze({
        formalRecordCount: records.length,
        reviewItemCount: reviews.length,
        chapterCount: chapters.length,
        formalEntityCount: records.length,
        chapterEntityCount: projectedChapters.size,
        relationCount: relations.length,
        sourceVersionCount: snapshot.sourceVersions.length,
        skippedRelationCount,
        invalidatedSupportCount,
        projectionOmissionCount,
        nonReviewDerivedFormalCount,
        nonExtractionReviewFormalCount,
        skipped: Object.freeze(skipped),
        partial: projectionOmissionCount > 0,
        stale: invalidatedSupportCount > 0,
      }),
    };
  }

  private async requireHash(content: string): Promise<string> {
    const hashed = await this.hasher.sha256(content);
    if (!hashed.ok) {
      throw hashed.error;
    }
    const digest = String(hashed.value);
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      throw new ProjectionIntegrityFailure("CONTENT_HASHER_CONTRACT_INVALID");
    }
    return digest;
  }
}

/**
 * Rebuilds the projection with a bounded compare-and-swap loop. Each retry
 * captures the graph revision before rereading authoritative inputs, so a
 * concurrent graph mutation can never be silently overwritten.
 *
 * Production callers must execute the repository and every authoritative
 * reader inside one serializable database transaction. This generic use case
 * cannot manufacture a cross-repository authority snapshot on its own.
 */
export class RebuildAuthoritativeStoryGraphProjection {
  public constructor(
    private readonly builder: BuildAuthoritativeStoryGraphProjection,
    private readonly repository: GraphRagProjectionRepository,
    private readonly clock: Clock,
  ) {}

  public async execute(
    projectId: string,
  ): Promise<Result<AuthoritativeStoryGraphRebuildReceipt, AppError>> {
    for (let attempt = 1; attempt <= AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = await this.repository.loadProject(projectId);
      if (!loaded.ok) {
        return loaded;
      }
      const expectedRevision = loaded.value?.revision ?? 0;
      if (loaded.value !== null && loaded.value.projectId !== projectId) {
        return err(graphProjectionContractError(projectId, "PROJECT_SCOPE_MISMATCH"));
      }
      if (loaded.value !== null && !isExclusivelyStoryOwnedProjection(loaded.value)) {
        return err(graphProjectionContractError(projectId, "NON_STORY_GRAPH_OWNERSHIP_DETECTED"));
      }

      const built = await this.builder.execute(projectId);
      if (!built.ok) {
        return built;
      }
      if (built.value.snapshot.projectId !== projectId) {
        return err(graphProjectionContractError(projectId, "BUILT_PROJECT_SCOPE_MISMATCH"));
      }

      const rebuiltAt = this.clock.now();
      const replaced = await this.repository.replaceProject({
        snapshot: built.value.snapshot,
        expectedRevision,
        mutatedAt: rebuiltAt,
      });
      if (replaced.ok) {
        if (
          replaced.value.projectId !== projectId ||
          replaced.value.previousRevision !== expectedRevision ||
          replaced.value.revision !== expectedRevision + 1 ||
          replaced.value.updatedAt !== rebuiltAt
        ) {
          return err(graphProjectionContractError(projectId, "MUTATION_RECEIPT_MISMATCH"));
        }
        return ok({
          ...built.value.diagnostics,
          projectId: replaced.value.projectId,
          previousRevision: replaced.value.previousRevision,
          revision: replaced.value.revision,
          rebuiltAt: replaced.value.updatedAt,
          casAttempts: attempt,
        });
      }
      if (!isExpectedGraphRevisionConflict(replaced.error, projectId, expectedRevision)) {
        return replaced;
      }
    }

    return err(
      new AppError({
        code: "VERSION_CONFLICT",
        message: "The Story graph changed repeatedly while it was being rebuilt.",
        retryable: true,
        actions: ["RETRY"],
        details: {
          operation: "AUTHORITATIVE_STORY_GRAPH_REBUILD",
          attempts: AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS,
        },
      }),
    );
  }
}

function validateFormalRecords(
  records: readonly FormalStoryRecord[],
  projectId: StoryUuidV7,
): readonly FormalStoryRecordSnapshot[] {
  const validated = records.map((record) => {
    const snapshot = record.toSnapshot();
    const rehydrated = FormalStoryRecord.rehydrate(snapshot);
    if (!rehydrated.ok) {
      throw new ProjectionIntegrityFailure("FORMAL_RECORD_SNAPSHOT_INVALID");
    }
    return rehydrated.value.toSnapshot();
  });
  if (
    validated.reduce((total, record) => total + record.versions.length, 0) >
    MAX_TOTAL_FORMAL_VERSIONS
  ) {
    throw new ProjectionCapacityFailure(
      "formal_versions",
      MAX_TOTAL_FORMAL_VERSIONS,
      validated.reduce((total, record) => total + record.versions.length, 0),
    );
  }
  assertScopedUniqueIds(validated, projectId, "FORMAL_RECORD");
  return validated.sort((left, right) => left.id.localeCompare(right.id));
}

function validateReviewItems(
  reviews: readonly StructuredReviewItem[],
  projectId: StoryUuidV7,
): readonly StructuredReviewItemSnapshot[] {
  const validated = reviews.map((review) => {
    const snapshot = review.toSnapshot();
    const rehydrated = StructuredReviewItem.rehydrate(snapshot);
    if (!rehydrated.ok) {
      throw new ProjectionIntegrityFailure("REVIEW_ITEM_SNAPSHOT_INVALID");
    }
    return rehydrated.value.toSnapshot();
  });
  if (
    validated.reduce((total, review) => total + review.decisions.length, 0) >
    MAX_TOTAL_REVIEW_DECISIONS
  ) {
    throw new ProjectionCapacityFailure(
      "review_decisions",
      MAX_TOTAL_REVIEW_DECISIONS,
      validated.reduce((total, review) => total + review.decisions.length, 0),
    );
  }
  assertScopedUniqueIds(validated, projectId, "REVIEW_ITEM");
  return validated.sort((left, right) => left.id.localeCompare(right.id));
}

function validateChapters(
  chapters: Awaited<ReturnType<ChapterRepository["listByProjectId"]>> extends Result<
    infer Value,
    AppError
  >
    ? Value
    : never,
  projectId: DomainUuidV7,
): readonly ReturnType<Chapter["toSnapshot"]>[] {
  const validated = chapters.map((chapter) => {
    const rehydrated = Chapter.rehydrate(chapter.toSnapshot());
    if (!rehydrated.ok) {
      throw new ProjectionIntegrityFailure("CHAPTER_SNAPSHOT_INVALID");
    }
    return rehydrated.value.toSnapshot();
  });
  assertScopedUniqueIds(validated, projectId, "CHAPTER");
  const currentVersionIds = new Set<string>();
  for (const chapter of validated) {
    if (currentVersionIds.has(chapter.currentVersionId)) {
      throw new ProjectionIntegrityFailure("CURRENT_CHAPTER_VERSION_ID_DUPLICATED");
    }
    currentVersionIds.add(chapter.currentVersionId);
  }
  return validated.sort((left, right) => left.id.localeCompare(right.id));
}

async function loadVersionSnapshot(
  versions: ChapterVersionRepository,
  versionId: DomainUuidV7,
): Promise<ReturnType<ChapterVersion["toSnapshot"]>> {
  const loaded = await versions.findVersionById(versionId);
  if (!loaded.ok) {
    throw loaded.error;
  }
  if (loaded.value === null) {
    throw new ProjectionIntegrityFailure("CURRENT_CHAPTER_VERSION_MISSING");
  }
  const rehydrated = ChapterVersion.create(loaded.value.toSnapshot());
  if (!rehydrated.ok) {
    throw new ProjectionIntegrityFailure("CHAPTER_VERSION_SNAPSHOT_INVALID");
  }
  const snapshot = rehydrated.value.toSnapshot();
  if (snapshot.id !== versionId) {
    throw new ProjectionIntegrityFailure("CHAPTER_VERSION_LOOKUP_MISMATCH");
  }
  return snapshot;
}

async function resolveCurrentChapter(
  chapterIdValue: string,
  chapters: ReadonlyMap<string, ReturnType<Chapter["toSnapshot"]>>,
  repository: ChapterRepository,
  projectId: DomainUuidV7,
): Promise<ReturnType<Chapter["toSnapshot"]> | undefined> {
  const listed = chapters.get(chapterIdValue);
  if (listed !== undefined) {
    return listed;
  }
  const chapterId = parseDomainUuidV7(chapterIdValue);
  if (!chapterId.ok) {
    throw new ProjectionIntegrityFailure("REVIEW_CHAPTER_ID_INVALID");
  }
  const loaded = await repository.findById(chapterId.value);
  if (!loaded.ok) {
    throw loaded.error;
  }
  if (loaded.value === null) {
    return undefined;
  }
  const rehydrated = Chapter.rehydrate(loaded.value.toSnapshot());
  if (!rehydrated.ok) {
    throw new ProjectionIntegrityFailure("REVIEW_CHAPTER_SNAPSHOT_INVALID");
  }
  const snapshot = rehydrated.value.toSnapshot();
  if (snapshot.projectId !== projectId) {
    throw new ProjectionIntegrityFailure("REVIEW_CHAPTER_PROJECT_SCOPE_MISMATCH");
  }
  throw new ProjectionIntegrityFailure("CHAPTER_PROJECT_LIST_INCOMPLETE");
}

function assertCurrentChapterVersion(
  version: ReturnType<ChapterVersion["toSnapshot"]>,
  chapter: ReturnType<Chapter["toSnapshot"]>,
  projectId: DomainUuidV7,
): void {
  if (
    version.id !== chapter.currentVersionId ||
    version.chapterId !== chapter.id ||
    version.projectId !== projectId ||
    chapter.projectId !== projectId ||
    version.content !== chapter.content
  ) {
    throw new ProjectionIntegrityFailure("CURRENT_CHAPTER_PROJECTION_MISMATCH");
  }
}

function assertReviewBindsCurrentFormalVersion(
  review: StructuredReviewItemSnapshot,
  record: FormalStoryRecordSnapshot,
  currentVersion: FormalStoryRecordSnapshot["versions"][number],
): void {
  const expectedStatus = currentVersion.reason === "suggestion_accepted" ? "accepted" : "modified";
  const previousVersion =
    currentVersion.previousVersion === null
      ? undefined
      : record.versions.find((version) => version.version === currentVersion.previousVersion);
  const finalDecision = review.decisions.at(-1);
  if (
    review.projectId !== record.projectId ||
    review.targetRecordId !== record.id ||
    review.targetRecordKind !== record.kind ||
    review.status !== expectedStatus ||
    previousVersion === undefined ||
    !storyValuesEqual(review.originalValue, previousVersion.value) ||
    review.finalValue === null ||
    !storyValuesEqual(review.finalValue, currentVersion.value) ||
    finalDecision?.kind !== expectedStatus ||
    finalDecision.actorId !== currentVersion.actorId ||
    finalDecision.decidedAt > currentVersion.createdAt ||
    review.updatedAt !== finalDecision.decidedAt ||
    finalDecision.finalValue === null ||
    !storyValuesEqual(finalDecision.finalValue, currentVersion.value)
  ) {
    throw new ProjectionIntegrityFailure("FORMAL_REVIEW_BINDING_MISMATCH");
  }
}

function assertExactUtf16Evidence(review: StructuredReviewItemSnapshot, content: string): void {
  const { start, end, sourceLength } = review.evidence.range;
  if (
    sourceLength !== content.length ||
    start < 0 ||
    end > content.length ||
    !isUtf16CodePointBoundary(content, start) ||
    !isUtf16CodePointBoundary(content, end) ||
    content.slice(start, end) !== review.evidence.excerpt
  ) {
    throw new ProjectionIntegrityFailure("REVIEW_EVIDENCE_FORGED_OR_CORRUPT");
  }
}

function requireFormalCurrentVersion(
  record: FormalStoryRecordSnapshot,
): FormalStoryRecordSnapshot["versions"][number] {
  const current = record.versions.find((version) => version.version === record.currentVersion);
  if (current === undefined) {
    throw new ProjectionIntegrityFailure("FORMAL_CURRENT_VERSION_MISSING");
  }
  return current;
}

function assertScopedUniqueIds(
  values: readonly { readonly id: string; readonly projectId: string }[],
  projectId: string,
  kind: string,
): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (value.projectId !== projectId) {
      throw new ProjectionIntegrityFailure(`${kind}_PROJECT_SCOPE_MISMATCH`);
    }
    if (ids.has(value.id)) {
      throw new ProjectionIntegrityFailure(`${kind}_ID_DUPLICATED`);
    }
    ids.add(value.id);
  }
}

function incrementSkip(
  counts: Map<AuthoritativeStoryGraphSkipReason, number>,
  reason: AuthoritativeStoryGraphSkipReason,
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function consumeSourceBudget(current: number, content: string): number {
  const next = current + new TextEncoder().encode(content).byteLength;
  if (!Number.isSafeInteger(next) || next > MAX_PROJECTION_SOURCE_UTF8_BYTES) {
    throw new ProjectionCapacityFailure(
      "projection_source_utf8_bytes",
      MAX_PROJECTION_SOURCE_UTF8_BYTES,
      next,
    );
  }
  return next;
}

function chapterSourceSkipReason(
  issue: GraphSourceContentIssue,
): AuthoritativeStoryGraphSkipReason {
  switch (issue) {
    case "ill_formed_utf16":
      return "chapter_source_ill_formed_utf16";
    case "too_large":
      return "chapter_source_too_large";
    case "unsafe_control":
      return "chapter_source_unsafe_control";
    case "empty":
      throw new ProjectionIntegrityFailure("ACCEPTED_REVIEW_EMPTY_CHAPTER_SOURCE");
  }
}

function isExclusivelyStoryOwnedProjection(snapshot: GraphRagProjectSnapshot): boolean {
  return (
    snapshot.sourceVersions.every(
      ({ source }) =>
        source.sourceId.startsWith("formal-source:") ||
        source.sourceId.startsWith("chapter-source:"),
    ) &&
    snapshot.entities.every(
      (entity) => entity.id.startsWith("formal:") || entity.id.startsWith("chapter:"),
    ) &&
    snapshot.relations.every(
      (relation) =>
        relation.id.startsWith("extraction-review:") &&
        relation.kind === AUTHORITATIVE_STORY_GRAPH_RELATION_KIND &&
        relation.evidence.every((evidence) =>
          evidence.id.startsWith("extraction-review-evidence:"),
        ),
    )
  );
}

function isExpectedGraphRevisionConflict(
  error: AppError,
  projectId: string,
  expectedRevision: number,
): boolean {
  return (
    error.code === "VERSION_CONFLICT" &&
    error.details.projectId === projectId &&
    error.details.expectedRevision === expectedRevision &&
    Number.isSafeInteger(error.details.actualRevision) &&
    (error.details.actualRevision as number) !== expectedRevision
  );
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new ProjectionIntegrityFailure("FORMAL_CANONICAL_JSON_INVALID");
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function formalSourceIdentity(recordId: string): string {
  return `formal-source:${recordId}`;
}

function formalEntityIdentity(recordId: string): string {
  return `formal:${recordId}`;
}

function chapterSourceIdentity(chapterId: string): string {
  return `chapter-source:${chapterId}`;
}

function chapterEntityIdentity(chapterId: string): string {
  return `chapter:${chapterId}`;
}

function normalizeStoryReadFailure(error: StoryCoreError, operation: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "Unable to read the authoritative Story source for graph rebuilding.",
    retryable: error.retryable,
    actions: error.retryable ? ["RETRY"] : ["CONTACT_SUPPORT"],
    details: {
      operation,
      sourceErrorCode: error.code,
    },
  });
}

function normalizeBuildFailure(cause: unknown, projectId: string): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  if (cause instanceof ProjectionCapacityFailure) {
    return projectionCapacityError(projectId, cause);
  }
  if (cause instanceof ProjectionIntegrityFailure) {
    return authoritativeSourceIntegrityError(projectId, cause.reason);
  }
  return authoritativeSourceIntegrityError(projectId, "UNEXPECTED_BUILD_FAILURE");
}

function projectionCapacityError(projectId: string, failure: ProjectionCapacityFailure): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message: "This project exceeds the current Story graph projection capacity.",
    actions: ["REDUCE_CONTEXT"],
    details: {
      operation: "AUTHORITATIVE_STORY_GRAPH_CAPACITY",
      projectId,
      capacity: failure.capacity,
      limit: failure.limit,
      actual: failure.actual,
    },
  });
}

function authoritativeSourceIntegrityError(projectId: string, reason: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The authoritative Story source failed Graph projection integrity validation.",
    actions: ["CONTACT_SUPPORT"],
    details: {
      operation: "AUTHORITATIVE_STORY_GRAPH_SOURCE_CORRUPT",
      projectId,
      reason,
    },
  });
}

function graphProjectionContractError(projectId: string, reason: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The Story graph projection repository violated its ownership or mutation contract.",
    actions: ["CONTACT_SUPPORT"],
    details: {
      operation: "AUTHORITATIVE_STORY_GRAPH_PROJECTION_CONTRACT",
      projectId,
      reason,
    },
  });
}

class ProjectionIntegrityFailure extends Error {
  public constructor(public readonly reason: string) {
    super(reason);
    this.name = "ProjectionIntegrityFailure";
  }
}

class ProjectionCapacityFailure extends Error {
  public constructor(
    public readonly capacity: string,
    public readonly limit: number,
    public readonly actual: number,
  ) {
    super(`${capacity}:${String(actual)}>${String(limit)}`);
    this.name = "ProjectionCapacityFailure";
  }
}
