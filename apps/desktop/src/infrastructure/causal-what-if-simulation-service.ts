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

export interface CausalWhatIfSimulationValue {
  readonly schema: typeof CAUSAL_WHAT_IF_SCHEMA;
  readonly hypothesis: string;
  readonly sourceEventId: string;
  readonly deterministicImpactEventIds: readonly string[];
  readonly alternateDirection: string;
  readonly effects: readonly CausalWhatIfModelEffect[];
  readonly sandbox: true;
  readonly changesFormalStory: false;
}

export interface CausalWhatIfSimulationReceipt {
  readonly branchId: string;
  readonly fact: StoryFact;
  readonly deterministicImpactCount: number;
  readonly truncated: boolean;
}

export class CausalWhatIfSimulationError extends Error {
  public constructor(
    readonly code:
      | "CAUSAL_WHAT_IF_INVALID"
      | "CAUSAL_WHAT_IF_SOURCE_MISSING"
      | "CAUSAL_WHAT_IF_MODEL_INVALID"
      | "CAUSAL_WHAT_IF_PERSISTENCE_FAILED",
    message: string,
    readonly retryable = false,
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
    const graph = await this.graph.loadProjectBranch(projectId, "main");
    const sourceEvent = graph.events.find(({ id }) => id === sourceEventId);
    if (sourceEvent === undefined) {
      throw new CausalWhatIfSimulationError(
        "CAUSAL_WHAT_IF_SOURCE_MISSING",
        "这个事件已经不在当前确认的故事关联中，请重新整理后再试演。",
      );
    }
    const impact = await this.graph.traceImpacts({
      projectId,
      branchId: "main",
      changedEventIds: [sourceEventId],
      maximumDepth: 32,
      maximumImpactedEvents: 128,
    });
    const impactedIds = impact.impactedEvents.map(({ eventId }) => eventId);
    const allowedIds = new Set([sourceEventId, ...impactedIds]);
    const impactedEvents = impact.impactedEvents.flatMap(({ eventId }) => {
      const event = graph.events.find(({ id }) => id === eventId);
      return event === undefined ? [] : [toEventContext(event)];
    });
    const relations = graph.relations
      .filter(
        ({ fromEventId, toEventId }) => allowedIds.has(fromEventId) && allowedIds.has(toEventId),
      )
      .map(toRelationContext);
    const factResult = await this.facts.listByProjectId(projectId);
    if (!factResult.ok) {
      throw persistenceFailure(factResult.error);
    }
    const lockedRules = factResult.value
      .map((fact) => fact.toSnapshot())
      .filter(
        (fact) =>
          fact.status === "formal" &&
          fact.userConfirmed &&
          fact.locked &&
          !fact.deprecated &&
          fact.branchId === null,
      )
      .slice(0, 100)
      .map((fact) => ({
        id: fact.id,
        content:
          fact.contentText ??
          (fact.structuredValue === null ? "" : JSON.stringify(fact.structuredValue)),
      }))
      .filter(({ content }) => content.length > 0);

    const output = validateModelOutput(
      await this.model.simulate({
        projectId,
        hypothesis,
        sourceEvent: toEventContext(sourceEvent),
        impactedEvents,
        relations,
        lockedRules,
      }),
      allowedIds,
    );
    const branchId = requireUuid(this.ids.next(), "无法创建试演分支编号。");
    const value: CausalWhatIfSimulationValue = Object.freeze({
      schema: CAUSAL_WHAT_IF_SCHEMA,
      hypothesis,
      sourceEventId,
      deterministicImpactEventIds: Object.freeze(impactedIds),
      alternateDirection: output.alternateDirection,
      effects: output.effects,
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
      deterministicImpactCount: impactedIds.length,
      truncated: impact.truncated,
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
  return Object.freeze({
    schema: CAUSAL_WHAT_IF_SCHEMA,
    hypothesis,
    sourceEventId,
    deterministicImpactEventIds,
    alternateDirection: requireText(value.alternateDirection, 10_000, "试演方向无效。"),
    effects,
    sandbox: true,
    changesFormalStory: false,
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
