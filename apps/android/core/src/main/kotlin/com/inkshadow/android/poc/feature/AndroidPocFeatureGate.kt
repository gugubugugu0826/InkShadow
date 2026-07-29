package com.inkshadow.android.poc.feature

/**
 * Shipping defaults. Creating the architecture PoC does not publish or enable a
 * product capability.
 */
data class AndroidPocFeatureFlags(
    val architecturePocEnabled: Boolean = false,
    val encryptedOfflineCacheEnabled: Boolean = false,
    val e2eeSyncEnabled: Boolean = false,
)

enum class AndroidPocCapability {
    ENCRYPTED_OFFLINE_CACHE,
    E2EE_SYNC,
}

enum class FeatureGateErrorCode {
    ANDROID_POC_DISABLED,
    ENCRYPTED_OFFLINE_CACHE_DISABLED,
    E2EE_SYNC_DISABLED,
}

class FeatureGateException(
    val code: FeatureGateErrorCode,
) : IllegalStateException(code.name)

class AndroidPocFeatureGate(
    private val flags: AndroidPocFeatureFlags = AndroidPocFeatureFlags(),
) {
    fun require(capability: AndroidPocCapability) {
        if (!flags.architecturePocEnabled) {
            throw FeatureGateException(FeatureGateErrorCode.ANDROID_POC_DISABLED)
        }
        when (capability) {
            AndroidPocCapability.ENCRYPTED_OFFLINE_CACHE ->
                if (!flags.encryptedOfflineCacheEnabled) {
                    throw FeatureGateException(
                        FeatureGateErrorCode.ENCRYPTED_OFFLINE_CACHE_DISABLED,
                    )
                }

            AndroidPocCapability.E2EE_SYNC ->
                if (!flags.e2eeSyncEnabled) {
                    throw FeatureGateException(FeatureGateErrorCode.E2EE_SYNC_DISABLED)
                }
        }
    }
}
