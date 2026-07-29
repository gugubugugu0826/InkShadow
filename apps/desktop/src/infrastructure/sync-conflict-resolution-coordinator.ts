import type { SyncContentConflict } from "@inkshadow/data";
import type { Clock, UuidV7Generator } from "@inkshadow/domain";

export type SyncConflictResolutionAction =
  "accept_local" | "accept_remote" | "keep_both" | "manual_merge";

export interface SyncConflictListItem {
  readonly conflictId: string;
  readonly projectId: string;
  readonly objectType: SyncContentConflict["objectType"];
  readonly objectId: string;
  readonly remoteKind: "upsert" | "delete";
  readonly remoteDeviceId: string | null;
  readonly createdAt: string;
}

export interface SyncConflictChapterBranch {
  readonly chapterId: string;
  readonly title: string;
  readonly content: string;
  readonly versionId: string;
  readonly revision: number;
  readonly contentChecksum: string;
  readonly updatedAt: string;
  readonly deviceId: string | null;
}

export interface SyncConflictBaseVersion {
  readonly versionId: string;
  readonly content: string;
  readonly contentChecksum: string;
}

export type SyncConflictReviewSourceResult =
  | Readonly<{
      status: "ready";
      conflict: Extract<SyncContentConflict, { status: "unresolved"; remoteKind: "upsert" }>;
      local: SyncConflictChapterBranch;
      remote: SyncConflictChapterBranch;
      base: SyncConflictBaseVersion | null;
    }>
  | Readonly<{
      status: "remote_delete";
      conflict: Extract<SyncContentConflict, { status: "unresolved"; remoteKind: "delete" }>;
      local: SyncConflictChapterBranch | null;
    }>
  | Readonly<{
      status: "unsupported";
      conflict: Extract<SyncContentConflict, { status: "unresolved" }>;
      reasonCode: string;
    }>;

export interface SyncConflictReviewSource {
  listUnresolved(projectId: string): Promise<readonly SyncConflictListItem[]>;
  loadReview(conflictId: string): Promise<SyncConflictReviewSourceResult>;
}

export interface ReadySyncConflictReview extends Omit<
  Extract<SyncConflictReviewSourceResult, { status: "ready" }>,
  "status"
> {
  readonly status: "ready";
  readonly reviewToken: string;
}

export type SyncConflictReview =
  | ReadySyncConflictReview
  | Extract<SyncConflictReviewSourceResult, { status: "remote_delete" | "unsupported" }>;

export interface CommitSyncChapterConflictResolutionInput {
  readonly conflictId: string;
  readonly expectedConflictRevision: number;
  readonly expectedRemoteOperationId: string;
  readonly expectedRemotePayloadSha256: string;
  readonly expectedLocalVersionId: string;
  readonly expectedLocalRevision: number;
  readonly expectedLocalContentChecksum: string;
  readonly action: SyncConflictResolutionAction;
  readonly selectedTitle: string;
  readonly selectedContent: string;
  readonly selectedContentChecksum: string;
  readonly stableVersionId: string;
  readonly projectionJobId: string;
  readonly keptRemoteChapterId: string | null;
  readonly keptRemoteVersionId: string | null;
  readonly keptRemoteProjectionJobId: string | null;
  readonly keptRemoteTitle: string | null;
  readonly keptRemoteContent: string | null;
  readonly keptRemoteContentChecksum: string | null;
  readonly confirmedAt: string;
}

export interface SyncConflictResolutionReceipt {
  readonly conflictId: string;
  readonly action: SyncConflictResolutionAction;
  readonly stableVersionId: string;
  readonly projectionJobId: string;
  readonly keptRemoteChapterId: string | null;
  readonly keptRemoteVersionId: string | null;
  readonly replayed: boolean;
}

export interface SyncConflictResolutionCommitter {
  commitChapterResolution(
    input: CommitSyncChapterConflictResolutionInput,
  ): Promise<SyncConflictResolutionReceipt>;
}

export interface ResolveSyncConflictCommand {
  readonly conflictId: string;
  readonly reviewToken: string;
  readonly action: SyncConflictResolutionAction;
  readonly confirmed: boolean;
  readonly mergedTitle?: string;
  readonly mergedContent?: string;
}

export interface SyncConflictResolutionCoordinatorDependencies {
  readonly source: SyncConflictReviewSource;
  readonly committer: SyncConflictResolutionCommitter;
  readonly ids: Pick<UuidV7Generator, "next">;
  readonly clock: Pick<Clock, "now">;
  readonly cryptoProvider?: Crypto;
}

/**
 * Keeps remote plaintext in caller memory only. A stale or unconfirmed review
 * cannot mutate the chapter, and every accepted path creates a new stable
 * version through one atomic committer.
 */
export class SyncConflictResolutionCoordinator {
  private readonly cryptoProvider: Crypto;

  public constructor(private readonly dependencies: SyncConflictResolutionCoordinatorDependencies) {
    this.cryptoProvider = dependencies.cryptoProvider ?? globalThis.crypto;
  }

  public listUnresolved(projectId: string): Promise<readonly SyncConflictListItem[]> {
    return this.dependencies.source.listUnresolved(projectId);
  }

