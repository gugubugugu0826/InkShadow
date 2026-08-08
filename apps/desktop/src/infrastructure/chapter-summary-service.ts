import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import type { ChapterPrivacyMode } from "@inkshadow/domain";
import { parseUuidV7 as parseDomainUuid } from "@inkshadow/domain";
import {
  REBUILDABLE_SYSTEM_FACT_SCHEMA_VERSION,
  parseUuidV7 as parseStoryUuid,
  type StoryFact,
  type StoryFactApplicationService,
  type StoryFactStore,
} from "@inkshadow/story-core";

import {
  ProjectContextPrivacyError,
  type ProjectContextPrivacyAuthority,
  type ProjectContextPrivacyReceipt,
} from "./project-context-privacy-authority";

export const CHAPTER_SUMMARY_PAYLOAD_SCHEMA_VERSION = "inkshadow.chapter-summary.v1" as const;
export const CHAPTER_SUMMARY_TASK = "long_memory_compression" as const;
export const CHAPTER_SUMMARY_SEGMENT_CHARACTERS = 1_800;
export const CHAPTER_SUMMARY_MAXIMUM_SEGMENTS = 48;
export const CHAPTER_SUMMARY_MAXIMUM_SOURCE_CHARACTERS =
  CHAPTER_SUMMARY_SEGMENT_CHARACTERS * CHAPTER_SUMMARY_MAXIMUM_SEGMENTS;

export interface ChapterSummarySourceSegment {
  readonly evidenceId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

export interface ChapterSummaryModelEntry {
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

export interface ChapterSummaryModelInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly sourceContentHash: string;
  readonly sourceLength: number;
  readonly segments: readonly ChapterSummarySourceSegment[];
  /** Exact project privacy authority bound to the native network dispatch. */
  readonly projectPrivacy: ProjectContextPrivacyReceipt;
  /** Present for production calls; optional only for older custom model adapters. */
  readonly privacyMode?: ChapterPrivacyMode;
  /** Project-wide authority captured before any chapter正文 is assembled. */
  readonly requiresVerifiedLocal?: boolean;
  readonly assertSourceCurrent: () => Promise<void>;
  /** A boolean argument means the selected route is about to dispatch. */
  readonly assertProjectPrivacyCurrent?: (verifiedLocalEligible?: boolean) => Promise<void>;
}

export interface ChapterSummaryModelOutput {
  readonly summary: string;
  readonly keyEvents: readonly ChapterSummaryModelEntry[];
  readonly continuityNotes: readonly ChapterSummaryModelEntry[];
  readonly evidenceIds: readonly string[];
  readonly providerKind: string;
  readonly modelId: string;
  readonly invocationId: string;
  readonly estimatedInputTokens: number;
}

export interface ChapterSummaryModelPort {
  summarize(input: ChapterSummaryModelInput): Promise<ChapterSummaryModelOutput>;
}

export class ChapterSummaryModelUnavailableError extends Error {
  public override readonly name = "ChapterSummaryModelUnavailableError";

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ChapterSummaryPreferenceStore {
  isAutomaticOnManualSaveEnabled(projectId: string): boolean;
  setAutomaticOnManualSaveEnabled(projectId: string, enabled: boolean): void;
}

export class BrowserChapterSummaryPreferenceStore implements ChapterSummaryPreferenceStore {
  public constructor(private readonly storage: Pick<Storage, "getItem" | "setItem"> | null) {}

  public isAutomaticOnManualSaveEnabled(projectId: string): boolean {
    try {
      return this.storage?.getItem(preferenceKey(projectId)) === "enabled";
    } catch {
      return false;
    }
  }

  public setAutomaticOnManualSaveEnabled(projectId: string, enabled: boolean): void {
    try {
      this.storage?.setItem(preferenceKey(projectId), enabled ? "enabled" : "disabled");
    } catch {
      // A blocked browser preference must fail safe: manual-save calls remain disabled.
    }
  }

  public isContinuousStoryStateOnManualSaveEnabled(projectId: string): boolean {
    try {
      return this.storage?.getItem(continuousStoryStatePreferenceKey(projectId)) === "enabled";
    } catch {
      return false;
    }
  }

