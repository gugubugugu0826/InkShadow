import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import type { ChapterVersionSnapshot, UuidV7 } from "@inkshadow/domain";
import {
  DETERMINISTIC_NOVEL_FACT_TYPES,
  validateNovelConsistency,
  type CreateStoryFactInput,
  type DeterministicNovelFactType,
  type NovelCurrentClaim,
  type NovelEvidenceReference,
  type NovelFactValue,
  type NovelHardRule,
  type NovelReferenceFact,
  type NovelValidationIssue,
  type NovelValidationIssueType,
  type NovelValidationSeverity,
  type StoryFact,
  type StoryFactApplicationService,
  type StoryFactSnapshot,
  type StoryFactStore,
  type StoryValue,
  type UuidV7 as StoryUuidV7,
} from "@inkshadow/story-core";

import type {
  ContinuousProjectionDiagnostic,
  ContinuousStoryStateProjectionAdapter,
} from "./continuous-story-state-projection-adapter";

export const CHAPTER_VALIDATION_UI_ACTIONS = ["ignore", "allow", "update_setting"] as const;
export type ChapterValidationUiAction = (typeof CHAPTER_VALIDATION_UI_ACTIONS)[number];

export const CHAPTER_VALIDATION_RESOLUTION_SCHEMA = "inkshadow.chapter-validation-resolution.v1";
export const CHAPTER_SUPPLEMENTAL_FINDING_RESOLUTION_SCHEMA =
  "inkshadow.chapter-supplemental-finding-resolution.v1";
export const CHAPTER_SUPPLEMENTAL_FINDING_ACTIONS = ["ignore", "allow"] as const;
export type ChapterSupplementalFindingAction =
  (typeof CHAPTER_SUPPLEMENTAL_FINDING_ACTIONS)[number];
export const CHAPTER_SUPPLEMENTAL_FINDING_CATEGORIES = [
  "character_voice",
  "pov_knowledge",
  "plotline",
  "time_location",
  "foreshadow",
  "pacing_quality",
] as const;
export type ChapterSupplementalFindingCategory =
  (typeof CHAPTER_SUPPLEMENTAL_FINDING_CATEGORIES)[number];

export const CHAPTER_VALIDATION_ADAPTER_SKIP_REASONS = [
  "chapter_not_found",
  "chapter_not_active",
  "chapter_project_mismatch",
  "current_version_not_found",
  "current_version_mismatch",
  "current_version_hash_mismatch",
  "fact_project_mismatch",
  "other_branch",
  "structured_fields_missing",
  "unsupported_fact_type",
  "unsupported_validation_role",
  "current_claim_not_explicit",
  "current_claim_not_current_version",
  "reference_fact_not_confirmed",
  "hard_rule_not_locked",
  "source_not_versioned_chapter_span",
  "evidence_version_not_found",
  "evidence_version_mismatch",
  "evidence_span_mismatch",
  "evidence_hash_mismatch",
  "validator_input_rejected",
  "pov_knowledge_source_incomplete",
  "pov_knowledge_source_unverified",
  "pov_knowledge_source_inactive",
] as const;

export type ChapterValidationAdapterSkipReason =
  (typeof CHAPTER_VALIDATION_ADAPTER_SKIP_REASONS)[number];

export interface ChapterValidationSkippedFact {
  readonly factId: string | null;
  readonly role: ValidationFactRole | null;
  readonly reason: ChapterValidationAdapterSkipReason;
  readonly missingRequirements: readonly string[];
}

export const CHAPTER_VALIDATION_COVERAGE_CATEGORIES = DETERMINISTIC_NOVEL_FACT_TYPES;
export type ChapterValidationCoverageCategory = DeterministicNovelFactType;
export type ChapterValidationCoverageStatus = "checked" | "not_checked";
export type ChapterValidationCoverageReason =
  | "explicit_claim_compared"
  | "current_claim_missing"
  | "confirmed_reference_or_rule_missing"
  | "no_comparable_source";

/**
 * Category-level truth about what the deterministic run actually compared.
 * `checked` never means every possible fact of that category was exhaustively
 * extracted; it only means at least one explicit current claim had an
 * overlapping confirmed reference or locked rule.
 */
export interface ChapterValidationCoverageItem {
  readonly category: ChapterValidationCoverageCategory;
  readonly status: ChapterValidationCoverageStatus;
  readonly reason: ChapterValidationCoverageReason;
  readonly currentClaimCount: number;
  readonly comparableReferenceCount: number;
  readonly applicableHardRuleCount: number;
}

export interface ChapterValidationUiEvidence {
  readonly sourceKind: NovelEvidenceReference["sourceKind"];
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly contentHash: string;
  readonly locator: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
}

export interface ChapterValidationUiIssue {
  readonly id: string;
  readonly type: NovelValidationIssueType;
  readonly currentTextExcerpt: string;
  readonly currentClaim: Readonly<{
    readonly factId: string;
    readonly factRevision: number;
    readonly factType: DeterministicNovelFactType;
    readonly subjectId: string;
    readonly attributeKey: string;
    readonly value: NovelFactValue;
    readonly effectiveRange: Readonly<{
      readonly startOrder: number;
      readonly endOrder: number | null;
    }>;
  }>;
  readonly conflictingFact: Readonly<{
    readonly id: string;
    readonly factId: string;
    readonly factRevision: number;
    readonly source: "confirmed_fact" | "locked_hard_rule";
    readonly statement: string;
    readonly value: NovelValidationIssue["conflictingFact"]["value"];
    readonly operator: NovelValidationIssue["conflictingFact"]["operator"];
  }>;
  readonly currentEvidence: readonly ChapterValidationUiEvidence[];
  readonly conflictingEvidence: readonly ChapterValidationUiEvidence[];
  readonly severity: NovelValidationSeverity;
  readonly modificationSuggestion: string;
  readonly availableActions: readonly ChapterValidationUiAction[];
  readonly resolution: ChapterValidationIssueResolution;
  readonly canUndoIgnore: boolean;
}

export type ChapterValidationResolutionState = "active" | "undone" | "incomplete";

export interface ChapterValidationResolutionSummary {
  readonly issueId: string;
  readonly action: ChapterValidationUiAction;
  readonly state: ChapterValidationResolutionState;
  readonly factId: string;
  readonly factRevision: number;
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly conflictingFactId: string;
  readonly decidedAt: string;
}

export type ChapterValidationIssueResolution =
  | Readonly<{ readonly status: "unresolved" }>
  | Readonly<{
      readonly status: "ignored" | "allowed" | "setting_updated";
      readonly factId: string;
      readonly factRevision: number;
      readonly decidedAt: string;
    }>;

export interface ChapterNovelValidationResult {
  readonly status: "checked" | "skipped";
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly chapterVersionId: UuidV7 | null;
  readonly chapterRevision: number | null;
  readonly issues: readonly ChapterValidationUiIssue[];
  readonly resolutions: readonly ChapterValidationResolutionSummary[];
  readonly skippedFacts: readonly ChapterValidationSkippedFact[];
  readonly missingRequirements: readonly string[];
  readonly explanation: string;
  readonly checked: Readonly<{
    readonly currentClaims: number;
    readonly referenceFacts: number;
    readonly hardRules: number;
  }>;
  /** Missing only on legacy v1 snapshots created before coverage was recorded. */
  readonly coverage?: readonly ChapterValidationCoverageItem[];
  readonly capabilities: Readonly<{
    readonly deterministicValidation: "ready";
    readonly naturalLanguageInference: "disabled";
    readonly ambiguousModelReview: "separate_read_only_service";
    readonly mutatesChapter: false;
  }>;
}

export interface ChapterNovelValidationRequest {
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  /** Null selects the main timeline. Global facts remain applicable. */
  readonly branchId?: string | null;
}

export interface ChapterNovelValidationRuntimeDependencies {
  readonly chapters: Pick<ChapterRepository, "findById">;
  readonly chapterVersions: Pick<ChapterVersionRepository, "findVersionById">;
  readonly storyFacts: Pick<StoryFactStore, "findById" | "listByProjectId">;
  readonly hasher: ContentHasher;
  readonly continuousProjection?: Pick<
    ContinuousStoryStateProjectionAdapter,
    "projectValidationFacts"
  >;
  readonly supplementalFindingVerifier?: ChapterSupplementalFindingVerificationPort;
  readonly mutations?: Readonly<{
    readonly factService: Pick<
      StoryFactApplicationService,
      | "createFormalUserFact"
      | "createFormalUserFactWithAuthorityFence"
      | "deprecate"
      | "deprecateSupplementalResolutionWithAuthorityFence"
    >;
    readonly actorId: string;
  }>;
}

