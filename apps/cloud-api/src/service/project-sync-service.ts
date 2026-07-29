import { createHash, timingSafeEqual } from "node:crypto";

import {
  CloudMutationAcceptedResponseSchema,
  CloudProjectKeyResponseSchema,
  CloudSyncPushResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudMutationAcceptedResponse,
  type CloudProjectKeyPublishRequest,
  type CloudProjectKeyResponse,
  type CloudProjectStateResponse,
  type CloudSyncPullResponse,
  type CloudSyncPushRequest,
  type CloudSyncPushResponse,
  type CloudSyncSnapshotResponse,
  type CloudTombstoneAcknowledgementRequest,
  type DeviceProjectKeyEnvelopeContract,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";

import type {
  CloudProjectAccessRecord,
  CloudProjectKeySetRecord,
  CloudProjectRecord,
  CloudSyncBatchRecord,
  PersistedSyncChunk,
  PersistedSyncOperation,
  PersistedSyncTombstone,
} from "../domain/project-records.js";
import type {
  CloudAuditEventRecord,
  CloudIdempotencyRecord,
  RegisteredDeviceRecord,
} from "../domain/records.js";
import type { CloudProjectStore, CloudProjectTransaction } from "../repository/project-store.js";
import {
  createIdempotencyScopeHash,
  hashCanonicalJson,
  hashUtf8,
} from "../security/canonical-hash.js";
import { InvalidSyncCursorError, type SyncCursorCodec } from "../security/sync-cursor.js";
import {
  InvalidSyncSnapshotCursorError,
  type SyncSnapshotCursor,
  type SyncSnapshotCursorCodec,
} from "../security/sync-snapshot-cursor.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  accessForbidden,
  idempotencyConflict,
  invalidCiphertext,
  resourceNotFound,
  revisionConflict,
  syncCursorExpired,
  syncSequenceConflict,
  validationFailed,
} from "./errors.js";
import type { CloudMutationContext, CloudPrincipal, CloudReadContext } from "./identity-service.js";

export interface CloudProjectSyncServiceOptions {
  readonly clock?: () => Date;
  readonly cursorCodec: SyncCursorCodec;
  readonly idempotencyLifetimeMs?: number;
  readonly snapshotCursorCodec: SyncSnapshotCursorCodec;
  readonly snapshotLifetimeMs?: number;
  readonly store: CloudProjectStore;
  readonly uuid: UuidV7Factory;
}

const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SNAPSHOT_LIFETIME_MS = 15 * 60 * 1_000;
const MAXIMUM_PULL_LIMIT = 256;
const MAXIMUM_PULL_CHUNKS = 10_000;

export class CloudProjectSyncService {
  private readonly clock: () => Date;
  private readonly cursorCodec: SyncCursorCodec;
  private readonly idempotencyLifetimeMs: number;
  private readonly snapshotCursorCodec: SyncSnapshotCursorCodec;
  private readonly snapshotLifetimeMs: number;
  private readonly store: CloudProjectStore;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudProjectSyncServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.cursorCodec = options.cursorCodec;
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.snapshotCursorCodec = options.snapshotCursorCodec;
    this.snapshotLifetimeMs = options.snapshotLifetimeMs ?? DEFAULT_SNAPSHOT_LIFETIME_MS;
    this.store = options.store;
    this.uuid = options.uuid;
    if (!Number.isSafeInteger(this.idempotencyLifetimeMs) || this.idempotencyLifetimeMs <= 0) {
      throw new Error("The cloud idempotency lifetime must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.snapshotLifetimeMs) || this.snapshotLifetimeMs <= 0) {
      throw new Error("The cloud snapshot lifetime must be a positive integer.");
    }
  }

