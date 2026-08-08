import type { Clock, UuidV7Generator } from "@inkshadow/domain";
import {
  StoryFact,
  type StoryCoreError,
  parseUuidV7,
  type CausalEventNode,
  type CausalEventRelation,
  type StoryFactStore,
  type UuidV7 as StoryUuidV7,
} from "@inkshadow/story-core";

import type { CausalEventGraphStore } from "./causal-event-graph-store";

export const CAUSAL_WHAT_IF_SCHEMA = "inkshadow.causal-what-if.v1";
export const CAUSAL_WHAT_IF_LOCKED_RULE_TOKEN_BUDGET = 8_000;
export const CAUSAL_WHAT_IF_MAXIMUM_LOCKED_RULES = 100;

export interface CausalWhatIfModelInput {
  readonly projectId: string;
  readonly hypothesis: string;
  readonly sourceEvent: CausalWhatIfEventContext;
  readonly impactedEvents: readonly CausalWhatIfEventContext[];
  readonly relations: readonly CausalWhatIfRelationContext[];
  readonly lockedRules: readonly Readonly<{ id: string; content: string }>[];
}

export interface CausalWhatIfEventContext {
  readonly id: string;
  readonly event: string;
  readonly result: string;
  readonly narrativeTime: string;
  readonly location: string;
  readonly participants: readonly string[];
  readonly evidenceReference: string;
}

export interface CausalWhatIfRelationContext {
  readonly id: string;
  readonly fromEventId: string;
  readonly toEventId: string;
  readonly kind: string;
  readonly evidenceReference: string;
}

export interface CausalWhatIfModelEffect {
  readonly eventId: string;
  readonly summary: string;
  readonly confidence: number;
}

export interface CausalWhatIfModelOutput {
  readonly alternateDirection: string;
  readonly effects: readonly CausalWhatIfModelEffect[];
}

export interface CausalWhatIfModelPort {
  simulate(input: CausalWhatIfModelInput): Promise<CausalWhatIfModelOutput>;
}

export type CausalWhatIfLockedRuleOmissionReason =
  "empty_rule_content" | "rule_count_limit" | "token_budget_exceeded";

export interface CausalWhatIfLockedRuleCompilationReceipt {
  readonly tokenBudget: number;
  readonly maximumRuleCount: number;
  readonly candidateCount: number;
  readonly estimatedIncludedTokens: number;
  readonly included: readonly Readonly<{
    id: string;
    revision: number;
    contentHash: string;
    estimatedTokens: number;
  }>[];
  readonly omitted: readonly Readonly<{
    id: string;
    revision: number;
    contentHash: string;
    estimatedTokens: number;
    reason: CausalWhatIfLockedRuleOmissionReason;
  }>[];
}

export interface CausalWhatIfSimulationValue {
  readonly schema: typeof CAUSAL_WHAT_IF_SCHEMA;
  readonly hypothesis: string;
  readonly sourceEventId: string;
  readonly deterministicImpactEventIds: readonly string[];
  readonly alternateDirection: string;
  readonly effects: readonly CausalWhatIfModelEffect[];
  /** New records always carry this receipt; null is reserved for legacy v1 facts. */
  readonly lockedRuleCompilation: CausalWhatIfLockedRuleCompilationReceipt | null;
  /** Hash of the graph impact scope and locked-rule identities used for this result. */
  readonly authorityFingerprint: string | null;
  readonly sandbox: true;
  readonly changesFormalStory: false;
}

export interface CausalWhatIfSimulationReceipt {
  readonly branchId: string;
  readonly fact: StoryFact;
  readonly deterministicImpactCount: number;
  readonly truncated: boolean;
}

interface PreparedCausalWhatIfAuthority {
  readonly sourceEvent: CausalWhatIfEventContext;
  readonly impactedEvents: readonly CausalWhatIfEventContext[];
  readonly relations: readonly CausalWhatIfRelationContext[];
  readonly lockedRules: readonly Readonly<{ id: string; content: string }>[];
  readonly lockedRuleCompilation: CausalWhatIfLockedRuleCompilationReceipt;
  readonly impactedEventIds: readonly string[];
  readonly allowedEventIds: ReadonlySet<string>;
  readonly truncated: boolean;
  readonly fingerprint: string;
}

