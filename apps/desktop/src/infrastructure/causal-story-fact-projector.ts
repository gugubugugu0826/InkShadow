import type { ChapterVersionRepository } from "@inkshadow/application";
import { parseUuidV7 as parseDomainUuid } from "@inkshadow/domain";
import {
  CAUSAL_IMPACT_RELATION_KINDS,
  CAUSAL_EVENT_RELATION_KINDS,
  type CausalEventGraph,
  parseUuidV7 as parseStoryUuid,
  type CausalCharacterStateChange,
  type CausalEventNode,
  type CausalEventPrerequisite,
  type CausalEventRelation,
  type CausalForeshadowProgress,
  type CausalItemChange,
  type CausalRelationshipChange,
  type CausalStateValue,
  type CausalTextEvidence,
  type StoryFact,
  type StoryFactStore,
  type StoryValue,
} from "@inkshadow/story-core";

import type { CausalEventGraphStore } from "./causal-event-graph-store";

export const CAUSAL_EVENT_FACT_SCHEMA = "inkshadow.causal-event-fact.v2" as const;
const LEGACY_CAUSAL_EVENT_FACT_SCHEMA = "inkshadow.causal-event-fact.v1" as const;
export const CAUSAL_RELATION_FACT_SCHEMA = "inkshadow.causal-relation-fact.v1" as const;

export type CausalProjectionSkipReason =
  | "not_confirmed"
  | "branch_mismatch"
  | "unsupported_schema"
  | "chapter_evidence_incomplete"
  | "chapter_version_unavailable"
  | "chapter_evidence_mismatch"
  | "duplicate_event"
  | "duplicate_relation"
  | "relation_endpoint_missing"
  | "structured_value_invalid";

export interface CausalProjectionSkip {
  readonly factId: string;
  readonly factType: string;
  readonly reason: CausalProjectionSkipReason;
  readonly explanation: string;
}

export interface CausalStoryFactProjectionReceipt {
  readonly projectId: string;
  readonly branchId: string;
  readonly eventCount: number;
  readonly relationCount: number;
  readonly includedFactIds: readonly string[];
  readonly skipped: readonly CausalProjectionSkip[];
  readonly graph: CausalEventGraph;
}

export class CausalStoryFactProjectorError extends Error {
  public constructor(
    readonly code:
      | "CAUSAL_FACT_PROJECT_INVALID_PROJECT"
      | "CAUSAL_FACT_PROJECT_FACTS_UNAVAILABLE"
      | "CAUSAL_FACT_PROJECT_STORE_FAILED",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CausalStoryFactProjectorError";
  }
}

interface ProjectionOptions {
  readonly facts: StoryFactStore;
  readonly chapterVersions: ChapterVersionRepository;
  readonly graph: CausalEventGraphStore;
}

interface EventCandidate {
  readonly fact: StoryFact;
  readonly event: Omit<CausalEventNode, "downstreamEventIds">;
}

interface RelationCandidate {
  readonly fact: StoryFact;
  readonly relation: CausalEventRelation;
}

/**
 * Rebuilds the authoritative causal graph only from human-confirmed unified
 * story facts with exact immutable chapter-version evidence.
 */
export class CausalStoryFactProjector {
  public constructor(private readonly options: ProjectionOptions) {}

