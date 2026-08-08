import type { ChapterRepository, ChapterVersionRepository } from "@inkshadow/application";
import { parseUuidV7 } from "@inkshadow/domain";
import {
  CAUSAL_EVENT_RELATION_KINDS,
  MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES,
  type CausalEventRelationKind,
  type CausalForeshadowChangeKind,
  type CausalItemChangeKind,
  type CausalPrerequisiteKind,
  type StoryFact,
  type StoryFactApplicationService,
  type StoryFactSnapshot,
  type StoryFactStore,
  parseUuidV7 as parseStoryUuidV7,
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
  readonly facts: Pick<StoryFactApplicationService, "createFormalUserFactWithAuthorityFence">;
  readonly factStore: Pick<StoryFactStore, "listByProjectId">;
  readonly projector: Pick<CausalStoryFactProjector, "rebuildProject">;
}

export interface ConfirmedCausalCharacter {
  readonly id: string;
  readonly name: string;
}

export type CausalKnowledgeGainInput = Readonly<{
  readonly characterId: string;
  /** Friendly category shown to ordinary users, for example “真实身份”. */
  readonly knowledgeLabel?: string;
  /** Friendly information statement, for example “米拉是真正的继承人”. */
  readonly informationText?: string;
  /** Compatibility-only stable reference used by governed internal callers. */
  readonly attributeKey?: string;
  /** Compatibility-only stable reference used by governed internal callers. */
  readonly informationId?: string;
}>;

export type CausalPrerequisiteInput = Readonly<{
  readonly kind: CausalPrerequisiteKind;
  /** Required for an event prerequisite; optional governed key for state/rule. */
  readonly referenceId?: string;
  /** Ordinary-user label used to derive a stable state/rule reference. */
  readonly referenceLabel?: string;
  readonly description: string;
}>;

export type CausalCharacterStateChangeInput = Readonly<{
  readonly characterId: string;
  readonly attributeKey?: string;
  readonly attributeLabel?: string;
  readonly beforeValue: string;
  readonly afterValue: string;
}>;

export type CausalRelationshipChangeInput = Readonly<{
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly relationshipKey?: string;
  readonly relationshipLabel?: string;
  readonly beforeValue: string;
  readonly afterValue: string;
}>;

export type CausalItemChangeInput = Readonly<{
  readonly itemId?: string;
  readonly itemLabel?: string;
  readonly kind: CausalItemChangeKind;
  readonly fromCharacterId?: string | null;
  readonly toCharacterId?: string | null;
}>;

export type CausalForeshadowProgressInput = Readonly<{
  readonly foreshadowId?: string;
  readonly foreshadowLabel?: string;
  readonly kind: CausalForeshadowChangeKind;
  readonly description: string;
}>;

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
  /**
   * Explicit knowledge granted by this event. Merely listing a character as
   * informed never authorizes an arbitrary POV knowledge edge.
   */
  readonly knowledgeGains?: readonly CausalKnowledgeGainInput[];
  readonly prerequisites?: readonly CausalPrerequisiteInput[];
  readonly characterStateChanges?: readonly CausalCharacterStateChangeInput[];
  readonly relationshipChanges?: readonly CausalRelationshipChangeInput[];
  readonly itemChanges?: readonly CausalItemChangeInput[];
  readonly foreshadowProgress?: readonly CausalForeshadowProgressInput[];
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
  /** `existing` means an identical prior submission was recovered instead of duplicated. */
  readonly persistence: "created" | "existing";
  /** Null means the authoritative fact is saved but the rebuild must be retried. */
  readonly projection: CausalStoryFactProjectionReceipt | null;
  readonly projectionError: string | null;
}

