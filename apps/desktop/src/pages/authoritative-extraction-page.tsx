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
            <h1>从正文更新设定</h1>
            <p>整理出的设定需要你确认后才会写入正式故事设定。</p>
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
          <h1>从正文更新设定</h1>
          <p>从当前章节找出人物、地点和事件等设定；每条结果都需要你确认。</p>
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
                online ? "章节扫描与待确认设定已刷新。" : "已安全记录离线等待状态。",
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
                  "整理能力检查已刷新。",
                )
              }
            >
              检查整理能力
            </Button>
          )}
        </div>
      </header>

      <InlineAlert
        tone="ai-clarification"
        title="AI 整理结果始终需要你确认"
        description="使用、修改、放弃或稍后处理都必须由你明确操作。来源与处理记录会完整保留，技术标识可在每条记录的“高级诊断详情”中查看。"
      />

      {!online && (
        <InlineAlert
          tone="warning"
          title="当前离线"
          description="离线时不会发送正文或自动重试；系统只保存任务进度并等待恢复联网。"
        />
      )}
      {waitingForNetwork && online && (
        <InlineAlert
          tone="info"
          title="离线任务可以恢复"
          description="再次扫描会继续原来的任务，不会为同一来源重复创建工作。"
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

      <section className="authoritative-extraction-summary" aria-label="设定整理状态摘要">
        <SummaryCard
          label="整理能力检查"
          value={dashboard?.evaluationPassed === true ? "通过" : "未通过"}
          tone={dashboard?.evaluationPassed === true ? "success" : "warning"}
        />
        <SummaryCard label="可恢复任务" value={String(dashboard?.jobs.length ?? 0)} tone="info" />
        <SummaryCard
          label="待确认设定"
          value={String(
            dashboard?.candidates.filter(
              ({ review }) =>
                review === null || review.status === "pending" || review.status === "deferred",
            ).length ?? 0,
          )}
          tone="ai"
        />
        <SummaryCard
          label="故事关联资料"
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
          title="故事关联资料需要更新"
          description="正式设定仍然安全；更新完成前，不应把旧的关联资料当作当前设定。"
          action={{
            label: "立即更新",
            onClick: () =>
              void perform(
                "projection",
                () => runtime.rebuildProjection(projectId),
                "故事关联资料已从正式设定更新。",
              ),
          }}
        />
      )}

      <section className="authoritative-extraction-jobs" aria-labelledby="extraction-jobs-title">
        <div className="authoritative-extraction-section-heading">
          <div>
            <h2 id="extraction-jobs-title">可恢复任务</h2>
            <p>进度、取消请求和失败原因都会保存在本机；应用意外关闭后仍可继续。</p>
          </div>
        </div>
        {dashboard?.jobs.length === 0 ? (
          <EmptyState
            title="还没有整理任务"
            description="整理当前章节后，会为已保存版本创建一项可恢复工作；重复操作不会重复创建。"
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
                    "取消请求已保存；迟到的模型输出不会进入待确认列表。",
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
            <h2 id="extraction-candidates-title">待确认设定</h2>
            <p>只有你点击使用或修改后使用，内容才会写入正式设定。</p>
          </div>
          {phase === "loading" && <Badge tone="neutral">加载中</Badge>}
        </div>
        {phase === "error" && dashboard === null ? (
          <EmptyState
            title="待确认设定暂时无法读取"
            description="本页没有报告任何写入成功。请恢复本地数据库后重试。"
            primaryAction={{ label: "重试", onClick: () => void load(false) }}
          />
        ) : dashboard?.candidates.length === 0 ? (
          <EmptyState
            title="没有待确认设定"
            description={
              dashboard.evaluationPassed
                ? "当前章节尚未整理出需要确认的设定。"
                : "请先完成当前整理方式的能力检查。"
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
  const categoryLabel = candidateCategoryLabel(candidate.category);

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
              message: "修改后的设定内容格式无法识别。",
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
      "修改后的设定已由你确认，正式设定与故事关联资料已同步更新。",
    );
  }

  return (
    <Card
      className={`authoritative-extraction-candidate${
        pending || deferred ? " candidate-decision-surface" : ""
      }`}
      aria-label={`${categoryLabel}设定的审核决定`}
    >
      <CardHeader>
        <div className="authoritative-extraction-card-heading">
          <div>
            <CardTitle>{categoryLabel}设定待确认</CardTitle>
            <CardDescription>内容可信度 {(candidate.confidence * 100).toFixed(0)}%</CardDescription>
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
        aria-label={`${categoryLabel}设定的待确认内容`}
        onKeyDown={handleCandidateDecisionNavigation}
      >
        <dl className="authoritative-extraction-provenance">
          <div>
            <dt>来源章节</dt>
            <dd>当前章节</dd>
          </div>
          <div>
            <dt>正文版本</dt>
            <dd>本次整理所用的已保存版本</dd>
          </div>
          <div>
            <dt>原文位置</dt>
            <dd>
              第 {source.scope.start + 1}–{source.scope.end} 个字（共 {source.scope.sourceLength}{" "}
              个字）
            </dd>
          </div>
        </dl>

        <AdvancedDiagnostics
          className="authoritative-extraction-provenance"
          rows={[
            ["结果键", candidate.key],
            ["任务编号", extraction.jobId],
            ["审核记录编号", extraction.reviewItemId],
            ["项目编号", source.projectId],
            ["章节编号", source.chapterId],
            ["版本编号", source.versionId],
            ["正文 SHA-256", source.checksumSha256],
            [
              "整理规则版本",
              `${extraction.provenance.prompt.registryId} v${String(extraction.provenance.prompt.version)}`,
            ],
            ["整理规则 SHA-256", extraction.provenance.prompt.checksumSha256],
            [
              "模型版本",
              `${extraction.provenance.model.provider}/${extraction.provenance.model.id}@${extraction.provenance.model.revision}`,
            ],
            ["能力检查版本", extraction.provenance.evaluationVersion],
          ]}
        />

        <blockquote className="authoritative-extraction-evidence">
          <strong>
            原文依据 · 第 {candidate.evidence.range.start + 1}–{candidate.evidence.range.end} 个字
          </strong>
          <p>{candidate.evidence.excerpt}</p>
        </blockquote>

        <div className="authoritative-extraction-diff">
          <div>
            <strong>当前正式设定</strong>
            <pre>{formatJson(candidate.originalValue)}</pre>
          </div>
          <div>
            <strong>建议设定</strong>
            <pre>{formatJson(candidate.suggestedValue)}</pre>
          </div>
        </div>

        {props.editing && (
          <div className="authoritative-extraction-modify">
            <label htmlFor={`modify-${identity}`}>修改后保存的设定内容</label>
            <Textarea
              id={`modify-${identity}`}
              ref={fitCandidateDecisionTextarea}
              value={props.modifiedJson}
              onInput={(event) => fitCandidateDecisionTextarea(event.currentTarget)}
              onChange={(event) => props.onModifiedJsonChange(event.currentTarget.value)}
              rows={7}
              spellCheck={false}
            />
            <p>只有点击“确认修改并使用”才会写入正式设定。</p>
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
                  "这条设定已由你确认，正式设定与故事关联资料已同步更新。",
                )
              }
            >
              使用这条设定
            </Button>
            <Button
              size="lg"
              variant="secondary"
              disabled={props.busyKey !== null}
              onClick={props.onStartModify}
            >
              修改后使用
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
                  "这条设定已暂缓，你可以稍后继续确认。",
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
                  "这条设定已放弃，没有修改正式设定。",
                )
              }
            >
              放弃
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
              确认修改并使用
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
                "这条设定已恢复为待确认。",
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
                "这条设定写入的当前正式版本已撤销，故事关联资料已同步更新。",
              )
            }
          >
            撤销本次使用
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
    <Card className="authoritative-extraction-job" aria-label="章节设定整理任务">
      <CardContent>
        <div>
          <strong>章节设定整理任务</strong>
          <span>来源：当前章节 · 本次整理所用的已保存版本</span>
        </div>
        <Badge tone={jobStateTone(job.state)}>{jobStateLabel(job.state)}</Badge>
        <span>已尝试 {job.attemptCount} 次</span>
        {job.failure !== null && (
          <span>原因：{projectOrdinaryUiError({ code: job.failure.code }).description}</span>
        )}
        <AdvancedDiagnostics
          className="authoritative-extraction-provenance"
          rows={[
            ["任务编号", job.id],
            ["项目编号", job.source.projectId],
            ["章节编号", job.source.chapterId],
            ["版本编号", job.source.versionId],
            ["正文 SHA-256", job.source.checksumSha256],
          ]}
        />
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

