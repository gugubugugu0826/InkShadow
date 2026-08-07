import type { ChapterVersionRepository, ContentHasher } from "@inkshadow/application";
import { parseUuidV7 as parseDomainUuid, type UuidV7 } from "@inkshadow/domain";
import {
  NARRATIVE_ANALYSIS_COVERAGE_AREAS,
  NarrativeAnalysisInputError,
  analyzeNovelNarrative,
  type CausalEventGraph,
  type CausalEventNode,
  type CausalTextEvidence,
  type NarrativeAnalysisCoverage,
  type NarrativeAnalysisCoverageArea,
  type NarrativeAnalysisInput,
  type NarrativeAnalysisPolicy,
  type NarrativeAnalysisResult,
  type NarrativeCharacterPresence,
  type NarrativeConvergencePlan,
  type NarrativeEvidenceReference,
  type NarrativeForeshadow,
  type NarrativeForeshadowProgress,
  type NarrativePlotline,
  type NarrativePlotlineCharacter,
  type NarrativePlotlineDependency,
  type NarrativePlotlineProgress,
  type NarrativeSceneMetrics,
  type NarrativeSupportedValue,
  type StoryFactSnapshot,
  type StoryFactStore,
} from "@inkshadow/story-core";

import type { CausalEventGraphStore } from "./causal-event-graph-store";
import type {
  ContinuousProjectionDiagnostic,
  ContinuousStoryStateProjectionAdapter,
} from "./continuous-story-state-projection-adapter";

export const NARRATIVE_ANALYSIS_FACT_SCHEMA = "inkshadow.narrative-analysis-fact.v1" as const;

export const NARRATIVE_ANALYSIS_FACT_KINDS = [
  "chapter",
  "coverage",
  "plotline",
  "plotline_character",
  "plotline_dependency",
  "plotline_progress",
  "convergence_plan",
  "scene_metric",
] as const;

export type NarrativeAnalysisFactKind = (typeof NARRATIVE_ANALYSIS_FACT_KINDS)[number];

export const DEFAULT_NARRATIVE_ANALYSIS_POLICY: NarrativeAnalysisPolicy = Object.freeze({
  plotlineStaleAfterChapters: 3,
  foreshadowStaleAfterChapters: 5,
  upcomingConvergenceWithinChapters: 3,
  repeatedFunctionLookbackChapters: 4,
  minimumRepeatedFunctionOccurrences: 3,
  buildupLookbackChapters: 3,
  pacingSimilarityTolerance: 0.08,
  minimumSimilarPacingChapters: 3,
  tensionFlatTolerance: 0.05,
});

export type NarrativeAnalysisAdapterSkipReason =
  | "not_confirmed"
  | "branch_mismatch"
  | "exact_evidence_missing"
  | "evidence_version_unavailable"
  | "evidence_mismatch"
  | "structured_value_invalid"
  | "duplicate_record"
  | "reference_missing"
  | "causal_event_missing"
  | "after_analysis_chapter"
  | "causal_order_ambiguous";

export interface NarrativeAnalysisAdapterSkip {
  readonly sourceId: string;
  readonly kind: NarrativeAnalysisFactKind | "causal_foreshadow" | "causal_presence" | null;
  readonly reason: NarrativeAnalysisAdapterSkipReason;
  readonly explanation: string;
}

export interface ChapterNarrativeAnalysisRequest {
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly branchId?: string | null;
}

export interface ChapterNarrativeAnalysisResult {
  readonly status: "analyzed" | "skipped";
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly branchId: string;
  readonly analysis: NarrativeAnalysisResult | null;
  readonly skippedSources: readonly NarrativeAnalysisAdapterSkip[];
  readonly missingRequirements: readonly string[];
  readonly explanation: string;
  readonly sourceSummary: Readonly<{
    readonly confirmedFacts: number;
    readonly causalEvents: number;
    readonly causalRelations: number;
  }>;
  readonly capabilities: Readonly<{
    readonly confirmedFactsOnly: true;
    readonly rebuildableSystemMetrics: "verified_current_version_only";
    readonly verifiedCausalGraphOnly: true;
    readonly naturalLanguageInference: "disabled";
    readonly mutatesStory: false;
  }>;
}

export interface ConfirmedNarrativeAnalysisAdapterDependencies {
  readonly storyFacts: Pick<StoryFactStore, "listByProjectId">;
  readonly chapterVersions: Pick<ChapterVersionRepository, "findVersionById">;
  readonly causalGraph: Pick<CausalEventGraphStore, "loadProjectBranch">;
  readonly hasher: ContentHasher;
  readonly policy?: NarrativeAnalysisPolicy;
  readonly continuousProjection?: Pick<
    ContinuousStoryStateProjectionAdapter,
    "projectNarrativeFacts"
  >;
}

interface AdaptedNarrativeInput {
  readonly input: NarrativeAnalysisInput | null;
  readonly skippedSources: readonly NarrativeAnalysisAdapterSkip[];
  readonly missingRequirements: readonly string[];
  readonly sourceSummary: ChapterNarrativeAnalysisResult["sourceSummary"];
}

interface VerifiedFact {
  readonly snapshot: StoryFactSnapshot;
  readonly evidence: NarrativeEvidenceReference;
}

interface ParsedChapter {
  readonly kind: "chapter";
  readonly factId: string;
  readonly chapterId: string;
  readonly order: number;
  readonly evidence: NarrativeEvidenceReference;
}

interface ParsedCoverage {
  readonly kind: "coverage";
  readonly factId: string;
  readonly area: NarrativeAnalysisCoverageArea;
  readonly complete: boolean;
  readonly evidence: NarrativeEvidenceReference;
}

interface ParsedPlotline {
  readonly kind: "plotline";
  readonly factId: string;
  readonly plotlineId: string;
  readonly goal: string | null;
  readonly evidence: NarrativeEvidenceReference;
}

interface ParsedPlotlineCharacter {
  readonly kind: "plotline_character";
  readonly factId: string;
  readonly plotlineId: string;
  readonly characterId: string;
  readonly evidence: NarrativeEvidenceReference;
}

interface ParsedPlotlineDependency {
  readonly kind: "plotline_dependency";
  readonly factId: string;
  readonly fromPlotlineId: string;
  readonly toPlotlineId: string;
  readonly status: NarrativePlotlineDependency["status"];
  readonly evidence: NarrativeEvidenceReference;
}

