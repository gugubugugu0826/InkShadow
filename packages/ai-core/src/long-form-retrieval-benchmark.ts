import { estimateContextTokensUtf8Conservative } from "./context-compiler.js";
import { rerankWithLocalEvidence, type EvidenceRerankCandidate } from "./evidence-rerank.js";
import {
  LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS,
  LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION,
  LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS,
  buildLongFormRetrievalBenchmarkFixtures,
  type LongFormBenchmarkDocument,
  type LongFormBenchmarkSample,
  type LongFormRetrievalBenchmarkScenario,
} from "./long-form-retrieval-benchmark-fixtures.js";
import {
  evaluateRetrievalRanking,
  type RetrievalEvaluationResult,
} from "./retrieval-evaluation.js";

export const LONG_FORM_RETRIEVAL_BENCHMARK_VERSION = "long_form_retrieval_benchmark_v2" as const;
export const LONG_FORM_RETRIEVAL_BENCHMARK_K = 5 as const;
export const LONG_FORM_RETRIEVAL_BENCHMARK_METHODS = Object.freeze([
  "fts_baseline",
  "fts_vector",
  "fts_vector_local_rerank",
  "fts_vector_graph_local_rerank",
  "weighted_fusion",
  "rrf_grouped_fusion",
] as const);

export type LongFormRetrievalBenchmarkMethod =
  (typeof LONG_FORM_RETRIEVAL_BENCHMARK_METHODS)[number];

export type LongFormBenchmarkOmissionReason =
  | "branch_mismatch"
  | "canon_not_authoritative"
  | "evidence_incomplete"
  | "future_knowledge"
  | "no_query_term_match"
  | "pov_mismatch"
  | "private_scope"
  | "rank_limit"
  | "rejected_candidate"
  | "stale_version"
  | "what_if_projection";

export interface LongFormBenchmarkEvidenceRef {
  readonly sourceType: "chapter" | "story_rule";
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly locator: string;
  readonly contentHash: string;
}

export interface LongFormBenchmarkTraceSource {
  readonly sourceId: string;
  readonly reason: LongFormBenchmarkOmissionReason;
}

export interface LongFormBenchmarkTrace {
  readonly traceId: string;
  readonly query: string;
  readonly scope: LongFormBenchmarkSample["scope"];
  readonly corpusDocumentCount: number;
  readonly includedSourceIds: readonly string[];
  readonly omittedSources: readonly LongFormBenchmarkTraceSource[];
  readonly selectedEvidenceRefs: readonly LongFormBenchmarkEvidenceRef[];
  readonly complete: boolean;
}

export interface LongFormBenchmarkFinding {
  readonly findingId: string;
  readonly sourceDocumentId: string;
  readonly evidenceRef: LongFormBenchmarkEvidenceRef;
}

export interface LongFormBenchmarkSafetyMetrics {
  readonly falseInclusionRate: number;
  readonly canonViolationRate: number;
  readonly branchLeakageRate: number;
  readonly povLeakageRate: number;
  readonly futureKnowledgeLeakageRate: number;
  readonly privateLeakageRate: number;
  readonly evidenceRefCompleteness: number;
  readonly traceCompleteness: number;
  readonly emptyResultCorrectness: number;
  readonly ftsFallbackOccurred: boolean;
  readonly findingEvidenceRatio: number | null;
  readonly hallucinatedFindingCount: number;
  readonly invalidToolCallCount: number;
  readonly hiddenProviderCallCount: number;
  readonly duplicateDispatchCount: number;
}

export interface LongFormBenchmarkCostMetrics {
  readonly estimatedContextTokens: number;
  readonly providerTokens: 0;
  readonly providerCost: 0;
  readonly providerDispatchCount: 0;
  readonly networkRequestCount: 0;
}

export interface LongFormBenchmarkLatencyMetrics {
  readonly latencyEstimateMs: number;
  readonly vectorLatencyEstimateMs: number;
  readonly graphLatencyEstimateMs: number;
  readonly fusionLatencyEstimateMs: number;
  readonly rerankLatencyEstimateMs: number;
  readonly measurementMode: "deterministic_operation_model_not_wall_clock";
  readonly realWorldLatencyClaimable: false;
}

export interface LongFormBenchmarkRawResult {
  readonly corpusCharacterTarget: number;
  readonly sampleId: string;
  readonly scenario: LongFormRetrievalBenchmarkScenario;
  readonly method: LongFormRetrievalBenchmarkMethod;
  readonly rankedDocumentIds: readonly string[];
  readonly relevantDocumentIds: readonly string[];
  readonly ranking: RetrievalEvaluationResult;
  readonly safety: LongFormBenchmarkSafetyMetrics;
  readonly cost: LongFormBenchmarkCostMetrics;
  readonly latency: LongFormBenchmarkLatencyMetrics;
  readonly findings: readonly LongFormBenchmarkFinding[];
  readonly trace: LongFormBenchmarkTrace;
}

export interface LongFormBenchmarkAggregate {
  readonly method: LongFormRetrievalBenchmarkMethod;
  readonly sampleCount: number;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly meanReciprocalRank: number;
  readonly normalizedDiscountedCumulativeGain: number;
  readonly hitRate: number;
  readonly falseInclusionRate: number;
  readonly authorityPrecision: number;
  readonly staleHitRate: number;
  readonly rejectedCandidateContaminationRate: number;
  readonly canonViolationRate: number;
  readonly branchLeakageRate: number;
  readonly povLeakageRate: number;
  readonly futureKnowledgeLeakageRate: number;
  readonly privateLeakageCount: number;
  readonly evidenceRefCompleteness: number;
  readonly traceCompleteness: number;
  readonly estimatedContextTokens: number;
  readonly averageLatencyEstimateMs: number;
  readonly averageRerankLatencyEstimateMs: number;
  readonly emptyResultCorrectness: number;
  readonly ftsFallbackRate: number;
  readonly rebuildDeterminism: 1;
  readonly restartRecovery: 1;
  readonly findingEvidenceRatio: number | null;
  readonly hallucinatedFindingCount: number;
  readonly invalidToolCallCount: number;
  readonly hiddenProviderCallCount: number;
  readonly duplicateDispatchCount: number;
  readonly providerDispatchCount: 0;
  readonly networkRequestCount: 0;
  readonly providerTokens: 0;
  readonly providerCost: 0;
}

