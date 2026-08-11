import { NOVEL_SKILL_EVALUATION_ARMS, type NovelSkillEvaluationArm } from "@inkshadow/ai-core";

export const NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT = 192 as const;

export type NovelSkillPaidEvaluationRunnerPhase =
  | "uninitialized"
  | "draft"
  | "prepared"
  | "quoted"
  | "authorized"
  | "running"
  | "paused"
  | "awaiting_review"
  | "completed"
  | "invalidated";

export type NovelSkillPaidEvaluationRunnerStopReason =
  "user_requested" | "predispatch_failed" | "observation_repair_failed" | "authority_changed";

export interface NovelSkillPaidEvaluationRunnerSnapshot {
  readonly runId: string;
  readonly phase: NovelSkillPaidEvaluationRunnerPhase;
  readonly settledCells: number;
  readonly observedCells: number;
  readonly totalCells: typeof NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT;
  readonly progressLabel: string;
  readonly quoteHash: string | null;
  readonly authorizationId: string | null;
  /** True only while an explicit `start()` call owns the serial dispatch loop. */
  readonly providerDispatchEnabled: boolean;
  readonly stopReason: NovelSkillPaidEvaluationRunnerStopReason | null;
}

export type NovelSkillPaidEvaluationRunnerSnapshotListener = (
  snapshot: NovelSkillPaidEvaluationRunnerSnapshot,
) => void;

export type NovelSkillPaidEvaluationAuthorityPhase = Exclude<
  NovelSkillPaidEvaluationRunnerPhase,
  "uninitialized" | "awaiting_review"
>;

export interface NovelSkillPaidEvaluationAuthoritySnapshot {
  readonly runId: string;
  readonly phase: NovelSkillPaidEvaluationAuthorityPhase;
  readonly settledCells: number;
  readonly observedCells: number;
  readonly quoteHash: string | null;
  readonly authorizationId: string | null;
}

export type NovelSkillPaidEvaluationDispatchState =
  "planned" | "not_dispatched" | "reserved" | "bound" | "dispatched" | "settled" | "ambiguous";

export interface NovelSkillPaidEvaluationReservationReference {
  readonly reservationId: string;
  readonly revision: number;
  readonly state: "reserved" | "bound" | "dispatched" | "settled" | "ambiguous";
}

export interface NovelSkillPaidEvaluationRunnerCell {
  readonly id: string;
  /** Frozen one-based serial order. */
  readonly executionOrder: number;
  readonly fixtureId: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly repetition: 1 | 2;
  readonly dispatchState: NovelSkillPaidEvaluationDispatchState;
  readonly observed: boolean;
  /** Number of provider dispatch boundaries already crossed for this cell. */
  readonly providerDispatchCount: 0 | 1;
  readonly reservation: NovelSkillPaidEvaluationReservationReference | null;
}

export interface NovelSkillPaidEvaluationRunnerQuoteCurrency {
  readonly currency: string;
  readonly estimatedMaximumCostMicros: string;
}

export interface NovelSkillPaidEvaluationRunnerQuote {
  readonly runId: string;
  readonly quoteHash: string;
  readonly authorizedCallCount: typeof NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT;
  readonly currencies: readonly NovelSkillPaidEvaluationRunnerQuoteCurrency[];
}

export interface NovelSkillPaidEvaluationRunnerAuthorization {
  readonly authorizationId: string;
  readonly runId: string;
  readonly quoteHash: string;
  readonly confirmationHash: string;
  readonly hardCeilings: readonly Readonly<{
    readonly currency: string;
    readonly hardCeilingMicros: string;
  }>[];
  readonly authorizedAt: string;
}

export interface NovelSkillPaidEvaluationRestartRecovery {
  readonly releasedPredispatch: number;
  readonly invalidatedAmbiguous: number;
}

export interface NovelSkillPaidEvaluationExactExecutionInput<TPrepared, TReceipt> {
  readonly prepared: TPrepared;
  readonly reserveAndBindBeforeDispatch: (receipt: TReceipt) => Promise<void>;
  readonly markDispatchStarted: (receipt: TReceipt) => Promise<void>;
  readonly assertBeforeProviderDispatch: () => void;
}

