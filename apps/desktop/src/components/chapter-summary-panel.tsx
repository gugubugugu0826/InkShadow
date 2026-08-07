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

export type ChapterSummaryPanelService = Pick<
  ChapterSummaryService,
  | "inspectProject"
  | "setAutomaticOnManualSaveEnabled"
  | "summarizeSavedVersion"
  | "clearChapterSummary"
>;

export interface ChapterSummaryPanelProps {
  readonly projectId: string;
  readonly service: ChapterSummaryPanelService;
  readonly continuousState: Pick<
    ContinuousStoryStateExtractionService,
    "inspectProject" | "isAutomaticOnManualSaveEnabled" | "setAutomaticOnManualSaveEnabled"
  >;
  readonly readOnly?: boolean;
}

export function ChapterSummaryPanel({
  projectId,
  service,
  continuousState,
  readOnly = false,
}: ChapterSummaryPanelProps) {
  const [dashboard, setDashboard] = useState<ChapterSummaryDashboard | null>(null);
  const [continuousDashboard, setContinuousDashboard] =
    useState<ContinuousStoryStateDashboard | null>(null);
  const [continuousAutomaticEnabled, setContinuousAutomaticEnabled] = useState(false);
  const [busyChapterId, setBusyChapterId] = useState<string | null>(null);
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
