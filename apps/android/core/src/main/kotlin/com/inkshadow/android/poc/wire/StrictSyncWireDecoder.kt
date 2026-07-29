package com.inkshadow.android.poc.wire

import kotlin.math.floor

/**
 * Strictly maps a duplicate-key-free JSON object tree into the Android DTOs.
 *
 * The transport parser is intentionally outside this PoC. It must reject
 * duplicate JSON keys before supplying a [Map] here; this decoder rejects every
 * unknown or missing property and performs the canonical contract validation.
 */
object StrictSyncWireDecoder {
    fun decodeEncryptedChunk(input: Map<*, *>): EncryptedSyncChunkDto {
        val fields =
            StrictObject(
                input,
                setOf(
                    "schemaVersion",
                    "algorithm",
                    "nonce",
                    "ciphertext",
                    "ciphertextSha256",
                    "plaintextBytes",
                    "aad",
                ),
            )
        val dto =
            EncryptedSyncChunkDto(
                schemaVersion = fields.int("schemaVersion"),
                algorithm = fields.string("algorithm"),
                nonce = fields.string("nonce"),
                ciphertext = fields.string("ciphertext"),
                ciphertextSha256 = fields.string("ciphertextSha256"),
                plaintextBytes = fields.int("plaintextBytes"),
                aad = decodeAad(fields.map("aad")),
            )
        SyncWireValidator.validate(dto)
        return dto
    }

    fun decodeOperation(input: Map<*, *>): SyncOperationDto {
        val fields =
            StrictObject(
                input,
                setOf(
                    "schemaVersion",
                    "operationId",
                    "projectId",
                    "deviceId",
                    "deviceSequence",
                    "objectType",
                    "objectId",
                    "objectGeneration",
                    "kind",
                    "vector",
                    "encryptedChunkIds",
                    "createdAt",
                ),
            )
        val dto =
            SyncOperationDto(
                schemaVersion = fields.int("schemaVersion"),
                operationId = fields.string("operationId"),
                projectId = fields.string("projectId"),
                deviceId = fields.string("deviceId"),
                deviceSequence = fields.long("deviceSequence"),
                objectType = SyncObjectType.fromWire(fields.string("objectType")),
                objectId = fields.string("objectId"),
                objectGeneration = fields.long("objectGeneration"),
                kind = SyncOperationKind.fromWire(fields.string("kind")),
                vector = decodeVersionVector(fields.map("vector")),
                encryptedChunkIds =
                    fields.list("encryptedChunkIds").map(::requireString),
                createdAt = fields.string("createdAt"),
            )
        SyncWireValidator.validate(dto)
        return dto
    }

    fun decodeTombstone(input: Map<*, *>): SyncTombstoneDto {
        val fields =
            StrictObject(
                input,
                setOf(
                    "schemaVersion",
                    "projectId",
                    "objectType",
                    "objectId",
                    "objectGeneration",
                    "deletedByDeviceId",
                    "vector",
                    "deletedAt",
                    "retainUntil",
                    "acknowledgedDeviceIds",
                ),
            )
        val dto =
            SyncTombstoneDto(
                schemaVersion = fields.int("schemaVersion"),
                projectId = fields.string("projectId"),
                objectType = SyncObjectType.fromWire(fields.string("objectType")),
                objectId = fields.string("objectId"),
                objectGeneration = fields.long("objectGeneration"),
                deletedByDeviceId = fields.string("deletedByDeviceId"),
                vector = decodeVersionVector(fields.map("vector")),
                deletedAt = fields.string("deletedAt"),
                retainUntil = fields.string("retainUntil"),
                acknowledgedDeviceIds =
                    fields.list("acknowledgedDeviceIds").map(::requireString),
            )
        SyncWireValidator.validate(dto)
        return dto
    }

    fun decodePushRequest(input: Map<*, *>): CloudSyncPushRequestDto {
        val fields =
            StrictObject(
                input,
                setOf(
                    "schemaVersion",
                    "baseCursor",
                    "operations",
                    "chunks",
                    "tombstones",
                ),
            )
        val dto =
            CloudSyncPushRequestDto(
                schemaVersion = fields.int("schemaVersion"),
                baseCursor = fields.nullableString("baseCursor"),
                operations =
                    fields.list("operations").map { decodeOperation(requireMap(it)) },
                chunks =
                    fields.list("chunks").map { decodeChunkUpload(requireMap(it)) },
                tombstones =
                    fields.list("tombstones").map { decodeTombstone(requireMap(it)) },
            )
        SyncWireValidator.validate(dto)
        return dto
    }

    fun decodePullResponse(input: Map<*, *>): CloudSyncPullResponseDto {
        val fields =
            StrictObject(
                input,
                setOf(
                    "schemaVersion",
                    "requestId",
                    "operations",
                    "chunks",
                    "tombstones",
                    "nextCursor",
                    "hasMore",
                ),
            )
        val dto =
            CloudSyncPullResponseDto(
                schemaVersion = fields.int("schemaVersion"),
                requestId = fields.string("requestId"),
                operations =
                    fields.list("operations").map { decodeOperation(requireMap(it)) },
                chunks =
                    fields.list("chunks").map { decodeChunkUpload(requireMap(it)) },
                tombstones =
                    fields.list("tombstones").map { decodeTombstone(requireMap(it)) },
                nextCursor = fields.string("nextCursor"),
                hasMore = fields.boolean("hasMore"),
            )
        SyncWireValidator.validate(dto)
        return dto
    }

