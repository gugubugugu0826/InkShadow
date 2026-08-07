import {
  detectCharacterVoiceDeviation,
  validateNovelConsistency,
  type CharacterVoiceDeviationCategory,
  type CharacterVoiceDeviationIssue,
  type CharacterVoiceSkippedCheck,
  type NovelValidationAction,
  type NovelValidationIssue,
  type NovelValidationSkippedCheck,
} from "@inkshadow/story-core";

import {
  CharacterVoicePovEvidenceAdapterError,
  type CharacterVoicePovEvidenceAdapter,
  type CharacterVoicePovEvidenceDiagnostic,
  type CharacterVoicePovEvidencePreparation,
  type PrepareCharacterVoicePovEvidenceRequest,
} from "./character-voice-pov-evidence-adapter";

export type ChapterCharacterVoicePovRuntimeStatus = "ready" | "skipped" | "error";
export type ChapterCharacterVoicePovIssueKind =
  "character_voice_deviation" | "pov_boundary_violation" | "knowledge_boundary_conflict";
export type ChapterCharacterVoicePovSeverity = "warning" | "error";

export interface ChapterCharacterVoicePovEvidenceSource {
  readonly id: string;
  readonly role: "current_text" | "historical_dialogue" | "confirmed_knowledge";
  readonly sourceKind: "chapter";
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly contentHash: string;
  readonly locator: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
}

export interface ChapterCharacterVoicePovIssue {
  readonly id: string;
  readonly kind: ChapterCharacterVoicePovIssueKind;
  readonly detector: "deterministic_statistics" | "deterministic_fact_comparison";
  readonly category: CharacterVoiceDeviationCategory | "pov_boundary" | "knowledge_boundary";
  readonly severity: ChapterCharacterVoicePovSeverity;
  readonly title: string;
  readonly summary: string;
  readonly explanation: string;
  readonly characterId: string;
  readonly addresseeCharacterId: string | null;
  readonly currentEvidence: readonly ChapterCharacterVoicePovEvidenceSource[];
  readonly referenceEvidence: readonly ChapterCharacterVoicePovEvidenceSource[];
  readonly sourceFactIds: Readonly<{
    readonly current: readonly string[];
    readonly reference: readonly string[];
  }>;
  readonly suggestion: Readonly<{
    readonly summary: string;
    readonly actions: readonly string[];
  }>;
  readonly requiresHumanReview: true;
}

export interface ChapterCharacterVoicePovSkippedCheck {
  readonly id: string;
  readonly scope: "evidence" | "voice" | "pov";
  readonly characterId: string | null;
  readonly reason: string;
  readonly title: string;
  readonly explanation: string;
  readonly missingRequirements: readonly string[];
  readonly sourceFactId: string | null;
}

export interface ChapterCharacterVoicePovRuntimeErrorView {
  readonly code:
    | "CHARACTER_EVIDENCE_STORAGE_UNAVAILABLE"
    | "CHARACTER_EVIDENCE_HASH_UNAVAILABLE"
    | "CHARACTER_VOICE_POV_RUNTIME_FAILED";
  readonly title: string;
  readonly description: string;
  readonly retryable: boolean;
  readonly actions: readonly string[];
}

export interface ChapterCharacterVoicePovRuntimeResult {
  readonly status: ChapterCharacterVoicePovRuntimeStatus;
  readonly projectId: string;
  readonly chapterId: string;
  readonly chapterVersionId: string | null;
  readonly chapterRevision: number | null;
  readonly currentContentHash: string | null;
  readonly issues: readonly ChapterCharacterVoicePovIssue[];
  readonly skippedChecks: readonly ChapterCharacterVoicePovSkippedCheck[];
  readonly error: ChapterCharacterVoicePovRuntimeErrorView | null;
  readonly summary: Readonly<{
    readonly detectorRunCount: number;
    readonly checkedCharacterCount: number;
    readonly voiceIssueCount: number;
    readonly povIssueCount: number;
    readonly skippedCheckCount: number;
  }>;
  readonly capabilities: Readonly<{
    readonly voiceReview: "deterministic_statistics";
    readonly povReview: "deterministic_fact_comparison";
    readonly immutableEvidenceRequired: true;
    readonly modelInference: "disabled";
    readonly mutatesChapter: false;
    readonly mutatesStoryFacts: false;
  }>;
}

