import { parseMultiAgentPublicResponse, type MultiAgentPublicResponse } from "@inkshadow/ai-core";
import {
  computeMultiAgentReviewCompletionFingerprint,
  computeMultiAgentReviewRequestFingerprint,
  type CreateMultiAgentReviewSessionInput,
  type MultiAgentReviewConclusion,
  type MultiAgentReviewLimits,
  type MultiAgentReviewParticipantSnapshot,
  type MultiAgentReviewSession,
  type MultiAgentReviewSqliteStore,
  MultiAgentReviewStoreError,
  type MultiAgentReviewTargetKind,
  type PersistedMultiAgentReviewMode,
  type PersistedMultiAgentReviewRole,
  type SqlExecutor,
} from "@inkshadow/data";
import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import type { ModelCenterStore, ModelProfile } from "./model-center-store";
import type { ModelRoutingStore } from "./model-routing-store";
import type { NativeModelGatewayClient } from "./runtime";

export const MULTI_AGENT_LOCAL_ROLES = [
  "planner",
  "drafter",
  "critic",
  "continuity_reviewer",
  "editor",
] as const satisfies readonly PersistedMultiAgentReviewRole[];

export interface StartMultiAgentReviewInput {
  readonly projectId: string;
  readonly mode: PersistedMultiAgentReviewMode;
  readonly target:
    { readonly kind: "chapter"; readonly chapterId: string } | { readonly kind: "outline" };
  readonly userRequest: string;
  readonly roles: readonly PersistedMultiAgentReviewRole[];
  readonly maximumRounds: number;
  readonly limits: Omit<MultiAgentReviewLimits, "maximumRounds" | "maximumTurns">;
  readonly execution?: "local" | "team_cloud";
}

export interface RunMultiAgentReviewOptions {
  readonly signal?: AbortSignal;
  readonly onUpdate?: (session: MultiAgentReviewSession) => void;
}

export interface MultiAgentReviewContext {
  readonly authorityJson: string;
  readonly citationReceiptsJson: string;
}

export interface MultiAgentReviewContextReader {
  resolveTargetAuthority(
    projectId: string,
    target: StartMultiAgentReviewInput["target"],
  ): Promise<CreateMultiAgentReviewSessionInput["target"]>;
  load(session: MultiAgentReviewSession): Promise<MultiAgentReviewContext>;
}

export type MultiAgentReviewRuntimeErrorCode =
  | "MULTI_AGENT_FEATURE_DISABLED"
  | "MULTI_AGENT_TEAM_CLOUD_DISABLED"
  | "MULTI_AGENT_MODEL_ROUTE_MISSING"
  | "MULTI_AGENT_MODEL_PROFILE_INVALID"
  | "MULTI_AGENT_TARGET_STALE"
  | "MULTI_AGENT_RESOURCE_EXHAUSTED"
  | "MULTI_AGENT_ALREADY_RUNNING";

export class MultiAgentReviewRuntimeError extends Error {
  public constructor(
    readonly code: MultiAgentReviewRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MultiAgentReviewRuntimeError";
  }
}

interface RuntimeDependencies {
  readonly store: MultiAgentReviewSqliteStore;
  readonly contextReader: MultiAgentReviewContextReader;
  readonly modelCenter: ModelCenterStore;
  readonly modelRouting: ModelRoutingStore;
  readonly modelGateway: NativeModelGatewayClient;
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
  readonly enabled: boolean;
}

const ROUTE_ROLE_BY_AGENT_ROLE = {
  planner: "high_quality",
  drafter: "high_quality",
  critic: "validation",
  continuity_reviewer: "long_context",
  editor: "high_quality",
} as const;
const PORTABLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/u;

export class MultiAgentReviewRuntime {
  private readonly activeGenerations = new Map<string, string>();
  private readonly cancellations = new Map<string, Promise<MultiAgentReviewSession>>();

  public constructor(private readonly dependencies: RuntimeDependencies) {}

  public async startReview(input: StartMultiAgentReviewInput): Promise<MultiAgentReviewSession> {
    this.requireEnabled();
    if ((input.execution ?? "local") !== "local") {
      throw runtimeError(
        "MULTI_AGENT_TEAM_CLOUD_DISABLED",
        "Team cloud multi-agent execution is not enabled; this review is local-only.",
      );
    }
    const roles = validateRoles(input.roles);
    const maximumRounds = requireInteger(input.maximumRounds, 1, 16, "maximumRounds");
    const participants = await Promise.all(
      roles.map((role, ordinal) => this.resolveParticipant(role, ordinal, maximumRounds)),
    );
    const currencies = new Set(participants.map(({ currency }) => currency));
    if (currencies.size !== 1 || !currencies.has(input.limits.currency)) {
      throw runtimeError(
        "MULTI_AGENT_MODEL_PROFILE_INVALID",
        "All selected model pricing snapshots must use the review budget currency.",
      );
    }
    const startedAt = this.dependencies.clock.now();
    const maximumDurationMs = requireInteger(
      input.limits.maximumDurationMs,
      1_000,
      86_400_000,
      "maximumDurationMs",
    );
    const target = await this.dependencies.contextReader.resolveTargetAuthority(
      input.projectId,
      input.target,
    );
    const withoutFingerprint = {
      id: this.dependencies.ids.next(),
      projectId: input.projectId,
      idempotencyKey: this.dependencies.ids.next(),
      mode: input.mode,
      target,
      userRequest: input.userRequest,
      limits: {
        maximumRounds,
        maximumTurns: maximumRounds * participants.length,
        maximumInputTokens: input.limits.maximumInputTokens,
        maximumOutputTokens: input.limits.maximumOutputTokens,
        maximumCostMicros: input.limits.maximumCostMicros,
        maximumDurationMs,
        currency: input.limits.currency,
      },
      participants: participants.map(({ currency, ...participant }) => {
        void currency;
        return participant;
      }),
      startedAt,
      deadlineAt: new Date(Date.parse(startedAt) + maximumDurationMs).toISOString(),
    } satisfies Omit<CreateMultiAgentReviewSessionInput, "requestFingerprint">;
    const requestFingerprint = await computeMultiAgentReviewRequestFingerprint(withoutFingerprint);
    const receipt = await this.dependencies.store.createSession({
      ...withoutFingerprint,
      requestFingerprint,
    });
    return receipt.session;
  }