    fun decodeSnapshotResponse(input: Map<*, *>): CloudSyncSnapshotResponseDto {
        val fields =
            StrictObject(
                input,
                setOf(
                    "schemaVersion",
                    "requestId",
                    "projectId",
                    "snapshotId",
                    "snapshotExpiresAt",
                    "operations",
                    "chunks",
                    "tombstones",
                    "resumeCursor",
                    "nextSnapshotCursor",
                    "hasMore",
                ),
            )
        val dto =
            CloudSyncSnapshotResponseDto(
                schemaVersion = fields.int("schemaVersion"),
                requestId = fields.string("requestId"),
                projectId = fields.string("projectId"),
                snapshotId = fields.string("snapshotId"),
                snapshotExpiresAt = fields.string("snapshotExpiresAt"),
                operations =
                    fields.list("operations").map { decodeOperation(requireMap(it)) },
                chunks =
                    fields.list("chunks").map { decodeChunkUpload(requireMap(it)) },
                tombstones =
                    fields.list("tombstones").map { decodeTombstone(requireMap(it)) },
                resumeCursor = fields.string("resumeCursor"),
                nextSnapshotCursor = fields.nullableString("nextSnapshotCursor"),
                hasMore = fields.boolean("hasMore"),
            )
        SyncWireValidator.validate(dto)
        return dto
    }

    fun decodeRegisteredDevice(input: Map<*, *>): RegisteredDeviceDto {
        val fields =
            StrictObject(
                input,
                setOf(
                    "schemaVersion",
                    "deviceId",
                    "accountId",
                    "state",
                    "publicKeyFingerprint",
                    "createdAt",
                    "revokedAt",
                ),
            )
        val dto =
            RegisteredDeviceDto(
                schemaVersion = fields.int("schemaVersion"),
                deviceId = fields.string("deviceId"),
                accountId = fields.string("accountId"),
                state = RegisteredDeviceState.fromWire(fields.string("state")),
                publicKeyFingerprint = fields.string("publicKeyFingerprint"),
                createdAt = fields.string("createdAt"),
                revokedAt = fields.nullableString("revokedAt"),
            )
        SyncWireValidator.validate(dto)
        return dto
    }

    private fun decodeAad(input: Map<*, *>): SyncChunkAadDto {
        val fields =
            StrictObject(
                input,
                setOf(
                    "projectId",
                    "objectType",
                    "objectId",
                    "versionId",
                    "chunkIndex",
                    "keyVersion",
                ),
            )
        val dto =
            SyncChunkAadDto(
                projectId = fields.string("projectId"),
                objectType = SyncObjectType.fromWire(fields.string("objectType")),
                objectId = fields.string("objectId"),
                versionId = fields.string("versionId"),
                chunkIndex = fields.long("chunkIndex"),
                keyVersion = fields.long("keyVersion"),
            )
        SyncWireValidator.validate(dto)
        return dto
    }

    private fun decodeChunkUpload(input: Map<*, *>): CloudSyncChunkUploadDto {
        val fields = StrictObject(input, setOf("chunkId", "encrypted"))
        val dto =
            CloudSyncChunkUploadDto(
                chunkId = fields.string("chunkId"),
                encrypted = decodeEncryptedChunk(fields.map("encrypted")),
            )
        SyncWireValidator.validate(dto)
        return dto
    }

    private fun decodeVersionVector(input: Map<*, *>): Map<String, Long> =
        input.entries.associate { (key, value) ->
            requireString(key) to requireLong(value)
        }

    private fun requireString(value: Any?): String =
        value as? String
            ?: throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)

    private fun requireMap(value: Any?): Map<*, *> =
        value as? Map<*, *>
            ?: throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)

    private fun requireLong(value: Any?): Long {
        val number =
            value as? Number
                ?: throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)
        val asDouble = number.toDouble()
        if (!asDouble.isFinite() || floor(asDouble) != asDouble) {
            throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)
        }
        if (asDouble < Long.MIN_VALUE.toDouble() || asDouble > Long.MAX_VALUE.toDouble()) {
            throw SyncContractException(SyncContractErrorCode.FIELD_RANGE)
        }
        val asLong = number.toLong()
        if (asLong.toDouble() != asDouble) {
            throw SyncContractException(SyncContractErrorCode.FIELD_RANGE)
        }
        return asLong
    }

    private class StrictObject(
        input: Map<*, *>,
        expectedKeys: Set<String>,
    ) {
        private val fields: Map<String, Any?>

        init {
            val converted =
                input.entries.associate { (key, value) ->
                    requireString(key) to value
                }
            if (converted.keys != expectedKeys) {
                throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)
            }
            fields = converted
        }

        fun string(name: String): String = requireString(fields[name])

        fun nullableString(name: String): String? {
            val value = fields[name]
            return if (value == null) null else requireString(value)
        }

        fun int(name: String): Int {
            val value = long(name)
            if (value !in Int.MIN_VALUE..Int.MAX_VALUE) {
                throw SyncContractException(SyncContractErrorCode.FIELD_RANGE)
            }
            return value.toInt()
        }

        fun long(name: String): Long = requireLong(fields[name])

        fun boolean(name: String): Boolean =
            fields[name] as? Boolean
                ?: throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)

        fun map(name: String): Map<*, *> = requireMap(fields[name])

        fun list(name: String): List<*> =
            fields[name] as? List<*>
                ?: throw SyncContractException(SyncContractErrorCode.FIELD_FORMAT)
    }
}