/**
 * This port must perform one exact-target attempt with retry and fallback both
 * disabled. The Runner invokes it at most once for a cell in one serial pass.
 */
export interface NovelSkillPaidEvaluationExactExecutor<TPrepared, TReceipt, TResult> {
  executeExactlyOnce(
    input: NovelSkillPaidEvaluationExactExecutionInput<TPrepared, TReceipt>,
  ): Promise<TResult>;
}

/**
 * Narrow persistence/compilation boundary. Production wiring should adapt the
 * existing 0061/0063 stores; tests can implement this entirely in memory.
 */
export interface NovelSkillPaidEvaluationRunnerAuthority<TPrepared, TReceipt, TResult> {
  inspectRun(runId: string): Promise<NovelSkillPaidEvaluationAuthoritySnapshot>;
  prepareRun(runId: string): Promise<void>;
  quoteRun(runId: string): Promise<NovelSkillPaidEvaluationRunnerQuote>;
  authorizeRun(input: NovelSkillPaidEvaluationRunnerAuthorization): Promise<void>;
  startAuthorizedRun(runId: string): Promise<void>;
  listCells(runId: string): Promise<readonly NovelSkillPaidEvaluationRunnerCell[]>;
  getCell(runId: string, cellId: string): Promise<NovelSkillPaidEvaluationRunnerCell>;
  prepareCell(runId: string, cell: NovelSkillPaidEvaluationRunnerCell): Promise<TPrepared>;
  reserveAndBind(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    receipt: TReceipt,
  ): Promise<NovelSkillPaidEvaluationReservationReference>;
  markDispatchStarted(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
    receipt: TReceipt,
  ): Promise<NovelSkillPaidEvaluationReservationReference>;
  settleSuccess(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
    result: TResult,
  ): Promise<void>;
  releasePredispatch(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
  ): Promise<void>;
  markAmbiguousAndInvalidate(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
  ): Promise<void>;
  invalidateRun(runId: string, reason: "dispatch_uncertain" | "authority_changed"): Promise<void>;
  recoverInterruptedDispatches(runId: string): Promise<NovelSkillPaidEvaluationRestartRecovery>;
  /** Rebuilds missing content-free observation evidence from settled local rows only. */
  repairSettledObservation(runId: string, cellId: string): Promise<void>;
}

export interface NovelSkillPaidEvaluationRunnerDependencies<TPrepared, TReceipt, TResult> {
  readonly authority: NovelSkillPaidEvaluationRunnerAuthority<TPrepared, TReceipt, TResult>;
  readonly exactExecutor: NovelSkillPaidEvaluationExactExecutor<TPrepared, TReceipt, TResult>;
}

export type NovelSkillPaidEvaluationRunnerErrorCode =
  | "NOVEL_SKILL_PAID_RUNNER_NOT_READY"
  | "NOVEL_SKILL_PAID_RUNNER_AUTHORIZATION_REQUIRED"
  | "NOVEL_SKILL_PAID_RUNNER_MATRIX_INVALID"
  | "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID";

export class NovelSkillPaidEvaluationRunnerError extends Error {
  public constructor(
    readonly code: NovelSkillPaidEvaluationRunnerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NovelSkillPaidEvaluationRunnerError";
  }
}

class DispatchCancellationLatchError extends Error {
  public constructor() {
    super("The paid evaluation dispatch was cancelled before the provider boundary.");
    this.name = "DispatchCancellationLatchError";
  }
}

type FailureDisposition = "continue" | "stop";

interface CellDispatchLifecycle {
  reservation: NovelSkillPaidEvaluationReservationReference | null;
  reserveCallbackUsed: boolean;
  dispatchCallbackUsed: boolean;
  dispatchBoundaryCommitted: boolean;
}

/**
 * Serial, default-off coordinator for the fixed commercial 192-cell pass.
 * Merely constructing, initializing, preparing, quoting, authorizing or
 * recovering this object cannot reach the provider-facing executor.
 */
export class NovelSkillPaidEvaluationRunner<TPrepared, TReceipt, TResult> {
  private snapshot: NovelSkillPaidEvaluationRunnerSnapshot;
  private authoritySnapshot: NovelSkillPaidEvaluationAuthoritySnapshot | null = null;
  private startPromise: Promise<NovelSkillPaidEvaluationRunnerSnapshot> | null = null;
  private cancellationRequested = false;
  private executing = false;
  private locallyPaused = false;
  private stopReason: NovelSkillPaidEvaluationRunnerStopReason | null = null;
  private readonly snapshotListeners = new Set<NovelSkillPaidEvaluationRunnerSnapshotListener>();