interface ParsedPlotlineProgress {
  readonly kind: "plotline_progress";
  readonly factId: string;
  readonly plotlineId: string;
  readonly chapterId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly summary: string;
  readonly evidence: NarrativeEvidenceReference;
}

interface ParsedConvergencePlan {
  readonly kind: "convergence_plan";
  readonly factId: string;
  readonly plotlineIds: readonly string[];
  readonly targetChapterOrder: number;
  readonly status: NarrativeConvergencePlan["status"];
  readonly evidence: NarrativeEvidenceReference;
}

interface ParsedSceneMetric {
  readonly kind: "scene_metric";
  readonly factId: string;
  readonly scene: NarrativeSceneMetrics;
}

type ParsedNarrativeFact =
  | ParsedChapter
  | ParsedCoverage
  | ParsedPlotline
  | ParsedPlotlineCharacter
  | ParsedPlotlineDependency
  | ParsedPlotlineProgress
  | ParsedConvergencePlan
  | ParsedSceneMetric;

interface ParseFailure {
  readonly kind: NarrativeAnalysisFactKind | null;
  readonly explanation: string;
}

type ParseResult =
  | Readonly<{ readonly ok: true; readonly value: ParsedNarrativeFact }>
  | Readonly<{ readonly ok: false; readonly failure: ParseFailure }>;

interface GraphForeshadowCandidate {
  readonly eventId: string;
  readonly eventOrder: number;
  readonly indexInEvent: number;
  readonly chapterId: string;
  readonly progressId: string;
  readonly foreshadowId: string;
  readonly kind: NarrativeForeshadowProgress["kind"];
  readonly description: string;
  readonly evidence: NarrativeEvidenceReference;
}

const MAXIMUM_RECORDS = 16_384;
const MAXIMUM_TEXT = 200_000;
const MAXIMUM_REFERENCE = 2_000;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Converts only human-confirmed StoryFact records and the already verified
 * causal graph into the strict domain input. Missing or ambiguous structure is
 * skipped; this adapter never derives narrative meaning from prose.
 */
export class ConfirmedNarrativeAnalysisAdapter {
  public constructor(
    private readonly dependencies: ConfirmedNarrativeAnalysisAdapterDependencies,
  ) {}

  public async adapt(request: ChapterNarrativeAnalysisRequest): Promise<AdaptedNarrativeInput> {
    const branchId = normalizeBranch(request.branchId);
    const loadedFacts = await this.dependencies.storyFacts.listByProjectId(
      request.projectId as unknown as Parameters<StoryFactStore["listByProjectId"]>[0],
    );
    if (!loadedFacts.ok) {
      throw new NarrativeAnalysisRuntimeError(
        "NARRATIVE_ANALYSIS_FACTS_UNAVAILABLE",
        "无法读取已确认的故事资料，叙事分析没有运行。",
        loadedFacts.error.retryable,
      );
    }

    const skipped: NarrativeAnalysisAdapterSkip[] = [];
    const verified: VerifiedFact[] = [];
    const versionCache = new Map<string, Promise<NarrativeEvidenceReference | null>>();
    let matchingConfirmedFacts = 0;
    for (const fact of loadedFacts.value) {
      const snapshot = fact.toSnapshot();
      const structured = asRecord(snapshot.structuredValue);
      if (structured?.schemaVersion !== NARRATIVE_ANALYSIS_FACT_SCHEMA) {
        continue;
      }
      const kind = narrativeKind(structured.kind);
      if (
        snapshot.status !== "formal" ||
        !snapshot.userConfirmed ||
        snapshot.deprecated ||
        snapshot.needsReview
      ) {
        skipped.push(
          skipSource(
            snapshot.id,
            kind,
            "not_confirmed",
            "只有用户确认的正式事实可以参与叙事分析。",
          ),
        );
        continue;
      }
      if (branchId !== "main" || snapshot.branchId !== null) {
        skipped.push(
          skipSource(snapshot.id, kind, "branch_mismatch", "该事实不属于当前主剧情分支。"),
        );
        continue;
      }
      matchingConfirmedFacts += 1;
      const evidence = await this.resolveFactEvidence(snapshot, versionCache);
      if (evidence === null) {
        skipped.push(
          skipSource(
            snapshot.id,
            kind,
            evidenceSkipReason(snapshot),
            "事实没有通过不可变章节版本、原文位置与内容哈希核验。",
          ),
        );
        continue;
      }
      verified.push({ snapshot, evidence });
    }

    if (this.dependencies.continuousProjection !== undefined) {
      try {
        const projected = await this.dependencies.continuousProjection.projectNarrativeFacts({
          projectId: request.projectId,
          chapterId: request.chapterId,
          currentVersionId: null,
          ...(request.branchId === undefined ? {} : { branchId: request.branchId }),
        });
        skipped.push(...projected.diagnostics.map(narrativeProjectionSkip));
        for (const fact of projected.facts) {
          const snapshot = fact.toSnapshot();
          const structured = asRecord(snapshot.structuredValue);
          const kind = narrativeKind(structured?.kind);
          const evidence = await this.resolveFactEvidence(snapshot, versionCache);
          if (evidence === null) {
            skipped.push(
              skipSource(
                snapshot.id,
                kind,
                evidenceSkipReason(snapshot),
                "Continuous narrative projection did not pass immutable evidence verification.",
              ),
            );
            continue;
          }
          verified.push({ snapshot, evidence });
        }
      } catch {
        skipped.push(
          skipSource(
            "continuous-story-state-projection",
            null,
            "structured_value_invalid",
            "Continuous narrative projection was unavailable; no narrative meaning was inferred.",
          ),
        );
      }
    }

    let graph: CausalEventGraph | null = null;
    try {
      graph = await this.dependencies.causalGraph.loadProjectBranch(request.projectId, branchId);
    } catch {
      // The remaining confirmed facts can still produce partial, explicitly
      // skipped output. A missing graph never becomes an inferred empty graph.
      graph = null;
    }

    const parsed: ParsedNarrativeFact[] = [];
    for (const fact of verified) {
      const result = parseNarrativeFact(fact);
      if (result.ok) {
        parsed.push(result.value);
      } else {
        skipped.push(
          skipSource(
            fact.snapshot.id,
            result.failure.kind,
            "structured_value_invalid",
            result.failure.explanation,
          ),
        );
      }
    }

    const chapters = uniqueRecords(
      parsed.filter((record): record is ParsedChapter => record.kind === "chapter"),
      (record) => record.chapterId,
      skipped,
    );
    const uniqueChapterOrders = keepUniqueChapterOrders(chapters, skipped);
    const analysisChapter = uniqueChapterOrders.find(
      ({ chapterId }) => chapterId === request.chapterId,
    );
    const sourceSummary = Object.freeze({
      confirmedFacts: matchingConfirmedFacts,
      causalEvents: graph?.events.length ?? 0,
      causalRelations: graph?.relations.length ?? 0,
    });
    if (analysisChapter === undefined) {
      return Object.freeze({
        input: null,
        skippedSources: Object.freeze(sortSkips(skipped)),
        missingRequirements: Object.freeze(["confirmed_chapter_order_with_exact_evidence"]),
        sourceSummary,
      });
    }

    const includedChapters = uniqueChapterOrders
      .filter(({ order }) => order <= analysisChapter.order)
      .sort(
        (left, right) => left.order - right.order || left.chapterId.localeCompare(right.chapterId),
      );
    const chapterById = new Map(includedChapters.map((chapter) => [chapter.chapterId, chapter]));
    const plotlineRecords = uniqueRecords(
      parsed.filter((record): record is ParsedPlotline => record.kind === "plotline"),
      (record) => record.plotlineId,
      skipped,
    );
    const plotlineIds = new Set(plotlineRecords.map(({ plotlineId }) => plotlineId));
    const graphEvents = new Map((graph?.events ?? []).map((event) => [event.id, event]));

    const plotlines: NarrativePlotline[] = plotlineRecords.map((record) =>
      Object.freeze({
        id: record.plotlineId,
        goal:
          record.goal === null ? null : supported(record.goal, Object.freeze([record.evidence])),
      }),
    );
    const plotlineCharacters = adaptPlotlineCharacters(parsed, plotlineIds, skipped);
    const plotlineDependencies = adaptPlotlineDependencies(parsed, plotlineIds, skipped);
    const plotlineProgress = adaptPlotlineProgress(
      parsed,
      plotlineIds,
      chapterById,
      graphEvents,
      skipped,
    );
    const convergencePlans = adaptConvergencePlans(
      parsed,
      plotlineIds,
      analysisChapter.order,
      skipped,
    );
    const characterPresences = deriveCharacterPresences(plotlineProgress, graphEvents, skipped);
    const { foreshadows, progress: foreshadowProgress } = deriveForeshadows(
      graph,
      chapterById,
      skipped,
    );
    const scenes = adaptScenes(parsed, chapterById, plotlineIds, skipped);
    const coverage = adaptCoverage(parsed, graph !== null, skipped);
    const missingRequirements = coverageRequirements(coverage, graph !== null);

    return Object.freeze({
      input: Object.freeze({
        projectId: request.projectId,
        branchId,
        analysisChapterId: request.chapterId,
        policy: this.dependencies.policy ?? DEFAULT_NARRATIVE_ANALYSIS_POLICY,
        coverage,
        chapters: Object.freeze(
          includedChapters.map((record) =>
            Object.freeze({
              id: record.chapterId,
              order: record.order,
              evidence: Object.freeze([record.evidence]),
            }),
          ),
        ),
        plotlines: Object.freeze(plotlines),
        plotlineCharacters: Object.freeze(plotlineCharacters),
        plotlineDependencies: Object.freeze(plotlineDependencies),
        plotlineProgress: Object.freeze(plotlineProgress),
        convergencePlans: Object.freeze(convergencePlans),
        characterPresences: Object.freeze(characterPresences),
        foreshadows: Object.freeze(foreshadows),
        foreshadowProgress: Object.freeze(foreshadowProgress),
        scenes: Object.freeze(scenes),
      }),
      skippedSources: Object.freeze(sortSkips(skipped)),
      missingRequirements: Object.freeze(missingRequirements),
      sourceSummary,
    });
  }