export class CausalWhatIfSimulationError extends Error {
  public constructor(
    readonly code:
      | "CAUSAL_WHAT_IF_INVALID"
      | "CAUSAL_WHAT_IF_SOURCE_MISSING"
      | "CAUSAL_WHAT_IF_LOCKED_RULE_BUDGET_EXCEEDED"
      | "CAUSAL_WHAT_IF_AUTHORITY_CHANGED"
      | "CAUSAL_WHAT_IF_MODEL_INVALID"
      | "CAUSAL_WHAT_IF_PERSISTENCE_FAILED",
    message: string,
    readonly retryable = false,
    readonly lockedRuleCompilation: CausalWhatIfLockedRuleCompilationReceipt | null = null,
  ) {
    super(message);
    this.name = "CausalWhatIfSimulationError";
  }
}

export class CausalWhatIfSimulationService {
  public constructor(
    private readonly graph: CausalEventGraphStore,
    private readonly facts: StoryFactStore,
    private readonly model: CausalWhatIfModelPort,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
  ) {}

  public async simulate(input: {
    readonly projectId: string;
    readonly sourceEventId: string;
    readonly hypothesis: string;
  }): Promise<CausalWhatIfSimulationReceipt> {
    const projectId = requireUuid(input.projectId, "项目编号无效。");
    const sourceEventId = requireUuid(input.sourceEventId, "事件编号无效。");
    const hypothesis = requireText(input.hypothesis, 2_000, "请描述想试演的改变。");
    const authority = await prepareCausalWhatIfAuthority(
      this.graph,
      this.facts,
      projectId,
      sourceEventId,
    );

    const output = validateModelOutput(
      await this.model.simulate({
        projectId,
        hypothesis,
        sourceEvent: authority.sourceEvent,
        impactedEvents: authority.impactedEvents,
        relations: authority.relations,
        lockedRules: authority.lockedRules,
      }),
      authority.allowedEventIds,
    );
    let currentAuthority: PreparedCausalWhatIfAuthority;
    try {
      currentAuthority = await prepareCausalWhatIfAuthority(
        this.graph,
        this.facts,
        projectId,
        sourceEventId,
      );
    } catch {
      throw authorityChanged();
    }
    if (currentAuthority.fingerprint !== authority.fingerprint) {
      throw authorityChanged();
    }
    const branchId = requireUuid(this.ids.next(), "无法创建试演分支编号。");
    const value: CausalWhatIfSimulationValue = Object.freeze({
      schema: CAUSAL_WHAT_IF_SCHEMA,
      hypothesis,
      sourceEventId,
      deterministicImpactEventIds: authority.impactedEventIds,
      alternateDirection: output.alternateDirection,
      effects: output.effects,
      lockedRuleCompilation: authority.lockedRuleCompilation,
      authorityFingerprint: authority.fingerprint,
      sandbox: true,
      changesFormalStory: false,
    });
    const created = StoryFact.create({
      id: this.ids.next(),
      projectId,
      factType: "what_if_simulation",
      contentText: output.alternateDirection,
      structuredValue: value,
      source: {
        kind: "system_derivation",
        reference: `causal-what-if:${branchId}:${sourceEventId}`,
      },
      branchId,
      confidence:
        output.effects.length === 0
          ? 0.5
          : Math.min(...output.effects.map(({ confidence }) => confidence)),
      status: "branch",
      origin: "system",
      needsReview: false,
      humanConfirmed: false,
      now: this.clock.now(),
    });
    if (!created.ok) {
      throw persistenceFailure(created.error);
    }
    const saved = await this.facts.create(created.value);
    if (!saved.ok) {
      throw persistenceFailure(saved.error);
    }
    return Object.freeze({
      branchId,
      fact: created.value,
      deterministicImpactCount: authority.impactedEventIds.length,
      truncated: authority.truncated,
    });
  }

  public async list(projectIdValue: string): Promise<readonly StoryFact[]> {
    const projectId = requireUuid(projectIdValue, "项目编号无效。");
    const result = await this.facts.listByProjectId(projectId, {
      status: "branch",
      factType: "what_if_simulation",
    });
    if (!result.ok) throw persistenceFailure(result.error);
    return result.value;
  }
}

