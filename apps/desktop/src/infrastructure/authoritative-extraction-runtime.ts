import type { ContentHasher } from "@inkshadow/application";
import type { SqlExecutor } from "@inkshadow/data";
import {
  AuthoritativeExtractionCoordinator,
  FormalRecordApplicationService,
  ReviewDecisionService,
  SqliteAuthoritativeExtractionRepository,
  SqliteChapterVersionReader,
  SqliteFormalStoryRecordRepository,
  SqliteReviewDecisionUnitOfWork,
  SqliteReviewItemRepository,
  StoryCoreError,
  err,
  ok,
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type AuthoritativeExtractionCandidateRecord,
  type AuthoritativeExtractionContentHasher,
  type AuthoritativeExtractionCycleReceipt,
  type AuthoritativeExtractionEvaluationReceipt,
  type AuthoritativeExtractionExecutionMode,
  type AuthoritativeExtractionGoldenSuite,
  type AuthoritativeExtractionJob,
  type AuthoritativeExtractionProvider,
  type AuthoritativeExtractionProvenance,
  type AuthoritativeExtractionRepository,
  type AuthoritativeExtractionSourceReader,
  type Clock as StoryClock,
  type FormalStoryRecord,
  type FormalStoryRecordSnapshot,
  type Result,
  type StructuredReviewItemSnapshot,
  type UuidV7Generator as StoryUuidV7Generator,
} from "@inkshadow/story-core";

import type { StoryGraphFreshness, StoryGraphRuntimePort } from "./story-graph-runtime";

export type AuthoritativeExtractionPersistenceKind = "native_sqlite" | "browser_development";

export type AuthoritativeExtractionAvailability =
  | Readonly<{
      available: true;
      persistence: "native_sqlite";
      providerConfigured: true;
    }>
  | Readonly<{
      available: false;
      reason: "feature_disabled" | "native_sqlite_required" | "provider_not_configured";
      persistence: AuthoritativeExtractionPersistenceKind;
      providerConfigured: boolean;
    }>;

export interface AuthoritativeExtractionDashboardCandidate {
  readonly extraction: AuthoritativeExtractionCandidateRecord;
  readonly review: StructuredReviewItemSnapshot<"extraction"> | null;
  readonly target: FormalStoryRecordSnapshot | null;
}

export interface AuthoritativeExtractionDashboard {
  readonly projectId: string;
  readonly jobs: readonly AuthoritativeExtractionJob[];
  readonly candidates: readonly AuthoritativeExtractionDashboardCandidate[];
  readonly evaluationPassed: boolean;
  readonly graphFreshness: StoryGraphFreshness | "unavailable";
}

export interface AuthoritativeExtractionFormalDecisionInput {
  readonly jobId: string;
  readonly candidateKey: string;
  readonly kind: "accept" | "modify";
  readonly actorId: string;
  readonly humanConfirmed: boolean;
  readonly modifiedValue?: unknown;
}

export interface AuthoritativeExtractionReviewDecisionInput {
  readonly jobId: string;
  readonly candidateKey: string;
  readonly kind: "reject" | "defer" | "resume";
  readonly actorId: string;
  readonly humanConfirmed: boolean;
  readonly remindAt?: string;
}

export interface AuthoritativeExtractionDecisionReceipt {
  readonly review: StructuredReviewItemSnapshot<"extraction">;
  readonly target: FormalStoryRecordSnapshot | null;
  readonly idempotent: boolean;
  readonly projection: "not_required" | "rebuilt" | "pending";
  readonly projectionErrorCode: string | null;
}

export interface AuthoritativeExtractionUndoReceipt {
  readonly target: FormalStoryRecordSnapshot;
  readonly idempotent: boolean;
  readonly projection: "rebuilt" | "pending";
  readonly projectionErrorCode: string | null;
}

export interface AuthoritativeExtractionDesktopPort {
  readonly availability: AuthoritativeExtractionAvailability;
  readonly goldenSuite?: AuthoritativeExtractionGoldenSuite;

  inspect(projectId: string): Promise<Result<AuthoritativeExtractionDashboard, StoryCoreError>>;

  runCycle(
    projectId: string,
    options: Readonly<{ online: boolean; maximumJobs?: number }>,
  ): Promise<Result<AuthoritativeExtractionCycleReceipt, StoryCoreError>>;

  runEvaluation(
    suite: AuthoritativeExtractionGoldenSuite,
  ): Promise<Result<AuthoritativeExtractionEvaluationReceipt, StoryCoreError>>;