  public constructor(
    private readonly runId: string,
    private readonly dependencies: NovelSkillPaidEvaluationRunnerDependencies<
      TPrepared,
      TReceipt,
      TResult
    >,
  ) {
    this.snapshot = freezeSnapshot({
      runId,
      phase: "uninitialized",
      settledCells: 0,
      observedCells: 0,
      quoteHash: null,
      authorizationId: null,
      providerDispatchEnabled: false,
      stopReason: null,
    });
  }

  public getSnapshot(): NovelSkillPaidEvaluationRunnerSnapshot {
    return this.snapshot;
  }

  /** Emits finite, content-free progress snapshots; subscribing never starts work. */
  public subscribe(listener: NovelSkillPaidEvaluationRunnerSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    listener(this.snapshot);
    return () => this.snapshotListeners.delete(listener);
  }

  public async initialize(): Promise<NovelSkillPaidEvaluationRunnerSnapshot> {
    return this.refreshSnapshot();
  }

  public async prepare(): Promise<NovelSkillPaidEvaluationRunnerSnapshot> {
    await this.ensureInitialized();
    if (this.snapshot.phase !== "draft" && this.snapshot.phase !== "prepared") {
      throw runnerError("NOVEL_SKILL_PAID_RUNNER_NOT_READY", "The run is not preparable.");
    }
    await this.dependencies.authority.prepareRun(this.runId);
    return this.refreshSnapshot();
  }

  public async quote(): Promise<
    Readonly<{
      quote: NovelSkillPaidEvaluationRunnerQuote;
      snapshot: NovelSkillPaidEvaluationRunnerSnapshot;
    }>
  > {
    await this.ensureInitialized();
    if (this.snapshot.phase !== "prepared" && this.snapshot.phase !== "quoted") {
      throw runnerError("NOVEL_SKILL_PAID_RUNNER_NOT_READY", "The run is not ready to quote.");
    }
    const quote = await this.dependencies.authority.quoteRun(this.runId);
    assertQuote(quote, this.runId);
    const snapshot = await this.refreshSnapshot();
    return Object.freeze({ quote, snapshot });
  }

  public async authorize(
    input: NovelSkillPaidEvaluationRunnerAuthorization,
  ): Promise<NovelSkillPaidEvaluationRunnerSnapshot> {
    await this.ensureInitialized();
    if (this.snapshot.phase !== "quoted" && this.snapshot.phase !== "authorized") {
      throw runnerError(
        "NOVEL_SKILL_PAID_RUNNER_NOT_READY",
        "The commercial quote must be frozen before authorization.",
      );
    }
    if (
      input.runId !== this.runId ||
      this.snapshot.quoteHash === null ||
      input.quoteHash !== this.snapshot.quoteHash
    ) {
      throw runnerError(
        "NOVEL_SKILL_PAID_RUNNER_AUTHORIZATION_REQUIRED",
        "Authorization does not match the current frozen commercial quote.",
      );
    }
    await this.dependencies.authority.authorizeRun(input);
    return this.refreshSnapshot();
  }

  /**
   * Releases interrupted predispatch work, invalidates any dispatched
   * uncertainty, and repairs settled-but-unobserved rows without dispatching.
   */
  public async recoverAfterRestart(): Promise<NovelSkillPaidEvaluationRunnerSnapshot> {
    await this.ensureInitialized();
    await this.dependencies.authority.recoverInterruptedDispatches(this.runId);
    await this.repairEverySettledObservation();
    this.cancellationRequested = false;
    this.locallyPaused = true;
    this.stopReason = null;
    return this.refreshSnapshot();
  }

  /** Requests a safe stop at the next boundary. It never starts work. */
  public requestCancellation(): void {
    this.cancellationRequested = true;
  }

