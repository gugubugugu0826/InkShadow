import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectDesktopReleaseSourceFiles,
  createDesktopReleaseArtifactFingerprint,
  createDesktopReleaseEnvironmentFingerprint,
  createDesktopReleaseManifest,
  createDesktopReleaseSourceBaseline,
  createDesktopReleaseSourceFingerprint,
  requireSafeReleasePath,
  verifyDesktopReleaseSourceBaseline,
} from "./desktop-release-manifest.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredFiles = [
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
  "apps/desktop/src-tauri/.cargo/config.toml",
  "scripts/capture-desktop-release-source.mjs",
  "scripts/check-desktop-release.mjs",
  "scripts/desktop-release-manifest.mjs",
  "scripts/desktop-release-manifest.test.mjs",
  "scripts/run-e2e.mjs",
  "scripts/serve-e2e.mjs",
  "scripts/write-desktop-release-manifest.mjs",
  "apps/desktop/src/main.ts",
  "apps/desktop/src-tauri/capabilities/default.json",
  "apps/desktop/src-tauri/icons/icon.png",
  "apps/desktop/src-tauri/src/lib.rs",
  "packages/application/package.json",
  "packages/application/tsconfig.json",
  "packages/application/tsconfig.test.json",
  "packages/application/src/index.ts",
  "packages/data/package.json",
  "packages/data/tsconfig.build.json",
  "packages/data/tsconfig.json",
  "packages/data/src/index.ts",
  "packages/data/migrations/0001_core.sql",
  "packages/story-core/package.json",
  "packages/story-core/tsconfig.build.json",
  "packages/story-core/tsconfig.json",
  "packages/story-core/src/index.ts",
  "packages/story-core/migrations/0001_story_core.sql",
];

