import type { NovelSkillPaidEvaluationCoordinatorPort as CoordinatorPort } from "./novel-skill-paid-evaluation-coordinator";
import type { NovelSkillPaidEvaluationRuntimeSnapshot } from "./novel-skill-paid-evaluation-runtime";

export type NovelSkillPaidEvaluationCoordinatorFactory = () => Promise<CoordinatorPort>;

const EMPTY_SNAPSHOT: NovelSkillPaidEvaluationRuntimeSnapshot = Object.freeze({
  phase: "not_prepared",
  runId: null,
  quote: null,
  authorizationId: null,
  completedProviderCalls: 0,
  sealedManualScores: 0,
  blindItem: null,
});

const INITIALIZATION_FAILURE_REASON =
  "付费评测的本地组件加载或恢复检查失败。基础写作仍可使用；修复评测记录前不会自动调用模型。";

/**
 * Keeps the full paid-evaluation graph outside the ordinary runtime chunk.
 * Reading the public port is synchronous and local-only. The factory is loaded
 * once on demand; initialization can be awaited and failed loads remain
 * isolated from the rest of DesktopRuntime.
 */
class LazyNovelSkillPaidEvaluationCoordinator implements CoordinatorPort {
  private delegate: CoordinatorPort | null = null;
  private delegateOperation: Promise<CoordinatorPort> | null = null;
  private initializeOperation: Promise<NovelSkillPaidEvaluationRuntimeSnapshot> | null = null;
  private snapshot: NovelSkillPaidEvaluationRuntimeSnapshot = EMPTY_SNAPSHOT;

  public constructor(private readonly factory: NovelSkillPaidEvaluationCoordinatorFactory) {}

  public initialize(): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    if (this.initializeOperation !== null) return this.initializeOperation;

    const operation = this.initializeUnlocked();
    this.initializeOperation = operation;
    void operation.then(
      () => {
        if (this.initializeOperation === operation) this.initializeOperation = null;
      },
      () => {
        if (this.initializeOperation === operation) this.initializeOperation = null;
      },
    );
    return operation;
  }

  public getSnapshot(): NovelSkillPaidEvaluationRuntimeSnapshot {
    return this.snapshot;
  }

  public getRecoverableRuns(): ReturnType<CoordinatorPort["getRecoverableRuns"]> {
    return this.delegate?.getRecoverableRuns() ?? Object.freeze([]);
  }

  public async prepareAndQuote(
    input: Parameters<CoordinatorPort["prepareAndQuote"]>[0],
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const delegate = await this.initializedDelegate();
    return delegate === null ? this.snapshot : this.capture(await delegate.prepareAndQuote(input));
  }

  public async authorizeCommercialRun(
    input: Parameters<CoordinatorPort["authorizeCommercialRun"]>[0],
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const delegate = await this.initializedDelegate();
    return delegate === null
      ? this.snapshot
      : this.capture(await delegate.authorizeCommercialRun(input));
  }

  public async startAuthorizedRun(
    input: Parameters<CoordinatorPort["startAuthorizedRun"]>[0],
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const delegate = await this.initializedDelegate();
    if (delegate === null) return this.snapshot;
    return this.capture(
      await delegate.startAuthorizedRun({
        ...input,
        onProgress: (snapshot) => {
          this.capture(snapshot);
          input.onProgress(snapshot);
        },
      }),
    );
  }

  public async cancelRun(
    input: Parameters<CoordinatorPort["cancelRun"]>[0],
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const delegate = await this.initializedDelegate();
    return delegate === null ? this.snapshot : this.capture(await delegate.cancelRun(input));
  }

  public async beginBlindReview(
    input: Parameters<CoordinatorPort["beginBlindReview"]>[0],
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const delegate = await this.initializedDelegate();
    return delegate === null ? this.snapshot : this.capture(await delegate.beginBlindReview(input));
  }

  public async sealBlindScores(
    input: Parameters<CoordinatorPort["sealBlindScores"]>[0],
  ): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    const delegate = await this.initializedDelegate();
    return delegate === null ? this.snapshot : this.capture(await delegate.sealBlindScores(input));
  }

  private async initializeUnlocked(): Promise<NovelSkillPaidEvaluationRuntimeSnapshot> {
    try {
      const delegate = await this.loadDelegate();
      return this.capture(await delegate.initialize());
    } catch {
      return this.capture(unavailableSnapshot(INITIALIZATION_FAILURE_REASON));
    }
  }

  private async initializedDelegate(): Promise<CoordinatorPort | null> {
    const snapshot = await this.initialize();
    return snapshot.phase === "unavailable" ? null : this.delegate;
  }

  private loadDelegate(): Promise<CoordinatorPort> {
    if (this.delegate !== null) return Promise.resolve(this.delegate);
    if (this.delegateOperation !== null) return this.delegateOperation;

    const operation = this.factory().then((delegate) => {
      this.delegate = delegate;
      return delegate;
    });
    this.delegateOperation = operation;
    void operation.catch(() => {
      if (this.delegateOperation === operation) this.delegateOperation = null;
    });
    return operation;
  }

  private capture(
    snapshot: NovelSkillPaidEvaluationRuntimeSnapshot,
  ): NovelSkillPaidEvaluationRuntimeSnapshot {
    this.snapshot = Object.freeze({ ...snapshot });
    return this.snapshot;
  }
}

export function createLazyNovelSkillPaidEvaluationCoordinator(
  factory: NovelSkillPaidEvaluationCoordinatorFactory,
): CoordinatorPort {
  return new LazyNovelSkillPaidEvaluationCoordinator(factory);
}

export function createUnavailableNovelSkillPaidEvaluationCoordinator(
  reason: string,
): CoordinatorPort {
  const snapshot = unavailableSnapshot(reason);
  return Object.freeze({
    initialize: () => Promise.resolve(snapshot),
    getSnapshot: () => snapshot,
    getRecoverableRuns: () => Object.freeze([]),
    prepareAndQuote: () => Promise.resolve(snapshot),
    authorizeCommercialRun: () => Promise.resolve(snapshot),
    startAuthorizedRun: () => Promise.resolve(snapshot),
    cancelRun: () => Promise.resolve(snapshot),
    beginBlindReview: () => Promise.resolve(snapshot),
    sealBlindScores: () => Promise.resolve(snapshot),
  });
}

function unavailableSnapshot(reason: string): NovelSkillPaidEvaluationRuntimeSnapshot {
  return Object.freeze({
    ...EMPTY_SNAPSHOT,
    phase: "unavailable",
    unavailableReason: reason,
  });
}
