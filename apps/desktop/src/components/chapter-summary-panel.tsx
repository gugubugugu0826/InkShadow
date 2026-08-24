import { useCallback, useEffect, useState } from "react";
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
} from "@inkshadow/ui";

import type {
  ChapterSummaryDashboard,
  ChapterSummaryService,
} from "../infrastructure/chapter-summary-service";
import type {
  ContinuousStoryStateDashboard,
  ContinuousStoryStateExtractionService,
} from "../infrastructure/continuous-story-state-extraction";
import type {
  HistoricalChapterBackfillPlan,
  HistoricalChapterBackfillService,
} from "../infrastructure/historical-chapter-backfill-service";
import {
  getModelProviderPreset,
  isModelProviderKind,
} from "../infrastructure/model-hub-provider-registry";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";

export type ChapterSummaryPanelService = Pick<
  ChapterSummaryService,
  "inspectProject" | "setAutomaticOnManualSaveEnabled" | "clearChapterSummary"
>;

export type HistoricalChapterBackfillPanelService = Pick<
  HistoricalChapterBackfillService,
  "plan" | "register"
>;

export interface ChapterSummaryPanelProps {
  readonly projectId: string;
  readonly service: ChapterSummaryPanelService;
  readonly continuousState: Pick<
    ContinuousStoryStateExtractionService,
    "inspectProject" | "isAutomaticOnManualSaveEnabled" | "setAutomaticOnManualSaveEnabled"
  >;
  readonly historicalBackfill: HistoricalChapterBackfillPanelService;
  readonly readOnly?: boolean;
}