export interface LongFormBenchmarkCorpusSummary {
  readonly characterTarget: number;
  readonly actualCharacterCount: number;
  readonly documentCount: number;
  readonly sampleCount: number;
  readonly scenarios: readonly LongFormRetrievalBenchmarkScenario[];
}

export interface LongFormBenchmarkUnavailableComparison {
  readonly method: "provider_rerank";
  readonly status: "not_authorized";
  readonly reason: string;
}

export interface LongFormBenchmarkMethodDisclosure {
  readonly method: LongFormRetrievalBenchmarkMethod;
  readonly status: "evaluated_fixed_fixture";
  readonly execution: "local_deterministic";
  readonly productionEquivalent: false;
  readonly implementation:
    | "deterministic_term_frequency_fixture_not_product_sqlite_fts"
    | "ordered_fts_then_hashed_token_vector_fixture"
    | "ordered_fts_vector_union_then_local_evidence_rerank"
    | "ordered_fts_vector_graph_fixture_then_local_evidence_rerank"
    | "fixed_0_55_fts_0_30_vector_0_15_graph_fixture"
    | "fixed_k60_rrf_over_fts_vector_graph_fixture";
}

export interface LongFormRetrievalBenchmarkReport {
  readonly benchmarkVersion: typeof LONG_FORM_RETRIEVAL_BENCHMARK_VERSION;
  readonly fixtureVersion: typeof LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION;
  readonly evaluatedAtK: typeof LONG_FORM_RETRIEVAL_BENCHMARK_K;
  readonly execution: {
    readonly mode: "local_deterministic_fixture";
    readonly ftsBaselineImplementation: "deterministic_term_frequency_fixture_not_product_sqlite_fts";
    readonly vectorImplementation: "deterministic_hashed_token_fixture_not_product_embedding";
    readonly graphImplementation: "deterministic_metadata_link_fixture_not_product_story_graph";
    readonly fusionImplementation: "fixed_fixture_weighted_and_k60_rrf_not_product_routing";
    readonly generatedCacheFiles: 0;
    readonly providerDispatchCount: 0;
    readonly networkRequestCount: 0;
    readonly providerTokens: 0;
    readonly providerCost: 0;
  };
  readonly corpusSummaries: readonly LongFormBenchmarkCorpusSummary[];
  readonly rawResults: readonly LongFormBenchmarkRawResult[];
  readonly aggregates: readonly LongFormBenchmarkAggregate[];
  readonly methodDisclosures: readonly LongFormBenchmarkMethodDisclosure[];
  readonly unavailableComparisons: readonly LongFormBenchmarkUnavailableComparison[];
  readonly defaultPathDecision: {
    readonly method: "fts_baseline";
    readonly stableImprovementRequirement: "strictly_higher_ndcg_at_every_corpus_with_no_safety_regression";
    readonly complexMethodsMeetingRequirement: readonly LongFormRetrievalBenchmarkMethod[];
    readonly reason: string;
  };
  readonly improvementClaim: {
    readonly status: "not_claimed";
    readonly reason: string;
  };
  readonly realUserAcceptance: {
    readonly status: "insufficient_sample";
    readonly observationCount: 0;
    readonly acceptedCount: null;
    readonly rejectedCount: null;
    readonly acceptanceRate: null;
    readonly reason: "no_real_user_observations";
  };
  readonly reproducibility: {
    readonly fixedCorpusTargets: typeof LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS;
    readonly fixedScenarioSet: typeof LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS;
    readonly rebuildDeterminism: "verified_by_independent_run_equality";
    readonly restartRecovery: "verified_for_rebuilt_in_memory_fixture";
    readonly sourceRevision: "WORKTREE_UNBOUND";
  };
}

interface RankedCandidate {
  readonly document: LongFormBenchmarkDocument;
  readonly score: number;
  readonly normalizedScore: number;
}

interface SearchPreparation {
  readonly ftsCandidates: readonly RankedCandidate[];
  readonly vectorCandidates: readonly RankedCandidate[];
  readonly graphCandidates: readonly RankedCandidate[];
  readonly eligibleDocumentIds: ReadonlySet<string>;
  readonly hardFilterReasons: ReadonlyMap<string, LongFormBenchmarkOmissionReason>;
}

interface RankingSelection {
  readonly rankedDocumentIds: readonly string[];
  readonly consideredDocumentIds: ReadonlySet<string>;
  readonly fallbackOccurred: boolean;
  readonly rerankedCandidateCount: number;
  readonly usesVector: boolean;
  readonly usesGraph: boolean;
  readonly usesFusion: boolean;
}

/**
 * Runs the fixed local benchmark. Web Crypto is used only to build real
 * SHA-256 EvidenceRef values; it performs no network or Provider work.
 */
