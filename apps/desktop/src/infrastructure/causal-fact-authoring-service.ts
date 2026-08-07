import type { ChapterRepository, ChapterVersionRepository } from "@inkshadow/application";
import { parseUuidV7 } from "@inkshadow/domain";
import {
  CAUSAL_EVENT_RELATION_KINDS,
  type CausalEventRelationKind,
  type StoryFact,
  type StoryFactApplicationService,
} from "@inkshadow/story-core";

import {
  CAUSAL_EVENT_FACT_SCHEMA,
  CAUSAL_RELATION_FACT_SCHEMA,
  type CausalStoryFactProjectionReceipt,
  type CausalStoryFactProjector,
} from "./causal-story-fact-projector";

export interface CausalFactAuthoringServiceOptions {
  readonly chapters: ChapterRepository;
  readonly chapterVersions: ChapterVersionRepository;
  readonly facts: Pick<StoryFactApplicationService, "createFormalUserFact">;
  readonly projector: Pick<CausalStoryFactProjector, "rebuildProject">;
}

export interface CreateConfirmedCausalEventInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly evidenceExcerpt: string;
  readonly eventText: string;
  readonly resultText: string;
  readonly narrativeOrder: number;
  readonly narrativeLabel: string;
  readonly locationLabel: string;
  readonly participantCharacterIds?: readonly string[];
  readonly informedCharacterIds?: readonly string[];
  readonly actorId: string;
}

export interface CreateConfirmedCausalRelationInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly evidenceExcerpt: string;
  readonly fromEventId: string;
  readonly toEventId: string;
  readonly kind: CausalEventRelationKind;
  readonly actorId: string;
}

export interface CausalFactAuthoringReceipt {
  readonly fact: StoryFact;
  readonly projection: CausalStoryFactProjectionReceipt;
}

export type CausalFactAuthoringErrorCode =
  | "CAUSAL_AUTHORING_INPUT_INVALID"
  | "CAUSAL_AUTHORING_CHAPTER_NOT_FOUND"
  | "CAUSAL_AUTHORING_VERSION_NOT_FOUND"
  | "CAUSAL_AUTHORING_EVIDENCE_NOT_FOUND"
  | "CAUSAL_AUTHORING_EVIDENCE_AMBIGUOUS"
  | "CAUSAL_AUTHORING_SAVE_FAILED";

export class CausalFactAuthoringError extends Error {
  public constructor(
    readonly code: CausalFactAuthoringErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CausalFactAuthoringError";
  }
}

interface ExactChapterEvidence {
  readonly chapterId: string;
  readonly versionId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
  readonly excerpt: string;
  readonly reference: string;
}

const MAXIMUM_SHORT_TEXT = 2_000;
const MAXIMUM_EVIDENCE_TEXT = 20_000;
const MAXIMUM_PARTICIPANTS = 128;
const MAXIMUM_NARRATIVE_ORDER = 1_000_000_000_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Explicit authoring path for the authoritative causal graph. Every write is
 * user-confirmed and anchored to one exact immutable chapter-version span.
 */
export class CausalFactAuthoringService {
  public constructor(private readonly options: CausalFactAuthoringServiceOptions) {}

