import {
  DEFAULT_PERSISTENCE_FLUSH_TIMEOUT_MS,
  MAX_PERSISTENCE_FLUSH_TIMEOUT_MS,
  MIN_PERSISTENCE_FLUSH_TIMEOUT_MS,
  type PersistenceFlushOutcome,
  type PersistenceLifecycleCoordinator,
} from "./persistence-lifecycle";

export const DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS = 8_000;

export interface PersistentLifecycleNotice {
  readonly code:
    | "PERSISTENCE_BLOCKED"
    | "PERSISTENCE_FAILED"
    | "PERSISTENCE_TIMEOUT"
    | "RUNTIME_CLOSE_FAILED"
    | "RUNTIME_CLOSE_TIMEOUT"
    | "WINDOW_DESTROY_FAILED";
  readonly title: string;
  readonly description: string;
  readonly cause?: unknown;
}

export type DesktopCloseOutcome =
  | Readonly<{ status: "destroyed" }>
  | Readonly<{ status: "blocked" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "timeout" }>;

export interface DesktopCloseCoordinatorOptions {
  readonly persistence: Pick<PersistenceLifecycleCoordinator, "flush" | "whenIdle">;
  readonly closeRuntime: () => Promise<void>;
  readonly destroyWindow: () => Promise<void>;
  readonly reportPersistentNotice: (notice: PersistentLifecycleNotice) => void;
  readonly persistenceTimeoutMs?: number;
  readonly runtimeCloseTimeoutMs?: number;
}

type BoundedOperationOutcome =
  | Readonly<{ status: "success" }>
  | Readonly<{ status: "failed"; cause: unknown }>
  | Readonly<{ status: "timeout"; settlement: Promise<void> }>;

/**
 * Coordinates the irreversible final window destroy. The caller must invoke
 * `preventDefault()` synchronously in the native close-request callback before
 * calling `requestClose`.
 */
export class DesktopCloseCoordinator {
  private readonly persistenceTimeoutMs: number;
  private readonly runtimeCloseTimeoutMs: number;
  private activeRequest: Promise<DesktopCloseOutcome> | null = null;

  public constructor(private readonly options: DesktopCloseCoordinatorOptions) {
    this.persistenceTimeoutMs =
      options.persistenceTimeoutMs ?? DEFAULT_PERSISTENCE_FLUSH_TIMEOUT_MS;
    this.runtimeCloseTimeoutMs = options.runtimeCloseTimeoutMs ?? DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS;
    requireDeadline(this.persistenceTimeoutMs);
    requireDeadline(this.runtimeCloseTimeoutMs);
  }

  public requestClose(): Promise<DesktopCloseOutcome> {
    if (this.activeRequest !== null) {
      return this.activeRequest;
    }
    const cycle = this.performClose();
    this.activeRequest = cycle;
    void cycle.then((outcome) => {
      if (outcome.status !== "timeout" && this.activeRequest === cycle) {
        this.activeRequest = null;
      }
    });
    return cycle;
  }

  private async performClose(): Promise<DesktopCloseOutcome> {
    const persistence = await this.options.persistence.flush(
      "window-close",
      this.persistenceTimeoutMs,
    );
    if (persistence.status !== "success") {
      this.reportPersistenceFailure(persistence);
      if (persistence.status === "timeout") {
        const timedOutCycle = this.activeRequest;
        void this.options.persistence.whenIdle().then(() => {
          if (this.activeRequest === timedOutCycle) {
            this.activeRequest = null;
          }
        });
        return Object.freeze({ status: "timeout" });
      }
      return Object.freeze({
        status: persistence.status === "blocked" ? "blocked" : "failed",
      });
    }

    const runtime = await runBounded(this.options.closeRuntime, this.runtimeCloseTimeoutMs);
    if (runtime.status === "timeout") {
      this.options.reportPersistentNotice({
        code: "RUNTIME_CLOSE_TIMEOUT",
        title: "关闭前整理超时",
        description: "应用仍保持打开。请勿强制关闭，等待当前本地操作结束后重试。",
      });
      const timedOutCycle = this.activeRequest;
      void runtime.settlement.then(() => {
        if (this.activeRequest === timedOutCycle) {
          this.activeRequest = null;
        }
      });
      return Object.freeze({ status: "timeout" });
    }
    if (runtime.status === "failed") {
      this.options.reportPersistentNotice({
        code: "RUNTIME_CLOSE_FAILED",
        title: "关闭前整理失败",
        description: "应用仍保持打开，未执行窗口销毁。请重试或导出草稿。",
        cause: runtime.cause,
      });
      return Object.freeze({ status: "failed" });
    }

    try {
      await this.options.destroyWindow();
      return Object.freeze({ status: "destroyed" });
    } catch (cause: unknown) {
      this.options.reportPersistentNotice({
        code: "WINDOW_DESTROY_FAILED",
        title: "窗口关闭失败",
        description: "本地保存与运行时整理已完成，但系统未能关闭窗口；可以安全重试。",
        cause,
      });
      return Object.freeze({ status: "failed" });
    }
  }

  private reportPersistenceFailure(
    outcome: Exclude<PersistenceFlushOutcome, { status: "success" }>,
  ) {
    switch (outcome.status) {
      case "blocked":
        this.options.reportPersistentNotice({
          code: "PERSISTENCE_BLOCKED",
          title: "尚不能离开",
          description: outcome.blockers[0]?.message ?? "请先完成当前输入，再重新关闭应用。",
        });
        return;
      case "failed":
        this.options.reportPersistentNotice({
          code: "PERSISTENCE_FAILED",
          title: "本地草稿保存失败",
          description: "窗口保持打开，本次关闭已取消。请重试保存或导出草稿。",
          cause: outcome.failures[0]?.cause,
        });
        return;
      case "timeout":
        this.options.reportPersistentNotice({
          code: "PERSISTENCE_TIMEOUT",
          title: "本地草稿保存超时",
          description: "窗口保持打开，请等待当前写入完成后重试关闭。",
        });
    }
  }
}

export function createIdempotentAsyncCloser(operation: () => Promise<void>): () => Promise<void> {
  let invocation: Promise<void> | null = null;
  return () => {
    invocation ??= Promise.resolve().then(operation);
    return invocation;
  };
}

async function runBounded(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<BoundedOperationOutcome> {
  const invocation = Promise.resolve().then(operation);
  const settlement = invocation.then(
    () => undefined,
    () => undefined,
  );
  let resolveTimeout: (() => void) | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    resolveTimeout = () => resolve("timeout");
  });
  const timeoutHandle = setTimeout(() => resolveTimeout?.(), timeoutMs);
  const result = await Promise.race([
    invocation.then(
      () => Object.freeze({ status: "success" as const }),
      (cause: unknown) => Object.freeze({ status: "failed" as const, cause }),
    ),
    timeout,
  ]);
  clearTimeout(timeoutHandle);
  return result === "timeout" ? Object.freeze({ status: "timeout", settlement }) : result;
}

function requireDeadline(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_PERSISTENCE_FLUSH_TIMEOUT_MS ||
    timeoutMs > MAX_PERSISTENCE_FLUSH_TIMEOUT_MS
  ) {
    throw new RangeError("Desktop close deadline is outside the supported safety range.");
  }
}
