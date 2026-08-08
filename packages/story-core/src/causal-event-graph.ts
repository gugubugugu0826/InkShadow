export const CAUSAL_EVENT_RELATION_KINDS = [
  "causes",
  "depends_on",
  "prevents",
  "reveals",
  "misleads",
  "before",
  "changes_state",
  "gains_information",
  "loses_item",
] as const;

export type CausalEventRelationKind = (typeof CAUSAL_EVENT_RELATION_KINDS)[number];

export const CAUSAL_IMPACT_RELATION_KINDS = [
  "causes",
  "depends_on",
  "prevents",
  "reveals",
  "misleads",
  "changes_state",
  "gains_information",
  "loses_item",
] as const satisfies readonly CausalEventRelationKind[];

export type CausalImpactRelationKind = (typeof CAUSAL_IMPACT_RELATION_KINDS)[number];
export type CausalStateValue = string | number | boolean | null;

/**
 * An exact excerpt from an immutable chapter version. Offsets use JavaScript
 * UTF-16 code units. A persistence adapter must additionally verify the hash,
 * chapter/version ownership, source length, and exact excerpt before saving.
 */
export interface CausalTextEvidence {
  readonly id: string;
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly contentHash: string;
  readonly locator: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
}

export interface CausalNarrativeTime {
  readonly order: number;
  readonly label: string;
}

export interface CausalEventLocation {
  readonly locationId: string;
  readonly label: string;
}

export type CausalPrerequisiteKind = "event" | "state" | "rule";

export interface CausalEventPrerequisite {
  readonly id: string;
  readonly kind: CausalPrerequisiteKind;
  readonly referenceId: string;
  readonly referenceLabel?: string;
  readonly description: string;
  readonly evidence: CausalTextEvidence;
}

export interface CausalCharacterStateChange {
  readonly id: string;
  readonly characterId: string;
  readonly attributeKey: string;
  readonly attributeLabel?: string;
  readonly beforeValue: CausalStateValue;
  readonly afterValue: CausalStateValue;
  readonly evidence: CausalTextEvidence;
}

export interface CausalRelationshipChange {
  readonly id: string;
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly relationshipKey: string;
  readonly relationshipLabel?: string;
  readonly beforeValue: CausalStateValue;
  readonly afterValue: CausalStateValue;
  readonly evidence: CausalTextEvidence;
}

export type CausalItemChangeKind = "acquired" | "lost" | "transferred" | "created" | "destroyed";

export interface CausalItemChange {
  readonly id: string;
  readonly itemId: string;
  readonly itemLabel?: string;
  readonly kind: CausalItemChangeKind;
  readonly fromCharacterId: string | null;
  readonly toCharacterId: string | null;
  readonly evidence: CausalTextEvidence;
}

export type CausalForeshadowChangeKind =
  "planted" | "advanced" | "revealed" | "resolved" | "misdirected";

export interface CausalForeshadowProgress {
  readonly id: string;
  readonly foreshadowId: string;
  readonly foreshadowLabel?: string;
  readonly kind: CausalForeshadowChangeKind;
  readonly description: string;
  readonly evidence: CausalTextEvidence;
}

export interface CausalEventNode {
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string;
  /** Only user-confirmed events are admitted to the authoritative graph. */
  readonly status: "confirmed";
  readonly participantCharacterIds: readonly string[];
  readonly narrativeTime: CausalNarrativeTime;
  readonly location: CausalEventLocation;
  readonly prerequisites: readonly CausalEventPrerequisite[];
  readonly eventText: string;
  readonly resultText: string;
  readonly characterStateChanges: readonly CausalCharacterStateChange[];
  readonly relationshipChanges: readonly CausalRelationshipChange[];
  readonly itemChanges: readonly CausalItemChange[];
  readonly informedCharacterIds: readonly string[];
  readonly foreshadowProgress: readonly CausalForeshadowProgress[];
  /** Declared direct impacts. These must be backed by explicit non-temporal relations. */
  readonly downstreamEventIds: readonly string[];
  readonly evidence: CausalTextEvidence;
}

/**
 * Every relation points from an influencing event to a potentially affected
 * event. For `depends_on`, the target depends on the source. `before` is only
 * temporal ordering and is deliberately excluded from What-if propagation.
 */
export interface CausalEventRelation {
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly fromEventId: string;
  readonly toEventId: string;
  readonly kind: CausalEventRelationKind;
  readonly evidence: CausalTextEvidence;
}

export interface CausalEventGraphInput {
  readonly events: readonly CausalEventNode[];
  readonly relations: readonly CausalEventRelation[];
}