  cancel(jobId: string): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>>;

  decideFormal(
    input: AuthoritativeExtractionFormalDecisionInput,
  ): Promise<Result<AuthoritativeExtractionDecisionReceipt, StoryCoreError>>;

  decideReview(
    input: AuthoritativeExtractionReviewDecisionInput,
  ): Promise<Result<AuthoritativeExtractionDecisionReceipt, StoryCoreError>>;

  undoAcceptance(
    input: Readonly<{
      jobId: string;
      candidateKey: string;
      actorId: string;
      humanConfirmed: boolean;
    }>,
  ): Promise<Result<AuthoritativeExtractionUndoReceipt, StoryCoreError>>;

  rebuildProjection(
    projectId: string,
  ): Promise<Result<Readonly<{ projection: "rebuilt" }>, StoryCoreError>>;
}

export interface CreateAuthoritativeExtractionDesktopRuntimeOptions {
  /** Default is false even when every other dependency is present. */
  readonly featureEnabled?: boolean;
  readonly persistence: AuthoritativeExtractionPersistenceKind;
  readonly executor: SqlExecutor;
  readonly provider?: AuthoritativeExtractionProvider;
  readonly graph: StoryGraphRuntimePort;
  readonly contentHasher: ContentHasher;
  readonly clock: StoryClock;
  readonly ids: StoryUuidV7Generator;
  readonly provenance: AuthoritativeExtractionProvenance;
  readonly evaluationSuiteId: string;
  readonly goldenSuite?: AuthoritativeExtractionGoldenSuite;
  readonly executionMode: AuthoritativeExtractionExecutionMode;
  readonly workerId?: string;
  readonly captureProjectContextAuthority?: (projectId: string) => Promise<() => Promise<void>>;
}

export function createAuthoritativeExtractionDesktopRuntime(
  options: CreateAuthoritativeExtractionDesktopRuntimeOptions,
): AuthoritativeExtractionDesktopPort {
  const featureEnabled = options.featureEnabled ?? false;
  if (!featureEnabled) {
    return new UnavailableAuthoritativeExtractionRuntime({
      available: false,
      reason: "feature_disabled",
      persistence: options.persistence,
      providerConfigured: options.provider !== undefined,
    });
  }
  if (options.persistence !== "native_sqlite") {
    return new UnavailableAuthoritativeExtractionRuntime({
      available: false,
      reason: "native_sqlite_required",
      persistence: options.persistence,
      providerConfigured: options.provider !== undefined,
    });
  }
  if (options.provider === undefined) {
    return new UnavailableAuthoritativeExtractionRuntime({
      available: false,
      reason: "provider_not_configured",
      persistence: options.persistence,
      providerConfigured: false,
    });
  }

  const repository = new SqliteAuthoritativeExtractionRepository(options.executor);
  const reviewItems = new SqliteReviewItemRepository(options.executor, "extraction");
  const records = new SqliteFormalStoryRecordRepository(options.executor);
  const coordinator = new AuthoritativeExtractionCoordinator({
    enabled: true,
    executionMode: options.executionMode,
    evaluationSuiteId: options.evaluationSuiteId,
    provenance: options.provenance,
    repository,
    sources: new SqliteAuthoritativeExtractionSourceReader(options.executor),
    formalRecords: records,
    reviewItems,
    provider: options.provider,
    hasher: new ApplicationHasherAdapter(options.contentHasher),
    clock: options.clock,
    ids: options.ids,
    workerId: options.workerId ?? "authoritative.extraction.desktop",
    ...(options.captureProjectContextAuthority === undefined
      ? {}
      : { captureProjectContextAuthority: options.captureProjectContextAuthority }),
  });
  const decisions = new AuthoritativeExtractionReviewCoordinator({
    extraction: repository,
    reviewItems,
    records,
    decisionService: new ReviewDecisionService({
      items: reviewItems,
      records,
      sourceVersions: new SqliteChapterVersionReader(options.executor),
      transaction: new SqliteReviewDecisionUnitOfWork(options.executor, "extraction"),
      clock: options.clock,
      ids: options.ids,
    }),
    formalService: new FormalRecordApplicationService({
      records,
      clock: options.clock,
      ids: options.ids,
    }),
    graph: options.graph,
    hasher: new ApplicationHasherAdapter(options.contentHasher),
    clock: options.clock,
    ids: options.ids,
  });
  return new SqliteAuthoritativeExtractionDesktopRuntime({
    repository,
    reviewItems,
    records,
    coordinator,
    decisions,
    graph: options.graph,
    provenance: options.provenance,
    suiteId: options.evaluationSuiteId,
    ...(options.goldenSuite === undefined ? {} : { goldenSuite: options.goldenSuite }),
  });
}

