import { MODEL_HUB_TEXT_TASKS, type ModelHubTextTask } from "./model-hub-execution-service";
import { MODEL_PROVIDER_KINDS, type ModelProviderKind } from "./model-hub-provider-registry";
import {
  executeModelHubExactEvaluationTarget,
  inspectModelHubExactEvaluationTarget,
  type ExecuteModelHubExactEvaluationTargetInput,
  type InspectModelHubExactEvaluationTargetInput,
  type ModelHubExactEvaluationDependencies,
  type ModelHubExactEvaluationExecutionResult,
  type ModelHubExactEvaluationInspection,
  type ModelHubExactEvaluationPredispatchReceipt,
  type ModelHubExactEvaluationRequestProfile,
} from "./model-hub-exact-evaluation-target";
import {
  compileNovelSkillPaidEvaluationPayload,
  createNovelSkillPaidEvaluationContextBaselineProjection,
  createNovelSkillPaidEvaluationPreferenceProjection,
  createNovelSkillPaidEvaluationPromptTemplateProjection,
  resolveNovelSkillPaidEvaluationArmConfigurationHash,
  type CompileNovelSkillPaidEvaluationPayloadInput,
  type NovelSkillPaidEvaluationAuthoritativePayload,
  type NovelSkillPaidEvaluationPreferenceSource,
} from "./novel-skill-paid-evaluation-payload-authority";
import {
  NovelSkillPaidEvaluationRunner,
  type NovelSkillPaidEvaluationAuthoritySnapshot,
  type NovelSkillPaidEvaluationReservationReference,
  type NovelSkillPaidEvaluationRestartRecovery,
  type NovelSkillPaidEvaluationRunnerAuthorization,
  type NovelSkillPaidEvaluationRunnerCell,
  type NovelSkillPaidEvaluationRunnerPhase,
  type NovelSkillPaidEvaluationRunnerQuote,
  type NovelSkillPaidEvaluationRunnerSnapshot,
} from "./novel-skill-paid-evaluation-runner";
import {
  hashNovelSkillPaidEvaluationCommercialConfirmation,
  hashNovelSkillPaidEvaluationInvariantRequest,
  type NovelSkillPaidEvaluationQuote,
  type NovelSkillPaidEvaluationReservationRecord,
  type NovelSkillPaidEvaluationSqliteStore,
} from "./novel-skill-paid-evaluation-sqlite-store";
import type {
  NovelSkillEvaluationCellRecord,
  NovelSkillEvaluationSqliteStore,
} from "./novel-skill-evaluation-sqlite-store";
import type {
  NovelSkillPaidEvaluationBlindReviewItem as StoredBlindReviewItem,
  NovelSkillPaidEvaluationControlSnapshot,
  NovelSkillPaidEvaluationControlSqliteStore,
  NovelSkillPaidEvaluationControlTarget,
  NovelSkillPaidEvaluationControlReservation,
  NovelSkillPaidEvaluationExecutionAuthority,
  NovelSkillPaidEvaluationRecoverableRun,
} from "./novel-skill-paid-evaluation-control-sqlite-store";
import {
  NovelSkillPaidBlindReviewService,
  type NovelSkillPaidBlindReviewItem,
  type NovelSkillPaidBlindReviewSourceItem,
} from "./novel-skill-paid-blind-review-service";
import type { NovelSkillSqliteStore } from "./novel-skill-sqlite-store";
import type { ContextCompilationTrace } from "./context-compilation-trace-store";
import type {
  CompiledNovelSkills,
  NovelSkillEvaluationMetric,
  NovelSkillInvocationMode,
  NovelSkillTask,
} from "@inkshadow/ai-core";
import type { AiCandidateSnapshot, Clock } from "@inkshadow/domain";

const PAID_CALL_COUNT = 192 as const;
const PAID_SCORE_COUNT = 2_496 as const;
const BROWSER_UNAVAILABLE_REASON =
  "付费评估只可通过桌面原生模型网关运行；浏览器模式不会回退或发送请求。";

export type NovelSkillPaidEvaluationRuntimePhase =
  | "unavailable"
  | "not_prepared"
  | "awaiting_quote"
  | "awaiting_authorization"
  | "authorized_not_started"
  | "running_waiting"
  | "running_active"
  | "invalidated_ambiguous"
  | "awaiting_blind_review"
  | "blind_reviewing"
  | "completed";

export interface NovelSkillPaidEvaluationRuntimeCurrencyQuote {
  readonly currencyCode: string;
  readonly estimatedCostMicros: number;
  readonly hardCeilingMicros: number;
}

export interface NovelSkillPaidEvaluationRuntimeQuote {
  readonly quoteId: string;
  readonly exactTargetIds: readonly [string, string];
  readonly currencies: readonly NovelSkillPaidEvaluationRuntimeCurrencyQuote[];
}

/** No provider, model, slot, experiment arm or persistence hash crosses this boundary. */
export interface NovelSkillPaidEvaluationRuntimeBlindItem {
  readonly blindItemId: string;
  readonly randomizedPosition: number;
  readonly fixtureLabel: string;
  readonly boundaries: readonly string[];
  readonly lockedFacts: readonly string[];
  readonly requestedOutcome: string;
  readonly candidateText: string;
}

export interface NovelSkillPaidEvaluationRuntimeSnapshot {
  readonly phase: NovelSkillPaidEvaluationRuntimePhase;
  readonly runId: string | null;
  readonly quote: NovelSkillPaidEvaluationRuntimeQuote | null;
  readonly authorizationId: string | null;
  readonly completedProviderCalls: number;
  readonly sealedManualScores: number;
  readonly blindItem: NovelSkillPaidEvaluationRuntimeBlindItem | null;
  readonly unavailableReason?: string;
}

export type NovelSkillPaidEvaluationRecoverableRuntimeSelection =
  | Readonly<{ kind: "create_new" }>
  | Readonly<{ kind: "resume_existing"; runId: string }>
  | Readonly<{
      kind: "requires_user_selection";
      recoverableRuns: readonly NovelSkillPaidEvaluationRecoverableRun[];
    }>;

/**
 * Startup remains outside the fixed-run runtime. More than one recoverable run
 * deliberately produces a user-selection state instead of choosing silently.
 */
export function createRecoverableRuntimeSelection(
  recoverableRuns: readonly NovelSkillPaidEvaluationRecoverableRun[],
): NovelSkillPaidEvaluationRecoverableRuntimeSelection {
  if (recoverableRuns.length === 0) return Object.freeze({ kind: "create_new" });
  if (recoverableRuns.length === 1) {
    const [recoverableRun] = recoverableRuns;
    if (recoverableRun === undefined) {
      return Object.freeze({ kind: "create_new" });
    }
    return Object.freeze({
      kind: "resume_existing",
      runId: recoverableRun.runId,
    });
  }
  return Object.freeze({
    kind: "requires_user_selection",
    recoverableRuns: Object.freeze([...recoverableRuns]),
  });
}

