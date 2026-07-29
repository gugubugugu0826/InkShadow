import { z } from "zod";

import {
  CloudAccountContractSchema,
  CloudSessionContractSchema,
  DeviceProjectKeyEnvelopeContractSchema,
  EncryptedSyncChunkContractSchema,
  PositivePortableIntegerSchema,
  ProjectKeyVersionContractSchema,
  RecoveryProjectKeyEnvelopeContractSchema,
  RegisteredDeviceContractSchema,
  RegisteredDevicePublicKeyContractSchema,
  SyncObjectTypeSchema,
  SyncOperationContractSchema,
  SyncTombstoneContractSchema,
} from "./cloud-schemas.js";
import {
  CONTRACT_SCHEMA_VERSION,
  ErrorActionSchema,
  IsoUtcTimestampSchema,
  UuidV7Schema,
} from "./schemas.js";

export const CloudEmailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().min(3).max(320));

export const CloudPasswordSchema = z
  .string()
  .min(12)
  .max(256)
  .refine((value) => !/\p{Cc}/u.test(value), {
    message: "Password cannot contain control characters",
  });
export const CloudOneTimeCodeSchema = z.string().regex(/^\d{6}$/u);
export const CloudClientVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
export const CloudOpaqueTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9._~-]+$/u)
  .min(43)
  .max(4_096);
export const CloudCursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/u)
  .min(1)
  .max(512);
export const CloudIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._~-]+$/u)
  .min(16)
  .max(200);
export const CloudDeviceDisplayNameSchema = z.string().trim().min(1).max(80);

export const CloudDeviceRegistrationInputSchema = z
  .object({
    deviceId: UuidV7Schema,
    displayName: CloudDeviceDisplayNameSchema,
    algorithm: z.literal("DHKEM-P256-HKDF-SHA256"),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    clientVersion: CloudClientVersionSchema,
  })
  .strict();

export const CloudIdentityRegistrationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    email: CloudEmailAddressSchema,
    password: CloudPasswordSchema,
  })
  .strict();

export const CloudIdentityChallengeResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    accepted: z.literal(true),
    challengeId: UuidV7Schema,
    expiresAt: IsoUtcTimestampSchema,
  })
  .strict();

export const CloudIdentityVerificationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    challengeId: UuidV7Schema,
    code: CloudOneTimeCodeSchema,
    device: CloudDeviceRegistrationInputSchema,
  })
  .strict();

export const CloudPasswordResetRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    email: CloudEmailAddressSchema,
  })
  .strict();

export const CloudPasswordResetConfirmationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    challengeId: UuidV7Schema,
    code: CloudOneTimeCodeSchema,
    newPassword: CloudPasswordSchema,
  })
  .strict();

export const CloudAuthenticationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    email: CloudEmailAddressSchema,
    password: CloudPasswordSchema,
    device: CloudDeviceRegistrationInputSchema,
  })
  .strict();

export const CloudSessionTokenSetSchema = z
  .object({
    accessToken: CloudOpaqueTokenSchema,
    accessTokenExpiresAt: IsoUtcTimestampSchema,
    refreshToken: CloudOpaqueTokenSchema,
    refreshTokenExpiresAt: IsoUtcTimestampSchema,
  })
  .strict()
  .refine(
    (tokens) => Date.parse(tokens.refreshTokenExpiresAt) > Date.parse(tokens.accessTokenExpiresAt),
    {
      message: "Refresh-token expiry must follow access-token expiry",
      path: ["refreshTokenExpiresAt"],
    },
  );

export const CloudDeviceContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    device: RegisteredDeviceContractSchema,
    publicKey: RegisteredDevicePublicKeyContractSchema,
    displayName: CloudDeviceDisplayNameSchema,
    revision: z.number().int().positive(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.device.deviceId !== record.publicKey.deviceId ||
      record.device.accountId !== record.publicKey.accountId ||
      record.device.publicKeyFingerprint !== record.publicKey.publicKeyFingerprint ||
      record.device.revokedAt !== record.publicKey.revokedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "Cloud device metadata and public-key identity must agree",
        path: ["publicKey"],
      });
    }
  });

export const CloudSessionGrantResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    account: CloudAccountContractSchema,
    device: CloudDeviceContractSchema,
    session: CloudSessionContractSchema,
    tokens: CloudSessionTokenSetSchema,
  })
  .strict()
  .superRefine((grant, context) => {
    if (
      grant.account.accountId !== grant.device.device.accountId ||
      grant.account.accountId !== grant.session.accountId ||
      grant.device.device.deviceId !== grant.session.deviceId
    ) {
      context.addIssue({
        code: "custom",
        message: "Account, device and session identities must agree",
        path: ["session"],
      });
    }
  });

