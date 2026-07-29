import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { projects } from "./schema.js";

export const syncCiphertextChunks = sqliteTable(
  "sync_ciphertext_chunks",
  {
    chunkId: text("chunk_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    versionId: text("version_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    keyVersion: integer("key_version").notNull(),
    algorithm: text("algorithm", { enum: ["AES-256-GCM"] }).notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    ciphertextSha256: text("ciphertext_sha256").notNull(),
    plaintextBytes: integer("plaintext_bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("sync_chunks_index", sql`${table.chunkIndex} >= 0`),
    check("sync_chunks_key_version", sql`${table.keyVersion} >= 1`),
    check("sync_chunks_plaintext_bytes", sql`${table.plaintextBytes} BETWEEN 0 AND 4194304`),
    check("sync_chunks_hash", sql`length(${table.ciphertextSha256}) = 64`),
    uniqueIndex("sync_chunks_object_unique").on(
      table.projectId,
      table.objectType,
      table.objectId,
      table.versionId,
      table.chunkIndex,
      table.keyVersion,
    ),
    index("sync_chunks_object_idx").on(
      table.projectId,
      table.objectType,
      table.objectId,
      table.versionId,
      table.chunkIndex,
    ),
  ],
);

export const syncOutboxOperations = sqliteTable(
  "sync_outbox_operations",
  {
    operationId: text("operation_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    deviceSequence: integer("device_sequence").notNull(),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    objectGeneration: integer("object_generation").notNull(),
    kind: text("kind", { enum: ["upsert", "delete"] }).notNull(),
    vectorJson: text("vector_json").notNull(),
    status: text("status", {
      enum: ["queued", "in_flight", "acknowledged", "failed", "paused"],
    }).notNull(),
    attempt: integer("attempt").notNull(),
    nextAttemptAt: text("next_attempt_at"),
    leaseOwnerId: text("lease_owner_id"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    failureCode: text("failure_code"),
    acknowledgedAt: text("acknowledged_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("sync_outbox_sequence", sql`${table.deviceSequence} >= 1`),
    check("sync_outbox_generation", sql`${table.objectGeneration} >= 1`),
    check("sync_outbox_attempt", sql`${table.attempt} BETWEEN 0 AND 100`),
    uniqueIndex("sync_outbox_device_sequence_unique").on(
      table.projectId,
      table.deviceId,
      table.deviceSequence,
    ),
    index("sync_outbox_runnable_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    index("sync_outbox_expired_lease_idx").on(table.status, table.leaseExpiresAt),
  ],
);

export const syncOperationChunks = sqliteTable(
  "sync_operation_chunks",
  {
    operationId: text("operation_id")
      .notNull()
      .references(() => syncOutboxOperations.operationId, { onDelete: "cascade" }),
    chunkId: text("chunk_id")
      .notNull()
      .references(() => syncCiphertextChunks.chunkId, { onDelete: "restrict" }),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.chunkId] }),
    check("sync_operation_chunks_position", sql`${table.position} >= 0`),
    uniqueIndex("sync_operation_chunks_position_unique").on(table.operationId, table.position),
  ],
);

export const syncTombstones = sqliteTable(
  "sync_tombstones",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    objectGeneration: integer("object_generation").notNull(),
    deletedByDeviceId: text("deleted_by_device_id").notNull(),
    vectorJson: text("vector_json").notNull(),
    deletedAt: text("deleted_at").notNull(),
    retainUntil: text("retain_until").notNull(),
    acknowledgedDeviceIdsJson: text("acknowledged_device_ids_json").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.objectType, table.objectId, table.objectGeneration],
    }),
    check("sync_tombstones_generation", sql`${table.objectGeneration} >= 1`),
    index("sync_tombstones_retention_idx").on(table.retainUntil, table.projectId, table.objectType),
  ],
);

export const syncTransfers = sqliteTable(
  "sync_transfers",
  {
    transferId: text("transfer_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    objectId: text("object_id").notNull(),
    versionId: text("version_id").notNull(),
    status: text("status", {
      enum: ["pending", "in_flight", "paused", "completed", "failed"],
    }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("sync_transfers_status_idx").on(table.status, table.updatedAt)],
);

export const syncTransferChunks = sqliteTable(
  "sync_transfer_chunks",
  {
    transferId: text("transfer_id")
      .notNull()
      .references(() => syncTransfers.transferId, { onDelete: "cascade" }),
    chunkId: text("chunk_id")
      .notNull()
      .references(() => syncCiphertextChunks.chunkId, { onDelete: "restrict" }),
    chunkIndex: integer("chunk_index").notNull(),
    ciphertextBytes: integer("ciphertext_bytes").notNull(),
    ciphertextSha256: text("ciphertext_sha256").notNull(),
    remoteEtag: text("remote_etag"),
    acknowledgedAt: text("acknowledged_at"),
  },
  (table) => [
    primaryKey({ columns: [table.transferId, table.chunkId] }),
    check("sync_transfer_chunks_index", sql`${table.chunkIndex} >= 0`),
    check("sync_transfer_chunks_bytes", sql`${table.ciphertextBytes} >= 1`),
    uniqueIndex("sync_transfer_chunks_index_unique").on(table.transferId, table.chunkIndex),
  ],
);

export const syncRemoteCheckpoints = sqliteTable(
  "sync_remote_checkpoints",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    signedRemoteCursor: text("signed_remote_cursor").notNull(),
    revision: integer("revision").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "sync_remote_checkpoints_cursor",
      sql`length(${table.signedRemoteCursor}) BETWEEN 1 AND 512`,
    ),
    check("sync_remote_checkpoints_revision", sql`${table.revision} >= 1`),
  ],
);

