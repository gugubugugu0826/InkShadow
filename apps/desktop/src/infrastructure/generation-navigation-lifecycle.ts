export interface ActiveGenerationNavigationGuard {
  readonly id: string;
  readonly actionLabel: string;
  readonly stopAndPreserve: () => Promise<void>;
}

export interface GenerationNavigationSession {
  readonly stopRequested: () => boolean;
  readonly stopAndPreserve: () => Promise<void>;
  readonly settle: (cause: unknown) => void;
  readonly release: () => void;
}

type GenerationNavigationListener = () => void;

let activeGuard: ActiveGenerationNavigationGuard | null = null;
const listeners = new Set<GenerationNavigationListener>();

export function currentGenerationNavigationGuard(): ActiveGenerationNavigationGuard | null {
  return activeGuard;
}

export function hasActiveGenerationNavigationGuard(): boolean {
  return activeGuard !== null;
}

export function subscribeGenerationNavigationGuard(
  listener: GenerationNavigationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerGenerationNavigationGuard(
  guard: ActiveGenerationNavigationGuard,
): () => void {
  let stopPromise: Promise<void> | null = null;
  const registeredGuard: ActiveGenerationNavigationGuard = Object.freeze({
    ...guard,
    stopAndPreserve: () => {
      stopPromise ??= Promise.resolve()
        .then(() => guard.stopAndPreserve())
        .catch((cause: unknown) => {
          stopPromise = null;
          throw cause instanceof Error
            ? cause
            : new Error("本次生成没有完成安全结算，请稍后重试。");
        });
      return stopPromise;
    },
  });
  activeGuard = registeredGuard;
  notifyListeners();
  return () => {
    if (activeGuard !== registeredGuard) return;
    activeGuard = null;
    notifyListeners();
  };
}

export function beginGenerationNavigationSession(input: {
  readonly id: string;
  readonly actionLabel: string;
  readonly stop: () => Promise<unknown>;
  readonly timeoutMs: number;
}): GenerationNavigationSession {
  let requested = false;
  let resolve!: (cause: unknown) => void;
  const settled = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  let stopPromise: Promise<void> | null = null;
  const stopAndPreserve = (): Promise<void> => {
    stopPromise ??= Promise.resolve()
      .then(async () => {
        requested = true;
        await input.stop();
        const cause = await Promise.race([
          settled,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("本次生成停止后仍未完成安全结算，请稍后重试。")),
              input.timeoutMs,
            ),
          ),
        ]);
        if (cause !== null)
          throw cause instanceof Error
            ? cause
            : new Error("本次生成没有完成安全结算，请稍后重试。");
      })
      .catch((cause: unknown) => {
        stopPromise = null;
        throw cause instanceof Error ? cause : new Error("本次生成没有完成安全结算，请稍后重试。");
      });
    return stopPromise;
  };
  const release = registerGenerationNavigationGuard({
    id: input.id,
    actionLabel: input.actionLabel,
    stopAndPreserve,
  });
  return Object.freeze({
    stopRequested: () => requested,
    stopAndPreserve,
    settle: resolve,
    release,
  });
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}
