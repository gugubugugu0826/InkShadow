import type {
  AcceptAiCandidate,
  AcceptCandidateOutcome,
  AiCandidateRepository,
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import type {
  CloudMutationOptions,
  CloudQueryOptions,
  InkShadowCloudApiClient,
} from "@inkshadow/cloud-client";
import {
  UuidV7Schema,
  type CloudProjectAssignment,
  type CloudTeamMembership,
} from "@inkshadow/contracts";
import {
  AiCandidate,
  parseUuidV7 as parseDomainUuid,
  type AppError,
  type Clock,
  type Result,
  type UuidV7Generator,
} from "@inkshadow/domain";
import { SyncMaterializationSqliteStore, type SqlExecutor } from "@inkshadow/data";

import type { CloudSessionCoordinator } from "./cloud-session-coordinator";
import type { CloudTeamWorkspacePort } from "./cloud-team-workspace-service";
import type { ProjectKeyLifecycleService } from "./project-key-lifecycle";
import { StudioReviewCrypto } from "./studio-review-crypto";
import {
  StudioReviewCoordinator,
  StudioReviewCoordinatorError,
  type StableEncryptedReviewSource,
  type StudioReviewCandidateVersionPort,
  type StudioReviewProjectKeyAccessPort,
  type StudioReviewStableSourcePort,
  type StudioReviewSuggestionApplicationReceipt,
  type VerifiedStudioReviewSuggestionApplication,
} from "./studio-review-coordinator";
import {
  StudioReviewService,
  type StudioReviewConnectivityPort,
  type StudioReviewRemotePort,
  type StudioReviewSessionContext,
} from "./studio-review-service";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_STABLE_PROJECTION_ROWS = 100_000;
const REVIEW_PROJECTION_OBJECT_TYPES = new Set([
  "project_manifest",
  "chapter_version",
  "story_record",
  "outline",
  "memory",
  "material",
  "attachment",
]);

export class StudioReviewRuntimeError extends Error {
  public constructor(
    public readonly code:
      "REVIEW_AUTHORITY_INCOMPLETE" | "REVIEW_AUTHORITY_INVALID" | "REVIEW_RUNTIME_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "StudioReviewRuntimeError";
  }
}

export interface StudioReviewRuntime {
  readonly coordinator: StudioReviewCoordinator;
  isOnline(): boolean;
  resolveContext(
    teamId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<StudioReviewSessionContext>;
}

interface StudioReviewCandidateRepository extends AiCandidateRepository {
  create(candidate: AiCandidate): Promise<Result<void, AppError>>;
}

export interface CreateStudioReviewRuntimeOptions {
  readonly api: InkShadowCloudApiClient;
  readonly session: CloudSessionCoordinator;
  readonly teams: CloudTeamWorkspacePort;
  readonly projectSecurity: ProjectKeyLifecycleService;
  readonly executor: SqlExecutor;
  readonly chapters: ChapterRepository;
  readonly chapterVersions: ChapterVersionRepository;
  readonly candidates: StudioReviewCandidateRepository;
  readonly acceptCandidate: AcceptAiCandidate;
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
  readonly hasher: ContentHasher;
  readonly connectivity?: StudioReviewConnectivityPort;
  readonly cryptoProvider?: Crypto;
}

export interface StudioReviewLocalSessionAuthorityPort {
  resolve(signal?: AbortSignal): Promise<Readonly<{ accountId: string; deviceId: string }>>;
}

/**
 * Production-only Studio review composition root.
 *
 * Every required authority is explicit. Callers cannot accidentally construct a
 * cloud-successing browser fake because native session, SQLite projection
 * authority, project-key lifecycle, and the author content commit path are all
 * mandatory dependencies.
 */
export function createStudioReviewRuntime(
  options: CreateStudioReviewRuntimeOptions,
): StudioReviewRuntime {
  const connectivity = options.connectivity ?? new NavigatorStudioReviewConnectivity();
  const stableSources = new SqliteStudioReviewStableSource(
    options.executor,
    {
      resolve: async (signal) => {
        const status = await options.session.ensureReady(signal === undefined ? {} : { signal });
        return Object.freeze({
          accountId: status.account.accountId,
          deviceId: status.device.device.deviceId,
        });
      },
    },
    options.cryptoProvider,
  );
  const service = new StudioReviewService(
    createSessionBoundReviewRemote(options.api, options.session),
    connectivity,
  );
  const coordinator = new StudioReviewCoordinator({
    service,
    crypto: new StudioReviewCrypto(options.cryptoProvider),
    stableSources,
    projectKeys: new LifecycleStudioReviewProjectKeys(options.projectSecurity, options.session),
    candidates: new RepositoryStudioReviewCandidateVersions({
      stableSources,
      chapters: options.chapters,
      chapterVersions: options.chapterVersions,
      candidates: options.candidates,
      acceptCandidate: options.acceptCandidate,
      clock: options.clock,
      hasher: options.hasher,
    }),
    ids: options.ids,
    idempotencyKeys: {
      next: () => options.ids.next(),
    },
  });
  const authority = new CloudStudioReviewAuthority(options.teams);
  return Object.freeze({
    coordinator,
    isOnline: () => connectivity.isOnline(),
    resolveContext: (teamId: string, projectId: string, signal?: AbortSignal) =>
      authority.resolveContext(teamId, projectId, signal),
  });
}

class NavigatorStudioReviewConnectivity implements StudioReviewConnectivityPort {
  public isOnline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine;
  }
}

export class CloudStudioReviewAuthority {
  public constructor(private readonly teams: CloudTeamWorkspacePort) {}

  public async resolveContext(
    teamIdValue: string,
    projectIdValue: string,
    signal?: AbortSignal,
  ): Promise<StudioReviewSessionContext> {
    throwIfAborted(signal);
    const teamId = requireUuid(teamIdValue);
    const projectId = requireUuid(projectIdValue);
    const accountId = await this.teams.getCurrentAccountId(signal);
    const [members, assignments] = await Promise.all([
      this.teams.listTeamMembers(teamId, signal),
      this.teams.listProjectAssignments(teamId, projectId, signal),
    ]);
    throwIfAborted(signal);
    if (members.nextCursor !== null || assignments.nextCursor !== null) {
      throw new StudioReviewRuntimeError(
        "REVIEW_AUTHORITY_INCOMPLETE",
        "Review authority cannot be decided from a truncated membership or assignment page.",
      );
    }

    const memberships = members.memberships.map((membership) =>
      requireMembershipScope(membership, teamId),
    );
    const actorCandidates = memberships.filter((membership) => membership.accountId === accountId);
    if (actorCandidates.length !== 1) {
      throw invalidAuthority("The current account does not have one exact team membership.");
    }
    const actor = actorCandidates[0];
    if (actor === undefined) {
      throw invalidAuthority("The current team membership is unavailable.");
    }
    if (memberships.some((membership) => membership.tenantId !== actor.tenantId)) {
      throw invalidAuthority("The membership response crossed its tenant scope.");
    }
    const scopedAssignments = assignments.assignments.map((assignment) =>
      requireAssignmentScope(assignment, actor.tenantId, teamId, projectId),
    );
    const membershipIds = new Set(memberships.map((membership) => membership.membershipId));
    if (scopedAssignments.some((assignment) => !membershipIds.has(assignment.membershipId))) {
      throw invalidAuthority("A project assignment referenced an unknown team membership.");
    }
    const actorAssignments = scopedAssignments.filter(
      (assignment) => assignment.membershipId === actor.membershipId,
    );
    if (actorAssignments.length > 1) {
      throw invalidAuthority("The current membership has duplicate project assignments.");
    }
    const assignment = actorAssignments[0] ?? null;
    return Object.freeze({
      tenantId: actor.tenantId,
      teamId,
      projectId,
      membershipId: actor.membershipId,
      role: actor.role,
      membershipState: actor.state,
      assignmentState: assignment?.state ?? "missing",
    });
  }
}

class LifecycleStudioReviewProjectKeys implements StudioReviewProjectKeyAccessPort {
  public constructor(
    private readonly projectSecurity: ProjectKeyLifecycleService,
    private readonly session: CloudSessionCoordinator,
  ) {}

  public async openReviewProjectKey(
    request: Readonly<{ projectId: string; keyVersion: number }>,
    signal?: AbortSignal,
  ) {
    const status = await this.session.ensureReady(signal === undefined ? {} : { signal });
    throwIfAborted(signal);
    const opened = await this.projectSecurity.openProjectDataKeyForDevice(
      request.projectId,
      status.device.device.deviceId,
      request.keyVersion,
      {
        accountId: status.account.accountId,
        expectedSessionId: status.session.sessionId,
      },
    );
    throwIfAborted(signal);
    return Object.freeze({
      projectId: opened.projectId,
      keyVersion: opened.keyVersion,
      key: opened.key,
    });
  }
}

interface StableProjectionRow {
  readonly job_id: string;
  readonly account_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly projection_kind: string;
  readonly source_revision: number;
  readonly key_version: number;
  readonly status: string;
  readonly operation_id: string | null;
  readonly outbox_status: string | null;
  readonly position: number | null;
  readonly ciphertext_sha256: string | null;
}

/**
 * Reads only acknowledged ciphertext projections. Any queued/failed/latest
 * projection, mixed key generation, missing manifest, or malformed chunk set
 * makes the source unavailable instead of falling back to plaintext.
 */
export class SqliteStudioReviewStableSource implements StudioReviewStableSourcePort {
  private readonly registrations: SyncMaterializationSqliteStore;
  private readonly cryptoProvider: Crypto;

  public constructor(
    private readonly executor: SqlExecutor,
    private readonly sessionAuthority: StudioReviewLocalSessionAuthorityPort,
    cryptoProvider: Crypto = globalThis.crypto,
  ) {
    this.registrations = new SyncMaterializationSqliteStore(executor);
    this.cryptoProvider = cryptoProvider;
  }

  public async loadStableEncryptedSource(
    scope: Readonly<{ tenantId: string; teamId: string; projectId: string }>,
    signal?: AbortSignal,
  ): Promise<StableEncryptedReviewSource | null> {
    throwIfAborted(signal);
    const tenantId = requireUuid(scope.tenantId);
    const teamId = requireUuid(scope.teamId);
    const projectId = requireUuid(scope.projectId);
    const sessionAuthority = await this.sessionAuthority.resolve(signal);
    throwIfAborted(signal);
    const accountId = requireUuid(sessionAuthority.accountId);
    const deviceId = requireUuid(sessionAuthority.deviceId);
    const registrationResult = await this.registrations.loadProjectSyncRegistration(projectId);
    const registration = unwrapResult(registrationResult);
    if (
      registration?.accountId !== accountId ||
      registration.deviceId !== deviceId ||
      registration.state !== "enabled" ||
      !registration.plaintextBootstrapCompleted
    ) {
      return null;
    }
    const rows = await this.executor.select<StableProjectionRow>(
      `WITH ranked AS (
         SELECT
           job.*,
           ROW_NUMBER() OVER (
             PARTITION BY job.object_type, job.object_id
             ORDER BY
               job.object_generation DESC,
               job.source_revision DESC,
               job.created_at DESC,
               job.job_id DESC
           ) AS source_rank
         FROM sync_projection_jobs AS job
         WHERE job.project_id = ? AND job.status <> 'superseded'
       )
       SELECT
         latest.job_id,
         latest.account_id,
         latest.object_type,
         latest.object_id,
         latest.object_generation,
         latest.projection_kind,
         latest.source_revision,
         latest.key_version,
         latest.status,
         latest.operation_id,
         outbox.status AS outbox_status,
         link.position,
         chunk.ciphertext_sha256
       FROM ranked AS latest
       LEFT JOIN sync_outbox_operations AS outbox
         ON outbox.operation_id = latest.operation_id
       LEFT JOIN sync_operation_chunks AS link
         ON link.operation_id = latest.operation_id
       LEFT JOIN sync_ciphertext_chunks AS chunk
         ON chunk.chunk_id = link.chunk_id
       WHERE latest.source_rank = 1
       ORDER BY
         latest.object_type ASC,
         latest.object_id ASC,
         latest.object_generation ASC,
         link.position ASC
       LIMIT ?`,
      [projectId, MAX_STABLE_PROJECTION_ROWS + 1],
    );
    throwIfAborted(signal);
    if (rows.length === 0 || rows.length > MAX_STABLE_PROJECTION_ROWS) {
      return null;
    }
    if (rows.some((row) => row.account_id !== accountId)) {
      return null;
    }

    const projections = groupStableProjectionRows(rows);
    if (
      projections.length === 0 ||
      !projections.some(
        (projection) =>
          projection.objectType === "project_manifest" && projection.kind === "upsert",
      ) ||
      projections.some(
        (projection) =>
          projection.status !== "completed" ||
          projection.outboxStatus !== "acknowledged" ||
          projection.keyVersion !== registration.keyVersion ||
          projection.operationId === null ||
          (projection.kind === "upsert" && projection.ciphertextHashes.length === 0) ||
          (projection.kind === "delete" && projection.ciphertextHashes.length !== 0),
      )
    ) {
      return null;
    }

    const manifest = projections.map((projection) => ({
      jobId: projection.jobId,
      objectType: projection.objectType,
      objectId: projection.objectId,
      objectGeneration: projection.objectGeneration,
      kind: projection.kind,
      sourceRevision: projection.sourceRevision,
      operationId: projection.operationId,
      ciphertextSha256: projection.ciphertextHashes,
    }));
    const authoritativeCiphertextSha256 = await sha256Hex(
      this.cryptoProvider,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    throwIfAborted(signal);
    const sourceVersion = projections.at(-1);
    if (sourceVersion === undefined) {
      return null;
    }
    let sourceVersionRevision = 0;
    for (const projection of projections) {
      sourceVersionRevision = Math.max(sourceVersionRevision, projection.sourceRevision);
    }
    return Object.freeze({
      authority: "saved_stable_encrypted_projection",
      projectionState: "settled",
      tenantId,
      teamId,
      projectId,
      sourceVersionId: sourceVersion.jobId,
      sourceVersionRevision,
      authoritativeCiphertextSha256,
      projectKeyVersion: registration.keyVersion,
    });
  }
}

interface StableProjection {
  readonly jobId: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly objectGeneration: number;
  readonly kind: "upsert" | "delete";
  readonly sourceRevision: number;
  readonly keyVersion: number;
  readonly status: string;
  readonly operationId: string | null;
  readonly outboxStatus: string | null;
  readonly ciphertextHashes: readonly string[];
}

function groupStableProjectionRows(
  rows: readonly StableProjectionRow[],
): readonly StableProjection[] {
  const projections: StableProjection[] = [];
  for (const row of rows) {
    const previous = projections.at(-1);
    if (previous?.jobId === row.job_id) {
      if (
        row.position === null ||
        row.position !== previous.ciphertextHashes.length ||
        row.ciphertext_sha256 === null ||
        !SHA256_HEX_PATTERN.test(row.ciphertext_sha256)
      ) {
        return [];
      }
      projections[projections.length - 1] = Object.freeze({
        ...previous,
        ciphertextHashes: Object.freeze([...previous.ciphertextHashes, row.ciphertext_sha256]),
      });
      continue;
    }
    if (
      !UuidV7Schema.safeParse(row.job_id).success ||
      !UuidV7Schema.safeParse(row.object_id).success ||
      !REVIEW_PROJECTION_OBJECT_TYPES.has(row.object_type) ||
      (row.projection_kind !== "upsert" && row.projection_kind !== "delete") ||
      !Number.isSafeInteger(row.object_generation) ||
      row.object_generation < 1 ||
      !Number.isSafeInteger(row.source_revision) ||
      row.source_revision < 1 ||
      !Number.isSafeInteger(row.key_version) ||
      row.key_version < 1 ||
      (row.operation_id !== null && !UuidV7Schema.safeParse(row.operation_id).success) ||
      (row.position !== null && row.position !== 0) ||
      (row.position === null) !== (row.ciphertext_sha256 === null) ||
      (row.ciphertext_sha256 !== null && !SHA256_HEX_PATTERN.test(row.ciphertext_sha256))
    ) {
      return [];
    }
    projections.push(
      Object.freeze({
        jobId: row.job_id,
        objectType: row.object_type,
        objectId: row.object_id,
        objectGeneration: row.object_generation,
        kind: row.projection_kind,
        sourceRevision: row.source_revision,
        keyVersion: row.key_version,
        status: row.status,
        operationId: row.operation_id,
        outboxStatus: row.outbox_status,
        ciphertextHashes: Object.freeze(
          row.ciphertext_sha256 === null ? [] : [row.ciphertext_sha256],
        ),
      }),
    );
  }
  return Object.freeze(projections);
}

interface RepositoryStudioReviewCandidateVersionsOptions {
  readonly stableSources: StudioReviewStableSourcePort;
  readonly chapters: ChapterRepository;
  readonly chapterVersions: ChapterVersionRepository;
  readonly candidates: StudioReviewCandidateRepository;
  readonly acceptCandidate: AcceptAiCandidate;
  readonly clock: Clock;
  readonly hasher: ContentHasher;
}

export class RepositoryStudioReviewCandidateVersions implements StudioReviewCandidateVersionPort {
  public constructor(private readonly options: RepositoryStudioReviewCandidateVersionsOptions) {}

  public async applyVerifiedSuggestion(
    application: VerifiedStudioReviewSuggestionApplication,
    signal?: AbortSignal,
  ): Promise<StudioReviewSuggestionApplicationReceipt> {
    throwIfAborted(signal);
    requireApplicationIdentity(application);
    if (
      application.applicationId !== application.itemId ||
      application.candidate.candidateId !== application.itemId
    ) {
      throw invalidSuggestion("The review item and author candidate identities diverged.");
    }
    const candidateId = parseUuid(application.candidate.candidateId);
    const chapterId = parseUuid(application.anchor.chapterId);
    const projectId = parseUuid(application.projectId);
    let candidate = unwrapResult(await this.options.candidates.findById(candidateId));
    if (candidate?.status === "accepted") {
      const existing = await this.requireAcceptedApplication(
        application,
        candidate,
        projectId,
        chapterId,
      );
      return receipt(application, existing.id, existing.sequence, "already_applied");
    }
    await this.requireStableBase(application, signal);
    const loadedChapter = unwrapResult(await this.options.chapters.findById(chapterId));
    if (loadedChapter?.projectId !== projectId) {
      throw invalidSuggestion("The suggestion chapter is not in the reviewed project.");
    }
    const { startUtf16, endUtf16 } = application.anchor;
    if (endUtf16 > loadedChapter.content.length) {
      throw new StudioReviewCoordinatorError(
        "REVIEW_REVISION_CONFLICT",
        "The reviewed text range no longer exists in the stable chapter.",
      );
    }
    const selected = loadedChapter.content.slice(startUtf16, endUtf16);
    const selectedHash = unwrapResult(await this.options.hasher.sha256(selected));
    if (selectedHash !== application.anchor.selectedTextSha256) {
      throw new StudioReviewCoordinatorError(
        "REVIEW_REVISION_CONFLICT",
        "The reviewed text changed before this suggestion was accepted.",
      );
    }
    const candidateContent =
      loadedChapter.content.slice(0, startUtf16) +
      application.candidate.replacement.text +
      loadedChapter.content.slice(endUtf16);
    const contentHash = unwrapResult(await this.options.hasher.sha256(candidateContent));
    if (candidate === null) {
      const streaming = unwrapResult(
        AiCandidate.createStreaming({
          id: candidateId,
          projectId,
          chapterId,
          source: "agent",
          baseVersionId: loadedChapter.currentVersionId,
          now: this.options.clock.now(),
        }),
      );
      candidate = unwrapResult(
        streaming.markReady(candidateContent, contentHash, this.options.clock.now()),
      );
      const created = await this.options.candidates.create(candidate);
      if (!created.ok) {
        candidate = unwrapResult(await this.options.candidates.findById(candidateId));
      }
    }
    if (
      candidate?.projectId !== projectId ||
      candidate.chapterId !== chapterId ||
      candidate.baseVersionId !== loadedChapter.currentVersionId ||
      candidate.content !== candidateContent
    ) {
      throw invalidSuggestion("The durable local candidate identity is already used differently.");
    }

    if (candidate.status === "accepted") {
      const existing = await this.requireAcceptedApplication(
        application,
        candidate,
        projectId,
        chapterId,
      );
      return receipt(application, existing.id, existing.sequence, "already_applied");
    }
    if (candidate.status !== "ready") {
      throw invalidSuggestion("The durable local candidate is no longer accept-ready.");
    }
    await this.requireStableBase(application, signal);
    const accepted = await this.options.acceptCandidate.execute({
      candidateId,
      expectedCandidateRevision: candidate.revision,
      strategy: { kind: "accept_all" },
    });
    if (!accepted.ok) {
      const racedCandidate = unwrapResult(await this.options.candidates.findById(candidateId));
      if (racedCandidate?.status === "accepted") {
        const existing = await this.requireAcceptedApplication(
          application,
          racedCandidate,
          projectId,
          chapterId,
        );
        return receipt(application, existing.id, existing.sequence, "already_applied");
      }
      throw accepted.error;
    }
    const outcome: AcceptCandidateOutcome = accepted.value;
    throwIfAborted(signal);
    return receipt(
      application,
      outcome.version.toSnapshot().id,
      outcome.version.toSnapshot().sequence,
      "created",
    );
  }

  public async loadAppliedSuggestion(
    scope: Readonly<{
      tenantId: string;
      teamId: string;
      projectId: string;
      reviewId: string;
      threadId: string;
      itemId: string;
    }>,
    expected: StudioReviewSuggestionApplicationReceipt,
    signal?: AbortSignal,
  ): Promise<StudioReviewSuggestionApplicationReceipt | null> {
    throwIfAborted(signal);
    if (
      (expected as { readonly authority?: unknown }).authority !==
        "local_review_suggestion_version" ||
      expected.applicationId !== scope.itemId ||
      expected.itemId !== scope.itemId ||
      expected.candidateId !== scope.itemId ||
      expected.tenantId !== scope.tenantId ||
      expected.teamId !== scope.teamId ||
      expected.projectId !== scope.projectId ||
      expected.reviewId !== scope.reviewId ||
      expected.threadId !== scope.threadId
    ) {
      return null;
    }
    const candidateId = parseUuid(scope.itemId);
    const candidate = unwrapResult(await this.options.candidates.findById(candidateId));
    if (
      candidate?.status !== "accepted" ||
      candidate.projectId !== parseUuid(scope.projectId) ||
      candidate.chapterId === null
    ) {
      return null;
    }
    const version = await this.findAcceptedVersion(candidateId, candidate.chapterId);
    throwIfAborted(signal);
    if (version.id !== expected.newVersionId || version.sequence !== expected.newVersionRevision) {
      return null;
    }
    return Object.freeze({ ...expected, result: "already_applied" });
  }

  private async findAcceptedVersion(candidateId: string, chapterId: string) {
    const versions = unwrapResult(
      await this.options.chapterVersions.listByChapterId(parseUuid(chapterId)),
    );
    const matches = versions
      .map((version) => version.toSnapshot())
      .filter((version) => version.sourceCandidateId === candidateId);
    if (matches.length !== 1 || matches[0] === undefined) {
      throw invalidSuggestion("The accepted review candidate version is missing or duplicated.");
    }
    return matches[0];
  }

  private async requireAcceptedApplication(
    application: VerifiedStudioReviewSuggestionApplication,
    candidate: AiCandidate,
    projectId: ReturnType<typeof parseUuid>,
    chapterId: ReturnType<typeof parseUuid>,
  ) {
    if (
      candidate.projectId !== projectId ||
      candidate.chapterId !== chapterId ||
      candidate.baseVersionId === null
    ) {
      throw invalidSuggestion(
        "The durable accepted candidate identity is already used in another scope.",
      );
    }
    const baseline = unwrapResult(
      await this.options.chapterVersions.findVersionById(candidate.baseVersionId),
    );
    if (baseline === null) {
      throw invalidSuggestion("The accepted review candidate baseline is missing.");
    }
    const baselineSnapshot = baseline.toSnapshot();
    const { startUtf16, endUtf16 } = application.anchor;
    if (
      baselineSnapshot.projectId !== projectId ||
      baselineSnapshot.chapterId !== chapterId ||
      endUtf16 > baselineSnapshot.content.length
    ) {
      throw invalidSuggestion("The accepted review candidate baseline crossed its exact scope.");
    }
    const selected = baselineSnapshot.content.slice(startUtf16, endUtf16);
    const selectedHash = unwrapResult(await this.options.hasher.sha256(selected));
    const expectedContent =
      baselineSnapshot.content.slice(0, startUtf16) +
      application.candidate.replacement.text +
      baselineSnapshot.content.slice(endUtf16);
    if (
      selectedHash !== application.anchor.selectedTextSha256 ||
      candidate.content !== expectedContent
    ) {
      throw invalidSuggestion(
        "The durable accepted candidate does not match the verified review suggestion.",
      );
    }
    const existing = await this.findAcceptedVersion(candidate.id, chapterId);
    if (existing.content !== candidate.content) {
      throw invalidSuggestion("The accepted candidate and stable version content diverged.");
    }
    return existing;
  }

  private async requireStableBase(
    application: VerifiedStudioReviewSuggestionApplication,
    signal?: AbortSignal,
  ): Promise<void> {
    const stable = await this.options.stableSources.loadStableEncryptedSource(
      {
        tenantId: application.tenantId,
        teamId: application.teamId,
        projectId: application.projectId,
      },
      signal,
    );
    if (
      stable?.tenantId !== application.tenantId ||
      (stable as { readonly authority?: unknown }).authority !==
        "saved_stable_encrypted_projection" ||
      (stable as { readonly projectionState?: unknown }).projectionState !== "settled" ||
      stable.teamId !== application.teamId ||
      stable.projectId !== application.projectId ||
      stable.sourceVersionId !== application.expectedBase.sourceVersionId ||
      stable.sourceVersionRevision !== application.expectedBase.sourceVersionRevision ||
      stable.authoritativeCiphertextSha256 !== application.expectedBase.sourceCiphertextSha256
    ) {
      throw new StudioReviewCoordinatorError(
        "REVIEW_SOURCE_CHANGED",
        "The acknowledged encrypted projection changed before author acceptance.",
      );
    }
  }
}

function createSessionBoundReviewRemote(
  api: InkShadowCloudApiClient,
  session: CloudSessionCoordinator,
): StudioReviewRemotePort {
  const run = <Value>(signal: AbortSignal | undefined, operation: () => Promise<Value>) =>
    session.runWithSession(() => operation(), signal === undefined ? {} : { signal });
  return Object.freeze({
    listReviews: (teamId, projectId, options: CloudQueryOptions = {}) =>
      run(options.signal, () => api.listReviews(teamId, projectId, options)),
    getReview: (teamId, projectId, reviewId, options: CloudQueryOptions = {}) =>
      run(options.signal, () => api.getReview(teamId, projectId, reviewId, options)),
    submitReview: (teamId, projectId, request, options: CloudMutationOptions) =>
      run(options.signal, () => api.submitReview(teamId, projectId, request, options)),
    appendReviewThreadItem: (teamId, projectId, reviewId, request, options: CloudMutationOptions) =>
      run(options.signal, () =>
        api.appendReviewThreadItem(teamId, projectId, reviewId, request, options),
      ),
    listReviewThreadItems: (
      teamId,
      projectId,
      reviewId,
      threadId,
      options: CloudQueryOptions = {},
    ) =>
      run(options.signal, () =>
        api.listReviewThreadItems(teamId, projectId, reviewId, threadId, options),
      ),
    listReviewThreads: (teamId, projectId, reviewId, options: CloudQueryOptions = {}) =>
      run(options.signal, () => api.listReviewThreads(teamId, projectId, reviewId, options)),
    decideReview: (teamId, projectId, reviewId, request, options: CloudMutationOptions) =>
      run(options.signal, () => api.decideReview(teamId, projectId, reviewId, request, options)),
    resolveReviewThread: (
      teamId,
      projectId,
      reviewId,
      threadId,
      request,
      options: CloudMutationOptions,
    ) =>
      run(options.signal, () =>
        api.resolveReviewThread(teamId, projectId, reviewId, threadId, request, options),
      ),
    decideReviewSuggestion: (
      teamId,
      projectId,
      reviewId,
      threadId,
      itemId,
      request,
      options: CloudMutationOptions,
    ) =>
      run(options.signal, () =>
        api.decideReviewSuggestion(teamId, projectId, reviewId, threadId, itemId, request, options),
      ),
  });
}

function requireMembershipScope(
  membership: CloudTeamMembership,
  teamId: string,
): CloudTeamMembership {
  if (membership.teamId !== teamId) {
    throw invalidAuthority("The membership response crossed its requested team scope.");
  }
  return membership;
}

function requireAssignmentScope(
  assignment: CloudProjectAssignment,
  tenantId: string,
  teamId: string,
  projectId: string,
): CloudProjectAssignment {
  if (
    assignment.tenantId !== tenantId ||
    assignment.teamId !== teamId ||
    assignment.projectId !== projectId
  ) {
    throw invalidAuthority("The assignment response crossed its requested project scope.");
  }
  return assignment;
}

function requireApplicationIdentity(application: VerifiedStudioReviewSuggestionApplication): void {
  for (const value of [
    application.applicationId,
    application.tenantId,
    application.teamId,
    application.projectId,
    application.reviewId,
    application.threadId,
    application.itemId,
    application.candidate.candidateId,
    application.anchor.chapterId,
    application.requestedByMembershipId,
  ]) {
    requireUuid(value);
  }
  if (
    application.applicationId !== application.itemId ||
    application.candidate.candidateId !== application.itemId ||
    application.candidate.replacement.chapterId !== application.anchor.chapterId ||
    application.candidate.replacement.startUtf16 !== application.anchor.startUtf16 ||
    application.candidate.replacement.endUtf16 !== application.anchor.endUtf16 ||
    application.candidate.baseSourceVersionId !== application.expectedBase.sourceVersionId ||
    application.candidate.baseSourceVersionRevision !==
      application.expectedBase.sourceVersionRevision ||
    application.candidate.baseSourceCiphertextSha256 !==
      application.expectedBase.sourceCiphertextSha256
  ) {
    throw invalidSuggestion("The verified review suggestion identity or source binding diverged.");
  }
}

function receipt(
  application: VerifiedStudioReviewSuggestionApplication,
  newVersionId: string,
  newVersionRevision: number,
  result: StudioReviewSuggestionApplicationReceipt["result"],
): StudioReviewSuggestionApplicationReceipt {
  return Object.freeze({
    authority: "local_review_suggestion_version",
    applicationId: application.applicationId,
    tenantId: application.tenantId,
    teamId: application.teamId,
    projectId: application.projectId,
    reviewId: application.reviewId,
    threadId: application.threadId,
    itemId: application.itemId,
    candidateId: application.candidate.candidateId,
    baseSourceVersionId: application.expectedBase.sourceVersionId,
    baseSourceVersionRevision: application.expectedBase.sourceVersionRevision,
    baseSourceCiphertextSha256: application.expectedBase.sourceCiphertextSha256,
    newVersionId,
    newVersionRevision,
    result,
  });
}

function invalidSuggestion(message: string): StudioReviewCoordinatorError {
  return new StudioReviewCoordinatorError("REVIEW_SUGGESTION_INVALID", message);
}

function invalidAuthority(message: string): StudioReviewRuntimeError {
  return new StudioReviewRuntimeError("REVIEW_AUTHORITY_INVALID", message);
}

function requireUuid(value: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw invalidAuthority("Studio review authority requires canonical UUIDv7 identifiers.");
  }
  return parsed.data.toLowerCase();
}

function parseUuid(value: string) {
  const parsed = parseDomainUuid(value);
  if (!parsed.ok) {
    throw invalidSuggestion("The local review candidate uses an invalid UUIDv7 identity.");
  }
  return parsed.value;
}

function unwrapResult<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function sha256Hex(cryptoProvider: Crypto, bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  try {
    const digest = await cryptoProvider.subtle.digest("SHA-256", owned);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
      "",
    );
  } finally {
    owned.fill(0);
    bytes.fill(0);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The Studio review runtime operation was cancelled.", "AbortError");
  }
}