export interface CharacterVoicePovEvidencePreparationPort {
  prepare(
    request: PrepareCharacterVoicePovEvidenceRequest,
  ): Promise<CharacterVoicePovEvidencePreparation>;
}

/**
 * Runs evidence-backed deterministic voice and POV checks. The runtime is
 * read-only: it has no model port and no chapter or StoryFact mutation port.
 */
export class ChapterCharacterVoicePovRuntime {
  public constructor(
    private readonly evidenceAdapter: Pick<CharacterVoicePovEvidenceAdapter, "prepare">,
  ) {}

  public async check(
    request: PrepareCharacterVoicePovEvidenceRequest,
  ): Promise<ChapterCharacterVoicePovRuntimeResult> {
    try {
      const preparation = await this.evidenceAdapter.prepare(request);
      return runPreparedChecks(request, preparation);
    } catch (cause) {
      return errorResult(request, normalizeRuntimeError(cause));
    }
  }
}

function runPreparedChecks(
  request: PrepareCharacterVoicePovEvidenceRequest,
  preparation: CharacterVoicePovEvidencePreparation,
): ChapterCharacterVoicePovRuntimeResult {
  const issues: ChapterCharacterVoicePovIssue[] = [];
  const skipped: ChapterCharacterVoicePovSkippedCheck[] = preparation.diagnostics.map(
    skippedFromAdapterDiagnostic,
  );
  let detectorRunCount = 0;
  let checkedCharacterCount = 0;

  for (const voiceCheck of preparation.voiceChecks) {
    if (voiceCheck.status !== "ready") {
      continue;
    }
    detectorRunCount += 1;
    checkedCharacterCount += 1;
    const result = detectCharacterVoiceDeviation(voiceCheck.input);
    issues.push(
      ...result.issues.map((issue) =>
        voiceIssue(issue, {
          current: voiceCheck.sourceFactIds.currentDialogue,
          reference: voiceCheck.sourceFactIds.historicalDialogue,
        }),
      ),
    );
    skipped.push(
      ...result.skippedChecks.map((check) => skippedFromVoiceCheck(check, voiceCheck.characterId)),
    );
  }

  if (preparation.povCheck.status === "ready") {
    detectorRunCount += 1;
    const result = validateNovelConsistency(preparation.povCheck.input);
    issues.push(
      ...result.issues
        .filter(
          (issue) =>
            issue.issueType === "pov_boundary_violation" ||
            issue.issueType === "knowledge_boundary_conflict",
        )
        .map((issue) =>
          povIssue(issue, {
            current:
              preparation.povCheck.status === "ready"
                ? preparation.povCheck.sourceFactIds.currentClaims
                : [],
            reference:
              preparation.povCheck.status === "ready"
                ? preparation.povCheck.sourceFactIds.confirmedKnowledge
                : [],
          }),
        ),
    );
    skipped.push(...result.skippedChecks.map(skippedFromNovelCheck));
  }

  const deduplicatedSkipped = deduplicateSkippedChecks(skipped);
  const sortedIssues = Object.freeze(issues.sort(compareIssues));
  const voiceIssueCount = sortedIssues.filter(
    ({ kind }) => kind === "character_voice_deviation",
  ).length;
  const povIssueCount = sortedIssues.length - voiceIssueCount;
  return freezeResult({
    status: detectorRunCount > 0 ? "ready" : "skipped",
    projectId: request.projectId,
    chapterId: request.chapterId,
    chapterVersionId: preparation.chapterVersionId,
    chapterRevision: preparation.chapterRevision,
    currentContentHash: preparation.currentContentHash,
    issues: sortedIssues,
    skippedChecks: deduplicatedSkipped,
    error: null,
    summary: {
      detectorRunCount,
      checkedCharacterCount,
      voiceIssueCount,
      povIssueCount,
      skippedCheckCount: deduplicatedSkipped.length,
    },
  });
}