export const CloudSessionRefreshRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    deviceId: UuidV7Schema,
    refreshToken: CloudOpaqueTokenSchema,
  })
  .strict();

export const CloudSessionLogoutRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    sessionId: UuidV7Schema,
  })
  .strict();

export const CloudMutationAcceptedResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    accepted: z.literal(true),
    completedAt: IsoUtcTimestampSchema,
  })
  .strict();

export const CloudSessionListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    sessions: z.array(CloudSessionContractSchema).max(1_024),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict();

export const CloudDeviceRegistrationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    device: CloudDeviceRegistrationInputSchema,
  })
  .strict();

export const CloudDeviceResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    device: CloudDeviceContractSchema,
  })
  .strict();

export const CloudDeviceListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    devices: z.array(CloudDeviceContractSchema).max(1_024),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict();

export const CloudProjectKeyPublishRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedServerRevision: z.number().int().positive().nullable(),
    version: ProjectKeyVersionContractSchema,
    recoveryEnvelope: RecoveryProjectKeyEnvelopeContractSchema,
    deviceEnvelopes: z.array(DeviceProjectKeyEnvelopeContractSchema).min(1).max(1_024),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.version.state !== "active" ||
      request.version.retiredAt !== null ||
      request.recoveryEnvelope.confirmedAt === null ||
      request.recoveryEnvelope.revokedAt !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Only an active, confirmed project-key version can be published",
        path: ["version", "state"],
      });
    }
    if ((request.version.keyVersion === 1) !== (request.expectedServerRevision === null)) {
      context.addIssue({
        code: "custom",
        message: "Initial and rotated project keys require different revision preconditions",
        path: ["expectedServerRevision"],
      });
    }
    const recipients = new Set<string>();
    for (const [index, envelope] of request.deviceEnvelopes.entries()) {
      if (
        envelope.projectId !== request.version.projectId ||
        envelope.keyVersion !== request.version.keyVersion ||
        envelope.revokedAt !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Device envelopes must match the published project-key version",
          path: ["deviceEnvelopes", index],
        });
      }
      if (recipients.has(envelope.recipientDeviceId)) {
        context.addIssue({
          code: "custom",
          message: "A project-key set cannot contain duplicate recipient devices",
          path: ["deviceEnvelopes", index, "recipientDeviceId"],
        });
      }
      recipients.add(envelope.recipientDeviceId);
    }
    if (
      request.recoveryEnvelope.projectId !== request.version.projectId ||
      request.recoveryEnvelope.keyVersion !== request.version.keyVersion
    ) {
      context.addIssue({
        code: "custom",
        message: "Recovery envelope must match the published project-key version",
        path: ["recoveryEnvelope"],
      });
    }
  });

export const CloudProjectKeySetSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    projectId: UuidV7Schema,
    keyVersion: z.number().int().positive(),
    serverRevision: z.number().int().positive(),
    publication: z
      .object({
        projectId: UuidV7Schema,
        keyVersion: z.number().int().positive().max(2_147_483_647),
        serverRevision: z.number().int().positive(),
        publicationRequestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        publishedAt: IsoUtcTimestampSchema,
      })
      .strict(),
    version: ProjectKeyVersionContractSchema,
    recoveryEnvelope: RecoveryProjectKeyEnvelopeContractSchema,
    deviceEnvelopes: z.array(DeviceProjectKeyEnvelopeContractSchema).max(1_024),
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict()
  .superRefine((keySet, context) => {
    if (
      keySet.version.projectId !== keySet.projectId ||
      keySet.version.keyVersion !== keySet.keyVersion ||
      keySet.recoveryEnvelope.projectId !== keySet.projectId ||
      keySet.recoveryEnvelope.keyVersion !== keySet.keyVersion ||
      keySet.publication.projectId !== keySet.projectId ||
      keySet.publication.keyVersion !== keySet.keyVersion ||
      keySet.publication.serverRevision !== keySet.serverRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "Project-key set identity is inconsistent",
        path: ["version"],
      });
    }
    if (Date.parse(keySet.publication.publishedAt) > Date.parse(keySet.updatedAt)) {
      context.addIssue({
        code: "custom",
        message: "Project-key publication cannot postdate the current key-set state",
        path: ["publication", "publishedAt"],
      });
    }
    const recipients = new Set<string>();
    for (const [index, envelope] of keySet.deviceEnvelopes.entries()) {
      if (
        envelope.projectId !== keySet.projectId ||
        envelope.keyVersion !== keySet.keyVersion ||
        recipients.has(envelope.recipientDeviceId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Project-key device envelope is inconsistent",
          path: ["deviceEnvelopes", index],
        });
      }
      recipients.add(envelope.recipientDeviceId);
    }
  });

