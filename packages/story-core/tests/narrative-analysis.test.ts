import { describe, expect, it } from "vitest";

import {
  NARRATIVE_ANALYSIS_COVERAGE_AREAS,
  analyzeNovelNarrative,
  type NarrativeAnalysisCoverage,
  type NarrativeAnalysisInput,
  type NarrativeEvidenceReference,
  type NarrativeSceneMetrics,
  type NarrativeSupportedValue,
} from "../src/narrative-analysis.js";

const HASH = "a".repeat(64);

describe("deterministic narrative analysis", () => {
  it("coordinates plotlines and foreshadows from explicit evidence-backed facts", () => {
    const result = analyzeNovelNarrative(completeInput());
    const main = result.plotlines.find(({ plotlineId }) => plotlineId === "plot-main");
    const romance = result.plotlines.find(({ plotlineId }) => plotlineId === "plot-romance");

    expect(main).toMatchObject({
      goal: { status: "analyzed", value: "Reach the observatory." },
      characterIds: {
        status: "analyzed",
        value: ["character-hero", "character-mentor"],
      },
      dependencies: {
        status: "analyzed",
        value: [
          {
            id: "dependency-main-romance",
            toPlotlineId: "plot-romance",
            status: "pending",
          },
        ],
      },
      latestProgress: {
        status: "analyzed",
        value: { id: "progress-main-3", chapterId: "chapter-3" },
      },
      stagnation: {
        status: "analyzed",
        value: { state: "active", chaptersSinceProgress: 0, threshold: 2 },
      },
      upcomingConvergences: {
        status: "analyzed",
        value: [{ id: "convergence-4", targetChapterOrder: 4 }],
      },
    });
    expect(romance).toMatchObject({
      latestProgress: {
        status: "analyzed",
        value: { id: "progress-romance-1", chapterId: "chapter-1" },
      },
      stagnation: {
        status: "analyzed",
        value: { state: "stagnant", chaptersSinceProgress: 2, threshold: 2 },
      },
    });

    expect(result.timeLocationConflicts).toMatchObject({
      status: "analyzed",
      value: [
        {
          characterId: "character-hero",
          plotlineIds: ["plot-main", "plot-romance"],
          locationIds: ["observatory", "riverside"],
          overlappingStoryTime: { start: 120, end: 130 },
        },
      ],
    });
    if (result.timeLocationConflicts.status !== "analyzed") {
      throw new Error("Expected an analyzed time/location conflict.");
    }
    expect(result.timeLocationConflicts.value[0]?.evidence).toHaveLength(2);

    expect(result.foreshadows).toEqual([
      {
        foreshadowId: "foreshadow-key",
        progress: expect.objectContaining({
          status: "analyzed",
          value: expect.objectContaining({
            state: "active",
            latestProgress: expect.objectContaining({ id: "foreshadow-advanced" }),
            chaptersSinceProgress: 2,
            stagnant: true,
            threshold: 2,
            sequenceIssues: [],
          }),
        }),
      },
    ]);
    expect(main?.goal.status === "analyzed" ? main.goal.evidence.length : 0).toBeGreaterThan(0);
  });

  it("reports transparent scene/chapter metrics without producing a quality score", () => {
    const result = analyzeNovelNarrative(completeInput());

    expect(result.scenes[0]).toMatchObject({
      sceneId: "scene-1",
      goal: { status: "analyzed", value: "Introduce the locked observatory." },
      conflictIntensity: { status: "analyzed", value: 0.5 },
      tension: {
        status: "analyzed",
        value: {
          start: 0.2,
          end: 0.4,
          peak: 0.6,
          change: 0.2,
          trend: "rising",
          flatTolerance: 0.01,
        },
      },
      composition: {
        status: "analyzed",
        value: {
          informationRatio: 0.25,
          dialogueRatio: 0.25,
          descriptionRatio: 0.25,
          innerActivityRatio: 0.25,
          measuredUnits: 100,
        },
      },
      plotAdvancement: { status: "analyzed", value: { advances: true } },
      characterChange: { status: "analyzed", value: { changes: true } },
    });
    expect(result.chapters[0]).toMatchObject({
      conflict: {
        status: "analyzed",
        value: { weightedMean: 0.5, measuredUnits: 100 },
      },
      tension: {
        status: "analyzed",
        value: { start: 0.2, end: 0.4, peak: 0.6, trend: "rising" },
      },
      composition: {
        status: "analyzed",
        value: {
          informationRatio: 0.25,
          dialogueRatio: 0.25,
          descriptionRatio: 0.25,
          innerActivityRatio: 0.25,
        },
      },
    });

    expect(result.repeatedFunctions).toMatchObject({
      status: "analyzed",
      value: [
        {
          functionTags: ["exposition", "obstacle"],
          sceneIds: ["scene-1", "scene-2", "scene-3"],
          occurrenceCount: 3,
          lookbackChapters: 3,
        },
      ],
    });
    expect(result.buildupChecks).toMatchObject({
      status: "analyzed",
      value: [
        {
          climaxSceneId: "scene-3",
          status: "missing_required_setup",
          foundSetupBeatIds: ["setup-near"],
          missingSetupBeatIds: ["setup-far"],
          lookbackChapters: 2,
        },
      ],
    });
    expect(result.similarPacingRuns).toMatchObject({
      status: "analyzed",
      value: [
        {
          chapterIds: ["chapter-1", "chapter-2", "chapter-3"],
          tolerance: 0.01,
          deltas: [
            expect.objectContaining({ conflictIntensity: 0, dialogueRatio: 0 }),
            expect.objectContaining({ conflictIntensity: 0, dialogueRatio: 0 }),
          ],
        },
      ],
    });
    if (result.similarPacingRuns.status !== "analyzed") {
      throw new Error("Expected analyzed pacing runs.");
    }
    expect(result.similarPacingRuns.evidence).toContainEqual(
      expect.objectContaining({ sourceId: "source-coverage-scene_metrics" }),
    );
    expect(result.qualityFindings.map(({ kind }) => kind)).toEqual([
      "climax_missing_required_setup",
      "consecutive_chapters_have_similar_pacing",
      "repeated_scene_function",
      "scene_changes_neither_plot_nor_character",
      "scene_changes_neither_plot_nor_character",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/qualityScore|overallScore|score/iu);
  });

  it("marks evidence-poor analysis as skipped instead of inventing conclusions", () => {
    const input = sparseInput();
    const result = analyzeNovelNarrative(input);

    expect(result.plotlines[0]).toMatchObject({
      goal: { status: "skipped", reason: "structured_value_missing" },
      characterIds: { status: "skipped", reason: "coverage_incomplete" },
      latestProgress: { status: "skipped", reason: "coverage_missing_evidence" },
      stagnation: { status: "skipped", reason: "coverage_missing_evidence" },
    });
    expect(result.scenes[0]).toMatchObject({
      goal: { status: "skipped", reason: "structured_value_missing" },
      conflictIntensity: { status: "skipped", reason: "structured_value_missing" },
      tension: { status: "skipped", reason: "structured_value_missing" },
      composition: { status: "skipped", reason: "structured_value_missing" },
    });
    expect(result.chapters[0]).toMatchObject({
      conflict: { status: "skipped", reason: "coverage_incomplete" },
      tension: { status: "skipped", reason: "coverage_incomplete" },
    });
    expect(result.timeLocationConflicts).toEqual({
      status: "skipped",
      reason: "coverage_incomplete",
    });
    expect(result.qualityFindings).toEqual([]);
    expect(result.skippedChecks).toEqual(
      expect.arrayContaining([
        {
          scope: "plotline",
          scopeId: "plot-main",
          check: "stagnation",
          reason: "coverage_missing_evidence",
        },
        {
          scope: "global",
          scopeId: "narrative",
          check: "time_location_conflicts",
          reason: "coverage_incomplete",
        },
      ]),
    );
  });

  it("reports explicit foreshadow sequence anomalies with their source evidence", () => {
    const input = completeInput();
    input.foreshadowProgress = [
      foreshadowProgress("advance-before-plant", "chapter-1", "advanced", 1),
      foreshadowProgress("plant-first", "chapter-1", "planted", 2),
      foreshadowProgress("plant-again", "chapter-2", "planted", 1),
      foreshadowProgress("resolve", "chapter-2", "resolved", 2),
      foreshadowProgress("advance-after-resolve", "chapter-3", "advanced", 1),
    ];

    const result = analyzeNovelNarrative(input);
    const progress = result.foreshadows[0]?.progress;
    if (progress?.status !== "analyzed") {
      throw new Error("Expected analyzed foreshadow progress.");
    }
    expect(progress.value.state).toBe("resolved");
    expect(
      progress.value.sequenceIssues.map(({ kind, progressId }) => ({ kind, progressId })),
    ).toEqual([
      { kind: "missing_plant", progressId: "advance-before-plant" },
      { kind: "duplicate_plant", progressId: "plant-again" },
      { kind: "progress_after_resolution", progressId: "advance-after-resolve" },
    ]);
    expect(progress.value.sequenceIssues.every(({ evidence }) => evidence.length > 0)).toBe(true);
  });

  it("keeps revealed but unresolved foreshadows eligible for explicit stagnation checks", () => {
    const input = completeInput();
    input.foreshadowProgress = [
      foreshadowProgress("plant", "chapter-1", "planted", 1),
      foreshadowProgress("reveal", "chapter-1", "revealed", 2),
    ];

    const progress = analyzeNovelNarrative(input).foreshadows[0]?.progress;
    expect(progress).toMatchObject({
      status: "analyzed",
      value: {
        state: "revealed",
        chaptersSinceProgress: 2,
        stagnant: true,
        threshold: 2,
      },
    });
  });

  it("rejects invalid ratios, imprecise evidence, and dangling structured references", () => {
    const invalidRatio = completeInput();
    const scene = invalidRatio.scenes[0];
    if (scene === undefined) {
      throw new Error("Expected scene fixture.");
    }
    invalidRatio.scenes = [
      {
        ...scene,
        composition: supported(
          {
            informationRatio: 0.1,
            dialogueRatio: 0.2,
            descriptionRatio: 0.3,
            innerActivityRatio: 0.3,
            measuredUnits: 100,
          },
          "invalid-ratio",
        ),
      },
      ...invalidRatio.scenes.slice(1),
    ];
    expect(() => analyzeNovelNarrative(invalidRatio)).toThrow(
      expect.objectContaining({ code: "NARRATIVE_ANALYSIS_INPUT_INVALID" }),
    );

    const invalidEvidence = completeInput();
    const firstChapter = invalidEvidence.chapters[0];
    if (firstChapter === undefined) {
      throw new Error("Expected chapter fixture.");
    }
    invalidEvidence.chapters = [
      {
        ...firstChapter,
        evidence: [{ ...evidence("bad-range"), endOffset: 2 }],
      },
      ...invalidEvidence.chapters.slice(1),
    ];
    expect(() => analyzeNovelNarrative(invalidEvidence)).toThrow(/exact immutable source span/iu);

    const dangling = completeInput();
    const firstProgress = dangling.plotlineProgress[0];
    if (firstProgress === undefined) {
      throw new Error("Expected plotline progress fixture.");
    }
    dangling.plotlineProgress = [
      { ...firstProgress, plotlineId: "missing-plotline" },
      ...dangling.plotlineProgress.slice(1),
    ];
    expect(() => analyzeNovelNarrative(dangling)).toThrow(/known record/iu);

    const staleCutoff = completeInput();
    staleCutoff.analysisChapterId = "chapter-2";
    expect(() => analyzeNovelNarrative(staleCutoff)).toThrow(/latest observed chapter/iu);

    const duplicateDependency = completeInput();
    const dependency = duplicateDependency.plotlineDependencies[0];
    if (dependency === undefined) {
      throw new Error("Expected plotline dependency fixture.");
    }
    duplicateDependency.plotlineDependencies = [
      dependency,
      { ...dependency, id: "dependency-main-romance-copy" },
    ];
    expect(() => analyzeNovelNarrative(duplicateDependency)).toThrow(
      /signature cannot be duplicated/iu,
    );
  });

  it("is deterministic for reversed input and freezes result collections", () => {
    const forward = completeInput();
    const reversed: NarrativeAnalysisInput = {
      ...forward,
      chapters: [...forward.chapters].reverse(),
      plotlines: [...forward.plotlines].reverse(),
      plotlineCharacters: [...forward.plotlineCharacters].reverse(),
      plotlineDependencies: [...forward.plotlineDependencies].reverse(),
      plotlineProgress: [...forward.plotlineProgress].reverse(),
      convergencePlans: [...forward.convergencePlans].reverse(),
      characterPresences: [...forward.characterPresences].reverse(),
      foreshadows: [...forward.foreshadows].reverse(),
      foreshadowProgress: [...forward.foreshadowProgress].reverse(),
      scenes: [...forward.scenes].reverse(),
    };

    const result = analyzeNovelNarrative(forward);
    expect(analyzeNovelNarrative(reversed)).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.plotlines)).toBe(true);
    expect(Object.isFrozen(result.scenes[0]?.goal)).toBe(true);
    expect(result.capabilities).toEqual({
      deterministicNarrativeCoordination: "ready",
      deterministicPacingAnalysis: "ready",
      semanticQualityJudgement: "separate_read_only_ai_review",
    });
  });
});

