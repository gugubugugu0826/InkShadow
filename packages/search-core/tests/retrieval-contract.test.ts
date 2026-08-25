import { describe, expect, it } from "vitest";

import {
  InMemoryHybridSearchIndex,
  SEARCH_CHUNK_KINDS,
  SEARCH_DOCUMENT_AUTHORITIES,
  SEARCH_DOCUMENT_CURRENTNESS,
  SEARCH_DOCUMENT_PRIVACY_MODES,
  SEARCH_RETRIEVAL_PRIVACY_SCOPES,
  SEARCH_RETRIEVAL_TASK_TYPES,
  type SearchDocument,
} from "../src/index.js";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000070";
const NOW = "2026-08-20T00:00:00.000Z";

describe("multigranular retrieval contracts", () => {
  it("keeps the bounded persisted enum families unique", () => {
    for (const values of [
      SEARCH_CHUNK_KINDS,
      SEARCH_DOCUMENT_AUTHORITIES,
      SEARCH_DOCUMENT_CURRENTNESS,
      SEARCH_DOCUMENT_PRIVACY_MODES,
      SEARCH_RETRIEVAL_PRIVACY_SCOPES,
      SEARCH_RETRIEVAL_TASK_TYPES,
    ]) {
      expect(new Set(values).size).toBe(values.length);
    }
    expect(SEARCH_CHUNK_KINDS).toEqual([
      "chapter",
      "scene",
      "event",
      "paragraph",
      "dialogue",
      "story_fact_evidence",
    ]);
    expect(SEARCH_RETRIEVAL_TASK_TYPES).toContain("prose_generation");
  });

  it("preserves exact parent, span, authority, privacy, and currentness evidence in hits", () => {
    const index = new InMemoryHybridSearchIndex();
    const document: SearchDocument = {
      id: "paragraph:chapter-1:4:10",
      projectId: PROJECT_ID,
      sourceType: "chapter",
      sourceId: "chapter-1",
      sourceVersionId: "version-1",
      title: "第一章 · 段落",
      text: "白塔密钥证据",
      contentHash: "a".repeat(64),
      updatedAt: NOW,
      chunkKind: "paragraph",
      parentDocumentId: "chapter:chapter-1:0",
      utf16Start: 4,
      utf16End: 10,
      sourceLength: 24,
      sceneId: "scene-1",
      eventId: null,
      characterIds: ["character-alice"],
      locationIds: ["location-white-tower"],
      storyTime: "night-before-storm",
      branchId: "branch-what-if",
      povCharacterId: "character-alice",
      storyOrder: 2,
      authority: "accepted_text",
      privacy: "local_only",
      currentness: "current",
      omittedScopeFields: ["story_time"],
    };
    index.rebuildProject(
      { projectId: PROJECT_ID, documents: [document], rebuiltAt: NOW },
      index.health().generation,
    );

    const result = index.search({ projectId: PROJECT_ID, query: "白塔密钥" });

    expect(result.hits[0]?.document).toMatchObject({
      chunkKind: "paragraph",
      parentDocumentId: "chapter:chapter-1:0",
      utf16Start: 4,
      utf16End: 10,
      sourceLength: 24,
      sceneId: "scene-1",
      eventId: null,
      characterIds: ["character-alice"],
      locationIds: ["location-white-tower"],
      storyTime: "night-before-storm",
      branchId: "branch-what-if",
      povCharacterId: "character-alice",
      storyOrder: 2,
      authority: "accepted_text",
      privacy: "local_only",
      currentness: "current",
      omittedScopeFields: ["story_time"],
    });
  });
});
