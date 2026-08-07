import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import {
  CausalEventGraph,
  CausalEventGraphInputError,
  type CausalEventGraphInput,
  type CausalEventNode,
  type CausalEventPrerequisite,
  type CausalEventRelation,
  type CausalEventRelationKind,
  type CausalForeshadowProgress,
  type CausalImpactTraceRequest,
  type CausalImpactTraceResult,
  type CausalItemChange,
  type CausalStateValue,
  type CausalTextEvidence,
} from "@inkshadow/story-core";

export const DEVELOPMENT_CAUSAL_EVENT_GRAPH_STORE_KEY =
  "inkshadow.development.causal-event-graphs.v1";

export interface CausalChapterVersionSource {
  readonly chapterVersionId: string;
  readonly projectId: string;
  readonly chapterId: string;
  /** Immutable chapter-version text. JavaScript string offsets are UTF-16 code units. */
  readonly content: string;
  /** When supplied, this persisted checksum must also match the calculated SHA-256. */
  readonly contentChecksum?: string;
}

export interface CausalEvidenceReader {
  readChapterVersion(chapterVersionId: string): Promise<CausalChapterVersionSource | null>;
}

export interface CausalEventGraphWriteRequest {
  readonly projectId: string;
  readonly branchId: string;
  readonly graph: CausalEventGraphInput;
}

export interface CausalEventGraphStore {
  /**
   * Atomically replaces one branch. The requested branch is the overwrite boundary;
   * identifiers already owned by another project/branch are strict conflicts.
   */
  replace(request: CausalEventGraphWriteRequest): Promise<CausalEventGraph>;

  /**
   * Atomically appends new event/relation/component identifiers. Any identifier or
   * semantic relation already present is a conflict and the whole append is rejected.
   * New relations may point from an existing event to a newly appended event.
   */
  append(request: CausalEventGraphWriteRequest): Promise<CausalEventGraph>;

  loadProjectBranch(projectId: string, branchId: string): Promise<CausalEventGraph>;
  traceImpacts(request: CausalImpactTraceRequest): Promise<CausalImpactTraceResult>;
}

export type CausalEventGraphStoreErrorCode =
  | "CAUSAL_GRAPH_INVALID"
  | "CAUSAL_GRAPH_CONFLICT"
  | "CAUSAL_GRAPH_EVIDENCE_INVALID"
  | "CAUSAL_GRAPH_EVIDENCE_UNAVAILABLE"
  | "CAUSAL_GRAPH_CORRUPT"
  | "CAUSAL_GRAPH_UNAVAILABLE";

export class CausalEventGraphStoreError extends Error {
  public constructor(
    readonly code: CausalEventGraphStoreErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CausalEventGraphStoreError";
  }
}

export interface SqliteCausalEventGraphStoreOptions {
  readonly now?: () => string;
}

interface BrowserGraphDatabase {
  readonly schemaVersion: 1;
  readonly branches: Readonly<Record<string, CausalEventGraphInput>>;
}

interface EvidenceRow {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly contentHash: string;
  readonly locator: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
}

interface ChapterVersionRow {
  readonly chapterVersionId: string;
  readonly versionProjectId: string;
  readonly versionChapterId: string;
  readonly chapterProjectId: string;
  readonly content: string;
  readonly contentChecksum: string;
}

interface EventRow {
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly status: string;
  readonly narrativeOrder: number;
  readonly narrativeLabel: string;
  readonly locationId: string;
  readonly locationLabel: string;
  readonly eventText: string;
  readonly resultText: string;
  readonly evidenceId: string;
}

interface ParticipantRow {
  readonly eventId: string;
  readonly characterId: string;
}

interface PrerequisiteRow {
  readonly id: string;
  readonly eventId: string;
  readonly prerequisiteKind: string;
  readonly referenceId: string;
  readonly referencedEventId: string | null;
  readonly description: string;
  readonly evidenceId: string;
}

interface CharacterChangeRow {
  readonly id: string;
  readonly eventId: string;
  readonly characterId: string;
  readonly attributeKey: string;
  readonly beforeValueJson: string;
  readonly afterValueJson: string;
  readonly evidenceId: string;
}

interface RelationshipChangeRow {
  readonly id: string;
  readonly eventId: string;
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly relationshipKey: string;
  readonly beforeValueJson: string;
  readonly afterValueJson: string;
  readonly evidenceId: string;
}

interface ItemChangeRow {
  readonly id: string;
  readonly eventId: string;
  readonly itemId: string;
  readonly changeKind: string;
  readonly fromCharacterId: string | null;
  readonly toCharacterId: string | null;
  readonly evidenceId: string;
}

interface InformedCharacterRow {
  readonly eventId: string;
  readonly characterId: string;
}

interface ForeshadowProgressRow {
  readonly id: string;
  readonly eventId: string;
  readonly foreshadowId: string;
  readonly progressKind: string;
  readonly description: string;
  readonly evidenceId: string;
}

interface RelationRow {
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly fromEventId: string;
  readonly toEventId: string;
  readonly relationKind: string;
  readonly evidenceId: string;
}

const SCHEMA_VERSION = 1;
const MAXIMUM_REFERENCE_CHARACTERS = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IMPACT_RELATION_KINDS = new Set<CausalEventRelationKind>([
  "causes",
  "depends_on",
  "prevents",
  "reveals",
  "misleads",
  "changes_state",
  "gains_information",
  "loses_item",
]);

export class SqliteCausalEventGraphStore implements CausalEventGraphStore {
  readonly #now: () => string;

