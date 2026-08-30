import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const EXPECTED_RELEASE_VERSION = "0.2.16";
export const EXPECTED_PRODUCT_NAME = "墨影 InkShadow";
export const EXPECTED_FILE_DESCRIPTION = "墨影 InkShadow";
export const EXPECTED_PE_MACHINE = "AMD64";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(workspaceRoot, "apps", "desktop", "src-tauri");
const releaseRoot = path.join(tauriRoot, "target", "release");
const bundleRoot = path.join(tauriRoot, "target", "release", "bundle", "nsis");

if (isDirectExecution()) {
  await main();
}

async function main() {
  if (process.platform !== "win32") {
    fail("Windows installer version verification must run on Windows.");
  }
  const tauriConfiguration = JSON.parse(
    await readFile(path.join(tauriRoot, "tauri.conf.json"), "utf8"),
  );
  validateOrFail(() => validateTauriConfiguration(tauriConfiguration));

  const expectedInstallerName = `${EXPECTED_PRODUCT_NAME}_${EXPECTED_RELEASE_VERSION}_x64-setup.exe`;
  const entries = await readdir(bundleRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      fail("The NSIS output must not contain symbolic links: " + entry.name);
    }
  }
  const installers = entries.filter((entry) => entry.isFile() && entry.name.endsWith("-setup.exe"));
  if (installers.length !== 1 || installers[0]?.name !== expectedInstallerName) {
    fail("Expected exactly one unsigned installer named " + expectedInstallerName + ".");
  }

  const installerPath = path.join(bundleRoot, expectedInstallerName);
  const installerStat = await lstat(installerPath);
  if (!installerStat.isFile() || installerStat.isSymbolicLink()) {
    fail("The Windows installer must be a regular file.");
  }
  const canonicalBundleRoot = await realpath(bundleRoot);
  const canonicalInstallerPath = await realpath(installerPath);
  if (path.dirname(canonicalInstallerPath) !== canonicalBundleRoot) {
    fail("The Windows installer must stay directly inside the NSIS output directory.");
  }
  const applicationPath = path.join(releaseRoot, "inkshadow-desktop.exe");
  const applicationStat = await lstat(applicationPath);
  if (!applicationStat.isFile() || applicationStat.isSymbolicLink()) {
    fail("The packaged Windows application payload must be a regular file.");
  }
  const canonicalReleaseRoot = await realpath(releaseRoot);
  const canonicalApplicationPath = await realpath(applicationPath);
  if (path.dirname(canonicalApplicationPath) !== canonicalReleaseRoot) {
    fail("The Windows application payload must stay directly inside the release directory.");
  }

  const inspection = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        "$item = Get-Item -LiteralPath $env:INKSHADOW_INSTALLER_PATH",
        "$application = Get-Item -LiteralPath $env:INKSHADOW_APPLICATION_PATH",
        "$signature = Get-AuthenticodeSignature -LiteralPath $item.FullName",
        "$stream = [System.IO.File]::OpenRead($application.FullName)",
        "try { $reader = [System.IO.BinaryReader]::new($stream); $stream.Position = 0x3c; $peOffset = $reader.ReadInt32(); $stream.Position = $peOffset + 4; $machine = $reader.ReadUInt16() } finally { if ($reader) { $reader.Dispose() } else { $stream.Dispose() } }",
        "$applicationMachine = if ($machine -eq 0x8664) { 'AMD64' } else { ('0x{0:X4}' -f $machine) }",
        "$json = [pscustomobject]@{ ProductName = $item.VersionInfo.ProductName; FileDescription = $item.VersionInfo.FileDescription; ProductVersion = $item.VersionInfo.ProductVersion; FileVersion = $item.VersionInfo.FileVersion; ApplicationMachine = $applicationMachine; SignatureStatus = $signature.Status.ToString() } | ConvertTo-Json -Compress",
        "[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))",
      ].join("; "),
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: createWindowsPowerShellEnvironment(
        process.env,
        canonicalInstallerPath,
        canonicalApplicationPath,
      ),
      windowsHide: true,
    },
  );
  if (inspection.status !== 0 || inspection.signal !== null) {
    fail("Could not inspect Windows installer metadata: " + inspection.stderr.trim());
  }

  let metadata;
  try {
    metadata = decodeWindowsInstallerMetadata(inspection.stdout);
  } catch {
    fail("Windows installer metadata did not return valid UTF-8 JSON.");
  }
  validateOrFail(() => validateInstallerMetadata(metadata));

  process.stdout.write(
    "Verified " +
      expectedInstallerName +
      ": ProductName and FileDescription " +
      EXPECTED_PRODUCT_NAME +
      ", ProductVersion and FileVersion " +
      EXPECTED_RELEASE_VERSION +
      ", machine AMD64, Authenticode NotSigned.\n",
  );
}