function voiceIssue(
  issue: CharacterVoiceDeviationIssue,
  sourceFactIds: Readonly<{ current: readonly string[]; reference: readonly string[] }>,
): ChapterCharacterVoicePovIssue {
  const copy = VOICE_CATEGORY_COPY[issue.category];
  return Object.freeze({
    id: `voice:${issue.id}`,
    kind: "character_voice_deviation",
    detector: "deterministic_statistics",
    category: issue.category,
    severity: issue.severity,
    title: copy.title,
    summary: `${issue.characterId}${issue.addresseeCharacterId === null ? "" : ` 对 ${issue.addresseeCharacterId}`}的${copy.subject}与已确认的历史台词存在明显差异。`,
    explanation: `当前测量值为 ${formatMetric(issue.metric.currentValue)}，可信历史范围为 ${formatMetric(issue.metric.expectedLowerBound)}–${formatMetric(issue.metric.expectedUpperBound)}（${issue.metric.unit}）。`,
    characterId: issue.characterId,
    addresseeCharacterId: issue.addresseeCharacterId,
    currentEvidence: Object.freeze(
      issue.currentDialogueEvidence.map((evidence) => evidenceSource(evidence, "current_text")),
    ),
    referenceEvidence: Object.freeze(
      issue.historicalDialogueEvidence.map((evidence) =>
        evidenceSource(evidence, "historical_dialogue"),
      ),
    ),
    sourceFactIds: freezeSourceFactIds(sourceFactIds),
    suggestion: Object.freeze({
      summary: copy.suggestion,
      actions: Object.freeze([...copy.actions]),
    }),
    requiresHumanReview: true,
  });
}

function povIssue(
  issue: NovelValidationIssue,
  sourceFactIds: Readonly<{ current: readonly string[]; reference: readonly string[] }>,
): ChapterCharacterVoicePovIssue {
  const isPovViolation = issue.issueType === "pov_boundary_violation";
  return Object.freeze({
    id: `pov:${issue.id}`,
    kind: isPovViolation ? "pov_boundary_violation" : "knowledge_boundary_conflict",
    detector: "deterministic_fact_comparison",
    category: isPovViolation ? "pov_boundary" : "knowledge_boundary",
    severity: issue.severity,
    title: isPovViolation ? "视角人物知道了尚未获得的信息" : "人物知识状态存在冲突",
    summary: isPovViolation
      ? `${issue.currentClaim.subjectId} 在当前视角中表现为已知，但已确认记录显示该信息尚未知晓。`
      : `${issue.currentClaim.subjectId} 的当前知识状态与已确认记录不一致。`,
    explanation: `当前正文证据为“${truncate(issue.currentClaim.text)}”；冲突记录为“${truncate(issue.conflictingFact.statement)}”。`,
    characterId: issue.currentClaim.subjectId,
    addresseeCharacterId: null,
    currentEvidence: Object.freeze(
      issue.currentClaim.evidence.map((evidence) => evidenceSource(evidence, "current_text")),
    ),
    referenceEvidence: Object.freeze(
      issue.conflictingFact.evidence.map((evidence) =>
        evidenceSource(evidence, "confirmed_knowledge"),
      ),
    ),
    sourceFactIds: freezeSourceFactIds(sourceFactIds),
    suggestion: Object.freeze({
      summary: isPovViolation
        ? "删除当前视角不应知道的信息，或补充更早且有证据的信息获得事件。"
        : "核对人物在该时间点的知识状态，再决定修改正文还是更新正式记录。",
      actions: Object.freeze(issue.suggestion.actions.map(readableNovelAction)),
    }),
    requiresHumanReview: true,
  });
}

function evidenceSource(
  evidence: Readonly<{
    readonly id?: string;
    readonly sourceId?: string;
    readonly chapterId?: string;
    readonly sourceVersionId?: string;
    readonly chapterVersionId?: string;
    readonly contentHash: string;
    readonly locator: string;
    readonly excerpt: string;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly sourceLength: number;
  }>,
  role: ChapterCharacterVoicePovEvidenceSource["role"],
): ChapterCharacterVoicePovEvidenceSource {
  const chapterId = evidence.chapterId ?? evidence.sourceId;
  const chapterVersionId = evidence.chapterVersionId ?? evidence.sourceVersionId;
  if (chapterId === undefined || chapterVersionId === undefined) {
    throw new Error("Prepared character evidence lost its chapter-version identity.");
  }
  return Object.freeze({
    id:
      evidence.id ??
      `${chapterVersionId}:${String(evidence.startOffset)}-${String(evidence.endOffset)}:${evidence.contentHash}`,
    role,
    sourceKind: "chapter",
    chapterId,
    chapterVersionId,
    contentHash: evidence.contentHash,
    locator: evidence.locator,
    excerpt: evidence.excerpt,
    startOffset: evidence.startOffset,
    endOffset: evidence.endOffset,
    sourceLength: evidence.sourceLength,
  });
}