  public async restartReview(sessionId: string): Promise<MultiAgentReviewSession> {
    this.requireEnabled();
    const previous = await this.requireSession(sessionId);
    const startedAt = this.dependencies.clock.now();
    const withoutFingerprint = {
      id: this.dependencies.ids.next(),
      projectId: previous.projectId,
      idempotencyKey: this.dependencies.ids.next(),
      restartOfSessionId: previous.id,
      mode: previous.mode,
      target:
        previous.targetKind === "chapter"
          ? {
              kind: "chapter" as const,
              chapterId: requirePresent(previous.chapterId, "chapterId"),
              baseVersionId: requirePresent(previous.baseVersionId, "baseVersionId"),
              baseAuthorityChecksum: previous.baseAuthorityChecksum,
            }
          : {
              kind: "outline" as const,
              baseOutlineRevision: requirePresent(
                previous.baseOutlineRevision,
                "baseOutlineRevision",
              ),
              baseAuthorityChecksum: previous.baseAuthorityChecksum,
            },
      userRequest: previous.userRequest,
      attempt: previous.attempt + 1,
      limits: previous.limits,
      participants: previous.participants.map(
        ({ status, errorCode, createdAt, updatedAt, ...participant }) => {
          void status;
          void errorCode;
          void createdAt;
          void updatedAt;
          return participant;
        },
      ),
      startedAt,
      deadlineAt: new Date(Date.parse(startedAt) + previous.limits.maximumDurationMs).toISOString(),
    } satisfies Omit<CreateMultiAgentReviewSessionInput, "requestFingerprint">;
    const requestFingerprint = await computeMultiAgentReviewRequestFingerprint(withoutFingerprint);
    return (
      await this.dependencies.store.createSession({
        ...withoutFingerprint,
        requestFingerprint,
      })
    ).session;
  }

  public async runReview(
    sessionId: string,
    options: RunMultiAgentReviewOptions = {},
  ): Promise<MultiAgentReviewSession> {
    this.requireEnabled();
    if (this.activeGenerations.has(sessionId)) {
      throw runtimeError(
        "MULTI_AGENT_ALREADY_RUNNING",
        "This review already has an active local model generation.",
      );
    }
    let session = await this.requireSession(sessionId);
    while (session.status === "running") {
      if (isAbortRequested(options.signal)) {
        return this.cancelReview(session.id);
      }
      if (session.turns.length >= session.limits.maximumTurns) {
        const resumed = await this.publishFinalStoredCandidate(session);
        if (resumed !== null) {
          options.onUpdate?.(resumed);
          return resumed;
        }
        session = await this.dependencies.store.failSession(
          session.id,
          session.revision,
          "AGENT_CANDIDATE_MISSING",
          this.dependencies.clock.now(),
        );
        options.onUpdate?.(session);
        return session;
      }
      try {
        session = await this.runOneTurn(session, options);
      } catch (cause: unknown) {
        if (
          cause instanceof MultiAgentReviewRuntimeError &&
          (cause.code === "MULTI_AGENT_RESOURCE_EXHAUSTED" ||
            cause.code === "MULTI_AGENT_TARGET_STALE")
        ) {
          session = await this.dependencies.store.failSession(
            session.id,
            session.revision,
            cause.code === "MULTI_AGENT_TARGET_STALE"
              ? "AGENT_TARGET_STALE"
              : "AGENT_PREFLIGHT_RESOURCE_EXHAUSTED",
            this.dependencies.clock.now(),
          );
          options.onUpdate?.(session);
          return session;
        }
        throw cause;
      }
      options.onUpdate?.(session);
    }
    return session;
  }

  public async cancelReview(sessionId: string): Promise<MultiAgentReviewSession> {
    this.requireEnabled();
    const existing = this.cancellations.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const cancellation = this.performCancellation(sessionId);
    this.cancellations.set(sessionId, cancellation);
    try {
      return await cancellation;
    } finally {
      if (this.cancellations.get(sessionId) === cancellation) {
        this.cancellations.delete(sessionId);
      }
    }
  }

