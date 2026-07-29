package com.inkshadow.android.poc.sync

import com.inkshadow.android.poc.wire.MAX_PORTABLE_INTEGER
import com.inkshadow.android.poc.wire.SyncOperationDto
import com.inkshadow.android.poc.wire.SyncTombstoneDto
import com.inkshadow.android.poc.wire.SyncWireValidator

enum class ConflictResolutionChoice {
    KEEP_LOCAL,
    KEEP_INCOMING,
    MANUAL_MERGE,
}

data class ExplicitConflictResolutionPlan(
    val choice: ConflictResolutionChoice,
    val resolutionOperation: SyncOperationDto,
    val resolutionTombstone: SyncTombstoneDto?,
)

object ConflictResolutionPolicy {
    fun plan(
        conflict: InboundSyncDecision.ManualConflict,
        choice: ConflictResolutionChoice,
        resolutionOperation: SyncOperationDto,
        resolutionTombstone: SyncTombstoneDto? = null,
    ): ExplicitConflictResolutionPlan {
        SyncWireValidator.validate(resolutionOperation)
        resolutionTombstone?.let(SyncWireValidator::validate)
        val local = conflict.local
        val incoming = conflict.incoming
        val correctObject =
            resolutionOperation.operationId != local.operationId &&
                resolutionOperation.operationId != incoming.operationId &&
            resolutionOperation.projectId == local.projectId &&
                resolutionOperation.objectType == local.objectType &&
                resolutionOperation.objectId == local.objectId &&
                resolutionOperation.projectId == incoming.projectId &&
                resolutionOperation.objectType == incoming.objectType &&
                resolutionOperation.objectId == incoming.objectId &&
                resolutionOperation.objectGeneration >=
                maxOf(local.objectGeneration, incoming.objectGeneration)
        val dominatesBoth =
            VersionVectors.compare(local.vector, resolutionOperation.vector) ==
                VersionVectorRelation.BEFORE &&
                VersionVectors.compare(incoming.vector, resolutionOperation.vector) ==
                VersionVectorRelation.BEFORE
        if (!correctObject || !dominatesBoth) {
            throw SyncPolicyException(SyncPolicyErrorCode.INVALID_CONFLICT_RESOLUTION)
        }
        val policy =
            AndroidSyncPolicy(
                com.inkshadow.android.poc.feature.AndroidPocFeatureGate(
                    com.inkshadow.android.poc.feature.AndroidPocFeatureFlags(
                        architecturePocEnabled = true,
                        e2eeSyncEnabled = true,
                    ),
                ),
            )
        try {
            policy.planInbound(
                localDeviceTrust = DeviceTrustState.TRUSTED,
                sourceDeviceTrust = DeviceTrustState.TRUSTED,
                localHead = null,
                activeTombstone = null,
                incoming = resolutionOperation,
                incomingTombstone = resolutionTombstone,
            )
        } catch (_: SyncPolicyException) {
            throw SyncPolicyException(SyncPolicyErrorCode.INVALID_CONFLICT_RESOLUTION)
        }
        return ExplicitConflictResolutionPlan(
            choice = choice,
            resolutionOperation = resolutionOperation,
            resolutionTombstone = resolutionTombstone,
        )
    }
}

enum class RevocationSyncState {
    BLOCKED_UNTIL_KEY_ROTATION,
}

data class DeviceRevocationPlan(
    val revokedDeviceId: String,
    val currentKeyVersion: Long,
    val nextKeyVersion: Long,
    val syncState: RevocationSyncState,
)

object DeviceRevocationPolicy {
    fun planProjectKeyRotation(
        revokedDeviceId: String,
        currentKeyVersion: Long,
    ): DeviceRevocationPlan {
        SyncWireValidator.requireUuidV7(revokedDeviceId)
        SyncWireValidator.requirePositivePortableInteger(currentKeyVersion)
        if (currentKeyVersion == MAX_PORTABLE_INTEGER) {
            throw SyncPolicyException(SyncPolicyErrorCode.KEY_VERSION_EXHAUSTED)
        }
        return DeviceRevocationPlan(
            revokedDeviceId = revokedDeviceId,
            currentKeyVersion = currentKeyVersion,
            nextKeyVersion = currentKeyVersion + 1,
            syncState = RevocationSyncState.BLOCKED_UNTIL_KEY_ROTATION,
        )
    }
}
