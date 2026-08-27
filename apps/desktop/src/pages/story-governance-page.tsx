import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Chapter, ChapterVersion, Project } from "@inkshadow/domain";
import { parseUuidV7 as parseDomainUuid } from "@inkshadow/domain";
import {
  FORMAL_RECORD_KINDS,
  MEMORY_LEVELS,
  StoryCoreError,
  directLocalPendingEvidenceIdentity,
  parseUuidV7 as parseStoryUuid,
  readAmbiguousStoryFactEntityAlias,
  storyFactNeedsEntityAliasResolution,
  type FormalRecordKind,
  type FormalStoryRecord,
  type DecideReviewItemCommand,
  type DirectLocalPendingEvidenceIdentity,
  type MemoryLevel,
  type LegacyMemoryPromotionPreview,
  type MemoryPolicy,
  type MemoryRecord,
  type MemorySourceKind,
  type OutlineDraftCandidate,
  type ReviewItemStatus,
  type ReviewItemType,
  type ReviewSeverity,
  type StoryFact,
  type StoryFactEvidenceSnapshot,
  type StoryFactSnapshot,
  type StoryFactRevision,
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
  Drawer,
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
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  captureMountedComponentPath,
  useComponentOwnershipPath,
} from "../components/component-ownership-context";
import { useWritingExperience } from "../hooks/use-writing-experience";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
import {
  recordProjectAreaReadIncident,
  recoverUiRouteIncident,
  type ProjectAreaReadStage,
} from "../infrastructure/ui-route-diagnostics";
import { useRuntime } from "../runtime-context";
import { WritingPreferencesPanel } from "../components/writing-preferences-panel";
import { NovelSkillPanel } from "../components/novel-skill-panel";
import { ContextHistoryPanel } from "../components/context-history-panel";
import { ChapterSummaryPanel } from "../components/chapter-summary-panel";
import { StorySettingsTools, type ManualFactFormDraft } from "../components/story-settings-tools";
import type { ContinuousStoryStateDashboard } from "../infrastructure/continuous-story-state-extraction";

const FORMAL_KIND_OPTIONS = FORMAL_RECORD_KINDS.map((kind) => ({
  value: kind,
  label: formalKindLabel(kind),
}));

const MEMORY_LEVEL_OPTIONS = MEMORY_LEVELS.map((level) => ({
  value: level,
  label: memoryLevelLabel(level),
}));

const PRIMARY_GOVERNANCE_TABS = ["characters", "world", "memory", "preferences"] as const;
const WORLD_SECTION_ORDER = ["location", "rule", "organization", "other"] as const;

