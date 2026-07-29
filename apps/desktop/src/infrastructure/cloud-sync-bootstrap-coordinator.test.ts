import { CloudClientError } from "@inkshadow/cloud-client";
import {
  CONTRACT_SCHEMA_VERSION,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type CloudProjectStateResponse,
  type CloudSyncSnapshotResponse,
} from "@inkshadow/contracts";
import type {
  CommitSyncSnapshotCommand,
  DiscardSyncSnapshotCommand,
  StageSyncSnapshotPageCommand,
  SyncRemoteCheckpoint,
  SyncSnapshotStagingSummary,
} from "@inkshadow/data/sync-sqlite-store";
import { ok, type Clock } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import {
  CloudSyncBootstrapCoordinator,
  type CloudSyncBootstrapApi,
  type CloudSyncBootstrapLimits,
  type CloudSyncBootstrapSession,
} from "./cloud-sync-bootstrap-coordinator";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const SNAPSHOT_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const OTHER_SNAPSHOT_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const FIRST_OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const SECOND_OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const FIRST_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000008";
const SECOND_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000009";
const NOW = "2026-07-28T00:00:00.000Z";
const EXPIRES_AT = "2026-07-28T01:00:00.000Z";
const OTHER_EXPIRES_AT = "2026-07-28T02:00:00.000Z";
const RETAIN_UNTIL = "2027-07-29T00:00:00.000Z";
const LOCAL_CURSOR = "signed_local_cursor";
const SNAPSHOT_REMOTE_CURSOR = "signed_snapshot_remote_cursor";