function completeInput(): Mutable<NarrativeAnalysisInput> {
  const chapters = [1, 2, 3].map((order) => ({
    id: `chapter-${String(order)}`,
    order,
    evidence: [evidence(`chapter-${String(order)}`)],
  }));
  return {
    projectId: "project-one",
    branchId: "main",
    analysisChapterId: "chapter-3",
    policy: {
      plotlineStaleAfterChapters: 2,
      foreshadowStaleAfterChapters: 2,
      upcomingConvergenceWithinChapters: 2,
      repeatedFunctionLookbackChapters: 3,
      minimumRepeatedFunctionOccurrences: 3,
      buildupLookbackChapters: 2,
      pacingSimilarityTolerance: 0.01,
      minimumSimilarPacingChapters: 3,
      tensionFlatTolerance: 0.01,
    },
    coverage: completeCoverage(),
    chapters,
    plotlines: [
      { id: "plot-main", goal: supported("Reach the observatory.", "goal-main") },
      { id: "plot-romance", goal: supported("Restore mutual trust.", "goal-romance") },
    ],
    plotlineCharacters: [
      association("association-main-hero", "plot-main", "character-hero"),
      association("association-main-mentor", "plot-main", "character-mentor"),
      association("association-romance-hero", "plot-romance", "character-hero"),
      association("association-romance-rival", "plot-romance", "character-rival"),
    ],
    plotlineDependencies: [
      {
        id: "dependency-main-romance",
        fromPlotlineId: "plot-main",
        toPlotlineId: "plot-romance",
        status: "pending",
        evidence: [evidence("dependency-main-romance")],
      },
    ],
    plotlineProgress: [
      {
        id: "progress-main-3",
        plotlineId: "plot-main",
        chapterId: "chapter-3",
        sequence: 1,
        eventId: "event-observatory-door",
        summary: "The hero reaches the observatory door.",
        evidence: [evidence("progress-main-3")],
      },
      {
        id: "progress-romance-1",
        plotlineId: "plot-romance",
        chapterId: "chapter-1",
        sequence: 1,
        eventId: "event-broken-promise",
        summary: "The promise is broken.",
        evidence: [evidence("progress-romance-1")],
      },
    ],
    convergencePlans: [
      {
        id: "convergence-4",
        plotlineIds: ["plot-main", "plot-romance"],
        targetChapterOrder: 4,
        status: "planned",
        evidence: [evidence("convergence-4")],
      },
    ],
    characterPresences: [
      {
        id: "presence-observatory",
        characterId: "character-hero",
        plotlineId: "plot-main",
        chapterId: "chapter-3",
        storyTime: { start: 100, end: 130 },
        locationId: "observatory",
        evidence: [evidence("presence-observatory")],
      },
      {
        id: "presence-riverside",
        characterId: "character-hero",
        plotlineId: "plot-romance",
        chapterId: "chapter-3",
        storyTime: { start: 120, end: 140 },
        locationId: "riverside",
        evidence: [evidence("presence-riverside")],
      },
    ],
    foreshadows: [{ id: "foreshadow-key" }],
    foreshadowProgress: [
      foreshadowProgress("foreshadow-planted", "chapter-1", "planted", 1),
      foreshadowProgress("foreshadow-advanced", "chapter-1", "advanced", 2),
    ],
    scenes: [
      scene("scene-1", "chapter-1", {
        goal: "Introduce the locked observatory.",
        advances: true,
        changes: true,
        setupBeatIds: ["setup-far"],
      }),
      scene("scene-2", "chapter-2", {
        goal: "Delay entry into the observatory.",
        advances: false,
        changes: false,
        setupBeatIds: ["setup-near"],
      }),
      scene("scene-3", "chapter-3", {
        goal: "Force the observatory door.",
        advances: false,
        changes: false,
        setupBeatIds: [],
        climaxRequired: ["setup-far", "setup-near"],
      }),
    ],
  };
}