  private async resolveFactEvidence(
    snapshot: StoryFactSnapshot,
    cache: Map<string, Promise<NarrativeEvidenceReference | null>>,
  ): Promise<NarrativeEvidenceReference | null> {
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
      return null;
    }
    const existing = cache.get(snapshot.id);
    if (existing !== undefined) {
      return existing;
    }
    const pending = this.loadFactEvidence(snapshot);
    cache.set(snapshot.id, pending);
    return pending;
  }

  private async loadFactEvidence(
    snapshot: StoryFactSnapshot,
  ): Promise<NarrativeEvidenceReference | null> {
    const source = snapshot.source;
    if (source.versionId === null || source.chapterId === null || source.excerpt === null) {
      return null;
    }
    const versionId = parseDomainUuid(source.versionId);
    if (!versionId.ok) {
      return null;
    }
    const loaded = await this.dependencies.chapterVersions.findVersionById(versionId.value);
    if (!loaded.ok || loaded.value === null) {
      return null;
    }
    const version = loaded.value.toSnapshot();
    const hash = await this.dependencies.hasher.sha256(version.content);
    if (!hash.ok) {
      return null;
    }
    if (
      String(version.id) !== String(source.versionId) ||
      String(version.projectId) !== String(snapshot.projectId) ||
      String(version.chapterId) !== String(source.chapterId) ||
      version.content.length !== source.sourceLength ||
      source.startOffset === null ||
      source.endOffset === null ||
      source.startOffset < 0 ||
      source.endOffset <= source.startOffset ||
      source.endOffset > version.content.length ||
      version.content.slice(source.startOffset, source.endOffset) !== source.excerpt ||
      String(hash.value) !== String(version.contentChecksum)
    ) {
      return null;
    }
    return Object.freeze({
      sourceKind: "story_fact",
      sourceId: snapshot.id,
      sourceVersionId: source.versionId,
      contentHash: String(hash.value),
      locator: `${source.reference}#utf16:${String(source.startOffset)}-${String(source.endOffset)}/${String(source.sourceLength)}`,
      excerpt: source.excerpt,
      startOffset: source.startOffset,
      endOffset: source.endOffset,
      sourceLength: source.sourceLength,
    });
  }
}

export class ChapterNarrativeAnalysisRuntime {
  readonly #adapter: ConfirmedNarrativeAnalysisAdapter;

  public constructor(dependencies: ConfirmedNarrativeAnalysisAdapterDependencies) {
    this.#adapter = new ConfirmedNarrativeAnalysisAdapter(dependencies);
  }

