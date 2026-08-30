import { useCallback, useEffect, useMemo, useState } from "react";
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
  PageStateBoundary,
  Select,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type BadgeTone,
  type SelectOption,
} from "@inkshadow/ui";

import {
  TASK_LABELS,
  type UsageAggregate,
  type UsageBreakdownDimension,
  type UsageBreakdownEntry,
  type UsageBudgetPolicy,
  type UsageCenterEvent,
  type UsageCenterQuery,
  type UsageCenterReader,
  type UsageCenterSnapshot,
  type UsageCostTotal,
  type UsageDataDestination,
  type UsageEventStatus,
  type UsagePrivacyPolicy,
} from "../infrastructure/usage-center-service";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";

type UsagePeriod = "today" | "7d" | "30d" | "all";

export interface UsageCenterPageProps {
  readonly reader: UsageCenterReader;
  readonly now?: () => Date;
}

interface UsageFilters {
  readonly period: UsagePeriod;
  readonly projectId: string;
  readonly task: string;
  readonly providerId: string;
  readonly modelId: string;
}

const INITIAL_FILTERS: UsageFilters = Object.freeze({
  period: "today",
  projectId: "",
  task: "",
  providerId: "",
  modelId: "",
});

const PERIOD_OPTIONS: readonly SelectOption[] = Object.freeze([
  { value: "today", label: "今天" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "all", label: "全部时间" },
]);

const BREAKDOWN_OPTIONS: readonly SelectOption[] = Object.freeze([
  { value: "time", label: "按日期" },
  { value: "project", label: "按作品" },
  { value: "task", label: "按任务" },
  { value: "provider", label: "按供应商" },
  { value: "model", label: "按模型" },
]);

const currentDate = () => new Date();

export function UsageCenterPage({ reader, now = currentDate }: UsageCenterPageProps) {
  const [filters, setFilters] = useState<UsageFilters>(INITIAL_FILTERS);
  const [breakdownDimension, setBreakdownDimension] = useState<UsageBreakdownDimension>("time");
  const [snapshot, setSnapshot] = useState<UsageCenterSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadSequence, setReloadSequence] = useState(0);

  const query = useMemo(() => buildQuery(filters, now()), [filters, now]);
  const load = useCallback(
    async (preserveContent: boolean): Promise<void> => {
      if (preserveContent) setRefreshing(true);
      else setLoading(true);
      try {
        const next = await reader.read(query);
        setSnapshot(next);
        setError(null);
      } catch (reason: unknown) {
        setError(reason);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [query, reader],
  );

  useEffect(() => {
    let active = true;
    void reader
      .read(query)
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        setRefreshing(false);
      });
    return () => {
      active = false;
    };
  }, [query, reader, reloadSequence]);

  const retryRead = () => {
    if (snapshot === null) setLoading(true);
    else setRefreshing(true);
    setReloadSequence((current) => current + 1);
  };

  const changeFilters = (next: UsageFilters) => {
    setRefreshing(true);
    setFilters(next);
  };

  const hasDimensionFilters =
    filters.projectId !== "" ||
    filters.task !== "" ||
    filters.providerId !== "" ||
    filters.modelId !== "";
  const initialError = error !== null && snapshot === null;

  return (
    <div className="desktop-page usage-center-page">
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">只读的本地 AI 服务记录</p>
          <h1>模型使用与费用</h1>
          <p>
            查看智能创作做了什么、使用了哪个模型、发送和返回了多少文字量，以及可确认的费用估算。
          </p>
        </div>
        <div className="page-heading__actions">
          <Button
            variant="secondary"
            disabled={loading || refreshing}
            loading={refreshing}
            onClick={() => {
              void load(snapshot !== null);
            }}
          >
            刷新记录
          </Button>
        </div>
      </header>

      <InlineAlert
        title="记录只存本机"
        description={
          <div>
            <p>这里不保存正文、提示词或接口密钥。已知金额是本机估算，不代表最终账单。</p>
            <p>服务商没有提供可计算的单价，实际费用请以服务商账单为准。</p>
          </div>
        }
      />

      <PageStateBoundary
        state={loading && snapshot === null ? "loading" : initialError ? "fatal_error" : "ready"}
        loadingLabel="正在读取本地 AI 服务记录"
        preserveContent={false}
        fallbacks={{
          fatal_error: (
            <ErrorState
              title="暂时无法读取 AI 服务记录"
              description={errorDescription(error)}
              savedState="正文与已有版本不受影响"
              primaryAction={{
                label: "重新读取",
                onClick: retryRead,
              }}
            />
          ),
        }}
      >
        {snapshot !== null && (
          <>
            {error !== null && (
              <InlineAlert
                tone="warning"
                title="刷新失败，仍显示上一次读取结果"
                description={errorDescription(error)}
                action={{
                  label: "重试",
                  onClick: retryRead,
                }}
              />
            )}

            <UsageFilterPanel
              filters={filters}
              snapshot={snapshot}
              disabled={refreshing}
              onChange={changeFilters}
              onReset={() => changeFilters(INITIAL_FILTERS)}
            />

            <UsageSummaryCards summary={snapshot.summary} />

            <UsageAttentionSummary summary={snapshot.summary} />

            {snapshot.budgets.length > 0 && <BudgetPanel budgets={snapshot.budgets} />}

            {snapshot.totalMatchingRecords === 0 ? (
              <EmptyState
                kind={hasDimensionFilters ? "no_results" : "no_data"}
                title={hasDimensionFilters ? "没有符合筛选条件的记录" : "还没有模型使用记录"}
                description={
                  hasDimensionFilters
                    ? "换一个作品、任务、供应商或模型，或者清除筛选。"
                    : "完成一次真实智能创作任务后，这里会显示供应商、模型、文字量、费用和隐私去向。"
                }
                {...(hasDimensionFilters
                  ? {
                      primaryAction: {
                        label: "清除筛选",
                        onClick: () => changeFilters(INITIAL_FILTERS),
                      },
                    }
                  : {})}
              />
            ) : (
              <>
                <BreakdownPanel
                  dimension={breakdownDimension}
                  entries={snapshot.breakdowns[breakdownDimension]}
                  onDimensionChange={setBreakdownDimension}
                />
                <UsageDetailsTable snapshot={snapshot} />
              </>
            )}
          </>
        )}
      </PageStateBoundary>
    </div>
  );
}