interface ReviewCoordinatorOptions {
  readonly extraction: AuthoritativeExtractionRepository;
  readonly reviewItems: SqliteReviewItemRepository<"extraction">;
  readonly records: SqliteFormalStoryRecordRepository;
  readonly decisionService: ReviewDecisionService<"extraction">;
  readonly formalService: FormalRecordApplicationService;
  readonly graph: StoryGraphRuntimePort;
  readonly hasher: AuthoritativeExtractionContentHasher;
  readonly clock: StoryClock;
  readonly ids: StoryUuidV7Generator;
}

export class AuthoritativeExtractionReviewCoordinator {
  public constructor(private readonly options: ReviewCoordinatorOptions) {}

  public async decideFormal(
    input: AuthoritativeExtractionFormalDecisionInput,
  ): Promise<Result<AuthoritativeExtractionDecisionReceipt, StoryCoreError>> {
    if (!input.humanConfirmed) {
      return humanRequired();
    }
    const candidate = await this.loadCandidate(input.jobId, input.candidateKey);
    if (!candidate.ok) {
      return candidate;
    }
    const actorId = parseUuidV7(input.actorId);
    if (!actorId.ok) {
      return actorId;
    }
    if (
      input.kind === "modify" &&
      (input.modifiedValue === undefined ||
        storyJson(input.modifiedValue) === storyJson(candidate.value.candidate.suggestedValue))
    ) {
      return validationError("Modified acceptance requires a distinct final value.");
    }
    const payload = canonicalJson({
      actorId: actorId.value,
      finalValue:
        input.kind === "modify" ? input.modifiedValue : candidate.value.candidate.suggestedValue,
      humanConfirmed: true,
      kind: input.kind,
    });
    const payloadChecksum = await this.options.hasher.sha256(payload);
    if (!payloadChecksum.ok) {
      return payloadChecksum;
    }
    const idempotencyKey = formalDecisionIdempotencyKey(candidate.value);
    const proposedDecisionId = parseUuidV7(this.options.ids.next());
    const now = parseIsoUtcTimestamp(this.options.clock.now());
    if (!proposedDecisionId.ok) {
      return proposedDecisionId;
    }
    if (!now.ok) {
      return now;
    }
    const claimed = await this.options.extraction.claimDecision({
      idempotencyKey,
      jobId: candidate.value.jobId,
      candidateKey: candidate.value.candidate.key,
      decisionId: proposedDecisionId.value,
      kind: input.kind,
      payloadChecksumSha256: payloadChecksum.value,
      now: now.value,
    });
    if (!claimed.ok) {
      return claimed;
    }
    const review = await this.options.reviewItems.findById(candidate.value.reviewItemId);
    if (!review.ok) {
      return review;
    }
    if (review.value === null) {
      return candidateNotFound("The extraction review item has not been materialized.");
    }

    let idempotent = false;
    let resultingReview = review.value;
    let resultingRecord: FormalStoryRecord | null = null;
    const snapshot = review.value.toSnapshot();
    const finalDecision = snapshot.decisions.at(-1);
    const expectedStatus = input.kind === "accept" ? "accepted" : "modified";
    if (
      snapshot.status === expectedStatus &&
      finalDecision?.id === claimed.value.decisionId &&
      finalDecision.kind === expectedStatus
    ) {
      idempotent = true;
      const storedRecord = await this.options.records.findById(
        candidate.value.candidate.target.recordId,
      );
      if (!storedRecord.ok) {
        return storedRecord;
      }
      if (
        storedRecord.value === null ||
        !recordWasChangedBy(storedRecord.value, candidate.value.reviewItemId)
      ) {
        return repositoryIntegrityError("Accepted extraction review lost its formal version.");
      }
      resultingRecord = storedRecord.value;
    } else if (snapshot.status === "pending" || snapshot.status === "deferred") {
      const decided = await this.options.decisionService.decide({
        itemId: candidate.value.reviewItemId,
        actorId: actorId.value,
        humanConfirmed: true,
        expectedItemRevision: snapshot.revision,
        expectedRecordRevision: candidate.value.candidate.target.expectedRevision,
        decisionId: claimed.value.decisionId,
        ...(input.kind === "accept"
          ? { kind: "accept" as const }
          : {
              kind: "modify" as const,
              modifiedValue: input.modifiedValue,
            }),
      });
      if (!decided.ok) {
        return decided;
      }
      resultingReview = decided.value.item;
      resultingRecord = decided.value.formalRecord;
    } else {
      return invalidTransition("This candidate already has a different terminal decision.");
    }

    let claim = claimed.value;
    if (claim.state === "claimed") {
      const committed = await this.options.extraction.updateDecisionClaim(
        claim.idempotencyKey,
        "claimed",
        "committed",
        this.requireNow(),
      );
      if (!committed.ok) {
        return committed;
      }
      claim = committed.value;
    }
    const projection = await this.options.graph.rebuildProject(candidate.value.source.projectId);
    if (!projection.ok) {
      if (claim.state === "committed") {
        const pending = await this.options.extraction.updateDecisionClaim(
          claim.idempotencyKey,
          "committed",
          "projection_pending",
          this.requireNow(),
        );
        if (!pending.ok) {
          return pending;
        }
      }
      return ok({
        review: resultingReview.toSnapshot(),
        target: resultingRecord?.toSnapshot() ?? null,
        idempotent,
        projection: "pending",
        projectionErrorCode: projection.error.code,
      });
    }
    if (claim.state === "committed" || claim.state === "projection_pending") {
      const completed = await this.options.extraction.updateDecisionClaim(
        claim.idempotencyKey,
        claim.state,
        "completed",
        this.requireNow(),
      );
      if (!completed.ok) {
        return completed;
      }
    }
    return ok({
      review: resultingReview.toSnapshot(),
      target: resultingRecord?.toSnapshot() ?? null,
      idempotent,
      projection: "rebuilt",
      projectionErrorCode: null,
    });
  }

