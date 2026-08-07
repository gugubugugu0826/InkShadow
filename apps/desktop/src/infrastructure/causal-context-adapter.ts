import type { ContextCandidateDraft, ContextEvidenceReference } from "@inkshadow/ai-core";
import type {
  CausalEventGraph,
  CausalEventNode,
  CausalEventRelation,
  CausalTextEvidence,
} from "@inkshadow/story-core";

export interface CausalContextSelectionInput {
  readonly graph: CausalEventGraph;
  readonly query: string;
  readonly maximumEvents?: number;
}

const DEFAULT_MAXIMUM_EVENTS = 8;
const HARD_MAXIMUM_EVENTS = 32;

/**
 * Selects an evidence-backed slice of the confirmed causal graph for the
 * context compiler. The adapter is local and deterministic: it never invents
 * an event, relation, or evidence reference and never calls a model.
 */
export function selectCausalContextCandidates(
  input: CausalContextSelectionInput,
): readonly ContextCandidateDraft[] {
  const maximumEvents = boundedMaximum(input.maximumEvents ?? DEFAULT_MAXIMUM_EVENTS);
  if (input.graph.events.length === 0 || maximumEvents === 0) {
    return Object.freeze([]);
  }

  const terms = tokenize(input.query);
  const newestOrder = Math.max(
    ...input.graph.events.map(({ narrativeTime }) => narrativeTime.order),
  );
  const connectedEventIds = connectedIds(input.graph.relations);
  const ranked = [...input.graph.events]
    .map((event, sourceIndex) => ({
      event,
      sourceIndex,
      score: eventSelectionScore(event, terms, newestOrder, connectedEventIds),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.event.narrativeTime.order - left.event.narrativeTime.order ||
        left.sourceIndex - right.sourceIndex ||
        left.event.id.localeCompare(right.event.id),
    )
    .slice(0, maximumEvents);

  const selectedIds = new Set(ranked.map(({ event }) => event.id));
  return Object.freeze(
    ranked.map(({ event, score }) =>
      Object.freeze({
        id: `causal-event:${event.id}`,
        content: renderEvent(event, input.graph.relations, selectedIds),
        selectionReason: causalSelectionReason(event, score, terms),
        evidence: Object.freeze(collectEventEvidence(event, input.graph.relations)),
        priority: Math.min(1_000, 500 + Math.round(score * 100)),
        relevanceScore: Math.min(1, Math.max(0, score / 10)),
      }),
    ),
  );
}

function boundedMaximum(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("The causal context event limit must be a non-negative integer.");
  }
  return Math.min(value, HARD_MAXIMUM_EVENTS);
}

function tokenize(value: string): readonly string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const cjk = Array.from(normalized).filter((character) => /[\p{Script=Han}]/u.test(character));
  return Object.freeze([...new Set([...words, ...cjk])].slice(0, 128));
}

function connectedIds(relations: readonly CausalEventRelation[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const relation of relations) {
    result.add(relation.fromEventId);
    result.add(relation.toEventId);
  }
  return result;
}

function eventSelectionScore(
  event: CausalEventNode,
  terms: readonly string[],
  newestOrder: number,
  connectedEventIds: ReadonlySet<string>,
): number {
  const searchable = [
    event.eventText,
    event.resultText,
    event.location.label,
    event.narrativeTime.label,
    ...event.participantCharacterIds,
    ...event.foreshadowProgress.map(({ description }) => description),
  ]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase();
  const matched = terms.filter((term) => searchable.includes(term)).length;
  const lexical = terms.length === 0 ? 0 : matched / terms.length;
  const recency = newestOrder <= 0 ? 0 : Math.max(0, event.narrativeTime.order / newestOrder);
  const connected = connectedEventIds.has(event.id) ? 0.5 : 0;
  return lexical * 7 + recency * 2 + connected;
}