export interface CausalImpactTraceRequest {
  readonly projectId: string;
  readonly branchId: string;
  readonly changedEventIds: readonly string[];
  readonly maximumDepth?: number;
  readonly maximumImpactedEvents?: number;
}

export interface CausalImpactReason {
  readonly relationId: string;
  readonly kind: CausalImpactRelationKind;
  readonly fromEventId: string;
  readonly toEventId: string;
  readonly evidence: CausalTextEvidence;
}

export interface CausalImpactedEvent {
  readonly eventId: string;
  readonly depth: number;
  readonly pathEventIds: readonly string[];
  readonly pathRelationIds: readonly string[];
  readonly reasons: readonly CausalImpactReason[];
}

export interface CausalCycleEdge {
  readonly relationId: string;
  readonly fromEventId: string;
  readonly toEventId: string;
}

export type CausalImpactTruncationReason = "maximum_depth" | "maximum_impacted_events";

export interface CausalImpactTraceResult {
  readonly projectId: string;
  readonly branchId: string;
  readonly changedEventIds: readonly string[];
  readonly impactedEvents: readonly CausalImpactedEvent[];
  readonly cycleEdgesSkipped: readonly CausalCycleEdge[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly CausalImpactTruncationReason[];
  readonly capabilities: Readonly<{
    deterministicImpactTraversal: "ready";
    alternatePlotGeneration: "available_via_governed_service";
    uiIntegration: "available_via_governed_service";
  }>;
}

export type CausalEventGraphInputErrorCode = "CAUSAL_EVENT_GRAPH_INPUT_INVALID";

export class CausalEventGraphInputError extends Error {
  public readonly code: CausalEventGraphInputErrorCode = "CAUSAL_EVENT_GRAPH_INPUT_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "CausalEventGraphInputError";
  }
}

const MAXIMUM_EVENTS = 8_192;
const MAXIMUM_RELATIONS = 32_768;
const MAXIMUM_EVENT_COLLECTION = 2_048;
const MAXIMUM_PARTICIPANTS = 512;
const MAXIMUM_TEXT_CHARACTERS = 200_000;
const MAXIMUM_DESCRIPTION_CHARACTERS = 20_000;
const MAXIMUM_REFERENCE_CHARACTERS = 512;
const MAXIMUM_LOCATOR_CHARACTERS = 2_000;
const MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS = 20_000;
const MAXIMUM_EVIDENCE_SOURCE_CHARACTERS = 5_000_000;
const MAXIMUM_STORY_ORDER = 1_000_000_000_000;
const DEFAULT_MAXIMUM_DEPTH = 128;
const DEFAULT_MAXIMUM_IMPACTED_EVENTS = 4_096;
const MAXIMUM_TRACE_DEPTH = 1_024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ITEM_CHANGE_KINDS: readonly CausalItemChangeKind[] = [
  "acquired",
  "lost",
  "transferred",
  "created",
  "destroyed",
];
const FORESHADOW_CHANGE_KINDS: readonly CausalForeshadowChangeKind[] = [
  "planted",
  "advanced",
  "revealed",
  "resolved",
  "misdirected",
];
const PREREQUISITE_KINDS: readonly CausalPrerequisiteKind[] = ["event", "state", "rule"];
const IMPACT_KIND_SET = new Set<CausalEventRelationKind>(CAUSAL_IMPACT_RELATION_KINDS);

interface MutableImpact {
  readonly eventId: string;
  readonly depth: number;
  readonly pathEventIds: readonly string[];
  readonly pathRelationIds: readonly string[];
  readonly reasons: CausalImpactReason[];
}

interface ValidatedGraph {
  readonly events: readonly CausalEventNode[];
  readonly relations: readonly CausalEventRelation[];
  readonly eventsById: ReadonlyMap<string, CausalEventNode>;
  readonly outgoingByEventId: ReadonlyMap<string, readonly CausalEventRelation[]>;
}

export class CausalEventGraph {
  public readonly events: readonly CausalEventNode[];
  public readonly relations: readonly CausalEventRelation[];
  readonly #eventsById: ReadonlyMap<string, CausalEventNode>;
  readonly #outgoingByEventId: ReadonlyMap<string, readonly CausalEventRelation[]>;

  private constructor(graph: ValidatedGraph) {
    this.events = graph.events;
    this.relations = graph.relations;
    this.#eventsById = graph.eventsById;
    this.#outgoingByEventId = graph.outgoingByEventId;
    Object.freeze(this);
  }

  public static create(input: CausalEventGraphInput): CausalEventGraph {
    return new CausalEventGraph(validateGraph(input));
  }

