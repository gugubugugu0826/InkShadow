import {
  buildAuthoritativeExtractionOutputInstruction,
  evaluateAuthoritativeExtractionCandidates,
  parseAuthoritativeExtractionOutput,
  validateAuthoritativeExtractionProvenance,
  validateAuthoritativeExtractionSource,
  type AuthoritativeExtractionCandidate,
  type AuthoritativeExtractionGoldenThresholds,
  type AuthoritativeExtractionMetrics,
  type AuthoritativeExtractionProvenance,
  type AuthoritativeExtractionSource,
  type AuthoritativeExtractionTargetBaseline,
  type AuthoritativeExtractionValidationContext,
} from "./authoritative-extraction.js";
import {
  createAuthoritativeExtractionJob,
  validateAuthoritativeExtractionEvaluationRecord,
  type AuthoritativeExtractionCandidateRecord,
  type AuthoritativeExtractionEvaluationRecord,
  type AuthoritativeExtractionExecutionMode,
  type AuthoritativeExtractionJob,
  type AuthoritativeExtractionRepository,
} from "./authoritative-extraction-task.js";
import { StoryCoreError } from "./errors.js";
import type { FormalStoryRecordListReader, ReviewItemRepository } from "./ports.js";
import { err, ok, type Result } from "./result.js";
import { storyValuesEqual } from "./safety.js";
import { StructuredReviewItem } from "./review-item.js";
import {
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type Clock,
  type IsoUtcTimestamp,
  type SafeIdentifier,
  type UuidV7,
  type UuidV7Generator,
} from "./value-objects.js";

export interface AuthoritativeExtractionChapterDocument {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly checksumSha256: string;
  readonly content: string;
}

export interface AuthoritativeExtractionSourceReader {
  listCurrentByProject(
    projectId: UuidV7,
  ): Promise<Result<readonly AuthoritativeExtractionChapterDocument[], StoryCoreError>>;

  loadCurrentByChapter(
    chapterId: UuidV7,
  ): Promise<Result<AuthoritativeExtractionChapterDocument | null, StoryCoreError>>;
}

export interface AuthoritativeExtractionContentHasher {
  sha256(content: string): Promise<Result<string, StoryCoreError>>;
}

export interface AuthoritativeExtractionProviderFailure {
  readonly code: string;
  readonly retryable: boolean;
  readonly offline: boolean;
}

export interface AuthoritativeExtractionProviderRequest {
  readonly publicationBoundary: "candidate_only";
  readonly formalWriteAllowed: false;
  readonly instruction: string;
  readonly source: AuthoritativeExtractionSource;
  readonly chapterContent: string;
  readonly targets: readonly AuthoritativeExtractionTargetBaseline[];
  readonly provenance: AuthoritativeExtractionProvenance;
  /** In-memory dispatch guard; never serialized into the provider prompt. */
  readonly assertProjectContextCurrent?: () => Promise<void>;
}

export interface AuthoritativeExtractionProvider {
  generate(
    request: AuthoritativeExtractionProviderRequest,
    signal: AbortSignal,
  ): Promise<Result<string, AuthoritativeExtractionProviderFailure>>;
}

export interface AuthoritativeExtractionGoldenFixture {
  readonly id: SafeIdentifier;
  readonly source: AuthoritativeExtractionChapterDocument;
  readonly targets: readonly AuthoritativeExtractionTargetBaseline[];
  readonly expected: readonly AuthoritativeExtractionCandidate[];
}

export interface AuthoritativeExtractionGoldenSuite {
  readonly id: SafeIdentifier;
  readonly thresholds: AuthoritativeExtractionGoldenThresholds;
  readonly fixtures: readonly AuthoritativeExtractionGoldenFixture[];
}

export interface AuthoritativeExtractionCoordinatorOptions {
  readonly enabled: boolean;
  readonly executionMode: AuthoritativeExtractionExecutionMode;
  readonly evaluationSuiteId: string;
  readonly provenance: AuthoritativeExtractionProvenance;
  readonly repository: AuthoritativeExtractionRepository;
  readonly sources: AuthoritativeExtractionSourceReader;
  readonly formalRecords: FormalStoryRecordListReader;
  readonly reviewItems: ReviewItemRepository<"extraction">;
  readonly provider: AuthoritativeExtractionProvider;
  readonly hasher: AuthoritativeExtractionContentHasher;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
  readonly workerId: string;
  readonly leaseDurationMs?: number;
  readonly maximumAttempts?: number;
  /** Captured before any project正文 or formal record is assembled. */
  readonly captureProjectContextAuthority?: (projectId: UuidV7) => Promise<() => Promise<void>>;
}