  public listHistory(projectId: string, limit = 50): Promise<readonly MultiAgentReviewSession[]> {
    return this.dependencies.store.listProjectSessions(projectId, limit);
  }

  public async recoverInterruptedReviews(): Promise<number> {
    const recovered = await this.dependencies.store.recoverInterruptedSessions(
      this.dependencies.clock.now(),
    );
    const pending = await this.dependencies.store.listPendingCandidatePublicationSessions();
    let finalized = 0;
    for (const session of pending) {
      try {
        const result = await this.publishFinalStoredCandidate(session);
        if (result !== null) {
          finalized += 1;
        }
      } catch (cause: unknown) {
        if (
          cause instanceof MultiAgentReviewStoreError &&
          (cause.code === "MULTI_AGENT_REVISION_CONFLICT" ||
            cause.code === "MULTI_AGENT_IDEMPOTENCY_CONFLICT" ||
            cause.code === "MULTI_AGENT_NOT_FOUND")
        ) {
          continue;
        }
        throw cause;
      }
    }
    return recovered + finalized;
  }

  public findReview(sessionId: string): Promise<MultiAgentReviewSession | null> {
    return this.dependencies.store.findSessionById(sessionId);
  }

  public exportHistory(session: MultiAgentReviewSession): string {
    return this.dependencies.store.exportSessionHistory(session);
  }

  public acceptOutlineCandidate(candidateId: string, expectedRevision: number) {
    this.requireEnabled();
    return this.dependencies.store.acceptOutlineCandidate(
      candidateId,
      expectedRevision,
      this.dependencies.ids.next(),
      this.dependencies.clock.now(),
    );
  }

  public rejectCandidate(candidateId: string, expectedRevision: number) {
    this.requireEnabled();
    return this.dependencies.store.rejectCandidate(
      candidateId,
      expectedRevision,
      this.dependencies.ids.next(),
      this.dependencies.clock.now(),
    );
  }

  public expireCandidate(candidateId: string, expectedRevision: number) {
    this.requireEnabled();
    return this.dependencies.store.expireCandidate(
      candidateId,
      expectedRevision,
      this.dependencies.ids.next(),
      this.dependencies.clock.now(),
    );
  }

