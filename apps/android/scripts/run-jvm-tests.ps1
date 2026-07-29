$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$androidRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $androidRoot "..\.."))
$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot ".tmp\android-jvm-tests"))
$allowedBuildPrefix = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot ".tmp")) +
    [System.IO.Path]::DirectorySeparatorChar
if (-not $buildRoot.StartsWith(
        $allowedBuildPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to clean an output directory outside the repository .tmp directory."
}
if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
$mainOutput = New-Item -ItemType Directory -Force -Path (Join-Path $buildRoot "main")
$testOutput = New-Item -ItemType Directory -Force -Path (Join-Path $buildRoot "test")

$javaCommand = Get-Command java -ErrorAction Stop
$java = $javaCommand.Source
$profileRoot = [Environment]::GetEnvironmentVariable("USERPROFILE")
if ([string]::IsNullOrWhiteSpace($profileRoot)) {
    $profileRoot = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::UserProfile
    )
}
$gradleArtifactCache = Join-Path $profileRoot ".gradle\caches\modules-2\files-2.1"

function Get-CachedJar {
    param(
        [Parameter(Mandatory = $true)][string]$RelativeModulePath,
        [Parameter(Mandatory = $true)][string]$FileName
    )
    $modulePath = Join-Path $gradleArtifactCache $RelativeModulePath
    if (-not (Test-Path -LiteralPath $modulePath)) {
        throw "Required cached Kotlin/JUnit module is unavailable: $RelativeModulePath"
    }
    $jar = Get-ChildItem -LiteralPath $modulePath -Recurse -Filter $FileName |
        Where-Object { $_.Name -notlike "*-sources.jar" } |
        Select-Object -First 1
    if ($null -eq $jar) {
        throw "Required cached Kotlin/JUnit artifact is unavailable: $FileName"
    }
    return $jar.FullName
}

$compilerJar = Get-CachedJar `
    "org.jetbrains.kotlin\kotlin-compiler-embeddable\2.2.20" `
    "kotlin-compiler-embeddable-2.2.20.jar"
$stdlibJar = Get-CachedJar `
    "org.jetbrains.kotlin\kotlin-stdlib\2.2.20" `
    "kotlin-stdlib-2.2.20.jar"
$scriptRuntimeJar = Get-CachedJar `
    "org.jetbrains.kotlin\kotlin-script-runtime\2.2.20" `
    "kotlin-script-runtime-2.2.20.jar"
$reflectJar = Get-CachedJar `
    "org.jetbrains.kotlin\kotlin-reflect\1.6.10" `
    "kotlin-reflect-1.6.10.jar"
$daemonJar = Get-CachedJar `
    "org.jetbrains.kotlin\kotlin-daemon-embeddable\2.2.20" `
    "kotlin-daemon-embeddable-2.2.20.jar"
$coroutinesJar = Get-CachedJar `
    "org.jetbrains.kotlinx\kotlinx-coroutines-core-jvm\1.8.0" `
    "kotlinx-coroutines-core-jvm-1.8.0.jar"
$troveJar = Get-CachedJar `
    "org.jetbrains.intellij.deps\trove4j\1.0.20200330" `
    "trove4j-1.0.20200330.jar"
$annotationsJar = Get-CachedJar `
    "org.jetbrains\annotations\13.0" `
    "annotations-13.0.jar"
$kotlinTestJar = Get-CachedJar `
    "org.jetbrains.kotlin\kotlin-test\2.2.20" `
    "kotlin-test-2.2.20.jar"
$kotlinTestJunitJar = Get-CachedJar `
    "org.jetbrains.kotlin\kotlin-test-junit5\2.2.20" `
    "kotlin-test-junit5-2.2.20.jar"
$junitApiJar = Get-CachedJar `
    "org.junit.jupiter\junit-jupiter-api\5.10.1" `
    "junit-jupiter-api-5.10.1.jar"
$junitEngineJar = Get-CachedJar `
    "org.junit.jupiter\junit-jupiter-engine\5.10.1" `
    "junit-jupiter-engine-5.10.1.jar"
$platformLauncherJar = Get-CachedJar `
    "org.junit.platform\junit-platform-launcher\1.10.1" `
    "junit-platform-launcher-1.10.1.jar"
$platformEngineJar = Get-CachedJar `
    "org.junit.platform\junit-platform-engine\1.10.1" `
    "junit-platform-engine-1.10.1.jar"
$platformCommonsJar = Get-CachedJar `
    "org.junit.platform\junit-platform-commons\1.10.1" `
    "junit-platform-commons-1.10.1.jar"
$openTestJar = Get-CachedJar `
    "org.opentest4j\opentest4j\1.3.0" `
    "opentest4j-1.3.0.jar"
$apiGuardianJar = Get-CachedJar `
    "org.apiguardian\apiguardian-api\1.1.2" `
    "apiguardian-api-1.1.2.jar"

$compilerClasspath = (
    $compilerJar,
    $stdlibJar,
    $scriptRuntimeJar,
    $reflectJar,
    $daemonJar,
    $coroutinesJar,
    $troveJar,
    $annotationsJar
) -join [System.IO.Path]::PathSeparator

$mainSources = Get-ChildItem `
    -LiteralPath (Join-Path $androidRoot "core\src\main\kotlin") `
    -Recurse `
    -Filter "*.kt" |
    Select-Object -ExpandProperty FullName
$mainArguments = @(
    "-cp",
    $compilerClasspath,
    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
    "-jvm-target",
    "17",
    "-Werror",
    "-no-stdlib",
    "-classpath",
    $stdlibJar,
    "-d",
    $mainOutput.FullName
) + $mainSources
& $java @mainArguments
if ($LASTEXITCODE -ne 0) {
    throw "Android JVM main-source compilation failed."
}

$testCompileClasspath = (
    $mainOutput.FullName,
    $stdlibJar,
    $kotlinTestJar,
    $kotlinTestJunitJar,
    $junitApiJar,
    $platformLauncherJar,
    $platformEngineJar,
    $platformCommonsJar,
    $openTestJar,
    $apiGuardianJar
) -join [System.IO.Path]::PathSeparator
$testSources = Get-ChildItem `
    -LiteralPath (Join-Path $androidRoot "core\src\test\kotlin") `
    -Recurse `
    -Filter "*.kt" |
    Select-Object -ExpandProperty FullName
$testArguments = @(
    "-cp",
    $compilerClasspath,
    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
    "-jvm-target",
    "17",
    "-Werror",
    "-no-stdlib",
    "-classpath",
    $testCompileClasspath,
    "-d",
    $testOutput.FullName
) + $testSources
& $java @testArguments
if ($LASTEXITCODE -ne 0) {
    throw "Android JVM test-source compilation failed."
}

$runtimeClasspath = (
    $mainOutput.FullName,
    $testOutput.FullName,
    $stdlibJar,
    $kotlinTestJar,
    $kotlinTestJunitJar,
    $junitApiJar,
    $junitEngineJar,
    $platformLauncherJar,
    $platformEngineJar,
    $platformCommonsJar,
    $openTestJar,
    $apiGuardianJar
) -join [System.IO.Path]::PathSeparator
& $java "-cp" $runtimeClasspath "com.inkshadow.android.poc.JvmTestLauncherKt"
if ($LASTEXITCODE -ne 0) {
    throw "Android JVM test execution failed."
}
