$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$androidRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$coreMain = Join-Path $androidRoot "core\src\main\kotlin"
$allMainSources = Get-ChildItem `
    -LiteralPath $androidRoot `
    -Recurse `
    -Filter "*.kt" |
    Where-Object { $_.FullName -like "*\src\main\*" }
$coreSources = $allMainSources |
    Where-Object { $_.FullName.StartsWith(
        $coreMain,
        [System.StringComparison]::OrdinalIgnoreCase
    ) }

$violations = [System.Collections.Generic.List[string]]::new()
$coreForbiddenImports = @(
    "^\s*import\s+android\.",
    "^\s*import\s+androidx\.",
    "^\s*import\s+okhttp3\.",
    "^\s*import\s+retrofit2\.",
    "^\s*import\s+io\.ktor\.client\."
)
foreach ($source in $coreSources) {
    foreach ($pattern in $coreForbiddenImports) {
        if (Select-String -LiteralPath $source.FullName -Pattern $pattern -Quiet) {
            $violations.Add("JVM core dependency boundary: $($source.FullName)")
        }
    }
}

$productionLoggingPatterns = @(
    "\bprintln\s*\(",
    "\bSystem\.(out|err)\b",
    "\bandroid\.util\.Log\b",
    "\bTimber\."
)
foreach ($source in $allMainSources) {
    foreach ($pattern in $productionLoggingPatterns) {
        if (Select-String -LiteralPath $source.FullName -Pattern $pattern -Quiet) {
            $violations.Add("Free-form production logging: $($source.FullName)")
        }
    }
}

$manifest = Join-Path $androidRoot "android-keystore\src\main\AndroidManifest.xml"
if (Select-String -LiteralPath $manifest -Pattern "android.permission.INTERNET" -Quiet) {
    $violations.Add("The architecture PoC must not request network access.")
}
if (Select-String -LiteralPath $manifest -Pattern "<(activity|service|receiver|provider)\b" -Quiet) {
    $violations.Add("The architecture PoC must not publish UI or app components.")
}

$snapshotFiles = Get-ChildItem -LiteralPath $androidRoot -Recurse -File |
    Where-Object {
        $_.FullName -notlike "*\build\*" -and
        (
            $_.Extension -in @(".snap", ".golden") -or
            $_.FullName -like "*\__snapshots__\*"
        )
    }
foreach ($snapshot in $snapshotFiles) {
    $violations.Add("Body-bearing snapshot is forbidden: $($snapshot.FullName)")
}

$keystoreSource = Join-Path $androidRoot `
    "android-keystore\src\main\kotlin\com\inkshadow\android\keystore\AndroidKeystoreAesGcmKeyHandle.kt"
$requiredKeystoreSignals = @(
    'private const val ANDROID_KEYSTORE = "AndroidKeyStore"',
    "private const val AES_KEY_BITS = 256",
    ".setRandomizedEncryptionRequired(true)",
    "key.encoded != null",
    "val nonce = cipher.iv"
)
foreach ($signal in $requiredKeystoreSignals) {
    if (-not (Select-String -LiteralPath $keystoreSource -SimpleMatch $signal -Quiet)) {
        $violations.Add("Missing Android Keystore invariant: $signal")
    }
}

if ($violations.Count -gt 0) {
    $violations | ForEach-Object { Write-Error $_ }
    throw "Android architecture boundary scan failed."
}

Write-Output (
    "Android boundary scan passed: coreSources={0}, productionSources={1}, snapshots=0" -f
    $coreSources.Count,
    $allMainSources.Count
)
