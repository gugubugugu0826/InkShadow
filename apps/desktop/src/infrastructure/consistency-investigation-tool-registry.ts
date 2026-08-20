import {
  createEvidenceRef,
  type EvidenceRef,
  type StoryMemoryReadModel,
  type StoryMemoryReadResult,
} from "@inkshadow/ai-core";
import type { ContentHasher } from "@inkshadow/application";
import type { UuidV7 } from "@inkshadow/domain";
import type {
  HybridSearchHit,
  HybridSearchResponse,
  SearchRetrievalScope,
  SearchRetrievalScopeTrace,
} from "@inkshadow/search-core";
import type { CausalEventGraph, CausalTextEvidence } from "@inkshadow/story-core";

import type { CausalEventGraphStore } from "./causal-event-graph-store";
import {
  planConsistencyLocalQueries,
  planConsistencyRecoveryQueries,
  type ConsistencyLocalQueryPlan,
  type ConsistencyLocalRecoveryQueryPlan,
  type ConsistencyQueryRecoveryType,
} from "./consistency-investigation-query-plan";
import {
  CONSISTENCY_INVESTIGATION_TOOL_NAMES,
  type ConsistencyInvestigationToolName,
} from "./consistency-investigation-store";
import type { ChapterNovelValidationResult } from "./novel-validation-runtime";

const INITIAL_SEARCH_K = 8;
const EXPANDED_SEARCH_K = 24;
const RECOVERY_SEARCH_K = 16;
const MINIMUM_SEARCH_EVIDENCE = 2;
const MAXIMUM_SEARCH_HITS = 24;
const MAXIMUM_CAUSAL_NEIGHBORS = 12;
const MAXIMUM_TOOL_TEXT_CHARACTERS = 120_000;

export interface ConsistencyInvestigationToolScope {
  readonly projectId: UuidV7;
  readonly observedAt: string;
  readonly destination: "local" | "remote";
}

interface ConsistencyChapterAuthority {
  readonly id: UuidV7;
  readonly status: string;
  readonly currentVersionId: UuidV7;
  readonly content: string;
  readonly privacyMode: "standard" | "local_only";
  toSnapshot(): Readonly<{ createdAt: string }>;
}

export interface ConsistencyInvestigationToolDependencies {
  readonly memory: Pick<StoryMemoryReadModel, "read">;
  readonly search: ConsistencyInvestigationFtsReader;
  readonly hasher: ContentHasher;
  readonly causalGraph: Pick<CausalEventGraphStore, "loadProjectBranch">;
  readonly chapters: Readonly<{
    listByProjectId(projectId: UuidV7): Promise<
      Readonly<{
        ok: boolean;
        value?: readonly ConsistencyChapterAuthority[];
        error?: unknown;
      }>
    >;
  }>;
  readonly validator: Readonly<{
    checkChapter(
      input: Readonly<{ projectId: UuidV7; chapterId: UuidV7 }>,
    ): Promise<ChapterNovelValidationResult>;
  }>;
}

/** The production ProjectSearchService read-only method, narrowed for Agent use. */
export interface ConsistencyInvestigationFtsReader {
  searchFtsOnly(
    projectId: UuidV7,
    query: string,
    scope: SearchRetrievalScope,
    limit?: number,
  ): Promise<
    | Readonly<{ readonly ok: true; readonly value: HybridSearchResponse }>
    | Readonly<{ readonly ok: false; readonly error: unknown }>
  >;
}

export interface StoryMemoryToolObservation {
  readonly kind: "story_memory";
  readonly projection: StoryMemoryReadResult;
}

export interface FactToolObservation {
  readonly kind: "confirmed_facts";
  readonly entries: StoryMemoryReadResult["layers"]["L1"];
}

export interface VerifiedConsistencySearchHit {
  readonly hit: HybridSearchHit;
  readonly evidence: EvidenceRef;
  readonly authority: "accepted_body" | "confirmed_fact";
}

