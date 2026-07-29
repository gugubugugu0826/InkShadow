package com.inkshadow.android.poc.sync

import com.inkshadow.android.poc.feature.AndroidPocCapability
import com.inkshadow.android.poc.feature.AndroidPocFeatureGate
import com.inkshadow.android.poc.feature.FeatureGateErrorCode
import com.inkshadow.android.poc.feature.FeatureGateException
import com.inkshadow.android.poc.wire.SyncObjectType
import com.inkshadow.android.poc.wire.SyncOperationDto
import com.inkshadow.android.poc.wire.SyncOperationKind
import com.inkshadow.android.poc.wire.SyncTombstoneDto
import com.inkshadow.android.poc.wire.SyncWireValidator

enum class DeviceTrustState {
    TRUSTED,
    REVOKED,
    UNKNOWN,
}

enum class NetworkState {
    ONLINE,
    OFFLINE,
}

data class LocalObjectHead(
    val operationId: String,
    val projectId: String,
    val objectType: SyncObjectType,
    val objectId: String,
    val objectGeneration: Long,
    val vector: Map<String, Long>,
)

sealed interface OutboundSyncDecision {
    data class FeatureDisabled(
        val reason: FeatureGateErrorCode,
    ) : OutboundSyncDecision

    data object LocalDeviceRevoked : OutboundSyncDecision

    data object LocalDeviceUntrusted : OutboundSyncDecision

    data class QueuedOffline(
        val operationId: String,
    ) : OutboundSyncDecision

    data class ReadyForTransport(
        val operation: SyncOperationDto,
    ) : OutboundSyncDecision
}

sealed interface InboundSyncDecision {
    data class FeatureDisabled(
        val reason: FeatureGateErrorCode,
    ) : InboundSyncDecision

    data object LocalDeviceRevoked : InboundSyncDecision

    data object LocalDeviceUntrusted : InboundSyncDecision

    data object SourceDeviceRevoked : InboundSyncDecision

    data object SourceDeviceUntrusted : InboundSyncDecision

    data class BlockedByTombstone(
        val operationId: String,
        val deletedGeneration: Long,
    ) : InboundSyncDecision

    data class Duplicate(
        val operationId: String,
    ) : InboundSyncDecision

    data class IgnoreStale(
        val operationId: String,
    ) : InboundSyncDecision

    data class ApplyCausallyOrdered(
        val operation: SyncOperationDto,
        val tombstone: SyncTombstoneDto?,
    ) : InboundSyncDecision

    data class ManualConflict(
        val local: LocalObjectHead,
        val incoming: SyncOperationDto,
    ) : InboundSyncDecision
}

