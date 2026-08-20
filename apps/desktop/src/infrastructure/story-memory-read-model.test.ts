import { AiCandidate, createProjectSeed, updateProjectSeedField } from "@inkshadow/domain";
import { StoryFact } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it } from "vitest";

import { createDevelopmentRuntime } from "./runtime";
import { CompositeStoryMemoryReadModel } from "./story-memory-read-model";

const NOW = "2026-08-18T00:00:00.000Z";
const ACTOR_ID = uuid(900);

describe("CompositeStoryMemoryReadModel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("combines current evidence, confirmed canon, rebuildable projections and project core", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "记忆读模型" }));
    const chapter = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: "林遥在钟楼下等雨停。",
      }),
    );

    const formal = expectStoryOk(
      StoryFact.create({
        id: uuid(10),
        projectId: project.id,
        factType: "world_rule",
        contentText: "钟楼午夜后不会开门。",
        source: chapterSpan(chapter.chapter.id, chapter.version.id, "林遥"),
        confidence: 1,
        status: "formal",
        origin: "user",
        needsReview: false,
        humanConfirmed: true,
        confirmationActorId: ACTOR_ID,
        now: NOW,
      }),
    );
    expectStoryOk(await runtime.story.facts.create(formal));
    const summary = expectStoryOk(
      chapterSummaryFact(
        project.id,
        chapter.chapter.id,
        chapter.version.id,
        chapter.version.toSnapshot().contentChecksum,
      ),
    );
    expectStoryOk(await runtime.story.facts.create(summary));

    let seed = createProjectSeed({
      seedId: uuid(30),
      journeyKind: "idea",
      premise: "一个关于失踪钟声的故事。",
      now: NOW,
    });
    seed = updateProjectSeedField(seed, "boundaries", {
      values: "不要复活已经确认死亡的人物。",
      source: "user_input",
      confirmation: "confirmed",
      origin: "test",
      updatedAt: NOW,
    });
    seed = updateProjectSeedField(seed, "genre", {
      values: "也许是悬疑",
      source: "ai_inference",
      confirmation: "unconfirmed",
      origin: "test-inference",
      updatedAt: NOW,
    });
    await runtime.projectSeeds.saveForProject(project.id, seed);

    const memory = expectStoryOk(
      await runtime.story.memoryService.createRecord({
        projectId: project.id,
        level: "L1",
        content: "旧记忆：林遥常带着怀表。",
        source: {
          kind: "chapter",
          sourceId: chapter.chapter.id,
          sourceVersionId: chapter.version.id,
        },
        origin: "user",
        humanConfirmed: true,
      }),
    );

    const model = new CompositeStoryMemoryReadModel({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.facts,
      memoryRecords: runtime.story.memoryRecords,
      projectSeeds: runtime.projectSeeds,
      candidates: runtime.repositories.aiCandidates,
      hasher: runtime.hasher,
    });
    const result = await model.read({
      projectId: project.id,
      currentBranchId: null,
      currentChapterId: chapter.chapter.id,
      currentImmutableVersionId: chapter.version.id,
      currentPovCharacterId: uuid(901),
      currentStoryOrder: 1,
      taskType: "continuation",
      privacy: "standard",
      authorityRevision: 1,
      destination: "local",
      observedAt: runtime.clock.now(),
    });

    expect(result.layers.L0).toEqual([
      expect.objectContaining({
        id: `chapter:${chapter.chapter.id}:${chapter.version.id}`,
        kind: "evidence",
        content: chapter.chapter.content,
      }),
    ]);
    expect(result.layers.L0[0]?.evidence[0]).toMatchObject({
      immutableVersionId: chapter.version.id,
      currentness: "current",
      locator: {
        kind: "utf16",
        startOffset: 0,
        endOffset: chapter.chapter.content.length,
        sourceLength: chapter.chapter.content.length,
      },
    });
    expect(result.layers.L1).toHaveLength(1);
    expect(result.layers.L1[0]?.id).toContain(formal.id);
    expect(result.layers.L1[0]?.kind).toBe("confirmed_canon");
    expect(result.layers.L2).toHaveLength(1);
    expect(result.layers.L2[0]?.id).toContain(summary.id);
    expect(result.layers.L2[0]).toMatchObject({
      kind: "rebuildable_narrative_projection",
      rebuildable: true,
    });
    expect(result.layers.L3.some(({ content }) => content.includes("一个关于失踪钟声的故事"))).toBe(
      true,
    );
    expect(result.layers.L3.some(({ content }) => content.includes("不要复活"))).toBe(true);
    expect(result.legacy).toHaveLength(1);
    expect(result.legacy[0]?.id).toContain(memory.id);
    expect(result.advisory).toHaveLength(1);
    expect(result.advisory[0]?.content).toContain("也许是悬疑");
    expect(result.exclusions).toContainEqual(
      expect.objectContaining({ sourceId: "project-seed:genre", reason: "unconfirmed" }),
    );
    expect(result.layers.L0[0]?.evidence[0]).not.toHaveProperty("excerpt");
    expect(result.layers.L0[0]?.evidence[0]).not.toHaveProperty("content");
    expect(result.scope).toMatchObject({
      currentChapterId: chapter.chapter.id,
      currentImmutableVersionId: chapter.version.id,
      taskType: "continuation",
      authorityRevision: 1,
    });
    expect(result.projectCore).toEqual(result.layers.L3);
    expect(result.canonFacts).toEqual(result.layers.L1);
    expect(result.narrativeState.atoms.map(({ id }) => id)).toEqual([formal.id]);
    expect(result.activeTaskState).toEqual({
      taskType: "continuation",
      status: "ready",
      missingRequirements: [],
    });
    expect(new Set(result.retrievalCandidates.map(({ id }) => id)).size).toBe(
      result.retrievalCandidates.length,
    );
    expect(result.contextDecisionTrace.every(({ evidenceRefCount }) => evidenceRefCount >= 0)).toBe(
      true,
    );
  });

  it("hard-filters stale versions, other branches, private remote evidence and rejected candidates", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(await runtime.useCases.createProject.execute({ name: "硬过滤" }));
    const standard = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "公开章节",
        content: "当前正文证据。",
      }),
    );
    const privateChapter = expectOk(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "私密章节",
        content: "不能发送的正文。",
        privacyMode: "local_only",
      }),
    );

    const stale = expectStoryOk(
      StoryFact.create({
        id: uuid(40),
        projectId: project.id,
        factType: "world_rule",
        contentText: "旧版本曾说门是红色。",
        source: chapterSpan(standard.chapter.id, uuid(401), "旧版本"),
        confidence: 1,
        status: "formal",
        origin: "user",
        needsReview: false,
        humanConfirmed: true,
        confirmationActorId: ACTOR_ID,
        now: NOW,
      }),
    );
    expectStoryOk(await runtime.story.facts.create(stale));
    const otherBranch = expectStoryOk(
      StoryFact.create({
        id: uuid(41),
        projectId: project.id,
        factType: "relationship",
        contentText: "另一个分支里两人已经离开。",
        source: chapterSpan(standard.chapter.id, standard.version.id, "当前正文"),
        branchId: uuid(411),
        confidence: 1,
        status: "branch",
        origin: "user",
        needsReview: false,
        humanConfirmed: false,
        now: NOW,
      }),
    );
    expectStoryOk(await runtime.story.facts.create(otherBranch));
    const privateFact = expectStoryOk(
      StoryFact.create({
        id: uuid(42),
        projectId: project.id,
        factType: "world_rule",
        contentText: "私密章节中的规则。",
        source: chapterSpan(privateChapter.chapter.id, privateChapter.version.id, "不能发送"),
        confidence: 1,
        status: "formal",
        origin: "user",
        needsReview: false,
        humanConfirmed: true,
        confirmationActorId: ACTOR_ID,
        now: NOW,
      }),
    );
    expectStoryOk(await runtime.story.facts.create(privateFact));

    const candidateHash = expectOk(await runtime.hasher.sha256("被拒绝的建议"));
    const candidateNow = runtime.clock.now();
    const streaming = expectOk(
      AiCandidate.createStreaming({
        id: runtime.ids.next(),
        projectId: project.id,
        chapterId: standard.chapter.id,
        baseVersionId: standard.version.id,
        source: "generate",
        now: candidateNow,
        applicationIntent: {
          task: "continuation",
          application: "insert_at_cursor",
          payload: "fragment",
          startUtf16: standard.chapter.content.length,
          endUtf16: standard.chapter.content.length,
        },
      }),
    );
    const ready = expectOk(streaming.markReady("被拒绝的建议", candidateHash, candidateNow));
    const rejected = expectOk(ready.reject(candidateNow));
    expectOk(await runtime.repositories.aiCandidates.create(rejected));

    const model = new CompositeStoryMemoryReadModel({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.facts,
      memoryRecords: runtime.story.memoryRecords,
      projectSeeds: runtime.projectSeeds,
      candidates: runtime.repositories.aiCandidates,
      hasher: runtime.hasher,
    });
    const result = await model.read({
      projectId: project.id,
      currentBranchId: null,
      destination: "remote",
      observedAt: runtime.clock.now(),
    });

    expect(result.layers.L1).toEqual([]);
    expect(result.layers.L0.map(({ content }) => content)).toEqual(["当前正文证据。"]);
    expect(result.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: stale.id, reason: "stale_version" }),
        expect.objectContaining({ sourceId: otherBranch.id, reason: "other_branch" }),
        expect.objectContaining({ sourceId: privateFact.id, reason: "private_remote_denied" }),
        expect.objectContaining({
          sourceId: privateChapter.chapter.id,
          reason: "private_remote_denied",
        }),
        expect.objectContaining({ sourceId: rejected.id, reason: "rejected_candidate" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("被拒绝的建议");
    expect(JSON.stringify(result)).not.toContain("不能发送的正文");
  });
});