  private async runOneTurn(
    initialSession: MultiAgentReviewSession,
    options: RunMultiAgentReviewOptions,
  ): Promise<MultiAgentReviewSession> {
    const participant = selectNextParticipant(initialSession);
    const context = await this.dependencies.contextReader.load(initialSession);
    const isFinalTurn = initialSession.turns.length + 1 >= initialSession.limits.maximumTurns;
    const messages = buildMessages(initialSession, participant.role, context, isFinalTurn);
    const reservation = planLocalMultiAgentReservation(initialSession, participant, messages);
    if (isAbortRequested(options.signal)) {
      return this.cancelReview(initialSession.id);
    }
    const turnId = this.dependencies.ids.next();
    const generationId = this.dependencies.ids.next();
    const startedAt = this.dependencies.clock.now();
    let session = await this.dependencies.store.claimTurn({
      sessionId: initialSession.id,
      expectedSessionRevision: initialSession.revision,
      turnId,
      participantId: participant.participantId,
      idempotencyKey: this.dependencies.ids.next(),
      generationId,
      reservation,
      startedAt,
    });
    options.onUpdate?.(session);
    if (isAbortRequested(options.signal)) {
      return this.cancelReview(session.id);
    }
    const abortListener = () => {
      void this.cancelReview(session.id).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });
    this.activeGenerations.set(session.id, generationId);
    let result:
      | {
          readonly response: MultiAgentPublicResponse;
          readonly serializedResponse: string;
          readonly usage: {
            readonly inputTokens: number;
            readonly outputTokens: number;
            readonly cachedInputTokens: number | null;
          };
        }
      | undefined;
    try {
      const generated = await this.dependencies.modelGateway.generate({
        generationId,
        config: {
          providerId: participant.providerId,
          provider: participant.providerKind,
          baseUrl: participant.endpointUrl,
          authentication: participant.authentication,
        },
        model: participant.modelId,
        messages,
        maxOutputTokens: reservation.maximumOutputTokens,
        temperature: participant.role === "critic" ? 0.2 : 0.5,
      });
      if (isAbortRequested(options.signal) || this.cancellations.has(session.id)) {
        session = await this.cancelReview(session.id);
        return session;
      }
      if (generated.usage === null) {
        session = isAbortRequested(options.signal)
          ? await this.cancelReview(session.id)
          : await this.failWorkingTurn(session, turnId, "failed", "MODEL_USAGE_UNAVAILABLE", null);
        return session;
      }
      try {
        const response = parseMultiAgentPublicResponse(generated.text);
        if (!isFinalTurn && response.candidate !== null) {
          session = await this.failWorkingTurn(
            session,
            turnId,
            "failed",
            "AGENT_RESPONSE_AUTHORITY_INVALID",
            generated.usage,
          );
          return session;
        }
        result = {
          response,
          serializedResponse: JSON.stringify(response),
          usage: generated.usage,
        };
      } catch {
        session = await this.failWorkingTurn(
          session,
          turnId,
          "failed",
          "AGENT_RESPONSE_SCHEMA_INVALID",
          generated.usage,
        );
        return session;
      }
    } catch (cause: unknown) {
      session =
        isAbortRequested(options.signal) || this.cancellations.has(session.id)
          ? await this.cancelReview(session.id)
          : await this.failWorkingTurn(
              session,
              turnId,
              "failed",
              normalizeProviderErrorCode(cause),
              null,
            );
      return session;
    } finally {
      this.activeGenerations.delete(session.id);
      options.signal?.removeEventListener("abort", abortListener);
    }
    const completion = {
      sessionId: session.id,
      turnId,
      expectedSessionRevision: session.revision,
      serializedResponse: result.serializedResponse,
      publicMessage: result.response.publicMessage,
      needsInput: result.response.needsInput !== null,
      usage: result.usage,
      conclusions: result.response.conclusions.map((conclusion) => ({
        id: this.dependencies.ids.next(),
        category: conclusion.category,
        title: conclusion.title,
        explanation: conclusion.explanation,
        evidence: conclusion.evidence,
        sourceReferences: conclusion.sourceReferences.map((reference) => ({
          ...reference,
          authoritativeLabel: null,
        })),
        taskProposal: conclusion.taskProposal,
      })) satisfies readonly Omit<MultiAgentReviewConclusion, "ordinal">[],
      completedAt: this.dependencies.clock.now(),
    };
    try {
      session = await this.dependencies.store.completeTurn({
        ...completion,
        resultFingerprint: await computeMultiAgentReviewCompletionFingerprint(completion),
      });
    } catch (cause: unknown) {
      if (cause instanceof MultiAgentReviewStoreError) {
        if (
          cause.code === "MULTI_AGENT_LIMIT_EXHAUSTED" ||
          cause.code === "MULTI_AGENT_USAGE_UNAVAILABLE"
        ) {
          return this.failWorkingTurn(
            session,
            turnId,
            "failed",
            "AGENT_RESOURCE_OVERRUN",
            result.usage,
          );
        }
        if (
          cause.code === "MULTI_AGENT_INVALID_INPUT" ||
          cause.code === "MULTI_AGENT_AUTHORITY_MISMATCH"
        ) {
          return this.failWorkingTurn(
            session,
            turnId,
            "failed",
            "AGENT_RESPONSE_AUTHORITY_INVALID",
            result.usage,
          );
        }
      }
      throw cause;
    }
    if (result.response.candidate === null || !isFinalTurn) {
      return session;
    }
    return this.publishCandidate(session);
  }

  private failWorkingTurn(
    session: MultiAgentReviewSession,
    turnId: string,
    outcome: "failed" | "cancelled",
    errorCode: string,
    usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens: number | null;
    } | null,
  ): Promise<MultiAgentReviewSession> {
    return this.dependencies.store.failTurn({
      sessionId: session.id,
      turnId,
      expectedSessionRevision: session.revision,
      outcome,
      errorCode,
      usage,
      completedAt: this.dependencies.clock.now(),
    });
  }

  private async performCancellation(sessionId: string): Promise<MultiAgentReviewSession> {
    const generationId = this.activeGenerations.get(sessionId);
    if (generationId !== undefined) {
      await this.dependencies.modelGateway.cancelGeneration(generationId).catch(() => false);
    }
    const session = await this.requireSession(sessionId);
    if (session.status === "cancelled") {
      return session;
    }
    return this.dependencies.store.cancelSession(
      session.id,
      session.revision,
      this.dependencies.clock.now(),
    );
  }

  private async publishFinalStoredCandidate(
    session: MultiAgentReviewSession,
  ): Promise<MultiAgentReviewSession | null> {
    const finalTurn = session.turns.at(-1);
    if (finalTurn?.status !== "completed" || finalTurn.responseJson === null) {
      return null;
    }
    const response = parseMultiAgentPublicResponse(finalTurn.responseJson);
    return response.candidate === null ? null : this.publishCandidate(session);
  }

  private async publishCandidate(
    session: MultiAgentReviewSession,
  ): Promise<MultiAgentReviewSession> {
    const finalTurn = session.turns.at(-1);
    if (
      finalTurn?.status !== "completed" ||
      finalTurn.responseJson === null ||
      finalTurn.completedAt === null
    ) {
      throw runtimeError(
        "MULTI_AGENT_TARGET_STALE",
        "Candidate publication requires the exact completed final public turn.",
      );
    }
    const persistedResponse = parseMultiAgentPublicResponse(finalTurn.responseJson);
    if (persistedResponse.candidate === null) {
      return session;
    }
    const persistedCandidate = persistedResponse.candidate;
    const payloadJson = JSON.stringify(persistedCandidate);
    const [candidateId, chapterCandidateId, auditEventId] = await Promise.all([
      deriveReviewArtifactId(session, finalTurn.id, "review-candidate"),
      persistedCandidate.kind === "chapter_content"
        ? deriveReviewArtifactId(session, finalTurn.id, "chapter-candidate")
        : Promise.resolve(null),
      deriveReviewArtifactId(session, finalTurn.id, "candidate-ready-audit"),
    ] as const);
    try {
      const candidate = await this.dependencies.store.publishCandidate({
        sessionId: session.id,
        expectedSessionRevision: session.revision,
        candidateId,
        chapterCandidateId,
        payloadJson,
        payloadChecksum: await sha256Text(payloadJson),
        chapterContentChecksum:
          persistedCandidate.kind === "chapter_content"
            ? await sha256Text(persistedCandidate.content)
            : null,
        auditEventId,
        publishedAt: finalTurn.completedAt,
      });
      return await this.requireSession(candidate.sessionId);
    } catch (cause: unknown) {
      if (
        cause instanceof MultiAgentReviewStoreError &&
        (cause.code === "MULTI_AGENT_INVALID_INPUT" ||
          cause.code === "MULTI_AGENT_AUTHORITY_MISMATCH" ||
          cause.code === "MULTI_AGENT_ILLEGAL_STATE" ||
          cause.code === "MULTI_AGENT_USAGE_UNAVAILABLE")
      ) {
        return this.dependencies.store.failSession(
          session.id,
          session.revision,
          "AGENT_CANDIDATE_PUBLICATION_FAILED",
          this.dependencies.clock.now(),
        );
      }
      throw cause;
    }
  }

  private async resolveParticipant(
    role: PersistedMultiAgentReviewRole,
    ordinal: number,
    maximumRounds: number,
  ): Promise<
    Omit<
      MultiAgentReviewParticipantSnapshot,
      "status" | "errorCode" | "createdAt" | "updatedAt"
    > & { readonly currency: string }
  > {
    const routeRole = ROUTE_ROLE_BY_AGENT_ROLE[role];
    const route = await this.dependencies.modelRouting.findRoute(routeRole);
    if (route === null) {
      throw runtimeError(
        "MULTI_AGENT_MODEL_ROUTE_MISSING",
        `No local model route is configured for ${routeRole}.`,
      );
    }
    const candidates = [
      [route.primaryProviderId, route.primaryModelId],
      ...(route.fallbackProviderId === null || route.fallbackModelId === null
        ? []
        : [[route.fallbackProviderId, route.fallbackModelId]]),
    ] as const;
    let selected: { readonly profile: ModelProfile; readonly modelId: string } | null = null;
    for (const [providerId, modelId] of candidates) {
      const profile = await this.dependencies.modelCenter.findByProviderId(providerId);
      if (profile !== null && profile.selectedModel === modelId && profile.pricing !== null) {
        selected = { profile, modelId };
        break;
      }
    }
    if (selected === null) {
      throw runtimeError(
        "MULTI_AGENT_MODEL_PROFILE_INVALID",
        `The ${routeRole} route has no usable local model and pricing snapshot.`,
      );
    }
    const pricing = requirePresent(selected.profile.pricing, "pricing");
    return Object.freeze({
      participantId: this.dependencies.ids.next(),
      ordinal,
      role,
      enabled: true,
      providerId: selected.profile.providerId,
      providerKind: selected.profile.provider,
      endpointUrl: selected.profile.baseUrl,
      authentication: selected.profile.authentication,
      providerProfileRevision: selected.profile.revision,
      modelId: selected.modelId,
      modelRevision: `${String(selected.profile.revision)}.${String(route.revision)}`,
      maximumTurns: maximumRounds,
      contextWindowTokens: pricing.contextWindowTokens,
      inputMicrosPerMillionTokens: pricing.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: pricing.outputMicrosPerMillionTokens,
      cachedInputMicrosPerMillionTokens: pricing.cachedInputMicrosPerMillionTokens,
      pricingVersion: pricing.pricingVersion,
      priceUpdatedAt: pricing.priceUpdatedAt,
      currency: pricing.currency,
    });
  }

  private async requireSession(sessionId: string): Promise<MultiAgentReviewSession> {
    const session = await this.dependencies.store.findSessionById(sessionId);
    if (session === null) {
      throw runtimeError(
        "MULTI_AGENT_TARGET_STALE",
        "The requested multi-agent review does not exist.",
      );
    }
    return session;
  }

  private requireEnabled(): void {
    if (!this.dependencies.enabled || !this.dependencies.modelGateway.available) {
      throw runtimeError(
        "MULTI_AGENT_FEATURE_DISABLED",
        "Local multi-agent review is disabled or unavailable in this runtime.",
      );
    }
  }
}