export const CloudProjectKeyPublicationReceiptSchema = CloudProjectKeySetSchema.shape.publication;

export const CloudProjectKeyResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    keySet: CloudProjectKeySetSchema,
  })
  .strict();

export const CloudProjectSyncStateSchema = z
  .object({
    headCursor: CloudCursorSchema,
    minimumAvailableCursor: CloudCursorSchema,
    cursorStatus: z.enum(["incremental_available", "snapshot_required"]),
  })
  .strict();

export const CloudProjectStateSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    projectId: UuidV7Schema,
    currentKeyVersion: z.number().int().positive().max(2_147_483_647),
    serverRevision: z.number().int().positive(),
    currentKeyPublication: CloudProjectKeyPublicationReceiptSchema,
    updatedAt: IsoUtcTimestampSchema,
    sync: CloudProjectSyncStateSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.currentKeyPublication.projectId !== state.projectId ||
      state.currentKeyPublication.keyVersion !== state.currentKeyVersion ||
      state.currentKeyPublication.serverRevision !== state.serverRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "Current project-key publication does not match the project state",
        path: ["currentKeyPublication"],
      });
    }
    if (Date.parse(state.currentKeyPublication.publishedAt) > Date.parse(state.updatedAt)) {
      context.addIssue({
        code: "custom",
        message: "Current project-key publication cannot postdate the project state",
        path: ["currentKeyPublication", "publishedAt"],
      });
    }
  });

export const CloudProjectStateResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    project: CloudProjectStateSchema,
  })
  .strict();

export const CloudSyncChunkUploadSchema = z
  .object({
    chunkId: UuidV7Schema,
    encrypted: EncryptedSyncChunkContractSchema,
  })
  .strict();

export const CloudSyncPushRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    baseCursor: CloudCursorSchema.nullable(),
    operations: z.array(SyncOperationContractSchema).min(1).max(256),
    chunks: z.array(CloudSyncChunkUploadSchema).max(10_000),
    tombstones: z.array(SyncTombstoneContractSchema).max(256),
  })
  .strict()
  .superRefine((request, context) => {
    for (let index = 1; index < request.operations.length; index += 1) {
      const previous = request.operations[index - 1];
      const current = request.operations[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current.deviceSequence <= previous.deviceSequence
      ) {
        context.addIssue({
          code: "custom",
          message: "Sync push device sequences must be strictly increasing",
          path: ["operations", index, "deviceSequence"],
        });
      }
    }
    const chunkIds = request.chunks.map((chunk) => chunk.chunkId);
    if (new Set(chunkIds).size !== chunkIds.length) {
      context.addIssue({
        code: "custom",
        message: "Sync push chunk identifiers must be unique",
        path: ["chunks"],
      });
    }
    const referenced = new Set(
      request.operations.flatMap((operation) => operation.encryptedChunkIds),
    );
    if (
      referenced.size !== chunkIds.length ||
      chunkIds.some((chunkId) => !referenced.has(chunkId))
    ) {
      context.addIssue({
        code: "custom",
        message: "Sync push must contain exactly the ciphertext chunks referenced by operations",
        path: ["chunks"],
      });
    }
    const operationsByChunkId = new Map<string, z.infer<typeof SyncOperationContractSchema>[]>();
    for (const operation of request.operations) {
      for (const chunkId of operation.encryptedChunkIds) {
        const owners = operationsByChunkId.get(chunkId) ?? [];
        owners.push(operation);
        operationsByChunkId.set(chunkId, owners);
      }
    }
    for (const [chunkIndex, chunk] of request.chunks.entries()) {
      const owners = operationsByChunkId.get(chunk.chunkId) ?? [];
      if (owners.some((operation) => operation.objectType !== chunk.encrypted.aad.objectType)) {
        context.addIssue({
          code: "custom",
          message: "Sync push ciphertext object type must match its operation",
          path: ["chunks", chunkIndex, "encrypted", "aad", "objectType"],
        });
      }
    }
    for (const [tombstoneIndex, tombstone] of request.tombstones.entries()) {
      const matchingDeletes = request.operations.filter(
        (operation) =>
          operation.kind === "delete" &&
          operation.projectId === tombstone.projectId &&
          operation.objectId === tombstone.objectId &&
          operation.objectGeneration === tombstone.objectGeneration &&
          operation.deviceId === tombstone.deletedByDeviceId &&
          sameVersionVector(operation.vector, tombstone.vector),
      );
      if (
        matchingDeletes.length > 0 &&
        !matchingDeletes.some((operation) => operation.objectType === tombstone.objectType)
      ) {
        context.addIssue({
          code: "custom",
          message: "Sync push tombstone object type must match its delete operation",
          path: ["tombstones", tombstoneIndex, "objectType"],
        });
      }
    }
  });

