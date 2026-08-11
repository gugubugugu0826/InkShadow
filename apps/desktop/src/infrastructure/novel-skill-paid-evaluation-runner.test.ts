/* eslint-disable @typescript-eslint/require-await -- synchronous in-memory fake ports */
import { NOVEL_SKILL_EVALUATION_ARMS } from "@inkshadow/ai-core";
import { describe, expect, it } from "vitest";

import {
  NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT,
  NovelSkillPaidEvaluationRunner,
  type NovelSkillPaidEvaluationAuthoritySnapshot,
  type NovelSkillPaidEvaluationExactExecutionInput,
  type NovelSkillPaidEvaluationExactExecutor,
  type NovelSkillPaidEvaluationReservationReference,
  type NovelSkillPaidEvaluationRestartRecovery,
  type NovelSkillPaidEvaluationRunnerAuthority,
  type NovelSkillPaidEvaluationRunnerAuthorization,
  type NovelSkillPaidEvaluationRunnerCell,
  type NovelSkillPaidEvaluationRunnerQuote,
} from "./novel-skill-paid-evaluation-runner";

const RUN_ID = "run-paid-evaluation";
const QUOTE_HASH = "quote-192-calls";

interface FakePrepared {
  readonly cellId: string;
}

interface FakeReceipt {
  readonly cellId: string;
}

interface FakeResult {
  readonly cellId: string;
  readonly visibleOutputHash: string;
}

type ExactStage = "before_reserve" | "after_bound" | "after_dispatch" | "provider";

class FakeExactExecutor implements NovelSkillPaidEvaluationExactExecutor<
  FakePrepared,
  FakeReceipt,
  FakeResult
> {
  public readonly callOrder: string[] = [];
  public providerCalls = 0;
  public maximumConcurrency = 0;
  public onStage: ((stage: ExactStage, cellId: string) => void) | null = null;
  private active = 0;

  public async executeExactlyOnce(
    input: NovelSkillPaidEvaluationExactExecutionInput<FakePrepared, FakeReceipt>,
  ): Promise<FakeResult> {
    const { cellId } = input.prepared;
    this.callOrder.push(cellId);
    this.active += 1;
    this.maximumConcurrency = Math.max(this.maximumConcurrency, this.active);
    try {
      this.onStage?.("before_reserve", cellId);
      const receipt = Object.freeze({ cellId });
      await input.reserveAndBindBeforeDispatch(receipt);
      this.onStage?.("after_bound", cellId);
      input.assertBeforeProviderDispatch();
      await input.markDispatchStarted(receipt);
      this.onStage?.("after_dispatch", cellId);
      input.assertBeforeProviderDispatch();
      this.providerCalls += 1;
      this.onStage?.("provider", cellId);
      return Object.freeze({ cellId, visibleOutputHash: `output:${cellId}` });
    } finally {
      this.active -= 1;
    }
  }
}

class FakeAuthority implements NovelSkillPaidEvaluationRunnerAuthority<
  FakePrepared,
  FakeReceipt,
  FakeResult