  public async publishProjectKey(
    principal: CloudPrincipal,
    projectId: string,
    keyVersion: number,
    request: CloudProjectKeyPublishRequest,
    context: CloudMutationContext,
  ): Promise<CloudProjectKeyResponse> {
    this.assertKeyRouteIdentity(projectId, keyVersion, request);
    const tenantId = personalTenantId(principal);
    const now = this.now();
    const requestHash = hashCanonicalJson({ projectId, keyVersion, request });
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(tenantId);
      const existingIdempotency = await this.findIdempotency(
        transaction,
        "projectKeys.publish",
        principal.accountId,
        context.idempotencyKey,
        requestHash,
        now,
      );
      if (existingIdempotency !== null) {
        return this.replayProjectKey(existingIdempotency, projectId, keyVersion, context.requestId);
      }

      const devices = await this.validateProjectKeyDevices(
        transaction,
        principal,
        request.deviceEnvelopes,
      );
      let project = await transaction.findProject(tenantId, projectId, true);
      if (project === null) {
        if (request.expectedServerRevision !== null || keyVersion !== 1) {
          throw revisionConflict();
        }
        project = {
          createdAt: now,
          currentKeyVersion: null,
          deletionScheduledFor: null,
          minimumAvailableRemoteSequence: 0n,
          ownerAccountId: principal.accountId,
          projectId,
          revision: 1,
          state: "active",
          syncCompactionEpoch: 0n,
          tenantId,
          updatedAt: now,
        };
        const inserted = await transaction.insertProject(project);
        if (!inserted) {
          throw accessForbidden("The cloud project identity is unavailable.");
        }
        await transaction.insertProjectAccess({
          accountId: principal.accountId,
          canManageKeys: true,
          canSync: true,
          createdAt: now,
          projectId,
          revision: 1,
          revokedAt: null,
          role: "owner",
          tenantId,
        });
      } else {
        if (project.state !== "active") {
          throw resourceNotFound("The cloud project was not found.");
        }
        const access = await this.requireProjectAccess(
          transaction,
          project,
          principal.accountId,
          "manage_keys",
        );
        void access;
        if (
          request.expectedServerRevision === null ||
          request.expectedServerRevision !== project.revision ||
          project.currentKeyVersion === null ||
          keyVersion !== project.currentKeyVersion + 1
        ) {
          throw revisionConflict();
        }
        await transaction.markProjectKeyRetiring(
          tenantId,
          projectId,
          project.currentKeyVersion,
          now,
        );
      }

      const serverRevision =
        project.currentKeyVersion === null ? project.revision : project.revision + 1;
      const keySet: CloudProjectKeySetRecord = {
        deviceEnvelopes: request.deviceEnvelopes,
        keyVersion,
        projectId,
        publication: {
          projectId,
          keyVersion,
          serverRevision,
          publicationRequestSha256: requestHash,
          publishedAt: now.toISOString(),
        },
        recoveryEnvelope: request.recoveryEnvelope,
        serverRevision,
        tenantId,
        updatedAt: now,
        version: request.version,
      };
      await transaction.insertProjectKeySet(keySet);
      project = {
        ...project,
        currentKeyVersion: keyVersion,
        revision: serverRevision,
        updatedAt: now,
      };
      await transaction.updateProject(project);
      const response = toProjectKeyResponse(keySet, context.requestId);
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "projectKeys.publish",
        requestHash,
        response,
        responseStatus: 200,
        resultKind: "project_key",
        resultResourceId: projectId,
      });
      await transaction.insertAuditEvent(
        this.auditEvent({
          action: keyVersion === 1 ? "project_key.created" : "project_key.rotated",
          context,
          now,
          principal,
          redactedDiff: {
            keyVersion,
            recipientDeviceCount: devices.length,
            serverRevision,
          },
          resourceId: projectId,
          resourceType: "cloud_project",
          tenantId,
        }),
      );
      return response;
    });
  }

  public async getProjectKey(
    principal: CloudPrincipal,
    projectId: string,
    keyVersion: number,
    context: CloudReadContext,
  ): Promise<CloudProjectKeyResponse> {
    const tenantId = personalTenantId(principal);
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(tenantId);
      const project = await this.requireProject(transaction, tenantId, projectId);
      await this.requireProjectAccess(transaction, project, principal.accountId, "read_keys");
      await this.requireTrustedCurrentDevice(transaction, principal);
      const keySet = await transaction.findProjectKeySet(tenantId, projectId, keyVersion);
      if (keySet === null) {
        throw resourceNotFound("The project-key version was not found.");
      }
      return toProjectKeyResponse(keySet, context.requestId);
    });
  }

  public async getCurrentProjectKey(
    principal: CloudPrincipal,
    projectId: string,
    context: CloudReadContext,
  ): Promise<CloudProjectKeyResponse> {
    const tenantId = personalTenantId(principal);
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(tenantId);
      const project = await this.requireProject(transaction, tenantId, projectId);
      await this.requireProjectAccess(transaction, project, principal.accountId, "read_keys");
      await this.requireTrustedCurrentDevice(transaction, principal);
      if (project.currentKeyVersion === null) {
        throw resourceNotFound("The current project-key version was not found.");
      }
      const keySet = await transaction.findProjectKeySet(
        tenantId,
        projectId,
        project.currentKeyVersion,
      );
      if (keySet?.serverRevision !== project.revision || keySet.version.state !== "active") {
        throw new Error("The current cloud project key is internally inconsistent.");
      }
      return toProjectKeyResponse(keySet, context.requestId);
    });
  }

  public async getProjectState(
    principal: CloudPrincipal,
    projectId: string,
    cursor: string | null,
    context: CloudReadContext,
  ): Promise<CloudProjectStateResponse> {
    const tenantId = personalTenantId(principal);
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(tenantId);
      const project = await this.requireProject(transaction, tenantId, projectId);
      await this.requireProjectAccess(transaction, project, principal.accountId, "read_keys");
      await this.requireTrustedCurrentDevice(transaction, principal);
      if (project.currentKeyVersion === null) {
        throw resourceNotFound("The current project-key version was not found.");
      }
      const [keySet, maximum] = await Promise.all([
        transaction.findProjectKeySet(tenantId, projectId, project.currentKeyVersion),
        transaction.getMaximumRemoteSequence(tenantId, projectId),
      ]);
      if (keySet?.serverRevision !== project.revision || keySet.version.state !== "active") {
        throw new Error("The current cloud project state is internally inconsistent.");
      }
      let suppliedSequence: bigint | null = cursor === null ? 0n : null;
      if (cursor !== null) {
        try {
          suppliedSequence = this.cursorCodec.decode(cursor, projectId);
        } catch (error) {
          if (!(error instanceof InvalidSyncCursorError)) {
            throw error;
          }
        }
      }
      const incrementalAvailable =
        suppliedSequence !== null &&
        suppliedSequence >= project.minimumAvailableRemoteSequence &&
        suppliedSequence <= maximum;
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        project: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          projectId,
          currentKeyVersion: project.currentKeyVersion,
          serverRevision: project.revision,
          currentKeyPublication: keySet.publication,
          updatedAt: project.updatedAt.toISOString(),
          sync: {
            headCursor: this.cursorCodec.encode(maximum, projectId),
            minimumAvailableCursor: this.cursorCodec.encode(
              project.minimumAvailableRemoteSequence,
              projectId,
            ),
            cursorStatus: incrementalAvailable ? "incremental_available" : "snapshot_required",
          },
        },
      };
    });
  }

  public async getSyncSnapshot(
    principal: CloudPrincipal,
    projectId: string,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudSyncSnapshotResponse> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_PULL_LIMIT) {
      throw validationFailed("The sync snapshot limit is invalid.");
    }
    const tenantId = personalTenantId(principal);
    const now = this.now();
    let suppliedCursor: SyncSnapshotCursor | null = null;
    if (cursor !== null) {
      try {
        suppliedCursor = this.snapshotCursorCodec.decode(cursor, projectId, now);
      } catch (error) {
        if (error instanceof InvalidSyncSnapshotCursorError) {
          throw syncCursorExpired();
        }
        throw error;
      }
    }
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(tenantId);
      const project = await transaction.findProjectForSnapshot(tenantId, projectId);
      if (project?.state !== "active") {
        throw resourceNotFound("The cloud project was not found.");
      }
      await this.requireProjectAccess(transaction, project, principal.accountId, "sync");
      await this.requireTrustedCurrentDevice(transaction, principal);

      const snapshot =
        suppliedCursor ??
        ({
          projectId,
          snapshotId: this.uuid(),
          highWaterSequence: await transaction.getMaximumRemoteSequence(tenantId, projectId),
          afterSequence: 0n,
          compactionEpoch: project.syncCompactionEpoch,
          minimumAvailableSequence: project.minimumAvailableRemoteSequence,
          expiresAt: new Date(now.getTime() + this.snapshotLifetimeMs),
        } satisfies SyncSnapshotCursor);
      if (
        snapshot.compactionEpoch !== project.syncCompactionEpoch ||
        snapshot.minimumAvailableSequence !== project.minimumAvailableRemoteSequence
      ) {
        throw syncCursorExpired();
      }

      const candidates = await transaction.listCompleteSyncOperations(
        tenantId,
        projectId,
        snapshot.afterSequence,
        snapshot.highWaterSequence,
        limit + 1,
      );
      const page = takeSyncOperationPage(candidates, limit);
      const operationIds = page.map((item) => item.operation.operationId);
      const [chunks, tombstones] = await Promise.all([
        transaction.findSyncChunksForOperations(tenantId, projectId, operationIds),
        transaction.findSyncTombstonesForOperations(tenantId, projectId, operationIds),
      ]);
      assertCompleteSyncPayload(projectId, page, chunks, tombstones);
      const hasMore = page.length < candidates.length;
      const nextAfterSequence = page.at(-1)?.remoteSequence ?? snapshot.afterSequence;
      if (hasMore && nextAfterSequence <= snapshot.afterSequence) {
        throw new Error("The cloud sync snapshot did not make forward progress.");
      }
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        projectId,
        snapshotId: snapshot.snapshotId,
        snapshotExpiresAt: snapshot.expiresAt.toISOString(),
        operations: page.map((item) => item.operation),
        chunks: chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          encrypted: chunk.encrypted,
        })),
        tombstones: tombstones.map((item) => item.tombstone),
        resumeCursor: this.cursorCodec.encode(snapshot.highWaterSequence, projectId),
        nextSnapshotCursor: hasMore
          ? this.snapshotCursorCodec.encode({
              ...snapshot,
              afterSequence: nextAfterSequence,
            })
          : null,
        hasMore,
      };
    });
  }

  public async pushSync(
    principal: CloudPrincipal,
    projectId: string,
    request: CloudSyncPushRequest,
    context: CloudMutationContext,
  ): Promise<CloudSyncPushResponse> {
    this.assertSyncProjectIdentity(principal, projectId, request);
    const tenantId = personalTenantId(principal);
    const now = this.now();
    const requestHash = hashCanonicalJson({ projectId, request });
    const baseSequence = this.decodeCursor(request.baseCursor, projectId);
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(tenantId);
      const existingIdempotency = await this.findIdempotency(
        transaction,
        "sync.push",
        principal.accountId,
        context.idempotencyKey,
        requestHash,
        now,
      );
      if (existingIdempotency !== null) {
        return this.replaySyncBatch(existingIdempotency, tenantId, projectId, context.requestId);
      }
      const project = await this.requireProject(transaction, tenantId, projectId);
      await this.requireProjectAccess(transaction, project, principal.accountId, "sync");
      const currentDevice = await this.requireTrustedCurrentDevice(transaction, principal);
      await transaction.lockSyncDeviceSequence(tenantId, projectId, principal.deviceId);
      const maximumBeforePush = await transaction.getMaximumRemoteSequence(tenantId, projectId);
      if (
        baseSequence < project.minimumAvailableRemoteSequence ||
        baseSequence > maximumBeforePush
      ) {
        throw syncCursorExpired();
      }

      const validated = await this.validateSyncPayload(
        transaction,
        tenantId,
        project,
        currentDevice,
        request,
      );
      let latestDeviceSequence = await transaction.findLatestDeviceSequence(
        tenantId,
        projectId,
        principal.deviceId,
      );
      const dispositions: {
        disposition: "accepted" | "duplicate";
        operationId: string;
      }[] = [];

      for (const operation of request.operations) {
        const existing = await transaction.findSyncOperation(
          tenantId,
          projectId,
          operation.operationId,
        );
        if (existing !== null) {
          await this.assertDuplicateOperationMatches(
            transaction,
            tenantId,
            projectId,
            existing.operation,
            operation,
            validated.chunksByOperation.get(operation.operationId) ?? [],
            validated.tombstonesByOperation.get(operation.operationId) ?? null,
          );
          dispositions.push({
            disposition: "duplicate",
            operationId: operation.operationId,
          });
          continue;
        }
        if (operation.deviceSequence <= latestDeviceSequence) {
          throw syncSequenceConflict();
        }
        const remoteSequence = await transaction.insertSyncOperation(tenantId, operation, now);
        void remoteSequence;
        const chunks = validated.chunksByOperation.get(operation.operationId) ?? [];
        await transaction.insertSyncChunks(chunks);
        const tombstone = validated.tombstonesByOperation.get(operation.operationId) ?? null;
        if (tombstone !== null) {
          await transaction.insertSyncTombstone(tombstone);
        }
        latestDeviceSequence = operation.deviceSequence;
        dispositions.push({
          disposition: "accepted",
          operationId: operation.operationId,
        });
      }

      const remoteSequence = await transaction.getMaximumRemoteSequence(tenantId, projectId);
      const batch: CloudSyncBatchRecord = {
        acceptedOperations: dispositions,
        accountId: principal.accountId,
        batchId: this.uuid(),
        deviceId: principal.deviceId,
        projectId,
        remoteSequence,
        serverTime: now,
        tenantId,
      };
      await transaction.insertSyncBatch(batch);
      const response = toSyncPushResponse(batch, this.cursorCodec, context.requestId);
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "sync.push",
        requestHash,
        response,
        responseSnapshot: {
          batchId: batch.batchId,
          projectId,
          response,
          snapshotKind: "sync_push_v1",
          tenantId,
        },
        responseStatus: 200,
        resultKind: "sync_batch",
        resultResourceId: batch.batchId,
      });
      await transaction.insertAuditEvent(
        this.auditEvent({
          action: "sync.ciphertext_pushed",
          context,
          now,
          principal,
          redactedDiff: {
            chunkCount: request.chunks.length,
            operationCount: request.operations.length,
            tombstoneCount: request.tombstones.length,
          },
          resourceId: projectId,
          resourceType: "cloud_project",
          tenantId,
        }),
      );
      return response;
    });
  }

  public async pullSync(
    principal: CloudPrincipal,
    projectId: string,
    cursor: string | null,
    limit: number,
    context: CloudReadContext,
  ): Promise<CloudSyncPullResponse> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_PULL_LIMIT) {
      throw validationFailed("The sync pull limit is invalid.");
    }
    const tenantId = personalTenantId(principal);
    const afterSequence = this.decodeCursor(cursor, projectId);
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(tenantId);
      const project = await this.requireProject(transaction, tenantId, projectId);
      await this.requireProjectAccess(transaction, project, principal.accountId, "sync");
      await this.requireTrustedCurrentDevice(transaction, principal);
      const maximum = await transaction.getMaximumRemoteSequence(tenantId, projectId);
      if (afterSequence < project.minimumAvailableRemoteSequence || afterSequence > maximum) {
        throw syncCursorExpired();
      }
      const fetched = await transaction.listSyncOperations(
        tenantId,
        projectId,
        afterSequence,
        limit + 1,
      );
      const page = takeSyncOperationPage(fetched, limit);
      const operationIds = page.map((item) => item.operation.operationId);
      const [chunks, tombstones] = await Promise.all([
        transaction.findSyncChunksForOperations(tenantId, projectId, operationIds),
        transaction.findSyncTombstonesForOperations(tenantId, projectId, operationIds),
      ]);
      assertCompleteSyncPayload(projectId, page, chunks, tombstones);
      const nextSequence = page.at(-1)?.remoteSequence ?? afterSequence;
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        operations: page.map((item) => item.operation),
        chunks: chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          encrypted: chunk.encrypted,
        })),
        tombstones: tombstones.map((item) => item.tombstone),
        nextCursor: this.cursorCodec.encode(nextSequence, projectId),
        hasMore: page.length < fetched.length,
      };
    });
  }

  public async acknowledgeTombstones(
    principal: CloudPrincipal,
    projectId: string,
    request: CloudTombstoneAcknowledgementRequest,
    context: CloudMutationContext,
  ): Promise<CloudMutationAcceptedResponse> {
    if (
      request.acknowledgements.some(
        (acknowledgement) => !isPositivePortableInteger(acknowledgement.objectGeneration),
      )
    ) {
      throw validationFailed("Sync object generations must be positive portable integers.");
    }
    const tenantId = personalTenantId(principal);
    const now = this.now();
    const requestHash = hashCanonicalJson({ projectId, request });
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(tenantId);
      const existingIdempotency = await this.findIdempotency(
        transaction,
        "sync.acknowledgeTombstones",
        principal.accountId,
        context.idempotencyKey,
        requestHash,
        now,
      );
      if (existingIdempotency !== null) {
        return replayAccepted(existingIdempotency, context.requestId);
      }
      const project = await this.requireProject(transaction, tenantId, projectId);
      await this.requireProjectAccess(transaction, project, principal.accountId, "sync");
      await this.requireTrustedCurrentDevice(transaction, principal);
      for (const acknowledgement of request.acknowledgements) {
        const tombstone = await transaction.findSyncTombstone(
          tenantId,
          projectId,
          acknowledgement.objectType,
          acknowledgement.objectId,
          acknowledgement.objectGeneration,
        );
        if (tombstone === null) {
          throw resourceNotFound("A sync tombstone was not found.");
        }
        await transaction.acknowledgeSyncTombstone(
          tenantId,
          projectId,
          acknowledgement.objectType,
          acknowledgement.objectId,
          acknowledgement.objectGeneration,
          principal.deviceId,
          now,
        );
      }
      const response = acceptedResponse(context.requestId, now);
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "sync.acknowledgeTombstones",
        requestHash,
        response,
        responseStatus: 202,
        resultKind: "accepted",
        resultResourceId: projectId,
      });
      await transaction.insertAuditEvent(
        this.auditEvent({
          action: "sync.tombstones_acknowledged",
          context,
          now,
          principal,
          redactedDiff: { acknowledgementCount: request.acknowledgements.length },
          resourceId: projectId,
          resourceType: "cloud_project",
          tenantId,
        }),
      );
      return response;
    });
  }

  public async revokeDeviceEnvelopes(
    principal: CloudPrincipal,
    revokedDeviceId: string,
    revokedAt: Date,
  ): Promise<number> {
    const tenantId = personalTenantId(principal);
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(tenantId);
      return transaction.revokeRecipientDeviceEnvelopes(tenantId, revokedDeviceId, revokedAt);
    });
  }

  private async validateProjectKeyDevices(
    transaction: CloudProjectTransaction,
    principal: CloudPrincipal,
    envelopes: readonly DeviceProjectKeyEnvelopeContract[],
  ): Promise<readonly RegisteredDeviceRecord[]> {
    const currentDevice = await this.requireTrustedCurrentDevice(transaction, principal);
    const recipientDevices = await transaction.findDevices(
      envelopes.map((envelope) => envelope.recipientDeviceId),
    );
    const trustedDevices = await transaction.listTrustedDevices(principal.accountId);
    if (
      recipientDevices.length !== envelopes.length ||
      trustedDevices.length !== envelopes.length ||
      recipientDevices.some(
        (device) => device.accountId !== principal.accountId || device.state !== "trusted",
      )
    ) {
      throw accessForbidden(
        "Project-key envelopes must cover every trusted device and no other device.",
      );
    }
    const byId = new Map(trustedDevices.map((device) => [device.deviceId, device]));
    if (!byId.has(currentDevice.deviceId)) {
      throw accessForbidden("The publishing device must receive the project key.");
    }
    for (const envelope of envelopes) {
      const recipient = byId.get(envelope.recipientDeviceId);
      if (
        recipient === undefined ||
        envelope.revokedAt !== null ||
        envelope.senderDeviceId !== currentDevice.deviceId ||
        envelope.senderPublicKey !== currentDevice.publicKey ||
        envelope.senderPublicKeyFingerprint !== currentDevice.publicKeyFingerprint ||
        envelope.recipientPublicKey !== recipient.publicKey ||
        envelope.recipientPublicKeyFingerprint !== recipient.publicKeyFingerprint
      ) {
        throw accessForbidden("A project-key device envelope is not authorized.");
      }
    }
    return trustedDevices;
  }

  private async validateSyncPayload(
    transaction: CloudProjectTransaction,
    tenantId: string,
    project: CloudProjectRecord,
    currentDevice: RegisteredDeviceRecord,
    request: CloudSyncPushRequest,
  ): Promise<{
    readonly chunksByOperation: ReadonlyMap<string, readonly PersistedSyncChunk[]>;
    readonly tombstonesByOperation: ReadonlyMap<string, PersistedSyncTombstone>;
  }> {
    const operationIds = new Set<string>();
    const chunkOwner = new Map<string, SyncOperationContract>();
    for (const operation of request.operations) {
      if (
        operationIds.has(operation.operationId) ||
        operation.projectId !== project.projectId ||
        operation.deviceId !== currentDevice.deviceId
      ) {
        throw validationFailed("A sync operation is duplicated or outside the active device.");
      }
      operationIds.add(operation.operationId);
      for (const chunkId of operation.encryptedChunkIds) {
        if (chunkOwner.has(chunkId)) {
          throw invalidCiphertext();
        }
        chunkOwner.set(chunkId, operation);
      }
    }

    const chunksByOperation = new Map<string, PersistedSyncChunk[]>();
    const keySets = new Map<number, CloudProjectKeySetRecord>();
    for (const upload of request.chunks) {
      const operation = chunkOwner.get(upload.chunkId);
      if (
        operation === undefined ||
        upload.encrypted.aad.projectId !== project.projectId ||
        upload.encrypted.aad.objectType !== operation.objectType ||
        upload.encrypted.aad.objectId !== operation.objectId ||
        !verifyCiphertextDigest(upload.encrypted.ciphertext, upload.encrypted.ciphertextSha256)
      ) {
        throw invalidCiphertext();
      }
      const cachedKeySet = keySets.get(upload.encrypted.aad.keyVersion);
      let keySet: CloudProjectKeySetRecord;
      if (cachedKeySet === undefined) {
        const loadedKeySet = await transaction.findProjectKeySet(
          tenantId,
          project.projectId,
          upload.encrypted.aad.keyVersion,
        );
        if (loadedKeySet === null) {
          throw invalidCiphertext();
        }
        keySet = loadedKeySet;
        keySets.set(upload.encrypted.aad.keyVersion, keySet);
      } else {
        keySet = cachedKeySet;
      }
      const envelope = keySet.deviceEnvelopes.find(
        (candidate) => candidate.recipientDeviceId === currentDevice.deviceId,
      );
      if (
        (keySet.version.state !== "active" && keySet.version.state !== "retiring") ||
        envelope?.revokedAt !== null
      ) {
        throw accessForbidden("The current device cannot sync with this project-key version.");
      }
      const persisted: PersistedSyncChunk = {
        chunkId: upload.chunkId,
        encrypted: upload.encrypted,
        operationId: operation.operationId,
        tenantId,
      };
      const list = chunksByOperation.get(operation.operationId) ?? [];
      list.push(persisted);
      chunksByOperation.set(operation.operationId, list);
    }

    const tombstonesByKey = new Map(
      request.tombstones.map((tombstone) => [
        tombstoneKey(tombstone.objectType, tombstone.objectId, tombstone.objectGeneration),
        tombstone,
      ]),
    );
    if (tombstonesByKey.size !== request.tombstones.length) {
      throw validationFailed("Sync tombstones must be unique.");
    }
    const tombstonesByOperation = new Map<string, PersistedSyncTombstone>();
    for (const operation of request.operations) {
      const tombstone = tombstonesByKey.get(
        tombstoneKey(operation.objectType, operation.objectId, operation.objectGeneration),
      );
      if (operation.kind === "delete") {
        if (
          tombstone?.projectId !== project.projectId ||
          tombstone.objectType !== operation.objectType ||
          tombstone.deletedByDeviceId !== currentDevice.deviceId ||
          hashCanonicalJson(tombstone.vector) !== hashCanonicalJson(operation.vector) ||
          tombstone.acknowledgedDeviceIds.length !== 0
        ) {
          throw validationFailed("A delete operation must carry its exact tombstone.");
        }
        tombstonesByOperation.set(operation.operationId, {
          operationId: operation.operationId,
          tenantId,
          tombstone,
        });
        tombstonesByKey.delete(
          tombstoneKey(operation.objectType, operation.objectId, operation.objectGeneration),
        );
      } else if (tombstone !== undefined) {
        throw validationFailed("Only delete operations can carry tombstones.");
      }
    }
    if (tombstonesByKey.size !== 0) {
      throw validationFailed("A sync tombstone does not match a delete operation.");
    }
    return { chunksByOperation, tombstonesByOperation };
  }

  private async assertDuplicateOperationMatches(
    transaction: CloudProjectTransaction,
    tenantId: string,
    projectId: string,
    persisted: SyncOperationContract,
    supplied: SyncOperationContract,
    suppliedChunks: readonly PersistedSyncChunk[],
    suppliedTombstone: PersistedSyncTombstone | null,
  ): Promise<void> {
    if (hashCanonicalJson(persisted) !== hashCanonicalJson(supplied)) {
      throw syncSequenceConflict();
    }
    const storedChunks = await transaction.findSyncChunksForOperations(tenantId, projectId, [
      persisted.operationId,
    ]);
    if (
      hashCanonicalJson(normalizeChunks(storedChunks)) !==
      hashCanonicalJson(normalizeChunks(suppliedChunks))
    ) {
      throw invalidCiphertext();
    }
    const storedTombstones = await transaction.findSyncTombstonesForOperations(
      tenantId,
      projectId,
      [persisted.operationId],
    );
    const storedTombstone = storedTombstones[0] ?? null;
    if (
      hashCanonicalJson(normalizeTombstone(storedTombstone)) !==
      hashCanonicalJson(normalizeTombstone(suppliedTombstone))
    ) {
      throw syncSequenceConflict();
    }
  }

  private assertKeyRouteIdentity(
    projectId: string,
    keyVersion: number,
    request: CloudProjectKeyPublishRequest,
  ): void {
    if (
      request.version.projectId !== projectId ||
      request.version.keyVersion !== keyVersion ||
      request.version.state !== "active" ||
      request.version.retiredAt !== null ||
      request.recoveryEnvelope.projectId !== projectId ||
      request.recoveryEnvelope.keyVersion !== keyVersion ||
      request.recoveryEnvelope.confirmedAt === null ||
      request.recoveryEnvelope.revokedAt !== null ||
      request.deviceEnvelopes.some(
        (envelope) => envelope.projectId !== projectId || envelope.keyVersion !== keyVersion,
      )
    ) {
      throw validationFailed("The project-key publication does not match its route.");
    }
  }

  private assertSyncProjectIdentity(
    principal: CloudPrincipal,
    projectId: string,
    request: CloudSyncPushRequest,
  ): void {
    let previousDeviceSequence = 0;
    if (
      request.operations.some((operation) => {
        const sequenceIsInvalid =
          !isPositivePortableInteger(operation.deviceSequence) ||
          operation.deviceSequence <= previousDeviceSequence;
        previousDeviceSequence = operation.deviceSequence;
        return (
          operation.projectId !== projectId ||
          operation.deviceId !== principal.deviceId ||
          sequenceIsInvalid ||
          !isPositivePortableInteger(operation.objectGeneration) ||
          Object.values(operation.vector).some((sequence) => !isPositivePortableInteger(sequence))
        );
      }) ||
      request.chunks.some((chunk) => chunk.encrypted.aad.projectId !== projectId) ||
      request.tombstones.some(
        (tombstone) =>
          tombstone.projectId !== projectId ||
          !isPositivePortableInteger(tombstone.objectGeneration) ||
          Object.values(tombstone.vector).some((sequence) => !isPositivePortableInteger(sequence)),
      )
    ) {
      throw validationFailed("The sync payload route or portable integer counters are invalid.");
    }
  }

  private async requireProject(
    transaction: CloudProjectTransaction,
    tenantId: string,
    projectId: string,
  ): Promise<CloudProjectRecord> {
    const project = await transaction.findProject(tenantId, projectId, false);
    if (project?.state !== "active") {
      throw resourceNotFound("The cloud project was not found.");
    }
    return project;
  }

  private async requireProjectAccess(
    transaction: CloudProjectTransaction,
    project: CloudProjectRecord,
    accountId: string,
    capability: "manage_keys" | "read_keys" | "sync",
  ): Promise<CloudProjectAccessRecord> {
    const access = await transaction.findProjectAccess(
      project.tenantId,
      project.projectId,
      accountId,
      false,
    );
    if (access?.revokedAt !== null) {
      throw accessForbidden();
    }
    const allowed =
      capability === "sync"
        ? access.canSync
        : capability === "manage_keys"
          ? access.canManageKeys
          : access.canManageKeys || access.canSync;
    if (!allowed) {
      throw accessForbidden();
    }
    return access;
  }

  private async requireTrustedCurrentDevice(
    transaction: CloudProjectTransaction,
    principal: CloudPrincipal,
  ): Promise<RegisteredDeviceRecord> {
    const device = await transaction.findDevice(principal.deviceId, false);
    if (device?.accountId !== principal.accountId || device.state !== "trusted") {
      throw accessForbidden("The current device is not trusted.");
    }
    return device;
  }

  private decodeCursor(cursor: string | null, projectId: string): bigint {
    if (cursor === null) {
      return 0n;
    }
    try {
      return this.cursorCodec.decode(cursor, projectId);
    } catch (error) {
      if (error instanceof InvalidSyncCursorError) {
        throw syncCursorExpired();
      }
      throw error;
    }
  }

  private replayProjectKey(
    idempotency: CloudIdempotencyRecord,
    projectId: string,
    keyVersion: number,
    requestId: string,
  ): CloudProjectKeyResponse {
    if (idempotency.resultKind !== "project_key" || idempotency.resultResourceId !== projectId) {
      throw new Error("The idempotency record does not reference this project key.");
    }
    if (idempotency.responseSnapshot === null) {
      throw new Error("The idempotent project-key response snapshot is unavailable.");
    }
    if (hashCanonicalJson(idempotency.responseSnapshot) !== idempotency.resultDigestSha256) {
      throw new Error("The idempotent project-key response snapshot digest is invalid.");
    }
    const parsed = CloudProjectKeyResponseSchema.safeParse(idempotency.responseSnapshot);
    if (
      !parsed.success ||
      parsed.data.keySet.projectId !== projectId ||
      parsed.data.keySet.keyVersion !== keyVersion
    ) {
      throw new Error("The idempotent project-key response snapshot is invalid.");
    }
    return {
      ...parsed.data,
      requestId,
    };
  }

  private replaySyncBatch(
    idempotency: CloudIdempotencyRecord,
    tenantId: string,
    projectId: string,
    requestId: string,
  ): CloudSyncPushResponse {
    if (idempotency.resultKind !== "sync_batch" || idempotency.resultResourceId === null) {
      throw new Error("The idempotency record does not reference a sync batch.");
    }
    const snapshot = requireSyncPushSnapshot(idempotency.responseSnapshot);
    const parsed = CloudSyncPushResponseSchema.safeParse(snapshot.response);
    if (
      !parsed.success ||
      snapshot.batchId !== idempotency.resultResourceId ||
      snapshot.tenantId !== tenantId ||
      snapshot.projectId !== projectId ||
      hashCanonicalJson(parsed.data) !== idempotency.resultDigestSha256
    ) {
      throw new Error("The idempotent sync response snapshot is invalid.");
    }
    return { ...parsed.data, requestId };
  }

  private async findIdempotency(
    transaction: CloudProjectTransaction,
    operationId: CloudIdempotencyRecord["operationId"],
    actorAccountId: string,
    idempotencyKey: string,
    requestHash: string,
    now: Date,
  ): Promise<CloudIdempotencyRecord | null> {
    const scopeHash = createIdempotencyScopeHash({
      actorAccountId,
      idempotencyKey,
      operationId,
    });
    await transaction.lockIdempotency(scopeHash);
    const existing = await transaction.findIdempotency(scopeHash);
    if (existing === null) {
      return null;
    }
    if (
      existing.operationId !== operationId ||
      existing.requestHashSha256 !== requestHash ||
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      throw idempotencyConflict();
    }
    return existing;
  }

  private async insertIdempotency(
    transaction: CloudProjectTransaction,
    options: {
      readonly actorAccountId: string;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: CloudIdempotencyRecord["operationId"];
      readonly requestHash: string;
      readonly response: unknown;
      readonly responseSnapshot?: unknown;
      readonly responseStatus: number;
      readonly resultKind: CloudIdempotencyRecord["resultKind"];
      readonly resultResourceId: string | null;
    },
  ): Promise<void> {
    await transaction.insertIdempotency({
      actorAccountId: options.actorAccountId,
      createdAt: options.now,
      expiresAt: new Date(options.now.getTime() + this.idempotencyLifetimeMs),
      idempotencyKeyHashSha256: hashUtf8(options.context.idempotencyKey),
      operationId: options.operationId,
      requestHashSha256: options.requestHash,
      responseSnapshot:
        options.responseSnapshot ??
        (options.resultKind === "accepted" || options.resultKind === "project_key"
          ? options.response
          : null),
      responseStatus: options.responseStatus,
      resultDigestSha256: hashCanonicalJson(options.response),
      resultKind: options.resultKind,
      resultResourceId: options.resultResourceId,
      scopeHashSha256: createIdempotencyScopeHash({
        actorAccountId: options.actorAccountId,
        idempotencyKey: options.context.idempotencyKey,
        operationId: options.operationId,
      }),
    });
  }

  private auditEvent(options: {
    readonly action: string;
    readonly context: CloudReadContext;
    readonly now: Date;
    readonly principal: CloudPrincipal;
    readonly redactedDiff?: Readonly<Record<string, unknown>>;
    readonly resourceId: string | null;
    readonly resourceType: string;
    readonly tenantId: string;
  }): CloudAuditEventRecord {
    return {
      action: options.action,
      actorAccountId: options.principal.accountId,
      actorDeviceId: options.principal.deviceId,
      createdAt: options.now,
      eventId: this.uuid(),
      redactedDiff: options.redactedDiff ?? {},
      requestId: options.context.requestId,
      resourceId: options.resourceId,
      resourceType: options.resourceType,
      result: "allowed",
      tenantId: options.tenantId,
    };
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The cloud-service clock returned an invalid timestamp.");
    }
    return new Date(value);
  }
}