  public async rebuildProject(
    projectIdValue: string,
    branchId = "main",
  ): Promise<CausalStoryFactProjectionReceipt> {
    const projectId = parseStoryUuid(projectIdValue);
    if (!projectId.ok) {
      throw new CausalStoryFactProjectorError(
        "CAUSAL_FACT_PROJECT_INVALID_PROJECT",
        "The causal projection project identifier is invalid.",
      );
    }
    const loaded = await this.options.facts.listByProjectId(projectId.value);
    if (!loaded.ok) {
      throw new CausalStoryFactProjectorError(
        "CAUSAL_FACT_PROJECT_FACTS_UNAVAILABLE",
        "Confirmed story facts could not be read for causal projection.",
        loaded.error.retryable,
      );
    }

    const skipped: CausalProjectionSkip[] = [];
    const events: EventCandidate[] = [];
    const relations: RelationCandidate[] = [];
    const eventIds = new Set<string>();
    const relationIds = new Set<string>();

    for (const fact of loaded.value) {
      const snapshot = fact.toSnapshot();
      if (!isCausalFact(snapshot.factType, snapshot.structuredValue)) {
        continue;
      }
      if (
        snapshot.status !== "formal" ||
        !snapshot.userConfirmed ||
        snapshot.needsReview ||
        snapshot.deprecated
      ) {
        skipped.push(skip(fact, "not_confirmed", "只有用户确认的正式事实可以进入因果图。"));
        continue;
      }
      if (
        (branchId === "main" && snapshot.branchId !== null) ||
        (branchId !== "main" && snapshot.branchId !== branchId)
      ) {
        skipped.push(skip(fact, "branch_mismatch", "事实不属于当前剧情分支。"));
        continue;
      }
      const evidence = await this.readEvidence(fact);
      if (!evidence.ok) {
        skipped.push(skip(fact, evidence.reason, evidence.explanation));
        continue;
      }
      const structured = asRecord(snapshot.structuredValue);
      if (structured === null) {
        skipped.push(skip(fact, "structured_value_invalid", "因果事实缺少结构化内容。"));
        continue;
      }

      if (
        structured.schemaVersion === CAUSAL_EVENT_FACT_SCHEMA ||
        structured.schemaVersion === LEGACY_CAUSAL_EVENT_FACT_SCHEMA
      ) {
        const event = parseEventFact(fact, structured, projectId.value, branchId, evidence.value);
        if (event === null) {
          skipped.push(skip(fact, "structured_value_invalid", "事件字段不完整或格式无效。"));
          continue;
        }
        if (eventIds.has(event.id)) {
          skipped.push(skip(fact, "duplicate_event", "事件标识已被另一条确认事实使用。"));
          continue;
        }
        eventIds.add(event.id);
        events.push({ fact, event });
        continue;
      }

      if (structured.schemaVersion === CAUSAL_RELATION_FACT_SCHEMA) {
        const relation = parseRelationFact(
          fact,
          structured,
          projectId.value,
          branchId,
          evidence.value,
        );
        if (relation === null) {
          skipped.push(skip(fact, "structured_value_invalid", "因果关系字段不完整或格式无效。"));
          continue;
        }
        if (relationIds.has(relation.id)) {
          skipped.push(skip(fact, "duplicate_relation", "关系标识已被另一条确认事实使用。"));
          continue;
        }
        relationIds.add(relation.id);
        relations.push({ fact, relation });
        continue;
      }

      skipped.push(skip(fact, "unsupported_schema", "因果事实版本暂不受支持。"));
    }

    const validRelations = relations.filter(({ fact, relation }) => {
      if (eventIds.has(relation.fromEventId) && eventIds.has(relation.toEventId)) {
        return true;
      }
      skipped.push(
        skip(fact, "relation_endpoint_missing", "关系引用的事件尚未确认或缺少有效证据。"),
      );
      return false;
    });
    for (const { event, fact } of events) {
      for (const prerequisite of event.prerequisites) {
        if (
          prerequisite.kind !== "event" ||
          !eventIds.has(prerequisite.referenceId) ||
          validRelations.some(
            ({ relation }) =>
              relation.fromEventId === prerequisite.referenceId &&
              relation.toEventId === event.id &&
              CAUSAL_IMPACT_RELATION_KINDS.some((kind) => kind === relation.kind),
          )
        ) {
          continue;
        }
        validRelations.push({
          fact,
          relation: Object.freeze({
            id: `prerequisite:${prerequisite.id}`,
            projectId: event.projectId,
            branchId: event.branchId,
            fromEventId: prerequisite.referenceId,
            toEventId: event.id,
            kind: "depends_on" as const,
            evidence: prerequisite.evidence,
          }),
        });
      }
    }
    const outgoing = new Map<string, string[]>();
    for (const { relation } of validRelations) {
      if (relation.kind === "before") {
        continue;
      }
      const targets = outgoing.get(relation.fromEventId) ?? [];
      targets.push(relation.toEventId);
      outgoing.set(relation.fromEventId, targets);
    }
    const graphInput = {
      events: events.map(({ event }) =>
        Object.freeze({
          ...event,
          downstreamEventIds: Object.freeze([...new Set(outgoing.get(event.id) ?? [])]),
        }),
      ),
      relations: validRelations.map(({ relation }) => relation),
    };

    try {
      const graph = await this.options.graph.replace({
        projectId: projectId.value,
        branchId,
        graph: graphInput,
      });
      const includedFactIds = [
        ...events.map(({ fact }) => fact.id),
        ...validRelations.map(({ fact }) => fact.id),
      ];
      return Object.freeze({
        projectId: projectId.value,
        branchId,
        eventCount: graph.events.length,
        relationCount: graph.relations.length,
        includedFactIds: Object.freeze([...new Set(includedFactIds)]),
        skipped: Object.freeze(skipped),
        graph,
      });
    } catch (cause: unknown) {
      throw new CausalStoryFactProjectorError(
        "CAUSAL_FACT_PROJECT_STORE_FAILED",
        cause instanceof Error ? cause.message : "The causal graph could not be rebuilt.",
        true,
      );
    }
  }

