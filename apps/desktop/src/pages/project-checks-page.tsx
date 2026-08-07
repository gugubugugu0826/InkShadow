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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  type ChapterNovelValidationResult,
  type ChapterValidationResolutionSummary,
  type ChapterValidationUiAction,
  type ChapterValidationUiEvidence,
  type ChapterValidationUiIssue,
} from "../infrastructure/novel-validation-runtime";
import type { ChapterNarrativeAnalysisResult } from "../infrastructure/narrative-analysis-runtime";
import type {
  ChapterCharacterVoicePovIssue,
  ChapterCharacterVoicePovRuntimeResult,
} from "../infrastructure/chapter-character-voice-pov-runtime";
import type {
  AmbiguousNovelReviewEvidence,
  AmbiguousNovelReviewFinding,
  AmbiguousNovelReviewResult,
  AmbiguousNovelReviewTask,
} from "../infrastructure/ambiguous-novel-review-service";
import { normalizeUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

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
};

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
  const [busyIssue, setBusyIssue] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(
    parsedProjectId.ok ? null : parsedProjectId.error,
  );
  const [operationError, setOperationError] = useState<unknown>(null);
  const [result, setResult] = useState<ChapterNovelValidationResult | null>(null);
  const [narrativeResult, setNarrativeResult] = useState<ChapterNarrativeAnalysisResult | null>(
    null,
  );
  const [voicePovResult, setVoicePovResult] =
    useState<ChapterCharacterVoicePovRuntimeResult | null>(null);
  const [ambiguousReviewResult, setAmbiguousReviewResult] =
    useState<AmbiguousNovelReviewResult | null>(null);
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
        const [checked, narrative, voicePov] = await Promise.all([
          runtime.story.chapterValidation.checkChapter({
            projectId,
            chapterId: chapterId.value,
          }),
          runtime.story.narrativeAnalysis.analyzeChapter({
            projectId,
            chapterId: chapterId.value,
          }),
          runtime.story.characterVoicePov.check({
            projectId,
            chapterId: chapterId.value,
          }),
        ]);
        setResult(checked);
        setNarrativeResult(narrative);
        setVoicePovResult(voicePov);
        const ambiguous = await runtime.story.ambiguousReview.review({
          projectId,
          chapterId: chapterId.value,
          expectedChapterVersionId: checked.chapterVersionId,
        });
        setAmbiguousReviewResult(ambiguous);
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

  const normalizedLoadError = loadError === null ? null : normalizeUiError(loadError);
  const normalizedOperationError =
    operationError === null ? null : normalizeUiError(operationError);
  const unresolvedCount =
    result?.issues.filter(({ resolution }) => resolution.status === "unresolved").length ?? 0;
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

      {normalizedLoadError !== null ? (
        <ErrorState
          title={normalizedLoadError.title}
          description={normalizedLoadError.description}
          errorCode={normalizedLoadError.code}
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
                      setResult(null);
                      setNarrativeResult(null);
                      setVoicePovResult(null);
                      setAmbiguousReviewResult(null);
                      setOperationError(null);
                      setActionNotice(null);
                    }}
                  />
                )}
              </FormField>
              <Button
                loading={checking}
                loadingLabel="正在检查"
                disabled={selectedChapterId.length === 0 || busyIssue !== null}
                onClick={() => void runCheck(selectedChapterId)}
              >
                检查本章
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {normalizedOperationError !== null && (
        <InlineAlert
          tone="error"
          title={normalizedOperationError.title}
          description={`${normalizedOperationError.description}（${normalizedOperationError.code}）`}
        />
      )}
      {actionNotice !== null && <InlineAlert title="处理结果已保存" description={actionNotice} />}

      <section aria-labelledby="check-results-heading">
        <div className="section-heading">
          <div>
            <h2 id="check-results-heading">确定性检查</h2>
            <p>这里先运行可由明确规则和精确证据判断的检查；处理操作不会改动正文。</p>
          </div>
          {result !== null && (
            <Badge tone={unresolvedCount === 0 ? "success" : "warning"}>
              {unresolvedCount} 项待处理
            </Badge>
          )}
        </div>
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
            description="本次确定性检查已经完成。它不会把缺少证据的猜测显示成问题；章节正文没有改变。"
          />
        ) : (
          <div className="chapter-check-results">
            {result.issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                busyIssue={busyIssue}
                onResolve={(action) => void resolveIssue(issue, action)}
                onUndoIgnore={() => void undoIgnore(issue)}
              />
            ))}
          </div>
        )}
      </section>

      {narrativeResult !== null && <NarrativeAnalysisSections result={narrativeResult} />}

      {voicePovResult !== null && <CharacterVoicePovSection result={voicePovResult} />}

      {ambiguousReviewResult !== null && (
        <>
          <AmbiguousNovelReviewSection result={ambiguousReviewResult} />
          <ContentQualityReviewSection result={ambiguousReviewResult} />
        </>
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

const ambiguousReviewTaskLabels: Readonly<Record<AmbiguousNovelReviewTask, string>> = {
  contradiction_check: "语义矛盾复核",
  pov_check: "视角与知情边界复核",
  character_voice_check: "人物说话方式复核",
  content_quality_check: "内容质量复核",
};

function AmbiguousNovelReviewSection({ result }: { result: AmbiguousNovelReviewResult }) {
  const tasks = result.tasks.filter(({ task }) => task !== "content_quality_check");
  const findings = result.findings.filter(({ task }) => task !== "content_quality_check");
  const reviewedCount = tasks.filter(({ status }) => status === "reviewed").length;
  return (
    <section aria-labelledby="ambiguous-review-heading">
      <div className="section-heading">
        <div>
          <p className="page-heading__eyebrow">与确定性检查分开显示</p>
          <h2 id="ambiguous-review-heading">AI 模糊复核</h2>
          <p>
            仅在模型具备经过验证的文本生成与结构化输出能力、且精确证据充足时运行。所有发现都需要人工判断。
          </p>
        </div>
        <Badge tone={findings.length > 0 ? "warning" : "neutral"}>
          {findings.length} 项需要人工判断
        </Badge>
      </div>

      <InlineAlert
        tone="info"
        title="只读复核，不会自动修复"
        description={`本次共有 ${String(reviewedCount)} / ${String(tasks.length)} 项 AI 模糊复核实际运行。未运行、证据不足或返回内容未通过校验的项目都不会显示为通过。`}
      />

      <div className="settings-grid">
        {tasks.map((task) => (
          <Card key={task.task}>
            <CardHeader>
              <div className="card-heading-row">
                <CardTitle headingLevel={3}>{ambiguousReviewTaskLabels[task.task]}</CardTitle>
                <Badge
                  tone={
                    task.status === "reviewed"
                      ? task.findings.length > 0
                        ? "warning"
                        : "neutral"
                      : task.status === "failed"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {task.status === "reviewed"
                    ? `${String(task.findings.length)} 项需判断`
                    : "未运行 / 证据不足"}
                </Badge>
              </div>
              <CardDescription>{task.explanation}</CardDescription>
            </CardHeader>
            <CardContent>
              {task.invocation === null ? (
                <p>
                  <small>没有可展示的已验证模型调用。</small>
                </p>
              ) : (
                <p>
                  <small>
                    调用记录 {task.invocation.id} · {task.invocation.providerKind} /{" "}
                    {task.invocation.modelId}
                    {task.invocation.usedFallback ? " · 已使用备用模型" : ""}
                  </small>
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {findings.length === 0 ? (
        <InlineAlert
          tone="info"
          title={reviewedCount === 0 ? "本次 AI 复核未运行" : "AI 没有提出新的人工判断项"}
          description={
            reviewedCount === 0
              ? "请查看上方每项的模型配置或证据说明。这里不会把未运行显示成通过。"
              : "这只代表实际运行且证据充足的项目没有返回发现，不代表未运行项目或整章已经通过。"
          }
        />
      ) : (
        <div className="chapter-check-results">
          {findings.map((finding) => (
            <AmbiguousNovelReviewFindingCard key={finding.id} finding={finding} />
          ))}
        </div>
      )}
    </section>
  );
}

function ContentQualityReviewSection({ result }: { result: AmbiguousNovelReviewResult }) {
  const task = result.tasks.find(({ task: taskName }) => taskName === "content_quality_check");
  if (task === undefined) {
    return null;
  }
  return (
    <section aria-labelledby="content-quality-review-heading">
      <div className="section-heading">
        <div>
          <p className="page-heading__eyebrow">与确定性检查分开显示</p>
          <h2 id="content-quality-review-heading">AI 内容质量建议</h2>
          <p>
            复核场景目标与因果、节奏与张力、信息密度、对话/描写/内心活动比例、重复功能场景、高潮铺垫和章节目标。
          </p>
        </div>
        <Badge
          tone={
            task.status === "reviewed" && task.findings.length > 0
              ? "warning"
              : task.status === "failed"
                ? "danger"
                : "neutral"
          }
        >
          {task.status === "reviewed"
            ? `${String(task.findings.length)} 项 AI 建议`
            : "未运行 / 证据不足"}
        </Badge>
      </div>

      <InlineAlert
        tone="info"
        title="AI 建议，需要作者判断"
        description="这是基于当前不可变章节版本和已确认资料的只读主观复核，不是质量总分，也不会修改正文、候选版本或正式故事设定。"
      />

      <Card>
        <CardHeader>
          <CardTitle headingLevel={3}>本次运行状态</CardTitle>
          <CardDescription>{task.explanation}</CardDescription>
        </CardHeader>
        <CardContent>
          {task.invocation === null ? (
            <p>
              <small>没有可展示的已验证模型调用。</small>
            </p>
          ) : (
            <p>
              <small>
                调用记录 {task.invocation.id} · {task.invocation.providerKind} /{" "}
                {task.invocation.modelId}
                {task.invocation.usedFallback ? " · 已使用备用模型" : ""}
              </small>
            </p>
          )}
        </CardContent>
      </Card>

      {task.status === "reviewed" && task.findings.length === 0 ? (
        <InlineAlert
          tone="info"
          title="AI 没有提出新的内容质量建议"
          description="这只表示本次实际运行的主观复核没有返回建议，不代表章节已经通过，也不替代作者判断。"
        />
      ) : task.findings.length > 0 ? (
        <div className="chapter-check-results">
          {task.findings.map((finding) => (
            <AmbiguousNovelReviewFindingCard key={finding.id} finding={finding} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AmbiguousNovelReviewFindingCard({ finding }: { finding: AmbiguousNovelReviewFinding }) {
  return (
    <Card>
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <CardTitle headingLevel={3}>{finding.title}</CardTitle>
            <CardDescription>
              {ambiguousReviewTaskLabels[finding.task]} · AI 建议，需要人工判断
            </CardDescription>
          </div>
          <Badge tone={finding.severity === "error" ? "danger" : "warning"}>
            {finding.severity === "error" ? "严重" : "需要留意"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p>{finding.explanation}</p>
        <AmbiguousNovelReviewEvidenceList evidence={finding.evidence} />
        <InlineAlert tone="info" title="修改建议" description={finding.suggestion} />
      </CardContent>
    </Card>
  );
}

function AmbiguousNovelReviewEvidenceList({
  evidence,
}: {
  evidence: readonly AmbiguousNovelReviewEvidence[];
}) {
  return (
    <div>
      <h4>精确证据</h4>
      <ul className="privacy-list">
        {evidence.map((source) => (
          <li key={source.id}>
            <strong>{ambiguousEvidenceRoleLabel(source.role)}</strong>：“{source.excerpt}”
            <br />
            <small>
              版本 {source.chapterVersionId} · {source.locator} · UTF-16 {source.startOffset}–
              {source.endOffset}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ambiguousEvidenceRoleLabel(role: AmbiguousNovelReviewEvidence["role"]): string {
  const labels: Readonly<Record<AmbiguousNovelReviewEvidence["role"], string>> = {
    current_chapter: "当前正文",
    confirmed_fact: "已确认设定",
    locked_rule: "锁定规则",
    current_pov_claim: "当前视角原文",
    confirmed_knowledge: "已确认知情范围",
    current_dialogue: "当前台词",
    historical_dialogue: "历史台词",
  };
  return labels[role];
}

function CharacterVoicePovSection({ result }: { result: ChapterCharacterVoicePovRuntimeResult }) {
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
          {result.issues.map((issue) => (
            <CharacterVoicePovIssueCard key={issue.id} issue={issue} />
          ))}
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

function CharacterVoicePovIssueCard({ issue }: { issue: ChapterCharacterVoicePovIssue }) {
  return (
    <Card>
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <CardTitle headingLevel={3}>{issue.title}</CardTitle>
            <CardDescription>{issue.summary}</CardDescription>
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
                版本 {source.chapterVersionId} · {source.locator}
              </small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NarrativeAnalysisSections({ result }: { result: ChapterNarrativeAnalysisResult }) {
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

      <NarrativePlotlineSection result={result} />
      <NarrativeForeshadowSection result={result} />
      <NarrativePacingSection result={result} />

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

function NarrativePlotlineSection({ result }: { result: ChapterNarrativeAnalysisResult }) {
  const analysis = result.analysis;
  if (analysis === null) {
    return null;
  }
  const conflicts = analysis.timeLocationConflicts;
  const hasContent = analysis.plotlines.length > 0;
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
            const goal = analyzedValue(plotline.goal);
            const stagnation = analyzedValue(plotline.stagnation);
            const latest = analyzedValue(plotline.latestProgress);
            const characters = analyzedValue(plotline.characterIds);
            const dependencies = analyzedValue(plotline.dependencies);
            const convergences = analyzedValue(plotline.upcomingConvergences);
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
                    <CardTitle headingLevel={4}>{goal ?? "未命名剧情线"}</CardTitle>
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
                        : `${latest.summary}（章节 ${latest.chapterId}）`}
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
                      {characters === null ? "尚无足够证据" : listOrNone(characters)}
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
                                  `${dependency.toPlotlineId}（${dependencyStatusLabel(dependency.status)}）`,
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
            <ul className="privacy-list">
              {conflicts.value.map((conflict) => (
                <li key={conflict.id}>
                  <strong>{conflict.characterId}</strong> 在故事时间{" "}
                  {conflict.overlappingStoryTime.start}–{conflict.overlappingStoryTime.end}{" "}
                  同时出现在 {conflict.locationIds.join(" 和 ")}。
                  <NarrativeEvidenceList evidence={conflict.evidence} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function NarrativeForeshadowSection({ result }: { result: ChapterNarrativeAnalysisResult }) {
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
          {analysis.foreshadows.map((foreshadow) => {
            if (foreshadow.progress.status === "skipped") {
              return (
                <Card key={foreshadow.foreshadowId}>
                  <CardHeader>
                    <CardTitle headingLevel={4}>{foreshadow.foreshadowId}</CardTitle>
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
                    <CardTitle headingLevel={4}>{foreshadow.foreshadowId}</CardTitle>
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
                    <ul className="privacy-list">
                      {progress.sequenceIssues.map((issue) => (
                        <li key={`${issue.kind}:${issue.progressId}`}>
                          {foreshadowIssueLabel(issue.kind)}
                        </li>
                      ))}
                    </ul>
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

function NarrativePacingSection({ result }: { result: ChapterNarrativeAnalysisResult }) {
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
            <ul className="privacy-list">
              {analysis.qualityFindings.map((finding, index) => (
                <li key={`${finding.kind}:${String(index)}`}>
                  {qualityFindingLabel(finding)}
                  <NarrativeEvidenceList evidence={finding.evidence} />
                </li>
              ))}
            </ul>
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
                <strong>
                  {scene.goal.status === "analyzed" ? scene.goal.value : `场景 ${scene.sceneId}`}
                </strong>
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
            <span>{source.locator}</span>
            <code>{source.sourceVersionId}</code>
            <span>
              位置 {source.startOffset}–{source.endOffset}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function analyzedValue<Value>(field: NarrativeAnalysisField<Value>): Value | null {
  return field.status === "analyzed" ? field.value : null;
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

function qualityFindingLabel(finding: NarrativeQualityFinding): string {
  switch (finding.kind) {
    case "scene_changes_neither_plot_nor_character":
      return `场景 ${finding.sceneId} 既未推进剧情，也未改变人物状态。`;
    case "repeated_scene_function":
      return `场景 ${finding.sceneIds.join("、")} 承担了重复的叙事功能。`;
    case "climax_missing_required_setup":
      return `高潮场景 ${finding.sceneId} 缺少明确要求的铺垫：${finding.missingSetupBeatIds.join("、")}。`;
    case "consecutive_chapters_have_similar_pacing":
      return `连续章节 ${finding.chapterIds.join("、")} 的已测节奏过于相似。`;
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

function tensionTrendLabel(trend: "rising" | "falling" | "flat"): string {
  return trend === "rising" ? "上升" : trend === "falling" ? "下降" : "平稳";
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "没有已确认记录" : values.join("、");
}

function formatDecimal(value: number): string {
  return value.toFixed(2);
}

function formatPercent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
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
  busyIssue,
  issue,
  onResolve,
  onUndoIgnore,
}: {
  readonly busyIssue: string | null;
  readonly issue: ChapterValidationUiIssue;
  readonly onResolve: (action: ChapterValidationUiAction) => void;
  readonly onUndoIgnore: () => void;
}) {
  const busy = busyIssue?.startsWith(`${issue.id}:`) === true;
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
              <span>{source.locator}</span>
              <code>{source.sourceVersionId}</code>
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
            <code>{resolution.factId}</code>
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