function skippedFromAdapterDiagnostic(
  diagnostic: CharacterVoicePovEvidenceDiagnostic,
): ChapterCharacterVoicePovSkippedCheck {
  const scope =
    diagnostic.source === "voice_check"
      ? "voice"
      : diagnostic.source === "pov_check"
        ? "pov"
        : "evidence";
  return Object.freeze({
    id: `adapter:${diagnostic.source}:${diagnostic.factId ?? diagnostic.characterId ?? "run"}:${diagnostic.reason}`,
    scope,
    characterId: diagnostic.characterId,
    reason: diagnostic.reason,
    title: readableSkipTitle(diagnostic.reason),
    explanation: readableSkipExplanation(diagnostic.reason),
    missingRequirements: Object.freeze([...diagnostic.missingRequirements]),
    sourceFactId: diagnostic.factId,
  });
}

function skippedFromVoiceCheck(
  check: CharacterVoiceSkippedCheck,
  characterId: string,
): ChapterCharacterVoicePovSkippedCheck {
  return Object.freeze({
    id: `voice:${characterId}:${check.scope}:${check.metricKey ?? "all"}:${check.addresseeCharacterId ?? "all"}:${check.reason}`,
    scope: "voice",
    characterId,
    reason: check.reason,
    title: readableSkipTitle(check.reason),
    explanation: readableSkipExplanation(check.reason),
    missingRequirements: Object.freeze(
      check.reason === "metric_not_observable"
        ? ["enough_explicit_markers_for_this_voice_metric"]
        : ["enough_evidence_backed_dialogue"],
    ),
    sourceFactId: null,
  });
}

function skippedFromNovelCheck(
  check: NovelValidationSkippedCheck,
): ChapterCharacterVoicePovSkippedCheck {
  return Object.freeze({
    id: `pov:${check.source}:${check.sourceId}:${check.reason}`,
    scope: "pov",
    characterId: null,
    reason: check.reason,
    title: readableSkipTitle(check.reason),
    explanation: readableSkipExplanation(check.reason),
    missingRequirements: Object.freeze(["explicit_confirmed_versioned_knowledge_evidence"]),
    sourceFactId: null,
  });
}

function readableNovelAction(action: NovelValidationAction): string {
  const actions: Readonly<Record<NovelValidationAction, string>> = {
    revise_current_text: "修改当前正文",
    review_confirmed_fact: "复核已确认的知识记录",
    update_timeline: "更新时间线",
    review_hard_rule: "复核硬规则",
    mark_allowed_exception: "记录允许的例外",
    add_information_acquisition: "补充有证据的信息获得事件",
    change_pov: "调整当前场景视角",
  };
  return actions[action];
}

function readableSkipTitle(reason: string): string {
  if (reason.includes("hash")) {
    return "证据完整性无法确认";
  }
  if (reason.includes("version") || reason.includes("span") || reason.includes("source")) {
    return "证据没有准确定位到章节版本";
  }
  if (reason.includes("catalog")) {
    return "人物声纹设置不完整";
  }
  if (reason.includes("historical_dialogue")) {
    return "历史台词证据不足";
  }
  if (reason.includes("current_dialogue")) {
    return "当前台词证据不足";
  }
  if (reason.includes("pov") || reason.includes("knowledge")) {
    return "人物知识边界证据不足";
  }
  if (reason === "metric_not_observable") {
    return "当前声纹指标暂时无法测量";
  }
  if (reason === "not_user_confirmed_formal") {
    return "相关事实尚未由用户确认";
  }
  return "本项检查已跳过";
}