export function readCausalWhatIfSimulationValue(fact: StoryFact): CausalWhatIfSimulationValue {
  const snapshot = fact.toSnapshot();
  const value = snapshot.structuredValue;
  if (!isRecord(value) || value.schema !== CAUSAL_WHAT_IF_SCHEMA) {
    throw new CausalWhatIfSimulationError(
      "CAUSAL_WHAT_IF_MODEL_INVALID",
      "这份剧情试演记录无法通过结构校验。",
    );
  }
  const hypothesis = requireText(value.hypothesis, 2_000, "剧情试演假设无效。");
  const sourceEventId = requireUuid(
    requireText(value.sourceEventId, 128, "剧情试演来源事件无效。"),
    "剧情试演来源事件无效。",
  );
  if (
    !Array.isArray(value.deterministicImpactEventIds) ||
    value.sandbox !== true ||
    value.changesFormalStory !== false ||
    !Array.isArray(value.effects)
  ) {
    throw new CausalWhatIfSimulationError(
      "CAUSAL_WHAT_IF_MODEL_INVALID",
      "这份剧情试演记录缺少安全边界信息。",
    );
  }
  const rawImpactIds: readonly unknown[] = value.deterministicImpactEventIds;
  const deterministicImpactEventIds = Object.freeze(
    rawImpactIds.map((id) =>
      requireUuid(requireText(id, 128, "受影响事件编号无效。"), "受影响事件编号无效。"),
    ),
  );
  const effects = validateModelOutput(
    {
      alternateDirection: requireText(value.alternateDirection, 10_000, "试演方向无效。"),
      effects: value.effects,
    },
    new Set([sourceEventId, ...deterministicImpactEventIds]),
  ).effects;
  const lockedRuleCompilation =
    value.lockedRuleCompilation === undefined
      ? null
      : validateLockedRuleCompilationReceipt(value.lockedRuleCompilation);
  const authorityFingerprint =
    value.authorityFingerprint === undefined
      ? null
      : requireSha256(value.authorityFingerprint, "剧情试演的权威状态指纹无效。");
  return Object.freeze({
    schema: CAUSAL_WHAT_IF_SCHEMA,
    hypothesis,
    sourceEventId,
    deterministicImpactEventIds,
    alternateDirection: requireText(value.alternateDirection, 10_000, "试演方向无效。"),
    effects,
    lockedRuleCompilation,
    authorityFingerprint,
    sandbox: true,
    changesFormalStory: false,
  });
}

