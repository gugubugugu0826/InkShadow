package com.inkshadow.android.poc.cache

import com.inkshadow.android.poc.wire.EncryptedSyncChunkDto

const val ENCRYPTED_CACHE_SCHEMA_VERSION: Int = 1

data class EncryptedCacheRecord(
    val schemaVersion: Int,
    val recordId: String,
    val keyAlias: String,
    val encrypted: EncryptedSyncChunkDto,
)

enum class CacheSecurityErrorCode {
    INVALID_RECORD,
    RECORD_ALREADY_EXISTS,
    RECORD_NOT_FOUND,
    KEY_ALIAS_MISMATCH,
    INVALID_NONCE,
    NONCE_COLLISION,
    INTEGRITY_FAILURE,
    STORAGE_FAILURE,
    CACHE_LIMIT_EXCEEDED,
}

class CacheSecurityException(
    val code: CacheSecurityErrorCode,
) : IllegalStateException(code.name)

interface EncryptedCacheStore {
    /**
     * Stores an immutable record only when the nonce has never been used with
     * the same key alias. Returns false on a nonce collision.
     */
    fun putIfNonceUnused(record: EncryptedCacheRecord): Boolean

    fun read(recordId: String): EncryptedCacheRecord
}