  public async decideReview(
    input: AuthoritativeExtractionReviewDecisionInput,
  ): Promise<Result<AuthoritativeExtractionDecisionReceipt, StoryCoreError>> {
    if (!input.humanConfirmed) {
      return humanRequired();
    }
    const candidate = await this.loadCandidate(input.jobId, input.candidateKey);
    if (!candidate.ok) {
      return candidate;
    }
    const review = await this.options.reviewItems.findById(candidate.value.reviewItemId);
    if (!review.ok) {
      return review;
    }
    if (review.value === null) {
      return candidateNotFound("The extraction review item has not been materialized.");
    }
    const snapshot = review.value.toSnapshot();
    const command =
      input.kind === "defer"
        ? input.remindAt === undefined
          ? null
          : {
              kind: "defer" as const,
              remindAt: input.remindAt,
            }
        : { kind: input.kind };
    if (command === null) {
      return validationError("Deferred extraction review requires a reminder time.");
    }
    const decided = await this.options.decisionService.decide({
      itemId: candidate.value.reviewItemId,
      actorId: input.actorId,
      humanConfirmed: true,
      expectedItemRevision: snapshot.revision,
      ...command,
    });
    if (!decided.ok) {
      return decided;
    }
    return ok({
      review: decided.value.item.toSnapshot(),
      target: null,
      idempotent: false,
      projection: "not_required",
      projectionErrorCode: null,
    });
  }