  public constructor(
    private readonly executor: SqlExecutor,
    options: SqliteCausalEventGraphStoreOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async replace(requestValue: CausalEventGraphWriteRequest): Promise<CausalEventGraph> {
    try {
      const request = validateWriteRequestShell(requestValue);
      const graph = validateReplacementGraph(request);
      return await this.executor.transaction(async (transaction) => {
        await verifyGraphEvidence(
          graph,
          request.projectId,
          new SqliteCausalEvidenceReader(transaction),
        );
        const timestamp = validateTimestamp(this.#now());
        await transaction.execute(
          "DELETE FROM causal_events WHERE project_id = ? AND branch_id = ?",
          [request.projectId, request.branchId],
        );
        await persistGraphParts(
          transaction,
          request.projectId,
          graph.events,
          graph.relations,
          timestamp,
        );
        await pruneUnreferencedEvidence(transaction, request.projectId);
        return graph;
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to replace the causal event graph branch.");
    }
  }

  public async append(requestValue: CausalEventGraphWriteRequest): Promise<CausalEventGraph> {
    try {
      const request = validateWriteRequestShell(requestValue);
      return await this.executor.transaction(async (transaction) => {
        const current = await readSqlGraph(transaction, request.projectId, request.branchId);
        const appended = mergeAppend(current, request);
        await verifyGraphEvidence(
          appended.graph,
          request.projectId,
          new SqliteCausalEvidenceReader(transaction),
        );
        await persistGraphParts(
          transaction,
          request.projectId,
          appended.appendedEvents,
          appended.appendedRelations,
          validateTimestamp(this.#now()),
        );
        return appended.graph;
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to append to the causal event graph branch.");
    }
  }

  public async loadProjectBranch(
    projectIdValue: string,
    branchIdValue: string,
  ): Promise<CausalEventGraph> {
    try {
      const { projectId, branchId } = validateScope(projectIdValue, branchIdValue);
      const graph = await readSqlGraph(this.executor, projectId, branchId);
      await verifyGraphEvidence(graph, projectId, new SqliteCausalEvidenceReader(this.executor));
      return graph;
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to load the causal event graph branch.");
    }
  }

  public async traceImpacts(request: CausalImpactTraceRequest): Promise<CausalImpactTraceResult> {
    try {
      const { projectId, branchId } = validateScope(request.projectId, request.branchId);
      const graph = await this.loadProjectBranch(projectId, branchId);
      return graph.traceImpacts(request);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to trace causal event impacts.");
    }
  }
}

export class BrowserDevelopmentCausalEventGraphStore implements CausalEventGraphStore {
  public constructor(
    private readonly storage: Storage,
    private readonly evidenceReader: CausalEvidenceReader,
  ) {}

  public async replace(requestValue: CausalEventGraphWriteRequest): Promise<CausalEventGraph> {
    try {
      const request = validateWriteRequestShell(requestValue);
      const graph = validateReplacementGraph(request);
      await verifyGraphEvidence(graph, request.projectId, this.evidenceReader);
      const database = readBrowserDatabase(this.storage);
      assertNoForeignBrowserConflicts(
        database,
        branchKey(request.projectId, request.branchId),
        graph,
      );
      writeBrowserDatabase(this.storage, {
        schemaVersion: SCHEMA_VERSION,
        branches: {
          ...database.branches,
          [branchKey(request.projectId, request.branchId)]: graphInput(graph),
        },
      });
      return graph;
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to replace the browser causal event graph branch.");
    }
  }

  public async append(requestValue: CausalEventGraphWriteRequest): Promise<CausalEventGraph> {
    try {
      const request = validateWriteRequestShell(requestValue);
      const database = readBrowserDatabase(this.storage);
      const key = branchKey(request.projectId, request.branchId);
      const current = graphFromStoredInput(
        database.branches[key] ?? { events: [], relations: [] },
        request.projectId,
        request.branchId,
      );
      const appended = mergeAppend(current, request);
      await verifyGraphEvidence(appended.graph, request.projectId, this.evidenceReader);
      assertNoForeignBrowserConflicts(database, key, appended.graph);
      writeBrowserDatabase(this.storage, {
        schemaVersion: SCHEMA_VERSION,
        branches: { ...database.branches, [key]: graphInput(appended.graph) },
      });
      return appended.graph;
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to append to the browser causal event graph branch.");
    }
  }

  public async loadProjectBranch(
    projectIdValue: string,
    branchIdValue: string,
  ): Promise<CausalEventGraph> {
    try {
      const { projectId, branchId } = validateScope(projectIdValue, branchIdValue);
      const input = readBrowserDatabase(this.storage).branches[branchKey(projectId, branchId)] ?? {
        events: [],
        relations: [],
      };
      const graph = graphFromStoredInput(input, projectId, branchId);
      await verifyGraphEvidence(graph, projectId, this.evidenceReader);
      return graph;
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to load the browser causal event graph branch.");
    }
  }

  public async traceImpacts(request: CausalImpactTraceRequest): Promise<CausalImpactTraceResult> {
    try {
      const graph = await this.loadProjectBranch(request.projectId, request.branchId);
      return graph.traceImpacts(request);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "Unable to trace browser causal event impacts.");
    }
  }
}

class SqliteCausalEvidenceReader implements CausalEvidenceReader {
  public constructor(private readonly executor: Pick<TransactionExecutor, "select">) {}

  public async readChapterVersion(
    chapterVersionId: string,
  ): Promise<CausalChapterVersionSource | null> {
    const rows = await this.executor.select<ChapterVersionRow>(
      `SELECT
         version.id AS chapterVersionId,
         version.project_id AS versionProjectId,
         version.chapter_id AS versionChapterId,
         chapter.project_id AS chapterProjectId,
         version.content,
         version.content_checksum AS contentChecksum
       FROM chapter_versions AS version
       INNER JOIN chapters AS chapter ON chapter.id = version.chapter_id
       WHERE version.id = ?
       LIMIT 2`,
      [chapterVersionId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    if (
      rows.length !== 1 ||
      row.chapterVersionId !== chapterVersionId ||
      row.versionProjectId !== row.chapterProjectId
    ) {
      throw corruptGraph();
    }
    return Object.freeze({
      chapterVersionId: row.chapterVersionId,
      projectId: row.versionProjectId,
      chapterId: row.versionChapterId,
      content: row.content,
      contentChecksum: row.contentChecksum,
    });
  }
}

interface AppendMerge {
  readonly graph: CausalEventGraph;
  readonly appendedEvents: readonly CausalEventNode[];
  readonly appendedRelations: readonly CausalEventRelation[];
}

function mergeAppend(
  current: CausalEventGraph,
  request: CausalEventGraphWriteRequest,
): AppendMerge {
  assertInputScope(request.graph, request.projectId, request.branchId);
  const currentEventIds = new Set(current.events.map(({ id }) => id));
  const currentRelationIds = new Set(current.relations.map(({ id }) => id));
  const currentComponentIds = collectComponentIds(current.events);
  const currentRelationSignatures = new Set(current.relations.map(relationSignature));

  for (const value of request.graph.events) {
    if (!isRecord(value) || typeof value.id !== "string") {
      throw invalidGraph();
    }
    if (currentEventIds.has(value.id)) {
      throw graphConflict("Append cannot replace an existing causal event identifier.");
    }
    for (const componentId of collectRawComponentIds(value)) {
      if (currentComponentIds.has(componentId)) {
        throw graphConflict("Append cannot reuse an existing causal component identifier.");
      }
    }
  }
  for (const value of request.graph.relations) {
    if (!isRecord(value) || typeof value.id !== "string") {
      throw invalidGraph();
    }
    if (currentRelationIds.has(value.id)) {
      throw graphConflict("Append cannot replace an existing causal relation identifier.");
    }
    if (isRelationShape(value) && currentRelationSignatures.has(relationSignature(value))) {
      throw graphConflict("Append cannot duplicate an existing causal relation.");
    }
  }

  const allRelations = [...current.relations, ...request.graph.relations];
  const derivedDownstream = downstreamBySource(allRelations);
  const existingEvents = current.events.map((event) => ({
    ...event,
    downstreamEventIds: Object.freeze([...(derivedDownstream.get(event.id) ?? [])].sort()),
  }));
  const validated = CausalEventGraph.create({
    events: [...existingEvents, ...request.graph.events],
    relations: allRelations,
  });
  const graph = canonicalizeDownstream(validated);
  assertGraphScope(graph, request.projectId, request.branchId);
  const appendedEventIds = new Set(
    request.graph.events.map((event) => {
      if (!isRecord(event) || typeof event.id !== "string") {
        throw invalidGraph();
      }
      return event.id;
    }),
  );
  const appendedRelationIds = new Set(
    request.graph.relations.map((relation) => {
      if (!isRecord(relation) || typeof relation.id !== "string") {
        throw invalidGraph();
      }
      return relation.id;
    }),
  );
  return Object.freeze({
    graph,
    appendedEvents: Object.freeze(graph.events.filter(({ id }) => appendedEventIds.has(id))),
    appendedRelations: Object.freeze(
      graph.relations.filter(({ id }) => appendedRelationIds.has(id)),
    ),
  });
}

function validateWriteRequestShell(
  value: CausalEventGraphWriteRequest,
): CausalEventGraphWriteRequest {
  if (!isRecord(value) || !isRecord(value.graph)) {
    throw invalidGraph();
  }
  const { projectId, branchId } = validateScope(value.projectId, value.branchId);
  if (!Array.isArray(value.graph.events) || !Array.isArray(value.graph.relations)) {
    throw invalidGraph();
  }
  return { projectId, branchId, graph: value.graph };
}

function validateReplacementGraph(request: CausalEventGraphWriteRequest): CausalEventGraph {
  const graph = canonicalizeDownstream(CausalEventGraph.create(request.graph));
  assertGraphScope(graph, request.projectId, request.branchId);
  return graph;
}

function canonicalizeDownstream(graph: CausalEventGraph): CausalEventGraph {
  const downstream = downstreamBySource(graph.relations);
  return CausalEventGraph.create({
    events: graph.events.map((event) => ({
      ...event,
      downstreamEventIds: Object.freeze([...(downstream.get(event.id) ?? [])].sort()),
    })),
    relations: graph.relations,
  });
}

function graphFromStoredInput(
  input: CausalEventGraphInput,
  projectId: string,
  branchId: string,
): CausalEventGraph {
  try {
    const graph = CausalEventGraph.create(input);
    assertGraphScope(graph, projectId, branchId, true);
    return graph;
  } catch (cause: unknown) {
    if (cause instanceof CausalEventGraphStoreError) {
      throw cause;
    }
    throw corruptGraph();
  }
}

function assertInputScope(input: CausalEventGraphInput, projectId: string, branchId: string): void {
  for (const value of [...input.events, ...input.relations]) {
    if (!isRecord(value) || value.projectId !== projectId || value.branchId !== branchId) {
      throw invalidGraph("Causal graph writes cannot cross a project or story branch.");
    }
  }
}

function assertGraphScope(
  graph: CausalEventGraph,
  projectId: string,
  branchId: string,
  stored = false,
): void {
  if (
    graph.events.some((event) => event.projectId !== projectId || event.branchId !== branchId) ||
    graph.relations.some(
      (relation) => relation.projectId !== projectId || relation.branchId !== branchId,
    )
  ) {
    throw stored
      ? corruptGraph()
      : invalidGraph("Causal graph writes cannot cross a project or story branch.");
  }
}

async function verifyGraphEvidence(
  graph: CausalEventGraph,
  projectId: string,
  reader: CausalEvidenceReader,
): Promise<void> {
  const sourcesByVersion = new Map<string, Promise<CausalChapterVersionSource | null>>();
  const hashesByVersion = new Map<string, string>();
  for (const evidence of collectEvidence(graph.events, graph.relations).values()) {
    let sourcePromise = sourcesByVersion.get(evidence.chapterVersionId);
    if (sourcePromise === undefined) {
      sourcePromise = readEvidenceSource(reader, evidence.chapterVersionId);
      sourcesByVersion.set(evidence.chapterVersionId, sourcePromise);
    }
    const source = await sourcePromise;
    if (source === null) {
      throw invalidEvidence(
        "Causal evidence is not bound to the requested project and chapter version.",
      );
    }
    if (
      source.chapterVersionId !== evidence.chapterVersionId ||
      source.projectId !== projectId ||
      source.chapterId !== evidence.chapterId ||
      typeof source.content !== "string"
    ) {
      throw invalidEvidence(
        "Causal evidence is not bound to the requested project and chapter version.",
      );
    }
    let calculatedHash = hashesByVersion.get(source.chapterVersionId);
    if (calculatedHash === undefined) {
      calculatedHash = await sha256Hex(source.content);
      hashesByVersion.set(source.chapterVersionId, calculatedHash);
    }
    if (
      calculatedHash !== evidence.contentHash ||
      (source.contentChecksum !== undefined &&
        (!SHA256_PATTERN.test(source.contentChecksum) ||
          source.contentChecksum !== calculatedHash)) ||
      source.content.length !== evidence.sourceLength ||
      evidence.startOffset < 0 ||
      evidence.endOffset > source.content.length ||
      source.content.slice(evidence.startOffset, evidence.endOffset) !== evidence.excerpt
    ) {
      throw invalidEvidence(
        "Causal evidence hash, UTF-16 range, source length, or excerpt does not match the immutable chapter version.",
      );
    }
  }
}

async function readEvidenceSource(
  reader: CausalEvidenceReader,
  chapterVersionId: string,
): Promise<CausalChapterVersionSource | null> {
  try {
    return await reader.readChapterVersion(chapterVersionId);
  } catch (cause: unknown) {
    if (cause instanceof CausalEventGraphStoreError) {
      throw cause;
    }
    throw new CausalEventGraphStoreError(
      "CAUSAL_GRAPH_EVIDENCE_UNAVAILABLE",
      "The chapter-version source required for causal evidence could not be read.",
      true,
    );
  }
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function collectEvidence(
  events: readonly CausalEventNode[],
  relations: readonly CausalEventRelation[],
): ReadonlyMap<string, CausalTextEvidence> {
  const evidence = new Map<string, CausalTextEvidence>();
  const add = (source: CausalTextEvidence): void => {
    const current = evidence.get(source.id);
    if (current !== undefined && !sameEvidence(current, source)) {
      throw invalidGraph("A causal evidence identifier cannot refer to two source spans.");
    }
    evidence.set(source.id, source);
  };
  for (const event of events) {
    add(event.evidence);
    event.prerequisites.forEach((item) => add(item.evidence));
    event.characterStateChanges.forEach((item) => add(item.evidence));
    event.relationshipChanges.forEach((item) => add(item.evidence));
    event.itemChanges.forEach((item) => add(item.evidence));
    event.foreshadowProgress.forEach((item) => add(item.evidence));
  }
  relations.forEach((relation) => add(relation.evidence));
  return evidence;
}

async function persistGraphParts(
  transaction: TransactionExecutor,
  projectId: string,
  events: readonly CausalEventNode[],
  relations: readonly CausalEventRelation[],
  timestamp: string,
): Promise<void> {
  await persistEvidence(transaction, projectId, collectEvidence(events, relations), timestamp);
  for (const event of events) {
    await transaction.execute(
      `INSERT INTO causal_events (
         id, project_id, branch_id, status, narrative_order, narrative_label,
         location_id, location_label, event_text, result_text, evidence_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.projectId,
        event.branchId,
        event.status,
        event.narrativeTime.order,
        event.narrativeTime.label,
        event.location.locationId,
        event.location.label,
        event.eventText,
        event.resultText,
        event.evidence.id,
        timestamp,
        timestamp,
      ],
    );
  }
  for (const event of events) {
    await persistEventChildren(transaction, event);
  }
  for (const relation of relations) {
    await transaction.execute(
      `INSERT INTO causal_event_relations (
         id, project_id, branch_id, from_event_id, to_event_id,
         relation_kind, evidence_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        relation.id,
        relation.projectId,
        relation.branchId,
        relation.fromEventId,
        relation.toEventId,
        relation.kind,
        relation.evidence.id,
        timestamp,
      ],
    );
  }
}

async function persistEvidence(
  transaction: TransactionExecutor,
  projectId: string,
  evidence: ReadonlyMap<string, CausalTextEvidence>,
  timestamp: string,
): Promise<void> {
  for (const source of evidence.values()) {
    const existing = await transaction.select<EvidenceRow>(
      `${EVIDENCE_SELECT} WHERE id = ? LIMIT 1`,
      [source.id],
    );
    const row = existing[0];
    if (row !== undefined) {
      if (!sameEvidence(source, evidenceFromRow(row))) {
        throw graphConflict(
          "A causal evidence identifier is already bound to another source span.",
        );
      }
      continue;
    }
    await transaction.execute(
      `INSERT INTO causal_evidence_sources (
         id, project_id, chapter_id, chapter_version_id, content_hash,
         locator, excerpt, start_offset, end_offset, source_length, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        source.id,
        // Every graph part has already been scope-checked. Evidence has no project field.
        projectId,
        source.chapterId,
        source.chapterVersionId,
        source.contentHash,
        source.locator,
        source.excerpt,
        source.startOffset,
        source.endOffset,
        source.sourceLength,
        timestamp,
      ],
    );
  }
}

async function persistEventChildren(
  transaction: TransactionExecutor,
  event: CausalEventNode,
): Promise<void> {
  for (const characterId of event.participantCharacterIds) {
    await transaction.execute(
      `INSERT INTO causal_event_participants (
         event_id, project_id, branch_id, character_id
       ) VALUES (?, ?, ?, ?)`,
      [event.id, event.projectId, event.branchId, characterId],
    );
  }
  for (const prerequisite of event.prerequisites) {
    await transaction.execute(
      `INSERT INTO causal_event_prerequisites (
         id, event_id, project_id, branch_id, prerequisite_kind,
         reference_id, referenced_event_id, description, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prerequisite.id,
        event.id,
        event.projectId,
        event.branchId,
        prerequisite.kind,
        prerequisite.referenceId,
        prerequisite.kind === "event" ? prerequisite.referenceId : null,
        prerequisite.description,
        prerequisite.evidence.id,
      ],
    );
  }
  for (const change of event.characterStateChanges) {
    await transaction.execute(
      `INSERT INTO causal_event_character_changes (
         id, event_id, project_id, branch_id, character_id, attribute_key,
         before_value_json, after_value_json, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        change.id,
        event.id,
        event.projectId,
        event.branchId,
        change.characterId,
        change.attributeKey,
        JSON.stringify(change.beforeValue),
        JSON.stringify(change.afterValue),
        change.evidence.id,
      ],
    );
  }
  for (const change of event.relationshipChanges) {
    await transaction.execute(
      `INSERT INTO causal_event_relationship_changes (
         id, event_id, project_id, branch_id, from_character_id, to_character_id,
         relationship_key, before_value_json, after_value_json, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        change.id,
        event.id,
        event.projectId,
        event.branchId,
        change.fromCharacterId,
        change.toCharacterId,
        change.relationshipKey,
        JSON.stringify(change.beforeValue),
        JSON.stringify(change.afterValue),
        change.evidence.id,
      ],
    );
  }
  for (const change of event.itemChanges) {
    await transaction.execute(
      `INSERT INTO causal_event_item_changes (
         id, event_id, project_id, branch_id, item_id, change_kind,
         from_character_id, to_character_id, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        change.id,
        event.id,
        event.projectId,
        event.branchId,
        change.itemId,
        change.kind,
        change.fromCharacterId,
        change.toCharacterId,
        change.evidence.id,
      ],
    );
  }
  for (const characterId of event.informedCharacterIds) {
    await transaction.execute(
      `INSERT INTO causal_event_informed_characters (
         event_id, project_id, branch_id, character_id
       ) VALUES (?, ?, ?, ?)`,
      [event.id, event.projectId, event.branchId, characterId],
    );
  }
  for (const progress of event.foreshadowProgress) {
    await transaction.execute(
      `INSERT INTO causal_event_foreshadow_progress (
         id, event_id, project_id, branch_id, foreshadow_id,
         progress_kind, description, evidence_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        progress.id,
        event.id,
        event.projectId,
        event.branchId,
        progress.foreshadowId,
        progress.kind,
        progress.description,
        progress.evidence.id,
      ],
    );
  }
}

async function pruneUnreferencedEvidence(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<void> {
  await transaction.execute(
    `DELETE FROM causal_evidence_sources
     WHERE project_id = ?
       AND NOT EXISTS (SELECT 1 FROM causal_events WHERE evidence_id = causal_evidence_sources.id)
       AND NOT EXISTS (SELECT 1 FROM causal_event_prerequisites WHERE evidence_id = causal_evidence_sources.id)
       AND NOT EXISTS (SELECT 1 FROM causal_event_character_changes WHERE evidence_id = causal_evidence_sources.id)
       AND NOT EXISTS (SELECT 1 FROM causal_event_relationship_changes WHERE evidence_id = causal_evidence_sources.id)
       AND NOT EXISTS (SELECT 1 FROM causal_event_item_changes WHERE evidence_id = causal_evidence_sources.id)
       AND NOT EXISTS (SELECT 1 FROM causal_event_foreshadow_progress WHERE evidence_id = causal_evidence_sources.id)
       AND NOT EXISTS (SELECT 1 FROM causal_event_relations WHERE evidence_id = causal_evidence_sources.id)`,
    [projectId],
  );
}

async function readSqlGraph(
  executor: Pick<TransactionExecutor, "select">,
  projectId: string,
  branchId: string,
): Promise<CausalEventGraph> {
  const evidenceRows = await executor.select<EvidenceRow>(
    `${EVIDENCE_SELECT} WHERE project_id = ?`,
    [projectId],
  );
  const eventRows = await executor.select<EventRow>(
    `SELECT
       id, project_id AS projectId, branch_id AS branchId, status,
       narrative_order AS narrativeOrder, narrative_label AS narrativeLabel,
       location_id AS locationId, location_label AS locationLabel,
       event_text AS eventText, result_text AS resultText, evidence_id AS evidenceId
     FROM causal_events
     WHERE project_id = ? AND branch_id = ?
     ORDER BY narrative_order ASC, id ASC`,
    [projectId, branchId],
  );
  const participants = await executor.select<ParticipantRow>(
    `SELECT event_id AS eventId, character_id AS characterId
     FROM causal_event_participants
     WHERE project_id = ? AND branch_id = ?
     ORDER BY event_id ASC, character_id ASC`,
    [projectId, branchId],
  );
  const prerequisites = await executor.select<PrerequisiteRow>(
    `SELECT id, event_id AS eventId, prerequisite_kind AS prerequisiteKind,
       reference_id AS referenceId, referenced_event_id AS referencedEventId,
       description, evidence_id AS evidenceId
     FROM causal_event_prerequisites
     WHERE project_id = ? AND branch_id = ?
     ORDER BY event_id ASC, id ASC`,
    [projectId, branchId],
  );
  const characterChanges = await executor.select<CharacterChangeRow>(
    `SELECT id, event_id AS eventId, character_id AS characterId,
       attribute_key AS attributeKey, before_value_json AS beforeValueJson,
       after_value_json AS afterValueJson, evidence_id AS evidenceId
     FROM causal_event_character_changes
     WHERE project_id = ? AND branch_id = ?
     ORDER BY event_id ASC, id ASC`,
    [projectId, branchId],
  );
  const relationshipChanges = await executor.select<RelationshipChangeRow>(
    `SELECT id, event_id AS eventId, from_character_id AS fromCharacterId,
       to_character_id AS toCharacterId, relationship_key AS relationshipKey,
       before_value_json AS beforeValueJson, after_value_json AS afterValueJson,
       evidence_id AS evidenceId
     FROM causal_event_relationship_changes
     WHERE project_id = ? AND branch_id = ?
     ORDER BY event_id ASC, id ASC`,
    [projectId, branchId],
  );
  const itemChanges = await executor.select<ItemChangeRow>(
    `SELECT id, event_id AS eventId, item_id AS itemId, change_kind AS changeKind,
       from_character_id AS fromCharacterId, to_character_id AS toCharacterId,
       evidence_id AS evidenceId
     FROM causal_event_item_changes
     WHERE project_id = ? AND branch_id = ?
     ORDER BY event_id ASC, id ASC`,
    [projectId, branchId],
  );
  const informedCharacters = await executor.select<InformedCharacterRow>(
    `SELECT event_id AS eventId, character_id AS characterId
     FROM causal_event_informed_characters
     WHERE project_id = ? AND branch_id = ?
     ORDER BY event_id ASC, character_id ASC`,
    [projectId, branchId],
  );
  const foreshadowProgress = await executor.select<ForeshadowProgressRow>(
    `SELECT id, event_id AS eventId, foreshadow_id AS foreshadowId,
       progress_kind AS progressKind, description, evidence_id AS evidenceId
     FROM causal_event_foreshadow_progress
     WHERE project_id = ? AND branch_id = ?
     ORDER BY event_id ASC, id ASC`,
    [projectId, branchId],
  );
  const relationRows = await executor.select<RelationRow>(
    `SELECT id, project_id AS projectId, branch_id AS branchId,
       from_event_id AS fromEventId, to_event_id AS toEventId,
       relation_kind AS relationKind, evidence_id AS evidenceId
     FROM causal_event_relations
     WHERE project_id = ? AND branch_id = ?
     ORDER BY from_event_id ASC, to_event_id ASC, relation_kind ASC, id ASC`,
    [projectId, branchId],
  );

  try {
    const evidence = new Map(
      evidenceRows.map((row) => {
        const source = evidenceFromRow(row);
        return [source.id, source] as const;
      }),
    );
    const requireEvidence = (id: string): CausalTextEvidence => {
      const source = evidence.get(id);
      if (source === undefined) {
        throw corruptGraph();
      }
      return source;
    };
    const relations: readonly CausalEventRelation[] = relationRows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      branchId: row.branchId,
      fromEventId: row.fromEventId,
      toEventId: row.toEventId,
      kind: row.relationKind as CausalEventRelation["kind"],
      evidence: requireEvidence(row.evidenceId),
    }));
    const downstream = downstreamBySource(relations);
    const events: readonly CausalEventNode[] = eventRows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      branchId: row.branchId,
      status: row.status as CausalEventNode["status"],
      participantCharacterIds: rowsForEvent(participants, row.id).map(
        ({ characterId }) => characterId,
      ),
      narrativeTime: { order: row.narrativeOrder, label: row.narrativeLabel },
      location: { locationId: row.locationId, label: row.locationLabel },
      prerequisites: rowsForEvent(prerequisites, row.id).map((item) =>
        prerequisiteFromRow(item, requireEvidence),
      ),
      eventText: row.eventText,
      resultText: row.resultText,
      characterStateChanges: rowsForEvent(characterChanges, row.id).map((item) => ({
        id: item.id,
        characterId: item.characterId,
        attributeKey: item.attributeKey,
        beforeValue: parseStateValue(item.beforeValueJson),
        afterValue: parseStateValue(item.afterValueJson),
        evidence: requireEvidence(item.evidenceId),
      })),
      relationshipChanges: rowsForEvent(relationshipChanges, row.id).map((item) => ({
        id: item.id,
        fromCharacterId: item.fromCharacterId,
        toCharacterId: item.toCharacterId,
        relationshipKey: item.relationshipKey,
        beforeValue: parseStateValue(item.beforeValueJson),
        afterValue: parseStateValue(item.afterValueJson),
        evidence: requireEvidence(item.evidenceId),
      })),
      itemChanges: rowsForEvent(itemChanges, row.id).map((item) => ({
        id: item.id,
        itemId: item.itemId,
        kind: item.changeKind as CausalItemChange["kind"],
        fromCharacterId: item.fromCharacterId,
        toCharacterId: item.toCharacterId,
        evidence: requireEvidence(item.evidenceId),
      })),
      informedCharacterIds: rowsForEvent(informedCharacters, row.id).map(
        ({ characterId }) => characterId,
      ),
      foreshadowProgress: rowsForEvent(foreshadowProgress, row.id).map((item) => ({
        id: item.id,
        foreshadowId: item.foreshadowId,
        kind: item.progressKind as CausalForeshadowProgress["kind"],
        description: item.description,
        evidence: requireEvidence(item.evidenceId),
      })),
      downstreamEventIds: Object.freeze([...(downstream.get(row.id) ?? [])].sort()),
      evidence: requireEvidence(row.evidenceId),
    }));
    assertEveryChildHasEvent(
      eventRows,
      participants,
      prerequisites,
      characterChanges,
      relationshipChanges,
      itemChanges,
      informedCharacters,
      foreshadowProgress,
    );
    return graphFromStoredInput({ events, relations }, projectId, branchId);
  } catch (cause: unknown) {
    if (cause instanceof CausalEventGraphStoreError) {
      throw cause;
    }
    throw corruptGraph();
  }
}

function prerequisiteFromRow(
  row: PrerequisiteRow,
  requireEvidence: (id: string) => CausalTextEvidence,
): CausalEventPrerequisite {
  if (
    (row.prerequisiteKind === "event" && row.referencedEventId !== row.referenceId) ||
    (row.prerequisiteKind !== "event" && row.referencedEventId !== null)
  ) {
    throw corruptGraph();
  }
  return {
    id: row.id,
    kind: row.prerequisiteKind as CausalEventPrerequisite["kind"],
    referenceId: row.referenceId,
    description: row.description,
    evidence: requireEvidence(row.evidenceId),
  };
}

function rowsForEvent<Row extends { readonly eventId: string }>(
  rows: readonly Row[],
  eventId: string,
): readonly Row[] {
  return rows.filter((row) => row.eventId === eventId);
}

function assertEveryChildHasEvent(
  eventRows: readonly EventRow[],
  ...collections: (readonly { readonly eventId: string }[])[]
): void {
  const eventIds = new Set(eventRows.map(({ id }) => id));
  if (collections.some((rows) => rows.some(({ eventId }) => !eventIds.has(eventId)))) {
    throw corruptGraph();
  }
}

function evidenceFromRow(row: EvidenceRow): CausalTextEvidence {
  return {
    id: row.id,
    chapterId: row.chapterId,
    chapterVersionId: row.chapterVersionId,
    contentHash: row.contentHash,
    locator: row.locator,
    excerpt: row.excerpt,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    sourceLength: row.sourceLength,
  };
}

function parseStateValue(serialized: string): CausalStateValue {
  const value: unknown = JSON.parse(serialized);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw corruptGraph();
}

function downstreamBySource(
  relations: readonly CausalEventRelation[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const downstream = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (!isRelationShape(relation) || !IMPACT_RELATION_KINDS.has(relation.kind)) {
      continue;
    }
    const targets = downstream.get(relation.fromEventId) ?? new Set<string>();
    targets.add(relation.toEventId);
    downstream.set(relation.fromEventId, targets);
  }
  return downstream;
}

function collectComponentIds(events: readonly CausalEventNode[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    event.prerequisites.forEach(({ id }) => ids.add(id));
    event.characterStateChanges.forEach(({ id }) => ids.add(id));
    event.relationshipChanges.forEach(({ id }) => ids.add(id));
    event.itemChanges.forEach(({ id }) => ids.add(id));
    event.foreshadowProgress.forEach(({ id }) => ids.add(id));
  }
  return ids;
}

function assertNoForeignBrowserConflicts(
  database: BrowserGraphDatabase,
  targetKey: string,
  incoming: CausalEventGraph,
): void {
  const incomingEventIds = new Set(incoming.events.map(({ id }) => id));
  const incomingRelationIds = new Set(incoming.relations.map(({ id }) => id));
  const incomingComponentIds = collectComponentIds(incoming.events);
  const incomingEvidence = collectEvidence(incoming.events, incoming.relations);
  const incomingScope = scopeFromBranchKey(targetKey);

  for (const [key, input] of Object.entries(database.branches)) {
    if (key === targetKey) {
      continue;
    }
    const scope = scopeFromBranchKey(key);
    const graph = graphFromStoredInput(input, scope.projectId, scope.branchId);
    if (
      graph.events.some(({ id }) => incomingEventIds.has(id)) ||
      graph.relations.some(({ id }) => incomingRelationIds.has(id)) ||
      [...collectComponentIds(graph.events)].some((id) => incomingComponentIds.has(id))
    ) {
      throw graphConflict(
        "A causal graph identifier is already owned by another project or story branch.",
      );
    }
    for (const [evidenceId, existing] of collectEvidence(graph.events, graph.relations)) {
      const candidate = incomingEvidence.get(evidenceId);
      if (
        candidate !== undefined &&
        (scope.projectId !== incomingScope.projectId || !sameEvidence(existing, candidate))
      ) {
        throw graphConflict(
          "A causal evidence identifier is already owned by another project or source span.",
        );
      }
    }
  }
}

function collectRawComponentIds(value: Record<string, unknown>): readonly string[] {
  const ids: string[] = [];
  for (const key of [
    "prerequisites",
    "characterStateChanges",
    "relationshipChanges",
    "itemChanges",
    "foreshadowProgress",
  ]) {
    const collection = value[key];
    if (!Array.isArray(collection)) {
      continue;
    }
    for (const item of collection) {
      if (isRecord(item) && typeof item.id === "string") {
        ids.push(item.id);
      }
    }
  }
  return ids;
}

function relationSignature(
  relation: Pick<
    CausalEventRelation,
    "projectId" | "branchId" | "fromEventId" | "toEventId" | "kind"
  >,
): string {
  return `${relation.projectId}\u0000${relation.branchId}\u0000${relation.fromEventId}\u0000${relation.toEventId}\u0000${relation.kind}`;
}

function isRelationShape(
  value: unknown,
): value is Pick<
  CausalEventRelation,
  "projectId" | "branchId" | "fromEventId" | "toEventId" | "kind"
> {
  return (
    isRecord(value) &&
    typeof value.projectId === "string" &&
    typeof value.branchId === "string" &&
    typeof value.fromEventId === "string" &&
    typeof value.toEventId === "string" &&
    typeof value.kind === "string"
  );
}

function sameEvidence(left: CausalTextEvidence, right: CausalTextEvidence): boolean {
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

function readBrowserDatabase(storage: Storage): BrowserGraphDatabase {
  const serialized = storage.getItem(DEVELOPMENT_CAUSAL_EVENT_GRAPH_STORE_KEY);
  if (serialized === null) {
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, branches: Object.freeze({}) });
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== SCHEMA_VERSION ||
      !isRecord(parsed.branches) ||
      hasUnsafeOwnKey(parsed) ||
      hasUnsafeOwnKey(parsed.branches)
    ) {
      throw corruptGraph();
    }
    const branches: Record<string, CausalEventGraphInput> = {};
    for (const [key, value] of Object.entries(parsed.branches)) {
      const scope = scopeFromBranchKey(key);
      if (!isRecord(value) || !Array.isArray(value.events) || !Array.isArray(value.relations)) {
        throw corruptGraph();
      }
      const graph = graphFromStoredInput(
        value as unknown as CausalEventGraphInput,
        scope.projectId,
        scope.branchId,
      );
      branches[key] = graphInput(graph);
    }
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, branches: Object.freeze(branches) });
  } catch (cause: unknown) {
    if (cause instanceof CausalEventGraphStoreError && cause.code === "CAUSAL_GRAPH_CORRUPT") {
      throw cause;
    }
    throw corruptGraph();
  }
}