export interface ResolveChapterValidationIssueCommand extends ChapterNovelValidationRequest {
  readonly issueId: string;
  readonly expectedChapterVersionId: UuidV7;
  readonly action: ChapterValidationUiAction;
  readonly humanConfirmed: boolean;
}

export interface UndoIgnoredChapterValidationIssueCommand extends ChapterNovelValidationRequest {
  readonly issueId: string;
  readonly expectedChapterVersionId: UuidV7;
  readonly humanConfirmed: boolean;
}

export interface ChapterValidationResolutionReceipt {
  readonly issueId: string;
  readonly action: ChapterValidationUiAction;
  readonly outcome: "ignored" | "allowed" | "setting_updated" | "ignore_undone";
  readonly resolutionFactId: string;
  readonly resolutionFactRevision: number;
  readonly chapterVersionId: UuidV7;
  readonly idempotent: boolean;
  readonly audit: Readonly<{
    readonly storage: "story_fact";
    readonly sourceKind: "chapter_span" | "review_decision";
    readonly humanConfirmed: true;
  }>;
}

export interface ChapterSupplementalFindingResolutionSummary {
  readonly findingId: string;
  readonly category: ChapterSupplementalFindingCategory;
  readonly action: ChapterSupplementalFindingAction;
  readonly evidenceSignature: string;
  readonly factId: string;
  readonly factRevision: number;
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly decidedAt: string;
}

export interface ResolveChapterSupplementalFindingCommand extends ChapterNovelValidationRequest {
  readonly expectedChapterVersionId: UuidV7;
  readonly findingId: string;
  readonly category: ChapterSupplementalFindingCategory;
  readonly evidenceSignature: string;
  readonly action: ChapterSupplementalFindingAction;
  readonly humanConfirmed: boolean;
}

export type ChapterSupplementalFindingVerificationRequest = Omit<
  ResolveChapterSupplementalFindingCommand,
  "action" | "humanConfirmed"
>;

export interface ChapterSupplementalFindingVerificationPort {
  isCurrentFinding(request: ChapterSupplementalFindingVerificationRequest): Promise<boolean>;
}

export interface UndoChapterSupplementalFindingCommand extends ChapterNovelValidationRequest {
  readonly expectedChapterVersionId: UuidV7;
  readonly findingId: string;
  readonly evidenceSignature: string;
  readonly resolutionFactId: string;
  readonly expectedResolutionFactRevision: number;
  readonly humanConfirmed: boolean;
}

export interface ChapterSupplementalFindingUndoReceipt {
  readonly resolutionFactId: string;
  readonly resolutionFactRevision: number;
  readonly idempotent: boolean;
}

export type ChapterNovelValidationRuntimeErrorCode =
  | "NOVEL_VALIDATION_STORAGE_UNAVAILABLE"
  | "NOVEL_VALIDATION_HASH_UNAVAILABLE"
  | "NOVEL_VALIDATION_MUTATION_UNAVAILABLE"
  | "NOVEL_VALIDATION_HUMAN_CONFIRMATION_REQUIRED"
  | "NOVEL_VALIDATION_STALE_RESULT"
  | "NOVEL_VALIDATION_ISSUE_NOT_FOUND"
  | "NOVEL_VALIDATION_ALREADY_RESOLVED"
  | "NOVEL_VALIDATION_BRANCH_RESOLUTION_UNSUPPORTED"
  | "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED";

export class ChapterNovelValidationRuntimeError extends Error {
  public constructor(
    readonly code: ChapterNovelValidationRuntimeErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ChapterNovelValidationRuntimeError";
  }
}

export type ValidationFactRole = "current_claim" | "reference_fact" | "hard_rule";

interface ResolvedVersionEvidence {
  readonly version: ChapterVersionSnapshot;
  readonly contentHash: string;
}

type EvidenceResolution =
  | Readonly<{ readonly ok: true; readonly evidence: NovelEvidenceReference }>
  | Readonly<{
      readonly ok: false;
      readonly reason: ChapterValidationAdapterSkipReason;
      readonly missingRequirements: readonly string[];
    }>;

interface AdaptedFactCollections {
  readonly currentClaims: NovelCurrentClaim[];
  readonly referenceFacts: NovelReferenceFact[];
  readonly hardRules: NovelHardRule[];
  readonly skippedFacts: ChapterValidationSkippedFact[];
  readonly validatedResolutionFactIds: Set<string>;
}

interface ValidationResolutionMetadata {
  readonly action: ChapterValidationUiAction;
  readonly issueId: string;
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly conflictingFactId: string;
}

interface ResolutionFactRecord {
  readonly fact: StoryFact;
  readonly snapshot: StoryFactSnapshot;
  readonly metadata: ValidationResolutionMetadata;
}

interface SupplementalFindingResolutionMetadata {
  readonly action: ChapterSupplementalFindingAction;
  readonly findingId: string;
  readonly category: ChapterSupplementalFindingCategory;
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly evidenceSignature: string;
}

interface SupplementalFindingResolutionRecord {
  readonly fact: StoryFact;
  readonly snapshot: StoryFactSnapshot;
  readonly metadata: SupplementalFindingResolutionMetadata;
}

export class ChapterNovelValidationRuntime {
  public constructor(private readonly dependencies: ChapterNovelValidationRuntimeDependencies) {}

  public async checkChapter(
    request: ChapterNovelValidationRequest,
  ): Promise<ChapterNovelValidationResult> {
    const chapterResult = await this.dependencies.chapters.findById(request.chapterId);
    if (!chapterResult.ok) {
      throw storageFailure("Unable to read the chapter for deterministic validation.");
    }
    const chapter = chapterResult.value;
    if (chapter === null) {
      return skippedRun(request, "chapter_not_found", ["existing_current_chapter"]);
    }
    const chapterSnapshot = chapter.toSnapshot();
    if (chapterSnapshot.projectId !== request.projectId) {
      return skippedRun(request, "chapter_project_mismatch", [
        "chapter_owned_by_requested_project",
      ]);
    }
    if (chapterSnapshot.status !== "active") {
      return skippedRun(request, "chapter_not_active", ["active_current_chapter"]);
    }

    const versionCache = new Map<string, Promise<ResolvedVersionEvidence | null>>();
    const currentVersion = await this.resolveVersion(
      chapterSnapshot.currentVersionId,
      versionCache,
    );
    if (currentVersion === null) {
      return skippedRun(request, "current_version_not_found", ["current_chapter_version"]);
    }
    if (
      currentVersion.version.projectId !== request.projectId ||
      currentVersion.version.chapterId !== request.chapterId ||
      currentVersion.version.id !== chapterSnapshot.currentVersionId ||
      currentVersion.version.content !== chapterSnapshot.content
    ) {
      return skippedRun(request, "current_version_mismatch", [
        "chapter_and_current_version_with_identical_project_chapter_and_content",
      ]);
    }
    if (currentVersion.contentHash !== currentVersion.version.contentChecksum) {
      return skippedRun(request, "current_version_hash_mismatch", [
        "verified_current_version_sha256",
      ]);
    }

    const factsResult = await this.dependencies.storyFacts.listByProjectId(
      request.projectId as unknown as StoryUuidV7,
    );
    if (!factsResult.ok) {
      throw storageFailure("Unable to read unified story facts for deterministic validation.");
    }
    const adapted: AdaptedFactCollections = {
      currentClaims: [],
      referenceFacts: [],
      hardRules: [],
      skippedFacts: [],
      validatedResolutionFactIds: new Set<string>(),
    };
    for (const fact of factsResult.value) {
      if (
        this.dependencies.continuousProjection !== undefined &&
        isContinuousExtractionSource(fact.toSnapshot())
      ) {
        continue;
      }
      await this.adaptFact(fact, request, chapterSnapshot.currentVersionId, versionCache, adapted);
    }
    if (this.dependencies.continuousProjection !== undefined) {
      try {
        const projected = await this.dependencies.continuousProjection.projectValidationFacts({
          projectId: request.projectId,
          chapterId: request.chapterId,
          currentVersionId: chapterSnapshot.currentVersionId,
          ...(request.branchId === undefined ? {} : { branchId: request.branchId }),
        });
        adapted.skippedFacts.push(...projected.diagnostics.map(continuousProjectionValidationSkip));
        for (const fact of projected.facts) {
          await this.adaptFact(
            fact,
            request,
            chapterSnapshot.currentVersionId,
            versionCache,
            adapted,
          );
        }
      } catch {
        adapted.skippedFacts.push(
          Object.freeze({
            factId: null,
            role: null,
            reason: "structured_fields_missing" as const,
            missingRequirements: Object.freeze([
              "verified_continuous_story_state_projection_available",
            ]),
          }),
        );
      }
    }
    const resolutions = collectResolutionSummaries(
      factsResult.value,
      request,
      chapterSnapshot.currentVersionId,
      adapted.validatedResolutionFactIds,
    );
    const activeResolutions = activeResolutionByIssue(resolutions);
    const coverage = deterministicCoverage(adapted);

    const missingRequirements: string[] = [];
    if (adapted.currentClaims.length === 0) {
      missingRequirements.push(
        "current_claim_with_explicit_structured_fields_and_current_version_evidence",
      );
    }
    if (adapted.referenceFacts.length === 0 && adapted.hardRules.length === 0) {
      missingRequirements.push("confirmed_reference_fact_or_locked_hard_rule_with_exact_evidence");
    }
    if (!coverage.some(({ status }) => status === "checked")) {
      missingRequirements.push("comparable_current_claim_and_confirmed_source");
    }
    if (missingRequirements.length > 0) {
      return freezeResult({
        status: "skipped",
        projectId: request.projectId,
        chapterId: request.chapterId,
        chapterVersionId: chapterSnapshot.currentVersionId,
        chapterRevision: chapterSnapshot.revision,
        issues: [],
        resolutions,
        skippedFacts: adapted.skippedFacts,
        missingRequirements,
        explanation: `Deterministic chapter validation skipped: ${missingRequirements.join(", ")}.`,
        checked: counts(adapted),
        coverage,
      });
    }

    const validation = validateNovelConsistency({
      currentClaims: adapted.currentClaims,
      referenceFacts: adapted.referenceFacts,
      hardRules: adapted.hardRules,
    });
    return freezeResult({
      status: "checked",
      projectId: request.projectId,
      chapterId: request.chapterId,
      chapterVersionId: chapterSnapshot.currentVersionId,
      chapterRevision: chapterSnapshot.revision,
      issues: validation.issues.map((issue) =>
        toUiIssue(issue, activeResolutions.get(issue.id) ?? null),
      ),
      resolutions,
      skippedFacts: adapted.skippedFacts,
      missingRequirements: [],
      explanation:
        validation.issues.length === 0
          ? "Deterministic checks found no evidence-backed conflicts in the categories that actually ran."
          : `Deterministic checks found ${String(validation.issues.length)} evidence-backed conflict(s).`,
      checked: counts(adapted),
      coverage,
    });
  }