/** Structurally compatible with the expert panel without importing React or component code. */
export interface NovelSkillPaidEvaluationRuntimePanelPort {
  readonly prepareAndQuote: (input: {
    readonly exactTargetIds: readonly [string, string];
  }) => Promise<NovelSkillPaidEvaluationRuntimeSnapshot>;
  readonly authorizeCommercialRun: (input: {
    readonly runId: string;
    readonly quoteId: string;
    readonly commercialUseAcknowledged: boolean;
  }) => Promise<NovelSkillPaidEvaluationRuntimeSnapshot>;
  readonly startAuthorizedRun: (input: {
    readonly runId: string;
    readonly authorizationId: string;
    readonly onProgress: (snapshot: NovelSkillPaidEvaluationRuntimeSnapshot) => void;
  }) => Promise<NovelSkillPaidEvaluationRuntimeSnapshot>;
  readonly cancelRun: (input: {
    readonly runId: string;
  }) => Promise<NovelSkillPaidEvaluationRuntimeSnapshot>;
  readonly beginBlindReview: (input: {
    readonly runId: string;
  }) => Promise<NovelSkillPaidEvaluationRuntimeSnapshot>;
  readonly sealBlindScores: (input: {
    readonly runId: string;
    readonly blindItemId: string;
    readonly scores: Readonly<Record<NovelSkillEvaluationMetric, number>>;
  }) => Promise<NovelSkillPaidEvaluationRuntimeSnapshot>;
}

type EvaluationStorePort = Pick<
  NovelSkillEvaluationSqliteStore,
  | "beginAttempt"
  | "completeRun"
  | "finishAttempt"
  | "getRunProgress"
  | "invalidateRun"
  | "listRunCells"
  | "repairSettledObservation"
>;

type PaidStorePort = Pick<
  NovelSkillPaidEvaluationSqliteStore,
  | "authorizeCommercialRun"
  | "markDispatchAmbiguous"
  | "markDispatchStarted"
  | "markNotDispatched"
  | "quoteCommercialRun"
  | "recoverInterruptedDispatches"
  | "reserveAndBindAttemptDispatch"
  | "settleDispatchSuccess"
  | "startAuthorizedRun"
>;

type ControlStorePort = Pick<
  NovelSkillPaidEvaluationControlSqliteStore,
  | "createBlindReviewBatch"
  | "getControlSnapshot"
  | "getNextBlindReviewItem"
  | "listReservations"
  | "listTargets"
  | "readExecutionAuthority"
  | "readBlindReviewBatch"
  | "sealBlindScores"
>;

type NovelSkillStorePort = Pick<NovelSkillSqliteStore, "commitInvocationBeforeDispatch">;

export interface NovelSkillPaidEvaluationRuntimeIdFactory {
  next(
    kind:
      | "attempt"
      | "authorization"
      | "candidate"
      | "invocation"
      | "reservation"
      | "skill_snapshot"
      | "trace",
  ): string;
}

export interface NovelSkillPaidEvaluationPreparationPort {
  /** Local-only preparation of the 0061 suite/run, 0063 protocol and two exact target locks. */
  preparePersistedRun(
    input: Readonly<{
      runId: string;
      exactTargetIds: readonly [string, string];
    }>,
  ): Promise<void>;
}

export interface NovelSkillPaidEvaluationPreferencePort {
  /** Returns the one frozen preference source set used by the preference A/B arm. */
  listFrozenPreferenceSources(
    runId: string,
  ): Promise<readonly NovelSkillPaidEvaluationPreferenceSource[]>;
}

export interface NovelSkillPaidEvaluationExactTargetPort {
  inspect(
    dependencies: ModelHubExactEvaluationDependencies,
    input: InspectModelHubExactEvaluationTargetInput,
  ): Promise<ModelHubExactEvaluationInspection>;
  execute(
    dependencies: ModelHubExactEvaluationDependencies,
    input: ExecuteModelHubExactEvaluationTargetInput,
  ): Promise<ModelHubExactEvaluationExecutionResult>;
}

export interface NovelSkillPaidEvaluationRuntimeOptions {
  readonly runId: string;
  readonly reviewerId: string;
  readonly clock: Clock;
  readonly ids: NovelSkillPaidEvaluationRuntimeIdFactory;
  readonly evaluationStore: EvaluationStorePort;
  readonly paidStore: PaidStorePort;
  readonly controlStore: ControlStorePort;
  readonly novelSkillStore: NovelSkillStorePort;
  readonly exactTargetDependencies: ModelHubExactEvaluationDependencies;
  readonly requestProfileForTask: (task: ModelHubTextTask) => ModelHubExactEvaluationRequestProfile;
  readonly contextBaselineTokenBudget: number | ((fixtureId: string) => number);
  readonly preferencePort: NovelSkillPaidEvaluationPreferencePort;
  readonly preparationPort?: NovelSkillPaidEvaluationPreparationPort;
  /** Tests may replace transport mechanics; production omits this and uses the exact target service. */
  readonly exactTargetPort?: NovelSkillPaidEvaluationExactTargetPort;
}

export type NovelSkillPaidEvaluationRuntimeErrorCode =
  | "NOVEL_SKILL_PAID_RUNTIME_UNAVAILABLE"
  | "NOVEL_SKILL_PAID_RUNTIME_INVALID"
  | "NOVEL_SKILL_PAID_RUNTIME_NOT_READY"
  | "NOVEL_SKILL_PAID_RUNTIME_AUTHORITY_CHANGED";

export class NovelSkillPaidEvaluationRuntimeError extends Error {
  public constructor(
    readonly code: NovelSkillPaidEvaluationRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NovelSkillPaidEvaluationRuntimeError";
  }
}

interface PreparedCell {
  readonly cell: NovelSkillPaidEvaluationRunnerCell;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly projectId: string;
  readonly attemptId: string;
  readonly reservationId: string;
  readonly traceId: string;
  readonly invocationId: string;
  readonly candidateId: string;
  readonly skillSnapshotId: string;
  readonly payloadAuthorityInput: CompileNovelSkillPaidEvaluationPayloadInput;
  readonly payloadAuthority: NovelSkillPaidEvaluationAuthoritativePayload;
  readonly inspection: ModelHubExactEvaluationInspection;
  readonly trace: ContextCompilationTrace;
  readonly protocolHash: string;
}

interface RuntimeReceipt {
  readonly prepared: PreparedCell;
  readonly receipt: ModelHubExactEvaluationPredispatchReceipt;
}

interface RuntimeExecutionResult {
  readonly prepared: PreparedCell;
  readonly result: ModelHubExactEvaluationExecutionResult;
}

interface SharedRuntimeState {
  exactTargetIds: readonly [string, string] | null;
  latestControl: NovelSkillPaidEvaluationControlSnapshot | null;
  latestQuote: NovelSkillPaidEvaluationQuote | null;
  executionAuthority: NovelSkillPaidEvaluationExecutionAuthority | null;
}

const DEFAULT_EXACT_TARGET_PORT: NovelSkillPaidEvaluationExactTargetPort = Object.freeze({
  inspect: inspectModelHubExactEvaluationTarget,
  execute: executeModelHubExactEvaluationTarget,
});

export class NovelSkillPaidEvaluationRuntime {
  private readonly state: SharedRuntimeState = {
    exactTargetIds: null,
    latestControl: null,
    latestQuote: null,
    executionAuthority: null,
  };
  private readonly authority: RuntimeAuthority;
  private readonly runner: NovelSkillPaidEvaluationRunner<
    PreparedCell,
    RuntimeReceipt,
    RuntimeExecutionResult
  >;
  private blindBatchId: string | null = null;
  private blindReview: NovelSkillPaidBlindReviewService | null = null;
  private currentBlindItem: NovelSkillPaidBlindReviewItem | null = null;
  private cancellationEpoch = 0;

