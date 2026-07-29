package com.inkshadow.android.poc.logging

import com.inkshadow.android.poc.sync.DeviceTrustState
import com.inkshadow.android.poc.sync.NetworkState
import com.inkshadow.android.poc.wire.SyncObjectType
import com.inkshadow.android.poc.wire.SyncOperationKind

enum class AndroidDiagnosticEventName {
    CACHE_WRITE,
    CACHE_READ,
    SYNC_POLICY_DECISION,
    KEY_ROTATION_REQUIRED,
}

enum class AndroidDiagnosticResultCode {
    SUCCESS,
    FEATURE_DISABLED,
    QUEUED_OFFLINE,
    DEVICE_REVOKED,
    DEVICE_UNTRUSTED,
    DUPLICATE,
    STALE,
    CONFLICT,
    INTEGRITY_FAILURE,
    STORAGE_FAILURE,
}

data class SafeAndroidDiagnosticEvent(
    val name: AndroidDiagnosticEventName,
    val result: AndroidDiagnosticResultCode,
    val objectType: SyncObjectType? = null,
    val operationKind: SyncOperationKind? = null,
    val networkState: NetworkState? = null,
    val deviceTrustState: DeviceTrustState? = null,
    val durationBucket: Int? = null,
    val queueDepthBucket: Int? = null,
) {
    init {
        require(durationBucket == null || durationBucket in 0..20)
        require(queueDepthBucket == null || queueDepthBucket in 0..20)
    }
}

/**
 * Deliberately has no free-form message, Throwable, body, prompt, token, key,
 * recovery code, project title, or identifier parameter.
 */
fun interface SafeAndroidEventSink {
    fun emit(event: SafeAndroidDiagnosticEvent)
}

class SafeAndroidEventLogger(
    private val sink: SafeAndroidEventSink,
) {
    fun log(event: SafeAndroidDiagnosticEvent) {
        sink.emit(event)
    }
}