  public async resolveIssue(
    command: ResolveChapterValidationIssueCommand,
  ): Promise<ChapterValidationResolutionReceipt> {
    const mutations = this.requireMutations(command.humanConfirmed, command.branchId);
    const current = await this.checkChapter(command);
    if (
      current.chapterVersionId === null ||
      current.chapterVersionId !== command.expectedChapterVersionId
    ) {
      throw actionFailure(
        "NOVEL_VALIDATION_STALE_RESULT",
        "章节已发生变化。请重新检查本章后再处理问题。",
        true,
      );
    }

    const issue = current.issues.find(({ id }) => id === command.issueId);
    if (issue === undefined) {
      const completed = await this.findResolutionRecords(command);
      const existing = completed.find(
        ({ metadata, snapshot }) =>
          metadata.action === command.action &&
          snapshot.status === "formal" &&
          !snapshot.deprecated,
      );
      if (
        existing !== undefined &&
        (command.action !== "update_setting" ||
          (await this.conflictingFactIsDeprecated(existing.metadata.conflictingFactId)))
      ) {
        return resolutionReceipt(
          command,
          existing.snapshot,
          resolutionOutcome(command.action),
          true,
        );
      }
      throw actionFailure(
        "NOVEL_VALIDATION_ISSUE_NOT_FOUND",
        "这条问题已不存在或证据已经变化。请重新检查本章。",
        true,
      );
    }
    if (issue.resolution.status !== "unresolved") {
      const resolution = issue.resolution;
      const resolvedAction = actionForResolutionStatus(resolution.status);
      if (resolvedAction !== command.action) {
        throw actionFailure(
          "NOVEL_VALIDATION_ALREADY_RESOLVED",
          "这条问题已经用另一种方式处理。请先查看现有处理记录。",
          false,
        );
      }
      const records = await this.findResolutionRecords(command);
      const existing = records.find(
        ({ metadata, snapshot }) =>
          metadata.action === command.action && snapshot.id === resolution.factId,
      );
      if (existing === undefined) {
        throw actionFailure(
          "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
          "处理记录与故事设定不一致。请重新检查，正文没有改变。",
          true,
        );
      }
      return resolutionReceipt(command, existing.snapshot, resolutionOutcome(command.action), true);
    }

    const records = await this.findResolutionRecords(command);
    const conflictingAction = records.find(
      ({ metadata, snapshot }) =>
        metadata.action !== command.action && snapshot.status === "formal" && !snapshot.deprecated,
    );
    if (conflictingAction !== undefined) {
      throw actionFailure(
        "NOVEL_VALIDATION_ALREADY_RESOLVED",
        "这条问题已经存在另一项处理记录。请重新检查后再决定。",
        false,
      );
    }
    let resolutionFact = records.find(
      ({ metadata, snapshot }) =>
        metadata.action === command.action && snapshot.status === "formal" && !snapshot.deprecated,
    )?.fact;
    if (resolutionFact !== undefined && command.action !== "update_setting") {
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "已有处理记录未能通过证据校验。请查看故事设定后重试。",
        false,
      );
    }
    resolutionFact ??= await this.createResolutionFact(command, issue, mutations);