export class SqliteMultiAgentReviewContextReader implements MultiAgentReviewContextReader {
  public constructor(private readonly executor: SqlExecutor) {}

  public async resolveTargetAuthority(
    projectId: string,
    target: StartMultiAgentReviewInput["target"],
  ): Promise<CreateMultiAgentReviewSessionInput["target"]> {
    if (target.kind === "chapter") {
      const rows = await this.executor.select<{
        current_version_id: string;
        content_checksum: string;
      }>(
        `SELECT chapter.current_version_id, version.content_checksum
         FROM chapters AS chapter
         JOIN chapter_versions AS version
           ON version.id = chapter.current_version_id
          AND version.chapter_id = chapter.id
          AND version.project_id = chapter.project_id
         WHERE chapter.id = ? AND chapter.project_id = ?
           AND chapter.status = 'active'`,
        [target.chapterId, projectId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw runtimeError(
          "MULTI_AGENT_TARGET_STALE",
          "The chapter review target is missing or inactive.",
        );
      }
      return {
        kind: "chapter",
        chapterId: target.chapterId,
        baseVersionId: row.current_version_id,
        baseAuthorityChecksum: row.content_checksum,
      };
    }
    const rows = await this.executor.select<{
      revision: number;
      snapshot_json: string;
    }>(
      `SELECT revision, snapshot_json
       FROM story_outlines
       WHERE project_id = ?`,
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw runtimeError(
        "MULTI_AGENT_TARGET_STALE",
        "The project outline review target is missing.",
      );
    }
    return {
      kind: "outline",
      baseOutlineRevision: row.revision,
      baseAuthorityChecksum: await sha256Text(row.snapshot_json),
    };
  }

  public async load(session: MultiAgentReviewSession): Promise<MultiAgentReviewContext> {
    if (session.targetKind === "chapter") {
      return this.loadChapter(session);
    }
    return this.loadOutline(session);
  }

  private async loadChapter(session: MultiAgentReviewSession): Promise<MultiAgentReviewContext> {
    const rows = await this.executor.select<{
      chapter_id: string;
      title: string;
      content: string;
      current_version_id: string;
      sequence: number;
      content_checksum: string;
    }>(
      `SELECT
         chapter.id AS chapter_id, chapter.title, chapter.content,
         chapter.current_version_id, version.sequence, version.content_checksum
       FROM chapters AS chapter
       JOIN chapter_versions AS version
         ON version.id = chapter.current_version_id
        AND version.chapter_id = chapter.id
        AND version.project_id = chapter.project_id
       WHERE chapter.id = ? AND chapter.project_id = ?
         AND chapter.status = 'active'`,
      [session.chapterId, session.projectId],
    );
    const row = rows[0];
    if (
      row?.current_version_id !== session.baseVersionId ||
      row.content_checksum !== session.baseAuthorityChecksum
    ) {
      throw runtimeError(
        "MULTI_AGENT_TARGET_STALE",
        "The chapter changed after this review baseline was captured.",
      );
    }
    requireSafeAuthorityText(row.title);
    requireSafeAuthorityText(row.content);
    const receipt = {
      kind: "chapter",
      sourceId: row.chapter_id,
      sourceRevision: row.sequence,
      sourceVersionId: row.current_version_id,
      sourceChecksum: row.content_checksum,
      authoritativeLabel: row.title,
    };
    return Object.freeze({
      authorityJson: JSON.stringify({
        target: "chapter",
        title: row.title,
        content: row.content,
      }),
      citationReceiptsJson: JSON.stringify([receipt]),
    });
  }

  private async loadOutline(session: MultiAgentReviewSession): Promise<MultiAgentReviewContext> {
    const rows = await this.executor.select<{
      revision: number;
      snapshot_json: string;
    }>(
      `SELECT revision, snapshot_json
       FROM story_outlines
       WHERE project_id = ?`,
      [session.projectId],
    );
    const row = rows[0];
    if (
      row?.revision !== session.baseOutlineRevision ||
      (await sha256Text(row.snapshot_json)) !== session.baseAuthorityChecksum
    ) {
      throw runtimeError(
        "MULTI_AGENT_TARGET_STALE",
        "The outline changed after this review baseline was captured.",
      );
    }
    if (row.snapshot_json.length > 5_000_000) {
      throw runtimeError(
        "MULTI_AGENT_RESOURCE_EXHAUSTED",
        "The full outline snapshot exceeds the bounded local authority window.",
      );
    }
    const snapshot = parseObjectJson(row.snapshot_json, "outline");
    if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length > 2_000) {
      throw runtimeError(
        "MULTI_AGENT_RESOURCE_EXHAUSTED",
        "The full outline exceeds the bounded local multi-agent authority window.",
      );
    }
    const nodes = snapshot.nodes;
    const receipts = await Promise.all(
      nodes.map(async (node) => {
        if (
          typeof node !== "object" ||
          node === null ||
          Array.isArray(node) ||
          typeof (node as Record<string, unknown>).id !== "string" ||
          !PORTABLE_IDENTIFIER_PATTERN.test((node as Record<string, unknown>).id as string) ||
          !Number.isSafeInteger((node as Record<string, unknown>).revision) ||
          ((node as Record<string, unknown>).revision as number) < 1
        ) {
          throw runtimeError(
            "MULTI_AGENT_TARGET_STALE",
            "The outline contains an invalid source node.",
          );
        }
        const record = node as Record<string, unknown>;
        return {
          kind: "outline_node",
          sourceId: record.id,
          sourceRevision: record.revision,
          sourceVersionId: null,
          sourceChecksum: await sha256Text(stableJson(record)),
          authoritativeLabel:
            typeof record.title === "string" &&
            record.title.length >= 1 &&
            record.title.length <= 240
              ? record.title
              : String(record.id),
        };
      }),
    );
    return Object.freeze({
      authorityJson: JSON.stringify({
        target: "outline",
        projectId: session.projectId,
        revision: row.revision,
        nodes,
        truncated: false,
      }),
      citationReceiptsJson: JSON.stringify(receipts),
    });
  }
}

