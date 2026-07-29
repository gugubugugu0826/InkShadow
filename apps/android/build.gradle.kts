import org.gradle.api.GradleException

tasks.register("verifyArchitectureBoundary") {
    group = "verification"
    description = "Checks that the JVM policy/crypto core has no Android, UI, or transport dependency."

    val coreSources = fileTree("core/src/main/kotlin") {
        include("**/*.kt")
    }
    inputs.files(coreSources)

    doLast {
        val forbiddenImports = listOf(
            "import android.",
            "import androidx.",
            "import okhttp3.",
            "import retrofit2.",
            "import io.ktor.client.",
        )
        val violations = coreSources.files.flatMap { source ->
            source.readLines().mapIndexedNotNull { index, line ->
                forbiddenImports.firstOrNull(line::contains)?.let {
                    "${source.relativeTo(projectDir)}:${index + 1}: $line"
                }
            }
        }
        if (violations.isNotEmpty()) {
            throw GradleException(
                "Android architecture boundary violations:\n${violations.joinToString("\n")}",
            )
        }
    }
}

tasks.register("verifyNoBodySnapshots") {
    group = "verification"
    description = "Rejects snapshot/golden files that could capture story body content."

    doLast {
        val snapshotFiles = fileTree(projectDir) {
            include("**/__snapshots__/**")
            include("**/*.snap")
            include("**/*.golden")
            exclude("**/build/**")
            exclude("**/.gradle/**")
        }.files
        if (snapshotFiles.isNotEmpty()) {
            throw GradleException(
                "Body-bearing snapshots are forbidden in the Android PoC:\n" +
                    snapshotFiles.joinToString("\n") { it.relativeTo(projectDir).path },
            )
        }
    }
}

tasks.register("check") {
    group = "verification"
    dependsOn(":core:check")
    dependsOn("verifyArchitectureBoundary")
    dependsOn("verifyNoBodySnapshots")
}