  public async createEvent(
    input: CreateConfirmedCausalEventInput,
  ): Promise<CausalFactAuthoringReceipt> {
    const eventText = boundedText(input.eventText, "请填写发生了什么。", MAXIMUM_SHORT_TEXT);
    const resultText = boundedText(input.resultText, "请填写事件造成的结果。", MAXIMUM_SHORT_TEXT);
    const narrativeLabel = boundedText(
      input.narrativeLabel,
      "请填写这个事件在故事中的时间。",
      MAXIMUM_SHORT_TEXT,
    );
    const locationLabel = boundedText(
      input.locationLabel,
      "请填写事件发生的地点。",
      MAXIMUM_SHORT_TEXT,
    );
    if (
      !Number.isSafeInteger(input.narrativeOrder) ||
      input.narrativeOrder < 0 ||
      input.narrativeOrder > MAXIMUM_NARRATIVE_ORDER
    ) {
      throw invalid("故事顺序必须是 0 以上的整数；可以用 10、20、30 为后续插入事件留出位置。");
    }
    const participantCharacterIds = referenceList(input.participantCharacterIds ?? [], "参与人物");
    const informedCharacterIds = referenceList(input.informedCharacterIds ?? [], "知情人物");
    const evidence = await this.resolveEvidence(
      input.projectId,
      input.chapterId,
      input.evidenceExcerpt,
    );
    const saved = await this.options.facts.createFormalUserFact({
      projectId: input.projectId,
      factType: "causal_event",
      contentText: eventText,
      structuredValue: {
        schemaVersion: CAUSAL_EVENT_FACT_SCHEMA,
        eventText,
        resultText,
        narrativeTime: { order: input.narrativeOrder, label: narrativeLabel },
        location: { locationId: stableLocationId(locationLabel), label: locationLabel },
        participantCharacterIds,
        informedCharacterIds,
        prerequisites: [],
        characterStateChanges: [],
        relationshipChanges: [],
        itemChanges: [],
        foreshadowProgress: [],
      },
      source: {
        kind: "chapter_span",
        reference: evidence.reference,
        chapterId: evidence.chapterId,
        versionId: evidence.versionId,
        startOffset: evidence.startOffset,
        endOffset: evidence.endOffset,
        sourceLength: evidence.sourceLength,
        excerpt: evidence.excerpt,
      },
      actorId: input.actorId,
      lock: false,
      humanConfirmed: true,
    });
    if (!saved.ok) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_SAVE_FAILED",
        "事件没有保存。请检查内容后重试；正文和已有设定没有改变。",
        saved.error.retryable,
      );
    }
    return Object.freeze({
      fact: saved.value,
      projection: await this.options.projector.rebuildProject(input.projectId, "main"),
    });
  }

  public async createRelation(
    input: CreateConfirmedCausalRelationInput,
  ): Promise<CausalFactAuthoringReceipt> {
    const fromEventId = reference(input.fromEventId, "起点事件");
    const toEventId = reference(input.toEventId, "终点事件");
    if (fromEventId === toEventId) {
      throw invalid("一条关系必须连接两个不同事件。只表示时间先后时请选择“发生在之前”。");
    }
    if (!CAUSAL_EVENT_RELATION_KINDS.includes(input.kind)) {
      throw invalid("请选择系统支持的事件关系。");
    }
    const evidence = await this.resolveEvidence(
      input.projectId,
      input.chapterId,
      input.evidenceExcerpt,
    );
    const saved = await this.options.facts.createFormalUserFact({
      projectId: input.projectId,
      factType: "causal_relation",
      contentText: `${fromEventId} ${relationLabel(input.kind)} ${toEventId}`,
      structuredValue: {
        schemaVersion: CAUSAL_RELATION_FACT_SCHEMA,
        fromEventId,
        toEventId,
        kind: input.kind,
      },
      source: {
        kind: "chapter_span",
        reference: evidence.reference,
        chapterId: evidence.chapterId,
        versionId: evidence.versionId,
        startOffset: evidence.startOffset,
        endOffset: evidence.endOffset,
        sourceLength: evidence.sourceLength,
        excerpt: evidence.excerpt,
      },
      actorId: input.actorId,
      lock: false,
      humanConfirmed: true,
    });
    if (!saved.ok) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_SAVE_FAILED",
        "事件关系没有保存。请检查内容后重试；正文和已有设定没有改变。",
        saved.error.retryable,
      );
    }
    return Object.freeze({
      fact: saved.value,
      projection: await this.options.projector.rebuildProject(input.projectId, "main"),
    });
  }

  private async resolveEvidence(
    projectIdValue: string,
    chapterIdValue: string,
    excerptValue: string,
  ): Promise<ExactChapterEvidence> {
    const projectId = parseUuidV7(projectIdValue);
    const chapterId = parseUuidV7(chapterIdValue);
    if (!projectId.ok || !chapterId.ok) {
      throw invalid("项目或章节标识无效，请返回作品后重新打开本页。");
    }
    const excerpt = boundedText(
      excerptValue,
      "请粘贴能直接证明这条事件或关系的原文。",
      MAXIMUM_EVIDENCE_TEXT,
    );
    const chapterResult = await this.options.chapters.findById(chapterId.value);
    if (!chapterResult.ok) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_CHAPTER_NOT_FOUND",
        "暂时无法读取所选章节，请稍后重试。",
        chapterResult.error.retryable,
      );
    }
    const chapter = chapterResult.value;
    if (chapter === null || String(chapter.projectId) !== String(projectId.value)) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_CHAPTER_NOT_FOUND",
        "所选章节不属于当前作品，请重新选择。",
      );
    }
    const versionResult = await this.options.chapterVersions.findVersionById(
      chapter.currentVersionId,
    );
    if (!versionResult.ok) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_VERSION_NOT_FOUND",
        "暂时无法读取章节的稳定版本，请先保存正文后重试。",
        versionResult.error.retryable,
      );
    }
    const version = versionResult.value?.toSnapshot() ?? null;
    if (
      version === null ||
      String(version.projectId) !== String(projectId.value) ||
      String(version.chapterId) !== String(chapterId.value)
    ) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_VERSION_NOT_FOUND",
        "章节的稳定版本已变化，请先保存正文并重新选择证据。",
      );
    }
    const first = version.content.indexOf(excerpt);
    if (first < 0) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_EVIDENCE_NOT_FOUND",
        "这段文字不在当前已保存正文中。请从章节原文复制一段完整证据后重试。",
      );
    }
    if (version.content.includes(excerpt, first + excerpt.length)) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_EVIDENCE_AMBIGUOUS",
        "这段文字在本章出现了多次。请多复制前后几句话，让证据能够唯一定位。",
      );
    }
    const endOffset = first + excerpt.length;
    return Object.freeze({
      chapterId: String(chapterId.value),
      versionId: String(version.id),
      startOffset: first,
      endOffset,
      sourceLength: version.content.length,
      excerpt,
      reference: `chapter:${String(chapterId.value)}:version:${String(version.id)}:utf16:${String(first)}-${String(endOffset)}`,
    });
  }
}

