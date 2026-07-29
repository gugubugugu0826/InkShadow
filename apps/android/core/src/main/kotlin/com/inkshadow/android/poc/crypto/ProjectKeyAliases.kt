package com.inkshadow.android.poc.crypto

import com.inkshadow.android.poc.wire.SyncWireValidator

object ProjectKeyAliases {
    private const val PREFIX = "inkshadow.project."

    fun forProject(
        projectId: String,
        keyVersion: Long,
    ): String {
        SyncWireValidator.requireUuidV7(projectId)
        SyncWireValidator.requirePositivePortableInteger(keyVersion)
        return "$PREFIX$projectId.v$keyVersion"
    }
}
