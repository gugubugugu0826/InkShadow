package com.inkshadow.android.poc.wire

import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Base64

enum class SyncContractErrorCode {
    SCHEMA_VERSION,
    FIELD_FORMAT,
    FIELD_RANGE,
    DUPLICATE_VALUE,
    RELATIONSHIP_MISMATCH,
    TOMBSTONE_RETENTION,
}

class SyncContractException(
    val code: SyncContractErrorCode,
) : IllegalArgumentException(code.name)

object SyncWireValidator {
    private val uuidV7 =
        Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
    private val base64Url16 = Regex("^[A-Za-z0-9_-]{16}$")
    private val base64Url = Regex("^[A-Za-z0-9_-]+$")
    private val lowercaseSha256 = Regex("^[a-f0-9]{64}$")
    private val cursor = Regex("^[A-Za-z0-9_-]+$")

    fun requireUuidV7(value: String) {
        requireContract(uuidV7.matches(value), SyncContractErrorCode.FIELD_FORMAT)
    }

    fun requirePositivePortableInteger(value: Long) {
        requireContract(
            value in 1..MAX_PORTABLE_INTEGER,
            SyncContractErrorCode.FIELD_RANGE,
        )
    }

    fun validate(aad: SyncChunkAadDto) {
        requireUuidV7(aad.projectId)
        requireUuidV7(aad.objectId)
        requireUuidV7(aad.versionId)
        requireContract(
            aad.chunkIndex in 0..MAX_PORTABLE_INTEGER,
            SyncContractErrorCode.FIELD_RANGE,
        )
        requirePositivePortableInteger(aad.keyVersion)
    }

    fun validate(chunk: EncryptedSyncChunkDto) {
        requireContract(
            chunk.schemaVersion == CONTRACT_SCHEMA_VERSION,
            SyncContractErrorCode.SCHEMA_VERSION,
        )
        requireContract(
            chunk.algorithm == "AES-256-GCM",
            SyncContractErrorCode.FIELD_FORMAT,
        )
        requireContract(
            base64Url16.matches(chunk.nonce),
            SyncContractErrorCode.FIELD_FORMAT,
        )
        requireContract(
            decodeBase64Url(chunk.nonce).size == 12,
            SyncContractErrorCode.FIELD_FORMAT,
        )
        requireContract(
            chunk.ciphertext.length <= MAX_CIPHERTEXT_CHARACTERS &&
                base64Url.matches(chunk.ciphertext),
            SyncContractErrorCode.FIELD_FORMAT,
        )
        decodeBase64Url(chunk.ciphertext)
        requireContract(
            lowercaseSha256.matches(chunk.ciphertextSha256),
            SyncContractErrorCode.FIELD_FORMAT,
        )
        requireContract(
            chunk.plaintextBytes in 0..MAX_PLAINTEXT_BYTES,
            SyncContractErrorCode.FIELD_RANGE,
        )
        validate(chunk.aad)
    }

    fun validate(operation: SyncOperationDto) {
        requireContract(
            operation.schemaVersion == SYNC_PROTOCOL_SCHEMA_VERSION,
            SyncContractErrorCode.SCHEMA_VERSION,
        )
        requireUuidV7(operation.operationId)
        requireUuidV7(operation.projectId)
        requireUuidV7(operation.deviceId)
        requirePositivePortableInteger(operation.deviceSequence)
        requireUuidV7(operation.objectId)
        requirePositivePortableInteger(operation.objectGeneration)
        validateVersionVector(operation.vector)
        requireContract(
            operation.vector[operation.deviceId] == operation.deviceSequence,
            SyncContractErrorCode.RELATIONSHIP_MISMATCH,
        )
        requireContract(
            operation.encryptedChunkIds.size <= 10_000,
            SyncContractErrorCode.FIELD_RANGE,
        )
        operation.encryptedChunkIds.forEach(::requireUuidV7)
        requireContract(
            operation.encryptedChunkIds.distinct().size == operation.encryptedChunkIds.size,
            SyncContractErrorCode.DUPLICATE_VALUE,
        )
        requireContract(
            when (operation.kind) {
                SyncOperationKind.UPSERT -> operation.encryptedChunkIds.isNotEmpty()
                SyncOperationKind.DELETE -> operation.encryptedChunkIds.isEmpty()
            },
            SyncContractErrorCode.RELATIONSHIP_MISMATCH,
        )
        requireIsoUtcTimestamp(operation.createdAt)
    }

