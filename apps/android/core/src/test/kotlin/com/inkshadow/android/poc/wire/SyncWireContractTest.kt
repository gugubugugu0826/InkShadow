package com.inkshadow.android.poc.wire

import com.inkshadow.android.poc.TestIds
import com.inkshadow.android.poc.testEncryptedChunk
import com.inkshadow.android.poc.testOperation
import com.inkshadow.android.poc.testPushRequest
import com.inkshadow.android.poc.testTombstone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class SyncWireContractTest {
    @Test
    fun `strict decoder rejects unknown fields`() {
        val encoded = encryptedChunkMap() + ("body" to "forbidden")

        val error =
            assertFailsWith<SyncContractException> {
                StrictSyncWireDecoder.decodeEncryptedChunk(encoded)
            }

        assertEquals(SyncContractErrorCode.FIELD_FORMAT, error.code)
    }

    @Test
    fun `strict decoder accepts the frozen encrypted chunk shape`() {
        val decoded = StrictSyncWireDecoder.decodeEncryptedChunk(encryptedChunkMap())

        assertEquals(CONTRACT_SCHEMA_VERSION, decoded.schemaVersion)
        assertEquals("AES-256-GCM", decoded.algorithm)
        assertEquals(TestIds.PROJECT, decoded.aad.projectId)
        assertEquals(TestIds.VERSION, decoded.aad.versionId)
    }

    @Test
    fun `operation sequence must match its version-vector counter`() {
        val invalid =
            testOperation(
                deviceSequence = 2,
                vector = mapOf(TestIds.DEVICE_A to 1L),
            )

        val error =
            assertFailsWith<SyncContractException> {
                SyncWireValidator.validate(invalid)
            }

        assertEquals(SyncContractErrorCode.RELATIONSHIP_MISMATCH, error.code)
    }

    @Test
    fun `push ciphertext ownership must match operation object type`() {
        val encrypted =
            testEncryptedChunk(
                aad =
                    com.inkshadow.android.poc.testAad().copy(
                        objectType = SyncObjectType.MATERIAL,
                    ),
            )
        val invalid = testPushRequest(encrypted = encrypted)

        val error =
            assertFailsWith<SyncContractException> {
                SyncWireValidator.validate(invalid)
            }

        assertEquals(SyncContractErrorCode.RELATIONSHIP_MISMATCH, error.code)
    }

    @Test
    fun `tombstones retain deletion metadata for at least 365 days`() {
        val invalid = testTombstone(retainUntil = "2026-12-31T23:59:59Z")

        val error =
            assertFailsWith<SyncContractException> {
                SyncWireValidator.validate(invalid)
            }

        assertEquals(SyncContractErrorCode.TOMBSTONE_RETENTION, error.code)
        SyncWireValidator.validate(testTombstone())
    }

    @Test
    fun `push operations must use strictly increasing device sequences`() {
        val first = testOperation(deviceSequence = 2, vector = mapOf(TestIds.DEVICE_A to 2L))
        val second =
            testOperation(
                operationId = TestIds.OPERATION_B,
                deviceSequence = 1,
                vector = mapOf(TestIds.DEVICE_A to 1L),
                encryptedChunkIds = listOf(TestIds.CHUNK_B),
            )
        val firstChunk =
            CloudSyncChunkUploadDto(
                chunkId = TestIds.CHUNK_A,
                encrypted = testEncryptedChunk(),
            )
        val secondChunk =
            CloudSyncChunkUploadDto(
                chunkId = TestIds.CHUNK_B,
                encrypted = testEncryptedChunk(aad = com.inkshadow.android.poc.testAad(chunkIndex = 1)),
            )
        val request =
            CloudSyncPushRequestDto(
                schemaVersion = CONTRACT_SCHEMA_VERSION,
                baseCursor = null,
                operations = listOf(first, second),
                chunks = listOf(firstChunk, secondChunk),
                tombstones = emptyList(),
            )

        val error =
            assertFailsWith<SyncContractException> {
                SyncWireValidator.validate(request)
            }

        assertEquals(SyncContractErrorCode.RELATIONSHIP_MISMATCH, error.code)
    }

    @Test
    fun `snapshot rejects ciphertext outside its project scope`() {
        val operation = testOperation()
        val valid =
            CloudSyncSnapshotResponseDto(
                schemaVersion = CONTRACT_SCHEMA_VERSION,
                requestId = TestIds.REQUEST,
                projectId = TestIds.PROJECT,
                snapshotId = TestIds.SNAPSHOT,
                snapshotExpiresAt = "2026-01-02T00:00:00Z",
                operations = listOf(operation),
                chunks =
                    listOf(
                        CloudSyncChunkUploadDto(
                            chunkId = TestIds.CHUNK_A,
                            encrypted = testEncryptedChunk(),
                        ),
                    ),
                tombstones = emptyList(),
                resumeCursor = "resume_1",
                nextSnapshotCursor = null,
                hasMore = false,
            )
        SyncWireValidator.validate(valid)

        val error =
            assertFailsWith<SyncContractException> {
                SyncWireValidator.validate(valid.copy(projectId = TestIds.OTHER_PROJECT))
            }

        assertEquals(SyncContractErrorCode.RELATIONSHIP_MISMATCH, error.code)
    }

    @Test
    fun `revoked device contract requires revoked timestamp`() {
        val encoded =
            mapOf(
                "schemaVersion" to CONTRACT_SCHEMA_VERSION,
                "deviceId" to TestIds.DEVICE_B,
                "accountId" to TestIds.ACCOUNT,
                "state" to "revoked",
                "publicKeyFingerprint" to "a".repeat(64),
                "createdAt" to "2026-01-01T00:00:00Z",
                "revokedAt" to null,
            )

        val error =
            assertFailsWith<SyncContractException> {
                StrictSyncWireDecoder.decodeRegisteredDevice(encoded)
            }

        assertEquals(SyncContractErrorCode.RELATIONSHIP_MISMATCH, error.code)
    }

    private fun encryptedChunkMap(): Map<String, Any?> {
        val chunk = testEncryptedChunk()
        return mapOf(
            "schemaVersion" to chunk.schemaVersion,
            "algorithm" to chunk.algorithm,
            "nonce" to chunk.nonce,
            "ciphertext" to chunk.ciphertext,
            "ciphertextSha256" to chunk.ciphertextSha256,
            "plaintextBytes" to chunk.plaintextBytes,
            "aad" to
                mapOf(
                    "projectId" to chunk.aad.projectId,
                    "objectType" to chunk.aad.objectType.wireValue,
                    "objectId" to chunk.aad.objectId,
                    "versionId" to chunk.aad.versionId,
                    "chunkIndex" to chunk.aad.chunkIndex,
                    "keyVersion" to chunk.aad.keyVersion,
                ),
        )
    }
}