function readableSkipExplanation(reason: string): string {
  const explanations: Readonly<Record<string, string>> = {
    chapter_not_found: "没有找到要检查的章节。请先确认章节仍然存在。",
    chapter_not_active: "章节当前不处于可检查状态。请先恢复章节。",
    chapter_project_mismatch: "章节不属于当前项目，因此没有读取其内容。",
    current_version_not_found: "找不到章节当前保存版本。请先重新保存章节。",
    current_version_scope_mismatch: "当前版本与所选项目或章节不匹配。",
    current_version_content_mismatch: "章节内容与当前不可变版本不一致，请先完成保存。",
    current_version_hash_mismatch: "当前版本哈希不匹配，为避免引用错误内容，本次检查已停止。",
    fact_project_mismatch: "相关事实不属于当前项目，已安全排除。",
    not_user_confirmed_formal: "只有用户已确认的正式事实才可以参与声纹和知识边界判断。",
    structured_fields_missing: "相关事实缺少明确的结构字段，系统不会根据名称或自由文本猜测。",
    source_not_versioned_chapter_span: "相关事实没有指向可复核的章节版本原文。",
    evidence_version_not_found: "原文所引用的章节版本已经无法读取。",
    evidence_version_scope_mismatch: "原文版本与事实记录的项目或章节不一致。",
    evidence_span_mismatch: "记录的原文位置与不可变章节版本不一致。",
    evidence_hash_mismatch: "原文版本哈希不匹配，该证据没有参与检查。",
    historical_dialogue_uses_current_version: "历史台词不能取自本次正在检查的当前版本。",
    current_evidence_not_current_version: "当前台词或知识声明不是来自所选章节的当前版本。",
    voice_catalog_missing: "尚未为该人物确认一份结构化声纹设置。",
    voice_catalog_ambiguous: "存在多份同时生效的声纹设置，需要先保留唯一版本。",
    historical_dialogue_insufficient: "可验证的历史台词数量或长度不足，无法建立稳定声纹。",
    current_dialogue_insufficient: "当前章节中可验证的该人物台词太少，无法可靠比较。",
    detector_input_rejected: "结构化数据未通过确定性检测器校验，系统没有进行推测。",
    pov_current_claim_missing: "当前章节没有已确认、可定位的人物知识声明。",
    pov_confirmed_knowledge_missing: "缺少可与当前正文比较的正式人物知识记录。",
    insufficient_historical_evidence: "历史台词证据不足，声纹统计没有运行。",
    insufficient_current_evidence: "当前台词证据不足，声纹统计没有运行。",
    metric_not_observable: "已确认样本中缺少该指标需要的明确标记。",
    current_claim_not_explicit: "当前知识声明不是正文中的明确表达。",
    current_claim_missing_evidence: "当前知识声明缺少可定位原文。",
    reference_fact_not_confirmed: "人物知识记录尚未由用户确认。",
    reference_fact_missing_evidence: "人物知识记录缺少可定位原文。",
    hard_rule_missing_evidence: "规则缺少可定位证据。",
  };
  return explanations[reason] ?? "可信证据尚未满足该项检查条件，系统没有进行猜测。";
}

function deduplicateSkippedChecks(
  checks: readonly ChapterCharacterVoicePovSkippedCheck[],
): readonly ChapterCharacterVoicePovSkippedCheck[] {
  const unique = new Map<string, ChapterCharacterVoicePovSkippedCheck>();
  for (const check of checks) {
    unique.set(check.id, check);
  }
  return Object.freeze([...unique.values()].sort(compareSkippedChecks));
}

function freezeSourceFactIds(
  sourceFactIds: Readonly<{ current: readonly string[]; reference: readonly string[] }>,
): ChapterCharacterVoicePovIssue["sourceFactIds"] {
  return Object.freeze({
    current: Object.freeze([...sourceFactIds.current].sort()),
    reference: Object.freeze([...sourceFactIds.reference].sort()),
  });
}

function normalizeRuntimeError(cause: unknown): ChapterCharacterVoicePovRuntimeErrorView {
  if (cause instanceof CharacterVoicePovEvidenceAdapterError) {
    const hashFailure = cause.code === "CHARACTER_EVIDENCE_HASH_UNAVAILABLE";
    return Object.freeze({
      code: cause.code,
      title: hashFailure ? "暂时无法校验证据" : "暂时无法读取检查资料",
      description: hashFailure
        ? "系统无法完成章节版本完整性校验。正文没有改变，请稍后重试。"
        : "系统无法读取章节版本或故事事实。正文没有改变，请稍后重试。",
      retryable: cause.retryable,
      actions: Object.freeze(["重试检查", "确认本地数据库可用"]),
    });
  }
  return Object.freeze({
    code: "CHARACTER_VOICE_POV_RUNTIME_FAILED",
    title: "人物一致性检查未完成",
    description: "检查过程中出现未预期错误。正文和故事设定均未改变，请重试。",
    retryable: true,
    actions: Object.freeze(["重试检查", "如持续失败，请导出诊断信息"]),
  });
}

function errorResult(
  request: PrepareCharacterVoicePovEvidenceRequest,
  error: ChapterCharacterVoicePovRuntimeErrorView,
): ChapterCharacterVoicePovRuntimeResult {
  return freezeResult({
    status: "error",
    projectId: request.projectId,
    chapterId: request.chapterId,
    chapterVersionId: null,
    chapterRevision: null,
    currentContentHash: null,
    issues: [],
    skippedChecks: [],
    error,
    summary: {
      detectorRunCount: 0,
      checkedCharacterCount: 0,
      voiceIssueCount: 0,
      povIssueCount: 0,
      skippedCheckCount: 0,
    },
  });
}