export const CloudSyncPushResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    acceptedOperations: z
      .array(
        z
          .object({
            operationId: UuidV7Schema,
            disposition: z.enum(["accepted", "duplicate"]),
          })
          .strict(),
      )
      .max(256),
    remoteCursor: CloudCursorSchema,
    serverTime: IsoUtcTimestampSchema,
  })
  .strict();

export const CloudSyncPullResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    operations: z.array(SyncOperationContractSchema).max(256),
    chunks: z.array(CloudSyncChunkUploadSchema).max(10_000),
    tombstones: z.array(SyncTombstoneContractSchema).max(256),
    nextCursor: CloudCursorSchema,
    hasMore: z.boolean(),
  })
  .strict();

export const CloudSyncSnapshotResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    projectId: UuidV7Schema,
    snapshotId: UuidV7Schema,
    snapshotExpiresAt: IsoUtcTimestampSchema,
    operations: z.array(SyncOperationContractSchema).max(256),
    chunks: z.array(CloudSyncChunkUploadSchema).max(10_000),
    tombstones: z.array(SyncTombstoneContractSchema).max(256),
    resumeCursor: CloudCursorSchema,
    nextSnapshotCursor: CloudCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    validateSnapshotPayload(snapshot, context);
    if (snapshot.hasMore !== (snapshot.nextSnapshotCursor !== null)) {
      context.addIssue({
        code: "custom",
        message: "Snapshot pagination state and continuation cursor must agree",
        path: ["nextSnapshotCursor"],
      });
    }
    if (snapshot.hasMore && snapshot.operations.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A continued snapshot page must make operation progress",
        path: ["operations"],
      });
    }
    if (snapshot.nextSnapshotCursor === snapshot.resumeCursor) {
      context.addIssue({
        code: "custom",
        message: "Snapshot and incremental sync cursors must remain distinct",
        path: ["nextSnapshotCursor"],
      });
    }
  });

export const CloudTombstoneAcknowledgementRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    acknowledgements: z
      .array(
        z
          .object({
            objectType: SyncObjectTypeSchema,
            objectId: UuidV7Schema,
            objectGeneration: PositivePortableIntegerSchema,
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict()
  .refine(
    (request) =>
      new Set(
        request.acknowledgements.map(
          (item) => `${item.objectType}:${item.objectId}:${String(item.objectGeneration)}`,
        ),
      ).size === request.acknowledgements.length,
    {
      message: "Tombstone acknowledgements must be unique",
      path: ["acknowledgements"],
    },
  );

export const CloudDeletionTargetKindSchema = z.enum(["project", "account"]);
export const CloudDeletionStateSchema = z.enum([
  "grace_period",
  "blocked",
  "purging",
  "backup_retention",
  "purged",
  "cancelled",
]);
export const CloudDeletionPhaseSchema = z.enum([
  "freeze",
  "derived",
  "ciphertext",
  "keys",
  "access",
  "marker",
  "verify",
  "backup_wait",
  "complete",
]);
export const CloudDeletionBlockedReasonSchema = z.enum([
  "legal_hold_active",
  "ownership_transfer_required",
  "external_purge_pending",
]);

export const CloudDeletionImpactSummarySchema = z
  .object({
    projectCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    syncOperationCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    encryptedChunkCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    keyEnvelopeCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deviceCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sessionCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const CloudDeletionRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    deletionRequestId: UuidV7Schema,
    targetKind: CloudDeletionTargetKindSchema,
    targetId: UuidV7Schema,
    state: CloudDeletionStateSchema,
    phase: CloudDeletionPhaseSchema,
    revision: PositivePortableIntegerSchema,
    requestedAt: IsoUtcTimestampSchema,
    scheduledFor: IsoUtcTimestampSchema,
    cancellableUntil: IsoUtcTimestampSchema,
    commitStartedAt: IsoUtcTimestampSchema.nullable(),
    liveDataPurgedAt: IsoUtcTimestampSchema.nullable(),
    backupRetainedUntil: IsoUtcTimestampSchema.nullable(),
    completedAt: IsoUtcTimestampSchema.nullable(),
    blockedReason: CloudDeletionBlockedReasonSchema.nullable(),
    canCancel: z.boolean(),
    impactSummary: CloudDeletionImpactSummarySchema,
  })
  .strict()
  .superRefine((request, context) => {
    const requestedAt = Date.parse(request.requestedAt);
    const scheduledFor = Date.parse(request.scheduledFor);
    const cancellableUntil = Date.parse(request.cancellableUntil);
    const commitStartedAt =
      request.commitStartedAt === null ? null : Date.parse(request.commitStartedAt);
    const liveDataPurgedAt =
      request.liveDataPurgedAt === null ? null : Date.parse(request.liveDataPurgedAt);
    const backupRetainedUntil =
      request.backupRetainedUntil === null ? null : Date.parse(request.backupRetainedUntil);
    const completedAt = request.completedAt === null ? null : Date.parse(request.completedAt);

    if (requestedAt > cancellableUntil || cancellableUntil > scheduledFor) {
      context.addIssue({
        code: "custom",
        message:
          "Deletion request, cancellation deadline and scheduled execution must be chronological",
        path: ["scheduledFor"],
      });
    }
    if (commitStartedAt !== null && commitStartedAt < scheduledFor) {
      context.addIssue({
        code: "custom",
        message: "Deletion commit cannot start before its scheduled execution",
        path: ["commitStartedAt"],
      });
    }
    if (
      liveDataPurgedAt !== null &&
      (commitStartedAt === null || liveDataPurgedAt < commitStartedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Live data cannot be marked purged before deletion commit",
        path: ["liveDataPurgedAt"],
      });
    }
    if (
      backupRetainedUntil !== null &&
      (liveDataPurgedAt === null || backupRetainedUntil < liveDataPurgedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Backup retention cannot finish before live data is purged",
        path: ["backupRetainedUntil"],
      });
    }
    if (
      completedAt !== null &&
      request.state !== "cancelled" &&
      (liveDataPurgedAt === null ||
        completedAt < liveDataPurgedAt ||
        (backupRetainedUntil !== null && completedAt < backupRetainedUntil))
    ) {
      context.addIssue({
        code: "custom",
        message: "Deletion completion cannot precede live-data purge or backup retention",
        path: ["completedAt"],
      });
    }
    if (
      request.state === "cancelled" &&
      completedAt !== null &&
      (completedAt < requestedAt || completedAt > cancellableUntil)
    ) {
      context.addIssue({
        code: "custom",
        message: "Deletion cancellation must complete within the cancellable window",
        path: ["completedAt"],
      });
    }

    const stateShapeIsValid =
      (request.state === "grace_period" &&
        request.phase === "freeze" &&
        request.canCancel &&
        request.commitStartedAt === null &&
        request.liveDataPurgedAt === null &&
        request.backupRetainedUntil === null &&
        request.completedAt === null) ||
      (request.state === "blocked" &&
        request.phase === "freeze" &&
        request.canCancel &&
        request.commitStartedAt === null &&
        request.liveDataPurgedAt === null &&
        request.backupRetainedUntil === null &&
        request.completedAt === null) ||
      (request.state === "purging" &&
        ["derived", "ciphertext", "keys", "access", "marker", "verify"].includes(request.phase) &&
        !request.canCancel &&
        request.commitStartedAt !== null &&
        request.backupRetainedUntil === null &&
        request.completedAt === null &&
        (["marker", "verify"].includes(request.phase)
          ? request.liveDataPurgedAt !== null
          : request.liveDataPurgedAt === null)) ||
      (request.state === "backup_retention" &&
        request.phase === "backup_wait" &&
        !request.canCancel &&
        request.commitStartedAt !== null &&
        request.liveDataPurgedAt !== null &&
        request.backupRetainedUntil !== null &&
        request.completedAt === null) ||
      (request.state === "purged" &&
        request.phase === "complete" &&
        !request.canCancel &&
        request.commitStartedAt !== null &&
        request.liveDataPurgedAt !== null &&
        request.completedAt !== null) ||
      (request.state === "cancelled" &&
        request.phase === "freeze" &&
        !request.canCancel &&
        request.commitStartedAt === null &&
        request.liveDataPurgedAt === null &&
        request.backupRetainedUntil === null &&
        request.completedAt !== null);
    if (!stateShapeIsValid) {
      context.addIssue({
        code: "custom",
        message: "Deletion state, phase, cancellation and progress timestamps are inconsistent",
        path: ["state"],
      });
    }
    if ((request.state === "blocked") !== (request.blockedReason !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only a blocked deletion requires a blocked reason",
        path: ["blockedReason"],
      });
    }
    if (request.targetKind === "project") {
      if (request.impactSummary.projectCount !== 1) {
        context.addIssue({
          code: "custom",
          message: "A project deletion must affect exactly one project",
          path: ["impactSummary", "projectCount"],
        });
      }
      if (request.impactSummary.deviceCount !== 0 || request.impactSummary.sessionCount !== 0) {
        context.addIssue({
          code: "custom",
          message: "A project deletion cannot revoke account devices or sessions",
          path: ["impactSummary"],
        });
      }
    }
  });

export const CloudDeletionSubmissionRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
    confirmationId: UuidV7Schema,
    password: CloudPasswordSchema,
  })
  .strict();