  public setContinuousStoryStateOnManualSaveEnabled(projectId: string, enabled: boolean): void {
    try {
      this.storage?.setItem(
        continuousStoryStatePreferenceKey(projectId),
        enabled ? "enabled" : "disabled",
      );
    } catch {
      // A blocked preference store must leave automatic provider work disabled.
    }
  }
}

export interface ChapterSummaryGenerationReceipt {
  readonly status: "generated" | "skipped" | "already_current" | "failed";
  readonly code: string;
  readonly message: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly fact: StoryFact | null;
  readonly replacedFactIds: readonly string[];
  readonly invocation: Readonly<{
    readonly task: typeof CHAPTER_SUMMARY_TASK;
    readonly providerKind: string;
    readonly modelId: string;
    readonly invocationId: string;
  }> | null;
}

export interface ChapterSummaryDashboardEntry {
  readonly chapterId: string;
  readonly chapterTitle: string;
  readonly currentVersionId: string;
  readonly state: "current" | "stale" | "missing" | "invalid";
  readonly message: string;
  readonly summary: string | null;
  readonly sourceVersionId: string | null;
  readonly sourceContentHash: string | null;
  readonly providerKind: string | null;
  readonly modelId: string | null;
  readonly invocationId: string | null;
  readonly factId: string | null;
}

export interface ChapterSummaryDashboard {
  readonly automaticOnManualSaveEnabled: boolean;
  readonly entries: readonly ChapterSummaryDashboardEntry[];
}

interface ChapterSummaryServiceDependencies {
  readonly chapters: Pick<ChapterRepository, "findById" | "listByProjectId">;
  readonly chapterVersions: Pick<ChapterVersionRepository, "findVersionById">;
  readonly facts: StoryFactStore;
  readonly factService: StoryFactApplicationService;
  readonly hasher: ContentHasher;
  readonly model: ChapterSummaryModelPort;
  readonly preferences: ChapterSummaryPreferenceStore;
  readonly projectContextPrivacy: Pick<
    ProjectContextPrivacyAuthority,
    "inspect" | "assertCurrentBeforeDispatch" | "assertRouteEligible"
  >;
}

interface VerifiedChapterSummarySource {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly chapterTitle: string;
  readonly content: string;
  readonly contentHash: string;
  readonly privacyMode: ChapterPrivacyMode;
  readonly privacyRevision: number;
  readonly revision: number;
}

export interface StoredChapterSummaryPayload {
  readonly schemaVersion: typeof CHAPTER_SUMMARY_PAYLOAD_SCHEMA_VERSION;
  readonly sourceProjectId: string;
  readonly sourceChapterId: string;
  readonly sourceVersionId: string;
  readonly sourceContentHash: string;
  readonly citations: readonly Readonly<{
    readonly evidenceId: string;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly sourceLength: number;
  }>[];
  readonly keyEvents: readonly ChapterSummaryModelEntry[];
  readonly continuityNotes: readonly ChapterSummaryModelEntry[];
  readonly generation: Readonly<{
    readonly task: typeof CHAPTER_SUMMARY_TASK;
    readonly providerKind: string;
    readonly modelId: string;
    readonly invocationId: string;
  }>;
  readonly budget: Readonly<{
    readonly strategy: "bounded_utf16_segments";
    readonly segmentCharacters: number;
    readonly maximumSegments: number;
    readonly sourceCharacters: number;
    readonly estimatedInputTokens: number;
    readonly tokenEstimate: "model_hub_estimate_not_provider_tokenizer";
  }>;
}

class ChapterSummarySourceError extends Error {
  public override readonly name = "ChapterSummarySourceError";

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const REFERENCE_PREFIX = "chapter-summary";

export function shouldRunChapterSummaryAfterSave(
  reason: "autosave" | "manual",
  automaticOnManualSaveEnabled: boolean,
): boolean {
  return reason === "manual" && automaticOnManualSaveEnabled;
}

export class ChapterSummaryService {
  private readonly inFlight = new Map<string, Promise<ChapterSummaryGenerationReceipt>>();

  public constructor(private readonly dependencies: ChapterSummaryServiceDependencies) {}

  public isAutomaticOnManualSaveEnabled(projectId: string): boolean {
    return this.dependencies.preferences.isAutomaticOnManualSaveEnabled(projectId);
  }

  public setAutomaticOnManualSaveEnabled(projectId: string, enabled: boolean): void {
    this.dependencies.preferences.setAutomaticOnManualSaveEnabled(projectId, enabled);
  }