function freezeResult(
  input: Omit<ChapterCharacterVoicePovRuntimeResult, "capabilities">,
): ChapterCharacterVoicePovRuntimeResult {
  return Object.freeze({
    ...input,
    issues: Object.freeze([...input.issues]),
    skippedChecks: Object.freeze([...input.skippedChecks]),
    summary: Object.freeze({ ...input.summary }),
    capabilities: Object.freeze({
      voiceReview: "deterministic_statistics",
      povReview: "deterministic_fact_comparison",
      immutableEvidenceRequired: true,
      modelInference: "disabled",
      mutatesChapter: false,
      mutatesStoryFacts: false,
    }),
  });
}

function compareIssues(
  left: ChapterCharacterVoicePovIssue,
  right: ChapterCharacterVoicePovIssue,
): number {
  return (
    severityRank(right.severity) - severityRank(left.severity) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

function compareSkippedChecks(
  left: ChapterCharacterVoicePovSkippedCheck,
  right: ChapterCharacterVoicePovSkippedCheck,
): number {
  return (
    left.scope.localeCompare(right.scope) ||
    (left.characterId ?? "").localeCompare(right.characterId ?? "") ||
    left.id.localeCompare(right.id)
  );
}

function severityRank(severity: ChapterCharacterVoicePovSeverity): number {
  return severity === "error" ? 2 : 1;
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function truncate(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length <= 100 ? normalized : `${normalized.slice(0, 100)}…`;
}

const VOICE_CATEGORY_COPY: Readonly<
  Record<
    CharacterVoiceDeviationCategory,
    Readonly<{
      title: string;
      subject: string;
      suggestion: string;
      actions: readonly string[];
    }>
  >
> = Object.freeze({
  sentence_length: {
    title: "人物句式长度发生变化",
    subject: "句子长度",
    suggestion: "参照所列历史台词，恢复该人物惯用的句子节奏。",
    actions: ["对比当前台词与历史台词", "只调整句式，不改变台词含义"],
  },
  common_terms: {
    title: "人物常用词发生变化",
    subject: "常用词使用频率",
    suggestion: "核对人物惯用词，避免机械添加，也不要无意移除其语言标记。",
    actions: ["查看历史常用词证据", "按当前情境决定是否调整"],
  },
  address_habit: {
    title: "人物称呼习惯发生变化",
    subject: "称呼方式",
    suggestion: "参考该人物面对同一对象时的历史称呼。",
    actions: ["核对称呼对象", "恢复自然且符合关系的称呼"],
  },
  emotional_expression: {
    title: "人物情绪表达强度发生变化",
    subject: "情绪表达强度",
    suggestion: "在不改变情节意图的前提下，调整明确情绪词和感叹标记。",
    actions: ["对比历史情绪表达", "保留当前场景所需的合理变化"],
  },
  politeness: {
    title: "人物礼貌程度发生变化",
    subject: "礼貌表达",
    suggestion: "参考历史台词中的礼貌与随意表达比例。",
    actions: ["核对人物关系和场景压力", "调整明确的礼貌或随意用词"],
  },
  directness: {
    title: "人物表达直接程度发生变化",
    subject: "直接表达方式",
    suggestion: "参考历史台词，调整明确的直接或委婉表达。",
    actions: ["保持台词事实意图", "调整表达方式而非剧情信息"],
  },
  metaphor_usage: {
    title: "人物比喻使用频率发生变化",
    subject: "明确比喻标记",
    suggestion: "仅依据已配置的明确比喻标记调整，并人工复核语义。",
    actions: ["查看历史比喻证据", "不要把普通描述误当作比喻"],
  },
  dialect_usage: {
    title: "人物方言标记发生变化",
    subject: "方言用词",
    suggestion: "参考已确认的历史方言标记，兼顾一致性与可读性。",
    actions: ["核对历史方言证据", "避免为了指标机械堆叠方言"],
  },
  addressee_voice: {
    title: "人物面对特定对象时的说话方式发生变化",
    subject: "对象化说话方式",
    suggestion: "比较人物过去面对同一对象时的称呼、礼貌和直接程度。",
    actions: ["查看同一对话对象的历史证据", "结合人物关系变化人工判断"],
  },
});