function sparseInput(): NarrativeAnalysisInput {
  const incomplete = supportedCoverage(false, "coverage-partial");
  const coverage = Object.fromEntries(
    NARRATIVE_ANALYSIS_COVERAGE_AREAS.map((area) => [area, incomplete]),
  ) as unknown as NarrativeAnalysisCoverage;
  return {
    projectId: "project-one",
    branchId: "main",
    analysisChapterId: "chapter-1",
    policy: {
      plotlineStaleAfterChapters: 2,
      foreshadowStaleAfterChapters: 2,
      upcomingConvergenceWithinChapters: 2,
      repeatedFunctionLookbackChapters: 3,
      minimumRepeatedFunctionOccurrences: 2,
      buildupLookbackChapters: 2,
      pacingSimilarityTolerance: 0.05,
      minimumSimilarPacingChapters: 2,
      tensionFlatTolerance: 0.01,
    },
    coverage: {
      ...coverage,
      plotline_progress: { complete: true, evidence: [] },
    },
    chapters: [{ id: "chapter-1", order: 1, evidence: [] }],
    plotlines: [{ id: "plot-main", goal: null }],
    plotlineCharacters: [],
    plotlineDependencies: [],
    plotlineProgress: [],
    convergencePlans: [],
    characterPresences: [],
    foreshadows: [],
    foreshadowProgress: [],
    scenes: [
      {
        id: "scene-1",
        chapterId: "chapter-1",
        sequence: 1,
        evidence: [],
        goal: null,
        conflictIntensity: null,
        tension: null,
        composition: null,
        plotAdvancement: null,
        characterChange: null,
        functionTags: null,
        setupBeatIds: null,
        climax: null,
      },
    ],
  };
}