export interface SearchToolObservation {
  readonly kind: "fts_search";
  /** Transient query text. Persisted/request receipts use queryTrace only. */
  readonly queries: readonly string[];
  readonly queryTrace: readonly Readonly<{
    readonly sourceEntryId: string | null;
    readonly queryType: ConsistencyLocalQueryPlan["queryType"];
    readonly stage: "initial" | "expand_k" | "recovery";
    readonly limit: number;
    readonly filterCounts: Readonly<{
      readonly time: number;
      readonly location: number;
      readonly branch: 1;
      readonly pov: 1;
      readonly storyOrder: 1;
    }>;
    readonly retrievalMethod: "fts";
    readonly resultCount: number;
    readonly verifiedResultCount: number;
    readonly fusionWeight: number;
    readonly omissionReason: string | null;
    readonly recoveryReason: ConsistencyQueryRecoveryType | "expand_k" | null;
    readonly scopeTrace: SearchRetrievalScopeTrace | null;
  }>[];
  readonly hits: readonly VerifiedConsistencySearchHit[];
  readonly scope: SearchRetrievalScope;
  readonly recoveryOutcome: "not_needed" | "recovered" | "evidence_insufficient";
  readonly notices: readonly string[];
}

export interface CausalToolObservation {
  readonly kind: "causal_graph";
  readonly events: CausalEventGraph["events"];
  readonly relations: CausalEventGraph["relations"];
  readonly verifiedNeighbors: readonly Readonly<{
    readonly id: string;
    readonly content: string;
    readonly evidence: EvidenceRef;
    readonly authority: "accepted_body";
  }>[];
  readonly recoveryTrace: Readonly<{
    readonly seedCount: number;
    readonly exactNeighborCount: number;
    readonly outcome: "not_needed" | "recovered" | "evidence_insufficient";
  }>;
}

export interface ValidationToolObservation {
  readonly kind: "deterministic_validation";
  readonly results: readonly ChapterNovelValidationResult[];
}

export type ConsistencyInvestigationToolObservation =
  | StoryMemoryToolObservation
  | FactToolObservation
  | SearchToolObservation
  | CausalToolObservation
  | ValidationToolObservation;

export class ConsistencyInvestigationToolRegistry {
  public constructor(private readonly dependencies: ConsistencyInvestigationToolDependencies) {}

  public names(): readonly ConsistencyInvestigationToolName[] {
    return CONSISTENCY_INVESTIGATION_TOOL_NAMES;
  }

  public async execute(
    name: string,
    scope: ConsistencyInvestigationToolScope,
    prior: readonly ConsistencyInvestigationToolObservation[] = [],
  ): Promise<ConsistencyInvestigationToolObservation> {
    if (!CONSISTENCY_INVESTIGATION_TOOL_NAMES.includes(name as ConsistencyInvestigationToolName)) {
      throw new ConsistencyInvestigationToolError(
        "AGENT_TOOL_NOT_REGISTERED",
        "The requested Agent tool is not registered for this read-only investigation.",
      );
    }
    switch (name as ConsistencyInvestigationToolName) {
      case "read_story_memory":
        return this.readStoryMemory(scope);
      case "inspect_fact":
        return this.inspectFacts(prior);
      case "search_fts":
        return this.searchFts(scope, prior);
      case "inspect_causal":
        return this.inspectCausal(scope, prior);
      case "validate_evidence":
        return this.validateEvidence(scope);
    }
  }

  private async readStoryMemory(
    scope: ConsistencyInvestigationToolScope,
  ): Promise<StoryMemoryToolObservation> {
    const projection = await this.dependencies.memory.read({
      projectId: scope.projectId,
      currentBranchId: null,
      destination: scope.destination,
      observedAt: scope.observedAt,
    });
    return Object.freeze({ kind: "story_memory", projection });
  }

  private inspectFacts(
    prior: readonly ConsistencyInvestigationToolObservation[],
  ): FactToolObservation {
    const memory = requireMemory(prior);
    return Object.freeze({ kind: "confirmed_facts", entries: memory.projection.layers.L1 });
  }