  private async readEvidence(fact: StoryFact): Promise<
    | Readonly<{ ok: true; value: CausalTextEvidence }>
    | Readonly<{
        ok: false;
        reason:
          | "chapter_evidence_incomplete"
          | "chapter_version_unavailable"
          | "chapter_evidence_mismatch";
        explanation: string;
      }>
  > {
    const snapshot = fact.toSnapshot();
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
      return {
        ok: false,
        reason: "chapter_evidence_incomplete",
        explanation: "事件必须引用不可变章节版本中的精确原文片段。",
      };
    }
    const versionId = parseDomainUuid(source.versionId);
    if (!versionId.ok) {
      return {
        ok: false,
        reason: "chapter_version_unavailable",
        explanation: "事件引用的章节版本标识无效。",
      };
    }
    const loaded = await this.options.chapterVersions.findVersionById(versionId.value);
    if (!loaded.ok || loaded.value === null) {
      return {
        ok: false,
        reason: "chapter_version_unavailable",
        explanation: "事件引用的不可变章节版本无法读取。",
      };
    }
    const version = loaded.value.toSnapshot();
    if (
      String(version.projectId) !== String(snapshot.projectId) ||
      String(version.chapterId) !== String(source.chapterId) ||
      version.content.length !== source.sourceLength ||
      source.startOffset < 0 ||
      source.endOffset <= source.startOffset ||
      source.endOffset > version.content.length ||
      version.content.slice(source.startOffset, source.endOffset) !== source.excerpt
    ) {
      return {
        ok: false,
        reason: "chapter_evidence_mismatch",
        explanation: "事件证据与当前保存的不可变章节版本不一致。",
      };
    }
    return {
      ok: true,
      value: Object.freeze({
        id: `${snapshot.id}:evidence`,
        chapterId: source.chapterId,
        chapterVersionId: source.versionId,
        contentHash: version.contentChecksum,
        locator: `${source.reference}#utf16:${String(source.startOffset)}-${String(source.endOffset)}/${String(source.sourceLength)}`,
        excerpt: source.excerpt,
        startOffset: source.startOffset,
        endOffset: source.endOffset,
        sourceLength: source.sourceLength,
      }),
    };
  }
}

function isCausalFact(factType: string, value: StoryValue | null): boolean {
  if (factType === "causal_event" || factType === "causal_relation") {
    return true;
  }
  const record = asRecord(value);
  return (
    record?.schemaVersion === CAUSAL_EVENT_FACT_SCHEMA ||
    record?.schemaVersion === LEGACY_CAUSAL_EVENT_FACT_SCHEMA ||
    record?.schemaVersion === CAUSAL_RELATION_FACT_SCHEMA
  );
}

function parseEventFact(
  fact: StoryFact,
  value: Readonly<Record<string, StoryValue>>,
  projectId: string,
  branchId: string,
  evidence: CausalTextEvidence,
): Omit<CausalEventNode, "downstreamEventIds"> | null {
  const eventId = stringValue(value.eventId) ?? fact.id;
  const eventText = stringValue(value.eventText);
  const resultText = stringValue(value.resultText);
  const narrativeTime = asRecord(value.narrativeTime);
  const location = asRecord(value.location);
  const order = numberValue(narrativeTime?.order);
  const narrativeLabel = stringValue(narrativeTime?.label);
  const locationId = stringValue(location?.locationId);
  const locationLabel = stringValue(location?.label);
  if (
    eventText === null ||
    resultText === null ||
    order === null ||
    narrativeLabel === null ||
    locationId === null ||
    locationLabel === null
  ) {
    return null;
  }
  const participantCharacterIds = stringArray(value.participantCharacterIds);
  const informedCharacterIds = stringArray(value.informedCharacterIds);
  const knowledgeGains = parseKnowledgeGains(value.knowledgeGains);
  if (
    participantCharacterIds === null ||
    informedCharacterIds === null ||
    knowledgeGains === null ||
    knowledgeGains.some(({ characterId }) => !informedCharacterIds.includes(characterId))
  ) {
    return null;
  }
  const prerequisites = parsePrerequisites(value.prerequisites, evidence);
  const characterStateChanges = parseCharacterChanges(value.characterStateChanges, evidence);
  const relationshipChanges = parseRelationshipChanges(value.relationshipChanges, evidence);
  const itemChanges = parseItemChanges(value.itemChanges, evidence);
  const foreshadowProgress = parseForeshadowProgress(value.foreshadowProgress, evidence);
  if (
    prerequisites === null ||
    characterStateChanges === null ||
    relationshipChanges === null ||
    itemChanges === null ||
    foreshadowProgress === null
  ) {
    return null;
  }
  return Object.freeze({
    id: eventId,
    projectId,
    branchId,
    status: "confirmed",
    participantCharacterIds: Object.freeze(participantCharacterIds),
    narrativeTime: Object.freeze({ order, label: narrativeLabel }),
    location: Object.freeze({ locationId, label: locationLabel }),
    prerequisites: Object.freeze(prerequisites),
    eventText,
    resultText,
    characterStateChanges: Object.freeze(characterStateChanges),
    relationshipChanges: Object.freeze(relationshipChanges),
    itemChanges: Object.freeze(itemChanges),
    informedCharacterIds: Object.freeze(informedCharacterIds),
    foreshadowProgress: Object.freeze(foreshadowProgress),
    evidence,
  });
}