  /**
   * The only method allowed to enter the exact provider executor. Repeated
   * concurrent calls share one serial pass; calls after all 192 settlements
   * are observed are read-only.
   */
  public start(): Promise<NovelSkillPaidEvaluationRunnerSnapshot> {
    if (this.startPromise !== null) return this.startPromise;

    // Clear the previous pass' local stop latch synchronously, before the
    // first inspection can yield. A cancellation requested while that
    // inspection is pending therefore belongs to this pass and cannot be
    // overwritten when initialization resumes. Concurrent start callers
    // return above and cannot clear the active pass' cancellation.
    this.cancellationRequested = false;
    this.locallyPaused = false;
    this.stopReason = null;

    const started = this.runSerialPass();
    this.startPromise = started.finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async runSerialPass(): Promise<NovelSkillPaidEvaluationRunnerSnapshot> {
    await this.ensureInitialized();
    if (
      this.snapshot.phase === "completed" ||
      this.snapshot.phase === "invalidated" ||
      this.snapshot.phase === "awaiting_review"
    ) {
      return this.snapshot;
    }
    if (
      this.snapshot.authorizationId === null ||
      !["authorized", "running", "paused"].includes(this.snapshot.phase)
    ) {
      throw runnerError(
        "NOVEL_SKILL_PAID_RUNNER_AUTHORIZATION_REQUIRED",
        "An exact 192-call authorization is required before execution can start.",
      );
    }

    if (this.isCancellationRequested()) return this.pause("user_requested");

    // A previous process may have ended after any local persistence boundary.
    // Recovery is content-free and must finish before this process can dispatch.
    await this.dependencies.authority.recoverInterruptedDispatches(this.runId);
    await this.repairEverySettledObservation();
    await this.refreshSnapshot();
    if (this.isExecutionTerminal()) {
      return this.snapshot;
    }

    if (this.authoritySnapshot?.phase !== "running") {
      await this.dependencies.authority.startAuthorizedRun(this.runId);
    }
    this.executing = true;
    try {
      await this.refreshSnapshot();
      if (this.authoritySnapshot?.phase !== "running") {
        throw runnerError(
          "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
          "The authorized run did not enter its persistent running state.",
        );
      }

      const cells = validateFixedMatrix(await this.dependencies.authority.listCells(this.runId));
      assertProgressMatchesCells(this.authoritySnapshot, cells);
      const executedInPass = new Set<string>();
      for (const plannedCell of cells) {
        if (this.isCancellationRequested()) return await this.pause("user_requested");
        const cell = await this.dependencies.authority.getCell(this.runId, plannedCell.id);
        assertSameCell(plannedCell, cell);
        if (cell.observed) continue;
        if (cell.dispatchState === "settled") {
          if (!(await this.tryRepairObservation(cell.id))) {
            return await this.pause("observation_repair_failed");
          }
          continue;
        }
        if (cell.dispatchState === "ambiguous" || cell.providerDispatchCount > 0) {
          await this.dependencies.authority.invalidateRun(this.runId, "authority_changed");
          this.stopReason = "authority_changed";
          return await this.refreshSnapshot();
        }
        if (cell.dispatchState !== "planned" && cell.dispatchState !== "not_dispatched") {
          await this.dependencies.authority.recoverInterruptedDispatches(this.runId);
          this.locallyPaused = true;
          this.stopReason = "authority_changed";
          return await this.refreshSnapshot();
        }
        if (executedInPass.has(cell.id)) {
          await this.dependencies.authority.invalidateRun(this.runId, "authority_changed");
          this.stopReason = "authority_changed";
          return await this.refreshSnapshot();
        }
        executedInPass.add(cell.id);
        const disposition = await this.executeCell(cell);
        if (disposition === "stop") return this.snapshot;
      }
      await this.refreshSnapshot();
      return this.snapshot;
    } finally {
      this.executing = false;
      await this.refreshSnapshot();
    }
  }

  private async executeCell(cell: NovelSkillPaidEvaluationRunnerCell): Promise<FailureDisposition> {
    const lifecycle: CellDispatchLifecycle = {
      reservation: null,
      reserveCallbackUsed: false,
      dispatchCallbackUsed: false,
      dispatchBoundaryCommitted: false,
    };

    try {
      const prepared = await this.dependencies.authority.prepareCell(this.runId, cell);
      this.assertDispatchAllowed();
      const result = await this.dependencies.exactExecutor.executeExactlyOnce({
        prepared,
        reserveAndBindBeforeDispatch: async (receipt) => {
          if (lifecycle.reserveCallbackUsed) {
            throw runnerError(
              "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
              "The exact executor attempted to reserve one cell more than once.",
            );
          }
          lifecycle.reserveCallbackUsed = true;
          this.assertDispatchAllowed();
          lifecycle.reservation = await this.dependencies.authority.reserveAndBind(
            this.runId,
            cell,
            receipt,
          );
          assertReservationState(lifecycle.reservation, "bound");
          this.assertDispatchAllowed();
        },
        markDispatchStarted: async (receipt) => {
          if (lifecycle.dispatchCallbackUsed || lifecycle.reservation === null) {
            throw runnerError(
              "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
              "The exact executor crossed an invalid dispatch boundary.",
            );
          }
          lifecycle.dispatchCallbackUsed = true;
          this.assertDispatchAllowed();
          lifecycle.reservation = await this.dependencies.authority.markDispatchStarted(
            this.runId,
            cell,
            lifecycle.reservation,
            receipt,
          );
          assertReservationState(lifecycle.reservation, "dispatched");
          lifecycle.dispatchBoundaryCommitted = true;
        },
        assertBeforeProviderDispatch: () => this.assertDispatchAllowed(),
      });
      if (
        !lifecycle.reserveCallbackUsed ||
        !lifecycle.dispatchCallbackUsed ||
        lifecycle.reservation === null
      ) {
        throw runnerError(
          "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
          "The exact executor returned without the required persistence boundaries.",
        );
      }
      await this.dependencies.authority.settleSuccess(
        this.runId,
        cell,
        lifecycle.reservation,
        result,
      );
      if (!(await this.tryRepairObservation(cell.id))) {
        await this.pause("observation_repair_failed");
        return "stop";
      }
      await this.refreshSnapshot();
      return "continue";
    } catch (cause: unknown) {
      return this.handleCellFailure(
        cell,
        lifecycle.reservation,
        lifecycle.dispatchBoundaryCommitted,
        cause,
      );
    }
  }

  private async handleCellFailure(
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference | null,
    dispatchBoundaryCommitted: boolean,
    cause: unknown,
  ): Promise<FailureDisposition> {
    const fresh = await this.dependencies.authority.getCell(this.runId, cell.id).catch(() => null);
    if (fresh?.observed === true) {
      await this.refreshSnapshot();
      return "continue";
    }
    if (fresh?.dispatchState === "settled") {
      if (await this.tryRepairObservation(cell.id)) {
        await this.refreshSnapshot();
        return "continue";
      }
      await this.pause("observation_repair_failed");
      return "stop";
    }

    const freshReservation = fresh?.reservation ?? reservation;
    const dispatched =
      fresh?.dispatchState === "dispatched" ||
      dispatchBoundaryCommitted ||
      hasDispatchedFlag(cause);
    if (dispatched) {
      if (freshReservation !== null) {
        await this.dependencies.authority
          .markAmbiguousAndInvalidate(this.runId, cell, freshReservation)
          .catch(async () => {
            await this.dependencies.authority.invalidateRun(this.runId, "dispatch_uncertain");
          });
      } else {
        await this.dependencies.authority.invalidateRun(this.runId, "dispatch_uncertain");
      }
      this.stopReason = "authority_changed";
      await this.refreshSnapshot();
      return "stop";
    }

    if (
      freshReservation !== null &&
      (fresh?.dispatchState === "reserved" ||
        fresh?.dispatchState === "bound" ||
        freshReservation.state === "reserved" ||
        freshReservation.state === "bound")
    ) {
      await this.dependencies.authority
        .releasePredispatch(this.runId, cell, freshReservation)
        .catch(async () => {
          await this.dependencies.authority.recoverInterruptedDispatches(this.runId);
        });
    }
    await this.pause(
      cause instanceof DispatchCancellationLatchError || this.isCancellationRequested()
        ? "user_requested"
        : "predispatch_failed",
    );
    return "stop";
  }

  private assertDispatchAllowed(): void {
    if (this.cancellationRequested) throw new DispatchCancellationLatchError();
    if (!this.executing) {
      throw runnerError(
        "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
        "No explicit serial execution pass owns the provider dispatch latch.",
      );
    }
  }

  private isCancellationRequested(): boolean {
    return this.cancellationRequested;
  }

  private isExecutionTerminal(): boolean {
    return this.snapshot.phase === "invalidated" || this.snapshot.phase === "awaiting_review";
  }

  private async pause(
    reason: NovelSkillPaidEvaluationRunnerStopReason,
  ): Promise<NovelSkillPaidEvaluationRunnerSnapshot> {
    this.locallyPaused = true;
    this.stopReason = reason;
    this.executing = false;
    return this.refreshSnapshot();
  }

  private async tryRepairObservation(cellId: string): Promise<boolean> {
    try {
      await this.dependencies.authority.repairSettledObservation(this.runId, cellId);
      return true;
    } catch {
      return false;
    }
  }

  private async repairEverySettledObservation(): Promise<void> {
    const cells = await this.dependencies.authority.listCells(this.runId);
    for (const cell of cells) {
      if (cell.dispatchState === "settled" && !cell.observed) {
        await this.dependencies.authority.repairSettledObservation(this.runId, cell.id);
      }
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.authoritySnapshot === null) await this.refreshSnapshot();
  }

  private async refreshSnapshot(): Promise<NovelSkillPaidEvaluationRunnerSnapshot> {
    const authority = await this.dependencies.authority.inspectRun(this.runId);
    assertAuthoritySnapshot(authority, this.runId);
    this.authoritySnapshot = authority;
    const phase = projectPhase(authority, this.executing, this.locallyPaused);
    this.snapshot = freezeSnapshot({
      ...authority,
      phase,
      providerDispatchEnabled:
        this.executing &&
        authority.phase === "running" &&
        authority.authorizationId !== null &&
        phase === "running",
      stopReason: phase === "paused" || phase === "invalidated" ? this.stopReason : null,
    });
    for (const listener of this.snapshotListeners) {
      try {
        listener(this.snapshot);
      } catch {
        // A presentation listener cannot alter the persisted execution state.
      }
    }
    return this.snapshot;
  }
}

function projectPhase(
  authority: NovelSkillPaidEvaluationAuthoritySnapshot,
  executing: boolean,
  locallyPaused: boolean,
): NovelSkillPaidEvaluationRunnerPhase {
  if (authority.phase === "invalidated" || authority.phase === "completed") {
    return authority.phase;
  }
  if (
    authority.settledCells === NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT &&
    authority.observedCells === NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT
  ) {
    return "awaiting_review";
  }
  if (locallyPaused && !executing && authority.phase === "running") return "paused";
  return authority.phase;
}

function freezeSnapshot(
  value: Omit<NovelSkillPaidEvaluationRunnerSnapshot, "totalCells" | "progressLabel">,
): NovelSkillPaidEvaluationRunnerSnapshot {
  return Object.freeze({
    ...value,
    totalCells: NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT,
    progressLabel: `${String(value.settledCells)}/${String(
      NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT,
    )}`,
  });
}

function assertAuthoritySnapshot(
  value: NovelSkillPaidEvaluationAuthoritySnapshot,
  runId: string,
): void {
  if (
    value.runId !== runId ||
    !Number.isSafeInteger(value.settledCells) ||
    !Number.isSafeInteger(value.observedCells) ||
    value.settledCells < 0 ||
    value.settledCells > NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT ||
    value.observedCells < 0 ||
    value.observedCells > value.settledCells
  ) {
    throw runnerError(
      "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
      "The paid evaluation authority returned invalid progress.",
    );
  }
}

function assertQuote(quote: NovelSkillPaidEvaluationRunnerQuote, runId: string): void {
  if (quote.runId !== runId || quote.quoteHash.length === 0 || quote.currencies.length === 0) {
    throw runnerError(
      "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
      "The commercial quote is not the fixed 192-call quote.",
    );
  }
}

function validateFixedMatrix(
  source: readonly NovelSkillPaidEvaluationRunnerCell[],
): readonly NovelSkillPaidEvaluationRunnerCell[] {
  if (source.length !== NOVEL_SKILL_PAID_EVALUATION_RUNNER_CELL_COUNT) {
    throw matrixError("The paid evaluation matrix must contain exactly 192 cells.");
  }
  const cells = [...source].sort((left, right) => left.executionOrder - right.executionOrder);
  const keys = new Set<string>();
  const fixtureCombinations = new Map<string, Set<string>>();
  const targetCounts = new Map<string, number>();
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell?.executionOrder !== index + 1) {
      throw matrixError("The paid evaluation serial order must be exactly 1 through 192.");
    }
    if (
      !NOVEL_SKILL_EVALUATION_ARMS.includes(cell.arm) ||
      !["text_tier_a", "text_tier_b"].includes(cell.modelSlotId) ||
      ![1, 2].includes(cell.repetition) ||
      !hasValidProviderDispatchCount(cell)
    ) {
      throw matrixError("A paid evaluation cell has an invalid frozen dimension.");
    }
    const key = `${cell.fixtureId}/${cell.arm}/${cell.modelSlotId}/${String(cell.repetition)}`;
    if (keys.has(key)) throw matrixError("The paid evaluation matrix contains a duplicate cell.");
    keys.add(key);
    const combinations = fixtureCombinations.get(cell.fixtureId) ?? new Set<string>();
    combinations.add(`${cell.arm}/${cell.modelSlotId}/${String(cell.repetition)}`);
    fixtureCombinations.set(cell.fixtureId, combinations);
    targetCounts.set(cell.modelSlotId, (targetCounts.get(cell.modelSlotId) ?? 0) + 1);
  }
  if (
    fixtureCombinations.size !== 12 ||
    [...fixtureCombinations.values()].some((combinations) => combinations.size !== 16) ||
    targetCounts.get("text_tier_a") !== 96 ||
    targetCounts.get("text_tier_b") !== 96
  ) {
    throw matrixError("The paid evaluation matrix is not the frozen 12 x 4 x 2 x 2 design.");
  }
  return Object.freeze(cells);
}