  private async searchFts(
    toolScope: ConsistencyInvestigationToolScope,
    prior: readonly ConsistencyInvestigationToolObservation[],
  ): Promise<SearchToolObservation> {
    const memory = requireMemory(prior);
    const facts = prior.find(
      (item): item is FactToolObservation => item.kind === "confirmed_facts",
    );
    const chapters = await this.requireChapters(toolScope.projectId);
    const activeChapters = chapterAuthorityById(chapters);
    const maximumStoryOrder = maximumActiveStoryOrder(chapters);
    if (maximumStoryOrder === 0) {
      throw new ConsistencyInvestigationToolError(
        "AGENT_CHAPTER_AUTHORITY_EMPTY",
        "No active chapter authority is available for scoped FTS.",
      );
    }
    const retrievalScope: SearchRetrievalScope = Object.freeze({
      projectId: toolScope.projectId,
      taskType: "agent_fts",
      privacy: toolScope.destination === "remote" ? "standard_only" : "include_local_only",
      currentness: "current",
      branchId: null,
      povCharacterId: memory.projection.scope.povCharacterId,
      maximumStoryOrder,
    });
    const entries = facts?.entries ?? memory.projection.layers.L1;
    const initialPlans = planConsistencyLocalQueries(entries);
    const hits = new Map<string, VerifiedConsistencySearchHit>();
    const notices = new Set<string>();
    const queryTrace: SearchToolObservation["queryTrace"][number][] = [];
    const queries: string[] = [];

    const executePlan = async (
      plan: ConsistencyLocalQueryPlan | ConsistencyLocalRecoveryQueryPlan,
      stage: SearchToolObservation["queryTrace"][number]["stage"],
      limit: number,
      recoveryReason: SearchToolObservation["queryTrace"][number]["recoveryReason"],
    ): Promise<void> => {
      queries.push(plan.query);
      let response: HybridSearchResponse | null = null;
      let omissionReason: string | null = null;
      try {
        const result = await this.dependencies.search.searchFtsOnly(
          toolScope.projectId,
          plan.query,
          retrievalScope,
          limit,
        );
        if (result.ok) {
          response = result.value;
        } else {
          omissionReason = "fts_read_failed";
          notices.add("fts_query_failed_without_remote_fallback");
        }
      } catch {
        omissionReason = "fts_read_failed";
        notices.add("fts_query_failed_without_remote_fallback");
      }
      let verifiedResultCount = 0;
      if (response !== null) {
        response.notices.forEach((notice) => notices.add(notice));
        if (!isCompleteAgentScopeTrace(response.retrievalScopeTrace)) {
          omissionReason = "retrieval_scope_trace_incomplete";
          notices.add("fts_scope_trace_failed_closed");
        } else {
          for (const hit of response.hits) {
            const verified = await this.verifySearchHit(
              hit,
              retrievalScope,
              response.retrievalScopeTrace,
              toolScope.observedAt,
              activeChapters,
              memory.projection,
            );
            if (verified === null) {
              notices.add("fts_hit_failed_exact_authority_validation");
              continue;
            }
            verifiedResultCount += 1;
            if (hits.size < MAXIMUM_SEARCH_HITS) hits.set(hit.document.id, verified);
          }
        }
      }
      queryTrace.push(
        toQueryTrace(
          plan,
          stage,
          limit,
          response?.hits.length ?? 0,
          verifiedResultCount,
          omissionReason,
          recoveryReason,
          response?.retrievalScopeTrace ?? null,
        ),
      );
    };

    for (const plan of initialPlans) await executePlan(plan, "initial", INITIAL_SEARCH_K, null);
    const initialEvidenceCount = hits.size;
    if (hits.size < MINIMUM_SEARCH_EVIDENCE) {
      for (const plan of initialPlans) {
        await executePlan(plan, "expand_k", EXPANDED_SEARCH_K, "expand_k");
        if (hits.size >= MINIMUM_SEARCH_EVIDENCE) break;
      }
    }
    if (hits.size < MINIMUM_SEARCH_EVIDENCE) {
      for (const plan of planConsistencyRecoveryQueries(entries, initialPlans)) {
        await executePlan(plan, "recovery", RECOVERY_SEARCH_K, plan.recoveryType);
        if (hits.size >= MINIMUM_SEARCH_EVIDENCE) break;
      }
    }
    const recoveryOutcome =
      initialEvidenceCount >= MINIMUM_SEARCH_EVIDENCE
        ? "not_needed"
        : hits.size >= MINIMUM_SEARCH_EVIDENCE
          ? "recovered"
          : "evidence_insufficient";
    if (recoveryOutcome === "evidence_insufficient") {
      notices.add("fts_evidence_insufficient_after_bounded_local_recovery");
    }
    notices.add("agent_retrieval_lexical_only_vector_weight_zero");
    return Object.freeze({
      kind: "fts_search",
      queries: Object.freeze(queries),
      queryTrace: Object.freeze(queryTrace),
      hits: Object.freeze([...hits.values()]),
      scope: retrievalScope,
      recoveryOutcome,
      notices: Object.freeze([...notices]),
    });
  }