> {
  public phase: NovelSkillPaidEvaluationAuthoritySnapshot["phase"] = "draft";
  public quoteHash: string | null = null;
  public authorizationId: string | null = null;
  public readonly cells = fixedCells();
  public readonly preparedOrder: string[] = [];
  public readonly reservedOrder: string[] = [];
  public readonly dispatchedOrder: string[] = [];
  public readonly settledOrder: string[] = [];
  public releasedPredispatch = 0;
  public ambiguousInvalidations = 0;
  public restartRecoveries = 0;
  public observationRepairs = 0;
  public inspectCalls = 0;
  public inspectGate: Promise<void> | null = null;

  public async inspectRun(runId: string): Promise<NovelSkillPaidEvaluationAuthoritySnapshot> {
    this.assertRun(runId);
    this.inspectCalls += 1;
    if (this.inspectGate !== null) await this.inspectGate;
    return this.snapshot();
  }

  public async prepareRun(runId: string): Promise<void> {
    this.assertRun(runId);
    this.phase = "prepared";
  }

  public async quoteRun(runId: string): Promise<NovelSkillPaidEvaluationRunnerQuote> {
    this.assertRun(runId);
    this.phase = "quoted";
    this.quoteHash = QUOTE_HASH;
    return Object.freeze({
      runId,
      quoteHash: QUOTE_HASH,
      authorizedCallCount: NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT,
      currencies: Object.freeze([
        Object.freeze({ currency: "USD", estimatedMaximumCostMicros: "192000" }),
      ]),
    });
  }

  public async authorizeRun(input: NovelSkillPaidEvaluationRunnerAuthorization): Promise<void> {
    this.assertRun(input.runId);
    if (input.quoteHash !== this.quoteHash) throw new Error("quote changed");
    this.authorizationId = input.authorizationId;
    this.phase = "authorized";
  }

  public async startAuthorizedRun(runId: string): Promise<void> {
    this.assertRun(runId);
    if (this.authorizationId === null) throw new Error("not authorized");
    this.phase = "running";
  }

  public async listCells(runId: string): Promise<readonly NovelSkillPaidEvaluationRunnerCell[]> {
    this.assertRun(runId);
    return Object.freeze([...this.cells]);
  }

  public async getCell(runId: string, cellId: string): Promise<NovelSkillPaidEvaluationRunnerCell> {
    this.assertRun(runId);
    return this.requiredCell(cellId);
  }

  public async prepareCell(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
  ): Promise<FakePrepared> {
    this.assertRun(runId);
    this.preparedOrder.push(cell.id);
    return Object.freeze({ cellId: cell.id });
  }

  public async reserveAndBind(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    receipt: FakeReceipt,
  ): Promise<NovelSkillPaidEvaluationReservationReference> {
    this.assertRun(runId);
    if (receipt.cellId !== cell.id) throw new Error("wrong receipt");
    const reservation = Object.freeze({
      reservationId: `reservation:${cell.id}`,
      revision: 2,
      state: "bound" as const,
    });
    this.reservedOrder.push(cell.id);
    this.replaceCell(cell.id, { dispatchState: "bound", reservation });
    return reservation;
  }

  public async markDispatchStarted(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
    receipt: FakeReceipt,
  ): Promise<NovelSkillPaidEvaluationReservationReference> {
    this.assertRun(runId);
    if (receipt.cellId !== cell.id || reservation.state !== "bound") {
      throw new Error("wrong dispatch receipt");
    }
    const dispatched = Object.freeze({ ...reservation, revision: 3, state: "dispatched" as const });
    this.dispatchedOrder.push(cell.id);
    this.replaceCell(cell.id, {
      dispatchState: "dispatched",
      providerDispatchCount: 1,
      reservation: dispatched,
    });
    return dispatched;
  }

  public async settleSuccess(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
    result: FakeResult,
  ): Promise<void> {
    this.assertRun(runId);
    if (result.cellId !== cell.id || reservation.state !== "dispatched") {
      throw new Error("wrong result");
    }
    const settled = Object.freeze({ ...reservation, revision: 4, state: "settled" as const });
    this.settledOrder.push(cell.id);
    this.replaceCell(cell.id, { dispatchState: "settled", reservation: settled });
  }

  public async releasePredispatch(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
  ): Promise<void> {
    this.assertRun(runId);
    if (reservation.state !== "reserved" && reservation.state !== "bound") {
      throw new Error("not releasable");
    }
    this.releasedPredispatch += 1;
    this.replaceCell(cell.id, { dispatchState: "not_dispatched", reservation: null });
  }

  public async markAmbiguousAndInvalidate(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
  ): Promise<void> {
    this.assertRun(runId);
    const ambiguous = Object.freeze({ ...reservation, revision: 4, state: "ambiguous" as const });
    this.ambiguousInvalidations += 1;
    this.replaceCell(cell.id, { dispatchState: "ambiguous", reservation: ambiguous });
    this.phase = "invalidated";
  }

  public async invalidateRun(
    runId: string,
    reason: "dispatch_uncertain" | "authority_changed",
  ): Promise<void> {
    this.assertRun(runId);
    void reason;
    this.phase = "invalidated";
  }

  public async recoverInterruptedDispatches(
    runId: string,
  ): Promise<NovelSkillPaidEvaluationRestartRecovery> {
    this.assertRun(runId);
    this.restartRecoveries += 1;
    let releasedPredispatch = 0;
    let invalidatedAmbiguous = 0;
    for (const cell of [...this.cells]) {
      if (cell.dispatchState === "reserved" || cell.dispatchState === "bound") {
        this.replaceCell(cell.id, { dispatchState: "not_dispatched", reservation: null });
        releasedPredispatch += 1;
      } else if (cell.dispatchState === "dispatched") {
        const current = cell.reservation;
        if (current === null) throw new Error("dispatched reservation missing");
        const ambiguous = Object.freeze({
          ...current,
          revision: current.revision + 1,
          state: "ambiguous" as const,
        });
        this.replaceCell(cell.id, { dispatchState: "ambiguous", reservation: ambiguous });
        invalidatedAmbiguous += 1;
        this.phase = "invalidated";
      }
    }
    return Object.freeze({ releasedPredispatch, invalidatedAmbiguous });
  }

  public async repairSettledObservation(runId: string, cellId: string): Promise<void> {
    this.assertRun(runId);
    const cell = this.requiredCell(cellId);
    if (cell.dispatchState !== "settled") throw new Error("not settled");
    if (!cell.observed) {
      this.observationRepairs += 1;
      this.replaceCell(cellId, { observed: true });
    }
  }

  public seedAuthorizedRunning(): void {
    this.phase = "running";
    this.quoteHash = QUOTE_HASH;
    this.authorizationId = "authorization-restart";
  }

  public seedSettled(cellId: string, observed: boolean): void {
    const cell = this.requiredCell(cellId);
    this.replaceCell(cellId, {
      dispatchState: "settled",
      observed,
      providerDispatchCount: 1,
      reservation: Object.freeze({
        reservationId: `reservation:${cell.id}`,
        revision: 4,
        state: "settled",
      }),
    });
  }

  public seedBound(cellId: string): void {
    const cell = this.requiredCell(cellId);
    this.replaceCell(cellId, {
      dispatchState: "bound",
      reservation: Object.freeze({
        reservationId: `reservation:${cell.id}`,
        revision: 2,
        state: "bound",
      }),
    });
  }

  public seedDispatched(cellId: string): void {
    const cell = this.requiredCell(cellId);
    this.replaceCell(cellId, {
      dispatchState: "dispatched",
      providerDispatchCount: 1,
      reservation: Object.freeze({
        reservationId: `reservation:${cell.id}`,
        revision: 3,
        state: "dispatched",
      }),
    });
  }

  private snapshot(): NovelSkillPaidEvaluationAuthoritySnapshot {
    return Object.freeze({
      runId: RUN_ID,
      phase: this.phase,
      settledCells: this.cells.filter(({ dispatchState }) => dispatchState === "settled").length,
      observedCells: this.cells.filter(({ observed }) => observed).length,
      quoteHash: this.quoteHash,
      authorizationId: this.authorizationId,
    });
  }

  private replaceCell(cellId: string, changes: Partial<NovelSkillPaidEvaluationRunnerCell>): void {
    const index = this.cells.findIndex(({ id }) => id === cellId);
    const current = this.cells[index];
    if (index < 0 || current === undefined) throw new Error(`unknown cell: ${cellId}`);
    this.cells[index] = Object.freeze({ ...current, ...changes });
  }

  private requiredCell(cellId: string): NovelSkillPaidEvaluationRunnerCell {
    const cell = this.cells.find(({ id }) => id === cellId);
    if (cell === undefined) throw new Error(`unknown cell: ${cellId}`);
    return cell;
  }

  private assertRun(runId: string): void {
    if (runId !== RUN_ID) throw new Error("wrong run");
  }
}