export function validateTauriConfiguration(configuration) {
  if (
    configuration?.version !== EXPECTED_RELEASE_VERSION ||
    configuration?.productName !== EXPECTED_PRODUCT_NAME
  ) {
    throw new Error(
      `The Tauri product name must be ${EXPECTED_PRODUCT_NAME} and release version must be ${EXPECTED_RELEASE_VERSION}.`,
    );
  }
}

export function validateInstallerMetadata(metadata) {
  if (metadata?.ProductName !== EXPECTED_PRODUCT_NAME) {
    throw new Error(
      `Installer ProductName must be ${EXPECTED_PRODUCT_NAME}; received ${String(metadata?.ProductName)}.`,
    );
  }
  if (metadata?.FileDescription !== EXPECTED_FILE_DESCRIPTION) {
    throw new Error(
      `Installer FileDescription must be ${EXPECTED_FILE_DESCRIPTION}; received ${String(metadata?.FileDescription)}.`,
    );
  }
  if (
    normalizeWindowsVersion(metadata?.ProductVersion) !== EXPECTED_RELEASE_VERSION ||
    normalizeWindowsVersion(metadata?.FileVersion) !== EXPECTED_RELEASE_VERSION
  ) {
    throw new Error(
      `Installer ProductVersion and FileVersion must both be ${EXPECTED_RELEASE_VERSION}; received ${String(metadata?.ProductVersion)} and ${String(metadata?.FileVersion)}.`,
    );
  }
  if (metadata?.ApplicationMachine !== EXPECTED_PE_MACHINE) {
    throw new Error(
      `Packaged application machine must be ${EXPECTED_PE_MACHINE}; received ${String(metadata?.ApplicationMachine)}.`,
    );
  }
  if (metadata?.SignatureStatus !== "NotSigned") {
    throw new Error(
      `The explicit unsigned candidate must report NotSigned, received ${String(metadata?.SignatureStatus)}.`,
    );
  }
}

export function normalizeWindowsVersion(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+\.\d+\.\d+)(?:\.0)?$/u.exec(value.trim());
  return match?.[1] ?? null;
}

export function createWindowsPowerShellEnvironment(
  baseEnvironment,
  installerPath,
  applicationPath,
) {
  return Object.fromEntries([
    ...Object.entries(baseEnvironment).filter(
      ([key, value]) => key.toLowerCase() !== "psmodulepath" && value !== undefined,
    ),
    ["INKSHADOW_INSTALLER_PATH", installerPath],
    ["INKSHADOW_APPLICATION_PATH", applicationPath],
  ]);
}

export function decodeWindowsInstallerMetadata(stdout) {
  const encoded = stdout.trim();
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(encoded)) {
    throw new Error("Windows installer metadata must use canonical Base64.");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64") !== encoded) {
    throw new Error("Windows installer metadata Base64 is not canonical UTF-8.");
  }
  return JSON.parse(decoded);
}

function validateOrFail(validation) {
  try {
    validation();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function isDirectExecution() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}