    if (command.action === "update_setting") {
      await this.deprecateConflictingFact(issue.conflictingFact.factId, mutations);
    }
    return resolutionReceipt(
      command,
      resolutionFact.toSnapshot(),
      resolutionOutcome(command.action),
      false,
    );
  }

  public async undoIgnoredIssue(
    command: UndoIgnoredChapterValidationIssueCommand,
  ): Promise<ChapterValidationResolutionReceipt> {
    const mutations = this.requireMutations(command.humanConfirmed, command.branchId);
    const current = await this.checkChapter(command);
    if (
      current.chapterVersionId === null ||
      current.chapterVersionId !== command.expectedChapterVersionId
    ) {
      throw actionFailure(
        "NOVEL_VALIDATION_STALE_RESULT",
        "章节已发生变化。请重新检查本章后再撤销忽略。",
        true,
      );
    }
    const records = (await this.findResolutionRecords(command)).filter(
      ({ metadata }) => metadata.action === "ignore",
    );
    const active = records.find(
      ({ snapshot }) => snapshot.status === "formal" && !snapshot.deprecated,
    );
    if (active === undefined) {
      const undone = records.find(({ snapshot }) => snapshot.deprecated);
      if (undone !== undefined) {
        return resolutionReceipt(command, undone.snapshot, "ignore_undone", true);
      }
      throw actionFailure(
        "NOVEL_VALIDATION_ISSUE_NOT_FOUND",
        "没有找到可以撤销的忽略记录。",
        false,
      );
    }
    const deprecated = await mutations.factService.deprecate({
      factId: active.snapshot.id,
      humanConfirmed: true,
      expectedRevision: active.snapshot.revision,
    });
    if (!deprecated.ok) {
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "撤销忽略没有保存成功。原有处理记录保持不变，请重试。",
        deprecated.error.retryable,
      );
    }
    return resolutionReceipt(command, deprecated.value.toSnapshot(), "ignore_undone", false);
  }

  public async listSupplementalFindingResolutions(
    request: ChapterNovelValidationRequest &
      Readonly<{ readonly expectedChapterVersionId: UuidV7 }>,
  ): Promise<readonly ChapterSupplementalFindingResolutionSummary[]> {
    await this.assertCurrentChapterVersion(request, request.expectedChapterVersionId);
    const records = await this.findSupplementalFindingResolutionRecords(
      request,
      request.expectedChapterVersionId,
    );
    return Object.freeze(
      records
        .filter(({ snapshot }) => snapshot.status === "formal" && !snapshot.deprecated)
        .map(supplementalResolutionSummary)
        .sort(
          (left, right) =>
            left.decidedAt.localeCompare(right.decidedAt) ||
            left.factId.localeCompare(right.factId),
        ),
    );
  }

  public async resolveSupplementalFinding(
    command: ResolveChapterSupplementalFindingCommand,
  ): Promise<ChapterSupplementalFindingResolutionSummary> {
    const mutations = this.requireMutations(command.humanConfirmed, command.branchId);
    validateSupplementalFindingIdentity(command.findingId, command.evidenceSignature);
    await this.assertCurrentChapterVersion(command, command.expectedChapterVersionId);
    await this.assertTrustedSupplementalFinding(command);
    const records = await this.findSupplementalFindingResolutionRecords(
      command,
      command.expectedChapterVersionId,
    );
    const active = records.find(
      ({ metadata, snapshot }) =>
        metadata.findingId === command.findingId &&
        metadata.evidenceSignature === command.evidenceSignature &&
        snapshot.status === "formal" &&
        !snapshot.deprecated,
    );
    if (active !== undefined) {
      if (active.metadata.action !== command.action) {
        throw actionFailure(
          "NOVEL_VALIDATION_ALREADY_RESOLVED",
          "这条提醒已经用另一种方式处理。请先恢复为待处理状态。",
          false,
        );
      }
      return supplementalResolutionSummary(active);
    }
    const created = await mutations.factService.createFormalUserFactWithAuthorityFence(
      {
        projectId: command.projectId,
        factType: "validation_resolution",
        contentText:
          command.action === "ignore"
            ? `用户忽略了检查提醒：${command.findingId}`
            : `用户明确允许了检查提醒：${command.findingId}`,
        structuredValue: Object.freeze({
          resolutionSchema: CHAPTER_SUPPLEMENTAL_FINDING_RESOLUTION_SCHEMA,
          resolutionAction: command.action,
          resolvedFindingId: command.findingId,
          resolvedFindingCategory: command.category,
          resolvedChapterId: command.chapterId,
          resolvedChapterVersionId: command.expectedChapterVersionId,
          evidenceSignature: command.evidenceSignature,
        }),
        source: Object.freeze({
          kind: "review_decision" as const,
          reference: `chapter-supplemental-finding:${command.chapterId}:${command.expectedChapterVersionId}:${command.findingId}`,
        }),
        actorId: mutations.actorId,
        lock: command.action === "allow",
        humanConfirmed: true,
      },
      {
        chapterId: command.chapterId,
        expectedCurrentVersionId: command.expectedChapterVersionId,
        requiredCausalEventIds: Object.freeze([]),
        requiredCharacterIds: Object.freeze([]),
      },
    );
    if (!created.ok) {
      if (created.error.code === "STORY_FACT_IDEMPOTENCY_CONFLICT") {
        throw actionFailure(
          "NOVEL_VALIDATION_ALREADY_RESOLVED",
          "这条提醒已经在另一窗口用不同方式处理。请重新检查后再继续。",
          true,
        );
      }
      if (created.error.code === "STORY_FACT_SOURCE_FENCE_FAILED") {
        throw actionFailure(
          "NOVEL_VALIDATION_STALE_RESULT",
          "章节已经保存了新版本。请重新检查后再处理提醒。",
          true,
        );
      }
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "提醒的处理结果没有保存成功。正文和正式设定没有改变，请重试。",
        created.error.retryable,
      );
    }
    const record = toSupplementalFindingResolutionRecord(created.value.fact);
    if (record === null) {
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "提醒的处理记录未通过完整性校验。正文和正式设定没有改变。",
        false,
      );
    }
    return supplementalResolutionSummary(record);
  }

  public async undoSupplementalFinding(
    command: UndoChapterSupplementalFindingCommand,
  ): Promise<ChapterSupplementalFindingUndoReceipt> {
    const mutations = this.requireMutations(command.humanConfirmed, command.branchId);
    validateSupplementalFindingIdentity(command.findingId, command.evidenceSignature);
    const deprecated =
      await mutations.factService.deprecateSupplementalResolutionWithAuthorityFence({
        factId: command.resolutionFactId,
        expectedProjectId: command.projectId,
        chapterId: command.chapterId,
        expectedCurrentVersionId: command.expectedChapterVersionId,
        findingId: command.findingId,
        evidenceSignature: command.evidenceSignature,
        expectedRevision: command.expectedResolutionFactRevision,
        humanConfirmed: true,
      });
    if (!deprecated.ok) {
      if (deprecated.error.code === "STORY_FACT_SOURCE_FENCE_FAILED") {
        throw actionFailure(
          "NOVEL_VALIDATION_STALE_RESULT",
          "章节已经保存了新版本。请重新检查后再恢复提醒。",
          true,
        );
      }
      if (
        deprecated.error.code === "STORY_FACT_NOT_FOUND" ||
        deprecated.error.code === "STORY_VALIDATION_FAILED" ||
        deprecated.error.code === "STORY_REVISION_CONFLICT" ||
        deprecated.error.code === "STORY_FACT_INVALID_TRANSITION"
      ) {
        throw actionFailure(
          "NOVEL_VALIDATION_ISSUE_NOT_FOUND",
          "这条提醒的处理记录已变化。请重新检查本章。",
          deprecated.error.retryable,
        );
      }
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "没有恢复为待处理状态。正文和正式设定没有改变，请重试。",
        deprecated.error.retryable,
      );
    }
    return Object.freeze({
      resolutionFactId: deprecated.value.fact.id,
      resolutionFactRevision: deprecated.value.fact.revision,
      idempotent: !deprecated.value.deprecated,
    });
  }

  private async assertTrustedSupplementalFinding(
    request: ChapterSupplementalFindingVerificationRequest,
  ): Promise<void> {
    const verifier = this.dependencies.supplementalFindingVerifier;
    if (verifier === undefined || !(await verifier.isCurrentFinding(request))) {
      throw actionFailure(
        "NOVEL_VALIDATION_ISSUE_NOT_FOUND",
        "这条提醒已不存在、证据已变化或来源已经失效。请重新检查本章。",
        true,
      );
    }
  }

  private async assertCurrentChapterVersion(
    request: ChapterNovelValidationRequest,
    expectedChapterVersionId: UuidV7,
  ): Promise<void> {
    const checked = await this.checkChapter(request);
    if (checked.chapterVersionId !== expectedChapterVersionId) {
      throw actionFailure(
        "NOVEL_VALIDATION_STALE_RESULT",
        "章节已经保存了新版本。请重新检查后再处理提醒。",
        true,
      );
    }
  }

  private async findSupplementalFindingResolutionRecords(
    request: ChapterNovelValidationRequest,
    expectedChapterVersionId: UuidV7,
  ): Promise<readonly SupplementalFindingResolutionRecord[]> {
    const loaded = await this.dependencies.storyFacts.listByProjectId(
      request.projectId as unknown as StoryUuidV7,
    );
    if (!loaded.ok) {
      throw storageFailure("Unable to read supplemental finding resolutions.");
    }
    return Object.freeze(
      loaded.value
        .map(toSupplementalFindingResolutionRecord)
        .filter((record): record is SupplementalFindingResolutionRecord => record !== null)
        .filter(
          ({ metadata }) =>
            metadata.chapterId === request.chapterId &&
            metadata.chapterVersionId === expectedChapterVersionId &&
            (request.branchId === undefined || request.branchId === null),
        )
        .sort(
          (left, right) =>
            right.snapshot.updatedAt.localeCompare(left.snapshot.updatedAt) ||
            right.snapshot.id.localeCompare(left.snapshot.id),
        ),
    );
  }

  private requireMutations(
    humanConfirmed: boolean,
    branchId: string | null | undefined,
  ): NonNullable<ChapterNovelValidationRuntimeDependencies["mutations"]> {
    if (!humanConfirmed) {
      throw actionFailure(
        "NOVEL_VALIDATION_HUMAN_CONFIRMATION_REQUIRED",
        "处理检查问题需要你明确确认。",
        false,
      );
    }
    if (branchId !== undefined && branchId !== null) {
      throw actionFailure(
        "NOVEL_VALIDATION_BRANCH_RESOLUTION_UNSUPPORTED",
        "当前只能在主线保存检查处理结果；分支内容仍保持不变。",
        false,
      );
    }
    if (this.dependencies.mutations === undefined) {
      throw actionFailure(
        "NOVEL_VALIDATION_MUTATION_UNAVAILABLE",
        "当前运行环境不能保存检查处理结果。正文和正式设定没有改变。",
        false,
      );
    }
    return this.dependencies.mutations;
  }

  private async createResolutionFact(
    command: ResolveChapterValidationIssueCommand,
    issue: ChapterValidationUiIssue,
    mutations: NonNullable<ChapterNovelValidationRuntimeDependencies["mutations"]>,
  ): Promise<StoryFact> {
    const currentEvidence = issue.currentEvidence[0];
    if (command.action !== "ignore" && currentEvidence === undefined) {
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "当前原文缺少可定位证据，不能建立正式设定。",
        false,
      );
    }
    const metadata = resolutionMetadataValue(command, issue);
    const created = await mutations.factService.createFormalUserFact({
      projectId: command.projectId,
      factType: command.action === "ignore" ? "validation_resolution" : issue.currentClaim.factType,
      contentText: resolutionContentText(command.action, issue),
      structuredValue:
        command.action === "ignore"
          ? metadata
          : command.action === "allow"
            ? {
                ...metadata,
                validationRole: "hard_rule",
                subjectId: issue.currentClaim.subjectId,
                attributeKey: issue.currentClaim.attributeKey,
                effectiveRange: issue.currentClaim.effectiveRange,
                operator: "equals",
                expectedValue: issue.currentClaim.value,
              }
            : {
                ...metadata,
                validationRole: "reference_fact",
                subjectId: issue.currentClaim.subjectId,
                attributeKey: issue.currentClaim.attributeKey,
                effectiveRange: issue.currentClaim.effectiveRange,
                value: issue.currentClaim.value,
              },
      source:
        command.action === "ignore"
          ? {
              kind: "review_decision",
              reference: `chapter-validation:${command.issueId}:${command.expectedChapterVersionId}`,
            }
          : evidenceToStoryFactSource(currentEvidence),
      actorId: mutations.actorId,
      lock: command.action === "allow",
      humanConfirmed: true,
    });
    if (!created.ok) {
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "检查处理结果没有保存成功。正文和原有正式设定保持不变，请重试。",
        created.error.retryable,
      );
    }
    return created.value;
  }

  private async deprecateConflictingFact(
    factId: string,
    mutations: NonNullable<ChapterNovelValidationRuntimeDependencies["mutations"]>,
  ): Promise<void> {
    const loaded = await this.dependencies.storyFacts.findById(factId as StoryUuidV7);
    if (!loaded.ok) {
      throw storageFailure("Unable to read the formal fact being updated.");
    }
    if (loaded.value === null) {
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "原有正式设定已经不存在。请重新检查本章。",
        true,
      );
    }
    const snapshot = loaded.value.toSnapshot();
    if (snapshot.deprecated) {
      return;
    }
    if (snapshot.status !== "formal" || !snapshot.userConfirmed) {
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "冲突来源不再是用户确认的正式设定。请重新检查本章。",
        true,
      );
    }
    const deprecated = await mutations.factService.deprecate({
      factId,
      humanConfirmed: true,
      expectedRevision: snapshot.revision,
    });
    if (!deprecated.ok) {
      throw actionFailure(
        "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
        "新设定已留下可追溯记录，但原设定尚未停用。请重试以完成更新。",
        deprecated.error.retryable,
      );
    }
  }

  private async conflictingFactIsDeprecated(factId: string): Promise<boolean> {
    const loaded = await this.dependencies.storyFacts.findById(factId as StoryUuidV7);
    if (!loaded.ok) {
      throw storageFailure("Unable to verify the superseded formal fact.");
    }
    return loaded.value?.toSnapshot().deprecated === true;
  }

  private async findResolutionRecords(
    command: Readonly<{
      projectId: UuidV7;
      chapterId: UuidV7;
      issueId: string;
      expectedChapterVersionId: UuidV7;
    }>,
  ): Promise<readonly ResolutionFactRecord[]> {
    const listed = await this.dependencies.storyFacts.listByProjectId(
      command.projectId as unknown as StoryUuidV7,
    );
    if (!listed.ok) {
      throw storageFailure("Unable to read chapter-validation resolution history.");
    }
    return Object.freeze(
      listed.value
        .map(toResolutionFactRecord)
        .filter((record): record is ResolutionFactRecord => record !== null)
        .filter(
          ({ metadata }) =>
            metadata.issueId === command.issueId &&
            idsEqual(metadata.chapterId, command.chapterId) &&
            idsEqual(metadata.chapterVersionId, command.expectedChapterVersionId),
        )
        .sort(compareResolutionRecords),
    );
  }

  private async adaptFact(
    fact: StoryFact,
    request: ChapterNovelValidationRequest,
    currentVersionId: UuidV7,
    versionCache: Map<string, Promise<ResolvedVersionEvidence | null>>,
    output: AdaptedFactCollections,
  ): Promise<void> {
    const snapshot = fact.toSnapshot();
    if (!idsEqual(snapshot.projectId, request.projectId)) {
      output.skippedFacts.push(
        skipFact(snapshot, null, "fact_project_mismatch", ["fact_owned_by_requested_project"]),
      );
      return;
    }
    const resolutionMetadata = parseValidationResolutionMetadata(snapshot.structuredValue);
    if (
      resolutionMetadata !== null &&
      (resolutionMetadata.action === "ignore" || snapshot.deprecated)
    ) {
      return;
    }
    const branchId = request.branchId ?? null;
    if (snapshot.branchId !== null && snapshot.branchId !== branchId) {
      output.skippedFacts.push(
        skipFact(snapshot, validationRole(snapshot.structuredValue), "other_branch", [
          "fact_applicable_to_selected_branch",
        ]),
      );
      return;
    }
    if (!DETERMINISTIC_NOVEL_FACT_TYPES.includes(snapshot.factType as DeterministicNovelFactType)) {
      output.skippedFacts.push(
        skipFact(snapshot, validationRole(snapshot.structuredValue), "unsupported_fact_type", [
          "deterministic_novel_fact_type",
        ]),
      );
      return;
    }
    if (!isRecord(snapshot.structuredValue)) {
      output.skippedFacts.push(
        skipFact(snapshot, null, "structured_fields_missing", [
          "structured_validation_role_subject_attribute_value_and_effective_range",
        ]),
      );
      return;
    }
    const role = validationRole(snapshot.structuredValue);
    if (role === null) {
      output.skippedFacts.push(
        skipFact(snapshot, null, "unsupported_validation_role", [
          "validationRole_current_claim_reference_fact_or_hard_rule",
        ]),
      );
      return;
    }
    if (role === "current_claim" && snapshot.structuredValue.basis !== "explicit_text") {
      output.skippedFacts.push(
        skipFact(snapshot, role, "current_claim_not_explicit", ["basis_explicit_text"]),
      );
      return;
    }
    if (
      role === "reference_fact" &&
      (snapshot.status !== "formal" ||
        !snapshot.userConfirmed ||
        snapshot.needsReview ||
        snapshot.deprecated)
    ) {
      output.skippedFacts.push(
        skipFact(snapshot, role, "reference_fact_not_confirmed", [
          "user_confirmed_formal_reference_fact",
        ]),
      );
      return;
    }
    if (
      role === "hard_rule" &&
      (snapshot.status !== "formal" ||
        !snapshot.userConfirmed ||
        !snapshot.locked ||
        snapshot.needsReview ||
        snapshot.deprecated)
    ) {
      output.skippedFacts.push(
        skipFact(snapshot, role, "hard_rule_not_locked", ["user_confirmed_locked_formal_rule"]),
      );
      return;
    }
    if (snapshot.source.kind !== "chapter_span") {
      output.skippedFacts.push(
        skipFact(snapshot, role, "source_not_versioned_chapter_span", [
          "chapter_span_with_version_offsets_and_excerpt",
        ]),
      );
      return;
    }
    if (role === "current_claim" && !idsEqual(snapshot.source.versionId, currentVersionId)) {
      output.skippedFacts.push(
        skipFact(snapshot, role, "current_claim_not_current_version", [
          "claim_evidence_from_current_chapter_version",
        ]),
      );
      return;
    }
    const evidence = await this.resolveFactEvidence(snapshot, versionCache);
    if (!evidence.ok) {
      output.skippedFacts.push(
        skipFact(snapshot, role, evidence.reason, evidence.missingRequirements),
      );
      return;
    }
    const structured = snapshot.structuredValue;
    const base = {
      id: `${role}:${snapshot.id}:r${String(snapshot.revision)}`,
      factType: snapshot.factType as DeterministicNovelFactType,
      subjectId: structured.subjectId,
      attributeKey: structured.attributeKey,
      branchId: snapshot.branchId,
      effectiveRange: structured.effectiveRange,
      evidence: [evidence.evidence],
    };
    try {
      if (role === "current_claim") {
        const claim = {
          ...base,
          value: structured.value,
          basis: structured.basis,
          claimText: evidence.evidence.excerpt,
          povContext: structured.povContext ?? null,
        } as unknown as NovelCurrentClaim;
        assertClaim(claim);
        output.currentClaims.push(claim);
        return;
      }
      if (role === "reference_fact") {
        const reference = {
          ...base,
          value: structured.value,
          status: "confirmed",
          factText: renderStructuredStatement(snapshot, structured.value),
        } as unknown as NovelReferenceFact;
        assertReferenceFact(reference);
        output.referenceFacts.push(reference);
        if (resolutionMetadata?.action === "update_setting") {
          output.validatedResolutionFactIds.add(snapshot.id);
        }
        return;
      }
      const rule = {
        id: base.id,
        locked: true,
        targetFactType: base.factType,
        subjectId: base.subjectId,
        attributeKey: base.attributeKey,
        branchId: base.branchId,
        effectiveRange: base.effectiveRange,
        operator: structured.operator,
        expectedValue: structured.expectedValue,
        ruleText: renderStructuredStatement(snapshot, structured.expectedValue),
        evidence: base.evidence,
      } as unknown as NovelHardRule;
      assertHardRule(rule);
      output.hardRules.push(rule);
      if (resolutionMetadata?.action === "allow") {
        output.validatedResolutionFactIds.add(snapshot.id);
      }
    } catch {
      output.skippedFacts.push(
        skipFact(snapshot, role, "validator_input_rejected", [
          role === "hard_rule"
            ? "valid_subject_attribute_effective_range_operator_and_expected_value"
            : "valid_subject_attribute_effective_range_and_typed_value",
        ]),
      );
    }
  }

  private async resolveFactEvidence(
    snapshot: StoryFactSnapshot,
    versionCache: Map<string, Promise<ResolvedVersionEvidence | null>>,
  ): Promise<EvidenceResolution> {
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
      return evidenceFailure("source_not_versioned_chapter_span", [
        "complete_chapter_version_span",
      ]);
    }
    const resolved = await this.resolveVersion(source.versionId, versionCache);
    if (resolved === null) {
      return evidenceFailure("evidence_version_not_found", ["existing_evidence_version"]);
    }
    if (
      !idsEqual(resolved.version.projectId, snapshot.projectId) ||
      !idsEqual(resolved.version.chapterId, source.chapterId) ||
      !idsEqual(resolved.version.id, source.versionId)
    ) {
      return evidenceFailure("evidence_version_mismatch", [
        "evidence_version_owned_by_fact_project_and_source_chapter",
      ]);
    }
    if (
      resolved.version.content.length !== source.sourceLength ||
      resolved.version.content.slice(source.startOffset, source.endOffset) !== source.excerpt
    ) {
      return evidenceFailure("evidence_span_mismatch", [
        "exact_excerpt_offsets_in_immutable_source_version",
      ]);
    }
    if (resolved.contentHash !== resolved.version.contentChecksum) {
      return evidenceFailure("evidence_hash_mismatch", ["verified_source_version_sha256"]);
    }
    return Object.freeze({
      ok: true,
      evidence: Object.freeze({
        sourceKind: "chapter",
        sourceId: source.chapterId,
        sourceVersionId: source.versionId,
        contentHash: resolved.contentHash,
        locator: source.reference,
        excerpt: source.excerpt,
        startOffset: source.startOffset,
        endOffset: source.endOffset,
        sourceLength: source.sourceLength,
      }),
    });
  }

  private resolveVersion(
    versionId: string,
    cache: Map<string, Promise<ResolvedVersionEvidence | null>>,
  ): Promise<ResolvedVersionEvidence | null> {
    const cached = cache.get(versionId);
    if (cached !== undefined) {
      return cached;
    }
    const loading = this.loadVersion(versionId);
    cache.set(versionId, loading);
    return loading;
  }

  private async loadVersion(versionId: string): Promise<ResolvedVersionEvidence | null> {
    const versionResult = await this.dependencies.chapterVersions.findVersionById(
      versionId as UuidV7,
    );
    if (!versionResult.ok) {
      throw storageFailure("Unable to read a chapter version used as validation evidence.");
    }
    if (versionResult.value === null) {
      return null;
    }
    const version = versionResult.value.toSnapshot();
    const hashResult = await this.dependencies.hasher.sha256(version.content);
    if (!hashResult.ok) {
      throw new ChapterNovelValidationRuntimeError(
        "NOVEL_VALIDATION_HASH_UNAVAILABLE",
        "Unable to verify chapter-version evidence before validation.",
        true,
      );
    }
    return Object.freeze({ version, contentHash: hashResult.value });
  }
}