export const syncDeviceSequences = sqliteTable(
  "sync_device_sequences",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    lastAllocatedSequence: integer("last_allocated_sequence").notNull(),
    revision: integer("revision").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.deviceId] }),
    check("sync_device_sequences_value", sql`${table.lastAllocatedSequence} >= 1`),
    check("sync_device_sequences_revision", sql`${table.revision} >= 1`),
  ],
);

export const syncIncomingBatches = sqliteTable(
  "sync_incoming_batches",
  {
    batchId: text("batch_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    priorSignedRemoteCursor: text("prior_signed_remote_cursor"),
    nextSignedRemoteCursor: text("next_signed_remote_cursor").notNull(),
    responseDigest: text("response_digest").notNull(),
    requestId: text("request_id").notNull(),
    hasMore: integer("has_more", { mode: "boolean" }).notNull(),
    operationCount: integer("operation_count").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    tombstoneCount: integer("tombstone_count").notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (table) => [
    check("sync_incoming_batches_id", sql`length(${table.batchId}) = 64`),
    check("sync_incoming_batches_digest", sql`length(${table.responseDigest}) = 64`),
    uniqueIndex("sync_incoming_batches_batch_project_unique").on(table.batchId, table.projectId),
    uniqueIndex("sync_incoming_batches_project_cursor_unique").on(
      table.projectId,
      table.nextSignedRemoteCursor,
    ),
    index("sync_incoming_batches_project_received_idx").on(
      table.projectId,
      table.receivedAt,
      table.batchId,
    ),
  ],
);

export const syncIncrementalTerminalObservations = sqliteTable(
  "sync_incremental_terminal_observations",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    signedRemoteCursor: text("signed_remote_cursor").notNull(),
    downloadedCheckpointRevision: integer("downloaded_checkpoint_revision").notNull(),
    responseDigest: text("response_digest").notNull(),
    requestId: text("request_id").notNull(),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.signedRemoteCursor, table.downloadedCheckpointRevision],
    }),
    check(
      "sync_incremental_terminal_observations_revision",
      sql`${table.downloadedCheckpointRevision} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "sync_incremental_terminal_observations_cursor",
      sql`length(${table.signedRemoteCursor}) BETWEEN 1 AND 512
        AND ${table.signedRemoteCursor} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "sync_incremental_terminal_observations_digest",
      sql`length(${table.responseDigest}) = 64
        AND ${table.responseDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "sync_incremental_terminal_observations_request",
      sql`length(${table.requestId}) BETWEEN 1 AND 200`,
    ),
    check(
      "sync_incremental_terminal_observations_observed_at",
      sql`julianday(${table.observedAt}) IS NOT NULL`,
    ),
    uniqueIndex("sync_incremental_terminal_observations_project_revision_unique").on(
      table.projectId,
      table.downloadedCheckpointRevision,
    ),
    index("sync_incremental_terminal_observations_project_observed_idx").on(
      table.projectId,
      table.observedAt,
      table.downloadedCheckpointRevision,
    ),
  ],
);

export const syncInboxOperations = sqliteTable(
  "sync_inbox_operations",
  {
    operationId: text("operation_id").primaryKey(),
    batchId: text("batch_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    deviceSequence: integer("device_sequence").notNull(),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    objectGeneration: integer("object_generation").notNull(),
    kind: text("kind", { enum: ["upsert", "delete"] }).notNull(),
    vectorJson: text("vector_json").notNull(),
    operationCreatedAt: text("operation_created_at").notNull(),
    status: text("status", {
      enum: ["received", "applying", "applied", "conflict", "failed"],
    }).notNull(),
    attempt: integer("attempt").notNull(),
    nextAttemptAt: text("next_attempt_at"),
    leaseOwnerId: text("lease_owner_id"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    resolutionToken: text("resolution_token"),
    conflictCode: text("conflict_code"),
    failureCode: text("failure_code"),
    receivedAt: text("received_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.batchId, table.projectId],
      foreignColumns: [syncIncomingBatches.batchId, syncIncomingBatches.projectId],
    }).onDelete("cascade"),
    check("sync_inbox_operations_sequence", sql`${table.deviceSequence} >= 1`),
    check("sync_inbox_operations_generation", sql`${table.objectGeneration} >= 1`),
    uniqueIndex("sync_inbox_operations_device_sequence_unique").on(
      table.projectId,
      table.deviceId,
      table.deviceSequence,
    ),
    index("sync_inbox_runnable_idx").on(
      table.projectId,
      table.status,
      table.nextAttemptAt,
      table.receivedAt,
    ),
  ],
);

export const syncInboxOperationChunks = sqliteTable(
  "sync_inbox_operation_chunks",
  {
    operationId: text("operation_id")
      .notNull()
      .references(() => syncInboxOperations.operationId, { onDelete: "cascade" }),
    chunkId: text("chunk_id")
      .notNull()
      .references(() => syncCiphertextChunks.chunkId, { onDelete: "restrict" }),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.chunkId] }),
    check("sync_inbox_operation_chunks_position", sql`${table.position} >= 0`),
    uniqueIndex("sync_inbox_operation_chunks_position_unique").on(
      table.operationId,
      table.position,
    ),
  ],
);

export const cloudAccountSnapshots = sqliteTable(
  "cloud_account_snapshots",
  {
    accountId: text("account_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    state: text("state", {
      enum: ["pending_verification", "active", "locked", "frozen", "deletion_scheduled", "deleted"],
    }).notNull(),
    revision: integer("revision").notNull(),
    verifiedAt: text("verified_at"),
    deletionScheduledFor: text("deletion_scheduled_for"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("cloud_accounts_schema_version", sql`${table.schemaVersion} = 1`),
    check("cloud_accounts_revision", sql`${table.revision} >= 1`),
  ],
);

export const registeredDeviceSnapshots = sqliteTable(
  "registered_device_snapshots",
  {
    deviceId: text("device_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => cloudAccountSnapshots.accountId, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull(),
    state: text("state", { enum: ["trusted", "revoked"] }).notNull(),
    publicKeyFingerprint: text("public_key_fingerprint").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    check("registered_devices_schema_version", sql`${table.schemaVersion} = 1`),
    check("registered_devices_fingerprint", sql`length(${table.publicKeyFingerprint}) = 64`),
    index("registered_devices_account_idx").on(table.accountId, table.state),
  ],
);

export const cloudSessionSnapshots = sqliteTable(
  "cloud_session_snapshots",
  {
    sessionId: text("session_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => cloudAccountSnapshots.accountId, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => registeredDeviceSnapshots.deviceId, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull(),
    clientVersion: text("client_version").notNull(),
    minimumClientVersion: text("minimum_client_version").notNull(),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    check("cloud_sessions_schema_version", sql`${table.schemaVersion} = 1`),
    index("cloud_sessions_account_device_idx").on(table.accountId, table.deviceId, table.expiresAt),
  ],
);

export const entitlementCache = sqliteTable("entitlement_cache", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => cloudAccountSnapshots.accountId, { onDelete: "cascade" }),
  tier: text("tier", { enum: ["community", "pro", "studio", "enterprise"] }).notNull(),
  subscriptionState: text("subscription_state", {
    enum: [
      "none",
      "trialing",
      "active",
      "past_due",
      "grace",
      "expired",
      "canceled",
      "refunded",
      "offline_expired",
    ],
  }).notNull(),
  grantedCapabilitiesJson: text("granted_capabilities_json").notNull(),
  enabledFlagsJson: text("enabled_flags_json").notNull(),
  observedAt: text("observed_at").notNull(),
});

export const offlineLicenseEnvelopes = sqliteTable(
  "offline_license_envelopes",
  {
    licenseId: text("license_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => cloudAccountSnapshots.accountId, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => registeredDeviceSnapshots.deviceId, { onDelete: "cascade" }),
    envelopeJson: text("envelope_json").notNull(),
    savedAt: text("saved_at").notNull(),
  },
  (table) => [index("offline_licenses_account_device_idx").on(table.accountId, table.deviceId)],
);

export const teamMembershipSnapshots = sqliteTable(
  "team_membership_snapshots",
  {
    membershipId: text("membership_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => cloudAccountSnapshots.accountId, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull(),
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id").notNull(),
    role: text("role", {
      enum: ["owner", "admin", "author", "reviewer", "read_only", "finance_admin"],
    }).notNull(),
    state: text("state", { enum: ["active", "revoked"] }).notNull(),
    projectIdsJson: text("project_ids_json"),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    check("team_memberships_schema_version", sql`${table.schemaVersion} = 1`),
    index("team_memberships_scope_idx").on(
      table.accountId,
      table.tenantId,
      table.teamId,
      table.state,
    ),
  ],
);

export const devicePublicKeyRecords = sqliteTable(
  "device_public_key_records",
  {
    deviceId: text("device_id").primaryKey(),
    accountId: text("account_id").references(() => cloudAccountSnapshots.accountId, {
      onDelete: "set null",
    }),
    schemaVersion: integer("schema_version").notNull(),
    algorithm: text("algorithm", { enum: ["DHKEM-P256-HKDF-SHA256"] }).notNull(),
    publicKey: text("public_key").notNull(),
    publicKeyFingerprint: text("public_key_fingerprint").notNull(),
    displayName: text("display_name").notNull(),
    keyOrigin: text("key_origin", {
      enum: ["local_os_credential", "remote_registered"],
    }).notNull(),
    state: text("state", {
      enum: ["trusted", "revoked", "credential_missing"],
    }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    check("device_public_keys_schema_version", sql`${table.schemaVersion} = 1`),
    check("device_public_keys_encoded", sql`length(${table.publicKey}) = 87`),
    check("device_public_keys_fingerprint", sql`length(${table.publicKeyFingerprint}) = 64`),
    check(
      "device_public_keys_display_name",
      sql`length(trim(${table.displayName})) BETWEEN 1 AND 80`,
    ),
    uniqueIndex("device_public_keys_fingerprint_unique").on(table.publicKeyFingerprint),
    index("device_public_keys_account_state_idx").on(table.accountId, table.state),
  ],
);

export const projectKeyVersions = sqliteTable(
  "project_key_versions",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyVersion: integer("key_version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    algorithm: text("algorithm", { enum: ["AES-256-GCM"] }).notNull(),
    state: text("state", {
      enum: ["pending_confirmation", "active", "retiring", "retired"],
    }).notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    retiredAt: text("retired_at"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.keyVersion] }),
    check("project_key_versions_schema_version", sql`${table.schemaVersion} = 1`),
    check("project_key_versions_number", sql`${table.keyVersion} BETWEEN 1 AND 2147483647`),
    check("project_key_versions_revision", sql`${table.revision} >= 1`),
    uniqueIndex("project_key_versions_one_active_idx")
      .on(table.projectId)
      .where(sql`${table.state} = 'active'`),
  ],
);

export const cloudProjectKeyCheckpoints = sqliteTable(
  "cloud_project_key_checkpoints",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    currentKeyVersion: integer("current_key_version").notNull(),
    serverRevision: integer("server_revision").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.currentKeyVersion],
      foreignColumns: [projectKeyVersions.projectId, projectKeyVersions.keyVersion],
    }).onDelete("cascade"),
    check(
      "cloud_project_key_checkpoints_key_version",
      sql`${table.currentKeyVersion} BETWEEN 1 AND 2147483647`,
    ),
    check(
      "cloud_project_key_checkpoints_server_revision",
      sql`${table.serverRevision} BETWEEN 1 AND 2147483647`,
    ),
  ],
);

export const cloudProjectKeyPublications = sqliteTable(
  "cloud_project_key_publications",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyVersion: integer("key_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expectedServerRevision: integer("expected_server_revision"),
    requestJson: text("request_json").notNull(),
    state: text("state", { enum: ["pending", "conflicted"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.keyVersion] }),
    foreignKey({
      columns: [table.projectId, table.keyVersion],
      foreignColumns: [projectKeyVersions.projectId, projectKeyVersions.keyVersion],
    }).onDelete("cascade"),
    uniqueIndex("cloud_project_key_publications_idempotency_idx").on(table.idempotencyKey),
    index("cloud_project_key_publications_state_idx").on(table.state, table.updatedAt),
    check(
      "cloud_project_key_publications_key_version",
      sql`${table.keyVersion} BETWEEN 1 AND 2147483647`,
    ),
    check(
      "cloud_project_key_publications_expected_revision",
      sql`${table.expectedServerRevision} IS NULL OR ${table.expectedServerRevision} BETWEEN 1 AND 2147483647`,
    ),
    check(
      "cloud_project_key_publications_request_size",
      sql`length(${table.requestJson}) BETWEEN 2 AND 4194304`,
    ),
    check(
      "cloud_project_key_publications_route",
      sql`(${table.keyVersion} = 1 AND ${table.expectedServerRevision} IS NULL) OR (${table.keyVersion} > 1 AND ${table.expectedServerRevision} IS NOT NULL)`,
    ),
    check(
      "cloud_project_key_publications_state_error",
      sql`(${table.state} = 'pending' AND ${table.lastErrorCode} IS NULL) OR (${table.state} = 'conflicted' AND ${table.lastErrorCode} IS NOT NULL)`,
    ),
  ],
);

export const projectDeviceKeyEnvelopes = sqliteTable(
  "project_device_key_envelopes",
  {
    envelopeId: text("envelope_id").primaryKey(),
    projectId: text("project_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    algorithm: text("algorithm", {
      enum: ["HPKE-AUTH-P256-HKDF-SHA256-AES128GCM"],
    }).notNull(),
    senderDeviceId: text("sender_device_id")
      .notNull()
      .references(() => devicePublicKeyRecords.deviceId, { onDelete: "restrict" }),
    senderPublicKey: text("sender_public_key").notNull(),
    senderPublicKeyFingerprint: text("sender_public_key_fingerprint").notNull(),
    recipientDeviceId: text("recipient_device_id")
      .notNull()
      .references(() => devicePublicKeyRecords.deviceId, { onDelete: "restrict" }),
    recipientPublicKey: text("recipient_public_key").notNull(),
    recipientPublicKeyFingerprint: text("recipient_public_key_fingerprint").notNull(),
    encapsulatedKey: text("encapsulated_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.keyVersion],
      foreignColumns: [projectKeyVersions.projectId, projectKeyVersions.keyVersion],
    }).onDelete("cascade"),
    check("project_device_envelopes_schema_version", sql`${table.schemaVersion} = 1`),
    uniqueIndex("project_device_envelopes_one_current_idx")
      .on(table.projectId, table.keyVersion, table.recipientDeviceId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("project_device_envelopes_sender_idx").on(table.senderDeviceId, table.createdAt),
  ],
);

export const projectRecoveryKeyEnvelopes = sqliteTable(
  "project_recovery_key_envelopes",
  {
    recoveryId: text("recovery_id").primaryKey(),
    projectId: text("project_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    algorithm: text("algorithm", { enum: ["ARGON2ID-AES256GCM"] }).notNull(),
    kdfAlgorithm: text("kdf_algorithm", { enum: ["ARGON2ID"] }).notNull(),
    kdfVersion: integer("kdf_version").notNull(),
    memoryKib: integer("memory_kib").notNull(),
    timeCost: integer("time_cost").notNull(),
    parallelism: integer("parallelism").notNull(),
    outputBytes: integer("output_bytes").notNull(),
    salt: text("salt").notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    verifier: text("verifier").notNull(),
    status: text("status", {
      enum: ["pending_confirmation", "confirmed", "revoked"],
    }).notNull(),
    createdAt: text("created_at").notNull(),
    confirmedAt: text("confirmed_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.keyVersion],
      foreignColumns: [projectKeyVersions.projectId, projectKeyVersions.keyVersion],
    }).onDelete("cascade"),
    check("project_recovery_envelopes_schema_version", sql`${table.schemaVersion} = 1`),
    check(
      "project_recovery_envelopes_kdf",
      sql`${table.kdfVersion} = 19
        AND ${table.memoryKib} = 65536
        AND ${table.timeCost} = 3
        AND ${table.parallelism} = 4
        AND ${table.outputBytes} = 64`,
    ),
    uniqueIndex("project_recovery_envelopes_one_current_idx")
      .on(table.projectId, table.keyVersion)
      .where(sql`${table.status} <> 'revoked'`),
  ],
);

export const syncSnapshotStagingSessions = sqliteTable(
  "sync_snapshot_staging_sessions",
  {
    snapshotId: text("snapshot_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: "cascade" }),
    epoch: integer("epoch").notNull(),
    state: text("state", { enum: ["staging", "committed"] }).notNull(),
    baseSignedRemoteCursor: text("base_signed_remote_cursor"),
    baseCheckpointRevision: integer("base_checkpoint_revision").notNull(),
    baseCheckpointUpdatedAt: text("base_checkpoint_updated_at"),
    snapshotSignedRemoteCursor: text("snapshot_signed_remote_cursor").notNull(),
    snapshotExpiresAt: text("snapshot_expires_at").notNull(),
    nextPageIndex: integer("next_page_index").notNull(),
    nextSnapshotCursor: text("next_snapshot_cursor"),
    pagesComplete: integer("pages_complete", { mode: "boolean" }).notNull(),
    finalSignedRemoteCursor: text("final_signed_remote_cursor"),
    totalOperationCount: integer("total_operation_count").notNull(),
    totalChunkCount: integer("total_chunk_count").notNull(),
    totalTombstoneCount: integer("total_tombstone_count").notNull(),
    committedCheckpointRevision: integer("committed_checkpoint_revision"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    committedAt: text("committed_at"),
  },
  (table) => [
    check("sync_snapshot_sessions_epoch", sql`${table.epoch} >= 1`),
    check("sync_snapshot_sessions_next_page", sql`${table.nextPageIndex} >= 1`),
    check(
      "sync_snapshot_sessions_counts",
      sql`${table.totalOperationCount} >= 0
        AND ${table.totalChunkCount} >= 0
        AND ${table.totalTombstoneCount} >= 0`,
    ),
  ],
);

export const syncSnapshotStagingPages = sqliteTable(
  "sync_snapshot_staging_pages",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => syncSnapshotStagingSessions.snapshotId, { onDelete: "cascade" }),
    pageIndex: integer("page_index").notNull(),
    resumeCursor: text("resume_cursor"),
    snapshotSignedRemoteCursor: text("snapshot_signed_remote_cursor").notNull(),
    snapshotExpiresAt: text("snapshot_expires_at").notNull(),
    nextSnapshotCursor: text("next_snapshot_cursor"),
    finalSignedRemoteCursor: text("final_signed_remote_cursor"),
    responseDigest: text("response_digest").notNull(),
    operationCount: integer("operation_count").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    tombstoneCount: integer("tombstone_count").notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.pageIndex] }),
    check("sync_snapshot_pages_index", sql`${table.pageIndex} >= 0`),
    check("sync_snapshot_pages_digest", sql`length(${table.responseDigest}) = 64`),
  ],
);

export const syncSnapshotStagingOperations = sqliteTable(
  "sync_snapshot_staging_operations",
  {
    snapshotId: text("snapshot_id").notNull(),
    pageIndex: integer("page_index").notNull(),
    operationPosition: integer("operation_position").notNull(),
    operationId: text("operation_id").notNull(),
    projectId: text("project_id").notNull(),
    deviceId: text("device_id").notNull(),
    deviceSequence: integer("device_sequence").notNull(),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    objectGeneration: integer("object_generation").notNull(),
    kind: text("kind", { enum: ["upsert", "delete"] }).notNull(),
    vectorJson: text("vector_json").notNull(),
    operationCreatedAt: text("operation_created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.operationId] }),
    foreignKey({
      columns: [table.snapshotId, table.pageIndex],
      foreignColumns: [syncSnapshotStagingPages.snapshotId, syncSnapshotStagingPages.pageIndex],
    }).onDelete("cascade"),
    uniqueIndex("sync_snapshot_operations_page_position_unique").on(
      table.snapshotId,
      table.pageIndex,
      table.operationPosition,
    ),
    uniqueIndex("sync_snapshot_operations_device_sequence_unique").on(
      table.snapshotId,
      table.projectId,
      table.deviceId,
      table.deviceSequence,
    ),
  ],
);

export const syncSnapshotStagingChunks = sqliteTable(
  "sync_snapshot_staging_chunks",
  {
    snapshotId: text("snapshot_id").notNull(),
    pageIndex: integer("page_index").notNull(),
    chunkId: text("chunk_id").notNull(),
    projectId: text("project_id").notNull(),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    versionId: text("version_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    keyVersion: integer("key_version").notNull(),
    algorithm: text("algorithm", { enum: ["AES-256-GCM"] }).notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    ciphertextSha256: text("ciphertext_sha256").notNull(),
    plaintextBytes: integer("plaintext_bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.chunkId] }),
    foreignKey({
      columns: [table.snapshotId, table.pageIndex],
      foreignColumns: [syncSnapshotStagingPages.snapshotId, syncSnapshotStagingPages.pageIndex],
    }).onDelete("cascade"),
    index("sync_snapshot_staging_chunks_project_idx").on(
      table.snapshotId,
      table.projectId,
      table.objectType,
      table.objectId,
      table.chunkIndex,
    ),
  ],
);

export const syncSnapshotStagingOperationChunks = sqliteTable(
  "sync_snapshot_staging_operation_chunks",
  {
    snapshotId: text("snapshot_id").notNull(),
    operationId: text("operation_id").notNull(),
    chunkId: text("chunk_id").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.operationId, table.chunkId] }),
    foreignKey({
      columns: [table.snapshotId, table.operationId],
      foreignColumns: [
        syncSnapshotStagingOperations.snapshotId,
        syncSnapshotStagingOperations.operationId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.snapshotId, table.chunkId],
      foreignColumns: [syncSnapshotStagingChunks.snapshotId, syncSnapshotStagingChunks.chunkId],
    }).onDelete("cascade"),
    uniqueIndex("sync_snapshot_operation_chunks_position_unique").on(
      table.snapshotId,
      table.operationId,
      table.position,
    ),
  ],
);

export const syncSnapshotStagingTombstones = sqliteTable(
  "sync_snapshot_staging_tombstones",
  {
    snapshotId: text("snapshot_id").notNull(),
    pageIndex: integer("page_index").notNull(),
    tombstonePosition: integer("tombstone_position").notNull(),
    projectId: text("project_id").notNull(),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    objectGeneration: integer("object_generation").notNull(),
    deletedByDeviceId: text("deleted_by_device_id").notNull(),
    vectorJson: text("vector_json").notNull(),
    deletedAt: text("deleted_at").notNull(),
    retainUntil: text("retain_until").notNull(),
    acknowledgedDeviceIdsJson: text("acknowledged_device_ids_json").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.snapshotId,
        table.projectId,
        table.objectType,
        table.objectId,
        table.objectGeneration,
      ],
    }),
    foreignKey({
      columns: [table.snapshotId, table.pageIndex],
      foreignColumns: [syncSnapshotStagingPages.snapshotId, syncSnapshotStagingPages.pageIndex],
    }).onDelete("cascade"),
    uniqueIndex("sync_snapshot_tombstones_page_position_unique").on(
      table.snapshotId,
      table.pageIndex,
      table.tombstonePosition,
    ),
  ],
);

export const syncSnapshotMaterializationReceipts = sqliteTable(
  "sync_snapshot_materialization_receipts",
  {
    snapshotId: text("snapshot_id").notNull(),
    operationId: text("operation_id").notNull(),
    operationFingerprint: text("operation_fingerprint").notNull(),
    outcome: text("outcome", { enum: ["applied", "skipped", "conflict"] }).notNull(),
    conflictCode: text("conflict_code"),
    resolvedAt: text("resolved_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.operationId] }),
    foreignKey({
      columns: [table.snapshotId, table.operationId],
      foreignColumns: [
        syncSnapshotStagingOperations.snapshotId,
        syncSnapshotStagingOperations.operationId,
      ],
    }).onDelete("cascade"),
    check(
      "sync_snapshot_materialization_receipts_fingerprint",
      sql`length(${table.operationFingerprint}) = 64
        AND ${table.operationFingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "sync_snapshot_materialization_receipts_conflict_code",
      sql`${table.conflictCode} IS NULL
        OR (
          length(${table.conflictCode}) BETWEEN 1 AND 120
          AND trim(${table.conflictCode}) = ${table.conflictCode}
          AND ${table.conflictCode} NOT GLOB '*[^A-Za-z0-9_.:-]*'
        )`,
    ),
    check(
      "sync_snapshot_materialization_receipts_outcome",
      sql`(${table.outcome} = 'conflict' AND ${table.conflictCode} IS NOT NULL)
        OR (${table.outcome} IN ('applied', 'skipped') AND ${table.conflictCode} IS NULL)`,
    ),
    check(
      "sync_snapshot_materialization_receipts_resolved_at",
      sql`julianday(${table.resolvedAt}) IS NOT NULL`,
    ),
    index("sync_snapshot_materialization_receipts_progress_idx").on(
      table.snapshotId,
      table.outcome,
      table.operationId,
    ),
  ],
);