  public async analyzeChapter(
    request: ChapterNarrativeAnalysisRequest,
  ): Promise<ChapterNarrativeAnalysisResult> {
    const branchId = normalizeBranch(request.branchId);
    const adapted = await this.#adapter.adapt(request);
    if (adapted.input === null) {
      return freezeRuntimeResult({
        status: "skipped",
        projectId: request.projectId,
        chapterId: request.chapterId,
        branchId,
        analysis: null,
        skippedSources: adapted.skippedSources,
        missingRequirements: adapted.missingRequirements,
        explanation: "尚无足够证据：需要已确认的章节顺序和可核验原文来源。",
        sourceSummary: adapted.sourceSummary,
      });
    }
    try {
      const analysis = analyzeNovelNarrative(adapted.input);
      return freezeRuntimeResult({
        status: "analyzed",
        projectId: request.projectId,
        chapterId: request.chapterId,
        branchId,
        analysis,
        skippedSources: adapted.skippedSources,
        missingRequirements: adapted.missingRequirements,
        explanation:
          adapted.missingRequirements.length === 0
            ? "已根据已确认事实和因果图完成可解释叙事分析。"
            : "已完成有证据支持的部分；其余项目尚无足够证据。",
        sourceSummary: adapted.sourceSummary,
      });
    } catch (cause: unknown) {
      if (cause instanceof NarrativeAnalysisInputError) {
        return freezeRuntimeResult({
          status: "skipped",
          projectId: request.projectId,
          chapterId: request.chapterId,
          branchId,
          analysis: null,
          skippedSources: adapted.skippedSources,
          missingRequirements: Object.freeze(["valid_non_conflicting_narrative_structure"]),
          explanation: "尚无足够证据：已确认资料之间存在重复、缺失引用或结构冲突。",
          sourceSummary: adapted.sourceSummary,
        });
      }
      throw cause;
    }
  }
}

export type NarrativeAnalysisRuntimeErrorCode = "NARRATIVE_ANALYSIS_FACTS_UNAVAILABLE";

export class NarrativeAnalysisRuntimeError extends Error {
  public constructor(
    readonly code: NarrativeAnalysisRuntimeErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NarrativeAnalysisRuntimeError";
  }
}

function parseNarrativeFact(fact: VerifiedFact): ParseResult {
  const value = asRecord(fact.snapshot.structuredValue);
  const kind = narrativeKind(value?.kind);
  if (value?.schemaVersion !== NARRATIVE_ANALYSIS_FACT_SCHEMA || kind === null) {
    return parseFailure(kind, "叙事资料缺少受支持的结构版本或记录类型。");
  }
  switch (kind) {
    case "chapter": {
      const chapterId = safeReference(value.chapterId);
      const order = safeOrder(value.order);
      if (chapterId === null || order === null || fact.snapshot.source.chapterId !== chapterId) {
        return parseFailure(kind, "章节顺序记录必须引用自身章节，并提供明确顺序。");
      }
      return parseSuccess({
        kind,
        factId: fact.snapshot.id,
        chapterId,
        order,
        evidence: fact.evidence,
      });
    }
    case "coverage": {
      const area = coverageArea(value.area);
      if (area === null || typeof value.complete !== "boolean") {
        return parseFailure(kind, "覆盖声明必须指出检查范围和是否完整。");
      }
      return parseSuccess({
        kind,
        factId: fact.snapshot.id,
        area,
        complete: value.complete,
        evidence: fact.evidence,
      });
    }
    case "plotline": {
      const plotlineId = safeReference(value.plotlineId);
      const goal = nullableText(value.goal);
      if (plotlineId === null || !goal.ok) {
        return parseFailure(kind, "剧情线记录必须提供标识和明确目标（目标可以显式为空）。");
      }
      return parseSuccess({
        kind,
        factId: fact.snapshot.id,
        plotlineId,
        goal: goal.value,
        evidence: fact.evidence,
      });
    }
    case "plotline_character": {
      const plotlineId = safeReference(value.plotlineId);
      const characterId = safeReference(value.characterId);
      if (plotlineId === null || characterId === null) {
        return parseFailure(kind, "剧情线人物记录缺少明确的剧情线或人物标识。");
      }
      return parseSuccess({
        kind,
        factId: fact.snapshot.id,
        plotlineId,
        characterId,
        evidence: fact.evidence,
      });
    }
    case "plotline_dependency": {
      const fromPlotlineId = safeReference(value.fromPlotlineId);
      const toPlotlineId = safeReference(value.toPlotlineId);
      const status = dependencyStatus(value.status);
      if (
        fromPlotlineId === null ||
        toPlotlineId === null ||
        fromPlotlineId === toPlotlineId ||
        status === null
      ) {
        return parseFailure(kind, "剧情线依赖缺少有效端点或明确状态。");
      }
      return parseSuccess({
        kind,
        factId: fact.snapshot.id,
        fromPlotlineId,
        toPlotlineId,
        status,
        evidence: fact.evidence,
      });
    }
    case "plotline_progress": {
      const plotlineId = safeReference(value.plotlineId);
      const chapterId = safeReference(value.chapterId);
      const sequence = safeSequence(value.sequence);
      const eventId = safeReference(value.eventId);
      const summary = safeText(value.summary);
      if (
        plotlineId === null ||
        chapterId === null ||
        sequence === null ||
        eventId === null ||
        summary === null ||
        fact.snapshot.source.chapterId !== chapterId
      ) {
        return parseFailure(kind, "剧情线推进必须引用本章、明确的章内顺序和已确认因果事件。");
      }
      return parseSuccess({
        kind,
        factId: fact.snapshot.id,
        plotlineId,
        chapterId,
        sequence,
        eventId,
        summary,
        evidence: fact.evidence,
      });
    }
    case "convergence_plan": {
      const plotlineIds = safeReferenceArray(value.plotlineIds, 2);
      const targetChapterOrder = safeOrder(value.targetChapterOrder);
      const status = convergenceStatus(value.status);
      if (plotlineIds === null || targetChapterOrder === null || status === null) {
        return parseFailure(kind, "剧情线交汇计划缺少至少两条剧情线、目标章节或状态。");
      }
      return parseSuccess({
        kind,
        factId: fact.snapshot.id,
        plotlineIds,
        targetChapterOrder,
        status,
        evidence: fact.evidence,
      });
    }
    case "scene_metric": {
      const scene = parseSceneMetric(value, fact);
      return scene === null
        ? parseFailure(kind, "场景指标必须是显式、完整且范围有效的结构化测量。")
        : parseSuccess({ kind, factId: fact.snapshot.id, scene });
    }
  }
}