async function prepareCausalWhatIfAuthority(
  graphStore: CausalEventGraphStore,
  facts: StoryFactStore,
  projectId: StoryUuidV7,
  sourceEventId: StoryUuidV7,
): Promise<PreparedCausalWhatIfAuthority> {
  const graph = await graphStore.loadProjectBranch(projectId, "main");
  const sourceEvent = graph.events.find(({ id }) => id === sourceEventId);
  if (sourceEvent === undefined) {
    throw new CausalWhatIfSimulationError(
      "CAUSAL_WHAT_IF_SOURCE_MISSING",
      "这个事件已经不在当前确认的故事关联中，请重新整理后再试演。",
    );
  }
  const impact = await graphStore.traceImpacts({
    projectId,
    branchId: "main",
    changedEventIds: [sourceEventId],
    maximumDepth: 32,
    maximumImpactedEvents: 128,
  });
  const impactedEventIds = Object.freeze(impact.impactedEvents.map(({ eventId }) => eventId));
  const allowedEventIds = new Set([sourceEventId, ...impactedEventIds]);
  const impactedEventNodes = impact.impactedEvents.flatMap(({ eventId }) => {
    const event = graph.events.find(({ id }) => id === eventId);
    return event === undefined ? [] : [event];
  });
  if (impactedEventNodes.length !== impactedEventIds.length) {
    throw new CausalWhatIfSimulationError(
      "CAUSAL_WHAT_IF_SOURCE_MISSING",
      "故事关联在影响范围整理期间发生了变化，请重试剧情试演。",
      true,
    );
  }
  const relevantRelations = graph.relations.filter(
    ({ fromEventId, toEventId }) =>
      allowedEventIds.has(fromEventId) && allowedEventIds.has(toEventId),
  );
  const factResult = await facts.listByProjectId(projectId);
  if (!factResult.ok) {
    throw persistenceFailure(factResult.error);
  }
  const lockedRuleCandidates = factResult.value
    .map((fact) => fact.toSnapshot())
    .filter(
      (fact) =>
        fact.status === "formal" &&
        fact.userConfirmed &&
        fact.locked &&
        !fact.deprecated &&
        fact.branchId === null,
    )
    .map((fact) => ({
      id: fact.id,
      revision: fact.revision,
      content:
        fact.contentText ??
        (fact.structuredValue === null ? "" : canonicalJson(fact.structuredValue)),
    }));
  const lockedRuleCompilation = await compileLockedRules(lockedRuleCandidates);
  if (lockedRuleCompilation.receipt.omitted.length > 0) {
    throw new CausalWhatIfSimulationError(
      "CAUSAL_WHAT_IF_LOCKED_RULE_BUDGET_EXCEEDED",
      "锁定规则无法全部放入这次剧情试演，模型尚未调用。请缩短或整理锁定规则后重试。",
      false,
      lockedRuleCompilation.receipt,
    );
  }
  const fingerprint = await sha256Hex(
    `inkshadow/causal-what-if-authority/v1\u0000${canonicalJson({
      projectId,
      sourceEventId,
      sourceEvent,
      impactedEventIds,
      impactedEvents: [...impactedEventNodes].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      relations: [...relevantRelations].sort((left, right) => left.id.localeCompare(right.id)),
      impact: {
        changedEventIds: impact.changedEventIds,
        impactedEvents: impact.impactedEvents,
        cycleEdgesSkipped: impact.cycleEdgesSkipped,
        truncated: impact.truncated,
        truncationReasons: impact.truncationReasons,
      },
      lockedRuleCompilation: lockedRuleCompilation.receipt,
    })}`,
  );
  return Object.freeze({
    sourceEvent: toEventContext(sourceEvent),
    impactedEvents: Object.freeze(impactedEventNodes.map(toEventContext)),
    relations: Object.freeze(relevantRelations.map(toRelationContext)),
    lockedRules: lockedRuleCompilation.rules,
    lockedRuleCompilation: lockedRuleCompilation.receipt,
    impactedEventIds,
    allowedEventIds,
    truncated: impact.truncated,
    fingerprint,
  });
}

async function compileLockedRules(
  candidates: readonly Readonly<{ id: string; revision: number; content: string }>[],
): Promise<
  Readonly<{
    rules: readonly Readonly<{ id: string; content: string }>[];
    receipt: CausalWhatIfLockedRuleCompilationReceipt;
  }>
> {
  const rules: Readonly<{ id: string; content: string }>[] = [];
  const included: {
    id: string;
    revision: number;
    contentHash: string;
    estimatedTokens: number;
  }[] = [];
  const omitted: {
    id: string;
    revision: number;
    contentHash: string;
    estimatedTokens: number;
    reason: CausalWhatIfLockedRuleOmissionReason;
  }[] = [];
  let estimatedIncludedTokens = 0;
  const sorted = await Promise.all(
    [...candidates]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(async (candidate) => {
        const content = candidate.content.trim();
        return Object.freeze({
          ...candidate,
          content,
          contentHash: await sha256Hex(content),
        });
      }),
  );
  for (const candidate of sorted) {
    const content = candidate.content;
    const estimatedTokens = estimateLockedRuleTokens(content);
    if (content.length === 0) {
      omitted.push({
        id: candidate.id,
        revision: candidate.revision,
        contentHash: candidate.contentHash,
        estimatedTokens: 0,
        reason: "empty_rule_content",
      });
      continue;
    }
    if (rules.length >= CAUSAL_WHAT_IF_MAXIMUM_LOCKED_RULES) {
      omitted.push({
        id: candidate.id,
        revision: candidate.revision,
        contentHash: candidate.contentHash,
        estimatedTokens,
        reason: "rule_count_limit",
      });
      continue;
    }
    if (estimatedIncludedTokens + estimatedTokens > CAUSAL_WHAT_IF_LOCKED_RULE_TOKEN_BUDGET) {
      omitted.push({
        id: candidate.id,
        revision: candidate.revision,
        contentHash: candidate.contentHash,
        estimatedTokens,
        reason: "token_budget_exceeded",
      });
      continue;
    }
    rules.push(Object.freeze({ id: candidate.id, content }));
    included.push({
      id: candidate.id,
      revision: candidate.revision,
      contentHash: candidate.contentHash,
      estimatedTokens,
    });
    estimatedIncludedTokens += estimatedTokens;
  }
  const receipt: CausalWhatIfLockedRuleCompilationReceipt = Object.freeze({
    tokenBudget: CAUSAL_WHAT_IF_LOCKED_RULE_TOKEN_BUDGET,
    maximumRuleCount: CAUSAL_WHAT_IF_MAXIMUM_LOCKED_RULES,
    candidateCount: sorted.length,
    estimatedIncludedTokens,
    included: Object.freeze(included.map((item) => Object.freeze(item))),
    omitted: Object.freeze(omitted.map((item) => Object.freeze(item))),
  });
  return Object.freeze({ rules: Object.freeze(rules), receipt });
}