    fun validate(tombstone: SyncTombstoneDto) {
        requireContract(
            tombstone.schemaVersion == SYNC_PROTOCOL_SCHEMA_VERSION,
            SyncContractErrorCode.SCHEMA_VERSION,
        )
        requireUuidV7(tombstone.projectId)
        requireUuidV7(tombstone.objectId)
        requirePositivePortableInteger(tombstone.objectGeneration)
        requireUuidV7(tombstone.deletedByDeviceId)
        validateVersionVector(tombstone.vector)
        val deletedAt = requireIsoUtcTimestamp(tombstone.deletedAt)
        val retainUntil = requireIsoUtcTimestamp(tombstone.retainUntil)
        requireContract(
            !Duration.between(deletedAt, retainUntil).minus(Duration.ofDays(365)).isNegative,
            SyncContractErrorCode.TOMBSTONE_RETENTION,
        )
        requireContract(
            tombstone.acknowledgedDeviceIds.size <= 1_024,
            SyncContractErrorCode.FIELD_RANGE,
        )
        tombstone.acknowledgedDeviceIds.forEach(::requireUuidV7)
        requireContract(
            tombstone.acknowledgedDeviceIds.distinct().size ==
                tombstone.acknowledgedDeviceIds.size,
            SyncContractErrorCode.DUPLICATE_VALUE,
        )
    }

    fun validate(upload: CloudSyncChunkUploadDto) {
        requireUuidV7(upload.chunkId)
        validate(upload.encrypted)
    }

    /**
     * Mirrors CloudSyncPushRequestSchema, including its cross-object checks.
     */
    fun validate(request: CloudSyncPushRequestDto) {
        requireContract(
            request.schemaVersion == CONTRACT_SCHEMA_VERSION,
            SyncContractErrorCode.SCHEMA_VERSION,
        )
        request.baseCursor?.let {
            requireCloudCursor(it)
        }
        requireContract(
            request.operations.size in 1..256 &&
                request.chunks.size <= 10_000 &&
                request.tombstones.size <= 256,
            SyncContractErrorCode.FIELD_RANGE,
        )
        request.operations.forEach(::validate)
        request.chunks.forEach(::validate)
        request.tombstones.forEach(::validate)

        request.operations.zipWithNext().forEach { (previous, current) ->
            requireContract(
                current.deviceSequence > previous.deviceSequence,
                SyncContractErrorCode.RELATIONSHIP_MISMATCH,
            )
        }

        val chunkIds = request.chunks.map(CloudSyncChunkUploadDto::chunkId)
        requireContract(
            chunkIds.distinct().size == chunkIds.size,
            SyncContractErrorCode.DUPLICATE_VALUE,
        )
        val referenced = request.operations.flatMap(SyncOperationDto::encryptedChunkIds).toSet()
        requireContract(
            referenced.size == chunkIds.size && chunkIds.all(referenced::contains),
            SyncContractErrorCode.RELATIONSHIP_MISMATCH,
        )

        val operationsByChunkId =
            request.operations
                .flatMap { operation ->
                    operation.encryptedChunkIds.map { chunkId -> chunkId to operation }
                }
                .groupBy({ it.first }, { it.second })
        request.chunks.forEach { chunk ->
            val owners = operationsByChunkId[chunk.chunkId].orEmpty()
            requireContract(
                owners.none { it.objectType != chunk.encrypted.aad.objectType },
                SyncContractErrorCode.RELATIONSHIP_MISMATCH,
            )
        }

        request.tombstones.forEach { tombstone ->
            val matchingDeletes =
                request.operations.filter { operation ->
                    operation.kind == SyncOperationKind.DELETE &&
                        operation.projectId == tombstone.projectId &&
                        operation.objectId == tombstone.objectId &&
                        operation.objectGeneration == tombstone.objectGeneration &&
                        operation.deviceId == tombstone.deletedByDeviceId &&
                        sameVersionVector(operation.vector, tombstone.vector)
                }
            requireContract(
                matchingDeletes.isEmpty() ||
                    matchingDeletes.any { it.objectType == tombstone.objectType },
                SyncContractErrorCode.RELATIONSHIP_MISMATCH,
            )
        }
    }