function assertClaim(claim: NovelCurrentClaim): void {
  validateNovelConsistency({ currentClaims: [claim], referenceFacts: [], hardRules: [] });
}

function assertReferenceFact(fact: NovelReferenceFact): void {
  validateNovelConsistency({ currentClaims: [], referenceFacts: [fact], hardRules: [] });
}

function assertHardRule(rule: NovelHardRule): void {
  validateNovelConsistency({ currentClaims: [], referenceFacts: [], hardRules: [rule] });
}

function toUiIssue(
  issue: NovelValidationIssue,
  resolutionSummary: ChapterValidationResolutionSummary | null,
): ChapterValidationUiIssue {
  const currentEvidence = issue.currentClaim.evidence.map(toUiEvidence);
  const conflictingEvidence = issue.conflictingFact.evidence.map(toUiEvidence);
  const currentIdentity = requireAdapterFactIdentity(issue.currentClaim.id, "current_claim");
  const conflictingIdentity = requireAdapterFactIdentity(
    issue.conflictingFact.id,
    issue.conflictingFact.source === "confirmed_fact" ? "reference_fact" : "hard_rule",
  );
  const resolution = toIssueResolution(resolutionSummary);
  return Object.freeze({
    id: issue.id,
    type: issue.issueType,
    currentTextExcerpt: currentEvidence[0]?.excerpt ?? issue.currentClaim.text,
    currentClaim: Object.freeze({
      factId: currentIdentity.factId,
      factRevision: currentIdentity.factRevision,
      factType: issue.currentClaim.factType,
      subjectId: issue.currentClaim.subjectId,
      attributeKey: issue.currentClaim.attributeKey,
      value: issue.currentClaim.value,
      effectiveRange: Object.freeze({ ...issue.overlap }),
    }),
    conflictingFact: Object.freeze({
      id: issue.conflictingFact.id,
      factId: conflictingIdentity.factId,
      factRevision: conflictingIdentity.factRevision,
      source: issue.conflictingFact.source,
      statement: issue.conflictingFact.statement,
      value: issue.conflictingFact.value,
      operator: issue.conflictingFact.operator,
    }),
    currentEvidence: Object.freeze(currentEvidence),
    conflictingEvidence: Object.freeze(conflictingEvidence),
    severity: issue.severity,
    modificationSuggestion: issue.suggestion.summary,
    availableActions:
      resolution.status === "unresolved"
        ? Object.freeze([...CHAPTER_VALIDATION_UI_ACTIONS])
        : Object.freeze([]),
    resolution,
    canUndoIgnore: resolution.status === "ignored",
  });
}

