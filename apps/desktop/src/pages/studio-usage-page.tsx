import { CloudClientError } from "@inkshadow/cloud-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PageStateBoundary,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@inkshadow/ui";
import type {
  CloudAiUsageBucket,
  CloudAiUsageEvent,
  CloudAiUsageSummaryResponse,
} from "@inkshadow/contracts";
import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import type { CloudAiUsageRuntimePort } from "../infrastructure/cloud-ai-usage-service";
import { CloudSessionCoordinatorError } from "../infrastructure/cloud-session-coordinator";
import { useRuntime } from "../runtime-context";

type PageState =
  | Readonly<{ status: "loading" }>
  | Readonly<{
      status: "ready";
      summary: CloudAiUsageSummaryResponse;
      events: readonly CloudAiUsageEvent[];
    }>
  | Readonly<{ status: "forbidden"; error: VisibleError }>
  | Readonly<{ status: "error"; error: VisibleError }>;

interface VisibleError {
  readonly code: string;
  readonly description: string;
  readonly requestId?: string;
}

interface TeamBudgetDraft {
  readonly currency: string;
  readonly monthlyLimit: string;
  readonly priceVersion: string;
  readonly inputPrice: string;
  readonly outputPrice: string;
  readonly maximumConcurrentRuns: string;
}

interface ProjectBudgetDraft {
  readonly monthlyLimit: string;
  readonly maximumConcurrentRuns: string;
}