export type CausalFactAuthoringErrorCode =
  | "CAUSAL_AUTHORING_INPUT_INVALID"
  | "CAUSAL_AUTHORING_CHAPTER_NOT_FOUND"
  | "CAUSAL_AUTHORING_VERSION_NOT_FOUND"
  | "CAUSAL_AUTHORING_VERSION_CHANGED"
  | "CAUSAL_AUTHORING_EVIDENCE_NOT_FOUND"
  | "CAUSAL_AUTHORING_EVIDENCE_AMBIGUOUS"
  | "CAUSAL_AUTHORING_FACTS_UNAVAILABLE"
  | "CAUSAL_AUTHORING_CHARACTER_NOT_CONFIRMED"
  | "CAUSAL_AUTHORING_RELATION_ENDPOINT_INVALID"
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
const MAXIMUM_EVIDENCE_TEXT = 2_000;
export const MAXIMUM_CAUSAL_CHARACTER_SELECTIONS = 128;
export const MAXIMUM_CAUSAL_KNOWLEDGE_GAINS = 128;
export const MAXIMUM_CAUSAL_EVENT_CHANGES = 128;
export const MAXIMUM_CAUSAL_STRUCTURED_VALUE_BYTES = 16_384;
const MAXIMUM_NARRATIVE_ORDER = 1_000_000_000_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Explicit authoring path for the authoritative causal graph. Every write is
 * user-confirmed and anchored to one exact immutable chapter-version span.
 */
export class CausalFactAuthoringService {
  private readonly projectMutationQueues = new Map<string, Promise<void>>();

  public constructor(private readonly options: CausalFactAuthoringServiceOptions) {}

  public async listConfirmedCharacters(
    projectIdValue: string,
  ): Promise<readonly ConfirmedCausalCharacter[]> {
    const facts = await this.loadProjectFacts(projectIdValue);
    return confirmedCharacters(facts);
  }

  public async createEvent(
    input: CreateConfirmedCausalEventInput,
  ): Promise<CausalFactAuthoringReceipt> {
    return this.runProjectMutation(input.projectId, () => this.createEventOnce(input));
  }