function completeCoverage(): NarrativeAnalysisCoverage {
  return Object.fromEntries(
    NARRATIVE_ANALYSIS_COVERAGE_AREAS.map((area) => [
      area,
      supportedCoverage(true, `coverage-${area}`),
    ]),
  ) as unknown as NarrativeAnalysisCoverage;
}

function supportedCoverage(complete: boolean, id: string) {
  return { complete, evidence: [evidence(id)] };
}

function association(id: string, plotlineId: string, characterId: string) {
  return { id, plotlineId, characterId, evidence: [evidence(id)] };
}

function foreshadowProgress(
  id: string,
  chapterId: string,
  kind: "planted" | "advanced" | "revealed" | "resolved" | "misdirected",
  sequence = 1,
) {
  return {
    id,
    foreshadowId: "foreshadow-key",
    chapterId,
    sequence,
    kind,
    description: `${id} changes the clue state.`,
    evidence: [evidence(id)],
  };
}

function scene(
  id: string,
  chapterId: string,
  options: Readonly<{
    goal: string;
    advances: boolean;
    changes: boolean;
    setupBeatIds: readonly string[];
    climaxRequired?: readonly string[];
  }>,
): NarrativeSceneMetrics {
  return {
    id,
    chapterId,
    sequence: 1,
    evidence: [evidence(`${id}-structure`)],
    goal: supported(options.goal, `${id}-goal`),
    conflictIntensity: supported(0.5, `${id}-conflict`),
    tension: supported({ start: 0.2, end: 0.4, peak: 0.6 }, `${id}-tension`),
    composition: supported(
      {
        informationRatio: 0.25,
        dialogueRatio: 0.25,
        descriptionRatio: 0.25,
        innerActivityRatio: 0.25,
        measuredUnits: 100,
      },
      `${id}-composition`,
    ),
    plotAdvancement: supported(
      {
        advances: options.advances,
        plotlineIds: options.advances ? ["plot-main"] : [],
      },
      `${id}-advancement`,
    ),
    characterChange: supported(
      {
        changes: options.changes,
        characterIds: options.changes ? ["character-hero"] : [],
      },
      `${id}-character-change`,
    ),
    functionTags: supported(["exposition", "obstacle"], `${id}-function`),
    setupBeatIds: supported(options.setupBeatIds, `${id}-setup`),
    climax: supported(
      {
        isClimax: options.climaxRequired !== undefined,
        requiredSetupBeatIds: options.climaxRequired ?? [],
      },
      `${id}-climax`,
    ),
  };
}

function supported<Value>(value: Value, id: string): NarrativeSupportedValue<Value> {
  return { value, evidence: [evidence(id)] };
}

function evidence(id: string): NarrativeEvidenceReference {
  const excerpt = `evidence-${id}`;
  return {
    sourceKind: "story_fact",
    sourceId: `source-${id}`,
    sourceVersionId: `version-${id}`,
    contentHash: HASH,
    locator: `fact:${id}`,
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    sourceLength: excerpt.length,
  };
}

type Mutable<Value> = {
  -readonly [Key in keyof Value]: Value[Key];
};
