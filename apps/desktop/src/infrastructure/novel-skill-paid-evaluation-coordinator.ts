import type { NovelSkillEvaluationMetric } from "@inkshadow/ai-core";

import type {
  NovelSkillPaidEvaluationRecoverableRun,
  NovelSkillPaidEvaluationControlSqliteStore,
} from "./novel-skill-paid-evaluation-control-sqlite-store";
import {
  createRecoverableRuntimeSelection,
  createUnavailableNovelSkillPaidEvaluationPanelPort,
  type NovelSkillPaidEvaluationRuntime,
  type NovelSkillPaidEvaluationRuntimePanelPort,
  type NovelSkillPaidEvaluationRuntimeSnapshot,
} from "./novel-skill-paid-evaluation-runtime";

type FixedRuntimePort = Pick<
  NovelSkillPaidEvaluationRuntime,
  | "authorizeCommercialRun"
  | "beginBlindReview"
  | "cancelRun"
  | "initialize"
  | "prepareAndQuote"
  | "recoverAfterRestart"
  | "runId"
  | "sealBlindScores"
  | "startAuthorizedRun"
>;

type RecoveryStorePort = Pick<NovelSkillPaidEvaluationControlSqliteStore, "listRecoverableRuns">;

export interface NovelSkillPaidEvaluationCoordinatorOptions {
  readonly controlStore: RecoveryStorePort;
  readonly nextRunId: () => string;
  readonly createRuntime: (runId: string) => FixedRuntimePort;
}

export interface NovelSkillPaidEvaluationCoordinatorPort extends NovelSkillPaidEvaluationRuntimePanelPort {
  initialize(): Promise<NovelSkillPaidEvaluationRuntimeSnapshot>;
  getSnapshot(): NovelSkillPaidEvaluationRuntimeSnapshot;
  getRecoverableRuns(): readonly NovelSkillPaidEvaluationRecoverableRun[];
}

const EMPTY_SNAPSHOT: NovelSkillPaidEvaluationRuntimeSnapshot = Object.freeze({
  phase: "not_prepared",
  runId: null,
  quote: null,
  authorizationId: null,
  completedProviderCalls: 0,
  sealedManualScores: 0,
  blindItem: null,
});

const MULTIPLE_RUNS_REASON =
  "检测到多个尚未完成的商业评测任务。为避免选择错误授权，本次不会自动恢复或调用模型。";
const INITIALIZATION_FAILURE_REASON =
  "付费评测的本地恢复检查失败。基础写作仍可使用；修复评测记录前不会自动调用模型。";

/**
 * Owns the one user-visible paid evaluation session. Initialization and restart
 * recovery are local-only; only the explicit `startAuthorizedRun` delegation can
 * reach the provider boundary.
 */
export class NovelSkillPaidEvaluationCoordinator implements NovelSkillPaidEvaluationCoordinatorPort {
  private runtime: FixedRuntimePort | null = null;
  private snapshot: NovelSkillPaidEvaluationRuntimeSnapshot = EMPTY_SNAPSHOT;
  private recoverableRuns: readonly NovelSkillPaidEvaluationRecoverableRun[] = Object.freeze([]);
  private initializeOperation: Promise<NovelSkillPaidEvaluationRuntimeSnapshot> | null = null;

  public constructor(private readonly options: NovelSkillPaidEvaluationCoordinatorOptions) {}

