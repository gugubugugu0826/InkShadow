package com.inkshadow.android.poc.sync

import com.inkshadow.android.poc.TestIds
import com.inkshadow.android.poc.feature.AndroidPocFeatureFlags
import com.inkshadow.android.poc.feature.AndroidPocFeatureGate
import com.inkshadow.android.poc.testOperation
import com.inkshadow.android.poc.testTombstone
import com.inkshadow.android.poc.wire.SyncObjectType
import com.inkshadow.android.poc.wire.SyncOperationKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs

class AndroidSyncPolicyTest {
    @Test
    fun `shipping defaults disable sync architecture`() {
        val decision =
            AndroidSyncPolicy(AndroidPocFeatureGate()).planOutbound(
                localDeviceId = TestIds.DEVICE_A,
                localDeviceTrust = DeviceTrustState.TRUSTED,
                networkState = NetworkState.ONLINE,
                operation = testOperation(),
            )

        assertIs<OutboundSyncDecision.FeatureDisabled>(decision)
    }

    @Test
    fun `offline work is queued and never reported as uploaded`() {
        val decision =
            enabledPolicy().planOutbound(
                localDeviceId = TestIds.DEVICE_A,
                localDeviceTrust = DeviceTrustState.TRUSTED,
                networkState = NetworkState.OFFLINE,
                operation = testOperation(),
            )

        assertEquals(
            OutboundSyncDecision.QueuedOffline(TestIds.OPERATION_A),
            decision,
        )
    }

    @Test
    fun `revoked local and source devices are blocked`() {
        val outbound =
            enabledPolicy().planOutbound(
                localDeviceId = TestIds.DEVICE_A,
                localDeviceTrust = DeviceTrustState.REVOKED,
                networkState = NetworkState.ONLINE,
                operation = testOperation(),
            )
        val inbound =
            enabledPolicy().planInbound(
                localDeviceTrust = DeviceTrustState.TRUSTED,
                sourceDeviceTrust = DeviceTrustState.REVOKED,
                localHead = null,
                activeTombstone = null,
                incoming = testOperation(),
            )

        assertIs<OutboundSyncDecision.LocalDeviceRevoked>(outbound)
        assertIs<InboundSyncDecision.SourceDeviceRevoked>(inbound)
    }

    @Test
    fun `concurrent vectors produce manual conflict and never overwrite`() {
        val local =
            LocalObjectHead(
                operationId = TestIds.OPERATION_A,
                projectId = TestIds.PROJECT,
                objectType = SyncObjectType.CHAPTER_VERSION,
                objectId = TestIds.OBJECT,
                objectGeneration = 1,
                vector = mapOf(TestIds.DEVICE_A to 2L),
            )
        val incoming =
            testOperation(
                operationId = TestIds.OPERATION_B,
                deviceId = TestIds.DEVICE_B,
                deviceSequence = 1,
                vector =
                    mapOf(
                        TestIds.DEVICE_A to 1L,
                        TestIds.DEVICE_B to 1L,
                    ),
            )

        val decision =
            enabledPolicy().planInbound(
                localDeviceTrust = DeviceTrustState.TRUSTED,
                sourceDeviceTrust = DeviceTrustState.TRUSTED,
                localHead = local,
                activeTombstone = null,
                incoming = incoming,
            )

        val conflict = assertIs<InboundSyncDecision.ManualConflict>(decision)
        val resolution =
            testOperation(
                operationId = TestIds.OPERATION_C,
                deviceId = TestIds.DEVICE_A,
                deviceSequence = 3,
                vector =
                    mapOf(
                        TestIds.DEVICE_A to 3L,
                        TestIds.DEVICE_B to 1L,
                    ),
            )
        val plan =
            ConflictResolutionPolicy.plan(
                conflict = conflict,
                choice = ConflictResolutionChoice.MANUAL_MERGE,
                resolutionOperation = resolution,
            )
        assertEquals(ConflictResolutionChoice.MANUAL_MERGE, plan.choice)
    }

    @Test
    fun `tombstone blocks stale generation resurrection`() {
        val delete =
            testOperation(
                operationId = TestIds.OPERATION_A,
                deviceSequence = 2,
                vector = mapOf(TestIds.DEVICE_A to 2L),
                kind = SyncOperationKind.DELETE,
                encryptedChunkIds = emptyList(),
                objectGeneration = 2,
            )
        val activeTombstone = testTombstone(delete)
        val incoming =
            testOperation(
                operationId = TestIds.OPERATION_B,
                deviceId = TestIds.DEVICE_B,
                deviceSequence = 1,
                vector = mapOf(TestIds.DEVICE_B to 1L),
                objectGeneration = 2,
            )

        val decision =
            enabledPolicy().planInbound(
                localDeviceTrust = DeviceTrustState.TRUSTED,
                sourceDeviceTrust = DeviceTrustState.TRUSTED,
                localHead = null,
                activeTombstone = activeTombstone,
                incoming = incoming,
            )

        assertIs<InboundSyncDecision.BlockedByTombstone>(decision)
    }

    @Test
    fun `delete without exact tombstone fails closed`() {
        val delete =
            testOperation(
                kind = SyncOperationKind.DELETE,
                encryptedChunkIds = emptyList(),
            )

        val error =
            assertFailsWith<SyncPolicyException> {
                enabledPolicy().planInbound(
                    localDeviceTrust = DeviceTrustState.TRUSTED,
                    sourceDeviceTrust = DeviceTrustState.TRUSTED,
                    localHead = null,
                    activeTombstone = null,
                    incoming = delete,
                )
            }

        assertEquals(SyncPolicyErrorCode.DELETE_TOMBSTONE_MISMATCH, error.code)
    }

    @Test
    fun `device revocation blocks sync until project key rotation`() {
        val plan =
            DeviceRevocationPolicy.planProjectKeyRotation(
                revokedDeviceId = TestIds.DEVICE_B,
                currentKeyVersion = 4,
            )

        assertEquals(5, plan.nextKeyVersion)
        assertEquals(
            RevocationSyncState.BLOCKED_UNTIL_KEY_ROTATION,
            plan.syncState,
        )
    }

    private fun enabledPolicy(): AndroidSyncPolicy =
        AndroidSyncPolicy(
            AndroidPocFeatureGate(
                AndroidPocFeatureFlags(
                    architecturePocEnabled = true,
                    e2eeSyncEnabled = true,
                ),
            ),
        )
}
