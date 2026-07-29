plugins {
    id("com.android.library") version "8.11.1"
    kotlin("android") version "2.2.20"
}

android {
    namespace = "com.inkshadow.android.keystore"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

dependencies {
    implementation(project(":core"))
}