function personalTenantId(principal: CloudPrincipal): string {
  return principal.accountId;
}

function toProjectKeyResponse(
  keySet: CloudProjectKeySetRecord,
  requestId: string,
): CloudProjectKeyResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    keySet: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      projectId: keySet.projectId,
      keyVersion: keySet.keyVersion,
      serverRevision: keySet.serverRevision,
      publication: keySet.publication,
      version: keySet.version,
      recoveryEnvelope: keySet.recoveryEnvelope,
      deviceEnvelopes: [...keySet.deviceEnvelopes],
      updatedAt: keySet.updatedAt.toISOString(),
    },
  };
}

function toSyncPushResponse(
  batch: CloudSyncBatchRecord,
  cursorCodec: SyncCursorCodec,
  requestId: string,
): CloudSyncPushResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    acceptedOperations: [...batch.acceptedOperations],
    remoteCursor: cursorCodec.encode(batch.remoteSequence, batch.projectId),
    serverTime: batch.serverTime.toISOString(),
  };
}

interface StoredSyncPushSnapshot {
  readonly batchId: string;
  readonly projectId: string;
  readonly response: unknown;
  readonly snapshotKind: "sync_push_v1";
  readonly tenantId: string;
}

function requireSyncPushSnapshot(value: unknown): StoredSyncPushSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The idempotent sync response snapshot is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["batchId", "projectId", "response", "snapshotKind", "tenantId"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    record.snapshotKind !== "sync_push_v1" ||
    typeof record.batchId !== "string" ||
    typeof record.projectId !== "string" ||
    typeof record.tenantId !== "string"
  ) {
    throw new Error("The idempotent sync response snapshot is invalid.");
  }
  return record as unknown as StoredSyncPushSnapshot;
}

