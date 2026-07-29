package com.inkshadow.android.poc.cache

import com.inkshadow.android.poc.JvmTestAeadKeyHandle
import com.inkshadow.android.poc.TestIds
import com.inkshadow.android.poc.feature.AndroidPocFeatureFlags
import com.inkshadow.android.poc.feature.AndroidPocFeatureGate
import com.inkshadow.android.poc.feature.FeatureGateException
import com.inkshadow.android.poc.testAad
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readBytes
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import org.junit.jupiter.api.io.TempDir

class EncryptedOfflineCacheTest {
    @TempDir
    lateinit var temporaryDirectory: Path

    @Test
    fun `encrypted cache round trips without persisting body and uses unique nonces`() {
        val cache = enabledCache()
        val body = "DRAFT_BODY_MUST_NEVER_BE_STORED".toByteArray(StandardCharsets.UTF_8)

        val first = cache.put(TestIds.RECORD_A, testAad(), body)
        val second = cache.put(TestIds.RECORD_B, testAad(chunkIndex = 1), body)

        assertNotEquals(first.encrypted.nonce, second.encrypted.nonce)
        assertContentEquals(body, cache.get(TestIds.RECORD_A))
        val persisted =
            Files.list(temporaryDirectory).use { files ->
                files
                    .filter { it.fileName.toString().endsWith(".iscache") }
                    .map(Path::readBytes)
                    .toList()
            }
        assertFalse(persisted.any { it.containsSubsequence(body) })
    }

    @Test
    fun `ciphertext tampering fails closed before decryption`() {
        val cache = enabledCache()
        val record =
            cache.put(
                TestIds.RECORD_A,
                testAad(),
                "integrity-probe".toByteArray(StandardCharsets.UTF_8),
            )
        replaceBytesInRecord(
            recordId = record.recordId,
            from = record.encrypted.ciphertext.toByteArray(StandardCharsets.UTF_8),
            to =
                record.encrypted.ciphertext
                    .replaceRange(0, 1, if (record.encrypted.ciphertext[0] == 'A') "B" else "A")
                    .toByteArray(StandardCharsets.UTF_8),
        )

        val error =
            assertFailsWith<CacheSecurityException> {
                cache.get(TestIds.RECORD_A)
            }
        assertEquals(CacheSecurityErrorCode.INTEGRITY_FAILURE, error.code)
    }

    @Test
    fun `version binding in AAD rejects substitution`() {
        val cache = enabledCache()
        cache.put(
            TestIds.RECORD_A,
            testAad(),
            "aad-probe".toByteArray(StandardCharsets.UTF_8),
        )
        replaceBytesInRecord(
            recordId = TestIds.RECORD_A,
            from = TestIds.VERSION.toByteArray(StandardCharsets.UTF_8),
            to = TestIds.OTHER_VERSION.toByteArray(StandardCharsets.UTF_8),
        )

        val error =
            assertFailsWith<CacheSecurityException> {
                cache.get(TestIds.RECORD_A)
            }
        assertEquals(CacheSecurityErrorCode.INTEGRITY_FAILURE, error.code)
    }

    @Test
    fun `project binding rejects moving ciphertext to another project`() {
        val cache = enabledCache()
        cache.put(
            TestIds.RECORD_A,
            testAad(),
            "project-binding-probe".toByteArray(StandardCharsets.UTF_8),
        )
        replaceBytesInRecord(
            recordId = TestIds.RECORD_A,
            from = TestIds.PROJECT.toByteArray(StandardCharsets.UTF_8),
            to = TestIds.OTHER_PROJECT.toByteArray(StandardCharsets.UTF_8),
        )

        val error =
            assertFailsWith<CacheSecurityException> {
                cache.get(TestIds.RECORD_A)
            }
        assertEquals(CacheSecurityErrorCode.INVALID_RECORD, error.code)
    }

    @Test
    fun `nonce substitution fails GCM authentication`() {
        val cache = enabledCache()
        val record =
            cache.put(
                TestIds.RECORD_A,
                testAad(),
                "nonce-probe".toByteArray(StandardCharsets.UTF_8),
            )
        val changedNonce =
            record.encrypted.nonce.replaceRange(
                0,
                1,
                if (record.encrypted.nonce[0] == 'A') "B" else "A",
            )
        replaceBytesInRecord(
            recordId = TestIds.RECORD_A,
            from = record.encrypted.nonce.toByteArray(StandardCharsets.UTF_8),
            to = changedNonce.toByteArray(StandardCharsets.UTF_8),
        )

        val error =
            assertFailsWith<CacheSecurityException> {
                cache.get(TestIds.RECORD_A)
            }
        assertEquals(CacheSecurityErrorCode.INTEGRITY_FAILURE, error.code)
    }

    @Test
    fun `shipping defaults block cache before touching storage`() {
        var storageTouched = false
        val store =
            object : EncryptedCacheStore {
                override fun putIfNonceUnused(record: EncryptedCacheRecord): Boolean {
                    storageTouched = true
                    return true
                }

                override fun read(recordId: String): EncryptedCacheRecord {
                    storageTouched = true
                    throw AssertionError("must not read")
                }
            }
        val cache =
            EncryptedOfflineCache(
                featureGate = AndroidPocFeatureGate(),
                keyHandle = JvmTestAeadKeyHandle(),
                store = store,
            )

        assertFailsWith<FeatureGateException> {
            cache.put(TestIds.RECORD_A, testAad(), byteArrayOf(1))
        }
        assertFalse(storageTouched)
    }

    private fun enabledCache(): EncryptedOfflineCache =
        EncryptedOfflineCache(
            featureGate =
                AndroidPocFeatureGate(
                    AndroidPocFeatureFlags(
                        architecturePocEnabled = true,
                        encryptedOfflineCacheEnabled = true,
                    ),
                ),
            keyHandle = JvmTestAeadKeyHandle(),
            store = FileEncryptedCacheStore(temporaryDirectory),
        )

    private fun replaceBytesInRecord(
        recordId: String,
        from: ByteArray,
        to: ByteArray,
    ) {
        require(from.size == to.size)
        val path = temporaryDirectory.resolve("$recordId.iscache")
        val bytes = Files.readAllBytes(path)
        val offset = bytes.indexOfSubsequence(from)
        require(offset >= 0)
        to.copyInto(bytes, destinationOffset = offset)
        Files.write(path, bytes)
    }
}

private fun ByteArray.containsSubsequence(needle: ByteArray): Boolean =
    indexOfSubsequence(needle) >= 0

private fun ByteArray.indexOfSubsequence(needle: ByteArray): Int {
    if (needle.isEmpty()) {
        return 0
    }
    for (start in 0..size - needle.size) {
        if (needle.indices.all { index -> this[start + index] == needle[index] }) {
            return start
        }
    }
    return -1
}