function renderEvent(
  event: CausalEventNode,
  relations: readonly CausalEventRelation[],
  selectedIds: ReadonlySet<string>,
): string {
  const lines = [
    "[用户确认的因果事件]",
    `事件：${event.eventText}`,
    `结果：${event.resultText}`,
    `时间：${event.narrativeTime.label}（顺序 ${String(event.narrativeTime.order)}）`,
    `地点：${event.location.label}`,
  ];
  if (event.participantCharacterIds.length > 0) {
    lines.push(`参与人物：${event.participantCharacterIds.join("、")}`);
  }
  if (event.informedCharacterIds.length > 0) {
    lines.push(`已知情人物：${event.informedCharacterIds.join("、")}`);
  }
  if (event.characterStateChanges.length > 0) {
    lines.push(
      `人物变化：${event.characterStateChanges
        .map(
          ({ characterId, attributeKey, beforeValue, afterValue }) =>
            `${characterId}.${attributeKey}: ${renderValue(beforeValue)} → ${renderValue(afterValue)}`,
        )
        .join("；")}`,
    );
  }
  if (event.relationshipChanges.length > 0) {
    lines.push(
      `关系变化：${event.relationshipChanges
        .map(
          ({ fromCharacterId, toCharacterId, relationshipKey, beforeValue, afterValue }) =>
            `${fromCharacterId}→${toCharacterId}.${relationshipKey}: ${renderValue(beforeValue)} → ${renderValue(afterValue)}`,
        )
        .join("；")}`,
    );
  }
  if (event.foreshadowProgress.length > 0) {
    lines.push(
      `伏笔：${event.foreshadowProgress
        .map(({ foreshadowId, kind, description }) => `${foreshadowId}(${kind}) ${description}`)
        .join("；")}`,
    );
  }
  const related = relations.filter(
    ({ fromEventId, toEventId }) =>
      (fromEventId === event.id && selectedIds.has(toEventId)) ||
      (toEventId === event.id && selectedIds.has(fromEventId)),
  );
  if (related.length > 0) {
    lines.push(
      `已确认关联：${related
        .map(({ fromEventId, kind, toEventId }) => `${fromEventId} ${kind} ${toEventId}`)
        .join("；")}`,
    );
  }
  return lines.join("\n");
}

function renderValue(value: string | number | boolean | null): string {
  return value === null ? "无" : String(value);
}

function causalSelectionReason(
  event: CausalEventNode,
  score: number,
  terms: readonly string[],
): string {
  if (terms.length > 0 && score >= 7 / terms.length) {
    return "与当前写作任务直接相关，并来自用户确认的因果事件链。";
  }
  return event.downstreamEventIds.length > 0
    ? "这是近期且会影响后续事件的已确认因果节点。"
    : "这是近期的已确认事件，用于保持前后连续。";
}

function collectEventEvidence(
  event: CausalEventNode,
  relations: readonly CausalEventRelation[],
): readonly ContextEvidenceReference[] {
  const evidence = [
    event.evidence,
    ...event.prerequisites.map((item) => item.evidence),
    ...event.characterStateChanges.map((item) => item.evidence),
    ...event.relationshipChanges.map((item) => item.evidence),
    ...event.itemChanges.map((item) => item.evidence),
    ...event.foreshadowProgress.map((item) => item.evidence),
    ...relations
      .filter(({ fromEventId, toEventId }) => fromEventId === event.id || toEventId === event.id)
      .map((relation) => relation.evidence),
  ];
  const seen = new Set<string>();
  return evidence.flatMap((item) => {
    const key = `${item.chapterVersionId}:${String(item.startOffset)}:${String(item.endOffset)}:${item.contentHash}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [causalEvidenceReference(item)];
  });
}

function causalEvidenceReference(evidence: CausalTextEvidence): ContextEvidenceReference {
  return Object.freeze({
    sourceType: "causal_event",
    sourceId: evidence.chapterId,
    sourceVersionId: evidence.chapterVersionId,
    locator: evidence.locator,
    contentHash: evidence.contentHash,
    excerpt: evidence.excerpt,
  });
}
