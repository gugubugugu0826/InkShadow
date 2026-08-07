import { StoryFact } from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import { BrowserDevelopmentStoryFactStore } from "./story-fact-store";
import {
  compileStoryContextForGeneration,
  formatStoryContextPrompt,
} from "./story-context-runtime";
import type { StoryContextRuntimeError } from "./story-context-runtime";

const PROJECT_ID = uuid(1);
const ACTOR_ID = uuid(2);
const CHAPTER_ID = uuid(3);
const VERSION_ID = uuid(4);
const NOW = "2026-08-01T00:00:00.000Z";

describe("story context runtime", () => {
  it("loads governed facts and compiles chapter, causal, semantic, and rerank sources in fixed order", async () => {
    const facts = new BrowserDevelopmentStoryFactStore(new MemoryStorage());
    await saveFact(
      facts,
      StoryFact.create({
        id: uuid(10),
        projectId: PROJECT_ID,
        factType: "world_rule",
        contentText: "魔法不能复活死者。",
        source: { kind: "user_statement", reference: "user:locked-rule" },
        confidence: 1,
        status: "formal",
        origin: "user",
        needsReview: false,
        locked: true,
        humanConfirmed: true,
        confirmationActorId: ACTOR_ID,
        now: NOW,
      }),
    );
    await saveFact(
      facts,
      StoryFact.create({
        id: uuid(11),
        projectId: PROJECT_ID,
        factType: "relationship",
        contentText: "林遥和苏晚可能已经相恋。",
        source: { kind: "system_derivation", reference: "extract:11" },
        confidence: 0.55,
        status: "unconfirmed",
        origin: "ai_extraction",
        needsReview: true,
        humanConfirmed: false,
        now: NOW,
      }),
    );

    const receipt = await compileStoryContextForGeneration(facts, {
      projectId: PROJECT_ID,
      currentTask: draft("continue", "续写下一场景。", "generation_task"),
      currentChapter: {
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        title: "雨夜站台",
        content: "列车已经离站，林遥仍站在雨里。",
      },
      causalCandidates: [draft("cause-1", "离站导致两人暂时失联。", "causal_event")],
      semanticCandidates: [draft("memory-1", "旧怀表曾在车站出现。", "memory")],
      rerankCandidates: [draft("rerank-1", "林遥害怕密闭车厢。", "rerank_result")],
      maximumContextTokens: 20_000,
    });

    expect(receipt.compiled.entries.map(({ layer }) => layer)).toEqual([
      "locked_hard_rules",
      "current_task",
      "recent_events",
      "related_causal_chain",
      "semantic_retrieval",
      "rerank_supplement",
    ]);
    expect(receipt.includedFactIds).toEqual([uuid(10)]);
    expect(receipt.discardedFacts).toEqual([
      expect.objectContaining({ factId: uuid(11), reason: "unconfirmed" }),
    ]);
    const chapterEvidence = receipt.compiled.entries[2]?.evidence[0];
    expect(chapterEvidence).toMatchObject({
      sourceId: CHAPTER_ID,
      sourceVersionId: VERSION_ID,
    });
    expect(chapterEvidence?.locator).toMatch(/^utf16:/u);
    const prompt = formatStoryContextPrompt(receipt);
    expect(prompt).toContain("魔法不能复活死者");
    expect(prompt).toContain("列车已经离站");
    expect(prompt).not.toContain("可能已经相恋");
    expect(receipt.promptSections).toHaveLength(6);
  });

  it("keeps only a bounded Unicode-safe tail of the current chapter", async () => {
    const facts = new BrowserDevelopmentStoryFactStore(new MemoryStorage());
    const chapterContent = `${"旧".repeat(4_000)}😀${"新".repeat(12_000)}`;
    const receipt = await compileStoryContextForGeneration(facts, {
      projectId: PROJECT_ID,
      currentTask: draft("continue", "续写。", "generation_task"),
      currentChapter: {
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        title: "长章",
        content: chapterContent,
      },
      maximumContextTokens: 20_000,
    });

    const chapter = receipt.compiled.entries.find(({ id }) => id.startsWith("current-chapter:"));
    expect(chapter?.content).toContain("新".repeat(100));
    expect(chapter?.content).not.toContain("旧".repeat(100));
    expect(chapter?.content).not.toContain("�");
    expect(chapter?.evidence[0]?.excerpt).toBeNull();
  });

  it("keeps user-visible task supplements independently traceable", async () => {
    const facts = new BrowserDevelopmentStoryFactStore(new MemoryStorage());
    const receipt = await compileStoryContextForGeneration(facts, {
      projectId: PROJECT_ID,
      currentTask: draft("continue", "续写。", "generation_task"),
      currentTaskSupplements: [draft("preference-1", "减少环境描写。", "user_input")],
      maximumContextTokens: 2_000,
    });

    const supplement = receipt.compiled.entries.find(({ id }) => id === "preference-1");
    expect(supplement).toMatchObject({
      layer: "current_task",
      content: "减少环境描写。",
      evidence: [{ sourceType: "user_input" }],
    });
  });

  it("records a current summary as recent events and audits an old-version summary", async () => {
    const facts = new BrowserDevelopmentStoryFactStore(new MemoryStorage());
    const contentHash = "d".repeat(64);
    const oldVersionId = uuid(40);
    await saveFact(facts, chapterSummaryFact(41, CHAPTER_ID, oldVersionId, "e".repeat(64)));
    await saveFact(facts, chapterSummaryFact(42, CHAPTER_ID, VERSION_ID, contentHash));

    const receipt = await compileStoryContextForGeneration(facts, {
      projectId: PROJECT_ID,
      currentTask: draft("continue", "Continue.", "generation_task"),
      currentChapterVersions: {
        [CHAPTER_ID]: { versionId: VERSION_ID, contentHash },
      },
      maximumContextTokens: 5_000,
    });

    expect(receipt.includedFactIds).toEqual([uuid(42)]);
    expect(receipt.discardedFacts).toContainEqual(
      expect.objectContaining({ factId: uuid(41), reason: "rebuildable_source_not_current" }),
    );
    const summary = receipt.compiled.entries.find(({ id }) => id.includes(uuid(42)));
    expect(summary).toMatchObject({
      layer: "recent_events",
      evidence: [
        {
          sourceId: CHAPTER_ID,
          sourceVersionId: VERSION_ID,
          contentHash,
          locator: "utf16:0-4/10",
        },
      ],
    });
  });

  it("fails clearly for an invalid project identifier", async () => {
    const facts = new BrowserDevelopmentStoryFactStore(new MemoryStorage());
    await expect(
      compileStoryContextForGeneration(facts, {
        projectId: "not-a-project-id",
        currentTask: draft("continue", "续写。", "generation_task"),
        maximumContextTokens: 1_000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<StoryContextRuntimeError>>({
        code: "STORY_CONTEXT_PROJECT_ID_INVALID",
      }),
    );
  });
});

function draft(
  id: string,
  content: string,
  sourceType: "generation_task" | "causal_event" | "memory" | "rerank_result" | "user_input",
) {
  return {
    id,
    content,
    selectionReason: `selected:${id}`,
    evidence: [
      {
        sourceType,
        sourceId: `${sourceType}:${id}`,
        sourceVersionId: null,
        locator: null,
        contentHash: null,
        excerpt: null,
      },
    ],
    priority: 100,
  } as const;
}

async function saveFact(
  store: BrowserDevelopmentStoryFactStore,
  created: ReturnType<typeof StoryFact.create>,
): Promise<void> {
  if (!created.ok) {
    throw created.error;
  }
  const saved = await store.create(created.value);
  if (!saved.ok) {
    throw saved.error;
  }
}

function chapterSummaryFact(
  sequence: number,
  chapterId: string,
  versionId: string,
  contentHash: string,
) {
  const evidenceId = `chapter:${chapterId}:version:${versionId}:sha256:${contentHash}:utf16:0-4`;
  return StoryFact.create({
    id: uuid(sequence),
    projectId: PROJECT_ID,
    factType: "chapter_summary",
    contentText: "Current saved chapter summary.",
    structuredValue: {
      schemaVersion: "inkshadow.rebuildable-system-fact.v1",
      replacementKey: `chapter:${chapterId}`,
      payload: {
        schemaVersion: "inkshadow.chapter-summary.v1",
        sourceProjectId: PROJECT_ID,
        sourceChapterId: chapterId,
        sourceVersionId: versionId,
        sourceContentHash: contentHash,
        citations: [{ evidenceId, startOffset: 0, endOffset: 4, sourceLength: 10 }],
        keyEvents: [{ text: "Event", evidenceIds: [evidenceId] }],
        continuityNotes: [{ text: "Note", evidenceIds: [evidenceId] }],
        generation: {
          task: "long_memory_compression",
          providerKind: "ollama",
          modelId: "test-model",
          invocationId: uuid(sequence + 100),
        },
        budget: {
          strategy: "bounded_utf16_segments",
          segmentCharacters: 1800,
          maximumSegments: 48,
          sourceCharacters: 10,
          estimatedInputTokens: 100,
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
      endOffset: 4,
      sourceLength: 10,
      excerpt: "ABCD",
    },
    confidence: 1,
    status: "temporary",
    origin: "system",
    needsReview: false,
    humanConfirmed: false,
    now: NOW,
  });
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