test("desktop release source fingerprint covers build configuration and migration bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-release-fingerprint-"));
  try {
    await Promise.all(
      requiredFiles.map(async (relativePath) => {
        const filePath = path.join(root, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${relativePath}\n`, "utf8");
      }),
    );

    const sourceFiles = await collectDesktopReleaseSourceFiles(root);
    const relativeFiles = new Set(
      sourceFiles.map((filePath) => path.relative(root, filePath).replaceAll("\\", "/")),
    );
    assert(relativeFiles.has("packages/data/migrations/0001_core.sql"));
    assert(relativeFiles.has("packages/story-core/migrations/0001_story_core.sql"));
    assert(relativeFiles.has("packages/data/tsconfig.build.json"));
    assert(relativeFiles.has("packages/story-core/tsconfig.build.json"));
    assert(relativeFiles.has("packages/application/tsconfig.test.json"));
    assert(relativeFiles.has("apps/desktop/src-tauri/tauri.dev.conf.json"));
    assert(relativeFiles.has("apps/desktop/src-tauri/.cargo/config.toml"));
    assert.equal(relativeFiles.size, sourceFiles.length);
    assert(
      [...relativeFiles].every(
        (relativePath) =>
          relativePath.length > 0 &&
          !relativePath.startsWith("../") &&
          !path.isAbsolute(relativePath),
      ),
    );

    const before = await createDesktopReleaseSourceFingerprint(root);
    const repeated = await createDesktopReleaseSourceFingerprint(root);
    assert.deepEqual(repeated, before);
    const environment = createDesktopReleaseEnvironmentFingerprint({
      VITE_INKSHADOW_CLOUD_IDENTITY_ENABLED: "false",
    });
    const baseline = createDesktopReleaseSourceBaseline(before, environment);
    assert.deepEqual(verifyDesktopReleaseSourceBaseline(baseline, repeated, environment), baseline);
    assert.throws(
      () =>
        verifyDesktopReleaseSourceBaseline(
          baseline,
          { ...repeated, digest: "f".repeat(64) },
          environment,
        ),
      /changed after baseline capture/u,
    );
    assert.throws(
      () =>
        verifyDesktopReleaseSourceBaseline(
          baseline,
          repeated,
          createDesktopReleaseEnvironmentFingerprint({
            VITE_INKSHADOW_CLOUD_IDENTITY_ENABLED: "true",
          }),
        ),
      /changed after baseline capture/u,
    );

    await writeFile(
      path.join(root, "packages/data/migrations/0001_core.sql"),
      "changed migration bytes\n",
      "utf8",
    );
    const afterMigrationChange = await createDesktopReleaseSourceFingerprint(root);
    assert.notEqual(afterMigrationChange.digest, before.digest);
    assert.equal(afterMigrationChange.fileCount, before.fileCount);

    await writeFile(
      path.join(root, "packages/data/migrations/0001_core.sql"),
      "packages/data/migrations/0001_core.sql\n",
      "utf8",
    );
    for (const buildConfigPath of [
      "packages/data/tsconfig.build.json",
      "packages/story-core/tsconfig.build.json",
      "packages/application/tsconfig.test.json",
      "apps/desktop/src-tauri/tauri.dev.conf.json",
      "apps/desktop/src-tauri/.cargo/config.toml",
    ]) {
      await writeFile(path.join(root, buildConfigPath), "changed build config bytes\n", "utf8");
      const afterBuildConfigChange = await createDesktopReleaseSourceFingerprint(root);
      assert.notEqual(
        afterBuildConfigChange.digest,
        before.digest,
        `${buildConfigPath} bytes must affect the source digest`,
      );
      assert.equal(afterBuildConfigChange.fileCount, before.fileCount);
      await writeFile(path.join(root, buildConfigPath), `${buildConfigPath}\n`, "utf8");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop release source collection rejects symlinked workspace package roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-release-symlink-"));
  try {
    await Promise.all(
      requiredFiles.map(async (relativePath) => {
        const filePath = path.join(root, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${relativePath}\n`, "utf8");
      }),
    );
    const externalPackage = path.join(root, "external-package");
    await mkdir(externalPackage, { recursive: true });
    await symlink(
      externalPackage,
      path.join(root, "packages", "linked-package"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      collectDesktopReleaseSourceFiles(root),
      /Workspace package roots must not be symlinks/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release path validation rejects symlinked ancestors and escaped paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-release-path-"));
  try {
    const safeDirectory = path.join(root, "safe", "dist");
    const safeFile = path.join(root, "safe", "baseline.json");
    await mkdir(safeDirectory, { recursive: true });
    await writeFile(safeFile, "{}\n", "utf8");
    await requireSafeReleasePath(root, safeDirectory, "directory", "Distribution");
    await requireSafeReleasePath(root, safeFile, "file", "Baseline");

    const linkedTarget = path.join(root, "linked-target");
    const linkedParent = path.join(root, "linked-parent");
    await mkdir(linkedTarget);
    await writeFile(path.join(linkedTarget, "baseline.json"), "{}\n", "utf8");
    await symlink(linkedTarget, linkedParent, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      requireSafeReleasePath(root, path.join(linkedParent, "baseline.json"), "file", "Baseline"),
      /must not contain symlinks/u,
    );
    await assert.rejects(
      requireSafeReleasePath(root, path.dirname(root), "directory", "Distribution"),
      /must stay inside/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release reference scan ignores import text inside regex-adjacent strings but rejects missing modules", async () => {
  const temporaryRoot = path.join(workspaceRoot, "apps", "desktop", ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const distributionRoot = await mkdtemp(path.join(temporaryRoot, "release-reference-scan-"));
  const assetDirectory = path.join(distributionRoot, "assets");
  const chunkPath = path.join(assetDirectory, "story-runtime-AbCdEf12.js");
  const scannerRegressionSource = String.raw`const credentialPattern=/\btoken\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/giu;const scopes=["chapter","import"],issuer=Symbol("AutomaticMemoryAuthorizationIssuer");`;
  try {
    await mkdir(assetDirectory);
    await writeFile(
      path.join(distributionRoot, "index.html"),
      '<!doctype html><html><body><script type="module" src="/assets/story-runtime-AbCdEf12.js"></script></body></html>\n',
      "utf8",
    );
    const checkChunk = async (source) => {
      await writeFile(chunkPath, source, "utf8");
      await writeFixtureManifest(distributionRoot);
      return runReleaseChecker(distributionRoot);
    };

    const falsePositiveResult = await checkChunk(scannerRegressionSource);
    assert.equal(
      falsePositiveResult.status,
      0,
      `${falsePositiveResult.stdout}\n${falsePositiveResult.stderr}`,
    );

    const missingModuleResult = await checkChunk(
      `${scannerRegressionSource}const loadMissing=()=>import("./missing-runtime-ZyxwVu12.js");`,
    );
    assert.equal(missingModuleResult.status, 1);
    assert.match(
      missingModuleResult.stderr,
      /references missing local asset assets\/missing-runtime-ZyxwVu12\.js/u,
    );

    const missingSideEffectResult = await checkChunk(
      `${scannerRegressionSource}import"./missing-side-effect-QwerTy12.js";`,
    );
    assert.equal(missingSideEffectResult.status, 1);
    assert.match(
      missingSideEffectResult.stderr,
      /references missing local asset assets\/missing-side-effect-QwerTy12\.js/u,
    );

    const blockCommentedSideEffectResult = await checkChunk(
      `${scannerRegressionSource}import "./missing-block-comment-AsDfGh12.js" /* release comment */;`,
    );
    assert.equal(blockCommentedSideEffectResult.status, 1);
    assert.match(
      blockCommentedSideEffectResult.stderr,
      /references missing local asset assets\/missing-block-comment-AsDfGh12\.js/u,
    );

    const lineCommentedSideEffectResult = await checkChunk(
      `${scannerRegressionSource}import "./missing-line-comment-YuIoPa12.js" // release comment\nconst afterImport=1;void afterImport;`,
    );
    assert.equal(lineCommentedSideEffectResult.status, 1);
    assert.match(
      lineCommentedSideEffectResult.stderr,
      /references missing local asset assets\/missing-line-comment-YuIoPa12\.js/u,
    );

    const missingStaticImportResult = await checkChunk(
      `${scannerRegressionSource}import { value } from "./missing-static-HjKlQw12.js";void value;`,
    );
    assert.equal(missingStaticImportResult.status, 1);
    assert.match(
      missingStaticImportResult.stderr,
      /references missing local asset assets\/missing-static-HjKlQw12\.js/u,
    );

    const missingBundledAssetResult = await checkChunk(
      `${scannerRegressionSource}const icon="/assets/missing-icon-ZxCvBn12.png";void icon;`,
    );
    assert.equal(missingBundledAssetResult.status, 1);
    assert.match(
      missingBundledAssetResult.stderr,
      /references missing local asset assets\/missing-icon-ZxCvBn12\.png/u,
    );

    const externalModuleResult = await checkChunk(
      `${scannerRegressionSource}const loadExternal=()=>import("https://updates.example.test/runtime.js");`,
    );
    assert.equal(externalModuleResult.status, 1);
    assert.match(
      externalModuleResult.stderr,
      /contains external runtime reference https:\/\/updates\.example\.test\/runtime\.js/u,
    );
  } finally {
    await rm(distributionRoot, { recursive: true, force: true });
  }
});

async function writeFixtureManifest(distributionRoot) {
  const manifest = createDesktopReleaseManifest(
    await createDesktopReleaseSourceFingerprint(workspaceRoot),
    createDesktopReleaseEnvironmentFingerprint(),
    await createDesktopReleaseArtifactFingerprint(distributionRoot),
  );
  await writeFile(
    path.join(distributionRoot, "inkshadow-release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function runReleaseChecker(distributionRoot) {
  return spawnSync(
    process.execPath,
    [
      path.join(workspaceRoot, "scripts", "check-desktop-release.mjs"),
      "--dist",
      path.relative(workspaceRoot, distributionRoot),
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: process.env,
    },
  );
}