export interface AuthoritativeExtractionCycleReceipt {
  readonly discoveredCount: number;
  readonly processedCount: number;
  readonly materializedCount: number;
  readonly blockedCount: number;
  readonly cancelledCount: number;
}

export interface AuthoritativeExtractionEvaluationReceipt {
  readonly evaluation: AuthoritativeExtractionEvaluationRecord;
  readonly releasedJobCount: number;
}

const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 3;
const MAX_CYCLE_JOBS = 100;

/**
 * Durable, recoverable chapter extraction coordinator.
 *
 * Discovery is idempotent over the exact chapter/version/checksum/scope and
 * prompt/model/eval authority tuple. Provider output is persisted only after
 * strict validation, and materialization can resume independently after a
 * crash without invoking the provider twice.
 */
export class AuthoritativeExtractionCoordinator {
  private readonly active = new Map<UuidV7, AbortController>();
  private readonly workerId: SafeIdentifier;
  private readonly suiteId: SafeIdentifier;
  private readonly provenance: AuthoritativeExtractionProvenance;
  private readonly leaseDurationMs: number;
  private readonly maximumAttempts: number;

  public constructor(private readonly options: AuthoritativeExtractionCoordinatorOptions) {
    const workerId = parseSafeIdentifier(options.workerId);
    const suiteId = parseSafeIdentifier(options.evaluationSuiteId);
    const provenance = validateAuthoritativeExtractionProvenance(options.provenance);
    if (!workerId.ok || !suiteId.ok || !provenance.ok) {
      throw new TypeError("Authoritative extraction coordinator configuration is invalid.");
    }
    this.workerId = workerId.value;
    this.suiteId = suiteId.value;
    this.provenance = provenance.value;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.maximumAttempts = options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
    if (
      !Number.isSafeInteger(this.leaseDurationMs) ||
      this.leaseDurationMs < 1_000 ||
      this.leaseDurationMs > 10 * 60_000 ||
      !Number.isSafeInteger(this.maximumAttempts) ||
      this.maximumAttempts < 1 ||
      this.maximumAttempts > 10
    ) {
      throw new TypeError("Authoritative extraction lease or retry limit is invalid.");
    }
  }

  public async discoverProject(projectIdValue: string): Promise<Result<number, StoryCoreError>> {
    const enabled = this.requireEnabled();
    if (!enabled.ok) {
      return enabled;
    }
    const projectId = parseUuidV7(projectIdValue);
    if (!projectId.ok) {
      return projectId;
    }
    const sources = await this.options.sources.listCurrentByProject(projectId.value);
    if (!sources.ok) {
      return sources;
    }
    let discoveredCount = 0;
    for (const document of sources.value) {
      const context = await this.validateCurrentDocument(document, projectId.value);
      if (!context.ok) {
        return context;
      }
      if (context.value === null) {
        continue;
      }
      const now = this.requireNow();
      if (!now.ok) {
        return now;
      }
      const job = createAuthoritativeExtractionJob({
        id: this.options.ids.next(),
        source: context.value,
        provenance: this.provenance,
        evaluationSuiteId: this.suiteId,
        executionMode: this.options.executionMode,
        now: now.value,
      });
      if (!job.ok) {
        return job;
      }
      const enqueued = await this.options.repository.enqueue(job.value);
      if (!enqueued.ok) {
        return enqueued;
      }
      if (enqueued.value.created) {
        discoveredCount += 1;
      }
    }
    return ok(discoveredCount);
  }