  public constructor(private readonly options: NovelSkillPaidEvaluationRuntimeOptions) {
    const exactTargetPort = options.exactTargetPort ?? DEFAULT_EXACT_TARGET_PORT;
    this.authority = new RuntimeAuthority(options, exactTargetPort, this.state);
    this.runner = new NovelSkillPaidEvaluationRunner(options.runId, {
      authority: this.authority,
      exactExecutor: {
        executeExactlyOnce: async (input) => {
          const result = await exactTargetPort.execute(options.exactTargetDependencies, {
            generationId: input.prepared.invocationId,
            inspection: input.prepared.inspection,
            // This is deliberately the sole message source at the provider boundary.
            messages: input.prepared.payloadAuthority.messages,
            reserveAndBindBeforeDispatch: (receipt) =>
              input.reserveAndBindBeforeDispatch(
                Object.freeze({ prepared: input.prepared, receipt }),
              ),
            markDispatchStarted: (receipt) =>
              input.markDispatchStarted(Object.freeze({ prepared: input.prepared, receipt })),
            assertBeforeProviderDispatch: input.assertBeforeProviderDispatch,
          });
          return Object.freeze({ prepared: input.prepared, result });
        },
      },
    });
  }

  public get runId(): string {
    return this.options.runId;
  }

  public get nativeGatewayAvailable(): boolean {
    return this.options.exactTargetDependencies.modelGateway.available;
  }

  public async initialize(): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const control = await this.options.controlStore.getControlSnapshot(this.options.runId);
    if (control === null) {
      return Object.freeze({
        phase: "not_prepared",
        runId: this.options.runId,
        quote: null,
        authorizationId: null,
        completedProviderCalls: 0,
        sealedManualScores: 0,
        blindItem: null,
      });
    }
    const snapshot = await this.runner.initialize();
    return this.present(snapshot);
  }

  public async prepareAndQuote(
    exactTargetIds: readonly [string, string],
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    this.assertNativeGatewayAvailable();
    assertExactTargetIds(exactTargetIds);
    this.state.exactTargetIds = Object.freeze([exactTargetIds[0], exactTargetIds[1]]);
    if (this.options.preparationPort !== undefined) {
      await this.options.preparationPort.preparePersistedRun({
        runId: this.options.runId,
        exactTargetIds: this.state.exactTargetIds,
      });
    }
    let snapshot = await this.runner.initialize();
    if (snapshot.phase === "draft") {
      snapshot = await this.runner.prepare();
    }
    await this.authority.assertExactTargetIds(exactTargetIds);
    if (snapshot.phase === "prepared" || snapshot.phase === "quoted") {
      const quoted = await this.runner.quote();
      snapshot = quoted.snapshot;
    } else if (
      !["authorized", "running", "paused", "awaiting_review", "completed"].includes(snapshot.phase)
    ) {
      throw runtimeError("NOVEL_SKILL_PAID_RUNTIME_NOT_READY", "The paid run is not quotable.");
    }
    if (this.state.latestQuote === null) {
      if (this.state.latestControl?.status !== "planned") {
        throw runtimeError(
          "NOVEL_SKILL_PAID_RUNTIME_NOT_READY",
          "A running paid evaluation cannot recreate its commercial quote.",
        );
      }
      this.state.latestQuote = await this.options.paidStore.quoteCommercialRun(this.options.runId);
    }
    return this.present(snapshot);
  }

  public async authorizeCommercialRun(
    input: Readonly<{
      runId: string;
      quoteId: string;
      commercialUseAcknowledged: boolean;
    }>,
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    this.assertNativeGatewayAvailable();
    assertRunId(input.runId, this.options.runId);
    if (!input.commercialUseAcknowledged) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_INVALID",
        "Commercial evaluation requires the local user's explicit acknowledgement.",
      );
    }
    const quote = await this.options.paidStore.quoteCommercialRun(this.options.runId);
    if (quote.quoteHash !== input.quoteId) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_AUTHORITY_CHANGED",
        "The commercial quote changed before authorization.",
      );
    }
    const hardCeilings = Object.freeze(
      quote.currencies.map(({ currency, estimatedMaximumCostMicros }) =>
        Object.freeze({ currency, hardCeilingMicros: estimatedMaximumCostMicros }),
      ),
    );
    const authorization: NovelSkillPaidEvaluationRunnerAuthorization = Object.freeze({
      authorizationId: this.options.ids.next("authorization"),
      runId: this.options.runId,
      quoteHash: quote.quoteHash,
      confirmationHash: await hashNovelSkillPaidEvaluationCommercialConfirmation({
        quote,
        hardCeilings,
      }),
      hardCeilings,
      authorizedAt: this.options.clock.now(),
    });
    this.state.latestQuote = quote;
    const snapshot = await this.runner.authorize(authorization);
    return this.present(snapshot);
  }

  /** The only public operation that can call Runner.start and reach a provider. */
  public async startAuthorizedRun(
    input: Readonly<{
      runId: string;
      authorizationId: string;
      onProgress: (snapshot: NovelSkillPaidEvaluationRuntimeSnapshot) => void;
    }>,
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    this.assertNativeGatewayAvailable();
    assertRunId(input.runId, this.options.runId);
    const cancellationEpoch = this.cancellationEpoch;
    const executionAuthority = await this.options.controlStore.readExecutionAuthority(
      this.options.runId,
    );
    if (
      executionAuthority?.authorizationId !== input.authorizationId ||
      executionAuthority.quoteHash === null ||
      (executionAuthority.status !== "planned" && executionAuthority.status !== "running")
    ) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_AUTHORITY_CHANGED",
        "The persisted authorization no longer matches the start request.",
      );
    }
    if (cancellationEpoch !== this.cancellationEpoch) {
      return this.present(await this.runner.initialize());
    }
    const unsubscribe = this.runner.subscribe((snapshot) => {
      input.onProgress(this.presentFromCache(snapshot));
    });
    try {
      // Runner.start resets its own previous-pass latch synchronously. Any
      // cancellation after this line is therefore part of this exact pass.
      const started = await this.runner.start();
      return await this.present(started);
    } finally {
      unsubscribe();
    }
  }

  public async cancelRun(runId: string): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    assertRunId(runId, this.options.runId);
    this.cancellationEpoch += 1;
    this.runner.requestCancellation();
    return this.present(this.runner.getSnapshot());
  }

  /** Local restart recovery; it never enters the exact executor. */
  public async recoverAfterRestart(): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    return this.present(await this.runner.recoverAfterRestart());
  }

  public async beginBlindReview(runId: string): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    assertRunId(runId, this.options.runId);
    const runnerSnapshot = await this.runner.initialize();
    if (runnerSnapshot.phase !== "awaiting_review" && runnerSnapshot.phase !== "completed") {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_NOT_READY",
        "Blind review requires all 192 local observation receipts.",
      );
    }
    const batchId = await deterministicUuidV7("novel-skill-paid-blind-batch@1", runId);
    await this.options.controlStore.createBlindReviewBatch({
      batchId,
      runId,
      reviewerId: this.options.reviewerId,
      createdAt: this.options.clock.now(),
    });
    this.blindBatchId = batchId;
    this.blindReview = this.createBlindReviewService(batchId);
    await this.blindReview.readBatch();
    this.currentBlindItem = await this.blindReview.nextItem();
    if (this.currentBlindItem === null && runnerSnapshot.phase === "awaiting_review") {
      await this.options.evaluationStore.completeRun(this.options.runId, this.options.clock.now());
      return this.present(await this.runner.initialize());
    }
    return this.present(runnerSnapshot);
  }

  public async sealBlindScores(
    input: Readonly<{
      runId: string;
      blindItemId: string;
      scores: Parameters<NovelSkillPaidBlindReviewService["submitScores"]>[0]["scores"];
    }>,
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    assertRunId(input.runId, this.options.runId);
    if (this.blindReview === null || this.blindBatchId === null) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_NOT_READY",
        "The blinded review batch has not been opened in this session.",
      );
    }
    await this.blindReview.submitScores({
      blindItemId: input.blindItemId,
      scores: input.scores,
    });
    this.currentBlindItem = await this.blindReview.nextItem();
    if (this.currentBlindItem === null) {
      await this.options.evaluationStore.completeRun(this.options.runId, this.options.clock.now());
    }
    return this.present(await this.runner.initialize());
  }

  public unavailableSnapshot(): NovelSkillPaidEvaluationRuntimeSnapshot {
    return Object.freeze({
      phase: "unavailable",
      runId: this.options.runId,
      quote: null,
      authorizationId: null,
      completedProviderCalls: 0,
      sealedManualScores: 0,
      blindItem: null,
      unavailableReason: BROWSER_UNAVAILABLE_REASON,
    });
  }

  private createBlindReviewService(batchId: string): NovelSkillPaidBlindReviewService {
    const reviewerId = this.options.reviewerId;
    const control = this.options.controlStore;
    const clock = this.options.clock;
    return new NovelSkillPaidBlindReviewService(batchId, {
      readBatchItems: async (id) =>
        stripStoredBlindItems(await control.readBlindReviewBatch({ batchId: id, reviewerId })),
      readNextUnscoredItem: async (id) => {
        const item = await control.getNextBlindReviewItem({ batchId: id, reviewerId });
        return item === null ? null : stripStoredBlindItem(item);
      },
      submitBlindScores: async ({ batchId: id, blindItemId, scores }) => {
        const scoredAt = clock.now();
        await control.sealBlindScores({
          batchId: id,
          blindItemId,
          reviewerId,
          scores,
          scoredAt,
          sealedAt: clock.now(),
        });
      },
    });
  }

  private async present(
    snapshot: NovelSkillPaidEvaluationRunnerSnapshot,
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    this.state.latestControl = await this.options.controlStore.getControlSnapshot(
      this.options.runId,
    );
    if (this.state.latestControl === null) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_AUTHORITY_CHANGED",
        "The paid evaluation control record is missing.",
      );
    }
    return this.presentFromCache(snapshot);
  }

  private presentFromCache(
    snapshot: NovelSkillPaidEvaluationRunnerSnapshot,
  ): NovelSkillPaidEvaluationRuntimeSnapshot {
    const control = this.state.latestControl;
    return Object.freeze({
      phase: panelPhase(
        snapshot.phase,
        snapshot.providerDispatchEnabled,
        this.blindReview !== null,
      ),
      runId: snapshot.runId,
      quote:
        this.state.latestQuote === null || this.state.exactTargetIds === null
          ? null
          : panelQuote(this.state.latestQuote, this.state.exactTargetIds),
      authorizationId: snapshot.authorizationId,
      completedProviderCalls: snapshot.settledCells,
      sealedManualScores: control?.sealedScoreCount ?? 0,
      blindItem:
        this.currentBlindItem === null
          ? null
          : Object.freeze({
              blindItemId: this.currentBlindItem.blindItemId,
              randomizedPosition: this.currentBlindItem.position,
              fixtureLabel: this.currentBlindItem.fixtureTaskContent,
              boundaries: Object.freeze([...this.currentBlindItem.boundaries]),
              lockedFacts: Object.freeze([...this.currentBlindItem.lockedFacts]),
              requestedOutcome: this.currentBlindItem.requestedOutcome,
              candidateText: this.currentBlindItem.candidateOutput,
            }),
    });
  }

  private assertNativeGatewayAvailable(): void {
    if (!this.nativeGatewayAvailable) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_UNAVAILABLE",
        "Paid evaluation is unavailable outside the desktop native model gateway.",
      );
    }
  }
}