export function StudioUsagePage() {
  const runtime = useRuntime();
  const service = runtime.cloudAiUsage ?? null;
  const { teamId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [saving, setSaving] = useState<"team" | "project" | null>(null);
  const [operationError, setOperationError] = useState<VisibleError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [teamDraft, setTeamDraft] = useState<TeamBudgetDraft>(() => emptyTeamDraft());
  const [projectDraft, setProjectDraft] = useState<ProjectBudgetDraft>({
    monthlyLimit: "",
    maximumConcurrentRuns: "",
  });

  const load = useCallback(
    async (target: CloudAiUsageRuntimePort, signal?: AbortSignal) => {
      await Promise.resolve();
      setState({ status: "loading" });
      try {
        const [summary, eventPage] = await Promise.all([
          target.getSummary(teamId, projectId, signal),
          target.listEvents(teamId, projectId, {
            limit: 50,
            ...(signal === undefined ? {} : { signal }),
          }),
        ]);
        setState({ status: "ready", summary, events: eventPage.events });
        setTeamDraft(teamBudgetDraft(summary));
        setProjectDraft(projectBudgetDraft(summary));
      } catch (error: unknown) {
        if (signal?.aborted === true) {
          return;
        }
        const visible = toVisibleError(error);
        setState(
          isForbidden(error)
            ? { status: "forbidden", error: visible }
            : { status: "error", error: visible },
        );
      }
    },
    [projectId, teamId],
  );

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (service === null || !online || teamId.length === 0) {
      return;
    }
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        void load(service, controller.signal);
      }
    });
    return () => controller.abort();
  }, [load, online, service, teamId]);

  if (service === null) {
    return (
      <div className="studio-usage-page">
        <PageIntro teamId={teamId} projectId={projectId} />
        <EmptyState
          kind="feature_limited"
          title="AI 用量云服务未配置"
          description="当前运行环境没有原生云会话与真实用量接口。预算操作保持关闭；本地正文、草稿与离线编辑不受影响。"
        />
      </div>
    );
  }

  if (!online) {
    return (
      <div className="studio-usage-page">
        <PageIntro teamId={teamId} projectId={projectId} />
        <EmptyState
          kind="offline"
          title="离线时无法读取云端用量"
          description="重新联网后可刷新团队预算与账本。本地正文和现有草稿仍可继续编辑，不会因为云端额度而被锁定。"
        />
      </div>
    );
  }

  async function saveTeamBudget(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (service === null || state.status !== "ready" || saving !== null) {
      return;
    }
    setSaving("team");
    setOperationError(null);
    setNotice(null);
    try {
      await service.updateTeamBudget(teamId, {
        expectedRevision: state.summary.teamBudget?.revision ?? null,
        currency: requireCurrency(teamDraft.currency),
        monthlyLimitMicrounits: requireMoney(teamDraft.monthlyLimit, "团队月度额度"),
        priceVersion: requireText(teamDraft.priceVersion, "价格版本"),
        inputMicrounitsPerMillionTokens: requireMoney(teamDraft.inputPrice, "输入价格", true),
        outputMicrounitsPerMillionTokens: requireMoney(teamDraft.outputPrice, "输出价格", true),
        maximumConcurrentRuns: requirePositiveInteger(
          teamDraft.maximumConcurrentRuns,
          "团队并发上限",
        ),
      });
      setNotice("团队 AI 预算已更新。");
      await load(service);
    } catch (error: unknown) {
      setOperationError(toVisibleError(error));
    } finally {
      setSaving(null);
    }
  }

  async function saveProjectBudget(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (service === null || projectId === null || state.status !== "ready" || saving !== null) {
      return;
    }
    setSaving("project");
    setOperationError(null);
    setNotice(null);
    try {
      await service.updateProjectBudget(teamId, projectId, {
        expectedRevision: state.summary.projectBudget?.revision ?? null,
        monthlyLimitMicrounits:
          projectDraft.monthlyLimit.trim().length === 0
            ? null
            : requireMoney(projectDraft.monthlyLimit, "项目月度额度"),
        maximumConcurrentRuns:
          projectDraft.maximumConcurrentRuns.trim().length === 0
            ? null
            : requirePositiveInteger(projectDraft.maximumConcurrentRuns, "项目并发上限"),
      });
      setNotice("项目 AI 预算覆盖已更新。");
      await load(service);
    } catch (error: unknown) {
      setOperationError(toVisibleError(error));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="studio-usage-page">
      <PageIntro teamId={teamId} projectId={projectId} />
      {operationError !== null && (
        <InlineAlert
          tone="error"
          title={errorTitle(operationError.code)}
          description={operationError.description}
          onDismiss={() => setOperationError(null)}
          dismissLabel="关闭错误"
        />
      )}
      {notice !== null && (
        <InlineAlert
          tone="info"
          title="预算已保存"
          description={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel="关闭通知"
        />
      )}

      {state.status === "loading" && (
        <PageStateBoundary state="loading" loadingLabel="正在读取 AI 预算与用量">
          <span />
        </PageStateBoundary>
      )}
      {state.status === "forbidden" && (
        <EmptyState
          kind="forbidden"
          title="无权查看此用量范围"
          description={`${state.error.description} 本地正文和离线编辑不受影响。`}
        />
      )}
      {state.status === "error" && (
        <ErrorState
          title="无法读取 AI 用量"
          description={state.error.description}
          errorCode={state.error.code}
          {...(state.error.requestId === undefined ? {} : { requestId: state.error.requestId })}
          primaryAction={{ label: "重试", onClick: () => void load(service) }}
        />
      )}
      {state.status === "ready" && (
        <>
          <UsageOverview summary={state.summary} />

          {state.summary.leaseExpiredCount > 0 && (
            <InlineAlert
              tone="warning"
              title="已回收过期并发占位"
              description={`本次读取回收了 ${String(state.summary.leaseExpiredCount)} 个过期租约，额度已归还到其创建月份。`}
            />
          )}

          <div className="studio-usage-page__budget-grid">
            {state.summary.team !== null && state.summary.capabilities.manageTeamBudget && (
              <TeamBudgetForm
                draft={teamDraft}
                disabled={saving !== null}
                loading={saving === "team"}
                updatedAt={state.summary.teamBudget?.updatedAt ?? null}
                revision={state.summary.teamBudget?.revision ?? null}
                onChange={setTeamDraft}
                onSubmit={(event) => void saveTeamBudget(event)}
              />
            )}
            {state.summary.team !== null && !state.summary.capabilities.manageTeamBudget && (
              <BudgetAccessNotice scope="团队" />
            )}
            {projectId !== null &&
              state.summary.project !== null &&
              state.summary.capabilities.manageProjectBudget && (
                <ProjectBudgetForm
                  draft={projectDraft}
                  disabled={saving !== null}
                  loading={saving === "project"}
                  updatedAt={state.summary.projectBudget?.updatedAt ?? null}
                  revision={state.summary.projectBudget?.revision ?? null}
                  onChange={setProjectDraft}
                  onSubmit={(event) => void saveProjectBudget(event)}
                />
              )}
            {projectId !== null &&
              state.summary.project !== null &&
              !state.summary.capabilities.manageProjectBudget && (
                <BudgetAccessNotice scope="项目" />
              )}
          </div>

          <UsageEvents events={state.events} currency={state.summary.currency} />
        </>
      )}
    </div>
  );
}

function PageIntro({
  teamId,
  projectId,
}: {
  readonly teamId: string;
  readonly projectId: string | null;
}) {
  return (
    <header className="studio-usage-page__intro">
      <div>
        <p className="studio-usage-page__eyebrow">Studio Cloud · InkShadow 内部额度账本</p>
        <h1>AI 额度、并发与用量</h1>
        <p>
          这是 InkShadow 内部的 token
          与价格元数据额度账本，数值来自受控执行回执或客户端上报；服务端不接收正文、提示词、项目密钥或密文。
        </p>
        <p>实际收费以模型供应商账单为准；当前版本尚未实现供应商侧权威账单对账。</p>
      </div>
      <div className="studio-usage-page__scope">
        <Link to="/teams">返回团队</Link>
        <code>{teamId}</code>
        {projectId !== null && <code>{projectId}</code>}
      </div>
    </header>
  );
}

function UsageOverview({ summary }: { readonly summary: CloudAiUsageSummaryResponse }) {
  const concurrencyReached = summary.concurrencyHardCapReached;
  return (
    <section className="studio-usage-page__overview" aria-label="AI 用量概览">
      <UsageCard title="团队月度用量" bucket={summary.team} currency={summary.currency} />
      <UsageCard title="项目月度用量" bucket={summary.project} currency={summary.currency} />
      <Card>
        <CardHeader>
          <CardTitle>并发租约</CardTitle>
          <CardDescription>租约超时会自动回收，不会永久占用运行名额。</CardDescription>
        </CardHeader>
        <CardContent className="studio-usage-page__metrics">
          <strong>
            {String(summary.activeLeaseCount)} /{" "}
            {summary.maximumConcurrentRuns === null
              ? "未配置"
              : String(summary.maximumConcurrentRuns)}
          </strong>
          {summary.activeProjectLeaseCount !== null && (
            <span>
              当前项目 {String(summary.activeProjectLeaseCount)} /{" "}
              {summary.projectMaximumConcurrentRuns === null
                ? "继承团队"
                : String(summary.projectMaximumConcurrentRuns)}
            </span>
          )}
          <Badge tone={concurrencyReached ? "danger" : "success"}>
            {concurrencyReached ? "并发硬上限已触发" : "可继续预约"}
          </Badge>
          <small>
            有效上限：
            {summary.effectiveMaximumConcurrentRuns === null
              ? "未配置"
              : String(summary.effectiveMaximumConcurrentRuns)}
          </small>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>计价版本</CardTitle>
          <CardDescription>
            内部额度按预约时锁定的服务端价格快照计算，不代表供应商最终账单。
          </CardDescription>
        </CardHeader>
        <CardContent className="studio-usage-page__metrics">
          <strong>{summary.priceVersion ?? "未配置"}</strong>
          <span>{summary.currency ?? "—"}</span>
          <small>服务端时间 {formatDate(summary.serverTime)}</small>
        </CardContent>
      </Card>
    </section>
  );
}

function UsageCard({
  title,
  bucket,
  currency,
}: {
  readonly title: string;
  readonly bucket: CloudAiUsageBucket | null;
  readonly currency: string | null;
}) {
  if (bucket === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>当前角色不具备该范围的查看权限。</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const used = bucket.settledMicrounits + bucket.reservedMicrounits;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          已结算 {formatMoney(bucket.settledMicrounits, currency)} · 已预约{" "}
          {formatMoney(bucket.reservedMicrounits, currency)}
        </CardDescription>
      </CardHeader>
      <CardContent className="studio-usage-page__metrics">
        <strong>{formatMoney(used, currency)}</strong>
        <span>
          /{" "}
          {bucket.monthlyLimitMicrounits === null
            ? "未配置"
            : formatMoney(bucket.monthlyLimitMicrounits, currency)}
        </span>
        <Badge tone={statusTone(bucket.status)}>{statusLabel(bucket.status)}</Badge>
        <small>
          剩余{" "}
          {bucket.remainingMicrounits === null
            ? "—"
            : formatMoney(bucket.remainingMicrounits, currency)}
        </small>
      </CardContent>
    </Card>
  );
}

function TeamBudgetForm(props: {
  readonly draft: TeamBudgetDraft;
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly revision: number | null;
  readonly updatedAt: string | null;
  readonly onChange: (draft: TeamBudgetDraft) => void;
  readonly onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
}) {
  const update = (patch: Partial<TeamBudgetDraft>) => props.onChange({ ...props.draft, ...patch });
  return (
    <Card>
      <CardHeader>
        <CardTitle>团队预算与服务端价格</CardTitle>
        <CardDescription>
          80% 时预警，100% 时拒绝新预约。修订 {props.revision ?? "尚未创建"} ·{" "}
          {props.updatedAt === null ? "尚未更新" : formatDate(props.updatedAt)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="studio-usage-page__form" onSubmit={props.onSubmit}>
          <FormField label="币种" required>
            {(field) => (
              <Input
                {...field}
                value={props.draft.currency}
                maxLength={3}
                disabled={props.disabled}
                onChange={(event) => update({ currency: event.currentTarget.value.toUpperCase() })}
              />
            )}
          </FormField>
          <FormField label="月度额度（币种单位）" required>
            {(field) => (
              <Input
                {...field}
                inputMode="decimal"
                value={props.draft.monthlyLimit}
                disabled={props.disabled}
                onChange={(event) => update({ monthlyLimit: event.currentTarget.value })}
              />
            )}
          </FormField>
          <FormField label="最大并发运行" required>
            {(field) => (
              <Input
                {...field}
                type="number"
                min={1}
                max={10_000}
                value={props.draft.maximumConcurrentRuns}
                disabled={props.disabled}
                onChange={(event) => update({ maximumConcurrentRuns: event.currentTarget.value })}
              />
            )}
          </FormField>
          <FormField label="价格版本" required>
            {(field) => (
              <Input
                {...field}
                value={props.draft.priceVersion}
                disabled={props.disabled}
                onChange={(event) => update({ priceVersion: event.currentTarget.value })}
              />
            )}
          </FormField>
          <FormField label="每百万输入 token 价格" required>
            {(field) => (
              <Input
                {...field}
                inputMode="decimal"
                value={props.draft.inputPrice}
                disabled={props.disabled}
                onChange={(event) => update({ inputPrice: event.currentTarget.value })}
              />
            )}
          </FormField>
          <FormField label="每百万输出 token 价格" required>
            {(field) => (
              <Input
                {...field}
                inputMode="decimal"
                value={props.draft.outputPrice}
                disabled={props.disabled}
                onChange={(event) => update({ outputPrice: event.currentTarget.value })}
              />
            )}
          </FormField>
          <Button type="submit" loading={props.loading} disabled={props.disabled}>
            保存团队预算
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ProjectBudgetForm(props: {
  readonly draft: ProjectBudgetDraft;
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly revision: number | null;
  readonly updatedAt: string | null;
  readonly onChange: (draft: ProjectBudgetDraft) => void;
  readonly onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
}) {
  const update = (patch: Partial<ProjectBudgetDraft>) =>
    props.onChange({ ...props.draft, ...patch });
  return (
    <Card>
      <CardHeader>
        <CardTitle>项目覆盖</CardTitle>
        <CardDescription>
          留空即继承团队额度或并发。修订 {props.revision ?? "尚未创建"} ·{" "}
          {props.updatedAt === null ? "尚未更新" : formatDate(props.updatedAt)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="studio-usage-page__form" onSubmit={props.onSubmit}>
          <FormField label="项目月度额度（可留空）">
            {(field) => (
              <Input
                {...field}
                inputMode="decimal"
                value={props.draft.monthlyLimit}
                disabled={props.disabled}
                onChange={(event) => update({ monthlyLimit: event.currentTarget.value })}
              />
            )}
          </FormField>
          <FormField label="项目最大并发（可留空）">
            {(field) => (
              <Input
                {...field}
                type="number"
                min={1}
                max={10_000}
                value={props.draft.maximumConcurrentRuns}
                disabled={props.disabled}
                onChange={(event) => update({ maximumConcurrentRuns: event.currentTarget.value })}
              />
            )}
          </FormField>
          <Button type="submit" loading={props.loading} disabled={props.disabled}>
            保存项目覆盖
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function BudgetAccessNotice({ scope }: { readonly scope: "团队" | "项目" }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{scope}预算为只读</CardTitle>
        <CardDescription>
          当前服务端角色可以查看此范围的用量，但没有修改预算的
          capability。页面不会提供无效的保存按钮。
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function UsageEvents({
  events,
  currency,
}: {
  readonly events: readonly CloudAiUsageEvent[];
  readonly currency: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>最近用量账本</CardTitle>
        <CardDescription>仅包含计费元数据；历史事件只追加、不覆写。</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <EmptyState title="还没有用量事件" description="首次预约后会在此显示元数据账本。" />
        ) : (
          <Table scrollLabel="AI 用量账本">
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>事件</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>用途</TableHead>
                <TableHead>输入 / 输出</TableHead>
                <TableHead>金额</TableHead>
                <TableHead>价格版本</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.eventId}>
                  <TableCell>{formatDate(event.createdAt)}</TableCell>
                  <TableCell>{eventTypeLabel(event.eventType)}</TableCell>
                  <TableCell>{event.modelIdentifier}</TableCell>
                  <TableCell>{purposeLabel(event.purpose)}</TableCell>
                  <TableCell>
                    {String(event.inputTokens)} / {String(event.outputTokens)}
                  </TableCell>
                  <TableCell>{formatMoney(event.costMicrounits, currency)}</TableCell>
                  <TableCell>{event.priceVersion}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function emptyTeamDraft(): TeamBudgetDraft {
  return {
    currency: "AUD",
    monthlyLimit: "",
    priceVersion: "",
    inputPrice: "",
    outputPrice: "",
    maximumConcurrentRuns: "1",
  };
}

function teamBudgetDraft(summary: CloudAiUsageSummaryResponse): TeamBudgetDraft {
  const budget = summary.teamBudget;
  if (budget === null) {
    return { ...emptyTeamDraft(), currency: summary.currency ?? "AUD" };
  }
  return {
    currency: budget.currency,
    monthlyLimit: microunitsToInput(budget.monthlyLimitMicrounits),
    priceVersion: budget.priceVersion,
    inputPrice: microunitsToInput(budget.inputMicrounitsPerMillionTokens),
    outputPrice: microunitsToInput(budget.outputMicrounitsPerMillionTokens),
    maximumConcurrentRuns: String(budget.maximumConcurrentRuns),
  };
}

function projectBudgetDraft(summary: CloudAiUsageSummaryResponse): ProjectBudgetDraft {
  return {
    monthlyLimit:
      summary.projectBudget?.monthlyLimitMicrounits == null
        ? ""
        : microunitsToInput(summary.projectBudget.monthlyLimitMicrounits),
    maximumConcurrentRuns:
      summary.projectBudget?.maximumConcurrentRuns == null
        ? ""
        : String(summary.projectBudget.maximumConcurrentRuns),
  };
}

function microunitsToInput(value: number): string {
  return (value / 1_000_000).toFixed(6).replace(/\.?0+$/u, "");
}

function requireMoney(value: string, label: string, allowZero = false): number {
  const parsed = Number(value.trim());
  const microunits = Math.round(parsed * 1_000_000);
  if (
    !Number.isFinite(parsed) ||
    !Number.isSafeInteger(microunits) ||
    microunits < (allowZero ? 0 : 1)
  ) {
    throw new Error(`${label}必须是有效的非负金额，且不能超过安全计数范围。`);
  }
  return microunits;
}

function requirePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error(`${label}必须是 1 到 10000 之间的整数。`);
  }
  return parsed;
}

function requireCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw new Error("币种必须是三个大写字母，例如 AUD。");
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label}不能为空。`);
  }
  return normalized;
}

function formatMoney(value: number, currency: string | null): string {
  if (currency === null) {
    return `${microunitsToInput(value)}（未配置币种）`;
  }
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: 6,
  }).format(value / 1_000_000);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusTone(
  status: CloudAiUsageBucket["status"],
): "neutral" | "success" | "warning" | "danger" {
  switch (status) {
    case "ok":
      return "success";
    case "warning":
      return "warning";
    case "hard_cap":
      return "danger";
    case "unconfigured":
      return "neutral";
  }
}

function statusLabel(status: CloudAiUsageBucket["status"]): string {
  switch (status) {
    case "ok":
      return "正常";
    case "warning":
      return "已达到 80% 预警线";
    case "hard_cap":
      return "硬上限已触发";
    case "unconfigured":
      return "未配置";
  }
}

function eventTypeLabel(type: CloudAiUsageEvent["eventType"]): string {
  switch (type) {
    case "reserved":
      return "已预约";
    case "settled":
      return "已结算";
    case "cancelled":
      return "已取消";
    case "lease_expired":
      return "租约过期";
  }
}

function purposeLabel(purpose: CloudAiUsageEvent["purpose"]): string {
  return purpose === "read_only_review" ? "只读 AI 评审" : "正文生成";
}

function isForbidden(error: unknown): boolean {
  return (
    (error instanceof CloudClientError &&
      (error.code === "ACCESS_FORBIDDEN" || error.status === 403)) ||
    (error instanceof CloudSessionCoordinatorError &&
      (error.reason === "account_blocked" || error.reason === "reauth_required"))
  );
}

function toVisibleError(error: unknown): VisibleError {
  if (error instanceof CloudClientError) {
    return {
      code: error.code,
      description: error.message,
      ...(error.requestId === null ? {} : { requestId: error.requestId }),
    };
  }
  if (error instanceof CloudSessionCoordinatorError) {
    return { code: error.sourceCode, description: error.message };
  }
  if (error instanceof Error) {
    return { code: "AI_USAGE_UI_ERROR", description: error.message };
  }
  return {
    code: "AI_USAGE_UI_ERROR",
    description: "AI 用量请求未完成；未知错误详情不会直接显示。",
  };
}

function errorTitle(code: string): string {
  switch (code) {
    case "AI_BUDGET_HARD_CAP":
      return "预算不能低于已使用金额";
    case "AI_BUDGET_CURRENCY_LOCKED":
      return "本月已有用量，暂不能切换币种";
    case "AI_CONCURRENCY_HARD_CAP":
      return "并发硬上限已触发";
    case "REVISION_CONFLICT":
      return "预算已被其他成员更新";
    case "ACCESS_FORBIDDEN":
      return "当前角色无权修改预算";
    default:
      return "预算更新失败";
  }
}