    fun validate(response: CloudSyncPullResponseDto) {
        requireContract(
            response.schemaVersion == CONTRACT_SCHEMA_VERSION,
            SyncContractErrorCode.SCHEMA_VERSION,
        )
        requireUuidV7(response.requestId)
        requireContract(
            response.operations.size <= 256 &&
                response.chunks.size <= 10_000 &&
                response.tombstones.size <= 256,
            SyncContractErrorCode.FIELD_RANGE,
        )
        response.operations.forEach(::validate)
        response.chunks.forEach(::validate)
        response.tombstones.forEach(::validate)
        requireCloudCursor(response.nextCursor)
    }

    fun validate(response: CloudSyncSnapshotResponseDto) {
        requireContract(
            response.schemaVersion == CONTRACT_SCHEMA_VERSION,
            SyncContractErrorCode.SCHEMA_VERSION,
        )
        requireUuidV7(response.requestId)
        requireUuidV7(response.projectId)
        requireUuidV7(response.snapshotId)
        requireIsoUtcTimestamp(response.snapshotExpiresAt)
        requireContract(
            response.operations.size <= 256 &&
                response.chunks.size <= 10_000 &&
                response.tombstones.size <= 256,
            SyncContractErrorCode.FIELD_RANGE,
        )
        response.operations.forEach(::validate)
        response.chunks.forEach(::validate)
        response.tombstones.forEach(::validate)
        requireCloudCursor(response.resumeCursor)
        response.nextSnapshotCursor?.let(::requireCloudCursor)
        validateSnapshotPayload(response)
        requireContract(
            response.hasMore == (response.nextSnapshotCursor != null),
            SyncContractErrorCode.RELATIONSHIP_MISMATCH,
        )
        requireContract(
            !response.hasMore || response.operations.isNotEmpty(),
            SyncContractErrorCode.RELATIONSHIP_MISMATCH,
        )
        requireContract(
            response.nextSnapshotCursor != response.resumeCursor,
            SyncContractErrorCode.RELATIONSHIP_MISMATCH,
        )
    }

    fun validate(device: RegisteredDeviceDto) {
        requireContract(
            device.schemaVersion == CONTRACT_SCHEMA_VERSION,
            SyncContractErrorCode.SCHEMA_VERSION,
        )
        requireUuidV7(device.deviceId)
        requireUuidV7(device.accountId)
        requireContract(
            lowercaseSha256.matches(device.publicKeyFingerprint),
            SyncContractErrorCode.FIELD_FORMAT,
        )
        requireIsoUtcTimestamp(device.createdAt)
        device.revokedAt?.let(::requireIsoUtcTimestamp)
        requireContract(
            (device.state == RegisteredDeviceState.REVOKED) ==
                (device.revokedAt != null),
            SyncContractErrorCode.RELATIONSHIP_MISMATCH,
        )
    }