describe("CloudSyncBootstrapCoordinator", () => {
  it("is opt-in and performs no local or cloud work by default", async () => {
    const fixture = createFixture();

    await expect(fixture.coordinator.runProjectBootstrap(PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      state: "disabled",
      pushAllowed: false,
      plaintextMaterializationRequired: false,
      pagesFetched: 0,
    });
    expect(fixture.store.readCheckpointCalls).toBe(0);
    expect(fixture.api.getProjectState).not.toHaveBeenCalled();
    expect(fixture.api.getSyncSnapshot).not.toHaveBeenCalled();
  });

  it("routes an accepted cursor to incremental plaintext intake without opening push", async () => {
    const fixture = createFixture({ enabled: true });

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID);

    expect(fixture.api.getProjectState).toHaveBeenCalledWith(PROJECT_ID, {
      cursor: LOCAL_CURSOR,
    });
    expect(fixture.api.getSyncSnapshot).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      state: "incremental_available",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
      checkpoint: { signedRemoteCursor: LOCAL_CURSOR },
    });
  });

  it.each([
    ["CLOUD_NETWORK_UNAVAILABLE", true, "offline"],
    ["SERVICE_UNAVAILABLE", true, "retryable"],
    ["ACCESS_FORBIDDEN", false, "auth_blocked"],
    ["VALIDATION_FAILED", false, "permanent_paused"],
  ] as const)(
    "classifies %s as %s without opening push",
    async (code, retryable, expectedState) => {
      const fixture = createFixture({ enabled: true });
      fixture.api.getProjectState.mockRejectedValue(cloudError(code, retryable));

      await expect(fixture.coordinator.runProjectBootstrap(PROJECT_ID)).resolves.toMatchObject({
        state: expectedState,
        pushAllowed: false,
        plaintextMaterializationRequired: false,
        failure: { category: expectedState, code },
      });
    },
  );

  it("discards stale incomplete staging before entering incremental plaintext intake", async () => {
    const fixture = createFixture({ enabled: true });
    fixture.store.staging = stagedSummary();

    await expect(fixture.coordinator.runProjectBootstrap(PROJECT_ID)).resolves.toMatchObject({
      state: "incremental_available",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
    });
    expect(fixture.store.discardCommands).toEqual([
      { snapshotId: SNAPSHOT_ID, projectId: PROJECT_ID, epoch: 7 },
    ]);
    expect(fixture.store.staging).toBeNull();
  });

  it("stages an exact multi-page ciphertext snapshot and atomically commits its fixed remote cursor", async () => {
    const fixture = createFixture({ enabled: true });
    requireSnapshotBootstrap(fixture.api);
    fixture.api.getSyncSnapshot
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: SNAPSHOT_ID,
          operationIndex: 0,
          nextSnapshotCursor: "snapshot_page_1",
        }),
      )
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: SNAPSHOT_ID,
          operationIndex: 1,
          nextSnapshotCursor: null,
        }),
      );

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID);

    expect(fixture.api.getSyncSnapshot).toHaveBeenNthCalledWith(1, PROJECT_ID, {
      cursor: null,
      limit: 128,
    });
    expect(fixture.api.getSyncSnapshot).toHaveBeenNthCalledWith(2, PROJECT_ID, {
      cursor: "snapshot_page_1",
      limit: 128,
    });
    expect(fixture.store.stageCommands).toHaveLength(2);
    expect(fixture.store.stageCommands[0]).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      epoch: 1,
      pageIndex: 0,
      resumeCursor: null,
      snapshotExpiresAt: EXPIRES_AT,
      snapshotSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
      nextSnapshotCursor: "snapshot_page_1",
      finalSignedRemoteCursor: null,
    });
    expect(fixture.store.stageCommands[1]).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      epoch: 1,
      pageIndex: 1,
      resumeCursor: "snapshot_page_1",
      snapshotExpiresAt: EXPIRES_AT,
      snapshotSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
      nextSnapshotCursor: null,
      finalSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
    });
    expect(fixture.store.events).toEqual(["stage:0", "stage:1", "commit"]);
    expect(outcome).toMatchObject({
      state: "ciphertext_baseline_committed",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
      pagesFetched: 2,
      checkpoint: { signedRemoteCursor: SNAPSHOT_REMOTE_CURSOR, revision: 4 },
    });
  });

  it("resumes the exact persisted snapshot identity, expiry, cursor, page, and epoch", async () => {
    const fixture = createFixture({ enabled: true });
    fixture.store.staging = stagedSummary();
    requireSnapshotBootstrap(fixture.api);
    fixture.api.getSyncSnapshot.mockResolvedValue(
      snapshotPage({
        snapshotId: SNAPSHOT_ID,
        operationIndex: 1,
        nextSnapshotCursor: null,
      }),
    );

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID);

    expect(fixture.api.getSyncSnapshot).toHaveBeenCalledWith(PROJECT_ID, {
      cursor: "snapshot_page_1",
      limit: 128,
    });
    expect(fixture.store.stageCommands).toHaveLength(1);
    expect(fixture.store.stageCommands[0]).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      epoch: 7,
      pageIndex: 1,
      resumeCursor: "snapshot_page_1",
      snapshotExpiresAt: EXPIRES_AT,
      snapshotSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
    });
    expect(fixture.store.discardCommands).toHaveLength(0);
    expect(outcome).toMatchObject({
      state: "ciphertext_baseline_committed",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
    });
  });

  it.each(["snapshotId", "snapshotExpiresAt", "resumeCursor"] as const)(
    "fails closed when the fixed snapshot %s changes between pages",
    async (field) => {
      const fixture = createFixture({ enabled: true });
      requireSnapshotBootstrap(fixture.api);
      const changed = snapshotPage({
        snapshotId: SNAPSHOT_ID,
        operationIndex: 1,
        nextSnapshotCursor: null,
      });
      const invalid: CloudSyncSnapshotResponse =
        field === "snapshotId"
          ? { ...changed, snapshotId: OTHER_SNAPSHOT_ID }
          : field === "snapshotExpiresAt"
            ? { ...changed, snapshotExpiresAt: OTHER_EXPIRES_AT }
            : { ...changed, resumeCursor: "changed_snapshot_remote_cursor" };
      fixture.api.getSyncSnapshot
        .mockResolvedValueOnce(
          snapshotPage({
            snapshotId: SNAPSHOT_ID,
            operationIndex: 0,
            nextSnapshotCursor: "snapshot_page_1",
          }),
        )
        .mockResolvedValueOnce(invalid);

      await expect(fixture.coordinator.runProjectBootstrap(PROJECT_ID)).resolves.toMatchObject({
        state: "permanent_paused",
        pushAllowed: false,
        failure: {
          category: "permanent_paused",
          code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
        },
      });
      expect(fixture.store.stageCommands).toHaveLength(1);
      expect(fixture.store.commitCommands).toHaveLength(0);
    },
  );

  it("discards an expired partial snapshot and restarts from page zero with a new local epoch", async () => {
    const fixture = createFixture({ enabled: true });
    requireSnapshotBootstrap(fixture.api);
    fixture.api.getSyncSnapshot
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: SNAPSHOT_ID,
          operationIndex: 0,
          nextSnapshotCursor: "old_snapshot_page_1",
        }),
      )
      .mockRejectedValueOnce(cloudError("SYNC_CURSOR_EXPIRED"))
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: OTHER_SNAPSHOT_ID,
          operationIndex: 1,
          nextSnapshotCursor: null,
          resumeCursor: "new_snapshot_remote_cursor",
        }),
      );

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID);

    expect(fixture.api.getProjectState).toHaveBeenCalledTimes(3);
    expect(fixture.store.discardCommands).toEqual([
      { snapshotId: SNAPSHOT_ID, projectId: PROJECT_ID, epoch: 1 },
    ]);
    expect(fixture.store.stageCommands).toMatchObject([
      { snapshotId: SNAPSHOT_ID, epoch: 1, pageIndex: 0, resumeCursor: null },
      { snapshotId: OTHER_SNAPSHOT_ID, epoch: 2, pageIndex: 0, resumeCursor: null },
    ]);
    expect(outcome).toMatchObject({
      state: "ciphertext_baseline_committed",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
      pagesFetched: 2,
      restarts: 1,
      checkpoint: { signedRemoteCursor: "new_snapshot_remote_cursor" },
    });
  });

  it("restarts instead of committing when the final snapshot high-water cursor fails preflight", async () => {
    const fixture = createFixture({ enabled: true });
    fixture.api.getProjectState.mockImplementation((_projectId, options) =>
      Promise.resolve(
        projectState(
          options?.cursor === "new_snapshot_remote_cursor"
            ? "incremental_available"
            : "snapshot_required",
        ),
      ),
    );
    fixture.api.getSyncSnapshot
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: SNAPSHOT_ID,
          operationIndex: 0,
          nextSnapshotCursor: null,
        }),
      )
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: OTHER_SNAPSHOT_ID,
          operationIndex: 1,
          nextSnapshotCursor: null,
          resumeCursor: "new_snapshot_remote_cursor",
        }),
      );

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID);

    expect(fixture.api.getProjectState).toHaveBeenCalledTimes(4);
    expect(fixture.api.getProjectState).toHaveBeenNthCalledWith(2, PROJECT_ID, {
      cursor: SNAPSHOT_REMOTE_CURSOR,
    });
    expect(fixture.store.discardCommands).toEqual([
      { snapshotId: SNAPSHOT_ID, projectId: PROJECT_ID, epoch: 1 },
    ]);
    expect(fixture.store.stageCommands).toMatchObject([
      { snapshotId: SNAPSHOT_ID, epoch: 1, pageIndex: 0 },
      { snapshotId: OTHER_SNAPSHOT_ID, epoch: 2, pageIndex: 0 },
    ]);
    expect(fixture.store.commitCommands).toHaveLength(1);
    expect(outcome).toMatchObject({
      state: "ciphertext_baseline_committed",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
      restarts: 1,
    });
  });

  it("uses the persisted expiry to discard an expired resumed snapshot before making another page request", async () => {
    const fixture = createFixture({ enabled: true });
    fixture.store.staging = stagedSummary({ snapshotExpiresAt: NOW });
    requireSnapshotBootstrap(fixture.api);
    fixture.api.getSyncSnapshot.mockResolvedValue(
      snapshotPage({
        snapshotId: OTHER_SNAPSHOT_ID,
        operationIndex: 1,
        nextSnapshotCursor: null,
        resumeCursor: "new_snapshot_remote_cursor",
      }),
    );

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID);

    expect(fixture.store.discardCommands).toEqual([
      { snapshotId: SNAPSHOT_ID, projectId: PROJECT_ID, epoch: 7 },
    ]);
    expect(fixture.api.getSyncSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.api.getSyncSnapshot).toHaveBeenCalledWith(PROJECT_ID, {
      cursor: null,
      limit: 128,
    });
    expect(fixture.store.stageCommands[0]).toMatchObject({
      snapshotId: OTHER_SNAPSHOT_ID,
      epoch: 8,
      pageIndex: 0,
    });
    expect(outcome.restarts).toBe(1);
  });

  it("returns an incomplete fail-closed result after bounded cursor-expiry restarts", async () => {
    const fixture = createFixture({
      enabled: true,
      limits: { maximumRestarts: 1 },
    });
    requireSnapshotBootstrap(fixture.api);
    fixture.api.getSyncSnapshot
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: SNAPSHOT_ID,
          operationIndex: 0,
          nextSnapshotCursor: "old_snapshot_page_1",
        }),
      )
      .mockRejectedValueOnce(cloudError("SYNC_CURSOR_EXPIRED"))
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: OTHER_SNAPSHOT_ID,
          operationIndex: 1,
          nextSnapshotCursor: "new_snapshot_page_1",
        }),
      )
      .mockRejectedValueOnce(cloudError("SYNC_CURSOR_EXPIRED"));

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID);

    expect(fixture.store.discardCommands.map((command) => command.epoch)).toEqual([1, 2]);
    expect(outcome).toMatchObject({
      state: "ciphertext_bootstrap_incomplete",
      pushAllowed: false,
      plaintextMaterializationRequired: false,
      pagesFetched: 2,
      restarts: 2,
      failure: {
        category: "bootstrap_incomplete",
        code: "SYNC_CURSOR_EXPIRED",
      },
      checkpoint: { signedRemoteCursor: LOCAL_CURSOR },
    });
  });

  it("leaves a resumable staged snapshot and forbids push when the page budget is reached", async () => {
    const fixture = createFixture({
      enabled: true,
      limits: { maximumPages: 1 },
    });
    requireSnapshotBootstrap(fixture.api);
    fixture.api.getSyncSnapshot.mockResolvedValue(
      snapshotPage({
        snapshotId: SNAPSHOT_ID,
        operationIndex: 0,
        nextSnapshotCursor: "snapshot_page_1",
      }),
    );

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID);

    expect(outcome).toMatchObject({
      state: "ciphertext_bootstrap_incomplete",
      pushAllowed: false,
      plaintextMaterializationRequired: false,
      pagesFetched: 1,
      failure: {
        category: "bootstrap_incomplete",
        code: "SYNC_SNAPSHOT_PAGE_LIMIT_REACHED",
      },
    });
    expect(fixture.store.staging).toMatchObject({
      state: "staging",
      nextPageIndex: 1,
      nextSnapshotCursor: "snapshot_page_1",
    });
    expect(fixture.store.commitCommands).toHaveLength(0);
  });

  it("commits an already complete staged baseline without downloading another page", async () => {
    const fixture = createFixture({ enabled: true });
    fixture.store.staging = stagedSummary({
      pagesComplete: true,
      nextPageIndex: 2,
      nextSnapshotCursor: null,
      finalSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
    });
    requireSnapshotBootstrap(fixture.api);

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID);

    expect(fixture.api.getSyncSnapshot).not.toHaveBeenCalled();
    expect(fixture.store.commitCommands).toHaveLength(1);
    expect(outcome).toMatchObject({
      state: "ciphertext_baseline_committed",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
      pagesFetched: 0,
    });
  });

  it("keeps push blocked when an earlier ciphertext baseline has no materialization proof", async () => {
    const fixture = createFixture({ enabled: true });
    fixture.store.checkpoint = {
      projectId: PROJECT_ID,
      signedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
      revision: 4,
      updatedAt: NOW,
    };
    fixture.store.staging = stagedSummary({
      state: "committed",
      pagesComplete: true,
      nextPageIndex: 2,
      nextSnapshotCursor: null,
      finalSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
      committedCheckpointRevision: 4,
      committedAt: NOW,
    });

    await expect(fixture.coordinator.runProjectBootstrap(PROJECT_ID)).resolves.toMatchObject({
      state: "ciphertext_baseline_committed",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
    });
    expect(fixture.api.getSyncSnapshot).not.toHaveBeenCalled();
  });

  it("preserves incomplete staging when the caller aborts", async () => {
    const controller = new AbortController();
    const fixture = createFixture({ enabled: true });
    fixture.store.staging = stagedSummary();
    requireSnapshotBootstrap(fixture.api);
    fixture.api.getSyncSnapshot.mockImplementation(() => {
      controller.abort();
      return Promise.reject(cloudError("CLOUD_REQUEST_ABORTED"));
    });

    const outcome = await fixture.coordinator.runProjectBootstrap(PROJECT_ID, {
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({
      state: "aborted",
      pushAllowed: false,
      failure: null,
    });
    expect(fixture.store.discardCommands).toHaveLength(0);
    expect(fixture.store.staging).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      state: "staging",
    });
  });

  it("does not persist a snapshot response when disable cancellation wins at the response boundary", async () => {
    const controller = new AbortController();
    const fixture = createFixture({ enabled: true });
    requireSnapshotBootstrap(fixture.api);
    fixture.api.getSyncSnapshot.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(
        snapshotPage({
          snapshotId: SNAPSHOT_ID,
          operationIndex: 0,
          nextSnapshotCursor: "snapshot_page_1",
        }),
      );
    });

    await expect(
      fixture.coordinator.runProjectBootstrap(PROJECT_ID, { signal: controller.signal }),
    ).resolves.toMatchObject({ state: "aborted", pagesFetched: 1 });
    expect(fixture.store.stageCommands).toHaveLength(0);
    expect(fixture.store.commitCommands).toHaveLength(0);
    expect(fixture.api.getSyncSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not request or persist page two after disable cancels a staged first page", async () => {
    const controller = new AbortController();
    const fixture = createFixture({ enabled: true });
    requireSnapshotBootstrap(fixture.api);
    fixture.api.getSyncSnapshot
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: SNAPSHOT_ID,
          operationIndex: 0,
          nextSnapshotCursor: "snapshot_page_1",
        }),
      )
      .mockResolvedValueOnce(
        snapshotPage({
          snapshotId: SNAPSHOT_ID,
          operationIndex: 1,
          nextSnapshotCursor: null,
          resumeCursor: SNAPSHOT_REMOTE_CURSOR,
        }),
      );
    fixture.store.afterStage = () => controller.abort();

    await expect(
      fixture.coordinator.runProjectBootstrap(PROJECT_ID, { signal: controller.signal }),
    ).resolves.toMatchObject({ state: "aborted", pagesFetched: 1 });
    expect(fixture.api.getSyncSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.store.stageCommands).toHaveLength(1);
    expect(fixture.store.commitCommands).toHaveLength(0);
    expect(fixture.store.staging).toMatchObject({
      state: "staging",
      nextPageIndex: 1,
      nextSnapshotCursor: "snapshot_page_1",
    });
  });
});

