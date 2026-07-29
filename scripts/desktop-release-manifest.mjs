import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const DESKTOP_RELEASE_MANIFEST_NAME = "inkshadow-release-manifest.json";
export const DESKTOP_RELEASE_MANIFEST_KIND = "inkshadow-desktop-release-manifest";
export const DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const DESKTOP_RELEASE_SOURCE_BASELINE_KIND = "inkshadow-desktop-release-source-baseline";
export const DESKTOP_RELEASE_SOURCE_BASELINE_SCHEMA_VERSION = 1;

const requiredReleaseInputs = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "apps/desktop/index.html",
  "apps/desktop/package.json",
  "apps/desktop/tsconfig.json",
  "apps/desktop/vite.config.ts",
  "apps/desktop/src-tauri/Cargo.lock",
  "apps/desktop/src-tauri/Cargo.toml",
  "apps/desktop/src-tauri/build.rs",
  "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/tauri.dev.conf.json",
  "apps/desktop/src-tauri/tauri.release-gate.conf.json",
  "scripts/capture-desktop-release-source.mjs",
  "scripts/check-desktop-release.mjs",
  "scripts/desktop-release-manifest.mjs",
  "scripts/desktop-release-manifest.test.mjs",
  "scripts/run-e2e.mjs",
  "scripts/serve-e2e.mjs",
  "scripts/write-desktop-release-manifest.mjs",
]);

const optionalReleaseInputs = Object.freeze([
  "apps/desktop/src-tauri/.cargo/config",
  "apps/desktop/src-tauri/.cargo/config.toml",
]);

const requiredReleaseInputDirectories = Object.freeze([
  "apps/desktop/src",
  "apps/desktop/src-tauri/capabilities",
  "apps/desktop/src-tauri/icons",
  "apps/desktop/src-tauri/src",
  "packages/data/migrations",
  "packages/story-core/migrations",
]);

export async function createDesktopReleaseSourceFingerprint(workspaceRoot) {
  return fingerprintFiles(
    workspaceRoot,
    await collectDesktopReleaseSourceFiles(workspaceRoot),
    false,
  );
}

export async function collectDesktopReleaseSourceFiles(workspaceRoot) {
  const files = [];
  for (const relativePath of requiredReleaseInputs) {
    const filePath = path.join(workspaceRoot, relativePath);
    await requireRegularFile(filePath, relativePath);
    files.push(filePath);
  }
  await validateOptionalCargoConfigDirectory(workspaceRoot);
  for (const relativePath of optionalReleaseInputs) {
    const filePath = path.join(workspaceRoot, relativePath);
    if (await isOptionalRegularFile(filePath, relativePath)) {
      files.push(filePath);
    }
  }
  for (const relativePath of requiredReleaseInputDirectories) {
    files.push(...(await collectRegularFiles(path.join(workspaceRoot, relativePath))));
  }
  const desktopRoot = path.join(workspaceRoot, "apps", "desktop");
  const desktopEntries = await readdir(desktopRoot, { withFileTypes: true });
  for (const entry of desktopEntries.sort(compareDirectoryEntries)) {
    if (!/^\.env(?:\.|$)/u.test(entry.name)) {
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Desktop build environment input is not a regular file: ${entry.name}`);
    }
    files.push(path.join(desktopRoot, entry.name));
  }

  const packagesRoot = path.join(workspaceRoot, "packages");
  const packageEntries = await readdir(packagesRoot, { withFileTypes: true });
  for (const entry of packageEntries.sort(compareDirectoryEntries)) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Workspace package roots must not be symlinks: ${normalizeSlash(
          path.join("packages", entry.name),
        )}`,
      );
    }
    if (!entry.isDirectory()) {
      continue;
    }
    const packageRoot = path.join(packagesRoot, entry.name);
    const packageManifestPath = path.join(packageRoot, "package.json");
    await requireRegularFile(
      packageManifestPath,
      normalizeSlash(path.relative(workspaceRoot, packageManifestPath)),
    );
    files.push(packageManifestPath);

    const packageRootEntries = await readdir(packageRoot, { withFileTypes: true });
    const tsconfigEntries = packageRootEntries
      .filter((packageEntry) => /^tsconfig.*\.json$/u.test(packageEntry.name))
      .sort(compareDirectoryEntries);
    if (!tsconfigEntries.some((packageEntry) => packageEntry.name === "tsconfig.json")) {
      throw new Error(
        `Required release input is missing: ${normalizeSlash(
          path.relative(workspaceRoot, path.join(packageRoot, "tsconfig.json")),
        )}`,
      );
    }
    for (const packageEntry of tsconfigEntries) {
      const filePath = path.join(packageRoot, packageEntry.name);
      if (packageEntry.isSymbolicLink() || !packageEntry.isFile()) {
        throw new Error(
          `Required release input is not a regular file: ${normalizeSlash(
            path.relative(workspaceRoot, filePath),
          )}`,
        );
      }
      files.push(filePath);
    }
    files.push(...(await collectRegularFiles(path.join(packageRoot, "src"))));
  }

  return Object.freeze(files.map((filePath) => path.resolve(filePath)));
}

