package com.inkshadow.android.poc.crypto

import com.inkshadow.android.poc.wire.SyncChunkAadDto
import com.inkshadow.android.poc.wire.SyncWireValidator
import java.nio.charset.StandardCharsets

/**
 * Byte-for-byte equivalent to packages/sync-core's canonical AAD.
 */
object SyncAadCodec {
    private const val DOMAIN = "inkshadow-sync-v1"

    fun encode(aad: SyncChunkAadDto): ByteArray {
        SyncWireValidator.validate(aad)
        return listOf(
            DOMAIN,
            aad.projectId,
            aad.objectType.wireValue,
            aad.objectId,
            aad.versionId,
            aad.chunkIndex.toString(),
            aad.keyVersion.toString(),
        ).joinToString("|").toByteArray(StandardCharsets.UTF_8)
    }
}
