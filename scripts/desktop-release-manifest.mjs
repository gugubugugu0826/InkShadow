import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const DESKTOP_RELEASE_MANIFEST_NAME = "inkshadow-release-manifest.json";
export const DESKTOP_RELEASE_MANIFEST_KIND = "inkshadow-desktop-release-manifest";
export const DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION = 2;
export const DESKTOP_RELEASE_SOURCE_BASELINE_KIND = "inkshadow-desktop-release-source-baseline";
export const DESKTOP_RELEASE_SOURCE_BASELINE_SCHEMA_VERSION = 2;

const fullGitCommitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const unsafeGitSelectionEnvironmentNames = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_SUPER_PREFIX",
  "GIT_WORK_TREE",
]);

export const UNSIGNED_RELEASE_CANDIDATE_STEPS = Object.freeze([
  Object.freeze({ label: "workspace release checks", arguments: Object.freeze(["release:check"]) }),
  Object.freeze({ label: "Rust release checks", arguments: Object.freeze(["check:rust"]) }),
  Object.freeze({
    label: "release frontend and E2E",
    arguments: Object.freeze(["test:e2e:release"]),
  }),
  Object.freeze({
    label: "unsigned Tauri packaging",
    arguments: Object.freeze(["--filter", "@inkshadow/desktop", "tauri:package:unsigned:prebuilt"]),
  }),
  Object.freeze({
    label: "Windows installer version verification",
    arguments: Object.freeze(["release:verify:installer-version"]),
  }),
  Object.freeze({
    label: "packaged release provenance verification",
    arguments: Object.freeze(["release:verify:unsigned"]),
  }),
]);

const requiredReleaseInputs = Object.freeze([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".github/workflows/ci.yml",
  ".prettierignore",
  ".prettierrc.json",
  "eslint.config.mjs",
  "package.json",
  "playwright.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "apps/desktop/index.html",
  "apps/desktop/package.json",
  "apps/desktop/tsconfig.json",
  "apps/desktop/vite.config.ts",
  "apps/desktop/vitest.config.ts",
  "apps/desktop/src-tauri/Cargo.lock",
  "apps/desktop/src-tauri/Cargo.toml",
  "apps/desktop/src-tauri/build.rs",
  "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/tauri.dev.conf.json",
  "apps/desktop/src-tauri/tauri.release-gate.conf.json",
]);

const optionalReleaseInputs = Object.freeze([
  "apps/desktop/src-tauri/.cargo/config",
  "apps/desktop/src-tauri/.cargo/config.toml",
]);

