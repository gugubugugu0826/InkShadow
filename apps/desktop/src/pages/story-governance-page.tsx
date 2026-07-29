import { useCallback, useEffect, useMemo, useState } from "react";
import type { Chapter, Project } from "@inkshadow/domain";
import { parseUuidV7 as parseDomainUuid } from "@inkshadow/domain";
import {
  FORMAL_RECORD_KINDS,
  MEMORY_LEVELS,
  StoryCoreError,
  parseUuidV7 as parseStoryUuid,
  type FormalRecordKind,
  type FormalStoryRecord,
  type FormalTimelineSnapshot,
  type DecideReviewItemCommand,
  type MemoryLevel,
  type MemoryPolicy,
  type MemoryRecord,
  type MemorySourceKind,
  type OutlineDraftCandidate,
  type ReviewItemStatus,
  type ReviewItemType,
  type ReviewSeverity,
  type StoryValue,
  type StructuredReviewItem,
  type WhatIfBranch,
  type WhatIfComparison,
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
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PageStateBoundary,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@inkshadow/ui";
import { Link, useParams } from "react-router-dom";

import { normalizeUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

const FORMAL_KIND_OPTIONS = FORMAL_RECORD_KINDS.map((kind) => ({
  value: kind,
  label: formalKindLabel(kind),
}));

const MEMORY_LEVEL_OPTIONS = MEMORY_LEVELS.map((level) => ({
  value: level,
  label: memoryLevelLabel(level),
}));

type FormalDialog =
  Readonly<{ mode: "create" }> | Readonly<{ mode: "edit"; record: FormalStoryRecord }>;

type WhatIfDialog =
  | Readonly<{ mode: "create" }>
  | Readonly<{ mode: "simulate"; branch: WhatIfBranch }>
  | Readonly<{ mode: "promote"; branch: WhatIfBranch }>;

type ReviewItem = StructuredReviewItem<"extraction"> | StructuredReviewItem<"consistency">;

export function StoryGovernancePage() {
  const runtime = useRuntime();
  const params = useParams<{ projectId: string }>();
  const projectIdParameter = params.projectId ?? "";
  const domainProjectId = useMemo(() => parseDomainUuid(projectIdParameter), [projectIdParameter]);
  const storyProjectId = useMemo(() => parseStoryUuid(projectIdParameter), [projectIdParameter]);
  const identifierError = !domainProjectId.ok
    ? domainProjectId.error
    : !storyProjectId.ok
      ? storyProjectId.error
      : null;
  const [project, setProject] = useState<Project | null>(null);
  const [records, setRecords] = useState<readonly FormalStoryRecord[]>([]);
  const [policy, setPolicy] = useState<MemoryPolicy | null>(null);
  const [memories, setMemories] = useState<readonly MemoryRecord[]>([]);
  const [timeline, setTimeline] = useState<FormalTimelineSnapshot | null>(null);
  const [whatIfBranches, setWhatIfBranches] = useState<readonly WhatIfBranch[]>([]);
  const [outlineDrafts, setOutlineDrafts] = useState<readonly OutlineDraftCandidate[]>([]);
  const [chapters, setChapters] = useState<readonly Chapter[]>([]);
  const [extractionItems, setExtractionItems] = useState<
    readonly StructuredReviewItem<"extraction">[]
  >([]);
  const [consistencyItems, setConsistencyItems] = useState<
    readonly StructuredReviewItem<"consistency">[]
  >([]);
  const [comparison, setComparison] = useState<WhatIfComparison | null>(null);
  const [activeTab, setActiveTab] = useState("formal");
  const [pageState, setPageState] = useState<"loading" | "ready" | "fatal_error">("loading");
  const [error, setError] = useState<unknown>(identifierError);
  const [busy, setBusy] = useState(false);
  const [formalDialog, setFormalDialog] = useState<FormalDialog | null>(null);
  const [formalKind, setFormalKind] = useState<FormalRecordKind>("character");
  const [formalTitle, setFormalTitle] = useState("");
  const [formalDescription, setFormalDescription] = useState("");
  const [memoryDialog, setMemoryDialog] = useState<MemoryRecord | "create" | null>(null);
  const [memoryLevel, setMemoryLevel] = useState<MemoryLevel>("L2");
  const [memoryContent, setMemoryContent] = useState("");
  const [policyDialogOpen, setPolicyDialogOpen] = useState(false);
  const [whatIfDialog, setWhatIfDialog] = useState<WhatIfDialog | null>(null);
  const [sourceEventId, setSourceEventId] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [effectSummary, setEffectSummary] = useState("");
  const [impactedRecordId, setImpactedRecordId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSynopsis, setDraftSynopsis] = useState("");
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewItemType, setReviewItemType] = useState<ReviewItemType>("extraction");
  const [reviewTargetId, setReviewTargetId] = useState("");
  const [reviewChapterId, setReviewChapterId] = useState("");
  const [reviewEvidence, setReviewEvidence] = useState("");
  const [suggestedTitle, setSuggestedTitle] = useState("");
  const [suggestedDescription, setSuggestedDescription] = useState("");

  const load = useCallback(async () => {
    if (!domainProjectId.ok || !storyProjectId.ok) {
      setPageState("fatal_error");
      return;
    }
    setPageState("loading");
    const [
      projectResult,
      recordResult,
      policyResult,
      memoryResult,
      timelineResult,
      branchResult,
      draftResult,
      chapterResult,
      extractionResult,
      consistencyResult,
    ] = await Promise.all([
      runtime.repositories.projects.findById(domainProjectId.value),
      runtime.story.formalRecords.listByProjectId(storyProjectId.value),
      runtime.story.memoryService.ensureDefaultPolicy(storyProjectId.value),
      runtime.story.memoryRecords.listByProjectId(storyProjectId.value),
      runtime.story.formalRecords.load(storyProjectId.value),
      runtime.story.whatIfBranches.listByProjectId(storyProjectId.value),
      runtime.story.outlineDrafts.listByProjectId(storyProjectId.value),
      runtime.repositories.chapters.listByProjectId(domainProjectId.value),
      runtime.story.extractionItems.listByProjectId(storyProjectId.value),
      runtime.story.consistencyItems.listByProjectId(storyProjectId.value),
    ]);
    const failed = [
      projectResult,
      recordResult,
      policyResult,
      memoryResult,
      timelineResult,
      branchResult,
      draftResult,
      chapterResult,
      extractionResult,
      consistencyResult,
    ].find((result) => !result.ok);
    if (failed !== undefined) {
      setError(failed.error);
      setPageState("fatal_error");
      return;
    }
    if (!projectResult.ok || projectResult.value === null) {
      setError(new Error("项目不存在"));
      setPageState("fatal_error");
      return;
    }
    if (
      !recordResult.ok ||
      !policyResult.ok ||
      !memoryResult.ok ||
      !timelineResult.ok ||
      !branchResult.ok ||
      !draftResult.ok ||
      !chapterResult.ok ||
      !extractionResult.ok ||
      !consistencyResult.ok
    ) {
      return;
    }
    setProject(projectResult.value);
    setRecords(recordResult.value);
    setPolicy(policyResult.value);
    setMemories(memoryResult.value);
    setTimeline(timelineResult.value);
    setWhatIfBranches(branchResult.value);
    setOutlineDrafts(draftResult.value);
    setChapters(chapterResult.value);
    setExtractionItems(extractionResult.value);
    setConsistencyItems(consistencyResult.value);
    setError(null);
    setPageState("ready");
  }, [domainProjectId, runtime, storyProjectId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const readonly = project?.status !== "active";
  const normalizedError = error === null ? null : normalizeUiError(error);
  const reviewItems = useMemo(
    () =>
      [...extractionItems, ...consistencyItems].sort(
        (left, right) =>
          right.toSnapshot().updatedAt.localeCompare(left.toSnapshot().updatedAt) ||
          left.id.localeCompare(right.id),
      ),
    [consistencyItems, extractionItems],
  );

  function openCreateFormalRecord(): void {
    setFormalKind("character");
    setFormalTitle("");
    setFormalDescription("");
    setFormalDialog({ mode: "create" });
  }

  function openEditFormalRecord(record: FormalStoryRecord): void {
    const fields = readFormalFields(record);
    setFormalKind(record.kind);
    setFormalTitle(fields.title);
    setFormalDescription(fields.description);
    setFormalDialog({ mode: "edit", record });
  }

  async function submitFormalRecord(): Promise<void> {
    if (!storyProjectId.ok || formalDialog === null || busy) {
      return;
    }
    setBusy(true);
    const value = {
      title: formalTitle.trim(),
      description: formalDescription.trim(),
    };
    const result =
      formalDialog.mode === "create"
        ? await runtime.story.formalRecordService.create({
            projectId: storyProjectId.value,
            kind: formalKind,
            recordKey: `${formalKind}.${runtime.ids.next().replaceAll("-", "")}`,
            value,
            actorId: runtime.story.actorId,
            humanConfirmed: true,
          })
        : await runtime.story.formalRecordService.edit({
            recordId: formalDialog.record.id,
            value,
            actorId: runtime.story.actorId,
            humanConfirmed: true,
            expectedRevision: formalDialog.record.revision,
          });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setFormalDialog(null);
    setError(null);
    await load();
  }

  async function undoFormalRecord(record: FormalStoryRecord): Promise<void> {
    const snapshot = record.toSnapshot();
    if (snapshot.currentVersion < 2 || busy) {
      return;
    }
    setBusy(true);
    const result = await runtime.story.formalRecordService.undo({
      recordId: record.id,
      targetVersion: snapshot.currentVersion - 1,
      actorId: runtime.story.actorId,
      humanConfirmed: true,
      expectedRevision: record.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    await load();
  }

  function openCreateMemory(): void {
    setMemoryLevel("L2");
    setMemoryContent("");
    setMemoryDialog("create");
  }

  function openEditMemory(record: MemoryRecord): void {
    const snapshot = record.toSnapshot();
    setMemoryLevel(snapshot.level);
    setMemoryContent(snapshot.content);
    setMemoryDialog(record);
  }

  async function submitMemory(): Promise<void> {
    if (!storyProjectId.ok || memoryDialog === null || busy) {
      return;
    }
    setBusy(true);
    const result =
      memoryDialog === "create"
        ? await runtime.story.memoryService.createRecord({
            projectId: storyProjectId.value,
            level: memoryLevel,
            content: memoryContent,
            source: {
              kind: "user_rule",
              sourceId: runtime.story.actorId,
              sourceVersionId: null,
            },
            origin: "user",
            humanConfirmed: true,
          })
        : await runtime.story.memoryService.govern({
            kind: "edit",
            recordId: memoryDialog.id,
            content: memoryContent,
            expectedRevision: memoryDialog.revision,
            humanConfirmed: true,
          });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMemoryDialog(null);
    setError(null);
    await load();
  }

  async function governMemory(
    record: MemoryRecord,
    command:
      | Readonly<{ kind: "set_enabled"; enabled: boolean }>
      | Readonly<{ kind: "pin" }>
      | Readonly<{ kind: "exclude" }>
      | Readonly<{ kind: "downweight"; weight: number }>
      | Readonly<{ kind: "reset_priority" }>,
  ): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    const result = await runtime.story.memoryService.govern({
      ...command,
      recordId: record.id,
      expectedRevision: record.revision,
      humanConfirmed: true,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    await load();
  }

  async function toggleAutomaticLearning(): Promise<void> {
    if (!storyProjectId.ok || policy === null || busy) {
      return;
    }
    setBusy(true);
    const result = await runtime.story.memoryService.setAutomaticLearning({
      projectId: storyProjectId.value,
      enabled: !policy.automaticLearningEnabled,
      humanConfirmed: true,
      expectedRevision: policy.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPolicyDialogOpen(false);
    setPolicy(result.value);
    setError(null);
  }

  function openCreateWhatIf(): void {
    const firstEvent = timeline?.events[0];
    if (firstEvent === undefined) {
      setActiveTab("formal");
      return;
    }
    setSourceEventId(firstEvent.id);
    setHypothesis("");
    setWhatIfDialog({ mode: "create" });
  }

  function openSimulation(branch: WhatIfBranch): void {
    setEffectSummary("");
    setImpactedRecordId(branch.toSnapshot().sourceEventId);
    setWhatIfDialog({ mode: "simulate", branch });
  }

  async function submitWhatIf(): Promise<void> {
    if (!storyProjectId.ok || whatIfDialog === null || timeline === null || busy) {
      return;
    }
    setBusy(true);
    const result =
      whatIfDialog.mode === "create"
        ? await runtime.story.whatIfService.create({
            projectId: storyProjectId.value,
            sourceEventId,
            baseTimelineRevision: timeline.revision,
            hypothesis,
          })
        : whatIfDialog.mode === "simulate"
          ? await runtime.story.whatIfService.recordSimulation({
              branchId: whatIfDialog.branch.id,
              effects: [
                {
                  effectType: "story.consequence",
                  summary: effectSummary,
                  impactedRecordIds: [impactedRecordId],
                  confidence: 0.8,
                },
              ],
              expectedRevision: whatIfDialog.branch.revision,
            })
          : null;
    setBusy(false);
    if (result === null) {
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setWhatIfDialog(null);
    setComparison(null);
    setError(null);
    await load();
  }

  async function compareWhatIf(branch: WhatIfBranch): Promise<WhatIfComparison | null> {
    if (busy) {
      return null;
    }
    setBusy(true);
    const result = await runtime.story.whatIfService.compare(branch.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setComparison(result.value);
    setError(null);
    return result.value;
  }

  async function preparePromotion(branch: WhatIfBranch): Promise<void> {
    const compared = await compareWhatIf(branch);
    if (compared === null) {
      return;
    }
    setDraftTitle(branch.toSnapshot().hypothesis.slice(0, 200));
    setDraftSynopsis(
      branch
        .toSnapshot()
        .effects.map(({ summary }) => summary)
        .join("\n"),
    );
    setWhatIfDialog({ mode: "promote", branch });
  }

  async function promoteWhatIf(): Promise<void> {
    if (whatIfDialog?.mode !== "promote" || busy) {
      return;
    }
    setBusy(true);
    const result = await runtime.story.whatIfService.promoteToOutlineDraft({
      branchId: whatIfDialog.branch.id,
      title: draftTitle,
      synopsis: draftSynopsis,
      actorId: runtime.story.actorId,
      humanConfirmed: true,
      expectedRevision: whatIfDialog.branch.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setWhatIfDialog(null);
    setComparison(null);
    setError(null);
    await load();
  }

  async function discardWhatIf(branch: WhatIfBranch): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    const result = await runtime.story.whatIfService.discard({
      branchId: branch.id,
      expectedRevision: branch.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setComparison(null);
    setError(null);
    await load();
  }

  function openCreateReview(): void {
    const target = records[0];
    const chapter = chapters.find((candidate) => candidate.content.length > 1);
    if (target === undefined || chapter === undefined) {
      return;
    }
    const fields = readFormalFields(target);
    setReviewItemType("extraction");
    setReviewTargetId(target.id);
    setReviewChapterId(chapter.id);
    setReviewEvidence(defaultEvidence(chapter.content));
    setSuggestedTitle(fields.title);
    setSuggestedDescription(fields.description);
    setReviewDialogOpen(true);
  }

  function selectReviewTarget(recordId: string): void {
    setReviewTargetId(recordId);
    const target = records.find((record) => record.id === recordId);
    if (target !== undefined) {
      const fields = readFormalFields(target);
      setSuggestedTitle(fields.title);
      setSuggestedDescription(fields.description);
    }
  }

  function selectReviewChapter(chapterId: string): void {
    setReviewChapterId(chapterId);
    const chapter = chapters.find((candidate) => candidate.id === chapterId);
    if (chapter !== undefined) {
      setReviewEvidence(defaultEvidence(chapter.content));
    }
  }

  async function submitReviewItem(): Promise<void> {
    if (!storyProjectId.ok || busy) {
      return;
    }
    const target = records.find((record) => record.id === reviewTargetId);
    const chapter = chapters.find((candidate) => candidate.id === reviewChapterId);
    if (target === undefined || chapter === undefined) {
      setError(
        new StoryCoreError({
          code: "STORY_VALIDATION_FAILED",
          message: "Review target or source chapter is unavailable.",
        }),
      );
      return;
    }
    const evidenceStart = chapter.content.indexOf(reviewEvidence);
    if (
      reviewEvidence.length === 0 ||
      evidenceStart < 0 ||
      reviewEvidence.length >= chapter.content.length
    ) {
      setError(
        new StoryCoreError({
          code: "STORY_EVIDENCE_RANGE_INVALID",
          message: "Evidence must be an exact, strict excerpt from the selected chapter.",
          actions: ["REVIEW_EVIDENCE", "OPEN_SOURCE"],
        }),
      );
      return;
    }
    setBusy(true);
    const command = {
      projectId: storyProjectId.value,
      category: `${target.kind}.manual_review`,
      severity: reviewItemType === "consistency" ? ("warning" as const) : ("info" as const),
      targetRecordId: target.id,
      targetRecordKind: target.kind,
      sourceChapterId: chapter.id,
      sourceVersionId: chapter.currentVersionId,
      evidence: {
        excerpt: reviewEvidence,
        start: evidenceStart,
        end: evidenceStart + reviewEvidence.length,
        sourceLength: chapter.content.length,
      },
      confidence: 0.8,
      originalValue: target.currentValue,
      suggestedValue: {
        title: suggestedTitle.trim(),
        description: suggestedDescription.trim(),
      },
    };
    const result =
      reviewItemType === "extraction"
        ? await runtime.story.extractionIntake.create(command)
        : await runtime.story.consistencyIntake.create(command);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setReviewDialogOpen(false);
    setError(null);
    await load();
  }

  async function decideReview(
    item: ReviewItem,
    kind: "accept" | "reject" | "defer" | "resume",
  ): Promise<void> {
    if (busy) {
      return;
    }
    const target = records.find((record) => record.id === item.targetRecordId);
    if (kind === "accept" && target === undefined) {
      setError(
        new StoryCoreError({
          code: "FORMAL_RECORD_NOT_FOUND",
          message: "Review target formal record was not found.",
        }),
      );
      return;
    }
    const common = {
      itemId: item.id,
      actorId: runtime.story.actorId,
      humanConfirmed: true,
      expectedItemRevision: item.revision,
    };
    let command: DecideReviewItemCommand;
    switch (kind) {
      case "accept":
        command = {
          ...common,
          kind,
          expectedRecordRevision: target?.revision ?? 0,
        };
        break;
      case "defer":
        command = {
          ...common,
          kind,
          remindAt: new Date(Date.parse(runtime.clock.now()) + 86_400_000).toISOString(),
        };
        break;
      case "reject":
      case "resume":
        command = { ...common, kind };
        break;
    }
    setBusy(true);
    const result =
      item.itemType === "extraction"
        ? await runtime.story.extractionDecisions.decide(command)
        : await runtime.story.consistencyDecisions.decide(command);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    await load();
  }

  return (
    <div className="desktop-page story-governance-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to={`/projects/${projectIdParameter}`}>
            返回工作区
          </Link>
          <h1>{project?.name ?? "故事治理"}</h1>
          <p>正式设定保留版本历史；记忆只有在你的明确操作下才会启用、固定或排除。</p>
        </div>
        <div className="story-governance-summary">
          <Badge>{String(records.length)} 条正式设定</Badge>
          <Badge>{String(memories.length)} 条记忆</Badge>
          <Badge>{String(whatIfBranches.length)} 条 What-if</Badge>
          <Badge>{String(reviewItems.length)} 条审阅候选</Badge>
        </div>
      </header>

      {runtime.mode === "browser-development" && (
        <InlineAlert
          tone="warning"
          title="浏览器开发模式"
          description="此处用 localStorage 验证交互；桌面发行版使用同一领域规则和 SQLite 乐观并发控制。"
        />
      )}

      {readonly && project !== null && (
        <InlineAlert
          tone="info"
          title={project.status === "archived" ? "项目已归档" : "项目位于回收站"}
          description="治理数据保持可读，恢复项目后才能修改。"
        />
      )}

      {normalizedError !== null && pageState !== "fatal_error" && (
        <InlineAlert
          tone="error"
          title={normalizedError.title}
          description={`${normalizedError.description}（${normalizedError.code}）`}
          onDismiss={() => setError(null)}
        />
      )}

      <PageStateBoundary
        state={pageState}
        preserveContent={false}
        fallbacks={{
          fatal_error:
            normalizedError === null ? undefined : (
              <ErrorState
                title={normalizedError.title}
                description={normalizedError.description}
                errorCode={normalizedError.code}
                primaryAction={{ label: "重试", onClick: () => void load() }}
              />
            ),
        }}
      >
        <Tabs defaultValue="formal" value={activeTab} onValueChange={setActiveTab}>
          <TabsList label="故事治理分类">
            <TabsTrigger value="formal">正式设定</TabsTrigger>
            <TabsTrigger value="memory">记忆治理</TabsTrigger>
            <TabsTrigger value="review">审阅候选</TabsTrigger>
            <TabsTrigger value="what-if">What-if 沙盒</TabsTrigger>
          </TabsList>

          <TabsContent value="formal">
            <section aria-labelledby="formal-records-title">
              <div className="section-heading">
                <div>
                  <h2 id="formal-records-title">正式设定</h2>
                  <p>角色、世界规则、伏笔和时间线事件都以不可静默覆盖的版本保存。</p>
                </div>
                <Button disabled={readonly || busy} onClick={openCreateFormalRecord}>
                  新建正式设定
                </Button>
              </div>

              {records.length === 0 ? (
                <EmptyState
                  title="还没有正式设定"
                  description="手工录入第一条角色、世界规则、伏笔或时间线事件。"
                  {...(readonly
                    ? {}
                    : {
                        primaryAction: {
                          label: "新建正式设定",
                          onClick: openCreateFormalRecord,
                        },
                      })}
                />
              ) : (
                <div className="story-governance-grid">
                  {records.map((record) => {
                    const snapshot = record.toSnapshot();
                    const fields = readFormalFields(record);
                    return (
                      <Card key={record.id}>
                        <CardHeader>
                          <div className="card-heading-row">
                            <div>
                              <CardTitle>{fields.title}</CardTitle>
                              <CardDescription>{snapshot.recordKey}</CardDescription>
                            </div>
                            <Badge tone={formalKindTone(record.kind)}>
                              {formalKindLabel(record.kind)}
                            </Badge>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <p className="story-governance-copy">{fields.description}</p>
                          <div className="story-governance-meta">
                            <span>版本 {String(snapshot.currentVersion)}</span>
                            <span>修订 {String(snapshot.revision)}</span>
                          </div>
                        </CardContent>
                        <CardFooter>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={readonly || busy}
                            onClick={() => openEditFormalRecord(record)}
                          >
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={readonly || busy || snapshot.currentVersion < 2}
                            onClick={() => void undoFormalRecord(record)}
                          >
                            撤回至上一版
                          </Button>
                        </CardFooter>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          </TabsContent>

          <TabsContent value="memory">
            <section aria-labelledby="memory-policy-title">
              <Card className="story-memory-policy">
                <CardHeader>
                  <div className="card-heading-row">
                    <div>
                      <CardTitle id="memory-policy-title">自动学习授权</CardTitle>
                      <CardDescription>
                        开启只授权后续经过校验的自动记忆写入，不会立即生成或修改任何记忆。
                      </CardDescription>
                    </div>
                    <Badge tone={policy?.automaticLearningEnabled === true ? "success" : "neutral"}>
                      {policy?.automaticLearningEnabled === true ? "已授权" : "未授权"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardFooter>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={readonly || busy || policy === null}
                    onClick={() => setPolicyDialogOpen(true)}
                  >
                    {policy?.automaticLearningEnabled === true ? "关闭自动学习" : "开启自动学习"}
                  </Button>
                </CardFooter>
              </Card>

              <div className="section-heading">
                <div>
                  <h2>可治理记忆</h2>
                  <p>固定、降权、排除、停用和编辑都会经过版本校验并保留来源。</p>
                </div>
                <Button disabled={readonly || busy} onClick={openCreateMemory}>
                  添加用户记忆
                </Button>
              </div>

              {memories.length === 0 ? (
                <EmptyState
                  title="还没有记忆"
                  description="添加一条由你确认的记忆规则；默认不会自动学习正文。"
                  {...(readonly
                    ? {}
                    : {
                        primaryAction: {
                          label: "添加用户记忆",
                          onClick: openCreateMemory,
                        },
                      })}
                />
              ) : (
                <div className="story-memory-list">
                  {memories.map((memory) => {
                    const snapshot = memory.toSnapshot();
                    return (
                      <Card key={memory.id}>
                        <CardHeader>
                          <div className="card-heading-row">
                            <div>
                              <CardTitle>{memoryLevelLabel(snapshot.level)}</CardTitle>
                              <CardDescription>
                                {snapshot.origin === "user" ? "用户确认" : "自动学习"} · 修订{" "}
                                {String(snapshot.revision)}
                              </CardDescription>
                            </div>
                            <div className="story-memory-badges">
                              <Badge tone={snapshot.status === "enabled" ? "success" : "neutral"}>
                                {snapshot.status === "enabled" ? "启用" : "停用"}
                              </Badge>
                              {snapshot.pinned && <Badge tone="accent">固定</Badge>}
                              {snapshot.excluded && <Badge tone="danger">排除</Badge>}
                              {!snapshot.pinned && !snapshot.excluded && snapshot.weight < 1 && (
                                <Badge tone="warning">权重 {snapshot.weight.toFixed(1)}</Badge>
                              )}
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <p className="story-governance-copy">{snapshot.content}</p>
                          <div className="story-governance-meta">
                            <span>来源：{memorySourceLabel(snapshot.source.kind)}</span>
                            <span>使用 {String(snapshot.useCount)} 次</span>
                          </div>
                        </CardContent>
                        <CardFooter className="story-governance-actions">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={readonly || busy}
                            onClick={() => openEditMemory(memory)}
                          >
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={readonly || busy}
                            onClick={() =>
                              void governMemory(memory, {
                                kind: "set_enabled",
                                enabled: snapshot.status !== "enabled",
                              })
                            }
                          >
                            {snapshot.status === "enabled" ? "停用" : "启用"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={readonly || busy || snapshot.pinned}
                            onClick={() => void governMemory(memory, { kind: "pin" })}
                          >
                            固定
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={readonly || busy || snapshot.excluded}
                            onClick={() => void governMemory(memory, { kind: "exclude" })}
                          >
                            排除
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              readonly ||
                              busy ||
                              snapshot.excluded ||
                              (!snapshot.pinned && snapshot.weight < 1)
                            }
                            onClick={() =>
                              void governMemory(memory, { kind: "downweight", weight: 0.5 })
                            }
                          >
                            降低权重
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              readonly ||
                              busy ||
                              (!snapshot.pinned && !snapshot.excluded && snapshot.weight === 1)
                            }
                            onClick={() => void governMemory(memory, { kind: "reset_priority" })}
                          >
                            恢复默认
                          </Button>
                        </CardFooter>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          </TabsContent>

          <TabsContent value="review">
            <section aria-labelledby="review-items-title">
              <InlineAlert
                tone="info"
                title="证据与版本绑定"
                description="候选保留章节版本和精确证据范围；接受时会再次校验章节仍是该版本，并与正式设定更新同事务提交。"
              />
              <div className="section-heading">
                <div>
                  <h2 id="review-items-title">结构化审阅候选</h2>
                  <p>当前支持人工准备候选；模型输出以后也必须进入同一审阅与确认流程。</p>
                </div>
                <Button
                  disabled={
                    readonly ||
                    busy ||
                    records.length === 0 ||
                    !chapters.some((chapter) => chapter.content.length > 1)
                  }
                  onClick={openCreateReview}
                >
                  准备审阅候选
                </Button>
              </div>

              {records.length === 0 ? (
                <EmptyState
                  title="还没有可审阅的正式设定"
                  description="先创建至少一条正式设定，再准备有目标的结构化候选。"
                  {...(readonly
                    ? {}
                    : {
                        primaryAction: {
                          label: "前往正式设定",
                          onClick: () => setActiveTab("formal"),
                        },
                      })}
                />
              ) : !chapters.some((chapter) => chapter.content.length > 1) ? (
                <EmptyState
                  title="还没有可引用的章节正文"
                  description="候选必须引用一个非空章节的精确证据片段。"
                />
              ) : reviewItems.length === 0 ? (
                <EmptyState
                  title="还没有审阅候选"
                  description="准备一条人工候选，验证证据、版本和正式设定的安全提交链路。"
                  {...(readonly
                    ? {}
                    : {
                        primaryAction: {
                          label: "准备审阅候选",
                          onClick: openCreateReview,
                        },
                      })}
                />
              ) : (
                <div className="story-review-list">
                  {reviewItems.map((item) => {
                    const snapshot = item.toSnapshot();
                    const target = records.find((record) => record.id === snapshot.targetRecordId);
                    const chapter = chapters.find(
                      (candidate) => String(candidate.id) === snapshot.sourceChapterId,
                    );
                    const suggestion = readStoryValueFields(snapshot.suggestedValue, "建议值");
                    return (
                      <Card key={item.id}>
                        <CardHeader>
                          <div className="card-heading-row">
                            <div>
                              <CardTitle>
                                {reviewTypeLabel(item.itemType)} ·{" "}
                                {target === undefined
                                  ? snapshot.targetRecordId
                                  : readFormalFields(target).title}
                              </CardTitle>
                              <CardDescription>
                                {chapter?.title ?? snapshot.sourceChapterId} · 版本{" "}
                                {snapshot.sourceVersionId.slice(-8)}
                              </CardDescription>
                            </div>
                            <div className="story-memory-badges">
                              <Badge tone={reviewStatusTone(snapshot.status)}>
                                {reviewStatusLabel(snapshot.status)}
                              </Badge>
                              <Badge tone={reviewSeverityTone(snapshot.severity)}>
                                {reviewSeverityLabel(snapshot.severity)}
                              </Badge>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="story-review-content">
                          <blockquote>{snapshot.evidence.excerpt}</blockquote>
                          <div className="story-review-suggestion">
                            <span>建议正式值</span>
                            <strong>{suggestion.title}</strong>
                            <p>{suggestion.description}</p>
                          </div>
                          <div className="story-governance-meta">
                            <span>置信度 {Math.round(snapshot.confidence * 100).toString()}%</span>
                            <span>修订 {String(snapshot.revision)}</span>
                          </div>
                        </CardContent>
                        <CardFooter className="story-governance-actions">
                          {(snapshot.status === "pending" || snapshot.status === "deferred") && (
                            <>
                              <Button
                                size="sm"
                                disabled={readonly || busy || target === undefined}
                                onClick={() => void decideReview(item, "accept")}
                              >
                                接受并写入正式设定
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={readonly || busy}
                                onClick={() => void decideReview(item, "reject")}
                              >
                                拒绝
                              </Button>
                            </>
                          )}
                          {snapshot.status === "pending" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={readonly || busy}
                              onClick={() => void decideReview(item, "defer")}
                            >
                              延后一天
                            </Button>
                          )}
                          {snapshot.status === "deferred" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={readonly || busy}
                              onClick={() => void decideReview(item, "resume")}
                            >
                              恢复待审
                            </Button>
                          )}
                        </CardFooter>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          </TabsContent>

          <TabsContent value="what-if">
            <section aria-labelledby="what-if-title">
              <InlineAlert
                tone="info"
                title="沙盒边界"
                description="What-if 分支只能比较正式时间线；即使提升，也只生成大纲草稿，不能直接提交正式时间线。"
              />
              <div className="section-heading">
                <div>
                  <h2 id="what-if-title">What-if 分支</h2>
                  <p>
                    当前正式时间线修订 {String(timeline?.revision ?? 1)}，包含{" "}
                    {String(timeline?.events.length ?? 0)} 个事件。
                  </p>
                </div>
                <Button
                  disabled={readonly || busy || (timeline?.events.length ?? 0) === 0}
                  onClick={openCreateWhatIf}
                >
                  新建 What-if
                </Button>
              </div>

              {(timeline?.events.length ?? 0) === 0 ? (
                <EmptyState
                  title="还没有正式时间线事件"
                  description="先在“正式设定”中新增一条时间线事件，才能以它为基线创建沙盒分支。"
                  {...(readonly
                    ? {}
                    : {
                        primaryAction: {
                          label: "前往正式设定",
                          onClick: () => setActiveTab("formal"),
                        },
                      })}
                />
              ) : whatIfBranches.length === 0 ? (
                <EmptyState
                  title="还没有 What-if 分支"
                  description="选择一个正式时间线事件，记录假设与人工审阅的影响。"
                  {...(readonly
                    ? {}
                    : {
                        primaryAction: {
                          label: "新建 What-if",
                          onClick: openCreateWhatIf,
                        },
                      })}
                />
              ) : (
                <div className="story-what-if-list">
                  {whatIfBranches.map((branch) => {
                    const snapshot = branch.toSnapshot();
                    const sourceRecord = records.find(
                      (record) => record.id === snapshot.sourceEventId,
                    );
                    return (
                      <Card key={branch.id}>
                        <CardHeader>
                          <div className="card-heading-row">
                            <div>
                              <CardTitle>{snapshot.hypothesis}</CardTitle>
                              <CardDescription>
                                基于{" "}
                                {sourceRecord === undefined
                                  ? snapshot.sourceEventId
                                  : readFormalFields(sourceRecord).title}{" "}
                                · 时间线修订 {String(snapshot.baseTimelineRevision)}
                              </CardDescription>
                            </div>
                            <Badge tone={whatIfStatusTone(snapshot.status)}>
                              {whatIfStatusLabel(snapshot.status)}
                            </Badge>
                          </div>
                        </CardHeader>
                        <CardContent>
                          {snapshot.effects.length === 0 ? (
                            <p className="story-governance-copy">尚未记录模拟影响。</p>
                          ) : (
                            <ul className="story-what-if-effects">
                              {snapshot.effects.map((effect) => (
                                <li key={effect.id}>
                                  <strong>{effect.summary}</strong>
                                  <span>
                                    置信度 {Math.round(effect.confidence * 100).toString()}% · 影响{" "}
                                    {String(effect.impactedRecordIds.length)} 条设定
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {comparison?.branchId === branch.id && (
                            <InlineAlert
                              tone="info"
                              title="已与当前正式时间线比较"
                              description={`基线修订 ${String(comparison.baseTimelineRevision)}；当前修订 ${String(comparison.formalTimelineRevision)}。沙盒不可提交正式时间线。`}
                            />
                          )}
                        </CardContent>
                        <CardFooter className="story-governance-actions">
                          {snapshot.status === "draft" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={readonly || busy}
                              onClick={() => openSimulation(branch)}
                            >
                              记录模拟结果
                            </Button>
                          )}
                          {snapshot.status === "simulated" && (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                onClick={() => void compareWhatIf(branch)}
                              >
                                与正式时间线比较
                              </Button>
                              <Button
                                size="sm"
                                disabled={readonly || busy}
                                onClick={() => void preparePromotion(branch)}
                              >
                                转为大纲草稿
                              </Button>
                            </>
                          )}
                          {(snapshot.status === "draft" || snapshot.status === "simulated") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={readonly || busy}
                              onClick={() => void discardWhatIf(branch)}
                            >
                              丢弃分支
                            </Button>
                          )}
                        </CardFooter>
                      </Card>
                    );
                  })}
                </div>
              )}

              {outlineDrafts.length > 0 && (
                <div className="story-outline-drafts">
                  <div className="section-heading">
                    <div>
                      <h2>大纲草稿候选</h2>
                      <p>这里只是候选内容；不会自动合并现有大纲或正式时间线。</p>
                    </div>
                    <Badge>{String(outlineDrafts.length)} 条</Badge>
                  </div>
                  <div className="story-governance-grid">
                    {outlineDrafts.map((draft) => (
                      <Card key={draft.id}>
                        <CardHeader>
                          <CardTitle>{draft.title}</CardTitle>
                          <CardDescription>来源分支 {draft.sourceBranchId}</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <p className="story-governance-copy">{draft.synopsis}</p>
                        </CardContent>
                        <CardFooter>
                          <Badge tone="warning">尚未合并</Badge>
                        </CardFooter>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </TabsContent>
        </Tabs>
      </PageStateBoundary>

      <Dialog
        open={formalDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setFormalDialog(null);
          }
        }}
        title={formalDialog?.mode === "edit" ? "编辑正式设定" : "新建正式设定"}
        description="保存即表示你确认把这条内容写入正式故事事实；之后仍可撤回到上一版。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setFormalDialog(null)}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={formalTitle.trim().length === 0 || formalDescription.trim().length === 0}
              onClick={() => void submitFormalRecord()}
            >
              确认写入正式设定
            </Button>
          </>
        }
      >
        <div className="story-governance-form">
          <FormField label="类型" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={formalKind}
                options={FORMAL_KIND_OPTIONS}
                disabled={formalDialog?.mode === "edit"}
                onChange={(event) => setFormalKind(event.currentTarget.value as FormalRecordKind)}
              />
            )}
          </FormField>
          <FormField label="名称" required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={formalTitle}
                maxLength={200}
                onChange={(event) => setFormalTitle(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField label="正式描述" hint="避免模糊推测；这里只保存你确认的事实。" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={formalDescription}
                maxLength={4000}
                currentLength={formalDescription.length}
                rows={7}
                onChange={(event) => setFormalDescription(event.currentTarget.value)}
              />
            )}
          </FormField>
        </div>
      </Dialog>

      <Dialog
        open={memoryDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMemoryDialog(null);
          }
        }}
        title={memoryDialog === "create" ? "添加用户记忆" : "编辑记忆"}
        description="保存即表示你确认这条内容可参与后续上下文选择。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setMemoryDialog(null)}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={memoryContent.trim().length === 0}
              onClick={() => void submitMemory()}
            >
              确认保存
            </Button>
          </>
        }
      >
        <div className="story-governance-form">
          <FormField label="记忆层级" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={memoryLevel}
                options={MEMORY_LEVEL_OPTIONS}
                disabled={memoryDialog !== "create"}
                onChange={(event) => setMemoryLevel(event.currentTarget.value as MemoryLevel)}
              />
            )}
          </FormField>
          <FormField label="记忆内容" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={memoryContent}
                maxLength={1000}
                currentLength={memoryContent.length}
                rows={6}
                onChange={(event) => setMemoryContent(event.currentTarget.value)}
              />
            )}
          </FormField>
        </div>
      </Dialog>

      <Dialog
        open={policyDialogOpen}
        onOpenChange={setPolicyDialogOpen}
        title={policy?.automaticLearningEnabled === true ? "关闭自动学习" : "开启自动学习"}
        description={
          policy?.automaticLearningEnabled === true
            ? "关闭后，不再允许新的自动记忆写入；已有记忆不会被删除。"
            : "开启后，仅允许通过来源与策略版本校验的自动记忆写入；正式设定仍需你确认。"
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setPolicyDialogOpen(false)}>
              取消
            </Button>
            <Button loading={busy} onClick={() => void toggleAutomaticLearning()}>
              明确确认
            </Button>
          </>
        }
      >
        <InlineAlert
          tone="info"
          title="授权范围"
          description="这个开关不会把 AI 建议直接写入正式设定，也不会绕过来源版本检查。"
        />
      </Dialog>

      <Dialog
        open={reviewDialogOpen}
        onOpenChange={setReviewDialogOpen}
        title="准备结构化审阅候选"
        description="候选不会自动修改正式设定；只有后续明确接受且来源版本仍一致时才会提交。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setReviewDialogOpen(false)}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={
                reviewTargetId.length === 0 ||
                reviewChapterId.length === 0 ||
                reviewEvidence.length === 0 ||
                suggestedTitle.trim().length === 0 ||
                suggestedDescription.trim().length === 0
              }
              onClick={() => void submitReviewItem()}
            >
              保存为待审候选
            </Button>
          </>
        }
      >
        <div className="story-governance-form">
          <FormField label="候选类型" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={reviewItemType}
                options={[
                  { value: "extraction", label: "信息提取建议" },
                  { value: "consistency", label: "一致性问题" },
                ]}
                onChange={(event) => setReviewItemType(event.currentTarget.value as ReviewItemType)}
              />
            )}
          </FormField>
          <FormField label="目标正式设定" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={reviewTargetId}
                options={records.map((record) => ({
                  value: record.id,
                  label: `${formalKindLabel(record.kind)} · ${readFormalFields(record).title}`,
                }))}
                onChange={(event) => selectReviewTarget(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField label="来源章节版本" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={reviewChapterId}
                options={chapters
                  .filter((chapter) => chapter.content.length > 1)
                  .map((chapter) => ({
                    value: chapter.id,
                    label: `${chapter.title} · 修订 ${String(chapter.revision)}`,
                  }))}
                onChange={(event) => selectReviewChapter(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField
            label="证据原文"
            hint="必须与所选章节中的一段连续原文完全一致，且不能覆盖整章。"
            required
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={reviewEvidence}
                maxLength={320}
                currentLength={reviewEvidence.length}
                rows={5}
                onChange={(event) => setReviewEvidence(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField label="建议名称" required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={suggestedTitle}
                maxLength={200}
                onChange={(event) => setSuggestedTitle(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField label="建议正式描述" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={suggestedDescription}
                maxLength={4000}
                currentLength={suggestedDescription.length}
                rows={6}
                onChange={(event) => setSuggestedDescription(event.currentTarget.value)}
              />
            )}
          </FormField>
        </div>
      </Dialog>

      <Dialog
        open={whatIfDialog?.mode === "create" || whatIfDialog?.mode === "simulate"}
        onOpenChange={(open) => {
          if (!open) {
            setWhatIfDialog(null);
          }
        }}
        title={whatIfDialog?.mode === "simulate" ? "记录模拟结果" : "新建 What-if 分支"}
        description={
          whatIfDialog?.mode === "simulate"
            ? "记录可审阅的影响，不改动任何正式设定。"
            : "分支会绑定当前正式时间线修订，避免在过期基线上悄悄运行。"
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setWhatIfDialog(null)}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={
                whatIfDialog?.mode === "simulate"
                  ? effectSummary.trim().length === 0 || impactedRecordId.length === 0
                  : hypothesis.trim().length === 0 || sourceEventId.length === 0
              }
              onClick={() => void submitWhatIf()}
            >
              {whatIfDialog?.mode === "simulate" ? "保存沙盒结果" : "创建沙盒分支"}
            </Button>
          </>
        }
      >
        <div className="story-governance-form">
          {whatIfDialog?.mode === "simulate" ? (
            <>
              <FormField label="影响摘要" required>
                {(fieldProps) => (
                  <Textarea
                    {...fieldProps}
                    value={effectSummary}
                    maxLength={1000}
                    currentLength={effectSummary.length}
                    rows={6}
                    onChange={(event) => setEffectSummary(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField label="主要受影响设定" required>
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={impactedRecordId}
                    options={records.map((record) => ({
                      value: record.id,
                      label: `${formalKindLabel(record.kind)} · ${readFormalFields(record).title}`,
                    }))}
                    onChange={(event) => setImpactedRecordId(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <InlineAlert
                tone="info"
                title="人工记录"
                description="当前结果由你输入并确认，置信度按 80% 记录；尚未调用模型生成。"
              />
            </>
          ) : (
            <>
              <FormField label="基线时间线事件" required>
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={sourceEventId}
                    options={(timeline?.events ?? []).map((event) => ({
                      value: event.id,
                      label: readFormalFields(event).title,
                    }))}
                    onChange={(event) => setSourceEventId(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField label="假设" required>
                {(fieldProps) => (
                  <Textarea
                    {...fieldProps}
                    value={hypothesis}
                    maxLength={1000}
                    currentLength={hypothesis.length}
                    rows={6}
                    onChange={(event) => setHypothesis(event.currentTarget.value)}
                  />
                )}
              </FormField>
            </>
          )}
        </div>
      </Dialog>

      <Dialog
        open={whatIfDialog?.mode === "promote"}
        onOpenChange={(open) => {
          if (!open) {
            setWhatIfDialog(null);
          }
        }}
        title="转为大纲草稿"
        description="这一步只创建独立候选，不合并大纲，更不会写入正式时间线。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setWhatIfDialog(null)}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={draftTitle.trim().length === 0 || draftSynopsis.trim().length === 0}
              onClick={() => void promoteWhatIf()}
            >
              明确确认生成草稿
            </Button>
          </>
        }
      >
        <div className="story-governance-form">
          <FormField label="草稿标题" required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={draftTitle}
                maxLength={200}
                onChange={(event) => setDraftTitle(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField label="草稿摘要" required>
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={draftSynopsis}
                maxLength={1000}
                currentLength={draftSynopsis.length}
                rows={6}
                onChange={(event) => setDraftSynopsis(event.currentTarget.value)}
              />
            )}
          </FormField>
          <InlineAlert
            tone="warning"
            title="不可直接提交正式时间线"
            description="候选需要在后续大纲工作流中再次人工审阅；本操作没有正式时间线写入能力。"
          />
        </div>
      </Dialog>
    </div>
  );
}

function readFormalFields(record: FormalStoryRecord): {
  readonly title: string;
  readonly description: string;
} {
  return readStoryValueFields(record.currentValue, record.toSnapshot().recordKey);
}

function readStoryValueFields(
  value: StoryValue,
  fallbackTitle: string,
): {
  readonly title: string;
  readonly description: string;
} {
  if (isStoryObject(value)) {
    const title = value.title;
    const description = value.description;
    if (typeof title === "string" && typeof description === "string") {
      return { title, description };
    }
  }
  return {
    title: fallbackTitle,
    description: JSON.stringify(value, null, 2),
  };
}

function defaultEvidence(content: string): string {
  const maximum = Math.min(120, content.length - 1);
  if (maximum < 1) {
    return "";
  }
  const firstNonWhitespace = content.search(/\S/u);
  const start = firstNonWhitespace < 0 ? 0 : firstNonWhitespace;
  const available = content.length - start;
  const length = Math.min(maximum, Math.max(1, available - 1));
  return content.slice(start, start + length);
}

function isStoryObject(value: StoryValue): value is Readonly<Record<string, StoryValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formalKindLabel(kind: FormalRecordKind): string {
  const labels: Record<FormalRecordKind, string> = {
    character: "角色",
    world_rule: "世界规则",
    foreshadow: "伏笔",
    timeline_event: "时间线事件",
  };
  return labels[kind];
}

function formalKindTone(kind: FormalRecordKind): "accent" | "info" | "warning" | "success" {
  const tones: Record<FormalRecordKind, "accent" | "info" | "warning" | "success"> = {
    character: "accent",
    world_rule: "info",
    foreshadow: "warning",
    timeline_event: "success",
  };
  return tones[kind];
}

function memoryLevelLabel(level: MemoryLevel): string {
  const labels: Record<MemoryLevel, string> = {
    L1: "L1 · 当前写作焦点",
    L2: "L2 · 近期上下文",
    L3: "L3 · 项目长期记忆",
    L4: "L4 · 稳定规则",
  };
  return labels[level];
}

function memorySourceLabel(kind: MemorySourceKind): string {
  const labels = {
    chapter: "章节版本",
    timeline_event: "时间线事件",
    session: "写作会话",
    user_rule: "用户规则",
    import: "导入",
  } as const;
  return labels[kind];
}

function whatIfStatusLabel(status: WhatIfBranch["status"]): string {
  const labels: Record<WhatIfBranch["status"], string> = {
    draft: "待模拟",
    simulated: "已模拟",
    promoted_to_outline_draft: "已转大纲草稿",
    discarded: "已丢弃",
  };
  return labels[status];
}

function whatIfStatusTone(
  status: WhatIfBranch["status"],
): "neutral" | "info" | "warning" | "success" {
  const tones: Record<WhatIfBranch["status"], "neutral" | "info" | "warning" | "success"> = {
    draft: "neutral",
    simulated: "info",
    promoted_to_outline_draft: "success",
    discarded: "warning",
  };
  return tones[status];
}

function reviewTypeLabel(itemType: ReviewItemType): string {
  return itemType === "extraction" ? "信息提取建议" : "一致性问题";
}

function reviewStatusLabel(status: ReviewItemStatus): string {
  const labels: Record<ReviewItemStatus, string> = {
    pending: "待审",
    accepted: "已接受",
    modified: "修改后接受",
    rejected: "已拒绝",
    deferred: "已延后",
  };
  return labels[status];
}

function reviewStatusTone(
  status: ReviewItemStatus,
): "neutral" | "info" | "success" | "warning" | "danger" {
  const tones: Record<ReviewItemStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
    pending: "info",
    accepted: "success",
    modified: "success",
    rejected: "danger",
    deferred: "warning",
  };
  return tones[status];
}

function reviewSeverityLabel(severity: ReviewSeverity): string {
  const labels: Record<ReviewSeverity, string> = {
    info: "提示",
    warning: "警告",
    error: "错误",
  };
  return labels[severity];
}

function reviewSeverityTone(severity: ReviewSeverity): "neutral" | "warning" | "danger" {
  const tones: Record<ReviewSeverity, "neutral" | "warning" | "danger"> = {
    info: "neutral",
    warning: "warning",
    error: "danger",
  };
  return tones[severity];
}