function parseSceneMetric(
  value: Readonly<Record<string, unknown>>,
  fact: VerifiedFact,
): NarrativeSceneMetrics | null {
  const sceneId = safeReference(value.sceneId);
  const chapterId = safeReference(value.chapterId);
  const sequence = safeSequence(value.sequence);
  if (
    sceneId === null ||
    chapterId === null ||
    sequence === null ||
    fact.snapshot.source.chapterId !== chapterId
  ) {
    return null;
  }
  const evidence = Object.freeze([fact.evidence]);
  const goal = optionalSupported(value.goal, evidence, safeText);
  const conflictIntensity = optionalSupported(value.conflictIntensity, evidence, unitInterval);
  const tension = optionalSupported(value.tension, evidence, tensionMeasurement);
  const composition = optionalSupported(value.composition, evidence, compositionMeasurement);
  const plotAdvancement = optionalSupported(value.plotAdvancement, evidence, plotAdvancementValue);
  const characterChange = optionalSupported(value.characterChange, evidence, characterChangeValue);
  const functionTags = optionalSupported(value.functionTags, evidence, (candidate) =>
    safeReferenceArray(candidate, 1),
  );
  const setupBeatIds = optionalSupported(value.setupBeatIds, evidence, (candidate) =>
    safeReferenceArray(candidate, 0),
  );
  const climax = optionalSupported(value.climax, evidence, climaxValue);
  if (
    goal === INVALID ||
    conflictIntensity === INVALID ||
    tension === INVALID ||
    composition === INVALID ||
    plotAdvancement === INVALID ||
    characterChange === INVALID ||
    functionTags === INVALID ||
    setupBeatIds === INVALID ||
    climax === INVALID
  ) {
    return null;
  }
  return Object.freeze({
    id: sceneId,
    chapterId,
    sequence,
    evidence,
    goal,
    conflictIntensity,
    tension,
    composition,
    plotAdvancement,
    characterChange,
    functionTags,
    setupBeatIds,
    climax,
  });
}

function adaptPlotlineCharacters(
  records: readonly ParsedNarrativeFact[],
  plotlineIds: ReadonlySet<string>,
  skipped: NarrativeAnalysisAdapterSkip[],
): NarrativePlotlineCharacter[] {
  return uniqueRecords(
    records.filter(
      (record): record is ParsedPlotlineCharacter => record.kind === "plotline_character",
    ),
    (record) => `${record.plotlineId}\u0000${record.characterId}`,
    skipped,
  )
    .filter((record) =>
      requireReference(record, plotlineIds, "剧情线人物引用了未知剧情线。", skipped),
    )
    .map((record) =>
      Object.freeze({
        id: record.factId,
        plotlineId: record.plotlineId,
        characterId: record.characterId,
        evidence: Object.freeze([record.evidence]),
      }),
    );
}

function adaptPlotlineDependencies(
  records: readonly ParsedNarrativeFact[],
  plotlineIds: ReadonlySet<string>,
  skipped: NarrativeAnalysisAdapterSkip[],
): NarrativePlotlineDependency[] {
  return uniqueRecords(
    records.filter(
      (record): record is ParsedPlotlineDependency => record.kind === "plotline_dependency",
    ),
    (record) => `${record.fromPlotlineId}\u0000${record.toPlotlineId}`,
    skipped,
  )
    .filter((record) => {
      if (plotlineIds.has(record.fromPlotlineId) && plotlineIds.has(record.toPlotlineId)) {
        return true;
      }
      skipped.push(
        skipSource(record.factId, record.kind, "reference_missing", "剧情线依赖引用了未知剧情线。"),
      );
      return false;
    })
    .map((record) =>
      Object.freeze({
        id: record.factId,
        fromPlotlineId: record.fromPlotlineId,
        toPlotlineId: record.toPlotlineId,
        status: record.status,
        evidence: Object.freeze([record.evidence]),
      }),
    );
}

function adaptPlotlineProgress(
  records: readonly ParsedNarrativeFact[],
  plotlineIds: ReadonlySet<string>,
  chapterById: ReadonlyMap<string, ParsedChapter>,
  graphEvents: ReadonlyMap<string, CausalEventNode>,
  skipped: NarrativeAnalysisAdapterSkip[],
): NarrativePlotlineProgress[] {
  return uniqueRecords(
    records.filter(
      (record): record is ParsedPlotlineProgress => record.kind === "plotline_progress",
    ),
    (record) => `${record.plotlineId}\u0000${record.chapterId}\u0000${String(record.sequence)}`,
    skipped,
  ).flatMap((record): NarrativePlotlineProgress[] => {
    if (!plotlineIds.has(record.plotlineId) || !chapterById.has(record.chapterId)) {
      skipped.push(
        skipSource(
          record.factId,
          record.kind,
          chapterById.has(record.chapterId) ? "reference_missing" : "after_analysis_chapter",
          "剧情线推进引用了未知剧情线或不在本次分析范围内的章节。",
        ),
      );
      return [];
    }
    const event = graphEvents.get(record.eventId);
    if (event?.evidence.chapterId !== record.chapterId) {
      skipped.push(
        skipSource(
          record.factId,
          record.kind,
          "causal_event_missing",
          "剧情线推进没有对应的已确认因果事件。",
        ),
      );
      return [];
    }
    return [
      Object.freeze({
        id: record.factId,
        plotlineId: record.plotlineId,
        chapterId: record.chapterId,
        sequence: record.sequence,
        eventId: record.eventId,
        summary: record.summary,
        evidence: mergeEvidence(
          Object.freeze([record.evidence]),
          Object.freeze([causalEvidence(event.evidence, event.id)]),
        ),
      }),
    ];
  });
}