function buildMessages(
  session: MultiAgentReviewSession,
  role: PersistedMultiAgentReviewRole,
  context: MultiAgentReviewContext,
  isFinalTurn: boolean,
) {
  const priorPublicTurns = session.turns
    .filter(({ responseJson }) => responseJson !== null)
    .map((turn) => ({
      sequence: turn.sequence,
      participantId: turn.participantId,
      resultFingerprint: turn.resultFingerprint,
      publicResponse: JSON.parse(requirePresent(turn.responseJson, "responseJson")) as unknown,
    }));
  return [
    {
      role: "system" as const,
      content: [
        "You are one participant in a bounded InkShadow local multi-agent review.",
        "Return exactly one JSON object, with no Markdown, preface, suffix, hidden reasoning, or extra fields.",
        "Schema: {schemaVersion:1,publicMessage:string,conclusions:[{category:'must_change'|'suggested_change'|'optional_enhancement'|'disputed_opinion'|'convertible_task',title:string,explanation:string,evidence:string[],sourceReferences:[{kind:'chapter'|'outline_node'|'material'|'project_rule'|'turn',sourceId:string,sourceRevision:integer,sourceVersionId:string|null,sourceChecksum:lowercase_sha256,modelLabel:string,excerpt:string|null}],taskProposal:{title:string,description:string,priority:'p0'|'p1'|'p2'|'p3'}|null}],candidate:{kind:'chapter_content',content:string}|{kind:'outline_patch',changes:[{nodeId:string,expectedNodeRevision:integer,title:string|null,synopsis:string|null}]}|null,needsInput:{question:string}|null}.",
        "Use only citation authority receipts supplied by the user; copy their source authority fields exactly. modelLabel is your public label, not authority.",
        "Never reveal chain-of-thought. Put only concise public conclusions and evidence in the response.",
        isFinalTurn
          ? "This is the final scheduled turn. Produce a candidate unless genuinely blocked; if blocked set candidate null and needsInput."
          : "This is not the final scheduled turn. Set candidate to null.",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        reviewMode: session.mode,
        participantRole: role,
        userRequest: session.userRequest,
        targetKind: session.targetKind,
        targetAuthority: JSON.parse(context.authorityJson) as unknown,
        allowedCitationReceipts: JSON.parse(context.citationReceiptsJson) as unknown,
        priorPublicTurns,
      }),
    },
  ];
}

