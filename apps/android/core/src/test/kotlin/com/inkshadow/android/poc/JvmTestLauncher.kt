package com.inkshadow.android.poc

import org.junit.platform.engine.discovery.DiscoverySelectors.selectPackage
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder
import org.junit.platform.launcher.core.LauncherFactory
import org.junit.platform.launcher.listeners.SummaryGeneratingListener

/**
 * Allows the PoC tests to run directly from an existing JDK/Kotlin cache when
 * Gradle or the Android SDK is unavailable.
 */
fun main() {
    val request =
        LauncherDiscoveryRequestBuilder
            .request()
            .selectors(selectPackage("com.inkshadow.android.poc"))
            .build()
    val listener = SummaryGeneratingListener()
    LauncherFactory.create().execute(request, listener)
    val summary = listener.summary
    println(
        "Android JVM PoC tests: found=${summary.testsFoundCount}, " +
            "succeeded=${summary.testsSucceededCount}, failed=${summary.testsFailedCount}",
    )
    summary.failures.forEach { failure ->
        println(
            "FAILED ${failure.testIdentifier.displayName}: " +
                failure.exception.javaClass.simpleName,
        )
    }
    if (summary.testsFailedCount > 0) {
        throw IllegalStateException("ANDROID_JVM_TESTS_FAILED")
    }
}