interface FixtureOptions {
  readonly enabled?: boolean;
  readonly limits?: CloudSyncBootstrapLimits;
}

function createFixture(options: FixtureOptions = {}) {
  const store = new MemoryBootstrapStore();
  const api = {
    getProjectState: vi.fn<CloudSyncBootstrapApi["getProjectState"]>(),
    getSyncSnapshot: vi.fn<CloudSyncBootstrapApi["getSyncSnapshot"]>(),
  };
  api.getProjectState.mockResolvedValue(projectState("incremental_available"));
  const session = {
    runWithSession: vi.fn(async (operation: () => Promise<unknown>) => operation()),
  } as unknown as CloudSyncBootstrapSession;
  const clock = { now: vi.fn().mockReturnValue(NOW) } as unknown as Clock;
  const coordinator = new CloudSyncBootstrapCoordinator({
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    api,
    session,
    store,
    clock,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { coordinator, api, session, store, clock };
}

function requireSnapshotBootstrap(api: CloudSyncBootstrapApi): void {
  vi.mocked(api.getProjectState).mockImplementation((_projectId, options) =>
    Promise.resolve(
      projectState(
        options?.cursor === LOCAL_CURSOR ? "snapshot_required" : "incremental_available",
      ),
    ),
  );
}

class MemoryBootstrapStore {
  public checkpoint: SyncRemoteCheckpoint = {
    projectId: PROJECT_ID,
    signedRemoteCursor: LOCAL_CURSOR,
    revision: 3,
    updatedAt: NOW,
  };
  public staging: SyncSnapshotStagingSummary | null = null;
  public readonly stageCommands: StageSyncSnapshotPageCommand[] = [];
  public readonly commitCommands: CommitSyncSnapshotCommand[] = [];
  public readonly discardCommands: DiscardSyncSnapshotCommand[] = [];
  public readonly events: string[] = [];
  public afterStage: (() => void) | null = null;
  public readCheckpointCalls = 0;

  public readRemoteCheckpoint() {
    this.readCheckpointCalls += 1;
    return Promise.resolve(ok(this.checkpoint));
  }

  public readStagedSyncSnapshot() {
    return Promise.resolve(ok(this.staging));
  }

  public stageSyncSnapshotPage(command: StageSyncSnapshotPageCommand) {
    this.stageCommands.push(command);
    this.events.push(`stage:${String(command.pageIndex)}`);
    const existing =
      this.staging?.state === "staging" && this.staging.snapshotId === command.snapshotId
        ? this.staging
        : null;
    const snapshot: SyncSnapshotStagingSummary = {
      snapshotId: command.snapshotId,
      projectId: command.projectId,
      epoch: command.epoch,
      state: "staging",
      baseCheckpoint: existing?.baseCheckpoint ?? this.checkpoint,
      snapshotExpiresAt: command.snapshotExpiresAt,
      snapshotSignedRemoteCursor: command.snapshotSignedRemoteCursor,
      nextPageIndex: command.pageIndex + 1,
      nextSnapshotCursor: command.nextSnapshotCursor,
      pagesComplete: command.nextSnapshotCursor === null,
      finalSignedRemoteCursor: command.finalSignedRemoteCursor,
      operationCount: (existing?.operationCount ?? 0) + command.operations.length,
      chunkCount: (existing?.chunkCount ?? 0) + command.chunks.length,
      tombstoneCount: (existing?.tombstoneCount ?? 0) + command.tombstones.length,
      committedCheckpointRevision: null,
      createdAt: existing?.createdAt ?? command.receivedAt,
      updatedAt: command.receivedAt,
      committedAt: null,
    };
    this.staging = snapshot;
    this.afterStage?.();
    return Promise.resolve(
      ok({
        created: true,
        pageIndex: command.pageIndex,
        pageDigest: "a".repeat(64),
        snapshot,
      }),
    );
  }

  public commitStagedSyncSnapshot(command: CommitSyncSnapshotCommand) {
    this.commitCommands.push(command);
    this.events.push("commit");
    const staged = this.staging;
    if (staged === null) {
      throw new Error("snapshot staging missing");
    }
    const checkpoint: SyncRemoteCheckpoint = {
      projectId: command.projectId,
      signedRemoteCursor: staged.snapshotSignedRemoteCursor,
      revision: staged.baseCheckpoint.revision + 1,
      updatedAt: command.now,
    };
    this.checkpoint = checkpoint;
    this.staging = {
      ...staged,
      state: "committed",
      committedCheckpointRevision: checkpoint.revision,
      updatedAt: command.now,
      committedAt: command.now,
    };
    return Promise.resolve(
      ok({
        snapshotId: command.snapshotId,
        projectId: command.projectId,
        epoch: command.epoch,
        operationCount: staged.operationCount,
        chunkCount: staged.chunkCount,
        tombstoneCount: staged.tombstoneCount,
        checkpoint,
        replayed: false,
      }),
    );
  }

  public discardStagedSyncSnapshot(command: DiscardSyncSnapshotCommand) {
    this.discardCommands.push(command);
    const discarded =
      this.staging?.state === "staging" &&
      this.staging.snapshotId === command.snapshotId &&
      this.staging.epoch === command.epoch;
    if (discarded) {
      this.staging = null;
    }
    return Promise.resolve(ok({ snapshotId: command.snapshotId, discarded }));
  }
}

function projectState(
  cursorStatus: "incremental_available" | "snapshot_required",
): CloudProjectStateResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    project: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      currentKeyVersion: 1,
      serverRevision: 1,
      currentKeyPublication: {
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 1,
        publicationRequestSha256: "a".repeat(64),
        publishedAt: NOW,
      },
      updatedAt: NOW,
      sync: {
        headCursor: SNAPSHOT_REMOTE_CURSOR,
        minimumAvailableCursor: "minimum_available_cursor",
        cursorStatus,
      },
    },
  };
}

