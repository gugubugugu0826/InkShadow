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
  ChapterSummaryGenerationReceipt,
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

export type ChapterSummaryPanelService = Pick<
  ChapterSummaryService,
  | "inspectProject"
  | "setAutomaticOnManualSaveEnabled"
  | "summarizeSavedVersion"
  | "clearChapterSummary"
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
  const [continuousAutomaticEnabled, setContinuousAutomaticEnabled] = useState(false);
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
      setDashboard(summaryState);
      setContinuousDashboard(continuousStateDashboard);
      setContinuousAutomaticEnabled(continuousState.isAutomaticOnManualSaveEnabled(projectId));
    } catch (cause: unknown) {
      setNotice({
        tone: "error",
        title: "无法读取章节摘要状态",
        description: cause instanceof Error ? cause.message : "请稍后重试。",
      });
    } finally {
      setLoading(false);
    }
  }, [continuousState, projectId, service]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  function toggleAutomatic(): void {
    if (dashboard === null || readOnly) {
      return;
    }
    const enabled = !dashboard.automaticOnManualSaveEnabled;
    service.setAutomaticOnManualSaveEnabled(projectId, enabled);
    setDashboard({ ...dashboard, automaticOnManualSaveEnabled: enabled });
    setBackfillPlan(null);
    setNotice({
      tone: "info",
      title: enabled ? "已启用手动保存后更新" : "已暂停自动更新",
      description: enabled
        ? "以后每次手动保存新版本时最多调用一次长程记忆压缩；自动保存仍不会调用模型，供应商可能收取费用。"
        : "手动保存和自动保存都不会自动调用摘要模型；你仍可按章节显式重建。",
    });
  }

  function toggleContinuousAutomatic(): void {
    if (readOnly) {
      return;
    }
    const enabled = !continuousAutomaticEnabled;
    continuousState.setAutomaticOnManualSaveEnabled(projectId, enabled);
    setContinuousAutomaticEnabled(enabled);
    setBackfillPlan(null);
    setNotice({
      tone: "info",
      title: enabled ? "已启用手动保存后识别故事变化" : "已暂停自动识别故事变化",
      description: enabled
        ? "以后每次手动保存新版本，完整已保存章节可能分别发送给“人物提取”和“世界设定提取”两个当前路由，最多两次模型调用并可能产生两次费用；自动保存仍不会发送。"
        : "手动保存与自动保存都不会自动发送章节；你仍可显式使用“重新识别最近一章”。",
    });
  }

  async function rebuild(chapterId: string, versionId: string): Promise<void> {
    setBusyChapterId(chapterId);
    try {
      const receipt = await service.summarizeSavedVersion({
        projectId,
        chapterId,
        versionId,
        trigger: "user_rebuild",
      });
      setNotice(receiptNotice(receipt));
      await load();
    } catch (cause: unknown) {
      setNotice({
        tone: "error",
        title: "章节摘要重建失败",
        description:
          cause instanceof Error
            ? cause.message
            : "正文与已有摘要均未被修改，请检查模型连接后重试。",
      });
    } finally {
      setBusyChapterId(null);
    }
  }

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
        description: cause instanceof Error ? cause.message : "请稍后重试。",
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
          "本次只核验章节与现有后台任务，没有发送正文、调用模型或登记新任务。请确认数量与可能费用后再继续。",
      });
    } catch (cause: unknown) {
      setNotice({
        tone: "error",
        title: "无法生成回填计划",
        description: cause instanceof Error ? cause.message : "正文没有变化，请稍后刷新后重试。",
      });
    } finally {
      setBackfillBusy(false);
    }
  }

  async function confirmHistoricalBackfill(): Promise<void> {
    if (backfillPlan === null || backfillPlan.willRegisterTaskCount === 0 || readOnly) {
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
        description: `新增 ${receipt.createdTaskCount.toLocaleString("zh-CN")} 个任务，已有 ${receipt.alreadyRegisteredTaskCount.toLocaleString("zh-CN")} 个任务无需重复登记。后台会分批恢复，登记不会阻塞或修改正文。${refreshNote}`,
      });
    } catch (cause: unknown) {
      setNotice({
        tone: "error",
        title: "现有章节任务未能登记",
        description:
          cause instanceof Error ? cause.message : "正文没有变化；请重新生成只读计划后再试。",
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
            默认关闭。启用后，墨影会在手动保存新版本后识别人设、人物状态、世界设定和剧情变化；自动保存永不发送正文。
          </p>
        </div>
        <Button
          size="sm"
          variant={continuousAutomaticEnabled ? "secondary" : "primary"}
          disabled={loading || readOnly}
          onClick={toggleContinuousAutomatic}
        >
          {continuousAutomaticEnabled ? "暂停自动识别" : "启用手动保存后识别"}
        </Button>
      </div>
      <InlineAlert
        tone="warning"
        title="启用前请确认正文发送范围与费用"
        description="一次手动保存可能把完整已保存章节分别发送给“人物提取”和“世界设定提取”两个当前 Model Hub 路由，最多产生两次模型调用及对应供应商费用。结果只会成为可追溯的待确认或可撤销变化，不会覆盖正文或自动成为重大正式设定。"
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
          <Button
            size="sm"
            variant={dashboard?.automaticOnManualSaveEnabled === true ? "secondary" : "primary"}
            disabled={loading || dashboard === null || readOnly}
            onClick={toggleAutomatic}
          >
            {dashboard?.automaticOnManualSaveEnabled === true
              ? "暂停自动更新"
              : "启用手动保存后更新"}
          </Button>
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>
            刷新状态
          </Button>
        </div>
      </div>

      <InlineAlert
        tone="warning"
        title="默认关闭，自动保存永不调用模型"
        description="启用后，只有你手动保存出一个新版本才会最多调用一次“长程记忆压缩”，可能产生供应商费用。按章节点击“重建摘要”也会明确调用一次模型。"
      />

      <details className="chapter-backfill" data-testid="historical-backfill-advanced">
        <summary>高级：补齐现有章节的摘要与设定资料</summary>
        <div className="chapter-backfill__content">
          <p>
            只检查当前作品中启用、非空且能与不可变保存版本完全核验的章节。计划和每次登记前都按当前稳定版本核验，不追溯所有历史版本；如果核验后恰好又保存了新版本，后台执行会再次拦截旧任务，正文不会改变。
          </p>
          <p className="candidate-panel__hint">
            第一步只生成只读计划，不发送正文。你可以先关闭上方“手动保存后识别”和“手动保存后更新”开关，再重新生成计划以关闭对应模型阶段。
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={backfillBusy || readOnly}
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
                title="可能发送给远程供应商的调用上限"
                description={`仅统计允许远程处理的标准章节：章节摘要 ${backfillPlan.possibleRemoteProviderCallUpperBound.chapterSummary.toLocaleString("zh-CN")} 次，人物与世界设定识别 ${backfillPlan.possibleRemoteProviderCallUpperBound.storyState.toLocaleString("zh-CN")} 次，合计最多 ${backfillPlan.possibleRemoteProviderCallUpperBound.total.toLocaleString("zh-CN")} 次。摘要阶段${backfillPlan.modelStages.chapterSummaryEnabled ? "已开启" : "已关闭"}，设定识别阶段${backfillPlan.modelStages.storyStateEnabled ? "已开启" : "已关闭"}。仅本机章节不计入远程上限；它们只能由已验证的本地模型处理，本地调用次数取决于实际路由。远程供应商可能按实际调用收费。`}
              />
              <p className="candidate-panel__hint">
                空章节排除 {backfillPlan.excludedEmptyChapterCount.toLocaleString("zh-CN")}{" "}
                章；版本无法稳定核验排除{" "}
                {backfillPlan.excludedUnstableChapterCount.toLocaleString("zh-CN")}{" "}
                章。符合条件的章节中有 {backfillPlan.localOnlyChapterCount.toLocaleString("zh-CN")}{" "}
                个本地私密章节，本次待登记{" "}
                {backfillPlan.willRegisterLocalOnlyChapterCount.toLocaleString("zh-CN")}{" "}
                个；远程路由会在发送正文前失败关闭，配置并验证可用的本地模型后仍可继续处理，因此计入远程供应商调用上限的次数为
                0。
              </p>
              <p className="candidate-panel__hint">
                确认后只登记可恢复任务，不会立即把整本书发给模型。现有后台处理器会分批执行，基础本地派生阶段仍可运行，正文编辑不被阻塞。
              </p>
              <Button
                size="sm"
                disabled={readOnly || backfillBusy || backfillPlan.willRegisterTaskCount === 0}
                loading={backfillBusy}
                onClick={() => void confirmHistoricalBackfill()}
              >
                {backfillPlan.willRegisterTaskCount === 0
                  ? "当前无需登记"
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
                    模型：{entry.providerKind}/{entry.modelId} · 调用记录：{entry.invocationId}
                  </p>
                )}
              </CardContent>
              <CardFooter>
                <Button
                  size="sm"
                  disabled={readOnly || busyChapterId !== null}
                  loading={busyChapterId === entry.chapterId}
                  onClick={() => void rebuild(entry.chapterId, entry.currentVersionId)}
                >
                  重建摘要（调用一次模型）
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

function receiptNotice(receipt: ChapterSummaryGenerationReceipt) {
  switch (receipt.status) {
    case "generated":
      return { tone: "info" as const, title: "章节摘要已重建", description: receipt.message };
    case "already_current":
      return { tone: "info" as const, title: "摘要已是最新", description: receipt.message };
    case "skipped":
      return {
        tone: "warning" as const,
        title: "本次未调用或未生成摘要",
        description: `${receipt.message}（${receipt.code}）`,
      };
    case "failed":
      return {
        tone: "error" as const,
        title: "章节摘要重建失败",
        description: `${receipt.message}（${receipt.code}）`,
      };
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
        `${continuousTaskLabel(record.task)}：${record.providerKind}/${record.modelId}`,
      );
    }
  }
  return [...assignments].sort();
}

function continuousTaskLabel(task: string): string {
  return task === "character_extraction"
    ? "人物提取"
    : task === "world_extraction"
      ? "世界设定提取"
      : task;
}