function hasValidProviderDispatchCount(cell: NovelSkillPaidEvaluationRunnerCell): boolean {
  const count = (cell as unknown as Readonly<{ providerDispatchCount?: unknown }>)
    .providerDispatchCount;
  return count === 0 || count === 1;
}

function assertProgressMatchesCells(
  authority: NovelSkillPaidEvaluationAuthoritySnapshot,
  cells: readonly NovelSkillPaidEvaluationRunnerCell[],
): void {
  const settled = cells.filter(({ dispatchState }) => dispatchState === "settled").length;
  const observed = cells.filter(({ observed }) => observed).length;
  if (authority.settledCells !== settled || authority.observedCells !== observed) {
    throw runnerError(
      "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
      "The paid evaluation progress does not match its cell authority.",
    );
  }
}

function assertSameCell(
  planned: NovelSkillPaidEvaluationRunnerCell,
  current: NovelSkillPaidEvaluationRunnerCell,
): void {
  if (
    planned.id !== current.id ||
    planned.executionOrder !== current.executionOrder ||
    planned.fixtureId !== current.fixtureId ||
    planned.arm !== current.arm ||
    planned.modelSlotId !== current.modelSlotId ||
    planned.repetition !== current.repetition
  ) {
    throw runnerError(
      "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
      "A paid evaluation cell changed after the matrix was frozen.",
    );
  }
}

function assertReservationState(
  reservation: NovelSkillPaidEvaluationReservationReference,
  expected: "bound" | "dispatched",
): void {
  if (reservation.state !== expected || !Number.isSafeInteger(reservation.revision)) {
    throw runnerError(
      "NOVEL_SKILL_PAID_RUNNER_AUTHORITY_INVALID",
      `The dispatch reservation did not enter ${expected}.`,
    );
  }
}

function hasDispatchedFlag(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "dispatched" in cause &&
    (cause as Readonly<{ dispatched?: unknown }>).dispatched === true
  );
}

function matrixError(message: string): NovelSkillPaidEvaluationRunnerError {
  return runnerError("NOVEL_SKILL_PAID_RUNNER_MATRIX_INVALID", message);
}

function runnerError(
  code: NovelSkillPaidEvaluationRunnerErrorCode,
  message: string,
): NovelSkillPaidEvaluationRunnerError {
  return new NovelSkillPaidEvaluationRunnerError(code, message);
}
