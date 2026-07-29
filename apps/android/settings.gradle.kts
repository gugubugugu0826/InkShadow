pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "inkshadow-android-architecture-poc"

include(":core")

// The pure JVM core is always buildable. The Android source set is opt-in because
// CI and reviewer machines may intentionally have no Android SDK installed.
if (providers.gradleProperty("inkshadow.includeAndroidSdkModule").orNull == "true") {
    include(":android-keystore")
}