function parseKnowledgeGains(value: StoryValue | undefined):
  | readonly Readonly<{
      readonly characterId: string;
      readonly attributeKey: string;
      readonly informationId: string;
    }>[]
  | null {
  const parsed = parseObjectArray(value, (record) => {
    const characterId = stringValue(record.characterId);
    const attributeKey = stringValue(record.attributeKey);
    const informationId = stringValue(record.informationId);
    return characterId === null || attributeKey === null || informationId === null
      ? null
      : Object.freeze({ characterId, attributeKey, informationId });
  });
  if (parsed === null) return null;
  const signatures = parsed.map(
    ({ characterId, attributeKey, informationId }) =>
      `${characterId}\u0000${attributeKey}\u0000${informationId}`,
  );
  return new Set(signatures).size === signatures.length ? Object.freeze(parsed) : null;
}

function parseRelationFact(
  fact: StoryFact,
  value: Readonly<Record<string, StoryValue>>,
  projectId: string,
  branchId: string,
  evidence: CausalTextEvidence,
): CausalEventRelation | null {
  const id = stringValue(value.relationId) ?? fact.id;
  const fromEventId = stringValue(value.fromEventId);
  const toEventId = stringValue(value.toEventId);
  const kind = stringValue(value.kind);
  if (
    fromEventId === null ||
    toEventId === null ||
    kind === null ||
    !CAUSAL_EVENT_RELATION_KINDS.includes(kind as CausalEventRelation["kind"])
  ) {
    return null;
  }
  return Object.freeze({
    id,
    projectId,
    branchId,
    fromEventId,
    toEventId,
    kind: kind as CausalEventRelation["kind"],
    evidence,
  });
}

function parsePrerequisites(
  value: StoryValue | undefined,
  evidence: CausalTextEvidence,
): CausalEventPrerequisite[] | null {
  return parseObjectArray(value, (record, index) => {
    const kind = stringValue(record.kind);
    const referenceId = stringValue(record.referenceId);
    const referenceLabel = stringValue(record.referenceLabel);
    const description = stringValue(record.description);
    if (
      referenceId === null ||
      description === null ||
      (kind !== "event" && kind !== "state" && kind !== "rule")
    ) {
      return null;
    }
    return {
      id: stringValue(record.id) ?? `${evidence.id}:prerequisite:${String(index)}`,
      kind,
      referenceId,
      ...(referenceLabel === null ? {} : { referenceLabel }),
      description,
      evidence,
    };
  });
}

function parseCharacterChanges(
  value: StoryValue | undefined,
  evidence: CausalTextEvidence,
): CausalCharacterStateChange[] | null {
  return parseObjectArray(value, (record, index) => {
    const characterId = stringValue(record.characterId);
    const attributeKey = stringValue(record.attributeKey);
    const attributeLabel = stringValue(record.attributeLabel);
    const beforeValue = stateValue(record.beforeValue);
    const afterValue = stateValue(record.afterValue);
    if (characterId === null || attributeKey === null || !beforeValue.ok || !afterValue.ok) {
      return null;
    }
    return {
      id: stringValue(record.id) ?? `${evidence.id}:character:${String(index)}`,
      characterId,
      attributeKey,
      ...(attributeLabel === null ? {} : { attributeLabel }),
      beforeValue: beforeValue.value,
      afterValue: afterValue.value,
      evidence,
    };
  });
}

