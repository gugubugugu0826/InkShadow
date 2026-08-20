import { useCallback, useEffect, useMemo, useState } from "react";
import { isModelRouteRole } from "@inkshadow/ai-core";
import { parseUuidV7 } from "@inkshadow/domain";
import type {
  NotificationSeverity,
  NotificationSnapshot,
  TaskSnapshot,
  TaskStatus,
} from "@inkshadow/task-engine";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  InlineAlert,
  PageStateBoundary,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
  type BadgeTone,
} from "@inkshadow/ui";
import { Link } from "react-router-dom";

import {
  inspectPipelineStageFailureCauseCode,
  pipelineRetryProgressStep,
  runAcceptedChapterPipeline,
  type AcceptedChapterPipelineInput,
} from "../infrastructure/accepted-chapter-pipeline";
import { retryInput as persistedAcceptedChapterPipelineInput } from "../infrastructure/accepted-chapter-pipeline-worker";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
import type { TaskCenterSnapshot } from "../infrastructure/task-center-store";
import { useRuntime } from "../runtime-context";

const REFRESH_INTERVAL_MS = 5_000;
const EMPTY_SNAPSHOT: TaskCenterSnapshot = {
  tasks: [],
  notifications: [],
};

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "等待执行",
  running: "执行中",
  waiting_retry: "等待重试",
  paused: "已暂停",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const TASK_STATUS_TONES: Record<TaskStatus, BadgeTone> = {
  queued: "info",
  running: "accent",
  waiting_retry: "warning",
  paused: "neutral",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
};

const NOTIFICATION_SEVERITY_TONES: Record<NotificationSeverity, BadgeTone> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "danger",
};

const NOTIFICATION_SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  info: "信息",
  success: "成功",
  warning: "注意",
  error: "错误",
};

const NOTIFICATION_MESSAGES: Record<string, string> = {
  "task.completed": "后台任务已完成",
  "task.partial": "AI 已保留未完整的建议版本，可继续补全",
  "task.failed": "后台任务执行失败",
  "task.cancelled": "后台任务已取消",
  "backup.completed": "本地备份已完成",
  "backup.failed": "本地备份失败",
  "import.completed": "导入已完成",
  "import.failed": "导入未完成",
  "export.completed": "导出已完成",
  "export.failed": "导出未完成",
  "index.rebuild_required": "搜索索引需要重建",
};

