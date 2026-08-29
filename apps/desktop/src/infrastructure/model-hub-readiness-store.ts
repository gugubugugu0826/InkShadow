import {
  MODEL_HUB_READINESS_CHANGED_EVENT,
  MODEL_HUB_READINESS_REFRESH_INTERVAL_MS,
  projectModelHubReadiness,
  type ModelHubReadinessProjection,
} from "./model-hub-readiness";
import type { DesktopRuntime } from "./runtime";
import { normalizeUiError, projectOrdinaryUiError } from "./ui-error";

export interface ModelHubReadinessFailure {
  readonly title: string;
  readonly description: string;
  readonly supportId: string;
  readonly recovery: string;
  /** Kept for stable incident correlation and advanced diagnostics; never render directly. */
  readonly diagnosticCode: string;
}

export interface ModelHubReadinessSnapshot {
  readonly readiness: ModelHubReadinessProjection;
  readonly checking: boolean;
  readonly checkedAt: string | null;
  readonly failure: ModelHubReadinessFailure | null;
  readonly revision: number;
}

export interface ModelHubReadinessStore {
  readonly getSnapshot: () => ModelHubReadinessSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: (
    options?: Readonly<{ showChecking?: boolean }>,
  ) => Promise<ModelHubReadinessSnapshot>;
}

interface CreateModelHubReadinessStoreOptions {
  readonly load?: (runtime: DesktopRuntime) => Promise<ModelHubReadinessProjection>;
  readonly autoStart?: boolean;
}

const stores = new WeakMap<DesktopRuntime, ModelHubReadinessStore>();

export function getModelHubReadinessStore(runtime: DesktopRuntime): ModelHubReadinessStore {
  const current = stores.get(runtime);
  if (current !== undefined) return current;
  const created = createModelHubReadinessStore(runtime, { autoStart: true });
  stores.set(runtime, created);
  return created;
}

export function createModelHubReadinessStore(
  runtime: DesktopRuntime,
  options: CreateModelHubReadinessStoreOptions = {},
): ModelHubReadinessStore {
  const load = options.load ?? loadReadinessWithoutDispatch;
  const listeners = new Set<() => void>();
  let requestSequence = 0;
  let started = false;
  let refreshTimer: number | null = null;
  let snapshot: ModelHubReadinessSnapshot = Object.freeze({
    readiness: projectModelHubReadiness({
      connections: [],
      catalog: [],
      routes: [],
      transientChecking: true,
    }),
    checking: true,
    checkedAt: null,
    failure: null,
    revision: 0,
  });

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const publish = (
    next: Omit<ModelHubReadinessSnapshot, "revision">,
  ): ModelHubReadinessSnapshot => {
    snapshot = Object.freeze({ ...next, revision: snapshot.revision + 1 });
    emit();
    return snapshot;
  };

  const refresh = async (
    refreshOptions: Readonly<{ showChecking?: boolean }> = {},
  ): Promise<ModelHubReadinessSnapshot> => {
    const sequence = requestSequence + 1;
    requestSequence = sequence;
    if (refreshOptions.showChecking === true || !snapshot.checking) {
      publish({
        readiness: projectReadinessDuringRefresh(snapshot.readiness, snapshot.checkedAt !== null),
        checking: true,
        checkedAt: snapshot.checkedAt,
        failure: snapshot.failure,
      });
    }
    try {
      const readiness = await load(runtime);
      if (sequence !== requestSequence) return snapshot;
      return publish({
        readiness,
        checking: false,
        checkedAt: runtime.clock.now(),
        failure: null,
      });
    } catch (cause: unknown) {
      if (sequence !== requestSequence) return snapshot;
      const normalized = normalizeUiError(cause);
      const ordinary = projectOrdinaryUiError(cause);
      const previousFailure =
        snapshot.failure?.diagnosticCode === normalized.code ? snapshot.failure : null;
      const failure: ModelHubReadinessFailure =
        previousFailure ??
        Object.freeze({
          title: ordinary.title,
          description: ordinary.description,
          supportId: readinessSupportId(runtime.ids.next(), runtime.clock.now()),
          recovery: "请重新读取 AI 写作状态；如果仍未恢复，请记下问题编号并下载脱敏诊断。",
          diagnosticCode: normalized.code,
        });
      const readiness =
        snapshot.readiness.savedConnectionCount > 0
          ? preserveHydratedReadinessAfterFailure(snapshot.readiness, failure)
          : Object.freeze({
              ...projectModelHubReadiness({
                connections: [],
                catalog: [],
                routes: [],
                loadFailed: true,
              }),
              needsRecheck: true,
            });
      return publish({
        readiness,
        checking: false,
        checkedAt: runtime.clock.now(),
        failure,
      });
    }
  };

  const handleChanged = (): void => {
    void refresh({ showChecking: true });
  };

  const start = (): void => {
    if (started || options.autoStart !== true || typeof window === "undefined") return;
    started = true;
    window.addEventListener(MODEL_HUB_READINESS_CHANGED_EVENT, handleChanged);
    refreshTimer = window.setInterval(() => {
      void refresh({ showChecking: false });
    }, MODEL_HUB_READINESS_REFRESH_INTERVAL_MS);
    void refresh({ showChecking: true });
  };

  const stop = (): void => {
    if (!started || listeners.size > 0 || typeof window === "undefined") return;
    started = false;
    requestSequence += 1;
    window.removeEventListener(MODEL_HUB_READINESS_CHANGED_EVENT, handleChanged);
    if (refreshTimer !== null) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    refresh,
  });
}

async function loadReadinessWithoutDispatch(
  runtime: DesktopRuntime,
): Promise<ModelHubReadinessProjection> {
  const { loadAuthoritativeModelHubReadiness } =
    await import("./model-hub-authoritative-readiness");
  return loadAuthoritativeModelHubReadiness(runtime);
}

function projectReadinessDuringRefresh(
  current: ModelHubReadinessProjection,
  hasPreviousResult: boolean,
): ModelHubReadinessProjection {
  return Object.freeze({
    ...current,
    state: "checking",
    label: hasPreviousResult ? "正在重新核对" : "正在核对",
    shortLabel: hasPreviousResult ? "AI 正在重新核对" : "AI 正在核对",
    description: hasPreviousResult
      ? "正在重新核对凭据、模型目录、创作安排、隐私去向和费用限制。上次核对结果仍保留，但不会作为当前可发送结论。"
      : "正在核对凭据、模型目录、创作安排、隐私去向和费用限制；完成前不会把连接标为可发送。",
    tone: "info",
    routeStatus: "temporarily_unavailable",
    needsRecheck: true,
  });
}

function preserveHydratedReadinessAfterFailure(
  current: ModelHubReadinessProjection,
  failure: ModelHubReadinessFailure,
): ModelHubReadinessProjection {
  return Object.freeze({
    ...current,
    state: "partially_unavailable",
    label: "状态需要重新核对",
    shortLabel: "AI 状态需重新核对",
    description: `${failure.description} 已保存的 ${String(
      current.savedConnectionCount,
    )} 个连接仍保留；墨影不会据此自动发送或重试。`,
    tone: "warning",
    needsRecheck: true,
  });
}

function readinessSupportId(id: string, startedAt: string): string {
  const stamp = startedAt
    .replace(/[^0-9]/gu, "")
    .slice(0, 14)
    .padEnd(14, "0");
  const suffix = id
    .replace(/[^a-z0-9]/giu, "")
    .toUpperCase()
    .slice(-6)
    .padStart(6, "0");
  return `墨影-${stamp}-${suffix}`;
}