function EvidenceDisclosure({
  label,
  children,
  className = "",
}: Readonly<{
  label: string;
  children: ReactNode;
  className?: string;
}>) {
  const [open, setOpen] = useState(false);
  const disclosureId = useId();
  const triggerId = `${disclosureId}-trigger`;
  const regionId = `${disclosureId}-region`;
  const currentLabel = open
    ? label.startsWith("查看")
      ? `收起${label.slice("查看".length)}`
      : `收起${label}`
    : label;
  const regionLabel = label.startsWith("查看") ? label.slice("查看".length) : label;

  return (
    <div className={["story-evidence-disclosure", className].filter(Boolean).join(" ")}>
      <Button
        id={triggerId}
        className="story-evidence-disclosure__trigger"
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen((current) => !current);
        }}
      >
        {currentLabel}
      </Button>
      {open && (
        <div
          id={regionId}
          className="story-evidence-disclosure__region"
          role="region"
          aria-label={regionLabel}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function storyFactEvidenceForPresentation(
  snapshot: StoryFactSnapshot,
  storedEvidence: readonly StoryFactEvidenceSnapshot[] | undefined,
): readonly StoryFactEvidenceSnapshot[] {
  if (storedEvidence !== undefined && storedEvidence.length > 0) return storedEvidence;
  const source = snapshot.source;
  if (
    source.kind !== "chapter_span" ||
    source.chapterId === null ||
    source.versionId === null ||
    source.startOffset === null ||
    source.endOffset === null ||
    source.sourceLength === null ||
    source.excerpt === null
  ) {
    return [];
  }
  return [
    {
      factId: String(snapshot.id),
      projectId: String(snapshot.projectId),
      reference: source.reference,
      chapterId: String(source.chapterId),
      versionId: String(source.versionId),
      startOffset: source.startOffset,
      endOffset: source.endOffset,
      sourceLength: source.sourceLength,
      excerpt: source.excerpt,
      recordedAt: String(snapshot.updatedAt),
    },
  ];
}

function StoryFactEvidenceDetails({
  evidence,
  chapters,
  sourceVersions,
}: Readonly<{
  evidence: readonly StoryFactEvidenceSnapshot[];
  chapters: readonly Chapter[];
  sourceVersions: readonly ChapterVersion[];
}>) {
  if (evidence.length === 0) {
    return <blockquote className="story-source-quote">这条设定没有可显示的原文片段。</blockquote>;
  }
  return (
    <>
      {evidence.length > 1 && <p>共 {String(evidence.length)} 处原文依据</p>}
      {evidence.map((item, index) => {
        const sourceChapter = chapters.find((chapter) => String(chapter.id) === item.chapterId);
        const sourceVersion = sourceVersions.find(
          (version) => String(version.id) === item.versionId,
        );
        return (
          <div className="story-governance-evidence-entry" key={item.reference}>
            {evidence.length > 1 && <p>原文依据 {String(index + 1)}</p>}
            <dl>
              <div>
                <dt>来源章节</dt>
                <dd>
                  {sourceChapter === undefined
                    ? "已保存章节（名称暂不可用）"
                    : "《" + sourceChapter.title + "》"}
                </dd>
              </div>
              <div>
                <dt>保存版本</dt>
                <dd>
                  {sourceVersion === undefined
                    ? "不可变版本详情暂不可用"
                    : "第 " + String(sourceVersion.sequence) + " 个不可变版本"}
                </dd>
              </div>
              <div>
                <dt>字符范围</dt>
                <dd>
                  第 {String(item.startOffset + 1)} 至 {String(item.endOffset)} 个字符
                </dd>
              </div>
            </dl>
            <blockquote className="story-source-quote">{item.excerpt}</blockquote>
          </div>
        );
      })}
    </>
  );
}

function PendingFactsSection({
  id,
  title,
  description,
  facts,
  evidenceByFactId,
  chapters,
  sourceVersions,
  disabled,
  onConfirm,
  onEdit,
  onDiscard,
}: Readonly<{
  id: string;
  title: string;
  description: string;
  facts: readonly StoryFact[];
  evidenceByFactId: ReadonlyMap<string, readonly StoryFactEvidenceSnapshot[]>;
  chapters: readonly Chapter[];
  sourceVersions: readonly ChapterVersion[];
  disabled: boolean;
  onConfirm: (fact: StoryFact) => void;
  onEdit: (fact: StoryFact) => void;
  onDiscard: (fact: StoryFact) => void;
}>) {
  if (facts.length === 0) return null;
  return (
    <section aria-labelledby={id}>
      <div className="section-heading">
        <div>
          <h2 id={id}>{title}</h2>
          <p>{description}</p>
        </div>
        <Badge>{String(facts.length)} 条</Badge>
      </div>
      <div className="story-governance-grid">
        {facts.map((fact) => {
          const snapshot = fact.toSnapshot();
          const fromSetup = userDraftFactIdentity(snapshot) !== null;
          return (
            <Card key={fact.id}>
              <CardHeader>
                <div className="card-heading-row">
                  <div>
                    <CardTitle>{factTypeLabel(snapshot.factType)}</CardTitle>
                    <CardDescription>
                      {fromSetup ? "来自专业创作输入" : "从正文原文整理"}，等待你的决定。
                    </CardDescription>
                  </div>
                  <Badge tone="warning">待确认</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="story-governance-copy">{storyFactContent(snapshot)}</p>
                <EvidenceDisclosure
                  className="story-governance-evidence"
                  label={fromSetup ? "查看输入来源" : "查看原文依据"}
                >
                  {fromSetup ? (
                    <>
                      <dl>
                        <div>
                          <dt>来源</dt>
                          <dd>专业创作表单</dd>
                        </div>
                        <div>
                          <dt>保存位置</dt>
                          <dd>本地项目资料</dd>
                        </div>
                      </dl>
                      <blockquote>{snapshot.contentText ?? "输入内容暂不可用"}</blockquote>
                    </>
                  ) : (
                    <StoryFactEvidenceDetails
                      evidence={storyFactEvidenceForPresentation(
                        snapshot,
                        evidenceByFactId.get(String(fact.id)),
                      )}
                      chapters={chapters}
                      sourceVersions={sourceVersions}
                    />
                  )}
                </EvidenceDisclosure>
              </CardContent>
              <CardFooter>
                <Button size="sm" disabled={disabled} onClick={() => onConfirm(fact)}>
                  确认并保留
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => onEdit(fact)}
                >
                  修改
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onDiscard(fact)}
                >
                  放弃
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function FactEditDialog({
  fact,
  content,
  busy,
  onClose,
  onChange,
  onSubmit,
}: Readonly<{
  fact: StoryFact | null;
  content: string;
  busy: boolean;
  onClose: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}>) {
  const pending = fact !== null && isPendingAuthorReviewFact(fact.toSnapshot());
  return (
    <Dialog
      open={fact !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="修改设定"
      description={
        pending
          ? "保存修改会同时确认这条内容，并把它加入正式设定；原始来源和每个旧版本都会保留。"
          : "只修改设定内容；原始来源和每个旧版本都会保留。固定的设定需先取消固定。"
      }
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button loading={busy} disabled={content.trim().length === 0} onClick={onSubmit}>
            {pending ? "保存修改并确认" : "保存修改"}
          </Button>
        </>
      }
    >
      <FormField label="设定内容" required>
        {(fieldProps) => (
          <Textarea
            {...fieldProps}
            value={content}
            maxLength={10_000}
            currentLength={content.length}
            rows={7}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        )}
      </FormField>
    </Dialog>
  );
}

const FACT_TYPE_OPTIONS = [
  { value: "character_identity", label: "人物身份" },
  { value: "character_state", label: "人物当前状态" },
  { value: "relationship", label: "人物关系" },
  { value: "world_setting", label: "世界设定" },
  { value: "world_rule", label: "世界硬规则" },
  { value: "timeline_event", label: "时间线事件" },
  { value: "causal_event", label: "因果事件" },
  { value: "causal_relation", label: "事件因果关系" },
  { value: "foreshadow", label: "伏笔" },
  { value: "pov_knowledge", label: "人物已知信息" },
  { value: "character_voice", label: "人物说话方式" },
  { value: "writing_rule", label: "写作与禁止项" },
] as const;

type FormalDialog =
  Readonly<{ mode: "create" }> | Readonly<{ mode: "edit"; record: FormalStoryRecord }>;

type ReviewItem = StructuredReviewItem<"extraction"> | StructuredReviewItem<"consistency">;

type WorldSectionKind = "location" | "rule" | "organization" | "other";

interface StoryEntityGroup {
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly facts: readonly StoryFact[];
  readonly records: readonly FormalStoryRecord[];
  readonly worldSection: WorldSectionKind | null;
}

export function StoryGovernancePage() {
  const runtime = useRuntime();
  const writingExperience = useWritingExperience();
  const directMode = writingExperience.preference?.mode === "direct";
  const navigate = useNavigate();
  const params = useParams<{ projectId: string }>();
  const projectIdParameter = params.projectId ?? "";
  const diagnosticRoute = `/projects/${projectIdParameter}/story`;
  const componentOwnershipPath = useComponentOwnershipPath("StoryGovernancePage");
  const domainProjectId = useMemo(() => parseDomainUuid(projectIdParameter), [projectIdParameter]);
  const storyProjectId = useMemo(() => parseStoryUuid(projectIdParameter), [projectIdParameter]);
  const identifierError = !domainProjectId.ok
    ? domainProjectId.error
    : !storyProjectId.ok
      ? storyProjectId.error
      : null;
  const [project, setProject] = useState<Project | null>(null);
  const [records, setRecords] = useState<readonly FormalStoryRecord[]>([]);
  const [facts, setFacts] = useState<readonly StoryFact[]>([]);
  const [directInitialEvidenceByFactId, setDirectInitialEvidenceByFactId] = useState<
    ReadonlyMap<string, DirectLocalPendingEvidenceIdentity>
  >(new Map());
  const [storyFactEvidenceByFactId, setStoryFactEvidenceByFactId] = useState<
    ReadonlyMap<string, readonly StoryFactEvidenceSnapshot[]>
  >(new Map());
  const [policy, setPolicy] = useState<MemoryPolicy | null>(null);
  const [memories, setMemories] = useState<readonly MemoryRecord[]>([]);
  const [memoryPromotionPreviews, setMemoryPromotionPreviews] = useState<
    readonly LegacyMemoryPromotionPreview[]
  >([]);
  const [whatIfBranches, setWhatIfBranches] = useState<readonly WhatIfBranch[]>([]);
  const [outlineDrafts, setOutlineDrafts] = useState<readonly OutlineDraftCandidate[]>([]);
  const [chapters, setChapters] = useState<readonly Chapter[]>([]);
  const [sourceVersions, setSourceVersions] = useState<readonly ChapterVersion[]>([]);
  const [extractionItems, setExtractionItems] = useState<
    readonly StructuredReviewItem<"extraction">[]
  >([]);
  const [consistencyItems, setConsistencyItems] = useState<
    readonly StructuredReviewItem<"consistency">[]
  >([]);
  const [comparison, setComparison] = useState<WhatIfComparison | null>(null);
  const [activeTab, setActiveTab] = useState("characters");
  const [pageState, setPageState] = useState<"loading" | "ready" | "fatal_error">("loading");
  const [error, setError] = useState<unknown>(identifierError);
  const [busy, setBusy] = useState(false);
  const [formalDialog, setFormalDialog] = useState<FormalDialog | null>(null);
  const [formalKind, setFormalKind] = useState<FormalRecordKind>("character");
  const [formalTitle, setFormalTitle] = useState("");
  const [formalDescription, setFormalDescription] = useState("");
  const [memoryDialog, setMemoryDialog] = useState<MemoryRecord | "create" | null>(null);
  const [memoryPromotionDialog, setMemoryPromotionDialog] =
    useState<LegacyMemoryPromotionPreview | null>(null);
  const [memoryLevel, setMemoryLevel] = useState<MemoryLevel>("L2");
  const [memoryContent, setMemoryContent] = useState("");
  const [policyDialogOpen, setPolicyDialogOpen] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewItemType, setReviewItemType] = useState<ReviewItemType>("extraction");
  const [reviewTargetId, setReviewTargetId] = useState("");
  const [reviewChapterId, setReviewChapterId] = useState("");
  const [reviewEvidence, setReviewEvidence] = useState("");
  const [suggestedTitle, setSuggestedTitle] = useState("");
  const [suggestedDescription, setSuggestedDescription] = useState("");
  const [factDialogOpen, setFactDialogOpen] = useState(false);
  const [factType, setFactType] = useState("character_identity");
  const [factContent, setFactContent] = useState("");
  const [factLocked, setFactLocked] = useState(false);
  const [editingFact, setEditingFact] = useState<StoryFact | null>(null);
  const [editingFactContent, setEditingFactContent] = useState("");
  const [historyFact, setHistoryFact] = useState<StoryFact | null>(null);
  const [factRevisions, setFactRevisions] = useState<readonly StoryFactRevision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [mergeFacts, setMergeFacts] = useState<Readonly<{
    survivor: StoryFact;
    duplicate: StoryFact;
  }> | null>(null);
  const factContentInputRef = useRef<HTMLTextAreaElement>(null);
  const factReturnFocusRef = useRef<Readonly<{
    element: HTMLElement | null;
    elementId: string | null;
  }> | null>(null);
  const [causalNotice, setCausalNotice] = useState<Readonly<{
    tone: "info" | "warning";
    title: string;
    description: string;
  }> | null>(null);
  const [continuousStateDashboard, setContinuousStateDashboard] =
    useState<ContinuousStoryStateDashboard | null>(null);
  const [selectedCharacterKey, setSelectedCharacterKey] = useState<string | null>(null);
  const [selectedWorldKey, setSelectedWorldKey] = useState<string | null>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [mergeMemoryIds, setMergeMemoryIds] = useState<readonly string[]>([]);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergedMemoryContent, setMergedMemoryContent] = useState("");
  const [mergeOperationId, setMergeOperationId] = useState<string | null>(null);
  const [aliasResolutionFactId, setAliasResolutionFactId] = useState<string | null>(null);
  const [aliasResolutionChoice, setAliasResolutionChoice] = useState("");
  const loadSequence = useRef(0);
  const routeIdentityRef = useRef(diagnosticRoute);
  useLayoutEffect(() => {
    routeIdentityRef.current = diagnosticRoute;
    loadSequence.current += 1;
    return () => {
      routeIdentityRef.current = "";
      loadSequence.current += 1;
    };
  }, [diagnosticRoute]);

  const activeLoadIncident = useRef<Readonly<{ id: string; route: string }> | null>(null);
  const [loadSupportId, setLoadSupportId] = useState<string | null>(null);
  const activeDerivedIncident = useRef<Readonly<{ id: string; route: string }> | null>(null);
  const [derivedSupportId, setDerivedSupportId] = useState<string | null>(null);
  const [unavailableDerivedSections, setUnavailableDerivedSections] = useState<readonly string[]>(
    [],
  );

  const recordLoadFailure = useCallback(
    (readStage: ProjectAreaReadStage, cause: unknown, reasonCodeChain: readonly string[]) => {
      const incident = recordProjectAreaReadIncident(runtime, {
        route: diagnosticRoute,
        readStage,
        cause,
        timestamp: runtime.clock.now(),
        componentName: "StoryGovernancePage",
        reasonCodeChain,
        componentStack: captureMountedComponentPath(componentOwnershipPath),
      });
      activeLoadIncident.current = { id: incident.diagnosticId, route: diagnosticRoute };
      setLoadSupportId(incident.diagnosticId);
    },
    [componentOwnershipPath, diagnosticRoute, runtime],
  );
  const recordDerivedFailure = useCallback(
    (cause: unknown) => {
      const incident = recordProjectAreaReadIncident(runtime, {
        route: diagnosticRoute,
        readStage: "story_governance",
        cause,
        timestamp: runtime.clock.now(),
        componentName: "StoryGovernancePage",
        reasonCodeChain: ["REPOSITORY_ERROR"],
        componentStack: captureMountedComponentPath(componentOwnershipPath),
      });
      activeDerivedIncident.current = {
        id: incident.diagnosticId,
        route: diagnosticRoute,
      };
      setDerivedSupportId(incident.diagnosticId);
    },
    [componentOwnershipPath, diagnosticRoute, runtime],
  );

  const load = useCallback(async () => {
    const expectedRoute = diagnosticRoute;
    if (routeIdentityRef.current !== expectedRoute) return;
    const requestSequence = loadSequence.current + 1;
    loadSequence.current = requestSequence;
    const isCurrentLoad = (): boolean =>
      loadSequence.current === requestSequence && routeIdentityRef.current === expectedRoute;
    setLoadSupportId(null);
    setUnavailableDerivedSections([]);
    if (!domainProjectId.ok || !storyProjectId.ok) {
      const cause = identifierError ?? new Error("项目编号不可用");
      recordLoadFailure("route_identity", cause, ["INVALID_UUID"]);
      setProject(null);
      setRecords([]);
      setFacts([]);
      setMemories([]);
      setChapters([]);
      setError(cause);
      setPageState("fatal_error");
      return;
    }
    setPageState("loading");
    setSourceVersions([]);
    setDirectInitialEvidenceByFactId(new Map());
    setStoryFactEvidenceByFactId(new Map());
    const [
      projectResult,
      factResult,
      recordResult,
      policyResult,
      memoryResult,
      memoryPromotionResult,
      branchResult,
      draftResult,
      chapterResult,
      extractionResult,
      consistencyResult,
    ] = await Promise.all([
      runtime.repositories.projects.findById(domainProjectId.value),
      runtime.story.facts.listByProjectId(storyProjectId.value),
      runtime.story.formalRecords.listByProjectId(storyProjectId.value),
      runtime.story.memoryService.ensureDefaultPolicy(storyProjectId.value),
      runtime.story.memoryRecords.listByProjectId(storyProjectId.value),
      runtime.story.legacyMemoryPromotion.previewProject(storyProjectId.value),
      runtime.story.whatIfBranches.listByProjectId(storyProjectId.value),
      runtime.story.outlineDrafts.listByProjectId(storyProjectId.value),
      runtime.repositories.chapters.listByProjectId(domainProjectId.value),
      runtime.story.extractionItems.listByProjectId(storyProjectId.value),
      runtime.story.consistencyItems.listByProjectId(storyProjectId.value),
    ]);
    if (!isCurrentLoad()) return;
    const failed = [
      { result: projectResult, readStage: "project" as const },
      { result: factResult, readStage: "story_governance" as const },
      { result: recordResult, readStage: "story_governance" as const },
      { result: policyResult, readStage: "story_governance" as const },
      { result: memoryResult, readStage: "story_governance" as const },
      { result: chapterResult, readStage: "chapter_list" as const },
    ].find(({ result }) => !result.ok);
    if (failed !== undefined) {
      if (failed.result.ok) return;
      recordLoadFailure(failed.readStage, failed.result.error, ["REPOSITORY_ERROR"]);
      setError(failed.result.error);
      setPageState("fatal_error");
      return;
    }
    if (!projectResult.ok || projectResult.value === null) {
      const cause = Object.assign(new Error("项目不存在"), { code: "PROJECT_NOT_FOUND" });
      recordLoadFailure("project", cause, ["PROJECT_NOT_FOUND"]);
      setError(cause);
      setPageState("fatal_error");
      return;
    }
    if (
      !recordResult.ok ||
      !factResult.ok ||
      !policyResult.ok ||
      !memoryResult.ok ||
      !chapterResult.ok
    ) {
      return;
    }
    const derivedFailures: Readonly<{ section: string; cause: unknown }>[] = [];
    const directInitialEvidenceEntries = await Promise.all(
      factResult.value
        .filter((fact) => isDirectLocalStoryFact(fact.toSnapshot()))
        .map(async (fact) => {
          const currentIdentity = directLocalPendingEvidenceIdentity(fact.toSnapshot());
          const revisions = await runtime.story.facts.listRevisions(fact.id);
          if (!revisions.ok) {
            return { factId: fact.id, identity: currentIdentity, error: revisions.error } as const;
          }
          const initial = revisions.value.find((entry) => entry.fact.revision === 1)?.fact;
          if (initial === undefined) {
            return {
              factId: fact.id,
              identity: currentIdentity,
              error: new Error("设定缺少最初的不可变修订"),
            } as const;
          }
          const identity = directLocalPendingEvidenceIdentity(initial.toSnapshot());
          return {
            factId: fact.id,
            identity,
            error: identity === null ? new Error("设定最初修订的原文身份不可用") : null,
          } as const;
        }),
    );
    if (!isCurrentLoad()) return;
    const initialEvidenceFailure = directInitialEvidenceEntries.find(
      ({ error: revisionError }) => revisionError !== null,
    )?.error;
    if (initialEvidenceFailure !== undefined && initialEvidenceFailure !== null) {
      derivedFailures.push({ section: "待确认设定历史", cause: initialEvidenceFailure });
    }
    const initialEvidenceByFactId = new Map<string, DirectLocalPendingEvidenceIdentity>();
    for (const { factId, identity } of directInitialEvidenceEntries) {
      if (identity !== null) initialEvidenceByFactId.set(factId, identity);
    }
    const evidenceReader = runtime.story.facts.listEvidenceByFactId?.bind(runtime.story.facts);
    const storyFactEvidenceEntries =
      evidenceReader === undefined
        ? []
        : await Promise.all(
            factResult.value.map(async (fact) => {
              const evidenceResult = await evidenceReader(fact.id);
              return evidenceResult.ok
                ? ({
                    factId: String(fact.id),
                    evidence: evidenceResult.value,
                    error: null,
                  } as const)
                : ({ factId: String(fact.id), evidence: [], error: evidenceResult.error } as const);
            }),
          );
    if (!isCurrentLoad()) return;
    const storyFactEvidenceFailure = storyFactEvidenceEntries.find(
      ({ error: evidenceError }) => evidenceError !== null,
    )?.error;
    if (storyFactEvidenceFailure !== undefined && storyFactEvidenceFailure !== null) {
      derivedFailures.push({ section: "设定原文依据", cause: storyFactEvidenceFailure });
    }
    const evidenceByFactId = new Map<string, readonly StoryFactEvidenceSnapshot[]>();
    for (const { factId, evidence, error: evidenceError } of storyFactEvidenceEntries) {
      if (evidenceError === null) evidenceByFactId.set(factId, evidence);
    }
    if (!memoryPromotionResult.ok) {
      derivedFailures.push({ section: "旧记忆整理", cause: memoryPromotionResult.error });
    }
    if (!branchResult.ok) {
      derivedFailures.push({ section: "旧版试演记录", cause: branchResult.error });
    }
    if (!draftResult.ok) {
      derivedFailures.push({ section: "规划草稿", cause: draftResult.error });
    }
    if (!extractionResult.ok) {
      derivedFailures.push({ section: "待确认设定", cause: extractionResult.error });
    }
    if (!consistencyResult.ok) {
      derivedFailures.push({ section: "一致性审查", cause: consistencyResult.error });
    }
    const sourceVersionIds = Array.from(
      new Set([
        ...factResult.value
          .filter((fact) => directLocalPendingEvidenceIdentity(fact.toSnapshot()) !== null)
          .map((fact) => fact.toSnapshot().source.versionId)
          .filter((versionId): versionId is NonNullable<typeof versionId> => versionId !== null)
          .map(String),
        ...Array.from(evidenceByFactId.values())
          .flat()
          .map(({ versionId }) => versionId),
      ]),
    );
    let sourceVersionFailure: unknown = null;
    const loadedSourceVersions = (
      await Promise.all(
        sourceVersionIds.map(async (versionId) => {
          const parsed = parseDomainUuid(versionId);
          if (!parsed.ok) {
            sourceVersionFailure ??= parsed.error;
            return null;
          }
          const found = await runtime.repositories.chapterVersions.findVersionById(parsed.value);
          if (!found.ok) {
            sourceVersionFailure ??= found.error;
            return null;
          }
          if (found.value === null) {
            sourceVersionFailure ??= new Error("设定原文对应的不可变版本不存在");
          }
          return found.value;
        }),
      )
    ).filter((version): version is ChapterVersion => version !== null);
    if (sourceVersionFailure !== null) {
      derivedFailures.push({ section: "设定原文版本", cause: sourceVersionFailure });
    }
    if (!isCurrentLoad()) return;
    setProject(projectResult.value);
    setFacts(factResult.value);
    setDirectInitialEvidenceByFactId(initialEvidenceByFactId);
    setStoryFactEvidenceByFactId(evidenceByFactId);
    setRecords(recordResult.value);
    setPolicy(policyResult.value);
    setMemories(memoryResult.value);
    setMemoryPromotionPreviews(memoryPromotionResult.ok ? memoryPromotionResult.value : []);
    setWhatIfBranches(branchResult.ok ? branchResult.value : []);
    setOutlineDrafts(draftResult.ok ? draftResult.value : []);
    setChapters(chapterResult.value);
    setSourceVersions(loadedSourceVersions);
    setExtractionItems(extractionResult.ok ? extractionResult.value : []);
    setConsistencyItems(consistencyResult.ok ? consistencyResult.value : []);
    try {
      const dashboard = await runtime.story.continuousState.inspectProject(projectIdParameter);
      if (!isCurrentLoad()) return;
      setContinuousStateDashboard(dashboard);
    } catch (cause: unknown) {
      if (!isCurrentLoad()) return;
      setContinuousStateDashboard(null);
      derivedFailures.push({ section: "连续故事状态", cause });
    }
    const unavailableSections = derivedFailures.map(({ section }) => section);
    setUnavailableDerivedSections(unavailableSections);
    if (derivedFailures.length > 0) {
      recordDerivedFailure(derivedFailures[0]?.cause);
    } else {
      if (activeDerivedIncident.current?.route === diagnosticRoute) {
        recoverUiRouteIncident(runtime, activeDerivedIncident.current.id, runtime.clock.now());
        activeDerivedIncident.current = null;
      }
      setDerivedSupportId(null);
    }
    if (activeLoadIncident.current?.route === diagnosticRoute) {
      recoverUiRouteIncident(runtime, activeLoadIncident.current.id, runtime.clock.now());
      activeLoadIncident.current = null;
    }
    setError(null);
    setPageState("ready");
  }, [
    diagnosticRoute,
    domainProjectId,
    identifierError,
    projectIdParameter,
    recordLoadFailure,
    recordDerivedFailure,
    runtime,
    storyProjectId,
  ]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  const readonly = project?.status !== "active";
  const normalizedError = error === null ? null : projectOrdinaryUiError(error);
  const reviewItems = useMemo(
    () =>
      [...extractionItems, ...consistencyItems].sort(
        (left, right) =>
          right.toSnapshot().updatedAt.localeCompare(left.toSnapshot().updatedAt) ||
          left.id.localeCompare(right.id),
      ),
    [consistencyItems, extractionItems],
  );
  const activeFacts = useMemo(
    () => facts.filter((fact) => fact.toSnapshot().status !== "deprecated"),
    [facts],
  );
  const directFormalFacts = useMemo(
    () => facts.filter((fact) => fact.toSnapshot().status === "formal"),
    [facts],
  );
  const directPendingLocalFactPresentation = useMemo(
    () => isolateHistoricalDirectPendingDuplicates(facts, directInitialEvidenceByFactId),
    [directInitialEvidenceByFactId, facts],
  );
  const directPendingLocalFacts = directPendingLocalFactPresentation.visibleFacts;
  const professionalSetupPendingFacts = directPendingLocalFacts.filter(
    (fact) => userDraftFactIdentity(fact.toSnapshot()) !== null,
  );
  const isolatedDirectPendingDuplicateCount =
    directPendingLocalFactPresentation.isolatedDuplicateCount;
  const directDeprecatedFacts = useMemo(
    () =>
      facts.filter(
        (fact) => fact.toSnapshot().status === "deprecated" && fact.toSnapshot().userConfirmed,
      ),
    [facts],
  );
  const directDuplicateByFactId = useMemo(() => {
    const groups = new Map<string, StoryFact[]>();
    for (const fact of directFormalFacts) {
      const snapshot = fact.toSnapshot();
      const key = simpleFactDuplicateKey(snapshot);
      if (key === null || snapshot.locked) {
        continue;
      }
      const group = groups.get(key) ?? [];
      group.push(fact);
      groups.set(key, group);
    }
    const pairs = new Map<string, StoryFact>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const fact of group) {
        const duplicate = group.find((candidate) => candidate.id !== fact.id);
        if (duplicate !== undefined) pairs.set(fact.id, duplicate);
      }
    }
    return pairs;
  }, [directFormalFacts]);
  const pendingFactCount = useMemo(
    () =>
      activeFacts.filter(({ status }) => status === "unconfirmed" || status === "temporary").length,
    [activeFacts],
  );
  const needsConfirmationCount = useMemo(
    () => activeFacts.filter((fact) => fact.toSnapshot().needsReview).length,
    [activeFacts],
  );
  const continuousEvidenceByFactId = useMemo(
    () =>
      new Map(
        continuousStateDashboard?.changes.map((change) => [change.fact.id, change] as const) ?? [],
      ),
    [continuousStateDashboard],
  );
  const characterGroups = useMemo(
    () => buildCharacterGroups(activeFacts, records),
    [activeFacts, records],
  );
  const worldGroups = useMemo(() => buildWorldGroups(activeFacts, records), [activeFacts, records]);
  const selectedCharacter = characterGroups.find(({ key }) => key === selectedCharacterKey) ?? null;
  const selectedWorld = worldGroups.find(({ key }) => key === selectedWorldKey) ?? null;
  const selectedMemory = memories.find(({ id }) => id === selectedMemoryId) ?? null;
  const promotedMemory = memories.find(({ id }) => id === memoryPromotionDialog?.memoryId) ?? null;
  const memoryPromotionById = useMemo(
    () => new Map(memoryPromotionPreviews.map((preview) => [preview.memoryId, preview] as const)),
    [memoryPromotionPreviews],
  );
  const mergeMemories = mergeMemoryIds
    .map((id) => memories.find((memory) => memory.id === id) ?? null)
    .filter((memory): memory is MemoryRecord => memory !== null);
  const aliasResolutionFact = facts.find(({ id }) => String(id) === aliasResolutionFactId) ?? null;
  const ambiguousAlias =
    aliasResolutionFact === null
      ? null
      : readAmbiguousStoryFactEntityAlias(aliasResolutionFact.toSnapshot());
  const aliasResolutionOptions = useMemo(
    () =>
      ambiguousAlias === null
        ? []
        : [
            ...ambiguousAlias.matchedEntityKeys.map((entityKey) => {
              const group = [...characterGroups, ...worldGroups].find(
                ({ key }) => key === `entity:${entityKey}`,
              );
              return {
                value: `existing:${entityKey}`,
                label: group === undefined ? `已有对象：${entityKey}` : `已有对象：${group.name}`,
              };
            }),
            { value: "separate", label: "不是以上对象，保留为新的独立对象" },
          ],
    [ambiguousAlias, characterGroups, worldGroups],
  );

  function openCreateFact(): void {
    factReturnFocusRef.current = {
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      elementId: null,
    };
    setFactType("character_identity");
    setFactContent("");
    setFactLocked(false);
    setFactDialogOpen(true);
  }

  function openManualFactForm(draft: ManualFactFormDraft): void {
    factReturnFocusRef.current = {
      element: null,
      elementId: draft.returnFocusElementId,
    };
    setFactType(draft.suggestedFactType ?? "character_identity");
    setFactContent(draft.contentText);
    setFactLocked(false);
    setFactDialogOpen(true);
  }

  function restoreFactDialogFocus(): void {
    const target = factReturnFocusRef.current;
    factReturnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      const connectedElement = target?.element?.isConnected === true ? target.element : null;
      const identifiedElement =
        target?.elementId === null || target?.elementId === undefined
          ? null
          : document.getElementById(target.elementId);
      (connectedElement ?? identifiedElement)?.focus();
    });
  }

  function closeFactDialog(): void {
    setFactDialogOpen(false);
    restoreFactDialogFocus();
  }

  async function keepMemoryAsSetting(memory: MemoryRecord): Promise<void> {
    if (!storyProjectId.ok || busy) return;
    setBusy(true);
    const preview = await runtime.story.legacyMemoryPromotion.preview({
      projectId: storyProjectId.value,
      memoryId: memory.id,
    });
    setBusy(false);
    if (!preview.ok) {
      setError(preview.error);
      return;
    }
    setSelectedMemoryId(null);
    setMemoryPromotionDialog(preview.value);
    setError(null);
  }

  async function confirmMemoryPromotion(): Promise<void> {
    if (!storyProjectId.ok || memoryPromotionDialog === null || busy) return;
    setBusy(true);
    const result = await runtime.story.legacyMemoryPromotion.confirm({
      projectId: storyProjectId.value,
      memoryId: memoryPromotionDialog.memoryId,
      expectedMemoryRevision: memoryPromotionDialog.memoryRevision,
      actorId: runtime.story.actorId,
      humanConfirmed: true,
      acceptConflict: memoryPromotionDialog.requiresConflictConfirmation,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      await load();
      return;
    }
    const status = result.value.status;
    setMemoryPromotionDialog(
      Object.freeze({
        ...memoryPromotionDialog,
        status,
        linkedLegacyRevision: result.value.link?.legacyRevision ?? null,
        canConfirm: false,
        requiresConflictConfirmation: false,
      }),
    );
    setError(null);
    await load();
  }

  async function forgetMemory(memory: MemoryRecord): Promise<void> {
    setSelectedMemoryId(null);
    await governMemory(memory, { kind: "exclude" });
  }

  function toggleMergeMemory(memoryId: string): void {
    setMergeMemoryIds((current) =>
      current.includes(memoryId)
        ? current.filter((id) => id !== memoryId)
        : current.length < 2
          ? [...current, memoryId]
          : current,
    );
  }

  function openMergeMemories(): void {
    if (mergeMemories.length !== 2) {
      return;
    }
    const [first, second] = mergeMemories;
    if (first === undefined || second === undefined) {
      return;
    }
    setMergeTargetId(first.id);
    setMergedMemoryContent(`${first.toSnapshot().content}\n${second.toSnapshot().content}`.trim());
    setMergeOperationId(runtime.ids.next());
    setMergeDialogOpen(true);
  }

  async function submitMemoryMerge(): Promise<void> {
    if (
      !storyProjectId.ok ||
      busy ||
      mergeOperationId === null ||
      mergeMemories.length !== 2 ||
      mergedMemoryContent.trim().length === 0
    ) {
      return;
    }
    const target = mergeMemories.find(({ id }) => id === mergeTargetId);
    const source = mergeMemories.find(({ id }) => id !== mergeTargetId);
    if (target === undefined || source === undefined) {
      return;
    }
    setBusy(true);
    const result = await runtime.story.memoryService.mergeRecords({
      operationId: mergeOperationId,
      projectId: storyProjectId.value,
      targetRecordId: target.id,
      sourceRecordId: source.id,
      expectedTargetRevision: target.revision,
      expectedSourceRevision: source.revision,
      content: mergedMemoryContent,
      humanConfirmed: true,
    });
    setBusy(false);
    setMergeDialogOpen(false);
    setMergeOperationId(null);
    if (!result.ok) {
      setError(result.error);
      setMergeMemoryIds([]);
      await load();
      return;
    }
    setMergeMemoryIds([]);
    setError(null);
    await load();
  }

  async function submitFact(): Promise<void> {
    if (!storyProjectId.ok || busy || factContent.trim().length === 0) {
      return;
    }
    setBusy(true);
    const result = await runtime.story.factService.createFormalUserFact({
      projectId: storyProjectId.value,
      factType,
      contentText: factContent.trim(),
      actorId: runtime.story.actorId,
      lock: factLocked,
      humanConfirmed: true,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setFactDialogOpen(false);
    setError(null);
    await load();
    restoreFactDialogFocus();
  }

  async function confirmFact(fact: StoryFact): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    const snapshot = fact.toSnapshot();
    const result =
      snapshot.source.kind === "chapter_span" &&
      snapshot.source.reference.startsWith("continuous-story-state:")
        ? await runtime.story.continuousState.confirmChange({
            factId: fact.id,
            actorId: runtime.story.actorId,
            humanConfirmed: true,
            expectedRevision: fact.revision,
          })
        : await runtime.story.factService.confirm({
            factId: fact.id,
            actorId: runtime.story.actorId,
            humanConfirmed: true,
            expectedRevision: fact.revision,
          });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshCausalStoryLinks(fact);
    setError(null);
    await load();
  }

  function openAliasResolution(fact: StoryFact): void {
    setAliasResolutionFactId(fact.id);
    setAliasResolutionChoice("");
  }

  async function resolveFactAlias(): Promise<void> {
    if (
      aliasResolutionFact === null ||
      ambiguousAlias === null ||
      aliasResolutionChoice.length === 0 ||
      busy
    ) {
      return;
    }
    setBusy(true);
    const result = await runtime.story.factService.resolveEntityAlias({
      factId: aliasResolutionFact.id,
      resolution:
        aliasResolutionChoice === "separate"
          ? { kind: "separate_entity" }
          : {
              kind: "existing_entity",
              targetEntityKey: aliasResolutionChoice.slice("existing:".length),
            },
      humanConfirmed: true,
      expectedRevision: aliasResolutionFact.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAliasResolutionFactId(null);
    setAliasResolutionChoice("");
    setError(null);
    await load();
  }

  async function toggleFactLock(fact: StoryFact): Promise<void> {
    const snapshot = fact.toSnapshot();
    if (busy || snapshot.status !== "formal") {
      return;
    }
    setBusy(true);
    const result = await runtime.story.factService.setLocked({
      factId: fact.id,
      locked: !snapshot.locked,
      humanConfirmed: true,
      expectedRevision: fact.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshCausalStoryLinks(fact);
    setError(null);
    await load();
  }

  async function refreshCausalStoryLinks(fact: StoryFact): Promise<void> {
    const snapshot = fact.toSnapshot();
    const structured =
      snapshot.structuredValue !== null &&
      typeof snapshot.structuredValue === "object" &&
      !Array.isArray(snapshot.structuredValue)
        ? (snapshot.structuredValue as Readonly<Record<string, StoryValue>>)
        : null;
    const schemaVersion =
      structured !== null && typeof structured.schemaVersion === "string"
        ? structured.schemaVersion
        : "";
    if (
      snapshot.factType !== "causal_event" &&
      snapshot.factType !== "causal_relation" &&
      !schemaVersion.startsWith("inkshadow.causal-")
    ) {
      return;
    }
    try {
      const receipt = await runtime.story.causalProjector.rebuildProject(projectIdParameter);
      setCausalNotice({
        tone: "info",
        title: "故事关联已更新",
        description: `已用 ${String(receipt.eventCount)} 个确认事件和 ${String(receipt.relationCount)} 条确认关系重建关联；未确认或证据不完整的内容没有进入。`,
      });
    } catch {
      setCausalNotice({
        tone: "warning",
        title: "设定已保存，故事关联暂未更新",
        description:
          "正文和刚才的确认都已保留。请稍后重试；在关联恢复前，写作助手不会使用这条因果链。",
      });
    }
  }

  async function deprecateFact(fact: StoryFact): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    const result = await runtime.story.factService.deprecate({
      factId: fact.id,
      humanConfirmed: true,
      expectedRevision: fact.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshCausalStoryLinks(fact);
    setError(null);
    await load();
  }

  function openEditFact(fact: StoryFact): void {
    setEditingFact(fact);
    setEditingFactContent(fact.toSnapshot().contentText ?? "");
  }

  async function submitFactEdit(): Promise<void> {
    if (editingFact === null || editingFactContent.trim().length === 0 || busy) {
      return;
    }
    setBusy(true);
    const command = {
      factId: editingFact.id,
      contentText: editingFactContent.trim(),
      actorId: runtime.story.actorId,
      humanConfirmed: true,
      expectedRevision: editingFact.revision,
    } as const;
    const result =
      directLocalPendingEvidenceIdentity(editingFact.toSnapshot()) !== null
        ? await runtime.story.factService.editStagedAsUser(command)
        : await runtime.story.factService.editAsUser(command);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshCausalStoryLinks(result.value);
    setEditingFact(null);
    setEditingFactContent("");
    setError(null);
    await load();
  }

  async function openFactHistory(fact: StoryFact): Promise<void> {
    setHistoryFact(fact);
    setFactRevisions([]);
    setHistoryLoading(true);
    const revisions = await runtime.story.facts.listRevisions(fact.id);
    setHistoryLoading(false);
    if (!revisions.ok) {
      setError(revisions.error);
      setHistoryFact(null);
      return;
    }
    setFactRevisions(revisions.value);
  }

  async function restoreFact(fact: StoryFact, selectedRevision?: number): Promise<void> {
    if (busy) return;
    setBusy(true);
    if (selectedRevision === undefined && fact.toSnapshot().status === "deprecated") {
      const restored = await runtime.story.factService.restoreDeletedAsUser({
        factId: fact.id,
        actorId: runtime.story.actorId,
        humanConfirmed: true,
        expectedRevision: fact.revision,
      });
      setBusy(false);
      if (!restored.ok) {
        setError(restored.error);
        return;
      }
      await refreshCausalStoryLinks(fact);
      setError(null);
      await load();
      return;
    }
    let revision = selectedRevision;
    if (revision === undefined) {
      const revisions = await runtime.story.facts.listRevisions(fact.id);
      if (!revisions.ok) {
        setBusy(false);
        setError(revisions.error);
        return;
      }
      revision = [...revisions.value].reverse().find((entry) => {
        const snapshot = entry.fact.toSnapshot();
        return (
          snapshot.revision < fact.revision &&
          snapshot.contentText !== null &&
          snapshot.structuredValue === null
        );
      })?.fact.revision;
    }
    if (revision === undefined) {
      setBusy(false);
      setError(
        new StoryCoreError({
          code: "STORY_FACT_INVALID_TRANSITION",
          message: "没有找到可以恢复的旧内容。",
        }),
      );
      return;
    }
    const result = await runtime.story.factService.restoreAsUser({
      factId: fact.id,
      revision,
      actorId: runtime.story.actorId,
      humanConfirmed: true,
      expectedRevision: fact.revision,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshCausalStoryLinks(fact);
    setHistoryFact(null);
    setFactRevisions([]);
    setError(null);
    await load();
  }

  async function submitFactMerge(): Promise<void> {
    if (mergeFacts === null || busy) return;
    setBusy(true);
    const result = await runtime.story.factService.mergeDuplicates({
      survivorFactId: mergeFacts.survivor.id,
      survivorExpectedRevision: mergeFacts.survivor.revision,
      duplicateFactId: mergeFacts.duplicate.id,
      duplicateExpectedRevision: mergeFacts.duplicate.revision,
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshCausalStoryLinks(mergeFacts.survivor);
    setMergeFacts(null);
    setError(null);
    await load();
  }
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

  function renderEntityGroupDetails(group: StoryEntityGroup) {
    return (
      <div className="story-entity-detail">
        <dl className="story-entity-detail__summary">
          <div>
            <dt>已记录字段</dt>
            <dd>{String(group.facts.length + group.records.length)}</dd>
          </div>
          <div>
            <dt>出场或来源章节</dt>
            <dd>{String(entityChapterIds(group).length)}</dd>
          </div>
          <div>
            <dt>别名</dt>
            <dd>{group.aliases.length > 0 ? group.aliases.join("、") : "暂无可靠别名"}</dd>
          </div>
        </dl>

        {group.facts.map((fact) => {
          const snapshot = fact.toSnapshot();
          const chapter = chapters.find(
            ({ id }) => String(id) === String(snapshot.source.chapterId),
          );
          const mergeNotice = storyFactMergeNotice(snapshot);
          const ambiguousAlias = readAmbiguousStoryFactEntityAlias(snapshot);
          const needsAliasResolution = storyFactNeedsEntityAliasResolution(snapshot);
          return (
            <section className="story-entity-detail__item" key={fact.id}>
              <div className="card-heading-row">
                <div>
                  <h3>{factTypeLabel(snapshot.factType)}</h3>
                  <p>{factSourceLabel(snapshot)}</p>
                </div>
                <Badge tone={factStatusTone(snapshot)}>{factStatusLabel(snapshot)}</Badge>
              </div>
              <p className="story-governance-copy">{storyFactContent(snapshot)}</p>
              <dl className="story-entity-detail__metadata">
                <div>
                  <dt>来源章节</dt>
                  <dd>
                    {chapter?.title ??
                      (snapshot.source.chapterId === null ? "非章节来源" : "已绑定来源章节")}
                  </dd>
                </div>
                <div>
                  <dt>来源引用</dt>
                  <dd>已保留可审计的来源定位</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{factStatusLabel(snapshot)}</dd>
                </div>
                <div>
                  <dt>可信度</dt>
                  <dd>{Math.round(snapshot.confidence * 100)}%</dd>
                </div>
              </dl>
              <blockquote className="story-source-quote">
                {snapshot.source.excerpt ?? "这条记录没有保存可显示的精确原文片段。"}
              </blockquote>
              {mergeNotice !== null && (
                <InlineAlert
                  tone="warning"
                  title="没有自动合并人物或设定"
                  description={mergeNotice}
                />
              )}
              <div className="story-governance-actions">
                {ambiguousAlias !== null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={readonly || busy}
                    onClick={() => openAliasResolution(fact)}
                  >
                    先辨认这个对象
                  </Button>
                )}
                {(snapshot.status === "unconfirmed" || snapshot.status === "temporary") && (
                  <Button
                    size="sm"
                    disabled={readonly || busy || needsAliasResolution}
                    onClick={() => void confirmFact(fact)}
                  >
                    确认并保留
                  </Button>
                )}
                {snapshot.status === "formal" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={readonly || busy}
                    onClick={() => void toggleFactLock(fact)}
                  >
                    {snapshot.locked ? "取消锁定" : "锁定为硬规则"}
                  </Button>
                )}
                {snapshot.status !== "branch" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readonly || busy}
                    onClick={() => void deprecateFact(fact)}
                  >
                    {snapshot.status === "temporary" ? "撤销这项更新" : "标记为不再生效"}
                  </Button>
                )}
              </div>
            </section>
          );
        })}

        {group.records.map((record) => {
          const snapshot = record.toSnapshot();
          const fields = readFormalFields(record);
          return (
            <section className="story-entity-detail__item" key={record.id}>
              <div className="card-heading-row">
                <div>
                  <h3>{fields.title}</h3>
                </div>
                <Badge tone={formalKindTone(record.kind)}>{formalKindLabel(record.kind)}</Badge>
              </div>
              <p className="story-governance-copy">{fields.description}</p>
              <div className="story-governance-meta">
                <span>正式版本 {String(snapshot.currentVersion)}</span>
                <span>修订 {String(snapshot.revision)}</span>
              </div>
              <div className="story-governance-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={readonly || busy}
                  onClick={() => openEditFormalRecord(record)}
                >
                  编辑正式记录
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readonly || busy || snapshot.currentVersion < 2}
                  onClick={() => void undoFormalRecord(record)}
                >
                  撤回至上一版
                </Button>
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  if (writingExperience.preference === null) {
    return (
      <div className="desktop-page" aria-busy={writingExperience.loading}>
        {writingExperience.loading ? (
          <div role="status">正在读取写作方式…</div>
        ) : (
          <ErrorState
            title="暂时无法打开设定"
            description={writingExperience.error ?? "写作方式没有读取成功，请重试。"}
            primaryAction={{ label: "重试", onClick: () => void writingExperience.refresh() }}
          />
        )}
      </div>
    );
  }

  if (directMode) {
    return (
      <div className="desktop-page story-governance-page">
        <header className="page-heading">
          <div>
            <Link className="back-link" to={"/projects/" + projectIdParameter}>
              返回正文
            </Link>
            <p className="page-heading__eyebrow">人物、地点、关系与规则</p>
            <h1>{project?.name ?? "设定"}</h1>
            <p>查看已经整理的设定和原文依据，也可以添加、固定或移除设定。</p>
          </div>
          <div className="story-governance-summary">
            <Badge>{String(directFormalFacts.length)} 条已保存</Badge>
            {directPendingLocalFacts.length > 0 && (
              <Badge>{String(directPendingLocalFacts.length)} 条待确认</Badge>
            )}
          </div>
        </header>

        {readonly && project !== null && (
          <InlineAlert
            tone="info"
            title={project.status === "archived" ? "项目已归档" : "项目位于回收站"}
            description="设定保持可读，恢复项目后才能修改。"
          />
        )}

        {unavailableDerivedSections.length > 0 && (
          <InlineAlert
            tone="warning"
            title="部分附属资料暂不可用"
            description={`以下附属资料没有读取成功：${unavailableDerivedSections.join(
              "、",
            )}。已有正式设定仍可查看；这些记录没有被删除。请稍后重试。${
              derivedSupportId === null ? "" : ` 支持编号：${derivedSupportId}。`
            }`}
          />
        )}

        {normalizedError !== null && pageState !== "fatal_error" && (
          <InlineAlert
            tone="error"
            title={normalizedError.title}
            description={normalizedError.description}
            onDismiss={() => setError(null)}
          />
        )}

        {causalNotice !== null && (
          <InlineAlert
            tone={causalNotice.tone}
            title={causalNotice.title}
            description={causalNotice.description}
            onDismiss={() => setCausalNotice(null)}
          />
        )}

        {isolatedDirectPendingDuplicateCount > 0 && (
          <InlineAlert
            tone="warning"
            title="已隔离重复的待确认设定"
            description={`${String(
              isolatedDirectPendingDuplicateCount,
            )} 条历史重复记录及审计关系，每组仅显示一条。`}
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
                  description={`${normalizedError.description}${
                    loadSupportId === null ? "" : ` 支持编号：${loadSupportId}。`
                  }`}
                  primaryAction={{ label: "重试", onClick: () => void load() }}
                />
              ),
          }}
        >
          <PendingFactsSection
            id="direct-pending-story-facts-title"
            title="待确认设定"
            description="这些内容来自专业创作输入或本机正文整理；确认前不会成为正式设定。"
            facts={directPendingLocalFacts}
            evidenceByFactId={storyFactEvidenceByFactId}
            chapters={chapters}
            sourceVersions={sourceVersions}
            disabled={readonly || busy}
            onConfirm={(fact) => void confirmFact(fact)}
            onEdit={openEditFact}
            onDiscard={(fact) => void deprecateFact(fact)}
          />

          <section aria-labelledby="direct-story-facts-title">
            <div className="section-heading">
              <div>
                <h2 id="direct-story-facts-title">当前设定</h2>
                <p>每条设定都保留来源；从正文整理的内容可以展开查看原文依据。</p>
              </div>
              <Button disabled={readonly || busy} onClick={openCreateFact}>
                添加设定
              </Button>
            </div>

            {directFormalFacts.length === 0 ? (
              <EmptyState
                title="还没有设定"
                description="可以直接开始写，也可以先添加人物、地点、关系或规则。"
                {...(readonly
                  ? {}
                  : {
                      primaryAction: {
                        label: "添加第一条设定",
                        onClick: openCreateFact,
                      },
                    })}
              />
            ) : (
              <div className="story-governance-grid">
                {directFormalFacts.map((fact) => {
                  const snapshot = fact.toSnapshot();
                  const visibleEvidence = storyFactEvidenceForPresentation(
                    snapshot,
                    storyFactEvidenceByFactId.get(String(fact.id)),
                  );
                  const needsCheck =
                    snapshot.status !== "formal" ||
                    storyFactNeedsEntityAliasResolution(snapshot) ||
                    snapshot.needsReview;
                  const statusLabel =
                    snapshot.status === "formal"
                      ? snapshot.locked
                        ? "已固定"
                        : "已保存"
                      : snapshot.status === "branch"
                        ? "试写资料"
                        : "需要核对";
                  return (
                    <Card key={fact.id}>
                      <CardHeader>
                        <div className="card-heading-row">
                          <div>
                            <CardTitle>{factTypeLabel(snapshot.factType)}</CardTitle>
                            <CardDescription>{factSourceLabel(snapshot)}</CardDescription>
                          </div>
                          <Badge
                            tone={snapshot.locked ? "accent" : needsCheck ? "warning" : "success"}
                          >
                            {statusLabel}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="story-governance-copy">{storyFactContent(snapshot)}</p>
                        {snapshot.structuredValue !== null && (
                          <p className="story-governance-meta">
                            结构化设定暂不支持直接改文字。你仍可查看原文依据、固定，或删除后恢复。
                          </p>
                        )}
                        <EvidenceDisclosure label="查看原文依据">
                          <StoryFactEvidenceDetails
                            evidence={visibleEvidence}
                            chapters={chapters}
                            sourceVersions={sourceVersions}
                          />
                        </EvidenceDisclosure>
                      </CardContent>
                      <CardFooter>
                        {needsCheck ? (
                          <Link
                            className="button-link button-link--secondary"
                            to={"/projects/" + projectIdParameter + "/checks"}
                          >
                            去检查
                          </Link>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={readonly || busy}
                            onClick={() => void toggleFactLock(fact)}
                          >
                            {snapshot.locked ? "取消固定" : "固定"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={
                            readonly ||
                            busy ||
                            snapshot.status === "branch" ||
                            snapshot.locked ||
                            snapshot.structuredValue !== null
                          }
                          onClick={() => openEditFact(fact)}
                        >
                          {"修改"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void openFactHistory(fact)}
                        >
                          {"历史版本"}
                        </Button>
                        {directDuplicateByFactId.has(fact.id) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={readonly || busy}
                            onClick={() => {
                              const duplicate = directDuplicateByFactId.get(fact.id);
                              if (duplicate !== undefined) {
                                setMergeFacts({ survivor: fact, duplicate });
                              }
                            }}
                          >
                            {"合并重复项"}
                          </Button>
                        )}
                        {snapshot.status !== "branch" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={readonly || busy}
                            onClick={() => void deprecateFact(fact)}
                          >
                            删除（保留记录）
                          </Button>
                        )}
                      </CardFooter>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {directDeprecatedFacts.length > 0 && (
            <section aria-labelledby="direct-deleted-facts-title">
              <div className="section-heading">
                <div>
                  <h2 id="direct-deleted-facts-title">已删除的设定</h2>
                  <p>删除不会抹掉记录；需要时可恢复为新的版本。</p>
                </div>
                <Badge>{String(directDeprecatedFacts.length)} 条</Badge>
              </div>
              <div className="story-governance-grid">
                {directDeprecatedFacts.map((fact) => {
                  const snapshot = fact.toSnapshot();
                  return (
                    <Card key={fact.id}>
                      <CardHeader>
                        <CardTitle>{factTypeLabel(snapshot.factType)}</CardTitle>
                        <CardDescription>{factSourceLabel(snapshot)}</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <p className="story-governance-copy">{storyFactContent(snapshot)}</p>
                      </CardContent>
                      <CardFooter>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={readonly || busy}
                          onClick={() => void restoreFact(fact)}
                        >
                          恢复
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void openFactHistory(fact)}
                        >
                          历史版本
                        </Button>
                      </CardFooter>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}
        </PageStateBoundary>

        <Dialog
          open={factDialogOpen}
          onOpenChange={(open) => {
            if (!open && !busy) closeFactDialog();
          }}
          title="添加设定"
          description="保存后仍可查看来源、取消固定或移除。"
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={closeFactDialog}>
                取消
              </Button>
              <Button
                loading={busy}
                disabled={factContent.trim().length === 0}
                onClick={() => void submitFact()}
              >
                保存设定
              </Button>
            </>
          }
        >
          <div className="story-governance-form">
            <FormField label="设定类型" required>
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={factType}
                  options={FACT_TYPE_OPTIONS}
                  onChange={(event) => setFactType(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="内容" hint="只写已经确定的内容。" required>
              {(fieldProps) => (
                <Textarea
                  {...fieldProps}
                  ref={factContentInputRef}
                  value={factContent}
                  maxLength={10_000}
                  currentLength={factContent.length}
                  rows={7}
                  onChange={(event) => setFactContent(event.currentTarget.value)}
                />
              )}
            </FormField>
            <FormField label="重要程度">
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={factLocked ? "locked" : "normal"}
                  options={[
                    { value: "normal", label: "普通设定" },
                    { value: "locked", label: "固定为不可违反的规则" },
                  ]}
                  onChange={(event) => setFactLocked(event.currentTarget.value === "locked")}
                />
              )}
            </FormField>
          </div>
        </Dialog>

        <FactEditDialog
          fact={editingFact}
          content={editingFactContent}
          busy={busy}
          onClose={() => {
            setEditingFact(null);
            setEditingFactContent("");
          }}
          onChange={setEditingFactContent}
          onSubmit={() => void submitFactEdit()}
        />

        <Dialog
          open={historyFact !== null}
          onOpenChange={(open) => {
            if (!open && !busy && !historyLoading) {
              setHistoryFact(null);
              setFactRevisions([]);
            }
          }}
          title="历史版本"
          description="恢复不会覆盖旧记录，而是把所选内容保存成一个新版本。"
          footer={
            <Button
              variant="secondary"
              disabled={busy || historyLoading}
              onClick={() => {
                setHistoryFact(null);
                setFactRevisions([]);
              }}
            >
              关闭
            </Button>
          }
        >
          {historyLoading ? (
            <div role="status">正在读取历史版本…</div>
          ) : (
            <div className="story-governance-grid">
              {[...factRevisions].reverse().map((entry) => {
                const snapshot = entry.fact.toSnapshot();
                const visibleContent =
                  snapshot.contentText ??
                  (typeof snapshot.structuredValue === "string"
                    ? snapshot.structuredValue
                    : "这个版本没有可直接显示的文字内容。");
                const isCurrent = snapshot.revision === historyFact?.revision;
                return (
                  <Card key={String(snapshot.revision)}>
                    <CardHeader>
                      <CardTitle>第 {String(snapshot.revision)} 版</CardTitle>
                      <CardDescription>{isCurrent ? "当前版本" : "已保留的旧版本"}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="story-governance-copy">{visibleContent}</p>
                    </CardContent>
                    {!isCurrent && historyFact !== null && (
                      <CardFooter>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={
                            readonly ||
                            busy ||
                            historyFact.toSnapshot().locked ||
                            historyFact.toSnapshot().structuredValue !== null ||
                            snapshot.structuredValue !== null ||
                            snapshot.contentText === null
                          }
                          onClick={() => void restoreFact(historyFact, snapshot.revision)}
                        >
                          恢复这个版本
                        </Button>
                      </CardFooter>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </Dialog>

        <Dialog
          open={mergeFacts !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setMergeFacts(null);
          }}
          title="合并重复项"
          description="两条设定类型一致且表达相同；空格或换行差异会忽略。确认后保留第一条，并把另一条移入可恢复的删除记录；两步会一起完成。"
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setMergeFacts(null)}>
                取消
              </Button>
              <Button loading={busy} onClick={() => void submitFactMerge()}>
                确认合并
              </Button>
            </>
          }
        >
          {mergeFacts !== null && (
            <div className="story-governance-form">
              <InlineAlert
                tone="info"
                title="将保留"
                description={storyFactContent(mergeFacts.survivor.toSnapshot())}
              />
              <InlineAlert
                tone="warning"
                title="将移入删除记录"
                description={storyFactContent(mergeFacts.duplicate.toSnapshot())}
              />
            </div>
          )}
        </Dialog>
      </div>
    );
  }

  return (
    <div className="desktop-page story-governance-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to={`/projects/${projectIdParameter}`}>
            返回工作区
          </Link>
          <p className="page-heading__eyebrow">人物、世界与故事状态</p>
          <h1>{project?.name ?? "故事设定"}</h1>
          <p>集中管理人物、关系、世界、事件、时间线和规则；AI 的推测不会自动变成正式事实。</p>
        </div>
        <div className="story-governance-summary">
          <Badge>{String(activeFacts.length)} 条故事事实</Badge>
          <Badge tone={pendingFactCount > 0 ? "warning" : "neutral"}>
            {String(pendingFactCount)} 项变化，{String(needsConfirmationCount)} 项需确认
          </Badge>
          <Badge>{String(memories.length)} 条 AI 记住的内容</Badge>
        </div>
      </header>

      {runtime.mode === "browser-development" && (
        <InlineAlert
          tone="warning"
          title="浏览器开发模式"
          description="此处使用浏览器调试存储验证交互；桌面发行版使用同一领域规则和本地数据库并发控制。"
        />
      )}

      {readonly && project !== null && (
        <InlineAlert
          tone="info"
          title={project.status === "archived" ? "项目已归档" : "项目位于回收站"}
          description="治理数据保持可读，恢复项目后才能修改。"
        />
      )}

      <InlineAlert
        tone="warning"
        title="逐章云端识别暂不可用"
        description="一次识别会把最新一章完整正文分别发送给人物提取和世界设定提取，最多两次模型服务调用并可能产生两次费用。当前页面还不能在发送前持久展示精确模型服务、精确模型并把不确定结果锁定为不可重发，因此入口保持停用；正文和已有设定不受影响。"
      />

      {unavailableDerivedSections.length > 0 && (
        <InlineAlert
          tone="warning"
          title="部分附属资料暂不可用"
          description={`以下附属资料没有读取成功：${unavailableDerivedSections.join(
            "、",
          )}。已有正式设定仍可查看；这些记录没有被删除。请稍后重试。${
            derivedSupportId === null ? "" : ` 支持编号：${derivedSupportId}。`
          }`}
        />
      )}

      {normalizedError !== null && pageState !== "fatal_error" && (
        <InlineAlert
          tone="error"
          title={normalizedError.title}
          description={normalizedError.description}
          onDismiss={() => setError(null)}
        />
      )}

      {causalNotice !== null && (
        <InlineAlert
          tone={causalNotice.tone}
          title={causalNotice.title}
          description={causalNotice.description}
          onDismiss={() => setCausalNotice(null)}
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
                description={`${normalizedError.description}${
                  loadSupportId === null ? "" : ` 支持编号：${loadSupportId}。`
                }`}
                primaryAction={{ label: "重试", onClick: () => void load() }}
              />
            ),
        }}
      >
        <>
          <PendingFactsSection
            id="professional-setup-pending-title"
            title="专业创作待确认设定"
            description="这些人物、关系和世界资料已保存在本地；只有你确认后才会成为正式设定。"
            facts={professionalSetupPendingFacts}
            evidenceByFactId={storyFactEvidenceByFactId}
            chapters={chapters}
            sourceVersions={sourceVersions}
            disabled={readonly || busy}
            onConfirm={(fact) => void confirmFact(fact)}
            onEdit={openEditFact}
            onDiscard={(fact) => void deprecateFact(fact)}
          />
          <StorySettingsTools
            runtime={runtime}
            projectId={projectIdParameter}
            projectName={project?.name ?? "墨影"}
            records={records}
            facts={facts}
            memories={memories}
            activeSection={
              activeTab === "characters" ||
              activeTab === "world" ||
              activeTab === "memory" ||
              activeTab === "preferences"
                ? activeTab
                : "other"
            }
            readonly={readonly}
            onChanged={load}
            onOpenManualForm={openManualFactForm}
          />
          <Tabs defaultValue="characters" value={activeTab} onValueChange={setActiveTab}>
            <TabsList label="故事设定分类">
              <TabsTrigger value="characters">人物</TabsTrigger>
              <TabsTrigger value="world">世界与规则</TabsTrigger>
              <TabsTrigger value="memory">AI 记住的内容</TabsTrigger>
              <TabsTrigger value="preferences">写作偏好</TabsTrigger>
            </TabsList>

            {!(PRIMARY_GOVERNANCE_TABS as readonly string[]).includes(activeTab) && (
              <div className="story-governance-advanced-return">
                <TabsList label="当前高级治理工具">
                  <TabsTrigger value={activeTab}>
                    {advancedGovernanceTabLabel(activeTab)}
                  </TabsTrigger>
                </TabsList>
                <Button size="sm" variant="secondary" onClick={() => setActiveTab("world")}>
                  返回世界与规则
                </Button>
              </div>
            )}

            <TabsContent value="characters">
              <section aria-labelledby="character-library-title">
                <div className="section-heading">
                  <div>
                    <h2 id="character-library-title">人物</h2>
                    <p>只按已有实体标识聚合；名称相同但没有可靠关联的人物不会被自动合并。</p>
                  </div>
                  <div className="story-governance-actions">
                    <Button
                      variant="secondary"
                      disabled
                      title="独立云派生授权与不确定结果防重机制完成后开放"
                    >
                      重新识别最近一章（暂不可用）
                    </Button>
                    <Button disabled={readonly || busy} onClick={openCreateFact}>
                      添加人物设定
                    </Button>
                  </div>
                </div>

                {needsConfirmationCount > 0 && (
                  <InlineAlert
                    tone="warning"
                    title={`${String(needsConfirmationCount)} 项重大变化需要确认`}
                    description="人物身份、生死、核心关系和重大能力变化不会因为 AI 识别而自动成为正式事实。"
                  />
                )}

                {characterGroups.length === 0 ? (
                  <EmptyState
                    title="还没有人物设定"
                    description="可以直接开始写作，或先添加一个人物；从正文识别出的内容会保留原文证据并等待你确认。"
                    {...(readonly
                      ? {}
                      : { primaryAction: { label: "添加第一个人物", onClick: openCreateFact } })}
                  />
                ) : (
                  <div className="story-entity-grid">
                    {characterGroups.map((group) => (
                      <Card key={group.key}>
                        <CardHeader>
                          <div className="card-heading-row">
                            <div>
                              <CardTitle>{group.name}</CardTitle>
                              <CardDescription>
                                {group.aliases.length > 0
                                  ? `别名：${group.aliases.join("、")}`
                                  : "暂无已确认别名"}
                              </CardDescription>
                            </div>
                            <Badge tone={entityGroupStatusTone(group)}>
                              {entityGroupStatusLabel(group)}
                            </Badge>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <p className="story-governance-copy">{entityGroupSummary(group)}</p>
                          <div className="story-governance-meta">
                            <span>{String(group.facts.length)} 项事实</span>
                            <span>{String(group.records.length)} 条正式记录</span>
                            <span>{String(entityChapterIds(group).length)} 个来源章节</span>
                          </div>
                        </CardContent>
                        <CardFooter>
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-haspopup="dialog"
                            aria-expanded={selectedCharacterKey === group.key}
                            aria-controls="story-character-detail"
                            onClick={(event) => {
                              event.currentTarget.focus();
                              setSelectedCharacterKey(group.key);
                            }}
                          >
                            查看人物详情
                          </Button>
                        </CardFooter>
                      </Card>
                    ))}
                  </div>
                )}
              </section>
            </TabsContent>

            <TabsContent value="world">
              <section aria-labelledby="world-library-title">
                <div className="section-heading">
                  <div>
                    <h2 id="world-library-title">世界与规则</h2>
                    <p>
                      地点、规则和组织按真实类型或实体标识分组；无法可靠分类的内容保留在“其他设定”。
                    </p>
                  </div>
                  <Button disabled={readonly || busy} onClick={openCreateFact}>
                    添加世界设定
                  </Button>
                </div>

                {worldGroups.length === 0 ? (
                  <EmptyState
                    title="还没有世界设定"
                    description="世界设定不是开始写作的必填项。需要时可添加地点、硬规则或组织，也可以从已保存正文重新识别。"
                    {...(readonly
                      ? {}
                      : { primaryAction: { label: "添加第一条设定", onClick: openCreateFact } })}
                  />
                ) : (
                  <div className="story-world-sections">
                    {WORLD_SECTION_ORDER.map((sectionKind) => {
                      const groups = worldGroups.filter(
                        ({ worldSection }) => worldSection === sectionKind,
                      );
                      if (groups.length === 0) return null;
                      return (
                        <section key={sectionKind} aria-labelledby={`world-${sectionKind}-title`}>
                          <div className="section-heading section-heading--compact">
                            <h3 id={`world-${sectionKind}-title`}>
                              {worldSectionLabel(sectionKind)}
                            </h3>
                            <Badge>{String(groups.length)} 项</Badge>
                          </div>
                          <div className="story-entity-grid">
                            {groups.map((group) => (
                              <Card key={group.key}>
                                <CardHeader>
                                  <div className="card-heading-row">
                                    <div>
                                      <CardTitle>{group.name}</CardTitle>
                                      <CardDescription>
                                        {worldSectionLabel(sectionKind)}
                                      </CardDescription>
                                    </div>
                                    <Badge tone={entityGroupStatusTone(group)}>
                                      {entityGroupStatusLabel(group)}
                                    </Badge>
                                  </div>
                                </CardHeader>
                                <CardContent>
                                  <p className="story-governance-copy">
                                    {entityGroupSummary(group)}
                                  </p>
                                  <div className="story-governance-meta">
                                    <span>{String(group.facts.length)} 项事实</span>
                                    <span>{String(entityChapterIds(group).length)} 个引用章节</span>
                                  </div>
                                </CardContent>
                                <CardFooter>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => setSelectedWorldKey(group.key)}
                                  >
                                    查看设定详情
                                  </Button>
                                </CardFooter>
                              </Card>
                            ))}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                )}

                <Card className="story-governance-advanced-tools">
                  <CardHeader>
                    <CardTitle>更多治理工具</CardTitle>
                    <CardDescription>
                      待确认变化、版本化正式记录和剧情试演保留原有安全边界，但不作为普通用户一级导航。
                    </CardDescription>
                  </CardHeader>
                  <CardFooter className="story-governance-actions">
                    <Button size="sm" variant="secondary" onClick={() => setActiveTab("facts")}>
                      查看全部故事事实
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setActiveTab("review")}>
                      待确认变化
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setActiveTab("formal")}>
                      版本化正式记录
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => navigate(`/projects/${projectIdParameter}/graph`)}
                    >
                      因果剧情试演
                    </Button>
                    {whatIfBranches.length > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => setActiveTab("what-if")}>
                        查看旧版试演记录
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              </section>
            </TabsContent>

            <TabsContent value="facts">
              <section aria-labelledby="unified-story-facts-title">
                <InlineAlert
                  tone="info"
                  title={`识别到 ${String(pendingFactCount)} 项变化，其中 ${String(needsConfirmationCount)} 项需要确认`}
                  description="普通状态可作为可撤销参考；人物死亡、身份、核心关系、世界规则等重大变化只有在你确认后才会影响后续创作。"
                />
                <div className="section-heading">
                  <div>
                    <h2 id="unified-story-facts-title">当前故事设定</h2>
                    <p>
                      每项内容都保留来源、状态和修订记录；“重新识别”会调用已连接的
                      AI；独立授权和不确定结果防重机制完成前不会开放。
                    </p>
                  </div>
                  <div className="story-governance-actions">
                    <Button
                      variant="secondary"
                      disabled
                      title="独立云派生授权与不确定结果防重机制完成后开放"
                    >
                      重新识别最近一章（暂不可用）
                    </Button>
                    <Button disabled={readonly || busy} onClick={openCreateFact}>
                      添加设定
                    </Button>
                  </div>
                </div>

                {activeFacts.length === 0 ? (
                  <EmptyState
                    title="还没有整理故事设定"
                    description="可以直接开始写，也可以先添加一个人物、世界规则或时间线事件；这些都不是开写前的必填项。"
                    {...(readonly
                      ? {}
                      : {
                          primaryAction: {
                            label: "添加第一条设定",
                            onClick: openCreateFact,
                          },
                        })}
                  />
                ) : (
                  <div className="story-governance-grid">
                    {activeFacts.map((fact) => {
                      const snapshot = fact.toSnapshot();
                      const continuousEvidence = continuousEvidenceByFactId.get(fact.id);
                      const mergeNotice = storyFactMergeNotice(snapshot);
                      const ambiguousAlias = readAmbiguousStoryFactEntityAlias(snapshot);
                      const needsAliasResolution = storyFactNeedsEntityAliasResolution(snapshot);
                      return (
                        <Card key={fact.id}>
                          <CardHeader>
                            <div className="card-heading-row">
                              <div>
                                <CardTitle>{factTypeLabel(snapshot.factType)}</CardTitle>
                                <CardDescription>{factSourceLabel(snapshot)}</CardDescription>
                              </div>
                              <Badge tone={factStatusTone(snapshot)}>
                                {factStatusLabel(snapshot)}
                              </Badge>
                            </div>
                          </CardHeader>
                          <CardContent>
                            <p className="story-governance-copy">{storyFactContent(snapshot)}</p>
                            <div className="story-governance-meta">
                              <span>可信度 {Math.round(snapshot.confidence * 100)}%</span>
                              <span>修订 {String(snapshot.revision)}</span>
                            </div>
                            {continuousEvidence !== undefined && (
                              <InlineAlert
                                tone={
                                  continuousEvidence.evidenceState === "current"
                                    ? "info"
                                    : "warning"
                                }
                                title={
                                  continuousEvidence.evidenceState === "current"
                                    ? "证据与当前正文一致"
                                    : continuousEvidence.evidenceState === "historical"
                                      ? "来自较早的正文版本"
                                      : "证据无法验证"
                                }
                                description={continuousEvidence.evidenceMessage}
                              />
                            )}
                            {mergeNotice !== null && (
                              <InlineAlert
                                tone="warning"
                                title="人物或剧情对象需要你辨认"
                                description={mergeNotice}
                              />
                            )}
                          </CardContent>
                          <CardFooter>
                            {ambiguousAlias !== null && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={readonly || busy}
                                onClick={() => openAliasResolution(fact)}
                              >
                                先辨认这个对象
                              </Button>
                            )}
                            {(snapshot.status === "unconfirmed" ||
                              snapshot.status === "temporary") && (
                              <Button
                                size="sm"
                                disabled={readonly || busy || needsAliasResolution}
                                onClick={() => void confirmFact(fact)}
                              >
                                确认并保留
                              </Button>
                            )}
                            {snapshot.status === "formal" && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={readonly || busy}
                                onClick={() => void toggleFactLock(fact)}
                              >
                                {snapshot.locked ? "取消锁定" : "锁定为硬规则"}
                              </Button>
                            )}
                            {snapshot.status !== "branch" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={readonly || busy}
                                onClick={() => void deprecateFact(fact)}
                              >
                                {snapshot.status === "temporary"
                                  ? "撤销这项更新"
                                  : "标记为不再生效"}
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

            <TabsContent value="context-history">
              <ChapterSummaryPanel
                projectId={projectIdParameter}
                service={runtime.story.chapterSummaries}
                continuousState={runtime.story.continuousState}
                historicalBackfill={runtime.story.historicalBackfill}
                readOnly={readonly}
              />
              <ContextHistoryPanel
                projectId={projectIdParameter}
                store={runtime.contextTraces}
                novelSkills={runtime.novelSkills}
              />
            </TabsContent>

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
                      <Badge
                        tone={policy?.automaticLearningEnabled === true ? "success" : "neutral"}
                      >
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
                  <div className="story-governance-actions">
                    <Button
                      variant="secondary"
                      disabled={readonly || busy || mergeMemories.length !== 2}
                      onClick={openMergeMemories}
                    >
                      合并所选 2 条
                    </Button>
                    <Button variant="secondary" onClick={() => setActiveTab("context-history")}>
                      查看 AI 参考记录
                    </Button>
                    <Button disabled={readonly || busy} onClick={openCreateMemory}>
                      添加用户记忆
                    </Button>
                  </div>
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
                      const promotion = memoryPromotionById.get(memory.id) ?? null;
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
                                {promotion !== null && (
                                  <Badge tone={memoryPromotionTone(promotion.status)}>
                                    {memoryPromotionLabel(promotion.status)}
                                  </Badge>
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
                              variant={mergeMemoryIds.includes(memory.id) ? "primary" : "secondary"}
                              disabled={
                                readonly ||
                                busy ||
                                snapshot.excluded ||
                                (mergeMemoryIds.length >= 2 && !mergeMemoryIds.includes(memory.id))
                              }
                              aria-pressed={mergeMemoryIds.includes(memory.id)}
                              onClick={() => toggleMergeMemory(memory.id)}
                            >
                              {mergeMemoryIds.includes(memory.id) ? "已选择合并" : "选择用于合并"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setSelectedMemoryId(memory.id)}
                            >
                              查看记忆详情
                            </Button>
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
                  description="每项变化都保留章节版本和精确证据范围；确认时会再次校验章节仍是该版本，并与正式设定更新同事务提交。"
                />
                <div className="section-heading">
                  <div>
                    <h2 id="review-items-title">待确认的设定变化</h2>
                    <p>
                      当前支持人工准备变化建议；AI 识别出的变化以后也必须进入同一审阅与确认流程。
                    </p>
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
                    准备一项变化
                  </Button>
                </div>

                {records.length === 0 ? (
                  <EmptyState
                    title="还没有可审阅的正式设定"
                    description="先创建至少一条正式设定，再准备一项有明确目标的变化。"
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
                    description="变化必须引用一个非空章节的精确证据片段。"
                  />
                ) : reviewItems.length === 0 ? (
                  <EmptyState
                    title="还没有待确认变化"
                    description="准备一项人工变化，验证证据、版本和正式设定的安全提交链路。"
                    {...(readonly
                      ? {}
                      : {
                          primaryAction: {
                            label: "准备一项变化",
                            onClick: openCreateReview,
                          },
                        })}
                  />
                ) : (
                  <div className="story-review-list">
                    {reviewItems.map((item) => {
                      const snapshot = item.toSnapshot();
                      const target = records.find(
                        (record) => record.id === snapshot.targetRecordId,
                      );
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
                                    ? "待恢复的正式设定"
                                    : readFormalFields(target).title}
                                </CardTitle>
                                <CardDescription>
                                  {chapter?.title ?? "来源章节待恢复"} · 已绑定对应不可变版本
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
                              <span>
                                置信度 {Math.round(snapshot.confidence * 100).toString()}%
                              </span>
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

            <TabsContent value="preferences">
              {storyProjectId.ok && (
                <>
                  <WritingPreferencesPanel
                    projectId={storyProjectId.value}
                    service={runtime.story.writingFeedback}
                    readonly={readonly}
                  />
                  <NovelSkillPanel
                    projectId={storyProjectId.value}
                    runtime={runtime.novelSkills}
                    readonly={readonly}
                  />
                </>
              )}
            </TabsContent>

            <TabsContent value="what-if">
              <section aria-labelledby="what-if-title">
                <InlineAlert
                  tone="warning"
                  title="旧版试演已停止新建"
                  description="这些记录仅供查看和迁移参考。新的剧情试演统一使用因果事件图确定影响范围，并保留锁定规则编译与模型调用证据。"
                />
                <div className="section-heading">
                  <div>
                    <h2 id="what-if-title">旧版试演记录</h2>
                    <p>历史沙盒与已生成的大纲草稿保持原样，不会自动转成正式事实。</p>
                  </div>
                  <Button onClick={() => navigate(`/projects/${projectIdParameter}/graph`)}>
                    前往因果剧情试演
                  </Button>
                </div>

                {whatIfBranches.length === 0 ? (
                  <EmptyState
                    title="没有旧版试演记录"
                    description="这里不会再创建自由输入的非因果模拟；请使用统一的因果剧情试演。"
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
                                    ? "待恢复的来源事件"
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
                                      置信度 {Math.round(effect.confidence * 100).toString()}% ·
                                      影响 {String(effect.impactedRecordIds.length)} 条设定
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
                            {snapshot.status === "simulated" && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                onClick={() => void compareWhatIf(branch)}
                              >
                                只读比较
                              </Button>
                            )}
                            <Badge tone="neutral">只读历史</Badge>
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
                        <h2>待采用的大纲草稿</h2>
                        <p>旧版试演生成的历史建议，仅供迁移参考，不会自动合并。</p>
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
        </>
      </PageStateBoundary>

      <Drawer
        open={selectedCharacter !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedCharacterKey(null);
        }}
        title={selectedCharacter?.name ?? "人物详情"}
        description="字段、状态、来源原文和章节引用均来自当前本地记录；没有可靠关联时不会按姓名猜测合并。"
        footer={
          <Button variant="secondary" onClick={() => setSelectedCharacterKey(null)}>
            关闭
          </Button>
        }
      >
        {selectedCharacter !== null && (
          <div id="story-character-detail">{renderEntityGroupDetails(selectedCharacter)}</div>
        )}
      </Drawer>

      <Drawer
        open={selectedWorld !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedWorldKey(null);
        }}
        title={selectedWorld?.name ?? "设定详情"}
        description="只显示已经保存的设定、状态与引用；缺少精确原文时会明确说明。"
        footer={
          <Button variant="secondary" onClick={() => setSelectedWorldKey(null)}>
            关闭
          </Button>
        }
      >
        {selectedWorld !== null && renderEntityGroupDetails(selectedWorld)}
      </Drawer>

      <Drawer
        open={selectedMemory !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedMemoryId(null);
        }}
        title="AI 记住的内容"
        description="这里展示本地记忆的来源、状态和治理方式；忘掉会排除后续使用，但保留可审计记录。"
        footer={
          <Button variant="secondary" onClick={() => setSelectedMemoryId(null)}>
            关闭
          </Button>
        }
      >
        {selectedMemory !== null &&
          (() => {
            const snapshot = selectedMemory.toSnapshot();
            const promotion = memoryPromotionById.get(selectedMemory.id) ?? null;
            const sourceChapter = chapters.find(
              ({ id }) => String(id) === snapshot.source.sourceId,
            );
            return (
              <div className="story-entity-detail">
                <p className="story-governance-copy">{snapshot.content}</p>
                <dl className="story-entity-detail__metadata">
                  <div>
                    <dt>记忆层级</dt>
                    <dd>{memoryLevelLabel(snapshot.level)}</dd>
                  </div>
                  <div>
                    <dt>状态</dt>
                    <dd>
                      {snapshot.excluded
                        ? "已忘掉"
                        : snapshot.status === "enabled"
                          ? "启用"
                          : "停用"}
                    </dd>
                  </div>
                  <div>
                    <dt>来源</dt>
                    <dd>{memorySourceLabel(snapshot.source.kind)}</dd>
                  </div>
                  <div>
                    <dt>来源章节或对象</dt>
                    <dd>{sourceChapter?.title ?? "已绑定来源对象"}</dd>
                  </div>
                  <div>
                    <dt>来源版本</dt>
                    <dd>
                      {snapshot.source.sourceVersionId === null
                        ? "没有版本引用"
                        : "已绑定不可变版本"}
                    </dd>
                  </div>
                  <div>
                    <dt>已使用</dt>
                    <dd>{String(snapshot.useCount)} 次</dd>
                  </div>
                  <div>
                    <dt>正式设定转换</dt>
                    <dd>
                      {promotion === null ? "尚未检查" : memoryPromotionLabel(promotion.status)}
                    </dd>
                  </div>
                </dl>
                <blockquote className="story-source-quote">
                  {snapshot.source.kind === "chapter" && sourceChapter !== undefined
                    ? `证据指向章节《${sourceChapter.title}》及上方来源版本；当前记忆底层没有保存精确原文范围，无法在此还原原文片段。`
                    : "这条记忆只保存了来源对象和版本，没有可显示的精确原文证据。"}
                </blockquote>
                <InlineAlert
                  tone="info"
                  title="记忆只会由你手动合并"
                  description="墨影不会仅凭文字相似自动合并。请回到列表选择两条记忆，核对各自来源、指定保留项并编辑合并内容；来源项只会被排除，不会删除。"
                />
                <div className="story-governance-actions">
                  <Button
                    disabled={
                      readonly ||
                      busy ||
                      promotion?.status === "converted" ||
                      promotion?.status === "duplicate"
                    }
                    onClick={() => void keepMemoryAsSetting(selectedMemory)}
                  >
                    {promotion?.status === "converted"
                      ? "已保留为设定"
                      : promotion?.status === "duplicate"
                        ? "已有重复转换"
                        : promotion?.status === "conflict"
                          ? "处理转换冲突"
                          : "保留为设定"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={readonly || busy || snapshot.excluded}
                    onClick={() => void forgetMemory(selectedMemory)}
                  >
                    忘掉
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={readonly || busy}
                    onClick={() => openEditMemory(selectedMemory)}
                  >
                    编辑记忆
                  </Button>
                </div>
              </div>
            );
          })()}
      </Drawer>

      <FactEditDialog
        fact={editingFact}
        content={editingFactContent}
        busy={busy}
        onClose={() => {
          setEditingFact(null);
          setEditingFactContent("");
        }}
        onChange={setEditingFactContent}
        onSubmit={() => void submitFactEdit()}
      />

      <Dialog
        open={memoryPromotionDialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setMemoryPromotionDialog(null);
        }}
        title="保留为正式设定"
        description="这里只把这条旧记忆的当前内容写入唯一的正式故事事实链。预览不会写入；只有下方的明确确认才会晋升，旧记忆和审计来源都会保留。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setMemoryPromotionDialog(null)}
            >
              {memoryPromotionDialog?.canConfirm === true ? "取消" : "完成"}
            </Button>
            {memoryPromotionDialog?.canConfirm === true && (
              <Button loading={busy} onClick={() => void confirmMemoryPromotion()}>
                {memoryPromotionDialog.requiresConflictConfirmation
                  ? "确认保留为新设定"
                  : "确认保留为正式设定"}
              </Button>
            )}
          </>
        }
      >
        {memoryPromotionDialog !== null && promotedMemory !== null && (
          <div className="story-governance-form">
            <InlineAlert
              tone={memoryPromotionDialog.status === "conflict" ? "warning" : "info"}
              title={memoryPromotionLabel(memoryPromotionDialog.status)}
              description={memoryPromotionDescription(memoryPromotionDialog)}
            />
            <div className="story-review-suggestion">
              <strong>将保留的内容</strong>
              <blockquote className="story-source-quote">
                {promotedMemory.toSnapshot().content}
              </blockquote>
            </div>
            <p className="story-governance-copy">
              目标是正式故事事实。转换会留下旧记忆修订与正式事实
              的来源关联，不会删除、改写或自动再次提升这条记忆。
            </p>
          </div>
        )}
      </Dialog>

      <Dialog
        open={aliasResolutionFact !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setAliasResolutionFactId(null);
            setAliasResolutionChoice("");
          }
        }}
        title="这段原文说的是哪个对象？"
        description="同一个名称对应多个已确认对象。请选择原文实际指向的对象；如果都不是，可以明确保留为新的独立对象。这个选择不会同时确认事实内容。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setAliasResolutionFactId(null);
                setAliasResolutionChoice("");
              }}
            >
              取消
            </Button>
            <Button
              loading={busy}
              disabled={aliasResolutionChoice.length === 0}
              onClick={() => void resolveFactAlias()}
            >
              保存对象选择
            </Button>
          </>
        }
      >
        <div className="story-governance-form">
          <FormField
            label="原文中的对象"
            hint="这里只解决对象归属；保存后仍需单独点击“确认并保留”。"
            required
          >
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={aliasResolutionChoice}
                options={[{ value: "", label: "请选择一个对象" }, ...aliasResolutionOptions]}
                onChange={(event) => setAliasResolutionChoice(event.currentTarget.value)}
              />
            )}
          </FormField>
        </div>
      </Dialog>

      <Dialog
        open={factDialogOpen}
        onOpenChange={(open) => {
          if (!busy) {
            if (open) {
              setFactDialogOpen(true);
            } else {
              closeFactDialog();
            }
          }
        }}
        initialFocusRef={factContentInputRef}
        title="添加故事设定"
        description="保存表示这条内容由你本人确认。你可以以后取消锁定或标记为不再生效，历史记录仍会保留。"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={closeFactDialog}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={factContent.trim().length === 0}
              onClick={() => void submitFact()}
            >
              确认保存
            </Button>
          </>
        }
      >
        <div className="story-governance-form">
          <FormField label="设定类型" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={factType}
                options={FACT_TYPE_OPTIONS}
                onChange={(event) => setFactType(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField
            label="内容"
            hint="只写已经确定的内容；不确定的猜测可以继续留在待确认变化中。"
            required
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                ref={factContentInputRef}
                value={factContent}
                maxLength={10_000}
                currentLength={factContent.length}
                rows={7}
                onChange={(event) => setFactContent(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField label="AI 写作时的优先级">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={factLocked ? "locked" : "normal"}
                options={[
                  { value: "normal", label: "普通正式设定" },
                  { value: "locked", label: "锁定为不可违反的硬规则" },
                ]}
                onChange={(event) => setFactLocked(event.currentTarget.value === "locked")}
              />
            )}
          </FormField>
        </div>
      </Dialog>

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
        open={mergeDialogOpen}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setMergeDialogOpen(false);
            setMergeOperationId(null);
          }
        }}
        title="手动合并两条记忆"
        description="先核对两条记忆的来源，再指定保留哪一条记录。保存后会更新保留项并排除另一项，二者的原始来源和操作前后快照都保留在审计记录中。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setMergeDialogOpen(false);
                setMergeOperationId(null);
              }}
            >
              取消
            </Button>
            <Button
              loading={busy}
              disabled={mergeMemories.length !== 2 || mergedMemoryContent.trim().length === 0}
              onClick={() => void submitMemoryMerge()}
            >
              确认合并
            </Button>
          </>
        }
      >
        <div className="story-governance-form">
          <FormField
            label="保留的记忆记录"
            hint="被保留的记录会承载下方合并内容；另一条只标记为已忘掉，不会删除。"
            required
          >
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={mergeTargetId}
                options={mergeMemories.map((memory, index) => ({
                  value: memory.id,
                  label: `记忆 ${String(index + 1)} · ${memoryLevelLabel(memory.toSnapshot().level)}`,
                }))}
                onChange={(event) => setMergeTargetId(event.currentTarget.value)}
              />
            )}
          </FormField>

          {mergeMemories.map((memory, index) => {
            const snapshot = memory.toSnapshot();
            return (
              <Card key={memory.id}>
                <CardHeader>
                  <div className="card-heading-row">
                    <div>
                      <CardTitle headingLevel={3}>记忆 {String(index + 1)}</CardTitle>
                      <CardDescription>
                        {memorySourceLabel(snapshot.source.kind)} · 修订 {String(snapshot.revision)}
                      </CardDescription>
                    </div>
                    {memory.id === mergeTargetId && <Badge tone="accent">保留项</Badge>}
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="story-governance-copy">{snapshot.content}</p>
                  <div className="story-governance-meta">
                    <span>来源对象：已绑定</span>
                    <span>
                      来源版本：{snapshot.source.sourceVersionId === null ? "无" : "已绑定"}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          <FormField
            label="合并后的内容"
            hint="请自行校对并编辑；墨影不会根据相似度自动生成或覆盖内容。"
            required
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={mergedMemoryContent}
                maxLength={1000}
                currentLength={mergedMemoryContent.length}
                rows={7}
                onChange={(event) => setMergedMemoryContent(event.currentTarget.value)}
              />
            )}
          </FormField>
          <InlineAlert
            tone="warning"
            title="合并不会删除来源"
            description="两条记录会在一个事务中完成更新；任何版本冲突或审计写入失败都会整体回滚。"
          />
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
        description="保存即表示你确认这条内容可参与后续故事资料选择。"
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
        title="准备一项设定变化"
        description="变化建议不会自动修改正式设定；只有后续明确接受且来源版本仍一致时才会提交。"
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
              保存为待确认变化
            </Button>
          </>
        }
      >
        <div className="story-governance-form">
          <FormField label="变化类型" required>
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
    </div>
  );
}

function buildCharacterGroups(
  facts: readonly StoryFact[],
  records: readonly FormalStoryRecord[],
): readonly StoryEntityGroup[] {
  const groups = new Map<
    string,
    {
      name: string;
      aliases: string[];
      facts: StoryFact[];
      records: FormalStoryRecord[];
    }
  >();
  for (const record of records.filter(({ kind }) => kind === "character")) {
    const fields = readFormalFields(record);
    groups.set(`entity:${record.toSnapshot().recordKey}`, {
      name: fields.title,
      aliases: [],
      facts: [],
      records: [record],
    });
  }
  for (const fact of facts) {
    const snapshot = fact.toSnapshot();
    const subject = readFactSubject(snapshot);
    if (!isCharacterFact(snapshot.factType, subject?.kind ?? null)) continue;
    const key =
      subject?.entityKey === null || subject?.entityKey === undefined
        ? `fact:${fact.id}`
        : `entity:${subject.entityKey}`;
    const existing = groups.get(key) ?? {
      name: subject?.canonicalName ?? factTypeLabel(snapshot.factType),
      aliases: [],
      facts: [],
      records: [],
    };
    existing.facts.push(fact);
    existing.aliases.push(...(subject?.aliases ?? []));
    groups.set(key, existing);
  }
  return freezeEntityGroups(groups, null);
}

function buildWorldGroups(
  facts: readonly StoryFact[],
  records: readonly FormalStoryRecord[],
): readonly StoryEntityGroup[] {
  const groups = new Map<
    string,
    {
      name: string;
      aliases: string[];
      facts: StoryFact[];
      records: FormalStoryRecord[];
      worldSection: WorldSectionKind;
    }
  >();
  for (const record of records.filter(({ kind }) => kind !== "character")) {
    const fields = readFormalFields(record);
    const worldSection = worldSectionForFormalKind(record.kind);
    groups.set(`entity:${record.toSnapshot().recordKey}`, {
      name: fields.title,
      aliases: [],
      facts: [],
      records: [record],
      worldSection,
    });
  }
  for (const fact of facts) {
    const snapshot = fact.toSnapshot();
    const subject = readFactSubject(snapshot);
    if (!isWorldFact(snapshot.factType, subject?.kind ?? null)) continue;
    const worldSection = worldSectionForFactType(snapshot.factType);
    const key =
      subject?.entityKey === null || subject?.entityKey === undefined
        ? `fact:${fact.id}`
        : `entity:${subject.entityKey}`;
    const existing = groups.get(key) ?? {
      name: subject?.canonicalName ?? factTypeLabel(snapshot.factType),
      aliases: [],
      facts: [],
      records: [],
      worldSection,
    };
    existing.facts.push(fact);
    existing.aliases.push(...(subject?.aliases ?? []));
    groups.set(key, existing);
  }
  return Object.freeze(
    [...groups.entries()]
      .map(([key, group]) =>
        Object.freeze({
          key,
          name: group.name,
          aliases: Object.freeze([...new Set(group.aliases)]),
          facts: Object.freeze([...group.facts]),
          records: Object.freeze([...group.records]),
          worldSection: group.worldSection,
        }),
      )
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
  );
}

function freezeEntityGroups(
  groups: ReadonlyMap<
    string,
    {
      name: string;
      aliases: string[];
      facts: StoryFact[];
      records: FormalStoryRecord[];
    }
  >,
  worldSection: WorldSectionKind | null,
): readonly StoryEntityGroup[] {
  return Object.freeze(
    [...groups.entries()]
      .map(([key, group]) =>
        Object.freeze({
          key,
          name: group.name,
          aliases: Object.freeze([...new Set(group.aliases)]),
          facts: Object.freeze([...group.facts]),
          records: Object.freeze([...group.records]),
          worldSection,
        }),
      )
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
  );
}

function readFactSubject(snapshot: StoryFactSnapshot): Readonly<{
  kind: string | null;
  entityKey: string | null;
  canonicalName: string | null;
  aliases: readonly string[];
}> | null {
  if (!isStoryObject(snapshot.structuredValue)) return null;
  const subject = snapshot.structuredValue.subject;
  if (!isStoryObject(subject)) return null;
  return Object.freeze({
    kind: typeof subject.kind === "string" ? subject.kind : null,
    entityKey: typeof subject.entityKey === "string" ? subject.entityKey : null,
    canonicalName: typeof subject.canonicalName === "string" ? subject.canonicalName : null,
    aliases: Object.freeze(
      Array.isArray(subject.aliases)
        ? subject.aliases.filter((value): value is string => typeof value === "string")
        : [],
    ),
  });
}

function isCharacterFact(factType: string, subjectKind: string | null): boolean {
  return (
    subjectKind === "character" ||
    factType.includes("character") ||
    factType.includes("relationship") ||
    factType === "pov_knowledge" ||
    factType === "core_relationship"
  );
}

function isWorldFact(factType: string, subjectKind: string | null): boolean {
  if (subjectKind === "world") return true;
  return [
    "world",
    "location",
    "place",
    "geography",
    "organization",
    "faction",
    "rule",
    "timeline",
    "causal",
    "foreshadow",
    "plotline",
    "key_item",
    "setting",
  ].some((token) => factType.includes(token));
}

function worldSectionForFactType(factType: string): WorldSectionKind {
  if (["location", "place", "geography"].some((token) => factType.includes(token))) {
    return "location";
  }
  if (["rule", "constraint", "boundary"].some((token) => factType.includes(token))) {
    return "rule";
  }
  if (["organization", "faction", "group"].some((token) => factType.includes(token))) {
    return "organization";
  }
  return "other";
}

function worldSectionForFormalKind(kind: FormalRecordKind): WorldSectionKind {
  return kind === "world_rule" ? "rule" : "other";
}

function worldSectionLabel(kind: WorldSectionKind): string {
  const labels: Record<WorldSectionKind, string> = {
    location: "地点",
    rule: "规则",
    organization: "组织",
    other: "其他设定",
  };
  return labels[kind];
}

function advancedGovernanceTabLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    facts: "全部故事事实",
    review: "待确认变化",
    formal: "版本化正式记录",
    "what-if": "旧版试演记录",
    "context-history": "AI 参考记录",
  };
  return labels[value] ?? "高级治理工具";
}

function groupNeedsConfirmation(group: StoryEntityGroup): boolean {
  return group.facts.some((fact) => {
    const snapshot = fact.toSnapshot();
    return snapshot.needsReview || snapshot.status === "unconfirmed";
  });
}

function groupHasReversibleUpdate(group: StoryEntityGroup): boolean {
  return group.facts.some(({ status }) => status === "temporary");
}

function entityGroupStatusLabel(group: StoryEntityGroup): string {
  if (groupNeedsConfirmation(group)) return "需要确认";
  if (groupHasReversibleUpdate(group)) return "可撤销更新";
  return "已记录";
}

function entityGroupStatusTone(group: StoryEntityGroup): "info" | "warning" | "success" {
  if (groupNeedsConfirmation(group)) return "warning";
  return groupHasReversibleUpdate(group) ? "info" : "success";
}

function entityGroupSummary(group: StoryEntityGroup): string {
  const firstFact = group.facts[0];
  if (firstFact !== undefined) return storyFactContent(firstFact.toSnapshot());
  const firstRecord = group.records[0];
  return firstRecord === undefined ? "暂无可显示内容" : readFormalFields(firstRecord).description;
}

function entityChapterIds(group: StoryEntityGroup): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        group.facts
          .map((fact) => fact.toSnapshot().source.chapterId)
          .filter((chapterId): chapterId is NonNullable<typeof chapterId> => chapterId !== null),
      ),
    ].map(String),
  );
}

function readFormalFields(record: FormalStoryRecord): {
  readonly title: string;
  readonly description: string;
} {
  return readStoryValueFields(record.currentValue, "旧结构化设定");
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
    description: "这条旧设定使用结构化格式保存；普通视图不会显示内部字段，请在人工表单中复核。",
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

function isStoryObject(
  value: StoryValue | undefined,
): value is Readonly<Record<string, StoryValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectLocalStoryFact(snapshot: StoryFactSnapshot): boolean {
  return (
    snapshot.source.kind === "chapter_span" &&
    snapshot.source.reference.startsWith("direct-local:inkshadow.direct-local-story-fact.v1:")
  );
}

function isolateHistoricalDirectPendingDuplicates(
  facts: readonly StoryFact[],
  initialIdentityByFactId: ReadonlyMap<string, DirectLocalPendingEvidenceIdentity>,
): Readonly<{
  visibleFacts: readonly StoryFact[];
  isolatedDuplicateCount: number;
}> {
  const groups = new Map<string, { readonly pending: StoryFact[]; hasAuthorDecision: boolean }>();
  let isolatedDuplicateCount = 0;
  for (const fact of facts) {
    const snapshot = fact.toSnapshot();
    const currentIdentity = directLocalPendingEvidenceIdentity(snapshot);
    const identity = initialIdentityByFactId.get(fact.id) ?? currentIdentity;
    const userDraftIdentity = userDraftFactIdentity(snapshot);
    const identityKey = userDraftIdentity ?? identity?.key ?? null;
    if (identityKey === null) continue;
    const group = groups.get(identityKey) ?? { pending: [], hasAuthorDecision: false };
    if (userDraftIdentity !== null) {
      if (snapshot.status === "unconfirmed" && snapshot.needsReview && !snapshot.userConfirmed) {
        group.pending.push(fact);
      } else {
        group.hasAuthorDecision = true;
      }
    } else if (currentIdentity === null) group.hasAuthorDecision = true;
    else group.pending.push(fact);
    groups.set(identityKey, group);
  }
  const visibleFacts: StoryFact[] = [];
  for (const group of groups.values()) {
    group.pending.sort((left, right) => {
      const leftSnapshot = left.toSnapshot();
      const rightSnapshot = right.toSnapshot();
      return (
        leftSnapshot.createdAt.localeCompare(rightSnapshot.createdAt) ||
        left.id.localeCompare(right.id)
      );
    });
    if (group.hasAuthorDecision) {
      isolatedDuplicateCount += group.pending.length;
    } else {
      const survivor = group.pending[0];
      if (survivor !== undefined) visibleFacts.push(survivor);
      isolatedDuplicateCount += Math.max(0, group.pending.length - 1);
    }
  }
  return Object.freeze({
    visibleFacts: Object.freeze(visibleFacts),
    isolatedDuplicateCount,
  });
}

function userDraftFactIdentity(snapshot: StoryFactSnapshot): string | null {
  if (
    snapshot.origin !== "user" ||
    snapshot.source.kind !== "user_statement" ||
    !snapshot.source.reference.startsWith("user-statement:draft:")
  ) {
    return null;
  }
  return `user-draft:${snapshot.source.reference}`;
}

function isPendingAuthorReviewFact(snapshot: StoryFactSnapshot): boolean {
  return (
    directLocalPendingEvidenceIdentity(snapshot) !== null ||
    userDraftFactIdentity(snapshot) !== null
  );
}

function factTypeLabel(factType: string): string {
  const option = FACT_TYPE_OPTIONS.find(({ value }) => value === factType);
  if (option !== undefined) {
    return option.label;
  }
  const labels: Readonly<Record<string, string>> = {
    core_relationship: "核心人物关系",
    character_death: "人物生死状态",
    major_ability_change: "重大能力变化",
    key_item_ownership: "关键物品归属",
    major_timeline_change: "重大时间线变化",
    foreshadow_status: "伏笔状态",
    scene_goal: "场景目标",
    chapter_summary: "章节摘要",
    scene_tag: "场景标签",
    relationship_change: "关系变化",
    plotline_state: "剧情线进展",
    pacing_metric: "节奏证据",
    world_setting: "世界背景",
    timeline_event: "时间线事件",
    character_voice: "人物说话方式",
    pov_knowledge: "人物知道的信息",
    event_category: "事件分类",
    weak_inference: "待验证推测",
  };
  return labels[factType] ?? "其他故事设定";
}

function storyFactMergeNotice(snapshot: StoryFactSnapshot): string | null {
  const structured = snapshot.structuredValue;
  if (structured === null || !isStoryObject(structured)) {
    return null;
  }
  const subject = structured.subject;
  if (!isStoryObject(subject)) {
    return null;
  }
  if (subject.mergeStatus === "ambiguous_confirmed_alias") {
    if (readAmbiguousStoryFactEntityAlias(snapshot) === null) {
      return "这条待确认结果的对象匹配资料已损坏，因此不能确认或辨认。请将它标记为不再生效，再重新识别正文或手动添加正确事实。";
    }
    const count = Array.isArray(subject.matchedEntityKeys) ? subject.matchedEntityKeys.length : 0;
    return `原文中的名称同时对应 ${String(count)} 个已确认对象。墨影没有按姓名猜测或自动合并；请先明确它指向哪个对象，或保留为新的独立对象。`;
  }
  if (subject.mergeStatus === "untrusted_key_ignored") {
    return "模型给出的对象编号没有已确认依据，已被忽略并作为新的待确认结果单独保留；请核对后决定。";
  }
  return null;
}

function factStatusLabel(snapshot: StoryFactSnapshot): string {
  if (snapshot.status === "formal") {
    return snapshot.locked ? "已确认并锁定" : "已确认";
  }
  const labels: Record<StoryFactSnapshot["status"], string> = {
    formal: "已确认",
    temporary: "自动更新，可撤销",
    unconfirmed: "需要确认",
    deprecated: "不再生效",
    branch: "仅当前试演剧情",
  };
  return labels[snapshot.status];
}

function factStatusTone(
  snapshot: StoryFactSnapshot,
): "neutral" | "info" | "warning" | "success" | "accent" {
  if (snapshot.status === "formal") {
    return snapshot.locked ? "accent" : "success";
  }
  if (snapshot.status === "unconfirmed") {
    return "warning";
  }
  if (snapshot.status === "temporary" || snapshot.status === "branch") {
    return "info";
  }
  return "neutral";
}

function factSourceLabel(snapshot: StoryFactSnapshot): string {
  const labels: Record<StoryFactSnapshot["source"]["kind"], string> = {
    user_statement: "由你直接添加",
    chapter_span: "来自已保存章节的精确原文",
    review_decision: "来自你确认过的检查结果",
    import_source: "来自导入作品，尚保留原始来源",
    legacy_record: "来自旧版设定，保留迁移关联",
    system_derivation: "由本机分析生成，可复查来源",
  };
  return labels[snapshot.source.kind];
}

function simpleFactDuplicateKey(snapshot: StoryFactSnapshot): string | null {
  if (snapshot.contentText === null || snapshot.structuredValue !== null) return null;
  const normalized = snapshot.contentText.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  return normalized.length === 0 ? null : snapshot.factType + String.fromCharCode(0) + normalized;
}
function storyFactContent(snapshot: StoryFactSnapshot): string {
  if (snapshot.contentText !== null && snapshot.contentText.trim().length > 0) {
    return snapshot.contentText;
  }
  return snapshot.structuredValue === null
    ? "（这条设定没有可显示的内容）"
    : "这条设定已按结构化字段保存；当前没有可显示的文字说明。";
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
    L1: "当前写作焦点",
    L2: "近期内容",
    L3: "项目长期内容",
    L4: "稳定规则",
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

function memoryPromotionLabel(status: LegacyMemoryPromotionPreview["status"]): string {
  const labels: Record<LegacyMemoryPromotionPreview["status"], string> = {
    available: "尚未转换",
    converted: "已转换",
    duplicate: "重复转换",
    conflict: "转换冲突",
  };
  return labels[status];
}

function memoryPromotionTone(
  status: LegacyMemoryPromotionPreview["status"],
): "neutral" | "success" | "accent" | "warning" {
  const tones: Record<
    LegacyMemoryPromotionPreview["status"],
    "neutral" | "success" | "accent" | "warning"
  > = {
    available: "neutral",
    converted: "success",
    duplicate: "accent",
    conflict: "warning",
  };
  return tones[status];
}

function memoryPromotionDescription(preview: LegacyMemoryPromotionPreview): string {
  if (preview.status === "converted") {
    return "这条旧记忆的当前修订已经由你确认并保留为正式故事事实；再次操作不会重复创建。";
  }
  if (preview.status === "duplicate") {
    return "相同内容已经通过这条旧记忆的较早修订转换；系统不会再创建一条重复的正式事实。";
  }
  if (preview.status === "conflict") {
    return preview.requiresConflictConfirmation
      ? "这条记忆在上次转换后改过内容。旧正式事实不会被覆盖；只有你再次明确确认，当前修订才会另存为一条新正式事实。"
      : "当前修订已有不一致或失效的转换记录。为避免覆盖历史，本次转换已拦截。";
  }
  return "这条记忆尚未转换。确认后会先建立可审计的旧记录来源关联，再单独晋升为正式故事事实。";
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
