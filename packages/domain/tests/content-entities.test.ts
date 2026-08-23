import { describe, expect, it } from "vitest";

import {
  AiCandidate,
  Chapter,
  ChapterVersion,
  RecoveryDraft,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AiCandidateApplicationIntent,
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
  it("keeps chapter privacy on an independent optimistic revision", () => {
    const original = chapter();

    const changed = original.changePrivacy({
      privacyMode: "local_only",
      expectedPrivacyRevision: 1,
      now: timestamp("2026-07-27T00:01:00.000Z"),
    });

    expect(changed.ok).toBe(true);
    if (!changed.ok) {
      return;
    }
    expect(changed.value.toSnapshot()).toMatchObject({
      privacyMode: "local_only",
      privacyRevision: 2,
      revision: 1,
      currentVersionId: VERSION_ID,
    });
    expect(original.toSnapshot()).toMatchObject({
      privacyMode: "standard",
      privacyRevision: 1,
    });
  });

  it("rejects a stale privacy write without changing正文 version state", () => {
    const changed = chapter().changePrivacy({
      privacyMode: "local_only",
      expectedPrivacyRevision: 2,
      now: NOW,
    });

    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.error.code).toBe("VERSION_CONFLICT");
    }
  });

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

  it("defaults legacy chapter-version responsibility to false", () => {
    const version = ChapterVersion.create({
      id: NEXT_VERSION_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      parentVersionId: VERSION_ID,
      sequence: 2,
      content: "Saved text",
      contentChecksum: checksum(),
      reason: "manual",
      sourceCandidateId: null,
      createdAt: NOW,
    });

    expect(version.ok).toBe(true);
    if (!version.ok) return;
    expect(version.value.toSnapshot().organizeLocalStoryFacts).toBe(false);
  });

  it("only decides a ready candidate once", () => {
    const accepted = readyCandidate().accept(NOW);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      return;
    }

    expect(accepted.value.revision).toBe(2);
    const acceptedAgain = accepted.value.accept(NOW);
    expect(acceptedAgain.ok).toBe(false);
    if (!acceptedAgain.ok) {
      expect(acceptedAgain.error.code).toBe("CANDIDATE_ALREADY_DECIDED");
    }
  });

  it("revises only a ready candidate without deciding or mutating the original", () => {
    const original = readyCandidate();
    const revised = original.reviseReadyContent(
      "作者修改后的建议。",
      checksum(),
      timestamp("2026-07-27T00:02:00.000Z"),
    );

    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.value.toSnapshot()).toMatchObject({
      content: "作者修改后的建议。",
      status: "ready",
      revision: 2,
      decidedAt: null,
      updatedAt: "2026-07-27T00:02:00.000Z",
    });
    expect(original.content).not.toBe(revised.value.content);

    const accepted = revised.value.accept(NOW);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.revision).toBe(3);
      expect(accepted.value.reviseReadyContent("不能再改", checksum(), NOW).ok).toBe(false);
    }
  });

  it("normalizes legacy Candidate snapshots to explicit full-document application semantics", () => {
    const legacySnapshot = { ...readyCandidate().toSnapshot() };
    Reflect.deleteProperty(legacySnapshot, "applicationIntent");
    Reflect.deleteProperty(legacySnapshot, "revision");
    Reflect.deleteProperty(legacySnapshot, "purpose");

    const rehydrated = AiCandidate.rehydrate(legacySnapshot);

    expect(rehydrated.ok).toBe(true);
    if (!rehydrated.ok) return;
    expect(rehydrated.value.revision).toBe(1);
    expect(rehydrated.value.purpose).toBe("prose");
    expect(rehydrated.value.applicationIntent).toEqual({
      task: "legacy_full_document",
      application: "replace_document",
      payload: "full_document",
      startUtf16: null,
      endUtf16: null,
    });
  });

  it("lets the author explicitly keep an older ready Candidate without deciding or deleting it", () => {
    const original = readyCandidate();
    const retainedAt = timestamp("2026-08-26T00:00:00.000Z");

    const retained = original.retain(retainedAt);

    expect(retained.ok).toBe(true);
    if (!retained.ok) return;
    expect(retained.value.toSnapshot()).toMatchObject({
      status: "ready",
      revision: 2,
      content: original.content,
      contentChecksum: original.contentChecksum,
      updatedAt: retainedAt,
      decidedAt: null,
    });
    expect(original.revision).toBe(1);
  });

  it("keeps continuation directions isolated and impossible to accept", () => {
    const streaming = AiCandidate.createStreaming({
      id: CANDIDATE_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      source: "generate",
      purpose: "continuation_directions",
      baseVersionId: VERSION_ID,
      now: NOW,
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: 0,
        endUtf16: 0,
      },
    });
    expect(streaming.ok).toBe(true);
    if (!streaming.ok) return;
    const ready = streaming.value.markReady("方向一：进入钟楼调查", checksum(), NOW);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const accepted = ready.value.accept(NOW);
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) {
      expect(accepted.error.details.reason).toBe("CONTINUATION_DIRECTIONS_NOT_ACCEPTABLE");
    }
    expect(ready.value.reject(NOW).ok).toBe(true);
  });

  it("rejects an invalid Candidate revision during rehydration", () => {
    const invalid = AiCandidate.rehydrate({ ...readyCandidate().toSnapshot(), revision: 0 });

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("VALIDATION_FAILED");
      expect(invalid.error.details.field).toBe("revision");
    }
  });

  it("fails closed instead of overflowing exhausted Candidate revision authority", () => {
    const exhausted = AiCandidate.rehydrate({
      ...readyCandidate().toSnapshot(),
      revision: Number.MAX_SAFE_INTEGER,
    });

    expect(exhausted.ok).toBe(true);
    if (!exhausted.ok) return;
    const revised = exhausted.value.reviseReadyContent("不能越界", checksum(), NOW);
    const rejected = exhausted.value.reject(NOW);
    expect(revised.ok).toBe(false);
    expect(rejected.ok).toBe(false);
    if (!revised.ok) {
      expect(revised.error.details.reason).toBe("CANDIDATE_REVISION_EXHAUSTED");
    }
    if (!rejected.ok) {
      expect(rejected.error.details.reason).toBe("CANDIDATE_REVISION_EXHAUSTED");
    }
  });

  it("retains a fragment task anchor while the ready Candidate is revised", () => {
    const intent = {
      task: "selection_rewrite",
      application: "replace_selection",
      payload: "fragment",
      startUtf16: 2,
      endUtf16: 7,
    } as const;
    const streaming = AiCandidate.createStreaming({
      id: CANDIDATE_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      source: "polish",
      baseVersionId: VERSION_ID,
      now: NOW,
      applicationIntent: intent,
    });
    expect(streaming.ok).toBe(true);
    if (!streaming.ok) return;
    const ready = streaming.value.markReady("改写片段", checksum(), NOW);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const revised = ready.value.reviseReadyContent("作者调整后的片段", checksum(), NOW);

    expect(revised.ok).toBe(true);
    if (revised.ok) {
      expect(revised.value.applicationIntent).toEqual(intent);
    }
  });

  it("rejects malformed task anchors before a Candidate can be created", () => {
    const malformedIntent = {
      task: "continuation",
      application: "insert_at_cursor",
      payload: "fragment",
      startUtf16: 4,
      endUtf16: 5,
    } as unknown as AiCandidateApplicationIntent;

    const streaming = AiCandidate.createStreaming({
      id: CANDIDATE_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      source: "generate",
      baseVersionId: VERSION_ID,
      now: NOW,
      applicationIntent: malformedIntent,
    });

    expect(streaming.ok).toBe(false);
    if (!streaming.ok) {
      expect(streaming.error.code).toBe("VALIDATION_FAILED");
      expect(streaming.error.details.field).toBe("applicationIntent");
    }
  });
});