function UsageFilterPanel({
  disabled,
  filters,
  onChange,
  onReset,
  snapshot,
}: {
  readonly disabled: boolean;
  readonly filters: UsageFilters;
  readonly onChange: (next: UsageFilters) => void;
  readonly onReset: () => void;
  readonly snapshot: UsageCenterSnapshot;
}) {
  return (
    <Card className="settings-card--wide">
      <CardHeader>
        <CardTitle>筛选记录</CardTitle>
        <CardDescription>筛选会同时更新汇总、分组和明细，不会修改任何本地记录。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="settings-grid">
          <FormField label="时间范围">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                aria-label="时间范围"
                value={filters.period}
                disabled={disabled}
                options={PERIOD_OPTIONS}
                onChange={(event) =>
                  onChange({ ...filters, period: event.currentTarget.value as UsagePeriod })
                }
              />
            )}
          </FormField>
          <FormField label="作品">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                aria-label="作品"
                value={filters.projectId}
                disabled={disabled}
                placeholder="全部作品（含未关联记录）"
                options={snapshot.facets.projects}
                onChange={(event) => onChange({ ...filters, projectId: event.currentTarget.value })}
              />
            )}
          </FormField>
          <FormField label="任务">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                aria-label="任务"
                value={filters.task}
                disabled={disabled}
                placeholder="全部任务"
                options={snapshot.facets.tasks}
                onChange={(event) => onChange({ ...filters, task: event.currentTarget.value })}
              />
            )}
          </FormField>
          <FormField label="供应商">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                aria-label="供应商"
                value={filters.providerId}
                disabled={disabled}
                placeholder="全部供应商"
                options={snapshot.facets.providers}
                onChange={(event) =>
                  onChange({ ...filters, providerId: event.currentTarget.value })
                }
              />
            )}
          </FormField>
          <FormField label="模型">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                aria-label="模型"
                value={filters.modelId}
                disabled={disabled}
                placeholder="全部模型"
                options={snapshot.facets.models}
                onChange={(event) => onChange({ ...filters, modelId: event.currentTarget.value })}
              />
            )}
          </FormField>
          <div className="settings-actions">
            <Button variant="ghost" disabled={disabled} onClick={onReset}>
              清除筛选
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageSummaryCards({ summary }: { readonly summary: UsageAggregate }) {
  return (
    <section aria-label="使用汇总" className="settings-grid">
      <SummaryCard
        title={formatCostTotals(summary.costTotals, summary.invocationCount)}
        description={
          summary.costUnknownCount > 0
            ? summary.costUnknownCount === summary.invocationCount &&
              summary.costTotals.length === 0
              ? `服务商未提供这 ${String(summary.costUnknownCount)} 次调用的费用信息，请以服务商账单为准`
              : `其中 ${String(summary.costUnknownCount)} 次费用暂无法估算；其余已知金额均为估算`
            : "已知金额均为估算，不是供应商账单"
        }
      />
      <SummaryCard
        title={`${formatInteger(summary.invocationCount)} 次`}
        description={`${formatInteger(summary.successCount)} 次完整结果 · ${formatInteger(summary.partialCount)} 次部分结果 · ${formatInteger(summary.failureCount)} 次失败或待核对 · ${formatInteger(summary.activeCount)} 次进行中`}
      />
      <SummaryCard
        title={`${formatInteger(summary.inputTokens + summary.outputTokens)} 个文字量单位`}
        description={
          summary.tokenUsageUnknownCount > 0
            ? `发送给 AI 的文字量 ${formatInteger(summary.inputTokens)} · AI 返回的文字量 ${formatInteger(summary.outputTokens)} · ${String(summary.tokenUsageUnknownCount)} 次未记录 · 这不是金额`
            : `发送给 AI 的文字量 ${formatInteger(summary.inputTokens)} · AI 返回的文字量 ${formatInteger(summary.outputTokens)} · 这不是金额`
        }
      />
      <SummaryCard
        title={`${formatInteger(summary.localCount)} 次本地运算`}
        description={`${formatInteger(summary.remoteCount)} 次发送到所选服务商 · ${formatInteger(summary.destinationUnknownCount)} 次旧记录未注明去向`}
      />
    </section>
  );
}

