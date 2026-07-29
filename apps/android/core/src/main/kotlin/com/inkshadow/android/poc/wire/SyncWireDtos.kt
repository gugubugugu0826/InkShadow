package com.inkshadow.android.poc.wire

const val CONTRACT_SCHEMA_VERSION: Int = 1
const val SYNC_PROTOCOL_SCHEMA_VERSION: Int = 2
const val MAX_PLAINTEXT_BYTES: Int = 4 * 1024 * 1024
const val MAX_CIPHERTEXT_CHARACTERS: Int = 8_000_000
const val MAX_PORTABLE_INTEGER: Long = 9_007_199_254_740_991L

enum class SyncObjectType(
    val wireValue: String,
) {
    PROJECT_MANIFEST("project_manifest"),
    CHAPTER_VERSION("chapter_version"),
    STORY_RECORD("story_record"),
    OUTLINE("outline"),
    MEMORY("memory"),
    MATERIAL("material"),
    ATTACHMENT("attachment"),
    ;

    companion object {
        fun fromWire(value: String): SyncObjectType =
            entries.firstOrNull { it.wireValue == value }
                ?: throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)
    }
}

enum class SyncOperationKind(
    val wireValue: String,
) {
    UPSERT("upsert"),
    DELETE("delete"),
    ;

    companion object {
        fun fromWire(value: String): SyncOperationKind =
            entries.firstOrNull { it.wireValue == value }
                ?: throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)
    }
}

enum class RegisteredDeviceState(
    val wireValue: String,
) {
    TRUSTED("trusted"),
    REVOKED("revoked"),
    ;

    companion object {
        fun fromWire(value: String): RegisteredDeviceState =
            entries.firstOrNull { it.wireValue == value }
                ?: throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)
    }
}

data class SyncChunkAadDto(
    val projectId: String,
    val objectType: SyncObjectType,
    val objectId: String,
    val versionId: String,
    val chunkIndex: Long,
    val keyVersion: Long,
)

data class EncryptedSyncChunkDto(
    val schemaVersion: Int,
    val algorithm: String,
    val nonce: String,
    val ciphertext: String,
    val ciphertextSha256: String,
    val plaintextBytes: Int,
    val aad: SyncChunkAadDto,
)

data class SyncOperationDto(
    val schemaVersion: Int,
    val operationId: String,
    val projectId: String,
    val deviceId: String,
    val deviceSequence: Long,
    val objectType: SyncObjectType,
    val objectId: String,
    val objectGeneration: Long,
    val kind: SyncOperationKind,
    val vector: Map<String, Long>,
    val encryptedChunkIds: List<String>,
    val createdAt: String,
)

data class SyncTombstoneDto(
    val schemaVersion: Int,
    val projectId: String,
    val objectType: SyncObjectType,
    val objectId: String,
    val objectGeneration: Long,
    val deletedByDeviceId: String,
    val vector: Map<String, Long>,
    val deletedAt: String,
    val retainUntil: String,
    val acknowledgedDeviceIds: List<String>,
)

data class CloudSyncChunkUploadDto(
    val chunkId: String,
    val encrypted: EncryptedSyncChunkDto,
)

data class CloudSyncPushRequestDto(
    val schemaVersion: Int,
    val baseCursor: String?,
    val operations: List<SyncOperationDto>,
    val chunks: List<CloudSyncChunkUploadDto>,
    val tombstones: List<SyncTombstoneDto>,
)

data class CloudSyncPullResponseDto(
    val schemaVersion: Int,
    val requestId: String,
    val operations: List<SyncOperationDto>,
    val chunks: List<CloudSyncChunkUploadDto>,
    val tombstones: List<SyncTombstoneDto>,
    val nextCursor: String,
    val hasMore: Boolean,
)

data class CloudSyncSnapshotResponseDto(
    val schemaVersion: Int,
    val requestId: String,
    val projectId: String,
    val snapshotId: String,
    val snapshotExpiresAt: String,
    val operations: List<SyncOperationDto>,
    val chunks: List<CloudSyncChunkUploadDto>,
    val tombstones: List<SyncTombstoneDto>,
    val resumeCursor: String,
    val nextSnapshotCursor: String?,
    val hasMore: Boolean,
)

data class RegisteredDeviceDto(
    val schemaVersion: Int,
    val deviceId: String,
    val accountId: String,
    val state: RegisteredDeviceState,
    val publicKeyFingerprint: String,
    val createdAt: String,
    val revokedAt: String?,
)