function AdvancedDiagnostics({
  className,
  rows,
}: Readonly<{
  className: string;
  rows: readonly (readonly [label: string, value: string | number])[];
}>) {
  return (
    <details>
      <summary>高级诊断详情</summary>
      <dl className={className}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
function availabilityCopy(
  reason: "feature_disabled" | "native_sqlite_required" | "provider_not_configured",
) {
  switch (reason) {
    case "feature_disabled":
      return {
        title: "自动整理设定默认关闭",
        description: "启用前不会读取章节、联系模型服务或创建任务。请在产品设置中明确开启。",
      };
    case "native_sqlite_required":
      return {
        title: "需要桌面本地存储",
        description:
          "浏览器开发模式不会伪装可恢复任务和能力检查记录。请在已连接桌面本地数据库的应用中使用。",
      };
    case "provider_not_configured":
      return {
        title: "尚未配置可用的设定整理模型",
        description: "本页不会用演示内容冒充真实整理结果。配置可用的模型服务后才能启用。",
      };
  }
}

function candidateIdentity(candidate: AuthoritativeExtractionDashboardCandidate): string {
  return `${candidate.extraction.jobId}:${candidate.extraction.candidate.key}`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
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
      return "待确认";
    case "accepted":
      return "已使用";
    case "modified":
      return "修改后使用";
    case "rejected":
      return "已放弃";
    case "deferred":
      return "已暂缓";
    default:
      return "等待保存";
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
    running: "整理中",
    waiting_for_network: "等待联网",
    blocked_evaluation: "整理能力检查未通过",
    materialization_pending: "等待保存",
    materializing: "保存中",
    awaiting_review: "等待确认",
    completed: "已完成",
    failed_retryable: "可以重试",
    failed_final: "未能完成",
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
