package com.inkshadow.android.poc.cache

import com.inkshadow.android.poc.crypto.AeadKeyHandle
import com.inkshadow.android.poc.crypto.ProjectKeyAliases
import com.inkshadow.android.poc.crypto.SyncAadCodec
import com.inkshadow.android.poc.feature.AndroidPocCapability
import com.inkshadow.android.poc.feature.AndroidPocFeatureGate
import com.inkshadow.android.poc.wire.CONTRACT_SCHEMA_VERSION
import com.inkshadow.android.poc.wire.EncryptedSyncChunkDto
import com.inkshadow.android.poc.wire.MAX_PLAINTEXT_BYTES
import com.inkshadow.android.poc.wire.SyncChunkAadDto
import com.inkshadow.android.poc.wire.SyncWireValidator

class EncryptedOfflineCache(
    private val featureGate: AndroidPocFeatureGate,
    private val keyHandle: AeadKeyHandle,
    private val store: EncryptedCacheStore,
) {
    fun put(
        recordId: String,
        aad: SyncChunkAadDto,
        plaintext: ByteArray,
    ): EncryptedCacheRecord {
        featureGate.require(AndroidPocCapability.ENCRYPTED_OFFLINE_CACHE)
        SyncWireValidator.requireUuidV7(recordId)
        SyncWireValidator.validate(aad)
        if (plaintext.size > MAX_PLAINTEXT_BYTES) {
            throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
        }
        assertExpectedKeyAlias(aad)
        keyHandle.assertNonExportable()
        val encodedAad = SyncAadCodec.encode(aad)

        repeat(MAX_NONCE_ATTEMPTS) {
            val encrypted = keyHandle.encrypt(plaintext, encodedAad)
            if (encrypted.nonce.size != AES_GCM_NONCE_BYTES) {
                throw CacheSecurityException(CacheSecurityErrorCode.INVALID_NONCE)
            }
            val ciphertext = encrypted.ciphertextAndTag.copyOf()
            val wireChunk =
                EncryptedSyncChunkDto(
                    schemaVersion = CONTRACT_SCHEMA_VERSION,
                    algorithm = "AES-256-GCM",
                    nonce = SyncWireValidator.encodeBase64Url(encrypted.nonce),
                    ciphertext = SyncWireValidator.encodeBase64Url(ciphertext),
                    ciphertextSha256 = SyncWireValidator.sha256Hex(ciphertext),
                    plaintextBytes = plaintext.size,
                    aad = aad,
                )
            SyncWireValidator.validate(wireChunk)
            val record =
                EncryptedCacheRecord(
                    schemaVersion = ENCRYPTED_CACHE_SCHEMA_VERSION,
                    recordId = recordId,
                    keyAlias = keyHandle.alias,
                    encrypted = wireChunk,
                )
            if (store.putIfNonceUnused(record)) {
                return record
            }
        }
        throw CacheSecurityException(CacheSecurityErrorCode.NONCE_COLLISION)
    }

    fun get(recordId: String): ByteArray {
        featureGate.require(AndroidPocCapability.ENCRYPTED_OFFLINE_CACHE)
        SyncWireValidator.requireUuidV7(recordId)
        keyHandle.assertNonExportable()
        val record = store.read(recordId)
        validateRecord(record, recordId)
        val chunk = record.encrypted
        val ciphertext = SyncWireValidator.decodeBase64Url(chunk.ciphertext)
        if (!SyncWireValidator.constantTimeSha256Matches(
                ciphertext,
                chunk.ciphertextSha256,
            )
        ) {
            throw CacheSecurityException(CacheSecurityErrorCode.INTEGRITY_FAILURE)
        }
        val plaintext =
            try {
                keyHandle.decrypt(
                    nonce = SyncWireValidator.decodeBase64Url(chunk.nonce),
                    ciphertextAndTag = ciphertext,
                    aad = SyncAadCodec.encode(chunk.aad),
                )
            } catch (_: Exception) {
                throw CacheSecurityException(CacheSecurityErrorCode.INTEGRITY_FAILURE)
            }
        if (plaintext.size != chunk.plaintextBytes) {
            plaintext.fill(0)
            throw CacheSecurityException(CacheSecurityErrorCode.INTEGRITY_FAILURE)
        }
        return plaintext
    }

    private fun validateRecord(
        record: EncryptedCacheRecord,
        expectedRecordId: String,
    ) {
        if (record.schemaVersion != ENCRYPTED_CACHE_SCHEMA_VERSION ||
            record.recordId != expectedRecordId
        ) {
            throw CacheSecurityException(CacheSecurityErrorCode.INVALID_RECORD)
        }
        SyncWireValidator.validate(record.encrypted)
        assertExpectedKeyAlias(record.encrypted.aad)
        if (record.keyAlias != keyHandle.alias) {
            throw CacheSecurityException(CacheSecurityErrorCode.KEY_ALIAS_MISMATCH)
        }
    }

    private fun assertExpectedKeyAlias(aad: SyncChunkAadDto) {
        val expectedAlias =
            ProjectKeyAliases.forProject(
                projectId = aad.projectId,
                keyVersion = aad.keyVersion,
            )
        if (keyHandle.alias != expectedAlias) {
            throw CacheSecurityException(CacheSecurityErrorCode.KEY_ALIAS_MISMATCH)
        }
    }

    private companion object {
        const val AES_GCM_NONCE_BYTES = 12
        const val MAX_NONCE_ATTEMPTS = 8
    }
}