  public traceImpacts(request: CausalImpactTraceRequest): CausalImpactTraceResult {
    const validated = validateTraceRequest(request, this.#eventsById);
    const changedSet = new Set(validated.changedEventIds);
    const impacts = new Map<string, MutableImpact>();
    const cycles = new Map<string, CausalCycleEdge>();
    const truncationReasons = new Set<CausalImpactTruncationReason>();
    const queue: string[] = [...validated.changedEventIds];
    const depths = new Map<string, number>(validated.changedEventIds.map((id) => [id, 0]));
    const paths = new Map<string, readonly string[]>(
      validated.changedEventIds.map((id) => [id, Object.freeze([id])]),
    );
    const relationPaths = new Map<string, readonly string[]>(
      validated.changedEventIds.map((id) => [id, Object.freeze([])]),
    );

    for (const currentId of queue) {
      const currentDepth = depths.get(currentId);
      const currentPath = paths.get(currentId);
      const currentRelationPath = relationPaths.get(currentId);
      if (
        currentDepth === undefined ||
        currentPath === undefined ||
        currentRelationPath === undefined
      ) {
        throw invalidInput("The causal impact traversal entered an invalid internal state.");
      }
      const outgoing = this.#outgoingByEventId.get(currentId) ?? [];
      for (const relation of outgoing) {
        if (
          relation.projectId !== validated.projectId ||
          relation.branchId !== validated.branchId ||
          !isImpactRelationKind(relation.kind)
        ) {
          continue;
        }
        if (currentPath.includes(relation.toEventId)) {
          cycles.set(
            relation.id,
            Object.freeze({
              relationId: relation.id,
              fromEventId: relation.fromEventId,
              toEventId: relation.toEventId,
            }),
          );
          continue;
        }
        const nextDepth = currentDepth + 1;
        if (nextDepth > validated.maximumDepth) {
          truncationReasons.add("maximum_depth");
          continue;
        }
        const reason = freezeImpactReason(relation);
        const knownDepth = depths.get(relation.toEventId);
        if (knownDepth !== undefined) {
          if (!changedSet.has(relation.toEventId) && knownDepth === nextDepth) {
            const existing = impacts.get(relation.toEventId);
            if (
              existing !== undefined &&
              !existing.reasons.some(({ relationId }) => relationId === relation.id)
            ) {
              existing.reasons.push(reason);
            }
          }
          continue;
        }
        if (impacts.size >= validated.maximumImpactedEvents) {
          truncationReasons.add("maximum_impacted_events");
          continue;
        }
        const nextEventPath = Object.freeze([...currentPath, relation.toEventId]);
        const nextRelationPath = Object.freeze([...currentRelationPath, relation.id]);
        depths.set(relation.toEventId, nextDepth);
        paths.set(relation.toEventId, nextEventPath);
        relationPaths.set(relation.toEventId, nextRelationPath);
        impacts.set(relation.toEventId, {
          eventId: relation.toEventId,
          depth: nextDepth,
          pathEventIds: nextEventPath,
          pathRelationIds: nextRelationPath,
          reasons: [reason],
        });
        queue.push(relation.toEventId);
      }
    }

    const impactedEvents = [...impacts.values()]
      .sort((left, right) => left.depth - right.depth || left.eventId.localeCompare(right.eventId))
      .map((impact) =>
        Object.freeze({
          eventId: impact.eventId,
          depth: impact.depth,
          pathEventIds: impact.pathEventIds,
          pathRelationIds: impact.pathRelationIds,
          reasons: Object.freeze(impact.reasons.sort(compareImpactReasons)),
        }),
      );

    return Object.freeze({
      projectId: validated.projectId,
      branchId: validated.branchId,
      changedEventIds: validated.changedEventIds,
      impactedEvents: Object.freeze(impactedEvents),
      cycleEdgesSkipped: Object.freeze([...cycles.values()].sort(compareCycleEdges)),
      truncated: truncationReasons.size > 0,
      truncationReasons: Object.freeze([...truncationReasons].sort()),
      capabilities: Object.freeze({
        deterministicImpactTraversal: "ready",
        alternatePlotGeneration: "available_via_governed_service",
        uiIntegration: "available_via_governed_service",
      }),
    });
  }
}

function validateGraph(input: CausalEventGraphInput): ValidatedGraph {
  if (
    !isRecord(input) ||
    !Array.isArray(input.events) ||
    !Array.isArray(input.relations) ||
    input.events.length > MAXIMUM_EVENTS ||
    input.relations.length > MAXIMUM_RELATIONS
  ) {
    throw invalidInput("Causal graph collection bounds are invalid.");
  }

  const eventIds = new Set<string>();
  const componentIds = new Set<string>();
  const evidenceById = new Map<string, CausalTextEvidence>();
  const events = input.events.map((event: unknown) =>
    validateEvent(event, eventIds, componentIds, evidenceById),
  );
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const relationIds = new Set<string>();
  const relationSignatures = new Set<string>();
  const relations = input.relations.map((relation: unknown) =>
    validateRelation(relation, relationIds, relationSignatures, evidenceById, eventsById),
  );

  validateEventReferences(events, relations, eventsById);
  const sortedEvents = Object.freeze(
    [...events].sort((left, right) => left.id.localeCompare(right.id)),
  );
  const sortedRelations = Object.freeze([...relations].sort(compareRelations));
  const outgoing = new Map<string, CausalEventRelation[]>();
  for (const relation of sortedRelations) {
    const bucket = outgoing.get(relation.fromEventId) ?? [];
    bucket.push(relation);
    outgoing.set(relation.fromEventId, bucket);
  }
  const frozenOutgoing = new Map<string, readonly CausalEventRelation[]>();
  for (const [eventId, bucket] of outgoing) {
    frozenOutgoing.set(eventId, Object.freeze(bucket));
  }
  return Object.freeze({
    events: sortedEvents,
    relations: sortedRelations,
    eventsById,
    outgoingByEventId: frozenOutgoing,
  });
}

function validateEvent(
  value: unknown,
  eventIds: Set<string>,
  componentIds: Set<string>,
  evidenceById: Map<string, CausalTextEvidence>,
): CausalEventNode {
  if (
    !isRecord(value) ||
    !registerUniqueReference(value.id, eventIds) ||
    !isSafeReference(value.projectId) ||
    !isSafeReference(value.branchId) ||
    value.status !== "confirmed" ||
    !Array.isArray(value.participantCharacterIds) ||
    value.participantCharacterIds.length > MAXIMUM_PARTICIPANTS ||
    !Array.isArray(value.prerequisites) ||
    value.prerequisites.length > MAXIMUM_EVENT_COLLECTION ||
    !isBoundedText(value.eventText, MAXIMUM_TEXT_CHARACTERS) ||
    !isBoundedText(value.resultText, MAXIMUM_TEXT_CHARACTERS) ||
    !Array.isArray(value.characterStateChanges) ||
    value.characterStateChanges.length > MAXIMUM_EVENT_COLLECTION ||
    !Array.isArray(value.relationshipChanges) ||
    value.relationshipChanges.length > MAXIMUM_EVENT_COLLECTION ||
    !Array.isArray(value.itemChanges) ||
    value.itemChanges.length > MAXIMUM_EVENT_COLLECTION ||
    !Array.isArray(value.informedCharacterIds) ||
    value.informedCharacterIds.length > MAXIMUM_PARTICIPANTS ||
    !Array.isArray(value.foreshadowProgress) ||
    value.foreshadowProgress.length > MAXIMUM_EVENT_COLLECTION ||
    !Array.isArray(value.downstreamEventIds) ||
    value.downstreamEventIds.length > MAXIMUM_EVENT_COLLECTION
  ) {
    throw invalidInput("A causal event node is invalid.");
  }

  return Object.freeze({
    id: value.id,
    projectId: value.projectId,
    branchId: value.branchId,
    status: "confirmed",
    participantCharacterIds: validateUniqueReferences(
      value.participantCharacterIds,
      "Causal event participants",
    ),
    narrativeTime: validateNarrativeTime(value.narrativeTime),
    location: validateLocation(value.location),
    prerequisites: Object.freeze(
      value.prerequisites.map((prerequisite: unknown) =>
        validatePrerequisite(prerequisite, componentIds, evidenceById),
      ),
    ),
    eventText: value.eventText,
    resultText: value.resultText,
    characterStateChanges: Object.freeze(
      value.characterStateChanges.map((change: unknown) =>
        validateCharacterChange(change, componentIds, evidenceById),
      ),
    ),
    relationshipChanges: Object.freeze(
      value.relationshipChanges.map((change: unknown) =>
        validateRelationshipChange(change, componentIds, evidenceById),
      ),
    ),
    itemChanges: Object.freeze(
      value.itemChanges.map((change: unknown) =>
        validateItemChange(change, componentIds, evidenceById),
      ),
    ),
    informedCharacterIds: validateUniqueReferences(
      value.informedCharacterIds,
      "Causal event informed characters",
    ),
    foreshadowProgress: Object.freeze(
      value.foreshadowProgress.map((progress: unknown) =>
        validateForeshadowProgress(progress, componentIds, evidenceById),
      ),
    ),
    downstreamEventIds: validateUniqueReferences(
      value.downstreamEventIds,
      "Causal event downstream impacts",
    ),
    evidence: validateEvidence(value.evidence, evidenceById),
  });
}

function validateNarrativeTime(value: unknown): CausalNarrativeTime {
  if (
    !isRecord(value) ||
    typeof value.order !== "number" ||
    !Number.isSafeInteger(value.order) ||
    Math.abs(value.order) > MAXIMUM_STORY_ORDER ||
    !isBoundedText(value.label, MAXIMUM_DESCRIPTION_CHARACTERS)
  ) {
    throw invalidInput("Causal event narrative time is invalid.");
  }
  return Object.freeze({ order: value.order, label: value.label });
}

function validateLocation(value: unknown): CausalEventLocation {
  if (
    !isRecord(value) ||
    !isSafeReference(value.locationId) ||
    !isBoundedText(value.label, MAXIMUM_DESCRIPTION_CHARACTERS)
  ) {
    throw invalidInput("Causal event location is invalid.");
  }
  return Object.freeze({ locationId: value.locationId, label: value.label });
}

function validatePrerequisite(
  value: unknown,
  componentIds: Set<string>,
  evidenceById: Map<string, CausalTextEvidence>,
): CausalEventPrerequisite {
  if (
    !isRecord(value) ||
    !registerUniqueReference(value.id, componentIds) ||
    !PREREQUISITE_KINDS.includes(value.kind as CausalPrerequisiteKind) ||
    !isSafeReference(value.referenceId) ||
    !isOptionalBoundedText(value.referenceLabel, MAXIMUM_DESCRIPTION_CHARACTERS) ||
    !isBoundedText(value.description, MAXIMUM_DESCRIPTION_CHARACTERS)
  ) {
    throw invalidInput("A causal event prerequisite is invalid.");
  }
  return Object.freeze({
    id: value.id,
    kind: value.kind as CausalPrerequisiteKind,
    referenceId: value.referenceId,
    ...(value.referenceLabel === undefined ? {} : { referenceLabel: value.referenceLabel }),
    description: value.description,
    evidence: validateEvidence(value.evidence, evidenceById),
  });
}

function validateCharacterChange(
  value: unknown,
  componentIds: Set<string>,
  evidenceById: Map<string, CausalTextEvidence>,
): CausalCharacterStateChange {
  if (
    !isRecord(value) ||
    !registerUniqueReference(value.id, componentIds) ||
    !isSafeReference(value.characterId) ||
    !isSafeReference(value.attributeKey) ||
    !isOptionalBoundedText(value.attributeLabel, MAXIMUM_DESCRIPTION_CHARACTERS) ||
    !isStateValue(value.beforeValue) ||
    !isStateValue(value.afterValue) ||
    stateValuesEqual(value.beforeValue, value.afterValue)
  ) {
    throw invalidInput("A causal character state change is invalid.");
  }
  return Object.freeze({
    id: value.id,
    characterId: value.characterId,
    attributeKey: value.attributeKey,
    ...(value.attributeLabel === undefined ? {} : { attributeLabel: value.attributeLabel }),
    beforeValue: normalizeStateValue(value.beforeValue),
    afterValue: normalizeStateValue(value.afterValue),
    evidence: validateEvidence(value.evidence, evidenceById),
  });
}

function validateRelationshipChange(
  value: unknown,
  componentIds: Set<string>,
  evidenceById: Map<string, CausalTextEvidence>,
): CausalRelationshipChange {
  if (
    !isRecord(value) ||
    !registerUniqueReference(value.id, componentIds) ||
    !isSafeReference(value.fromCharacterId) ||
    !isSafeReference(value.toCharacterId) ||
    value.fromCharacterId === value.toCharacterId ||
    !isSafeReference(value.relationshipKey) ||
    !isOptionalBoundedText(value.relationshipLabel, MAXIMUM_DESCRIPTION_CHARACTERS) ||
    !isStateValue(value.beforeValue) ||
    !isStateValue(value.afterValue) ||
    stateValuesEqual(value.beforeValue, value.afterValue)
  ) {
    throw invalidInput("A causal relationship change is invalid.");
  }
  return Object.freeze({
    id: value.id,
    fromCharacterId: value.fromCharacterId,
    toCharacterId: value.toCharacterId,
    relationshipKey: value.relationshipKey,
    ...(value.relationshipLabel === undefined
      ? {}
      : { relationshipLabel: value.relationshipLabel }),
    beforeValue: normalizeStateValue(value.beforeValue),
    afterValue: normalizeStateValue(value.afterValue),
    evidence: validateEvidence(value.evidence, evidenceById),
  });
}

function validateItemChange(
  value: unknown,
  componentIds: Set<string>,
  evidenceById: Map<string, CausalTextEvidence>,
): CausalItemChange {
  if (
    !isRecord(value) ||
    !registerUniqueReference(value.id, componentIds) ||
    !isSafeReference(value.itemId) ||
    !isOptionalBoundedText(value.itemLabel, MAXIMUM_DESCRIPTION_CHARACTERS) ||
    !ITEM_CHANGE_KINDS.includes(value.kind as CausalItemChangeKind) ||
    !isNullableSafeReference(value.fromCharacterId) ||
    !isNullableSafeReference(value.toCharacterId) ||
    !itemEndpointsAreValid(
      value.kind as CausalItemChangeKind,
      value.fromCharacterId,
      value.toCharacterId,
    )
  ) {
    throw invalidInput("A causal item change is invalid.");
  }
  return Object.freeze({
    id: value.id,
    itemId: value.itemId,
    ...(value.itemLabel === undefined ? {} : { itemLabel: value.itemLabel }),
    kind: value.kind as CausalItemChangeKind,
    fromCharacterId: value.fromCharacterId,
    toCharacterId: value.toCharacterId,
    evidence: validateEvidence(value.evidence, evidenceById),
  });
}

function validateForeshadowProgress(
  value: unknown,
  componentIds: Set<string>,
  evidenceById: Map<string, CausalTextEvidence>,
): CausalForeshadowProgress {
  if (
    !isRecord(value) ||
    !registerUniqueReference(value.id, componentIds) ||
    !isSafeReference(value.foreshadowId) ||
    !isOptionalBoundedText(value.foreshadowLabel, MAXIMUM_DESCRIPTION_CHARACTERS) ||
    !FORESHADOW_CHANGE_KINDS.includes(value.kind as CausalForeshadowChangeKind) ||
    !isBoundedText(value.description, MAXIMUM_DESCRIPTION_CHARACTERS)
  ) {
    throw invalidInput("Causal foreshadow progress is invalid.");
  }
  return Object.freeze({
    id: value.id,
    foreshadowId: value.foreshadowId,
    ...(value.foreshadowLabel === undefined ? {} : { foreshadowLabel: value.foreshadowLabel }),
    kind: value.kind as CausalForeshadowChangeKind,
    description: value.description,
    evidence: validateEvidence(value.evidence, evidenceById),
  });
}

function validateRelation(
  value: unknown,
  relationIds: Set<string>,
  relationSignatures: Set<string>,
  evidenceById: Map<string, CausalTextEvidence>,
  eventsById: ReadonlyMap<string, CausalEventNode>,
): CausalEventRelation {
  if (
    !isRecord(value) ||
    !registerUniqueReference(value.id, relationIds) ||
    !isSafeReference(value.projectId) ||
    !isSafeReference(value.branchId) ||
    !isSafeReference(value.fromEventId) ||
    !isSafeReference(value.toEventId) ||
    value.fromEventId === value.toEventId ||
    !CAUSAL_EVENT_RELATION_KINDS.includes(value.kind as CausalEventRelationKind)
  ) {
    throw invalidInput("A causal event relation is invalid.");
  }
  const from = eventsById.get(value.fromEventId);
  const to = eventsById.get(value.toEventId);
  if (
    from === undefined ||
    to === undefined ||
    from.projectId !== value.projectId ||
    to.projectId !== value.projectId ||
    from.branchId !== value.branchId ||
    to.branchId !== value.branchId
  ) {
    throw invalidInput("Causal relations cannot cross a project or story branch.");
  }
  if (value.kind === "before" && from.narrativeTime.order >= to.narrativeTime.order) {
    throw invalidInput("A before relation must follow strict narrative order.");
  }
  const signature = `${value.projectId}\u0000${value.branchId}\u0000${value.fromEventId}\u0000${value.toEventId}\u0000${String(value.kind)}`;
  if (relationSignatures.has(signature)) {
    throw invalidInput("A causal relation cannot be duplicated.");
  }
  relationSignatures.add(signature);
  return Object.freeze({
    id: value.id,
    projectId: value.projectId,
    branchId: value.branchId,
    fromEventId: value.fromEventId,
    toEventId: value.toEventId,
    kind: value.kind as CausalEventRelationKind,
    evidence: validateEvidence(value.evidence, evidenceById),
  });
}

function validateEventReferences(
  events: readonly CausalEventNode[],
  relations: readonly CausalEventRelation[],
  eventsById: ReadonlyMap<string, CausalEventNode>,
): void {
  const relationsByPair = new Map<string, CausalEventRelation[]>();
  const impactTargetsBySource = new Map<string, Set<string>>();
  for (const relation of relations) {
    const key = pairKey(relation.fromEventId, relation.toEventId);
    const bucket = relationsByPair.get(key) ?? [];
    bucket.push(relation);
    relationsByPair.set(key, bucket);
    if (isImpactRelationKind(relation.kind)) {
      const targets = impactTargetsBySource.get(relation.fromEventId) ?? new Set<string>();
      targets.add(relation.toEventId);
      impactTargetsBySource.set(relation.fromEventId, targets);
    }
  }

  for (const event of events) {
    for (const prerequisite of event.prerequisites) {
      if (prerequisite.kind !== "event") {
        continue;
      }
      const referenced = eventsById.get(prerequisite.referenceId);
      const incoming = relationsByPair.get(pairKey(prerequisite.referenceId, event.id)) ?? [];
      if (
        referenced?.projectId !== event.projectId ||
        referenced.branchId !== event.branchId ||
        !incoming.some(({ kind }) => isImpactRelationKind(kind))
      ) {
        throw invalidInput(
          "An event prerequisite must have an evidence-backed incoming impact relation in the same branch.",
        );
      }
    }

    const declared = new Set(event.downstreamEventIds);
    for (const downstreamEventId of declared) {
      const referenced = eventsById.get(downstreamEventId);
      const outgoing = relationsByPair.get(pairKey(event.id, downstreamEventId)) ?? [];
      if (
        referenced?.projectId !== event.projectId ||
        referenced.branchId !== event.branchId ||
        !outgoing.some(({ kind }) => isImpactRelationKind(kind))
      ) {
        throw invalidInput(
          "A declared downstream event must have an evidence-backed impact relation in the same branch.",
        );
      }
    }
    for (const relationTarget of impactTargetsBySource.get(event.id) ?? []) {
      if (!declared.has(relationTarget)) {
        throw invalidInput("Every direct impact relation must be declared by its source event.");
      }
    }
  }
}

function validateEvidence(
  value: unknown,
  evidenceById: Map<string, CausalTextEvidence>,
): CausalTextEvidence {
  if (
    !isRecord(value) ||
    !isSafeReference(value.id) ||
    !isSafeReference(value.chapterId) ||
    !isSafeReference(value.chapterVersionId) ||
    typeof value.contentHash !== "string" ||
    !SHA256_PATTERN.test(value.contentHash) ||
    !isBoundedText(value.locator, MAXIMUM_LOCATOR_CHARACTERS) ||
    !isBoundedText(value.excerpt, MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS) ||
    typeof value.startOffset !== "number" ||
    !Number.isSafeInteger(value.startOffset) ||
    typeof value.endOffset !== "number" ||
    !Number.isSafeInteger(value.endOffset) ||
    typeof value.sourceLength !== "number" ||
    !Number.isSafeInteger(value.sourceLength) ||
    value.startOffset < 0 ||
    value.endOffset <= value.startOffset ||
    value.endOffset > value.sourceLength ||
    value.sourceLength > MAXIMUM_EVIDENCE_SOURCE_CHARACTERS ||
    value.excerpt.length !== value.endOffset - value.startOffset
  ) {
    throw invalidInput("Causal graph evidence must use an exact immutable chapter-version span.");
  }
  const evidence = Object.freeze({
    id: value.id,
    chapterId: value.chapterId,
    chapterVersionId: value.chapterVersionId,
    contentHash: value.contentHash,
    locator: value.locator,
    excerpt: value.excerpt,
    startOffset: value.startOffset,
    endOffset: value.endOffset,
    sourceLength: value.sourceLength,
  });
  const existing = evidenceById.get(evidence.id);
  if (existing !== undefined) {
    if (!evidenceEquals(existing, evidence)) {
      throw invalidInput("A causal evidence id cannot identify different source spans.");
    }
    return existing;
  }
  evidenceById.set(evidence.id, evidence);
  return evidence;
}

function validateTraceRequest(
  value: CausalImpactTraceRequest,
  eventsById: ReadonlyMap<string, CausalEventNode>,
): Readonly<{
  projectId: string;
  branchId: string;
  changedEventIds: readonly string[];
  maximumDepth: number;
  maximumImpactedEvents: number;
}> {
  if (
    !isRecord(value) ||
    !isSafeReference(value.projectId) ||
    !isSafeReference(value.branchId) ||
    !Array.isArray(value.changedEventIds) ||
    value.changedEventIds.length < 1 ||
    value.changedEventIds.length > MAXIMUM_EVENTS
  ) {
    throw invalidInput("A causal impact trace request is invalid.");
  }
  const changedEventIds = validateUniqueReferences(
    value.changedEventIds,
    "Causal impact changed events",
  );
  for (const eventId of changedEventIds) {
    const event = eventsById.get(eventId);
    if (event?.projectId !== value.projectId || event.branchId !== value.branchId) {
      throw invalidInput("Every changed event must exist in the requested project and branch.");
    }
  }
  const maximumDepth = value.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH;
  const maximumImpactedEvents = value.maximumImpactedEvents ?? DEFAULT_MAXIMUM_IMPACTED_EVENTS;
  if (
    !Number.isSafeInteger(maximumDepth) ||
    maximumDepth < 0 ||
    maximumDepth > MAXIMUM_TRACE_DEPTH ||
    !Number.isSafeInteger(maximumImpactedEvents) ||
    maximumImpactedEvents < 1 ||
    maximumImpactedEvents > MAXIMUM_EVENTS
  ) {
    throw invalidInput("Causal impact traversal limits are invalid.");
  }
  return Object.freeze({
    projectId: value.projectId,
    branchId: value.branchId,
    changedEventIds: Object.freeze([...changedEventIds].sort()),
    maximumDepth,
    maximumImpactedEvents,
  });
}

function freezeImpactReason(relation: CausalEventRelation): CausalImpactReason {
  if (!isImpactRelationKind(relation.kind)) {
    throw invalidInput("A temporal-only relation cannot be an impact reason.");
  }
  return Object.freeze({
    relationId: relation.id,
    kind: relation.kind,
    fromEventId: relation.fromEventId,
    toEventId: relation.toEventId,
    evidence: relation.evidence,
  });
}

function validateUniqueReferences(value: readonly unknown[], context: string): readonly string[] {
  const references: string[] = [];
  const unique = new Set<string>();
  for (const candidate of value) {
    if (!isSafeReference(candidate) || unique.has(candidate)) {
      throw invalidInput(`${context} must contain unique safe references.`);
    }
    unique.add(candidate);
    references.push(candidate);
  }
  return Object.freeze(references);
}

function itemEndpointsAreValid(
  kind: CausalItemChangeKind,
  fromCharacterId: string | null,
  toCharacterId: string | null,
): boolean {
  switch (kind) {
    case "acquired":
      return fromCharacterId === null && toCharacterId !== null;
    case "lost":
      return fromCharacterId !== null && toCharacterId === null;
    case "transferred":
      return (
        fromCharacterId !== null && toCharacterId !== null && fromCharacterId !== toCharacterId
      );
    case "created":
      return fromCharacterId === null;
    case "destroyed":
      return toCharacterId === null;
  }
}

function evidenceEquals(left: CausalTextEvidence, right: CausalTextEvidence): boolean {
  return (
    left.id === right.id &&
    left.chapterId === right.chapterId &&
    left.chapterVersionId === right.chapterVersionId &&
    left.contentHash === right.contentHash &&
    left.locator === right.locator &&
    left.excerpt === right.excerpt &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset &&
    left.sourceLength === right.sourceLength
  );
}

function stateValuesEqual(left: CausalStateValue, right: CausalStateValue): boolean {
  return Object.is(normalizeStateValue(left), normalizeStateValue(right));
}

function normalizeStateValue(value: CausalStateValue): CausalStateValue {
  return typeof value === "number" && Object.is(value, -0) ? 0 : value;
}

function isStateValue(value: unknown): value is CausalStateValue {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length <= 16_000 &&
      !CONTROL_CHARACTER_PATTERN.test(value)) ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isImpactRelationKind(value: CausalEventRelationKind): value is CausalImpactRelationKind {
  return IMPACT_KIND_SET.has(value);
}

function compareRelations(left: CausalEventRelation, right: CausalEventRelation): number {
  return (
    left.fromEventId.localeCompare(right.fromEventId) ||
    left.toEventId.localeCompare(right.toEventId) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

function compareImpactReasons(left: CausalImpactReason, right: CausalImpactReason): number {
  return (
    left.fromEventId.localeCompare(right.fromEventId) ||
    left.kind.localeCompare(right.kind) ||
    left.relationId.localeCompare(right.relationId)
  );
}

function compareCycleEdges(left: CausalCycleEdge, right: CausalCycleEdge): number {
  return (
    left.fromEventId.localeCompare(right.fromEventId) ||
    left.toEventId.localeCompare(right.toEventId) ||
    left.relationId.localeCompare(right.relationId)
  );
}

function pairKey(fromEventId: string, toEventId: string): string {
  return `${fromEventId}\u0000${toEventId}`;
}

function registerUniqueReference(value: unknown, references: Set<string>): value is string {
  if (!isSafeReference(value) || references.has(value)) {
    return false;
  }
  references.add(value);
  return true;
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isOptionalBoundedText(value: unknown, maximumLength: number): value is string | undefined {
  return value === undefined || isBoundedText(value, maximumLength);
}

function isSafeReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_REFERENCE_CHARACTERS &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function isNullableSafeReference(value: unknown): value is string | null {
  return value === null || isSafeReference(value);
}

function invalidInput(message: string): CausalEventGraphInputError {
  return new CausalEventGraphInputError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