  private async inspectCausal(
    scope: ConsistencyInvestigationToolScope,
    prior: readonly ConsistencyInvestigationToolObservation[],
  ): Promise<CausalToolObservation> {
    const search = prior.find((item): item is SearchToolObservation => item.kind === "fts_search");
    const empty = (outcome: CausalToolObservation["recoveryTrace"]["outcome"]) =>
      Object.freeze({
        kind: "causal_graph" as const,
        events: Object.freeze([]),
        relations: Object.freeze([]),
        verifiedNeighbors: Object.freeze([]),
        recoveryTrace: Object.freeze({
          seedCount: search?.hits.length ?? 0,
          exactNeighborCount: 0,
          outcome,
        }),
      });
    if (search === undefined || search.recoveryOutcome === "not_needed") return empty("not_needed");
    try {
      const graph = await this.dependencies.causalGraph.loadProjectBranch(scope.projectId, "main");
      const chapters = chapterAuthorityById(await this.requireChapters(scope.projectId));
      const seedChapterIds = new Set(search.hits.map(({ evidence }) => evidence.chapterId));
      const seedEventIds = new Set(
        graph.events
          .filter(({ evidence }) => seedChapterIds.has(evidence.chapterId))
          .map(({ id }) => id),
      );
      const neighborEventIds = new Set<string>();
      for (const relation of graph.relations) {
        if (seedEventIds.has(relation.fromEventId)) neighborEventIds.add(relation.toEventId);
        if (seedEventIds.has(relation.toEventId)) neighborEventIds.add(relation.fromEventId);
      }
      const neighbors: CausalToolObservation["verifiedNeighbors"][number][] = [];
      for (const event of graph.events) {
        if (!neighborEventIds.has(event.id) || neighbors.length >= MAXIMUM_CAUSAL_NEIGHBORS)
          continue;
        const evidence = await this.verifyCausalEvidence(
          event.evidence,
          scope,
          search.scope,
          chapters,
        );
        if (evidence !== null) {
          neighbors.push(
            Object.freeze({
              id: `causal-neighbor:${event.id}:${event.evidence.id}`,
              content: event.evidence.excerpt,
              evidence,
              authority: "accepted_body" as const,
            }),
          );
        }
      }
      const outcome = neighbors.length > 0 ? "recovered" : "evidence_insufficient";
      return Object.freeze({
        kind: "causal_graph",
        events: Object.freeze(graph.events.slice(0, 1_000)),
        relations: Object.freeze(graph.relations.slice(0, 2_000)),
        verifiedNeighbors: Object.freeze(neighbors),
        recoveryTrace: Object.freeze({
          seedCount: search.hits.length,
          exactNeighborCount: neighbors.length,
          outcome,
        }),
      });
    } catch {
      return empty("evidence_insufficient");
    }
  }

  private async validateEvidence(
    scope: ConsistencyInvestigationToolScope,
  ): Promise<ValidationToolObservation> {
    const chapters = await this.dependencies.chapters.listByProjectId(scope.projectId);
    if (!chapters.ok || chapters.value === undefined) {
      throw new ConsistencyInvestigationToolError(
        "AGENT_CHAPTER_READ_FAILED",
        "Accepted chapters could not be read for deterministic validation.",
      );
    }
    const active = chapters.value.filter(({ status }) => status === "active").slice(0, 10_000);
    const results: ChapterNovelValidationResult[] = [];
    for (const chapter of active) {
      results.push(
        await this.dependencies.validator.checkChapter({
          projectId: scope.projectId,
          chapterId: chapter.id,
        }),
      );
    }
    return Object.freeze({ kind: "deterministic_validation", results: Object.freeze(results) });
  }

