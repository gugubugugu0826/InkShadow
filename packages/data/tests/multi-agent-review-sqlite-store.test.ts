import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { Clock } from "@inkshadow/domain";

import {
  MultiAgentReviewSqliteStore,
  computeMultiAgentReviewCompletionFingerprint,
  computeMultiAgentReviewRequestFingerprint,
  type CompleteMultiAgentReviewTurnInput,
  type CreateMultiAgentReviewSessionInput,
} from "../src/index.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../story-core/migrations/0001_story_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../story-core/migrations/0002_materials.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0024_multi_agent_review.sql", import.meta.url), "utf8"),
].join("\n");

const ids = {
  project: "019fa024-0000-7000-8000-000000000001",
  otherProject: "019fa024-0000-7000-8000-000000000002",
  chapter: "019fa024-0000-7000-8000-000000000003",
  otherChapter: "019fa024-0000-7000-8000-000000000004",
  version: "019fa024-0000-7000-8000-000000000005",
  otherVersion: "019fa024-0000-7000-8000-000000000006",
  session: "019fa024-0000-7000-8000-000000000007",
  participant: "019fa024-0000-7000-8000-000000000008",
  turn: "019fa024-0000-7000-8000-000000000009",
  conclusion: "019fa024-0000-7000-8000-00000000000a",
  candidate: "019fa024-0000-7000-8000-00000000000b",
  chapterCandidate: "019fa024-0000-7000-8000-00000000000c",
  audit: "019fa024-0000-7000-8000-00000000000d",
  acceptAudit: "019fa024-0000-7000-8000-00000000000e",
  rejectAudit: "019fa024-0000-7000-8000-00000000000f",
  expireAudit: "019fa024-0000-7000-8000-000000000010",
} as const;

const startedAt = "2026-07-28T08:00:00.000Z";
const deadlineAt = "2026-07-28T08:10:00.000Z";
const completedAt = "2026-07-28T08:01:00.000Z";

