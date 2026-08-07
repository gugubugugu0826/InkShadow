import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn";
import { Button } from "./button";
import type { HeadingLevel } from "./surfaces";

export type ToastTone = "success" | "info" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: ReactNode;
  tone?: ToastTone;
  duration?: number | null;
  action?: ToastAction;
}

type ToastRecord = ToastOptions & {
  id: string;
};

export interface ToastApi {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

function defaultDuration(tone: ToastTone): number | null {
  if (tone === "error") {
    return 12_000;
  }
  if (tone === "warning") {
    return 8_000;
  }
  return 5_000;
}

interface ToastItemProps {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
}

function ToastItem({ onDismiss, toast }: ToastItemProps): ReactNode {
  const tone = toast.tone ?? "info";
  const duration = toast.duration === undefined ? defaultDuration(tone) : toast.duration;
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || duration === null) {
      return;
    }

    const timeout = window.setTimeout(() => {
      onDismiss(toast.id);
    }, duration);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [duration, onDismiss, paused, toast.id]);

  return (
    <article
      role={tone === "error" ? "alert" : "status"}
      className={cn("ink-toast", `ink-toast--${tone}`)}
      data-paused={paused || undefined}
      onMouseEnter={() => {
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
      }}
      onFocusCapture={() => {
        setPaused(true);
      }}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setPaused(false);
        }
      }}
    >
      <div className="ink-toast__body">
        <strong className="ink-toast__title">{toast.title}</strong>
        {toast.description !== undefined && (
          <div className="ink-toast__description">{toast.description}</div>
        )}
      </div>
      {toast.action !== undefined && (
        <button
          type="button"
          className="ink-toast__action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="ink-toast__close"
        aria-label={`关闭“${toast.title}”通知`}
        onClick={() => {
          onDismiss(toast.id);
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </article>
  );
}

export interface ToastProviderProps {
  children: ReactNode;
  maxVisible?: number;
}

export function ToastProvider({ children, maxVisible = 3 }: ToastProviderProps): ReactNode {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const idPrefix = `ink-toast-${useId()}`;
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions): string => {
      counterRef.current += 1;
      const id = `${idPrefix}-${String(counterRef.current)}`;
      const record: ToastRecord = { ...options, id };
      setToasts((current) => limitVisibleToasts([...current, record], maxVisible));
      return id;
    },
    [idPrefix, maxVisible],
  );

  const api = useMemo<ToastApi>(() => ({ dismiss, toast }), [dismiss, toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ink-toast-viewport" aria-label="通知">
        {toasts.map((item) => (
          <ToastItem key={item.id} toast={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function limitVisibleToasts(toasts: ToastRecord[], maxVisible: number): ToastRecord[] {
  const limit = Math.max(1, maxVisible);
  if (toasts.length <= limit) {
    return toasts;
  }

  const protectedIds = new Set(
    toasts
      .filter((toast) => toast.tone === "error" || toast.duration === null)
      .map((toast) => toast.id),
  );
  const ordinarySlots = Math.max(0, limit - protectedIds.size);
  const retainedOrdinaryIds = new Set(
    ordinarySlots === 0
      ? []
      : toasts
          .filter((toast) => !protectedIds.has(toast.id))
          .slice(-ordinarySlots)
          .map((toast) => toast.id),
  );

  // `maxVisible` is deliberately a soft limit for critical notices. Errors and
  // persistent notices must remain visible until their own timer or the user
  // dismisses them, even when several arrive together.
  return toasts.filter((toast) => protectedIds.has(toast.id) || retainedOrdinaryIds.has(toast.id));
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);

  if (context === null) {
    throw new Error("useToast must be used inside ToastProvider.");
  }

  return context;
}

export type SkeletonProps = HTMLAttributes<HTMLSpanElement> & {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  shape?: "text" | "rect" | "circle";
};

export function Skeleton({
  className,
  height,
  shape = "text",
  style,
  width,
  ...props
}: SkeletonProps): ReactNode {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={cn("ink-skeleton", `ink-skeleton--${shape}`, className)}
      style={{
        ...style,
        ...(height === undefined ? {} : { height }),
        ...(width === undefined ? {} : { width }),
      }}
    />
  );
}

export interface StateAction {
  label: string;
  onClick: () => void;
}

export type EmptyStateKind = "no_data" | "no_results" | "offline" | "forbidden" | "feature_limited";

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  description: ReactNode;
  headingLevel?: HeadingLevel;
  kind?: EmptyStateKind;
  icon?: ReactNode;
  primaryAction?: StateAction;
  secondaryAction?: StateAction;
};

export function EmptyState({
  className,
  description,
  headingLevel = 2,
  icon,
  kind = "no_data",
  primaryAction,
  secondaryAction,
  title,
  ...props
}: EmptyStateProps): ReactNode {
  const Heading = `h${String(headingLevel)}`;

  return (
    <div {...props} className={cn("ink-empty-state", className)} data-kind={kind}>
      {icon !== undefined && (
        <div className="ink-empty-state__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      {createElement(Heading, { className: "ink-empty-state__title" }, title)}
      <div className="ink-empty-state__description">{description}</div>
      {(primaryAction !== undefined || secondaryAction !== undefined) && (
        <div className="ink-empty-state__actions">
          {primaryAction !== undefined && (
            <Button onClick={primaryAction.onClick}>{primaryAction.label}</Button>
          )}
          {secondaryAction !== undefined && (
            <Button variant="secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export type ErrorStateProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  description: ReactNode;
  headingLevel?: HeadingLevel;
  errorCode?: string;
  requestId?: string;
  savedState?: ReactNode;
  primaryAction?: StateAction;
  secondaryAction?: StateAction;
};

export function ErrorState({
  className,
  description,
  errorCode,
  headingLevel = 2,
  primaryAction,
  requestId,
  savedState,
  secondaryAction,
  title,
  ...props
}: ErrorStateProps): ReactNode {
  const Heading = `h${String(headingLevel)}`;

  return (
    <div {...props} role="alert" className={cn("ink-error-state", className)}>
      {createElement(Heading, { className: "ink-error-state__title" }, title)}
      <div className="ink-error-state__description">{description}</div>
      {(errorCode !== undefined || requestId !== undefined || savedState !== undefined) && (
        <dl className="ink-error-state__details">
          {errorCode !== undefined && (
            <div>
              <dt>错误码</dt>
              <dd>{errorCode}</dd>
            </div>
          )}
          {requestId !== undefined && (
            <div>
              <dt>请求编号</dt>
              <dd>{requestId}</dd>
            </div>
          )}
          {savedState !== undefined && (
            <div>
              <dt>保存状态</dt>
              <dd>{savedState}</dd>
            </div>
          )}
        </dl>
      )}
      {(primaryAction !== undefined || secondaryAction !== undefined) && (
        <div className="ink-error-state__actions">
          {primaryAction !== undefined && (
            <Button onClick={primaryAction.onClick}>{primaryAction.label}</Button>
          )}
          {secondaryAction !== undefined && (
            <Button variant="secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export type InlineAlertTone = "info" | "warning" | "error" | "ai-clarification";

export type InlineAlertProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  tone?: InlineAlertTone;
  action?: StateAction;
  onDismiss?: () => void;
  dismissLabel?: string;
};

export function InlineAlert({
  action,
  className,
  description,
  dismissLabel = "关闭提示",
  onDismiss,
  title,
  tone = "info",
  ...props
}: InlineAlertProps): ReactNode {
  return (
    <div
      {...props}
      role={tone === "error" ? "alert" : "status"}
      className={cn("ink-inline-alert", `ink-inline-alert--${tone}`, className)}
    >
      <div className="ink-inline-alert__body">
        <strong className="ink-inline-alert__title">{title}</strong>
        {description !== undefined && (
          <div className="ink-inline-alert__description">{description}</div>
        )}
      </div>
      {action !== undefined && (
        <Button size="sm" variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      {onDismiss !== undefined && (
        <button
          type="button"
          className="ink-inline-alert__close"
          aria-label={dismissLabel}
          onClick={onDismiss}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

export type SaveState =
  | "clean"
  | "dirty"
  | "saving"
  | "saved_local"
  | "pending_sync"
  | "save_failed"
  | "conflict"
  | "readonly";

const defaultSaveLabels: Record<SaveState, string> = {
  clean: "已保存",
  dirty: "有未保存更改",
  saving: "正在保存…",
  saved_local: "已保存到本地",
  pending_sync: "已保存，待同步",
  save_failed: "保存失败",
  conflict: "检测到版本冲突",
  readonly: "只读",
};

export type SaveStatusProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  state: SaveState;
  labels?: Partial<Record<SaveState, string>>;
  onActivate?: () => void;
  interactiveTitle?: string;
};

export function SaveStatus({
  className,
  interactiveTitle = "查看保存详情",
  labels,
  onActivate,
  state,
  ...props
}: SaveStatusProps): ReactNode {
  const label = labels?.[state] ?? defaultSaveLabels[state];
  const isAlert = state === "save_failed" || state === "conflict";
  const common = {
    ...props,
    className: cn("ink-save-status", className),
    "data-state": state,
    "aria-live": isAlert ? ("assertive" as const) : ("polite" as const),
  };

  if (onActivate === undefined) {
    return (
      <span
        className={common.className}
        data-state={state}
        role={isAlert ? "alert" : "status"}
        aria-live={common["aria-live"]}
      >
        <span className="ink-save-status__indicator" aria-hidden="true" />
        {label}
      </span>
    );
  }

  return (
    <button
      {...common}
      type="button"
      data-interactive
      title={props.title ?? interactiveTitle}
      onClick={onActivate}
    >
      <span className="ink-save-status__indicator" aria-hidden="true" />
      {label}
    </button>
  );
}

export type PageState =
  | "initial"
  | "loading"
  | "empty"
  | "ready"
  | "partial_error"
  | "fatal_error"
  | "offline"
  | "forbidden"
  | "readonly"
  | "conflict"
  | "migrating"
  | "background_work"
  | "license_limited"
  | "recoverable";

type NonReadyPageState = Exclude<PageState, "ready">;

export type PageStateBoundaryProps = HTMLAttributes<HTMLElement> & {
  state: PageState;
  children: ReactNode;
  fallbacks?: Partial<Record<NonReadyPageState, ReactNode>>;
  preserveContent?: boolean;
  loadingLabel?: string;
};

const defaultPageStateLabels: Record<NonReadyPageState, string> = {
  initial: "正在准备页面",
  loading: "正在加载",
  empty: "暂无内容",
  partial_error: "部分内容暂时不可用",
  fatal_error: "页面加载失败",
  offline: "当前处于离线状态",
  forbidden: "没有访问权限",
  readonly: "当前内容为只读",
  conflict: "检测到版本冲突",
  migrating: "正在迁移数据",
  background_work: "任务正在后台运行",
  license_limited: "当前授权不包含此功能",
  recoverable: "发现可恢复的内容",
};

function defaultPageFallback(state: NonReadyPageState, loadingLabel: string): ReactNode {
  if (state === "initial" || state === "loading" || state === "migrating") {
    return (
      <div className="ink-page-state__loading" role="status">
        <span className="ink-spinner" aria-hidden="true" />
        {state === "loading" ? loadingLabel : defaultPageStateLabels[state]}
      </div>
    );
  }

  if (
    state === "partial_error" ||
    state === "offline" ||
    state === "readonly" ||
    state === "background_work" ||
    state === "license_limited"
  ) {
    const tone = state === "partial_error" ? "warning" : "info";
    return <InlineAlert tone={tone} title={defaultPageStateLabels[state]} />;
  }

  if (state === "empty" || state === "forbidden") {
    return (
      <EmptyState
        kind={state === "forbidden" ? "forbidden" : "no_data"}
        title={defaultPageStateLabels[state]}
        description="请使用页面提供的操作继续。"
      />
    );
  }

  return (
    <ErrorState
      title={defaultPageStateLabels[state]}
      description="请查看可用的恢复操作或稍后重试。"
    />
  );
}

export function PageStateBoundary({
  children,
  className,
  fallbacks,
  loadingLabel = "正在加载",
  preserveContent = true,
  state,
  ...props
}: PageStateBoundaryProps): ReactNode {
  const ready = state === "ready";
  const nonReadyState = ready ? undefined : state;
  const keepContent =
    preserveContent &&
    (state === "loading" ||
      state === "partial_error" ||
      state === "offline" ||
      state === "readonly" ||
      state === "background_work" ||
      state === "license_limited");
  const fallback =
    nonReadyState === undefined
      ? undefined
      : (fallbacks?.[nonReadyState] ?? defaultPageFallback(nonReadyState, loadingLabel));

  return (
    <section
      {...props}
      className={cn("ink-page-state", className)}
      data-page-state={state}
      aria-busy={state === "initial" || state === "loading" || state === "migrating"}
    >
      {(ready || keepContent) && children}
      {!ready && <div className="ink-page-state__fallback">{fallback}</div>}
    </section>
  );
}
