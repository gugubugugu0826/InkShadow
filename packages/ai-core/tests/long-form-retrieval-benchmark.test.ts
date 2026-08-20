import { describe, expect, it, vi } from "vitest";

import {
  LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS,
  LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION,
  LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS,
  buildLongFormRetrievalBenchmarkFixtures,
} from "../src/long-form-retrieval-benchmark-fixtures.js";
import {
  LONG_FORM_RETRIEVAL_BENCHMARK_K,
  LONG_FORM_RETRIEVAL_BENCHMARK_METHODS,
  runLongFormRetrievalBenchmark,
  serializeLongFormRetrievalBenchmarkReport,
} from "../src/long-form-retrieval-benchmark.js";

describe("fixed long-form retrieval benchmark", () => {
  it("rebuilds exact 5k/20k/50k/200k corpora with the complete risk matrix", () => {
    const fixtures = buildLongFormRetrievalBenchmarkFixtures();

    expect(fixtures.map(({ characterTarget }) => characterTarget)).toEqual([
      5_000, 20_000, 50_000, 200_000,
    ]);
    expect(fixtures.map(({ actualCharacterCount }) => actualCharacterCount)).toEqual([
      5_000, 20_000, 50_000, 200_000,
    ]);
    expect(
      fixtures.map(({ documents }) =>
        documents.reduce((total, document) => total + document.text.length, 0),
      ),
    ).toEqual([5_000, 20_000, 50_000, 200_000]);
    expect(fixtures.reduce((total, fixture) => total + fixture.samples.length, 0)).toBe(48);
    expect(fixtures.every(({ samples }) => samples.length === 12)).toBe(true);
    expect(
      new Set(fixtures.flatMap(({ samples }) => samples.map(({ scenario }) => scenario))),
    ).toEqual(new Set(LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS));
    expect(
      fixtures.every(
        ({ fixtureVersion }) => fixtureVersion === LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION,
      ),
    ).toBe(true);

    const largest = fixtures.at(-1);
    expect(new Set(largest?.documents.map(({ chapterId }) => chapterId)).size).toBeGreaterThan(12);
    expect(
      new Set(largest?.documents.map(({ sourceVersionId }) => sourceVersionId)).size,
    ).toBeGreaterThan(12);
    expect(new Set(largest?.documents.map(({ branchId }) => branchId))).toEqual(
      new Set(["main", "alternate"]),
    );
    expect(new Set(largest?.documents.map(({ povCharacterId }) => povCharacterId))).toEqual(
      new Set(["omniscient", "lin-wan", "zhou-qi"]),
    );
    expect(largest?.documents.some(({ authority }) => authority === "what_if_projection")).toBe(
      true,
    );
    expect(
      largest?.documents.some(({ timelineOrder, storyOrder }) => timelineOrder < storyOrder),
    ).toBe(true);
    expect(largest?.documents.some(({ authority }) => authority === "unverified_conflict")).toBe(
      true,
    );
    expect(largest?.documents.some(({ authority }) => authority === "rejected_candidate")).toBe(
      true,
    );
    expect(largest?.documents.some(({ currentness }) => currentness === "stale")).toBe(true);
    expect(largest?.documents.some(({ privacy }) => privacy === "private")).toBe(true);
  });

  it("runs the fixed six-arm local matrix with complete raw metrics and no dispatch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const report = await runLongFormRetrievalBenchmark();
      const semanticSampleCount = report.corpusSummaries.reduce(
        (total, corpus) => total + corpus.sampleCount,
        0,
      );

      expect(semanticSampleCount).toBe(48);
      expect(semanticSampleCount).toBeGreaterThanOrEqual(30);
      expect(report.evaluatedAtK).toBe(LONG_FORM_RETRIEVAL_BENCHMARK_K);
      expect(report.rawResults).toHaveLength(
        semanticSampleCount * LONG_FORM_RETRIEVAL_BENCHMARK_METHODS.length,
      );
      expect(new Set(report.rawResults.map(({ method }) => method))).toEqual(
        new Set([
          "fts_baseline",
          "fts_vector",
          "fts_vector_local_rerank",
          "fts_vector_graph_local_rerank",
          "weighted_fusion",
          "rrf_grouped_fusion",
        ]),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(report.execution).toEqual({
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
      });

      for (const raw of report.rawResults) {
        expect(raw.ranking).toEqual(
          expect.objectContaining({
            recallAtK: expect.any(Number),
            precisionAtK: expect.any(Number),
            meanReciprocalRank: expect.any(Number),
            normalizedDiscountedCumulativeGain: expect.any(Number),
            hitRate: expect.any(Number),
            authorityPrecision: expect.any(Number),
            staleHitRate: expect.any(Number),
            rejectedCandidateContaminationRate: expect.any(Number),
            privateLeakageCount: expect.any(Number),
          }),
        );
        expect(raw.safety).toEqual(
          expect.objectContaining({
            falseInclusionRate: expect.any(Number),
            canonViolationRate: 0,
            branchLeakageRate: 0,
            povLeakageRate: 0,
            futureKnowledgeLeakageRate: 0,
            privateLeakageRate: 0,
            evidenceRefCompleteness: 1,
            traceCompleteness: 1,
            emptyResultCorrectness: 1,
            hallucinatedFindingCount: 0,
            invalidToolCallCount: 0,
            hiddenProviderCallCount: 0,
            duplicateDispatchCount: 0,
          }),
        );
        expect(raw.cost).toEqual(
          expect.objectContaining({
            estimatedContextTokens: expect.any(Number),
            providerTokens: 0,
            providerCost: 0,
            providerDispatchCount: 0,
            networkRequestCount: 0,
          }),
        );
        expect(raw.latency).toEqual(
          expect.objectContaining({
            latencyEstimateMs: expect.any(Number),
            vectorLatencyEstimateMs: expect.any(Number),
            graphLatencyEstimateMs: expect.any(Number),
            fusionLatencyEstimateMs: expect.any(Number),
            rerankLatencyEstimateMs: expect.any(Number),
            measurementMode: "deterministic_operation_model_not_wall_clock",
            realWorldLatencyClaimable: false,
          }),
        );
        expect(raw.trace.includedSourceIds).toEqual(raw.rankedDocumentIds);
        expect(raw.trace.selectedEvidenceRefs.map(({ sourceId }) => sourceId)).toEqual(
          raw.rankedDocumentIds,
        );
        expect(raw.trace.includedSourceIds.length + raw.trace.omittedSources.length).toBe(
          raw.trace.corpusDocumentCount,
        );
      }

      expect(report.rawResults.some(({ safety }) => safety.ftsFallbackOccurred)).toBe(true);
      expect(report.aggregates).toHaveLength(6);
      expect(
        report.aggregates.every(
          (aggregate) =>
            aggregate.sampleCount === 48 &&
            aggregate.canonViolationRate === 0 &&
            aggregate.staleHitRate === 0 &&
            aggregate.rejectedCandidateContaminationRate === 0 &&
            aggregate.branchLeakageRate === 0 &&
            aggregate.povLeakageRate === 0 &&
            aggregate.futureKnowledgeLeakageRate === 0 &&
            aggregate.privateLeakageCount === 0 &&
            aggregate.evidenceRefCompleteness === 1 &&
            aggregate.traceCompleteness === 1 &&
            aggregate.emptyResultCorrectness === 1 &&
            aggregate.findingEvidenceRatio === 1 &&
            aggregate.providerDispatchCount === 0 &&
            aggregate.networkRequestCount === 0,
        ),
      ).toBe(true);
      expect(report.realUserAcceptance).toEqual({
        status: "insufficient_sample",
        observationCount: 0,
        acceptedCount: null,
        rejectedCount: null,
        acceptanceRate: null,
        reason: "no_real_user_observations",
      });
      expect(report.improvementClaim.status).toBe("not_claimed");
      expect(report.defaultPathDecision.method).toBe("fts_baseline");
      expect(report.defaultPathDecision.stableImprovementRequirement).toBe(
        "strictly_higher_ndcg_at_every_corpus_with_no_safety_regression",
      );
      expect(report.defaultPathDecision.complexMethodsMeetingRequirement).toEqual([
        "fts_vector_local_rerank",
      ]);
      expect(report.defaultPathDecision.reason).toContain(
        "fixture-only evidence does not replace commit-bound production telemetry",
      );
      expect(report.methodDisclosures).toHaveLength(6);
      expect(report.methodDisclosures.map(({ method }) => method)).toEqual(
        LONG_FORM_RETRIEVAL_BENCHMARK_METHODS,
      );
      expect(
        report.methodDisclosures.every(
          ({ execution, productionEquivalent, status }) =>
            execution === "local_deterministic" &&
            !productionEquivalent &&
            status === "evaluated_fixed_fixture",
        ),
      ).toBe(true);
      expect(report.unavailableComparisons).toEqual([
        expect.objectContaining({ method: "provider_rerank", status: "not_authorized" }),
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("emits stable raw JSON across rebuild and simulated restart", async () => {
    const first = await runLongFormRetrievalBenchmark();
    const serializedBeforeRestart = serializeLongFormRetrievalBenchmarkReport(first);
    const restoredSnapshot = JSON.parse(serializedBeforeRestart) as unknown;
    const rebuiltAfterRestart = await runLongFormRetrievalBenchmark();
    const serializedAfterRestart = serializeLongFormRetrievalBenchmarkReport(rebuiltAfterRestart);

    expect(serializedAfterRestart).toBe(serializedBeforeRestart);
    expect(restoredSnapshot).toEqual(rebuiltAfterRestart);
    expect(serializedBeforeRestart.endsWith("\n")).toBe(true);
    expect(serializedBeforeRestart).not.toContain("createdAt");
    expect(serializedBeforeRestart).not.toContain("cachePath");
    expect(rebuiltAfterRestart.reproducibility).toEqual({
      fixedCorpusTargets: LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS,
      fixedScenarioSet: LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS,
      rebuildDeterminism: "verified_by_independent_run_equality",
      restartRecovery: "verified_for_rebuilt_in_memory_fixture",
      sourceRevision: "WORKTREE_UNBOUND",
    });
  });
});
