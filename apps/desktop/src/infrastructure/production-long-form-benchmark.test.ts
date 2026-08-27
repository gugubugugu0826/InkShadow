import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ContentHasher } from "@inkshadow/application";
import {
  LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS,
  LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION,
  LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS,
  buildLongFormRetrievalBenchmarkFixtures,
  estimateContextTokensUtf8Conservative,
  evaluateRetrievalRanking,
  type LongFormBenchmarkDocument,
  type LongFormBenchmarkSample,
  type LongFormRetrievalBenchmarkFixture,
  type RetrievalEvaluationResult,
  type StoryMemoryReadResult,
} from "@inkshadow/ai-core";
import { ProjectSeedSqliteStore, createSqliteRepositories } from "@inkshadow/data";
import {
  AiCandidate,
  Chapter,
  ChapterVersion,
  Project,
  parseUuidV7,
  type Clock,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import { CryptoContentHasher } from "@inkshadow/platform";
import type { SearchChunkKind, SearchDocument, SearchRetrievalScope } from "@inkshadow/search-core";
import {
  CausalEventGraph,
  SqliteMemoryRecordRepository,
  SqliteOutlineRepository,
  SqliteStoryFactStore,
  StoryFact,
} from "@inkshadow/story-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { ConsistencyInvestigationService } from "./consistency-investigation-service";
import { recoverConsistencyInvestigationsAtStartup } from "./consistency-investigation-recovery";
import { ConsistencyInvestigationSqliteStore } from "./consistency-investigation-store";
import { ConsistencyInvestigationToolRegistry } from "./consistency-investigation-tool-registry";
import { SqliteContextCompilationTraceStore } from "./context-compilation-trace-store";
import { TauriModelHubStore, type ModelCatalogEntry } from "./model-hub-store";
import type { ChapterNovelValidationResult } from "./novel-validation-runtime";
import { ProjectContextPrivacyAuthority } from "./project-context-privacy-authority";
import { LocalProjectSearchService } from "./project-search";
import { TauriProjectSearchSnapshotStore } from "./project-search-store";
import type { NativeModelGatewayClient } from "./runtime";
import { CompositeStoryMemoryReadModel } from "./story-memory-read-model";
import { TauriTaskCenterStore } from "./task-center-store";

const NOW = "2026-08-20T00:00:00.000Z";
const TEST_SOURCE_REVISION = "1111111111111111111111111111111111111111";
const BENCHMARK_SCHEMA_VERSION = "inkshadow.production-long-form-benchmark.v1" as const;
const BENCHMARK_K = 5;
const WRITE_ENVIRONMENT_VARIABLE = "INKSHADOW_WRITE_LONG_FORM_BENCHMARK";
const SOURCE_REVISION_ENVIRONMENT_VARIABLE = "INKSHADOW_SOURCE_REVISION";
const SEARCH_PROJECT_IDS = LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS.map((_, index) =>
  uuid(100 + index),
);
const MEMORY_PROJECT_ID = uuid(200);
const AGENT_PROJECT_ID = uuid(300);
const MAIN_BRANCH_SCOPE = null;

interface ProductionSearchEvidenceRef {
  readonly sourceType: SearchDocument["sourceType"];
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly locator: Readonly<{ startUtf16: number; endUtf16: number; sourceLength: number }>;
  readonly contentHash: string;
}

interface ProductionSearchRawResult {
  readonly corpusCharacterTarget: number;
  readonly sampleId: string;
  readonly scenario: LongFormBenchmarkSample["scenario"];
  readonly method: "product_sqlite_fts_only";
  readonly rankedDocumentIds: readonly string[];
  readonly relevantDocumentIds: readonly string[];
  readonly ranking: RetrievalEvaluationResult;
  readonly falseInclusionRate: number;
  readonly canonViolationRate: number;
  readonly staleVersionLeakageRate: number;
  readonly branchLeakageRate: number;
  readonly povLeakageRate: number;
  readonly futureKnowledgeLeakageRate: number;
  readonly privateLeakageRate: number;
  readonly evidenceRefCompleteness: number;
  readonly traceCompleteness: number;
  readonly selectedEvidenceRefs: readonly ProductionSearchEvidenceRef[];
  readonly omittedSourceReasons: readonly Readonly<{
    readonly sourceId: string;
    readonly reasons: readonly string[];
  }>[];
  readonly estimatedContextTokens: number;
  readonly latency: Readonly<{
    readonly wallClockMilliseconds: number;
    readonly measurementMode: "local_process_wall_clock";
    readonly realWorldLatencyClaimable: false;
  }>;
  readonly rerank: Readonly<{
    readonly applied: false;
    readonly latencyMilliseconds: 0;
    readonly reason: "production_ordinary_path_is_fts_only";
  }>;
  readonly emptyResultCorrectness: number;
  readonly ftsFallbackOccurred: boolean;
  readonly retrievalScopeComplete: boolean;
}

interface SearchAggregate {
  readonly sampleCount: number;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly meanReciprocalRank: number;
  readonly normalizedDiscountedCumulativeGain: number;
  readonly hitRate: number;
  readonly falseInclusionRate: number;
  readonly authorityPrecision: number;
  readonly canonViolationRate: number;
  readonly staleVersionLeakageRate: number;
  readonly rejectedCandidateContaminationRate: number;
  readonly branchLeakageRate: number;
  readonly povLeakageRate: number;
  readonly futureKnowledgeLeakageRate: number;
  readonly privateLeakageCount: number;
  readonly evidenceRefCompleteness: number;
  readonly traceCompleteness: number;
  readonly emptyResultCorrectness: number;
  readonly ftsFallbackRate: number;
  readonly averageEstimatedContextTokens: number;
  readonly averageWallClockMilliseconds: number;
  readonly averageRerankLatencyMilliseconds: 0;
}

interface ProductionLongFormBenchmarkReport {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly sourceRevision: string;
  readonly fixtureVersion: typeof LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION;
  readonly evaluatedAtK: number;
  readonly execution: Readonly<{
    readonly database: "temporary_file_backed_node_sqlite";
    readonly schemaHead: "0080_candidate_selection_action.sql";
    readonly searchPath: "LocalProjectSearchService.searchFtsOnly+TauriProjectSearchSnapshotStore";
    readonly storyMemoryPath: "CompositeStoryMemoryReadModel+SQLite_authority_repositories";
    readonly agentPath: "ConsistencyInvestigationService+ConsistencyInvestigationToolRegistry";
    readonly providerBoundary: "counted_fake_gateway_only";
    readonly productionSearchPath: true;
    readonly productionStoryMemoryPath: true;
    readonly productionAgentServicePath: true;
    readonly realProviderDispatchCount: 0;
    readonly networkRequestCount: 0;
    readonly realCredentialReadCount: 0;
    readonly vectorOrEmbeddingDispatchCount: 0;
    readonly generatedCacheFilesCommitted: 0;
    readonly deterministicFixtureDisclosure: string;
  }>;
  readonly environment: Readonly<{
    readonly command: string;
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
  }>;
  readonly corpusSummaries: readonly Readonly<{
    readonly characterTarget: number;
    readonly actualCharacterCount: number;
    readonly documentCount: number;
    readonly sampleCount: number;
    readonly chunkKinds: readonly string[];
    readonly sqliteBackend: "fts5_trigram";
  }>[];
  readonly rawSearchResults: readonly ProductionSearchRawResult[];
  readonly searchAggregatesByCorpus: readonly Readonly<{
    readonly characterTarget: number;
    readonly metrics: SearchAggregate;
  }>[];
  readonly searchAggregate: SearchAggregate;
  readonly rebuild: Readonly<{
    readonly productStoreForceRebuildDeterminism: number;
    readonly comparedScenarioCount: number;
    readonly wallClockMilliseconds: number;
  }>;
  readonly restart: Readonly<{
    readonly fileBackedSqliteRecovery: number;
    readonly comparedScenarioCount: number;
    readonly searchRankingEquality: number;
    readonly storyMemoryTraceEquality: number;
    readonly agentNoRedispatch: number;
    readonly agentRecoveredRunCount: number;
    readonly wallClockMilliseconds: number;
  }>;
  readonly storyMemory: Readonly<{
    readonly localAcceptedChapterCount: number;
    readonly remoteAcceptedChapterCount: number;
    readonly confirmedCanonCount: number;
    readonly evidenceRefCompleteness: number;
    readonly traceCompleteness: number;
    readonly privateExclusionCount: number;
    readonly rejectedCandidateExclusionCount: number;
    readonly branchExclusionCount: number;
    readonly privateLeakageCount: number;
    readonly rejectedCandidateLeakageCount: number;
    readonly branchLeakageCount: number;
  }>;
  readonly agent: Readonly<{
    readonly representativeRunCount: number;
    readonly callsBeforeConfirmation: number;
    readonly disclosedConfirmedCallCount: number;
    readonly fakeGatewayDispatchCount: number;
    readonly retryCount: 0;
    readonly findingCount: number;
    readonly findingEvidenceRatio: number;
    readonly hallucinatedFindingSubmittedCount: number;
    readonly hallucinatedFindingAcceptedCount: number;
    readonly invalidToolAttemptCount: number;
    readonly invalidToolRejectedCount: number;
    readonly invalidToolAcceptedCount: 0;
    readonly hiddenProviderCallCount: number;
    readonly duplicateDispatchCount: number;
    readonly traceCompleteness: number;
    readonly estimatedInputTokens: number;
    readonly reportedProviderInputTokens: number;
    readonly reportedProviderOutputTokens: number;
    readonly wallClockMilliseconds: number;
    readonly restartNoRedispatch: number;
  }>;
  readonly realUserAcceptance: Readonly<{
    readonly status: "insufficient_sample";
    readonly observationCount: 0;
    readonly acceptanceRate: null;
    readonly reason: "no_real_user_observations";
  }>;
  readonly claims: Readonly<{
    readonly productionSearchMetrics: "measured";
    readonly productionStoryMemorySafety: "measured";
    readonly productionAgentControlFlow: "measured_with_fake_gateway";
    readonly realProviderQuality: "not_measured";
    readonly realUserAcceptance: "insufficient_sample";
    readonly improvementPercentage: "not_claimed_single_production_baseline";
  }>;
}

interface SearchFixtureState {
  readonly fixture: LongFormRetrievalBenchmarkFixture;
  readonly projectId: UuidV7;
  readonly documents: readonly SearchDocument[];
}

interface StoryMemoryBenchmarkState {
  readonly request: Parameters<CompositeStoryMemoryReadModel["read"]>[0];
  readonly local: StoryMemoryReadResult;
  readonly remote: StoryMemoryReadResult;
  readonly privateText: string;
  readonly rejectedText: string;
  readonly branchText: string;
}

interface AgentBenchmarkState {
  readonly validRunId: string;
  readonly fakeGateway: CountingFakeGateway;
  readonly metrics: ProductionLongFormBenchmarkReport["agent"];
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("commit-bound production long-form Memory + Agent benchmark", () => {
  it("rejects an unbound or malformed source revision", () => {
    expect(() => requireBoundSourceRevision(undefined)).toThrow("INKSHADOW_SOURCE_REVISION");
    expect(() => requireBoundSourceRevision("WORKTREE_UNBOUND")).toThrow(
      "INKSHADOW_SOURCE_REVISION",
    );
    expect(() => requireBoundSourceRevision("abc")).toThrow("INKSHADOW_SOURCE_REVISION");
    expect(requireBoundSourceRevision(TEST_SOURCE_REVISION)).toBe(TEST_SOURCE_REVISION);
  });

  it("runs 48 fixed scenarios through product SQLite FTS, StoryMemory and the active Agent service", async () => {
    const shouldWrite = process.env[WRITE_ENVIRONMENT_VARIABLE] === "1";
    const sourceRevision = shouldWrite
      ? requireBoundSourceRevision(process.env[SOURCE_REVISION_ENVIRONMENT_VARIABLE])
      : TEST_SOURCE_REVISION;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const report = await runProductionLongFormBenchmark(sourceRevision);

      expect(report.schemaVersion).toBe(BENCHMARK_SCHEMA_VERSION);
      expect(report.sourceRevision).toBe(sourceRevision);
      expect(report.rawSearchResults).toHaveLength(48);
      expect(report.corpusSummaries.map(({ characterTarget }) => characterTarget)).toEqual([
        5_000, 20_000, 50_000, 200_000,
      ]);
      expect(
        report.corpusSummaries.map(({ actualCharacterCount }) => actualCharacterCount),
      ).toEqual([5_000, 20_000, 50_000, 200_000]);
      expect(report.corpusSummaries.every(({ sampleCount }) => sampleCount === 12)).toBe(true);
      expect(
        report.corpusSummaries.every(({ chunkKinds }) =>
          ["chapter", "dialogue", "event", "paragraph", "scene", "story_fact_evidence"].every(
            (chunkKind) => chunkKinds.includes(chunkKind),
          ),
        ),
      ).toBe(true);
      expect(new Set(report.rawSearchResults.map(({ scenario }) => scenario))).toEqual(
        new Set(LONG_FORM_RETRIEVAL_BENCHMARK_SCENARIOS),
      );
      const stableSearchOrder = report.rawSearchResults.map(
        ({ corpusCharacterTarget, sampleId }) =>
          `${String(corpusCharacterTarget).padStart(6, "0")}:${sampleId}`,
      );
      expect(stableSearchOrder).toEqual([...stableSearchOrder].sort());
      expect(
        report.rawSearchResults
          .filter(
            (result) =>
              result.evidenceRefCompleteness !== 1 ||
              result.traceCompleteness !== 1 ||
              !result.retrievalScopeComplete ||
              result.canonViolationRate !== 0 ||
              result.staleVersionLeakageRate !== 0 ||
              result.branchLeakageRate !== 0 ||
              result.povLeakageRate !== 0 ||
              result.futureKnowledgeLeakageRate !== 0 ||
              result.privateLeakageRate !== 0,
          )
          .map((result) => ({
            corpus: result.corpusCharacterTarget,
            sampleId: result.sampleId,
            evidence: result.evidenceRefCompleteness,
            trace: result.traceCompleteness,
            canon: result.canonViolationRate,
            stale: result.staleVersionLeakageRate,
            branch: result.branchLeakageRate,
            pov: result.povLeakageRate,
            future: result.futureKnowledgeLeakageRate,
            private: result.privateLeakageRate,
          })),
      ).toEqual([]);
      expect(report.rebuild).toMatchObject({
        productStoreForceRebuildDeterminism: 1,
        comparedScenarioCount: 48,
      });
      expect(report.searchAggregate).toMatchObject({
        sampleCount: 48,
        canonViolationRate: 0,
        staleVersionLeakageRate: 0,
        rejectedCandidateContaminationRate: 0,
        branchLeakageRate: 0,
        povLeakageRate: 0,
        futureKnowledgeLeakageRate: 0,
        privateLeakageCount: 0,
        evidenceRefCompleteness: 1,
        traceCompleteness: 1,
        emptyResultCorrectness: 1,
        averageRerankLatencyMilliseconds: 0,
      });
      expect(report.searchAggregatesByCorpus).toHaveLength(4);
      expect(
        report.searchAggregatesByCorpus.every(
          ({ metrics }) =>
            metrics.sampleCount === 12 &&
            metrics.canonViolationRate === 0 &&
            metrics.staleVersionLeakageRate === 0 &&
            metrics.branchLeakageRate === 0 &&
            metrics.povLeakageRate === 0 &&
            metrics.futureKnowledgeLeakageRate === 0 &&
            metrics.privateLeakageCount === 0 &&
            metrics.evidenceRefCompleteness === 1 &&
            metrics.traceCompleteness === 1 &&
            metrics.emptyResultCorrectness === 1,
        ),
      ).toBe(true);
      expect(report.searchAggregate.ftsFallbackRate).toBeGreaterThan(0);
      expect(report.restart).toMatchObject({
        fileBackedSqliteRecovery: 1,
        comparedScenarioCount: 48,
        searchRankingEquality: 1,
        storyMemoryTraceEquality: 1,
        agentNoRedispatch: 1,
        agentRecoveredRunCount: 1,
      });
      expect(report.storyMemory).toMatchObject({
        evidenceRefCompleteness: 1,
        traceCompleteness: 1,
        privateLeakageCount: 0,
        rejectedCandidateLeakageCount: 0,
        branchLeakageCount: 0,
      });
      expect(report.storyMemory.privateExclusionCount).toBeGreaterThan(0);
      expect(report.storyMemory.rejectedCandidateExclusionCount).toBeGreaterThan(0);
      expect(report.storyMemory.branchExclusionCount).toBeGreaterThan(0);
      expect(report.agent).toMatchObject({
        callsBeforeConfirmation: 0,
        disclosedConfirmedCallCount: 2,
        fakeGatewayDispatchCount: 2,
        retryCount: 0,
        findingCount: 1,
        findingEvidenceRatio: 1,
        hallucinatedFindingSubmittedCount: 1,
        hallucinatedFindingAcceptedCount: 0,
        invalidToolAttemptCount: 1,
        invalidToolRejectedCount: 1,
        invalidToolAcceptedCount: 0,
        hiddenProviderCallCount: 0,
        duplicateDispatchCount: 0,
        traceCompleteness: 1,
        restartNoRedispatch: 1,
      });
      expect(report.execution).toMatchObject({
        realProviderDispatchCount: 0,
        networkRequestCount: 0,
        realCredentialReadCount: 0,
        vectorOrEmbeddingDispatchCount: 0,
      });
      expect(report.realUserAcceptance).toEqual({
        status: "insufficient_sample",
        observationCount: 0,
        acceptanceRate: null,
        reason: "no_real_user_observations",
      });
      expect(report.claims).toEqual({
        productionSearchMetrics: "measured",
        productionStoryMemorySafety: "measured",
        productionAgentControlFlow: "measured_with_fake_gateway",
        realProviderQuality: "not_measured",
        realUserAcceptance: "insufficient_sample",
        improvementPercentage: "not_claimed_single_production_baseline",
      });
      expect(fetchSpy).not.toHaveBeenCalled();

      if (shouldWrite) {
        const outputPath = writeRawBenchmarkReport(report);
        process.stdout.write(`[production-long-form-benchmark] raw_json=${outputPath}\n`);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  }, 120_000);
});

async function runProductionLongFormBenchmark(
  sourceRevisionValue: string,
): Promise<ProductionLongFormBenchmarkReport> {
  const sourceRevision = requireBoundSourceRevision(sourceRevisionValue);
  const workspaceRoot = findWorkspaceRoot();
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "inkshadow-production-long-form-"));
  temporaryDirectories.push(temporaryDirectory);
  const databasePath = path.join(temporaryDirectory, "benchmark.sqlite3");
  const migration = readCurrentLocalSchema(workspaceRoot);
  const hasher = new CryptoContentHasher();
  const clock = fixedClock();
  let executor = new NodeSqliteExecutor(migration, databasePath);
  let executorOpen = true;
  try {
    const fixtureStates = await seedSearchFixtures(executor, hasher, clock);
    const firstSearch = await runSearchMatrix(executor, fixtureStates);
    const rebuildStartedAt = performance.now();
    const rebuiltSearch = await rebuildAndRunSearchMatrix(executor, fixtureStates);
    const rebuildMilliseconds = roundedMilliseconds(performance.now() - rebuildStartedAt);
    const rebuildDeterministic = sameRankings(firstSearch, rebuiltSearch);

    const storyMemory = await seedAndRunStoryMemoryBenchmark(executor, hasher, clock);
    const agent = await seedAndRunAgentBenchmark(executor, hasher, clock);
    const gatewayCountBeforeRestart = agent.fakeGateway.callCount;

    await executor.close();
    executorOpen = false;

    const restartStartedAt = performance.now();
    executor = new NodeSqliteExecutor("", databasePath);
    executorOpen = true;
    const restartedSearch = await runSearchMatrix(executor, fixtureStates);
    const restartedMemory = await createStoryMemoryModel(executor, hasher).read(
      storyMemory.request,
    );
    const restartedAgent = createAgentService(executor, hasher, clock, agent.fakeGateway);
    const recoveredCount = await recoverConsistencyInvestigationsAtStartup({
      executor,
      taskCenter: restartedAgent.taskCenter,
      clock,
      ids: new SequentialIds(90_000),
    });
    const replay = await restartedAgent.service.run({
      runId: agent.validRunId,
      humanConfirmed: true,
    });
    const restartMilliseconds = roundedMilliseconds(performance.now() - restartStartedAt);
    const restartNoRedispatch =
      replay.run.status === "succeeded" &&
      agent.fakeGateway.callCount === gatewayCountBeforeRestart;

    const rawSearchResults = Object.freeze(
      [...firstSearch].sort((left, right) =>
        `${String(left.corpusCharacterTarget).padStart(6, "0")}:${left.sampleId}`.localeCompare(
          `${String(right.corpusCharacterTarget).padStart(6, "0")}:${right.sampleId}`,
        ),
      ),
    );
    const storyMemoryMetrics = evaluateStoryMemory(storyMemory);
    const restartMemoryTraceEquality =
      stableJson(storyMemory.remote.contextDecisionTrace) ===
        stableJson(restartedMemory.contextDecisionTrace) &&
      stableJson(storyMemory.remote.evidenceRefs) === stableJson(restartedMemory.evidenceRefs);
    const report: ProductionLongFormBenchmarkReport = Object.freeze({
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      sourceRevision,
      fixtureVersion: LONG_FORM_RETRIEVAL_BENCHMARK_FIXTURE_VERSION,
      evaluatedAtK: BENCHMARK_K,
      execution: Object.freeze({
        database: "temporary_file_backed_node_sqlite",
        schemaHead: "0080_candidate_selection_action.sql",
        searchPath: "LocalProjectSearchService.searchFtsOnly+TauriProjectSearchSnapshotStore",
        storyMemoryPath: "CompositeStoryMemoryReadModel+SQLite_authority_repositories",
        agentPath: "ConsistencyInvestigationService+ConsistencyInvestigationToolRegistry",
        providerBoundary: "counted_fake_gateway_only",
        productionSearchPath: true,
        productionStoryMemoryPath: true,
        productionAgentServicePath: true,
        realProviderDispatchCount: 0,
        networkRequestCount: 0,
        realCredentialReadCount: 0,
        vectorOrEmbeddingDispatchCount: 0,
        generatedCacheFilesCommitted: 0,
        deterministicFixtureDisclosure:
          "The existing six-arm ai-core fixture remains non-production. This report uses its fixed corpora and relevance labels only; ranking is produced by current product SQLite/search APIs.",
      }),
      environment: Object.freeze({
        command: "INKSHADOW_SOURCE_REVISION=<40-hex-commit> pnpm benchmark:long-form:production",
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      }),
      corpusSummaries: Object.freeze(
        fixtureStates.map(({ fixture, documents }) =>
          Object.freeze({
            characterTarget: fixture.characterTarget,
            actualCharacterCount: fixture.actualCharacterCount,
            documentCount: documents.length,
            sampleCount: fixture.samples.length,
            chunkKinds: Object.freeze(
              [...new Set(documents.map(({ chunkKind }) => chunkKind ?? "chapter"))].sort(),
            ),
            sqliteBackend: "fts5_trigram" as const,
          }),
        ),
      ),
      rawSearchResults,
      searchAggregatesByCorpus: Object.freeze(
        LONG_FORM_RETRIEVAL_BENCHMARK_CHARACTER_TARGETS.map((characterTarget) =>
          Object.freeze({
            characterTarget,
            metrics: aggregateSearch(
              rawSearchResults.filter(
                ({ corpusCharacterTarget }) => corpusCharacterTarget === characterTarget,
              ),
            ),
          }),
        ),
      ),
      searchAggregate: aggregateSearch(rawSearchResults),
      rebuild: Object.freeze({
        productStoreForceRebuildDeterminism: rebuildDeterministic ? 1 : 0,
        comparedScenarioCount: rebuiltSearch.length,
        wallClockMilliseconds: rebuildMilliseconds,
      }),
      restart: Object.freeze({
        fileBackedSqliteRecovery: 1,
        comparedScenarioCount: restartedSearch.length,
        searchRankingEquality: sameRankings(firstSearch, restartedSearch) ? 1 : 0,
        storyMemoryTraceEquality: restartMemoryTraceEquality ? 1 : 0,
        agentNoRedispatch: restartNoRedispatch ? 1 : 0,
        agentRecoveredRunCount: recoveredCount,
        wallClockMilliseconds: restartMilliseconds,
      }),
      storyMemory: storyMemoryMetrics,
      agent: Object.freeze({
        ...agent.metrics,
        restartNoRedispatch: restartNoRedispatch ? 1 : 0,
        duplicateDispatchCount:
          agent.metrics.duplicateDispatchCount + (restartNoRedispatch ? 0 : 1),
      }),
      realUserAcceptance: Object.freeze({
        status: "insufficient_sample",
        observationCount: 0,
        acceptanceRate: null,
        reason: "no_real_user_observations",
      }),
      claims: Object.freeze({
        productionSearchMetrics: "measured",
        productionStoryMemorySafety: "measured",
        productionAgentControlFlow: "measured_with_fake_gateway",
        realProviderQuality: "not_measured",
        realUserAcceptance: "insufficient_sample",
        improvementPercentage: "not_claimed_single_production_baseline",
      }),
    });
    return report;
  } finally {
    if (executorOpen) await executor.close();
  }
}

async function seedSearchFixtures(
  executor: NodeSqliteExecutor,
  hasher: ContentHasher,
  clock: Clock,
): Promise<readonly SearchFixtureState[]> {
  const fixtures = buildLongFormRetrievalBenchmarkFixtures();
  const repositories = createSqliteRepositories(executor);
  const snapshots = new TauriProjectSearchSnapshotStore(executor);
  const states: SearchFixtureState[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const projectId = parseId(SEARCH_PROJECT_IDS[index] ?? uuid(100 + index));
    await createProject(repositories, projectId, `长篇检索 ${String(fixture.characterTarget)}`);
    const documents = await Promise.all(
      fixture.documents.map((document, documentIndex) =>
        toSearchDocument(projectId, document, documentIndex, hasher),
      ),
    );
    await snapshots.synchronizeProject({
      projectId,
      documents,
      indexedAt: clock.now(),
    });
    states.push(Object.freeze({ fixture, projectId, documents: Object.freeze(documents) }));
  }
  return Object.freeze(states);
}

async function runSearchMatrix(
  executor: NodeSqliteExecutor,
  states: readonly SearchFixtureState[],
): Promise<readonly ProductionSearchRawResult[]> {
  const runtime = createSearchRuntime(executor);
  const results: ProductionSearchRawResult[] = [];
  for (const state of states) {
    for (const sample of state.fixture.samples) {
      results.push(await evaluateProductSearch(runtime, state, sample));
    }
  }
  return Object.freeze(results);
}

async function rebuildAndRunSearchMatrix(
  executor: NodeSqliteExecutor,
  states: readonly SearchFixtureState[],
): Promise<readonly ProductionSearchRawResult[]> {
  const snapshots = new TauriProjectSearchSnapshotStore(executor);
  for (const state of states) {
    await snapshots.synchronizeProject({
      projectId: state.projectId,
      documents: state.documents,
      indexedAt: NOW,
      force: true,
    });
  }
  return runSearchMatrix(executor, states);
}

async function evaluateProductSearch(
  search: LocalProjectSearchService,
  state: SearchFixtureState,
  sample: LongFormBenchmarkSample,
): Promise<ProductionSearchRawResult> {
  const scope: SearchRetrievalScope = Object.freeze({
    projectId: state.projectId,
    taskType: "agent_fts",
    privacy: sample.scope.allowPrivate ? "include_local_only" : "standard_only",
    currentness: "current",
    branchId: MAIN_BRANCH_SCOPE,
    povCharacterId:
      sample.scope.povCharacterId === "omniscient" ? null : sample.scope.povCharacterId,
    maximumStoryOrder: sample.scope.maximumStoryOrder,
  });
  const startedAt = performance.now();
  const result = await search.searchFtsOnly(state.projectId, sample.query, scope, BENCHMARK_K);
  const wallClockMilliseconds = roundedMilliseconds(performance.now() - startedAt);
  if (!result.ok) throw result.error;
  const rankedDocumentIds = Object.freeze(result.value.hits.map(({ document }) => document.id));
  const byId = new Map(state.fixture.documents.map((document) => [document.id, document]));
  const rankedDocuments = rankedDocumentIds.flatMap((id) => {
    const document = byId.get(id);
    return document === undefined ? [] : [document];
  });
  const authoritativeIds = state.fixture.documents
    .filter(isAuthoritativeFixtureDocument)
    .map(({ id }) => id);
  const staleIds = state.fixture.documents
    .filter(({ currentness }) => currentness !== "current")
    .map(({ id }) => id);
  const rejectedIds = state.fixture.documents
    .filter(({ authority }) => authority === "rejected_candidate")
    .map(({ id }) => id);
  const privateIds = state.fixture.documents
    .filter(({ privacy }) => privacy === "private")
    .map(({ id }) => id);
  const ranking = evaluateRetrievalRanking({
    rankedIds: rankedDocumentIds,
    relevantIds: sample.relevantDocumentIds,
    authoritativeIds,
    staleIds,
    rejectedCandidateIds: rejectedIds,
    privateIds,
    limit: BENCHMARK_K,
  });
  const selectedEvidenceRefs = Object.freeze(
    result.value.hits.map(({ document }) => toProductionEvidenceRef(document)),
  );
  const traceComplete =
    result.value.retrievalScopeTrace?.omittedHardFilters.length === 0 &&
    result.value.hits.every(({ document, evidence }) =>
      selectedEvidenceIsComplete(document, evidence.sourceVersionId, evidence.contentHash),
    );
  return Object.freeze({
    corpusCharacterTarget: state.fixture.characterTarget,
    sampleId: sample.id,
    scenario: sample.scenario,
    method: "product_sqlite_fts_only",
    rankedDocumentIds,
    relevantDocumentIds: Object.freeze([...sample.relevantDocumentIds]),
    ranking,
    falseInclusionRate: zeroSafeRate(
      rankedDocumentIds.filter((id) => !sample.relevantDocumentIds.includes(id)).length,
      rankedDocumentIds.length,
    ),
    canonViolationRate: zeroSafeRate(
      rankedDocuments.filter(({ canon }) => canon !== "canonical").length,
      rankedDocuments.length,
    ),
    staleVersionLeakageRate: zeroSafeRate(
      rankedDocuments.filter(({ currentness }) => currentness !== "current").length,
      rankedDocuments.length,
    ),
    branchLeakageRate: zeroSafeRate(
      rankedDocuments.filter(({ branchId }) => branchId === "alternate").length,
      rankedDocuments.length,
    ),
    povLeakageRate: zeroSafeRate(
      rankedDocuments.filter(
        ({ povCharacterId }) =>
          povCharacterId !== "omniscient" && povCharacterId !== sample.scope.povCharacterId,
      ).length,
      rankedDocuments.length,
    ),
    futureKnowledgeLeakageRate: zeroSafeRate(
      rankedDocuments.filter(({ storyOrder }) => storyOrder > sample.scope.maximumStoryOrder)
        .length,
      rankedDocuments.length,
    ),
    privateLeakageRate: zeroSafeRate(
      rankedDocuments.filter(({ privacy }) => privacy === "private").length,
      rankedDocuments.length,
    ),
    evidenceRefCompleteness: ratio(
      selectedEvidenceRefs.filter(evidenceRefIsComplete).length,
      selectedEvidenceRefs.length,
    ),
    traceCompleteness: traceComplete ? 1 : 0,
    selectedEvidenceRefs,
    omittedSourceReasons: Object.freeze(
      state.fixture.documents
        .filter(({ id }) => !rankedDocumentIds.includes(id))
        .map((document) =>
          Object.freeze({
            sourceId: document.id,
            reasons: Object.freeze(evaluationOmissionReasons(document, sample)),
          }),
        )
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    ),
    estimatedContextTokens:
      result.value.hits.length === 0
        ? 0
        : estimateContextTokensUtf8Conservative(
            result.value.hits.map(({ document }) => document.text).join("\n"),
          ),
    latency: Object.freeze({
      wallClockMilliseconds,
      measurementMode: "local_process_wall_clock",
      realWorldLatencyClaimable: false,
    }),
    rerank: Object.freeze({
      applied: false,
      latencyMilliseconds: 0,
      reason: "production_ordinary_path_is_fts_only",
    }),
    emptyResultCorrectness: sample.expectedEmpty === (rankedDocumentIds.length === 0) ? 1 : 0,
    ftsFallbackOccurred:
      sample.localRerankAvailability === "unavailable_use_fts_fallback" &&
      result.value.notices.includes("fts_only_read_only_no_embedding_or_gateway"),
    retrievalScopeComplete: traceComplete,
  });
}

async function seedAndRunStoryMemoryBenchmark(
  executor: NodeSqliteExecutor,
  hasher: ContentHasher,
  clock: Clock,
): Promise<StoryMemoryBenchmarkState> {
  const repositories = createSqliteRepositories(executor);
  const projectId = parseId(MEMORY_PROJECT_ID);
  await createProject(repositories, projectId, "StoryMemory 生产路径");
  const accepted = await createChapter(
    repositories,
    hasher,
    projectId,
    parseId(uuid(201)),
    parseId(uuid(202)),
    "已接受正文",
    "林晚确认银铃海港的暗号仍然有效。",
    "standard",
  );
  const privateText = "黑曜名册只保存在仅本机章节。";
  await createChapter(
    repositories,
    hasher,
    projectId,
    parseId(uuid(203)),
    parseId(uuid(204)),
    "仅本机章节",
    privateText,
    "local_only",
  );
  const facts = new SqliteStoryFactStore(executor);
  const confirmed = createConfirmedFact({
    id: parseId(uuid(205)),
    projectId,
    chapterId: accepted.chapter.id,
    versionId: accepted.version.id,
    chapterText: accepted.chapter.content,
    contentText: "银铃海港的暗号属于守夜人。",
  });
  unwrap(await facts.create(confirmed));
  const branchText = "另一分支中暗号已经失效。";
  const branch = unwrap(
    StoryFact.create({
      id: parseId(uuid(206)),
      projectId,
      factType: "world_rule",
      contentText: branchText,
      source: chapterSpan(accepted.chapter.id, accepted.version.id, accepted.chapter.content),
      branchId: parseId(uuid(207)),
      confidence: 1,
      status: "branch",
      origin: "user",
      needsReview: false,
      humanConfirmed: false,
      now: NOW,
    }),
  );
  unwrap(await facts.create(branch));

  const rejectedText = "被拒 Candidate 声称暗号改成蓝灯。";
  const candidateDigest = unwrap(await hasher.sha256(rejectedText));
  const streaming = unwrap(
    AiCandidate.createStreaming({
      id: parseId(uuid(208)),
      projectId,
      chapterId: accepted.chapter.id,
      baseVersionId: accepted.version.id,
      source: "generate",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: accepted.chapter.content.length,
        endUtf16: accepted.chapter.content.length,
      },
      now: NOW as never,
    }),
  );
  const ready = unwrap(streaming.markReady(rejectedText, candidateDigest, NOW as never));
  const rejected = unwrap(ready.reject(NOW as never));
  unwrap(await repositories.aiCandidates.create(rejected));

  const model = createStoryMemoryModel(executor, hasher);
  const request = Object.freeze({
    projectId,
    currentBranchId: null,
    currentChapterId: accepted.chapter.id,
    currentImmutableVersionId: accepted.version.id,
    currentPovCharacterId: null,
    currentStoryOrder: 2,
    taskType: "consistency_investigation" as const,
    privacy: "standard" as const,
    authorityRevision: 1,
    destination: "remote" as const,
    observedAt: clock.now(),
  });
  const [local, remote] = await Promise.all([
    model.read({ ...request, destination: "local" }),
    model.read(request),
  ]);
  return Object.freeze({ request, local, remote, privateText, rejectedText, branchText });
}

