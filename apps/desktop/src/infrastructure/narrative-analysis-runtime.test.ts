import { beforeEach, describe, expect, it } from "vitest";

import type { UuidV7 } from "@inkshadow/domain";
import { NARRATIVE_ANALYSIS_COVERAGE_AREAS } from "@inkshadow/story-core";

import { createDevelopmentRuntime, type DesktopRuntime } from "./runtime";

describe("ChapterNarrativeAnalysisRuntime", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("fails closed when no confirmed chapter-order fact has exact evidence", async () => {
    const fixture = await createFixture();

    const result = await fixture.runtime.story.narrativeAnalysis.analyzeChapter({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
    });

    expect(result).toMatchObject({
      status: "skipped",
      analysis: null,
      missingRequirements: ["confirmed_chapter_order_with_exact_evidence"],
      capabilities: {
        confirmedFactsOnly: true,
        verifiedCausalGraphOnly: true,
        naturalLanguageInference: "disabled",
        mutatesStory: false,
      },
    });
    expect(result.explanation).toContain("尚无足够证据");
  });

  it("adapts confirmed structural facts and verified causal events without prose inference", async () => {
    const fixture = await createFixture();
    await seedNarrativeFact(fixture, {
      kind: "chapter",
      chapterId: fixture.chapterId,
      order: 1,
    });
    for (const area of NARRATIVE_ANALYSIS_COVERAGE_AREAS) {
      await seedNarrativeFact(fixture, { kind: "coverage", area, complete: true });
    }
    await seedNarrativeFact(fixture, {
      kind: "plotline",
      plotlineId: "plot-main",
      goal: "进入观测站。",
    });
    await seedNarrativeFact(fixture, {
      kind: "plotline",
      plotlineId: "plot-romance",
      goal: "修复两人的信任。",
    });
    await seedNarrativeFact(fixture, {
      kind: "plotline_character",
      plotlineId: "plot-main",
      characterId: "character-hero",
    });
    await seedNarrativeFact(fixture, {
      kind: "plotline_character",
      plotlineId: "plot-romance",
      characterId: "character-hero",
    });
    await seedNarrativeFact(fixture, {
      kind: "plotline_progress",
      plotlineId: "plot-main",
      chapterId: fixture.chapterId,
      sequence: 1,
      eventId: "event-observatory",
      summary: "主角抵达观测站。",
    });
    await seedNarrativeFact(fixture, {
      kind: "plotline_progress",
      plotlineId: "plot-romance",
      chapterId: fixture.chapterId,
      sequence: 1,
      eventId: "event-riverside",
      summary: "主角赴河边见面。",
    });
    await seedNarrativeFact(fixture, {
      kind: "scene_metric",
      sceneId: "scene-one",
      chapterId: fixture.chapterId,
      sequence: 1,
      goal: "展示无法同时赴约的困境。",
      conflictIntensity: 0.7,
      tension: { start: 0.3, end: 0.7, peak: 0.8 },
      composition: {
        informationRatio: 0.25,
        dialogueRatio: 0.25,
        descriptionRatio: 0.25,
        innerActivityRatio: 0.25,
        measuredUnits: 100,
      },
      plotAdvancement: { advances: false, plotlineIds: [] },
      characterChange: { changes: false, characterIds: [] },
      functionTags: ["choice"],
      setupBeatIds: [],
      climax: { isClimax: false, requiredSetupBeatIds: [] },
    });

    await fixture.runtime.story.causalGraph.replace({
      projectId: fixture.projectId,
      branchId: "main",
      graph: {
        events: [
          causalEvent(fixture, {
            id: "event-observatory",
            locationId: "observatory",
            foreshadow: true,
          }),
          causalEvent(fixture, {
            id: "event-riverside",
            locationId: "riverside",
            foreshadow: false,
          }),
        ],
        relations: [],
      },
    });

    const result = await fixture.runtime.story.narrativeAnalysis.analyzeChapter({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
    });

    expect(result.status).toBe("analyzed");
    expect(result.missingRequirements).toEqual([]);
    expect(result.sourceSummary).toMatchObject({
      confirmedFacts: 15,
      causalEvents: 2,
      causalRelations: 0,
    });
    expect(result.analysis?.plotlines).toHaveLength(2);
    expect(result.analysis?.timeLocationConflicts).toMatchObject({
      status: "analyzed",
      value: [
        {
          characterId: "character-hero",
          locationIds: ["observatory", "riverside"],
          overlappingStoryTime: { start: 100, end: 100 },
        },
      ],
    });
    expect(result.analysis?.foreshadows).toMatchObject([
      {
        foreshadowId: "foreshadow-key",
        progress: { status: "analyzed", value: { state: "active", stagnant: false } },
      },
    ]);
    expect(result.analysis?.qualityFindings).toEqual([
      expect.objectContaining({
        kind: "scene_changes_neither_plot_nor_character",
        sceneId: "scene-one",
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/qualityScore|overallScore/iu);
  });

  it("excludes unconfirmed narrative facts instead of promoting them into analysis", async () => {
    const fixture = await createFixture();
    unwrap(
      await fixture.runtime.story.factService.stageAutomaticFact({
        projectId: fixture.projectId,
        factType: "narrative_analysis",
        contentText: "模型猜测这是第一章。",
        structuredValue: {
          schemaVersion: "inkshadow.narrative-analysis-fact.v1",
          kind: "chapter",
          chapterId: fixture.chapterId,
          order: 1,
        },
        source: fixture.factSource,
        confidence: 0.9,
        origin: "ai_extraction",
      }),
    );

    const result = await fixture.runtime.story.narrativeAnalysis.analyzeChapter({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
    });

    expect(result.status).toBe("skipped");
    expect(result.skippedSources).toEqual([
      expect.objectContaining({ kind: "chapter", reason: "not_confirmed" }),
    ]);
  });
});

interface Fixture {
  readonly runtime: DesktopRuntime;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly versionId: string;
  readonly contentHash: string;
  readonly content: string;
  readonly factSource: Readonly<{
    readonly kind: "chapter_span";
    readonly reference: string;
    readonly chapterId: string;
    readonly versionId: string;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly sourceLength: number;
    readonly excerpt: string;
  }>;
}

async function createFixture(): Promise<Fixture> {
  const runtime = createDevelopmentRuntime(window.localStorage);
  const project = unwrap(await runtime.useCases.createProject.execute({ name: "叙事分析测试" }));
  const content = "主角在同一时刻抵达观测站，也被记录为出现在河边。钥匙的伏笔已经埋下。";
  const created = unwrap(
    await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "第一章",
      content,
    }),
  );
  const chapter = created.chapter.toSnapshot();
  const contentHash = String(unwrap(await runtime.hasher.sha256(content)));
  return {
    runtime,
    projectId: project.id,
    chapterId: chapter.id,
    versionId: chapter.currentVersionId,
    contentHash,
    content,
    factSource: {
      kind: "chapter_span",
      reference: `chapter:${chapter.id}:narrative-structure`,
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      startOffset: 0,
      endOffset: content.length,
      sourceLength: content.length,
      excerpt: content,
    },
  };
}