function selectNextParticipant(
  session: MultiAgentReviewSession,
): MultiAgentReviewParticipantSnapshot {
  const enabled = session.participants.filter(({ enabled }) => enabled);
  const participant = enabled[session.turns.length % enabled.length];
  if (participant === undefined) {
    throw runtimeError(
      "MULTI_AGENT_RESOURCE_EXHAUSTED",
      "No enabled participant remains for this review.",
    );
  }
  return participant;
}

export function planLocalMultiAgentReservation(
  session: MultiAgentReviewSession,
  participant: MultiAgentReviewParticipantSnapshot,
  messages: readonly { readonly role: string; readonly content: string }[],
) {
  const usage = session.turns.reduce(
    (total, turn) => ({
      inputTokens: total.inputTokens + (turn.inputTokens ?? 0),
      outputTokens: total.outputTokens + (turn.outputTokens ?? 0),
      costMicros: total.costMicros + (turn.costMicros ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costMicros: 0 },
  );
  const remainingInput = session.limits.maximumInputTokens - usage.inputTokens;
  const remainingOutput = session.limits.maximumOutputTokens - usage.outputTokens;
  const remainingCost = session.limits.maximumCostMicros - usage.costMicros;
  const estimatedInputTokens = estimateLocalMultiAgentInputTokens(messages);
  const maximumContextOutput = participant.contextWindowTokens - estimatedInputTokens;
  const inputCostMicros = calculateReservationCostMicros(
    estimatedInputTokens,
    participant.inputMicrosPerMillionTokens,
  );
  const outputBudgetMicros = remainingCost - inputCostMicros;
  const affordableOutputTokens =
    participant.outputMicrosPerMillionTokens === 0
      ? Number.MAX_SAFE_INTEGER
      : Number(
          (BigInt(Math.max(0, outputBudgetMicros)) * 1_000_000n) /
            BigInt(participant.outputMicrosPerMillionTokens),
        );
  const maximumOutputTokens = Math.min(
    remainingOutput,
    4_096,
    maximumContextOutput,
    affordableOutputTokens,
  );
  const minimumOutputTokens = 256;
  if (
    estimatedInputTokens < 1 ||
    estimatedInputTokens > remainingInput ||
    estimatedInputTokens > 10_000_000 ||
    maximumOutputTokens < minimumOutputTokens ||
    outputBudgetMicros < 0
  ) {
    throw runtimeError(
      "MULTI_AGENT_RESOURCE_EXHAUSTED",
      "The next public turn cannot be funded within its token, context, and cost limits.",
    );
  }
  const maximumCostMicros =
    inputCostMicros +
    calculateReservationCostMicros(maximumOutputTokens, participant.outputMicrosPerMillionTokens);
  if (maximumCostMicros > remainingCost) {
    throw runtimeError(
      "MULTI_AGENT_RESOURCE_EXHAUSTED",
      "The next public turn exceeds the remaining authoritative cost budget.",
    );
  }
  return Object.freeze({
    maximumInputTokens: estimatedInputTokens,
    maximumOutputTokens,
    maximumCostMicros,
  });
}

export function estimateLocalMultiAgentInputTokens(
  messages: readonly { readonly role: string; readonly content: string }[],
): number {
  const encodedBytes = messages.reduce(
    (total, message) =>
      total +
      new TextEncoder().encode(message.role).byteLength +
      new TextEncoder().encode(message.content).byteLength,
    0,
  );
  return encodedBytes + 1_024 + messages.length * 64;
}

function calculateReservationCostMicros(tokens: number, rate: number): number {
  const numerator = BigInt(tokens) * BigInt(rate);
  return Number(numerator === 0n ? 0n : (numerator + 999_999n) / 1_000_000n);
}

function validateRoles(
  roles: readonly PersistedMultiAgentReviewRole[],
): readonly PersistedMultiAgentReviewRole[] {
  if (roles.length < 1 || roles.length > MULTI_AGENT_LOCAL_ROLES.length) {
    throw runtimeError(
      "MULTI_AGENT_MODEL_PROFILE_INVALID",
      "Select between one and five local review roles.",
    );
  }
  const unique = new Set(roles);
  if (
    unique.size !== roles.length ||
    roles.some((role) => !MULTI_AGENT_LOCAL_ROLES.includes(role))
  ) {
    throw runtimeError(
      "MULTI_AGENT_MODEL_PROFILE_INVALID",
      "Local review roles are invalid or duplicated.",
    );
  }
  return Object.freeze([...roles]);
}

function normalizeProviderErrorCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,127}$/u.test(cause.code)
  ) {
    return cause.code;
  }
  return "MODEL_PROVIDER_FAILURE";
}