  private async createEventOnce(
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
    const knowledgeGains = knowledgeGainList(input.knowledgeGains ?? []);
    const prerequisites = prerequisiteList(input.prerequisites ?? []);
    const characterStateChanges = characterStateChangeList(input.characterStateChanges ?? []);
    const relationshipChanges = relationshipChangeList(input.relationshipChanges ?? []);
    const itemChanges = itemChangeList(input.itemChanges ?? []);
    const foreshadowProgress = foreshadowProgressList(input.foreshadowProgress ?? []);
    if (knowledgeGains.some(({ characterId }) => !informedCharacterIds.includes(characterId))) {
      throw invalid("每条明确知识取得都必须绑定到本事件的知情人物。");
    }
    const referencedCharacterIds = Object.freeze([
      ...new Set([
        ...participantCharacterIds,
        ...informedCharacterIds,
        ...knowledgeGains.map(({ characterId }) => characterId),
        ...characterStateChanges.map(({ characterId }) => characterId),
        ...relationshipChanges.flatMap(({ fromCharacterId, toCharacterId }) => [
          fromCharacterId,
          toCharacterId,
        ]),
        ...itemChanges.flatMap(({ fromCharacterId, toCharacterId }) =>
          [fromCharacterId, toCharacterId].filter((value): value is string => value !== null),
        ),
      ]),
    ]);
    if (referencedCharacterIds.length > MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES) {
      throw invalid(
        `单个事件最多关联 ${String(MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES)} 个不同人物，请拆分事件后再保存。`,
      );
    }
    const evidence = await this.resolveEvidence(
      input.projectId,
      input.chapterId,
      input.evidenceExcerpt,
    );
    const projectFacts = await this.loadProjectFacts(input.projectId);
    assertConfirmedCharacters(projectFacts, referencedCharacterIds);
    const structuredValue = Object.freeze({
      schemaVersion: CAUSAL_EVENT_FACT_SCHEMA,
      eventText,
      resultText,
      narrativeTime: Object.freeze({ order: input.narrativeOrder, label: narrativeLabel }),
      location: Object.freeze({
        locationId: stableLocationId(locationLabel),
        label: locationLabel,
      }),
      participantCharacterIds,
      informedCharacterIds,
      knowledgeGains,
      prerequisites,
      characterStateChanges,
      relationshipChanges,
      itemChanges,
      foreshadowProgress,
    });
    if (
      new TextEncoder().encode(JSON.stringify(structuredValue)).byteLength >
      MAXIMUM_CAUSAL_STRUCTURED_VALUE_BYTES
    ) {
      throw invalid(
        "这次事件关联的内容总量过多。请减少参与人物或明确知识条目，或者把它拆成两个事件后再保存。",
      );
    }
    const saved = await this.options.facts.createFormalUserFactWithAuthorityFence(
      {
        projectId: input.projectId,
        factType: "causal_event",
        contentText: eventText,
        structuredValue,
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
      },
      {
        chapterId: evidence.chapterId,
        expectedCurrentVersionId: evidence.versionId,
        requiredCausalEventIds: Object.freeze(
          prerequisites
            .filter(({ kind }) => kind === "event")
            .map(({ referenceId }) => referenceId),
        ),
        requiredCharacterIds: referencedCharacterIds,
      },
    );
    if (!saved.ok) {
      if (saved.error.code === "STORY_FACT_SOURCE_FENCE_FAILED") {
        throw versionChanged();
      }
      if (saved.error.code === "STORY_FACT_CHARACTER_AUTHORITY_INVALID") {
        throw characterNotConfirmed();
      }
      if (saved.error.code === "STORY_FACT_RELATION_ENDPOINT_INVALID") {
        throw new CausalFactAuthoringError(
          "CAUSAL_AUTHORING_RELATION_ENDPOINT_INVALID",
          "所选前置事件已变化、失效或不属于当前作品，请重新选择。",
        );
      }
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_SAVE_FAILED",
        "事件没有保存。请检查内容后重试；正文和已有设定没有改变。",
        saved.error.retryable,
      );
    }
    return this.finishWithProjection(
      saved.value.fact,
      input.projectId,
      saved.value.created ? "created" : "existing",
    );
  }

  public async createRelation(
    input: CreateConfirmedCausalRelationInput,
  ): Promise<CausalFactAuthoringReceipt> {
    return this.runProjectMutation(input.projectId, () => this.createRelationOnce(input));
  }

  private async createRelationOnce(
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
    let currentProjection: CausalStoryFactProjectionReceipt;
    try {
      currentProjection = await this.options.projector.rebuildProject(input.projectId, "main");
    } catch {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_FACTS_UNAVAILABLE",
        "暂时无法核对事件关系的两个端点，因此没有保存。请稍后重试。",
        true,
      );
    }
    if (
      !currentProjection.graph.events.some(({ id }) => id === fromEventId) ||
      !currentProjection.graph.events.some(({ id }) => id === toEventId)
    ) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_RELATION_ENDPOINT_INVALID",
        "所选事件已变化、失效或不属于当前作品，请重新选择关系两端。",
      );
    }
    const contentText = `${fromEventId} ${relationLabel(input.kind)} ${toEventId}`;
    const structuredValue = Object.freeze({
      schemaVersion: CAUSAL_RELATION_FACT_SCHEMA,
      fromEventId,
      toEventId,
      kind: input.kind,
    });
    const saved = await this.options.facts.createFormalUserFactWithAuthorityFence(
      {
        projectId: input.projectId,
        factType: "causal_relation",
        contentText,
        structuredValue,
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
      },
      {
        chapterId: evidence.chapterId,
        expectedCurrentVersionId: evidence.versionId,
        requiredCausalEventIds: Object.freeze([fromEventId, toEventId]),
      },
    );
    if (!saved.ok) {
      if (saved.error.code === "STORY_FACT_SOURCE_FENCE_FAILED") {
        throw versionChanged();
      }
      if (saved.error.code === "STORY_FACT_RELATION_ENDPOINT_INVALID") {
        throw new CausalFactAuthoringError(
          "CAUSAL_AUTHORING_RELATION_ENDPOINT_INVALID",
          "所选事件在保存前已经变化、失效或出现冲突，请重新选择关系两端。",
        );
      }
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_SAVE_FAILED",
        "事件关系没有保存。请检查内容后重试；正文和已有设定没有改变。",
        saved.error.retryable,
      );
    }
    return this.finishWithProjection(
      saved.value.fact,
      input.projectId,
      saved.value.created ? "created" : "existing",
    );
  }

  private async finishWithProjection(
    fact: StoryFact,
    projectId: string,
    persistence: CausalFactAuthoringReceipt["persistence"],
  ): Promise<CausalFactAuthoringReceipt> {
    try {
      return Object.freeze({
        fact,
        persistence,
        projection: await this.options.projector.rebuildProject(projectId, "main"),
        projectionError: null,
      });
    } catch {
      return Object.freeze({
        fact,
        persistence,
        projection: null,
        projectionError: "正式设定已安全保存，但故事关联暂时未刷新。请使用“重新整理”恢复显示。",
      });
    }
  }

  private async loadProjectFacts(projectIdValue: string): Promise<readonly StoryFact[]> {
    const projectId = parseStoryUuidV7(projectIdValue);
    if (!projectId.ok) {
      throw invalid("当前作品标识无效，请返回作品库后重新打开。");
    }
    const loaded = await this.options.factStore.listByProjectId(projectId.value);
    if (!loaded.ok) {
      throw new CausalFactAuthoringError(
        "CAUSAL_AUTHORING_FACTS_UNAVAILABLE",
        "暂时无法核对已确认的故事设定，因此没有保存。请稍后重试。",
        loaded.error.retryable,
      );
    }
    return loaded.value;
  }

  private async runProjectMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectMutationQueues.get(projectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.projectMutationQueues.set(projectId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.projectMutationQueues.get(projectId) === tail) {
        this.projectMutationQueues.delete(projectId);
      }
    }
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
  if (values.length > MAXIMUM_CAUSAL_CHARACTER_SELECTIONS) {
    throw invalid(`${label}数量过多，请只保留与事件直接相关的人物。`);
  }
  const normalized = values.map((value) => reference(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw invalid(`${label}中存在重复项。`);
  }
  return Object.freeze(normalized);
}