describe("NovelSkillPaidEvaluationRunner", () => {
  it("keeps construction, initialization, preparation, quoting, authorization and recovery provider-free", async () => {
    const { authority, exact, runner } = harness();

    expect(runner.getSnapshot()).toMatchObject({
      phase: "uninitialized",
      providerDispatchEnabled: false,
      progressLabel: "0/192",
    });
    await runner.initialize();
    await runner.prepare();
    const quoted = await runner.quote();
    await runner.authorize(authorization(quoted.quote.quoteHash));
    const recovered = await runner.recoverAfterRestart();

    expect(exact.callOrder).toEqual([]);
    expect(exact.providerCalls).toBe(0);
    expect(authority.restartRecoveries).toBe(1);
    expect(recovered).toMatchObject({ phase: "authorized", providerDispatchEnabled: false });
  });

  it("dispatches the frozen 192 cells exactly once, serially, with 96 cells per exact target", async () => {
    const { authority, exact, runner } = await authorizedHarness();
    const progress: string[] = [];
    const unsubscribe = runner.subscribe((snapshot) => progress.push(snapshot.progressLabel));

    const first = runner.start();
    const duplicate = runner.start();
    expect(duplicate).toBe(first);
    const [snapshot] = await Promise.all([first, duplicate]);

    const expectedOrder = authority.cells.map(({ id }) => id);
    expect(exact.callOrder).toEqual(expectedOrder);
    expect(authority.preparedOrder).toEqual(expectedOrder);
    expect(authority.reservedOrder).toEqual(expectedOrder);
    expect(authority.dispatchedOrder).toEqual(expectedOrder);
    expect(authority.settledOrder).toEqual(expectedOrder);
    expect(exact.maximumConcurrency).toBe(1);
    expect(exact.providerCalls).toBe(192);
    expect(new Set(exact.callOrder).size).toBe(192);
    expect(authority.cells.filter(({ modelSlotId }) => modelSlotId === "text_tier_a")).toHaveLength(
      96,
    );
    expect(authority.cells.filter(({ modelSlotId }) => modelSlotId === "text_tier_b")).toHaveLength(
      96,
    );
    expect(snapshot).toMatchObject({
      phase: "awaiting_review",
      settledCells: 192,
      observedCells: 192,
      providerDispatchEnabled: false,
      progressLabel: "192/192",
    });
    expect(progress).toContain("1/192");
    expect(progress).toContain("192/192");
    unsubscribe();

    await runner.start();
    expect(exact.providerCalls).toBe(192);
    expect(exact.callOrder).toHaveLength(192);
  });

  it("preserves cancellation requested while start waits for initialization until an explicit restart", async () => {
    const { authority, exact, runner } = harness();
    authority.seedAuthorizedRunning();
    const inspection = deferredSignal();
    authority.inspectGate = inspection.promise;

    const first = runner.start();
    expect(authority.inspectCalls).toBe(1);
    runner.requestCancellation();
    const duplicate = runner.start();
    expect(duplicate).toBe(first);

    inspection.resolve();
    const stopped = await first;

    expect(stopped).toMatchObject({
      phase: "paused",
      providerDispatchEnabled: false,
      stopReason: "user_requested",
      progressLabel: "0/192",
    });
    expect(authority.restartRecoveries).toBe(0);
    expect(exact.callOrder).toEqual([]);
    expect(exact.providerCalls).toBe(0);

    const resumed = await runner.start();
    expect(resumed).toMatchObject({
      phase: "awaiting_review",
      settledCells: 192,
      observedCells: 192,
      providerDispatchEnabled: false,
    });
    expect(exact.providerCalls).toBe(192);
  });

  it.each([
    ["before reservation", "before_reserve", "paused", "planned", 0, 0],
    ["after bind", "after_bound", "paused", "not_dispatched", 0, 1],
    ["after dispatch boundary", "after_dispatch", "invalidated", "ambiguous", 0, 0],
  ] as const)(
    "cancels safely %s without a retry or fallback",
    async (_label, cancelAt, phase, cellState, providerCalls, released) => {
      const { authority, exact, runner } = await authorizedHarness();
      let cancelled = false;
      exact.onStage = (stage) => {
        if (!cancelled && stage === cancelAt) {
          cancelled = true;
          runner.requestCancellation();
        }
      };

      const snapshot = await runner.start();

      expect(snapshot.phase).toBe(phase);
      expect(exact.callOrder).toHaveLength(1);
      expect(exact.providerCalls).toBe(providerCalls);
      expect(authority.cells[0]?.dispatchState).toBe(cellState);
      expect(authority.releasedPredispatch).toBe(released);
      expect(authority.ambiguousInvalidations).toBe(phase === "invalidated" ? 1 : 0);
      expect(
        authority.cells.slice(1).every(({ dispatchState }) => dispatchState === "planned"),
      ).toBe(true);
    },
  );

  it("invalidates provider-bound uncertainty and does not retry it on another start", async () => {
    const { authority, exact, runner } = await authorizedHarness();
    exact.onStage = (stage) => {
      if (stage === "provider") {
        throw Object.assign(new Error("provider outcome unknown"), { dispatched: true });
      }
    };

    const failed = await runner.start();
    expect(failed.phase).toBe("invalidated");
    expect(exact.callOrder).toHaveLength(1);
    expect(exact.providerCalls).toBe(1);
    expect(authority.cells[0]?.dispatchState).toBe("ambiguous");

    exact.onStage = null;
    await runner.start();
    expect(exact.callOrder).toHaveLength(1);
    expect(exact.providerCalls).toBe(1);
  });

  it("repairs settled local evidence and releases bound work after restart before explicit resume", async () => {
    const { authority, exact, runner } = harness();
    authority.seedAuthorizedRunning();
    for (const cell of authority.cells.slice(0, 10)) authority.seedSettled(cell.id, true);
    const unobserved = authority.cells[10];
    const bound = authority.cells[11];
    if (unobserved === undefined || bound === undefined) throw new Error("matrix missing");
    authority.seedSettled(unobserved.id, false);
    authority.seedBound(bound.id);

    await runner.initialize();
    const recovered = await runner.recoverAfterRestart();

    expect(exact.providerCalls).toBe(0);
    expect(exact.callOrder).toEqual([]);
    expect(authority.requiredCellForTest(unobserved.id).observed).toBe(true);
    expect(authority.requiredCellForTest(bound.id).dispatchState).toBe("not_dispatched");
    expect(recovered).toMatchObject({
      phase: "paused",
      settledCells: 11,
      observedCells: 11,
      providerDispatchEnabled: false,
    });

    exact.onStage = null;
    const resumed = await runner.start();
    expect(exact.providerCalls).toBe(181);
    expect(exact.callOrder[0]).toBe(bound.id);
    expect(resumed).toMatchObject({ phase: "awaiting_review", settledCells: 192 });
  });

  it("invalidates a dispatched restart uncertainty and never redispatches it", async () => {
    const { authority, exact, runner } = harness();
    authority.seedAuthorizedRunning();
    const first = authority.cells[0];
    if (first === undefined) throw new Error("matrix missing");
    authority.seedDispatched(first.id);

    await runner.initialize();
    const recovered = await runner.recoverAfterRestart();
    const afterStart = await runner.start();

    expect(recovered.phase).toBe("invalidated");
    expect(afterStart.phase).toBe("invalidated");
    expect(authority.requiredCellForTest(first.id).dispatchState).toBe("ambiguous");
    expect(exact.callOrder).toEqual([]);
    expect(exact.providerCalls).toBe(0);
  });

  it("rejects a malformed matrix before any exact execution", async () => {
    const { authority, exact, runner } = await authorizedHarness();
    authority.cells.pop();

    await expect(runner.start()).rejects.toMatchObject({
      code: "NOVEL_SKILL_PAID_RUNNER_MATRIX_INVALID",
    });
    expect(exact.callOrder).toEqual([]);
    expect(exact.providerCalls).toBe(0);
  });
});