function chapterSpan(chapterId: string, versionId: string, excerpt: string) {
  return {
    kind: "chapter_span" as const,
    reference: `chapter:${chapterId}:version:${versionId}:utf16:0-${String(excerpt.length)}`,
    chapterId,
    versionId,
    startOffset: 0,
    endOffset: excerpt.length,
    sourceLength: Math.max(excerpt.length, 20),
    excerpt,
  };
}

function chapterSummaryFact(
  projectId: string,
  chapterId: string,
  versionId: string,
  contentHash: string,
) {
  const evidenceId = `chapter:${chapterId}:version:${versionId}:sha256:${contentHash}:utf16:0-2`;
  return StoryFact.create({
    id: uuid(20),
    projectId,
    factType: "chapter_summary",
    contentText: "林遥正在钟楼下等待。",
    structuredValue: {
      schemaVersion: "inkshadow.rebuildable-system-fact.v1",
      replacementKey: `chapter:${chapterId}`,
      payload: {
        schemaVersion: "inkshadow.chapter-summary.v1",
        sourceProjectId: projectId,
        sourceChapterId: chapterId,
        sourceVersionId: versionId,
        sourceContentHash: contentHash,
        citations: [{ evidenceId, startOffset: 0, endOffset: 2, sourceLength: 11 }],
        keyEvents: [{ text: "等待", evidenceIds: [evidenceId] }],
        continuityNotes: [{ text: "场景仍在钟楼", evidenceIds: [evidenceId] }],
        generation: {
          task: "long_memory_compression",
          providerKind: "ollama",
          modelId: "fake-model",
          invocationId: uuid(21),
        },
        budget: {
          strategy: "bounded_utf16_segments",
          segmentCharacters: 1_800,
          maximumSegments: 48,
          sourceCharacters: 11,
          estimatedInputTokens: 20,
          tokenEstimate: "model_hub_estimate_not_provider_tokenizer",
        },
      },
    },
    source: {
      kind: "chapter_span",
      reference: `chapter-summary:${chapterId}:${versionId}:sha256:${contentHash}`,
      chapterId,
      versionId,
      startOffset: 0,
      endOffset: 2,
      sourceLength: 11,
      excerpt: "林遥",
    },
    confidence: 1,
    status: "temporary",
    origin: "system",
    needsReview: false,
    humanConfirmed: false,
    now: NOW,
  });
}

function expectOk<Value>(
  result:
    | Readonly<{ readonly ok: true; readonly value: Value }>
    | Readonly<{ readonly ok: false; readonly error: unknown }>,
): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}

function expectStoryOk<Value>(
  result:
    | Readonly<{ readonly ok: true; readonly value: Value }>
    | Readonly<{ readonly ok: false; readonly error: unknown }>,
): Value {
  return expectOk(result);
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}
