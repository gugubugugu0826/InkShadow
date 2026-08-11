import type {
  ExecuteResult,
  SqlExecutor,
  SqlPrimitive,
  TransactionExecutor,
} from "@inkshadow/data";
import type { AiCandidateSnapshot } from "@inkshadow/domain";
import { listNovelSkillEvaluationFixtures } from "@inkshadow/ai-core";
import { describe, expect, it } from "vitest";

import type { ContextCompilationTrace } from "./context-compilation-trace-store";
import {
  MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
  hashModelHubExactEvaluationExecutionLock,
  hashModelHubExactEvaluationRequestProfile,
  type ModelHubExactEvaluationExecutionResult,
  type ModelHubExactEvaluationInspection,
  type ModelHubExactEvaluationPredispatchReceipt,
} from "./model-hub-exact-evaluation-target";
import {
  NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT,
  NovelSkillPaidEvaluationSqliteStore,
  hashNovelSkillPaidEvaluationCommercialConfirmation,
  hashNovelSkillPaidEvaluationInvariantRequest,
  hashNovelSkillPaidEvaluationTraceBaseline,
  type ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
} from "./novel-skill-paid-evaluation-sqlite-store";
import {
  compileNovelSkillPaidEvaluationPayload,
  createNovelSkillPaidEvaluationContextBaselineProjection,
  createNovelSkillPaidEvaluationPromptTemplateProjection,
  resolveNovelSkillPaidEvaluationArmConfigurationHash,
  type NovelSkillPaidEvaluationTraceBaselineProjection,
} from "./novel-skill-paid-evaluation-payload-authority";
import {
  hashNovelSkillEvaluationModelArtifact,
  hashNovelSkillEvaluationModelIdentity,
} from "./novel-skill-evaluation-sqlite-store";

const NOW = "2026-08-11T00:00:00.000Z";
const RUN_ID = "019f9f4a-b3c7-7350-8000-000000000101";
const AUTHORIZATION_ID = "019f9f4a-b3c7-7350-8000-000000000102";
const RESERVATION_ID = "019f9f4a-b3c7-7350-8000-000000000103";
const CELL_ID = "019f9f4a-b3c7-7350-8000-000000000104";
const ATTEMPT_ID = "019f9f4a-b3c7-7350-8000-000000000105";
const TRACE_ID = "019f9f4a-b3c7-7350-8000-000000000111";
const CANDIDATE_ID = "019f9f4a-b3c7-7350-8000-000000000112";
const INVOCATION_ID = "019f9f4a-b3c7-7350-8000-000000000113";
const PROJECT_ID = "019f9f4a-b3c7-7350-8000-000000000114";
const SUITE_ID = "019f9f4a-b3c7-7350-8000-000000000115";
const FIXTURE_ID = "zh.campus.first_person.continuation";
const PROTOCOL_HASH = "6".repeat(64);
const PROMPT_TEMPLATE_HASH = "8".repeat(64);
const BOUND_AT = "2026-08-11T00:00:01.000Z";
const COMPLETED_AT = "2026-08-11T00:00:02.000Z";
const VISIBLE_OUTPUT = "雨停了。🌧️";

