import { createHash } from "node:crypto";

import type { ChapterVersionRepository } from "@inkshadow/application";
import {
  ChapterVersion,
  ok,
  parseContentChecksum,
  parseUuidV7 as parseDomainUuid,
  type ChapterVersionSnapshot,
} from "@inkshadow/domain";
import { StoryFact } from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import {
  BrowserDevelopmentCausalEventGraphStore,
  type CausalEvidenceReader,
} from "./causal-event-graph-store";
import {
  CAUSAL_EVENT_FACT_SCHEMA,
  CAUSAL_RELATION_FACT_SCHEMA,
  CausalStoryFactProjector,
} from "./causal-story-fact-projector";
import { BrowserDevelopmentStoryFactStore } from "./story-fact-store";

const PROJECT_ID = uuid(1);
const ACTOR_ID = uuid(2);
const CHAPTER_ID = uuid(3);
const VERSION_ID = uuid(4);
const CONTENT = "门开了。钟声响起。";
const CHECKSUM = createHash("sha256").update(CONTENT, "utf8").digest("hex");
const NOW = "2026-08-01T00:00:00.000Z";

describe("causal story-fact projector", () => {
  it("projects only confirmed evidence-backed facts and derives downstream impacts", async () => {
    const storage = new MemoryStorage();
    const version = chapterVersion();
    const versions = new MemoryVersionRepository(version);
    const evidenceReader: CausalEvidenceReader = {
      readChapterVersion: (versionId) =>
        Promise.resolve(
          versionId === VERSION_ID
            ? {
                chapterVersionId: VERSION_ID,
                projectId: PROJECT_ID,
                chapterId: CHAPTER_ID,
                content: CONTENT,
                contentChecksum: CHECKSUM,
              }
            : null,
        ),
    };
    const facts = new BrowserDevelopmentStoryFactStore(storage);
    const graph = new BrowserDevelopmentCausalEventGraphStore(storage, evidenceReader);
    await persist(
      facts,
      eventFact({ id: uuid(10), eventId: "event-one", order: 1, start: 0, end: 4 }),
    );
    await persist(
      facts,
      eventFact({ id: uuid(11), eventId: "event-two", order: 2, start: 4, end: 9 }),
    );
    await persist(facts, relationFact());
    await persist(facts, unconfirmedEventFact());

    const receipt = await new CausalStoryFactProjector({
      facts,
      chapterVersions: versions,
      graph,
    }).rebuildProject(PROJECT_ID);

    expect(receipt).toMatchObject({ eventCount: 2, relationCount: 1 });
    expect(receipt.includedFactIds).toEqual([uuid(10), uuid(11), uuid(12)]);
    expect(receipt.skipped).toEqual([
      expect.objectContaining({ factId: uuid(13), reason: "not_confirmed" }),
    ]);
    expect(receipt.graph.events.find(({ id }) => id === "event-one")?.downstreamEventIds).toEqual([
      "event-two",
    ]);
    const impact = await graph.traceImpacts({
      projectId: PROJECT_ID,
      branchId: "main",
      changedEventIds: ["event-one"],
    });
    expect(impact.impactedEvents).toEqual([
      expect.objectContaining({ eventId: "event-two", depth: 1 }),
    ]);
  });

  it("skips a fact whose immutable source excerpt no longer matches", async () => {
    const storage = new MemoryStorage();
    const version = chapterVersion();
    const versions = new MemoryVersionRepository(version);
    const facts = new BrowserDevelopmentStoryFactStore(storage);
    await persist(
      facts,
      eventFact({ id: uuid(20), eventId: "event-invalid", order: 1, start: 0, end: 4 }, "错误片段"),
    );
    const graph = new BrowserDevelopmentCausalEventGraphStore(storage, {
      readChapterVersion: () =>
        Promise.resolve({
          chapterVersionId: VERSION_ID,
          projectId: PROJECT_ID,
          chapterId: CHAPTER_ID,
          content: CONTENT,
          contentChecksum: CHECKSUM,
        }),
    });

    const receipt = await new CausalStoryFactProjector({
      facts,
      chapterVersions: versions,
      graph,
    }).rebuildProject(PROJECT_ID);

    expect(receipt.eventCount).toBe(0);
    expect(receipt.skipped).toEqual([
      expect.objectContaining({ reason: "chapter_evidence_mismatch" }),
    ]);
  });
});