export const CloudAccountDeletionSubmissionRequestSchema =
  CloudDeletionSubmissionRequestSchema.extend({
    email: CloudEmailAddressSchema,
  }).strict();

export const CloudDeletionCancellationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    deletionRequestId: UuidV7Schema,
    expectedDeletionRevision: PositivePortableIntegerSchema,
  })
  .strict();

const CloudAccountDeletionCredentialProofSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    email: CloudEmailAddressSchema,
    password: CloudPasswordSchema,
  })
  .strict();

export const CloudAccountDeletionLookupRequestSchema = z.union([
  CloudAccountDeletionCredentialProofSchema.extend({
    deletionRequestId: UuidV7Schema,
  }).strict(),
  CloudAccountDeletionCredentialProofSchema.extend({
    confirmationId: UuidV7Schema,
  }).strict(),
]);

export const CloudAccountDeletionCancellationRequestSchema =
  CloudDeletionCancellationRequestSchema.extend({
    email: CloudEmailAddressSchema,
    password: CloudPasswordSchema,
  }).strict();

export const CloudDeletionRequestResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    deletionRequest: CloudDeletionRequestSchema,
  })
  .strict();

export const CloudApiErrorCodeSchema = z.enum([
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_EMAIL_UNVERIFIED",
  "AUTH_RATE_LIMITED",
  "AUTH_ACCOUNT_LOCKED",
  "AUTH_ACCOUNT_FROZEN",
  "AUTH_SESSION_EXPIRED",
  "AUTH_SESSION_REVOKED",
  "AUTH_REFRESH_REPLAYED",
  "AUTH_DEVICE_REVOKED",
  "AUTH_UPGRADE_REQUIRED",
  "AUTH_NETWORK_UNAVAILABLE",
  "ACCESS_FORBIDDEN",
  "RESOURCE_NOT_FOUND",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "SYNC_CURSOR_EXPIRED",
  "SYNC_SEQUENCE_CONFLICT",
  "SYNC_INVALID_CIPHERTEXT",
  "SYNC_QUOTA_EXCEEDED",
  "AI_BUDGET_NOT_CONFIGURED",
  "AI_BUDGET_HARD_CAP",
  "AI_BUDGET_CURRENCY_LOCKED",
  "AI_CONCURRENCY_HARD_CAP",
  "AI_PRICE_VERSION_MISMATCH",
  "AI_RESERVATION_EXPIRED",
  "AI_RESERVATION_STATE_CONFLICT",
  "ENTERPRISE_LICENSE_REQUIRED",
  "ENTERPRISE_LICENSE_INVALID",
  "ENTERPRISE_POLICY_REQUIRED",
  "ENTERPRISE_POLICY_DENIED",
  "SSO_REQUIRED",
  "SSO_NOT_CONFIGURED",
  "SSO_STATE_INVALID",
  "SSO_FLOW_EXPIRED",
  "SSO_FLOW_REPLAYED",
  "SSO_CALLBACK_IN_PROGRESS",
  "SSO_PROVIDER_UNAVAILABLE",
  "SSO_TOKEN_INVALID",
  "SSO_DOMAIN_FORBIDDEN",
  "SSO_MEMBERSHIP_REQUIRED",
  "SSO_DEVICE_NOT_APPROVED",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const CloudApiErrorResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    error: z
      .object({
        code: CloudApiErrorCodeSchema,
        message: z.string().min(1).max(500),
        retryable: z.boolean(),
        actions: z.array(ErrorActionSchema).max(8),
        supportId: z.string().min(1).max(100).nullable(),
      })
      .strict(),
  })
  .strict();

export type CloudIdentityRegistrationRequest = z.infer<
  typeof CloudIdentityRegistrationRequestSchema
>;
export type CloudDeviceRegistrationInput = z.infer<typeof CloudDeviceRegistrationInputSchema>;
export type CloudDeviceContract = z.infer<typeof CloudDeviceContractSchema>;
export type CloudIdentityChallengeResponse = z.infer<typeof CloudIdentityChallengeResponseSchema>;
export type CloudIdentityVerificationRequest = z.infer<
  typeof CloudIdentityVerificationRequestSchema
>;
export type CloudPasswordResetRequest = z.infer<typeof CloudPasswordResetRequestSchema>;
export type CloudPasswordResetConfirmationRequest = z.infer<
  typeof CloudPasswordResetConfirmationRequestSchema