export const projectSyncRegistrations = sqliteTable(
  "project_sync_registrations",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    deviceId: text("device_id").notNull(),
    state: text("state", {
      enum: ["enabled", "enabling", "paused", "bootstrap_required", "error", "disabled"],
    }).notNull(),
    consentRevision: integer("consent_revision").notNull(),
    keyVersion: integer("key_version").notNull(),
    revision: integer("revision").notNull(),
    plaintextBootstrapCompleted: integer("plaintext_bootstrap_completed", {
      mode: "boolean",
    }).notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    enabledAt: text("enabled_at"),
    pausedAt: text("paused_at"),
  },
  (table) => [
    check("project_sync_registrations_consent_revision", sql`${table.consentRevision} >= 1`),
    check("project_sync_registrations_key_version", sql`${table.keyVersion} >= 1`),
    check("project_sync_registrations_revision", sql`${table.revision} >= 1`),
    index("project_sync_registrations_state_idx").on(table.state, table.updatedAt, table.projectId),
  ],
);

export const syncMaterializedObjects = sqliteTable(
  "sync_materialized_objects",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    objectGeneration: integer("object_generation").notNull(),
    versionId: text("version_id"),
    vectorJson: text("vector_json").notNull(),
    payloadSha256: text("payload_sha256"),
    sourceOperationId: text("source_operation_id").notNull(),
    sourceDeviceId: text("source_device_id").notNull(),
    sourceDeviceSequence: integer("source_device_sequence").notNull(),
    state: text("state", { enum: ["present", "deleted"] }).notNull(),
    materializedAt: text("materialized_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.objectType, table.objectId, table.objectGeneration],
    }),
    uniqueIndex("sync_materialized_objects_source_operation_idx").on(
      table.projectId,
      table.sourceOperationId,
    ),
    index("sync_materialized_objects_current_idx").on(
      table.projectId,
      table.objectType,
      table.objectId,
      table.objectGeneration,
    ),
  ],
);

