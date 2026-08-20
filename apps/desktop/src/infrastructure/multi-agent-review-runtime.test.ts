import { describe, expect, it, vi } from "vitest";
import {
  MultiAgentReviewSqliteStore,
  MultiAgentReviewStoreError,
  type MultiAgentReviewSession,
  type SqlExecutor,
} from "@inkshadow/data";
import {
  parseIsoUtcTimestamp,
  parseUuidV7,
  type Clock,
  type UuidV7Generator,
} from "@inkshadow/domain";

import {
  MultiAgentReviewRuntime,
  SqliteMultiAgentReviewContextReader,
  type MultiAgentReviewContext,
  type MultiAgentReviewContextReader,
} from "./multi-agent-review-runtime";
import type { ModelCenterStore, ModelProfile } from "./model-center-store";
import type { ModelRoutingStore } from "./model-routing-store";
import type { ProjectContextPrivacyAuthority } from "./project-context-privacy-authority";
import type { NativeModelGatewayClient, NativeModelGenerationResult } from "./runtime";
import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";

describe("local multi-agent review runtime", () => {
  it("loads every bounded outline node instead of silently truncating authority", async () => {
    const nodes = Array.from({ length: 501 }, (_unused, index) => ({
      id: `node-${String(index + 1)}`,
      revision: 1,
      title: `Node ${String(index + 1)}`,
      synopsis: `Synopsis ${String(index + 1)}`,
    }));
    const snapshotJson = JSON.stringify({ nodes });
    const session = reviewSession({
      baseAuthorityChecksum: await sha256(snapshotJson),
    });
    const executor = await outlineExecutor(snapshotJson);
    const reader = new SqliteMultiAgentReviewContextReader(executor);

    try {
      const context = await reader.load(session);
      const authority = parseOutlineAuthority(context.authorityJson);
      expect(authority.nodes).toHaveLength(501);
      expect(authority.truncated).toBe(false);
      expect(JSON.parse(context.citationReceiptsJson)).toHaveLength(501);
    } finally {
      await executor.close();
    }
  });

  it("fails closed when the full outline exceeds its explicit node bound", async () => {
    const snapshotJson = JSON.stringify({
      nodes: Array.from({ length: 2_001 }, (_unused, index) => ({
        id: `node-${String(index + 1)}`,
        revision: 1,
      })),
    });
    const session = reviewSession({
      baseAuthorityChecksum: await sha256(snapshotJson),
    });
    const executor = await outlineExecutor(snapshotJson);

    try {
      await expect(
        new SqliteMultiAgentReviewContextReader(executor).load(session),
      ).rejects.toMatchObject({
        code: "MULTI_AGENT_RESOURCE_EXHAUSTED",
      });
    } finally {
      await executor.close();
    }
  });

  it("fails before claim or provider dispatch when the full context exceeds authority", async () => {
    const initial = reviewSession();
    const failed = reviewSession({
      status: "failed",
      revision: 2,
      failureCode: "AGENT_PREFLIGHT_RESOURCE_EXHAUSTED",
      completedAt: NOW,
    });
    const store = fakeStore({
      findSessionById: vi.fn(() => Promise.resolve(initial)),
      failSession: vi.fn(() => Promise.resolve(failed)),
    });
    const gateway = fakeGateway();
    const runtime = createRuntime(store, gateway, {
      authorityJson: JSON.stringify({ content: "x".repeat(20_000) }),
      citationReceiptsJson: "[]",
    });

    await expect(runtime.runReview(initial.id)).resolves.toMatchObject({
      status: "failed",
      failureCode: "AGENT_PREFLIGHT_RESOURCE_EXHAUSTED",
    });
    expect(store.claimTurn).not.toHaveBeenCalled();
    expect(gateway.generate).not.toHaveBeenCalled();
    expect(store.failSession).toHaveBeenCalledWith(
      initial.id,
      initial.revision,
      "AGENT_PREFLIGHT_RESOURCE_EXHAUSTED",
      NOW,
    );
  });

  it("blocks a local-only chapter before a remote review participant is claimed", async () => {
    const initial = reviewSession({
      targetKind: "chapter",
      chapterId: "chapter-1",
      baseVersionId: "version-1",
      baseOutlineRevision: null,
    });
    const store = fakeStore({
      findSessionById: vi.fn(() => Promise.resolve(initial)),
    });
    const gateway = fakeGateway();
    const runtime = createRuntime(store, gateway, {
      authorityJson: JSON.stringify({ content: "private chapter text" }),
      citationReceiptsJson: "[]",
      localOnly: true,
    });

    await expect(runtime.runReview(initial.id)).rejects.toMatchObject({
      code: "PRIVATE_CHAPTER_LOCAL_ONLY",
    });
    expect(store.claimTurn).not.toHaveBeenCalled();
    expect(gateway.generate).not.toHaveBeenCalled();
  });

  it("does not dispatch when the participant profile changes during the final privacy check", async () => {
    const initial = reviewSession();
    const working = withWorkingTurn(initial);
    const failed = reviewSession({
      ...working,
      status: "failed",
      revision: 3,
      failureCode: "MULTI_AGENT_MODEL_PROFILE_INVALID",
      completedAt: NOW,
      participants: working.participants.map((participant) => ({
        ...participant,
        status: "error",
        errorCode: "MULTI_AGENT_MODEL_PROFILE_INVALID",
      })),
      turns: working.turns.map((turn) => ({
        ...turn,
        status: "failed",
        usageSource: "provider_unavailable",
        errorCode: "MULTI_AGENT_MODEL_PROFILE_INVALID",
        completedAt: NOW,
        updatedAt: NOW,
      })),
    });
    const store = fakeStore({
      findSessionById: vi.fn(() => Promise.resolve(initial)),
      claimTurn: vi.fn(() => Promise.resolve(working)),
      failTurn: vi.fn(() => Promise.resolve(failed)),
    });
    const gateway = fakeGateway();
    let profileRevision = 1;
    const privacy = standardPrivacyAuthority();
    const runtime = createRuntime(store, gateway, undefined, {
      modelCenter: fakeModelCenter(() => profileRevision),
      projectContextPrivacy: {
        ...privacy,
        assertCurrentBeforeDispatch: () => {
          profileRevision = 2;
          return Promise.resolve();
        },
      },
    });

    await expect(runtime.runReview(initial.id)).resolves.toMatchObject({
      status: "failed",
      failureCode: "MULTI_AGENT_MODEL_PROFILE_INVALID",
    });
    expect(gateway.generate).not.toHaveBeenCalled();
    expect(store.failTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "MULTI_AGENT_MODEL_PROFILE_INVALID",
      }),
    );
  });

  it("keeps repository and CAS failures recoverable instead of rewriting them as model errors", async () => {
    const initial = reviewSession();
    const conflict = new MultiAgentReviewStoreError(
      "MULTI_AGENT_REVISION_CONFLICT",
      "changed",
      true,
    );
    const store = fakeStore({
      findSessionById: vi.fn(() => Promise.resolve(initial)),
      claimTurn: vi.fn(() => Promise.reject(conflict)),
    });
    const gateway = fakeGateway();
    const runtime = createRuntime(store, gateway);

    await expect(runtime.runReview(initial.id)).rejects.toBe(conflict);
    expect(store.failSession).not.toHaveBeenCalled();
    expect(store.failTurn).not.toHaveBeenCalled();
    expect(gateway.generate).not.toHaveBeenCalled();
  });

  it("leaves a completed final turn recoverable when candidate publication has a transient conflict", async () => {
    const completed = withCompletedCandidateTurn(reviewSession());
    const exactPayloadJson = JSON.stringify(
      parseStoredCandidate(firstTurn(completed).responseJson),
    );
    const stableCandidateId = await expectedArtifactId(
      completed,
      completed.turns[0]?.id ?? "",
      "review-candidate",
    );
    const ready = reviewSession({
      ...completed,
      status: "candidate_ready",
      revision: 4,
      completedAt: NOW,
      participants: completed.participants.map((participant) => ({
        ...participant,
        status: "done",
      })),
      candidate: {
        id: stableCandidateId,
        sessionId: completed.id,
        projectId: completed.projectId,
        targetKind: "outline",
        chapterCandidateId: null,
        baseVersionId: null,
        baseOutlineRevision: completed.baseOutlineRevision,
        payloadJson: exactPayloadJson,
        payloadChecksum: await sha256(exactPayloadJson),
        status: "ready",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        decidedAt: null,
        acceptedOutlineSnapshotJson: null,
        acceptedOutlineRevision: null,
      },
    });
    const conflict = new MultiAgentReviewStoreError(
      "MULTI_AGENT_REVISION_CONFLICT",
      "candidate publication raced",
      true,
    );
    const findSessionById = vi
      .fn()
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(ready);
    const publishCandidate = vi
      .fn<MultiAgentReviewSqliteStore["publishCandidate"]>()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(requireCandidate(ready));
    const store = fakeStore({ findSessionById, publishCandidate });
    const gateway = fakeGateway();
    const runtime = createRuntime(store, gateway);

    await expect(runtime.runReview(completed.id)).rejects.toBe(conflict);
    expect(store.failSession).not.toHaveBeenCalled();
    expect(completed.status).toBe("running");
    expect(completed.turns[0]?.status).toBe("completed");

    await expect(runtime.runReview(completed.id)).resolves.toBe(ready);
    expect(publishCandidate).toHaveBeenCalledTimes(2);
    const firstPublication = publishCandidate.mock.calls[0]?.[0];
    const retriedPublication = publishCandidate.mock.calls[1]?.[0];
    expect(retriedPublication).toEqual(firstPublication);
    expect(firstPublication).toMatchObject({
      candidateId: stableCandidateId,
      payloadJson: exactPayloadJson,
      publishedAt: completed.turns[0]?.completedAt,
    });
    expect(firstPublication?.auditEventId).toEqual(expect.any(String));
    expect(gateway.generate).not.toHaveBeenCalled();
  });

  it("finalizes a persisted final candidate during startup recovery without another model call", async () => {
    const completed = withCompletedCandidateTurn(reviewSession());
    const payloadJson = JSON.stringify(parseStoredCandidate(firstTurn(completed).responseJson));
    const ready = reviewSession({
      ...completed,
      status: "candidate_ready",
      revision: 4,
      completedAt: NOW,
      candidate: {
        id: await expectedArtifactId(completed, completed.turns[0]?.id ?? "", "review-candidate"),
        sessionId: completed.id,
        projectId: completed.projectId,
        targetKind: "outline",
        chapterCandidateId: null,
        baseVersionId: null,
        baseOutlineRevision: completed.baseOutlineRevision,
        payloadJson,
        payloadChecksum: await sha256(payloadJson),
        status: "ready",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        decidedAt: null,
        acceptedOutlineSnapshotJson: null,
        acceptedOutlineRevision: null,
      },
    });
    const readyCandidate = ready.candidate;
    if (readyCandidate === null) {
      throw new Error("Expected a startup-recovery candidate receipt.");
    }
    const store = fakeStore({
      recoverInterruptedSessions: vi.fn(() => Promise.resolve(0)),
      listPendingCandidatePublicationSessions: vi.fn(() => Promise.resolve([completed])),
      publishCandidate: vi.fn(() => Promise.resolve(readyCandidate)),
      findSessionById: vi.fn(() => Promise.resolve(ready)),
    });
    const gateway = fakeGateway();
    const runtime = createRuntime(store, gateway);

    await expect(runtime.recoverInterruptedReviews()).resolves.toBe(1);
    expect(store.publishCandidate).toHaveBeenCalledTimes(1);
    expect(gateway.generate).not.toHaveBeenCalled();
  });

  it("records provider-reported overage unchanged as a terminal resource failure", async () => {
    const initial = reviewSession();
    const working = withWorkingTurn(initial);
    const failed = reviewSession({
      status: "failed",
      revision: 3,
      failureCode: "AGENT_RESOURCE_OVERRUN",
      completedAt: NOW,
      participants: working.participants.map((participant) => ({
        ...participant,
        status: "error",
        errorCode: "AGENT_RESOURCE_OVERRUN",
      })),
      turns: [
        {
          ...firstTurn(working),
          status: "failed",
          usageSource: "provider_reported",
          inputTokens: 100_000,
          outputTokens: 8_000,
          cachedInputTokens: null,
          costMicros: 108,
          errorCode: "AGENT_RESOURCE_OVERRUN",
          completedAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    const usage = {
      inputTokens: 100_000,
      outputTokens: 8_000,
      cachedInputTokens: null,
    };
    const store = fakeStore({
      findSessionById: vi.fn(() => Promise.resolve(initial)),
      claimTurn: vi.fn(() => Promise.resolve(working)),
      completeTurn: vi.fn(() =>
        Promise.reject(
          new MultiAgentReviewStoreError("MULTI_AGENT_LIMIT_EXHAUSTED", "over reservation"),
        ),
      ),
      failTurn: vi.fn(() => Promise.resolve(failed)),
    });
    const gateway = fakeGateway({
      generate: vi.fn(() =>
        Promise.resolve({
          text: JSON.stringify({
            schemaVersion: 1,
            publicMessage: "Public result",
            conclusions: [],
            candidate: null,
            needsInput: null,
          }),
          usage,
        }),
      ),
    });
    const runtime = createRuntime(store, gateway);

    await expect(runtime.runReview(initial.id)).resolves.toMatchObject({
      status: "failed",
      turns: [
        {
          usageSource: "provider_reported",
          inputTokens: 100_000,
          outputTokens: 8_000,
        },
      ],
    });
    expect(store.failTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "AGENT_RESOURCE_OVERRUN",
        usage,
      }),
    );
    const dispatched = gateway.generate.mock.calls[0]?.[0];
    expect(dispatched?.config.retryLimit).toBe(0);
    expect(dispatched?.reasoningMode).toBe("disabled");
    expect(dispatched).not.toHaveProperty("responseFormat");
  });

  it("rejects an early candidate instead of persisting it before the final turn", async () => {
    const base = reviewSession();
    const initial = reviewSession({
      limits: {
        ...base.limits,
        maximumRounds: 2,
        maximumTurns: 2,
      },
      participants: base.participants.map((participant) => ({
        ...participant,
        maximumTurns: 2,
      })),
    });
    const working = withWorkingTurn(initial);
    const failed = reviewSession({
      ...working,
      status: "failed",
      revision: 3,
      failureCode: "AGENT_RESPONSE_AUTHORITY_INVALID",
      completedAt: NOW,
      participants: working.participants.map((participant) => ({
        ...participant,
        status: "error",
        errorCode: "AGENT_RESPONSE_AUTHORITY_INVALID",
      })),
      turns: working.turns.map((turn) => ({
        ...turn,
        status: "failed",
        resultFingerprint: "e".repeat(64),
        usageSource: "provider_reported",
        inputTokens: 300,
        outputTokens: 100,
        cachedInputTokens: null,
        costMicros: 2,
        errorCode: "AGENT_RESPONSE_AUTHORITY_INVALID",
        completedAt: NOW,
        updatedAt: NOW,
      })),
    });
    const usage = {
      inputTokens: 300,
      outputTokens: 100,
      cachedInputTokens: null,
    };
    const store = fakeStore({
      findSessionById: vi.fn(() => Promise.resolve(initial)),
      claimTurn: vi.fn(() => Promise.resolve(working)),
      failTurn: vi.fn(() => Promise.resolve(failed)),
    });
    const gateway = fakeGateway({
      generate: vi.fn(() =>
        Promise.resolve({
          text: JSON.stringify({
            schemaVersion: 1,
            publicMessage: "Too-early candidate",
            conclusions: [],
            candidate: {
              kind: "outline_patch",
              changes: [
                {
                  nodeId: "node-1",
                  expectedNodeRevision: 1,
                  title: "Early",
                  synopsis: null,
                },
              ],
            },
            needsInput: null,
          }),
          usage,
        }),
      ),
    });
    const runtime = createRuntime(store, gateway);

    await expect(runtime.runReview(initial.id)).resolves.toMatchObject({
      status: "failed",
      failureCode: "AGENT_RESPONSE_AUTHORITY_INVALID",
    });
    expect(store.completeTurn).not.toHaveBeenCalled();
    expect(store.publishCandidate).not.toHaveBeenCalled();
    expect(store.failTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "AGENT_RESPONSE_AUTHORITY_INVALID",
        usage,
      }),
    );
  });

  it("deduplicates concurrent abort and stop cancellation into one persisted decision", async () => {
    const initial = reviewSession();
    const working = withWorkingTurn(initial);
    const cancelled = reviewSession({
      status: "cancelled",
      revision: 3,
      completedAt: NOW,
      cancellationRequested: true,
      participants: working.participants.map((participant) => ({
        ...participant,
        status: "cancelled",
      })),
      turns: [
        {
          ...firstTurn(working),
          status: "cancelled",
          usageSource: "provider_unavailable",
          errorCode: "AGENT_CANCELLED",
          completedAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    let rejectGeneration: ((cause: unknown) => void) | null = null;
    const gateway = fakeGateway({
      generate: vi.fn(
        () =>
          new Promise<NativeModelGenerationResult>((_resolve, reject) => {
            rejectGeneration = reject;
          }),
      ),
      cancelGeneration: vi.fn(() => {
        rejectGeneration?.(new Error("cancelled"));
        return Promise.resolve(true);
      }),
    });
    const findSessionById = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(working);
    let resolvePersistedCancellation: (session: MultiAgentReviewSession) => void = () => {
      throw new Error("Cancellation persistence was not initialized.");
    };
    const persistedCancellation = new Promise<MultiAgentReviewSession>((resolve) => {
      resolvePersistedCancellation = resolve;
    });
    const store = fakeStore({
      findSessionById,
      claimTurn: vi.fn(() => Promise.resolve(working)),
      cancelSession: vi.fn(() => persistedCancellation),
    });
    const runtime = createRuntime(store, gateway);
    const controller = new AbortController();
    const run = runtime.runReview(initial.id, { signal: controller.signal });
    await vi.waitFor(() => expect(gateway.generate).toHaveBeenCalledTimes(1));

    controller.abort();
    await vi.waitFor(() => expect(gateway.cancelGeneration).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.cancelSession).toHaveBeenCalledTimes(1));
    const first = runtime.cancelReview(initial.id);
    const second = runtime.cancelReview(initial.id);
    resolvePersistedCancellation(cancelled);
    await expect(Promise.all([first, second, run])).resolves.toEqual([
      cancelled,
      cancelled,
      cancelled,
    ]);
    expect(gateway.cancelGeneration).toHaveBeenCalledTimes(1);
    expect(store.cancelSession).toHaveBeenCalledTimes(1);
  });
});

const NOW = requireTimestamp("2026-07-28T08:00:00.000Z");
const TEST_CLOCK = {
  now: () => NOW,
} satisfies Clock;

function reviewSession(override: Partial<MultiAgentReviewSession> = {}): MultiAgentReviewSession {
  return {
    id: "review-1",
    projectId: "project-1",
    idempotencyKey: "request-1",
    requestFingerprint: "a".repeat(64),
    restartOfSessionId: null,
    mode: "outline_review",
    targetKind: "outline",
    chapterId: null,
    baseVersionId: null,
    baseOutlineRevision: 1,
    baseAuthorityChecksum: "b".repeat(64),
    userRequest: "Review the outline",
    status: "running",
    revision: 1,
    attempt: 1,
    limits: {
      maximumRounds: 1,
      maximumTurns: 1,
      maximumInputTokens: 120_000,
      maximumOutputTokens: 32_000,
      maximumCostMicros: 10_000_000,
      maximumDurationMs: 900_000,
      currency: "USD",
    },
    cancellationRequested: false,
    failureCode: null,
    startedAt: NOW,
    deadlineAt: "2026-07-28T08:15:00.000Z",
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    participants: [
      {
        participantId: "participant-1",
        ordinal: 0,
        role: "critic",
        enabled: true,
        status: "idle",
        providerId: "provider-1",
        providerKind: "open_ai_compatible",
        endpointUrl: "https://models.example/v1",
        authentication: "bearer_keyring",
        providerProfileRevision: 1,
        modelId: "review-model",
        modelRevision: "1.1",
        maximumTurns: 1,
        contextWindowTokens: 8_192,
        inputMicrosPerMillionTokens: 1_000,
        outputMicrosPerMillionTokens: 1_000,
        cachedInputMicrosPerMillionTokens: null,
        pricingVersion: "price-1",
        priceUpdatedAt: NOW,
        errorCode: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    turns: [],
    candidate: null,
    ...override,
  };
}

function withWorkingTurn(session: MultiAgentReviewSession): MultiAgentReviewSession {
  return {
    ...session,
    revision: 2,
    participants: session.participants.map((participant) => ({
      ...participant,
      status: "working",
    })),
    turns: [
      {
        id: "turn-1",
        sequence: 1,
        attempt: 1,
        participantId: "participant-1",
        idempotencyKey: "turn-request-1",
        resultFingerprint: null,
        generationId: "generation-1",
        runRevisionBefore: 1,
        status: "working",
        reservation: {
          maximumInputTokens: 4_000,
          maximumOutputTokens: 1_000,
          maximumCostMicros: 5,
        },
        publicMessage: null,
        responseJson: null,
        usageSource: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        costMicros: null,
        errorCode: null,
        startedAt: NOW,
        completedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        conclusions: [],
      },
    ],
  };
}

function withCompletedCandidateTurn(session: MultiAgentReviewSession): MultiAgentReviewSession {
  const working = withWorkingTurn(session);
  return {
    ...working,
    revision: working.revision + 1,
    participants: working.participants.map((participant) => ({
      ...participant,
      status: "done",
    })),
    turns: working.turns.map((turn) => ({
      ...turn,
      resultFingerprint: "c".repeat(64),
      status: "completed",
      publicMessage: "Final public result",
      responseJson: JSON.stringify({
        schemaVersion: 1,
        publicMessage: "Final public result",
        conclusions: [],
        candidate: {
          kind: "outline_patch",
          changes: [
            {
              nodeId: "node-1",
              expectedNodeRevision: 1,
              title: "Revised title",
              synopsis: null,
            },
          ],
        },
        needsInput: null,
      }),
      usageSource: "provider_reported",
      inputTokens: 2_000,
      outputTokens: 300,
      cachedInputTokens: null,
      costMicros: 3,
      completedAt: NOW,
      updatedAt: NOW,
    })),
  };
}

type MultiAgentReviewStoreOverrides = Partial<
  Pick<
    MultiAgentReviewSqliteStore,
    | "findSessionById"
    | "listProjectSessions"
    | "createSession"
    | "claimTurn"
    | "completeTurn"
    | "failTurn"
    | "failSession"
    | "cancelSession"
    | "publishCandidate"
    | "recoverInterruptedSessions"
    | "listPendingCandidatePublicationSessions"
    | "exportSessionHistory"
    | "acceptOutlineCandidate"
    | "rejectCandidate"
    | "expireCandidate"
  >
>;

function fakeStore(override: MultiAgentReviewStoreOverrides = {}) {
  const store = new MultiAgentReviewSqliteStore(new RejectingSqlExecutor(), TEST_CLOCK);
  const spies = {
    findSessionById: vi.spyOn(store, "findSessionById"),
    listProjectSessions: vi.spyOn(store, "listProjectSessions"),
    createSession: vi.spyOn(store, "createSession"),
    claimTurn: vi.spyOn(store, "claimTurn"),
    completeTurn: vi.spyOn(store, "completeTurn"),
    failTurn: vi.spyOn(store, "failTurn"),
    failSession: vi.spyOn(store, "failSession"),
    cancelSession: vi.spyOn(store, "cancelSession"),
    publishCandidate: vi.spyOn(store, "publishCandidate"),
    recoverInterruptedSessions: vi.spyOn(store, "recoverInterruptedSessions"),
    listPendingCandidatePublicationSessions: vi.spyOn(
      store,
      "listPendingCandidatePublicationSessions",
    ),
    exportSessionHistory: vi.spyOn(store, "exportSessionHistory"),
    acceptOutlineCandidate: vi.spyOn(store, "acceptOutlineCandidate"),
    rejectCandidate: vi.spyOn(store, "rejectCandidate"),
    expireCandidate: vi.spyOn(store, "expireCandidate"),
  };
  if (override.findSessionById !== undefined) {
    spies.findSessionById.mockImplementation(override.findSessionById);
  }
  if (override.listProjectSessions !== undefined) {
    spies.listProjectSessions.mockImplementation(override.listProjectSessions);
  }
  if (override.createSession !== undefined) {
    spies.createSession.mockImplementation(override.createSession);
  }
  if (override.claimTurn !== undefined) {
    spies.claimTurn.mockImplementation(override.claimTurn);
  }
  if (override.completeTurn !== undefined) {
    spies.completeTurn.mockImplementation(override.completeTurn);
  }
  if (override.failTurn !== undefined) {
    spies.failTurn.mockImplementation(override.failTurn);
  }
  if (override.failSession !== undefined) {
    spies.failSession.mockImplementation(override.failSession);
  }
  if (override.cancelSession !== undefined) {
    spies.cancelSession.mockImplementation(override.cancelSession);
  }
  if (override.publishCandidate !== undefined) {
    spies.publishCandidate.mockImplementation(override.publishCandidate);
  }
  if (override.recoverInterruptedSessions !== undefined) {
    spies.recoverInterruptedSessions.mockImplementation(override.recoverInterruptedSessions);
  }
  if (override.listPendingCandidatePublicationSessions !== undefined) {
    spies.listPendingCandidatePublicationSessions.mockImplementation(
      override.listPendingCandidatePublicationSessions,
    );
  } else {
    spies.listPendingCandidatePublicationSessions.mockResolvedValue([]);
  }
  if (override.exportSessionHistory !== undefined) {
    spies.exportSessionHistory.mockImplementation(override.exportSessionHistory);
  }
  if (override.acceptOutlineCandidate !== undefined) {
    spies.acceptOutlineCandidate.mockImplementation(override.acceptOutlineCandidate);
  }
  if (override.rejectCandidate !== undefined) {
    spies.rejectCandidate.mockImplementation(override.rejectCandidate);
  }
  if (override.expireCandidate !== undefined) {
    spies.expireCandidate.mockImplementation(override.expireCandidate);
  }
  return { runtimeStore: store, ...spies };
}

function fakeGateway(override: Partial<NativeModelGatewayClient> = {}) {
  const listModels = vi.fn<NativeModelGatewayClient["listModels"]>();
  const checkConnection = vi.fn<NativeModelGatewayClient["checkConnection"]>();
  const embed = vi.fn<NativeModelGatewayClient["embed"]>();
  const generate = vi.fn<NativeModelGatewayClient["generate"]>();
  const cancelGeneration = vi.fn<NativeModelGatewayClient["cancelGeneration"]>(() =>
    Promise.resolve(true),
  );
  if (override.listModels !== undefined) {
    listModels.mockImplementation(override.listModels);
  }
  if (override.checkConnection !== undefined) {
    checkConnection.mockImplementation(override.checkConnection);
  }
  if (override.embed !== undefined) {
    embed.mockImplementation(override.embed);
  }
  if (override.generate !== undefined) {
    generate.mockImplementation(override.generate);
  }
  if (override.cancelGeneration !== undefined) {
    cancelGeneration.mockImplementation(override.cancelGeneration);
  }
  const runtimeGateway = {
    available: override.available ?? true,
    listModels,
    checkConnection,
    embed,
    generate,
    cancelGeneration,
  } satisfies NativeModelGatewayClient;
  return {
    runtimeGateway,
    listModels,
    checkConnection,
    embed,
    generate,
    cancelGeneration,
  };
}

function createRuntime(
  store: ReturnType<typeof fakeStore>,
  gateway: ReturnType<typeof fakeGateway>,
  context: MultiAgentReviewContext = {
    authorityJson: JSON.stringify({ nodes: [] }),
    citationReceiptsJson: "[]",
  },
  overrides: Readonly<{
    modelCenter?: ModelCenterStore;
    projectContextPrivacy?: Pick<
      ProjectContextPrivacyAuthority,
      "inspect" | "assertCurrentBeforeDispatch" | "assertRouteEligible"
    >;
  }> = {},
): MultiAgentReviewRuntime {
  let id = 0;
  return new MultiAgentReviewRuntime({
    store: store.runtimeStore,
    contextReader: {
      resolveTargetAuthority: vi.fn(),
      load: vi.fn(() => Promise.resolve(context)),
    } satisfies MultiAgentReviewContextReader,
    modelCenter: overrides.modelCenter ?? fakeModelCenter(),
    modelHub: { findConnection: vi.fn().mockResolvedValue(null) },
    modelRouting: fakeModelRouting(),
    credentials: { getSummary: vi.fn().mockResolvedValue({ configured: true }) },
    modelGateway: gateway.runtimeGateway,
    projectContextPrivacy: overrides.projectContextPrivacy ?? standardPrivacyAuthority(),
    ids: {
      next: () => requireUuid(`00000000-0000-7000-8000-${String((id += 1)).padStart(12, "0")}`),
    } satisfies UuidV7Generator,
    clock: TEST_CLOCK,
    enabled: true,
  });
}

function standardPrivacyAuthority(): Pick<
  ProjectContextPrivacyAuthority,
  "inspect" | "assertCurrentBeforeDispatch" | "assertRouteEligible"
> {
  return {
    inspect: (projectId) =>
      Promise.resolve(
        Object.freeze({
          schemaVersion: 1 as const,
          projectId,
          fingerprint: `standard:${projectId}`,
          activeChapterCount: 0,
          retainedChapterCount: 0,
          requiresVerifiedLocal: false,
          chapters: Object.freeze([]),
        }),
      ),
    assertCurrentBeforeDispatch: () => Promise.resolve(),
    assertRouteEligible: () => undefined,
  };
}

class RejectingSqlExecutor implements SqlExecutor {
  public select<Row extends object>(): Promise<Row[]> {
    return Promise.reject(new Error("An unexpected test SQL read escaped the store mock."));
  }

  public execute(): Promise<never> {
    return Promise.reject(new Error("An unexpected test SQL write escaped the store mock."));
  }

  public transaction<Value>(): Promise<Value> {
    return Promise.reject(new Error("An unexpected test transaction escaped the store mock."));
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

async function outlineExecutor(snapshotJson: string): Promise<NodeSqliteExecutor> {
  const executor = new NodeSqliteExecutor(`
    CREATE TABLE story_outlines (
      project_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL
    );
  `);
  await executor.execute(
    `INSERT INTO story_outlines (project_id, revision, snapshot_json)
     VALUES (?, ?, ?)`,
    ["project-1", 1, snapshotJson],
  );
  return executor;
}

function requireCandidate(
  session: MultiAgentReviewSession,
): NonNullable<MultiAgentReviewSession["candidate"]> {
  if (session.candidate === null) {
    throw new Error("Expected the fixture to contain a review candidate.");
  }
  return session.candidate;
}

function fakeModelCenter(readRevision: () => number = () => 1): ModelCenterStore {
  const baseProfile: ModelProfile = {
    providerId: "provider-1",
    provider: "open_ai_compatible",
    baseUrl: "https://models.example/v1",
    authentication: "bearer_keyring",
    selectedModel: "review-model",
    pricing: {
      contextWindowTokens: 8_192,
      currency: "USD",
      inputMicrosPerMillionTokens: 1_000,
      outputMicrosPerMillionTokens: 1_000,
      cachedInputMicrosPerMillionTokens: 0,
      pricingVersion: "price-1",
      priceUpdatedAt: NOW,
    },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const currentProfile = (): ModelProfile =>
    Object.freeze({ ...baseProfile, revision: readRevision() });
  return {
    listProfiles: vi.fn<ModelCenterStore["listProfiles"]>(() =>
      Promise.resolve([currentProfile()]),
    ),
    findByProviderId: vi.fn<ModelCenterStore["findByProviderId"]>((providerId) =>
      Promise.resolve(providerId === baseProfile.providerId ? currentProfile() : null),
    ),
    save: vi.fn<ModelCenterStore["save"]>(),
  };
}

function fakeModelRouting(): ModelRoutingStore {
  return {
    listRoutes: vi.fn<ModelRoutingStore["listRoutes"]>(),
    findRoute: vi.fn<ModelRoutingStore["findRoute"]>(),
    saveRoute: vi.fn<ModelRoutingStore["saveRoute"]>(),
    deleteRoute: vi.fn<ModelRoutingStore["deleteRoute"]>(),
  };
}

function parseStoredCandidate(responseJson: string | null): unknown {
  if (responseJson === null) {
    throw new Error("Expected the completed turn to contain its public response.");
  }
  const response: unknown = JSON.parse(responseJson);
  if (typeof response !== "object" || response === null || !("candidate" in response)) {
    throw new Error("Expected the completed response to contain a candidate.");
  }
  return response.candidate;
}

function parseOutlineAuthority(value: string): {
  readonly nodes: readonly unknown[];
  readonly truncated: boolean;
} {
  const authority: unknown = JSON.parse(value);
  if (
    typeof authority !== "object" ||
    authority === null ||
    !("nodes" in authority) ||
    !Array.isArray(authority.nodes) ||
    !("truncated" in authority) ||
    typeof authority.truncated !== "boolean"
  ) {
    throw new Error("Expected a complete outline authority response.");
  }
  return { nodes: authority.nodes, truncated: authority.truncated };
}

function requireTimestamp(value: string): ReturnType<Clock["now"]> {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function requireUuid(value: string): ReturnType<UuidV7Generator["next"]> {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function firstTurn(session: MultiAgentReviewSession): MultiAgentReviewSession["turns"][number] {
  const turn = session.turns[0];
  if (turn === undefined) {
    throw new Error("Expected the fixture to contain a review turn.");
  }
  return turn;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectedArtifactId(
  session: MultiAgentReviewSession,
  finalTurnId: string,
  purpose: "review-candidate",
): Promise<string> {
  const timeHex = Date.parse(session.startedAt).toString(16).padStart(12, "0");
  const entropy = await sha256(`inkshadow.multi-agent.v1:${session.id}:${finalTurnId}:${purpose}`);
  return [
    timeHex.slice(0, 8),
    timeHex.slice(8, 12),
    `7${entropy.slice(0, 3)}`,
    `8${entropy.slice(3, 6)}`,
    entropy.slice(6, 18),
  ].join("-");
}
