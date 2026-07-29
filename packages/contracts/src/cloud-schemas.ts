import { z } from "zod";

import { CONTRACT_SCHEMA_VERSION, IsoUtcTimestampSchema, UuidV7Schema } from "./schemas.js";

export const ReleaseTierSchema = z.enum(["community", "pro", "studio", "enterprise"]);
export const SubscriptionStateSchema = z.enum([
  "none",
  "trialing",
  "active",
  "past_due",
  "grace",
  "expired",
  "canceled",
  "refunded",
  "offline_expired",
]);
export const ProductCapabilitySchema = z.enum([
  "local.read",
  "local.edit",
  "local.version",
  "local.backup",
  "local.export",
  "ai.local",
  "ai.byok",
  "sync.e2ee",
  "ai.advanced",
  "story.graphrag",
  "team.workspace",
  "team.review",
  "team.audit",
  "team.budget",
  "enterprise.sso",
  "enterprise.private_deployment",
  "enterprise.policy",
]);

export const MAX_PORTABLE_INTEGER = Number.MAX_SAFE_INTEGER;
export const PositivePortableIntegerSchema = z.number().int().positive().max(MAX_PORTABLE_INTEGER);

export const VersionVectorSchema = z
  .record(UuidV7Schema, PositivePortableIntegerSchema)
  .refine((vector) => Object.keys(vector).length <= 1_024, {
    message: "Version vector exceeds the supported device count",
  });

export const SyncObjectTypeSchema = z.enum([
  "project_manifest",
  "chapter_version",
  "story_record",
  "outline",
  "memory",
  "material",
  "attachment",
]);

export const SYNC_PROTOCOL_SCHEMA_VERSION = 2 as const;

export const SyncChunkAadSchema = z
  .object({
    projectId: UuidV7Schema,
    objectType: SyncObjectTypeSchema,
    objectId: UuidV7Schema,
    versionId: UuidV7Schema,
    chunkIndex: z.number().int().nonnegative(),
    keyVersion: z.number().int().positive(),
  })
  .strict();

export const EncryptedSyncChunkContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    algorithm: z.literal("AES-256-GCM"),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .max(8_000_000),
    ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    plaintextBytes: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
    aad: SyncChunkAadSchema,
  })
  .strict();

export const SyncOperationContractSchema = z
  .object({
    schemaVersion: z.literal(SYNC_PROTOCOL_SCHEMA_VERSION),
    operationId: UuidV7Schema,
    projectId: UuidV7Schema,
    deviceId: UuidV7Schema,
    deviceSequence: PositivePortableIntegerSchema,
    objectType: SyncObjectTypeSchema,
    objectId: UuidV7Schema,
    objectGeneration: PositivePortableIntegerSchema,
    kind: z.enum(["upsert", "delete"]),
    vector: VersionVectorSchema,
    encryptedChunkIds: z.array(UuidV7Schema).max(10_000),
    createdAt: IsoUtcTimestampSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.vector[operation.deviceId] !== operation.deviceSequence) {
      context.addIssue({
        code: "custom",
        message: "Device sequence must match its version-vector counter",
        path: ["deviceSequence"],
      });
    }
    const uniqueChunks = new Set(operation.encryptedChunkIds);
    if (uniqueChunks.size !== operation.encryptedChunkIds.length) {
      context.addIssue({
        code: "custom",
        message: "Encrypted chunk identifiers must be unique",
        path: ["encryptedChunkIds"],
      });
    }
    if (
      (operation.kind === "upsert" && operation.encryptedChunkIds.length === 0) ||
      (operation.kind === "delete" && operation.encryptedChunkIds.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only upserts carry ciphertext chunks",
        path: ["encryptedChunkIds"],
      });
    }
  });

export const SyncTombstoneContractSchema = z
  .object({
    schemaVersion: z.literal(SYNC_PROTOCOL_SCHEMA_VERSION),
    projectId: UuidV7Schema,
    objectType: SyncObjectTypeSchema,
    objectId: UuidV7Schema,
    objectGeneration: PositivePortableIntegerSchema,
    deletedByDeviceId: UuidV7Schema,
    vector: VersionVectorSchema,
    deletedAt: IsoUtcTimestampSchema,
    retainUntil: IsoUtcTimestampSchema,
    acknowledgedDeviceIds: z.array(UuidV7Schema).max(1_024),
  })
  .strict()
  .superRefine((tombstone, context) => {
    const minimumRetention = 365 * 24 * 60 * 60 * 1_000;
    if (Date.parse(tombstone.retainUntil) - Date.parse(tombstone.deletedAt) < minimumRetention) {
      context.addIssue({
        code: "custom",
        message: "Tombstone retention must be at least 365 days",
        path: ["retainUntil"],
      });
    }
    if (new Set(tombstone.acknowledgedDeviceIds).size !== tombstone.acknowledgedDeviceIds.length) {
      context.addIssue({
        code: "custom",
        message: "Acknowledged devices must be unique",
        path: ["acknowledgedDeviceIds"],
      });
    }
  });