>;
export type CloudAuthenticationRequest = z.infer<typeof CloudAuthenticationRequestSchema>;
export type CloudSessionTokenSet = z.infer<typeof CloudSessionTokenSetSchema>;
export type CloudSessionGrantResponse = z.infer<typeof CloudSessionGrantResponseSchema>;
export type CloudSessionRefreshRequest = z.infer<typeof CloudSessionRefreshRequestSchema>;
export type CloudSessionLogoutRequest = z.infer<typeof CloudSessionLogoutRequestSchema>;
export type CloudMutationAcceptedResponse = z.infer<typeof CloudMutationAcceptedResponseSchema>;
export type CloudSessionListResponse = z.infer<typeof CloudSessionListResponseSchema>;
export type CloudDeviceRegistrationRequest = z.infer<typeof CloudDeviceRegistrationRequestSchema>;
export type CloudDeviceResponse = z.infer<typeof CloudDeviceResponseSchema>;
export type CloudDeviceListResponse = z.infer<typeof CloudDeviceListResponseSchema>;
export type CloudProjectKeyPublishRequest = z.infer<typeof CloudProjectKeyPublishRequestSchema>;
export type CloudProjectKeyPublicationReceipt = z.infer<
  typeof CloudProjectKeyPublicationReceiptSchema
>;
export type CloudProjectKeySet = z.infer<typeof CloudProjectKeySetSchema>;
export type CloudProjectKeyResponse = z.infer<typeof CloudProjectKeyResponseSchema>;
export type CloudProjectSyncState = z.infer<typeof CloudProjectSyncStateSchema>;
export type CloudProjectState = z.infer<typeof CloudProjectStateSchema>;
export type CloudProjectStateResponse = z.infer<typeof CloudProjectStateResponseSchema>;
export type CloudSyncPushRequest = z.infer<typeof CloudSyncPushRequestSchema>;
export type CloudSyncPushResponse = z.infer<typeof CloudSyncPushResponseSchema>;
export type CloudSyncPullResponse = z.infer<typeof CloudSyncPullResponseSchema>;
export type CloudSyncSnapshotResponse = z.infer<typeof CloudSyncSnapshotResponseSchema>;
export type CloudTombstoneAcknowledgementRequest = z.infer<
  typeof CloudTombstoneAcknowledgementRequestSchema
>;
export type CloudDeletionTargetKind = z.infer<typeof CloudDeletionTargetKindSchema>;
export type CloudDeletionState = z.infer<typeof CloudDeletionStateSchema>;
export type CloudDeletionPhase = z.infer<typeof CloudDeletionPhaseSchema>;
export type CloudDeletionBlockedReason = z.infer<typeof CloudDeletionBlockedReasonSchema>;
export type CloudDeletionImpactSummary = z.infer<typeof CloudDeletionImpactSummarySchema>;
export type CloudDeletionRequest = z.infer<typeof CloudDeletionRequestSchema>;
export type CloudDeletionSubmissionRequest = z.infer<typeof CloudDeletionSubmissionRequestSchema>;
export type CloudAccountDeletionSubmissionRequest = z.infer<
  typeof CloudAccountDeletionSubmissionRequestSchema
>;
export type CloudDeletionCancellationRequest = z.infer<
  typeof CloudDeletionCancellationRequestSchema
>;
export type CloudAccountDeletionLookupRequest = z.infer<
  typeof CloudAccountDeletionLookupRequestSchema
>;
export type CloudAccountDeletionCancellationRequest = z.infer<
  typeof CloudAccountDeletionCancellationRequestSchema
>;
export type CloudDeletionRequestResponse = z.infer<typeof CloudDeletionRequestResponseSchema>;
export type CloudApiErrorCode = z.infer<typeof CloudApiErrorCodeSchema>;
export type CloudApiErrorResponse = z.infer<typeof CloudApiErrorResponseSchema>;