describe("0024 bounded multi-agent review SQLite vertical", () => {
  it("is idempotent and rejects raw cross-project target ownership", () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);

    expect(() => executor.database.exec(migration)).not.toThrow();
    expect(() =>
      executor.database
        .prepare(
          `INSERT INTO multi_agent_review_sessions (
             id, project_id, idempotency_key, request_fingerprint,
             restart_of_session_id, mode, target_kind, chapter_id,
             base_version_id, base_outline_revision, base_authority_checksum,
             user_request, status, revision, attempt, maximum_rounds,
             maximum_turns, maximum_input_tokens, maximum_output_tokens,
             maximum_cost_micros, maximum_duration_ms, currency,
             cancellation_requested, failure_code, started_at, deadline_at,
             completed_at, created_at, updated_at
           ) VALUES (
             ?, ?, 'cross-project', ?, NULL, 'outline_review', 'chapter', ?,
             ?, NULL, ?, '评审', 'running', 1, 1, 1, 1, 1000, 1000,
             0, 600000, 'USD', 0, NULL, ?, ?, NULL, ?, ?
           )`,
        )
        .run(
          "019fa024-0000-7000-8000-000000000099",
          ids.project,
          "a".repeat(64),
          ids.otherChapter,
          ids.otherVersion,
          "b".repeat(64),
          startedAt,
          deadlineAt,
          startedAt,
          startedAt,
        ),
    ).toThrow(/ownership mismatch/u);
  });

  it("persists bounded public history with exact replay, CAS and explicit outline acceptance", async () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);
    const store = createStore(executor);
    const create = await outlineCreateInput();

    const first = await store.createSession(create);
    const replay = await store.createSession(create);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(first.session.status).toBe("running");
    expect(() =>
      executor.database
        .prepare(
          `UPDATE multi_agent_review_participants
           SET endpoint_url = 'https://attacker.example/v1'
           WHERE session_id = ? AND participant_id = ?`,
        )
        .run(ids.session, ids.participant),
    ).toThrow(/participant authority is immutable/u);
    expect(() =>
      executor.database
        .prepare(
          `UPDATE multi_agent_review_sessions
           SET user_request = 'rewritten authority'
           WHERE id = ?`,
        )
        .run(ids.session),
    ).toThrow(/session authority is immutable/u);

    const changed = await outlineCreateInput({
      limits: { ...create.limits, maximumInputTokens: 2_001 },
    });
    await expect(store.createSession(changed)).rejects.toMatchObject({
      code: "MULTI_AGENT_IDEMPOTENCY_CONFLICT",
    });

    const claimed = await store.claimTurn(claim());
    expect(claimed.revision).toBe(2);
    await expect(store.claimTurn(claim())).resolves.toMatchObject({
      revision: 2,
      turns: [{ status: "working" }],
    });

    const response = outlineResponse();
    const complete = await completion(response);
    const completed = await store.completeTurn(complete);
    expect(completed).toMatchObject({
      revision: 3,
      status: "running",
      turns: [
        {
          status: "completed",
          inputTokens: 120,
          outputTokens: 40,
          costMicros: 0,
        },
      ],
    });
    await expect(store.completeTurn(complete)).resolves.toMatchObject({
      revision: 3,
    });
    expect(() =>
      executor.database
        .prepare(
          `UPDATE multi_agent_review_turns
           SET public_message = 'rewritten terminal history'
           WHERE id = ?`,
        )
        .run(ids.turn),
    ).toThrow(/terminal turn history is immutable/u);
    await expect(
      store.claimTurn({
        ...claim(),
        expectedSessionRevision: 2,
        turnId: "019fa024-0000-7000-8000-000000000080",
        idempotencyKey: "review-turn-stale",
        generationId: "generation-stale",
      }),
    ).rejects.toMatchObject({ code: "MULTI_AGENT_REVISION_CONFLICT" });

    const payloadJson = JSON.stringify(response.candidate);
    await expect(
      store.publishCandidate({
        sessionId: ids.session,
        expectedSessionRevision: 3,
        candidateId: ids.candidate,
        chapterCandidateId: null,
        payloadJson,
        payloadChecksum: "f".repeat(64),
        chapterContentChecksum: null,
        auditEventId: ids.audit,
        publishedAt: "2026-07-28T08:02:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MULTI_AGENT_AUTHORITY_MISMATCH" });

    const payloadChecksum = await sha256(payloadJson);
    const published = await store.publishCandidate({
      sessionId: ids.session,
      expectedSessionRevision: 3,
      candidateId: ids.candidate,
      chapterCandidateId: null,
      payloadJson,
      payloadChecksum,
      chapterContentChecksum: null,
      auditEventId: ids.audit,
      publishedAt: "2026-07-28T08:02:00.000Z",
    });
    expect(published).toMatchObject({
      targetKind: "outline",
      status: "ready",
      baseOutlineRevision: 1,
    });
    expect(
      executor.database
        .prepare("SELECT revision FROM story_outlines WHERE project_id = ?")
        .get(ids.project),
    ).toEqual({ revision: 1 });

    const accepted = await store.acceptOutlineCandidate(
      ids.candidate,
      1,
      ids.acceptAudit,
      "2026-07-28T08:03:00.000Z",
    );
    expect(accepted).toMatchObject({
      outlineRevision: 2,
      candidate: { status: "accepted", revision: 2 },
    });
    expect(JSON.parse(accepted.outlineSnapshotJson)).toMatchObject({
      revision: 2,
      nodes: [{ id: outlineNodeId, synopsis: "补充主动选择的动机。" }],
    });

    const acceptedReplay = await store.acceptOutlineCandidate(
      ids.candidate,
      1,
      ids.acceptAudit,
      "2026-07-28T08:03:00.000Z",
    );
    expect(acceptedReplay.outlineSnapshotJson).toBe(accepted.outlineSnapshotJson);
    expect(
      executor.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM local_audit_events
           WHERE action = 'outline_candidate_accepted'`,
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rejects cross-project evidence and rolls the public turn commit back", async () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);
    const store = createStore(executor);
    await store.createSession(await outlineCreateInput());
    await store.claimTurn(claim());
    const response = outlineResponse();
    const invalidCompletion = await completion(response, {
      conclusions: [
        {
          id: ids.conclusion,
          category: "must_change",
          title: "跨项目证据",
          explanation: "该证据不应进入评审历史。",
          evidence: ["伪造证据"],
          sourceReferences: [
            {
              kind: "chapter",
              sourceId: ids.otherChapter,
              sourceRevision: 1,
              sourceVersionId: ids.otherVersion,
              sourceChecksum: createHash("sha256").update("另一个项目正文。").digest("hex"),
              modelLabel: "另一个项目",
              authoritativeLabel: null,
              excerpt: null,
            },
          ],
          taskProposal: null,
        },
      ],
    });

    await expect(store.completeTurn(invalidCompletion)).rejects.toMatchObject({
      code: "MULTI_AGENT_AUTHORITY_MISMATCH",
    });
    await expect(store.findSessionById(ids.session)).resolves.toMatchObject({
      revision: 2,
      turns: [{ status: "working" }],
    });
  });

  it("rejects outline acceptance when the baseline changed without a revision bump", async () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);
    const store = createStore(executor);
    await store.createSession(await outlineCreateInput());
    await store.claimTurn(claim());
    const response = outlineResponse();
    await store.completeTurn(await completion(response));
    const payloadJson = JSON.stringify(response.candidate);
    await store.publishCandidate({
      sessionId: ids.session,
      expectedSessionRevision: 3,
      candidateId: ids.candidate,
      chapterCandidateId: null,
      payloadJson,
      payloadChecksum: await sha256(payloadJson),
      chapterContentChecksum: null,
      auditEventId: ids.audit,
      publishedAt: "2026-07-28T08:02:00.000Z",
    });

    executor.database
      .prepare(
        `UPDATE story_outlines
         SET snapshot_json = ?
         WHERE project_id = ? AND revision = 1`,
      )
      .run(
        JSON.stringify({
          ...outlineSnapshot(),
          nodes: [
            {
              ...outlineSnapshot().nodes[0],
              synopsis: "同修订号下被篡改的正式大纲。",
            },
          ],
        }),
        ids.project,
      );

    await expect(
      store.acceptOutlineCandidate(ids.candidate, 1, ids.acceptAudit, "2026-07-28T08:03:00.000Z"),
    ).rejects.toMatchObject({ code: "MULTI_AGENT_AUTHORITY_MISMATCH" });
    await expect(store.findSessionById(ids.session)).resolves.toMatchObject({
      status: "candidate_ready",
      candidate: { status: "ready", revision: 1 },
    });
  });

  it("recovers interrupted work as paused history and never invents provider usage", async () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);
    const store = createStore(executor);
    await store.createSession(await outlineCreateInput());
    await store.claimTurn(claim());

    await expect(store.recoverInterruptedSessions("2026-07-28T08:04:00.000Z")).resolves.toBe(1);
    await expect(store.findSessionById(ids.session)).resolves.toMatchObject({
      status: "paused",
      revision: 3,
      turns: [
        {
          status: "failed",
          usageSource: "provider_unavailable",
          inputTokens: null,
          outputTokens: null,
          costMicros: null,
          errorCode: "APP_RESTARTED",
        },
      ],
    });
  });

  it("preserves a completed final candidate for deterministic publication recovery", async () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);
    const store = createStore(executor);
    const base = await outlineCreateInput();
    await store.createSession(
      await outlineCreateInput({
        limits: {
          ...base.limits,
          maximumRounds: 1,
          maximumTurns: 1,
        },
        participants: [{ ...participant(), maximumTurns: 1 }],
      }),
    );
    await store.claimTurn(claim());
    await store.completeTurn(await completion(outlineResponse()));

    await expect(store.recoverInterruptedSessions("2026-07-28T08:04:00.000Z")).resolves.toBe(0);
    await expect(store.listPendingCandidatePublicationSessions()).resolves.toMatchObject([
      {
        id: ids.session,
        status: "running",
        revision: 3,
        turns: [{ status: "completed" }],
        candidate: null,
      },
    ]);
  });

  it("cascades a deleted restart root without mutating immutable restart authority", async () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);
    const store = createStore(executor);
    await store.createSession(await outlineCreateInput());
    await store.failSession(
      ids.session,
      1,
      "AGENT_PREFLIGHT_RESOURCE_EXHAUSTED",
      "2026-07-28T08:00:10.000Z",
    );
    const restartedSessionId = "019fa024-0000-7000-8000-000000000081";
    const restartedParticipantId = "019fa024-0000-7000-8000-000000000082";
    await store.createSession(
      await outlineCreateInput({
        id: restartedSessionId,
        idempotencyKey: "review-outline-restart-1",
        restartOfSessionId: ids.session,
        attempt: 2,
        participants: [
          {
            ...participant(),
            participantId: restartedParticipantId,
          },
        ],
        startedAt: "2026-07-28T08:02:00.000Z",
      }),
    );

    expect(() =>
      executor.database
        .prepare("DELETE FROM multi_agent_review_sessions WHERE id = ?")
        .run(ids.session),
    ).not.toThrow();
    expect(
      executor.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM multi_agent_review_sessions
           WHERE id IN (?, ?)`,
        )
        .get(ids.session, restartedSessionId),
    ).toEqual({ count: 0 });
  });

  it("records provider-reported overage honestly and terminates the working turn", async () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);
    const store = createStore(executor);
    await store.createSession(await outlineCreateInput());
    await store.claimTurn(claim());
    const response = outlineResponse();
    const overageUsage = {
      inputTokens: 2_500,
      outputTokens: 400,
      cachedInputTokens: null,
    };
    await expect(
      store.completeTurn(
        await completion(response, {
          usage: overageUsage,
        }),
      ),
    ).rejects.toMatchObject({ code: "MULTI_AGENT_LIMIT_EXHAUSTED" });

    const failed = await store.failTurn({
      sessionId: ids.session,
      turnId: ids.turn,
      expectedSessionRevision: 2,
      outcome: "failed",
      errorCode: "AGENT_BUDGET_OVERRUN",
      usage: overageUsage,
      completedAt,
    });
    expect(failed).toMatchObject({
      status: "failed",
      turns: [
        {
          status: "failed",
          usageSource: "provider_reported",
          inputTokens: 2_500,
          outputTokens: 400,
          costMicros: 0,
          errorCode: "AGENT_BUDGET_OVERRUN",
        },
      ],
    });
  });

  it("publishes chapter output only as an isolated AiCandidate without formal mutation", async () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);
    const store = createStore(executor);
    const create = await chapterCreateInput();
    await store.createSession(create);
    await store.claimTurn(claim());
    const response = chapterResponse();
    await store.completeTurn(await completion(response));
    const payloadJson = JSON.stringify(response.candidate);
    const publishedAt = "2026-07-28T08:02:00.000Z";

    await store.publishCandidate({
      sessionId: ids.session,
      expectedSessionRevision: 3,
      candidateId: ids.candidate,
      chapterCandidateId: ids.chapterCandidate,
      payloadJson,
      payloadChecksum: await sha256(payloadJson),
      chapterContentChecksum: await sha256(response.candidate.content),
      auditEventId: ids.audit,
      publishedAt,
    });

    expect(
      executor.database
        .prepare("SELECT content, revision FROM chapters WHERE id = ?")
        .get(ids.chapter),
    ).toEqual({ content: "正式正文。", revision: 1 });
    expect(
      executor.database
        .prepare(
          `SELECT source, status, base_version_id, content
           FROM ai_candidates
           WHERE id = ?`,
        )
        .get(ids.chapterCandidate),
    ).toEqual({
      source: "agent",
      status: "ready",
      base_version_id: ids.version,
      content: "评审后的候选正文。",
    });
    expect(() =>
      executor.database.prepare("DELETE FROM ai_candidates WHERE id = ?").run(ids.chapterCandidate),
    ).toThrow(/FOREIGN KEY constraint failed/u);

    const rejected = await store.rejectCandidate(
      ids.candidate,
      1,
      ids.rejectAudit,
      "2026-07-28T08:03:00.000Z",
    );
    expect(rejected).toMatchObject({ status: "rejected", revision: 2 });
    await expect(
      store.rejectCandidate(ids.candidate, 1, ids.rejectAudit, "2026-07-28T08:03:00.000Z"),
    ).resolves.toMatchObject({ status: "rejected", revision: 2 });
    expect(
      executor.database
        .prepare("SELECT status, decided_at FROM ai_candidates WHERE id = ?")
        .get(ids.chapterCandidate),
    ).toEqual({
      status: "rejected",
      decided_at: "2026-07-28T08:03:00.000Z",
    });
    expect(() =>
      executor.database.prepare("DELETE FROM projects WHERE id = ?").run(ids.project),
    ).not.toThrow();
    expect(
      executor.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM ai_candidates WHERE project_id = ?) AS ai_count,
             (SELECT COUNT(*) FROM multi_agent_review_sessions WHERE project_id = ?)
               AS review_count`,
        )
        .get(ids.project, ids.project),
    ).toEqual({ ai_count: 0, review_count: 0 });
  });

  it("fails closed when callers bypass the protocol parser", async () => {
    const executor = new NodeSqliteExecutor(migration);
    seedAuthorities(executor);
    const store = createStore(executor);
    await store.createSession(await outlineCreateInput());
    await store.claimTurn(claim());
    const response = outlineResponse();

    const hiddenRoot = await completion(response, {
      serializedResponse: JSON.stringify({
        ...response,
        hiddenReasoning: "must never be persisted",
      }),
    });
    await expect(store.completeTurn(hiddenRoot)).rejects.toMatchObject({
      code: "MULTI_AGENT_INVALID_INPUT",
    });

    const missingNeedsInput = await completion(response, {
      serializedResponse: JSON.stringify({
        schemaVersion: 1,
        publicMessage: response.publicMessage,
        conclusions: response.conclusions,
        candidate: null,
      }),
      needsInput: true,
    });
    await expect(store.completeTurn(missingNeedsInput)).rejects.toMatchObject({
      code: "MULTI_AGENT_INVALID_INPUT",
    });

    await store.completeTurn(await completion(response));
    const invalidPayload = {
      kind: "outline_patch",
      changes: [
        {
          nodeId: outlineNodeId,
          expectedNodeRevision: Number.MAX_SAFE_INTEGER,
          title: "Unsafe",
          synopsis: null,
        },
      ],
    };
    const invalidPayloadJson = JSON.stringify(invalidPayload);
    await expect(
      store.publishCandidate({
        sessionId: ids.session,
        expectedSessionRevision: 3,
        candidateId: ids.candidate,
        chapterCandidateId: null,
        payloadJson: invalidPayloadJson,
        payloadChecksum: await sha256(invalidPayloadJson),
        chapterContentChecksum: null,
        auditEventId: ids.audit,
        publishedAt: "2026-07-28T08:02:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MULTI_AGENT_INVALID_INPUT" });
  });

  it("rejects normalized calendar rollovers and unsafe endpoint query snapshots", async () => {
    const invalidDateExecutor = new NodeSqliteExecutor(migration);
    seedAuthorities(invalidDateExecutor);
    const invalidDateStore = createStore(invalidDateExecutor);
    const validCreate = await outlineCreateInput();
    await expect(
      invalidDateStore.createSession({
        ...validCreate,
        startedAt: "2026-02-31T08:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MULTI_AGENT_INVALID_INPUT" });

    for (const endpointUrl of [
      "https://models.example/v1?api-version=sk-super-secret",
      "https://models.example/v1?api-version=2024-10-21&api-version=2024-12-01",
    ]) {
      await expect(
        invalidDateStore.createSession({
          ...validCreate,
          participants: [{ ...participant(), endpointUrl }],
        }),
      ).rejects.toMatchObject({ code: "MULTI_AGENT_INVALID_INPUT" });
    }

    await expect(
      invalidDateStore.createSession(
        await outlineCreateInput({
          participants: [
            {
              ...participant(),
              endpointUrl: "https://models.example/v1?api-version=2024-10-21",
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ created: true });
    expect(() =>
      invalidDateExecutor.database
        .prepare("UPDATE multi_agent_review_sessions SET updated_at = 'not-a-date' WHERE id = ?")
        .run(ids.session),
    ).toThrow(/CHECK constraint failed/u);
  });

  it("fails recovery and candidate decisions before integer authority can overflow", async () => {
    const recoveryExecutor = new NodeSqliteExecutor(migration);
    seedAuthorities(recoveryExecutor);
    const recoveryStore = createStore(recoveryExecutor);
    await recoveryStore.createSession(await outlineCreateInput());
    await recoveryStore.claimTurn(claim());
    recoveryExecutor.database
      .prepare("UPDATE multi_agent_review_sessions SET revision = ? WHERE id = ?")
      .run(Number.MAX_SAFE_INTEGER, ids.session);
    await expect(
      recoveryStore.recoverInterruptedSessions("2026-07-28T08:04:00.000Z"),
    ).rejects.toMatchObject({ code: "MULTI_AGENT_LIMIT_EXHAUSTED" });
    expect(
      recoveryExecutor.database
        .prepare("SELECT status FROM multi_agent_review_turns WHERE id = ?")
        .get(ids.turn),
    ).toEqual({ status: "working" });

    const candidateExecutor = new NodeSqliteExecutor(migration);
    seedAuthorities(candidateExecutor);
    const candidateStore = createStore(candidateExecutor);
    await candidateStore.createSession(await outlineCreateInput());
    await candidateStore.claimTurn(claim());
    const response = outlineResponse();
    await candidateStore.completeTurn(await completion(response));
    const payloadJson = JSON.stringify(response.candidate);
    await candidateStore.publishCandidate({
      sessionId: ids.session,
      expectedSessionRevision: 3,
      candidateId: ids.candidate,
      chapterCandidateId: null,
      payloadJson,
      payloadChecksum: await sha256(payloadJson),
      chapterContentChecksum: null,
      auditEventId: ids.audit,
      publishedAt: "2026-07-28T08:02:00.000Z",
    });
    candidateExecutor.database
      .prepare("UPDATE multi_agent_review_candidates SET revision = ? WHERE id = ?")
      .run(Number.MAX_SAFE_INTEGER, ids.candidate);
    await expect(
      candidateStore.expireCandidate(
        ids.candidate,
        Number.MAX_SAFE_INTEGER,
        ids.expireAudit,
        "2026-07-28T08:03:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "MULTI_AGENT_LIMIT_EXHAUSTED" });
    candidateExecutor.database
      .prepare("UPDATE multi_agent_review_candidates SET revision = 1 WHERE id = ?")
      .run(ids.candidate);
    await expect(
      candidateStore.expireCandidate(ids.candidate, 1, ids.expireAudit, "2026-07-28T08:03:00.000Z"),
    ).resolves.toMatchObject({ status: "expired", revision: 2 });
    await expect(
      candidateStore.expireCandidate(ids.candidate, 1, ids.expireAudit, "2026-07-28T08:03:00.000Z"),
    ).resolves.toMatchObject({ status: "expired", revision: 2 });
  });
});

const outlineNodeId = "019fa024-0000-7000-8000-000000000020";

function createStore(executor: NodeSqliteExecutor): MultiAgentReviewSqliteStore {
  const clock = {
    now: () => "2026-07-28T08:05:00.000Z",
  } as unknown as Clock;
  return new MultiAgentReviewSqliteStore(executor, clock);
}

async function outlineCreateInput(
  override: Partial<CreateMultiAgentReviewSessionInput> = {},
): Promise<CreateMultiAgentReviewSessionInput> {
  const withoutFingerprint = {
    id: ids.session,
    projectId: ids.project,
    idempotencyKey: "review-outline-1",
    mode: "outline_review",
    target: {
      kind: "outline",
      baseOutlineRevision: 1,
      baseAuthorityChecksum: await sha256(JSON.stringify(outlineSnapshot())),
    },
    userRequest: "评审当前大纲的角色动机。",
    limits: {
      maximumRounds: 2,
      maximumTurns: 2,
      maximumInputTokens: 2_000,
      maximumOutputTokens: 1_000,
      maximumCostMicros: 0,
      maximumDurationMs: 600_000,
      currency: "USD",
    },
    participants: [participant()],
    startedAt,
    deadlineAt,
    ...override,
  } satisfies Omit<CreateMultiAgentReviewSessionInput, "requestFingerprint">;
  return {
    ...withoutFingerprint,
    requestFingerprint: await computeMultiAgentReviewRequestFingerprint(withoutFingerprint),
  };
}

async function chapterCreateInput(): Promise<CreateMultiAgentReviewSessionInput> {
  const withoutFingerprint = {
    id: ids.session,
    projectId: ids.project,
    idempotencyKey: "review-chapter-1",
    mode: "commercial_review",
    target: {
      kind: "chapter",
      chapterId: ids.chapter,
      baseVersionId: ids.version,
      baseAuthorityChecksum: await sha256("正式正文。"),
    },
    userRequest: "评审当前章节。",
    limits: {
      maximumRounds: 2,
      maximumTurns: 2,
      maximumInputTokens: 2_000,
      maximumOutputTokens: 1_000,
      maximumCostMicros: 0,
      maximumDurationMs: 600_000,
      currency: "USD",
    },
    participants: [participant()],
    startedAt,
    deadlineAt,
  } satisfies Omit<CreateMultiAgentReviewSessionInput, "requestFingerprint">;
  return {
    ...withoutFingerprint,
    requestFingerprint: await computeMultiAgentReviewRequestFingerprint(withoutFingerprint),
  };
}

function participant() {
  return {
    participantId: ids.participant,
    ordinal: 0,
    role: "planner",
    enabled: true,
    providerId: "local-ollama",
    providerKind: "ollama",
    endpointUrl: "http://127.0.0.1:11434",
    authentication: "none",
    providerProfileRevision: 1,
    modelId: "writer-model",
    modelRevision: "profile-1",
    maximumTurns: 2,
    contextWindowTokens: 8_192,
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "local-zero-cost",
    priceUpdatedAt: startedAt,
  } as const;
}

function claim() {
  return {
    sessionId: ids.session,
    expectedSessionRevision: 1,
    turnId: ids.turn,
    participantId: ids.participant,
    idempotencyKey: "review-turn-1",
    generationId: "generation-1",
    reservation: {
      maximumInputTokens: 500,
      maximumOutputTokens: 250,
      maximumCostMicros: 0,
    },
    startedAt: "2026-07-28T08:00:30.000Z",
  } as const;
}

async function completion(
  response: ReturnType<typeof outlineResponse> | ReturnType<typeof chapterResponse>,
  override: Partial<Omit<CompleteMultiAgentReviewTurnInput, "resultFingerprint">> = {},
): Promise<CompleteMultiAgentReviewTurnInput> {
  const withoutFingerprint = {
    sessionId: ids.session,
    turnId: ids.turn,
    expectedSessionRevision: 2,
    serializedResponse: JSON.stringify(response),
    publicMessage: response.publicMessage,
    needsInput: false,
    usage: {
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: null,
    },
    conclusions: [
      {
        id: ids.conclusion,
        category: "suggested_change",
        title: "补充动机",
        explanation: "需要让角色主动做出选择。",
        evidence: ["现有转折缺少主动选择。"],
        sourceReferences: [],
        taskProposal: null,
      },
    ],
    completedAt,
    ...override,
  } satisfies Omit<CompleteMultiAgentReviewTurnInput, "resultFingerprint">;
  return {
    ...withoutFingerprint,
    resultFingerprint: await computeMultiAgentReviewCompletionFingerprint(withoutFingerprint),
  };
}

function outlineResponse() {
  return {
    schemaVersion: 1,
    publicMessage: "大纲评审已形成公开结论。",
    conclusions: [
      {
        category: "suggested_change",
        title: "补充动机",
        explanation: "需要让角色主动做出选择。",
        evidence: ["现有转折缺少主动选择。"],
        sourceReferences: [],
        taskProposal: null,
      },
    ],
    candidate: {
      kind: "outline_patch",
      changes: [
        {
          nodeId: outlineNodeId,
          expectedNodeRevision: 1,
          title: null,
          synopsis: "补充主动选择的动机。",
        },
      ],
    },
    needsInput: null,
  } as const;
}

function chapterResponse() {
  return {
    schemaVersion: 1,
    publicMessage: "章节评审已形成公开结论。",
    conclusions: [
      {
        category: "suggested_change",
        title: "补充动机",
        explanation: "需要让角色主动做出选择。",
        evidence: ["现有转折缺少主动选择。"],
        sourceReferences: [],
        taskProposal: null,
      },
    ],
    candidate: {
      kind: "chapter_content",
      content: "评审后的候选正文。",
    },
    needsInput: null,
  } as const;
}

function seedAuthorities(executor: NodeSqliteExecutor): void {
  const now = startedAt;
  executor.database
    .prepare(
      `INSERT INTO projects (id, name, status, revision, created_at, updated_at)
       VALUES (?, ?, 'active', 1, ?, ?)`,
    )
    .run(ids.project, "项目一", now, now);
  executor.database
    .prepare(
      `INSERT INTO projects (id, name, status, revision, created_at, updated_at)
       VALUES (?, ?, 'active', 1, ?, ?)`,
    )
    .run(ids.otherProject, "项目二", now, now);
  insertChapter(executor, ids.project, ids.chapter, ids.version, "正式正文。");
  insertChapter(executor, ids.otherProject, ids.otherChapter, ids.otherVersion, "另一个项目正文。");
  executor.database
    .prepare(
      `INSERT INTO story_outlines (project_id, revision, snapshot_json)
       VALUES (?, 1, ?)`,
    )
    .run(ids.project, JSON.stringify(outlineSnapshot()));
}

function outlineSnapshot() {
  return {
    projectId: ids.project,
    revision: 1,
    nodes: [
      {
        id: outlineNodeId,
        kind: "book",
        parentId: null,
        title: "第一卷",
        synopsis: "原始梗概。",
        position: 1024,
        locked: false,
        revision: 1,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    ],
  } as const;
}

function insertChapter(
  executor: NodeSqliteExecutor,
  projectId: string,
  chapterId: string,
  versionId: string,
  content: string,
): void {
  executor.database.exec("BEGIN");
  try {
    executor.database
      .prepare(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision,
           current_version_id, created_at, updated_at
         ) VALUES (?, ?, '第一章', ?, 'active', 1, ?, ?, ?)`,
      )
      .run(chapterId, projectId, content, versionId, startedAt, startedAt);
    executor.database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
      )
      .run(
        versionId,
        projectId,
        chapterId,
        content,
        createHash("sha256").update(content).digest("hex"),
        startedAt,
      );
    executor.database.exec("COMMIT");
  } catch (error: unknown) {
    executor.database.exec("ROLLBACK");
    throw error;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