function knowledgeGainList(values: readonly CausalKnowledgeGainInput[]): readonly Readonly<{
  readonly characterId: string;
  readonly attributeKey: string;
  readonly informationId: string;
}>[] {
  if (values.length > MAXIMUM_CAUSAL_KNOWLEDGE_GAINS) {
    throw invalid("事件中的明确知识取得数量过多。");
  }
  const normalized = values.map((value) => {
    const hasFriendlyValues =
      value.knowledgeLabel !== undefined || value.informationText !== undefined;
    if (hasFriendlyValues) {
      const knowledgeLabel = boundedText(value.knowledgeLabel ?? "", "请填写这条知识的类别。", 200);
      const informationText = boundedText(
        value.informationText ?? "",
        "请填写人物得知的具体内容。",
        1_000,
      );
      return Object.freeze({
        characterId: stableReference(value.characterId, "知识取得人物"),
        attributeKey: stableGeneratedReference("knowledge", knowledgeLabel),
        informationId: stableGeneratedReference(
          "information",
          `${knowledgeLabel}\u0000${informationText}`,
        ),
      });
    }
    return Object.freeze({
      characterId: stableReference(value.characterId, "知识取得人物"),
      attributeKey: stableReference(value.attributeKey ?? "", "知识属性键"),
      informationId: stableReference(value.informationId ?? "", "知识信息标识"),
    });
  });
  const signatures = normalized.map(
    ({ characterId, attributeKey, informationId }) =>
      `${characterId}\u0000${attributeKey}\u0000${informationId}`,
  );
  if (new Set(signatures).size !== signatures.length) {
    throw invalid("同一人物的同一条知识取得不能重复声明。");
  }
  return Object.freeze(normalized);
}