  public async undoAcceptance(
    input: Readonly<{
      jobId: string;
      candidateKey: string;
      actorId: string;
      humanConfirmed: boolean;
    }>,
  ): Promise<Result<AuthoritativeExtractionUndoReceipt, StoryCoreError>> {
    if (!input.humanConfirmed) {
      return humanRequired();
    }
    const candidate = await this.loadCandidate(input.jobId, input.candidateKey);
    if (!candidate.ok) {
      return candidate;
    }
    const loaded = await this.options.records.findById(candidate.value.candidate.target.recordId);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      return candidateNotFound("The accepted extraction target was not found.");
    }
    const snapshot = loaded.value.toSnapshot();
    const current = snapshot.versions.at(-1);
    const previous = snapshot.versions.at(-2);
    let changed = loaded.value;
    let idempotent = false;
    if (
      current?.reason === "undo" &&
      current.restoredFromVersion === candidate.value.candidate.target.expectedRevision &&
      previous?.sourceReviewItemId === candidate.value.reviewItemId
    ) {
      idempotent = true;
    } else {
      if (
        current?.sourceReviewItemId !== candidate.value.reviewItemId ||
        current.previousVersion !== candidate.value.candidate.target.expectedRevision
      ) {
        return invalidTransition(
          "Only the current version created by this accepted candidate can be undone here.",
        );
      }
      const undone = await this.options.formalService.undo({
        recordId: loaded.value.id,
        targetVersion: candidate.value.candidate.target.expectedRevision,
        actorId: input.actorId,
        humanConfirmed: true,
        expectedRevision: loaded.value.revision,
      });
      if (!undone.ok) {
        return undone;
      }
      changed = undone.value;
    }
    const projection = await this.options.graph.rebuildProject(candidate.value.source.projectId);
    return ok({
      target: changed.toSnapshot(),
      idempotent,
      projection: projection.ok ? "rebuilt" : "pending",
      projectionErrorCode: projection.ok ? null : projection.error.code,
    });
  }

  private async loadCandidate(
    jobIdValue: string,
    candidateKeyValue: string,
  ): Promise<Result<AuthoritativeExtractionCandidateRecord, StoryCoreError>> {
    const jobId = parseUuidV7(jobIdValue);
    const candidateKey = parseSafeIdentifier(candidateKeyValue);
    if (!jobId.ok) {
      return jobId;
    }
    if (!candidateKey.ok) {
      return candidateKey;
    }
    const candidate = await this.options.extraction.findCandidate(jobId.value, candidateKey.value);
    if (!candidate.ok) {
      return candidate;
    }
    if (candidate.value === null) {
      return candidateNotFound("Authoritative extraction candidate was not found.");
    }
    return ok(candidate.value);
  }

  private requireNow() {
    const now = parseIsoUtcTimestamp(this.options.clock.now());
    if (!now.ok) {
      throw now.error;
    }
    return now.value;
  }
}

interface SqliteRuntimeDependencies {
  readonly repository: SqliteAuthoritativeExtractionRepository;
  readonly reviewItems: SqliteReviewItemRepository<"extraction">;
  readonly records: SqliteFormalStoryRecordRepository;
  readonly coordinator: AuthoritativeExtractionCoordinator;
  readonly decisions: AuthoritativeExtractionReviewCoordinator;
  readonly graph: StoryGraphRuntimePort;
  readonly provenance: AuthoritativeExtractionProvenance;
  readonly suiteId: string;
  readonly goldenSuite?: AuthoritativeExtractionGoldenSuite;
}

class SqliteAuthoritativeExtractionDesktopRuntime implements AuthoritativeExtractionDesktopPort {
  public readonly availability = Object.freeze({
    available: true as const,
    persistence: "native_sqlite" as const,
    providerConfigured: true as const,
  });
  public readonly goldenSuite?: AuthoritativeExtractionGoldenSuite;

  public constructor(private readonly dependencies: SqliteRuntimeDependencies) {
    if (dependencies.goldenSuite !== undefined) {
      this.goldenSuite = dependencies.goldenSuite;
    }
  }

  public async inspect(
    projectIdValue: string,
  ): Promise<Result<AuthoritativeExtractionDashboard, StoryCoreError>> {
    const projectId = parseUuidV7(projectIdValue);
    if (!projectId.ok) {
      return projectId;
    }
    const [jobs, candidates, evaluation, graph] = await Promise.all([
      this.dependencies.repository.listJobsByProject(projectId.value),
      this.dependencies.repository.listCandidatesByProject(projectId.value),
      this.dependencies.repository.findLatestPassingEvaluation(
        this.requireSuiteId(),
        this.dependencies.provenance,
      ),
      this.dependencies.graph.inspectProject(projectId.value),
    ]);
    if (!jobs.ok) {
      return jobs;
    }
    if (!candidates.ok) {
      return candidates;
    }
    if (!evaluation.ok) {
      return evaluation;
    }
    const dashboardCandidates: AuthoritativeExtractionDashboardCandidate[] = [];
    for (const candidate of candidates.value) {
      const [review, target] = await Promise.all([
        this.dependencies.reviewItems.findById(candidate.reviewItemId),
        this.dependencies.records.findById(candidate.candidate.target.recordId),
      ]);
      if (!review.ok) {
        return review;
      }
      if (!target.ok) {
        return target;
      }
      dashboardCandidates.push(
        Object.freeze({
          extraction: candidate,
          review: review.value?.toSnapshot() ?? null,
          target: target.value?.toSnapshot() ?? null,
        }),
      );
    }
    return ok({
      projectId: projectId.value,
      jobs: jobs.value,
      candidates: Object.freeze(dashboardCandidates),
      evaluationPassed: evaluation.value !== null,
      graphFreshness: graph.ok ? graph.value.freshness : "unavailable",
    });
  }