class RuntimeAuthority {
  public constructor(
    private readonly options: NovelSkillPaidEvaluationRuntimeOptions,
    private readonly exactTarget: NovelSkillPaidEvaluationExactTargetPort,
    private readonly state: SharedRuntimeState,
  ) {}

  public async inspectRun(runId: string): Promise<NovelSkillPaidEvaluationAuthoritySnapshot> {
    const control = await this.requireControl(runId);
    if (control.exactTargetCount === 2) {
      const targets = [...(await this.options.controlStore.listTargets(runId))].sort(
        (left, right) => left.modelSlotId.localeCompare(right.modelSlotId, "en"),
      );
      const [firstTarget, secondTarget] = targets;
      if (firstTarget === undefined || secondTarget === undefined || targets.length !== 2) {
        throw authorityChanged("The persisted exact-target pair is incomplete.");
      }
      this.state.exactTargetIds = Object.freeze([
        targetUiId(firstTarget),
        targetUiId(secondTarget),
      ]);
    }
    const executionAuthority = control.protocolConfigured
      ? await this.options.controlStore.readExecutionAuthority(runId)
      : null;
    if (control.protocolConfigured && executionAuthority === null) {
      throw authorityChanged("The persisted execution protocol authority is missing.");
    }
    if (
      executionAuthority !== null &&
      (executionAuthority.runId !== runId || executionAuthority.status !== control.status)
    ) {
      throw authorityChanged("The persisted execution authority changed while it was read.");
    }
    if (
      executionAuthority !== null &&
      executionAuthority.authorizationId !== control.authorizationId
    ) {
      throw authorityChanged("The persisted authorization changed while it was read.");
    }
    this.state.executionAuthority = executionAuthority;
    let quoteHash: string | null = executionAuthority?.quoteHash ?? null;
    if (
      control.status === "planned" &&
      control.protocolConfigured &&
      control.exactTargetCount === 2
    ) {
      this.state.latestQuote = await this.options.paidStore.quoteCommercialRun(runId);
      if (
        executionAuthority !== null &&
        this.state.latestQuote.protocolHash !== executionAuthority.protocolHash
      ) {
        throw authorityChanged("The commercial quote no longer matches the persisted protocol.");
      }
      if (
        executionAuthority?.quoteHash !== null &&
        executionAuthority?.quoteHash !== undefined &&
        this.state.latestQuote.quoteHash !== executionAuthority.quoteHash
      ) {
        throw authorityChanged("The commercial quote no longer matches the authorization.");
      }
      quoteHash = this.state.latestQuote.quoteHash;
    }
    return Object.freeze({
      runId,
      phase: authorityPhase(control),
      settledCells: control.reservationCounts.settled,
      observedCells: control.observationCount,
      quoteHash,
      authorizationId: control.authorizationId,
    });
  }

