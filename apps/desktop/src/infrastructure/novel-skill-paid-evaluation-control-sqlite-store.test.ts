import {
  NOVEL_SKILL_EVALUATION_ARMS,
  NOVEL_SKILL_EVALUATION_METRICS,
  listNovelSkillEvaluationFixtures,
  type NovelSkillEvaluationMetric,
} from "@inkshadow/ai-core";
import type {
  ExecuteResult,
  SqlExecutor,
  SqlPrimitive,
  TransactionExecutor,
} from "@inkshadow/data";
import { describe, expect, it, vi } from "vitest";

import {
  NOVEL_SKILL_PAID_EVALUATION_EXPECTED_SCORE_COUNT,
  NovelSkillPaidEvaluationControlSqliteStore,
  type CreateNovelSkillPaidEvaluationBlindReviewBatchInput,
  type SealNovelSkillPaidEvaluationBlindScoresInput,
} from "./novel-skill-paid-evaluation-control-sqlite-store";

const RUN_ID = uuid(1);
const SUITE_ID = uuid(2);
const BATCH_ID = uuid(3);
const CELL_ID = uuid(4);
const NOW = "2026-08-11T00:00:00.000Z";
const SCORED_AT = "2026-08-11T00:01:00.000Z";
const SEALED_AT = "2026-08-11T00:01:01.000Z";
const REVIEWER_ID = "local-reviewer-1";
const OTHER_REVIEWER_ID = "local-reviewer-2";

