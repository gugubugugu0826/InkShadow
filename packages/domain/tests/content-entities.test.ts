import { describe, expect, it } from "vitest";

import {
  AiCandidate,
  Chapter,
  ChapterVersion,
  RecoveryDraft,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type ContentChecksum,
  type IsoUtcTimestamp,
  type UuidV7,
} from "../src/index.js";

function uuid(value: string): UuidV7 {
  const result = parseUuidV7(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function timestamp(value: string): IsoUtcTimestamp {
  const result = parseIsoUtcTimestamp(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function checksum(value = "a"): ContentChecksum {
  const result = parseContentChecksum(value.repeat(64));
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

const PROJECT_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000001");
const CHAPTER_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000002");
const VERSION_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000003");
const NEXT_VERSION_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000004");
const CANDIDATE_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000005");
const DRAFT_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000006");
const NOW = timestamp("2026-07-27T00:00:00.000Z");

function chapter(): Chapter {
  const result = Chapter.create({
    id: CHAPTER_ID,
    projectId: PROJECT_ID,
    title: "Chapter One",
    content: "Stable text",
    initialVersionId: VERSION_ID,
    now: NOW,
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function readyCandidate(): AiCandidate {
  const streaming = AiCandidate.createStreaming({
    id: CANDIDATE_ID,
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    source: "generate",
    baseVersionId: VERSION_ID,
    now: NOW,
  });
  if (!streaming.ok) {
    throw streaming.error;
  }

  const ready = streaming.value.markReady("Candidate text", checksum(), NOW);
  if (!ready.ok) {
    throw ready.error;
  }
  return ready.value;
}

describe("content entities", () => {
  it("rejects a stale chapter write instead of overwriting", () => {
    const saved = chapter().saveContent({
      content: "New text",
      expectedRevision: 2,
      newVersionId: NEXT_VERSION_ID,
      now: NOW,
    });

    expect(saved.ok).toBe(false);
    if (!saved.ok) {
      expect(saved.error.code).toBe("VERSION_CONFLICT");
    }
  });

  it("keeps recovery cursor inside the draft", () => {
    const draft = RecoveryDraft.create({
      id: DRAFT_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      baseRevision: 1,
      content: "draft",
      cursorOffset: 99,
      now: NOW,
    });

    expect(draft.ok).toBe(false);
  });

  it("requires candidate versions to retain their candidate id", () => {
    const version = ChapterVersion.create({
      id: NEXT_VERSION_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      parentVersionId: VERSION_ID,
      sequence: 2,
      content: "Candidate text",
      contentChecksum: checksum(),
      reason: "candidate_accept",
      sourceCandidateId: null,
      createdAt: NOW,
    });

    expect(version.ok).toBe(false);
  });

  it("only decides a ready candidate once", () => {
    const accepted = readyCandidate().accept(NOW);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      return;
    }

    const acceptedAgain = accepted.value.accept(NOW);
    expect(acceptedAgain.ok).toBe(false);
    if (!acceptedAgain.ok) {
      expect(acceptedAgain.error.code).toBe("CANDIDATE_ALREADY_DECIDED");
    }
  });
});