  public async runCycle(
    projectIdValue: string,
    options: Readonly<{ online: boolean; maximumJobs?: number }>,
  ): Promise<Result<AuthoritativeExtractionCycleReceipt, StoryCoreError>> {
    const enabled = this.requireEnabled();
    if (!enabled.ok) {
      return enabled;
    }
    const projectId = parseUuidV7(projectIdValue);
    if (!projectId.ok) {
      return projectId;
    }
    const maximumJobs = options.maximumJobs ?? MAX_CYCLE_JOBS;
    if (!Number.isSafeInteger(maximumJobs) || maximumJobs < 1 || maximumJobs > MAX_CYCLE_JOBS) {
      return extractionValidationError("Extraction cycle limit must be between 1 and 100.");
    }
    const discovered = await this.discoverProject(projectId.value);
    if (!discovered.ok) {
      return discovered;
    }
    const now = this.requireNow();
    if (!now.ok) {
      return now;
    }
    const recovered = await this.options.repository.recoverExpiredLeases(now.value);
    if (!recovered.ok) {
      return recovered;
    }
    if (options.online) {
      const resumed = await this.options.repository.resumeNetworkJobs(projectId.value, now.value);
      if (!resumed.ok) {
        return resumed;
      }
    }
    const passingEvaluation = await this.options.repository.findLatestPassingEvaluation(
      this.suiteId,
      this.provenance,
    );
    if (!passingEvaluation.ok) {
      return passingEvaluation;
    }
    if (passingEvaluation.value !== null) {
      const released = await this.options.repository.resumeEvaluationBlockedJobs(
        projectId.value,
        this.provenance,
        now.value,
      );
      if (!released.ok) {
        return released;
      }
    }

    let processedCount = 0;
    let materializedCount = 0;
    let blockedCount = 0;
    let cancelledCount = 0;
    for (let index = 0; index < maximumJobs; index += 1) {
      const materializing = await this.claimMaterialization(projectId.value);
      if (!materializing.ok) {
        return materializing;
      }
      if (materializing.value !== null) {
        const materialized = await this.materialize(materializing.value);
        if (!materialized.ok) {
          return materialized;
        }
        materializedCount += 1;
        continue;
      }

      const claimed = await this.claimProviderJob(projectId.value);
      if (!claimed.ok) {
        return claimed;
      }
      if (claimed.value === null) {
        break;
      }
      processedCount += 1;
      const processed = await this.processClaimedJob(
        claimed.value,
        options.online,
        passingEvaluation.value !== null,
      );
      if (!processed.ok) {
        return processed;
      }
      if (
        processed.value.state === "waiting_for_network" ||
        processed.value.state === "blocked_evaluation" ||
        processed.value.state === "blocked_stale" ||
        processed.value.state === "failed_retryable" ||
        processed.value.state === "failed_final"
      ) {
        blockedCount += 1;
      } else if (processed.value.state === "cancelled") {
        cancelledCount += 1;
      }
    }
    return ok(
      Object.freeze({
        discoveredCount: discovered.value,
        processedCount,
        materializedCount,
        blockedCount,
        cancelledCount,
      }),
    );
  }