describe("NovelSkillPaidEvaluationControlSqliteStore", () => {
  it("returns content-free control, target, reservation, recovery and repair read models", async () => {
    const executor = new StubSqlExecutor({
      select: (query) => {
        if (query.includes("AS protocol_configured")) return [controlSnapshotRow()];
        if (query.includes("WHERE run.status IN ('planned','running')")) {
          return [recoverableRow()];
        }
        if (query.includes("AS execution_protocol_hash")) {
          return [executionAuthorityRow()];
        }
        if (query.includes("FROM novel_skill_evaluation_run_model_targets AS target")) {
          return [targetRow()];
        }
        if (
          query.includes("FROM novel_skill_evaluation_dispatch_reservations AS reservation") &&
          !query.includes("LEFT JOIN novel_skill_evaluation_observations")
        ) {
          return [reservationRow()];
        }
        if (query.includes("LEFT JOIN novel_skill_evaluation_observations")) {
          return [settledUnobservedRow()];
        }
        throw new Error(`Unexpected select: ${query}`);
      },
    });
    const store = new NovelSkillPaidEvaluationControlSqliteStore(executor);

    await expect(store.getControlSnapshot(RUN_ID)).resolves.toMatchObject({
      runId: RUN_ID,
      protocolConfigured: true,
      exactTargetCount: 2,
      completedAt: null,
      reservationCounts: {
        reserved: 1,
        bound: 2,
        dispatched: 0,
        settled: 37,
        ambiguous: 0,
        notDispatched: 1,
      },
    });
    await expect(store.listRecoverableRuns()).resolves.toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        recoveryKind: "safe_local_resume",
        requiresManualDispatchDecision: false,
      }),
    ]);
    await expect(store.readExecutionAuthority(RUN_ID)).resolves.toEqual({
      runId: RUN_ID,
      status: "running",
      protocolHash: "1".repeat(64),
      authorizationId: uuid(9),
      quoteHash: "2".repeat(64),
    });
    await expect(store.listTargets(RUN_ID)).resolves.toEqual([
      expect.objectContaining({
        modelSlotId: "text_tier_a",
        providerModelId: "exact-provider-model-a",
        currency: "USD",
      }),
    ]);
    await expect(store.listReservations(RUN_ID)).resolves.toEqual([
      expect.objectContaining({
        reservationId: uuid(10),
        state: "settled",
        settlementReceiptHash: "9".repeat(64),
      }),
    ]);
    await expect(store.listSettledUnobserved(RUN_ID)).resolves.toEqual([
      {
        reservationId: uuid(10),
        runId: RUN_ID,
        cellId: CELL_ID,
        attemptId: uuid(5),
        contextTraceId: uuid(6),
        modelInvocationId: uuid(7),
        outputCandidateId: uuid(8),
        terminalAt: SEALED_AT,
        revision: 4,
      },
    ]);

    for (const operation of executor.operations) {
      if (operation.kind !== "select") continue;
      expect(operation.query).not.toMatch(
        /\barm\b|model_assignments_json|prompt_text|candidate_text|reasoning|credential|base_url|fixture_id|input_content/u,
      );
    }
  });

  it("classifies interrupted dispatches as requiring a manual decision", async () => {
    const executor = new StubSqlExecutor({
      select: () => [
        recoverableRow({ dispatched_count: 1 }),
        recoverableRow({
          run_id: uuid(40),
          ambiguous_count: 1,
          successful_settlement_count: 12,
        }),
        recoverableRow({
          run_id: uuid(41),
          status: "planned",
          authorization_id: uuid(42),
          authorized_call_count: 192,
        }),
      ],
    });
    const store = new NovelSkillPaidEvaluationControlSqliteStore(executor);

    const rows = await store.listRecoverableRuns();

    expect(rows.map(({ recoveryKind }) => recoveryKind)).toEqual([
      "manual_dispatch_decision",
      "manual_dispatch_decision",
      "authorized_not_started",
    ]);
    expect(
      rows
        .slice(0, 2)
        .every(({ requiresManualDispatchDecision }) => requiresManualDispatchDecision),
    ).toBe(true);
  });

  it("creates one blinded batch and exact randomized positions 1 through 192 atomically", async () => {
    const observations = observationRows();
    const input = batchInput();
    const executor = blindBatchExecutor(observations);
    const store = new NovelSkillPaidEvaluationControlSqliteStore(
      executor,
      deterministicRandomSource(1),
    );

    const result = await store.createBlindReviewBatch(input);

    expect(result).toMatchObject({
      batchId: BATCH_ID,
      runId: RUN_ID,
      reviewerId: REVIEWER_ID,
      itemCount: 192,
      createdAt: NOW,
    });
    expect(result.observationSetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.assignmentManifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(result).sort()).toEqual(
      [
        "assignmentManifestHash",
        "batchId",
        "createdAt",
        "itemCount",
        "observationSetHash",
        "reviewerId",
        "runId",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(/arm|model|observationId/u);
    expect(executor.transactionCount).toBe(1);
    expect(executor.executions).toHaveLength(193);
    const itemWrites = executor.executions.filter(({ query }) =>
      query.includes("novel_skill_evaluation_review_items"),
    );
    expect(itemWrites).toHaveLength(192);
    expect(itemWrites.map(({ values }) => values[3])).toEqual(
      Array.from({ length: 192 }, (_, index) => index + 1),
    );
    expect(new Set(itemWrites.map(({ values }) => values[2]))).toEqual(
      new Set(observations.map(({ id }) => id)),
    );
    expect(itemWrites.every(({ values }) => /^blind-[0-9a-f]{64}$/u.test(String(values[1])))).toBe(
      true,
    );
    expect(itemWrites.every(({ values }) => values[1] !== values[2])).toBe(true);
    expect(executor.operations.at(0)).toEqual({ kind: "transaction", phase: "begin" });
    expect(executor.operations.at(-1)).toEqual({ kind: "transaction", phase: "commit" });

    for (const operation of executor.operations) {
      if (operation.kind === "transaction") continue;
      if (operation.kind === "execute") {
        expect(operation.values).not.toEqual(expect.arrayContaining(["no_skill", "text_tier_a"]));
      }
    }
  });

  it("rejects caller-provided observation or model assignments before opening a transaction", async () => {
    const clean = batchInput();
    const contaminated = {
      ...clean,
      observationId: uuid(1_999),
      arm: "core",
      modelSlotId: "text_tier_a",
    } as unknown as CreateNovelSkillPaidEvaluationBlindReviewBatchInput;
    const executor = blindBatchExecutor(observationRows());
    const store = new NovelSkillPaidEvaluationControlSqliteStore(
      executor,
      deterministicRandomSource(1),
    );

    await expect(store.createBlindReviewBatch(contaminated)).rejects.toMatchObject({
      code: "NOVEL_SKILL_EVALUATION_INVALID",
    });
    expect(executor.transactionCount).toBe(0);
    expect(executor.operations).toHaveLength(0);
  });

  it("rolls back the blind batch when any assignment loses its CAS write", async () => {
    const observations = observationRows();
    let reviewItemWrite = 0;
    const executor = blindBatchExecutor(observations, (query) => {
      if (query.includes("novel_skill_evaluation_review_items")) {
        reviewItemWrite += 1;
        if (reviewItemWrite === 81) return { rowsAffected: 0 };
      }
      return { rowsAffected: 1 };
    });
    const store = new NovelSkillPaidEvaluationControlSqliteStore(
      executor,
      deterministicRandomSource(1),
    );

    await expect(store.createBlindReviewBatch(batchInput())).rejects.toMatchObject({
      code: "NOVEL_SKILL_EVALUATION_CONFLICT",
    });
    expect(executor.operations.at(-1)).toEqual({ kind: "transaction", phase: "rollback" });
  });

  it("derives non-repeating blind identities and order from fresh 256-bit seeds", async () => {
    const firstExecutor = blindBatchExecutor(observationRows());
    const secondExecutor = blindBatchExecutor(observationRows());
    await new NovelSkillPaidEvaluationControlSqliteStore(
      firstExecutor,
      deterministicRandomSource(1),
    ).createBlindReviewBatch(batchInput());
    await new NovelSkillPaidEvaluationControlSqliteStore(
      secondExecutor,
      deterministicRandomSource(47),
    ).createBlindReviewBatch(batchInput());

    const first = blindItemWrites(firstExecutor);
    const second = blindItemWrites(secondExecutor);
    expect(first.map(({ values }) => values[1])).not.toEqual(second.map(({ values }) => values[1]));
    expect(first.map(({ values }) => values[2])).not.toEqual(second.map(({ values }) => values[2]));
    expect(
      firstExecutor.executions.find(({ query }) =>
        query.includes("novel_skill_evaluation_review_batches"),
      )?.values[9],
    ).not.toBe(
      secondExecutor.executions.find(({ query }) =>
        query.includes("novel_skill_evaluation_review_batches"),
      )?.values[9],
    );
  });

  it("fails closed for a weak random source or a non-exact observation matrix", async () => {
    const weakExecutor = blindBatchExecutor(observationRows());
    const weakStore = new NovelSkillPaidEvaluationControlSqliteStore(
      weakExecutor,
      (length) => new Uint8Array(length),
    );
    await expect(weakStore.createBlindReviewBatch(batchInput())).rejects.toMatchObject({
      code: "NOVEL_SKILL_EVALUATION_INVALID",
    });
    expect(weakExecutor.operations.at(-1)).toEqual({ kind: "transaction", phase: "rollback" });

    const invalidRows = observationRows().map((row, index) =>
      index === 0 ? { ...row, fixture_id: "unknown.fixture" } : row,
    );
    const invalidExecutor = blindBatchExecutor(invalidRows);
    const invalidStore = new NovelSkillPaidEvaluationControlSqliteStore(
      invalidExecutor,
      deterministicRandomSource(1),
    );
    await expect(invalidStore.createBlindReviewBatch(batchInput())).rejects.toMatchObject({
      code: "NOVEL_SKILL_EVALUATION_CONFLICT",
    });
    expect(invalidExecutor.executions).toEqual([]);
  });

  it("returns an existing exact batch idempotently and rejects identity takeover", async () => {
    const existing = existingBlindBatchRow();
    const executor = blindBatchExecutor(observationRows(), undefined, [existing]);
    const randomSource = vi.fn(deterministicRandomSource(1));
    const store = new NovelSkillPaidEvaluationControlSqliteStore(executor, randomSource);

    await expect(store.createBlindReviewBatch(batchInput())).resolves.toEqual({
      batchId: BATCH_ID,
      runId: RUN_ID,
      reviewerId: REVIEWER_ID,
      itemCount: 192,
      observationSetHash: existing.observation_set_hash,
      assignmentManifestHash: existing.assignment_manifest_hash,
      createdAt: NOW,
    });
    expect(randomSource).not.toHaveBeenCalled();
    expect(executor.executions).toEqual([]);
    await expect(
      store.createBlindReviewBatch({
        ...batchInput(),
        createdAt: "2026-08-11T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({ createdAt: NOW });

    const takeoverExecutor = blindBatchExecutor(observationRows(), undefined, [
      { ...existing, reviewer_id: OTHER_REVIEWER_ID },
    ]);
    await expect(
      new NovelSkillPaidEvaluationControlSqliteStore(
        takeoverExecutor,
        deterministicRandomSource(1),
      ).createBlindReviewBatch(batchInput()),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    expect(takeoverExecutor.executions).toEqual([]);
  });

  it("returns only the reviewer-safe 192-item DTO with null or sealed local scores", async () => {
    const rows = blindProjectionRows(1);
    const executor = blindProjectionExecutor(rows);
    const store = new NovelSkillPaidEvaluationControlSqliteStore(executor);

    const batch = await store.readBlindReviewBatch({
      batchId: BATCH_ID,
      reviewerId: REVIEWER_ID,
    });
    const next = await store.getNextBlindReviewItem({
      batchId: BATCH_ID,
      reviewerId: REVIEWER_ID,
    });

    expect(batch).toHaveLength(192);
    expect(batch[0]?.scores).toEqual(completeNullableScores(0.75));
    expect(next?.position).toBe(2);
    expect(Object.keys(batch[0] ?? {})).toEqual([
      "blindItemId",
      "position",
      "fixtureTaskContent",
      "boundaries",
      "lockedFacts",
      "requestedOutcome",
      "candidateOutput",
      "scores",
    ]);
    expect(collectKeys(batch)).not.toEqual(
      expect.arrayContaining([
        "arm",
        "model",
        "modelId",
        "modelSlotId",
        "slot",
        "repetition",
        "cost",
        "hash",
        "observationId",
      ]),
    );
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch[0]?.scores)).toBe(true);
  });

  it("fails closed on reviewer mismatch, injected identity, or partial score evidence", async () => {
    const deniedStore = new NovelSkillPaidEvaluationControlSqliteStore(blindProjectionExecutor([]));
    await expect(
      deniedStore.readBlindReviewBatch({ batchId: BATCH_ID, reviewerId: OTHER_REVIEWER_ID }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    await expect(
      deniedStore.getNextBlindReviewItem({
        batchId: BATCH_ID,
        reviewerId: OTHER_REVIEWER_ID,
        observationId: uuid(9_999),
      } as never),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_INVALID" });

    const partial = blindProjectionRows().flatMap((row, index) =>
      index === 0
        ? [{ ...row, metric: NOVEL_SKILL_EVALUATION_METRICS[0], score_basis_points: 5_000 }]
        : [row],
    );
    await expect(
      new NovelSkillPaidEvaluationControlSqliteStore(
        blindProjectionExecutor(partial),
      ).readBlindReviewBatch({ batchId: BATCH_ID, reviewerId: REVIEWER_ID }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
  });

  it("seals exactly 13 rubric scores, a receipt, and the cell state in one transaction", async () => {
    const executor = scoreExecutor();
    const store = new NovelSkillPaidEvaluationControlSqliteStore(executor);

    const receipt = await store.sealBlindScores(scoreInput());

    expect(receipt).toMatchObject({
      batchId: BATCH_ID,
      blindItemId: blindItemId(1),
      reviewerId: REVIEWER_ID,
      rubricVersion: "novel-skill-human-rubric@1",
      metricCount: 13,
    });
    expect(receipt.scoresManifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(receipt)).not.toMatch(/arm|model|observation|cell/u);
    expect(executor.transactionCount).toBe(1);
    const scoreWrites = executor.executions.filter(({ query }) =>
      query.includes("INSERT INTO novel_skill_evaluation_scores"),
    );
    expect(scoreWrites).toHaveLength(13);
    expect(scoreWrites.map(({ values }) => values[1])).toEqual([...NOVEL_SKILL_EVALUATION_METRICS]);
    expect(scoreWrites.map(({ values }) => values[2])).toEqual(
      Array.from({ length: 13 }, () => 7_500),
    );
    expect(executor.executions.at(13)?.query).toContain("novel_skill_evaluation_review_receipts");
    expect(executor.executions.at(14)?.query).toContain("SET state = 'observed'");
    expect(executor.operations.at(-1)).toEqual({ kind: "transaction", phase: "commit" });
  });

  it("rejects incomplete scores before writing and rolls back a lost cell CAS", async () => {
    const incomplete = {
      ...scoreInput(),
      scores: Object.fromEntries(
        NOVEL_SKILL_EVALUATION_METRICS.slice(0, 12).map((metric) => [metric, 1]),
      ),
    } as unknown as SealNovelSkillPaidEvaluationBlindScoresInput;
    const unused = scoreExecutor();
    const unusedStore = new NovelSkillPaidEvaluationControlSqliteStore(unused);

    await expect(unusedStore.sealBlindScores(incomplete)).rejects.toMatchObject({
      code: "NOVEL_SKILL_EVALUATION_INVALID",
    });
    expect(unused.transactionCount).toBe(0);

    const lostCas = scoreExecutor((query) =>
      query.includes("SET state = 'observed'") ? { rowsAffected: 0 } : { rowsAffected: 1 },
    );
    const store = new NovelSkillPaidEvaluationControlSqliteStore(lostCas);
    await expect(store.sealBlindScores(scoreInput())).rejects.toMatchObject({
      code: "NOVEL_SKILL_EVALUATION_CONFLICT",
    });
    expect(lostCas.operations.at(-1)).toEqual({ kind: "transaction", phase: "rollback" });
  });

  it("makes an identical sealed-score retry idempotent and rejects reviewer takeover", async () => {
    const firstExecutor = scoreExecutor();
    const firstReceipt = await new NovelSkillPaidEvaluationControlSqliteStore(
      firstExecutor,
    ).sealBlindScores(scoreInput());
    const retryExecutor = scoreExecutor(undefined, {
      cell_state: "observed",
      receipt_scores_manifest_hash: firstReceipt.scoresManifestHash,
      receipt_scored_at: SCORED_AT,
      receipt_sealed_at: SEALED_AT,
      persisted_score_count: 13,
    });

    await expect(
      new NovelSkillPaidEvaluationControlSqliteStore(retryExecutor).sealBlindScores(scoreInput()),
    ).resolves.toEqual(firstReceipt);
    expect(retryExecutor.executions).toEqual([]);
    expect(retryExecutor.operations.at(-1)).toEqual({ kind: "transaction", phase: "commit" });

    const deniedExecutor = new StubSqlExecutor({ select: () => [] });
    await expect(
      new NovelSkillPaidEvaluationControlSqliteStore(deniedExecutor).sealBlindScores({
        ...scoreInput(),
        reviewerId: OTHER_REVIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_EVALUATION_CONFLICT" });
    expect(deniedExecutor.executions).toEqual([]);
    expect(deniedExecutor.operations.at(-1)).toEqual({
      kind: "transaction",
      phase: "rollback",
    });
  });

  it("publishes the exact fixed score cardinality", () => {
    expect(NOVEL_SKILL_PAID_EVALUATION_EXPECTED_SCORE_COUNT).toBe(2_496);
  });
});

interface StubOptions {
  readonly select: (query: string, values: readonly SqlPrimitive[]) => readonly object[];
  readonly execute?: (query: string, values: readonly SqlPrimitive[]) => ExecuteResult;
}

type StubOperation =
  | Readonly<{ kind: "transaction"; phase: "begin" | "commit" | "rollback" }>
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
    this.operations.push({ kind: "select", query, values: [...values] });
    return Promise.resolve([...this.options.select(query, values)] as unknown as Row[]);
  }

  public execute(query: string, values: readonly SqlPrimitive[] = []): Promise<ExecuteResult> {
    const operation = { query, values: [...values] };
    this.executions.push(operation);
    this.operations.push({ kind: "execute", ...operation });
    return Promise.resolve(this.options.execute?.(query, values) ?? { rowsAffected: 1 });
  }

  public async transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    this.transactionCount += 1;
    this.operations.push({ kind: "transaction", phase: "begin" });
    try {
      const result = await operation(this);
      this.operations.push({ kind: "transaction", phase: "commit" });
      return result;
    } catch (cause: unknown) {
      this.operations.push({ kind: "transaction", phase: "rollback" });
      throw cause;
    }
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function blindBatchExecutor(
  observations: readonly object[],
  execute?: StubOptions["execute"],
  existing: readonly object[] = [],
): StubSqlExecutor {
  return new StubSqlExecutor({
    select: (query) => {
      if (
        query.includes("FROM novel_skill_evaluation_review_batches AS batch") &&
        query.includes("WHERE batch.id = ? OR batch.run_id = ?")
      ) {
        return existing;
      }
      if (query.includes("SELECT protocol.protocol_hash")) return [blindProtocolRow()];
      if (query.includes("cell.fixture_id, cell.arm")) return observations;
      throw new Error(`Unexpected select: ${query}`);
    },
    ...(execute === undefined ? {} : { execute }),
  });
}

function blindProjectionExecutor(rows: readonly object[]): StubSqlExecutor {
  return new StubSqlExecutor({
    select: (query, values) => {
      if (!query.includes("candidate.content AS candidate_output")) {
        throw new Error(`Unexpected select: ${query}`);
      }
      if (values[1] !== REVIEWER_ID) return [];
      return rows;
    },
  });
}

function scoreExecutor(
  execute?: StubOptions["execute"],
  rowOverrides: Readonly<Record<string, unknown>> = {},
): StubSqlExecutor {
  return new StubSqlExecutor({
    select: (query) => {
      if (!query.includes("FROM novel_skill_evaluation_review_batches AS batch")) {
        throw new Error(`Unexpected select: ${query}`);
      }
      return [
        {
          run_id: RUN_ID,
          reviewer_id: REVIEWER_ID,
          rubric_version: "novel-skill-human-rubric@1",
          rubric_content_hash: "2".repeat(64),
          observation_id: uuid(100),
          cell_id: CELL_ID,
          cell_state: "planned",
          assigned_at: NOW,
          receipt_scores_manifest_hash: null,
          receipt_scored_at: null,
          receipt_sealed_at: null,
          persisted_score_count: 0,
          ...rowOverrides,
        },
      ];
    },
    ...(execute === undefined ? {} : { execute }),
  });
}

function batchInput(): CreateNovelSkillPaidEvaluationBlindReviewBatchInput {
  return {
    batchId: BATCH_ID,
    runId: RUN_ID,
    reviewerId: REVIEWER_ID,
    createdAt: NOW,
  };
}

function scoreInput(): SealNovelSkillPaidEvaluationBlindScoresInput {
  return {
    batchId: BATCH_ID,
    blindItemId: blindItemId(1),
    reviewerId: REVIEWER_ID,
    scores: Object.fromEntries(
      NOVEL_SKILL_EVALUATION_METRICS.map((metric) => [metric, 0.75]),
    ) as Readonly<Record<NovelSkillEvaluationMetric, number>>,
    scoredAt: SCORED_AT,
    sealedAt: SEALED_AT,
  };
}

function observationRows(): readonly Readonly<{
  id: string;
  result_hash: string;
  fixture_id: string;
  arm: string;
  model_slot_id: string;
  repetition: number;
}>[] {
  let index = 0;
  return listNovelSkillEvaluationFixtures().flatMap(({ fixtureId }) =>
    NOVEL_SKILL_EVALUATION_ARMS.flatMap((arm) =>
      (["text_tier_a", "text_tier_b"] as const).flatMap((modelSlotId) =>
        ([1, 2] as const).map((repetition) => {
          index += 1;
          return {
            id: uuid(1000 + index),
            result_hash: index.toString(16).padStart(64, "0"),
            fixture_id: fixtureId,
            arm,
            model_slot_id: modelSlotId,
            repetition,
          };
        }),
      ),
    ),
  );
}

function deterministicRandomSource(offset: number): (byteLength: number) => Uint8Array {
  return (byteLength) =>
    Uint8Array.from({ length: byteLength }, (_, index) => (index + offset) % 256);
}

function blindProtocolRow() {
  return {
    protocol_hash: "1".repeat(64),
    rubric_version: "novel-skill-human-rubric@1",
    rubric_content_hash: "2".repeat(64),
    blinding_protocol_version: "blind-review@1",
    blinding_protocol_hash: "3".repeat(64),
    randomization_protocol_version: "randomized-review@1",
    randomization_protocol_hash: "4".repeat(64),
  };
}

function existingBlindBatchRow() {
  return {
    id: BATCH_ID,
    run_id: RUN_ID,
    reviewer_id: REVIEWER_ID,
    observation_set_hash: "5".repeat(64),
    assignment_manifest_hash: "6".repeat(64),
    created_at: NOW,
    item_count: 192,
    position_count: 192,
    observation_count: 192,
  };
}

function blindProjectionRows(scoredPosition?: number): readonly object[] {
  const fixtures = listNovelSkillEvaluationFixtures();
  return Array.from({ length: 192 }, (_, index) => {
    const position = index + 1;
    const base = {
      blind_item_id: blindItemId(position),
      randomized_position: position,
      fixture_id: fixtures[index % fixtures.length]?.fixtureId ?? "missing.fixture",
      candidate_output: `隔离 Candidate 正文 ${String(position)}`,
    };
    if (position !== scoredPosition) {
      return [{ ...base, metric: null, score_basis_points: null }];
    }
    return NOVEL_SKILL_EVALUATION_METRICS.map((metric) => ({
      ...base,
      metric,
      score_basis_points: 7_500,
    }));
  }).flat();
}

function completeNullableScores(
  score: number,
): Readonly<Record<NovelSkillEvaluationMetric, number | null>> {
  return Object.fromEntries(
    NOVEL_SKILL_EVALUATION_METRICS.map((metric) => [metric, score]),
  ) as Readonly<Record<NovelSkillEvaluationMetric, number | null>>;
}

function blindItemWrites(executor: StubSqlExecutor) {
  return executor.executions.filter(({ query }) =>
    query.includes("novel_skill_evaluation_review_items"),
  );
}

function collectKeys(value: unknown): readonly string[] {
  const keys = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return;
    for (const [key, child] of Object.entries(current)) {
      keys.add(key);
      visit(child);
    }
  };
  visit(value);
  return [...keys];
}

function controlSnapshotRow() {
  return {
    run_id: RUN_ID,
    suite_id: SUITE_ID,
    status: "running",
    evaluation_status: "NOT_EVALUATED",
    revision: 2,
    protocol_configured: 1,
    target_count: 2,
    authorization_id: uuid(9),
    authorized_call_count: 192,
    total_cells: 192,
    observed_cells: 0,
    observation_count: 37,
    reserved_count: 1,
    bound_count: 2,
    dispatched_count: 0,
    settled_count: 37,
    ambiguous_count: 0,
    not_dispatched_count: 1,
    successful_settlement_count: 37,
    blind_item_count: 0,
    blind_receipt_count: 0,
    sealed_score_count: 0,
    started_at: NOW,
    completed_at: null,
    created_at: NOW,
  };
}

function recoverableRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    run_id: RUN_ID,
    status: "running",
    revision: 2,
    authorization_id: uuid(9),
    authorized_call_count: 192,
    reserved_count: 1,
    bound_count: 0,
    dispatched_count: 0,
    settled_count: 37,
    ambiguous_count: 0,
    not_dispatched_count: 0,
    successful_settlement_count: 37,
    observation_count: 37,
    blind_receipt_count: 0,
    started_at: NOW,
    created_at: NOW,
    ...overrides,
  };
}

function executionAuthorityRow() {
  return {
    run_id: RUN_ID,
    status: "running",
    execution_protocol_hash: "1".repeat(64),
    authorization_id: uuid(9),
    authorized_quote_hash: "2".repeat(64),
  };
}

function targetRow() {
  return {
    run_id: RUN_ID,
    model_slot_id: "text_tier_a",
    connection_id: "connection-a",
    catalog_entry_id: "catalog-a",
    provider_kind_snapshot: "openai",
    connection_protocol_snapshot: "openai_compatible",
    connection_revision: 3,
    catalog_revision: 4,
    provider_model_id_snapshot: "exact-provider-model-a",
    model_identity_hash: "1".repeat(64),
    model_artifact_hash: "2".repeat(64),
    target_hash: "3".repeat(64),
    currency: "USD",
    input_micros_per_million_tokens: "1000000",
    output_micros_per_million_tokens: "2000000",
    cached_input_micros_per_million_tokens: null,
    pricing_version: "provider-2026-08",
    pricing_snapshot_hash: "4".repeat(64),
  };
}

function reservationRow() {
  return {
    id: uuid(10),
    run_id: RUN_ID,
    cell_id: CELL_ID,
    attempt_id: uuid(5),
    model_slot_id: "text_tier_a",
    dispatch_generation: 1,
    state: "settled",
    planned_context_trace_id: uuid(6),
    planned_model_invocation_id: uuid(7),
    planned_candidate_id: uuid(8),
    currency: "USD",
    reserved_max_cost_micros: "100",
    actual_cost_micros: "42",
    settlement_outcome: "succeeded",
    provider_receipt_hash: "9".repeat(64),
    provider_visible_output_hash: "8".repeat(64),
    output_candidate_id: uuid(8),
    reserved_at: NOW,
    bound_at: NOW,
    dispatched_at: NOW,
    terminal_at: SEALED_AT,
    revision: 4,
  };
}

function settledUnobservedRow() {
  return {
    reservation_id: uuid(10),
    run_id: RUN_ID,
    cell_id: CELL_ID,
    attempt_id: uuid(5),
    context_trace_id: uuid(6),
    model_invocation_id: uuid(7),
    output_candidate_id: uuid(8),
    terminal_at: SEALED_AT,
    revision: 4,
  };
}

function blindItemId(index: number): string {
  return `blind-item-${String(index).padStart(8, "0")}`;
}

function uuid(index: number): string {
  return `019f9f4a-b3c7-7350-8000-${index.toString(16).padStart(12, "0")}`;
}