  public async loadReview(conflictId: string): Promise<SyncConflictReview> {
    const loaded = await this.dependencies.source.loadReview(conflictId);
    if (loaded.status !== "ready") {
      return loaded;
    }
    return Object.freeze({
      ...loaded,
      reviewToken: await createReviewToken(loaded, this.cryptoProvider),
    });
  }

  public async resolve(
    command: ResolveSyncConflictCommand,
  ): Promise<SyncConflictResolutionReceipt> {
    if (!command.confirmed) {
      throw resolutionError(
        "SYNC_CONFLICT_CONFIRMATION_REQUIRED",
        "Conflict resolution requires explicit user confirmation.",
      );
    }
    const current = await this.dependencies.source.loadReview(command.conflictId);
    if (current.status !== "ready") {
      throw resolutionError(
        current.status === "remote_delete"
          ? "SYNC_DELETE_CONFLICT_REQUIRES_SEPARATE_REVIEW"
          : current.reasonCode,
        "This conflict cannot be resolved by the chapter merge workflow.",
      );
    }
    const expectedToken = await createReviewToken(current, this.cryptoProvider);
    if (!constantTimeEqual(command.reviewToken, expectedToken)) {
      throw resolutionError(
        "SYNC_CONFLICT_REVIEW_STALE",
        "The conflict changed after it was reviewed.",
      );
    }

    const selected = selectResolutionContent(current, command);
    const checksum = await sha256(selected.content, this.cryptoProvider);
    const keepBoth = command.action === "keep_both";
    return this.dependencies.committer.commitChapterResolution({
      conflictId: current.conflict.conflictId,
      expectedConflictRevision: current.conflict.revision,
      expectedRemoteOperationId: current.conflict.remoteOperationId,
      expectedRemotePayloadSha256: current.conflict.remotePayloadSha256,
      expectedLocalVersionId: current.local.versionId,
      expectedLocalRevision: current.local.revision,
      expectedLocalContentChecksum: current.local.contentChecksum,
      action: command.action,
      selectedTitle: selected.title,
      selectedContent: selected.content,
      selectedContentChecksum: checksum,
      stableVersionId: this.dependencies.ids.next(),
      projectionJobId: this.dependencies.ids.next(),
      keptRemoteChapterId: keepBoth ? this.dependencies.ids.next() : null,
      keptRemoteVersionId: keepBoth ? this.dependencies.ids.next() : null,
      keptRemoteProjectionJobId: keepBoth ? this.dependencies.ids.next() : null,
      keptRemoteTitle: keepBoth ? current.remote.title : null,
      keptRemoteContent: keepBoth ? current.remote.content : null,
      keptRemoteContentChecksum: keepBoth ? current.remote.contentChecksum : null,
      confirmedAt: requireTimestamp(this.dependencies.clock.now()),
    });
  }
}

function selectResolutionContent(
  review: Extract<SyncConflictReviewSourceResult, { status: "ready" }>,
  command: ResolveSyncConflictCommand,
): Readonly<{ title: string; content: string }> {
  switch (command.action) {
    case "accept_local":
    case "keep_both":
      return { title: review.local.title, content: review.local.content };
    case "accept_remote":
      return { title: review.remote.title, content: review.remote.content };
    case "manual_merge": {
      if (typeof command.mergedTitle !== "string" || typeof command.mergedContent !== "string") {
        throw resolutionError(
          "SYNC_CONFLICT_MERGED_CONTENT_REQUIRED",
          "Manual merge requires the reviewed title and content.",
        );
      }
      const title = command.mergedTitle.trim();
      if (
        title.length === 0 ||
        title.length > 200 ||
        command.mergedContent.length > 5_000_000 ||
        command.mergedContent.includes("\u0000")
      ) {
        throw resolutionError(
          "SYNC_CONFLICT_MERGED_CONTENT_INVALID",
          "Manual merge content is outside the supported bounds.",
        );
      }
      return { title, content: command.mergedContent };
    }
  }
}

async function createReviewToken(
  review: Extract<SyncConflictReviewSourceResult, { status: "ready" }>,
  cryptoProvider: Crypto,
): Promise<string> {
  return sha256(
    JSON.stringify({
      contract: "inkshadow.sync-conflict-review.v1",
      conflictId: review.conflict.conflictId,
      conflictRevision: review.conflict.revision,
      objectGeneration: review.conflict.objectGeneration,
      localVersionId: review.local.versionId,
      localRevision: review.local.revision,
      localContentChecksum: review.local.contentChecksum,
      remoteOperationId: review.conflict.remoteOperationId,
      remotePayloadSha256: review.conflict.remotePayloadSha256,
      remoteVersionId: review.remote.versionId,
      remoteContentChecksum: review.remote.contentChecksum,
      baseVersionId: review.base?.versionId ?? null,
      baseContentChecksum: review.base?.contentChecksum ?? null,
    }),
    cryptoProvider,
  );
}

async function sha256(value: string, cryptoProvider: Crypto): Promise<string> {
  const digest = await cryptoProvider.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function requireTimestamp(value: string): string {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw resolutionError(
      "SYNC_CONFLICT_CLOCK_INVALID",
      "The conflict clock did not return a canonical UTC timestamp.",
    );
  }
  return value;
}

export class SyncConflictResolutionError extends Error {
  public override readonly name = "SyncConflictResolutionError";

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function resolutionError(code: string, message: string): SyncConflictResolutionError {
  return new SyncConflictResolutionError(code, message);
}