async function seedNarrativeFact(
  fixture: Fixture,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  unwrap(
    await fixture.runtime.story.factService.createFormalUserFact({
      projectId: fixture.projectId,
      factType: "narrative_analysis",
      contentText: "用户确认的结构化叙事资料。",
      structuredValue: {
        schemaVersion: "inkshadow.narrative-analysis-fact.v1",
        ...value,
      },
      source: fixture.factSource,
      actorId: fixture.runtime.story.actorId,
      humanConfirmed: true,
    }),
  );
}

function causalEvent(
  fixture: Fixture,
  input: Readonly<{ id: string; locationId: string; foreshadow: boolean }>,
) {
  const evidence = {
    id: `${input.id}:evidence`,
    chapterId: fixture.chapterId,
    chapterVersionId: fixture.versionId,
    contentHash: fixture.contentHash,
    locator: `chapter:${fixture.chapterId}:${input.id}#utf16:0-${String(fixture.content.length)}/${String(fixture.content.length)}`,
    excerpt: fixture.content,
    startOffset: 0,
    endOffset: fixture.content.length,
    sourceLength: fixture.content.length,
  };
  return {
    id: input.id,
    projectId: fixture.projectId,
    branchId: "main",
    status: "confirmed" as const,
    participantCharacterIds: ["character-hero"],
    narrativeTime: { order: 100, label: "同一时刻" },
    location: { locationId: input.locationId, label: input.locationId },
    prerequisites: [],
    eventText: `${input.id} 发生。`,
    resultText: `${input.id} 已完成。`,
    characterStateChanges: [],
    relationshipChanges: [],
    itemChanges: [],
    informedCharacterIds: ["character-hero"],
    foreshadowProgress: input.foreshadow
      ? [
          {
            id: "foreshadow-key-planted",
            foreshadowId: "foreshadow-key",
            kind: "planted" as const,
            description: "钥匙伏笔被明确埋下。",
            evidence,
          },
        ]
      : [],
    downstreamEventIds: [],
    evidence,
  };
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