function prerequisiteList(values: readonly CausalPrerequisiteInput[]): readonly Readonly<{
  readonly kind: CausalPrerequisiteKind;
  readonly referenceId: string;
  readonly referenceLabel?: string;
  readonly description: string;
}>[] {
  assertChangeCount(values, "前置条件");
  const normalized = values.map((value) => {
    if (!(["event", "state", "rule"] as const).includes(value.kind)) {
      throw invalid("前置条件类型无效，请重新选择。");
    }
    const description = boundedText(value.description, "请说明这个前置条件。", 1_000);
    if (value.kind === "event") {
      const referenceId = stableReference(value.referenceId ?? "", "前置事件");
      const referenceLabel = optionalBoundedText(value.referenceLabel, 200);
      return Object.freeze({
        kind: value.kind,
        referenceId,
        ...(referenceLabel === null ? {} : { referenceLabel }),
        description,
      });
    }
    const resolved = friendlyReference(
      value.referenceId,
      value.referenceLabel,
      value.kind === "state" ? "state" : "rule",
      value.kind === "state" ? "状态名称" : "规则名称",
    );
    return Object.freeze({
      kind: value.kind,
      referenceId: resolved.id,
      ...(resolved.label === null ? {} : { referenceLabel: resolved.label }),
      description,
    });
  });
  assertUnique(
    normalized.map(({ kind, referenceId }) => `${kind}\u0000${referenceId}`),
    "同一个前置条件不能重复添加。",
  );
  return Object.freeze(normalized);
}

function characterStateChangeList(
  values: readonly CausalCharacterStateChangeInput[],
): readonly Readonly<{
  readonly characterId: string;
  readonly attributeKey: string;
  readonly attributeLabel?: string;
  readonly beforeValue: string;
  readonly afterValue: string;
}>[] {
  assertChangeCount(values, "人物状态变化");
  const normalized = values.map((value) => {
    const attribute = friendlyReference(
      value.attributeKey,
      value.attributeLabel,
      "state",
      "人物状态名称",
    );
    const beforeValue = boundedText(value.beforeValue, "请填写变化前的人物状态。", 1_000);
    const afterValue = boundedText(value.afterValue, "请填写变化后的人物状态。", 1_000);
    if (beforeValue === afterValue) {
      throw invalid("人物状态变化前后不能相同。");
    }
    return Object.freeze({
      characterId: stableReference(value.characterId, "状态变化人物"),
      attributeKey: attribute.id,
      ...(attribute.label === null ? {} : { attributeLabel: attribute.label }),
      beforeValue,
      afterValue,
    });
  });
  assertUnique(
    normalized.map(({ characterId, attributeKey }) => `${characterId}\u0000${attributeKey}`),
    "同一事件中同一人物的同一状态只能声明一次变化。",
  );
  return Object.freeze(normalized);
}

function relationshipChangeList(
  values: readonly CausalRelationshipChangeInput[],
): readonly Readonly<{
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly relationshipKey: string;
  readonly relationshipLabel?: string;
  readonly beforeValue: string;
  readonly afterValue: string;
}>[] {
  assertChangeCount(values, "人物关系变化");
  const normalized = values.map((value) => {
    const fromCharacterId = stableReference(value.fromCharacterId, "关系起点人物");
    const toCharacterId = stableReference(value.toCharacterId, "关系终点人物");
    if (fromCharacterId === toCharacterId) {
      throw invalid("人物关系变化必须连接两个不同人物。");
    }
    const relationship = friendlyReference(
      value.relationshipKey,
      value.relationshipLabel,
      "relationship",
      "关系名称",
    );
    const beforeValue = boundedText(value.beforeValue, "请填写变化前的关系。", 1_000);
    const afterValue = boundedText(value.afterValue, "请填写变化后的关系。", 1_000);
    if (beforeValue === afterValue) {
      throw invalid("人物关系变化前后不能相同。");
    }
    return Object.freeze({
      fromCharacterId,
      toCharacterId,
      relationshipKey: relationship.id,
      ...(relationship.label === null ? {} : { relationshipLabel: relationship.label }),
      beforeValue,
      afterValue,
    });
  });
  assertUnique(
    normalized.map(
      ({ fromCharacterId, relationshipKey, toCharacterId }) =>
        `${fromCharacterId}\u0000${toCharacterId}\u0000${relationshipKey}`,
    ),
    "同一事件中的同一人物关系只能声明一次变化。",
  );
  return Object.freeze(normalized);
}