function toUiEvidence(evidence: NovelEvidenceReference): ChapterValidationUiEvidence {
  return Object.freeze({ ...evidence });
}

function collectResolutionSummaries(
  facts: readonly StoryFact[],
  request: ChapterNovelValidationRequest,
  chapterVersionId: UuidV7,
  validatedResolutionFactIds: ReadonlySet<string>,
): readonly ChapterValidationResolutionSummary[] {
  const factsById = new Map(facts.map((fact) => [fact.id as string, fact.toSnapshot()]));
  const summaries: ChapterValidationResolutionSummary[] = [];
  for (const fact of facts) {
    const record = toResolutionFactRecord(fact);
    if (
      record === null ||
      !idsEqual(record.snapshot.projectId, request.projectId) ||
      !idsEqual(record.metadata.chapterId, request.chapterId) ||
      !idsEqual(record.metadata.chapterVersionId, chapterVersionId) ||
      record.snapshot.origin !== "user" ||
      !record.snapshot.userConfirmed
    ) {
      continue;
    }
    let state: ChapterValidationResolutionState;
    if (record.snapshot.deprecated) {
      state = "undone";
    } else if (record.snapshot.status !== "formal") {
      state = "incomplete";
    } else if (record.metadata.action === "ignore") {
      state = record.snapshot.source.kind === "review_decision" ? "active" : "incomplete";
    } else if (record.metadata.action === "allow") {
      state =
        record.snapshot.locked && validatedResolutionFactIds.has(record.snapshot.id)
          ? "active"
          : "incomplete";
    } else {
      const conflicting = factsById.get(record.metadata.conflictingFactId);
      state =
        validatedResolutionFactIds.has(record.snapshot.id) && conflicting?.deprecated === true
          ? "active"
          : "incomplete";
    }
    summaries.push(
      Object.freeze({
        issueId: record.metadata.issueId,
        action: record.metadata.action,
        state,
        factId: record.snapshot.id,
        factRevision: record.snapshot.revision,
        chapterId: record.metadata.chapterId,
        chapterVersionId: record.metadata.chapterVersionId,
        conflictingFactId: record.metadata.conflictingFactId,
        decidedAt: record.snapshot.updatedAt,
      }),
    );
  }
  return Object.freeze(summaries.sort(compareResolutionSummaries));
}

function activeResolutionByIssue(
  summaries: readonly ChapterValidationResolutionSummary[],
): ReadonlyMap<string, ChapterValidationResolutionSummary> {
  const active = new Map<string, ChapterValidationResolutionSummary>();
  for (const summary of summaries) {
    if (summary.state === "active") {
      active.set(summary.issueId, summary);
    }
  }
  return active;
}

function toIssueResolution(
  summary: ChapterValidationResolutionSummary | null,
): ChapterValidationIssueResolution {
  if (summary?.state !== "active") {
    return Object.freeze({ status: "unresolved" });
  }
  return Object.freeze({
    status:
      summary.action === "ignore"
        ? "ignored"
        : summary.action === "allow"
          ? "allowed"
          : "setting_updated",
    factId: summary.factId,
    factRevision: summary.factRevision,
    decidedAt: summary.decidedAt,
  });
}