export function ChapterSummaryPanel({
  projectId,
  service,
  continuousState,
  historicalBackfill,
  readOnly = false,
}: ChapterSummaryPanelProps) {
  const [dashboard, setDashboard] = useState<ChapterSummaryDashboard | null>(null);
  const [continuousDashboard, setContinuousDashboard] =
    useState<ContinuousStoryStateDashboard | null>(null);
  const [busyChapterId, setBusyChapterId] = useState<string | null>(null);
  const [storedBackfillPlan, setBackfillPlan] = useState<HistoricalChapterBackfillPlan | null>(
    null,
  );
  const [backfillBusy, setBackfillBusy] = useState(false);
  const backfillPlan = storedBackfillPlan?.projectId === projectId ? storedBackfillPlan : null;
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Readonly<{
    tone: "info" | "warning" | "error";
    title: string;
    description: string;
  }> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryState, continuousStateDashboard] = await Promise.all([
        service.inspectProject(projectId),
        continuousState.inspectProject(projectId),
      ]);
      // Earlier releases stored project-level switches that could cause a later
      // manual save or recovery worker to send正文.  They are retired on read;
      // accepted-version work is now local-only for every source.
      if (summaryState.automaticOnManualSaveEnabled) {
        service.setAutomaticOnManualSaveEnabled(projectId, false);
      }
      if (continuousState.isAutomaticOnManualSaveEnabled(projectId)) {
        continuousState.setAutomaticOnManualSaveEnabled(projectId, false);
      }
      setDashboard({ ...summaryState, automaticOnManualSaveEnabled: false });
      setContinuousDashboard(continuousStateDashboard);
    } catch (cause: unknown) {
      setNotice({
        tone: "error",
        title: "无法读取章节摘要状态",
        description: projectOrdinaryUiError(cause).description,
      });
    } finally {
      setLoading(false);
    }
  }, [continuousState, projectId, service]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function clear(chapterId: string): Promise<void> {
    setBusyChapterId(chapterId);
    try {
      const ids = await service.clearChapterSummary({ projectId, chapterId });
      setNotice({
        tone: "info",
        title: "章节摘要已撤销",
        description:
          ids.length > 0
            ? "系统生成的临时摘要已停用；正文、正式设定和历史版本均未修改。"
            : "当前没有可撤销的系统章节摘要。",
      });
      await load();
    } catch (cause: unknown) {
      setNotice({
        tone: "error",
        title: "无法撤销章节摘要",
        description: projectOrdinaryUiError(cause).description,
      });
    } finally {
      setBusyChapterId(null);
    }
  }

  async function previewHistoricalBackfill(): Promise<void> {
    setBackfillBusy(true);
    setBackfillPlan(null);
    try {
      const plan = await historicalBackfill.plan(projectId);
      setBackfillPlan(plan);
      setNotice({
        tone: "info",
        title: "只读计划已生成",
        description:
          "本次只核验章节与现有后台任务，没有发送正文、调用模型或登记新任务。确认后也只会登记本地搜索与故事关联重建。",
      });
    } catch (cause: unknown) {
      setNotice({
        tone: "error",
        title: "无法生成回填计划",
        description: projectOrdinaryUiError(cause).description,
      });
    } finally {
      setBackfillBusy(false);
    }
  }

  async function confirmHistoricalBackfill(): Promise<void> {
    if (
      backfillPlan === null ||
      backfillPlan.willRegisterTaskCount === 0 ||
      backfillPlan.possibleRemoteProviderCallUpperBound.total > 0 ||
      readOnly
    ) {
      return;
    }
    setBackfillBusy(true);
    try {
      const receipt = await historicalBackfill.register({
        projectId,
        expectedPlanFingerprint: backfillPlan.fingerprint,
        humanConfirmed: true,
      });
      let refreshNote = "";
      try {
        const refreshedPlan = await historicalBackfill.plan(projectId);
        setBackfillPlan(refreshedPlan);
      } catch {
        setBackfillPlan(null);
        refreshNote = " 当前计划刷新失败，请重新生成只读计划查看剩余任务。";
      }
      if (receipt.status !== "completed") {
        setNotice({
          tone: "warning",
          title:
            receipt.registeredTaskCount > 0 ? "部分现有章节任务已登记" : "计划已经变化，未继续登记",
          description: `已成功登记 ${receipt.registeredTaskCount.toLocaleString("zh-CN")} 个任务（新增 ${receipt.createdTaskCount.toLocaleString("zh-CN")} 个、并发登记 ${receipt.alreadyRegisteredTaskCount.toLocaleString("zh-CN")} 个）；仍有 ${receipt.remainingTaskCount.toLocaleString("zh-CN")} 个任务未登记。正文没有变化，请按刷新后的计划重试。${refreshNote}`,
        });
        return;
      }
      setNotice({
        tone: "info",
        title: "现有章节任务已登记",
        description: `新增 ${receipt.createdTaskCount.toLocaleString("zh-CN")} 个本地任务，已有 ${receipt.alreadyRegisteredTaskCount.toLocaleString("zh-CN")} 个任务无需重复登记。后台只会分批重建本地搜索与故事关联，不会向模型服务发送内容，也不会阻塞或修改正文。${refreshNote}`,
      });
    } catch (cause: unknown) {
      setNotice({
        tone: "error",
        title: "现有章节任务未能登记",
        description: projectOrdinaryUiError(cause).description,
      });
    } finally {
      setBackfillBusy(false);
    }
  }

  return (
    <section aria-labelledby="chapter-summary-title" className="chapter-summary-panel">
      <div className="section-heading">
        <div>
          <h2 id="continuous-story-state-title">手动保存后的故事变化识别</h2>
          <p>
            已停用自动云处理。接受建议、手动保存、恢复版本和启动恢复都只更新本地正文、版本与本地派生状态。
          </p>
        </div>
        <Badge tone="neutral">自动云处理已停用</Badge>
      </div>
      <InlineAlert
        tone="info"
        title="保存与恢复不会向模型服务发送内容"
        description="配置模型不代表同意发送正文。故事变化识别只会在独立授权流程能够持久记录发送范围、精确模型服务与模型、费用、发送次数上限、取消和结果待核对状态后重新开放。"
      />
      {continuousProviderAssignments(continuousDashboard).length > 0 && (
        <p className="candidate-panel__hint">
          最近使用：{continuousProviderAssignments(continuousDashboard).join("；")}
        </p>
      )}

      <div className="section-heading">
        <div>
          <h2 id="chapter-summary-title">章节摘要与长程记忆</h2>
          <p>
            摘要只从不可变的保存版本生成，是可重建、可撤销的临时参考，不会成为正式设定，也不会修改正文。
          </p>
        </div>
        <div className="story-governance-actions">
          <Badge tone="neutral">自动云处理已停用</Badge>
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>
            刷新状态
          </Button>
        </div>
      </div>

      <InlineAlert
        tone="warning"
        title="逐章云端重建暂不可用"
        description="一次重建会发送完整已保存章节并可能产生一次费用。当前页面还不能在发送前持久展示精确模型服务、精确模型并把不确定结果锁定为不可重发，因此按钮保持停用；正文和已有摘要不受影响。"
      />

      <details className="chapter-backfill" data-testid="historical-backfill-advanced">
        <summary>高级：补齐现有章节的摘要与设定资料</summary>
        <div className="chapter-backfill__content">
          <p>
            只检查当前作品中启用、非空且能与不可变保存版本完全核验的章节。计划和每次登记前都按当前稳定版本核验，不追溯所有历史版本；如果核验后恰好又保存了新版本，后台执行会再次拦截旧任务，正文不会改变。
          </p>
          <p className="candidate-panel__hint">
            第一步只生成只读计划，不发送正文。确认后只登记本地搜索与故事关联重建，不包含章节摘要或设定识别，精确
            不会向模型服务发送内容。
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={loading || backfillBusy || readOnly}
            loading={backfillBusy && backfillPlan === null}
            onClick={() => void previewHistoricalBackfill()}
          >
            生成只读计划
          </Button>

          {backfillPlan !== null && (
            <div className="chapter-backfill__plan" aria-label="现有章节回填只读计划">
              <dl className="story-entity-detail__summary">
                <div>
                  <dt>符合条件</dt>
                  <dd>{backfillPlan.eligibleChapterCount.toLocaleString("zh-CN")} 章</dd>
                </div>
                <div>
                  <dt>已经登记</dt>
                  <dd>{backfillPlan.registeredChapterCount.toLocaleString("zh-CN")} 章</dd>
                </div>
                <div>
                  <dt>本次将新增</dt>
                  <dd>{backfillPlan.willRegisterChapterCount.toLocaleString("zh-CN")} 章</dd>
                </div>
                <div>
                  <dt>待登记后台任务</dt>
                  <dd>{backfillPlan.willRegisterTaskCount.toLocaleString("zh-CN")} 个</dd>
                </div>
                <div>
                  <dt>待处理正文量</dt>
                  <dd>{backfillPlan.willRegisterCharacterCount.toLocaleString("zh-CN")} 字符</dd>
                </div>
              </dl>
              <InlineAlert
                tone={
                  backfillPlan.possibleRemoteProviderCallUpperBound.total > 0 ? "warning" : "info"
                }
                title={
                  backfillPlan.possibleRemoteProviderCallUpperBound.total > 0
                    ? "旧云阶段计划已停用"
                    : "向模型服务发送次数上限：0 次"
                }
                description={
                  backfillPlan.possibleRemoteProviderCallUpperBound.total > 0
                    ? "这份计划包含旧的自动云阶段，不能登记。请刷新页面退役旧开关，再重新生成只包含本地搜索与故事关联的计划。"
                    : "历史章节回填只重建本地搜索与故事关联。不登记章节摘要或设定识别阶段，不发送正文，不产生模型服务费用。"
                }
              />
              <p className="candidate-panel__hint">
                空章节排除 {backfillPlan.excludedEmptyChapterCount.toLocaleString("zh-CN")}{" "}
                章；版本无法稳定核验排除{" "}
                {backfillPlan.excludedUnstableChapterCount.toLocaleString("zh-CN")}{" "}
                章。符合条件的章节中有 {backfillPlan.localOnlyChapterCount.toLocaleString("zh-CN")}{" "}
                个本地私密章节，本次待登记{" "}
                {backfillPlan.willRegisterLocalOnlyChapterCount.toLocaleString("zh-CN")}{" "}
                个；私密章节与普通章节遵守同一纯本地回填边界。
              </p>
              <p className="candidate-panel__hint">
                确认后只登记可恢复的本地任务。现有后台处理器会分批执行，正文编辑不被阻塞。
              </p>
              <Button
                size="sm"
                disabled={
                  readOnly ||
                  backfillBusy ||
                  backfillPlan.willRegisterTaskCount === 0 ||
                  backfillPlan.possibleRemoteProviderCallUpperBound.total > 0
                }
                loading={backfillBusy}
                onClick={() => void confirmHistoricalBackfill()}
              >
                {backfillPlan.willRegisterTaskCount === 0
                  ? "当前无需登记"
                  : backfillPlan.possibleRemoteProviderCallUpperBound.total > 0
                    ? "旧云阶段计划不可登记"
                    : `确认并登记 ${backfillPlan.willRegisterTaskCount.toLocaleString("zh-CN")} 个后台任务`}
              </Button>
            </div>
          )}
        </div>
      </details>

      {notice !== null && (
        <InlineAlert
          tone={notice.tone}
          title={notice.title}
          description={notice.description}
          onDismiss={() => setNotice(null)}
        />
      )}

      {loading && dashboard === null ? (
        <p role="status">正在核验章节摘要…</p>
      ) : dashboard === null || dashboard.entries.length === 0 ? (
        <EmptyState
          title="还没有可生成摘要的章节"
          description="先创建并保存一个章节；之后可在这里显式重建摘要。"
        />
      ) : (
        <div className="story-governance-grid">
          {dashboard.entries.map((entry) => (
            <Card key={entry.chapterId}>
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle>{entry.chapterTitle}</CardTitle>
                    <CardDescription>{entry.message}</CardDescription>
                  </div>
                  <Badge tone={entry.state === "current" ? "success" : "warning"}>
                    {summaryStateLabel(entry.state)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                {entry.summary === null ? (
                  <p className="candidate-panel__hint">尚无摘要内容。</p>
                ) : (
                  <p className="story-governance-copy">{entry.summary}</p>
                )}
                {entry.modelId !== null && (
                  <p className="candidate-panel__hint">
                    模型：{providerDisplayName(entry.providerKind)} · {entry.modelId} ·
                    本次模型结果已记录，可在模型使用与费用中核对
                  </p>
                )}
              </CardContent>
              <CardFooter>
                <Button
                  size="sm"
                  disabled
                  loading={busyChapterId === entry.chapterId}
                  title="独立云派生授权与不确定结果防重机制完成后开放"
                >
                  重建摘要（暂不可用）
                </Button>
                {entry.factId !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readOnly || busyChapterId !== null}
                    onClick={() => void clear(entry.chapterId)}
                  >
                    撤销摘要
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function summaryStateLabel(state: ChapterSummaryDashboard["entries"][number]["state"]): string {
  switch (state) {
    case "current":
      return "当前版本";
    case "stale":
      return "旧版本，已停用";
    case "invalid":
      return "无法核验";
    case "missing":
      return "未生成";
  }
}

function continuousProviderAssignments(
  dashboard: ContinuousStoryStateDashboard | null,
): readonly string[] {
  if (dashboard === null) {
    return [];
  }
  const assignments = new Set<string>();
  for (const { fact } of dashboard.changes) {
    const value = fact.toSnapshot().structuredValue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const extraction = (value as Readonly<Record<string, unknown>>).extraction;
    if (extraction === null || typeof extraction !== "object" || Array.isArray(extraction)) {
      continue;
    }
    const record = extraction as Readonly<Record<string, unknown>>;
    if (
      typeof record.task === "string" &&
      typeof record.providerKind === "string" &&
      typeof record.modelId === "string"
    ) {
      assignments.add(
        `${continuousTaskLabel(record.task)}：${providerDisplayName(record.providerKind)} · ${record.modelId}`,
      );
    }
  }
  return [...assignments].sort();
}

function providerDisplayName(providerKind: unknown): string {
  return isModelProviderKind(providerKind)
    ? getModelProviderPreset(providerKind).displayName
    : "已确认的模型服务";
}

function continuousTaskLabel(task: string): string {
  return task === "character_extraction"
    ? "人物提取"
    : task === "world_extraction"
      ? "世界设定提取"
      : task;
}