function boundedText(value: string, missingMessage: string, maximum: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw invalid(
      normalized.length === 0 ? missingMessage : `内容不能超过 ${String(maximum)} 个字符。`,
    );
  }
  return normalized;
}

function reference(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    /[\u0000-\u0020\u007f]/u.test(normalized)
  ) {
    throw invalid(`${label}无效，请重新选择。`);
  }
  return normalized;
}

function referenceList(values: readonly string[], label: string): readonly string[] {
  if (values.length > MAXIMUM_PARTICIPANTS) {
    throw invalid(`${label}数量过多，请只保留与事件直接相关的人物。`);
  }
  const normalized = values.map((value) => reference(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw invalid(`${label}中存在重复项。`);
  }
  return Object.freeze(normalized);
}

function stableLocationId(label: string): string {
  let hash = 2_166_136_261;
  for (const character of label.normalize("NFKC").toLocaleLowerCase("zh-CN")) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `location-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function relationLabel(kind: CausalEventRelationKind): string {
  const labels: Readonly<Record<CausalEventRelationKind, string>> = {
    causes: "导致",
    depends_on: "使其依赖",
    prevents: "阻止",
    reveals: "揭示",
    misleads: "误导",
    before: "发生在之前",
    changes_state: "改变状态并影响",
    gains_information: "使其获得信息并影响",
    loses_item: "使其失去物品并影响",
  };
  return labels[kind];
}

function invalid(message: string): CausalFactAuthoringError {
  return new CausalFactAuthoringError("CAUSAL_AUTHORING_INPUT_INVALID", message);
}