function writeBrowserDatabase(storage: Storage, database: BrowserGraphDatabase): void {
  try {
    storage.setItem(DEVELOPMENT_CAUSAL_EVENT_GRAPH_STORE_KEY, JSON.stringify(database));
  } catch {
    throw new CausalEventGraphStoreError(
      "CAUSAL_GRAPH_UNAVAILABLE",
      "Browser storage could not persist the causal event graph atomically.",
      true,
    );
  }
}

function graphInput(graph: CausalEventGraph): CausalEventGraphInput {
  return Object.freeze({ events: graph.events, relations: graph.relations });
}

function branchKey(projectId: string, branchId: string): string {
  return JSON.stringify([projectId, branchId]);
}

function scopeFromBranchKey(key: string): Readonly<{ projectId: string; branchId: string }> {
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) {
      throw corruptGraph();
    }
    const scope = validateScope(parsed[0], parsed[1]);
    if (branchKey(scope.projectId, scope.branchId) !== key) {
      throw corruptGraph();
    }
    return scope;
  } catch {
    throw corruptGraph();
  }
}

function validateScope(
  projectId: unknown,
  branchId: unknown,
): Readonly<{ projectId: string; branchId: string }> {
  if (!isSafeReference(projectId) || !isSafeReference(branchId)) {
    throw invalidGraph("A causal graph project and branch must use safe identifiers.");
  }
  return Object.freeze({ projectId, branchId });
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

function validateTimestamp(value: string): string {
  if (!CANONICAL_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new CausalEventGraphStoreError(
      "CAUSAL_GRAPH_UNAVAILABLE",
      "The causal graph clock did not return a canonical timestamp.",
    );
  }
  return value;
}

function hasUnsafeOwnKey(value: Record<string, unknown>): boolean {
  return ["__proto__", "prototype", "constructor"].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function invalidGraph(
  message = "The causal event graph write request is invalid.",
): CausalEventGraphStoreError {
  return new CausalEventGraphStoreError("CAUSAL_GRAPH_INVALID", message);
}

function graphConflict(message: string): CausalEventGraphStoreError {
  return new CausalEventGraphStoreError("CAUSAL_GRAPH_CONFLICT", message);
}

function invalidEvidence(message: string): CausalEventGraphStoreError {
  return new CausalEventGraphStoreError("CAUSAL_GRAPH_EVIDENCE_INVALID", message);
}

function corruptGraph(): CausalEventGraphStoreError {
  return new CausalEventGraphStoreError(
    "CAUSAL_GRAPH_CORRUPT",
    "Stored causal event graph data failed integrity validation.",
  );
}

function normalizeFailure(cause: unknown, message: string): CausalEventGraphStoreError {
  if (cause instanceof CausalEventGraphStoreError) {
    return cause;
  }
  if (cause instanceof CausalEventGraphInputError) {
    return invalidGraph(cause.message);
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (/UNIQUE constraint failed/iu.test(detail)) {
    return graphConflict("A causal graph identifier or relation already exists.");
  }
  return new CausalEventGraphStoreError("CAUSAL_GRAPH_UNAVAILABLE", message, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EVIDENCE_SELECT = `SELECT
  id,
  project_id AS projectId,
  chapter_id AS chapterId,
  chapter_version_id AS chapterVersionId,
  content_hash AS contentHash,
  locator,
  excerpt,
  start_offset AS startOffset,
  end_offset AS endOffset,
  source_length AS sourceLength
FROM causal_evidence_sources`;