function itemChangeList(values: readonly CausalItemChangeInput[]): readonly Readonly<{
  readonly itemId: string;
  readonly itemLabel?: string;
  readonly kind: CausalItemChangeKind;
  readonly fromCharacterId: string | null;
  readonly toCharacterId: string | null;
}>[] {
  assertChangeCount(values, "物品变化");
  const normalized = values.map((value) => {
    if (
      !(["acquired", "lost", "transferred", "created", "destroyed"] as const).includes(value.kind)
    ) {
      throw invalid("物品变化类型无效，请重新选择。");
    }
    const item = friendlyReference(value.itemId, value.itemLabel, "item", "物品名称");
    const fromCharacterId = optionalStableReference(value.fromCharacterId, "物品原持有人");
    const toCharacterId = optionalStableReference(value.toCharacterId, "物品新持有人");
    if (value.kind === "acquired" && toCharacterId === null) {
      throw invalid("取得物品时必须选择新持有人。");
    }
    if (value.kind === "lost" && fromCharacterId === null) {
      throw invalid("失去物品时必须选择原持有人。");
    }
    if (
      value.kind === "transferred" &&
      (fromCharacterId === null || toCharacterId === null || fromCharacterId === toCharacterId)
    ) {
      throw invalid("转移物品时必须选择两个不同的原持有人和新持有人。");
    }
    if (value.kind === "created" && fromCharacterId !== null) {
      throw invalid("新出现的物品不能同时填写原持有人。");
    }
    if (value.kind === "destroyed" && toCharacterId !== null) {
      throw invalid("被毁或消失的物品不能同时填写新持有人。");
    }
    return Object.freeze({
      itemId: item.id,
      ...(item.label === null ? {} : { itemLabel: item.label }),
      kind: value.kind,
      fromCharacterId,
      toCharacterId,
    });
  });
  assertUnique(
    normalized.map(({ itemId, kind }) => `${itemId}\u0000${kind}`),
    "同一事件中的同一物品变化不能重复添加。",
  );
  return Object.freeze(normalized);
}

function foreshadowProgressList(
  values: readonly CausalForeshadowProgressInput[],
): readonly Readonly<{
  readonly foreshadowId: string;
  readonly foreshadowLabel?: string;
  readonly kind: CausalForeshadowChangeKind;
  readonly description: string;
}>[] {
  assertChangeCount(values, "伏笔推进");
  const normalized = values.map((value) => {
    if (
      !(["planted", "advanced", "revealed", "resolved", "misdirected"] as const).includes(
        value.kind,
      )
    ) {
      throw invalid("伏笔推进类型无效，请重新选择。");
    }
    const foreshadow = friendlyReference(
      value.foreshadowId,
      value.foreshadowLabel,
      "foreshadow",
      "伏笔名称",
    );
    return Object.freeze({
      foreshadowId: foreshadow.id,
      ...(foreshadow.label === null ? {} : { foreshadowLabel: foreshadow.label }),
      kind: value.kind,
      description: boundedText(value.description, "请说明这次伏笔推进。", 1_000),
    });
  });
  assertUnique(
    normalized.map(({ foreshadowId, kind }) => `${foreshadowId}\u0000${kind}`),
    "同一事件中的同一种伏笔推进不能重复添加。",
  );
  return Object.freeze(normalized);
}

function assertChangeCount(values: readonly unknown[], label: string): void {
  if (values.length > MAXIMUM_CAUSAL_EVENT_CHANGES) {
    throw invalid(`${label}数量过多，请拆分事件后再保存。`);
  }
}

function assertUnique(signatures: readonly string[], message: string): void {
  if (new Set(signatures).size !== signatures.length) {
    throw invalid(message);
  }
}