function parseValidationResolutionMetadata(
  value: StoryValue | null,
): ValidationResolutionMetadata | null {
  if (
    !isRecord(value) ||
    value.resolutionSchema !== CHAPTER_VALIDATION_RESOLUTION_SCHEMA ||
    !CHAPTER_VALIDATION_UI_ACTIONS.includes(value.resolutionAction as ChapterValidationUiAction) ||
    !isBoundedReference(value.resolvedIssueId, 1_000) ||
    !isUuidV7(value.resolvedChapterId) ||
    !isUuidV7(value.resolvedChapterVersionId) ||
    !isUuidV7(value.resolvedConflictingFactId)
  ) {
    return null;
  }
  return Object.freeze({
    action: value.resolutionAction as ChapterValidationUiAction,
    issueId: value.resolvedIssueId,
    chapterId: value.resolvedChapterId,
    chapterVersionId: value.resolvedChapterVersionId,
    conflictingFactId: value.resolvedConflictingFactId,
  });
}

function toResolutionFactRecord(fact: StoryFact): ResolutionFactRecord | null {
  const snapshot = fact.toSnapshot();
  const metadata = parseValidationResolutionMetadata(snapshot.structuredValue);
  return metadata === null ? null : Object.freeze({ fact, snapshot, metadata });
}

function parseSupplementalFindingResolutionMetadata(
  value: StoryValue | null,
): SupplementalFindingResolutionMetadata | null {
  if (
    !isRecord(value) ||
    value.resolutionSchema !== CHAPTER_SUPPLEMENTAL_FINDING_RESOLUTION_SCHEMA ||
    !CHAPTER_SUPPLEMENTAL_FINDING_ACTIONS.includes(
      value.resolutionAction as ChapterSupplementalFindingAction,
    ) ||
    !CHAPTER_SUPPLEMENTAL_FINDING_CATEGORIES.includes(
      value.resolvedFindingCategory as ChapterSupplementalFindingCategory,
    ) ||
    !isBoundedReference(value.resolvedFindingId, 1_000) ||
    !isUuidV7(value.resolvedChapterId) ||
    !isUuidV7(value.resolvedChapterVersionId) ||
    !isBoundedReference(value.evidenceSignature, 5_000)
  ) {
    return null;
  }
  return Object.freeze({
    action: value.resolutionAction as ChapterSupplementalFindingAction,
    findingId: value.resolvedFindingId,
    category: value.resolvedFindingCategory as ChapterSupplementalFindingCategory,
    chapterId: value.resolvedChapterId,
    chapterVersionId: value.resolvedChapterVersionId,
    evidenceSignature: value.evidenceSignature,
  });
}

function toSupplementalFindingResolutionRecord(
  fact: StoryFact,
): SupplementalFindingResolutionRecord | null {
  const snapshot = fact.toSnapshot();
  if (
    snapshot.factType !== "validation_resolution" ||
    snapshot.status !== "formal" ||
    !snapshot.userConfirmed
  ) {
    return null;
  }
  const metadata = parseSupplementalFindingResolutionMetadata(snapshot.structuredValue);
  return metadata === null ? null : Object.freeze({ fact, snapshot, metadata });
}

function supplementalResolutionSummary(
  record: SupplementalFindingResolutionRecord,
): ChapterSupplementalFindingResolutionSummary {
  return Object.freeze({
    findingId: record.metadata.findingId,
    category: record.metadata.category,
    action: record.metadata.action,
    evidenceSignature: record.metadata.evidenceSignature,
    factId: record.snapshot.id,
    factRevision: record.snapshot.revision,
    chapterId: record.metadata.chapterId,
    chapterVersionId: record.metadata.chapterVersionId,
    decidedAt: record.snapshot.updatedAt,
  });
}

function validateSupplementalFindingIdentity(findingId: string, evidenceSignature: string): void {
  if (!isBoundedReference(findingId, 1_000) || !isBoundedReference(evidenceSignature, 5_000)) {
    throw actionFailure(
      "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
      "提醒缺少稳定标识或证据签名，不能保存处理结果。",
      false,
    );
  }
}

function compareResolutionRecords(left: ResolutionFactRecord, right: ResolutionFactRecord): number {
  return (
    right.snapshot.updatedAt.localeCompare(left.snapshot.updatedAt) ||
    right.snapshot.id.localeCompare(left.snapshot.id)
  );
}

function compareResolutionSummaries(
  left: ChapterValidationResolutionSummary,
  right: ChapterValidationResolutionSummary,
): number {
  return left.decidedAt.localeCompare(right.decidedAt) || left.factId.localeCompare(right.factId);
}

function requireAdapterFactIdentity(
  value: string,
  expectedRole: ValidationFactRole,
): Readonly<{ factId: string; factRevision: number }> {
  const prefix = `${expectedRole}:`;
  const revisionMarker = value.lastIndexOf(":r");
  const factId = value.slice(prefix.length, revisionMarker);
  const factRevision = Number(value.slice(revisionMarker + 2));
  if (
    !value.startsWith(prefix) ||
    revisionMarker <= prefix.length ||
    !isUuidV7(factId) ||
    !Number.isSafeInteger(factRevision) ||
    factRevision < 1
  ) {
    throw actionFailure(
      "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
      "检查结果缺少可追溯的事实标识。",
      false,
    );
  }
  return Object.freeze({ factId, factRevision });
}

function resolutionMetadataValue(
  command: ResolveChapterValidationIssueCommand,
  issue: ChapterValidationUiIssue,
): Readonly<Record<string, StoryValue>> {
  return Object.freeze({
    resolutionSchema: CHAPTER_VALIDATION_RESOLUTION_SCHEMA,
    resolutionAction: command.action,
    resolvedIssueId: command.issueId,
    resolvedChapterId: command.chapterId,
    resolvedChapterVersionId: command.expectedChapterVersionId,
    resolvedCurrentFactId: issue.currentClaim.factId,
    resolvedCurrentFactRevision: issue.currentClaim.factRevision,
    resolvedConflictingFactId: issue.conflictingFact.factId,
    resolvedConflictingFactRevision: issue.conflictingFact.factRevision,
  });
}

function evidenceToStoryFactSource(
  evidence: ChapterValidationUiEvidence | undefined,
): CreateStoryFactInput["source"] {
  if (evidence?.sourceKind !== "chapter") {
    throw actionFailure(
      "NOVEL_VALIDATION_RESOLUTION_WRITE_FAILED",
      "当前原文证据不能建立可追溯的正式设定。",
      false,
    );
  }
  return Object.freeze({
    kind: "chapter_span",
    reference: evidence.locator,
    chapterId: evidence.sourceId,
    versionId: evidence.sourceVersionId,
    startOffset: evidence.startOffset,
    endOffset: evidence.endOffset,
    sourceLength: evidence.sourceLength,
    excerpt: evidence.excerpt,
  });
}

function resolutionContentText(
  action: ChapterValidationUiAction,
  issue: ChapterValidationUiIssue,
): string {
  const excerpt = issue.currentTextExcerpt.trim().slice(0, 160);
  if (action === "ignore") {
    return `用户忽略了检查问题：${issue.type}。`;
  }
  if (action === "allow") {
    return `用户允许当前写法并锁定例外：${excerpt}`;
  }
  return `用户依据当前正文更新了正式设定：${excerpt}`;
}

function resolutionOutcome(
  action: ChapterValidationUiAction,
): Exclude<ChapterValidationResolutionReceipt["outcome"], "ignore_undone"> {
  return action === "ignore" ? "ignored" : action === "allow" ? "allowed" : "setting_updated";
}

function actionForResolutionStatus(
  status: Exclude<ChapterValidationIssueResolution["status"], "unresolved">,
): ChapterValidationUiAction {
  return status === "ignored" ? "ignore" : status === "allowed" ? "allow" : "update_setting";
}

function resolutionReceipt(
  command: Readonly<{
    readonly issueId: string;
    readonly expectedChapterVersionId: UuidV7;
    readonly action?: ChapterValidationUiAction;
  }>,
  snapshot: StoryFactSnapshot,
  outcome: ChapterValidationResolutionReceipt["outcome"],
  idempotent: boolean,
): ChapterValidationResolutionReceipt {
  const action = command.action ?? "ignore";
  return Object.freeze({
    issueId: command.issueId,
    action,
    outcome,
    resolutionFactId: snapshot.id,
    resolutionFactRevision: snapshot.revision,
    chapterVersionId: command.expectedChapterVersionId,
    idempotent,
    audit: Object.freeze({
      storage: "story_fact",
      sourceKind: action === "ignore" ? "review_decision" : "chapter_span",
      humanConfirmed: true,
    }),
  });
}