  public async cancel(
    jobIdValue: string,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>> {
    const enabled = this.requireEnabled();
    if (!enabled.ok) {
      return enabled;
    }
    const jobId = parseUuidV7(jobIdValue);
    const now = this.requireNow();
    if (!jobId.ok) {
      return jobId;
    }
    if (!now.ok) {
      return now;
    }
    const result = await this.options.repository.requestCancellation(jobId.value, now.value);
    if (result.ok) {
      this.active.get(jobId.value)?.abort();
    }
    return result;
  }

  public async runGoldenSuite(
    suite: AuthoritativeExtractionGoldenSuite,
  ): Promise<Result<AuthoritativeExtractionEvaluationReceipt, StoryCoreError>> {
    const enabled = this.requireEnabled();
    if (!enabled.ok) {
      return enabled;
    }
    if (suite.id !== this.suiteId || suite.fixtures.length < 1 || suite.fixtures.length > 100) {
      return extractionValidationError("Golden extraction suite identity or size is invalid.");
    }
    let truePositiveCount = 0;
    let falsePositiveCount = 0;
    let falseNegativeCount = 0;
    let protocolFailureCount = 0;
    for (const fixture of suite.fixtures) {
      const source = await this.validateFixture(fixture);
      if (!source.ok) {
        return source;
      }
      const controller = new AbortController();
      const generated = await this.options.provider.generate(
        providerRequest(source.value.context),
        controller.signal,
      );
      if (!generated.ok) {
        protocolFailureCount += 1;
        falseNegativeCount += fixture.expected.length;
        continue;
      }
      const parsed = parseAuthoritativeExtractionOutput(generated.value, source.value.context);
      if (!parsed.ok) {
        protocolFailureCount += 1;
        falseNegativeCount += fixture.expected.length;
        continue;
      }
      const metrics = evaluateAuthoritativeExtractionCandidates(
        parsed.value.candidates,
        fixture.expected,
        suite.thresholds,
      );
      if (!metrics.ok) {
        return metrics;
      }
      truePositiveCount += metrics.value.truePositiveCount;
      falsePositiveCount += metrics.value.falsePositiveCount;
      falseNegativeCount += metrics.value.falseNegativeCount;
    }
    const predictedCount = truePositiveCount + falsePositiveCount;
    const expectedCount = truePositiveCount + falseNegativeCount;
    const precision = predictedCount === 0 ? 1 : truePositiveCount / predictedCount;
    const recall = expectedCount === 0 ? 1 : truePositiveCount / expectedCount;
    const metrics: AuthoritativeExtractionMetrics = Object.freeze({
      truePositiveCount,
      falsePositiveCount,
      falseNegativeCount,
      predictedCount,
      expectedCount,
      precision,
      recall,
      passed:
        protocolFailureCount === 0 &&
        precision >= suite.thresholds.minimumPrecision &&
        recall >= suite.thresholds.minimumRecall,
    });
    const now = this.requireNow();
    if (!now.ok) {
      return now;
    }
    const evaluation = validateAuthoritativeExtractionEvaluationRecord({
      id: this.options.ids.next() as UuidV7,
      suiteId: this.suiteId,
      provenance: this.provenance,
      thresholds: Object.freeze({ ...suite.thresholds }),
      metrics,
      fixtureCount: suite.fixtures.length,
      protocolFailureCount,
      createdAt: now.value,
    });
    if (!evaluation.ok) {
      return evaluation;
    }
    const recorded = await this.options.repository.recordEvaluation(evaluation.value);
    if (!recorded.ok) {
      return recorded;
    }
    let releasedJobCount = 0;
    if (evaluation.value.metrics.passed) {
      const projectIds = new Set(suite.fixtures.map(({ source }) => source.projectId));
      for (const projectIdValue of projectIds) {
        const projectId = parseUuidV7(projectIdValue);
        if (!projectId.ok) {
          return projectId;
        }
        const released = await this.options.repository.resumeEvaluationBlockedJobs(
          projectId.value,
          this.provenance,
          now.value,
        );
        if (!released.ok) {
          return released;
        }
        releasedJobCount += released.value;
      }
    }
    return ok(Object.freeze({ evaluation: evaluation.value, releasedJobCount }));
  }

  private async processClaimedJob(
    job: AuthoritativeExtractionJob,
    online: boolean,
    evaluationPassed: boolean,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>> {
    if (job.executionMode === "remote" && !online) {
      return this.failClaim(job, "waiting_for_network", "network_offline", false);
    }
    if (!evaluationPassed) {
      return this.failClaim(job, "blocked_evaluation", "evaluation_gate_not_passed", false);
    }
    if (
      job.executionMode === "remote" &&
      this.options.captureProjectContextAuthority === undefined
    ) {
      return this.failClaim(job, "failed_retryable", "project_context_privacy_unavailable", true);
    }
    let assertProjectContextCurrent: (() => Promise<void>) | undefined;
    if (this.options.captureProjectContextAuthority !== undefined) {
      try {
        assertProjectContextCurrent = await this.options.captureProjectContextAuthority(
          job.source.projectId,
        );
      } catch {
        return this.failClaim(job, "failed_retryable", "project_context_privacy_unavailable", true);
      }
    }
    const document = await this.options.sources.loadCurrentByChapter(job.source.chapterId);
    if (!document.ok) {
      return document;
    }
    if (document.value === null) {
      return this.failClaim(job, "blocked_stale", "source_missing", false);
    }
    const source = await this.validateCurrentDocument(document.value, job.source.projectId);
    if (!source.ok) {
      return source;
    }
    if (source.value === null || !sameSource(source.value, job.source)) {
      return this.failClaim(job, "blocked_stale", "source_changed", false);
    }
    const formal = await this.options.formalRecords.listByProjectId(job.source.projectId);
    if (!formal.ok) {
      return formal;
    }
    const targets: AuthoritativeExtractionTargetBaseline[] = formal.value.map((record) =>
      Object.freeze({
        recordId: record.id,
        kind: record.kind,
        expectedRevision: record.revision,
        value: record.currentValue,
      }),
    );
    const context: AuthoritativeExtractionValidationContext = Object.freeze({
      source: job.source,
      chapterContent: document.value.content,
      provenance: job.provenance,
      targets: Object.freeze(targets),
    });
    const controller = new AbortController();
    this.active.set(job.id, controller);
    let generated: Result<string, AuthoritativeExtractionProviderFailure>;
    try {
      await assertProjectContextCurrent?.();
      generated = await this.options.provider.generate(
        providerRequest(context, assertProjectContextCurrent),
        controller.signal,
      );
    } catch {
      generated = err({
        code: "provider_exception",
        retryable: true,
        offline: false,
      });
    } finally {
      this.active.delete(job.id);
    }
    const cancelled = await this.options.repository.isCancellationRequested(job.id);
    if (!cancelled.ok) {
      return cancelled;
    }
    const current = await this.options.repository.findJobById(job.id);
    if (!current.ok) {
      return current;
    }
    if (current.value === null) {
      return extractionNotFound("Extraction job disappeared while a provider was running.");
    }
    const leasedJob = current.value;
    if (cancelled.value || controller.signal.aborted) {
      return this.failClaim(leasedJob, "cancelled", null, false);
    }
    if (!generated.ok) {
      const state =
        generated.error.offline && job.executionMode === "remote"
          ? "waiting_for_network"
          : generated.error.retryable && leasedJob.attemptCount < this.maximumAttempts
            ? "failed_retryable"
            : "failed_final";
      return this.failClaim(
        leasedJob,
        state,
        sanitizeProviderCode(generated.error.code),
        state === "failed_retryable",
      );
    }
    const parsed = parseAuthoritativeExtractionOutput(generated.value, context);
    if (!parsed.ok) {
      const retryable = leasedJob.attemptCount < this.maximumAttempts;
      return this.failClaim(
        leasedJob,
        retryable ? "failed_retryable" : "failed_final",
        "output_protocol_invalid",
        retryable,
      );
    }
    const now = this.requireNow();
    if (!now.ok) {
      return now;
    }
    const candidates: AuthoritativeExtractionCandidateRecord[] = parsed.value.candidates.map(
      (candidate) =>
        Object.freeze({
          jobId: leasedJob.id,
          reviewItemId: this.requireGeneratedId(),
          source: leasedJob.source,
          provenance: leasedJob.provenance,
          candidate,
          createdAt: now.value,
        }),
    );
    return this.options.repository.completeAttempt({
      job: leasedJob,
      expectedRevision: leasedJob.revision,
      workerId: this.workerId,
      candidates: Object.freeze(candidates),
      now: now.value,
    });
  }

  private async materialize(
    job: AuthoritativeExtractionJob,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>> {
    const records = await this.options.repository.listCandidatesByJob(job.id);
    if (!records.ok) {
      return records;
    }
    for (const record of records.value) {
      const existing = await this.options.reviewItems.findById(record.reviewItemId);
      if (!existing.ok) {
        return existing;
      }
      if (existing.value !== null) {
        if (!reviewMatchesCandidate(existing.value, record)) {
          return extractionIntegrityError(
            "Existing review item does not match its extraction candidate.",
          );
        }
        continue;
      }
      const created = StructuredReviewItem.create("extraction", {
        id: record.reviewItemId,
        projectId: record.source.projectId,
        category: record.candidate.category,
        severity: record.candidate.severity,
        targetRecordId: record.candidate.target.recordId,
        targetRecordKind: record.candidate.target.kind,
        sourceChapterId: record.source.chapterId,
        sourceVersionId: record.source.versionId,
        evidence: {
          excerpt: record.candidate.evidence.excerpt,
          ...record.candidate.evidence.range,
        },
        confidence: record.candidate.confidence,
        originalValue: record.candidate.originalValue,
        suggestedValue: record.candidate.suggestedValue,
        now: record.createdAt,
      });
      if (!created.ok) {
        return created;
      }
      const saved = await this.options.reviewItems.create(created.value);
      if (!saved.ok) {
        // A crash can occur after the review insert but before this worker sees
        // the receipt. Re-read the stable review ID before declaring failure.
        const raced = await this.options.reviewItems.findById(record.reviewItemId);
        if (!raced.ok || raced.value === null || !reviewMatchesCandidate(raced.value, record)) {
          return saved;
        }
      }
    }
    const now = this.requireNow();
    if (!now.ok) {
      return now;
    }
    return this.options.repository.finishMaterialization(
      job.id,
      job.revision,
      this.workerId,
      now.value,
    );
  }

  private async validateCurrentDocument(
    document: AuthoritativeExtractionChapterDocument,
    expectedProjectId: UuidV7,
  ): Promise<Result<AuthoritativeExtractionSource | null, StoryCoreError>> {
    const projectId = parseUuidV7(document.projectId);
    const chapterId = parseUuidV7(document.chapterId);
    const versionId = parseUuidV7(document.versionId);
    if (
      !projectId.ok ||
      !chapterId.ok ||
      !versionId.ok ||
      projectId.value !== expectedProjectId ||
      typeof document.content !== "string"
    ) {
      return extractionSourceChanged("Chapter extraction source identity is invalid.");
    }
    if (document.content.length === 0) {
      return ok(null);
    }
    const checksum = await this.options.hasher.sha256(document.content);
    if (!checksum.ok) {
      return checksum;
    }
    if (checksum.value !== document.checksumSha256) {
      return extractionSourceChanged("Chapter extraction source checksum is stale or corrupt.");
    }
    return validateAuthoritativeExtractionSource({
      projectId: projectId.value,
      chapterId: chapterId.value,
      versionId: versionId.value,
      checksumSha256: checksum.value,
      scope: Object.freeze({
        start: 0,
        end: document.content.length,
        sourceLength: document.content.length,
      }),
    });
  }

  private async validateFixture(
    fixture: AuthoritativeExtractionGoldenFixture,
  ): Promise<
    Result<Readonly<{ context: AuthoritativeExtractionValidationContext }>, StoryCoreError>
  > {
    const fixtureId = parseSafeIdentifier(fixture.id);
    const projectId = parseUuidV7(fixture.source.projectId);
    if (!fixtureId.ok || !projectId.ok) {
      return extractionValidationError("Golden fixture identity is invalid.");
    }
    const source = await this.validateCurrentDocument(fixture.source, projectId.value);
    if (!source.ok) {
      return source;
    }
    if (source.value === null) {
      return extractionValidationError("Golden fixture source cannot be empty.");
    }
    return ok(
      Object.freeze({
        context: Object.freeze({
          source: source.value,
          chapterContent: fixture.source.content,
          provenance: this.provenance,
          targets: fixture.targets,
        }),
      }),
    );
  }

  private async claimProviderJob(
    projectId: UuidV7,
  ): Promise<Result<AuthoritativeExtractionJob | null, StoryCoreError>> {
    const lease = this.leaseWindow();
    if (!lease.ok) {
      return lease;
    }
    return this.options.repository.claimNext({
      projectId,
      workerId: this.workerId,
      now: lease.value.now,
      leaseExpiresAt: lease.value.expiresAt,
    });
  }

  private async claimMaterialization(
    projectId: UuidV7,
  ): Promise<Result<AuthoritativeExtractionJob | null, StoryCoreError>> {
    const lease = this.leaseWindow();
    if (!lease.ok) {
      return lease;
    }
    return this.options.repository.claimMaterialization({
      projectId,
      workerId: this.workerId,
      now: lease.value.now,
      leaseExpiresAt: lease.value.expiresAt,
    });
  }

  private leaseWindow(): Result<
    Readonly<{ now: IsoUtcTimestamp; expiresAt: IsoUtcTimestamp }>,
    StoryCoreError
  > {
    const now = this.requireNow();
    if (!now.ok) {
      return now;
    }
    const expiresAt = parseIsoUtcTimestamp(
      new Date(Date.parse(now.value) + this.leaseDurationMs).toISOString(),
    );
    return expiresAt.ok ? ok({ now: now.value, expiresAt: expiresAt.value }) : expiresAt;
  }

  private failClaim(
    job: AuthoritativeExtractionJob,
    state:
      | "waiting_for_network"
      | "blocked_evaluation"
      | "failed_retryable"
      | "failed_final"
      | "blocked_stale"
      | "cancelled",
    code: string | null,
    retryable: boolean,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>> {
    const now = this.requireNow();
    if (!now.ok) {
      return Promise.resolve(now);
    }
    const parsedCode = code === null ? null : parseSafeIdentifier(code);
    if (parsedCode !== null && !parsedCode.ok) {
      return Promise.resolve(extractionValidationError("Extraction failure code is invalid."));
    }
    return this.options.repository.failJob({
      jobId: job.id,
      expectedRevision: job.revision,
      workerId: this.workerId,
      state,
      failure:
        parsedCode === null
          ? null
          : Object.freeze({
              code: parsedCode.value,
              retryable,
            }),
      now: now.value,
    });
  }

  private requireGeneratedId(): UuidV7 {
    const id = parseUuidV7(this.options.ids.next());
    if (!id.ok) {
      throw new TypeError("Extraction UUID generator returned a non-UUIDv7 value.");
    }
    return id.value;
  }

  private requireNow(): Result<IsoUtcTimestamp, StoryCoreError> {
    return parseIsoUtcTimestamp(this.options.clock.now());
  }

  private requireEnabled(): Result<true, StoryCoreError> {
    return this.options.enabled
      ? ok(true)
      : err(
          new StoryCoreError({
            code: "EXTRACTION_DISABLED",
            message: "Authoritative extraction is disabled by its default-off feature flag.",
          }),
        );
  }
}

function providerRequest(
  context: AuthoritativeExtractionValidationContext,
  assertProjectContextCurrent?: () => Promise<void>,
): AuthoritativeExtractionProviderRequest {
  return Object.freeze({
    publicationBoundary: "candidate_only",
    formalWriteAllowed: false,
    instruction: buildAuthoritativeExtractionOutputInstruction(context),
    source: context.source,
    chapterContent: context.chapterContent,
    targets: context.targets,
    provenance: context.provenance,
    ...(assertProjectContextCurrent === undefined ? {} : { assertProjectContextCurrent }),
  });
}

function reviewMatchesCandidate(
  review: StructuredReviewItem<"extraction">,
  record: AuthoritativeExtractionCandidateRecord,
): boolean {
  const snapshot = review.toSnapshot();
  return (
    snapshot.id === record.reviewItemId &&
    snapshot.projectId === record.source.projectId &&
    snapshot.category === record.candidate.category &&
    snapshot.targetRecordId === record.candidate.target.recordId &&
    snapshot.targetRecordKind === record.candidate.target.kind &&
    snapshot.sourceChapterId === record.source.chapterId &&
    snapshot.sourceVersionId === record.source.versionId &&
    snapshot.evidence.excerpt === record.candidate.evidence.excerpt &&
    snapshot.evidence.range.start === record.candidate.evidence.range.start &&
    snapshot.evidence.range.end === record.candidate.evidence.range.end &&
    snapshot.evidence.range.sourceLength === record.candidate.evidence.range.sourceLength &&
    snapshot.confidence === record.candidate.confidence &&
    storyValuesEqual(snapshot.originalValue, record.candidate.originalValue) &&
    storyValuesEqual(snapshot.suggestedValue, record.candidate.suggestedValue)
  );
}

function sameSource(
  left: AuthoritativeExtractionSource,
  right: AuthoritativeExtractionSource,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.chapterId === right.chapterId &&
    left.versionId === right.versionId &&
    left.checksumSha256 === right.checksumSha256 &&
    left.scope.start === right.scope.start &&
    left.scope.end === right.scope.end &&
    left.scope.sourceLength === right.scope.sourceLength
  );
}

function sanitizeProviderCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]/gu, "_")
    .slice(0, 96);
  return /^[a-z]/u.test(normalized) ? normalized : "provider_failure";
}

function extractionSourceChanged(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "EXTRACTION_SOURCE_CHANGED",
      message,
      actions: ["OPEN_SOURCE", "RECOMPARE", "RETRY"],
    }),
  );
}

function extractionIntegrityError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message,
      actions: ["CONTACT_SUPPORT"],
    }),
  );
}

function extractionValidationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
    }),
  );
}

function extractionNotFound(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "EXTRACTION_JOB_NOT_FOUND",
      message,
    }),
  );
}