async function seedAndRunAgentBenchmark(
  executor: NodeSqliteExecutor,
  hasher: ContentHasher,
  clock: Clock,
): Promise<AgentBenchmarkState> {
  const repositories = createSqliteRepositories(executor);
  const projectId = parseId(AGENT_PROJECT_ID);
  await createProject(repositories, projectId, "一致性 Agent 生产路径");
  const first = await createChapter(
    repositories,
    hasher,
    projectId,
    parseId(uuid(301)),
    parseId(uuid(302)),
    "北城抵达",
    "林晚在冬至夜抵达北城。她记得这发生在典礼之前。",
    "standard",
  );
  await createChapter(
    repositories,
    hasher,
    projectId,
    parseId(uuid(303)),
    parseId(uuid(304)),
    "典礼记录",
    "北城档案确认典礼在冬至夜之前已经结束。",
    "standard",
  );
  const facts = new SqliteStoryFactStore(executor);
  unwrap(
    await facts.create(
      createConfirmedFact({
        id: parseId(uuid(305)),
        projectId,
        chapterId: first.chapter.id,
        versionId: first.version.id,
        chapterText: first.chapter.content,
        contentText: "北城典礼在林晚抵达前已经结束。",
      }),
    ),
  );
  const search = createSearchRuntime(executor);
  const rebuilt = await search.rebuildProject(projectId);
  if (!rebuilt.ok) throw rebuilt.error;

  const modelHub = new TauriModelHubStore(executor, clock);
  const target = await seedFakeAgentTarget(modelHub);
  await modelHub.saveTaskRoute({
    task: "contradiction_check",
    primaryCatalogEntryId: target.id,
    fallbackCatalogEntryId: null,
    parameterPolicy: { maximumOutputTokens: 4_096, temperature: 0 },
    maximumCostMicros: "100000",
    currency: "USD",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
  await assertFakeAgentTargetReadable(modelHub, target.id);
  const fakeGateway = new CountingFakeGateway();
  const runtime = createAgentService(executor, hasher, clock, fakeGateway);

  const preconfirmation = await runtime.service.prepare({ projectId });
  const callsBeforeConfirmation = fakeGateway.callCount;
  await runtime.service.run({ runId: preconfirmation.runId, humanConfirmed: false }).then(
    () => {
      throw new Error("Unconfirmed Agent benchmark run unexpectedly dispatched.");
    },
    () => undefined,
  );
  if (fakeGateway.callCount !== callsBeforeConfirmation) {
    throw new Error("The unconfirmed Agent benchmark crossed the fake gateway boundary.");
  }

  let invalidToolRejectedCount = 0;
  await runtime.tools
    .execute("write_story", { projectId, observedAt: clock.now(), destination: "remote" })
    .catch((cause: unknown) => {
      if (safeErrorCode(cause) === "AGENT_TOOL_NOT_REGISTERED") invalidToolRejectedCount = 1;
      else throw cause;
    });

  fakeGateway.enqueue(validAgentResponse());
  const validDisclosure = await runtime.service.prepare({ projectId });
  const validStartedAt = performance.now();
  const valid = await runtime.service.run({ runId: validDisclosure.runId, humanConfirmed: true });
  const validMilliseconds = performance.now() - validStartedAt;
  const afterValidCount = fakeGateway.callCount;
  await runtime.service.run({ runId: validDisclosure.runId, humanConfirmed: true });
  const duplicateAfterImmediateReplay = fakeGateway.callCount - afterValidCount;

  fakeGateway.enqueue(hallucinatedEvidenceResponse());
  const hallucinatedDisclosure = await runtime.service.prepare({ projectId });
  const hallucinatedStartedAt = performance.now();
  const hallucinated = await runtime.service.run({
    runId: hallucinatedDisclosure.runId,
    humanConfirmed: true,
  });
  const hallucinatedMilliseconds = performance.now() - hallucinatedStartedAt;
  const validEvidenceCount = valid.findings.reduce(
    (total, finding) => total + finding.evidence.length,
    0,
  );
  const findingEvidenceRatio = ratio(
    valid.findings.filter(({ evidence }) => evidence.length > 0).length,
    valid.findings.length,
  );
  const expectedDisclosedCalls =
    validDisclosure.maximumModelCalls + hallucinatedDisclosure.maximumModelCalls;
  const fakeGatewayDispatchCount = fakeGateway.callCount;
  const capturedRetryCounts = fakeGateway.requests.map(({ config }) => config.retryLimit);
  const metrics: ProductionLongFormBenchmarkReport["agent"] = Object.freeze({
    representativeRunCount: 3,
    callsBeforeConfirmation,
    disclosedConfirmedCallCount: expectedDisclosedCalls,
    fakeGatewayDispatchCount,
    retryCount: 0,
    findingCount: valid.findings.length,
    findingEvidenceRatio:
      validEvidenceCount > 0 && findingEvidenceRatio === 1 ? findingEvidenceRatio : 0,
    hallucinatedFindingSubmittedCount: 1,
    hallucinatedFindingAcceptedCount: hallucinated.findings.length,
    invalidToolAttemptCount: 1,
    invalidToolRejectedCount,
    invalidToolAcceptedCount: 0,
    hiddenProviderCallCount: Math.max(0, fakeGatewayDispatchCount - expectedDisclosedCalls),
    duplicateDispatchCount: duplicateAfterImmediateReplay,
    traceCompleteness:
      valid.run.contextTraceId !== null &&
      hallucinated.run.contextTraceId !== null &&
      valid.findings.every(({ evidence }) => evidence.length > 0)
        ? 1
        : 0,
    estimatedInputTokens:
      validDisclosure.estimatedInputTokens + hallucinatedDisclosure.estimatedInputTokens,
    reportedProviderInputTokens: fakeGateway.totalInputTokens,
    reportedProviderOutputTokens: fakeGateway.totalOutputTokens,
    wallClockMilliseconds: roundedMilliseconds(validMilliseconds + hallucinatedMilliseconds),
    restartNoRedispatch: 0,
  });
  if (capturedRetryCounts.some((retryCount) => retryCount !== 0)) {
    throw new Error("The production Agent benchmark observed an automatic retry configuration.");
  }
  return Object.freeze({ validRunId: valid.run.id, fakeGateway, metrics });
}

async function assertFakeAgentTargetReadable(
  modelHub: TauriModelHubStore,
  catalogEntryId: string,
): Promise<void> {
  const connections = await modelHub.listConnections();
  const connection = connections.find(({ id }) => id === "benchmark-fake-remote");
  if (connection === undefined) throw new Error("Benchmark fake connection is not readable.");
  const [catalog, evidence, cost, route] = await Promise.all([
    modelHub.listCatalog(connection.id),
    modelHub.listCapabilityEvidence(catalogEntryId),
    modelHub.findCostPrivacyProfile(catalogEntryId),
    modelHub.findTaskRoute("contradiction_check"),
  ]);
  if (
    !catalog.some(
      ({ id, availability }) => id === catalogEntryId && availability === "available",
    ) ||
    !evidence.some(
      ({ capability, verdict }) => capability === "text_generation" && verdict === "supported",
    ) ||
    cost?.dataDestination !== "remote" ||
    route?.primaryCatalogEntryId !== catalogEntryId
  ) {
    throw new Error("Benchmark fake Model Hub target did not round-trip through SQLite.");
  }
}

function createSearchRuntime(executor: NodeSqliteExecutor): LocalProjectSearchService {
  const repositories = createSqliteRepositories(executor);
  return new LocalProjectSearchService({
    projects: repositories.projects,
    chapters: repositories.chapters,
    outlines: new SqliteOutlineRepository(executor),
    storyFacts: new SqliteStoryFactStore(executor),
    snapshots: new TauriProjectSearchSnapshotStore(executor),
    hasher: new CryptoContentHasher(),
    clock: fixedClock(),
  });
}

function createStoryMemoryModel(
  executor: NodeSqliteExecutor,
  hasher: ContentHasher,
): CompositeStoryMemoryReadModel {
  const repositories = createSqliteRepositories(executor);
  return new CompositeStoryMemoryReadModel({
    chapters: repositories.chapters,
    chapterVersions: repositories.chapterVersions,
    facts: new SqliteStoryFactStore(executor),
    memoryRecords: new SqliteMemoryRecordRepository(executor),
    projectSeeds: new ProjectSeedSqliteStore(executor),
    candidates: repositories.aiCandidates,
    hasher,
  });
}

function createAgentService(
  executor: NodeSqliteExecutor,
  hasher: ContentHasher,
  clock: Clock,
  fakeGateway: CountingFakeGateway,
): Readonly<{
  readonly service: ConsistencyInvestigationService;
  readonly tools: ConsistencyInvestigationToolRegistry;
  readonly taskCenter: TauriTaskCenterStore;
}> {
  const repositories = createSqliteRepositories(executor);
  const memory = new CompositeStoryMemoryReadModel({
    chapters: repositories.chapters,
    chapterVersions: repositories.chapterVersions,
    facts: new SqliteStoryFactStore(executor),
    memoryRecords: new SqliteMemoryRecordRepository(executor),
    projectSeeds: new ProjectSeedSqliteStore(executor),
    candidates: repositories.aiCandidates,
    hasher,
  });
  const search = createSearchRuntime(executor);
  const tools = new ConsistencyInvestigationToolRegistry({
    memory,
    search,
    hasher,
    causalGraph: {
      loadProjectBranch: () =>
        Promise.resolve(CausalEventGraph.create({ events: [], relations: [] })),
    },
    chapters: repositories.chapters,
    validator: {
      checkChapter: async ({ projectId, chapterId }) => {
        const chapter = unwrap(await repositories.chapters.findById(chapterId));
        if (chapter === null) throw new Error("Agent benchmark chapter disappeared.");
        return deterministicValidation(projectId, chapterId, chapter.currentVersionId);
      },
    },
  });
  const taskCenter = new TauriTaskCenterStore(executor, clock);
  const modelHub = new TauriModelHubStore(executor, clock);
  const service = new ConsistencyInvestigationService({
    store: new ConsistencyInvestigationSqliteStore(executor),
    tools,
    taskCenter,
    chapters: repositories.chapters,
    contextTraces: new SqliteContextCompilationTraceStore(executor),
    modelHub,
    modelGateway: fakeGateway,
    credentials: { getSummary: () => Promise.resolve({ configured: true }) },
    projectContextPrivacy: new ProjectContextPrivacyAuthority(repositories.chapters, hasher),
    ids: new SequentialIds(50_000),
    clock,
    hasher,
  });
  return Object.freeze({ service, tools, taskCenter });
}

async function seedFakeAgentTarget(modelHub: TauriModelHubStore): Promise<ModelCatalogEntry> {
  const connection = await modelHub.saveConnection({
    id: "benchmark-fake-remote",
    providerKind: "custom_openai_compatible",
    displayName: "Benchmark fake gateway",
    baseUrlOverride: "https://benchmark.invalid/v1",
    credentialRef: "keyring:model-hub:benchmark-fake-remote",
    credentialState: "present",
    retryLimit: 3,
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  const entries = await modelHub.syncCatalog({
    syncId: "benchmark-fake-sync",
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: "benchmark-fake-catalog",
        providerModelId: "benchmark-fake-model",
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter: "2026-08-21T00:00:00.000Z",
      },
    ],
  });
  const entry = entries[0];
  if (entry === undefined) throw new Error("Benchmark fake catalog entry is missing.");
  await modelHub.recordCapabilityScan({
    scanId: "benchmark-fake-capability",
    catalogEntryId: entry.id,
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "commit-bound-fake-v1",
    evidence: [
      {
        id: "benchmark-fake-text-evidence",
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: entry.id,
    currency: "USD",
    inputMicrosPerMillionTokens: "1000",
    outputMicrosPerMillionTokens: "2000",
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "commit-bound-fake-v1",
    priceUpdatedAt: NOW,
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "commit-bound-fake-v1",
    expectedRevision: null,
  });
  return entry;
}

class CountingFakeGateway implements Pick<
  NativeModelGatewayClient,
  "available" | "generate" | "cancelGeneration"
> {
  public readonly available = true;
  public readonly requests: Parameters<NativeModelGatewayClient["generate"]>[0][] = [];
  private readonly responses: Awaited<ReturnType<NativeModelGatewayClient["generate"]>>[] = [];

  public get callCount(): number {
    return this.requests.length;
  }

  public get totalInputTokens(): number {
    return this.responsesUsed.reduce(
      (total, response) => total + (response.usage?.inputTokens ?? 0),
      0,
    );
  }

  public get totalOutputTokens(): number {
    return this.responsesUsed.reduce(
      (total, response) => total + (response.usage?.outputTokens ?? 0),
      0,
    );
  }

  private readonly responsesUsed: Awaited<ReturnType<NativeModelGatewayClient["generate"]>>[] = [];

  public enqueue(response: Awaited<ReturnType<NativeModelGatewayClient["generate"]>>): void {
    this.responses.push(response);
  }

  public generate(
    request: Parameters<NativeModelGatewayClient["generate"]>[0],
  ): Promise<Awaited<ReturnType<NativeModelGatewayClient["generate"]>>> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("The counted fake gateway has no queued response.");
    this.responsesUsed.push(response);
    return Promise.resolve(response);
  }

  public cancelGeneration(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function validAgentResponse(): Awaited<ReturnType<NativeModelGatewayClient["generate"]>> {
  return Object.freeze({
    text: JSON.stringify({
      schemaVersion: "inkshadow.consistency-investigation.v1",
      summary: "发现一项需要作者复核的时间冲突。",
      findings: [
        {
          severity: "error",
          category: "timeline",
          title: "抵达与典礼顺序冲突",
          explanation: "两项已接受来源对事件先后给出了不相容的约束。",
          evidenceIds: ["evidence-1"],
        },
      ],
    }),
    usage: { inputTokens: 120, outputTokens: 60, cachedInputTokens: null },
    streamed: false,
  });
}

function hallucinatedEvidenceResponse(): Awaited<ReturnType<NativeModelGatewayClient["generate"]>> {
  return Object.freeze({
    text: JSON.stringify({
      schemaVersion: "inkshadow.consistency-investigation.v1",
      summary: "提交一项没有来源的结论。",
      findings: [
        {
          severity: "warning",
          category: "world",
          title: "无来源结论",
          explanation: "这项说明没有绑定任何已发送的精确证据。",
          evidenceIds: ["evidence-does-not-exist"],
        },
      ],
    }),
    usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: null },
    streamed: false,
  });
}

function deterministicValidation(
  projectId: UuidV7,
  chapterId: UuidV7,
  chapterVersionId: UuidV7,
): ChapterNovelValidationResult {
  return Object.freeze({
    status: "checked",
    projectId,
    chapterId,
    chapterVersionId,
    chapterRevision: 1,
    issues: Object.freeze([]),
    resolutions: Object.freeze([]),
    skippedFacts: Object.freeze([]),
    missingRequirements: Object.freeze([]),
    explanation: "本地确定性校验完成。",
    checked: { currentClaims: 1, referenceFacts: 1, hardRules: 0 },
    coverage: Object.freeze([]),
    capabilities: {
      deterministicValidation: "ready" as const,
      naturalLanguageInference: "disabled" as const,
      ambiguousModelReview: "separate_read_only_service" as const,
      mutatesChapter: false as const,
    },
  });
}

async function createProject(
  repositories: ReturnType<typeof createSqliteRepositories>,
  projectId: UuidV7,
  name: string,
): Promise<void> {
  const project = unwrap(Project.create({ id: projectId, name, now: NOW as never }));
  unwrap(await repositories.projects.create(project));
}

async function createChapter(
  repositories: ReturnType<typeof createSqliteRepositories>,
  hasher: ContentHasher,
  projectId: UuidV7,
  chapterId: UuidV7,
  versionId: UuidV7,
  title: string,
  content: string,
  privacyMode: "standard" | "local_only",
): Promise<Readonly<{ chapter: Chapter; version: ChapterVersion }>> {
  const contentChecksum = unwrap(await hasher.sha256(content));
  const chapter = unwrap(
    Chapter.create({
      id: chapterId,
      projectId,
      title,
      content,
      privacyMode,
      initialVersionId: versionId,
      now: NOW as never,
    }),
  );
  const version = unwrap(
    ChapterVersion.create({
      id: versionId,
      projectId,
      chapterId,
      parentVersionId: null,
      sequence: 1,
      content,
      contentChecksum,
      reason: "created",
      sourceCandidateId: null,
      createdAt: NOW as never,
    }),
  );
  unwrap(await repositories.contentCommits.createChapter({ chapter, initialVersion: version }));
  return Object.freeze({ chapter, version });
}

function createConfirmedFact(
  input: Readonly<{
    id: UuidV7;
    projectId: UuidV7;
    chapterId: UuidV7;
    versionId: UuidV7;
    chapterText: string;
    contentText: string;
  }>,
): StoryFact {
  return unwrap(
    StoryFact.create({
      id: input.id,
      projectId: input.projectId,
      factType: "world_rule",
      contentText: input.contentText,
      source: chapterSpan(input.chapterId, input.versionId, input.chapterText),
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: parseId(uuid(999)),
      now: NOW,
    }),
  );
}

function chapterSpan(chapterId: UuidV7, versionId: UuidV7, content: string) {
  const endOffset = Math.min(content.length, 12);
  return Object.freeze({
    kind: "chapter_span" as const,
    reference: `chapter:${chapterId}:version:${versionId}:utf16:0-${String(endOffset)}`,
    chapterId,
    versionId,
    startOffset: 0,
    endOffset,
    sourceLength: content.length,
    excerpt: content.slice(0, endOffset),
  });
}

async function toSearchDocument(
  projectId: UuidV7,
  document: LongFormBenchmarkDocument,
  index: number,
  hasher: ContentHasher,
): Promise<SearchDocument> {
  const contentHash = unwrap(await hasher.sha256(document.text));
  const chunkKind = fixtureChunkKind(document, index);
  return Object.freeze({
    id: document.id,
    projectId,
    sourceType: document.authority === "accepted_story_fact" ? "memory" : "chapter",
    sourceId: document.chapterId,
    sourceVersionId: document.sourceVersionId,
    title: `${document.chapterId} · ${chunkKind}`,
    text: document.text,
    contentHash,
    updatedAt: NOW,
    chunkKind,
    parentDocumentId: null,
    utf16Start: 0,
    utf16End: document.text.length,
    sourceLength: document.text.length,
    sceneId: chunkKind === "scene" ? `scene:${document.id}` : null,
    eventId: chunkKind === "event" ? `event:${document.id}` : null,
    characterIds:
      document.povCharacterId === "omniscient"
        ? Object.freeze([])
        : Object.freeze([document.povCharacterId]),
    locationIds: Object.freeze([]),
    storyTime: `timeline-order:${String(document.timelineOrder)}`,
    branchId: document.branchId === "alternate" ? "alternate" : null,
    povCharacterId: document.povCharacterId === "omniscient" ? null : document.povCharacterId,
    storyOrder: document.storyOrder,
    authority:
      document.canon !== "canonical" || document.evidenceLocator === null
        ? "rebuildable"
        : document.authority === "accepted_body"
          ? "accepted_text"
          : document.authority === "accepted_story_fact"
            ? "confirmed_fact"
            : "rebuildable",
    privacy: document.privacy === "private" ? "local_only" : "standard",
    currentness: document.currentness,
    omittedScopeFields: Object.freeze(["locations"]),
  });
}

function fixtureChunkKind(document: LongFormBenchmarkDocument, index: number): SearchChunkKind {
  if (document.authority === "accepted_story_fact") return "story_fact_evidence";
  const kinds = ["chapter", "scene", "paragraph", "event", "dialogue"] as const;
  return kinds[index % kinds.length] ?? "chapter";
}

function toProductionEvidenceRef(document: SearchDocument): ProductionSearchEvidenceRef {
  return Object.freeze({
    sourceType: document.sourceType,
    sourceId: document.sourceId,
    sourceVersionId: document.sourceVersionId,
    locator: Object.freeze({
      startUtf16: document.utf16Start ?? 0,
      endUtf16: document.utf16End ?? document.text.length,
      sourceLength: document.sourceLength ?? document.text.length,
    }),
    contentHash: document.contentHash,
  });
}

function selectedEvidenceIsComplete(
  document: SearchDocument,
  sourceVersionId: string,
  contentHash: string,
): boolean {
  const evidence = toProductionEvidenceRef(document);
  return (
    evidence.sourceVersionId === sourceVersionId &&
    evidence.contentHash === contentHash &&
    evidenceRefIsComplete(evidence)
  );
}

function evidenceRefIsComplete(evidence: ProductionSearchEvidenceRef): boolean {
  return (
    /^[0-9a-f]{64}$/u.test(evidence.contentHash) &&
    evidence.sourceId.length > 0 &&
    evidence.sourceVersionId.length > 0 &&
    evidence.locator.startUtf16 >= 0 &&
    evidence.locator.endUtf16 > evidence.locator.startUtf16 &&
    evidence.locator.sourceLength >= evidence.locator.endUtf16
  );
}

function evaluationOmissionReasons(
  document: LongFormBenchmarkDocument,
  sample: LongFormBenchmarkSample,
): readonly string[] {
  const reasons: string[] = [];
  if (document.currentness !== "current") reasons.push("stale_version");
  if (document.authority === "rejected_candidate") reasons.push("rejected_candidate");
  if (document.authority === "what_if_projection") reasons.push("what_if_projection");
  if (document.authority === "unverified_conflict") reasons.push("canon_not_authoritative");
  if (document.branchId === "alternate") reasons.push("branch_mismatch");
  if (
    document.povCharacterId !== "omniscient" &&
    document.povCharacterId !== sample.scope.povCharacterId
  )
    reasons.push("pov_mismatch");
  if (document.storyOrder > sample.scope.maximumStoryOrder) reasons.push("future_knowledge");
  if (document.privacy === "private" && !sample.scope.allowPrivate) reasons.push("private_scope");
  if (document.evidenceLocator === null) reasons.push("evidence_incomplete");
  if (reasons.length === 0) reasons.push("no_match_or_rank_limit");
  return Object.freeze(reasons.sort());
}

function isAuthoritativeFixtureDocument(document: LongFormBenchmarkDocument): boolean {
  return (
    document.canon === "canonical" &&
    document.evidenceLocator !== null &&
    document.currentness === "current" &&
    document.privacy === "ordinary" &&
    (document.authority === "accepted_body" || document.authority === "accepted_story_fact")
  );
}

function evaluateStoryMemory(
  state: StoryMemoryBenchmarkState,
): ProductionLongFormBenchmarkReport["storyMemory"] {
  const evidenceRefs = [...state.local.evidenceRefs, ...state.remote.evidenceRefs];
  const completeEvidence = evidenceRefs.filter(
    ({ excerptDigest, locator }) =>
      /^[0-9a-f]{64}$/u.test(excerptDigest) &&
      (locator.kind === "stable" ||
        (locator.startOffset >= 0 &&
          locator.endOffset > locator.startOffset &&
          locator.sourceLength >= locator.endOffset)),
  ).length;
  const expectedTraceSourceIds = new Set([
    ...state.remote.retrievalCandidates.map(({ id }) => id),
    ...state.remote.exclusions.map(({ sourceId }) => sourceId),
  ]);
  const recordedTraceSourceIds = new Set(
    state.remote.contextDecisionTrace.map(({ sourceId }) => sourceId),
  );
  const serializedRemote = JSON.stringify(state.remote);
  return Object.freeze({
    localAcceptedChapterCount: state.local.layers.L0.length,
    remoteAcceptedChapterCount: state.remote.layers.L0.length,
    confirmedCanonCount: state.remote.layers.L1.length,
    evidenceRefCompleteness: ratio(completeEvidence, evidenceRefs.length),
    traceCompleteness: ratio(
      [...expectedTraceSourceIds].filter((sourceId) => recordedTraceSourceIds.has(sourceId)).length,
      expectedTraceSourceIds.size,
    ),
    privateExclusionCount: state.remote.exclusions.filter(
      ({ reason }) => reason === "private_remote_denied",
    ).length,
    rejectedCandidateExclusionCount: state.remote.exclusions.filter(
      ({ reason }) => reason === "rejected_candidate",
    ).length,
    branchExclusionCount: state.remote.exclusions.filter(({ reason }) => reason === "other_branch")
      .length,
    privateLeakageCount: serializedRemote.includes(state.privateText) ? 1 : 0,
    rejectedCandidateLeakageCount: serializedRemote.includes(state.rejectedText) ? 1 : 0,
    branchLeakageCount: serializedRemote.includes(state.branchText) ? 1 : 0,
  });
}

function aggregateSearch(results: readonly ProductionSearchRawResult[]): SearchAggregate {
  return Object.freeze({
    sampleCount: results.length,
    recallAtK: average(results.map(({ ranking }) => ranking.recallAtK)),
    precisionAtK: average(results.map(({ ranking }) => ranking.precisionAtK)),
    meanReciprocalRank: average(results.map(({ ranking }) => ranking.meanReciprocalRank)),
    normalizedDiscountedCumulativeGain: average(
      results.map(({ ranking }) => ranking.normalizedDiscountedCumulativeGain),
    ),
    hitRate: average(results.map(({ ranking }) => ranking.hitRate)),
    falseInclusionRate: average(results.map(({ falseInclusionRate }) => falseInclusionRate)),
    authorityPrecision: average(results.map(({ ranking }) => ranking.authorityPrecision)),
    canonViolationRate: average(results.map(({ canonViolationRate }) => canonViolationRate)),
    staleVersionLeakageRate: average(
      results.map(({ staleVersionLeakageRate }) => staleVersionLeakageRate),
    ),
    rejectedCandidateContaminationRate: average(
      results.map(({ ranking }) => ranking.rejectedCandidateContaminationRate),
    ),
    branchLeakageRate: average(results.map(({ branchLeakageRate }) => branchLeakageRate)),
    povLeakageRate: average(results.map(({ povLeakageRate }) => povLeakageRate)),
    futureKnowledgeLeakageRate: average(
      results.map(({ futureKnowledgeLeakageRate }) => futureKnowledgeLeakageRate),
    ),
    privateLeakageCount: results.reduce(
      (total, { ranking }) => total + ranking.privateLeakageCount,
      0,
    ),
    evidenceRefCompleteness: average(
      results.map(({ evidenceRefCompleteness }) => evidenceRefCompleteness),
    ),
    traceCompleteness: average(results.map(({ traceCompleteness }) => traceCompleteness)),
    emptyResultCorrectness: average(
      results.map(({ emptyResultCorrectness }) => emptyResultCorrectness),
    ),
    ftsFallbackRate: average(
      results.map(({ ftsFallbackOccurred }) => (ftsFallbackOccurred ? 1 : 0)),
    ),
    averageEstimatedContextTokens: average(
      results.map(({ estimatedContextTokens }) => estimatedContextTokens),
    ),
    averageWallClockMilliseconds: average(
      results.map(({ latency }) => latency.wallClockMilliseconds),
    ),
    averageRerankLatencyMilliseconds: 0,
  });
}

function sameRankings(
  left: readonly ProductionSearchRawResult[],
  right: readonly ProductionSearchRawResult[],
): boolean {
  const leftBySample = new Map(
    left.map((result) => [
      `${String(result.corpusCharacterTarget)}:${result.sampleId}`,
      result.rankedDocumentIds,
    ]),
  );
  return (
    left.length === right.length &&
    right.every(
      (result) =>
        stableJson(
          leftBySample.get(`${String(result.corpusCharacterTarget)}:${result.sampleId}`) ?? [],
        ) === stableJson(result.rankedDocumentIds),
    )
  );
}

function requireBoundSourceRevision(value: string | undefined): string {
  if (value === undefined || value === "WORKTREE_UNBOUND" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(
      "INKSHADOW_SOURCE_REVISION must be the lowercase 40-hex SHA of the frozen source commit; WORKTREE_UNBOUND is forbidden.",
    );
  }
  return value;
}

function writeRawBenchmarkReport(report: ProductionLongFormBenchmarkReport): string {
  const workspaceRoot = findWorkspaceRoot();
  const outputDirectory = path.join(
    workspaceRoot,
    "test-results",
    "production-long-form-benchmark",
  );
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${report.sourceRevision}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outputPath;
}

function readCurrentLocalSchema(workspaceRoot: string): string {
  const dataDirectory = path.join(workspaceRoot, "packages", "data", "migrations");
  const dataMigrations = readdirSync(dataDirectory)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort();
  if (
    dataMigrations.length !== 80 ||
    dataMigrations[0] !== "0001_core.sql" ||
    dataMigrations.at(-7) !== "0074_chapter_version_story_fact_responsibility.sql" ||
    dataMigrations.at(-6) !== "0075_generation_attempt_privacy_snapshot.sql" ||
    dataMigrations.at(-5) !== "0076_direct_local_story_fact_author_revision.sql" ||
    dataMigrations.at(-4) !== "0077_project_display_identities.sql" ||
    dataMigrations.at(-3) !== "0078_generation_attempt_prose_invocation.sql" ||
    dataMigrations.at(-2) !== "0079_story_fact_evidence.sql" ||
    dataMigrations.at(-1) !== "0080_candidate_selection_action.sql"
  ) {
    throw new Error("The production benchmark expected the exact Data 0001-0080 migration chain.");
  }
  const sql: string[] = [];
  for (const fileName of dataMigrations) {
    sql.push(readFileSync(path.join(dataDirectory, fileName), "utf8"));
    if (fileName === "0002_tasks_notifications.sql") {
      sql.push(
        readFileSync(
          path.join(workspaceRoot, "packages", "story-core", "migrations", "0001_story_core.sql"),
          "utf8",
        ),
      );
    }
    if (fileName === "0004_model_profiles.sql") {
      sql.push(
        readFileSync(
          path.join(workspaceRoot, "packages", "story-core", "migrations", "0002_materials.sql"),
          "utf8",
        ),
      );
    }
    if (fileName === "0020_graph_rag_projection.sql") {
      sql.push(
        readFileSync(
          path.join(workspaceRoot, "packages", "story-core", "migrations", "0003_ideation.sql"),
          "utf8",
        ),
      );
    }
  }
  return sql.join("\n");
}

function findWorkspaceRoot(): string {
  let current = path.resolve(process.cwd());
  while (!existsSync(path.join(current, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("InkShadow workspace root could not be located.");
    current = parent;
  }
  return current;
}

function fixedClock(): Clock {
  return Object.freeze({ now: () => NOW as ReturnType<Clock["now"]> });
}

class SequentialIds implements UuidV7Generator {
  public constructor(private sequence: number) {}

  public next(): UuidV7 {
    const id = parseId(uuid(this.sequence));
    this.sequence += 1;
    return id;
  }
}

function unwrap<Value>(
  result:
    | Readonly<{ readonly ok: true; readonly value: Value }>
    | Readonly<{ readonly ok: false; readonly error: unknown }>,
): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}

function parseId(value: string): UuidV7 {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

function safeErrorCode(cause: unknown): string | null {
  if (cause === null || typeof cause !== "object" || !("code" in cause)) return null;
  const code = cause.code;
  return typeof code === "string" ? code : null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function roundedMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : roundMetric(numerator / denominator);
}

function zeroSafeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : roundMetric(numerator / denominator);
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : roundMetric(values.reduce((total, value) => total + value, 0) / values.length);
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