  private async requireChapters(
    projectId: UuidV7,
  ): Promise<readonly ConsistencyChapterAuthority[]> {
    const result = await this.dependencies.chapters.listByProjectId(projectId);
    if (!result.ok || result.value === undefined) {
      throw new ConsistencyInvestigationToolError(
        "AGENT_CHAPTER_READ_FAILED",
        "Accepted chapter authority could not be read for scoped retrieval.",
      );
    }
    return result.value;
  }

  private async verifySearchHit(
    hit: HybridSearchHit,
    scope: SearchRetrievalScope,
    scopeTrace: SearchRetrievalScopeTrace,
    observedAt: string,
    chapters: ReadonlyMap<string, ConsistencyChapterAuthority>,
    memory: StoryMemoryReadResult,
  ): Promise<VerifiedConsistencySearchHit | null> {
    const document = hit.document;
    const authority = document.authority;
    if (
      !isCompleteAgentScopeTrace(scopeTrace) ||
      document.projectId !== scope.projectId ||
      document.currentness !== "current" ||
      (authority !== "accepted_text" && authority !== "confirmed_fact") ||
      document.sourceVersionId !== hit.evidence.sourceVersionId ||
      document.contentHash !== hit.evidence.contentHash ||
      document.privacy === undefined ||
      (scope.privacy === "standard_only" && document.privacy !== "standard") ||
      document.branchId !== null ||
      (document.povCharacterId !== null && document.povCharacterId !== scope.povCharacterId) ||
      (document.storyOrder !== null &&
        document.storyOrder !== undefined &&
        document.storyOrder > (scope.maximumStoryOrder ?? -1))
    ) {
      return null;
    }
    const chapterId =
      authority === "accepted_text"
        ? document.sourceType === "chapter"
          ? document.sourceId
          : null
        : chapterIdFromStoryFactDocument(hit);
    if (chapterId === null) return null;
    const chapter = chapters.get(chapterId);
    const start = document.utf16Start;
    const end = document.utf16End;
    if (
      chapter?.status !== "active" ||
      chapter.currentVersionId !== document.sourceVersionId ||
      chapter.privacyMode !== document.privacy ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(document.sourceLength) ||
      start === undefined ||
      end === undefined ||
      document.sourceLength === undefined ||
      start < 0 ||
      end <= start ||
      document.sourceLength !== chapter.content.length ||
      end > document.sourceLength ||
      chapter.content.slice(start, end) !== document.text
    ) {
      return null;
    }
    const hashed = await this.dependencies.hasher.sha256(document.text);
    if (!hashed.ok || hashed.value !== document.contentHash) return null;
    if (
      authority === "confirmed_fact" &&
      !matchesConfirmedFactAuthority(memory.layers.L1, document.sourceId, {
        chapterId,
        versionId: document.sourceVersionId,
        start,
        end,
        sourceLength: document.sourceLength,
        digest: document.contentHash,
        privacy: document.privacy,
      })
    ) {
      return null;
    }
    const evidence = createEvidenceRef({
      projectId: document.projectId,
      chapterId,
      immutableVersionId: document.sourceVersionId,
      sourceKind: authority === "confirmed_fact" ? "story_fact" : "chapter",
      locator: {
        kind: "utf16",
        startOffset: start,
        endOffset: end,
        sourceLength: document.sourceLength,
      },
      excerptDigest: document.contentHash,
      sourceCreatedAt: chapter.toSnapshot().createdAt,
      observedAt,
      currentness: "current",
      branchId: null,
      privacy: document.privacy,
    });
    return Object.freeze({
      hit,
      evidence,
      authority: authority === "confirmed_fact" ? "confirmed_fact" : "accepted_body",
    });
  }