function validationRole(value: StoryValue | null): ValidationFactRole | null {
  if (!isRecord(value)) {
    return null;
  }
  return value.validationRole === "current_claim" ||
    value.validationRole === "reference_fact" ||
    value.validationRole === "hard_rule"
    ? value.validationRole
    : null;
}

function isContinuousExtractionSource(snapshot: StoryFactSnapshot): boolean {
  return snapshot.source.reference.startsWith("continuous-story-state:");
}

function continuousProjectionValidationSkip(
  value: ContinuousProjectionDiagnostic,
): ChapterValidationSkippedFact {
  const reason: ChapterValidationAdapterSkipReason =
    value.reason === "branch_mismatch"
      ? "other_branch"
      : value.reason === "human_confirmation_required"
        ? "reference_fact_not_confirmed"
        : value.reason === "knowledge_source_incomplete"
          ? "pov_knowledge_source_incomplete"
          : value.reason === "knowledge_source_unverified"
            ? "pov_knowledge_source_unverified"
            : value.reason === "knowledge_source_inactive"
              ? "pov_knowledge_source_inactive"
              : value.reason === "current_version_required"
                ? "current_claim_not_current_version"
                : value.reason === "evidence_invalid"
                  ? "evidence_span_mismatch"
                  : "structured_fields_missing";
  return Object.freeze({
    factId: value.sourceFactId,
    role: null,
    reason,
    missingRequirements: Object.freeze([...value.missingRequirements]),
  });
}

function renderStructuredStatement(snapshot: StoryFactSnapshot, value: unknown): string {
  if (snapshot.contentText !== null) {
    return snapshot.contentText;
  }
  const structured = snapshot.structuredValue;
  const subject =
    isRecord(structured) && typeof structured.subjectId === "string"
      ? structured.subjectId
      : "unknown";
  const attribute =
    isRecord(structured) && typeof structured.attributeKey === "string"
      ? structured.attributeKey
      : snapshot.factType;
  return `${subject}.${attribute} = ${stableValue(value)}`;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${key}: ${stableValue(record[key])}`)
      .join(", ")}}`;
  }
  return String(value);
}

function skipFact(
  snapshot: StoryFactSnapshot,
  role: ValidationFactRole | null,
  reason: ChapterValidationAdapterSkipReason,
  missingRequirements: readonly string[],
): ChapterValidationSkippedFact {
  return Object.freeze({
    factId: snapshot.id,
    role,
    reason,
    missingRequirements: Object.freeze([...missingRequirements]),
  });
}

function evidenceFailure(
  reason: ChapterValidationAdapterSkipReason,
  missingRequirements: readonly string[],
): EvidenceResolution {
  return Object.freeze({
    ok: false,
    reason,
    missingRequirements: Object.freeze([...missingRequirements]),
  });
}

function skippedRun(
  request: ChapterNovelValidationRequest,
  reason: ChapterValidationAdapterSkipReason,
  missingRequirements: readonly string[],
): ChapterNovelValidationResult {
  return freezeResult({
    status: "skipped",
    projectId: request.projectId,
    chapterId: request.chapterId,
    chapterVersionId: null,
    chapterRevision: null,
    issues: [],
    resolutions: [],
    skippedFacts: [
      Object.freeze({
        factId: null,
        role: null,
        reason,
        missingRequirements: Object.freeze([...missingRequirements]),
      }),
    ],
    missingRequirements,
    explanation: `Deterministic chapter validation skipped: ${missingRequirements.join(", ")}.`,
    checked: { currentClaims: 0, referenceFacts: 0, hardRules: 0 },
    coverage: emptyDeterministicCoverage(),
  });
}

function deterministicCoverage(
  adapted: Pick<AdaptedFactCollections, "currentClaims" | "referenceFacts" | "hardRules">,
): readonly ChapterValidationCoverageItem[] {
  return Object.freeze(
    CHAPTER_VALIDATION_COVERAGE_CATEGORIES.map((category) => {
      const claims = adapted.currentClaims.filter(({ factType }) => factType === category);
      const references = adapted.referenceFacts.filter(({ factType }) => factType === category);
      const rules = adapted.hardRules.filter(({ targetFactType }) => targetFactType === category);
      let comparableReferenceCount = 0;
      let applicableHardRuleCount = 0;
      for (const claim of claims) {
        comparableReferenceCount += references.filter((fact) =>
          assertionsCanBeCompared(claim, fact),
        ).length;
        applicableHardRuleCount += rules.filter((rule) => ruleCanBeCompared(claim, rule)).length;
      }
      const status =
        comparableReferenceCount > 0 || applicableHardRuleCount > 0 ? "checked" : "not_checked";
      const reason: ChapterValidationCoverageReason =
        status === "checked"
          ? "explicit_claim_compared"
          : claims.length === 0
            ? "current_claim_missing"
            : references.length === 0 && rules.length === 0
              ? "confirmed_reference_or_rule_missing"
              : "no_comparable_source";
      return Object.freeze({
        category,
        status,
        reason,
        currentClaimCount: claims.length,
        comparableReferenceCount,
        applicableHardRuleCount,
      });
    }),
  );
}

function emptyDeterministicCoverage(): readonly ChapterValidationCoverageItem[] {
  return Object.freeze(
    CHAPTER_VALIDATION_COVERAGE_CATEGORIES.map((category) =>
      Object.freeze({
        category,
        status: "not_checked" as const,
        reason: "current_claim_missing" as const,
        currentClaimCount: 0,
        comparableReferenceCount: 0,
        applicableHardRuleCount: 0,
      }),
    ),
  );
}

function assertionsCanBeCompared(claim: NovelCurrentClaim, fact: NovelReferenceFact): boolean {
  return (
    claim.subjectId === fact.subjectId &&
    claim.attributeKey === fact.attributeKey &&
    branchesCanOverlap(claim.branchId, fact.branchId) &&
    rangesCanOverlap(claim.effectiveRange, fact.effectiveRange)
  );
}

function ruleCanBeCompared(claim: NovelCurrentClaim, rule: NovelHardRule): boolean {
  return (
    claim.subjectId === rule.subjectId &&
    claim.attributeKey === rule.attributeKey &&
    branchesCanOverlap(claim.branchId, rule.branchId) &&
    rangesCanOverlap(claim.effectiveRange, rule.effectiveRange)
  );
}

function branchesCanOverlap(left: string | null, right: string | null): boolean {
  return left === null || right === null || left === right;
}

function rangesCanOverlap(
  left: Readonly<{ readonly startOrder: number; readonly endOrder: number | null }>,
  right: Readonly<{ readonly startOrder: number; readonly endOrder: number | null }>,
): boolean {
  return (
    Math.max(left.startOrder, right.startOrder) <=
    Math.min(left.endOrder ?? Number.POSITIVE_INFINITY, right.endOrder ?? Number.POSITIVE_INFINITY)
  );
}

function counts(adapted: AdaptedFactCollections): ChapterNovelValidationResult["checked"] {
  return Object.freeze({
    currentClaims: adapted.currentClaims.length,
    referenceFacts: adapted.referenceFacts.length,
    hardRules: adapted.hardRules.length,
  });
}

function freezeResult(
  input: Omit<ChapterNovelValidationResult, "capabilities">,
): ChapterNovelValidationResult {
  return Object.freeze({
    ...input,
    issues: Object.freeze([...input.issues]),
    resolutions: Object.freeze([...input.resolutions]),
    skippedFacts: Object.freeze([...input.skippedFacts]),
    missingRequirements: Object.freeze([...input.missingRequirements]),
    checked: Object.freeze({ ...input.checked }),
    ...(input.coverage === undefined
      ? {}
      : { coverage: Object.freeze(input.coverage.map((item) => Object.freeze({ ...item }))) }),
    capabilities: Object.freeze({
      deterministicValidation: "ready",
      naturalLanguageInference: "disabled",
      ambiguousModelReview: "separate_read_only_service",
      mutatesChapter: false,
    }),
  });
}

function storageFailure(message: string): ChapterNovelValidationRuntimeError {
  return new ChapterNovelValidationRuntimeError(
    "NOVEL_VALIDATION_STORAGE_UNAVAILABLE",
    message,
    true,
  );
}

function actionFailure(
  code: Exclude<
    ChapterNovelValidationRuntimeErrorCode,
    "NOVEL_VALIDATION_STORAGE_UNAVAILABLE" | "NOVEL_VALIDATION_HASH_UNAVAILABLE"
  >,
  message: string,
  retryable: boolean,
): ChapterNovelValidationRuntimeError {
  return new ChapterNovelValidationRuntimeError(code, message, retryable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idsEqual(left: string | null, right: string | null): boolean {
  return left === right;
}

function isBoundedReference(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isUuidV7(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