  public async prepareRun(runId: string): Promise<void> {
    assertRunId(runId, this.options.runId);
    if (this.options.preparationPort !== undefined) {
      if (this.state.exactTargetIds === null) {
        throw runtimeError(
          "NOVEL_SKILL_PAID_RUNTIME_NOT_READY",
          "Two exact target identifiers are required before local preparation.",
        );
      }
      await this.options.preparationPort.preparePersistedRun({
        runId,
        exactTargetIds: this.state.exactTargetIds,
      });
    }
    const control = await this.requireControl(runId);
    if (!control.protocolConfigured || control.exactTargetCount !== 2) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_NOT_READY",
        "The persisted 0061/0063 evaluation plan is incomplete.",
      );
    }
  }

  public async quoteRun(runId: string): Promise<NovelSkillPaidEvaluationRunnerQuote> {
    const quote = await this.options.paidStore.quoteCommercialRun(runId);
    this.state.latestQuote = quote;
    return Object.freeze({
      runId: quote.runId,
      quoteHash: quote.quoteHash,
      authorizedCallCount: quote.authorizedCallCount,
      currencies: quote.currencies,
    });
  }

  public async authorizeRun(input: NovelSkillPaidEvaluationRunnerAuthorization): Promise<void> {
    await this.options.paidStore.authorizeCommercialRun(input);
  }

  public async startAuthorizedRun(runId: string): Promise<void> {
    await this.options.paidStore.startAuthorizedRun(runId, this.options.clock.now());
  }

  public async listCells(runId: string): Promise<readonly NovelSkillPaidEvaluationRunnerCell[]> {
    const [cells, reservations] = await Promise.all([
      this.options.evaluationStore.listRunCells(runId),
      this.options.controlStore.listReservations(runId),
    ]);
    return mapRunnerCells(cells, reservations);
  }

  public async getCell(runId: string, cellId: string): Promise<NovelSkillPaidEvaluationRunnerCell> {
    const cells = await this.listCells(runId);
    const cell = cells.find(({ id }) => id === cellId);
    if (cell === undefined) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_AUTHORITY_CHANGED",
        "The fixed evaluation cell is missing.",
      );
    }
    return cell;
  }

  public async prepareCell(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
  ): Promise<PreparedCell> {
    if (!this.options.exactTargetDependencies.modelGateway.available) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_UNAVAILABLE",
        "The desktop native model gateway is unavailable.",
      );
    }
    const [storedCells, progress, targets, executionAuthority] = await Promise.all([
      this.options.evaluationStore.listRunCells(runId),
      this.options.evaluationStore.getRunProgress(runId),
      this.options.controlStore.listTargets(runId),
      this.options.controlStore.readExecutionAuthority(runId),
    ]);
    if (
      executionAuthority?.status !== "running" ||
      executionAuthority.authorizationId === null ||
      executionAuthority.quoteHash === null
    ) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_AUTHORITY_CHANGED",
        "The persisted running execution authority is unavailable.",
      );
    }
    const expectedExecutionAuthority = this.state.executionAuthority;
    if (
      expectedExecutionAuthority?.protocolHash !== executionAuthority.protocolHash ||
      expectedExecutionAuthority.authorizationId !== executionAuthority.authorizationId ||
      expectedExecutionAuthority.quoteHash !== executionAuthority.quoteHash
    ) {
      throw authorityChanged("The running execution authority changed before cell preparation.");
    }
    const latestQuoteProtocolHash = this.state.latestQuote?.protocolHash;
    if (
      latestQuoteProtocolHash !== undefined &&
      latestQuoteProtocolHash !== executionAuthority.protocolHash
    ) {
      throw authorityChanged("The running execution protocol changed after authorization.");
    }
    this.state.executionAuthority = executionAuthority;
    const protocolHash = executionAuthority.protocolHash;
    const stored = storedCells.find(({ id }) => id === cell.id);
    if (stored === undefined) throw authorityChanged("The evaluation cell disappeared.");
    const taskType = requireNovelSkillTask(stored.taskType);
    const invocationMode = requireInvocationMode(stored.invocationMode);
    const target = requireCellTarget(targets, cell.modelSlotId);
    const profile = this.options.requestProfileForTask(requireModelHubTask(stored.taskType));
    if (profile.task !== stored.taskType) {
      throw authorityChanged("The request profile no longer matches the fixed fixture task.");
    }
    const promptTemplate = await createNovelSkillPaidEvaluationPromptTemplateProjection();
    const contextBaseline = await createNovelSkillPaidEvaluationContextBaselineProjection(
      stored.fixtureId,
      baselineBudget(this.options.contextBaselineTokenBudget, stored.fixtureId),
    );
    const preferenceProjection =
      stored.arm === "core_genre_preferences"
        ? await createNovelSkillPaidEvaluationPreferenceProjection(
            await this.options.preferencePort.listFrozenPreferenceSources(runId),
          )
        : null;
    const payloadAuthorityInput: CompileNovelSkillPaidEvaluationPayloadInput = Object.freeze({
      cell: Object.freeze({
        runId,
        suiteId: progress.suiteId,
        cellId: stored.id,
        fixtureId: stored.fixtureId,
        fixtureInputContentHash: stored.fixtureInputContentHash,
        taskType,
        invocationMode,
        arm: stored.arm,
        armConfigurationHash: await resolveNovelSkillPaidEvaluationArmConfigurationHash(stored.arm),
        modelSlotId: cell.modelSlotId,
        repetition: requireRepetition(stored.repetition),
      }),
      promptTemplate,
      contextBaseline,
      preferenceProjection,
    });
    const payloadAuthority = await compileNovelSkillPaidEvaluationPayload(payloadAuthorityInput);
    const inspection = await this.exactTarget.inspect(this.options.exactTargetDependencies, {
      target: {
        connectionId: target.connectionId,
        catalogEntryId: target.catalogEntryId,
        providerKind: requireProviderKind(target.providerKind),
        modelId: target.providerModelId,
      },
      requestProfile: profile,
      messages: payloadAuthority.messages,
    });
    assertInspectionMatchesAuthority(inspection, payloadAuthority, target);

    const invocationId = this.options.ids.next("invocation");
    const createdAt = this.options.clock.now();
    const traceId = this.options.ids.next("trace");
    const trace = await createRuntimeTrace({
      traceId,
      projectId: progress.evaluationProjectId,
      invocationId,
      taskType,
      createdAt,
      payloadInput: payloadAuthorityInput,
    });
    return Object.freeze({
      cell,
      taskType,
      invocationMode,
      projectId: progress.evaluationProjectId,
      attemptId: this.options.ids.next("attempt"),
      reservationId: this.options.ids.next("reservation"),
      traceId,
      invocationId,
      candidateId: this.options.ids.next("candidate"),
      skillSnapshotId: this.options.ids.next("skill_snapshot"),
      payloadAuthorityInput,
      payloadAuthority,
      inspection,
      trace,
      protocolHash,
    });
  }

  public async reserveAndBind(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    runtimeReceipt: RuntimeReceipt,
  ): Promise<NovelSkillPaidEvaluationReservationReference> {
    assertPreparedReceipt(runtimeReceipt, runId, cell);
    const prepared = runtimeReceipt.prepared;
    const control = await this.requireControl(runId);
    if (control.authorizationId === null) {
      throw runtimeError(
        "NOVEL_SKILL_PAID_RUNTIME_AUTHORITY_CHANGED",
        "The commercial authorization disappeared before reservation.",
      );
    }
    const startedAt = this.options.clock.now();
    const dispatchGeneration = await this.options.evaluationStore.beginAttempt({
      attemptId: prepared.attemptId,
      runId,
      cellId: cell.id,
      startedAt,
    });
    const boundAt = this.options.clock.now();
    let reservation: NovelSkillPaidEvaluationReservationRecord;
    try {
      reservation = await this.options.paidStore.reserveAndBindAttemptDispatch({
        reservation: {
          reservationId: prepared.reservationId,
          authorizationId: control.authorizationId,
          runId,
          cellId: cell.id,
          attemptId: prepared.attemptId,
          modelSlotId: cell.modelSlotId,
          dispatchGeneration,
          plannedContextTraceId: prepared.traceId,
          plannedModelInvocationId: prepared.invocationId,
          plannedCandidateId: prepared.candidateId,
          receipt: runtimeReceipt.receipt,
          contextBaselineHash: prepared.payloadAuthority.manifest.contextBaselineHash,
          promptTemplateHash: prepared.payloadAuthority.manifest.promptTemplateHash,
          invariantRequestHash: await hashNovelSkillPaidEvaluationInvariantRequest({
            runId,
            suiteId: prepared.payloadAuthority.manifest.suiteId,
            fixtureId: prepared.payloadAuthority.manifest.fixtureId,
            taskType: prepared.taskType,
            modelSlotId: cell.modelSlotId,
            repetition: prepared.payloadAuthority.manifest.repetition,
            protocolHash: prepared.protocolHash,
            requestProfileHash: runtimeReceipt.receipt.requestProfileHash,
            contextBaselineHash: prepared.payloadAuthority.manifest.contextBaselineHash,
            promptTemplateHash: prepared.payloadAuthority.manifest.promptTemplateHash,
          }),
          skillConfigurationHash: prepared.payloadAuthority.manifest.armConfigurationHash,
          preferenceConfigurationHash:
            prepared.payloadAuthority.manifest.preferenceConfigurationHash,
          idempotencyKeyHash: await sha256Hex(
            `novel-skill-paid-dispatch@1/${prepared.reservationId}`,
          ),
          reservedAt: startedAt,
        },
        trace: prepared.trace,
        payloadAuthorityInput: prepared.payloadAuthorityInput,
        payloadAuthority: prepared.payloadAuthority,
        boundAt,
      });
    } catch (cause: unknown) {
      await this.options.evaluationStore
        .finishAttempt({
          attemptId: prepared.attemptId,
          status: "cancelled",
          contextTraceId: null,
          modelInvocationId: null,
          errorCode: "PREDISPATCH_RESERVATION_FAILED",
          completedAt: this.options.clock.now(),
        })
        .catch(() => undefined);
      throw cause;
    }
    if (reservation.state !== "bound") {
      throw authorityChanged("The exact reservation did not become bound.");
    }
    if (prepared.payloadAuthority.compiledSkills !== null) {
      await this.commitSkillSnapshot(prepared, prepared.payloadAuthority.compiledSkills, boundAt);
    }
    return reservationReference(reservation);
  }

  public async markDispatchStarted(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
    runtimeReceipt: RuntimeReceipt,
  ): Promise<NovelSkillPaidEvaluationReservationReference> {
    assertPreparedReceipt(runtimeReceipt, runId, cell);
    if (reservation.reservationId !== runtimeReceipt.prepared.reservationId) {
      throw authorityChanged("The dispatch receipt changed after reservation.");
    }
    return reservationReference(
      await this.options.paidStore.markDispatchStarted(
        reservation.reservationId,
        reservation.revision,
        this.options.clock.now(),
      ),
    );
  }

  public async settleSuccess(
    runId: string,
    cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
    execution: RuntimeExecutionResult,
  ): Promise<void> {
    assertRunId(runId, this.options.runId);
    if (
      execution.prepared.cell.id !== cell.id ||
      execution.prepared.reservationId !== reservation.reservationId
    ) {
      throw authorityChanged("The provider result changed its prepared evaluation cell.");
    }
    const completedAt = this.options.clock.now();
    const candidate: AiCandidateSnapshot = {
      id: execution.prepared.candidateId,
      projectId: execution.prepared.projectId,
      chapterId: null,
      source: "generate",
      baseVersionId: null,
      content: execution.result.text,
      contentChecksum: execution.result.visibleOutputHash,
      status: "ready",
      revision: 1,
      incomplete: false,
      createdAt: completedAt,
      updatedAt: completedAt,
      decidedAt: null,
    } as AiCandidateSnapshot;
    await this.options.paidStore.settleDispatchSuccess({
      reservationId: reservation.reservationId,
      expectedRevision: reservation.revision,
      candidate,
      result: execution.result,
      completedAt,
    });
  }

  public async releasePredispatch(
    _runId: string,
    _cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
  ): Promise<void> {
    await this.options.paidStore.markNotDispatched(
      reservation.reservationId,
      reservation.revision,
      this.options.clock.now(),
    );
  }

  public async markAmbiguousAndInvalidate(
    _runId: string,
    _cell: NovelSkillPaidEvaluationRunnerCell,
    reservation: NovelSkillPaidEvaluationReservationReference,
  ): Promise<void> {
    await this.options.paidStore.markDispatchAmbiguous(
      reservation.reservationId,
      reservation.revision,
      this.options.clock.now(),
    );
  }

  public async invalidateRun(
    runId: string,
    reason: "dispatch_uncertain" | "authority_changed",
  ): Promise<void> {
    void reason;
    await this.options.evaluationStore.invalidateRun(runId, this.options.clock.now());
  }

  public async recoverInterruptedDispatches(
    runId: string,
  ): Promise<NovelSkillPaidEvaluationRestartRecovery> {
    const result = await this.options.paidStore.recoverInterruptedDispatches(
      runId,
      this.options.clock.now(),
    );
    return Object.freeze({
      releasedPredispatch: result.released,
      invalidatedAmbiguous: result.ambiguous,
    });
  }

  public async repairSettledObservation(runId: string, cellId: string): Promise<void> {
    await this.options.evaluationStore.repairSettledObservation({
      observationId: await deterministicUuidV7("novel-skill-paid-observation@1", runId, cellId),
      runId,
      cellId,
      createdAt: this.options.clock.now(),
    });
  }

  public async assertExactTargetIds(ids: readonly [string, string]): Promise<void> {
    const targets = [...(await this.options.controlStore.listTargets(this.options.runId))].sort(
      (left, right) => left.modelSlotId.localeCompare(right.modelSlotId, "en"),
    );
    const [firstTarget, secondTarget] = targets;
    if (
      firstTarget === undefined ||
      secondTarget === undefined ||
      targets.length !== 2 ||
      targetUiId(firstTarget) !== ids[0] ||
      targetUiId(secondTarget) !== ids[1]
    ) {
      throw authorityChanged("The selected exact targets do not match the persisted two slots.");
    }
  }

  private async requireControl(runId: string): Promise<NovelSkillPaidEvaluationControlSnapshot> {
    const control = await this.options.controlStore.getControlSnapshot(runId);
    if (control === null) throw authorityChanged("The paid evaluation run is missing.");
    this.state.latestControl = control;
    return control;
  }

  private async commitSkillSnapshot(
    prepared: PreparedCell,
    compiled: CompiledNovelSkills,
    createdAt: string,
  ): Promise<void> {
    await this.options.novelSkillStore.commitInvocationBeforeDispatch({
      snapshotId: prepared.skillSnapshotId,
      projectId: prepared.projectId,
      contextTraceId: prepared.traceId,
      modelInvocationId: prepared.invocationId,
      taskType: prepared.taskType,
      invocationMode: prepared.invocationMode,
      compiled,
      createdAt,
    });
  }
}