export function TaskCenterPage() {
  const runtime = useRuntime();
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<TaskCenterSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<TaskSnapshot | null>(null);

  const load = useCallback(
    async (background = false): Promise<void> => {
      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        setSnapshot(await runtime.taskCenter.load());
        setError(null);
      } catch (reason: unknown) {
        setError(reason);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [runtime],
  );

  useEffect(() => {
    void Promise.resolve().then(() => load());
    const refreshTimer = window.setInterval(() => {
      void load(true);
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(refreshTimer);
    };
  }, [load]);

  const unreadNotifications = useMemo(
    () => snapshot.notifications.filter((notification) => isUnread(notification)),
    [snapshot.notifications],
  );
  const activeTasks = useMemo(
    () => snapshot.tasks.filter((task) => !isTerminalTask(task.status)),
    [snapshot.tasks],
  );
  const normalizedError = error === null ? null : projectOrdinaryUiError(error);

  async function cancelTask(task: TaskSnapshot): Promise<void> {
    setBusyId(task.id);
    try {
      const next = await runtime.taskCenter.cancelTask(task.id);
      const chapterId = task.metadata.chapterId;
      const modelRole = task.metadata.modelRole;
      if (
        task.type === "ai.generate.deferred" &&
        typeof chapterId === "string" &&
        isModelRouteRole(modelRole)
      ) {
        const deferred = await runtime.generationGovernance.findWaitingDeferredRequest(
          chapterId,
          modelRole,
        );
        if (deferred?.taskId === task.id) {
          await runtime.generationGovernance.transitionDeferredRequest({
            id: deferred.id,
            expectedRevision: deferred.revision,
            status: "cancelled",
          });
        }
      }
      setSnapshot((current) => ({
        ...current,
        tasks: current.tasks.map((item) => (item.id === next.id ? next : item)),
      }));
      toast({
        title: next.status === "cancelled" ? "任务已取消" : "已请求取消",
        description:
          next.status === "cancelled"
            ? "等待中的任务不会继续执行。"
            : "正在运行的任务会在下一个安全边界停止。",
        tone: "success",
      });
    } catch (reason: unknown) {
      setError(reason);
    } finally {
      setBusyId(null);
    }
  }

  async function retryAcceptedVersionTask(task: TaskSnapshot): Promise<void> {
    const input = acceptedVersionRetryInput(task);
    if (input === null || task.failure === null) {
      toast({
        title: "这条任务无法安全重试",
        description: "任务来源信息不完整。正文没有受影响，可导出诊断后再处理。",
        tone: "warning",
      });
      return;
    }

    setBusyId(task.id);
    try {
      const queued = await runtime.taskCenter.retryTaskNow(task.id, {
        expectedSequence: task.sequence,
        expectedAttempt: task.attempt,
        expectedFailureCauseCode: task.failure.causeCode,
        recoveryProgressStep: pipelineRetryProgressStep(task.attempt, task.failure.causeCode),
      });
      const queuedInput = persistedAcceptedChapterPipelineInput(queued);
      if (queuedInput === null) {
        throw new Error("The accepted-version retry marker could not be verified after enqueue.");
      }
      const receipt = await runAcceptedChapterPipeline(runtime, queuedInput);
      await load(true);
      toast({
        title:
          receipt.status === "partially_completed"
            ? "重试后仍有后台更新未完成"
            : "故事资料已重新整理",
        description:
          receipt.status === "partially_completed"
            ? "正文始终安全保留；可查看任务详情，并在服务恢复后再次重试。"
            : "搜索、章节摘要、故事设定与故事关联已按当前可用能力处理。",
        tone: receipt.status === "partially_completed" ? "warning" : "success",
      });
    } catch (reason: unknown) {
      setError(reason);
      await load(true).catch(() => undefined);
    } finally {
      setBusyId(null);
    }
  }

  async function markNotificationRead(notification: NotificationSnapshot): Promise<void> {
    setBusyId(notification.id);
    try {
      const next = await runtime.taskCenter.markNotificationRead(notification.id);
      setSnapshot((current) => ({
        ...current,
        notifications: current.notifications.map((item) => (item.id === next.id ? next : item)),
      }));
    } catch (reason: unknown) {
      setError(reason);
    } finally {
      setBusyId(null);
    }
  }

  async function markAllRead(): Promise<void> {
    setBusyId("all-notifications");
    try {
      const count = await runtime.taskCenter.markAllNotificationsRead();
      await load(true);
      toast({
        title: count === 0 ? "没有未读通知" : `已将 ${String(count)} 条通知标为已读`,
        tone: "success",
      });
    } catch (reason: unknown) {
      setError(reason);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="desktop-page task-center-page">
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">可恢复的后台工作</p>
          <h1>任务与通知</h1>
          <p>任务状态、重试与失败会保存在本地；关闭应用后仍可继续查看。</p>
        </div>
        <div className="task-center-summary" aria-label="任务中心摘要">
          <Badge tone={activeTasks.length > 0 ? "accent" : "neutral"}>
            {String(activeTasks.length)} 个进行中
          </Badge>
          <Badge tone={unreadNotifications.length > 0 ? "warning" : "neutral"}>
            {String(unreadNotifications.length)} 条未读
          </Badge>
          <Button
            size="sm"
            variant="secondary"
            loading={refreshing}
            onClick={() => void load(true)}
          >
            刷新
          </Button>
        </div>
      </header>

      {runtime.mode === "browser-development" && (
        <InlineAlert
          tone="warning"
          title="当前是浏览器开发数据"
          description="任务与通知仅保存在当前浏览器的调试存储中；桌面发行版使用本地数据库。"
        />
      )}

      {normalizedError !== null && (
        <InlineAlert
          tone="error"
          title={normalizedError.title}
          description={normalizedError.description}
          action={{ label: "重试", onClick: () => void load(true) }}
          onDismiss={() => setError(null)}
        />
      )}

      <PageStateBoundary
        state={loading ? "loading" : "ready"}
        loadingLabel="正在读取本地任务与通知"
      >
        <Tabs defaultValue="tasks">
          <TabsList label="任务中心分类">
            <TabsTrigger value="tasks">任务 {String(snapshot.tasks.length)}</TabsTrigger>
            <TabsTrigger value="notifications">
              通知 {String(snapshot.notifications.length)}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tasks">
            <TaskList
              tasks={snapshot.tasks}
              busyId={busyId}
              onCancel={setCancelTarget}
              onRetry={(task) => void retryAcceptedVersionTask(task)}
            />
          </TabsContent>

          <TabsContent value="notifications">
            <div className="task-center-actions">
              <span>{String(unreadNotifications.length)} 条未读通知</span>
              <Button
                size="sm"
                variant="secondary"
                disabled={unreadNotifications.length === 0}
                loading={busyId === "all-notifications"}
                onClick={() => void markAllRead()}
              >
                全部标为已读
              </Button>
            </div>
            <NotificationList
              notifications={snapshot.notifications}
              busyId={busyId}
              onMarkRead={(notification) => void markNotificationRead(notification)}
            />
          </TabsContent>
        </Tabs>
      </PageStateBoundary>
      <Dialog
        open={cancelTarget !== null}
        dismissible={busyId === null}
        onOpenChange={(open) => {
          if (!open && busyId === null) {
            setCancelTarget(null);
          }
        }}
        title="确认取消任务"
        description={
          cancelTarget === null
            ? undefined
            : cancelTarget.status === "running"
              ? `“${taskTypeLabel(cancelTarget.type)}”正在执行。取消请求会在下一个安全边界停止，已经安全提交的结果不会回滚。`
              : `“${taskTypeLabel(cancelTarget.type)}”尚未完成。确认后它不会继续执行或自动重试。`
        }
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busyId !== null}
              onClick={() => setCancelTarget(null)}
            >
              继续任务
            </Button>
            <Button
              variant="danger"
              loading={cancelTarget !== null && busyId === cancelTarget.id}
              disabled={cancelTarget === null || busyId !== null}
              onClick={() => {
                const task = cancelTarget;
                if (task !== null) {
                  setCancelTarget(null);
                  void cancelTask(task);
                }
              }}
            >
              确认取消
            </Button>
          </>
        }
      >
        <InlineAlert
          tone="warning"
          title="取消不会删除已有项目内容"
          description="只停止这条后台任务；项目、章节、稳定版本和已完成的导出仍会保留。"
        />
      </Dialog>
    </div>
  );
}

interface TaskListProps {
  readonly tasks: readonly TaskSnapshot[];
  readonly busyId: string | null;
  readonly onCancel: (task: TaskSnapshot) => void;
  readonly onRetry: (task: TaskSnapshot) => void;
}

function TaskList({ busyId, onCancel, onRetry, tasks }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <EmptyState
        title="暂无后台任务"
        description="导入、导出、索引和 AI 生成等后台工作会出现在这里。"
      />
    );
  }

  return (
    <div className="task-list" aria-label="后台任务">
      {tasks.map((task) => {
        const progress = progressPercent(task);
        const editorRoute = taskEditorRoute(task);
        const canRetryAcceptedVersion = acceptedVersionRetryInput(task) !== null;
        return (
          <Card key={task.id} className="task-card">
            <CardHeader>
              <div className="card-heading-row">
                <div>
                  <CardTitle>{taskTypeLabel(task.type)}</CardTitle>
                  <CardDescription>
                    更新于 {formatTimestamp(task.updatedAt)} · 第 {String(task.attempt)}/
                    {String(task.maxAttempts)} 次尝试
                  </CardDescription>
                </div>
                <Badge tone={TASK_STATUS_TONES[task.status]}>
                  {task.cancelRequestedAt !== null && task.status === "running"
                    ? "正在取消"
                    : TASK_STATUS_LABELS[task.status]}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="task-card__content">
                {task.progress === null ? (
                  <p className="task-card__muted">
                    {task.status === "queued"
                      ? task.type === "ai.generate.deferred"
                        ? "等待网络恢复；返回原章节重新检查并确认后执行。"
                        : "等待本地执行器接手。"
                      : "尚未报告进度。"}
                  </p>
                ) : (
                  <div className="task-progress">
                    <div className="task-progress__label">
                      <span>{progressStepLabel(task.progress.step)}</span>
                      <span>
                        {task.progress.totalUnits === null
                          ? String(task.progress.completedUnits)
                          : `${String(task.progress.completedUnits)}/${String(
                              task.progress.totalUnits,
                            )}`}
                      </span>
                    </div>
                    {progress === null ? (
                      <div
                        className="task-progress__indeterminate"
                        role="progressbar"
                        aria-label={`${taskTypeLabel(task.type)}进度`}
                        aria-valuetext={`${progressStepLabel(task.progress.step)}，正在执行，尚未提供完成比例`}
                      />
                    ) : (
                      <progress
                        aria-label={`${taskTypeLabel(task.type)}进度`}
                        aria-valuetext={`${progressStepLabel(task.progress.step)}，已完成 ${String(progress)}%`}
                        max={100}
                        value={progress}
                      />
                    )}
                  </div>
                )}

                {task.failure !== null && (
                  <>
                    <InlineAlert
                      tone="error"
                      title="任务失败"
                      description={taskFailureDescription(task.failure)}
                    />
                    <div className="task-failure-actions">
                      {canRetryAcceptedVersion && (
                        <Button
                          size="sm"
                          loading={busyId === task.id}
                          disabled={busyId !== null}
                          onClick={() => onRetry(task)}
                        >
                          立即重试后台整理
                        </Button>
                      )}
                      {task.failure.actions.includes("RETRY") &&
                        !canRetryAcceptedVersion &&
                        editorRoute !== null && (
                          <Link className="button-link" to={editorRoute}>
                            返回章节重试
                          </Link>
                        )}
                      {(task.failure.actions.includes("SWITCH_MODEL") ||
                        task.failure.actions.includes("REDUCE_CONTEXT")) && (
                        <Link className="button-link" to="/settings#model-center">
                          调整模型或上下文
                        </Link>
                      )}
                      {task.failure.actions.includes("EXPORT_DIAGNOSTICS") && (
                        <Link className="button-link" to="/settings#diagnostics">
                          导出诊断
                        </Link>
                      )}
                    </div>
                  </>
                )}

                <div className="task-card__footer">
                  {!isTerminalTask(task.status) && (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={task.cancelRequestedAt !== null}
                      loading={busyId === task.id}
                      onClick={() => onCancel(task)}
                    >
                      {task.cancelRequestedAt !== null ? "已请求取消" : "取消任务"}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

interface NotificationListProps {
  readonly notifications: readonly NotificationSnapshot[];
  readonly busyId: string | null;
  readonly onMarkRead: (notification: NotificationSnapshot) => void;
}

const ORDINARY_NOTIFICATION_METADATA_KEYS = new Set([
  "taskType",
  "attempt",
  "reasonCode",
  "pipelineStatus",
  "detectedCount",
  "needsConfirmationCount",
]);

function NotificationList({ busyId, notifications, onMarkRead }: NotificationListProps) {
  if (notifications.length === 0) {
    return (
      <EmptyState title="暂无通知" description="需要关注的成功、失败和恢复信息会保存在这里。" />
    );
  }

  return (
    <div className="notification-list" aria-label="持久通知">
      {notifications.map((notification) => (
        <Card
          key={notification.id}
          className="notification-card"
          data-unread={isUnread(notification) || undefined}
        >
          <CardHeader>
            <div className="card-heading-row">
              <div>
                <CardTitle>{notificationMessage(notification)}</CardTitle>
                <CardDescription>{formatTimestamp(notification.updatedAt)}</CardDescription>
              </div>
              <Badge tone={NOTIFICATION_SEVERITY_TONES[notification.severity]}>
                {NOTIFICATION_SEVERITY_LABELS[notification.severity]}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="notification-card__content">
              <NotificationMetadata metadata={notification.metadata} />
              {notification.requiresResolution && (
                <InlineAlert
                  tone="warning"
                  title="需要处理"
                  description="这条通知不会自动过期，请完成对应操作后再关闭。"
                />
              )}
              {notification.status === "failed_delivery" && (
                <InlineAlert
                  tone="error"
                  title="通知投递失败"
                  description="事件仍保存在本地通知中心，没有丢失。"
                />
              )}
              <NotificationAction notification={notification} />
              <div className="notification-card__footer">
                {canMarkRead(notification) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busyId === notification.id}
                    onClick={() => onMarkRead(notification)}
                  >
                    标为已读
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function NotificationAction({ notification }: { readonly notification: NotificationSnapshot }) {
  const route = notificationStoryRoute(notification);
  if (route === null) {
    return null;
  }
  return (
    <Link className="button-link" to={route}>
      {notification.metadata.needsConfirmationCount === 0 ? "查看故事设定" : "查看待确认设定"}
    </Link>
  );
}

function NotificationMetadata({
  metadata,
}: {
  readonly metadata: NotificationSnapshot["metadata"];
}) {
  const entries = Object.entries(metadata).filter(
    ([key, value]) =>
      ORDINARY_NOTIFICATION_METADATA_KEYS.has(key) &&
      ["string", "number", "boolean"].includes(typeof value),
  );
  if (entries.length === 0) {
    return null;
  }
  return (
    <dl className="notification-metadata">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{metadataLabel(key)}</dt>
          <dd>{metadataValue(key, value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function progressPercent(task: TaskSnapshot): number | null {
  if (task.progress?.totalUnits === null || task.progress === null) {
    return null;
  }
  return Math.round((task.progress.completedUnits / task.progress.totalUnits) * 100);
}

function isTerminalTask(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isUnread(notification: NotificationSnapshot): boolean {
  return (
    notification.status === "created" ||
    notification.status === "queued" ||
    notification.status === "visible" ||
    notification.status === "failed_delivery"
  );
}

function canMarkRead(notification: NotificationSnapshot): boolean {
  return (
    notification.status === "created" ||
    notification.status === "queued" ||
    notification.status === "visible"
  );
}

function taskTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    "ai.generate": "AI 章节生成",
    "ai.generate.deferred": "等待联网的 AI 生成",
    "ai.refine": "AI 精修",
    "import.scan": "导入扫描",
    "import.commit": "导入作品",
    "export.bundle": "导出项目包",
    "backup.create": "创建备份",
    "index.rebuild": "重建搜索索引",
    "story.accepted-version.process": "整理已接受的正文",
    "consistency.repair-candidate": "生成一致性修复建议",
    "sync.project": "同步项目",
  };
  return labels[type] ?? "其他后台任务";
}

function progressStepLabel(step: string): string {
  const labels: Record<string, string> = {
    "context.build": "整理上下文",
    "context.retrieving": "检索并整理上下文",
    "model.generating": "接收模型输出",
    "candidate.validating": "检查候选完整性",
    "candidate.persisted": "保存隔离候选",
    "candidate.finalized": "候选稿已就绪",
    "stream.receive": "接收模型输出",
    "candidate.persist": "保存候选",
    "import.scan": "扫描文件",
    "import.commit": "写入项目",
    "index.keyword": "构建关键词索引",
    "index.embedding": "构建向量索引",
    "search.rebuilt": "更新本地搜索",
    "summary.updated": "更新章节摘要",
    "story-state.updated": "更新故事设定",
    "causal.projected": "更新故事关联",
  };
  return labels[step] ?? "正在处理后台步骤";
}

function taskFailureLabel(code: string): string {
  const labels: Record<string, string> = {
    UPSTREAM_TEMPORARY: "模型服务暂时不可用",
    UPSTREAM_AUTH_FAILED: "模型凭据无效",
    DISK_FULL: "本地磁盘空间不足",
    CANCELLED: "任务已取消",
    RETRY_EXHAUSTED: "重试次数已用尽",
    TASK_RETRY_EXHAUSTED: "重试次数已用尽",
    MODEL_TIMEOUT: "模型响应超时",
    MODEL_GENERATION_FAILED: "模型生成未完成",
    MODEL_GENERATION_CANCELLED: "模型生成已取消",
    MODEL_OUTPUT_EMPTY: "模型没有返回可用内容",
    ACCEPTED_VERSION_PIPELINE_PARTIAL: "正文已安全保留，但部分故事资料尚未更新",
    CONSISTENCY_REPAIR_FAILED: "一致性修复建议未能完成",
    CONSISTENCY_REPAIR_RESULT_AMBIGUOUS: "模型结果不确定，未自动重发",
  };
  return labels[code] ?? "后台任务未能完成";
}

function taskFailureDescription(failure: NonNullable<TaskSnapshot["failure"]>): string {
  const cause =
    failure.causeCode === null || failure.causeCode === failure.code
      ? ""
      : `；底层原因：${taskFailureCauseLabel(failure.causeCode)}`;
  const recovery = failure.retryable ? "，请求已安全保留，可返回章节重新检查后重试。" : "";
  return `${taskFailureLabel(failure.code)}${cause}${recovery}`;
}

function taskFailureCauseLabel(causeCode: string): string {
  const pipeline = inspectPipelineStageFailureCauseCode(causeCode);
  if (pipeline.kind === "valid") {
    const stageLabels: Record<string, string> = {
      search: "本地搜索索引",
      chapter_summary: "章节摘要",
      story_state: "故事设定",
      causal_projection: "故事关联",
    };
    return `未完成步骤：${[...pipeline.stages]
      .map((stage) => stageLabels[stage] ?? stage)
      .join("、")}`;
  }
  const labels: Record<string, string> = {
    PROVIDER_UNAVAILABLE: "模型服务暂时不可用",
    MODEL_PROVIDER_UNAVAILABLE: "模型服务暂时不可用",
    MODEL_PROFILE_NOT_READY: "模型配置尚未就绪",
    UPSTREAM_TEMPORARY: "模型服务暂时不可用",
    UPSTREAM_AUTH_FAILED: "模型凭据无效",
    DISK_FULL: "本地磁盘空间不足",
  };
  return labels[causeCode] ?? "后台步骤报告了未识别的失败原因";
}

function taskEditorRoute(task: TaskSnapshot): string | null {
  const projectId = task.metadata.projectId;
  const chapterId = task.metadata.chapterId;
  return typeof projectId === "string" && typeof chapterId === "string"
    ? `/projects/${projectId}/chapters/${chapterId}`
    : null;
}

function acceptedVersionRetryInput(task: TaskSnapshot): AcceptedChapterPipelineInput | null {
  if (
    task.type !== "story.accepted-version.process" ||
    task.status !== "waiting_retry" ||
    task.failure === null ||
    !task.failure.retryable ||
    !task.failure.actions.includes("RETRY")
  ) {
    return null;
  }
  const input = persistedAcceptedChapterPipelineInput(task);
  if (input === null) {
    return null;
  }
  return {
    ...input,
    ...(task.failure.causeCode === null ? {} : { retryFailureCauseCode: task.failure.causeCode }),
  };
}

function notificationMessage(notification: NotificationSnapshot): string {
  const detectedCount = notification.metadata.detectedCount;
  const needsConfirmationCount = notification.metadata.needsConfirmationCount;
  if (
    (notification.messageKey === "story.accepted-version.completed" ||
      notification.messageKey === "story.accepted-version.completed_with_skips") &&
    typeof detectedCount === "number" &&
    typeof needsConfirmationCount === "number"
  ) {
    return `识别到 ${String(detectedCount)} 项变化，其中 ${String(needsConfirmationCount)} 项需要确认`;
  }
  const acceptedVersionMessages: Record<string, string> = {
    "story.accepted-version.completed": "正文整理已完成",
    "story.accepted-version.completed_with_skips": "正文已整理，部分可选步骤已跳过",
    "story.accepted-version.partially_completed": "正文已安全保存，部分故事资料需要重试",
    "story.accepted-version.already_scheduled": "正文整理任务已在队列中",
  };
  return (
    acceptedVersionMessages[notification.messageKey] ??
    NOTIFICATION_MESSAGES[notification.messageKey] ??
    "有一条新的后台通知"
  );
}

function notificationStoryRoute(notification: NotificationSnapshot): string | null {
  if (!notification.messageKey.startsWith("story.accepted-version.")) {
    return null;
  }
  const projectId = notification.metadata.projectId;
  if (typeof projectId !== "string") {
    return null;
  }
  const parsed = parseUuidV7(projectId);
  return parsed.ok ? `/projects/${parsed.value}/story` : null;
}

function metadataLabel(key: string): string {
  const labels: Record<string, string> = {
    taskType: "任务",
    attempt: "尝试次数",
    reasonCode: "原因码",
    pipelineStatus: "整理状态",
    detectedCount: "识别变化",
    needsConfirmationCount: "需要确认",
  };
  return labels[key] ?? "详情";
}

function metadataValue(key: string, value: unknown): string {
  if (key === "taskType" && typeof value === "string") {
    return taskTypeLabel(value);
  }
  if (key === "reasonCode" && typeof value === "string") {
    return taskFailureLabel(value);
  }
  if (key === "pipelineStatus" && typeof value === "string") {
    const labels: Record<string, string> = {
      completed: "已完成",
      completed_with_skips: "已完成，部分步骤跳过",
      partially_completed: "部分完成",
      already_scheduled: "已在队列中",
    };
    return labels[value] ?? "状态待确认";
  }
  return String(value);
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "时间未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