const requiredReleaseInputDirectories = Object.freeze([
  "apps/desktop/public",
  "apps/desktop/src",
  "apps/desktop/src-tauri/capabilities",
  "apps/desktop/src-tauri/gen/schemas",
  "apps/desktop/src-tauri/icons",
  "apps/desktop/src-tauri/src",
  "packages/data/migrations",
  "packages/story-core/migrations",
  "scripts",
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
    const packageRootEntries = await readdir(packageRoot, { withFileTypes: true });
    const rootFileEntries = packageRootEntries
      .filter((packageEntry) => packageEntry.isFile() || packageEntry.isSymbolicLink())
      .sort(compareDirectoryEntries);
    if (!rootFileEntries.some((packageEntry) => packageEntry.name === "package.json")) {
      throw new Error(
        `Required release input is missing: ${normalizeSlash(
          path.relative(workspaceRoot, path.join(packageRoot, "package.json")),
        )}`,
      );
    }
    if (!rootFileEntries.some((packageEntry) => packageEntry.name === "tsconfig.json")) {
      throw new Error(
        `Required release input is missing: ${normalizeSlash(
          path.relative(workspaceRoot, path.join(packageRoot, "tsconfig.json")),
        )}`,
      );
    }
    for (const packageEntry of rootFileEntries) {
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
    for (const optionalDirectoryName of ["migrations", "tests"]) {
      const optionalDirectoryPath = path.join(packageRoot, optionalDirectoryName);
      if (await isOptionalRegularDirectory(optionalDirectoryPath, workspaceRoot)) {
        files.push(...(await collectRegularFiles(optionalDirectoryPath)));
      }
    }
  }

  return Object.freeze(
    [...new Set(files.map((filePath) => path.resolve(filePath)))].sort(compareStrings),
  );
}

export async function createDesktopReleaseArtifactFingerprint(distributionRoot) {
  const files = (await collectRegularFiles(distributionRoot)).filter(
    (filePath) =>
      normalizeSlash(path.relative(distributionRoot, filePath)) !== DESKTOP_RELEASE_MANIFEST_NAME,
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
  gitCommitSha,
) {
  requireFullGitCommitSha(gitCommitSha);
  return {
    schemaVersion: DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION,
    kind: DESKTOP_RELEASE_MANIFEST_KIND,
    gitCommitSha,
    sourceFingerprint,
    environmentFingerprint,
    artifactFingerprint,
  };
}

export function createDesktopReleaseSourceBaseline(
  sourceFingerprint,
  environmentFingerprint,
  gitCommitSha,
) {
  requireFullGitCommitSha(gitCommitSha);
  return {
    schemaVersion: DESKTOP_RELEASE_SOURCE_BASELINE_SCHEMA_VERSION,
    kind: DESKTOP_RELEASE_SOURCE_BASELINE_KIND,
    gitCommitSha,
    sourceFingerprint,
    environmentFingerprint,
  };
}

export function verifyDesktopReleaseSourceBaseline(
  baseline,
  sourceFingerprint,
  environmentFingerprint,
  gitCommitSha,
) {
  const expected = createDesktopReleaseSourceBaseline(
    sourceFingerprint,
    environmentFingerprint,
    gitCommitSha,
  );
  if (JSON.stringify(baseline) !== JSON.stringify(expected)) {
    throw new Error("Desktop release source or build environment changed after baseline capture.");
  }
  return expected;
}

export function assertReleaseGitEnvironmentSafe(environment = process.env) {
  const unsafeNames = Object.keys(environment)
    .filter((name) => isUnsafeGitSelectionEnvironmentName(name))
    .sort(compareStrings);
  if (unsafeNames.length > 0) {
    throw new Error(
      `Release provenance rejects Git repository-selection environment variables: ${unsafeNames.join(
        ", ",
      )}.`,
    );
  }
}

export async function inspectCleanReleaseHead(
  workspaceRoot,
  runGit = runGitCommand,
  environment = process.env,
  collectReleaseInputs = collectDesktopReleaseSourceFiles,
) {
  assertReleaseGitEnvironmentSafe(environment);
  const normalizedRoot = path.resolve(workspaceRoot);
  const expectedIdentity = await resolveWorkspaceGitIdentity(normalizedRoot);
  const repositoryRoot = path.resolve(
    await runGit(normalizedRoot, ["rev-parse", "--show-toplevel"]),
  );
  if (comparePlatformPaths(repositoryRoot, normalizedRoot) !== 0) {
    throw new Error("Release workspace must be the Git repository root.");
  }

  const actualGitDirectory = await canonicalizeGitDirectory(
    await runGit(normalizedRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    "Git directory",
  );
  const actualCommonDirectory = await canonicalizeGitDirectory(
    await runGit(normalizedRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "Git common directory",
  );
  if (
    comparePlatformPaths(actualGitDirectory, expectedIdentity.gitDirectory) !== 0 ||
    comparePlatformPaths(actualCommonDirectory, expectedIdentity.commonDirectory) !== 0
  ) {
    throw new Error(
      "Release workspace Git directory/common directory does not match its real .git metadata.",
    );
  }

  const before = await readFullGitCommitSha(normalizedRoot, runGit);
  await assertCleanGitStatus(normalizedRoot, runGit);
  assertNoHiddenGitIndexFlags(
    await runGit(normalizedRoot, ["ls-files", "-v", "-z", "--full-name"]),
  );
  await verifyReleaseInputsMatchHead(
    normalizedRoot,
    await collectReleaseInputs(normalizedRoot),
    runGit,
  );
  await assertCleanGitStatus(normalizedRoot, runGit);
  const after = await readFullGitCommitSha(normalizedRoot, runGit);
  if (before !== after) {
    throw new Error("Git HEAD changed while the release source state was being inspected.");
  }
  return Object.freeze({ gitCommitSha: before });
}

export function assertNoHiddenGitIndexFlags(output) {
  const unsafe = output
    .split("\0")
    .filter(Boolean)
    .filter((entry) => {
      const flag = entry[0] ?? "";
      return flag === "S" || /^[a-z]$/u.test(flag);
    });
  if (unsafe.length > 0) {
    throw new Error(
      "Release candidates reject skip-worktree and assume-unchanged index flags; clear every hidden Git index flag first.",
    );
  }
}

export async function verifyReleaseInputsMatchHead(
  workspaceRoot,
  inputFiles,
  runGit = runGitCommand,
) {
  const relativePaths = [
    ...new Set(
      inputFiles.map((filePath) => {
        const relativePath = normalizeSlash(path.relative(workspaceRoot, path.resolve(filePath)));
        if (
          relativePath.length === 0 ||
          relativePath.startsWith("../") ||
          path.isAbsolute(relativePath) ||
          /[\0\r\n]/u.test(relativePath)
        ) {
          throw new Error(
            `Release Git input escaped its root or has an unsafe name: ${relativePath}`,
          );
        }
        return relativePath;
      }),
    ),
  ].sort(compareStrings);
  if (relativePaths.length === 0) {
    throw new Error("Release provenance requires at least one tracked source input.");
  }

  await assertReleaseInputsHaveSafeGitAttributes(workspaceRoot, relativePaths, runGit);
  const queryInput = relativePaths.map((relativePath) => `HEAD:${relativePath}\n`).join("");
  const headLines = splitGitLines(
    await runGit(workspaceRoot, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      input: queryInput,
    }),
  );
  const worktreeLines = splitGitLines(
    await runGit(workspaceRoot, ["hash-object", "--stdin-paths"], {
      input: relativePaths.map((relativePath) => `${relativePath}\n`).join(""),
    }),
  );
  if (headLines.length !== relativePaths.length || worktreeLines.length !== relativePaths.length) {
    throw new Error("Git returned an incomplete release-source blob inventory.");
  }

  for (const [index, relativePath] of relativePaths.entries()) {
    const headMatch = /^([0-9a-f]{40}|[0-9a-f]{64}) blob$/u.exec(headLines[index] ?? "");
    const worktreeObject = worktreeLines[index] ?? "";
    if (headMatch === null) {
      throw new Error(`Release input is not a tracked HEAD blob: ${relativePath}`);
    }
    if (!fullGitCommitPattern.test(worktreeObject) || worktreeObject !== headMatch[1]) {
      throw new Error(`Release input bytes do not match the HEAD blob: ${relativePath}`);
    }
  }
}

export function verifyReleaseHeadUnchanged(expected, actual) {
  requireFullGitCommitSha(expected?.gitCommitSha);
  requireFullGitCommitSha(actual?.gitCommitSha);
  if (expected.gitCommitSha !== actual.gitCommitSha) {
    throw new Error("Git HEAD changed during release generation.");
  }
  return expected;
}

export async function runUnsignedReleaseCandidate(
  workspaceRoot,
  {
    inspectReleaseHead = inspectCleanReleaseHead,
    runStep = runPnpmReleaseStep,
    writeOutput = (message) => process.stdout.write(message),
  } = {},
) {
  const initialHead = await inspectReleaseHead(workspaceRoot);
  writeOutput(`Unsigned release candidate source: Git commit ${initialHead.gitCommitSha}.\n`);

  for (const step of UNSIGNED_RELEASE_CANDIDATE_STEPS) {
    await runStep(workspaceRoot, step);
    const currentHead = await inspectReleaseHead(workspaceRoot);
    verifyReleaseHeadUnchanged(initialHead, currentHead);
  }

  writeOutput(
    `Unsigned release candidate completed from Git commit ${initialHead.gitCommitSha}.\n`,
  );
  writeOutput(
    `At Git commit ${initialHead.gitCommitSha}, persistent source/index and dist-release changes visible at the final post-package check were rejected; transient rewrites restored before a check are outside this process-level attestation.\n`,
  );
  return initialHead;
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

async function isOptionalRegularDirectory(directoryPath, workspaceRoot) {
  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      `Optional release input directory is not a regular directory: ${normalizeSlash(
        path.relative(workspaceRoot, directoryPath),
      )}`,
    );
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

async function assertCleanGitStatus(workspaceRoot, runGit) {
  const status = await runGit(workspaceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status.length > 0) {
    throw new Error(
      "Release candidates require a clean Git worktree and index; commit or remove every change first.",
    );
  }
}

async function assertReleaseInputsHaveSafeGitAttributes(workspaceRoot, relativePaths, runGit) {
  const output = await runGit(
    workspaceRoot,
    ["check-attr", "-z", "--stdin", "filter", "ident", "working-tree-encoding"],
    { input: `${relativePaths.join("\0")}\0` },
  );
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  if (fields.length !== relativePaths.length * 9) {
    throw new Error("Git returned an incomplete release-source attribute inventory.");
  }
  const allowedValues = new Set(["unspecified", "unset"]);
  for (let index = 0; index < fields.length; index += 3) {
    const relativePath = fields[index] ?? "";
    const attribute = fields[index + 1] ?? "";
    const value = fields[index + 2] ?? "";
    const pathIndex = Math.floor(index / 9);
    const attributeIndex = (index / 3) % 3;
    const expectedPath = relativePaths[pathIndex];
    const expectedAttribute = ["filter", "ident", "working-tree-encoding"][attributeIndex];
    if (relativePath !== expectedPath || attribute !== expectedAttribute) {
      throw new Error("Git returned an unexpected release-source attribute inventory.");
    }
    if (!allowedValues.has(value)) {
      throw new Error(
        `Release input ${relativePath} uses forbidden ${attribute}=${value}; release bytes may only use Git text/EOL normalization.`,
      );
    }
  }
}

function splitGitLines(output) {
  if (output.length === 0) {
    return [];
  }
  return output.split(/\r?\n/u).filter((line) => line.length > 0);
}

async function resolveWorkspaceGitIdentity(workspaceRoot) {
  const dotGitPath = path.join(workspaceRoot, ".git");
  let dotGitMetadata;
  try {
    dotGitMetadata = await lstat(dotGitPath);
  } catch (error) {
    throw new Error("Release workspace has no readable .git metadata.", { cause: error });
  }
  if (dotGitMetadata.isSymbolicLink()) {
    throw new Error("Release workspace .git metadata must not be a symbolic link.");
  }

  let gitDirectory;
  if (dotGitMetadata.isDirectory()) {
    gitDirectory = await canonicalizeGitDirectory(dotGitPath, "Workspace Git directory");
  } else if (dotGitMetadata.isFile()) {
    const pointer = await readFile(dotGitPath, "utf8");
    const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/u.exec(pointer);
    if (match === null) {
      throw new Error("Release workspace .git file is not a single valid gitdir pointer.");
    }
    gitDirectory = await canonicalizeGitDirectory(
      path.resolve(workspaceRoot, match[1]),
      "Workspace Git directory",
    );
  } else {
    throw new Error("Release workspace .git metadata must be a regular file or directory.");
  }

  const commonDirectoryPointer = path.join(gitDirectory, "commondir");
  let commonDirectory = gitDirectory;
  try {
    const commonMetadata = await lstat(commonDirectoryPointer);
    if (commonMetadata.isSymbolicLink() || !commonMetadata.isFile()) {
      throw new Error("Git commondir metadata must be a regular file.");
    }
    const pointer = await readFile(commonDirectoryPointer, "utf8");
    const match = /^([^\0\r\n]+)\r?\n?$/u.exec(pointer);
    if (match === null) {
      throw new Error("Git commondir metadata must contain one directory pointer.");
    }
    commonDirectory = await canonicalizeGitDirectory(
      path.resolve(gitDirectory, match[1]),
      "Workspace Git common directory",
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return Object.freeze({ gitDirectory, commonDirectory });
}

async function canonicalizeGitDirectory(directoryPath, label) {
  const canonicalPath = await realpath(path.resolve(directoryPath));
  const metadata = await lstat(canonicalPath);
  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be a directory.`);
  }
  return canonicalPath;
}

async function readFullGitCommitSha(workspaceRoot, runGit) {
  const commitSha = await runGit(workspaceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  requireFullGitCommitSha(commitSha);
  return commitSha;
}

function requireFullGitCommitSha(value) {
  if (typeof value !== "string" || !fullGitCommitPattern.test(value)) {
    throw new Error("Release provenance requires a full lowercase Git commit SHA.");
  }
}

async function runGitCommand(workspaceRoot, arguments_, { input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false", ...arguments_],
      {
        cwd: workspaceRoot,
        env: createSanitizedGitEnvironment(process.env, workspaceRoot),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(new Error("Could not inspect the Git release source state.", { cause: error }));
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          `Could not inspect the Git release source state${
            stderr.trim().length === 0 ? "." : `: ${stderr.trim()}`
          }`,
        ),
      );
    });
    child.stdin.end(input, "utf8");
  });
}

function isUnsafeGitSelectionEnvironmentName(name) {
  const upperName = name.toUpperCase();
  return unsafeGitSelectionEnvironmentNames.has(upperName);
}

function createSanitizedGitEnvironment(environment, workspaceRoot) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!/^GIT_/iu.test(name) && value !== undefined) {
      sanitized[name] = value;
    }
  }
  sanitized.GIT_NO_REPLACE_OBJECTS = "1";
  sanitized.GIT_OPTIONAL_LOCKS = "0";
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  sanitized.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  sanitized.GIT_ATTR_NOSYSTEM = "1";
  sanitized.GIT_CONFIG_COUNT = "1";
  sanitized.GIT_CONFIG_KEY_0 = "safe.directory";
  sanitized.GIT_CONFIG_VALUE_0 = path.resolve(workspaceRoot);
  return sanitized;
}

function comparePlatformPaths(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.localeCompare(normalizedRight, "en", { sensitivity: "accent" })
    : compareStrings(normalizedLeft, normalizedRight);
}

export async function resolvePnpmCli(environment = process.env) {
  const npmExecPath = readEnvironmentValue(environment, "npm_execpath");
  if (npmExecPath !== undefined && npmExecPath.trim().length > 0) {
    if (!path.isAbsolute(npmExecPath)) {
      throw new Error("The pnpm npm_execpath must be an absolute JavaScript CLI path.");
    }
    const resolvedExecPath = await resolveRegularPnpmCli(npmExecPath);
    if (resolvedExecPath === undefined) {
      throw new Error("The pnpm npm_execpath is not a regular pnpm.cjs or pnpm.mjs file.");
    }
    return resolvedExecPath;
  }

  const userAgent = readEnvironmentValue(environment, "npm_config_user_agent");
  if (userAgent === undefined || !/^pnpm\/[^\s/]+(?:\s|$)/iu.test(userAgent.trim())) {
    throw new Error("Run the unsigned release candidate through pnpm.");
  }

  const pathValue = readEnvironmentValue(environment, "PATH");
  if (pathValue === undefined || pathValue.length === 0) {
    throw new Error("Could not resolve pnpm's JavaScript CLI from PATH.");
  }

  for (const rawEntry of pathValue.split(path.delimiter)) {
    const pathEntry = normalizePathEntry(rawEntry);
    if (pathEntry === undefined || !path.isAbsolute(pathEntry)) {
      continue;
    }

    const packageRoots = [path.join(pathEntry, "node_modules", "pnpm", "bin")];
    if (path.basename(pathEntry).toLowerCase() === ".bin") {
      packageRoots.push(path.join(pathEntry, "..", "pnpm", "bin"));
    }
    const directCandidates = [
      ...packageRoots.flatMap((packageRoot) => [
        path.join(packageRoot, "pnpm.mjs"),
        path.join(packageRoot, "pnpm.cjs"),
      ]),
      path.join(pathEntry, "pnpm.mjs"),
      path.join(pathEntry, "pnpm.cjs"),
    ];
    for (const candidate of directCandidates) {
      const resolvedCandidate = await resolveRegularPnpmCli(candidate);
      if (resolvedCandidate !== undefined) {
        return resolvedCandidate;
      }
    }

    if (process.platform !== "win32") {
      const linkedPnpm = path.join(pathEntry, "pnpm");
      if (await isSymbolicLink(linkedPnpm)) {
        const resolvedCandidate = await resolveRegularPnpmCli(linkedPnpm);
        if (resolvedCandidate !== undefined) {
          return resolvedCandidate;
        }
      }
    }
  }

  throw new Error("Could not resolve pnpm's JavaScript CLI from PATH.");
}

async function runPnpmReleaseStep(workspaceRoot, step) {
  const packageManagerCli = await resolvePnpmCli(process.env);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [packageManagerCli, ...step.arguments], {
      cwd: workspaceRoot,
      env: createSanitizedGitEnvironment(process.env, workspaceRoot),
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => {
      reject(new Error(`Could not start ${step.label}.`, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${step.label} failed${signal === null ? ` with exit code ${String(code)}` : ` on signal ${signal}`}.`,
        ),
      );
    });
  });
}

function readEnvironmentValue(environment, expectedName) {
  const matchingEntries = Object.entries(environment).filter(
    ([name, value]) => name.toLowerCase() === expectedName.toLowerCase() && value !== undefined,
  );
  if (matchingEntries.length === 0) {
    return undefined;
  }
  const distinctValues = new Set(matchingEntries.map(([, value]) => value));
  if (distinctValues.size !== 1) {
    throw new Error(`Conflicting ${expectedName} environment values are not allowed.`);
  }
  return matchingEntries[0]?.[1];
}

function normalizePathEntry(rawEntry) {
  const trimmed = rawEntry.trim();
  if (trimmed.length === 0 || /[\0\r\n]/u.test(trimmed)) {
    return undefined;
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function resolveRegularPnpmCli(candidate) {
  let canonicalPath;
  try {
    canonicalPath = await realpath(candidate);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    !path.isAbsolute(canonicalPath) ||
    !/^pnpm\.(?:cjs|mjs)$/iu.test(path.basename(canonicalPath))
  ) {
    return undefined;
  }
  const metadata = await lstat(canonicalPath);
  return metadata.isFile() ? canonicalPath : undefined;
}

async function isSymbolicLink(candidate) {
  try {
    return (await lstat(candidate)).isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