function UsageAttentionSummary({ summary }: { readonly summary: UsageAggregate }) {
  if (summary.partialCount === 0 && summary.failureCount === 0 && summary.activeCount === 0) {
    return null;
  }
  const facts = [
    summary.partialCount > 0 ? `${formatInteger(summary.partialCount)} 次已保留部分结果` : null,
    summary.failureCount > 0 ? `${formatInteger(summary.failureCount)} 次失败或结果不明确` : null,
    summary.activeCount > 0 ? `${formatInteger(summary.activeCount)} 次尚未终结` : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <InlineAlert
      tone={summary.failureCount > 0 ? "error" : "warning"}
      title={`AI 服务记录有 ${facts.join("、")}`}
      description="请在下方明细按作品、章节和任务核对。请求状态不确定时不会自动重发。"
    />
  );
}

function SummaryCard({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function BudgetPanel({ budgets }: { readonly budgets: readonly UsageBudgetPolicy[] }) {
  return (
    <Card className="settings-card--wide">
      <CardHeader>
        <CardTitle>当前预算规则</CardTitle>
        <CardDescription>
          这里只显示已保存的预算上限。预算占用使用发送前估算，不能替代服务商账单对账。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label="当前预算规则">
          <TableHeader>
            <TableRow>
              <TableHead>范围</TableHead>
              <TableHead>上限</TableHead>
              <TableHead>处理方式</TableHead>
              <TableHead>更新时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {budgets.map((budget) => (
              <TableRow key={budget.scopeKey}>
                <TableCell>
                  {budget.scope === "month"
                    ? `${budget.monthKey ?? "当前月份"} 总预算`
                    : `${budget.projectName ?? "所选作品"} 预算`}
                </TableCell>
                <TableCell>{formatMoney(budget.currency, budget.limitMicros)}</TableCell>
                <TableCell>
                  <Badge tone={budget.enforcement === "hard" ? "danger" : "warning"}>
                    {budget.enforcement === "hard" ? "达到上限后停止发送" : "达到上限时提醒"}
                  </Badge>
                </TableCell>
                <TableCell>{formatDateTime(budget.updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function BreakdownPanel({
  dimension,
  entries,
  onDimensionChange,
}: {
  readonly dimension: UsageBreakdownDimension;
  readonly entries: readonly UsageBreakdownEntry[];
  readonly onDimensionChange: (dimension: UsageBreakdownDimension) => void;
}) {
  return (
    <Card className="settings-card--wide">
      <CardHeader>
        <CardTitle>分类汇总</CardTitle>
        <CardDescription>费用按币种分别汇总；未知金额不会被当作 0。</CardDescription>
      </CardHeader>
      <CardContent>
        <FormField label="汇总方式">
          {(fieldProps) => (
            <Select
              {...fieldProps}
              aria-label="汇总方式"
              value={dimension}
              options={BREAKDOWN_OPTIONS}
              onChange={(event) =>
                onDimensionChange(event.currentTarget.value as UsageBreakdownDimension)
              }
            />
          )}
        </FormField>
        <Table aria-label="分类使用汇总">
          <TableHeader>
            <TableRow>
              <TableHead>{breakdownHeading(dimension)}</TableHead>
              <TableHead>次数</TableHead>
              <TableHead>文字量（不是金额）</TableHead>
              <TableHead>费用估算</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>本地</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.key}>
                <TableCell>{entry.label}</TableCell>
                <TableCell>{formatInteger(entry.invocationCount)}</TableCell>
                <TableCell>{formatInteger(entry.inputTokens + entry.outputTokens)}</TableCell>
                <TableCell>
                  {formatCostTotals(entry.costTotals, entry.invocationCount)}
                  {entry.costUnknownCount > 0 ? ` · ${String(entry.costUnknownCount)} 次未知` : ""}
                </TableCell>
                <TableCell>
                  {formatInteger(entry.successCount)} 次完整结果 ·{" "}
                  {formatInteger(entry.partialCount)} 次部分结果 ·{" "}
                  {formatInteger(entry.failureCount)} 次失败或待核对 ·{" "}
                  {formatInteger(entry.activeCount)} 次进行中
                </TableCell>
                <TableCell>{formatInteger(entry.localCount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function UsageDetailsTable({ snapshot }: { readonly snapshot: UsageCenterSnapshot }) {
  return (
    <Card className="settings-card--wide">
      <CardHeader>
        <CardTitle>使用明细</CardTitle>
        <CardDescription>按实际记录时间倒序排列；旧续写与模型中心记录已去重。</CardDescription>
      </CardHeader>
      <CardContent>
        {snapshot.detailsTruncated && (
          <InlineAlert
            tone="warning"
            title={`共 ${formatInteger(snapshot.totalMatchingRecords)} 条，当前显示最近 ${formatInteger(snapshot.records.length)} 条`}
            description="上方汇总仍覆盖全部匹配记录。缩短时间范围可以查看更精确的明细列表。"
          />
        )}
        <Table aria-label="使用明细">
          <TableCaption>不包含正文、提示词、模型输出或凭据。</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>作品 / 章节 / 任务</TableHead>
              <TableHead>供应商 / 模型</TableHead>
              <TableHead>文字量（不是金额）</TableHead>
              <TableHead>费用估算</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>隐私去向</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot.records.map((record) => (
              <TableRow key={record.id}>
                <TableCell>{formatDateTime(record.occurredAt)}</TableCell>
                <TableCell>
                  <strong>{record.projectName ?? "未关联作品"}</strong>
                  <br />
                  <span>
                    {record.chapterName ??
                      (record.projectId === null ? "未关联章节" : "作品级生成")}
                  </span>
                  <br />
                  {taskLabel(record.task)}
                </TableCell>
                <TableCell>
                  {record.providerLabel}
                  <br />
                  {record.modelId}
                </TableCell>
                <TableCell>{formatRecordTokens(record)}</TableCell>
                <TableCell>{formatRecordCost(record)}</TableCell>
                <TableCell>
                  <UsageRecordResult record={record} />
                </TableCell>
                <TableCell>
                  <Badge tone={destinationTone(record.dataDestination)}>
                    {destinationLabel(record.dataDestination)}
                  </Badge>
                  <br />
                  {privacyLabel(record.privacyPolicy)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function UsageRecordResult({ record }: { readonly record: UsageCenterEvent }) {
  const facts = [
    record.visibleContentLength === null
      ? null
      : `${formatInteger(record.visibleContentLength)} 个可见字符`,
    record.sendCount === null ? null : `发送 ${formatInteger(record.sendCount)} 次`,
    record.automaticRetryCount === null
      ? null
      : `自动重试 ${formatInteger(record.automaticRetryCount)} 次`,
  ].filter((fact): fact is string => fact !== null);
  return (
    <>
      <Badge tone={statusTone(record.status)}>{statusLabel(record.status)}</Badge>
      {facts.length > 0 && (
        <>
          <br />
          <span>{facts.join(" · ")}</span>
        </>
      )}
      {record.errorCode !== null && (
        <>
          <br />
          <span>
            {record.status === "partial"
              ? "返回没有完整结束，已收到的文字仍安全保留；正文没有改变。"
              : usageRecordErrorDescription(record.errorCode)}
          </span>
        </>
      )}
    </>
  );
}

function buildQuery(filters: UsageFilters, current: Date): UsageCenterQuery {
  const range = periodRange(filters.period, current);
  return Object.freeze({
    fromInclusive: range.fromInclusive,
    toExclusive: range.toExclusive,
    projectId: filters.projectId === "" ? null : filters.projectId,
    task: filters.task === "" ? null : filters.task,
    providerId: filters.providerId === "" ? null : filters.providerId,
    modelId: filters.modelId === "" ? null : filters.modelId,
    monthKey: `${String(current.getFullYear()).padStart(4, "0")}-${String(current.getMonth() + 1).padStart(2, "0")}`,
    timezoneOffsetMinutes: current.getTimezoneOffset(),
  });
}

function periodRange(
  period: UsagePeriod,
  current: Date,
): Pick<UsageCenterQuery, "fromInclusive" | "toExclusive"> {
  if (period === "all") {
    return { fromInclusive: null, toExclusive: null };
  }
  const start = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  const days = period === "today" ? 1 : period === "7d" ? 7 : 30;
  start.setDate(start.getDate() - (days - 1));
  const end = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
  return { fromInclusive: start.toISOString(), toExclusive: end.toISOString() };
}

function formatCostTotals(totals: readonly UsageCostTotal[], invocationCount: number): string {
  if (totals.length === 0) {
    return invocationCount === 0 ? "—" : "暂时无法估算";
  }
  return totals.map((total) => formatMoney(total.currency, total.micros)).join(" + ");
}

function formatMoney(currency: string, microsValue: string): string {
  const micros = BigInt(microsValue);
  const roundedMinor = (micros + 5_000n) / 10_000n;
  const whole = roundedMinor / 100n;
  const fraction = (roundedMinor % 100n).toString().padStart(2, "0");
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${whole.toString()}.${fraction}`;
}

function formatRecordCost(record: UsageCenterEvent): string {
  if (record.costMicros === null || record.currency === null) {
    return "服务商未提供费用信息";
  }
  const formatted = formatMoney(record.currency, record.costMicros);
  return record.costMicros === "0" ? `${formatted}（费用记录为 0）` : formatted;
}

function formatRecordTokens(record: UsageCenterEvent): string {
  if (record.inputTokens === null || record.outputTokens === null) {
    return "文字量未记录（不是金额）";
  }
  const cached =
    record.cachedInputTokens !== null && record.cachedInputTokens > 0
      ? ` · 缓存文字量 ${formatInteger(record.cachedInputTokens)}`
      : "";
  return `发送给 AI 的文字量 ${formatInteger(record.inputTokens)} · AI 返回的文字量 ${formatInteger(record.outputTokens)}${cached}`;
}

function formatDateTime(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function taskLabel(task: string): string {
  return TASK_LABELS[task] ?? "其他模型任务";
}

function statusLabel(status: UsageEventStatus): string {
  return {
    queued: "等待发送",
    running: "服务处理中",
    succeeded: "已得到完整结果",
    partial: "已保留部分结果",
    failed: "未得到结果",
    cancelled: "已取消",
    pre_dispatch_cancelled: "发送前安全终止",
    ambiguous: "请求可能已经发出，暂时无法确认结果",
    not_dispatched: "发送前失败",
  }[status];
}

function statusTone(status: UsageEventStatus): BadgeTone {
  return {
    queued: "neutral",
    running: "accent",
    succeeded: "success",
    partial: "warning",
    failed: "danger",
    cancelled: "neutral",
    pre_dispatch_cancelled: "neutral",
    ambiguous: "warning",
    not_dispatched: "danger",
  }[status] as BadgeTone;
}

function destinationLabel(destination: UsageDataDestination): string {
  return {
    local: "本地运算",
    remote: "发送到所选服务商",
    not_recorded: "去向未记录",
  }[destination];
}

function destinationTone(destination: UsageDataDestination): BadgeTone {
  return destination === "local" ? "success" : destination === "remote" ? "info" : "warning";
}

function privacyLabel(policy: UsagePrivacyPolicy): string {
  return {
    cloud_allowed: "允许云端任务",
    local_preferred: "优先本地",
    local_only: "仅限本地",
    not_recorded: "这条旧记录未保存隐私设置",
  }[policy];
}

function breakdownHeading(dimension: UsageBreakdownDimension): string {
  return {
    time: "日期",
    project: "作品",
    task: "任务",
    provider: "供应商",
    model: "模型",
  }[dimension];
}

function errorDescription(error: unknown): string {
  return projectOrdinaryUiError(error).description;
}

function usageRecordErrorDescription(errorCode: string): string {
  return projectOrdinaryUiError({ code: errorCode }).description;
}