  public summarizeSavedVersion(input: {
    readonly projectId: string;
    readonly chapterId: string;
    readonly versionId: string;
    readonly trigger: "manual_save" | "user_rebuild" | "historical_backfill";
  }): Promise<ChapterSummaryGenerationReceipt> {
    if (
      input.trigger === "manual_save" &&
      !this.dependencies.preferences.isAutomaticOnManualSaveEnabled(input.projectId)
    ) {
      return Promise.resolve(
        receipt(input, "skipped", "CHAPTER_SUMMARY_AUTOMATION_PAUSED", "章节摘要自动更新已暂停。"),
      );
    }
    const key = `${input.projectId}:${input.chapterId}:${input.versionId}`;
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      return running;
    }
    const work = this.summarizeOnce(input).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  public async clearChapterSummary(input: {
    readonly projectId: string;
    readonly chapterId: string;
  }): Promise<readonly string[]> {
    const cleared = await this.dependencies.factService.clearRebuildableSystemFacts({
      projectId: input.projectId,
      factType: "chapter_summary",
      replacementKey: replacementKey(input.chapterId),
    });
    if (!cleared.ok) {
      throw cleared.error;
    }
    return cleared.value;
  }

  public async inspectProject(projectIdValue: string): Promise<ChapterSummaryDashboard> {
    const projectId = parseDomainUuid(projectIdValue);
    if (!projectId.ok) {
      throw projectId.error;
    }
    const [chapters, facts] = await Promise.all([
      this.dependencies.chapters.listByProjectId(projectId.value),
      this.listProjectFacts(projectIdValue),
    ]);
    if (!chapters.ok) {
      throw chapters.error;
    }
    const activeFacts = facts.filter((fact) => isActiveGeneratedChapterSummary(fact));
    const entries = await Promise.all(
      chapters.value
        .filter((chapter) => chapter.status === "active")
        .map(async (chapter): Promise<ChapterSummaryDashboardEntry> => {
          const candidates = activeFacts
            .filter((fact) => String(fact.toSnapshot().source.chapterId) === String(chapter.id))
            .sort((left, right) =>
              right.toSnapshot().updatedAt.localeCompare(left.toSnapshot().updatedAt),
            );
          const selected = candidates.at(0) ?? null;
          if (selected === null) {
            return dashboardEntry(chapter.id, chapter.title, chapter.currentVersionId, "missing", {
              message: "尚未生成章节摘要。",
            });
          }
          const payload = parseStoredChapterSummaryPayload(selected);
          if (payload === null) {
            return dashboardEntry(chapter.id, chapter.title, chapter.currentVersionId, "invalid", {
              message: "现有摘要元数据不完整，建议重建。",
              factId: selected.id,
              summary: selected.toSnapshot().contentText,
            });
          }
          let state: ChapterSummaryDashboardEntry["state"] = "current";
          let message = "摘要与当前保存版本一致。";
          try {
            await this.readVerifiedSource({
              projectId: projectIdValue,
              chapterId: chapter.id,
              versionId: chapter.currentVersionId,
            });
            if (
              payload.sourceVersionId !== chapter.currentVersionId ||
              payload.sourceChapterId !== chapter.id
            ) {
              state = "stale";
              message = "摘要来自旧版本，不会进入后续写作上下文。";
            } else {
              const version = await this.dependencies.chapterVersions.findVersionById(
                chapter.currentVersionId,
              );
              if (!version.ok || version.value === null) {
                state = "invalid";
                message = "当前保存版本无法核验，摘要已停用。";
              } else if (version.value.toSnapshot().contentChecksum !== payload.sourceContentHash) {
                state = "stale";
                message = "摘要的正文校验值已过期，不会进入后续写作上下文。";
              }
            }
          } catch {
            state = "invalid";
            message = "摘要来源无法核验，摘要已停用。";
          }
          return dashboardEntry(chapter.id, chapter.title, chapter.currentVersionId, state, {
            message,
            summary: selected.toSnapshot().contentText,
            sourceVersionId: payload.sourceVersionId,
            sourceContentHash: payload.sourceContentHash,
            providerKind: payload.generation.providerKind,
            modelId: payload.generation.modelId,
            invocationId: payload.generation.invocationId,
            factId: selected.id,
          });
        }),
    );
    return Object.freeze({
      automaticOnManualSaveEnabled:
        this.dependencies.preferences.isAutomaticOnManualSaveEnabled(projectIdValue),
      entries: Object.freeze(entries),
    });
  }