function parseRelationshipChanges(
  value: StoryValue | undefined,
  evidence: CausalTextEvidence,
): CausalRelationshipChange[] | null {
  return parseObjectArray(value, (record, index) => {
    const fromCharacterId = stringValue(record.fromCharacterId);
    const toCharacterId = stringValue(record.toCharacterId);
    const relationshipKey = stringValue(record.relationshipKey);
    const relationshipLabel = stringValue(record.relationshipLabel);
    const beforeValue = stateValue(record.beforeValue);
    const afterValue = stateValue(record.afterValue);
    if (
      fromCharacterId === null ||
      toCharacterId === null ||
      relationshipKey === null ||
      !beforeValue.ok ||
      !afterValue.ok
    ) {
      return null;
    }
    return {
      id: stringValue(record.id) ?? `${evidence.id}:relationship:${String(index)}`,
      fromCharacterId,
      toCharacterId,
      relationshipKey,
      ...(relationshipLabel === null ? {} : { relationshipLabel }),
      beforeValue: beforeValue.value,
      afterValue: afterValue.value,
      evidence,
    };
  });
}

function parseItemChanges(
  value: StoryValue | undefined,
  evidence: CausalTextEvidence,
): CausalItemChange[] | null {
  return parseObjectArray(value, (record, index) => {
    const itemId = stringValue(record.itemId);
    const itemLabel = stringValue(record.itemLabel);
    const kind = stringValue(record.kind);
    const fromCharacterId = nullableStringValue(record.fromCharacterId);
    const toCharacterId = nullableStringValue(record.toCharacterId);
    if (
      itemId === null ||
      !["acquired", "lost", "transferred", "created", "destroyed"].includes(kind ?? "") ||
      !fromCharacterId.ok ||
      !toCharacterId.ok
    ) {
      return null;
    }
    return {
      id: stringValue(record.id) ?? `${evidence.id}:item:${String(index)}`,
      itemId,
      ...(itemLabel === null ? {} : { itemLabel }),
      kind: kind as CausalItemChange["kind"],
      fromCharacterId: fromCharacterId.value,
      toCharacterId: toCharacterId.value,
      evidence,
    };
  });
}

function parseForeshadowProgress(
  value: StoryValue | undefined,
  evidence: CausalTextEvidence,
): CausalForeshadowProgress[] | null {
  return parseObjectArray(value, (record, index) => {
    const foreshadowId = stringValue(record.foreshadowId);
    const foreshadowLabel = stringValue(record.foreshadowLabel);
    const kind = stringValue(record.kind);
    const description = stringValue(record.description);
    if (
      foreshadowId === null ||
      description === null ||
      !["planted", "advanced", "revealed", "resolved", "misdirected"].includes(kind ?? "")
    ) {
      return null;
    }
    return {
      id: stringValue(record.id) ?? `${evidence.id}:foreshadow:${String(index)}`,
      foreshadowId,
      ...(foreshadowLabel === null ? {} : { foreshadowLabel }),
      kind: kind as CausalForeshadowProgress["kind"],
      description,
      evidence,
    };
  });
}

function parseObjectArray<T>(
  value: StoryValue | undefined,
  parse: (record: Readonly<Record<string, StoryValue>>, index: number) => T | null,
): T[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const result: T[] = [];
  for (const [index, item] of value.entries()) {
    const record = asRecord(item);
    const parsed = record === null ? null : parse(record, index);
    if (parsed === null) {
      return null;
    }
    result.push(parsed);
  }
  return result;
}

function asRecord(value: unknown): Readonly<Record<string, StoryValue>> | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, StoryValue>>)
    : null;
}

function stringValue(value: StoryValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nullableStringValue(
  value: StoryValue | undefined,
): Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false }> {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  const parsed = stringValue(value);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

function numberValue(value: StoryValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stringArray(value: StoryValue | undefined): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed = value.map(stringValue);
  return parsed.every((item): item is string => item !== null) ? parsed : null;
}

function stateValue(
  value: StoryValue | undefined,
): Readonly<{ ok: true; value: CausalStateValue }> | Readonly<{ ok: false }> {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
    ? { ok: true, value: value as CausalStateValue }
    : { ok: false };
}

function skip(
  fact: StoryFact,
  reason: CausalProjectionSkipReason,
  explanation: string,
): CausalProjectionSkip {
  const snapshot = fact.toSnapshot();
  return Object.freeze({ factId: fact.id, factType: snapshot.factType, reason, explanation });
}
