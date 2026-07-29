package com.inkshadow.android.poc.crypto

import com.inkshadow.android.poc.TestIds
import com.inkshadow.android.poc.testAad
import java.nio.charset.StandardCharsets
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class SyncAadCodecTest {
    @Test
    fun `AAD is byte-compatible with the frozen sync-core domain format`() {
        val encoded = SyncAadCodec.encode(testAad()).toString(StandardCharsets.UTF_8)

        assertEquals(
            "inkshadow-sync-v1|${TestIds.PROJECT}|chapter_version|" +
                "${TestIds.OBJECT}|${TestIds.VERSION}|0|1",
            encoded,
        )
    }

    @Test
    fun `project version and key version all change authenticated bytes`() {
        val original = SyncAadCodec.encode(testAad())

        assertNotEquals(
            original.toList(),
            SyncAadCodec.encode(testAad(versionId = TestIds.OTHER_VERSION)).toList(),
        )
        assertNotEquals(
            original.toList(),
            SyncAadCodec.encode(testAad(keyVersion = 2)).toList(),
        )
    }
}