  private async summarizeOnce(input: {
    readonly projectId: string;
    readonly chapterId: string;
    readonly versionId: string;
    readonly trigger: "manual_save" | "user_rebuild" | "historical_backfill";
  }): Promise<ChapterSummaryGenerationReceipt> {
    try {
      const projectPrivacy = await this.dependencies.projectContextPrivacy.inspect(input.projectId);
      const source = await this.readVerifiedSource(input);
      assertSummarySourceMatchesProjectReceipt(projectPrivacy, source);
      if (source.content.length === 0) {
        return receipt(input, "skipped", "CHAPTER_SUMMARY_EMPTY_CHAPTER", "空章节无需生成摘要。");
      }
      if (source.content.length > CHAPTER_SUMMARY_MAXIMUM_SOURCE_CHARACTERS) {
        return receipt(
          input,
          "skipped",
          "CHAPTER_SUMMARY_SOURCE_TOO_LARGE",
          "本章超过单次摘要的安全上限，请拆分章节后重试。",
        );
      }
      if (input.trigger !== "user_rebuild" && (await this.hasCurrentSummary(source))) {
        return receipt(
          input,
          "already_current",
          "CHAPTER_SUMMARY_ALREADY_CURRENT",
          "当前保存版本已有可用摘要。",
        );
      }
      const segments = segmentChapterSource(source);
      const output = await this.dependencies.model.summarize({
        projectId: source.projectId,
        chapterId: source.chapterId,
        versionId: source.versionId,
        sourceContentHash: source.contentHash,
        sourceLength: source.content.length,
        segments,
        projectPrivacy,
        privacyMode: source.privacyMode,
        requiresVerifiedLocal: projectPrivacy.requiresVerifiedLocal,
        assertSourceCurrent: async () => {
          await this.readVerifiedSource(source);
        },
        assertProjectPrivacyCurrent: async (verifiedLocalEligible) => {
          await this.dependencies.projectContextPrivacy.assertCurrentBeforeDispatch(projectPrivacy);
          if (verifiedLocalEligible !== undefined) {
            this.dependencies.projectContextPrivacy.assertRouteEligible(
              projectPrivacy,
              verifiedLocalEligible,
            );
          }
        },
      });
      await this.readVerifiedSource(source);
      await this.dependencies.projectContextPrivacy.assertCurrentBeforeDispatch(projectPrivacy);
      const citedSegments = resolveCitedSegments(output, segments);
      const primary = citedSegments.at(0);
      if (primary === undefined) {
        throw new ChapterSummarySourceError(
          "CHAPTER_SUMMARY_EVIDENCE_INVALID",
          "摘要没有可核验的正文证据。",
        );
      }
      const payload: StoredChapterSummaryPayload = Object.freeze({
        schemaVersion: CHAPTER_SUMMARY_PAYLOAD_SCHEMA_VERSION,
        sourceProjectId: source.projectId,
        sourceChapterId: source.chapterId,
        sourceVersionId: source.versionId,
        sourceContentHash: source.contentHash,
        citations: Object.freeze(
          citedSegments.map((segment) =>
            Object.freeze({
              evidenceId: segment.evidenceId,
              startOffset: segment.startOffset,
              endOffset: segment.endOffset,
              sourceLength: source.content.length,
            }),
          ),
        ),
        keyEvents: output.keyEvents,
        continuityNotes: output.continuityNotes,
        generation: Object.freeze({
          task: CHAPTER_SUMMARY_TASK,
          providerKind: output.providerKind,
          modelId: output.modelId,
          invocationId: output.invocationId,
        }),
        budget: Object.freeze({
          strategy: "bounded_utf16_segments",
          segmentCharacters: CHAPTER_SUMMARY_SEGMENT_CHARACTERS,
          maximumSegments: CHAPTER_SUMMARY_MAXIMUM_SEGMENTS,
          sourceCharacters: source.content.length,
          estimatedInputTokens: output.estimatedInputTokens,
          tokenEstimate: "model_hub_estimate_not_provider_tokenizer",
        }),
      });
      const saved = await this.dependencies.factService.replaceRebuildableSystemFact({
        projectId: source.projectId,
        factType: "chapter_summary",
        replacementKey: replacementKey(source.chapterId),
        contentText: output.summary,
        payload,
        source: {
          kind: "chapter_span",
          reference: `${REFERENCE_PREFIX}:${source.chapterId}:${source.versionId}:sha256:${source.contentHash}`,
          chapterId: source.chapterId,
          versionId: source.versionId,
          startOffset: primary.startOffset,
          endOffset: primary.endOffset,
          sourceLength: source.content.length,
          excerpt: primary.text,
        },
        confidence: 1,
      });
      if (!saved.ok) {
        throw saved.error;
      }
      return Object.freeze({
        ...receipt(
          input,
          "generated",
          "CHAPTER_SUMMARY_GENERATED",
          "章节摘要已从当前保存版本生成，可撤销且不会修改正文。",
        ),
        fact: saved.value.fact,
        replacedFactIds: saved.value.replacedFactIds,
        invocation: Object.freeze({
          task: CHAPTER_SUMMARY_TASK,
          providerKind: output.providerKind,
          modelId: output.modelId,
          invocationId: output.invocationId,
        }),
      });
    } catch (cause: unknown) {
      if (cause instanceof ChapterSummaryModelUnavailableError) {
        return receipt(input, "skipped", cause.code, cause.message);
      }
      if (
        cause instanceof ChapterSummarySourceError &&
        [
          "CHAPTER_SUMMARY_SOURCE_NOT_CURRENT",
          "CHAPTER_SUMMARY_EMPTY_CHAPTER",
          "CHAPTER_SUMMARY_SOURCE_TOO_LARGE",
        ].includes(cause.code)
      ) {
        return receipt(input, "skipped", cause.code, cause.message);
      }
      return receipt(
        input,
        "failed",
        errorCode(cause),
        cause instanceof Error ? cause.message : "章节摘要生成失败；正文和已有摘要均未被修改。",
      );
    }
  }