  public runCycle(projectId: string, options: Readonly<{ online: boolean; maximumJobs?: number }>) {
    return this.dependencies.coordinator.runCycle(projectId, options);
  }

  public runEvaluation(suite: AuthoritativeExtractionGoldenSuite) {
    return this.dependencies.coordinator.runGoldenSuite(suite);
  }

  public cancel(jobId: string) {
    return this.dependencies.coordinator.cancel(jobId);
  }

  public decideFormal(input: AuthoritativeExtractionFormalDecisionInput) {
    return this.dependencies.decisions.decideFormal(input);
  }

  public decideReview(input: AuthoritativeExtractionReviewDecisionInput) {
    return this.dependencies.decisions.decideReview(input);
  }

  public undoAcceptance(
    input: Readonly<{
      jobId: string;
      candidateKey: string;
      actorId: string;
      humanConfirmed: boolean;
    }>,
  ) {
    return this.dependencies.decisions.undoAcceptance(input);
  }

  public async rebuildProjection(
    projectId: string,
  ): Promise<Result<Readonly<{ projection: "rebuilt" }>, StoryCoreError>> {
    const rebuilt = await this.dependencies.graph.rebuildProject(projectId);
    return rebuilt.ok
      ? ok(Object.freeze({ projection: "rebuilt" as const }))
      : err(graphError(rebuilt.error.code));
  }

  private requireSuiteId() {
    const parsed = parseSafeIdentifier(this.dependencies.suiteId);
    if (!parsed.ok) {
      throw parsed.error;
    }
    return parsed.value;
  }
}

class UnavailableAuthoritativeExtractionRuntime implements AuthoritativeExtractionDesktopPort {
  public constructor(public readonly availability: AuthoritativeExtractionAvailability) {}

  public inspect(): Promise<Result<AuthoritativeExtractionDashboard, StoryCoreError>> {
    return Promise.resolve(err(unavailableError(this.availability)));
  }

  public runCycle(): Promise<Result<AuthoritativeExtractionCycleReceipt, StoryCoreError>> {
    return Promise.resolve(err(unavailableError(this.availability)));
  }

  public runEvaluation(): Promise<
    Result<AuthoritativeExtractionEvaluationReceipt, StoryCoreError>
  > {
    return Promise.resolve(err(unavailableError(this.availability)));
  }

  public cancel(): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>> {
    return Promise.resolve(err(unavailableError(this.availability)));
  }

  public decideFormal(): Promise<Result<AuthoritativeExtractionDecisionReceipt, StoryCoreError>> {
    return Promise.resolve(err(unavailableError(this.availability)));
  }

  public decideReview(): Promise<Result<AuthoritativeExtractionDecisionReceipt, StoryCoreError>> {
    return Promise.resolve(err(unavailableError(this.availability)));
  }

  public undoAcceptance(): Promise<Result<AuthoritativeExtractionUndoReceipt, StoryCoreError>> {
    return Promise.resolve(err(unavailableError(this.availability)));
  }

  public rebuildProjection(): Promise<Result<Readonly<{ projection: "rebuilt" }>, StoryCoreError>> {
    return Promise.resolve(err(unavailableError(this.availability)));
  }
}

export class SqliteAuthoritativeExtractionSourceReader implements AuthoritativeExtractionSourceReader {
  public constructor(private readonly executor: SqlExecutor) {}

  public async listCurrentByProject(projectId: string) {
    try {
      const rows = await this.executor.select<ChapterDocumentRow>(
        `${CHAPTER_DOCUMENT_SELECT}
         WHERE chapter.project_id = ?
           AND chapter.status = 'active'
           AND project.status <> 'trashed'
         ORDER BY chapter.updated_at ASC, chapter.id ASC`,
        [projectId],
      );
      return ok(Object.freeze(rows.map(hydrateChapterDocument)));
    } catch {
      return err(sourceReadError());
    }
  }