describe("NovelSkillPaidEvaluationSqliteStore", () => {
  it("replays only the exact persisted protocol, profiles and fixture baselines", async () => {
    const fixtureIds = Array.from(
      { length: 12 },
      (_, index) => `fixture-${String(index + 1).padStart(2, "0")}`,
    );
    const requestProfile = {
      version: "model-hub-exact-evaluation-request@1" as const,
      task: "continuation" as const,
      maximumInputTokens: 7_000,
      maximumOutputTokens: 64,
      temperatureBasisPoints: 0,
      topPBasisPoints: 10_000,
      reasoningMode: "disabled" as const,
      responseFormat: "text" as const,
      streaming: true as const,
      stopPolicyHash: MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
      providerCallPolicy: "single_attempt" as const,
    };
    const profileInput = {
      taskType: requestProfile.task,
      profileVersion: requestProfile.version,
      requestProfileHash: await hashModelHubExactEvaluationRequestProfile(requestProfile),
      maximumInputTokens: requestProfile.maximumInputTokens,
      maximumOutputTokens: requestProfile.maximumOutputTokens,
      temperatureBasisPoints: requestProfile.temperatureBasisPoints,
      topPBasisPoints: requestProfile.topPBasisPoints,
      streaming: true as const,
      stopPolicyHash: requestProfile.stopPolicyHash,
    };
    const baselines = fixtureIds.map((fixtureId, index) => ({
      fixtureId,
      baselineContractHash: `${(index + 1).toString(16).padStart(2, "0")}${"1".repeat(62)}`,
      includedSourceManifestHash: `${(index + 1).toString(16).padStart(2, "0")}${"2".repeat(62)}`,
      omittedSourceManifestHash: `${(index + 1).toString(16).padStart(2, "0")}${"3".repeat(62)}`,
      compiledBaselineHash: `${(index + 1).toString(16).padStart(2, "0")}${"4".repeat(62)}`,
      baselineTokenBudget: 7_000,
    }));
    const input = {
      suiteId: SUITE_ID,
      promptTemplateVersion: "evaluation-template@1",
      promptTemplateHash: PROMPT_TEMPLATE_HASH,
      rubricContentHash: "1".repeat(64),
      evaluatorContractHash: "2".repeat(64),
      blindingProtocolVersion: "blind-review@1",
      blindingProtocolHash: "3".repeat(64),
      randomizationProtocolVersion: "randomized-review@1",
      randomizationProtocolHash: "4".repeat(64),
      requestProfiles: [profileInput],
      contextBaselines: baselines,
      createdAt: NOW,
    } as const;
    let created = false;
    const storedRecord: {
      current?: Awaited<ReturnType<NovelSkillPaidEvaluationSqliteStore["createExecutionProtocol"]>>;
    } = {};
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM novel_skill_evaluation_fixtures")) {
          return fixtureIds.map((fixture_id) => ({ fixture_id, task_type: "continuation" }));
        }
        if (query.includes("FROM novel_skill_evaluation_protocols")) {
          if (!created) return [];
          const record = storedRecord.current;
          if (record === undefined) throw new Error("Persisted protocol record is unavailable.");
          return [
            {
              schema_version: 1,
              execution_protocol_version: "novel-skill-paid-ab@1",
              protocol_hash: record.protocolHash,
              request_profile_manifest_hash: record.requestProfileManifestHash,
              context_baseline_manifest_hash: record.contextBaselineManifestHash,
              prompt_template_version: input.promptTemplateVersion,
              prompt_template_hash: input.promptTemplateHash,
              rubric_version: "novel-skill-human-rubric@1",
              rubric_content_hash: input.rubricContentHash,
              evaluator_contract_hash: input.evaluatorContractHash,
              blinding_protocol_version: input.blindingProtocolVersion,
              blinding_protocol_hash: input.blindingProtocolHash,
              randomization_protocol_version: input.randomizationProtocolVersion,
              randomization_protocol_hash: input.randomizationProtocolHash,
              created_at: input.createdAt,
            },
          ];
        }
        if (query.includes("FROM novel_skill_evaluation_request_profiles")) {
          return [
            {
              task_type: profileInput.taskType,
              profile_version: profileInput.profileVersion,
              request_profile_hash: profileInput.requestProfileHash,
              maximum_input_tokens: profileInput.maximumInputTokens,
              maximum_output_tokens: profileInput.maximumOutputTokens,
              temperature_basis_points: profileInput.temperatureBasisPoints,
              top_p_basis_points: profileInput.topPBasisPoints,
              reasoning_policy: "disabled",
              response_format: "text",
              streaming: 1,
              stop_policy_hash: profileInput.stopPolicyHash,
              created_at: input.createdAt,
            },
          ];
        }
        if (query.includes("FROM novel_skill_evaluation_context_baselines")) {
          return baselines.map((baseline) => ({
            fixture_id: baseline.fixtureId,
            baseline_contract_hash: baseline.baselineContractHash,
            included_source_manifest_hash: baseline.includedSourceManifestHash,
            omitted_source_manifest_hash: baseline.omittedSourceManifestHash,
            compiled_baseline_hash: baseline.compiledBaselineHash,
            baseline_token_budget: baseline.baselineTokenBudget,
            created_at: input.createdAt,
          }));
        }
        throw new Error(`Unexpected select: ${query}`);
      },
      execute: (query) => {
        if (query.includes("INSERT INTO novel_skill_evaluation_protocols")) created = true;
        return { rowsAffected: 1 };
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    const record = await store.createExecutionProtocol(input);
    storedRecord.current = record;
    const persistedExecutionCount = executor.executions.length;
    await expect(store.createExecutionProtocol(input)).resolves.toEqual(record);
    expect(executor.executions).toHaveLength(persistedExecutionCount);
    await expect(
      store.createExecutionProtocol({ ...input, randomizationProtocolHash: "5".repeat(64) }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    expect(executor.executions).toHaveLength(persistedExecutionCount);
  });

  it("rejects a caller-supplied request profile hash that does not match the wire contract", async () => {
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM novel_skill_evaluation_fixtures")) {
          return Array.from({ length: 12 }, (_, index) => ({
            fixture_id: `fixture-${String(index + 1).padStart(2, "0")}`,
            task_type: "continuation",
          }));
        }
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(
      store.createExecutionProtocol({
        suiteId: SUITE_ID,
        promptTemplateVersion: "evaluation-template@1",
        promptTemplateHash: PROMPT_TEMPLATE_HASH,
        rubricContentHash: "1".repeat(64),
        evaluatorContractHash: "2".repeat(64),
        blindingProtocolVersion: "blind-review@1",
        blindingProtocolHash: "3".repeat(64),
        randomizationProtocolVersion: "randomized-review@1",
        randomizationProtocolHash: "4".repeat(64),
        requestProfiles: [
          {
            taskType: "continuation",
            profileVersion: "model-hub-exact-evaluation-request@1",
            requestProfileHash: "f".repeat(64),
            maximumInputTokens: 7_000,
            maximumOutputTokens: 64,
            temperatureBasisPoints: 0,
            topPBasisPoints: 10_000,
            streaming: true,
            stopPolicyHash: MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
          },
        ],
        contextBaselines: [],
        createdAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
    expect(executor.executions).toHaveLength(0);
  });

  it("quotes exactly 192 calls by currency and persists only an explicit matching ceiling", async () => {
    const executor = quoteExecutor();
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    const quote = await store.quoteCommercialRun(RUN_ID);

    expect(quote.authorizedCallCount).toBe(NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT);
    expect(quote.currencies).toEqual([{ currency: "USD", estimatedMaximumCostMicros: "384" }]);
    await expect(
      store.authorizeCommercialRun({
        authorizationId: AUTHORIZATION_ID,
        runId: RUN_ID,
        quoteHash: quote.quoteHash,
        confirmationHash: "a".repeat(64),
        hardCeilings: [{ currency: "USD", hardCeilingMicros: "383" }],
        authorizedAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
    expect(executor.executions).toHaveLength(0);

    const hardCeilings = [{ currency: "USD", hardCeilingMicros: "400" }] as const;
    const confirmationHash = await hashNovelSkillPaidEvaluationCommercialConfirmation({
      quote,
      hardCeilings,
    });
    await expect(
      store.authorizeCommercialRun({
        authorizationId: AUTHORIZATION_ID,
        runId: RUN_ID,
        quoteHash: quote.quoteHash,
        confirmationHash: "b".repeat(64),
        hardCeilings,
        authorizedAt: NOW,
      }),
    ).rejects.toThrow(/commercial confirmation/iu);
    expect(executor.executions).toHaveLength(0);

    await expect(
      store.authorizeCommercialRun({
        authorizationId: AUTHORIZATION_ID,
        runId: RUN_ID,
        quoteHash: quote.quoteHash,
        confirmationHash,
        hardCeilings,
        authorizedAt: NOW,
      }),
    ).resolves.toEqual(quote);
    expect(executor.executions).toHaveLength(2);
    expect(executor.executions[0]?.query).toContain(
      "novel_skill_evaluation_dispatch_authorizations",
    );
    expect(executor.executions[1]?.values).toContain("400");
  });

  it("reserves and binds the trace, invocation, attempt, and reservation in one ordered transaction", async () => {
    let state: ReservationState | null = null;
    let revision = 0;
    let snapshot: Readonly<Record<string, SqlPrimitive>> | null = null;
    const input = await reserveAndBindInput();
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          return [exactTargetRow("a")];
        }
        if (query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
          return snapshot === null ? [] : [snapshot];
        }
        if (query.includes("WHERE attempt_id = ?")) {
          return state === null ? [] : [reservationRow(state, revision, ATTEMPT_ID)];
        }
        if (query.includes("FROM novel_skill_evaluation_run_model_targets")) {
          return [dispatchTargetRow(input)];
        }
        if (query.includes("WHERE id = ?")) {
          return state === null ? [] : [reservationRow(state, revision, ATTEMPT_ID)];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
      execute: (query, values) => {
        if (query.includes("INSERT INTO novel_skill_evaluation_dispatch_reservations")) {
          state = "reserved";
          revision = 1;
        }
        if (query.includes("INSERT INTO novel_skill_evaluation_predispatch_authority_snapshots")) {
          snapshot = snapshotRowFromInsert(query, values, input);
        }
        if (query.includes("SET state = 'bound'")) {
          state = "bound";
          revision = 2;
        }
        return { rowsAffected: 1 };
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(store.reserveAndBindAttemptDispatch(input)).resolves.toMatchObject({
      id: RESERVATION_ID,
      state: "bound",
      revision: 2,
    });

    expect(executor.transactionCount).toBe(1);
    expect(operationLabels(executor)).toEqual([
      "transaction:begin",
      "select:target:read",
      "select:target:read-live",
      "select:reservation:read-attempt",
      "execute:reservation:insert",
      "select:reservation:read-attempt",
      "select:authority:read",
      "execute:authority:insert",
      "select:authority:read",
      "select:target:read-live",
      "execute:trace:insert-run",
      ...input.trace.entries.flatMap((entry) => [
        "execute:trace:insert-entry",
        ...entry.sources.map(() => "execute:trace:insert-source"),
      ]),
      "execute:trace:link-execution",
      "execute:invocation:insert",
      "execute:trace:link-invocation",
      "execute:attempt:bind",
      "execute:reservation:bind",
      "select:reservation:read-id",
      "transaction:commit",
    ]);
  });

  it("treats an already complete immutable binding as an idempotent success", async () => {
    const input = await reserveAndBindInput();
    const authority = await capturePredispatchAuthorityRow(input);
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          return [exactTargetRow("a")];
        }
        if (query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
          return [authority];
        }
        if (query.includes("FROM novel_skill_evaluation_run_model_targets")) {
          return [dispatchTargetRow(input)];
        }
        if (query.includes("WHERE attempt_id = ?")) {
          return [reservationRow("bound", 2, ATTEMPT_ID)];
        }
        if (query.includes("SELECT count(*) AS valid")) return [{ valid: 1 }];
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(store.reserveAndBindAttemptDispatch(input)).resolves.toMatchObject({
      state: "bound",
      revision: 2,
    });

    expect(executor.transactionCount).toBe(1);
    expect(executor.executions).toHaveLength(0);
    expect(operationLabels(executor)).toEqual([
      "transaction:begin",
      "select:target:read",
      "select:target:read-live",
      "select:reservation:read-attempt",
      "select:reservation:assert-idempotent-input",
      "select:authority:read",
      "select:target:read-live",
      "select:reservation:assert-bound",
      "transaction:commit",
    ]);
  });

  it("rejects an existing reservation when the same identifiers carry a different immutable payload", async () => {
    const original = await reserveAndBindInput();
    const changedPayloadHash = "c".repeat(64);
    const changed: ReserveAndBindNovelSkillPaidEvaluationDispatchInput = {
      ...original,
      reservation: {
        ...original.reservation,
        receipt: {
          ...original.reservation.receipt,
          payloadHash: changedPayloadHash,
          executionLockHash: await hashModelHubExactEvaluationExecutionLock({
            targetIdentityHash: original.reservation.receipt.target.targetIdentityHash,
            requestProfileHash: original.reservation.receipt.requestProfileHash,
            payloadHash: changedPayloadHash,
            currency: original.reservation.receipt.currency,
            estimatedMaximumCostMicros: original.reservation.receipt.estimatedMaximumCostMicros,
          }),
        },
      },
    };
    const executor = new StubSqlExecutor({
      select: (query, values) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          return [exactTargetRow("a")];
        }
        if (query.includes("FROM novel_skill_evaluation_run_model_targets")) {
          return [dispatchTargetRow(original)];
        }
        if (query.includes("WHERE attempt_id = ?")) {
          return [reservationRow("bound", 2, ATTEMPT_ID)];
        }
        if (
          query.includes("SELECT count(*) AS valid") &&
          !query.includes("INNER JOIN novel_skill_evaluation_attempts")
        ) {
          return [
            {
              valid: values.includes(original.reservation.receipt.payloadHash) ? 1 : 0,
            },
          ];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(store.reserveAndBindAttemptDispatch(changed)).rejects.toMatchObject({
      code: "NOVEL_SKILL_EVALUATION_CONFLICT",
    });

    expect(executor.executions).toHaveLength(0);
    expect(operationLabels(executor)).toEqual([
      "transaction:begin",
      "select:target:read",
      "select:target:read-live",
      "select:reservation:read-attempt",
      "select:reservation:assert-idempotent-input",
      "transaction:rollback",
    ]);
  });

  it("rejects a caller-reported capability hash that is not bound into the frozen target", async () => {
    const original = await reserveAndBindInput();
    const forged: ReserveAndBindNovelSkillPaidEvaluationDispatchInput = {
      ...original,
      reservation: {
        ...original.reservation,
        receipt: {
          ...original.reservation.receipt,
          target: {
            ...original.reservation.receipt.target,
            capabilityEvidenceHash: "f".repeat(64),
          },
        },
      },
    };
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          return [exactTargetRow("a")];
        }
        if (query.includes("FROM novel_skill_evaluation_run_model_targets")) {
          return [dispatchTargetRow(original)];
        }
        throw new Error(`Unexpected forged-capability select: ${query}`);
      },
    });

    await expect(
      new NovelSkillPaidEvaluationSqliteStore(executor).reserveAndBindAttemptDispatch(forged),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    expect(executor.executions).toHaveLength(0);
  });

  it("rejects trace drift and free-form audit text before opening a transaction", async () => {
    const original = await reserveAndBindInput();
    const changedTrace: ContextCompilationTrace = {
      ...original.trace,
      entries: original.trace.entries.map((entry, index) =>
        index === 0 ? { ...entry, priority: entry.priority - 1 } : entry,
      ),
    };
    const executor = new StubSqlExecutor({
      select: (query) => {
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(
      store.reserveAndBindAttemptDispatch({ ...original, trace: changedTrace }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
    await expect(
      store.reserveAndBindAttemptDispatch({
        ...original,
        trace: {
          ...original.trace,
          entries: original.trace.entries.map((entry, index) =>
            index === 0 ? { ...entry, selectionReason: "作者的秘密正文" } : entry,
          ),
        },
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
    expect(executor.transactionCount).toBe(0);
    expect(executor.operations).toHaveLength(0);
  });

  it("rejects trace preference evidence that is absent from the authoritative arm", async () => {
    const original = await reserveAndBindInput();
    const firstEntry = original.trace.entries[0];
    const firstSource = firstEntry?.sources[0];
    if (firstEntry === undefined || firstSource === undefined) {
      throw new Error("evaluation trace evidence missing");
    }
    const changedTrace: ContextCompilationTrace = {
      ...original.trace,
      entries: [
        {
          ...firstEntry,
          contextCandidateId: "writing-preference:unexpected",
          sources: [
            {
              ...firstSource,
              sourceType: "user_input",
              locator: "writing_preference",
              contentHash: firstSource.contentHash ?? "e".repeat(64),
            },
          ],
        },
        ...original.trace.entries.slice(1),
      ],
    };
    const executor = new StubSqlExecutor({
      select: (query) => {
        throw new Error(`Unexpected select: ${query}`);
      },
    });

    await expect(
      new NovelSkillPaidEvaluationSqliteStore(executor).reserveAndBindAttemptDispatch({
        ...original,
        trace: changedTrace,
      }),
    ).rejects.toThrow(/preference evidence/iu);
    expect(executor.transactionCount).toBe(0);
    expect(executor.operations).toHaveLength(0);
  });

  it("rejects a tampered authority message before opening a transaction", async () => {
    const original = await reserveAndBindInput();
    const firstMessage = original.payloadAuthority.messages[0];
    if (firstMessage === undefined) throw new Error("authority message missing");
    const executor = new StubSqlExecutor({
      select: (query) => {
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(
      store.reserveAndBindAttemptDispatch({
        ...original,
        payloadAuthority: {
          ...original.payloadAuthority,
          messages: [
            { ...firstMessage, content: `${firstMessage.content}\nunauthorized mutation` },
            ...original.payloadAuthority.messages.slice(1),
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });

    expect(executor.transactionCount).toBe(0);
    expect(executor.executions).toHaveLength(0);
  });

  it("starts the queued invocation before committing the reservation as dispatched", async () => {
    let invocationState: "queued" | "running" = "queued";
    let reservationState: ReservationState = "bound";
    let revision = 2;
    const authority = await capturePredispatchAuthorityRow(await reserveAndBindInput());
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          return [exactTargetRow("a")];
        }
        if (query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
          return [authority];
        }
        if (query.includes("SELECT planned_model_invocation_id")) {
          return [{ planned_model_invocation_id: INVOCATION_ID }];
        }
        if (query.includes("WHERE id = ?")) {
          return [reservationRow(reservationState, revision, ATTEMPT_ID)];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
      execute: (query) => {
        if (query.includes("SET status = 'running'")) {
          expect(invocationState).toBe("queued");
          expect(reservationState).toBe("bound");
          invocationState = "running";
        }
        if (query.includes("SET state = 'dispatched'")) {
          expect(invocationState).toBe("running");
          expect(reservationState).toBe("bound");
          reservationState = "dispatched";
          revision = 3;
        }
        return { rowsAffected: 1 };
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(store.markDispatchStarted(RESERVATION_ID, 2, COMPLETED_AT)).resolves.toMatchObject(
      {
        state: "dispatched",
        revision: 3,
      },
    );

    expect(executor.transactionCount).toBe(1);
    expect(executor.executions.map(({ query }) => query)).toEqual([
      expect.stringContaining("SET status = 'running'"),
      expect.stringContaining("SET state = 'dispatched'"),
    ]);
  });

  it("rejects Candidate output hash or Unicode length drift before opening a transaction", async () => {
    const result = await executionResult();
    const candidate = candidateSnapshot(result.visibleOutputHash);
    const cases: readonly Readonly<{
      label: string;
      result: ModelHubExactEvaluationExecutionResult;
    }>[] = [
      {
        label: "visible output hash",
        result: { ...result, visibleOutputHash: "f".repeat(64) },
      },
      {
        label: "Unicode code-point length",
        result: { ...result, visibleContentLength: result.visibleContentLength + 1 },
      },
    ];

    for (const mismatch of cases) {
      const executor = new StubSqlExecutor({
        select: (query) => {
          throw new Error(`A ${mismatch.label} mismatch must not read SQLite: ${query}`);
        },
      });
      const store = new NovelSkillPaidEvaluationSqliteStore(executor);

      await expect(
        store.settleDispatchSuccess({
          reservationId: RESERVATION_ID,
          expectedRevision: 3,
          candidate,
          result: mismatch.result,
          completedAt: COMPLETED_AT,
        }),
      ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
      expect(executor.transactionCount).toBe(0);
      expect(executor.operations).toHaveLength(0);
    }
  });

  it("rejects succeeded and failed usage beyond the frozen input or output limits", async () => {
    const baseResult = await executionResult();
    const authority = await capturePredispatchAuthorityRow(await reserveAndBindInput());
    const overInputResult = {
      ...baseResult,
      usage: { inputTokens: 7_001, outputTokens: 4, cachedInputTokens: 0 },
      estimatedActualCostMicros: "8",
    };
    const successExecutor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          return [exactTargetRow("a")];
        }
        if (query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
          return [authority];
        }
        if (query.includes("reserved_max_cost_micros")) {
          return [settlementReservationRow(overInputResult)];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    await expect(
      new NovelSkillPaidEvaluationSqliteStore(successExecutor).settleDispatchSuccess({
        reservationId: RESERVATION_ID,
        expectedRevision: 3,
        candidate: candidateSnapshot(overInputResult.visibleOutputHash),
        result: overInputResult,
        completedAt: COMPLETED_AT,
      }),
    ).rejects.toThrow(/token counts exceed/iu);
    expect(successExecutor.executions).toHaveLength(0);

    const failureExecutor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          return [exactTargetRow("a")];
        }
        if (query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
          return [authority];
        }
        if (query.includes("reserved_max_cost_micros") && query.includes("input_rate")) {
          return [failureReservationRow()];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    await expect(
      new NovelSkillPaidEvaluationSqliteStore(failureExecutor).settleDispatchFailure({
        reservationId: RESERVATION_ID,
        expectedRevision: 3,
        outcome: "failed",
        errorCode: "MODEL_PROVIDER_ERROR",
        usage: { inputTokens: 5, outputTokens: 65, cachedInputTokens: 0 },
        estimatedActualCostMicros: "1",
        completedAt: COMPLETED_AT,
      }),
    ).rejects.toThrow(/token counts exceed/iu);
    expect(failureExecutor.executions).toHaveLength(0);
  });

  it("settles from frozen authority after dispatch even when the live target becomes unavailable", async () => {
    const result = await executionResult();
    const candidate = candidateSnapshot(result.visibleOutputHash);
    const authority = await capturePredispatchAuthorityRow(await reserveAndBindInput());
    let state: ReservationState = "dispatched";
    let revision = 3;
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          throw new Error("Settlement must not depend on post-dispatch live target state.");
        }
        if (query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
          return [authority];
        }
        if (query.includes("reserved_max_cost_micros")) {
          return [settlementReservationRow(result)];
        }
        if (query.includes("WHERE id = ?")) {
          return [reservationRow(state, revision, ATTEMPT_ID)];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
      execute: (query) => {
        if (query.includes("SET state = 'settled'")) {
          state = "settled";
          revision = 4;
        }
        return { rowsAffected: 1 };
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(
      store.settleDispatchSuccess({
        reservationId: RESERVATION_ID,
        expectedRevision: 3,
        candidate,
        result,
        completedAt: COMPLETED_AT,
      }),
    ).resolves.toMatchObject({ state: "settled", revision: 4 });

    expect(executor.transactionCount).toBe(1);
    expect(operationLabels(executor)).toEqual([
      "transaction:begin",
      "select:authority:read",
      "select:reservation:read-settlement",
      "execute:invocation:settle",
      "execute:candidate:insert",
      "execute:trace:link-output",
      "execute:attempt:settle",
      "execute:reservation:settle",
      "select:reservation:read-id",
      "transaction:commit",
    ]);

    const outputWriters = executor.executions.filter(({ values }) =>
      values.includes(VISIBLE_OUTPUT),
    );
    expect(outputWriters).toHaveLength(1);
    expect(outputWriters[0]?.query).toContain("INSERT INTO ai_candidates");
    const sidecars = executor.executions.filter(
      ({ query }) => !query.includes("INSERT INTO ai_candidates"),
    );
    expect(sidecars.every(({ values }) => !values.includes(VISIBLE_OUTPUT))).toBe(true);
    expect(JSON.stringify(sidecars)).not.toContain(VISIBLE_OUTPUT);
  });

  it("recomputes failed-call cost, closes the invocation, and invalidates the run atomically", async () => {
    let reservationState: ReservationState = "dispatched";
    let revision = 3;
    const authority = await capturePredispatchAuthorityRow(await reserveAndBindInput());
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          return [exactTargetRow("a")];
        }
        if (query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
          return [authority];
        }
        if (query.includes("reserved_max_cost_micros") && query.includes("input_rate")) {
          return [failureReservationRow()];
        }
        if (query.includes("state IN ('reserved','bound','dispatched')")) return [];
        if (query.includes("WHERE id = ?")) {
          return [reservationRow(reservationState, revision, ATTEMPT_ID)];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
      execute: (query) => {
        if (query.includes("SET state = 'settled'")) {
          reservationState = "settled";
          revision = 4;
        }
        return { rowsAffected: 1 };
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(
      store.settleDispatchFailure({
        reservationId: RESERVATION_ID,
        expectedRevision: 3,
        outcome: "failed",
        errorCode: "MODEL_PROVIDER_ERROR",
        usage: { inputTokens: 5, outputTokens: 0, cachedInputTokens: 0 },
        estimatedActualCostMicros: "1",
        completedAt: COMPLETED_AT,
      }),
    ).resolves.toMatchObject({ state: "settled", revision: 4 });

    const statements = executor.executions.map(({ query }) => query);
    expect(statements).toContainEqual(expect.stringContaining("SET status = ?"));
    expect(statements).toContainEqual(expect.stringContaining("SET state = 'settled'"));
    expect(statements).toContainEqual(expect.stringContaining("status = 'invalidated'"));
    expect(statements.every((query) => !query.includes("INSERT INTO ai_candidates"))).toBe(true);
    expect(executor.executions.some(({ values }) => values.includes("1"))).toBe(true);
  });

  it("rejects a caller-reported failed-call cost that does not match locked rates", async () => {
    const authority = await capturePredispatchAuthorityRow(await reserveAndBindInput());
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM model_provider_connections AS connection")) {
          return [exactTargetRow("a")];
        }
        if (query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
          return [authority];
        }
        if (query.includes("reserved_max_cost_micros") && query.includes("input_rate")) {
          return [failureReservationRow()];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(
      store.settleDispatchFailure({
        reservationId: RESERVATION_ID,
        expectedRevision: 3,
        outcome: "failed",
        errorCode: "MODEL_PROVIDER_ERROR",
        usage: { inputTokens: 5, outputTokens: 0, cachedInputTokens: 0 },
        estimatedActualCostMicros: "2",
        completedAt: COMPLETED_AT,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
    expect(executor.executions).toHaveLength(0);
  });

  it("releases a predispatch reservation and cancels its attempt in one transaction", async () => {
    let state: ReservationState = "bound";
    let revision = 2;
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("SELECT attempt_id FROM novel_skill_evaluation_dispatch_reservations")) {
          return [{ attempt_id: ATTEMPT_ID }];
        }
        if (
          query.includes("FROM novel_skill_evaluation_dispatch_reservations") &&
          query.includes("WHERE id = ?")
        ) {
          return [reservationRow(state, revision, ATTEMPT_ID)];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
      execute: (query) => {
        if (query.includes("SET state = 'not_dispatched'")) {
          state = "not_dispatched";
          revision += 1;
        }
        return { rowsAffected: 1 };
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(store.markNotDispatched(RESERVATION_ID, 2, NOW)).resolves.toMatchObject({
      state: "not_dispatched",
      revision: 3,
    });

    expect(executor.transactionCount).toBe(1);
    expect(executor.executions.map(({ query }) => query)).toEqual([
      expect.stringContaining("SET status = 'cancelled'"),
      expect.stringContaining("error_code = 'PRE_DISPATCH_CANCELLED'"),
      expect.stringContaining("SET state = 'not_dispatched'"),
    ]);
  });

  it("releases only predispatch work after restart and invalidates a possibly charged dispatch", async () => {
    const activeReservations = [
      reservationRow("reserved", 1, ATTEMPT_ID),
      reservationRow(
        "bound",
        2,
        "019f9f4a-b3c7-7350-8000-000000000106",
        "019f9f4a-b3c7-7350-8000-000000000107",
      ),
      reservationRow(
        "dispatched",
        3,
        "019f9f4a-b3c7-7350-8000-000000000108",
        "019f9f4a-b3c7-7350-8000-000000000109",
      ),
    ];
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("state IN ('reserved','bound','dispatched')")) {
          return activeReservations.filter(({ state }) =>
            ["reserved", "bound", "dispatched"].includes(state),
          );
        }
        throw new Error(`Unexpected select: ${query}`);
      },
      execute: (query, values) => {
        const nextState = query.includes("SET state = 'not_dispatched'")
          ? "not_dispatched"
          : query.includes("SET state = 'ambiguous'")
            ? "ambiguous"
            : null;
        if (nextState !== null) {
          const id = String(values[1]);
          const row = activeReservations.find((candidate) => candidate.id === id);
          if (row !== undefined) {
            row.state = nextState;
            row.revision += 1;
          }
        }
        return { rowsAffected: 1 };
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(store.recoverInterruptedDispatches(RUN_ID, NOW)).resolves.toEqual({
      released: 2,
      ambiguous: 1,
    });

    const statements = executor.executions.map(({ query }) => query);
    expect(statements.filter((query) => query.includes("PRE_DISPATCH_CANCELLED"))).toHaveLength(2);
    expect(statements).toContainEqual(expect.stringContaining("SET state = 'ambiguous'"));
    expect(statements).toContainEqual(expect.stringContaining("status = 'invalidated'"));
    expect(statements).toContainEqual(expect.stringContaining("state = 'invalidated'"));
  });

  it("refuses model artifacts that lack an exact provider model identifier", async () => {
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("FROM novel_skill_evaluation_runs WHERE id = ?")) {
          return [
            {
              id: RUN_ID,
              suite_id: "019f9f4a-b3c7-7350-8000-000000000110",
              status: "planned",
              model_assignments_json: JSON.stringify([
                {
                  slotId: "text_tier_a",
                  modelIdentityHash: "1".repeat(64),
                  modelArtifactHash: "2".repeat(64),
                },
                {
                  slotId: "text_tier_b",
                  modelIdentityHash: "3".repeat(64),
                  modelArtifactHash: "4".repeat(64),
                },
              ]),
            },
          ];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);

    await expect(
      store.bindExactModelTargets(
        RUN_ID,
        [
          {
            modelSlotId: "text_tier_a",
            inspection: inspection("a"),
            artifactIdentitySource: "provider_version" as never,
          },
          {
            modelSlotId: "text_tier_b",
            inspection: inspection("b"),
            artifactIdentitySource: "provider_model_id",
          },
        ],
        NOW,
      ),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });
    expect(executor.executions).toHaveLength(0);
  });

  it("replays only the exact two persisted model target locks", async () => {
    const rows = [exactTargetRow("a"), exactTargetRow("b")];
    const inspections = await Promise.all(
      rows.map(async (row, index) => {
        const value = inspection(index === 0 ? "a" : "b");
        const costProfileHash = await sha256Hex(testCanonicalJson(testCostProjection(row)));
        return {
          ...value,
          target: {
            ...value.target,
            costProfileHash,
            targetIdentityHash: await testTargetIdentityHash(
              row,
              value.target.capabilityEvidenceHash,
              costProfileHash,
            ),
          },
        };
      }),
    );
    const assignments = await Promise.all(
      rows.map(async (row, index) => ({
        slotId: index === 0 ? ("text_tier_a" as const) : ("text_tier_b" as const),
        modelIdentityHash: await hashNovelSkillEvaluationModelIdentity({
          catalogEntryId: row.catalog_id,
          connectionId: row.connection_id,
          modelId: row.provider_model_id,
          providerKind: row.provider_kind,
        }),
        modelArtifactHash: await hashNovelSkillEvaluationModelArtifact({
          modelId: row.provider_model_id,
          providerKind: row.provider_kind,
        }),
      })),
    );
    const persisted: object[] = [];
    const executor = new StubSqlExecutor({
      select: (query, values) => {
        if (query.includes("FROM novel_skill_evaluation_runs WHERE id = ?")) {
          return [
            {
              id: RUN_ID,
              suite_id: SUITE_ID,
              status: "planned",
              model_assignments_json: JSON.stringify(assignments),
            },
          ];
        }
        if (query.includes("FROM model_provider_connections AS connection")) {
          const row = rows.find(({ connection_id }) => connection_id === values[0]);
          return row === undefined ? [] : [row];
        }
        if (query.includes("FROM novel_skill_evaluation_run_model_targets")) return persisted;
        throw new Error(`Unexpected select: ${query}`);
      },
      execute: (query, values) => {
        if (query.includes("INSERT INTO novel_skill_evaluation_run_model_targets")) {
          persisted.push(persistedTargetFromValues(values));
        }
        return { rowsAffected: 1 };
      },
    });
    const store = new NovelSkillPaidEvaluationSqliteStore(executor);
    const input = inspections.map((value, index) => ({
      modelSlotId: index === 0 ? ("text_tier_a" as const) : ("text_tier_b" as const),
      inspection: value,
      artifactIdentitySource: "provider_model_id" as const,
    }));

    const first = await store.bindExactModelTargets(RUN_ID, input, NOW);
    const persistedExecutionCount = executor.executions.length;
    await expect(store.bindExactModelTargets(RUN_ID, input, NOW)).resolves.toEqual(first);
    expect(executor.executions).toHaveLength(persistedExecutionCount);
    const changedTarget = {
      ...input[1],
      inspection: {
        ...input[1]?.inspection,
        target: { ...input[1]?.inspection.target, targetIdentityHash: "f".repeat(64) },
      },
    } as (typeof input)[number];
    const firstTarget = input[0];
    if (firstTarget === undefined) throw new Error("First exact target is missing.");
    await expect(
      store.bindExactModelTargets(RUN_ID, [firstTarget, changedTarget], NOW),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    expect(executor.executions).toHaveLength(persistedExecutionCount);
  });
});

type ReservationState =
  "reserved" | "bound" | "dispatched" | "settled" | "ambiguous" | "not_dispatched";

interface StubOptions {
  readonly select: (query: string, values: readonly SqlPrimitive[]) => readonly object[];
  readonly execute?: (query: string, values: readonly SqlPrimitive[]) => ExecuteResult;
}

type StubOperation =
  | Readonly<{
      kind: "transaction";
      phase: "begin" | "commit" | "rollback";
    }>
  | Readonly<{
      kind: "select" | "execute";
      query: string;
      values: readonly SqlPrimitive[];
    }>;

class StubSqlExecutor implements SqlExecutor {
  public readonly executions: Readonly<{
    query: string;
    values: readonly SqlPrimitive[];
  }>[] = [];
  public readonly operations: StubOperation[] = [];
  public transactionCount = 0;

  public constructor(private readonly options: StubOptions) {}

  public select<Row extends object>(
    query: string,
    values: readonly SqlPrimitive[] = [],
  ): Promise<Row[]> {
    this.operations.push(
      Object.freeze({ kind: "select", query, values: Object.freeze([...values]) }),
    );
    const result = this.options.select(query, values);
    return Promise.resolve([...result] as unknown as Row[]);
  }

  public execute(query: string, values: readonly SqlPrimitive[] = []): Promise<ExecuteResult> {
    const operation = Object.freeze({ query, values: Object.freeze([...values]) });
    this.executions.push(operation);
    this.operations.push(Object.freeze({ kind: "execute", ...operation }));
    return Promise.resolve(this.options.execute?.(query, values) ?? { rowsAffected: 1 });
  }

  public async transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    this.transactionCount += 1;
    this.operations.push(Object.freeze({ kind: "transaction", phase: "begin" }));
    try {
      const value = await operation(this);
      this.operations.push(Object.freeze({ kind: "transaction", phase: "commit" }));
      return value;
    } catch (cause: unknown) {
      this.operations.push(Object.freeze({ kind: "transaction", phase: "rollback" }));
      throw cause;
    }
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

async function reserveAndBindInput(): Promise<ReserveAndBindNovelSkillPaidEvaluationDispatchInput> {
  const fixture = listNovelSkillEvaluationFixtures().find(
    ({ fixtureId }) => fixtureId === FIXTURE_ID,
  );
  if (fixture === undefined) throw new Error("Required evaluation fixture is missing.");
  const promptTemplate = await createNovelSkillPaidEvaluationPromptTemplateProjection();
  const contextBaseline = await createNovelSkillPaidEvaluationContextBaselineProjection(
    FIXTURE_ID,
    7_000,
  );
  const currentTask = contextBaseline.traceBaseline.entries.find(
    ({ layer }) => layer === "current_task",
  );
  const fixtureInputContentHash = currentTask?.sources[0]?.contentHash;
  if (fixtureInputContentHash === undefined) {
    throw new Error("Evaluation fixture input hash is missing.");
  }
  const payloadAuthorityInput = {
    cell: {
      runId: RUN_ID,
      suiteId: SUITE_ID,
      cellId: CELL_ID,
      fixtureId: FIXTURE_ID,
      fixtureInputContentHash,
      taskType: fixture.taskType,
      invocationMode: fixture.invocationMode,
      arm: "no_skill" as const,
      armConfigurationHash: await resolveNovelSkillPaidEvaluationArmConfigurationHash("no_skill"),
      modelSlotId: "text_tier_a" as const,
      repetition: 1 as const,
    },
    promptTemplate,
    contextBaseline,
    preferenceProjection: null,
  };
  const payloadAuthority = await compileNovelSkillPaidEvaluationPayload(payloadAuthorityInput);
  const receipt = await predispatchReceipt(payloadAuthority.manifest.messagePayloadHash);
  const trace = evaluationTrace(contextBaseline.traceBaseline);
  const contextBaselineHash = await hashNovelSkillPaidEvaluationTraceBaseline(trace);
  const invariantRequestHash = await hashNovelSkillPaidEvaluationInvariantRequest({
    runId: RUN_ID,
    suiteId: SUITE_ID,
    fixtureId: FIXTURE_ID,
    taskType: "continuation",
    modelSlotId: "text_tier_a",
    repetition: 1,
    protocolHash: PROTOCOL_HASH,
    requestProfileHash: receipt.requestProfileHash,
    contextBaselineHash,
    promptTemplateHash: promptTemplate.hash,
  });
  return {
    reservation: {
      reservationId: RESERVATION_ID,
      authorizationId: AUTHORIZATION_ID,
      runId: RUN_ID,
      cellId: CELL_ID,
      attemptId: ATTEMPT_ID,
      modelSlotId: "text_tier_a",
      dispatchGeneration: 1,
      plannedContextTraceId: TRACE_ID,
      plannedModelInvocationId: INVOCATION_ID,
      plannedCandidateId: CANDIDATE_ID,
      receipt,
      contextBaselineHash,
      promptTemplateHash: promptTemplate.hash,
      invariantRequestHash,
      skillConfigurationHash: null,
      preferenceConfigurationHash: null,
      idempotencyKeyHash: "a".repeat(64),
      reservedAt: NOW,
    },
    trace,
    payloadAuthorityInput,
    payloadAuthority,
    boundAt: BOUND_AT,
  };
}

async function predispatchReceipt(
  messagePayloadHash = inspection("a").messagePayloadHash,
): Promise<ModelHubExactEvaluationPredispatchReceipt> {
  const exact = inspection("a");
  const liveTarget = exactTargetRow("a");
  const costProfileHash = await sha256Hex(testCanonicalJson(testCostProjection(liveTarget)));
  const targetIdentityHash = await testTargetIdentityHash(
    liveTarget,
    exact.target.capabilityEvidenceHash,
    costProfileHash,
  );
  const target = {
    ...exact.target,
    costProfileHash,
    targetIdentityHash,
  };
  return {
    generationId: INVOCATION_ID,
    target,
    requestProfileHash: exact.requestProfileHash,
    messagePayloadHash,
    payloadHash: exact.payloadHash,
    executionLockHash: await hashModelHubExactEvaluationExecutionLock({
      targetIdentityHash,
      requestProfileHash: exact.requestProfileHash,
      payloadHash: exact.payloadHash,
      currency: exact.pricing.currency,
      estimatedMaximumCostMicros: exact.pricing.estimatedMaximumCostMicros,
    }),
    currency: exact.pricing.currency,
    estimatedMaximumCostMicros: exact.pricing.estimatedMaximumCostMicros,
    dataDestination: exact.dataDestination,
  };
}

function evaluationTrace(
  baseline: NovelSkillPaidEvaluationTraceBaselineProjection,
): ContextCompilationTrace {
  return {
    id: TRACE_ID,
    projectId: PROJECT_ID,
    chapterId: null,
    taskType: baseline.taskType,
    maximumContextTokens: baseline.maximumContextTokens,
    requiredTokens: baseline.requiredTokens,
    usedTokens: baseline.usedTokens,
    remainingTokens: baseline.remainingTokens,
    discardedTokens: baseline.discardedTokens,
    tokenEstimateSource: baseline.tokenEstimateSource,
    createdAt: NOW,
    execution: {
      generationId: INVOCATION_ID,
      generationRunId: null,
      modelInvocationId: INVOCATION_ID,
    },
    outputCandidateId: null,
    entries: baseline.entries.map(({ sources, ...entry }) => ({
      ...entry,
      sources: sources.map(({ sourceType, sourceId, sourceVersionId, locator, contentHash }) => ({
        sourceType,
        sourceId,
        sourceVersionId,
        locator,
        contentHash,
      })),
    })),
  };
}

async function executionResult(): Promise<ModelHubExactEvaluationExecutionResult> {
  const receipt = await predispatchReceipt();
  return {
    text: VISIBLE_OUTPUT,
    usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0 },
    streamed: true,
    visibleOutputHash: await sha256Hex(VISIBLE_OUTPUT),
    visibleContentLength: Array.from(VISIBLE_OUTPUT).length,
    estimatedActualCostMicros: "1",
    currency: receipt.currency,
    dataDestination: receipt.dataDestination,
    target: receipt.target,
    requestProfileHash: receipt.requestProfileHash,
    messagePayloadHash: receipt.messagePayloadHash,
    payloadHash: receipt.payloadHash,
    executionLockHash: receipt.executionLockHash,
  };
}

function candidateSnapshot(contentChecksum: string): AiCandidateSnapshot {
  return {
    id: CANDIDATE_ID,
    projectId: PROJECT_ID,
    chapterId: null,
    source: "generate",
    baseVersionId: null,
    content: VISIBLE_OUTPUT,
    contentChecksum,
    status: "ready",
    revision: 1,
    incomplete: false,
    createdAt: COMPLETED_AT,
    updatedAt: COMPLETED_AT,
    decidedAt: null,
  } as AiCandidateSnapshot;
}

function settlementReservationRow(result: ModelHubExactEvaluationExecutionResult) {
  return {
    attempt_id: ATTEMPT_ID,
    planned_context_trace_id: TRACE_ID,
    planned_model_invocation_id: INVOCATION_ID,
    planned_candidate_id: CANDIDATE_ID,
    target_hash: result.target.targetIdentityHash,
    pricing_snapshot_hash: result.target.costProfileHash,
    request_profile_hash: result.requestProfileHash,
    message_payload_hash: result.messagePayloadHash,
    request_payload_hash: result.payloadHash,
    execution_lock_hash: result.executionLockHash,
    data_destination: result.dataDestination,
    currency: result.currency,
    reserved_max_cost_micros: "2",
    input_rate: "1000",
    output_rate: "2000",
    cached_input_rate: "500",
    maximum_input_tokens: 7_000,
    maximum_output_tokens: 64,
  };
}

function failureReservationRow() {
  return {
    run_id: RUN_ID,
    attempt_id: ATTEMPT_ID,
    planned_model_invocation_id: INVOCATION_ID,
    target_hash: "1".repeat(64),
    pricing_snapshot_hash: "2".repeat(64),
    request_profile_hash: "3".repeat(64),
    request_payload_hash: "4".repeat(64),
    currency: "USD",
    reserved_max_cost_micros: "2",
    input_rate: "1000",
    output_rate: "2000",
    cached_input_rate: "500",
    maximum_input_tokens: 7_000,
    maximum_output_tokens: 64,
  };
}

function dispatchTargetRow(input: ReserveAndBindNovelSkillPaidEvaluationDispatchInput) {
  return {
    target_hash: input.reservation.receipt.target.targetIdentityHash,
    pricing_snapshot_hash: input.reservation.receipt.target.costProfileHash,
    connection_id: input.reservation.receipt.target.connectionId,
    catalog_entry_id: input.reservation.receipt.target.catalogEntryId,
    provider_kind_snapshot: input.reservation.receipt.target.providerKind,
    provider_model_id_snapshot: input.reservation.receipt.target.modelId,
    connection_revision: input.reservation.receipt.target.connectionRevision,
    catalog_revision: input.reservation.receipt.target.catalogRevision,
    cost_profile_revision: input.reservation.receipt.target.costPrivacyRevision,
    currency: input.reservation.receipt.currency,
    input_rate: "1000",
    output_rate: "2000",
    data_destination: input.reservation.receipt.dataDestination,
    maximum_input_tokens: 7_000,
    maximum_output_tokens: 64,
    suite_id: SUITE_ID,
    fixture_id: FIXTURE_ID,
    task_type: "continuation",
    invocation_mode: input.payloadAuthority.manifest.invocationMode,
    fixture_contract_hash: input.payloadAuthority.manifest.fixtureContractHash,
    fixture_input_content_hash: input.payloadAuthority.manifest.fixtureInputContentHash,
    arm: input.payloadAuthority.manifest.arm,
    arm_configuration_hash: input.payloadAuthority.manifest.armConfigurationHash,
    repetition: 1,
    protocol_hash: PROTOCOL_HASH,
    request_profile_hash: input.reservation.receipt.requestProfileHash,
    context_baseline_hash: input.reservation.contextBaselineHash,
    prompt_template_hash: input.reservation.promptTemplateHash,
  };
}

async function capturePredispatchAuthorityRow(
  input: ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
): Promise<Readonly<Record<string, SqlPrimitive>>> {
  let state: ReservationState | null = null;
  let revision = 0;
  const captured: {
    snapshot: Readonly<Record<string, SqlPrimitive>> | null;
  } = { snapshot: null };
  const executor = new StubSqlExecutor({
    select: (query) => {
      if (query.includes("FROM model_provider_connections AS connection")) {
        return [exactTargetRow("a")];
      }
      if (query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
        return captured.snapshot === null ? [] : [captured.snapshot];
      }
      if (query.includes("WHERE attempt_id = ?")) {
        return state === null ? [] : [reservationRow(state, revision, ATTEMPT_ID)];
      }
      if (query.includes("FROM novel_skill_evaluation_run_model_targets")) {
        return [dispatchTargetRow(input)];
      }
      if (query.includes("WHERE id = ?")) {
        return state === null ? [] : [reservationRow(state, revision, ATTEMPT_ID)];
      }
      throw new Error(`Unexpected authority capture select: ${query}`);
    },
    execute: (query, values) => {
      if (query.includes("INSERT INTO novel_skill_evaluation_dispatch_reservations")) {
        state = "reserved";
        revision = 1;
      }
      if (query.includes("INSERT INTO novel_skill_evaluation_predispatch_authority_snapshots")) {
        captured.snapshot = snapshotRowFromInsert(query, values, input);
      }
      if (query.includes("SET state = 'bound'")) {
        state = "bound";
        revision = 2;
      }
      return { rowsAffected: 1 };
    },
  });
  await new NovelSkillPaidEvaluationSqliteStore(executor).reserveAndBindAttemptDispatch(input);
  if (captured.snapshot === null) throw new Error("The authority snapshot was not captured.");
  return captured.snapshot;
}

function snapshotRowFromInsert(
  query: string,
  values: readonly SqlPrimitive[],
  input: ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
): Readonly<Record<string, SqlPrimitive>> {
  const columnList = /\(([\s\S]*?)\)\s*VALUES\s*\(/u.exec(query)?.[1];
  if (columnList === undefined) throw new Error("Authority insert columns are unavailable.");
  const columns = columnList.split(",").map((column) => column.trim());
  if (columns.length !== values.length) {
    throw new Error("Authority insert columns and values are misaligned.");
  }
  return Object.freeze({
    ...Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null])),
    authorization_id: input.reservation.authorizationId,
    attempt_id: input.reservation.attemptId,
    dispatch_generation: input.reservation.dispatchGeneration,
    planned_context_trace_id: input.reservation.plannedContextTraceId,
    planned_model_invocation_id: input.reservation.plannedModelInvocationId,
    planned_candidate_id: input.reservation.plannedCandidateId,
    idempotency_key_hash: input.reservation.idempotencyKeyHash,
    reservation_run_id: input.reservation.runId,
    reservation_cell_id: input.reservation.cellId,
    reservation_model_slot_id: input.reservation.modelSlotId,
    reservation_target_hash: input.reservation.receipt.target.targetIdentityHash,
    reservation_pricing_snapshot_hash: input.reservation.receipt.target.costProfileHash,
    reservation_request_profile_hash: input.reservation.receipt.requestProfileHash,
    reservation_message_payload_hash: input.reservation.receipt.messagePayloadHash,
    reservation_request_payload_hash: input.reservation.receipt.payloadHash,
    reservation_execution_lock_hash: input.reservation.receipt.executionLockHash,
    reservation_payload_authority_manifest_hash: input.payloadAuthority.manifestHash,
    reservation_currency: input.reservation.receipt.currency,
    reservation_data_destination: input.reservation.receipt.dataDestination,
    reservation_reserved_max_cost_micros: "8",
    reservation_reserved_at: input.reservation.reservedAt,
  });
}

function operationLabels(executor: StubSqlExecutor): readonly string[] {
  return executor.operations.map((operation) => {
    if (operation.kind === "transaction") return `transaction:${operation.phase}`;
    return `${operation.kind}:${sqlOperationLabel(operation.query)}`;
  });
}

function sqlOperationLabel(query: string): string {
  const isSelect = query.trimStart().startsWith("SELECT");
  if (isSelect && query.includes("novel_skill_evaluation_predispatch_authority_snapshots")) {
    return "authority:read";
  }
  if (isSelect && query.includes("SELECT count(*) AS valid")) {
    return query.includes("INNER JOIN novel_skill_evaluation_attempts")
      ? "reservation:assert-bound"
      : "reservation:assert-idempotent-input";
  }
  if (
    isSelect &&
    query.includes("reserved_max_cost_micros") &&
    query.includes("state = 'dispatched'")
  ) {
    return "reservation:read-settlement";
  }
  if (isSelect && query.includes("WHERE attempt_id = ?")) return "reservation:read-attempt";
  if (isSelect && query.includes("FROM model_provider_connections AS connection")) {
    return "target:read-live";
  }
  if (isSelect && query.includes("FROM novel_skill_evaluation_run_model_targets")) {
    return "target:read";
  }
  if (isSelect && query.includes("WHERE id = ?")) return "reservation:read-id";
  if (query.includes("INSERT INTO novel_skill_evaluation_dispatch_reservations")) {
    return "reservation:insert";
  }
  if (query.includes("INSERT INTO novel_skill_evaluation_predispatch_authority_snapshots")) {
    return "authority:insert";
  }
  if (query.includes("INSERT INTO context_compilation_runs")) return "trace:insert-run";
  if (query.includes("INSERT INTO context_compilation_entries")) return "trace:insert-entry";
  if (query.includes("INSERT INTO context_compilation_entry_sources")) {
    return "trace:insert-source";
  }
  if (query.includes("INSERT INTO context_compilation_execution_links")) {
    return "trace:link-execution";
  }
  if (query.includes("INSERT INTO model_invocation_facts")) return "invocation:insert";
  if (query.includes("INSERT INTO context_compilation_model_invocation_links")) {
    return "trace:link-invocation";
  }
  if (query.includes("SET context_trace_id = ?")) return "attempt:bind";
  if (query.includes("SET state = 'bound'")) return "reservation:bind";
  if (query.includes("SET status = 'succeeded'") && query.includes("model_invocation_facts")) {
    return "invocation:settle";
  }
  if (query.includes("INSERT INTO ai_candidates")) return "candidate:insert";
  if (query.includes("INSERT INTO context_compilation_output_candidate_links")) {
    return "trace:link-output";
  }
  if (query.includes("SET status = 'succeeded'") && query.includes("evaluation_attempts")) {
    return "attempt:settle";
  }
  if (query.includes("SET state = 'settled'")) return "reservation:settle";
  throw new Error(`Unlabelled SQL operation: ${query}`);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function quoteExecutor(): StubSqlExecutor {
  const targets = [targetQuote("text_tier_a", "1"), targetQuote("text_tier_b", "2")];
  return new StubSqlExecutor({
    select: (query) => {
      if (query.includes("SELECT protocol.protocol_hash")) {
        return [{ protocol_hash: "a".repeat(64) }];
      }
      if (
        query.includes("FROM novel_skill_evaluation_run_model_targets") &&
        !query.includes("novel_skill_evaluation_cells")
      ) {
        return targets;
      }
      if (query.includes("FROM novel_skill_evaluation_cells AS cell")) {
        return targets.map((target) => ({
          ...target,
          task_type: "continuation",
          maximum_input_tokens: 1000,
          maximum_output_tokens: 500,
          cell_count: 96,
        }));
      }
      throw new Error(`Unexpected select: ${query}`);
    },
  });
}

function targetQuote(modelSlotId: "text_tier_a" | "text_tier_b", suffix: string) {
  return {
    model_slot_id: modelSlotId,
    currency: "USD",
    input_rate: "1000",
    output_rate: "2000",
    target_hash: suffix.repeat(64),
    pricing_snapshot_hash: (suffix === "1" ? "3" : "4").repeat(64),
    connection_id: `connection-${suffix}`,
    catalog_entry_id: `catalog-${suffix}`,
    model_identity_hash: (suffix === "1" ? "5" : "6").repeat(64),
    model_artifact_hash: (suffix === "1" ? "7" : "8").repeat(64),
  };
}

function reservationRow(
  state: ReservationState,
  revision: number,
  attemptId: string,
  id = RESERVATION_ID,
) {
  return {
    id,
    run_id: RUN_ID,
    cell_id: CELL_ID,
    attempt_id: attemptId,
    state,
    planned_context_trace_id: "019f9f4a-b3c7-7350-8000-000000000111",
    planned_model_invocation_id: INVOCATION_ID,
    planned_candidate_id: "019f9f4a-b3c7-7350-8000-000000000112",
    revision,
  };
}

function exactTargetRow(suffix: "a" | "b") {
  return {
    connection_id: `connection-${suffix}`,
    provider_kind: "deepseek",
    protocol: "openai_compatible",
    region: null,
    workspace_id: null,
    endpoint_id: null,
    base_url: "https://api.example.test/v1",
    credential_ref: `keyring:model-hub:connection-${suffix}`,
    credential_state: "present",
    authentication_mode: "bearer",
    credential_header_name: null,
    model_discovery_path: "/models",
    text_generation_path: "/chat/completions",
    embedding_path: null,
    request_timeout_ms: 30_000,
    retry_limit: 0,
    connection_status: "ready",
    connection_enabled: 1,
    connection_revision: 1,
    catalog_id: `catalog-${suffix}`,
    catalog_connection_id: `connection-${suffix}`,
    provider_model_id: `model-${suffix}`,
    catalog_source: "provider",
    availability: "available",
    lifecycle: "active",
    input_token_limit: 64_000,
    output_token_limit: 8_192,
    stale_after: null,
    catalog_revision: 1,
    currency: "USD",
    input_rate: "1000",
    output_rate: "2000",
    cached_input_rate: "500",
    pricing_version: "price@1",
    price_updated_at: NOW,
    data_destination: "remote",
    retention_policy: "provider_policy",
    training_policy: "provider_policy",
    evidence_source: "user_confirmed",
    evidence_version: "price@1",
    evidence_summary: null,
    evidence_updated_at: NOW,
    cost_revision: 1,
    cost_created_at: NOW,
    cost_updated_at: NOW,
  } as const;
}

function testCostProjection(row: ReturnType<typeof exactTargetRow>) {
  return {
    catalogEntryId: row.catalog_id,
    currency: row.currency,
    inputMicrosPerMillionTokens: row.input_rate,
    outputMicrosPerMillionTokens: row.output_rate,
    cachedInputMicrosPerMillionTokens: row.cached_input_rate,
    pricingVersion: row.pricing_version,
    priceUpdatedAt: row.price_updated_at,
    dataDestination: row.data_destination,
    retentionPolicy: row.retention_policy,
    trainingPolicy: row.training_policy,
    evidenceSource: row.evidence_source,
    evidenceVersion: row.evidence_version,
    evidenceSummary: row.evidence_summary,
    evidenceUpdatedAt: row.evidence_updated_at,
    revision: row.cost_revision,
    createdAt: row.cost_created_at,
    updatedAt: row.cost_updated_at,
  };
}

function testFinalDispatchIdentity(row: ReturnType<typeof exactTargetRow>): string {
  return JSON.stringify([
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    row.connection_id,
    row.connection_revision,
    true,
    row.provider_kind,
    row.protocol,
    row.base_url,
    row.credential_ref,
    row.credential_state,
    row.catalog_id,
    row.catalog_revision,
    row.catalog_connection_id,
    row.provider_model_id,
    row.availability,
    row.lifecycle,
    row.stale_after,
    row.cost_revision,
    `connection-${row.connection_id.slice("connection-".length)}`,
    "open_ai_compatible",
    row.base_url,
    row.authentication_mode,
    null,
    null,
    null,
    null,
    row.request_timeout_ms,
    row.retry_limit,
  ]);
}

async function testTargetIdentityHash(
  row: ReturnType<typeof exactTargetRow>,
  capabilityEvidenceHash: string,
  costProfileHash: string,
): Promise<string> {
  return sha256Hex(
    testCanonicalJson({
      version: "model-hub-exact-evaluation-target@1",
      finalDispatchIdentity: testFinalDispatchIdentity(row),
      capabilityEvidenceHash,
      costProfileHash,
    }),
  );
}

function persistedTargetFromValues(values: readonly SqlPrimitive[]) {
  const keys = [
    "run_id",
    "model_slot_id",
    "connection_id",
    "catalog_entry_id",
    "provider_kind_snapshot",
    "connection_protocol_snapshot",
    "connection_revision",
    "connection_configuration_hash",
    "catalog_revision",
    "provider_model_id_snapshot",
    "catalog_identity_hash",
    "model_identity_hash",
    "model_artifact_hash",
    "artifact_identity_source",
    "cost_profile_revision",
    "currency",
    "input_micros_per_million_tokens",
    "output_micros_per_million_tokens",
    "cached_input_micros_per_million_tokens",
    "pricing_version",
    "price_updated_at",
    "pricing_snapshot_hash",
    "target_hash",
    "created_at",
  ] as const;
  return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? null]));
}

function testCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(testCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${testCanonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function inspection(suffix: string): ModelHubExactEvaluationInspection {
  return {
    target: {
      connectionId: `connection-${suffix}`,
      catalogEntryId: `catalog-${suffix}`,
      providerKind: "deepseek",
      modelId: `model-${suffix}`,
      connectionRevision: 1,
      catalogRevision: 1,
      costPrivacyRevision: 1,
      capabilityEvidenceHash: "1".repeat(64),
      costProfileHash: "2".repeat(64),
      targetIdentityHash: "3".repeat(64),
    },
    requestProfile: {
      version: "model-hub-exact-evaluation-request@1",
      task: "prose_generation",
      maximumInputTokens: 7_000,
      maximumOutputTokens: 64,
      temperatureBasisPoints: 0,
      topPBasisPoints: 10_000,
      reasoningMode: "disabled",
      responseFormat: "text",
      streaming: true,
      stopPolicyHash: MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
      providerCallPolicy: "single_attempt",
    },
    requestProfileHash: "4".repeat(64),
    messagePayloadHash: "7".repeat(64),
    payloadHash: "5".repeat(64),
    executionLockHash: "6".repeat(64),
    requiredCapabilities: ["text_generation"],
    dataDestination: "remote",
    estimatedInputTokens: 10,
    estimatedTotalTokens: 74,
    inputTokenLimit: 1000,
    outputTokenLimit: 1000,
    pricing: {
      currency: "USD",
      estimatedMaximumCostMicros: "1",
      pricingVersion: "price@1",
      priceUpdatedAt: NOW,
      evidenceSource: "user_confirmed",
      evidenceVersion: "price@1",
      evidenceUpdatedAt: NOW,
    },
  };
}