function estimateLockedRuleTokens(content: string): number {
  // Deliberately conservative for CJK and punctuation-heavy prose.
  return content.length === 0 ? 0 : Math.max(1, Math.ceil(content.length * 1.5));
}

function validateLockedRuleCompilationReceipt(
  value: unknown,
): CausalWhatIfLockedRuleCompilationReceipt {
  if (
    !isRecord(value) ||
    value.tokenBudget !== CAUSAL_WHAT_IF_LOCKED_RULE_TOKEN_BUDGET ||
    value.maximumRuleCount !== CAUSAL_WHAT_IF_MAXIMUM_LOCKED_RULES ||
    typeof value.candidateCount !== "number" ||
    !Number.isInteger(value.candidateCount) ||
    value.candidateCount < 0 ||
    typeof value.estimatedIncludedTokens !== "number" ||
    !Number.isInteger(value.estimatedIncludedTokens) ||
    value.estimatedIncludedTokens < 0 ||
    !Array.isArray(value.included) ||
    !Array.isArray(value.omitted)
  ) {
    throw invalidModel("剧情试演的锁定规则编译记录无效。");
  }
  const included = value.included.map(validateIncludedLockedRuleReceiptItem);
  const omitted = value.omitted.map(validateOmittedLockedRuleReceiptItem);
  if (
    omitted.length > 0 ||
    included.length !== value.candidateCount ||
    included.length > CAUSAL_WHAT_IF_MAXIMUM_LOCKED_RULES ||
    included.reduce((sum, item) => sum + item.estimatedTokens, 0) !==
      value.estimatedIncludedTokens ||
    value.estimatedIncludedTokens > CAUSAL_WHAT_IF_LOCKED_RULE_TOKEN_BUDGET ||
    new Set(included.map(({ id }) => id)).size !== included.length
  ) {
    throw invalidModel("剧情试演没有完整记录全部锁定规则。");
  }
  return Object.freeze({
    tokenBudget: value.tokenBudget,
    maximumRuleCount: value.maximumRuleCount,
    candidateCount: value.candidateCount,
    estimatedIncludedTokens: value.estimatedIncludedTokens,
    included: Object.freeze(included),
    omitted: Object.freeze(omitted),
  });
}

function validateIncludedLockedRuleReceiptItem(
  value: unknown,
): Readonly<{ id: string; revision: number; contentHash: string; estimatedTokens: number }> {
  return validateLockedRuleReceiptItemBase(value);
}

function validateOmittedLockedRuleReceiptItem(value: unknown): Readonly<{
  id: string;
  revision: number;
  contentHash: string;
  estimatedTokens: number;
  reason: CausalWhatIfLockedRuleOmissionReason;
}> {
  const base = validateLockedRuleReceiptItemBase(value);
  if (!isRecord(value)) {
    throw invalidModel("剧情试演的锁定规则省略原因无效。");
  }
  const reasons: readonly CausalWhatIfLockedRuleOmissionReason[] = [
    "empty_rule_content",
    "rule_count_limit",
    "token_budget_exceeded",
  ];
  if (!reasons.includes(value.reason as CausalWhatIfLockedRuleOmissionReason)) {
    throw invalidModel("剧情试演的锁定规则省略原因无效。");
  }
  return Object.freeze({
    ...base,
    reason: value.reason as CausalWhatIfLockedRuleOmissionReason,
  });
}