function eventFact(
  input: {
    readonly id: string;
    readonly eventId: string;
    readonly order: number;
    readonly start: number;
    readonly end: number;
  },
  excerpt = CONTENT.slice(input.start, input.end),
) {
  return StoryFact.create({
    id: input.id,
    projectId: PROJECT_ID,
    factType: "causal_event",
    contentText: `事件 ${input.eventId}`,
    structuredValue: {
      schemaVersion: CAUSAL_EVENT_FACT_SCHEMA,
      eventId: input.eventId,
      participantCharacterIds: ["character-hero"],
      narrativeTime: { order: input.order, label: `第 ${String(input.order)} 幕` },
      location: { locationId: "old-gate", label: "旧门" },
      eventText: input.eventId === "event-one" ? "门被打开" : "钟声响起",
      resultText: input.eventId === "event-one" ? "封印松动" : "守门人醒来",
      informedCharacterIds: ["character-hero"],
      prerequisites: [],
      characterStateChanges: [],
      relationshipChanges: [],
      itemChanges: [],
      foreshadowProgress: [],
      downstreamEventIds: [],
    },
    source: {
      kind: "chapter_span",
      reference: `chapter:${CHAPTER_ID}`,
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      startOffset: input.start,
      endOffset: input.end,
      sourceLength: CONTENT.length,
      excerpt,
    },
    confidence: 1,
    status: "formal",
    origin: "user",
    needsReview: false,
    humanConfirmed: true,
    confirmationActorId: ACTOR_ID,
    now: NOW,
  });
}

function relationFact() {
  return StoryFact.create({
    id: uuid(12),
    projectId: PROJECT_ID,
    factType: "causal_relation",
    contentText: "开门导致钟响",
    structuredValue: {
      schemaVersion: CAUSAL_RELATION_FACT_SCHEMA,
      relationId: "relation-one",
      fromEventId: "event-one",
      toEventId: "event-two",
      kind: "causes",
    },
    source: {
      kind: "chapter_span",
      reference: `chapter:${CHAPTER_ID}`,
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      startOffset: 0,
      endOffset: 9,
      sourceLength: CONTENT.length,
      excerpt: CONTENT.slice(0, 9),
    },
    confidence: 1,
    status: "formal",
    origin: "user",
    needsReview: false,
    humanConfirmed: true,
    confirmationActorId: ACTOR_ID,
    now: NOW,
  });
}

function unconfirmedEventFact() {
  return StoryFact.create({
    id: uuid(13),
    projectId: PROJECT_ID,
    factType: "causal_event",
    contentText: "AI 猜测的第三个事件",
    structuredValue: {
      schemaVersion: CAUSAL_EVENT_FACT_SCHEMA,
      eventId: "event-three",
      participantCharacterIds: [],
      narrativeTime: { order: 3, label: "第三幕" },
      location: { locationId: "unknown", label: "未知" },
      eventText: "可能发生",
      resultText: "尚未确认",
      informedCharacterIds: [],
      prerequisites: [],
      characterStateChanges: [],
      relationshipChanges: [],
      itemChanges: [],
      foreshadowProgress: [],
      downstreamEventIds: [],
    },
    source: {
      kind: "chapter_span",
      reference: `chapter:${CHAPTER_ID}`,
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      startOffset: 4,
      endOffset: 9,
      sourceLength: CONTENT.length,
      excerpt: CONTENT.slice(4, 9),
    },
    confidence: 0.6,
    status: "unconfirmed",
    origin: "ai_extraction",
    needsReview: true,
    humanConfirmed: false,
    now: NOW,
  });
}

async function persist(
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

function chapterVersion() {
  const checksum = parseContentChecksum(CHECKSUM);
  const projectId = parseDomainUuid(PROJECT_ID);
  const chapterId = parseDomainUuid(CHAPTER_ID);
  const versionId = parseDomainUuid(VERSION_ID);
  if (!checksum.ok || !projectId.ok || !chapterId.ok || !versionId.ok) {
    throw new Error("The fixture identifiers are invalid.");
  }
  const snapshot: ChapterVersionSnapshot = {
    id: versionId.value,
    projectId: projectId.value,
    chapterId: chapterId.value,
    parentVersionId: null,
    sequence: 1,
    content: CONTENT,
    contentChecksum: checksum.value,
    reason: "created",
    sourceCandidateId: null,
    createdAt: NOW as ChapterVersionSnapshot["createdAt"],
  };
  const created = ChapterVersion.create(snapshot);
  if (!created.ok) {
    throw created.error;
  }
  return created.value;
}

class MemoryVersionRepository implements ChapterVersionRepository {
  public constructor(private readonly version: ChapterVersion) {}

  public findVersionById(id: ChapterVersionSnapshot["id"]) {
    return Promise.resolve(ok(id === this.version.toSnapshot().id ? this.version : null));
  }

  public listByChapterId() {
    return Promise.resolve(ok([this.version]));
  }
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