  private async verifyCausalEvidence(
    source: CausalTextEvidence,
    toolScope: ConsistencyInvestigationToolScope,
    retrievalScope: SearchRetrievalScope,
    chapters: ReadonlyMap<string, ConsistencyChapterAuthority>,
  ): Promise<EvidenceRef | null> {
    const chapter = chapters.get(source.chapterId);
    if (
      chapter?.status !== "active" ||
      chapter.currentVersionId !== source.chapterVersionId ||
      source.sourceLength !== chapter.content.length ||
      source.startOffset < 0 ||
      source.endOffset <= source.startOffset ||
      source.endOffset > source.sourceLength ||
      chapter.content.slice(source.startOffset, source.endOffset) !== source.excerpt ||
      (retrievalScope.privacy === "standard_only" && chapter.privacyMode !== "standard")
    ) {
      return null;
    }
    const [sourceHash, excerptHash] = await Promise.all([
      this.dependencies.hasher.sha256(chapter.content),
      this.dependencies.hasher.sha256(source.excerpt),
    ]);
    if (!sourceHash.ok || !excerptHash.ok || sourceHash.value !== source.contentHash) return null;
    return createEvidenceRef({
      projectId: toolScope.projectId,
      chapterId: chapter.id,
      immutableVersionId: chapter.currentVersionId,
      sourceKind: "chapter",
      locator: {
        kind: "utf16",
        startOffset: source.startOffset,
        endOffset: source.endOffset,
        sourceLength: source.sourceLength,
      },
      excerptDigest: excerptHash.value,
      sourceCreatedAt: chapter.toSnapshot().createdAt,
      observedAt: toolScope.observedAt,
      currentness: "current",
      branchId: null,
      privacy: chapter.privacyMode,
    });
  }
}

export class ConsistencyInvestigationToolError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConsistencyInvestigationToolError";
  }
}

export function authoritativeEvidenceCatalog(
  observations: readonly ConsistencyInvestigationToolObservation[],
): ReadonlyMap<string, EvidenceRef> {
  const memory = requireMemory(observations);
  const entries = [...memory.projection.layers.L0, ...memory.projection.layers.L1];
  const catalog = new Map<string, EvidenceRef>();
  let sequence = 1;
  for (const entry of entries) {
    for (const evidence of entry.evidence) {
      if (
        evidence.currentness !== "current" ||
        (evidence.sourceKind !== "chapter" && evidence.sourceKind !== "story_fact")
      ) {
        continue;
      }
      catalog.set(`evidence-${String(sequence)}`, evidence);
      sequence += 1;
    }
  }
  return catalog;
}

/** Returns a bounded, content-free receipt suitable for persistence. */
export function boundedToolObservationJson(
  observations: readonly ConsistencyInvestigationToolObservation[],
  maximumCharacters = MAXIMUM_TOOL_TEXT_CHARACTERS,
): string {
  const serialized = JSON.stringify(observations.map(contentFreeToolReceipt));
  if (serialized.length <= maximumCharacters) return serialized;
  throw new ConsistencyInvestigationToolError(
    "AGENT_CONTEXT_LIMIT_EXCEEDED",
    "The content-free Agent tool receipt does not fit the configured bound.",
  );
}

function requireMemory(
  observations: readonly ConsistencyInvestigationToolObservation[],
): StoryMemoryToolObservation {
  const memory = observations.find(
    (item): item is StoryMemoryToolObservation => item.kind === "story_memory",
  );
  if (memory === undefined) {
    throw new ConsistencyInvestigationToolError(
      "AGENT_TOOL_ORDER_INVALID",
      "Story memory must be read before dependent tools run.",
    );
  }
  return memory;
}

function maximumActiveStoryOrder(chapters: readonly ConsistencyChapterAuthority[]): number {
  let maximum = 0;
  chapters.forEach((chapter, index) => {
    if (chapter.status === "active") maximum = index + 1;
  });
  return maximum;
}

function chapterAuthorityById(
  chapters: readonly ConsistencyChapterAuthority[],
): ReadonlyMap<string, ConsistencyChapterAuthority> {
  return new Map(
    chapters.filter(({ status }) => status === "active").map((item) => [item.id, item]),
  );
}

