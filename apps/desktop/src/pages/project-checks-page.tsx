import { parseUuidV7, type Chapter } from "@inkshadow/domain";
import type {
  NarrativeAnalysisField,
  NarrativeEvidenceReference,
  NarrativeQualityFinding,
} from "@inkshadow/story-core";
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
  Select,
} from "@inkshadow/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  type ChapterNovelValidationResult,
  type ChapterValidationCoverageCategory,
  type ChapterValidationCoverageItem,
  type ChapterValidationResolutionSummary,
  type ChapterSupplementalFindingAction,
  type ChapterSupplementalFindingResolutionSummary,
  type ChapterValidationUiAction,
  type ChapterValidationUiEvidence,
  type ChapterValidationUiIssue,
} from "../infrastructure/novel-validation-runtime";
import type { ChapterValidationSnapshot } from "../infrastructure/chapter-validation-snapshot-store";
import type { ChapterNarrativeAnalysisResult } from "../infrastructure/narrative-analysis-runtime";
import type {
  ChapterCharacterVoicePovIssue,
  ChapterCharacterVoicePovRuntimeResult,
} from "../infrastructure/chapter-character-voice-pov-runtime";
import {
  characterVoicePovSupplementalFinding,
  findSupplementalFindingResolution,
  narrativeQualityFindingId,
  supplementalEvidenceSignature,
  type SupplementalFindingDescriptor,
  type SupplementalFindingEvidenceIdentity,
} from "../infrastructure/chapter-supplemental-finding-verifier";
import { createEvidenceCorrectionCandidate } from "../infrastructure/evidence-correction-candidate";
import { projectOrdinaryUiError, UiActionError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";
import { ConsistencyInvestigationPanel } from "../components/consistency-investigation-panel";

const checkCategories = [
  ["人物与事实", "人物身份、生死、年龄、关系、能力和物品归属是否前后一致。"],
  ["时间与地点", "事件顺序、时间跨度、角色所在地点和行动路线是否能够成立。"],
  ["视角与知情范围", "当前叙述人物是否说出或想到尚未得知的信息。"],
  ["人物说话方式", "称呼、用词、语气和表达习惯是否偏离已有台词。"],
  ["世界规则", "正文是否触碰用户锁定的能力、社会、地理或其他硬性规则。"],
  ["剧情推进", "因果是否断裂、情节是否重复、伏笔是否提前泄露或长期未处理。"],
  ["多线叙事", "各条剧情线是否失衡、停滞、互相冲突或即将自然交汇。"],
  ["节奏与章节目标", "场景是否推动剧情或人物变化，连续章节的节奏是否过于相似。"],
] as const;

const issueLabels: Record<ChapterValidationUiIssue["type"], string> = {
  character_life_status_conflict: "人物生死冲突",
  character_age_conflict: "人物年龄冲突",
  character_identity_conflict: "人物身份冲突",
  relationship_conflict: "人物关系冲突",
  timeline_conflict: "时间线冲突",
  location_conflict: "地点冲突",
  item_ownership_conflict: "物品归属冲突",
  ability_conflict: "人物能力冲突",
  world_setting_conflict: "世界设定冲突",
  world_hard_rule_conflict: "世界硬规则冲突",
  knowledge_boundary_conflict: "人物知情范围冲突",
  pov_boundary_violation: "视角越界",
};

const missingRequirementLabels: Readonly<Record<string, string>> = {
  existing_current_chapter: "需要一个仍然存在的章节。",
  chapter_owned_by_requested_project: "所选章节必须属于当前项目。",
  active_current_chapter: "请先恢复已删除的章节。",
  current_chapter_version: "章节还没有可核验的已保存版本。",
  chapter_and_current_version_with_identical_project_chapter_and_content:
    "当前正文与已保存版本不一致，请先保存或重新打开章节。",
  verified_current_version_sha256: "当前版本的完整性校验未通过，请从版本历史或备份恢复。",
  current_claim_with_explicit_structured_fields_and_current_version_evidence:
    "本章还没有带原文位置的明确事实，系统不会从语气或暗示中猜测。",
  confirmed_reference_fact_or_locked_hard_rule_with_exact_evidence:
    "项目还没有可与本章比较的已确认设定或锁定规则。",
  comparable_current_claim_and_confirmed_source:
    "本章明确事实与已确认设定之间还没有可比较的同一对象、属性和生效区间。",
};

const coverageCategoryLabels: Readonly<Record<ChapterValidationCoverageCategory, string>> = {
  character_life_status: "人物生死",
  character_age: "人物年龄",
  character_identity: "人物身份",
  relationship: "人物关系",
  event_time: "事件时间",
  entity_location: "人物与物品地点",
  item_ownership: "物品归属",
  ability_state: "人物能力",
  world_property: "世界设定与硬规则",
  character_knowledge: "人物知情范围与 POV",
};

interface SupplementalFindingActionProps {
  readonly actionsDisabled: boolean;
  readonly busyIssue: string | null;
  readonly expectedChapterVersionId: string | null;
  readonly resolutions: readonly ChapterSupplementalFindingResolutionSummary[];
  readonly onResolve: (
    finding: SupplementalFindingDescriptor,
    action: ChapterSupplementalFindingAction,
  ) => void;
  readonly onUndo: (
    finding: SupplementalFindingDescriptor,
    resolution: ChapterSupplementalFindingResolutionSummary,
  ) => void;
}

export function ProjectChecksPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const { projectId: projectIdValue = "" } = useParams<{ projectId: string }>();
  const parsedProjectId = useMemo(() => parseUuidV7(projectIdValue), [projectIdValue]);
  const projectId = parsedProjectId.ok ? parsedProjectId.value : null;
  const projectRoot = `/projects/${projectIdValue}`;
  const [chapters, setChapters] = useState<readonly Chapter[]>([]);
  const [selectedChapterId, setSelectedChapterId] = useState("");
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const snapshotLoadSequence = useRef(0);
  const [busyIssue, setBusyIssue] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(
    parsedProjectId.ok ? null : parsedProjectId.error,
  );
  const [operationError, setOperationError] = useState<unknown>(null);
  const [result, setResult] = useState<ChapterNovelValidationResult | null>(null);
  const [validationSnapshot, setValidationSnapshot] = useState<ChapterValidationSnapshot | null>(
    null,
  );
  const [narrativeResult, setNarrativeResult] = useState<ChapterNarrativeAnalysisResult | null>(
    null,
  );
  const [voicePovResult, setVoicePovResult] =
    useState<ChapterCharacterVoicePovRuntimeResult | null>(null);
  const [supplementalResolutions, setSupplementalResolutions] = useState<
    readonly ChapterSupplementalFindingResolutionSummary[]
  >([]);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const loadChapters = useCallback(async (): Promise<void> => {
    if (projectId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const loaded = await runtime.repositories.chapters.listByProjectId(projectId);
    if (!loaded.ok) {
      setLoadError(loaded.error);
      setLoading(false);
      return;
    }
    const active = loaded.value.filter((chapter) => chapter.status === "active");
    setChapters(active);
    setSelectedChapterId((current) =>
      active.some(({ id }) => id === current) ? current : (active[0]?.id ?? ""),
    );
    setLoadError(null);
    setLoading(false);
  }, [projectId, runtime]);

  useEffect(() => {
    void Promise.resolve().then(loadChapters);
  }, [loadChapters]);

  useEffect(() => {
    const requestSequence = snapshotLoadSequence.current + 1;
    snapshotLoadSequence.current = requestSequence;
    void Promise.resolve().then(async () => {
      if (snapshotLoadSequence.current !== requestSequence) return;
      setValidationSnapshot(null);
      setResult(null);
      setNarrativeResult(null);
      setVoicePovResult(null);
      setSupplementalResolutions([]);
      if (projectId === null || selectedChapterId.length === 0) {
        setSnapshotLoading(false);
        return;
      }
      const chapterId = parseUuidV7(selectedChapterId);
      if (!chapterId.ok) {
        setOperationError(chapterId.error);
        setSnapshotLoading(false);
        return;
      }
      setSnapshotLoading(true);
      try {
        const snapshot = await runtime.story.chapterValidationSnapshots.findLatest(
          projectId,
          chapterId.value,
        );
        if (snapshotLoadSequence.current !== requestSequence) return;
        setValidationSnapshot(snapshot);
        setResult(snapshot?.result ?? null);
      } catch (cause: unknown) {
        if (snapshotLoadSequence.current === requestSequence) setOperationError(cause);
      } finally {
        if (snapshotLoadSequence.current === requestSequence) setSnapshotLoading(false);
      }
    });
    return () => {
      if (snapshotLoadSequence.current === requestSequence) {
        snapshotLoadSequence.current += 1;
      }
    };
  }, [projectId, runtime, selectedChapterId]);

  const runCheck = useCallback(
    async (chapterIdValue: string): Promise<ChapterNovelValidationResult | null> => {
      if (projectId === null) {
        return null;
      }
      const chapterId = parseUuidV7(chapterIdValue);
      if (!chapterId.ok) {
        setOperationError(chapterId.error);
        return null;
      }
      setChecking(true);
      setOperationError(null);
      try {
        const [snapshot, narrative, voicePov] = await Promise.all([
          runtime.story.chapterValidationSnapshots.run(
            {
              projectId,
              chapterId: chapterId.value,
            },
            { mode: "rerun" },
          ),
          runtime.story.narrativeAnalysis.analyzeChapter({
            projectId,
            chapterId: chapterId.value,
          }),
          runtime.story.characterVoicePov.check({
            projectId,
            chapterId: chapterId.value,
          }),
        ]);
        const checked = snapshot.result;
        setValidationSnapshot(snapshot);
        setResult(checked);
        setNarrativeResult(narrative);
        setVoicePovResult(voicePov);
        if (checked.chapterVersionId !== null) {
          setSupplementalResolutions(
            await runtime.story.chapterValidation.listSupplementalFindingResolutions({
              projectId,
              chapterId: chapterId.value,
              expectedChapterVersionId: checked.chapterVersionId,
            }),
          );
        } else {
          setSupplementalResolutions([]);
        }
        return checked;
      } catch (cause) {
        setOperationError(cause);
        return null;
      } finally {
        setChecking(false);
      }
    },
    [projectId, runtime],
  );

  async function resolveIssue(
    issue: ChapterValidationUiIssue,
    action: ChapterValidationUiAction,
  ): Promise<void> {
    const chapterVersionId = result?.chapterVersionId ?? null;
    if (projectId === null || chapterVersionId === null) {
      return;
    }
    const chapterId = parseUuidV7(selectedChapterId);
    if (!chapterId.ok) {
      setOperationError(chapterId.error);
      return;
    }
    setBusyIssue(`${issue.id}:${action}`);
    setOperationError(null);
    setActionNotice(null);
    try {
      await runtime.story.chapterValidation.resolveIssue({
        projectId,
        chapterId: chapterId.value,
        issueId: issue.id,
        expectedChapterVersionId: chapterVersionId,
        action,
        humanConfirmed: true,
      });
      setActionNotice(actionNoticeFor(action));
      await runCheck(selectedChapterId);
    } catch (cause) {
      setOperationError(cause);
    } finally {
      setBusyIssue(null);
    }
  }

  async function undoIgnore(issue: ChapterValidationUiIssue): Promise<void> {
    const chapterVersionId = result?.chapterVersionId ?? null;
    if (projectId === null || chapterVersionId === null) {
      return;
    }
    const chapterId = parseUuidV7(selectedChapterId);
    if (!chapterId.ok) {
      setOperationError(chapterId.error);
      return;
    }
    setBusyIssue(`${issue.id}:undo`);
    setOperationError(null);
    setActionNotice(null);
    try {
      await runtime.story.chapterValidation.undoIgnoredIssue({
        projectId,
        chapterId: chapterId.value,
        issueId: issue.id,
        expectedChapterVersionId: chapterVersionId,
        humanConfirmed: true,
      });
      setActionNotice("已撤销忽略，这条问题重新进入待处理状态。");
      await runCheck(selectedChapterId);
    } catch (cause) {
      setOperationError(cause);
    } finally {
      setBusyIssue(null);
    }
  }

  async function createCorrectionCandidate(issue: ChapterValidationUiIssue): Promise<void> {
    const chapterVersionId = result?.chapterVersionId ?? null;
    if (projectId === null || chapterVersionId === null) return;
    const chapterId = parseUuidV7(selectedChapterId);
    if (!chapterId.ok) {
      setOperationError(chapterId.error);
      return;
    }
    const evidence = issue.currentEvidence.find(
      (item) =>
        item.sourceKind === "chapter" &&
        item.sourceId === chapterId.value &&
        item.sourceVersionId === chapterVersionId,
    );
    if (evidence === undefined) {
      setOperationError(
        new UiActionError(
          "EVIDENCE_NOT_FOUND",
          "这条问题缺少能够精确定位到当前正文的原文证据。请重新检查本章后再试。",
          "无法创建修改建议",
        ),
      );
      return;
    }

    setBusyIssue(`${issue.id}:create_candidate`);
    setOperationError(null);
    setActionNotice(null);
    try {
      const candidate = await createEvidenceCorrectionCandidate(runtime, {
        projectId,
        chapterId: chapterId.value,
        expectedChapterVersionId: chapterVersionId,
        evidence,
        replacement: issue.conflictingFact.statement,
      });
      await navigate(
        `${projectRoot}/chapters/${String(chapterId.value)}?candidate=${String(candidate.id)}`,
      );
    } catch (cause) {
      setOperationError(cause);
    } finally {
      setBusyIssue(null);
    }
  }

  async function resolveSupplementalFinding(
    finding: SupplementalFindingDescriptor,
    action: ChapterSupplementalFindingAction,
  ): Promise<void> {
    const chapterVersionId = result?.chapterVersionId ?? null;
    if (projectId === null || chapterVersionId === null || finding.evidence.length === 0) return;
    const chapterId = parseUuidV7(selectedChapterId);
    if (!chapterId.ok) {
      setOperationError(chapterId.error);
      return;
    }
    const evidenceSignature = supplementalEvidenceSignature(finding.evidence);
    setBusyIssue(`${finding.id}:supplemental:${action}`);
    setOperationError(null);
    try {
      const saved = await runtime.story.chapterValidation.resolveSupplementalFinding({
        projectId,
        chapterId: chapterId.value,
        expectedChapterVersionId: chapterVersionId,
        findingId: finding.id,
        category: finding.category,
        evidenceSignature,
        action,
        humanConfirmed: true,
      });
      setSupplementalResolutions((current) => [
        ...current.filter(
          (item) =>
            item.chapterVersionId !== saved.chapterVersionId ||
            item.findingId !== saved.findingId ||
            item.evidenceSignature !== saved.evidenceSignature,
        ),
        saved,
      ]);
      setActionNotice(
        action === "ignore" ? "提醒已忽略，可随时恢复。" : "当前写法已明确标记为允许，可随时恢复。",
      );
    } catch (cause) {
      setOperationError(cause);
    } finally {
      setBusyIssue(null);
    }
  }

  async function undoSupplementalFinding(
    finding: SupplementalFindingDescriptor,
    resolution: ChapterSupplementalFindingResolutionSummary,
  ): Promise<void> {
    const chapterVersionId = result?.chapterVersionId ?? null;
    if (projectId === null || chapterVersionId === null) return;
    const chapterId = parseUuidV7(selectedChapterId);
    if (!chapterId.ok) {
      setOperationError(chapterId.error);
      return;
    }
    setBusyIssue(`${finding.id}:supplemental:undo`);
    setOperationError(null);
    try {
      await runtime.story.chapterValidation.undoSupplementalFinding({
        projectId,
        chapterId: chapterId.value,
        expectedChapterVersionId: chapterVersionId,
        findingId: finding.id,
        evidenceSignature: resolution.evidenceSignature,
        resolutionFactId: resolution.factId,
        expectedResolutionFactRevision: resolution.factRevision,
        humanConfirmed: true,
      });
      setSupplementalResolutions((current) =>
        current.filter(({ factId }) => factId !== resolution.factId),
      );
      setActionNotice("提醒已恢复为待处理状态。正文和正式设定没有改变。");
    } catch (cause) {
      setOperationError(cause);
    } finally {
      setBusyIssue(null);
    }
  }

  const normalizedLoadError = loadError === null ? null : projectOrdinaryUiError(loadError);
  const normalizedOperationError =
    operationError === null ? null : projectOrdinaryUiError(operationError);
  const unresolvedCount =
    result?.issues.filter(({ resolution }) => resolution.status === "unresolved").length ?? 0;
  const selectedChapter = chapters.find(({ id }) => id === selectedChapterId) ?? null;
  const checkedCoverageCount =
    result?.coverage?.filter(({ status }) => status === "checked").length ?? 0;
  const snapshotIsCurrent =
    validationSnapshot !== null &&
    selectedChapter !== null &&
    validationSnapshot.chapterVersionId === selectedChapter.currentVersionId;
  const advancedTools = advancedProjectTools(runtime, projectRoot);

  return (
    <div className="desktop-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to={projectRoot}>
            返回正文
          </Link>
          <p className="page-heading__eyebrow">写作检查</p>
          <h1>检查</h1>
          <p>选择一章运行证据驱动检查。没有可定位证据的推测不会被当作问题。</p>
        </div>
      </header>

      <InlineAlert
        title="每条问题都必须带证据"
        description="结果会同时展示当前原文、冲突设定、双方来源、严重程度和修改建议。检查只读，不会自动修改正文或正式设定。"
      />

      {projectId !== null && runtime.consistencyInvestigation !== null && (
        <ConsistencyInvestigationPanel
          projectId={projectId}
          runtime={runtime.consistencyInvestigation}
          onOpenCandidate={(candidate) =>
            navigate(
              `${projectRoot}/chapters/${candidate.chapterId}?candidate=${candidate.candidateId}`,
            )
          }
        />
      )}

      {normalizedLoadError !== null ? (
        <ErrorState
          title={normalizedLoadError.title}
          description={normalizedLoadError.description}
          primaryAction={{ label: "重新读取章节", onClick: () => void loadChapters() }}
        />
      ) : loading ? (
        <div role="status">正在读取章节…</div>
      ) : chapters.length === 0 ? (
        <EmptyState
          title="还没有可检查的章节"
          description="先创建或恢复一个章节，再回来运行检查。"
          primaryAction={{ label: "返回正文", onClick: () => void navigate(projectRoot) }}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle headingLevel={2}>选择要检查的章节</CardTitle>
            <CardDescription>
              正文冲突只检查该章节当前已保存版本；叙事分析只读取已确认资料和因果图，不读取未接受的
              AI 建议版本。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="chapter-check-runner">
              <FormField label="章节" required>
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={selectedChapterId}
                    disabled={checking || busyIssue !== null}
                    options={chapters.map((chapter) => ({
                      value: chapter.id,
                      label: `${chapter.title} · 版本 ${String(chapter.revision)}`,
                    }))}
                    onChange={(event) => {
                      setSelectedChapterId(event.currentTarget.value);
                      setValidationSnapshot(null);
                      setResult(null);
                      setNarrativeResult(null);
                      setVoicePovResult(null);
                      setOperationError(null);
                      setActionNotice(null);
                    }}
                  />
                )}
              </FormField>
              <Button
                loading={checking}
                loadingLabel="正在检查"
                disabled={selectedChapterId.length === 0 || busyIssue !== null || snapshotLoading}
                onClick={() => void runCheck(selectedChapterId)}
              >
                {validationSnapshot === null ? "检查本章" : "重新检查"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {normalizedOperationError !== null && (
        <InlineAlert
          tone="error"
          title={normalizedOperationError.title}
          description={normalizedOperationError.description}
        />
      )}
      {actionNotice !== null && <InlineAlert title="处理结果已保存" description={actionNotice} />}
      {snapshotLoading && <div role="status">正在读取最近一次检查快照…</div>}
      {validationSnapshot !== null && (
        <InlineAlert
          tone={snapshotIsCurrent ? "info" : "warning"}
          title={snapshotIsCurrent ? "已读取当前版本的检查快照" : "这是较早版本的检查快照"}
          description={`第 ${String(validationSnapshot.runSequence)} 次检查 · 规则 ${validationSnapshot.ruleSetVersion} · ${formatTimestamp(validationSnapshot.generatedAt)}${
            snapshotIsCurrent ? "" : "。正文版本已经变化，请重新检查后再处理问题。"
          }`}
        />
      )}

      <section aria-labelledby="check-results-heading">
        <div className="section-heading">
          <div>
            <h2 id="check-results-heading">确定性检查</h2>
            <p>这里先运行可由明确规则和精确证据判断的检查；处理操作不会改动正文。</p>
          </div>
          {result !== null && (
            <Badge tone={unresolvedCount === 0 ? "success" : "warning"}>
              {checkedCoverageCount} 类实际运行 · {unresolvedCount} 项待处理
            </Badge>
          )}
        </div>
        {result !== null && <DeterministicCoverageSummary coverage={result.coverage} />}
        {result === null ? (
          <EmptyState
            title="还没有检查结果"
            description="选择章节并点击“检查本章”。系统不会把尚未运行的检查显示成已完成。"
          />
        ) : result.status === "skipped" ? (
          <SkippedCheckResult result={result} />
        ) : result.issues.length === 0 ? (
          <EmptyState
            title="没有发现有证据支持的冲突"
            description="在上方列出的实际运行类别中没有发现冲突；未检查类别仍然未知，不代表通过。章节正文没有改变。"
          />
        ) : (
          <div className="chapter-check-results">
            {result.issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                busyIssue={busyIssue}
                actionsDisabled={!snapshotIsCurrent}
                onCreateCandidate={() => void createCorrectionCandidate(issue)}
                onResolve={(action) => void resolveIssue(issue, action)}
                onUndoIgnore={() => void undoIgnore(issue)}
              />
            ))}
          </div>
        )}
      </section>

      {narrativeResult !== null && (
        <NarrativeAnalysisSections
          result={narrativeResult}
          chapters={chapters}
          projectRoot={projectRoot}
          expectedChapterVersionId={result?.chapterVersionId ?? null}
          actionsDisabled={!snapshotIsCurrent}
          busyIssue={busyIssue}
          resolutions={supplementalResolutions}
          onResolve={(finding, action) => void resolveSupplementalFinding(finding, action)}
          onUndo={(finding, resolution) => void undoSupplementalFinding(finding, resolution)}
        />
      )}

      {voicePovResult !== null && (
        <CharacterVoicePovSection
          result={voicePovResult}
          deterministicIssues={result?.issues ?? []}
          expectedChapterVersionId={result?.chapterVersionId ?? null}
          actionsDisabled={!snapshotIsCurrent}
          busyIssue={busyIssue}
          resolutions={supplementalResolutions}
          onResolve={(finding, action) => void resolveSupplementalFinding(finding, action)}
          onUndo={(finding, resolution) => void undoSupplementalFinding(finding, resolution)}
          onUpdateSetting={(issue) => void resolveIssue(issue, "update_setting")}
        />
      )}

      {result !== null && (
        <InlineAlert
          tone="info"
          title="普通检查不会调用 AI"
          description="旧版批量 AI 模糊复核已安全关闭。需要模型参与时，请使用页面上方的一致性调查，并在发送前核对该次调查展示的模型、调用与费用信息。"
        />
      )}

      {result !== null && result.resolutions.length > 0 && (
        <ResolutionHistory resolutions={result.resolutions} />
      )}

      <details>
        <summary>检查范围</summary>
        <p>以下是产品计划覆盖的方向，不代表本次已经运行或发现了问题。</p>
        <ul className="privacy-list">
          {checkCategories.map(([title, description]) => (
            <li key={title}>
              <strong>{title}</strong>：{description}
            </li>
          ))}
        </ul>
      </details>

      <details>
        <summary>高级工具</summary>
        <p>这些入口保留给需要进一步排查的用户，不属于普通项目的一级导航。</p>
        <div className="settings-grid">
          {advancedTools.map((tool) => (
            <Card key={tool.to}>
              <CardHeader>
                <CardTitle>{tool.label}</CardTitle>
                <CardDescription>{tool.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link className="button-link button-link--secondary" to={tool.to}>
                  打开{tool.label}
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </details>
    </div>
  );
}

function CharacterVoicePovSection({
  actionsDisabled,
  busyIssue,
  deterministicIssues,
  expectedChapterVersionId,
  onResolve,
  onUndo,
  onUpdateSetting,
  resolutions,
  result,
}: Readonly<
  SupplementalFindingActionProps & {
    readonly result: ChapterCharacterVoicePovRuntimeResult;
    readonly deterministicIssues: readonly ChapterValidationUiIssue[];
    readonly onUpdateSetting: (issue: ChapterValidationUiIssue) => void;
  }
>) {
  return (
    <section aria-labelledby="voice-pov-check-heading">
      <div className="section-heading">
        <div>
          <h2 id="voice-pov-check-heading">人物说话方式与视角边界</h2>
          <p>只比较已确认的人物历史台词和知识记录；不会根据姓名或模糊语气猜测。</p>
        </div>
        <Badge
          tone={
            result.status === "error"
              ? "danger"
              : result.issues.length > 0
                ? "warning"
                : result.status === "ready"
                  ? "success"
                  : "neutral"
          }
        >
          {result.status === "error"
            ? "检查未完成"
            : `${String(result.issues.length)} 项有证据的问题`}
        </Badge>
      </div>

      {result.error !== null ? (
        <InlineAlert
          tone="error"
          title={result.error.title}
          description={`${result.error.description} 可尝试：${result.error.actions.join("、")}。`}
        />
      ) : result.status === "skipped" ? (
        <InlineAlert
          tone="warning"
          title="尚无足够的人物证据"
          description="需要明确标注说话人、原文位置和已确认的历史台词或知识状态；本次没有生成猜测性结论。"
        />
      ) : result.issues.length === 0 ? (
        <InlineAlert
          tone="info"
          title="已完成能够核验的部分"
          description="在本次实际运行且证据充分的声纹与视角检查中没有发现偏离；未满足条件的项目仍会列在下方。"
        />
      ) : (
        <div className="chapter-check-results">
          {result.issues.map((issue) => {
            const linkedDeterministicIssue = issue.id.startsWith("pov:")
              ? (deterministicIssues.find(({ id }) => id === issue.id.slice(4)) ?? null)
              : null;
            return (
              <CharacterVoicePovIssueCard
                key={issue.id}
                issue={issue}
                linkedDeterministicIssue={linkedDeterministicIssue}
                expectedChapterVersionId={expectedChapterVersionId}
                actionsDisabled={actionsDisabled}
                busyIssue={busyIssue}
                resolutions={resolutions}
                onResolve={onResolve}
                onUndo={onUndo}
                onUpdateSetting={onUpdateSetting}
              />
            );
          })}
        </div>
      )}

      {result.skippedChecks.length > 0 && (
        <details>
          <summary>本次未能运行的检查（{result.skippedChecks.length}）</summary>
          <ul className="privacy-list">
            {result.skippedChecks.map((check) => (
              <li key={check.id}>
                <strong>{check.title}</strong>：{check.explanation}
                {check.missingRequirements.length > 0
                  ? ` 还需要：${check.missingRequirements.join("、")}。`
                  : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function CharacterVoicePovIssueCard({
  actionsDisabled,
  busyIssue,
  expectedChapterVersionId,
  issue,
  linkedDeterministicIssue,
  onResolve,
  onUndo,
  onUpdateSetting,
  resolutions,
}: Readonly<
  SupplementalFindingActionProps & {
    readonly issue: ChapterCharacterVoicePovIssue;
    readonly linkedDeterministicIssue: ChapterValidationUiIssue | null;
    readonly onUpdateSetting: (issue: ChapterValidationUiIssue) => void;
  }
>) {
  const finding = characterVoicePovSupplementalFinding(issue);
  return (
    <Card>
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <CardTitle headingLevel={3}>{issue.title}</CardTitle>
            <CardDescription>{characterVoiceIssueSummary(issue)}</CardDescription>
          </div>
          <Badge tone={issue.severity === "error" ? "danger" : "warning"}>
            {issue.severity === "error" ? "严重" : "需要留意"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p>{issue.explanation}</p>
        <div className="settings-grid">
          <CharacterEvidenceList title="当前原文" evidence={issue.currentEvidence} />
          <CharacterEvidenceList title="历史依据" evidence={issue.referenceEvidence} />
        </div>
        <InlineAlert
          tone="info"
          title="修改建议"
          description={`${issue.suggestion.summary} ${issue.suggestion.actions.join("；")}`}
        />
        <SupplementalFindingActions
          finding={finding}
          expectedChapterVersionId={expectedChapterVersionId}
          actionsDisabled={actionsDisabled}
          busyIssue={busyIssue}
          resolutions={resolutions}
          onResolve={onResolve}
          onUndo={onUndo}
        />
        {issue.kind === "character_voice_deviation" ? (
          <p>
            <strong>更新正式设定：</strong>
            不适用于单章声纹偏离。声纹需要综合多段历史台词，请在人物设定中人工调整，避免一条异常台词覆盖既有样本。
          </p>
        ) : linkedDeterministicIssue !== null ? (
          <div className="settings-actions">
            <Button
              size="sm"
              loading={busyIssue === `${linkedDeterministicIssue.id}:update_setting`}
              disabled={
                actionsDisabled || busyIssue?.startsWith(`${linkedDeterministicIssue.id}:`) === true
              }
              onClick={() => onUpdateSetting(linkedDeterministicIssue)}
            >
              用当前正文更新正式知情设定
            </Button>
          </div>
        ) : (
          <p>
            <strong>更新正式设定：</strong>
            当前提醒没有可安全绑定的正式知识事实，因此不提供一键更新；请先补充带来源的信息取得事件后重新检查。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CharacterEvidenceList({
  title,
  evidence,
}: {
  readonly title: string;
  readonly evidence: ChapterCharacterVoicePovIssue["currentEvidence"];
}) {
  return (
    <div>
      <h4>{title}</h4>
      {evidence.length === 0 ? (
        <p>没有通过完整性核验的证据。</p>
      ) : (
        <ul className="privacy-list">
          {evidence.map((source) => (
            <li key={source.id}>
              “{source.excerpt}”
              <br />
              <small>
                {evidenceSourceLabel(source.sourceKind)} · 已绑定对应不可变版本 · 位置
                {source.startOffset}–{source.endOffset}
              </small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NarrativeAnalysisSections({
  actionsDisabled,
  busyIssue,
  chapters,
  expectedChapterVersionId,
  onResolve,
  onUndo,
  projectRoot,
  resolutions,
  result,
}: Readonly<
  SupplementalFindingActionProps & {
    readonly chapters: readonly Chapter[];
    readonly result: ChapterNarrativeAnalysisResult;
    readonly projectRoot: string;
  }
>) {
  if (result.status === "skipped" || result.analysis === null) {
    return (
      <section aria-labelledby="narrative-analysis-heading">
        <div className="section-heading">
          <div>
            <h2 id="narrative-analysis-heading">剧情推进、伏笔与节奏</h2>
            <p>这里只读取已确认故事事实和经过核验的因果事件，不会从正文语气中猜测。</p>
          </div>
        </div>
        <InlineAlert
          tone="warning"
          title="尚无足够证据"
          description="需要先形成带原文位置的章节顺序、剧情结构或场景指标；本次没有生成猜测性结论。"
        />
      </section>
    );
  }

  const analysis = result.analysis;
  return (
    <section aria-labelledby="narrative-analysis-heading">
      <div className="section-heading">
        <div>
          <h2 id="narrative-analysis-heading">剧情推进、伏笔与节奏</h2>
          <p>结论只来自已确认资料和因果图；这里的结果只读，不会修改正文或正式设定。</p>
        </div>
        <Badge tone={analysis.qualityFindings.length === 0 ? "success" : "warning"}>
          {analysis.qualityFindings.length} 项结构提醒
        </Badge>
      </div>

      {result.missingRequirements.length > 0 && (
        <InlineAlert
          tone="warning"
          title="部分项目尚无足够证据"
          description={`已完成能够核验的部分；还有 ${String(result.missingRequirements.length)} 个资料范围未声明完整，因此不会据此报告“没有问题”。`}
        />
      )}
      <p>
        本次读取 {result.sourceSummary.confirmedFacts} 条已确认结构资料、
        {result.sourceSummary.causalEvents} 个已核验因果事件和
        {result.sourceSummary.causalRelations} 条因果关系。
      </p>

      <NarrativePlotlineSection
        result={result}
        chapters={chapters}
        projectRoot={projectRoot}
        expectedChapterVersionId={expectedChapterVersionId}
        actionsDisabled={actionsDisabled}
        busyIssue={busyIssue}
        resolutions={resolutions}
        onResolve={onResolve}
        onUndo={onUndo}
      />
      <NarrativeForeshadowSection
        result={result}
        expectedChapterVersionId={expectedChapterVersionId}
        actionsDisabled={actionsDisabled}
        busyIssue={busyIssue}
        resolutions={resolutions}
        onResolve={onResolve}
        onUndo={onUndo}
      />
      <NarrativePacingSection
        result={result}
        chapters={chapters}
        expectedChapterVersionId={expectedChapterVersionId}
        actionsDisabled={actionsDisabled}
        busyIssue={busyIssue}
        resolutions={resolutions}
        onResolve={onResolve}
        onUndo={onUndo}
      />

      {result.skippedSources.length > 0 && (
        <details>
          <summary>未参与分析的资料（{result.skippedSources.length}）</summary>
          <ul className="privacy-list">
            {result.skippedSources.map((source, index) => (
              <li key={`${source.sourceId}:${source.reason}:${String(index)}`}>
                {source.explanation}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function NarrativePlotlineSection({
  actionsDisabled,
  busyIssue,
  chapters,
  expectedChapterVersionId,
  onResolve,
  onUndo,
  projectRoot,
  resolutions,
  result,
}: Readonly<
  SupplementalFindingActionProps & {
    readonly chapters: readonly Chapter[];
    readonly result: ChapterNarrativeAnalysisResult;
    readonly projectRoot: string;
  }
>) {
  const analysis = result.analysis;
  if (analysis === null) {
    return null;
  }
  const conflicts = analysis.timeLocationConflicts;
  const hasContent = analysis.plotlines.length > 0;
  const plotlineLabels = new Map(
    analysis.plotlines.map((plotline, index) => [
      plotline.plotlineId,
      narrativeLabel(analyzedValue(plotline.goal), `剧情线 ${String(index + 1)}`),
    ]),
  );
  return (
    <section aria-labelledby="plotline-analysis-heading">
      <div className="section-heading">
        <div>
          <h3 id="plotline-analysis-heading">多线叙事协调</h3>
          <p>查看每条剧情线的目标、最近推进、参与人物、依赖、停滞和即将交汇。</p>
        </div>
      </div>
      {!hasContent ? (
        <NarrativeEvidenceMissing />
      ) : (
        <div className="settings-grid">
          {analysis.plotlines.map((plotline) => {
            const stagnation = analyzedValue(plotline.stagnation);
            const latest = analyzedValue(plotline.latestProgress);
            const characters = analyzedValue(plotline.characterIds);
            const dependencies = analyzedValue(plotline.dependencies);
            const convergences = analyzedValue(plotline.upcomingConvergences);
            const plotlineLabel = plotlineLabels.get(plotline.plotlineId) ?? "未命名剧情线";
            const evidence = analyzedEvidence(
              plotline.goal,
              plotline.latestProgress,
              plotline.stagnation,
              plotline.dependencies,
              plotline.upcomingConvergences,
            );
            return (
              <Card key={plotline.plotlineId}>
                <CardHeader>
                  <div className="card-heading-row">
                    <CardTitle headingLevel={4}>{plotlineLabel}</CardTitle>
                    {stagnation !== null && (
                      <Badge tone={stagnation.state === "stagnant" ? "warning" : "neutral"}>
                        {plotlineStateLabel(stagnation.state)}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="privacy-list">
                    <li>
                      <strong>最近推进：</strong>
                      {latest === null
                        ? plotline.latestProgress.status === "analyzed"
                          ? "尚未开始"
                          : "尚无足够证据"
                        : `${latest.summary}（${chapterDisplayLabel(chapters, latest.chapterId)}）`}
                    </li>
                    <li>
                      <strong>推进状态：</strong>
                      {stagnation === null
                        ? "尚无足够证据"
                        : stagnation.chaptersSinceProgress === null
                          ? plotlineStateLabel(stagnation.state)
                          : `${plotlineStateLabel(stagnation.state)}；已过 ${String(stagnation.chaptersSinceProgress)} 章，停滞阈值为 ${String(stagnation.threshold)} 章`}
                    </li>
                    <li>
                      <strong>参与人物：</strong>
                      {characters === null
                        ? "尚无足够证据"
                        : characters.length === 0
                          ? "没有已确认人物"
                          : `${String(characters.length)} 位已确认人物`}
                    </li>
                    <li>
                      <strong>依赖：</strong>
                      {dependencies === null
                        ? "尚无足够证据"
                        : dependencies.length === 0
                          ? "没有已确认依赖"
                          : dependencies
                              .map(
                                (dependency) =>
                                  `${plotlineLabels.get(dependency.toPlotlineId) ?? "另一条剧情线"}（${dependencyStatusLabel(dependency.status)}）`,
                              )
                              .join("；")}
                    </li>
                    <li>
                      <strong>即将交汇：</strong>
                      {convergences === null
                        ? "尚无足够证据"
                        : convergences.length === 0
                          ? "当前范围内没有已确认计划"
                          : convergences
                              .map(
                                (plan) => `预计在章节顺序 ${String(plan.targetChapterOrder)} 交汇`,
                              )
                              .join("；")}
                    </li>
                  </ul>
                  <NarrativeEvidenceList evidence={evidence} />
                  {stagnation?.state === "stagnant" && (
                    <NarrativeFindingDisposition
                      title="剧情线长期未推进"
                      severity="warning"
                      explanation={`“${plotlineLabel}”已超过 ${String(stagnation.threshold)} 章未推进。`}
                      suggestion="在接下来的场景推进该剧情线、明确安排交汇点，或在确认有意搁置时标记为允许。"
                      finding={{
                        id: `narrative:plotline:${plotline.plotlineId}:stagnant`,
                        category: "plotline",
                        evidence,
                      }}
                      settingAction="not_applicable"
                      expectedChapterVersionId={expectedChapterVersionId}
                      actionsDisabled={actionsDisabled}
                      busyIssue={busyIssue}
                      resolutions={resolutions}
                      onResolve={onResolve}
                      onUndo={onUndo}
                    />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle headingLevel={4}>人物时空冲突</CardTitle>
          <CardDescription>只有同一人物在明确重叠时间出现在不同地点时才会报告。</CardDescription>
        </CardHeader>
        <CardContent>
          {conflicts.status === "skipped" ? (
            <p>尚无足够证据</p>
          ) : conflicts.value.length === 0 ? (
            <p>在已声明完整的资料范围内没有发现时空冲突。</p>
          ) : (
            <div className="chapter-check-results">
              {conflicts.value.map((conflict) => (
                <NarrativeFindingDisposition
                  key={conflict.id}
                  title="人物时空冲突"
                  severity="error"
                  explanation={`一位已确认人物在故事时间 ${String(conflict.overlappingStoryTime.start)}–${String(conflict.overlappingStoryTime.end)} 同时出现在两个不同地点。`}
                  suggestion="核对两条事件的时间、地点和参与人物，保留有原文依据的一条；若这是有意设定，可标记为允许。"
                  finding={{
                    id: `narrative:time-location:${conflict.id}`,
                    category: "time_location",
                    evidence: conflict.evidence,
                  }}
                  evidence={conflict.evidence}
                  settingAction="choose_source"
                  projectRoot={projectRoot}
                  expectedChapterVersionId={expectedChapterVersionId}
                  actionsDisabled={actionsDisabled}
                  busyIssue={busyIssue}
                  resolutions={resolutions}
                  onResolve={onResolve}
                  onUndo={onUndo}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function NarrativeForeshadowSection({
  actionsDisabled,
  busyIssue,
  expectedChapterVersionId,
  onResolve,
  onUndo,
  resolutions,
  result,
}: Readonly<SupplementalFindingActionProps & { readonly result: ChapterNarrativeAnalysisResult }>) {
  const analysis = result.analysis;
  if (analysis === null) {
    return null;
  }
  return (
    <section aria-labelledby="foreshadow-analysis-heading">
      <div className="section-heading">
        <div>
          <h3 id="foreshadow-analysis-heading">伏笔推进</h3>
          <p>按因果事件中明确记录的埋设、推进、揭示和回收顺序展示。</p>
        </div>
      </div>
      {analysis.foreshadows.length === 0 ? (
        <NarrativeEvidenceMissing />
      ) : (
        <div className="settings-grid">
          {analysis.foreshadows.map((foreshadow, index) => {
            const foreshadowLabel = `伏笔线索 ${String(index + 1)}`;
            if (foreshadow.progress.status === "skipped") {
              return (
                <Card key={foreshadow.foreshadowId}>
                  <CardHeader>
                    <CardTitle headingLevel={4}>{foreshadowLabel}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p>尚无足够证据</p>
                  </CardContent>
                </Card>
              );
            }
            const progress = foreshadow.progress.value;
            return (
              <Card key={foreshadow.foreshadowId}>
                <CardHeader>
                  <div className="card-heading-row">
                    <CardTitle headingLevel={4}>{foreshadowLabel}</CardTitle>
                    <Badge tone={progress.stagnant ? "warning" : "neutral"}>
                      {foreshadowStateLabel(progress.state)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <p>
                    最近推进：{progress.latestProgress?.description ?? "尚未开始"}
                    {progress.chaptersSinceProgress === null
                      ? ""
                      : `；距今 ${String(progress.chaptersSinceProgress)} 章`}
                  </p>
                  {progress.sequenceIssues.length > 0 && (
                    <div className="chapter-check-results">
                      {progress.sequenceIssues.map((issue) => (
                        <NarrativeFindingDisposition
                          key={`${issue.kind}:${issue.progressId}`}
                          title="伏笔顺序冲突"
                          severity={issue.kind === "duplicate_plant" ? "warning" : "error"}
                          explanation={foreshadowIssueLabel(issue.kind)}
                          suggestion={foreshadowIssueSuggestion(issue.kind)}
                          finding={{
                            id: `narrative:foreshadow:${foreshadow.foreshadowId}:${issue.kind}:${issue.progressId}`,
                            category: "foreshadow",
                            evidence: issue.evidence,
                          }}
                          settingAction="not_applicable"
                          expectedChapterVersionId={expectedChapterVersionId}
                          actionsDisabled={actionsDisabled}
                          busyIssue={busyIssue}
                          resolutions={resolutions}
                          onResolve={onResolve}
                          onUndo={onUndo}
                        />
                      ))}
                    </div>
                  )}
                  {progress.stagnant && (
                    <NarrativeFindingDisposition
                      title="伏笔长期未推进"
                      severity="warning"
                      explanation={`“${foreshadowLabel}”距最近一次推进已经 ${String(progress.chaptersSinceProgress ?? progress.threshold)} 章。`}
                      suggestion="在后续场景安排推进或回收；若有意延后，可以标记为允许并保留审计记录。"
                      finding={{
                        id: `narrative:foreshadow:${foreshadow.foreshadowId}:stagnant:${progress.latestProgress?.id ?? "none"}`,
                        category: "foreshadow",
                        evidence: foreshadow.progress.evidence,
                      }}
                      settingAction="not_applicable"
                      expectedChapterVersionId={expectedChapterVersionId}
                      actionsDisabled={actionsDisabled}
                      busyIssue={busyIssue}
                      resolutions={resolutions}
                      onResolve={onResolve}
                      onUndo={onUndo}
                    />
                  )}
                  <NarrativeEvidenceList evidence={foreshadow.progress.evidence} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function NarrativePacingSection({
  actionsDisabled,
  busyIssue,
  chapters,
  expectedChapterVersionId,
  onResolve,
  onUndo,
  resolutions,
  result,
}: Readonly<
  SupplementalFindingActionProps & {
    readonly chapters: readonly Chapter[];
    readonly result: ChapterNarrativeAnalysisResult;
  }
>) {
  const analysis = result.analysis;
  if (analysis === null) {
    return null;
  }
  const hasMeasuredChapter = analysis.chapters.some(
    (chapter) =>
      chapter.conflict.status === "analyzed" ||
      chapter.tension.status === "analyzed" ||
      chapter.composition.status === "analyzed",
  );
  const sceneLabels = new Map(
    analysis.scenes.map((scene, index) => [
      scene.sceneId,
      narrativeLabel(analyzedValue(scene.goal), `场景 ${String(index + 1)}`),
    ]),
  );
  return (
    <section aria-labelledby="pacing-analysis-heading">
      <div className="section-heading">
        <div>
          <h3 id="pacing-analysis-heading">节奏与章节质量</h3>
          <p>展示明确测量的冲突、张力和内容比例，以及可由结构事实直接验证的提醒。</p>
        </div>
      </div>
      {!hasMeasuredChapter ? (
        <NarrativeEvidenceMissing />
      ) : (
        <div className="chapter-check-results">
          {analysis.chapters.map((chapter) => (
            <Card key={chapter.chapterId}>
              <CardHeader>
                <CardTitle headingLevel={4}>章节顺序 {chapter.order}</CardTitle>
                <CardDescription>{chapter.sceneIds.length} 个有明确指标的场景</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="privacy-list">
                  <li>
                    <strong>冲突强度：</strong>
                    {chapter.conflict.status === "analyzed"
                      ? formatDecimal(chapter.conflict.value.weightedMean)
                      : "尚无足够证据"}
                  </li>
                  <li>
                    <strong>张力：</strong>
                    {chapter.tension.status === "analyzed"
                      ? `${formatDecimal(chapter.tension.value.start)} → ${formatDecimal(chapter.tension.value.end)}，峰值 ${formatDecimal(chapter.tension.value.peak)}（${tensionTrendLabel(chapter.tension.value.trend)}）`
                      : "尚无足够证据"}
                  </li>
                  <li>
                    <strong>内容比例：</strong>
                    {chapter.composition.status === "analyzed"
                      ? `信息 ${formatPercent(chapter.composition.value.informationRatio)}、对话 ${formatPercent(chapter.composition.value.dialogueRatio)}、描写 ${formatPercent(chapter.composition.value.descriptionRatio)}、内心活动 ${formatPercent(chapter.composition.value.innerActivityRatio)}`
                      : "尚无足够证据"}
                  </li>
                  <li>
                    <strong>是否推进剧情：</strong>
                    {booleanMeasurement(chapter.advancesPlot, "是", "否")}
                  </li>
                  <li>
                    <strong>是否改变人物：</strong>
                    {booleanMeasurement(chapter.changesCharacters, "是", "否")}
                  </li>
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle headingLevel={4}>结构提醒</CardTitle>
          <CardDescription>没有证据时不会给分，也不会把主观评价伪装成结论。</CardDescription>
        </CardHeader>
        <CardContent>
          {analysis.qualityFindings.length === 0 ? (
            hasMeasuredChapter ? (
              <p>在已有结构化证据范围内没有发现可确定的节奏或章节功能问题。</p>
            ) : (
              <p>尚无足够证据</p>
            )
          ) : (
            <div className="chapter-check-results">
              {analysis.qualityFindings.map((finding) => (
                <NarrativeFindingDisposition
                  key={narrativeQualityFindingId(finding)}
                  title="节奏与章节功能提醒"
                  severity="warning"
                  explanation={qualityFindingLabel(finding, chapters, sceneLabels)}
                  suggestion={qualityFindingSuggestion(finding)}
                  finding={{
                    id: narrativeQualityFindingId(finding),
                    category: "pacing_quality",
                    evidence: finding.evidence,
                  }}
                  settingAction="not_applicable"
                  expectedChapterVersionId={expectedChapterVersionId}
                  actionsDisabled={actionsDisabled}
                  busyIssue={busyIssue}
                  resolutions={resolutions}
                  onResolve={onResolve}
                  onUndo={onUndo}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <details>
        <summary>查看场景指标（{analysis.scenes.length}）</summary>
        {analysis.scenes.length === 0 ? (
          <p>尚无足够证据</p>
        ) : (
          <ul className="privacy-list">
            {analysis.scenes.map((scene) => (
              <li key={scene.sceneId}>
                <strong>{sceneLabels.get(scene.sceneId) ?? "未命名场景"}</strong>
                ：冲突
                {scene.conflictIntensity.status === "analyzed"
                  ? ` ${formatDecimal(scene.conflictIntensity.value)}`
                  : " 尚无足够证据"}
                ，张力
                {scene.tension.status === "analyzed"
                  ? ` ${tensionTrendLabel(scene.tension.value.trend)}`
                  : " 尚无足够证据"}
                。
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

function NarrativeFindingDisposition({
  actionsDisabled,
  busyIssue,
  evidence,
  expectedChapterVersionId,
  explanation,
  finding,
  onResolve,
  onUndo,
  projectRoot,
  resolutions,
  settingAction,
  severity,
  suggestion,
  title,
}: Readonly<
  SupplementalFindingActionProps & {
    readonly title: string;
    readonly severity: "warning" | "error";
    readonly explanation: string;
    readonly suggestion: string;
    readonly finding: SupplementalFindingDescriptor;
    readonly evidence?: readonly NarrativeEvidenceReference[];
    readonly settingAction: "not_applicable" | "choose_source";
    readonly projectRoot?: string;
  }
>) {
  const displayedEvidence = evidence ?? finding.evidence;
  return (
    <div className="chapter-check-issue">
      <div className="card-heading-row">
        <strong>{title}</strong>
        <Badge tone={severity === "error" ? "danger" : "warning"}>
          {severity === "error" ? "需要处理" : "建议复核"}
        </Badge>
      </div>
      <p>{explanation}</p>
      <SupplementalEvidenceList evidence={displayedEvidence} />
      <InlineAlert tone="info" title="修改建议" description={suggestion} />
      <SupplementalFindingActions
        finding={finding}
        expectedChapterVersionId={expectedChapterVersionId}
        actionsDisabled={actionsDisabled}
        busyIssue={busyIssue}
        resolutions={resolutions}
        onResolve={onResolve}
        onUndo={onUndo}
      />
      {settingAction === "choose_source" && projectRoot !== undefined ? (
        <p>
          <strong>更新正式设定：</strong>
          这类事实冲突需要先选择哪条事件为准，不能一键覆盖。请到
          <Link to={`${projectRoot}/graph`}>故事关联</Link>
          核对事件后再保存。
        </p>
      ) : (
        <p>
          <strong>更新正式设定：</strong>
          不适用于结构或质量提醒；忽略和允许只保存处置记录，不会改写正文或正式设定。
        </p>
      )}
    </div>
  );
}

function SupplementalFindingActions({
  actionsDisabled,
  busyIssue,
  expectedChapterVersionId,
  finding,
  onResolve,
  onUndo,
  resolutions,
}: SupplementalFindingActionProps & { readonly finding: SupplementalFindingDescriptor }) {
  const evidenceSignature = supplementalEvidenceSignature(finding.evidence);
  const resolution = findSupplementalFindingResolution(
    resolutions,
    finding,
    expectedChapterVersionId,
  );
  const busy = actionsDisabled || busyIssue?.startsWith(`${finding.id}:supplemental:`) === true;
  if (finding.evidence.length === 0) {
    return (
      <InlineAlert
        tone="warning"
        title="缺少精确证据，不能保存处置"
        description="请补充带不可变版本、原文位置和内容校验值的证据后重新检查。"
      />
    );
  }
  if (evidenceSignature.length > 5_000) {
    return (
      <InlineAlert
        tone="warning"
        title="证据范围过大，不能保存处置"
        description="请缩小本次检查范围或拆分提醒后重新检查；正文和正式设定没有改变。"
      />
    );
  }
  return (
    <div className="settings-actions" aria-label="检查提醒处理操作">
      {resolution === undefined ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            loading={busyIssue === `${finding.id}:supplemental:ignore`}
            disabled={busy}
            onClick={() => onResolve(finding, "ignore")}
          >
            忽略
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={busyIssue === `${finding.id}:supplemental:allow`}
            disabled={busy}
            onClick={() => onResolve(finding, "allow")}
          >
            标记为允许
          </Button>
        </>
      ) : (
        <>
          <span>{resolution.action === "ignore" ? "已忽略" : "已标记为允许"}</span>
          <Button
            size="sm"
            variant="secondary"
            loading={busyIssue === `${finding.id}:supplemental:undo`}
            disabled={busy}
            onClick={() => onUndo(finding, resolution)}
          >
            恢复为待处理
          </Button>
        </>
      )}
    </div>
  );
}

function SupplementalEvidenceList({
  evidence,
}: {
  readonly evidence: readonly SupplementalFindingEvidenceIdentity[];
}) {
  const uniqueEvidence = uniqueSupplementalEvidence(evidence);
  return (
    <div>
      <h4>原文证据</h4>
      <ul className="privacy-list">
        {uniqueEvidence.map((source) => (
          <li
            key={`${source.sourceVersionId}:${source.contentHash}:${String(source.startOffset)}:${String(source.endOffset)}`}
          >
            “{source.excerpt}”
            <br />
            <small>
              {evidenceSourceLabel(source.sourceKind)} · 已绑定对应不可变版本 · 位置
              {source.startOffset}–{source.endOffset}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function uniqueSupplementalEvidence(
  evidence: readonly SupplementalFindingEvidenceIdentity[],
): readonly SupplementalFindingEvidenceIdentity[] {
  const unique = new Map<string, SupplementalFindingEvidenceIdentity>();
  evidence.forEach((source) => {
    const identity = `${source.sourceVersionId}:${source.contentHash}:${String(source.startOffset)}:${String(source.endOffset)}`;
    if (!unique.has(identity)) unique.set(identity, source);
  });
  return Object.freeze([...unique.values()]);
}

function NarrativeEvidenceMissing() {
  return (
    <InlineAlert
      tone="warning"
      title="尚无足够证据"
      description="需要已确认且带原文位置的结构化资料；系统不会从自然语言中盲猜。"
    />
  );
}

function NarrativeEvidenceList({ evidence }: { evidence: readonly NarrativeEvidenceReference[] }) {
  if (evidence.length === 0) {
    return null;
  }
  return (
    <details>
      <summary>查看证据（{evidence.length}）</summary>
      <ul>
        {evidence.map((source) => (
          <li
            key={`${source.sourceKind}:${source.sourceId}:${source.sourceVersionId}:${String(source.startOffset)}`}
          >
            <span>“{source.excerpt}”</span>
            <br />
            <small>
              {evidenceSourceLabel(source.sourceKind)} · 已绑定对应不可变版本 · 位置
              {source.startOffset}–{source.endOffset}
            </small>
          </li>
        ))}
      </ul>
    </details>
  );
}

function analyzedValue<Value>(field: NarrativeAnalysisField<Value>): Value | null {
  return field.status === "analyzed" ? field.value : null;
}

function characterVoiceIssueSummary(issue: ChapterCharacterVoicePovIssue): string {
  return issue.kind === "character_voice_deviation"
    ? "一位已确认人物的当前表达与已确认历史台词存在明显差异。"
    : "一位已确认人物在当前片段中的知识状态与已确认记录存在冲突。";
}

function evidenceSourceLabel(sourceKind: string): string {
  const labels: Readonly<Record<string, string>> = {
    chapter: "章节原文",
    chapter_version: "章节版本",
    story_fact: "已确认事实",
    character_state: "人物状态",
    relationship: "人物关系",
    timeline: "时间线",
    world_rule: "世界规则",
    causal_event: "因果事件",
    outline: "规划资料",
    scene_metric: "场景指标",
    foreshadow: "伏笔记录",
    import: "导入资料",
  };
  return labels[sourceKind] ?? "已确认资料";
}

function analyzedEvidence(
  ...fields: readonly NarrativeAnalysisField<unknown>[]
): readonly NarrativeEvidenceReference[] {
  const evidence = new Map<string, NarrativeEvidenceReference>();
  fields.forEach((field) => {
    if (field.status !== "analyzed") {
      return;
    }
    field.evidence.forEach((source) =>
      evidence.set(
        `${source.sourceKind}:${source.sourceId}:${source.sourceVersionId}:${String(source.startOffset)}:${String(source.endOffset)}`,
        source,
      ),
    );
  });
  return [...evidence.values()];
}

function booleanMeasurement<
  Value extends { readonly advances?: boolean; readonly changes?: boolean },
>(field: NarrativeAnalysisField<Value>, yes: string, no: string): string {
  if (field.status === "skipped") {
    return "尚无足够证据";
  }
  const measured = field.value.advances ?? field.value.changes;
  return measured === undefined ? "尚无足够证据" : measured ? yes : no;
}

function narrativeLabel(value: string | null, fallback: string): string {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : fallback;
}

function chapterDisplayLabel(chapters: readonly Chapter[], chapterId: string): string {
  const title = chapters.find(({ id }) => id === chapterId)?.title.trim() ?? "";
  return title.length > 0 ? `《${title}》` : "相关章节";
}

function qualityFindingLabel(
  finding: NarrativeQualityFinding,
  chapters: readonly Chapter[],
  sceneLabels: ReadonlyMap<string, string>,
): string {
  switch (finding.kind) {
    case "scene_changes_neither_plot_nor_character":
      return `“${sceneLabels.get(finding.sceneId) ?? "相关场景"}”既未推进剧情，也未改变人物状态。`;
    case "repeated_scene_function": {
      const labels = finding.sceneIds.map(
        (sceneId, index) => sceneLabels.get(sceneId) ?? `相关场景 ${String(index + 1)}`,
      );
      return `${labels.join("、")}承担了重复的叙事功能。`;
    }
    case "climax_missing_required_setup":
      return `“${sceneLabels.get(finding.sceneId) ?? "高潮场景"}”缺少 ${String(finding.missingSetupBeatIds.length)} 项明确要求的铺垫。`;
    case "consecutive_chapters_have_similar_pacing": {
      const chapterLabels = finding.chapterIds.map((chapterId, index) => {
        const label = chapterDisplayLabel(chapters, chapterId);
        return label === "相关章节" ? `相关章节 ${String(index + 1)}` : label;
      });
      return `连续章节 ${chapterLabels.join("、")} 的已测节奏过于相似。`;
    }
  }
}

function qualityFindingSuggestion(finding: NarrativeQualityFinding): string {
  switch (finding.kind) {
    case "scene_changes_neither_plot_nor_character":
      return "为该场景补充明确的剧情推进或人物状态变化；如果它有意承担停顿、氛围或对照功能，可以标记为允许。";
    case "repeated_scene_function":
      return "合并重复功能的场景，或让后一个场景承担新的冲突、信息或人物变化。";
    case "climax_missing_required_setup":
      return "在高潮前补齐列出的铺垫节点，或重新确认高潮场景声明的必需铺垫。";
    case "consecutive_chapters_have_similar_pacing":
      return "调整相邻章节的冲突强度、张力走势或内容比例，形成可感知的节奏变化。";
  }
}

function plotlineStateLabel(state: "active" | "stagnant" | "not_started"): string {
  return state === "stagnant" ? "长期未推进" : state === "active" ? "正在推进" : "尚未开始";
}

function dependencyStatusLabel(status: "pending" | "satisfied" | "blocked"): string {
  return status === "pending" ? "等待满足" : status === "satisfied" ? "已满足" : "受阻";
}

function foreshadowStateLabel(state: "not_started" | "active" | "revealed" | "resolved"): string {
  return state === "not_started"
    ? "尚未埋设"
    : state === "active"
      ? "正在推进"
      : state === "revealed"
        ? "已经揭示"
        : "已经回收";
}

function foreshadowIssueLabel(
  kind: "missing_plant" | "duplicate_plant" | "progress_after_resolution",
): string {
  return kind === "missing_plant"
    ? "出现推进记录，但缺少明确埋设证据。"
    : kind === "duplicate_plant"
      ? "同一伏笔被重复标记为埋设。"
      : "伏笔已经回收后仍出现新的推进记录。";
}

function foreshadowIssueSuggestion(
  kind: "missing_plant" | "duplicate_plant" | "progress_after_resolution",
): string {
  return kind === "missing_plant"
    ? "补充有原文依据的埋设记录，或把当前记录改成独立线索。"
    : kind === "duplicate_plant"
      ? "合并重复的埋设记录；若是有意二次强化，可以标记为允许。"
      : "移除回收后的推进记录，或明确建立新的伏笔分支。";
}

function tensionTrendLabel(trend: "rising" | "falling" | "flat"): string {
  return trend === "rising" ? "上升" : trend === "falling" ? "下降" : "平稳";
}

function formatDecimal(value: number): string {
  return value.toFixed(2);
}

function formatPercent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

function DeterministicCoverageSummary({
  coverage,
}: {
  readonly coverage: readonly ChapterValidationCoverageItem[] | undefined;
}) {
  if (coverage === undefined) {
    return (
      <InlineAlert
        tone="warning"
        title="旧检查快照没有记录覆盖范围"
        description="不能判断哪些类别实际运行。请重新检查本章；旧结果不会被当作完整通过。"
      />
    );
  }
  const checked = coverage.filter(({ status }) => status === "checked");
  const missing = coverage.filter(({ status }) => status === "not_checked");
  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={3}>本次实际检查范围</CardTitle>
        <CardDescription>
          “已检查”只表示至少一条明确原文事实与同对象、同属性、同生效区间的确认资料完成比较，不代表整类内容已被完整提取。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="settings-grid">
          <div>
            <h4>已检查（{checked.length}）</h4>
            {checked.length === 0 ? (
              <p>没有类别具备完整比较条件。</p>
            ) : (
              <ul className="privacy-list">
                {checked.map((item) => (
                  <li key={item.category}>
                    <strong>{coverageCategoryLabels[item.category]}</strong>：比较{" "}
                    {item.currentClaimCount} 条当前主张、{item.comparableReferenceCount}{" "}
                    条确认事实和 {item.applicableHardRuleCount} 条锁定规则。
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4>因证据不足未检查（{missing.length}）</h4>
            {missing.length === 0 ? (
              <p>所有已声明类别都有可比较资料。</p>
            ) : (
              <ul className="privacy-list">
                {missing.map((item) => (
                  <li key={item.category}>
                    <strong>{coverageCategoryLabels[item.category]}</strong>：
                    {coverageReasonLabel(item)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function coverageReasonLabel(item: ChapterValidationCoverageItem): string {
  switch (item.reason) {
    case "current_claim_missing":
      return "本章没有带精确原文位置的明确主张。";
    case "confirmed_reference_or_rule_missing":
      return "没有已确认设定或锁定规则可供比较。";
    case "no_comparable_source":
      return "现有资料的对象、属性、分支或生效区间不重合。";
    case "explicit_claim_compared":
      return "已完成比较。";
  }
}

function SkippedCheckResult({ result }: { result: ChapterNovelValidationResult }) {
  return (
    <InlineAlert
      tone="warning"
      title="本章暂时没有足够证据完成检查"
      description={
        <div>
          <p>系统没有报告问题，因为缺少以下条件：</p>
          <ul>
            {result.missingRequirements.map((requirement) => (
              <li key={requirement}>
                {missingRequirementLabels[requirement] ?? "需要补充可核验的结构化故事资料。"}
              </li>
            ))}
          </ul>
          {result.skippedFacts.length > 0 && (
            <p>另有 {result.skippedFacts.length} 条资料因证据、确认状态或分支不匹配而未参与。</p>
          )}
        </div>
      }
    />
  );
}

function IssueCard({
  actionsDisabled,
  busyIssue,
  issue,
  onCreateCandidate,
  onResolve,
  onUndoIgnore,
}: {
  readonly actionsDisabled: boolean;
  readonly busyIssue: string | null;
  readonly issue: ChapterValidationUiIssue;
  readonly onCreateCandidate: () => void;
  readonly onResolve: (action: ChapterValidationUiAction) => void;
  readonly onUndoIgnore: () => void;
}) {
  const busy = actionsDisabled || busyIssue?.startsWith(`${issue.id}:`) === true;
  return (
    <Card className="chapter-check-issue">
      <CardHeader>
        <div className="card-heading-row">
          <CardTitle>{issueLabels[issue.type]}</CardTitle>
          <Badge tone={issue.severity === "error" ? "danger" : "warning"}>
            {issue.severity === "error" ? "需要处理" : "建议复核"}
          </Badge>
        </div>
        {issue.resolution.status !== "unresolved" && (
          <CardDescription>
            {issue.resolution.status === "ignored"
              ? "已忽略（可以撤销）"
              : issue.resolution.status === "allowed"
                ? "已标记为允许，并建立了锁定规则"
                : "已用当前正文更新正式设定"}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="chapter-check-evidence-grid">
          <EvidencePanel title="当前原文" evidence={issue.currentEvidence}>
            <blockquote>{issue.currentTextExcerpt}</blockquote>
          </EvidencePanel>
          <EvidencePanel title="冲突设定" evidence={issue.conflictingEvidence}>
            <p>{issue.conflictingFact.statement}</p>
            <p className="chapter-check-fact-value">
              记录值：{formatFactValue(issue.conflictingFact.value)}
            </p>
          </EvidencePanel>
        </div>
        <div className="chapter-check-suggestion">
          <strong>修改建议</strong>
          <p>{localizedSuggestion(issue)}</p>
        </div>
        <div className="settings-actions" aria-label={`${issueLabels[issue.type]}处理操作`}>
          {issue.resolution.status === "unresolved" ? (
            <>
              <Button
                size="sm"
                variant="ai-primary"
                loading={busyIssue === `${issue.id}:create_candidate`}
                disabled={busy || issue.currentEvidence.length === 0}
                onClick={onCreateCandidate}
              >
                按设定生成修改建议
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busyIssue === `${issue.id}:ignore`}
                disabled={busy}
                onClick={() => onResolve("ignore")}
              >
                忽略
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={busyIssue === `${issue.id}:allow`}
                disabled={busy}
                onClick={() => onResolve("allow")}
              >
                标记为允许
              </Button>
              <Button
                size="sm"
                loading={busyIssue === `${issue.id}:update_setting`}
                disabled={busy}
                onClick={() => onResolve("update_setting")}
              >
                用当前正文更新正式设定
              </Button>
            </>
          ) : issue.canUndoIgnore ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busyIssue === `${issue.id}:undo`}
              disabled={busy}
              onClick={onUndoIgnore}
            >
              撤销忽略
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function EvidencePanel({
  children,
  evidence,
  title,
}: {
  readonly children: ReactNode;
  readonly evidence: readonly ChapterValidationUiEvidence[];
  readonly title: string;
}) {
  return (
    <section className="chapter-check-evidence">
      <h4>{title}</h4>
      {children}
      <details>
        <summary>查看来源</summary>
        <ul>
          {evidence.map((source) => (
            <li key={`${source.sourceVersionId}:${String(source.startOffset)}`}>
              <span>{evidenceSourceLabel(source.sourceKind)}</span>
              <span>已绑定对应不可变版本</span>
              <span>
                位置 {source.startOffset}–{source.endOffset}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function ResolutionHistory({
  resolutions,
}: {
  readonly resolutions: readonly ChapterValidationResolutionSummary[];
}) {
  return (
    <details>
      <summary>本版本处理记录（{resolutions.length}）</summary>
      <ul className="chapter-check-history">
        {resolutions.map((resolution) => (
          <li key={resolution.factId}>
            <strong>{resolutionActionLabel(resolution.action)}</strong>
            <span>{resolutionStateLabel(resolution.state)}</span>
            <time dateTime={resolution.decidedAt}>{formatTimestamp(resolution.decidedAt)}</time>
          </li>
        ))}
      </ul>
    </details>
  );
}

function localizedSuggestion(issue: ChapterValidationUiIssue): string {
  switch (issue.type) {
    case "timeline_conflict":
    case "location_conflict":
      return "让当前段落与已确认的时间和地点一致；如果正文才是正确版本，可以用当前正文更新正式设定。";
    case "world_hard_rule_conflict":
      return "修改当前段落以遵守锁定规则，或在确实属于有意例外时标记为允许。";
    case "pov_boundary_violation":
      return "删去当前视角尚不知道的信息，补充取得信息的事件，或调整本场景视角。";
    case "knowledge_boundary_conflict":
      return "修改知情描述，或先补充有证据的信息取得事件。";
    default:
      return "修改当前段落以符合已确认设定；如果正文才是正确版本，可以更新正式设定。";
  }
}

function formatFactValue(value: ChapterValidationUiIssue["conflictingFact"]["value"]): string {
  return Array.isArray(value) ? value.join("、") : String(value);
}

function actionNoticeFor(action: ChapterValidationUiAction): string {
  if (action === "ignore") {
    return "已保存忽略记录；它只作用于这条问题和当前章节版本，并可随时撤销。";
  }
  if (action === "allow") {
    return "已建立并锁定允许规则；原正文没有改变。";
  }
  return "已创建用户确认的正式事实，并停用被替换设定；原正文没有改变。";
}

function resolutionActionLabel(action: ChapterValidationUiAction): string {
  return action === "ignore" ? "忽略" : action === "allow" ? "标记为允许" : "更新正式设定";
}

function resolutionStateLabel(state: ChapterValidationResolutionSummary["state"]): string {
  return state === "active" ? "当前有效" : state === "undone" ? "已撤销" : "尚未完整应用";
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toLocaleString("zh-CN");
}

function advancedProjectTools(runtime: ReturnType<typeof useRuntime>, projectRoot: string) {
  return [
    {
      available: true,
      label: "创作资料",
      to: `${projectRoot}/materials`,
      description: "整理写作参考资料。这里的内容不会被自动当作正式故事事实。",
    },
    {
      available: true,
      label: "查找相关正文",
      to: `${projectRoot}/search`,
      description: "从已保存的正文和大纲中查找证据，不读取未接受的 AI 建议版本。",
    },
    {
      available: true,
      label: "查看故事关联",
      to: `${projectRoot}/graph`,
      description: "查看已经建立的故事关联；这不代表系统已经完成一致性检查。",
    },
    {
      available:
        runtime.featureFlags.authoritativeExtraction && runtime.authoritativeExtraction !== null,
      label: "从正文更新设定",
      to: `${projectRoot}/extraction`,
      description: "提取待确认的设定变化，重大事实仍需由用户确认。",
    },
    {
      available: runtime.featureFlags.multiAgent && runtime.multiAgentReview !== null,
      label: "深度审稿",
      to: `${projectRoot}/multi-agent-review`,
      description: "按需启动更深入的审阅；进入页面本身不会自动调用模型。",
    },
    {
      available: runtime.cloudSyncControl !== null,
      label: "备份与同步",
      to: `${projectRoot}/sync`,
      description: "处理项目备份和同步状态，与正文质量检查相互独立。",
    },
  ].filter((tool) => tool.available);
}