function takeSyncOperationPage(
  candidates: readonly PersistedSyncOperation[],
  operationLimit: number,
): readonly PersistedSyncOperation[] {
  const page: PersistedSyncOperation[] = [];
  let chunkCount = 0;
  for (const candidate of candidates) {
    if (page.length >= operationLimit) {
      break;
    }
    const operationChunkCount = candidate.operation.encryptedChunkIds.length;
    if (operationChunkCount > MAXIMUM_PULL_CHUNKS) {
      throw new Error("A persisted sync operation exceeds the cloud chunk budget.");
    }
    if (chunkCount + operationChunkCount > MAXIMUM_PULL_CHUNKS) {
      if (page.length === 0) {
        throw new Error("The cloud sync page cannot fit one persisted operation.");
      }
      break;
    }
    page.push(candidate);
    chunkCount += operationChunkCount;
  }
  return page;
}

function assertCompleteSyncPayload(
  projectId: string,
  operations: readonly PersistedSyncOperation[],
  chunks: readonly PersistedSyncChunk[],
  tombstones: readonly PersistedSyncTombstone[],
): void {
  const operationIds = new Set(operations.map((item) => item.operation.operationId));
  const chunkIds = new Set<string>();
  const chunksByOperation = new Map<string, PersistedSyncChunk[]>();
  for (const chunk of chunks) {
    if (
      !operationIds.has(chunk.operationId) ||
      chunk.encrypted.aad.projectId !== projectId ||
      chunkIds.has(chunk.chunkId)
    ) {
      throw new Error("The persisted sync chunks do not match their operation page.");
    }
    chunkIds.add(chunk.chunkId);
    const owned = chunksByOperation.get(chunk.operationId) ?? [];
    owned.push(chunk);
    chunksByOperation.set(chunk.operationId, owned);
  }
  const tombstonesByOperation = new Map<string, PersistedSyncTombstone[]>();
  for (const tombstone of tombstones) {
    if (!operationIds.has(tombstone.operationId) || tombstone.tombstone.projectId !== projectId) {
      throw new Error("The persisted sync tombstones do not match their operation page.");
    }
    const owned = tombstonesByOperation.get(tombstone.operationId) ?? [];
    owned.push(tombstone);
    tombstonesByOperation.set(tombstone.operationId, owned);
  }
  for (const persisted of operations) {
    const operation = persisted.operation;
    const ownedChunks = chunksByOperation.get(operation.operationId) ?? [];
    const ownedTombstones = tombstonesByOperation.get(operation.operationId) ?? [];
    if (operation.projectId !== projectId) {
      throw new Error("A persisted sync operation crossed its project scope.");
    }
    if (operation.kind === "upsert") {
      if (
        ownedTombstones.length !== 0 ||
        ownedChunks.length !== operation.encryptedChunkIds.length
      ) {
        throw new Error("A persisted upsert operation is incomplete.");
      }
      const byId = new Map(ownedChunks.map((chunk) => [chunk.chunkId, chunk]));
      for (const [index, expectedChunkId] of operation.encryptedChunkIds.entries()) {
        const chunk = byId.get(expectedChunkId);
        if (
          chunk?.encrypted.aad.objectId !== operation.objectId ||
          chunk.encrypted.aad.objectType !== operation.objectType ||
          chunk.encrypted.aad.chunkIndex !== index
        ) {
          throw new Error("A persisted upsert operation has inconsistent chunk ownership.");
        }
      }
      continue;
    }
    const tombstone = ownedTombstones[0];
    if (
      ownedChunks.length !== 0 ||
      ownedTombstones.length !== 1 ||
      tombstone?.tombstone.objectId !== operation.objectId ||
      tombstone.tombstone.objectType !== operation.objectType ||
      tombstone.tombstone.objectGeneration !== operation.objectGeneration ||
      tombstone.tombstone.deletedByDeviceId !== operation.deviceId ||
      hashCanonicalJson(tombstone.tombstone.vector) !== hashCanonicalJson(operation.vector)
    ) {
      throw new Error("A persisted delete operation is incomplete.");
    }
  }
}