export const syncMaterializedCheckpoints = sqliteTable(
  "sync_materialized_checkpoints",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    signedRemoteCursor: text("signed_remote_cursor").notNull(),
    downloadedCheckpointRevision: integer("downloaded_checkpoint_revision").notNull(),
    revision: integer("revision").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "sync_materialized_checkpoints_downloaded_revision",
      sql`${table.downloadedCheckpointRevision} >= 1`,
    ),
    check("sync_materialized_checkpoints_revision", sql`${table.revision} >= 1`),
  ],
);

export const syncContentConflicts = sqliteTable(
  "sync_content_conflicts",
  {
    conflictId: text("conflict_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    objectGeneration: integer("object_generation").notNull(),
    localVectorJson: text("local_vector_json").notNull(),
    remoteVectorJson: text("remote_vector_json").notNull(),
    remoteOperationId: text("remote_operation_id").notNull(),
    remoteKind: text("remote_kind", { enum: ["upsert", "delete"] }).notNull(),
    remotePayloadSha256: text("remote_payload_sha256"),
    status: text("status", { enum: ["unresolved", "resolved"] }).notNull(),
    resolution: text("resolution", {
      enum: ["accept_local", "accept_remote", "merged", "dismissed"],
    }),
    resolutionOperationId: text("resolution_operation_id"),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    uniqueIndex("sync_content_conflicts_remote_operation_idx").on(
      table.projectId,
      table.remoteOperationId,
    ),
    index("sync_content_conflicts_status_idx").on(table.projectId, table.status, table.createdAt),
    index("sync_content_conflicts_identity_idx").on(
      table.projectId,
      table.objectType,
      table.objectId,
      table.objectGeneration,
      table.status,
      table.createdAt,
    ),
  ],
);

export const syncProjectionJobs = sqliteTable(
  "sync_projection_jobs",
  {
    jobId: text("job_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    objectType: text("object_type", {
      enum: [
        "project_manifest",
        "chapter_version",
        "story_record",
        "outline",
        "memory",
        "material",
        "attachment",
      ],
    }).notNull(),
    objectId: text("object_id").notNull(),
    objectGeneration: integer("object_generation").notNull(),
    projectionKind: text("projection_kind", { enum: ["upsert", "delete"] }).notNull(),
    versionId: text("version_id"),
    sourceRevision: integer("source_revision").notNull(),
    keyVersion: integer("key_version").notNull(),
    consentRevision: integer("consent_revision").notNull(),
    deviceId: text("device_id").notNull(),
    status: text("status", {
      enum: ["queued", "leased", "retry_wait", "completed", "failed", "superseded"],
    }).notNull(),
    attempt: integer("attempt").notNull(),
    revision: integer("revision").notNull(),
    nextAttemptAt: text("next_attempt_at"),
    leaseOwnerId: text("lease_owner_id"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    operationId: text("operation_id"),
    failureCode: text("failure_code"),
    supersededByJobId: text("superseded_by_job_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    terminalAt: text("terminal_at"),
  },
  (table) => [
    uniqueIndex("sync_projection_jobs_source_idx").on(
      table.projectId,
      table.accountId,
      table.objectType,
      table.objectId,
      table.objectGeneration,
      table.projectionKind,
      table.sourceRevision,
      table.keyVersion,
      table.consentRevision,
      table.deviceId,
    ),
    index("sync_projection_jobs_runnable_idx").on(
      table.projectId,
      table.status,
      table.nextAttemptAt,
      table.createdAt,
      table.jobId,
    ),
    index("sync_projection_jobs_identity_idx").on(
      table.projectId,
      table.objectType,
      table.objectId,
      table.objectGeneration,
      table.sourceRevision,
    ),
    uniqueIndex("sync_projection_jobs_operation_idx")
      .on(table.operationId)
      .where(sql`${table.operationId} IS NOT NULL`),
    uniqueIndex("sync_projection_jobs_lease_token_idx")
      .on(table.leaseToken)
      .where(sql`${table.leaseToken} IS NOT NULL`),
  ],
);

export type SyncCiphertextChunkRow = typeof syncCiphertextChunks.$inferSelect;
export type SyncOutboxOperationRow = typeof syncOutboxOperations.$inferSelect;
export type SyncTombstoneRow = typeof syncTombstones.$inferSelect;
export type SyncTransferRow = typeof syncTransfers.$inferSelect;
export type SyncRemoteCheckpointRow = typeof syncRemoteCheckpoints.$inferSelect;
export type SyncDeviceSequenceRow = typeof syncDeviceSequences.$inferSelect;
export type SyncIncomingBatchRow = typeof syncIncomingBatches.$inferSelect;
export type SyncIncrementalTerminalObservationRow =
  typeof syncIncrementalTerminalObservations.$inferSelect;
export type SyncInboxOperationRow = typeof syncInboxOperations.$inferSelect;
export type SyncInboxOperationChunkRow = typeof syncInboxOperationChunks.$inferSelect;
export type SyncSnapshotStagingSessionRow = typeof syncSnapshotStagingSessions.$inferSelect;
export type SyncSnapshotStagingPageRow = typeof syncSnapshotStagingPages.$inferSelect;
export type SyncSnapshotStagingOperationRow = typeof syncSnapshotStagingOperations.$inferSelect;
export type SyncSnapshotStagingChunkRow = typeof syncSnapshotStagingChunks.$inferSelect;
export type SyncSnapshotStagingOperationChunkRow =
  typeof syncSnapshotStagingOperationChunks.$inferSelect;
export type SyncSnapshotStagingTombstoneRow = typeof syncSnapshotStagingTombstones.$inferSelect;
export type SyncSnapshotMaterializationReceiptRow =
  typeof syncSnapshotMaterializationReceipts.$inferSelect;
export type CloudAccountSnapshotRow = typeof cloudAccountSnapshots.$inferSelect;
export type RegisteredDeviceSnapshotRow = typeof registeredDeviceSnapshots.$inferSelect;
export type CloudSessionSnapshotRow = typeof cloudSessionSnapshots.$inferSelect;
export type EntitlementCacheRow = typeof entitlementCache.$inferSelect;
export type TeamMembershipSnapshotRow = typeof teamMembershipSnapshots.$inferSelect;
export type DevicePublicKeyRecordRow = typeof devicePublicKeyRecords.$inferSelect;
export type ProjectKeyVersionRow = typeof projectKeyVersions.$inferSelect;
export type ProjectDeviceKeyEnvelopeRow = typeof projectDeviceKeyEnvelopes.$inferSelect;
export type ProjectRecoveryKeyEnvelopeRow = typeof projectRecoveryKeyEnvelopes.$inferSelect;
export type ProjectSyncRegistrationRow = typeof projectSyncRegistrations.$inferSelect;
export type SyncMaterializedObjectRow = typeof syncMaterializedObjects.$inferSelect;
export type SyncMaterializedCheckpointRow = typeof syncMaterializedCheckpoints.$inferSelect;
export type SyncContentConflictRow = typeof syncContentConflicts.$inferSelect;
export type SyncProjectionJobRow = typeof syncProjectionJobs.$inferSelect;