interface SnapshotPageOptions {
  readonly snapshotId: string;
  readonly operationIndex: 0 | 1;
  readonly nextSnapshotCursor: string | null;
  readonly resumeCursor?: string;
}

function snapshotPage(options: SnapshotPageOptions): CloudSyncSnapshotResponse {
  const operationId = options.operationIndex === 0 ? FIRST_OPERATION_ID : SECOND_OPERATION_ID;
  const objectId = options.operationIndex === 0 ? FIRST_OBJECT_ID : SECOND_OBJECT_ID;
  const sequence = options.operationIndex + 1;
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    projectId: PROJECT_ID,
    snapshotId: options.snapshotId,
    snapshotExpiresAt: EXPIRES_AT,
    operations: [
      {
        schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
        operationId,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        deviceSequence: sequence,
        objectType: "chapter_version",
        objectId,
        objectGeneration: 1,
        kind: "delete",
        vector: { [DEVICE_ID]: sequence },
        encryptedChunkIds: [],
        createdAt: NOW,
      },
    ],
    chunks: [],
    tombstones: [
      {
        schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
        projectId: PROJECT_ID,
        objectType: "chapter_version",
        objectId,
        objectGeneration: 1,
        deletedByDeviceId: DEVICE_ID,
        vector: { [DEVICE_ID]: sequence },
        deletedAt: NOW,
        retainUntil: RETAIN_UNTIL,
        acknowledgedDeviceIds: [],
      },
    ],
    resumeCursor: options.resumeCursor ?? SNAPSHOT_REMOTE_CURSOR,
    nextSnapshotCursor: options.nextSnapshotCursor,
    hasMore: options.nextSnapshotCursor !== null,
  };
}

