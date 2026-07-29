package com.inkshadow.android.poc.logging

import com.inkshadow.android.poc.sync.NetworkState
import com.inkshadow.android.poc.wire.SyncObjectType
import java.nio.charset.StandardCharsets
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SafeAndroidEventLoggerTest {
    @Test
    fun `diagnostic API cannot accept body prompt key token or throwable`() {
        val emitted = mutableListOf<SafeAndroidDiagnosticEvent>()
        val logger = SafeAndroidEventLogger(emitted::add)
        val body = "BODY_SHOULD_NOT_REACH_DIAGNOSTICS"

        logger.log(
            SafeAndroidDiagnosticEvent(
                name = AndroidDiagnosticEventName.SYNC_POLICY_DECISION,
                result = AndroidDiagnosticResultCode.QUEUED_OFFLINE,
                objectType = SyncObjectType.CHAPTER_VERSION,
                networkState = NetworkState.OFFLINE,
                queueDepthBucket = 1,
            ),
        )

        val diagnostics =
            emitted.joinToString(separator = "\n").toByteArray(StandardCharsets.UTF_8)
        assertFalse(diagnostics.containsSubsequence(body.toByteArray(StandardCharsets.UTF_8)))
        assertTrue(diagnostics.isNotEmpty())
    }
}

private fun ByteArray.containsSubsequence(needle: ByteArray): Boolean {
    if (needle.isEmpty()) {
        return true
    }
    for (start in 0..size - needle.size) {
        if (needle.indices.all { index -> this[start + index] == needle[index] }) {
            return true
        }
    }
    return false
}
