import type { SyncContentConflict } from "@inkshadow/data";
import { parseIsoUtcTimestamp, parseUuidV7 } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import {
  SyncConflictResolutionCoordinator,
  SyncConflictResolutionError,
  type CommitSyncChapterConflictResolutionInput,
  type SyncConflictReviewSourceResult,
} from "./sync-conflict-resolution-coordinator";

const PROJECT_ID = "019fa202-2000-7000-8000-000000000001";
const CHAPTER_ID = "019fa202-2000-7000-8000-000000000002";
const CONFLICT_ID = "019fa202-2000-7000-8000-000000000003";
const REMOTE_OPERATION_ID = "019fa202-2000-7000-8000-000000000004";
const LOCAL_VERSION_ID = "019fa202-2000-7000-8000-000000000005";
const REMOTE_VERSION_ID = "019fa202-2000-7000-8000-000000000006";
const BASE_VERSION_ID = "019fa202-2000-7000-8000-000000000007";
const GENERATED_IDS = [
  "019fa202-2000-7000-8000-000000000008",
  "019fa202-2000-7000-8000-000000000009",
  "019fa202-2000-7000-8000-000000000010",
  "019fa202-2000-7000-8000-000000000011",
  "019fa202-2000-7000-8000-000000000012",
].map((value) => expectDomain(parseUuidV7(value)));
const NOW = "2026-07-28T04:00:00.000Z";
const NOW_INSTANT = expectDomain(parseIsoUtcTimestamp(NOW));
const LOCAL_CHECKSUM = "1".repeat(64);
const REMOTE_CHECKSUM = "2".repeat(64);
const REMOTE_PAYLOAD_SHA = "3".repeat(64);
const BASE_CHECKSUM = "4".repeat(64);