export const CloudAccountStateSchema = z.enum([
  "pending_verification",
  "active",
  "locked",
  "frozen",
  "deletion_scheduled",
  "deleted",
]);

export const CloudAccountContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    accountId: UuidV7Schema,
    state: CloudAccountStateSchema,
    revision: z.number().int().positive(),
    verifiedAt: IsoUtcTimestampSchema.nullable(),
    deletionScheduledFor: IsoUtcTimestampSchema.nullable(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict()
  .superRefine((account, context) => {
    if (
      (account.state === "pending_verification") !== (account.verifiedAt === null) ||
      (account.state === "deletion_scheduled") !== (account.deletionScheduledFor !== null) ||
      Date.parse(account.updatedAt) < Date.parse(account.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Cloud account lifecycle timestamps are inconsistent",
        path: ["state"],
      });
    }
  });

export const RegisteredDeviceContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    deviceId: UuidV7Schema,
    accountId: UuidV7Schema,
    state: z.enum(["trusted", "revoked"]),
    publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: IsoUtcTimestampSchema,
    revokedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((device, context) => {
    if ((device.state === "revoked") !== (device.revokedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Revoked device and revokedAt must agree",
        path: ["revokedAt"],
      });
    }
  });

export const RegisteredDevicePublicKeyContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    deviceId: UuidV7Schema,
    accountId: UuidV7Schema,
    algorithm: z.literal("DHKEM-P256-HKDF-SHA256"),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: IsoUtcTimestampSchema,
    revokedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .refine(
    (record) =>
      record.revokedAt === null || Date.parse(record.revokedAt) >= Date.parse(record.createdAt),
    {
      message: "Device public-key revocation cannot predate creation",
      path: ["revokedAt"],
    },
  );

export const ProjectKeyVersionContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    projectId: UuidV7Schema,
    keyVersion: z.number().int().positive().max(2_147_483_647),
    algorithm: z.literal("AES-256-GCM"),
    state: z.enum(["pending_confirmation", "active", "retiring", "retired"]),
    revision: z.number().int().positive(),
    createdAt: IsoUtcTimestampSchema,
    retiredAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((version, context) => {
    if (
      (version.state === "retired") !== (version.retiredAt !== null) ||
      (version.retiredAt !== null && Date.parse(version.retiredAt) < Date.parse(version.createdAt))
    ) {
      context.addIssue({
        code: "custom",
        message: "Project key version lifecycle timestamps are inconsistent",
        path: ["retiredAt"],
      });
    }
  });

export const DeviceProjectKeyEnvelopeContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    algorithm: z.literal("HPKE-AUTH-P256-HKDF-SHA256-AES128GCM"),
    envelopeId: UuidV7Schema,
    projectId: UuidV7Schema,
    keyVersion: z.number().int().positive().max(2_147_483_647),
    senderDeviceId: UuidV7Schema,
    senderPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    senderPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    recipientDeviceId: UuidV7Schema,
    recipientPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    recipientPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    encapsulatedKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{64}$/u),
    createdAt: IsoUtcTimestampSchema,
    revokedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .refine(
    (envelope) =>
      envelope.revokedAt === null ||
      Date.parse(envelope.revokedAt) >= Date.parse(envelope.createdAt),
    {
      message: "Device key-envelope revocation cannot predate creation",
      path: ["revokedAt"],
    },
  );

export const RecoveryKdfParametersContractSchema = z
  .object({
    algorithm: z.literal("ARGON2ID"),
    version: z.literal(19),
    memoryKib: z.literal(65_536),
    timeCost: z.literal(3),
    parallelism: z.literal(4),
    outputBytes: z.literal(64),
  })
  .strict();

export const RecoveryProjectKeyEnvelopeContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    algorithm: z.literal("ARGON2ID-AES256GCM"),
    recoveryId: UuidV7Schema,
    projectId: UuidV7Schema,
    keyVersion: z.number().int().positive().max(2_147_483_647),
    kdf: RecoveryKdfParametersContractSchema,
    salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{64}$/u),
    verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    createdAt: IsoUtcTimestampSchema,
    confirmedAt: IsoUtcTimestampSchema.nullable(),
    revokedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (
      (envelope.confirmedAt !== null &&
        Date.parse(envelope.confirmedAt) < Date.parse(envelope.createdAt)) ||
      (envelope.revokedAt !== null &&
        Date.parse(envelope.revokedAt) < Date.parse(envelope.createdAt))
    ) {
      context.addIssue({
        code: "custom",
        message: "Recovery key-envelope lifecycle timestamps are inconsistent",
        path: ["confirmedAt"],
      });
    }
  });

