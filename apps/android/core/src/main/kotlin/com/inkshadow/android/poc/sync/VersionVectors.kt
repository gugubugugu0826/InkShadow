package com.inkshadow.android.poc.sync

import com.inkshadow.android.poc.wire.SyncWireValidator

enum class VersionVectorRelation {
    EQUAL,
    BEFORE,
    AFTER,
    CONCURRENT,
}

object VersionVectors {
    fun compare(
        left: Map<String, Long>,
        right: Map<String, Long>,
    ): VersionVectorRelation {
        SyncWireValidator.validateVersionVector(left)
        SyncWireValidator.validateVersionVector(right)
        var leftIsLower = false
        var leftIsHigher = false
        (left.keys + right.keys).forEach { deviceId ->
            val leftCounter = left[deviceId] ?: 0L
            val rightCounter = right[deviceId] ?: 0L
            if (leftCounter < rightCounter) {
                leftIsLower = true
            }
            if (leftCounter > rightCounter) {
                leftIsHigher = true
            }
        }
        return when {
            leftIsLower && leftIsHigher -> VersionVectorRelation.CONCURRENT
            leftIsLower -> VersionVectorRelation.BEFORE
            leftIsHigher -> VersionVectorRelation.AFTER
            else -> VersionVectorRelation.EQUAL
        }
    }
}