function harness(): Readonly<{
  authority: FakeAuthority & {
    requiredCellForTest(cellId: string): NovelSkillPaidEvaluationRunnerCell;
  };
  exact: FakeExactExecutor;
  runner: NovelSkillPaidEvaluationRunner<FakePrepared, FakeReceipt, FakeResult>;
}> {
  const authority = new FakeAuthority() as FakeAuthority & {
    requiredCellForTest(cellId: string): NovelSkillPaidEvaluationRunnerCell;
  };
  authority.requiredCellForTest = (cellId: string) => {
    const cell = authority.cells.find(({ id }) => id === cellId);
    if (cell === undefined) throw new Error("unknown cell");
    return cell;
  };
  const exact = new FakeExactExecutor();
  return Object.freeze({
    authority,
    exact,
    runner: new NovelSkillPaidEvaluationRunner(RUN_ID, { authority, exactExecutor: exact }),
  });
}

async function authorizedHarness(): Promise<ReturnType<typeof harness>> {
  const value = harness();
  await value.runner.initialize();
  await value.runner.prepare();
  const { quote } = await value.runner.quote();
  await value.runner.authorize(authorization(quote.quoteHash));
  return value;
}

function authorization(quoteHash: string): NovelSkillPaidEvaluationRunnerAuthorization {
  return Object.freeze({
    authorizationId: "authorization-explicit",
    runId: RUN_ID,
    quoteHash,
    confirmationHash: "confirmation-content-free",
    hardCeilings: Object.freeze([Object.freeze({ currency: "USD", hardCeilingMicros: "192000" })]),
    authorizedAt: "2026-08-11T00:00:00.000Z",
  });
}

function deferredSignal(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve: () => {
      if (resolvePromise === undefined) throw new Error("deferred resolver missing");
      resolvePromise();
    },
  });
}

function fixedCells(): NovelSkillPaidEvaluationRunnerCell[] {
  const cells: NovelSkillPaidEvaluationRunnerCell[] = [];
  for (let fixtureIndex = 1; fixtureIndex <= 12; fixtureIndex += 1) {
    for (const arm of NOVEL_SKILL_EVALUATION_ARMS) {
      for (const modelSlotId of ["text_tier_a", "text_tier_b"] as const) {
        for (const repetition of [1, 2] as const) {
          const executionOrder = cells.length + 1;
          cells.push(
            Object.freeze({
              id: `cell-${String(executionOrder).padStart(3, "0")}`,
              executionOrder,
              fixtureId: `fixture-${String(fixtureIndex).padStart(2, "0")}`,
              arm,
              modelSlotId,
              repetition,
              dispatchState: "planned",
              observed: false,
              providerDispatchCount: 0,
              reservation: null,
            }),
          );
        }
      }
    }
  }
  return cells;
}
