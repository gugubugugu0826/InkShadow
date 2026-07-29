package com.inkshadow.android.poc

import com.inkshadow.android.poc.crypto.AeadCiphertext
import com.inkshadow.android.poc.crypto.AeadKeyHandle
import com.inkshadow.android.poc.crypto.ProjectKeyAliases
import com.inkshadow.android.poc.wire.CONTRACT_SCHEMA_VERSION
import com.inkshadow.android.poc.wire.CloudSyncChunkUploadDto
import com.inkshadow.android.poc.wire.CloudSyncPushRequestDto
import com.inkshadow.android.poc.wire.EncryptedSyncChunkDto
import com.inkshadow.android.poc.wire.SYNC_PROTOCOL_SCHEMA_VERSION
import com.inkshadow.android.poc.wire.SyncChunkAadDto
import com.inkshadow.android.poc.wire.SyncObjectType
import com.inkshadow.android.poc.wire.SyncOperationDto
import com.inkshadow.android.poc.wire.SyncOperationKind
import com.inkshadow.android.poc.wire.SyncTombstoneDto
import com.inkshadow.android.poc.wire.SyncWireValidator
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object TestIds {
    const val PROJECT = "018f47a0-1111-7abc-8abc-111111111111"
    const val OTHER_PROJECT = "018f47a0-1111-7abc-8abc-111111111112"
    const val OBJECT = "018f47a0-2222-7abc-8abc-222222222222"
    const val VERSION = "018f47a0-3333-7abc-8abc-333333333333"
    const val OTHER_VERSION = "018f47a0-3333-7abc-8abc-333333333334"
    const val DEVICE_A = "018f47a0-4444-7abc-8abc-444444444444"
    const val DEVICE_B = "018f47a0-5555-7abc-8abc-555555555555"
    const val ACCOUNT = "018f47a0-5555-7abc-8abc-555555555556"
    const val REQUEST = "018f47a0-5555-7abc-8abc-555555555557"
    const val SNAPSHOT = "018f47a0-5555-7abc-8abc-555555555558"
    const val OPERATION_A = "018f47a0-6666-7abc-8abc-666666666666"
    const val OPERATION_B = "018f47a0-6666-7abc-8abc-666666666667"
    const val OPERATION_C = "018f47a0-6666-7abc-8abc-666666666668"
    const val CHUNK_A = "018f47a0-7777-7abc-8abc-777777777777"
    const val CHUNK_B = "018f47a0-7777-7abc-8abc-777777777778"
    const val RECORD_A = "018f47a0-8888-7abc-8abc-888888888888"
    const val RECORD_B = "018f47a0-8888-7abc-8abc-888888888889"
}

fun testAad(
    versionId: String = TestIds.VERSION,
    chunkIndex: Long = 0,
    keyVersion: Long = 1,
): SyncChunkAadDto =
    SyncChunkAadDto(
        projectId = TestIds.PROJECT,
        objectType = SyncObjectType.CHAPTER_VERSION,
        objectId = TestIds.OBJECT,
        versionId = versionId,
        chunkIndex = chunkIndex,
        keyVersion = keyVersion,
    )

fun testEncryptedChunk(
    aad: SyncChunkAadDto = testAad(),
): EncryptedSyncChunkDto {
    val ciphertext = ByteArray(24) { (it + 1).toByte() }
    return EncryptedSyncChunkDto(
        schemaVersion = CONTRACT_SCHEMA_VERSION,
        algorithm = "AES-256-GCM",
        nonce = SyncWireValidator.encodeBase64Url(ByteArray(12) { (it + 2).toByte() }),
        ciphertext = SyncWireValidator.encodeBase64Url(ciphertext),
        ciphertextSha256 = SyncWireValidator.sha256Hex(ciphertext),
        plaintextBytes = 8,
        aad = aad,
    )
}

fun testOperation(
    operationId: String = TestIds.OPERATION_A,
    deviceId: String = TestIds.DEVICE_A,
    deviceSequence: Long = 1,
    vector: Map<String, Long> = mapOf(deviceId to deviceSequence),
    kind: SyncOperationKind = SyncOperationKind.UPSERT,
    encryptedChunkIds: List<String> =
        if (kind == SyncOperationKind.UPSERT) listOf(TestIds.CHUNK_A) else emptyList(),
    objectGeneration: Long = 1,
): SyncOperationDto =
    SyncOperationDto(
        schemaVersion = SYNC_PROTOCOL_SCHEMA_VERSION,
        operationId = operationId,
        projectId = TestIds.PROJECT,
        deviceId = deviceId,
        deviceSequence = deviceSequence,
        objectType = SyncObjectType.CHAPTER_VERSION,
        objectId = TestIds.OBJECT,
        objectGeneration = objectGeneration,
        kind = kind,
        vector = vector,
        encryptedChunkIds = encryptedChunkIds,
        createdAt = "2026-01-01T00:00:00Z",
    )

fun testTombstone(
    operation: SyncOperationDto =
        testOperation(
            kind = SyncOperationKind.DELETE,
            encryptedChunkIds = emptyList(),
        ),
    retainUntil: String = "2027-01-01T00:00:00Z",
): SyncTombstoneDto =
    SyncTombstoneDto(
        schemaVersion = SYNC_PROTOCOL_SCHEMA_VERSION,
        projectId = operation.projectId,
        objectType = operation.objectType,
        objectId = operation.objectId,
        objectGeneration = operation.objectGeneration,
        deletedByDeviceId = operation.deviceId,
        vector = operation.vector,
        deletedAt = operation.createdAt,
        retainUntil = retainUntil,
        acknowledgedDeviceIds = emptyList(),
    )

fun testPushRequest(
    operation: SyncOperationDto = testOperation(),
    encrypted: EncryptedSyncChunkDto = testEncryptedChunk(),
): CloudSyncPushRequestDto =
    CloudSyncPushRequestDto(
        schemaVersion = CONTRACT_SCHEMA_VERSION,
        baseCursor = null,
        operations = listOf(operation),
        chunks =
            listOf(
                CloudSyncChunkUploadDto(
                    chunkId = operation.encryptedChunkIds.single(),
                    encrypted = encrypted,
                ),
            ),
        tombstones = emptyList(),
    )

class JvmTestAeadKeyHandle(
    projectId: String = TestIds.PROJECT,
    keyVersion: Long = 1,
    private val secureRandom: SecureRandom = SecureRandom(),
) : AeadKeyHandle {
    private val key =
        SecretKeySpec(
            ByteArray(32) { index -> (index + 11).toByte() },
            "AES",
        )

    override val alias: String = ProjectKeyAliases.forProject(projectId, keyVersion)

    override fun assertNonExportable() {
        // This is an isolated JVM fixture. Production uses AndroidKeyStore.
    }

    override fun encrypt(
        plaintext: ByteArray,
        aad: ByteArray,
    ): AeadCiphertext {
        val nonce = ByteArray(12).also(secureRandom::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        return AeadCiphertext(nonce, cipher.doFinal(plaintext))
    }

    override fun decrypt(
        nonce: ByteArray,
        ciphertextAndTag: ByteArray,
        aad: ByteArray,
    ): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(ciphertextAndTag)
    }
}
