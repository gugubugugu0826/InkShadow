import { useCallback, useEffect, useState } from "react";
import {
  StoryCoreError,
  type AuthoritativeExtractionGoldenSuite,
  type AuthoritativeExtractionJob,
  type ReviewItemStatus,
  type Result,
} from "@inkshadow/story-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  InlineAlert,
  Textarea,
} from "@inkshadow/ui";

import {
  type AuthoritativeExtractionDashboard,
  type AuthoritativeExtractionDashboardCandidate,
  type AuthoritativeExtractionDesktopPort,
} from "../infrastructure/authoritative-extraction-runtime";
import {
  fitCandidateDecisionTextarea,
  handleCandidateDecisionNavigation,
} from "../components/candidate-decision-navigation";
import { normalizeUiError, projectOrdinaryUiError } from "../infrastructure/ui-error";
import "./authoritative-extraction-page.css";

export interface AuthoritativeExtractionPageProps {
  readonly runtime: AuthoritativeExtractionDesktopPort;
  readonly projectId: string;
  readonly actorId: string;
  readonly goldenSuite?: AuthoritativeExtractionGoldenSuite;
  /** Test/embedding seam. Omit to follow the browser's real online state. */
  readonly online?: boolean;
}

type PagePhase = "loading" | "ready" | "error";