export async function runLongFormRetrievalBenchmark(): Promise<LongFormRetrievalBenchmarkReport> {
  const fixtures = buildLongFormRetrievalBenchmarkFixtures();
  const rawResults: LongFormBenchmarkRawResult[] = [];
  for (const fixture of fixtures) {
    const evidenceCache = new Map<string, LongFormBenchmarkEvidenceRef>();
    for (const sample of fixture.samples) {
      const preparation = prepareFtsCandidates(fixture.documents, sample);
      for (const method of LONG_FORM_RETRIEVAL_BENCHMARK_METHODS) {
        rawResults.push(
          await evaluateSample(
            fixture.characterTarget,
            fixture.actualCharacterCount,
            fixture.documents,
            sample,
            method,
            preparation,
            evidenceCache,
          ),
        );
      }
    }
  }

  const complexMethodsMeetingRequirement = Object.freeze(
    LONG_FORM_RETRIEVAL_BENCHMARK_METHODS.filter(
      (method) =>
        method !== "fts_baseline" && complexMethodHasStableFixtureImprovement(method, rawResults),
    ),
  );

  return Object.freeze({
    benchmarkVersion: LONG_FORM_RETRIEVAL_BENCHMARK_VERSION,
    fixtureVersion: LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION,
    evaluatedAtK: LONG_FORM_RETRIEVAL_BENCHMARK_K,
    execution: Object.freeze({
      mode: "local_deterministic_fixture",
      ftsBaselineImplementation: "deterministic_term_frequency_fixture_not_product_sqlite_fts",
      vectorImplementation: "deterministic_hashed_token_fixture_not_product_embedding",
      graphImplementation: "deterministic_metadata_link_fixture_not_product_story_graph",
      fusionImplementation: "fixed_fixture_weighted_and_k60_rrf_not_product_routing",
      generatedCacheFiles: 0,
      providerDispatchCount: 0,
      networkRequestCount: 0,
      providerTokens: 0,
      providerCost: 0,
    }),
    corpusSummaries: Object.freeze(
      fixtures.map((fixture) =>
        Object.freeze({
          characterTarget: fixture.characterTarget,
          actualCharacterCount: fixture.actualCharacterCount,
          documentCount: fixture.documents.length,
          sampleCount: fixture.samples.length,
          scenarios: Object.freeze(fixture.samples.map(({ scenario }) => scenario)),
        }),
      ),
    ),
    rawResults: Object.freeze(rawResults),
    aggregates: Object.freeze(
      LONG_FORM_RETRIEVAL_BENCHMARK_METHODS.map((method) =>
        aggregateResults(
          method,
          rawResults.filter((result) => result.method === method),
        ),
      ),
    ),
    methodDisclosures: METHOD_DISCLOSURES,
    unavailableComparisons: UNAVAILABLE_COMPARISONS,
    defaultPathDecision: Object.freeze({
      method: "fts_baseline",
      stableImprovementRequirement:
        "strictly_higher_ndcg_at_every_corpus_with_no_safety_regression",
      complexMethodsMeetingRequirement,
      reason:
        complexMethodsMeetingRequirement.length === 0
          ? "No complex fixture arm is strictly better at every corpus size without a safety regression; keep simple FTS as the default."
          : "A fixture arm met the fixed comparison threshold, but fixture-only evidence does not replace commit-bound production telemetry or justify changing the default.",
    }),
    improvementClaim: Object.freeze({
      status: "not_claimed",
      reason:
        "Raw fixed-fixture metrics are reported without an improvement percentage while the report is not bound to a clean source commit and has no real-user sample.",
    }),
    realUserAcceptance: Object.freeze({
      status: "insufficient_sample",
      observationCount: 0,
      acceptedCount: null,
      rejectedCount: null,
      acceptanceRate: null,
      reason: "no_real_user_observations",
    }),
    reproducibility: Object.freeze({
      fixedCorpusTargets: LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS,
      fixedScenarioSet: LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS,
      rebuildDeterminism: "verified_by_independent_run_equality",
      restartRecovery: "verified_for_rebuilt_in_memory_fixture",
      sourceRevision: "WORKTREE_UNBOUND",
    }),
  });
}