function adaptConvergencePlans(
  records: readonly ParsedNarrativeFact[],
  plotlineIds: ReadonlySet<string>,
  analysisOrder: number,
  skipped: NarrativeAnalysisAdapterSkip[],
): NarrativeConvergencePlan[] {
  return uniqueRecords(
    records.filter((record): record is ParsedConvergencePlan => record.kind === "convergence_plan"),
    (record) => record.factId,
    skipped,
  )
    .filter((record) => {
      if (record.plotlineIds.every((id) => plotlineIds.has(id))) {
        return true;
      }
      skipped.push(
        skipSource(record.factId, record.kind, "reference_missing", "交汇计划引用了未知剧情线。"),
      );
      return false;
    })
    .filter((record) => {
      if (record.status === "planned" || record.targetChapterOrder <= analysisOrder) {
        return true;
      }
      skipped.push(
        skipSource(
          record.factId,
          record.kind,
          "after_analysis_chapter",
          "已完成或取消的交汇记录发生在本次分析章节之后。",
        ),
      );
      return false;
    })
    .map((record) =>
      Object.freeze({
        id: record.factId,
        plotlineIds: Object.freeze([...record.plotlineIds]),
        targetChapterOrder: record.targetChapterOrder,
        status: record.status,
        evidence: Object.freeze([record.evidence]),
      }),
    );
}

function deriveCharacterPresences(
  progress: readonly NarrativePlotlineProgress[],
  graphEvents: ReadonlyMap<string, CausalEventNode>,
  skipped: NarrativeAnalysisAdapterSkip[],
): NarrativeCharacterPresence[] {
  const candidates: NarrativeCharacterPresence[] = [];
  for (const record of progress) {
    const event = graphEvents.get(record.eventId);
    if (event === undefined) {
      continue;
    }
    for (const characterId of event.participantCharacterIds) {
      candidates.push(
        Object.freeze({
          id: `${record.id}:presence:${characterId}`,
          characterId,
          plotlineId: record.plotlineId,
          chapterId: record.chapterId,
          storyTime: Object.freeze({
            start: event.narrativeTime.order,
            end: event.narrativeTime.order,
          }),
          locationId: event.location.locationId,
          evidence: mergeEvidence(
            record.evidence,
            Object.freeze([causalEvidence(event.evidence, event.id)]),
          ),
        }),
      );
    }
  }
  return uniqueNarrativeValues(
    candidates,
    (value) =>
      `${value.characterId}\u0000${value.plotlineId}\u0000${value.chapterId}\u0000${String(value.storyTime.start)}\u0000${value.locationId}`,
    (value) =>
      skipped.push(
        skipSource(
          value.id,
          "causal_presence",
          "duplicate_record",
          "同一人物在同一剧情线事件中的出现记录重复，已排除歧义项。",
        ),
      ),
  );
}