export const CloudSessionContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    sessionId: UuidV7Schema,
    accountId: UuidV7Schema,
    deviceId: UuidV7Schema,
    clientVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u),
    minimumClientVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u),
    issuedAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
    revokedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .refine((session) => Date.parse(session.expiresAt) > Date.parse(session.issuedAt), {
    message: "Session expiry must follow issuance",
    path: ["expiresAt"],
  });

export const OfflineLicensePayloadContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    licenseId: UuidV7Schema,
    product: z.literal("inkshadow"),
    keyId: z.string().min(1).max(256),
    deviceId: UuidV7Schema,
    tier: ReleaseTierSchema,
    issuedAt: IsoUtcTimestampSchema,
    notBefore: IsoUtcTimestampSchema,
    validUntil: IsoUtcTimestampSchema,
    graceUntil: IsoUtcTimestampSchema,
    capabilities: z.array(ProductCapabilitySchema).max(256),
    featureFlags: z.array(z.string().min(1).max(256)).max(256),
  })
  .strict()
  .superRefine((license, context) => {
    if (
      Date.parse(license.notBefore) < Date.parse(license.issuedAt) ||
      Date.parse(license.validUntil) < Date.parse(license.notBefore) ||
      Date.parse(license.graceUntil) < Date.parse(license.validUntil)
    ) {
      context.addIssue({
        code: "custom",
        message: "Offline license validity window is inconsistent",
        path: ["validUntil"],
      });
    }
    if (
      new Set(license.capabilities).size !== license.capabilities.length ||
      new Set(license.featureFlags).size !== license.featureFlags.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Offline license grants must be unique",
        path: ["capabilities"],
      });
    }
  });

export const SignedOfflineLicenseContractSchema = z
  .object({
    payload: OfflineLicensePayloadContractSchema,
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .max(1_024),
  })
  .strict();

export const TeamRoleSchema = z.enum([
  "owner",
  "admin",
  "author",
  "reviewer",
  "read_only",
  "finance_admin",
]);

export const TeamMembershipContractSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    membershipId: UuidV7Schema,
    accountId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    role: TeamRoleSchema,
    state: z.enum(["active", "revoked"]),
    projectIds: z.array(UuidV7Schema).max(10_000).nullable(),
    createdAt: IsoUtcTimestampSchema,
    revokedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((membership, context) => {
    if ((membership.state === "revoked") !== (membership.revokedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Revoked membership and revokedAt must agree",
        path: ["revokedAt"],
      });
    }
    if (
      membership.projectIds !== null &&
      new Set(membership.projectIds).size !== membership.projectIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Membership project scope must be unique",
        path: ["projectIds"],
      });
    }
  });

export type EncryptedSyncChunkContract = z.infer<typeof EncryptedSyncChunkContractSchema>;
export type SyncObjectType = z.infer<typeof SyncObjectTypeSchema>;
export type SyncOperationContract = z.infer<typeof SyncOperationContractSchema>;
export type SyncTombstoneContract = z.infer<typeof SyncTombstoneContractSchema>;
export type CloudAccountContract = z.infer<typeof CloudAccountContractSchema>;
export type RegisteredDeviceContract = z.infer<typeof RegisteredDeviceContractSchema>;
export type RegisteredDevicePublicKeyContract = z.infer<
  typeof RegisteredDevicePublicKeyContractSchema
>;
export type ProjectKeyVersionContract = z.infer<typeof ProjectKeyVersionContractSchema>;
export type DeviceProjectKeyEnvelopeContract = z.infer<
  typeof DeviceProjectKeyEnvelopeContractSchema
>;
export type RecoveryKdfParametersContract = z.infer<typeof RecoveryKdfParametersContractSchema>;
export type RecoveryProjectKeyEnvelopeContract = z.infer<
  typeof RecoveryProjectKeyEnvelopeContractSchema
>;
export type CloudSessionContract = z.infer<typeof CloudSessionContractSchema>;
export type SignedOfflineLicenseContract = z.infer<typeof SignedOfflineLicenseContractSchema>;
export type TeamMembershipContract = z.infer<typeof TeamMembershipContractSchema>;