  private async hasCurrentSummary(source: VerifiedChapterSummarySource): Promise<boolean> {
    const facts = await this.listProjectFacts(source.projectId);
    return facts.some((fact) => {
      if (!isActiveGeneratedChapterSummary(fact)) {
        return false;
      }
      const payload = parseStoredChapterSummaryPayload(fact);
      return (
        payload?.sourceChapterId === source.chapterId &&
        payload.sourceVersionId === source.versionId &&
        payload.sourceContentHash === source.contentHash
      );
    });
  }

  private async listProjectFacts(projectIdValue: string): Promise<readonly StoryFact[]> {
    const projectId = parseStoryUuid(projectIdValue);
    if (!projectId.ok) {
      throw projectId.error;
    }
    const facts = await this.dependencies.facts.listByProjectId(projectId.value, {
      factType: "chapter_summary",
    });
    if (!facts.ok) {
      throw facts.error;
    }
    return facts.value;
  }

  private async readVerifiedSource(input: {
    readonly projectId: string;
    readonly chapterId: string;
    readonly versionId: string;
    readonly contentHash?: string;
    readonly privacyMode?: ChapterPrivacyMode;
    readonly privacyRevision?: number;
  }): Promise<VerifiedChapterSummarySource> {
    const projectId = parseDomainUuid(input.projectId);
    const chapterId = parseDomainUuid(input.chapterId);
    const versionId = parseDomainUuid(input.versionId);
    if (!projectId.ok || !chapterId.ok || !versionId.ok) {
      throw new ChapterSummarySourceError(
        "CHAPTER_SUMMARY_SOURCE_ID_INVALID",
        "章节摘要的项目、章节或版本标识无效。",
      );
    }
    const chapter = await this.dependencies.chapters.findById(chapterId.value);
    if (!chapter.ok) {
      throw chapter.error;
    }
    if (chapter.value === null) {
      throw new ChapterSummarySourceError(
        "CHAPTER_SUMMARY_CHAPTER_NOT_FOUND",
        "找不到要生成摘要的章节。",
      );
    }
    if (
      chapter.value.projectId !== projectId.value ||
      chapter.value.status !== "active" ||
      chapter.value.currentVersionId !== versionId.value
    ) {
      throw new ChapterSummarySourceError(
        "CHAPTER_SUMMARY_SOURCE_NOT_CURRENT",
        "章节已产生更新版本，本次旧版本摘要已跳过。",
      );
    }
    const version = await this.dependencies.chapterVersions.findVersionById(versionId.value);
    if (!version.ok) {
      throw version.error;
    }
    if (version.value === null) {
      throw new ChapterSummarySourceError(
        "CHAPTER_SUMMARY_VERSION_NOT_FOUND",
        "找不到对应的不可变保存版本。",
      );
    }
    const snapshot = version.value.toSnapshot();
    if (snapshot.projectId !== projectId.value || snapshot.chapterId !== chapterId.value) {
      throw new ChapterSummarySourceError(
        "CHAPTER_SUMMARY_SOURCE_SCOPE_MISMATCH",
        "保存版本不属于当前项目和章节。",
      );
    }
    const hashed = await this.dependencies.hasher.sha256(snapshot.content);
    if (!hashed.ok) {
      throw hashed.error;
    }
    if (
      hashed.value !== snapshot.contentChecksum ||
      (input.contentHash !== undefined && hashed.value !== input.contentHash) ||
      chapter.value.content !== snapshot.content
    ) {
      throw new ChapterSummarySourceError(
        "CHAPTER_SUMMARY_SOURCE_INTEGRITY_FAILED",
        "保存版本正文或校验值不一致，未生成摘要。",
      );
    }
    if (
      (input.privacyMode !== undefined && chapter.value.privacyMode !== input.privacyMode) ||
      (input.privacyRevision !== undefined &&
        chapter.value.privacyRevision !== input.privacyRevision)
    ) {
      throw new ChapterSummarySourceError(
        "CHAPTER_SUMMARY_PRIVACY_CHANGED",
        "章节隐私设置已变化，本次摘要在发送正文前停止，请重新运行。",
      );
    }
    return Object.freeze({
      projectId: input.projectId,
      chapterId: input.chapterId,
      versionId: input.versionId,
      chapterTitle: chapter.value.title,
      content: snapshot.content,
      contentHash: hashed.value,
      privacyMode: chapter.value.privacyMode,
      privacyRevision: chapter.value.privacyRevision,
      revision: chapter.value.revision,
    });
  }
}

function assertSummarySourceMatchesProjectReceipt(
  receipt: ProjectContextPrivacyReceipt,
  source: VerifiedChapterSummarySource,
): void {
  const binding = receipt.chapters.find(({ chapterId }) => chapterId === source.chapterId);
  if (
    receipt.projectId !== source.projectId ||
    binding?.status !== "active" ||
    binding.currentVersionId !== source.versionId ||
    binding.revision !== source.revision ||
    binding.privacyMode !== source.privacyMode ||
    binding.privacyRevision !== source.privacyRevision
  ) {
    throw new ProjectContextPrivacyError(
      "PROJECT_CONTEXT_PRIVACY_CHANGED",
      "章节版本或作品隐私范围在摘要准备期间发生了变化；本次请求在发送 0 字后停止。",
      true,
    );
  }
}

export function segmentChapterSource(
  source: Pick<VerifiedChapterSummarySource, "chapterId" | "versionId" | "contentHash" | "content">,
): readonly ChapterSummarySourceSegment[] {
  if (source.content.length > CHAPTER_SUMMARY_MAXIMUM_SOURCE_CHARACTERS) {
    throw new ChapterSummarySourceError(
      "CHAPTER_SUMMARY_SOURCE_TOO_LARGE",
      "本章超过单次摘要的安全上限。",
    );
  }
  const segments: ChapterSummarySourceSegment[] = [];
  for (let startOffset = 0; startOffset < source.content.length;) {
    let endOffset = Math.min(
      source.content.length,
      startOffset + CHAPTER_SUMMARY_SEGMENT_CHARACTERS,
    );
    if (
      endOffset < source.content.length &&
      isHighSurrogate(source.content.charCodeAt(endOffset - 1)) &&
      isLowSurrogate(source.content.charCodeAt(endOffset))
    ) {
      endOffset -= 1;
    }
    const text = source.content.slice(startOffset, endOffset);
    segments.push(
      Object.freeze({
        evidenceId: `chapter:${source.chapterId}:version:${source.versionId}:sha256:${source.contentHash}:utf16:${String(startOffset)}-${String(endOffset)}`,
        startOffset,
        endOffset,
        text,
      }),
    );
    startOffset = endOffset;
  }
  return Object.freeze(segments);
}

export function parseStoredChapterSummaryPayload(
  fact: StoryFact,
): StoredChapterSummaryPayload | null {
  const snapshot = fact.toSnapshot();
  const value = fact.toSnapshot().structuredValue;
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "replacementKey", "payload"])) {
    return null;
  }
  if (value.schemaVersion !== REBUILDABLE_SYSTEM_FACT_SCHEMA_VERSION || !isRecord(value.payload)) {
    return null;
  }
  const payload = value.payload;
  if (
    !hasExactKeys(payload, [
      "schemaVersion",
      "sourceProjectId",
      "sourceChapterId",
      "sourceVersionId",
      "sourceContentHash",
      "citations",
      "keyEvents",
      "continuityNotes",
      "generation",
      "budget",
    ]) ||
    payload.schemaVersion !== CHAPTER_SUMMARY_PAYLOAD_SCHEMA_VERSION ||
    typeof payload.sourceProjectId !== "string" ||
    typeof payload.sourceChapterId !== "string" ||
    typeof payload.sourceVersionId !== "string" ||
    typeof payload.sourceContentHash !== "string" ||
    value.replacementKey !== replacementKey(payload.sourceChapterId) ||
    !parseStoryUuid(payload.sourceProjectId).ok ||
    !parseStoryUuid(payload.sourceChapterId).ok ||
    !parseStoryUuid(payload.sourceVersionId).ok ||
    payload.sourceProjectId !== snapshot.projectId ||
    !/^[a-f0-9]{64}$/u.test(payload.sourceContentHash) ||
    !isValidStoredCitations(payload.citations, payload) ||
    !isValidStoredEntries(payload.keyEvents) ||
    !isValidStoredEntries(payload.continuityNotes) ||
    !isGeneration(payload.generation) ||
    !isBudget(payload.budget)
  ) {
    return null;
  }
  const parsed = payload as unknown as StoredChapterSummaryPayload;
  const citationIds = new Set(parsed.citations.map(({ evidenceId }) => evidenceId));
  if (
    citationIds.size !== parsed.citations.length ||
    parsed.citations.some(({ sourceLength }) => sourceLength !== parsed.budget.sourceCharacters) ||
    [...parsed.keyEvents, ...parsed.continuityNotes].some(({ evidenceIds }) =>
      evidenceIds.some((id) => !citationIds.has(id)),
    ) ||
    snapshot.source.kind !== "chapter_span" ||
    snapshot.source.chapterId !== parsed.sourceChapterId ||
    snapshot.source.versionId !== parsed.sourceVersionId ||
    snapshot.source.sourceLength !== parsed.budget.sourceCharacters ||
    snapshot.source.startOffset === null ||
    snapshot.source.endOffset === null ||
    !parsed.citations.some(
      ({ startOffset, endOffset }) =>
        startOffset === snapshot.source.startOffset && endOffset === snapshot.source.endOffset,
    ) ||
    snapshot.source.reference !==
      `${REFERENCE_PREFIX}:${parsed.sourceChapterId}:${parsed.sourceVersionId}:sha256:${parsed.sourceContentHash}`
  ) {
    return null;
  }
  return parsed;
}