function optionalBoundedText(value: string | undefined, maximum: number): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  return boundedText(value, "", maximum);
}

function optionalStableReference(value: string | null | undefined, label: string): string | null {
  if (value === undefined || value === null || value.trim().length === 0) return null;
  return stableReference(value, label);
}

function friendlyReference(
  stableValue: string | undefined,
  friendlyValue: string | undefined,
  prefix: "state" | "rule" | "relationship" | "item" | "foreshadow",
  label: string,
): Readonly<{ readonly id: string; readonly label: string | null }> {
  const friendly = optionalBoundedText(friendlyValue, 200);
  if (friendly !== null) {
    return Object.freeze({ id: stableGeneratedReference(prefix, friendly), label: friendly });
  }
  return Object.freeze({ id: stableReference(stableValue ?? "", label), label: null });
}

function confirmedCharacters(facts: readonly StoryFact[]): readonly ConfirmedCausalCharacter[] {
  const characters = new Map<string, string>();
  for (const fact of facts) {
    const snapshot = fact.toSnapshot();
    if (snapshot.factType !== "character_identity" || !isActiveFormalMainFact(snapshot)) continue;
    const structured = asStoryRecord(snapshot.structuredValue);
    const subject = asStoryRecord(structured?.subject);
    if (subject?.kind !== "character") continue;
    const id = typeof subject.entityKey === "string" ? subject.entityKey : null;
    const name = typeof subject.canonicalName === "string" ? subject.canonicalName.trim() : "";
    if (id === null || !SAFE_STABLE_REFERENCE.test(id) || name.length === 0 || name.length > 200) {
      continue;
    }
    characters.set(id, name);
  }
  return Object.freeze(
    [...characters.entries()]
      .map(([id, name]) => Object.freeze({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
  );
}

function assertConfirmedCharacters(facts: readonly StoryFact[], values: readonly string[]): void {
  const confirmed = new Set(confirmedCharacters(facts).map(({ id }) => id));
  const missing = [...new Set(values)].filter((id) => !confirmed.has(id));
  if (missing.length > 0) {
    throw characterNotConfirmed();
  }
}

function characterNotConfirmed(): CausalFactAuthoringError {
  return new CausalFactAuthoringError(
    "CAUSAL_AUTHORING_CHARACTER_NOT_CONFIRMED",
    "所选人物尚未成为当前作品中已确认的正式人物，请先到“设定 → 人物”确认后再保存。",
  );
}

function isActiveFormalMainFact(snapshot: StoryFactSnapshot): boolean {
  return (
    snapshot.status === "formal" &&
    snapshot.userConfirmed &&
    !snapshot.needsReview &&
    !snapshot.deprecated &&
    snapshot.invalidatedAt === null &&
    snapshot.branchId === null
  );
}

function asStoryRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

const SAFE_STABLE_REFERENCE = /^[a-z0-9][a-z0-9:._-]{0,511}$/iu;

function stableReference(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_STABLE_REFERENCE.test(normalized)) {
    throw invalid(`${label}只能使用字母、数字、冒号、点、下划线和短横线，且不能包含空格。`);
  }
  return normalized;
}

function stableGeneratedReference(
  prefix: "knowledge" | "information" | "state" | "rule" | "relationship" | "item" | "foreshadow",
  value: string,
): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  const compactPrefixes = {
    knowledge: "k",
    information: "i",
    state: "s",
    rule: "r",
    relationship: "rel",
    item: "item",
    foreshadow: "f",
  } as const;
  const compactPrefix = compactPrefixes[prefix];
  return `${compactPrefix}-${stableHash(normalized, 2_166_136_261)}${stableHash(normalized, 2_654_435_761)}`;
}

function stableHash(value: string, seed: number): string {
  let hash = seed;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

function versionChanged(): CausalFactAuthoringError {
  return new CausalFactAuthoringError(
    "CAUSAL_AUTHORING_VERSION_CHANGED",
    "核对期间正文已经保存了新版本。为了避免引用旧内容，本次没有保存；请重新复制当前原文证据。",
  );
}