function parseObjectJson(value: string, field: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw runtimeError("MULTI_AGENT_TARGET_STALE", `The ${field} source snapshot is invalid.`);
  }
}

function stableJson(
  value: unknown,
  depth = 0,
  budget: { visited: number } = { visited: 0 },
): string {
  budget.visited += 1;
  if (depth > 20 || budget.visited > 20_000) {
    throw runtimeError(
      "MULTI_AGENT_RESOURCE_EXHAUSTED",
      "An outline source node exceeds the bounded authority graph.",
    );
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    requireSafeAuthorityText(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw runtimeError(
        "MULTI_AGENT_TARGET_STALE",
        "An outline source node contains a non-finite number.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry, depth + 1, budget)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw runtimeError("MULTI_AGENT_TARGET_STALE", "A source authority contains unsupported data.");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw runtimeError(
          "MULTI_AGENT_TARGET_STALE",
          "An outline source node contains a prohibited object key.",
        );
      }
      requireSafeAuthorityText(key);
      return `${JSON.stringify(key)}:${stableJson(record[key], depth + 1, budget)}`;
    })
    .join(",")}}`;
}

function requireSafeAuthorityText(value: string): void {
  if (
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value) ||
    /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(value)
  ) {
    throw runtimeError(
      "MULTI_AGENT_TARGET_STALE",
      "An outline source node contains unsafe Unicode controls.",
    );
  }
}

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveReviewArtifactId(
  session: MultiAgentReviewSession,
  finalTurnId: string,
  purpose: "review-candidate" | "chapter-candidate" | "candidate-ready-audit",
): Promise<string> {
  const timestamp = Date.parse(session.startedAt);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffff_ffff_ffff) {
    throw runtimeError(
      "MULTI_AGENT_TARGET_STALE",
      "The review start timestamp cannot derive a stable publication receipt.",
    );
  }
  const timeHex = timestamp.toString(16).padStart(12, "0");
  const entropy = await sha256Text(
    `inkshadow.multi-agent.v1:${session.id}:${finalTurnId}:${purpose}`,
  );
  return [
    timeHex.slice(0, 8),
    timeHex.slice(8, 12),
    `7${entropy.slice(0, 3)}`,
    `8${entropy.slice(3, 6)}`,
    entropy.slice(6, 18),
  ].join("-");
}

function requireInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw runtimeError(
      "MULTI_AGENT_RESOURCE_EXHAUSTED",
      `${field} is outside its supported boundary.`,
    );
  }
  return value;
}

function requirePresent<Value>(value: Value | null | undefined, field: string): Value {
  if (value === null || value === undefined) {
    throw runtimeError("MULTI_AGENT_TARGET_STALE", `The ${field} authority is missing.`);
  }
  return value;
}

function runtimeError(
  code: MultiAgentReviewRuntimeErrorCode,
  message: string,
): MultiAgentReviewRuntimeError {
  return new MultiAgentReviewRuntimeError(code, message);
}

export function isLocalMultiAgentTargetKind(value: string): value is MultiAgentReviewTargetKind {
  return value === "chapter" || value === "outline";
}