function isCompleteAgentScopeTrace(
  trace: SearchRetrievalScopeTrace | undefined,
): trace is SearchRetrievalScopeTrace {
  return (
    trace?.taskType === "agent_fts" &&
    trace.versionMode === "per_source_current" &&
    trace.omittedHardFilters.length === 0
  );
}

function chapterIdFromStoryFactDocument(hit: HybridSearchHit): string | null {
  const document = hit.document;
  if (
    document.sourceType !== "memory" ||
    document.chunkKind !== "story_fact_evidence" ||
    document.parentDocumentId === null ||
    document.parentDocumentId === undefined
  ) {
    return null;
  }
  const match = /^chapter:(.+):\d+$/u.exec(document.parentDocumentId);
  return match?.[1] ?? null;
}

function matchesConfirmedFactAuthority(
  entries: StoryMemoryReadResult["layers"]["L1"],
  factId: string,
  expected: Readonly<{
    chapterId: string;
    versionId: string;
    start: number;
    end: number;
    sourceLength: number;
    digest: string;
    privacy: "standard" | "local_only";
  }>,
): boolean {
  return entries.some(
    (entry) =>
      entry.id.startsWith(`story-fact:${factId}:`) &&
      entry.kind === "confirmed_canon" &&
      entry.evidence.some(
        (evidence) =>
          evidence.currentness === "current" &&
          evidence.chapterId === expected.chapterId &&
          evidence.immutableVersionId === expected.versionId &&
          evidence.excerptDigest === expected.digest &&
          evidence.privacy === expected.privacy &&
          evidence.locator.kind === "utf16" &&
          evidence.locator.startOffset === expected.start &&
          evidence.locator.endOffset === expected.end &&
          evidence.locator.sourceLength === expected.sourceLength,
      ),
  );
}

function toQueryTrace(
  plan: ConsistencyLocalQueryPlan | ConsistencyLocalRecoveryQueryPlan,
  stage: SearchToolObservation["queryTrace"][number]["stage"],
  limit: number,
  resultCount: number,
  verifiedResultCount: number,
  omissionReason: string | null,
  recoveryReason: SearchToolObservation["queryTrace"][number]["recoveryReason"],
  scopeTrace: SearchRetrievalScopeTrace | null,
): SearchToolObservation["queryTrace"][number] {
  return Object.freeze({
    sourceEntryId: plan.sourceEntryId,
    queryType: plan.queryType,
    stage,
    limit,
    filterCounts: Object.freeze({
      time: plan.filters.timeTerms.length,
      location: plan.filters.locationTerms.length,
      branch: 1 as const,
      pov: 1 as const,
      storyOrder: 1 as const,
    }),
    retrievalMethod: plan.retrievalMethod,
    resultCount,
    verifiedResultCount,
    fusionWeight: plan.fusionWeight,
    omissionReason,
    recoveryReason,
    scopeTrace,
  });
}

function contentFreeToolReceipt(
  observation: ConsistencyInvestigationToolObservation,
): Readonly<Record<string, unknown>> {
  switch (observation.kind) {
    case "story_memory":
      return Object.freeze({
        kind: observation.kind,
        counts: Object.fromEntries(
          Object.entries(observation.projection.layers).map(([layer, entries]) => [
            layer,
            entries.length,
          ]),
        ),
        exclusionCount: observation.projection.exclusions.length,
      });
    case "confirmed_facts":
      return Object.freeze({ kind: observation.kind, count: observation.entries.length });
    case "fts_search":
      return Object.freeze({
        kind: observation.kind,
        queryCount: observation.queries.length,
        hitCount: observation.hits.length,
        scope: observation.scope,
        queryTrace: observation.queryTrace,
        recoveryOutcome: observation.recoveryOutcome,
        notices: observation.notices,
      });
    case "causal_graph":
      return Object.freeze({
        kind: observation.kind,
        eventCount: observation.events.length,
        relationCount: observation.relations.length,
        recoveryTrace: observation.recoveryTrace,
      });
    case "deterministic_validation":
      return Object.freeze({ kind: observation.kind, resultCount: observation.results.length });
  }
}