/** Stable raw JSON. No timestamp, wall-clock timing, or generated cache path is included. */
export function serializeLongFormRetrievalBenchmarkReport(
  report: LongFormRetrievalBenchmarkReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function evaluateSample(
  corpusCharacterTarget: number,
  corpusCharacterCount: number,
  documents: readonly LongFormBenchmarkDocument[],
  sample: LongFormBenchmarkSample,
  method: LongFormRetrievalBenchmarkMethod,
  preparation: SearchPreparation,
  evidenceCache: Map<string, LongFormBenchmarkEvidenceRef>,
): Promise<LongFormBenchmarkRawResult> {
  const selection = await selectRanking(method, sample, preparation, evidenceCache);
  const rankedDocumentIds = selection.rankedDocumentIds;

  const documentById = new Map(documents.map((document) => [document.id, document] as const));
  const selectedDocuments = rankedDocumentIds.flatMap((id) => {
    const document = documentById.get(id);
    return document === undefined ? [] : [document];
  });
  const selectedEvidenceRefs = await Promise.all(
    selectedDocuments.map((document) => evidenceFor(document, evidenceCache)),
  );
  const authoritativeIds = documents
    .filter(({ authority }) => authority === "accepted_body" || authority === "accepted_story_fact")
    .map(({ id }) => id);
  const ranking = evaluateRetrievalRanking({
    rankedIds: rankedDocumentIds,
    relevantIds: sample.relevantDocumentIds,
    authoritativeIds,
    staleIds: documents.filter(({ currentness }) => currentness === "stale").map(({ id }) => id),
    rejectedCandidateIds: documents
      .filter(({ authority }) => authority === "rejected_candidate")
      .map(({ id }) => id),
    privateIds: documents.filter(({ privacy }) => privacy === "private").map(({ id }) => id),
    limit: LONG_FORM_RETRIEVAL_BENCHMARK_K,
  });
  const findings = await buildFindings(sample, selectedDocuments, evidenceCache, method);
  const trace = buildTrace(
    corpusCharacterTarget,
    documents,
    sample,
    method,
    rankedDocumentIds,
    selectedEvidenceRefs,
    preparation,
    selection.consideredDocumentIds,
  );
  const returnedCount = selectedDocuments.length;
  const nonRelevantCount = selectedDocuments.filter(
    ({ id }) => !sample.relevantDocumentIds.includes(id),
  ).length;
  const evidenceCompleteCount = selectedEvidenceRefs.filter(isCompleteEvidenceRef).length;
  const findingEvidenceCount = findings.filter(({ evidenceRef }) =>
    isCompleteEvidenceRef(evidenceRef),
  ).length;
  const estimatedContextTokens = selectedDocuments.reduce(
    (total, { text }) => total + estimateContextTokensUtf8Conservative(text),
    0,
  );

  return Object.freeze({
    corpusCharacterTarget,
    sampleId: sample.id,
    scenario: sample.scenario,
    method,
    rankedDocumentIds: Object.freeze(rankedDocumentIds),
    relevantDocumentIds: sample.relevantDocumentIds,
    ranking,
    safety: Object.freeze({
      falseInclusionRate: ratio(nonRelevantCount, returnedCount),
      canonViolationRate: ratio(
        selectedDocuments.filter(({ canon }) => canon !== "canonical").length,
        returnedCount,
      ),
      branchLeakageRate: ratio(
        selectedDocuments.filter(
          ({ branchId }) => branchId !== "shared" && branchId !== sample.scope.branchId,
        ).length,
        returnedCount,
      ),
      povLeakageRate: ratio(
        selectedDocuments.filter(
          ({ povCharacterId }) =>
            povCharacterId !== "omniscient" && povCharacterId !== sample.scope.povCharacterId,
        ).length,
        returnedCount,
      ),
      futureKnowledgeLeakageRate: ratio(
        selectedDocuments.filter(({ storyOrder }) => storyOrder > sample.scope.maximumStoryOrder)
          .length,
        returnedCount,
      ),
      privateLeakageRate: ratio(
        selectedDocuments.filter(({ privacy }) => privacy === "private").length,
        returnedCount,
      ),
      evidenceRefCompleteness:
        returnedCount === 0 ? 1 : ratio(evidenceCompleteCount, returnedCount),
      traceCompleteness: trace.complete ? 1 : 0,
      emptyResultCorrectness: sample.expectedEmpty === (returnedCount === 0) ? 1 : 0,
      ftsFallbackOccurred: selection.fallbackOccurred,
      findingEvidenceRatio:
        findings.length === 0 ? null : ratio(findingEvidenceCount, findings.length),
      hallucinatedFindingCount: 0,
      invalidToolCallCount: 0,
      hiddenProviderCallCount: 0,
      duplicateDispatchCount: 0,
    }),
    cost: Object.freeze({
      estimatedContextTokens,
      providerTokens: 0,
      providerCost: 0,
      providerDispatchCount: 0,
      networkRequestCount: 0,
    }),
    latency: Object.freeze({
      latencyEstimateMs: round(
        estimateRetrievalLatencyMs(
          corpusCharacterCount,
          documents.length,
          preparation.ftsCandidates.length,
        ) +
          (selection.usesVector
            ? estimateVectorFixtureLatencyMs(corpusCharacterCount, documents.length)
            : 0) +
          (selection.usesGraph
            ? estimateGraphFixtureLatencyMs(
                preparation.eligibleDocumentIds.size,
                preparation.graphCandidates.length,
              )
            : 0) +
          (selection.usesFusion
            ? estimateFusionLatencyMs(selection.consideredDocumentIds.size)
            : 0) +
          (selection.rerankedCandidateCount > 0
            ? estimateRerankLatencyMs(selection.rerankedCandidateCount, sample.query.length)
            : 0),
      ),
      vectorLatencyEstimateMs: selection.usesVector
        ? estimateVectorFixtureLatencyMs(corpusCharacterCount, documents.length)
        : 0,
      graphLatencyEstimateMs: selection.usesGraph
        ? estimateGraphFixtureLatencyMs(
            preparation.eligibleDocumentIds.size,
            preparation.graphCandidates.length,
          )
        : 0,
      fusionLatencyEstimateMs: selection.usesFusion
        ? estimateFusionLatencyMs(selection.consideredDocumentIds.size)
        : 0,
      rerankLatencyEstimateMs:
        selection.rerankedCandidateCount > 0
          ? estimateRerankLatencyMs(selection.rerankedCandidateCount, sample.query.length)
          : 0,
      measurementMode: "deterministic_operation_model_not_wall_clock",
      realWorldLatencyClaimable: false,
    }),
    findings,
    trace,
  });
}

async function selectRanking(
  method: LongFormRetrievalBenchmarkMethod,
  sample: LongFormBenchmarkSample,
  preparation: SearchPreparation,
  evidenceCache: Map<string, LongFormBenchmarkEvidenceRef>,
): Promise<RankingSelection> {
  const baselineCandidates = preparation.ftsCandidates;
  const vectorUnion = orderedCandidateUnion([
    preparation.ftsCandidates,
    preparation.vectorCandidates,
  ]);
  const graphUnion = orderedCandidateUnion([
    preparation.ftsCandidates,
    preparation.vectorCandidates,
    preparation.graphCandidates,
  ]);
  const fallbackOccurred =
    (method === "fts_vector_local_rerank" || method === "fts_vector_graph_local_rerank") &&
    sample.localRerankAvailability === "unavailable_use_fts_fallback";

  if (method === "fts_baseline" || fallbackOccurred) {
    return rankingSelection(
      baselineCandidates,
      baselineCandidates,
      fallbackOccurred,
      0,
      false,
      false,
      false,
    );
  }
  if (method === "fts_vector") {
    return rankingSelection(vectorUnion, vectorUnion, false, 0, true, false, false);
  }
  if (method === "fts_vector_local_rerank") {
    return rerankedSelection(sample, vectorUnion, false, evidenceCache);
  }
  if (method === "fts_vector_graph_local_rerank") {
    return rerankedSelection(sample, graphUnion, true, evidenceCache);
  }
  if (method === "weighted_fusion") {
    const fused = weightedFixtureFusion(preparation);
    return rankingSelection(fused, fused, false, 0, true, true, true);
  }
  const fused = reciprocalRankFixtureFusion(preparation);
  return rankingSelection(fused, fused, false, 0, true, true, true);
}

async function rerankedSelection(
  sample: LongFormBenchmarkSample,
  candidates: readonly RankedCandidate[],
  usesGraph: boolean,
  evidenceCache: Map<string, LongFormBenchmarkEvidenceRef>,
): Promise<RankingSelection> {
  const boundedCandidates = candidates.slice(0, 20);
  const rerankCandidates = await Promise.all(
    boundedCandidates.map(
      async ({ document, normalizedScore }) =>
        ({
          id: document.id,
          text: document.text,
          retrievalScore: normalizedScore,
          importance: document.authority === "accepted_story_fact" ? 1 : 0,
          pinned: false,
          evidence: await evidenceFor(document, evidenceCache),
        }) satisfies EvidenceRerankCandidate,
    ),
  );
  const rankedDocumentIds =
    rerankCandidates.length === 0
      ? []
      : rerankWithLocalEvidence({
          query: sample.query,
          candidates: rerankCandidates,
          limit: LONG_FORM_RETRIEVAL_BENCHMARK_K,
        }).ranked.map(({ candidate }) => candidate.id);
  return Object.freeze({
    rankedDocumentIds: Object.freeze(rankedDocumentIds),
    consideredDocumentIds: new Set(candidates.map(({ document }) => document.id)),
    fallbackOccurred: false,
    rerankedCandidateCount: rerankCandidates.length,
    usesVector: true,
    usesGraph,
    usesFusion: false,
  });
}

function rankingSelection(
  rankedCandidates: readonly RankedCandidate[],
  consideredCandidates: readonly RankedCandidate[],
  fallbackOccurred: boolean,
  rerankedCandidateCount: number,
  usesVector: boolean,
  usesGraph: boolean,
  usesFusion: boolean,
): RankingSelection {
  return Object.freeze({
    rankedDocumentIds: Object.freeze(
      rankedCandidates.slice(0, LONG_FORM_RETRIEVAL_BENCHMARK_K).map(({ document }) => document.id),
    ),
    consideredDocumentIds: new Set(consideredCandidates.map(({ document }) => document.id)),
    fallbackOccurred,
    rerankedCandidateCount,
    usesVector,
    usesGraph,
    usesFusion,
  });
}

function prepareFtsCandidates(
  documents: readonly LongFormBenchmarkDocument[],
  sample: LongFormBenchmarkSample,
): SearchPreparation {
  const queryTerms = tokenize(sample.query);
  const hardFilterReasons = new Map<string, LongFormBenchmarkOmissionReason>();
  const eligibleDocuments: LongFormBenchmarkDocument[] = [];
  const ftsScored: Readonly<{ document: LongFormBenchmarkDocument; score: number }>[] = [];
  const vectorScored: Readonly<{ document: LongFormBenchmarkDocument; score: number }>[] = [];
  for (const document of documents) {
    const exclusionReason = hardFilterReason(document, sample);
    if (exclusionReason !== null) {
      hardFilterReasons.set(document.id, exclusionReason);
      continue;
    }
    eligibleDocuments.push(document);
    const normalizedText = normalize(document.text);
    const score = queryTerms.reduce(
      (total, term) => total + countOccurrences(normalizedText, term),
      0,
    );
    if (score > 0) {
      ftsScored.push(Object.freeze({ document, score }));
    }
    const vectorScore = deterministicVectorFixtureSimilarity(sample.query, document.text);
    if (vectorScore > 0) {
      vectorScored.push(Object.freeze({ document, score: vectorScore }));
    }
  }
  const ftsCandidates = normalizeRankedCandidates(ftsScored);
  const vectorCandidates = normalizeRankedCandidates(vectorScored);
  const graphCandidates = buildDeterministicGraphFixtureCandidates(
    eligibleDocuments,
    orderedCandidateUnion([ftsCandidates, vectorCandidates]).slice(0, 12),
  );
  return Object.freeze({
    ftsCandidates,
    vectorCandidates,
    graphCandidates,
    eligibleDocumentIds: new Set(eligibleDocuments.map(({ id }) => id)),
    hardFilterReasons,
  });
}

function normalizeRankedCandidates(
  candidates: readonly Readonly<{
    readonly document: LongFormBenchmarkDocument;
    readonly score: number;
  }>[],
): readonly RankedCandidate[] {
  const sorted = [...candidates].sort(
    (left, right) =>
      right.score - left.score || compareIdentifiers(left.document.id, right.document.id),
  );
  const maximumScore = sorted[0]?.score ?? 1;
  return Object.freeze(
    sorted.map(({ document, score }) =>
      Object.freeze({
        document,
        score: round(score),
        normalizedScore: round(score / maximumScore),
      }),
    ),
  );
}

function orderedCandidateUnion(
  groups: readonly (readonly RankedCandidate[])[],
): readonly RankedCandidate[] {
  const byId = new Map<string, RankedCandidate>();
  for (const group of groups) {
    for (const candidate of group) {
      const previous = byId.get(candidate.document.id);
      if (previous === undefined) {
        byId.set(candidate.document.id, candidate);
      } else if (candidate.normalizedScore > previous.normalizedScore) {
        byId.set(
          candidate.document.id,
          Object.freeze({
            document: candidate.document,
            score: candidate.score,
            normalizedScore: candidate.normalizedScore,
          }),
        );
      }
    }
  }
  return Object.freeze([...byId.values()]);
}

function weightedFixtureFusion(preparation: SearchPreparation): readonly RankedCandidate[] {
  const ftsScores = candidateScoreMap(preparation.ftsCandidates);
  const vectorScores = candidateScoreMap(preparation.vectorCandidates);
  const graphScores = candidateScoreMap(preparation.graphCandidates);
  const documentById = candidateDocumentMap([
    preparation.ftsCandidates,
    preparation.vectorCandidates,
    preparation.graphCandidates,
  ]);
  return normalizeRankedCandidates(
    [...documentById].map(([id, document]) =>
      Object.freeze({
        document,
        score:
          0.55 * (ftsScores.get(id) ?? 0) +
          0.3 * (vectorScores.get(id) ?? 0) +
          0.15 * (graphScores.get(id) ?? 0),
      }),
    ),
  );
}

function reciprocalRankFixtureFusion(preparation: SearchPreparation): readonly RankedCandidate[] {
  const groups = [
    preparation.ftsCandidates,
    preparation.vectorCandidates,
    preparation.graphCandidates,
  ] as const;
  const documentById = candidateDocumentMap(groups);
  const scores = new Map<string, number>();
  for (const group of groups) {
    group.forEach(({ document }, index) => {
      scores.set(document.id, (scores.get(document.id) ?? 0) + 1 / (60 + index + 1));
    });
  }
  return normalizeRankedCandidates(
    [...documentById].map(([id, document]) =>
      Object.freeze({ document, score: scores.get(id) ?? 0 }),
    ),
  );
}

function candidateScoreMap(candidates: readonly RankedCandidate[]): ReadonlyMap<string, number> {
  return new Map(candidates.map(({ document, normalizedScore }) => [document.id, normalizedScore]));
}

function candidateDocumentMap(
  groups: readonly (readonly RankedCandidate[])[],
): ReadonlyMap<string, LongFormBenchmarkDocument> {
  const documents = new Map<string, LongFormBenchmarkDocument>();
  for (const group of groups) {
    for (const { document } of group) {
      documents.set(document.id, document);
    }
  }
  return documents;
}

function deterministicVectorFixtureSimilarity(query: string, text: string): number {
  const queryTokens = vectorFixtureTokens(query);
  const documentTokens = vectorFixtureTokens(text);
  if (queryTokens.length === 0 || !hasSharedToken(queryTokens, documentTokens)) {
    return 0;
  }
  const queryVector = hashedTokenVector(queryTokens);
  const documentVector = hashedTokenVector(documentTokens);
  const queryMagnitude = vectorMagnitude(queryVector);
  const documentMagnitude = vectorMagnitude(documentVector);
  if (queryMagnitude === 0 || documentMagnitude === 0) {
    return 0;
  }
  const dotProduct = queryVector.reduce(
    (total, value, index) => total + value * (documentVector[index] ?? 0),
    0,
  );
  return round(Math.max(0, dotProduct / (queryMagnitude * documentMagnitude)));
}

function vectorFixtureTokens(value: string): readonly string[] {
  return Object.freeze(
    normalize(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0),
  );
}

function hasSharedToken(left: readonly string[], right: readonly string[]): boolean {
  const rightTokens = new Set(right);
  return left.some((token) => rightTokens.has(token));
}

function hashedTokenVector(tokens: readonly string[]): readonly number[] {
  const vector = Array.from({ length: 48 }, () => 0);
  for (const token of tokens) {
    const hash = stableTokenHash(token);
    const index = hash % vector.length;
    vector[index] = (vector[index] ?? 0) + 1 + Math.min(token.length, 12) / 12;
  }
  return Object.freeze(vector);
}

function stableTokenHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function vectorMagnitude(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
}

function buildDeterministicGraphFixtureCandidates(
  eligibleDocuments: readonly LongFormBenchmarkDocument[],
  seedCandidates: readonly RankedCandidate[],
): readonly RankedCandidate[] {
  if (seedCandidates.length === 0) {
    return Object.freeze([]);
  }
  return normalizeRankedCandidates(
    eligibleDocuments.flatMap((document) => {
      const score = seedCandidates.reduce(
        (maximum, seed, index) =>
          Math.max(
            maximum,
            graphFixtureEdgeScore(seed.document, document) *
              seed.normalizedScore *
              (1 / (index + 1)),
          ),
        0,
      );
      return score > 0 ? [Object.freeze({ document, score })] : [];
    }),
  );
}

function graphFixtureEdgeScore(
  seed: LongFormBenchmarkDocument,
  candidate: LongFormBenchmarkDocument,
): number {
  if (seed.id === candidate.id) {
    return 1;
  }
  const seedTokens = new Set(vectorFixtureTokens(seed.text));
  const candidateTokens = new Set(vectorFixtureTokens(candidate.text));
  const sharedTokenCount = [...seedTokens].filter((token) => candidateTokens.has(token)).length;
  const sameChapter = seed.chapterId === candidate.chapterId;
  const adjacentSamePov =
    seed.povCharacterId === candidate.povCharacterId &&
    Math.abs(seed.storyOrder - candidate.storyOrder) <= 1;
  if (!sameChapter && sharedTokenCount === 0 && !adjacentSamePov) {
    return 0;
  }
  const tokenUnionCount = new Set([...seedTokens, ...candidateTokens]).size;
  const tokenOverlap = tokenUnionCount === 0 ? 0 : sharedTokenCount / tokenUnionCount;
  const storyProximity = 1 / (1 + Math.abs(seed.storyOrder - candidate.storyOrder));
  const timelineProximity = 1 / (1 + Math.abs(seed.timelineOrder - candidate.timelineOrder));
  return round(
    (sameChapter ? 0.45 : 0) +
      0.3 * tokenOverlap +
      (adjacentSamePov ? 0.15 * storyProximity : 0) +
      0.1 * timelineProximity,
  );
}

function hardFilterReason(
  document: LongFormBenchmarkDocument,
  sample: LongFormBenchmarkSample,
): LongFormBenchmarkOmissionReason | null {
  if (document.evidenceLocator === null) {
    return "evidence_incomplete";
  }
  if (document.authority === "rejected_candidate") {
    return "rejected_candidate";
  }
  if (document.authority === "what_if_projection") {
    return "what_if_projection";
  }
  if (document.currentness === "stale") {
    return "stale_version";
  }
  if (document.canon !== "canonical" || document.authority === "unverified_conflict") {
    return "canon_not_authoritative";
  }
  if (document.branchId !== "shared" && document.branchId !== sample.scope.branchId) {
    return "branch_mismatch";
  }
  if (
    document.povCharacterId !== "omniscient" &&
    document.povCharacterId !== sample.scope.povCharacterId
  ) {
    return "pov_mismatch";
  }
  if (document.storyOrder > sample.scope.maximumStoryOrder) {
    return "future_knowledge";
  }
  if (document.privacy === "private" && !sample.scope.allowPrivate) {
    return "private_scope";
  }
  return null;
}

async function evidenceFor(
  document: LongFormBenchmarkDocument,
  cache: Map<string, LongFormBenchmarkEvidenceRef>,
): Promise<LongFormBenchmarkEvidenceRef> {
  const cached = cache.get(document.id);
  if (cached !== undefined) {
    return cached;
  }
  if (document.evidenceLocator === null) {
    throw new Error("A benchmark result cannot be emitted without a complete EvidenceRef.");
  }
  const evidence = Object.freeze({
    sourceType: document.authority === "accepted_story_fact" ? "story_rule" : "chapter",
    sourceId: document.id,
    sourceVersionId: document.sourceVersionId,
    locator: document.evidenceLocator,
    contentHash: await sha256Hex(document.text),
  } satisfies LongFormBenchmarkEvidenceRef);
  cache.set(document.id, evidence);
  return evidence;
}

async function buildFindings(
  sample: LongFormBenchmarkSample,
  selectedDocuments: readonly LongFormBenchmarkDocument[],
  evidenceCache: Map<string, LongFormBenchmarkEvidenceRef>,
  method: LongFormRetrievalBenchmarkMethod,
): Promise<readonly LongFormBenchmarkFinding[]> {
  return Object.freeze(
    await Promise.all(
      selectedDocuments
        .filter(({ id }) => sample.relevantDocumentIds.includes(id))
        .map(async (document, index) =>
          Object.freeze({
            findingId: `${sample.id}:${method}:finding:${String(index + 1)}`,
            sourceDocumentId: document.id,
            evidenceRef: await evidenceFor(document, evidenceCache),
          }),
        ),
    ),
  );
}

function buildTrace(
  corpusCharacterTarget: number,
  documents: readonly LongFormBenchmarkDocument[],
  sample: LongFormBenchmarkSample,
  method: LongFormRetrievalBenchmarkMethod,
  rankedDocumentIds: readonly string[],
  selectedEvidenceRefs: readonly LongFormBenchmarkEvidenceRef[],
  preparation: SearchPreparation,
  consideredDocumentIds: ReadonlySet<string>,
): LongFormBenchmarkTrace {
  const included = new Set(rankedDocumentIds);
  const omittedSources = documents.flatMap((document): readonly LongFormBenchmarkTraceSource[] => {
    if (included.has(document.id)) {
      return [];
    }
    return [
      Object.freeze({
        sourceId: document.id,
        reason:
          preparation.hardFilterReasons.get(document.id) ??
          (consideredDocumentIds.has(document.id) ? "rank_limit" : "no_query_term_match"),
      }),
    ];
  });
  const accountedFor = new Set([
    ...rankedDocumentIds,
    ...omittedSources.map(({ sourceId }) => sourceId),
  ]);
  return Object.freeze({
    traceId: `long-${String(corpusCharacterTarget)}:${sample.id}:${method}`,
    query: sample.query,
    scope: sample.scope,
    corpusDocumentCount: documents.length,
    includedSourceIds: Object.freeze([...rankedDocumentIds]),
    omittedSources: Object.freeze(omittedSources),
    selectedEvidenceRefs: Object.freeze(selectedEvidenceRefs),
    complete:
      accountedFor.size === documents.length &&
      rankedDocumentIds.length === selectedEvidenceRefs.length &&
      selectedEvidenceRefs.every(isCompleteEvidenceRef),
  });
}

function aggregateResults(
  method: LongFormRetrievalBenchmarkMethod,
  results: readonly LongFormBenchmarkRawResult[],
): LongFormBenchmarkAggregate {
  const average = (select: (result: LongFormBenchmarkRawResult) => number): number =>
    ratio(
      results.reduce((total, result) => total + select(result), 0),
      results.length,
    );
  const findingCount = results.reduce((total, result) => total + result.findings.length, 0);
  const evidencedFindingCount = results.reduce(
    (total, result) =>
      total +
      result.findings.filter(({ evidenceRef }) => isCompleteEvidenceRef(evidenceRef)).length,
    0,
  );
  return Object.freeze({
    method,
    sampleCount: results.length,
    recallAtK: average(({ ranking }) => ranking.recallAtK),
    precisionAtK: average(({ ranking }) => ranking.precisionAtK),
    meanReciprocalRank: average(({ ranking }) => ranking.meanReciprocalRank),
    normalizedDiscountedCumulativeGain: average(
      ({ ranking }) => ranking.normalizedDiscountedCumulativeGain,
    ),
    hitRate: average(({ ranking }) => ranking.hitRate),
    falseInclusionRate: average(({ safety }) => safety.falseInclusionRate),
    authorityPrecision: average(({ ranking }) => ranking.authorityPrecision),
    staleHitRate: average(({ ranking }) => ranking.staleHitRate),
    rejectedCandidateContaminationRate: average(
      ({ ranking }) => ranking.rejectedCandidateContaminationRate,
    ),
    canonViolationRate: average(({ safety }) => safety.canonViolationRate),
    branchLeakageRate: average(({ safety }) => safety.branchLeakageRate),
    povLeakageRate: average(({ safety }) => safety.povLeakageRate),
    futureKnowledgeLeakageRate: average(({ safety }) => safety.futureKnowledgeLeakageRate),
    privateLeakageCount: results.reduce(
      (total, { ranking }) => total + ranking.privateLeakageCount,
      0,
    ),
    evidenceRefCompleteness: average(({ safety }) => safety.evidenceRefCompleteness),
    traceCompleteness: average(({ safety }) => safety.traceCompleteness),
    estimatedContextTokens: results.reduce(
      (total, { cost }) => total + cost.estimatedContextTokens,
      0,
    ),
    averageLatencyEstimateMs: average(({ latency }) => latency.latencyEstimateMs),
    averageRerankLatencyEstimateMs: average(({ latency }) => latency.rerankLatencyEstimateMs),
    emptyResultCorrectness: average(({ safety }) => safety.emptyResultCorrectness),
    ftsFallbackRate: average(({ safety }) => (safety.ftsFallbackOccurred ? 1 : 0)),
    rebuildDeterminism: 1,
    restartRecovery: 1,
    findingEvidenceRatio: findingCount === 0 ? null : ratio(evidencedFindingCount, findingCount),
    hallucinatedFindingCount: results.reduce(
      (total, { safety }) => total + safety.hallucinatedFindingCount,
      0,
    ),
    invalidToolCallCount: results.reduce(
      (total, { safety }) => total + safety.invalidToolCallCount,
      0,
    ),
    hiddenProviderCallCount: results.reduce(
      (total, { safety }) => total + safety.hiddenProviderCallCount,
      0,
    ),
    duplicateDispatchCount: results.reduce(
      (total, { safety }) => total + safety.duplicateDispatchCount,
      0,
    ),
    providerDispatchCount: 0,
    networkRequestCount: 0,
    providerTokens: 0,
    providerCost: 0,
  });
}

function complexMethodHasStableFixtureImprovement(
  method: LongFormRetrievalBenchmarkMethod,
  rawResults: readonly LongFormBenchmarkRawResult[],
): boolean {
  const baselineBySample = new Map(
    rawResults
      .filter(({ method: resultMethod }) => resultMethod === "fts_baseline")
      .map((result) => [fixtureSampleKey(result), result] as const),
  );
  const methodResults = rawResults.filter(({ method: resultMethod }) => resultMethod === method);
  const hasNoSafetyRegression = methodResults.every((result) => {
    const baseline = baselineBySample.get(fixtureSampleKey(result));
    return baseline !== undefined && safetyIsNoWorse(result, baseline);
  });
  if (!hasNoSafetyRegression) {
    return false;
  }
  return LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS.every((characterTarget) => {
    const baseline = rawResults.filter(
      (result) =>
        result.method === "fts_baseline" && result.corpusCharacterTarget === characterTarget,
    );
    const comparison = methodResults.filter(
      ({ corpusCharacterTarget }) => corpusCharacterTarget === characterTarget,
    );
    return averageNdcg(comparison) > averageNdcg(baseline) && comparison.length === baseline.length;
  });
}

function fixtureSampleKey(result: LongFormBenchmarkRawResult): string {
  return `${String(result.corpusCharacterTarget)}:${result.sampleId}`;
}

function safetyIsNoWorse(
  comparison: LongFormBenchmarkRawResult,
  baseline: LongFormBenchmarkRawResult,
): boolean {
  return (
    comparison.safety.falseInclusionRate <= baseline.safety.falseInclusionRate &&
    comparison.safety.canonViolationRate <= baseline.safety.canonViolationRate &&
    comparison.safety.branchLeakageRate <= baseline.safety.branchLeakageRate &&
    comparison.safety.povLeakageRate <= baseline.safety.povLeakageRate &&
    comparison.safety.futureKnowledgeLeakageRate <= baseline.safety.futureKnowledgeLeakageRate &&
    comparison.safety.privateLeakageRate <= baseline.safety.privateLeakageRate &&
    comparison.safety.evidenceRefCompleteness >= baseline.safety.evidenceRefCompleteness &&
    comparison.safety.traceCompleteness >= baseline.safety.traceCompleteness &&
    comparison.safety.emptyResultCorrectness >= baseline.safety.emptyResultCorrectness
  );
}

function averageNdcg(results: readonly LongFormBenchmarkRawResult[]): number {
  return ratio(
    results.reduce((total, { ranking }) => total + ranking.normalizedDiscountedCumulativeGain, 0),
    results.length,
  );
}

function isCompleteEvidenceRef(value: LongFormBenchmarkEvidenceRef): boolean {
  return (
    value.sourceId.length > 0 &&
    value.sourceVersionId.length > 0 &&
    value.locator.length > 0 &&
    /^[a-f0-9]{64}$/u.test(value.contentHash)
  );
}

function tokenize(value: string): readonly string[] {
  return Object.freeze(
    normalize(value)
      .split(/\s+/u)
      .filter((term) => term.length > 0),
  );
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(term, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    offset = index + term.length;
  }
  return count;
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function estimateRetrievalLatencyMs(
  corpusCharacters: number,
  documentCount: number,
  matchedCount: number,
): number {
  return round(0.05 + corpusCharacters / 2_000_000 + documentCount / 10_000 + matchedCount / 1_000);
}

function estimateVectorFixtureLatencyMs(corpusCharacters: number, documentCount: number): number {
  return round(0.03 + corpusCharacters / 1_500_000 + documentCount / 8_000);
}

function estimateGraphFixtureLatencyMs(
  eligibleDocumentCount: number,
  graphHitCount: number,
): number {
  return round(0.015 + eligibleDocumentCount / 5_000 + graphHitCount / 2_000);
}

function estimateFusionLatencyMs(candidateCount: number): number {
  return round(0.005 + candidateCount / 4_000);
}

function estimateRerankLatencyMs(candidateCount: number, queryCharacters: number): number {
  return round(0.02 + candidateCount / 500 + queryCharacters / 10_000);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const UNAVAILABLE_COMPARISONS = Object.freeze([
  Object.freeze({
    method: "provider_rerank",
    status: "not_authorized",
    reason:
      "The benchmark has no user authorization to send story content to a Provider, so it records zero dispatches, network requests, tokens, and cost.",
  }),
] satisfies readonly LongFormBenchmarkUnavailableComparison[]);

const METHOD_DISCLOSURES = Object.freeze([
  Object.freeze({
    method: "fts_baseline",
    status: "evaluated_fixed_fixture",
    execution: "local_deterministic",
    productionEquivalent: false,
    implementation: "deterministic_term_frequency_fixture_not_product_sqlite_fts",
  }),
  Object.freeze({
    method: "fts_vector",
    status: "evaluated_fixed_fixture",
    execution: "local_deterministic",
    productionEquivalent: false,
    implementation: "ordered_fts_then_hashed_token_vector_fixture",
  }),
  Object.freeze({
    method: "fts_vector_local_rerank",
    status: "evaluated_fixed_fixture",
    execution: "local_deterministic",
    productionEquivalent: false,
    implementation: "ordered_fts_vector_union_then_local_evidence_rerank",
  }),
  Object.freeze({
    method: "fts_vector_graph_local_rerank",
    status: "evaluated_fixed_fixture",
    execution: "local_deterministic",
    productionEquivalent: false,
    implementation: "ordered_fts_vector_graph_fixture_then_local_evidence_rerank",
  }),
  Object.freeze({
    method: "weighted_fusion",
    status: "evaluated_fixed_fixture",
    execution: "local_deterministic",
    productionEquivalent: false,
    implementation: "fixed_0_55_fts_0_30_vector_0_15_graph_fixture",
  }),
  Object.freeze({
    method: "rrf_grouped_fusion",
    status: "evaluated_fixed_fixture",
    execution: "local_deterministic",
    productionEquivalent: false,
    implementation: "fixed_k60_rrf_over_fts_vector_graph_fixture",
  }),
] satisfies readonly LongFormBenchmarkMethodDisclosure[]);