export function createNovelSkillPaidEvaluationRuntime(
  options: NovelSkillPaidEvaluationRuntimeOptions,
): NovelSkillPaidEvaluationRuntime {
  return new NovelSkillPaidEvaluationRuntime(options);
}

/** Creates the expert-panel boundary without registering it in Settings or the app runtime. */
export function createNovelSkillPaidEvaluationPanelPort(
  runtime: NovelSkillPaidEvaluationRuntime,
): NovelSkillPaidEvaluationRuntimePanelPort {
  if (!runtime.nativeGatewayAvailable) {
    return createUnavailableNovelSkillPaidEvaluationPanelPort(
      runtime.unavailableSnapshot().unavailableReason,
    );
  }
  const port: NovelSkillPaidEvaluationRuntimePanelPort = {
    prepareAndQuote: ({ exactTargetIds }) => runtime.prepareAndQuote(exactTargetIds),
    authorizeCommercialRun: (input) => runtime.authorizeCommercialRun(input),
    startAuthorizedRun: (input) => runtime.startAuthorizedRun(input),
    cancelRun: ({ runId }) => runtime.cancelRun(runId),
    beginBlindReview: ({ runId }) => runtime.beginBlindReview(runId),
    sealBlindScores: (input) => runtime.sealBlindScores(input),
  };
  return Object.freeze(port);
}