  public initialize(): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    if (this.initializeOperation !== null) {
      if (this.snapshot.unavailableReason !== INITIALIZATION_FAILURE_REASON) {
        return this.initializeOperation;
      }
      this.initializeOperation = null;
    }
    const operation = this.initializeUnlocked().catch(() => {
      this.initializeOperation = null;
      return this.capture(
        Object.freeze({
          ...EMPTY_SNAPSHOT,
          phase: "unavailable",
          unavailableReason: INITIALIZATION_FAILURE_REASON,
        }),
      );
    });
    this.initializeOperation = operation;
    return operation;
  }

  public getSnapshot(): NovelSkillPaidEvaluationRuntimeSnapshot {
    return this.snapshot;
  }

  public getRecoverableRuns(): readonly NovelSkillPaidEvaluationRecoverableRun[] {
    return this.recoverableRuns;
  }

  public async prepareAndQuote(input: {
    readonly exactTargetIds: readonly [string, string];
  }): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    await this.initialize();
    if (this.snapshot.phase === "unavailable") return this.snapshot;
    const runtime = this.runtime ?? this.createFreshRuntime();
    return this.capture(await runtime.prepareAndQuote(input.exactTargetIds));
  }

  public async authorizeCommercialRun(input: {
    readonly runId: string;
    readonly quoteId: string;
    readonly commercialUseAcknowledged: boolean;
  }): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const runtime = await this.requireRuntime(input.runId);
    return this.capture(await runtime.authorizeCommercialRun(input));
  }

  public async startAuthorizedRun(input: {
    readonly runId: string;
    readonly authorizationId: string;
    readonly onProgress: (snapshot: NovelSkillPaidEvaluationRuntimeSnapshot) => void;
  }): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const runtime = await this.requireRuntime(input.runId);
    const snapshot = await runtime.startAuthorizedRun({
      ...input,
      onProgress: (progress) => {
        this.capture(progress);
        input.onProgress(progress);
      },
    });
    return this.capture(snapshot);
  }

  public async cancelRun(input: {
    readonly runId: string;
  }): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const runtime = await this.requireRuntime(input.runId);
    return this.capture(await runtime.cancelRun(input.runId));
  }

  public async beginBlindReview(input: {
    readonly runId: string;
  }): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const runtime = await this.requireRuntime(input.runId);
    return this.capture(await runtime.beginBlindReview(input.runId));
  }

  public async sealBlindScores(input: {
    readonly runId: string;
    readonly blindItemId: string;
    readonly scores: Readonly<Record<NovelSkillEvaluationMetric, number>>;
  }): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const runtime = await this.requireRuntime(input.runId);
    return this.capture(await runtime.sealBlindScores(input));
  }

  private async initializeUnlocked(): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    this.recoverableRuns = Object.freeze([
      ...(await this.options.controlStore.listRecoverableRuns()),
    ]);
    const selection = createRecoverableRuntimeSelection(this.recoverableRuns);
    if (selection.kind === "create_new") {
      this.runtime = null;
      return this.capture(EMPTY_SNAPSHOT);
    }
    if (selection.kind === "requires_user_selection") {
      return this.capture(
        Object.freeze({
          ...EMPTY_SNAPSHOT,
          phase: "unavailable",
          unavailableReason: MULTIPLE_RUNS_REASON,
        }),
      );
    }

    this.runtime = this.options.createRuntime(selection.runId);
    await this.runtime.initialize();
    return this.capture(await this.runtime.recoverAfterRestart());
  }

  private createFreshRuntime(): FixedRuntimePort {
    const runId = this.options.nextRunId();
    if (runId.length === 0) {
      throw new Error("The paid evaluation run identifier is unavailable.");
    }
    const runtime = this.options.createRuntime(runId);
    if (runtime.runId !== runId) {
      throw new Error("The paid evaluation runtime identity changed during creation.");
    }
    this.runtime = runtime;
    return runtime;
  }

  private async requireRuntime(runId: string): Promise<FixedRuntimePort> {
    await this.initialize();
    if (this.snapshot.phase === "unavailable") {
      throw new Error(this.snapshot.unavailableReason ?? MULTIPLE_RUNS_REASON);
    }
    if (this.runtime?.runId !== runId) {
      throw new Error("The paid evaluation action does not match the selected persisted run.");
    }
    return this.runtime;
  }

  private capture(
    snapshot: NovelSkillPaidEvaluationRuntimeSnapshot,
  ): NovelSkillPaidEvaluationRuntimeSnapshot {
    this.snapshot = Object.freeze({ ...snapshot });
    return this.snapshot;
  }
}

export function createNovelSkillPaidEvaluationCoordinator(
  options: NovelSkillPaidEvaluationCoordinatorOptions,
): NovelSkillPaidEvaluationCoordinatorPort {
  return new NovelSkillPaidEvaluationCoordinator(options);
}

export function createUnavailableNovelSkillPaidEvaluationCoordinator(
  reason?: string,
): NovelSkillPaidEvaluationCoordinatorPort {
  const panel = createUnavailableNovelSkillPaidEvaluationPanelPort(reason);
  const snapshot: NovelSkillPaidEvaluationRuntimeSnapshot = Object.freeze({
    phase: "unavailable",
    runId: null,
    quote: null,
    authorizationId: null,
    completedProviderCalls: 0,
    sealedManualScores: 0,
    blindItem: null,
    ...(reason === undefined ? {} : { unavailableReason: reason }),
  });
  return Object.freeze({
    ...panel,
    initialize: () => Promise.resolve(snapshot),
    getSnapshot: () => snapshot,
    getRecoverableRuns: () => Object.freeze([]),
  });
}