class AndroidSyncPolicy(
    private val featureGate: AndroidPocFeatureGate,
) {
    fun planOutbound(
        localDeviceId: String,
        localDeviceTrust: DeviceTrustState,
        networkState: NetworkState,
        operation: SyncOperationDto,
    ): OutboundSyncDecision {
        featureDisabledReason()?.let {
            return OutboundSyncDecision.FeatureDisabled(it)
        }
        SyncWireValidator.requireUuidV7(localDeviceId)
        SyncWireValidator.validate(operation)
        if (operation.deviceId != localDeviceId) {
            throw SyncPolicyException(SyncPolicyErrorCode.LOCAL_DEVICE_MISMATCH)
        }
        when (localDeviceTrust) {
            DeviceTrustState.REVOKED -> return OutboundSyncDecision.LocalDeviceRevoked
            DeviceTrustState.UNKNOWN -> return OutboundSyncDecision.LocalDeviceUntrusted
            DeviceTrustState.TRUSTED -> Unit
        }
        return when (networkState) {
            NetworkState.OFFLINE ->
                OutboundSyncDecision.QueuedOffline(operation.operationId)

            NetworkState.ONLINE ->
                OutboundSyncDecision.ReadyForTransport(operation)
        }
    }

    fun planInbound(
        localDeviceTrust: DeviceTrustState,
        sourceDeviceTrust: DeviceTrustState,
        localHead: LocalObjectHead?,
        activeTombstone: SyncTombstoneDto?,
        incoming: SyncOperationDto,
        incomingTombstone: SyncTombstoneDto? = null,
    ): InboundSyncDecision {
        featureDisabledReason()?.let {
            return InboundSyncDecision.FeatureDisabled(it)
        }
        SyncWireValidator.validate(incoming)
        activeTombstone?.let(SyncWireValidator::validate)
        incomingTombstone?.let(SyncWireValidator::validate)

        when (localDeviceTrust) {
            DeviceTrustState.REVOKED -> return InboundSyncDecision.LocalDeviceRevoked
            DeviceTrustState.UNKNOWN -> return InboundSyncDecision.LocalDeviceUntrusted
            DeviceTrustState.TRUSTED -> Unit
        }
        when (sourceDeviceTrust) {
            DeviceTrustState.REVOKED -> return InboundSyncDecision.SourceDeviceRevoked
            DeviceTrustState.UNKNOWN -> return InboundSyncDecision.SourceDeviceUntrusted
            DeviceTrustState.TRUSTED -> Unit
        }

        validateIncomingDelete(incoming, incomingTombstone)
        validateLocalHead(localHead, incoming)
        activeTombstone?.let { tombstone ->
            if (!sameObject(tombstone, incoming)) {
                throw SyncPolicyException(SyncPolicyErrorCode.OBJECT_SCOPE_MISMATCH)
            }
            if (incoming.objectGeneration <= tombstone.objectGeneration) {
                return InboundSyncDecision.BlockedByTombstone(
                    operationId = incoming.operationId,
                    deletedGeneration = tombstone.objectGeneration,
                )
            }
        }
        if (localHead == null) {
            return InboundSyncDecision.ApplyCausallyOrdered(incoming, incomingTombstone)
        }
        if (incoming.objectGeneration < localHead.objectGeneration) {
            return InboundSyncDecision.IgnoreStale(incoming.operationId)
        }

        return when (VersionVectors.compare(localHead.vector, incoming.vector)) {
            VersionVectorRelation.EQUAL ->
                InboundSyncDecision.Duplicate(incoming.operationId)

            VersionVectorRelation.BEFORE ->
                InboundSyncDecision.ApplyCausallyOrdered(incoming, incomingTombstone)

            VersionVectorRelation.AFTER ->
                InboundSyncDecision.IgnoreStale(incoming.operationId)

            VersionVectorRelation.CONCURRENT ->
                InboundSyncDecision.ManualConflict(localHead, incoming)
        }
    }

    private fun featureDisabledReason(): FeatureGateErrorCode? =
        try {
            featureGate.require(AndroidPocCapability.E2EE_SYNC)
            null
        } catch (error: FeatureGateException) {
            error.code
        }

    private fun validateIncomingDelete(
        incoming: SyncOperationDto,
        tombstone: SyncTombstoneDto?,
    ) {
        if (incoming.kind == SyncOperationKind.UPSERT) {
            if (tombstone != null) {
                throw SyncPolicyException(SyncPolicyErrorCode.UNEXPECTED_TOMBSTONE)
            }
            return
        }
        if (tombstone == null ||
            tombstone.projectId != incoming.projectId ||
            tombstone.objectType != incoming.objectType ||
            tombstone.objectId != incoming.objectId ||
            tombstone.objectGeneration != incoming.objectGeneration ||
            tombstone.deletedByDeviceId != incoming.deviceId ||
            tombstone.vector != incoming.vector
        ) {
            throw SyncPolicyException(SyncPolicyErrorCode.DELETE_TOMBSTONE_MISMATCH)
        }
    }

    private fun validateLocalHead(
        localHead: LocalObjectHead?,
        incoming: SyncOperationDto,
    ) {
        if (localHead == null) {
            return
        }
        SyncWireValidator.requireUuidV7(localHead.operationId)
        SyncWireValidator.requireUuidV7(localHead.projectId)
        SyncWireValidator.requireUuidV7(localHead.objectId)
        SyncWireValidator.requirePositivePortableInteger(localHead.objectGeneration)
        SyncWireValidator.validateVersionVector(localHead.vector)
        if (localHead.projectId != incoming.projectId ||
            localHead.objectType != incoming.objectType ||
            localHead.objectId != incoming.objectId
        ) {
            throw SyncPolicyException(SyncPolicyErrorCode.OBJECT_SCOPE_MISMATCH)
        }
    }

    private fun sameObject(
        tombstone: SyncTombstoneDto,
        operation: SyncOperationDto,
    ): Boolean =
        tombstone.projectId == operation.projectId &&
            tombstone.objectType == operation.objectType &&
            tombstone.objectId == operation.objectId
}

enum class SyncPolicyErrorCode {
    LOCAL_DEVICE_MISMATCH,
    OBJECT_SCOPE_MISMATCH,
    DELETE_TOMBSTONE_MISMATCH,
    UNEXPECTED_TOMBSTONE,
    INVALID_CONFLICT_RESOLUTION,
    KEY_VERSION_EXHAUSTED,
}

class SyncPolicyException(
    val code: SyncPolicyErrorCode,
) : IllegalArgumentException(code.name)