describe("SyncConflictResolutionCoordinator", () => {
  it("requires an explicit confirmation of the exact reviewed branches", async () => {
    const fixture = createFixture();
    const review = await fixture.coordinator.loadReview(CONFLICT_ID);
    expect(review).toMatchObject({
      status: "ready",
      local: { content: "本地正文" },
      remote: { content: "云端正文" },
    });
    if (review.status !== "ready") {
      throw new Error("expected ready review");
    }

    await expect(
      fixture.coordinator.resolve({
        conflictId: CONFLICT_ID,
        reviewToken: review.reviewToken,
        action: "accept_remote",
        confirmed: false,
      }),
    ).rejects.toMatchObject({ code: "SYNC_CONFLICT_CONFIRMATION_REQUIRED" });
    expect(fixture.commit).not.toHaveBeenCalled();

    fixture.source.loadReview.mockResolvedValueOnce({
      ...readyReview(),
      local: { ...readyReview().local, revision: 8 },
    });
    await expect(
      fixture.coordinator.resolve({
        conflictId: CONFLICT_ID,
        reviewToken: review.reviewToken,
        action: "accept_remote",
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "SYNC_CONFLICT_REVIEW_STALE" });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("commits a manual merge as a new stable version with bounded metadata only", async () => {
    const fixture = createFixture();
    const review = await fixture.coordinator.loadReview(CONFLICT_ID);
    if (review.status !== "ready") {
      throw new Error("expected ready review");
    }

    await expect(
      fixture.coordinator.resolve({
        conflictId: CONFLICT_ID,
        reviewToken: review.reviewToken,
        action: "manual_merge",
        confirmed: true,
        mergedTitle: "人工合并章",
        mergedContent: "人工确认后的正文",
      }),
    ).resolves.toMatchObject({
      action: "manual_merge",
      stableVersionId: GENERATED_IDS[0],
      projectionJobId: GENERATED_IDS[1],
    });

    const committed = fixture.commit.mock.calls[0]?.[0];
    if (committed === undefined) {
      throw new Error("expected commit input");
    }
    expect(committed).toMatchObject({
      expectedConflictRevision: 2,
      expectedLocalVersionId: LOCAL_VERSION_ID,
      expectedRemoteOperationId: REMOTE_OPERATION_ID,
      action: "manual_merge",
      selectedTitle: "人工合并章",
      selectedContent: "人工确认后的正文",
      keptRemoteChapterId: null,
      confirmedAt: NOW,
    });
    expect(committed.selectedContentChecksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(committed)).not.toContain("accessToken");
    expect(Object.keys(committed)).not.toContain("projectKey");
  });

  it("keeps both branches by allocating a separate durable chapter/version/projection", async () => {
    const fixture = createFixture();
    const review = await fixture.coordinator.loadReview(CONFLICT_ID);
    if (review.status !== "ready") {
      throw new Error("expected ready review");
    }

    await fixture.coordinator.resolve({
      conflictId: CONFLICT_ID,
      reviewToken: review.reviewToken,
      action: "keep_both",
      confirmed: true,
    });

    expect(fixture.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "keep_both",
        selectedContent: "本地正文",
        keptRemoteChapterId: GENERATED_IDS[2],
        keptRemoteVersionId: GENERATED_IDS[3],
        keptRemoteProjectionJobId: GENERATED_IDS[4],
        keptRemoteContent: "云端正文",
        keptRemoteContentChecksum: REMOTE_CHECKSUM,
      }),
    );
  });

  it("fails closed for remote deletes and unsupported object types", async () => {
    const remoteDelete: SyncConflictReviewSourceResult = {
      status: "remote_delete",
      conflict: deleteConflict(),
      local: readyReview().local,
    };
    const fixture = createFixture({ review: remoteDelete });

    await expect(fixture.coordinator.loadReview(CONFLICT_ID)).resolves.toEqual(remoteDelete);
    await expect(
      fixture.coordinator.resolve({
        conflictId: CONFLICT_ID,
        reviewToken: "0".repeat(64),
        action: "accept_local",
        confirmed: true,
      }),
    ).rejects.toMatchObject({
      code: "SYNC_DELETE_CONFLICT_REQUIRES_SEPARATE_REVIEW",
    });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("validates manual content bounds before allocating durable identifiers", async () => {
    const fixture = createFixture();
    const review = await fixture.coordinator.loadReview(CONFLICT_ID);
    if (review.status !== "ready") {
      throw new Error("expected ready review");
    }

    await expect(
      fixture.coordinator.resolve({
        conflictId: CONFLICT_ID,
        reviewToken: review.reviewToken,
        action: "manual_merge",
        confirmed: true,
        mergedTitle: "   ",
        mergedContent: "x",
      }),
    ).rejects.toBeInstanceOf(SyncConflictResolutionError);
    expect(fixture.nextId).not.toHaveBeenCalled();
  });
});

function createFixture(options: Readonly<{ review?: SyncConflictReviewSourceResult }> = {}) {
  const review = options.review ?? readyReview();
  const source = {
    listUnresolved: vi.fn(() => Promise.resolve([])),
    loadReview: vi.fn(() => Promise.resolve(review)),
  };
  const commit = vi.fn((input: CommitSyncChapterConflictResolutionInput) =>
    Promise.resolve({
      conflictId: input.conflictId,
      action: input.action,
      stableVersionId: input.stableVersionId,
      projectionJobId: input.projectionJobId,
      keptRemoteChapterId: input.keptRemoteChapterId,
      keptRemoteVersionId: input.keptRemoteVersionId,
      replayed: false,
    }),
  );
  const ids = [...GENERATED_IDS];
  const nextId = vi.fn(() => {
    const id = ids.shift();
    if (id === undefined) {
      throw new Error("id fixture exhausted");
    }
    return id;
  });
  return {
    coordinator: new SyncConflictResolutionCoordinator({
      source,
      committer: { commitChapterResolution: commit },
      ids: { next: nextId },
      clock: { now: () => NOW_INSTANT },
    }),
    source,
    commit,
    nextId,
  };
}

function readyReview(): Extract<SyncConflictReviewSourceResult, { status: "ready" }> {
  return {
    status: "ready",
    conflict: upsertConflict(),
    local: {
      chapterId: CHAPTER_ID,
      title: "本地章",
      content: "本地正文",
      versionId: LOCAL_VERSION_ID,
      revision: 7,
      contentChecksum: LOCAL_CHECKSUM,
      updatedAt: NOW,
      deviceId: null,
    },
    remote: {
      chapterId: CHAPTER_ID,
      title: "云端章",
      content: "云端正文",
      versionId: REMOTE_VERSION_ID,
      revision: 7,
      contentChecksum: REMOTE_CHECKSUM,
      updatedAt: NOW,
      deviceId: "019fa202-2000-7000-8000-000000000013",
    },
    base: {
      versionId: BASE_VERSION_ID,
      content: "共同祖先",
      contentChecksum: BASE_CHECKSUM,
    },
  };
}

function upsertConflict(): Extract<
  SyncContentConflict,
  { status: "unresolved"; remoteKind: "upsert" }
> {
  return {
    conflictId: CONFLICT_ID,
    projectId: PROJECT_ID,
    objectType: "chapter_version",
    objectId: CHAPTER_ID,
    objectGeneration: 1,
    localVector: { local: 2 },
    remoteVector: { remote: 2 },
    remoteOperationId: REMOTE_OPERATION_ID,
    remoteKind: "upsert",
    remotePayloadSha256: REMOTE_PAYLOAD_SHA,
    status: "unresolved",
    resolution: null,
    resolutionOperationId: null,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
  };
}

function deleteConflict(): Extract<
  SyncContentConflict,
  { status: "unresolved"; remoteKind: "delete" }
> {
  return {
    ...upsertConflict(),
    remoteKind: "delete",
    remotePayloadSha256: null,
  };
}

function expectDomain<Value>(
  result: Readonly<{ ok: true; value: Value } | { ok: false; error: unknown }>,
): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