function validateLockedRuleReceiptItemBase(
  value: unknown,
): Readonly<{ id: string; revision: number; contentHash: string; estimatedTokens: number }> {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.contentHash) ||
    typeof value.estimatedTokens !== "number" ||
    !Number.isInteger(value.estimatedTokens) ||
    value.estimatedTokens < 0
  ) {
    throw invalidModel("剧情试演的锁定规则编译明细无效。");
  }
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    contentHash: value.contentHash,
    estimatedTokens: value.estimatedTokens,
  });
}

function toEventContext(event: CausalEventNode): CausalWhatIfEventContext {
  return Object.freeze({
    id: event.id,
    event: event.eventText,
    result: event.resultText,
    narrativeTime: event.narrativeTime.label,
    location: event.location.label,
    participants: Object.freeze([...event.participantCharacterIds]),
    evidenceReference: `${event.evidence.chapterVersionId}:${String(event.evidence.startOffset)}-${String(event.evidence.endOffset)}`,
  });
}

function toRelationContext(relation: CausalEventRelation): CausalWhatIfRelationContext {
  return Object.freeze({
    id: relation.id,
    fromEventId: relation.fromEventId,
    toEventId: relation.toEventId,
    kind: relation.kind,
    evidenceReference: `${relation.evidence.chapterVersionId}:${String(relation.evidence.startOffset)}-${String(relation.evidence.endOffset)}`,
  });
}

function validateModelOutput(
  value: unknown,
  allowedEventIds: ReadonlySet<string>,
): CausalWhatIfModelOutput {
  if (!isRecord(value)) {
    throw invalidModel("模型没有返回可验证的剧情试演结果。");
  }
  const alternateDirection = requireText(
    value.alternateDirection,
    10_000,
    "模型没有返回可用的替代剧情方向。",
  );
  if (!Array.isArray(value.effects) || value.effects.length > 128) {
    throw invalidModel("模型返回的影响列表超出安全范围。");
  }
  const seen = new Set<string>();
  const rawEffects: readonly unknown[] = value.effects;
  const effects = rawEffects.map((effectValue) => {
    if (!isRecord(effectValue)) {
      throw invalidModel("模型返回了无法识别的影响记录。");
    }
    const eventId = requireUuid(
      requireText(effectValue.eventId, 128, "模型返回了无效的事件编号。"),
      "模型返回了无效的事件编号。",
    );
    if (!allowedEventIds.has(eventId) || seen.has(eventId)) {
      throw invalidModel("模型引用了确定性影响范围之外或重复的事件。");
    }
    seen.add(eventId);
    const confidence = effectValue.confidence;
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw invalidModel("模型返回了无效的影响置信度。");
    }
    return Object.freeze({
      eventId,
      summary: requireText(effectValue.summary, 2_000, "模型返回了空的影响说明。"),
      confidence,
    });
  });
  return Object.freeze({ alternateDirection, effects: Object.freeze(effects) });
}

function requireUuid(value: string, message: string): StoryUuidV7 {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw new CausalWhatIfSimulationError("CAUSAL_WHAT_IF_INVALID", message);
  }
  return parsed.value;
}

function requireText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== "string") {
    throw new CausalWhatIfSimulationError("CAUSAL_WHAT_IF_INVALID", message);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || normalized.includes("\0")) {
    throw new CausalWhatIfSimulationError("CAUSAL_WHAT_IF_INVALID", message);
  }
  return normalized;
}

function requireSha256(value: unknown, message: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw invalidModel(message);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return '"__undefined__"';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function authorityChanged(): CausalWhatIfSimulationError {
  return new CausalWhatIfSimulationError(
    "CAUSAL_WHAT_IF_AUTHORITY_CHANGED",
    "模型试演期间，故事关联或锁定规则发生了变化。结果没有保存，请按当前内容重试。",
    true,
  );
}

function invalidModel(message: string): CausalWhatIfSimulationError {
  return new CausalWhatIfSimulationError("CAUSAL_WHAT_IF_MODEL_INVALID", message, true);
}

function persistenceFailure(cause: StoryCoreError): CausalWhatIfSimulationError {
  return new CausalWhatIfSimulationError(
    "CAUSAL_WHAT_IF_PERSISTENCE_FAILED",
    `剧情试演没有保存：${cause.message}`,
    cause.retryable,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