function resolveCitedSegments(
  output: ChapterSummaryModelOutput,
  segments: readonly ChapterSummarySourceSegment[],
): readonly ChapterSummarySourceSegment[] {
  const allowed = new Map(segments.map((segment) => [segment.evidenceId, segment] as const));
  const allIds = [
    ...output.evidenceIds,
    ...output.keyEvents.flatMap((entry) => entry.evidenceIds),
    ...output.continuityNotes.flatMap((entry) => entry.evidenceIds),
  ];
  const unique: ChapterSummarySourceSegment[] = [];
  const seen = new Set<string>();
  for (const id of allIds) {
    const segment = allowed.get(id);
    if (segment === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(segment);
  }
  if (unique.length === 0 || unique.length > 16) {
    throw new ChapterSummarySourceError(
      "CHAPTER_SUMMARY_EVIDENCE_INVALID",
      "摘要证据为空或超过安全上限。",
    );
  }
  return Object.freeze(unique);
}

function isActiveGeneratedChapterSummary(fact: StoryFact): boolean {
  const snapshot = fact.toSnapshot();
  return (
    snapshot.factType === "chapter_summary" &&
    snapshot.status === "temporary" &&
    snapshot.origin === "system" &&
    !snapshot.userConfirmed &&
    !snapshot.locked &&
    !snapshot.deprecated &&
    !snapshot.needsReview &&
    snapshot.branchId === null &&
    snapshot.source.reference.startsWith(`${REFERENCE_PREFIX}:`)
  );
}

function receipt(
  input: Readonly<{ projectId: string; chapterId: string; versionId: string }>,
  status: ChapterSummaryGenerationReceipt["status"],
  code: string,
  message: string,
): ChapterSummaryGenerationReceipt {
  return Object.freeze({
    status,
    code,
    message,
    projectId: input.projectId,
    chapterId: input.chapterId,
    versionId: input.versionId,
    fact: null,
    replacedFactIds: Object.freeze([]),
    invocation: null,
  });
}

function dashboardEntry(
  chapterId: string,
  chapterTitle: string,
  currentVersionId: string,
  state: ChapterSummaryDashboardEntry["state"],
  details: Partial<
    Omit<ChapterSummaryDashboardEntry, "chapterId" | "chapterTitle" | "currentVersionId" | "state">
  >,
): ChapterSummaryDashboardEntry {
  return Object.freeze({
    chapterId,
    chapterTitle,
    currentVersionId,
    state,
    message: details.message ?? "",
    summary: details.summary ?? null,
    sourceVersionId: details.sourceVersionId ?? null,
    sourceContentHash: details.sourceContentHash ?? null,
    providerKind: details.providerKind ?? null,
    modelId: details.modelId ?? null,
    invocationId: details.invocationId ?? null,
    factId: details.factId ?? null,
  });
}

function isValidStoredCitations(value: unknown, payload: Record<string, unknown>): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every(
      (citation) =>
        isRecord(citation) &&
        hasExactKeys(citation, ["evidenceId", "startOffset", "endOffset", "sourceLength"]) &&
        typeof citation.evidenceId === "string" &&
        Number.isSafeInteger(citation.startOffset) &&
        Number.isSafeInteger(citation.endOffset) &&
        Number.isSafeInteger(citation.sourceLength) &&
        typeof citation.startOffset === "number" &&
        typeof citation.endOffset === "number" &&
        typeof citation.sourceLength === "number" &&
        citation.startOffset >= 0 &&
        citation.endOffset > citation.startOffset &&
        citation.endOffset <= citation.sourceLength &&
        citation.evidenceId ===
          `chapter:${String(payload.sourceChapterId)}:version:${String(payload.sourceVersionId)}:sha256:${String(payload.sourceContentHash)}:utf16:${String(citation.startOffset)}-${String(citation.endOffset)}`,
    )
  );
}

function isValidStoredEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 6 &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ["text", "evidenceIds"]) &&
        typeof entry.text === "string" &&
        entry.text.length > 0 &&
        entry.text.length <= 160 &&
        Array.isArray(entry.evidenceIds) &&
        entry.evidenceIds.length > 0 &&
        entry.evidenceIds.length <= 3 &&
        entry.evidenceIds.every((id) => typeof id === "string"),
    )
  );
}

function isGeneration(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["task", "providerKind", "modelId", "invocationId"]) &&
    value.task === CHAPTER_SUMMARY_TASK &&
    isBoundedMetadata(value.providerKind, 200) &&
    isBoundedMetadata(value.modelId, 500) &&
    typeof value.invocationId === "string" &&
    parseStoryUuid(value.invocationId).ok
  );
}

function isBudget(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "strategy",
      "segmentCharacters",
      "maximumSegments",
      "sourceCharacters",
      "estimatedInputTokens",
      "tokenEstimate",
    ]) &&
    value.strategy === "bounded_utf16_segments" &&
    value.segmentCharacters === CHAPTER_SUMMARY_SEGMENT_CHARACTERS &&
    value.maximumSegments === CHAPTER_SUMMARY_MAXIMUM_SEGMENTS &&
    typeof value.sourceCharacters === "number" &&
    Number.isSafeInteger(value.sourceCharacters) &&
    value.sourceCharacters > 0 &&
    value.sourceCharacters <= CHAPTER_SUMMARY_MAXIMUM_SOURCE_CHARACTERS &&
    typeof value.estimatedInputTokens === "number" &&
    Number.isSafeInteger(value.estimatedInputTokens) &&
    value.estimatedInputTokens > 0 &&
    value.tokenEstimate === "model_hub_estimate_not_provider_tokenizer"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedMetadata(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function replacementKey(chapterId: string): string {
  return `chapter:${chapterId}`;
}

function preferenceKey(projectId: string): string {
  return `inkshadow.chapter-summary.auto-on-manual-save.v1:${projectId}`;
}

function continuousStoryStatePreferenceKey(projectId: string): string {
  return `inkshadow.continuous-story-state.auto-on-manual-save.v1:${projectId}`;
}

function errorCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return cause.code;
  }
  return "CHAPTER_SUMMARY_FAILED";
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