    fun decodeBase64Url(value: String): ByteArray =
        try {
            Base64.getUrlDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)
        }

    fun encodeBase64Url(value: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(value)

    fun sha256Hex(value: ByteArray): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(value)
            .joinToString(separator = "") { byte -> "%02x".format(byte) }

    fun constantTimeSha256Matches(
        ciphertext: ByteArray,
        expectedHex: String,
    ): Boolean {
        if (!lowercaseSha256.matches(expectedHex)) {
            return false
        }
        val expected =
            expectedHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val actual = MessageDigest.getInstance("SHA-256").digest(ciphertext)
        return MessageDigest.isEqual(actual, expected)
    }

    fun validateVersionVector(vector: Map<String, Long>) {
        requireContract(vector.size <= 1_024, SyncContractErrorCode.FIELD_RANGE)
        vector.forEach { (deviceId, counter) ->
            requireUuidV7(deviceId)
            requirePositivePortableInteger(counter)
        }
    }

    fun requireIsoUtcTimestamp(value: String): Instant {
        requireContract(value.endsWith("Z"), SyncContractErrorCode.FIELD_FORMAT)
        return try {
            Instant.parse(value)
        } catch (_: DateTimeParseException) {
            throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)
        }
    }

    fun requireCloudCursor(value: String) {
        requireContract(
            value.length in 1..512 && cursor.matches(value),
            SyncContractErrorCode.FIELD_FORMAT,
        )
    }

    private fun validateSnapshotPayload(response: CloudSyncSnapshotResponseDto) {
        data class ChunkOwner(
            val operation: SyncOperationDto,
            val position: Int,
        )

        val operationIds = mutableSetOf<String>()
        val chunkOwners = mutableMapOf<String, ChunkOwner>()
        val operationsByObject = mutableMapOf<String, MutableList<SyncOperationDto>>()
        response.operations.forEach { operation ->
            requireContract(
                operation.projectId == response.projectId,
                SyncContractErrorCode.RELATIONSHIP_MISMATCH,
            )
            requireContract(
                operationIds.add(operation.operationId),
                SyncContractErrorCode.DUPLICATE_VALUE,
            )
            operationsByObject
                .getOrPut(objectKey(operation)) { mutableListOf() }
                .add(operation)
            operation.encryptedChunkIds.forEachIndexed { position, chunkId ->
                requireContract(
                    chunkOwners.putIfAbsent(
                        chunkId,
                        ChunkOwner(operation, position),
                    ) == null,
                    SyncContractErrorCode.RELATIONSHIP_MISMATCH,
                )
            }
        }

        val chunksById = mutableMapOf<String, CloudSyncChunkUploadDto>()
        val firstChunkByOperation = mutableMapOf<String, CloudSyncChunkUploadDto>()
        response.chunks.forEach { chunk ->
            requireContract(
                chunksById.putIfAbsent(chunk.chunkId, chunk) == null,
                SyncContractErrorCode.DUPLICATE_VALUE,
            )
            val owner =
                chunkOwners[chunk.chunkId]
                    ?: throw SyncContractException(
                        SyncContractErrorCode.RELATIONSHIP_MISMATCH,
                    )
            requireContract(
                chunk.encrypted.aad.projectId == response.projectId &&
                    chunk.encrypted.aad.objectType == owner.operation.objectType &&
                    chunk.encrypted.aad.objectId == owner.operation.objectId &&
                    chunk.encrypted.aad.chunkIndex == owner.position.toLong(),
                SyncContractErrorCode.RELATIONSHIP_MISMATCH,
            )
            val first =
                firstChunkByOperation.putIfAbsent(
                    owner.operation.operationId,
                    chunk,
                )
            if (first != null) {
                requireContract(
                    chunk.encrypted.aad.objectType == first.encrypted.aad.objectType &&
                        chunk.encrypted.aad.versionId == first.encrypted.aad.versionId &&
                        chunk.encrypted.aad.keyVersion == first.encrypted.aad.keyVersion,
                    SyncContractErrorCode.RELATIONSHIP_MISMATCH,
                )
            }
        }
        requireContract(
            chunksById.size == chunkOwners.size &&
                chunkOwners.keys.all(chunksById::containsKey),
            SyncContractErrorCode.RELATIONSHIP_MISMATCH,
        )

        val tombstoneKeys = mutableSetOf<String>()
        val matchedDeleteOperationIds = mutableSetOf<String>()
        response.tombstones.forEach { tombstone ->
            val key = objectKey(tombstone)
            val matchingDeletes =
                operationsByObject[key]
                    .orEmpty()
                    .filter { operation ->
                        operation.kind == SyncOperationKind.DELETE &&
                            tombstone.objectType == operation.objectType &&
                            tombstone.deletedByDeviceId == operation.deviceId &&
                            tombstone.vector == operation.vector
                    }
            requireContract(
                tombstone.projectId == response.projectId &&
                    tombstoneKeys.add(key) &&
                    matchingDeletes.size == 1,
                SyncContractErrorCode.RELATIONSHIP_MISMATCH,
            )
            matchedDeleteOperationIds.add(matchingDeletes.single().operationId)
        }
        response.operations.forEach { operation ->
            requireContract(
                operation.kind != SyncOperationKind.DELETE ||
                    matchedDeleteOperationIds.contains(operation.operationId),
                SyncContractErrorCode.RELATIONSHIP_MISMATCH,
            )
        }
    }

    private fun objectKey(operation: SyncOperationDto): String =
        "${operation.objectType.wireValue}:${operation.objectId}:${operation.objectGeneration}"

    private fun objectKey(tombstone: SyncTombstoneDto): String =
        "${tombstone.objectType.wireValue}:${tombstone.objectId}:${tombstone.objectGeneration}"

    private fun sameVersionVector(
        left: Map<String, Long>,
        right: Map<String, Long>,
    ): Boolean = left == right

    private fun requireContract(
        condition: Boolean,
        code: SyncContractErrorCode,
    ) {
        if (!condition) {
            throw SyncContractException(code)
        }
    }
}