/** Browser wiring can use this directly without constructing stores or a fake runtime. */
export function createUnavailableNovelSkillPaidEvaluationPanelPort(
  reason = BROWSER_UNAVAILABLE_REASON,
): NovelSkillPaidEvaluationRuntimePanelPort {
  const unavailable: NovelSkillPaidEvaluationRuntimeSnapshot = Object.freeze({
    phase: "unavailable",
    runId: null,
    quote: null,
    authorizationId: null,
    completedProviderCalls: 0,
    sealedManualScores: 0,
    blindItem: null,
    unavailableReason: reason,
  });
  const port: NovelSkillPaidEvaluationRuntimePanelPort = {
    prepareAndQuote: () => Promise.resolve(unavailable),
    authorizeCommercialRun: () => Promise.resolve(unavailable),
    startAuthorizedRun: () => Promise.resolve(unavailable),
    cancelRun: () => Promise.resolve(unavailable),
    beginBlindReview: () => Promise.resolve(unavailable),
    sealBlindScores: () => Promise.resolve(unavailable),
  };
  return Object.freeze(port);
}

export function novelSkillPaidEvaluationTargetId(
  target: Pick<NovelSkillPaidEvaluationControlTarget, "catalogEntryId">,
): string {
  return targetUiId(target);
}

function authorityPhase(
  control: NovelSkillPaidEvaluationControlSnapshot,
): NovelSkillPaidEvaluationAuthoritySnapshot["phase"] {
  if (control.status === "invalidated" || control.status === "completed") return control.status;
  if (control.status === "running") return "running";
  if (control.authorizationId !== null) return "authorized";
  if (control.protocolConfigured && control.exactTargetCount === 2) return "quoted";
  if (control.protocolConfigured) return "prepared";
  return "draft";
}

function panelPhase(
  phase: NovelSkillPaidEvaluationRunnerPhase,
  providerDispatchEnabled: boolean,
  blindReviewOpen: boolean,
): NovelSkillPaidEvaluationRuntimeSnapshot["phase"] {
  switch (phase) {
    case "uninitialized":
    case "draft":
      return "not_prepared";
    case "prepared":
      return "awaiting_quote";
    case "quoted":
      return "awaiting_authorization";
    case "authorized":
      return "authorized_not_started";
    case "running":
      return providerDispatchEnabled ? "running_active" : "running_waiting";
    case "paused":
      return "running_waiting";
    case "awaiting_review":
      return blindReviewOpen ? "blind_reviewing" : "awaiting_blind_review";
    case "invalidated":
      return "invalidated_ambiguous";
    case "completed":
      return "completed";
  }
}

function panelQuote(
  quote: NovelSkillPaidEvaluationQuote,
  exactTargetIds: readonly [string, string],
): NovelSkillPaidEvaluationRuntimeQuote {
  return Object.freeze({
    quoteId: quote.quoteHash,
    exactTargetIds,
    currencies: Object.freeze(
      quote.currencies.map(({ currency, estimatedMaximumCostMicros }) => {
        const cost = Number(estimatedMaximumCostMicros);
        if (!Number.isSafeInteger(cost) || cost < 0) {
          throw runtimeError(
            "NOVEL_SKILL_PAID_RUNTIME_INVALID",
            "The panel cannot safely represent the commercial quote.",
          );
        }
        return Object.freeze({
          currencyCode: currency,
          estimatedCostMicros: cost,
          hardCeilingMicros: cost,
        });
      }),
    ),
  });
}

function mapRunnerCells(
  cells: readonly NovelSkillEvaluationCellRecord[],
  reservations: readonly NovelSkillPaidEvaluationControlReservation[],
): readonly NovelSkillPaidEvaluationRunnerCell[] {
  const ordered = [...cells].sort((left, right) =>
    `${left.fixtureId}/${left.arm}/${left.modelSlotId}/${String(left.repetition)}`.localeCompare(
      `${right.fixtureId}/${right.arm}/${right.modelSlotId}/${String(right.repetition)}`,
      "en",
    ),
  );
  return Object.freeze(
    ordered.map((cell, index) => {
      const cellReservations = reservations
        .filter((reservation) => reservation.cellId === cell.id)
        .sort(
          (left, right) =>
            right.dispatchGeneration - left.dispatchGeneration || right.revision - left.revision,
        );
      const latest = cellReservations[0] ?? null;
      const crossedProviderBoundary = cellReservations.some(({ state }) =>
        ["dispatched", "settled", "ambiguous"].includes(state),
      );
      return Object.freeze({
        id: cell.id,
        executionOrder: index + 1,
        fixtureId: cell.fixtureId,
        arm: cell.arm,
        modelSlotId: requireModelSlot(cell.modelSlotId),
        repetition: requireRepetition(cell.repetition),
        dispatchState: latest?.state ?? "planned",
        observed: cell.evidenceCollected,
        providerDispatchCount: crossedProviderBoundary ? 1 : 0,
        reservation:
          latest === null || latest.state === "not_dispatched"
            ? null
            : Object.freeze({
                reservationId: latest.reservationId,
                revision: latest.revision,
                state: requireReservationReferenceState(latest.state),
              }),
      });
    }),
  );
}

async function createRuntimeTrace(
  input: Readonly<{
    traceId: string;
    projectId: string;
    invocationId: string;
    taskType: NovelSkillTask;
    createdAt: string;
    payloadInput: CompileNovelSkillPaidEvaluationPayloadInput;
  }>,
): Promise<ContextCompilationTrace> {
  const baseline = input.payloadInput.contextBaseline.traceBaseline;
  const entries = baseline.entries.map((entry) =>
    Object.freeze({
      ...entry,
      sources: Object.freeze(
        entry.sources.map((source) =>
          Object.freeze({
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            sourceVersionId: source.sourceVersionId,
            locator: source.locator,
            contentHash: source.contentHash,
          }),
        ),
      ),
    }),
  );
  const preferenceSources = input.payloadInput.preferenceProjection?.sources ?? [];
  const preferenceEntries = await Promise.all(
    preferenceSources.map(async (source, index) => {
      const contentHash = await sha256Hex(source.preferenceText);
      return Object.freeze({
        contextCandidateId: `writing-preference:${String(index + 1).padStart(2, "0")}:${contentHash.slice(0, 32)}`,
        layer: "locked_hard_rules" as const,
        selectionReason: "fixed_evaluation_preference",
        included: true,
        discardedReason: null,
        estimatedTokens: 0,
        evaluationOrder: entries.length + index + 1,
        layerOrder: 1,
        priority: 100,
        relevanceScore: null,
        required: true,
        budgetRemainingBefore: baseline.remainingTokens,
        budgetRemainingAfter: baseline.remainingTokens,
        sources: Object.freeze([
          Object.freeze({
            sourceType: "user_input" as const,
            sourceId: source.sourceId,
            sourceVersionId: source.sourceVersionId,
            locator: "writing_preference",
            contentHash,
          }),
        ]),
      });
    }),
  );
  return Object.freeze({
    id: input.traceId,
    projectId: input.projectId,
    chapterId: null,
    taskType: input.taskType,
    maximumContextTokens: baseline.maximumContextTokens,
    requiredTokens: baseline.requiredTokens,
    usedTokens: baseline.usedTokens,
    remainingTokens: baseline.remainingTokens,
    discardedTokens: baseline.discardedTokens,
    tokenEstimateSource: baseline.tokenEstimateSource,
    createdAt: input.createdAt,
    execution: Object.freeze({
      generationId: input.invocationId,
      generationRunId: null,
      modelInvocationId: input.invocationId,
    }),
    outputCandidateId: null,
    entries: Object.freeze([...entries, ...preferenceEntries]),
  });
}