function acceptedResponse(requestId: string, completedAt: Date): CloudMutationAcceptedResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    accepted: true,
    completedAt: completedAt.toISOString(),
  };
}

function replayAccepted(
  idempotency: CloudIdempotencyRecord,
  requestId: string,
): CloudMutationAcceptedResponse {
  if (idempotency.resultKind !== "accepted") {
    throw new Error("The idempotency record does not reference an accepted mutation.");
  }
  const parsed = CloudMutationAcceptedResponseSchema.safeParse(idempotency.responseSnapshot);
  if (!parsed.success || hashCanonicalJson(parsed.data) !== idempotency.resultDigestSha256) {
    throw new Error("The idempotent accepted-mutation response snapshot is invalid.");
  }
  return { ...parsed.data, requestId };
}

function verifyCiphertextDigest(ciphertext: string, expectedHex: string): boolean {
  const decoded = Buffer.from(ciphertext, "base64url");
  if (decoded.toString("base64url") !== ciphertext) {
    decoded.fill(0);
    return false;
  }
  const actual = createHash("sha256").update(decoded).digest();
  const expected = Buffer.from(expectedHex, "hex");
  decoded.fill(0);
  try {
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
}

function tombstoneKey(
  objectType: SyncOperationContract["objectType"],
  objectId: string,
  objectGeneration: number,
): string {
  return `${objectType}:${objectId}:${String(objectGeneration)}`;
}

function isPositivePortableInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeChunks(chunks: readonly PersistedSyncChunk[]): unknown {
  return [...chunks]
    .sort((left, right) => left.chunkId.localeCompare(right.chunkId))
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      encrypted: chunk.encrypted,
      operationId: chunk.operationId,
    }));
}

function normalizeTombstone(tombstone: PersistedSyncTombstone | null): unknown {
  if (tombstone === null) {
    return null;
  }
  return {
    operationId: tombstone.operationId,
    tombstone: {
      ...tombstone.tombstone,
      acknowledgedDeviceIds: [],
    } satisfies SyncTombstoneContract,
  };
}