export function AuthoritativeExtractionPage({
  runtime,
  projectId,
  actorId,
  goldenSuite,
  online: onlineOverride,
}: AuthoritativeExtractionPageProps) {
  const [browserOnline, setBrowserOnline] = useState(readOnlineState);
  const [phase, setPhase] = useState<PagePhase>("loading");
  const [dashboard, setDashboard] = useState<AuthoritativeExtractionDashboard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingCandidate, setEditingCandidate] = useState<string | null>(null);
  const [modifiedJson, setModifiedJson] = useState("");

  useEffect(() => {
    if (onlineOverride !== undefined) {
      return;
    }
    const sync = () => {
      setBrowserOnline(readOnlineState());
    };
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, [onlineOverride]);
  const online = onlineOverride ?? browserOnline;

  const load = useCallback(
    async (runExtraction: boolean) => {
      if (!runtime.availability.available) {
        setPhase("ready");
        return;
      }
      setPhase("loading");
      setError(null);
      try {
        if (runExtraction) {
          const cycle = await runtime.runCycle(projectId, { online });
          if (!cycle.ok) {
            setError(cycle.error);
          }
        }
        const inspected = await runtime.inspect(projectId);
        if (!inspected.ok) {
          setError(inspected.error);
          setPhase("error");
          return;
        }
        setDashboard(inspected.value);
        setPhase("ready");
      } catch (cause: unknown) {
        setError(cause);
        setPhase("error");
      }
    },
    [online, projectId, runtime],
  );

  useEffect(() => {
    // Opening or restoring the page is read-only. Provider work starts only
    // from the explicit scan action, so a restart cannot redispatch a job.
    void Promise.resolve().then(() => load(false));
  }, [load]);

  const perform = useCallback(
    async (
      key: string,
      action: () => Promise<Result<unknown, StoryCoreError>>,
      successMessage: string,
    ) => {
      if (busyKey !== null) {
        return;
      }
      setBusyKey(key);
      setError(null);
      setNotice(null);
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNotice(successMessage);
        setEditingCandidate(null);
        await load(false);
      } catch (cause: unknown) {
        setError(cause);
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, load],
  );

  const unavailable = runtime.availability.available
    ? null
    : availabilityCopy(runtime.availability.reason);
  if (unavailable !== null) {
    return (
      <div className="desktop-page authoritative-extraction-page">
        <header className="page-heading">
          <div>
            <h1>权威事实抽取</h1>
            <p>模型结果只会进入候选审核，不会自动写入正式故事事实。</p>
          </div>
          <Badge tone="neutral">默认关闭</Badge>
        </header>
        <EmptyState
          kind="feature_limited"
          title={unavailable.title}
          description={unavailable.description}
        />
      </div>
    );
  }

  const normalizedError = error === null ? null : normalizeUiError(error);
  const waitingForNetwork =
    dashboard?.jobs.some(({ state }) => state === "waiting_for_network") === true;
  const projectionNeedsAttention =
    dashboard?.graphFreshness === "stale" || dashboard?.graphFreshness === "unavailable";

  return (
    <div className="desktop-page authoritative-extraction-page">
      <header className="page-heading">
        <div>
          <h1>权威事实抽取</h1>
          <p>自动发现章节候选，逐条人工确认后才写入正式事实并重建 GraphRAG。</p>
        </div>
        <div className="authoritative-extraction-actions">
          <Badge tone={online ? "success" : "neutral"}>{online ? "在线" : "离线"}</Badge>
          <Button
            variant="secondary"
            loading={busyKey === "scan"}
            disabled={busyKey !== null}
            onClick={() =>
              void perform(
                "scan",
                () => runtime.runCycle(projectId, { online }),
                online ? "章节扫描与候选队列已刷新。" : "已安全记录离线等待状态。",
              )
            }
          >
            扫描当前章节
          </Button>
          {goldenSuite !== undefined && (
            <Button
              variant="secondary"
              loading={busyKey === "evaluation"}
              disabled={busyKey !== null}
              onClick={() =>
                void perform(
                  "evaluation",
                  () => runtime.runEvaluation(goldenSuite),
                  "黄金样本精确率与召回率门禁已刷新。",
                )
              }
            >
              运行评测门禁
            </Button>
          )}
        </div>
      </header>

      <InlineAlert
        tone="ai-clarification"
        title="AI 输出始终只是待审核候选"
        description="接受、修改、拒绝、暂缓都必须由人明确操作。来源章节、版本、校验和、范围、证据，以及提示词、模型和评测版本都会随候选保留。"
      />

      {!online && (
        <InlineAlert
          tone="warning"
          title="当前离线"
          description="远程抽取不会携带正文重试；任务仅保存元数据并等待恢复联网。"
        />
      )}
      {waitingForNetwork && online && (
        <InlineAlert
          tone="info"
          title="离线任务可以恢复"
          description="再次扫描会从持久化队列继续，不会重复创建同一来源任务。"
        />
      )}
      {normalizedError !== null && (
        <InlineAlert
          tone="error"
          title={normalizedError.title}
          description={normalizedError.description}
          action={{ label: "重新加载", onClick: () => void load(false) }}
        />
      )}
      {notice !== null && (
        <InlineAlert
          tone="info"
          title="操作已完成"
          description={notice}
          onDismiss={() => setNotice(null)}
        />
      )}

      <section className="authoritative-extraction-summary" aria-label="抽取状态摘要">
        <SummaryCard
          label="评测门禁"
          value={dashboard?.evaluationPassed === true ? "通过" : "未通过"}
          tone={dashboard?.evaluationPassed === true ? "success" : "warning"}
        />
        <SummaryCard label="持久化任务" value={String(dashboard?.jobs.length ?? 0)} tone="info" />
        <SummaryCard
          label="待审核候选"
          value={String(
            dashboard?.candidates.filter(
              ({ review }) =>
                review === null || review.status === "pending" || review.status === "deferred",
            ).length ?? 0,
          )}
          tone="ai"
        />
        <SummaryCard
          label="GraphRAG 投影"
          value={graphFreshnessLabel(dashboard?.graphFreshness)}
          tone={
            dashboard?.graphFreshness === "fresh"
              ? "success"
              : dashboard?.graphFreshness === "unavailable"
                ? "danger"
                : "warning"
          }
        />
      </section>

      {projectionNeedsAttention && (
        <InlineAlert
          tone="warning"
          title="GraphRAG 投影需要重建"
          description="正式事实仍然安全；重建成功前，不应把旧投影当作当前权威上下文。"
          action={{
            label: "立即重建",
            onClick: () =>
              void perform(
                "projection",
                () => runtime.rebuildProjection(projectId),
                "GraphRAG 投影已从正式事实重建。",
              ),
          }}
        />
      )}

      <section className="authoritative-extraction-jobs" aria-labelledby="extraction-jobs-title">
        <div className="authoritative-extraction-section-heading">
          <div>
            <h2 id="extraction-jobs-title">可恢复任务队列</h2>
            <p>进度、取消请求和失败分类均持久化；崩溃后按租约恢复。</p>
          </div>
        </div>
        {dashboard?.jobs.length === 0 ? (
          <EmptyState
            title="还没有抽取任务"
            description="扫描当前章节后，稳定版本会进入幂等任务队列。"
          />
        ) : (
          <div className="authoritative-extraction-job-list">
            {dashboard?.jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                busy={busyKey === `cancel:${job.id}`}
                disabled={busyKey !== null}
                onCancel={() =>
                  void perform(
                    `cancel:${job.id}`,
                    () => runtime.cancel(job.id),
                    "取消请求已持久化；迟到的模型输出不会进入候选库。",
                  )
                }
              />
            ))}
          </div>
        )}
      </section>

      <section
        className="authoritative-extraction-candidates"
        aria-labelledby="extraction-candidates-title"
        aria-busy={phase === "loading"}
      >
        <div className="authoritative-extraction-section-heading">
          <div>
            <h2 id="extraction-candidates-title">人工审核候选</h2>
            <p>所有正式写入都使用现有审核事务；按钮点击才构成人工确认。</p>
          </div>
          {phase === "loading" && <Badge tone="neutral">加载中</Badge>}
        </div>
        {phase === "error" && dashboard === null ? (
          <EmptyState
            title="候选暂时无法读取"
            description="本页没有报告任何写入成功。请恢复本地数据库后重试。"
            primaryAction={{ label: "重试", onClick: () => void load(false) }}
          />
        ) : dashboard?.candidates.length === 0 ? (
          <EmptyState
            title="没有可审核候选"
            description={
              dashboard.evaluationPassed
                ? "当前章节尚未产出候选。"
                : "先让当前提示词、模型与评测版本通过黄金样本门禁。"
            }
          />
        ) : (
          <div className="authoritative-extraction-candidate-list">
            {dashboard?.candidates.map((candidate) => {
              const identity = candidateIdentity(candidate);
              const editing = editingCandidate === identity;
              return (
                <CandidateCard
                  key={identity}
                  candidate={candidate}
                  actorId={actorId}
                  editing={editing}
                  modifiedJson={modifiedJson}
                  busyKey={busyKey}
                  onModifiedJsonChange={setModifiedJson}
                  onStartModify={() => {
                    setEditingCandidate(identity);
                    setModifiedJson(
                      JSON.stringify(candidate.extraction.candidate.suggestedValue, null, 2),
                    );
                    setError(null);
                  }}
                  onCancelModify={() => setEditingCandidate(null)}
                  onPerform={perform}
                  runtime={runtime}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

interface CandidateCardProps {
  readonly candidate: AuthoritativeExtractionDashboardCandidate;
  readonly actorId: string;
  readonly editing: boolean;
  readonly modifiedJson: string;
  readonly busyKey: string | null;
  readonly runtime: AuthoritativeExtractionDesktopPort;
  readonly onModifiedJsonChange: (value: string) => void;
  readonly onStartModify: () => void;
  readonly onCancelModify: () => void;
  readonly onPerform: (
    key: string,
    action: () => Promise<Result<unknown, StoryCoreError>>,
    successMessage: string,
  ) => Promise<void>;
}

function CandidateCard(props: CandidateCardProps) {
  const { extraction, review, target } = props.candidate;
  const candidate = extraction.candidate;
  const source = extraction.source;
  const identity = candidateIdentity(props.candidate);
  const latestTargetVersion = target?.versions.at(-1) ?? null;
  const canUndo =
    (review?.status === "accepted" || review?.status === "modified") &&
    latestTargetVersion?.sourceReviewItemId === extraction.reviewItemId &&
    (latestTargetVersion.reason === "suggestion_accepted" ||
      latestTargetVersion.reason === "suggestion_modified");
  const wasUndone =
    latestTargetVersion?.reason === "undo" &&
    target?.versions.at(-2)?.sourceReviewItemId === extraction.reviewItemId;
  const pending = review?.status === "pending";
  const deferred = review?.status === "deferred";

  function runModify(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(props.modifiedJson) as unknown;
    } catch {
      void props.onPerform(
        `invalid:${identity}`,
        () =>
          Promise.resolve({
            ok: false,
            error: new StoryCoreError({
              code: "STORY_VALIDATION_FAILED",
              message: "修改后的正式值必须是有效 JSON。",
            }),
          }),
        "",
      );
      return;
    }
    void props.onPerform(
      `modify:${identity}`,
      () =>
        props.runtime.decideFormal({
          jobId: extraction.jobId,
          candidateKey: candidate.key,
          kind: "modify",
          actorId: props.actorId,
          humanConfirmed: true,
          modifiedValue: parsed,
        }),
      "修改后的候选已由人工确认，正式事实与 GraphRAG 已同步处理。",
    );
  }

  return (
    <Card
      className={`authoritative-extraction-candidate${
        pending || deferred ? " candidate-decision-surface" : ""
      }`}
      aria-label={`${candidate.key}的正式设定候选决策`}
    >
      <CardHeader>
        <div className="authoritative-extraction-card-heading">
          <div>
            <CardTitle>{candidate.key}</CardTitle>
            <CardDescription>
              类别 {candidateCategoryLabel(candidate.category)} · 置信度{" "}
              {(candidate.confidence * 100).toFixed(0)}%
            </CardDescription>
          </div>
          <div className="authoritative-extraction-badges">
            <Badge tone={candidate.severity === "error" ? "danger" : "info"}>
              {candidateSeverityLabel(candidate.severity)}
            </Badge>
            <Badge tone={reviewStatusTone(review?.status)}>
              {wasUndone ? "已撤销" : reviewStatusLabel(review?.status)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent
        tabIndex={pending || deferred ? 0 : undefined}
        aria-label={`${candidate.key}的正式设定候选内容`}
        onKeyDown={handleCandidateDecisionNavigation}
      >
        <dl className="authoritative-extraction-provenance">
          <div>
            <dt>来源章节 / 版本</dt>
            <dd title={`${source.chapterId} / ${source.versionId}`}>
              {shortId(source.chapterId)} / {shortId(source.versionId)}
            </dd>
          </div>
          <div>
            <dt>校验和</dt>
            <dd title={source.checksumSha256}>{shortChecksum(source.checksumSha256)}</dd>
          </div>
          <div>
            <dt>范围</dt>
            <dd>
              {source.scope.start}–{source.scope.end} / {source.scope.sourceLength}
            </dd>
          </div>
          <div>
            <dt>提示词版本</dt>
            <dd>
              {extraction.provenance.prompt.registryId} v{extraction.provenance.prompt.version} ·{" "}
              <span title={extraction.provenance.prompt.checksumSha256}>
                {shortChecksum(extraction.provenance.prompt.checksumSha256)}
              </span>
            </dd>
          </div>
          <div>
            <dt>模型版本</dt>
            <dd>
              {extraction.provenance.model.provider}/{extraction.provenance.model.id}@
              {extraction.provenance.model.revision}
            </dd>
          </div>
          <div>
            <dt>评测版本</dt>
            <dd>{extraction.provenance.evaluationVersion}</dd>
          </div>
        </dl>

        <blockquote className="authoritative-extraction-evidence">
          <strong>
            章节证据 {candidate.evidence.range.start}–{candidate.evidence.range.end}
          </strong>
          <p>{candidate.evidence.excerpt}</p>
        </blockquote>

        <div className="authoritative-extraction-diff">
          <div>
            <strong>原正式值</strong>
            <pre>{formatJson(candidate.originalValue)}</pre>
          </div>
          <div>
            <strong>候选值</strong>
            <pre>{formatJson(candidate.suggestedValue)}</pre>
          </div>
        </div>

        {props.editing && (
          <div className="authoritative-extraction-modify">
            <label htmlFor={`modify-${identity}`}>修改后写入的正式结构化值（JSON）</label>
            <Textarea
              id={`modify-${identity}`}
              ref={fitCandidateDecisionTextarea}
              value={props.modifiedJson}
              onInput={(event) => fitCandidateDecisionTextarea(event.currentTarget)}
              onChange={(event) => props.onModifiedJsonChange(event.currentTarget.value)}
              rows={7}
              spellCheck={false}
            />
            <p>只有点击“确认修改并接受”才会进入正式事实。</p>
          </div>
        )}
      </CardContent>
      <CardFooter className="candidate-decision-actions">
        {pending && !props.editing && (
          <>
            <Button
              size="lg"
              loading={props.busyKey === `accept:${identity}`}
              disabled={props.busyKey !== null}
              onClick={() =>
                void props.onPerform(
                  `accept:${identity}`,
                  () =>
                    props.runtime.decideFormal({
                      jobId: extraction.jobId,
                      candidateKey: candidate.key,
                      kind: "accept",
                      actorId: props.actorId,
                      humanConfirmed: true,
                    }),
                  "候选已由人工接受，正式事实与 GraphRAG 已同步处理。",
                )
              }
            >
              接受候选
            </Button>
            <Button
              size="lg"
              variant="secondary"
              disabled={props.busyKey !== null}
              onClick={props.onStartModify}
            >
              修改后接受
            </Button>
            <Button
              size="lg"
              variant="secondary"
              disabled={props.busyKey !== null}
              onClick={() =>
                void props.onPerform(
                  `defer:${identity}`,
                  () =>
                    props.runtime.decideReview({
                      jobId: extraction.jobId,
                      candidateKey: candidate.key,
                      kind: "defer",
                      actorId: props.actorId,
                      humanConfirmed: true,
                      remindAt: tomorrowUtc(),
                    }),
                  "候选已暂缓，可稍后恢复审核。",
                )
              }
            >
              暂缓 24 小时
            </Button>
            <Button
              size="lg"
              variant="danger"
              disabled={props.busyKey !== null}
              onClick={() =>
                void props.onPerform(
                  `reject:${identity}`,
                  () =>
                    props.runtime.decideReview({
                      jobId: extraction.jobId,
                      candidateKey: candidate.key,
                      kind: "reject",
                      actorId: props.actorId,
                      humanConfirmed: true,
                    }),
                  "候选已拒绝，未修改正式事实。",
                )
              }
            >
              拒绝
            </Button>
          </>
        )}
        {pending && props.editing && (
          <>
            <Button
              size="lg"
              loading={props.busyKey === `modify:${identity}`}
              disabled={props.busyKey !== null}
              onClick={runModify}
            >
              确认修改并接受
            </Button>
            <Button
              size="lg"
              variant="secondary"
              disabled={props.busyKey !== null}
              onClick={props.onCancelModify}
            >
              取消修改
            </Button>
          </>
        )}
        {deferred && (
          <Button
            size="lg"
            disabled={props.busyKey !== null}
            onClick={() =>
              void props.onPerform(
                `resume:${identity}`,
                () =>
                  props.runtime.decideReview({
                    jobId: extraction.jobId,
                    candidateKey: candidate.key,
                    kind: "resume",
                    actorId: props.actorId,
                    humanConfirmed: true,
                  }),
                "候选已恢复为待审核。",
              )
            }
          >
            恢复审核
          </Button>
        )}
        {canUndo && (
          <Button
            size="lg"
            variant="secondary"
            loading={props.busyKey === `undo:${identity}`}
            disabled={props.busyKey !== null}
            onClick={() =>
              void props.onPerform(
                `undo:${identity}`,
                () =>
                  props.runtime.undoAcceptance({
                    jobId: extraction.jobId,
                    candidateKey: candidate.key,
                    actorId: props.actorId,
                    humanConfirmed: true,
                  }),
                "本候选写入的当前正式版本已撤销，GraphRAG 已同步处理。",
              )
            }
          >
            撤销本次接受
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function JobCard({
  job,
  busy,
  disabled,
  onCancel,
}: Readonly<{
  job: AuthoritativeExtractionJob;
  busy: boolean;
  disabled: boolean;
  onCancel: () => void;
}>) {
  const cancellable = ![
    "awaiting_review",
    "completed",
    "failed_final",
    "blocked_stale",
    "cancelled",
  ].includes(job.state);
  return (
    <Card className="authoritative-extraction-job">
      <CardContent>
        <div>
          <strong title={job.id}>{shortId(job.id)}</strong>
          <span title={job.source.versionId}>版本 {shortId(job.source.versionId)}</span>
        </div>
        <Badge tone={jobStateTone(job.state)}>{jobStateLabel(job.state)}</Badge>
        <span>尝试 {job.attemptCount}</span>
        {job.failure !== null && (
          <span>原因：{projectOrdinaryUiError({ code: job.failure.code }).description}</span>
        )}
        {cancellable && (
          <Button size="sm" variant="ghost" loading={busy} disabled={disabled} onClick={onCancel}>
            取消
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: Readonly<{
  label: string;
  value: string;
  tone: "neutral" | "ai" | "success" | "warning" | "danger" | "info";
}>) {
  return (
    <Card>
      <CardContent>
        <span>{label}</span>
        <Badge tone={tone}>{value}</Badge>
      </CardContent>
    </Card>
  );
}

function availabilityCopy(
  reason: "feature_disabled" | "native_sqlite_required" | "provider_not_configured",
) {
  switch (reason) {
    case "feature_disabled":
      return {
        title: "权威抽取默认关闭",
        description: "启用前不会读取章节、调用模型或创建任务。请由产品配置显式开启。",
      };
    case "native_sqlite_required":
      return {
        title: "需要桌面原生持久化",
        description:
          "浏览器开发模式不会伪装生产级队列与评测存储。请在已连接桌面本地数据库的运行环境中使用。",
      };
    case "provider_not_configured":
      return {
        title: "尚未配置真实抽取提供方",
        description: "本页不会用演示生成器冒充端到端抽取。配置真实提供方后才能启用。",
      };
  }
}

function candidateIdentity(candidate: AuthoritativeExtractionDashboardCandidate): string {
  return `${candidate.extraction.jobId}:${candidate.extraction.candidate.key}`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function shortChecksum(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function graphFreshnessLabel(
  value: AuthoritativeExtractionDashboard["graphFreshness"] | undefined,
): string {
  switch (value) {
    case "fresh":
      return "最新";
    case "missing":
      return "待创建";
    case "stale":
      return "已过期";
    case "unavailable":
      return "不可用";
    default:
      return "读取中";
  }
}

function reviewStatusLabel(value: ReviewItemStatus | undefined): string {
  switch (value) {
    case "pending":
      return "待审核";
    case "accepted":
      return "已接受";
    case "modified":
      return "修改后接受";
    case "rejected":
      return "已拒绝";
    case "deferred":
      return "已暂缓";
    default:
      return "待物化";
  }
}

function candidateCategoryLabel(value: string): string {
  const labels: Record<string, string> = {
    character: "角色",
    character_state: "角色状态",
    foreshadow: "伏笔",
    location: "地点",
    timeline: "时间线",
    timeline_event: "时间线事件",
    world_rule: "世界规则",
  };
  return labels[value] ?? "自定义";
}

function candidateSeverityLabel(value: string): string {
  const labels: Record<string, string> = {
    error: "高风险",
    info: "提示",
    warning: "需注意",
  };
  return labels[value] ?? "提示";
}

function reviewStatusTone(value: ReviewItemStatus | undefined) {
  switch (value) {
    case "accepted":
    case "modified":
      return "success" as const;
    case "rejected":
      return "danger" as const;
    case "deferred":
      return "warning" as const;
    case "pending":
      return "ai" as const;
    default:
      return "neutral" as const;
  }
}

function jobStateLabel(state: AuthoritativeExtractionJob["state"]): string {
  const labels: Record<AuthoritativeExtractionJob["state"], string> = {
    queued: "排队中",
    running: "抽取中",
    waiting_for_network: "等待联网",
    blocked_evaluation: "评测未通过",
    materialization_pending: "待物化",
    materializing: "物化中",
    awaiting_review: "等待审核",
    completed: "已完成",
    failed_retryable: "可重试失败",
    failed_final: "最终失败",
    blocked_stale: "来源已变化",
    cancelled: "已取消",
  };
  return labels[state];
}

function jobStateTone(state: AuthoritativeExtractionJob["state"]) {
  switch (state) {
    case "awaiting_review":
    case "completed":
      return "success" as const;
    case "failed_final":
    case "blocked_stale":
      return "danger" as const;
    case "waiting_for_network":
    case "blocked_evaluation":
    case "failed_retryable":
      return "warning" as const;
    case "running":
    case "materializing":
      return "ai" as const;
    default:
      return "neutral" as const;
  }
}

function tomorrowUtc(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
}

function readOnlineState(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}