export async function createDesktopReleaseArtifactFingerprint(distributionRoot) {
  const files = (await collectRegularFiles(distributionRoot)).filter(
    (filePath) => path.basename(filePath) !== DESKTOP_RELEASE_MANIFEST_NAME,
  );
  return fingerprintFiles(distributionRoot, files, true);
}

export function createDesktopReleaseEnvironmentFingerprint(environment = process.env) {
  const variables = Object.entries(environment)
    .filter(([name, value]) => name.startsWith("VITE_INKSHADOW_") && value !== undefined)
    .sort(([left], [right]) => compareStrings(left, right));
  const aggregate = createHash("sha256");
  for (const [name, value] of variables) {
    aggregate.update(name, "utf8");
    aggregate.update("\0", "utf8");
    aggregate.update(value ?? "", "utf8");
    aggregate.update("\n", "utf8");
  }
  return {
    algorithm: "sha256",
    digest: aggregate.digest("hex"),
    variableCount: variables.length,
    variableNames: variables.map(([name]) => name),
  };
}

export function createDesktopReleaseManifest(
  sourceFingerprint,
  environmentFingerprint,
  artifactFingerprint,
) {
  return {
    schemaVersion: DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION,
    kind: DESKTOP_RELEASE_MANIFEST_KIND,
    sourceFingerprint,
    environmentFingerprint,
    artifactFingerprint,
  };
}

export function createDesktopReleaseSourceBaseline(sourceFingerprint, environmentFingerprint) {
  return {
    schemaVersion: DESKTOP_RELEASE_SOURCE_BASELINE_SCHEMA_VERSION,
    kind: DESKTOP_RELEASE_SOURCE_BASELINE_KIND,
    sourceFingerprint,
    environmentFingerprint,
  };
}

export function verifyDesktopReleaseSourceBaseline(
  baseline,
  sourceFingerprint,
  environmentFingerprint,
) {
  const expected = createDesktopReleaseSourceBaseline(sourceFingerprint, environmentFingerprint);
  if (JSON.stringify(baseline) !== JSON.stringify(expected)) {
    throw new Error("Desktop release source or build environment changed after baseline capture.");
  }
  return expected;
}

export async function requireSafeReleasePath(root, target, expectedType, label) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    normalizedTarget === normalizedRoot
  ) {
    throw new Error(`${label} must stay inside the release workspace.`);
  }
  let current = normalizedRoot;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      throw new Error(`${label} path is missing.`, { cause: error });
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} path must not contain symlinks.`);
    }
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !metadata.isDirectory()) {
      throw new Error(`${label} parent must be a directory.`);
    }
    if (
      isLeaf &&
      ((expectedType === "directory" && !metadata.isDirectory()) ||
        (expectedType === "file" && !metadata.isFile()))
    ) {
      throw new Error(`${label} must be a regular ${expectedType}.`);
    }
  }
}

async function fingerprintFiles(root, inputFiles, includeFiles) {
  const uniqueFiles = [...new Set(inputFiles.map((filePath) => path.resolve(filePath)))].sort(
    compareStrings,
  );
  const aggregate = createHash("sha256");
  const entries = [];
  let totalBytes = 0;
  for (const filePath of uniqueFiles) {
    const relativePath = normalizeSlash(path.relative(root, filePath));
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("../") ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`Release fingerprint input escaped its root: ${relativePath}`);
    }
    const bytes = await readFile(filePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    aggregate.update(relativePath, "utf8");
    aggregate.update("\0", "utf8");
    aggregate.update(String(bytes.byteLength), "utf8");
    aggregate.update("\0", "utf8");
    aggregate.update(digest, "ascii");
    aggregate.update("\n", "utf8");
    totalBytes += bytes.byteLength;
    if (includeFiles) {
      entries.push({
        path: relativePath,
        bytes: bytes.byteLength,
        sha256: digest,
      });
    }
  }
  return {
    algorithm: "sha256",
    digest: aggregate.digest("hex"),
    fileCount: uniqueFiles.length,
    totalBytes,
    ...(includeFiles ? { files: entries } : {}),
  };
}

async function collectRegularFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort(compareDirectoryEntries)) {
    const target = path.join(directory, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Release fingerprint inputs must not contain symlinks: ${target}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectRegularFiles(target)));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Release fingerprint input is not a regular file: ${target}`);
    }
    files.push(target);
  }
  return files;
}

async function requireRegularFile(filePath, label) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    throw new Error(`Required release input is missing: ${label}`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Required release input is not a regular file: ${label}`);
  }
}

async function isOptionalRegularFile(filePath, label) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Optional release input is not a regular file: ${label}`);
  }
  return true;
}

async function validateOptionalCargoConfigDirectory(workspaceRoot) {
  const relativePath = "apps/desktop/src-tauri/.cargo";
  const directoryPath = path.join(workspaceRoot, relativePath);
  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Optional release input directory is not a regular directory: ${relativePath}`);
  }
}

function compareDirectoryEntries(left, right) {
  return compareStrings(left.name, right.name);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSlash(value) {
  return value.replaceAll("\\", "/");
}