interface StagedSummaryOptions {
  readonly state?: "staging" | "committed";
  readonly snapshotExpiresAt?: string;
  readonly pagesComplete?: boolean;
  readonly nextPageIndex?: number;
  readonly nextSnapshotCursor?: string | null;
  readonly finalSignedRemoteCursor?: string | null;
  readonly committedCheckpointRevision?: number | null;
  readonly committedAt?: string | null;
}

function stagedSummary(options: StagedSummaryOptions = {}): SyncSnapshotStagingSummary {
  return {
    snapshotId: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    epoch: 7,
    state: options.state ?? "staging",
    baseCheckpoint: {
      projectId: PROJECT_ID,
      signedRemoteCursor: LOCAL_CURSOR,
      revision: 3,
      updatedAt: NOW,
    },
    snapshotExpiresAt: options.snapshotExpiresAt ?? EXPIRES_AT,
    snapshotSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
    nextPageIndex: options.nextPageIndex ?? 1,
    nextSnapshotCursor:
      options.nextSnapshotCursor === undefined ? "snapshot_page_1" : options.nextSnapshotCursor,
    pagesComplete: options.pagesComplete ?? false,
    finalSignedRemoteCursor: options.finalSignedRemoteCursor ?? null,
    operationCount: 1,
    chunkCount: 0,
    tombstoneCount: 1,
    committedCheckpointRevision: options.committedCheckpointRevision ?? null,
    createdAt: NOW,
    updatedAt: NOW,
    committedAt: options.committedAt ?? null,
  };
}

type TestCloudErrorCode =
  | "ACCESS_FORBIDDEN"
  | "CLOUD_NETWORK_UNAVAILABLE"
  | "CLOUD_REQUEST_ABORTED"
  | "SERVICE_UNAVAILABLE"
  | "SYNC_CURSOR_EXPIRED"
  | "VALIDATION_FAILED";

function cloudError(code: TestCloudErrorCode, retryable = true): CloudClientError {
  return new CloudClientError({
    code,
    message: code,
    status: code === "SYNC_CURSOR_EXPIRED" ? 409 : null,
    requestId: REQUEST_ID,
    retryable,
  });
}