  public async loadCurrentByChapter(chapterId: string) {
    try {
      const rows = await this.executor.select<ChapterDocumentRow>(
        `${CHAPTER_DOCUMENT_SELECT}
         WHERE chapter.id = ?
           AND chapter.status = 'active'
           AND project.status <> 'trashed'`,
        [chapterId],
      );
      return ok(rows[0] === undefined ? null : hydrateChapterDocument(rows[0]));
    } catch {
      return err(sourceReadError());
    }
  }
}

interface ChapterDocumentRow {
  readonly project_id: string;
  readonly chapter_id: string;
  readonly version_id: string;
  readonly content_checksum: string;
  readonly content: string;
}

const CHAPTER_DOCUMENT_SELECT = `SELECT
  chapter.project_id,
  chapter.id AS chapter_id,
  version.id AS version_id,
  version.content_checksum,
  version.content
FROM chapters AS chapter
INNER JOIN projects AS project ON project.id = chapter.project_id
INNER JOIN chapter_versions AS version
  ON version.id = chapter.current_version_id
 AND version.chapter_id = chapter.id
 AND version.project_id = chapter.project_id`;

function hydrateChapterDocument(row: ChapterDocumentRow) {
  return Object.freeze({
    projectId: row.project_id,
    chapterId: row.chapter_id,
    versionId: row.version_id,
    checksumSha256: row.content_checksum,
    content: row.content,
  });
}

class ApplicationHasherAdapter implements AuthoritativeExtractionContentHasher {
  public constructor(private readonly hasher: ContentHasher) {}

  public async sha256(content: string): Promise<Result<string, StoryCoreError>> {
    const hashed = await this.hasher.sha256(content);
    return hashed.ok
      ? ok(hashed.value)
      : err(
          new StoryCoreError({
            code: "STORY_REPOSITORY_ERROR",
            message: "Unable to verify authoritative extraction content.",
            retryable: hashed.error.retryable,
            actions: hashed.error.retryable ? ["RETRY"] : ["CONTACT_SUPPORT"],
            details: { sourceErrorCode: hashed.error.code },
          }),
        );
  }
}

function recordWasChangedBy(record: FormalStoryRecord, reviewItemId: string): boolean {
  const current = record.toSnapshot().versions.at(-1);
  return (
    current?.sourceReviewItemId === reviewItemId &&
    (current.reason === "suggestion_accepted" || current.reason === "suggestion_modified")
  );
}

function formalDecisionIdempotencyKey(candidate: AuthoritativeExtractionCandidateRecord): string {
  return `formal:${candidate.jobId}:${candidate.candidate.key}`;
}

function storyJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return "";
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("Decision payload is not JSON-compatible.");
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function unavailableError(availability: AuthoritativeExtractionAvailability): StoryCoreError {
  return new StoryCoreError({
    code:
      availability.available || availability.reason === "feature_disabled"
        ? "EXTRACTION_DISABLED"
        : "EXTRACTION_PROVIDER_UNAVAILABLE",
    message:
      !availability.available && availability.reason === "native_sqlite_required"
        ? "Browser development mode cannot impersonate native SQLite extraction persistence."
        : !availability.available && availability.reason === "provider_not_configured"
          ? "No real extraction provider is configured."
          : "Authoritative extraction is disabled by default.",
  });
}

function graphError(code: string): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message: "The accepted extraction is safe, but GraphRAG projection rebuilding failed.",
    retryable: true,
    actions: ["RETRY", "CONTACT_SUPPORT"],
    details: { graphErrorCode: code },
  });
}

function sourceReadError(): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message: "Unable to read the current chapter for authoritative extraction.",
    retryable: true,
    actions: ["RETRY", "CONTACT_SUPPORT"],
  });
}

function repositoryIntegrityError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message,
      actions: ["CONTACT_SUPPORT"],
    }),
  );
}

function humanRequired(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "HUMAN_DECISION_REQUIRED",
      message: "Formal extraction decisions require explicit human confirmation.",
      actions: ["REVIEW_EVIDENCE"],
    }),
  );
}

function validationError(message: string): Result<never, StoryCoreError> {
  return err(new StoryCoreError({ code: "STORY_VALIDATION_FAILED", message }));
}

function candidateNotFound(message: string): Result<never, StoryCoreError> {
  return err(new StoryCoreError({ code: "EXTRACTION_CANDIDATE_NOT_FOUND", message }));
}

function invalidTransition(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "EXTRACTION_INVALID_TRANSITION",
      message,
      actions: ["RECOMPARE", "REVIEW_EVIDENCE"],
    }),
  );
}