function deriveForeshadows(
  graph: CausalEventGraph | null,
  chapterById: ReadonlyMap<string, ParsedChapter>,
  skipped: NarrativeAnalysisAdapterSkip[],
): Readonly<{
  foreshadows: NarrativeForeshadow[];
  progress: NarrativeForeshadowProgress[];
}> {
  if (graph === null) {
    return { foreshadows: [], progress: [] };
  }
  const candidates: GraphForeshadowCandidate[] = [];
  for (const event of graph.events) {
    if (!chapterById.has(event.evidence.chapterId)) {
      continue;
    }
    event.foreshadowProgress.forEach((progress, indexInEvent) => {
      candidates.push({
        eventId: event.id,
        eventOrder: event.narrativeTime.order,
        indexInEvent,
        chapterId: event.evidence.chapterId,
        progressId: progress.id,
        foreshadowId: progress.foreshadowId,
        kind: progress.kind,
        description: progress.description,
        evidence: causalEvidence(progress.evidence, progress.id),
      });
    });
  }
  const grouped = new Map<string, GraphForeshadowCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.foreshadowId}\u0000${candidate.chapterId}`;
    const values = grouped.get(key) ?? [];
    values.push(candidate);
    grouped.set(key, values);
  }
  const progress: NarrativeForeshadowProgress[] = [];
  for (const values of grouped.values()) {
    const ambiguousOrders = new Set<number>();
    const eventIdsByOrder = new Map<number, Set<string>>();
    for (const value of values) {
      const eventIds = eventIdsByOrder.get(value.eventOrder) ?? new Set<string>();
      eventIds.add(value.eventId);
      eventIdsByOrder.set(value.eventOrder, eventIds);
      if (eventIds.size > 1) {
        ambiguousOrders.add(value.eventOrder);
      }
    }
    const ordered = values
      .filter((value) => {
        if (!ambiguousOrders.has(value.eventOrder)) {
          return true;
        }
        skipped.push(
          skipSource(
            value.progressId,
            "causal_foreshadow",
            "causal_order_ambiguous",
            "同一伏笔在同一明确故事时点由多个事件推进，无法确定先后顺序。",
          ),
        );
        return false;
      })
      .sort(
        (left, right) =>
          left.eventOrder - right.eventOrder || left.indexInEvent - right.indexInEvent,
      );
    ordered.forEach((value, index) => {
      progress.push(
        Object.freeze({
          id: value.progressId,
          foreshadowId: value.foreshadowId,
          chapterId: value.chapterId,
          sequence: index + 1,
          kind: value.kind,
          description: value.description,
          evidence: Object.freeze([value.evidence]),
        }),
      );
    });
  }
  const foreshadows = [...new Set(progress.map(({ foreshadowId }) => foreshadowId))]
    .sort()
    .map((id) => Object.freeze({ id }));
  return {
    foreshadows,
    progress: progress.sort(
      (left, right) =>
        left.foreshadowId.localeCompare(right.foreshadowId) ||
        left.chapterId.localeCompare(right.chapterId) ||
        left.sequence - right.sequence,
    ),
  };
}

function adaptScenes(
  records: readonly ParsedNarrativeFact[],
  chapterById: ReadonlyMap<string, ParsedChapter>,
  plotlineIds: ReadonlySet<string>,
  skipped: NarrativeAnalysisAdapterSkip[],
): NarrativeSceneMetrics[] {
  return uniqueRecords(
    records.filter((record): record is ParsedSceneMetric => record.kind === "scene_metric"),
    (record) => `${record.scene.chapterId}\u0000${String(record.scene.sequence)}`,
    skipped,
  )
    .filter((record) => {
      if (!chapterById.has(record.scene.chapterId)) {
        skipped.push(
          skipSource(
            record.factId,
            record.kind,
            "after_analysis_chapter",
            "场景不在本次分析章节范围内。",
          ),
        );
        return false;
      }
      const referenced = record.scene.plotAdvancement?.value.plotlineIds ?? [];
      if (referenced.every((id) => plotlineIds.has(id))) {
        return true;
      }
      skipped.push(
        skipSource(
          record.factId,
          record.kind,
          "reference_missing",
          "场景推进指标引用了未知剧情线。",
        ),
      );
      return false;
    })
    .map(({ scene }) => scene);
}

function adaptCoverage(
  records: readonly ParsedNarrativeFact[],
  graphAvailable: boolean,
  skipped: NarrativeAnalysisAdapterSkip[],
): NarrativeAnalysisCoverage {
  const coverageRecords = records.filter(
    (record): record is ParsedCoverage => record.kind === "coverage",
  );
  const assertions = Object.fromEntries(
    NARRATIVE_ANALYSIS_COVERAGE_AREAS.map((area) => {
      const candidates = coverageRecords.filter((record) => record.area === area);
      if (candidates.length !== 1) {
        if (candidates.length > 1) {
          candidates.forEach((record) =>
            skipped.push(
              skipSource(
                record.factId,
                record.kind,
                "duplicate_record",
                "同一检查范围存在多条有效覆盖声明，无法确定哪一条生效。",
              ),
            ),
          );
        }
        return [area, Object.freeze({ complete: false, evidence: Object.freeze([]) })];
      }
      const record = candidates[0];
      if (record === undefined) {
        return [area, Object.freeze({ complete: false, evidence: Object.freeze([]) })];
      }
      const graphBacked =
        area === "plotline_progress" ||
        area === "character_presence" ||
        area === "foreshadow_progress";
      return [
        area,
        Object.freeze({
          complete: record.complete && (!graphBacked || graphAvailable),
          evidence: Object.freeze([record.evidence]),
        }),
      ];
    }),
  );
  return Object.freeze(assertions as unknown as NarrativeAnalysisCoverage);
}

function coverageRequirements(
  coverage: NarrativeAnalysisCoverage,
  graphAvailable: boolean,
): string[] {
  const missing = NARRATIVE_ANALYSIS_COVERAGE_AREAS.filter(
    (area) => !coverage[area].complete || coverage[area].evidence.length === 0,
  ).map((area) => `complete_narrative_coverage:${area}`);
  if (!graphAvailable) {
    missing.push("verified_causal_graph");
  }
  return [...new Set(missing)].sort();
}

function keepUniqueChapterOrders(
  chapters: readonly ParsedChapter[],
  skipped: NarrativeAnalysisAdapterSkip[],
): ParsedChapter[] {
  return uniqueRecords(chapters, (record) => String(record.order), skipped);
}

function uniqueRecords<
  RecordValue extends { readonly factId: string; readonly kind: NarrativeAnalysisFactKind },
>(
  records: readonly RecordValue[],
  keyOf: (record: RecordValue) => string,
  skipped: NarrativeAnalysisAdapterSkip[],
): RecordValue[] {
  const grouped = new Map<string, RecordValue[]>();
  for (const record of records) {
    const key = keyOf(record);
    const values = grouped.get(key) ?? [];
    values.push(record);
    grouped.set(key, values);
  }
  const accepted: RecordValue[] = [];
  for (const values of grouped.values()) {
    if (values.length === 1) {
      const value = values[0];
      if (value !== undefined) {
        accepted.push(value);
      }
      continue;
    }
    values.forEach((record) =>
      skipped.push(
        skipSource(
          record.factId,
          record.kind,
          "duplicate_record",
          "同一叙事记录存在多个有效来源，已排除全部歧义项。",
        ),
      ),
    );
  }
  return accepted;
}

function uniqueNarrativeValues<Value>(
  values: readonly Value[],
  keyOf: (value: Value) => string,
  onDuplicate: (value: Value) => void,
): Value[] {
  const grouped = new Map<string, Value[]>();
  for (const value of values) {
    const key = keyOf(value);
    const matches = grouped.get(key) ?? [];
    matches.push(value);
    grouped.set(key, matches);
  }
  const result: Value[] = [];
  for (const matches of grouped.values()) {
    if (matches.length === 1) {
      const value = matches[0];
      if (value !== undefined) {
        result.push(value);
      }
    } else {
      matches.forEach(onDuplicate);
    }
  }
  return result;
}

function requireReference(
  record: ParsedPlotlineCharacter,
  plotlineIds: ReadonlySet<string>,
  explanation: string,
  skipped: NarrativeAnalysisAdapterSkip[],
): boolean {
  if (plotlineIds.has(record.plotlineId)) {
    return true;
  }
  skipped.push(skipSource(record.factId, record.kind, "reference_missing", explanation));
  return false;
}

function causalEvidence(
  evidence: CausalTextEvidence,
  sourceId: string,
): NarrativeEvidenceReference {
  return Object.freeze({
    sourceKind: "causal_event",
    sourceId,
    sourceVersionId: evidence.chapterVersionId,
    contentHash: evidence.contentHash,
    locator: evidence.locator,
    excerpt: evidence.excerpt,
    startOffset: evidence.startOffset,
    endOffset: evidence.endOffset,
    sourceLength: evidence.sourceLength,
  });
}

function mergeEvidence(
  ...collections: readonly (readonly NarrativeEvidenceReference[])[]
): readonly NarrativeEvidenceReference[] {
  const evidence = new Map<string, NarrativeEvidenceReference>();
  for (const candidate of collections.flat()) {
    evidence.set(
      `${candidate.sourceKind}\u0000${candidate.sourceId}\u0000${candidate.sourceVersionId}\u0000${String(candidate.startOffset)}\u0000${String(candidate.endOffset)}`,
      candidate,
    );
  }
  return Object.freeze([...evidence.values()]);
}

function supported<Value>(
  value: Value,
  evidence: readonly NarrativeEvidenceReference[],
): NarrativeSupportedValue<Value> {
  return Object.freeze({ value, evidence });
}

const INVALID = Symbol("invalid-narrative-value");

function optionalSupported<Value>(
  raw: unknown,
  evidence: readonly NarrativeEvidenceReference[],
  parser: (value: unknown) => Value | null,
): NarrativeSupportedValue<Value> | null | typeof INVALID {
  if (raw === null || raw === undefined) {
    return null;
  }
  const parsed = parser(raw);
  return parsed === null ? INVALID : supported(parsed, evidence);
}

function tensionMeasurement(value: unknown) {
  const record = asRecord(value);
  const start = unitInterval(record?.start);
  const end = unitInterval(record?.end);
  const peak = unitInterval(record?.peak);
  return start === null || end === null || peak === null || peak < start || peak < end
    ? null
    : Object.freeze({ start, end, peak });
}

function compositionMeasurement(value: unknown) {
  const record = asRecord(value);
  const informationRatio = unitInterval(record?.informationRatio);
  const dialogueRatio = unitInterval(record?.dialogueRatio);
  const descriptionRatio = unitInterval(record?.descriptionRatio);
  const innerActivityRatio = unitInterval(record?.innerActivityRatio);
  const measuredUnits = positiveInteger(record?.measuredUnits);
  if (
    informationRatio === null ||
    dialogueRatio === null ||
    descriptionRatio === null ||
    innerActivityRatio === null ||
    measuredUnits === null ||
    Math.abs(informationRatio + dialogueRatio + descriptionRatio + innerActivityRatio - 1) > 1e-6
  ) {
    return null;
  }
  return Object.freeze({
    informationRatio,
    dialogueRatio,
    descriptionRatio,
    innerActivityRatio,
    measuredUnits,
  });
}

function plotAdvancementValue(value: unknown) {
  const record = asRecord(value);
  const plotlineIds = safeReferenceArray(record?.plotlineIds, 0);
  if (typeof record?.advances !== "boolean" || plotlineIds === null) {
    return null;
  }
  if (
    (record.advances && plotlineIds.length === 0) ||
    (!record.advances && plotlineIds.length > 0)
  ) {
    return null;
  }
  return Object.freeze({ advances: record.advances, plotlineIds });
}

function characterChangeValue(value: unknown) {
  const record = asRecord(value);
  const characterIds = safeReferenceArray(record?.characterIds, 0);
  if (typeof record?.changes !== "boolean" || characterIds === null) {
    return null;
  }
  if (
    (record.changes && characterIds.length === 0) ||
    (!record.changes && characterIds.length > 0)
  ) {
    return null;
  }
  return Object.freeze({ changes: record.changes, characterIds });
}

function climaxValue(value: unknown) {
  const record = asRecord(value);
  const requiredSetupBeatIds = safeReferenceArray(record?.requiredSetupBeatIds, 0);
  if (typeof record?.isClimax !== "boolean" || requiredSetupBeatIds === null) {
    return null;
  }
  if (!record.isClimax && requiredSetupBeatIds.length > 0) {
    return null;
  }
  return Object.freeze({ isClimax: record.isClimax, requiredSetupBeatIds });
}

function parseSuccess(value: ParsedNarrativeFact): ParseResult {
  return { ok: true, value };
}

function parseFailure(kind: NarrativeAnalysisFactKind | null, explanation: string): ParseResult {
  return { ok: false, failure: { kind, explanation } };
}

function narrativeKind(value: unknown): NarrativeAnalysisFactKind | null {
  return typeof value === "string" &&
    NARRATIVE_ANALYSIS_FACT_KINDS.includes(value as NarrativeAnalysisFactKind)
    ? (value as NarrativeAnalysisFactKind)
    : null;
}

function coverageArea(value: unknown): NarrativeAnalysisCoverageArea | null {
  return typeof value === "string" &&
    NARRATIVE_ANALYSIS_COVERAGE_AREAS.includes(value as NarrativeAnalysisCoverageArea)
    ? (value as NarrativeAnalysisCoverageArea)
    : null;
}

function dependencyStatus(value: unknown): NarrativePlotlineDependency["status"] | null {
  return value === "pending" || value === "satisfied" || value === "blocked" ? value : null;
}

function convergenceStatus(value: unknown): NarrativeConvergencePlan["status"] | null {
  return value === "planned" || value === "reached" || value === "cancelled" ? value : null;
}

function nullableText(
  value: unknown,
): Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false }> {
  if (value === null) {
    return { ok: true, value: null };
  }
  const text = safeText(value);
  return text === null ? { ok: false } : { ok: true, value: text };
}

function safeText(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAXIMUM_TEXT &&
    !CONTROL_PATTERN.test(value)
    ? value
    : null;
}

function safeReference(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAXIMUM_REFERENCE &&
    !CONTROL_PATTERN.test(value)
    ? value
    : null;
}

function safeReferenceArray(value: unknown, minimum: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAXIMUM_RECORDS) {
    return null;
  }
  const references = value.map(safeReference);
  if (references.some((reference) => reference === null)) {
    return null;
  }
  const values = references as string[];
  return new Set(values).size === values.length ? Object.freeze(values) : null;
}

function safeOrder(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000_000
    ? Number(value)
    : null;
}

function safeSequence(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAXIMUM_RECORDS
    ? Number(value)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 5_000_000
    ? Number(value)
    : null;
}

function unitInterval(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function skipSource(
  sourceId: string,
  kind: NarrativeAnalysisAdapterSkip["kind"],
  reason: NarrativeAnalysisAdapterSkipReason,
  explanation: string,
): NarrativeAnalysisAdapterSkip {
  return Object.freeze({ sourceId, kind, reason, explanation });
}

function narrativeProjectionSkip(
  value: ContinuousProjectionDiagnostic,
): NarrativeAnalysisAdapterSkip {
  const reason: NarrativeAnalysisAdapterSkipReason =
    value.reason === "branch_mismatch"
      ? "branch_mismatch"
      : value.reason === "evidence_invalid"
        ? "evidence_mismatch"
        : "structured_value_invalid";
  return skipSource(
    value.sourceFactId,
    null,
    reason,
    `Continuous narrative projection skipped: ${value.missingRequirements.join(", ")}.`,
  );
}

function evidenceSkipReason(snapshot: StoryFactSnapshot): NarrativeAnalysisAdapterSkipReason {
  return snapshot.source.kind === "chapter_span" ? "evidence_mismatch" : "exact_evidence_missing";
}

function sortSkips(
  values: readonly NarrativeAnalysisAdapterSkip[],
): NarrativeAnalysisAdapterSkip[] {
  return [...values].sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.reason.localeCompare(right.reason),
  );
}

function normalizeBranch(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim().length === 0 ? "main" : value;
}

function freezeRuntimeResult(
  value: Omit<ChapterNarrativeAnalysisResult, "capabilities">,
): ChapterNarrativeAnalysisResult {
  return Object.freeze({
    ...value,
    skippedSources: Object.freeze([...value.skippedSources]),
    missingRequirements: Object.freeze([...value.missingRequirements]),
    capabilities: Object.freeze({
      confirmedFactsOnly: true as const,
      rebuildableSystemMetrics: "verified_current_version_only" as const,
      verifiedCausalGraphOnly: true as const,
      naturalLanguageInference: "disabled" as const,
      mutatesStory: false as const,
    }),
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