function stripStoredBlindItems(
  values: readonly StoredBlindReviewItem[],
): readonly NovelSkillPaidBlindReviewSourceItem[] {
  return Object.freeze(values.map(stripStoredBlindItem));
}

function stripStoredBlindItem(value: StoredBlindReviewItem): NovelSkillPaidBlindReviewSourceItem {
  return Object.freeze({
    blindItemId: value.blindItemId,
    position: value.position,
    fixtureTaskContent: value.fixtureTaskContent,
    boundaries: Object.freeze([...value.boundaries]),
    lockedFacts: Object.freeze([...value.lockedFacts]),
    requestedOutcome: value.requestedOutcome,
    candidateOutput: value.candidateOutput,
  });
}

function assertInspectionMatchesAuthority(
  inspection: ModelHubExactEvaluationInspection,
  payload: NovelSkillPaidEvaluationAuthoritativePayload,
  target: NovelSkillPaidEvaluationControlTarget,
): void {
  if (
    inspection.messagePayloadHash !== payload.manifest.messagePayloadHash ||
    inspection.target.connectionId !== target.connectionId ||
    inspection.target.catalogEntryId !== target.catalogEntryId ||
    inspection.target.modelId !== target.providerModelId ||
    inspection.target.targetIdentityHash !== target.targetHash ||
    inspection.target.costProfileHash !== target.pricingSnapshotHash ||
    inspection.pricing.currency !== target.currency
  ) {
    throw authorityChanged(
      "The exact target inspection does not match the payload and target locks.",
    );
  }
}

function assertPreparedReceipt(
  value: RuntimeReceipt,
  runId: string,
  cell: NovelSkillPaidEvaluationRunnerCell,
): void {
  if (
    value.prepared.cell.id !== cell.id ||
    value.prepared.payloadAuthority.manifest.runId !== runId ||
    value.receipt.generationId !== value.prepared.invocationId ||
    value.receipt.messagePayloadHash !==
      value.prepared.payloadAuthority.manifest.messagePayloadHash ||
    value.receipt.payloadHash !== value.prepared.inspection.payloadHash ||
    value.receipt.executionLockHash !== value.prepared.inspection.executionLockHash
  ) {
    throw authorityChanged("The exact executor returned a receipt for a different prepared cell.");
  }
}

function reservationReference(
  value: NovelSkillPaidEvaluationReservationRecord,
): NovelSkillPaidEvaluationReservationReference {
  return Object.freeze({
    reservationId: value.id,
    revision: value.revision,
    state: requireReservationReferenceState(value.state),
  });
}

function requireReservationReferenceState(
  value: NovelSkillPaidEvaluationReservationRecord["state"],
): NovelSkillPaidEvaluationReservationReference["state"] {
  if (!["reserved", "bound", "dispatched", "settled", "ambiguous"].includes(value)) {
    throw authorityChanged("The reservation is not active in the exact runner.");
  }
  return value as NovelSkillPaidEvaluationReservationReference["state"];
}

function requireCellTarget(
  targets: readonly NovelSkillPaidEvaluationControlTarget[],
  modelSlotId: "text_tier_a" | "text_tier_b",
): NovelSkillPaidEvaluationControlTarget {
  const matches = targets.filter((target) => target.modelSlotId === modelSlotId);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw authorityChanged("The cell has no unique exact model target.");
  }
  return matches[0];
}

function requireModelHubTask(value: string): ModelHubTextTask {
  if (!(MODEL_HUB_TEXT_TASKS as readonly string[]).includes(value)) {
    throw authorityChanged("The fixture task is not an exact text-generation task.");
  }
  return value as ModelHubTextTask;
}

function requireNovelSkillTask(value: string): NovelSkillTask {
  return requireModelHubTask(value);
}

function requireInvocationMode(value: string): NovelSkillInvocationMode {
  if (
    !(["coach", "collaborator", "draft", "critic", "revision", "explorer"] as const).includes(
      value as NovelSkillInvocationMode,
    )
  ) {
    throw authorityChanged("The fixture invocation mode is invalid.");
  }
  return value as NovelSkillInvocationMode;
}

function requireProviderKind(value: string): ModelProviderKind {
  if (!(MODEL_PROVIDER_KINDS as readonly string[]).includes(value)) {
    throw authorityChanged("The exact target provider kind is unsupported.");
  }
  return value as ModelProviderKind;
}

function requireModelSlot(value: string): "text_tier_a" | "text_tier_b" {
  if (value !== "text_tier_a" && value !== "text_tier_b") {
    throw authorityChanged("The fixed evaluation model slot is invalid.");
  }
  return value;
}

function requireRepetition(value: number): 1 | 2 {
  if (value !== 1 && value !== 2) {
    throw authorityChanged("The fixed evaluation repetition is invalid.");
  }
  return value;
}

function baselineBudget(
  source: number | ((fixtureId: string) => number),
  fixtureId: string,
): number {
  const value = typeof source === "number" ? source : source(fixtureId);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    throw runtimeError(
      "NOVEL_SKILL_PAID_RUNTIME_INVALID",
      "The context baseline token budget is invalid.",
    );
  }
  return value;
}

function targetUiId(target: Pick<NovelSkillPaidEvaluationControlTarget, "catalogEntryId">): string {
  return target.catalogEntryId;
}

function assertExactTargetIds(value: readonly [string, string]): void {
  if (value[0].length === 0 || value[1].length === 0 || value[0] === value[1]) {
    throw runtimeError(
      "NOVEL_SKILL_PAID_RUNTIME_INVALID",
      "Paid evaluation requires two distinct exact target identifiers.",
    );
  }
}

function assertRunId(value: string, expected: string): void {
  if (value !== expected) {
    throw runtimeError(
      "NOVEL_SKILL_PAID_RUNTIME_AUTHORITY_CHANGED",
      "The requested run does not match this runtime authority.",
    );
  }
}

async function deterministicUuidV7(domain: string, ...parts: readonly string[]): Promise<string> {
  const digest = await sha256Hex([domain, ...parts].join("\u001f"));
  const characters = digest.slice(0, 32).split("");
  characters[12] = "7";
  characters[16] = "8";
  const hex = characters.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function authorityChanged(message: string): NovelSkillPaidEvaluationRuntimeError {
  return runtimeError("NOVEL_SKILL_PAID_RUNTIME_AUTHORITY_CHANGED", message);
}

function runtimeError(
  code: NovelSkillPaidEvaluationRuntimeErrorCode,
  message: string,
): NovelSkillPaidEvaluationRuntimeError {
  return new NovelSkillPaidEvaluationRuntimeError(code, message);
}

export const NOVEL_SKILL_PAID_EVALUATION_RUNTIME_TOTAL_CALLS = PAID_CALL_COUNT;
export const NOVEL_SKILL_PAID_EVALUATION_RUNTIME_TOTAL_SCORES = PAID_SCORE_COUNT;