function validateSnapshotPayload(
  snapshot: {
    readonly projectId: string;
    readonly operations: readonly z.infer<typeof SyncOperationContractSchema>[];
    readonly chunks: readonly z.infer<typeof CloudSyncChunkUploadSchema>[];
    readonly tombstones: readonly z.infer<typeof SyncTombstoneContractSchema>[];
  },
  context: z.RefinementCtx,
): void {
  const operationIds = new Set<string>();
  const chunkOwners = new Map<
    string,
    {
      readonly operation: z.infer<typeof SyncOperationContractSchema>;
      readonly position: number;
    }
  >();
  const operationsByObject = new Map<string, z.infer<typeof SyncOperationContractSchema>[]>();

  for (const [operationIndex, operation] of snapshot.operations.entries()) {
    if (operation.projectId !== snapshot.projectId) {
      context.addIssue({
        code: "custom",
        message: "Snapshot operation is outside the project scope",
        path: ["operations", operationIndex, "projectId"],
      });
    }
    if (operationIds.has(operation.operationId)) {
      context.addIssue({
        code: "custom",
        message: "Snapshot operation identifiers must be unique",
        path: ["operations", operationIndex, "operationId"],
      });
    }
    operationIds.add(operation.operationId);
    const objectKey = snapshotObjectKey(
      operation.objectType,
      operation.objectId,
      operation.objectGeneration,
    );
    const objectOperations = operationsByObject.get(objectKey) ?? [];
    objectOperations.push(operation);
    operationsByObject.set(objectKey, objectOperations);
    for (const [position, chunkId] of operation.encryptedChunkIds.entries()) {
      if (chunkOwners.has(chunkId)) {
        context.addIssue({
          code: "custom",
          message: "Snapshot ciphertext chunks must have exactly one operation owner",
          path: ["operations", operationIndex, "encryptedChunkIds", position],
        });
      } else {
        chunkOwners.set(chunkId, { operation, position });
      }
    }
  }

  const chunksById = new Map<string, z.infer<typeof CloudSyncChunkUploadSchema>>();
  const firstChunkByOperation = new Map<string, z.infer<typeof CloudSyncChunkUploadSchema>>();
  for (const [chunkIndex, chunk] of snapshot.chunks.entries()) {
    if (chunksById.has(chunk.chunkId)) {
      context.addIssue({
        code: "custom",
        message: "Snapshot ciphertext chunk identifiers must be unique",
        path: ["chunks", chunkIndex, "chunkId"],
      });
    }
    chunksById.set(chunk.chunkId, chunk);
    const owner = chunkOwners.get(chunk.chunkId);
    if (
      owner === undefined ||
      chunk.encrypted.aad.projectId !== snapshot.projectId ||
      chunk.encrypted.aad.objectType !== owner.operation.objectType ||
      chunk.encrypted.aad.objectId !== owner.operation.objectId ||
      chunk.encrypted.aad.chunkIndex !== owner.position
    ) {
      context.addIssue({
        code: "custom",
        message: "Snapshot ciphertext ownership does not match its operation",
        path: ["chunks", chunkIndex, "encrypted", "aad"],
      });
      continue;
    }
    const first = firstChunkByOperation.get(owner.operation.operationId);
    if (first === undefined) {
      firstChunkByOperation.set(owner.operation.operationId, chunk);
    } else if (
      chunk.encrypted.aad.objectType !== first.encrypted.aad.objectType ||
      chunk.encrypted.aad.versionId !== first.encrypted.aad.versionId ||
      chunk.encrypted.aad.keyVersion !== first.encrypted.aad.keyVersion
    ) {
      context.addIssue({
        code: "custom",
        message: "Snapshot operation chunks must form one ordered ciphertext set",
        path: ["chunks", chunkIndex, "encrypted", "aad"],
      });
    }
  }
  if (
    chunksById.size !== chunkOwners.size ||
    [...chunkOwners.keys()].some((chunkId) => !chunksById.has(chunkId))
  ) {
    context.addIssue({
      code: "custom",
      message: "Snapshot must contain the exact ciphertext set referenced by operations",
      path: ["chunks"],
    });
  }

  const tombstoneKeys = new Set<string>();
  const matchedDeleteOperationIds = new Set<string>();
  for (const [tombstoneIndex, tombstone] of snapshot.tombstones.entries()) {
    const key = snapshotObjectKey(
      tombstone.objectType,
      tombstone.objectId,
      tombstone.objectGeneration,
    );
    const matchingDeletes = (operationsByObject.get(key) ?? []).filter(
      (operation) =>
        operation.kind === "delete" &&
        tombstone.objectType === operation.objectType &&
        tombstone.deletedByDeviceId === operation.deviceId &&
        sameVersionVector(tombstone.vector, operation.vector),
    );
    if (
      tombstone.projectId !== snapshot.projectId ||
      tombstoneKeys.has(key) ||
      matchingDeletes.length !== 1
    ) {
      context.addIssue({
        code: "custom",
        message: "Snapshot tombstone does not match one exact delete operation",
        path: ["tombstones", tombstoneIndex],
      });
    } else {
      matchedDeleteOperationIds.add(matchingDeletes[0]?.operationId ?? "");
    }
    tombstoneKeys.add(key);
  }
  for (const [operationIndex, operation] of snapshot.operations.entries()) {
    if (operation.kind === "delete" && !matchedDeleteOperationIds.has(operation.operationId)) {
      context.addIssue({
        code: "custom",
        message: "Every snapshot delete operation must carry its exact tombstone",
        path: ["operations", operationIndex, "kind"],
      });
    }
  }
}

function snapshotObjectKey(
  objectType: z.infer<typeof SyncOperationContractSchema>["objectType"],
  objectId: string,
  objectGeneration: number,
): string {
  return `${objectType}:${objectId}:${String(objectGeneration)}`;
}

function sameVersionVector(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([deviceId, sequence]) => right[deviceId] === sequence)
  );
}
