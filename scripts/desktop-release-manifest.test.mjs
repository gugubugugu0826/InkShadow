import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UNSIGNED_RELEASE_CANDIDATE_STEPS,
  assertNoHiddenGitIndexFlags,
  assertReleaseGitEnvironmentSafe,
  collectDesktopReleaseSourceFiles,
  createDesktopReleaseArtifactFingerprint,
  createDesktopReleaseEnvironmentFingerprint,
  createDesktopReleaseManifest,
  createDesktopReleaseSourceBaseline,
  createDesktopReleaseSourceFingerprint,
  inspectCleanReleaseHead,
  requireSafeReleasePath,
  resolvePnpmCli,
  runUnsignedReleaseCandidate,
  verifyDesktopReleaseSourceBaseline,
  verifyReleaseInputsMatchHead,
  verifyReleaseHeadUnchanged,
} from "./desktop-release-manifest.mjs";
import {
  EXPECTED_FILE_DESCRIPTION,
  EXPECTED_PE_MACHINE,
  EXPECTED_PRODUCT_NAME,
  EXPECTED_RELEASE_VERSION,
  createWindowsPowerShellEnvironment,
  decodeWindowsInstallerMetadata,
  normalizeWindowsVersion,
  validateInstallerMetadata,
  validateTauriConfiguration,
} from "./check-windows-installer-version.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseCommitSha = "a".repeat(40);
const replacementCommitSha = "b".repeat(40);
const expectedUnsignedReleaseCandidateSteps = [
  { label: "workspace release checks", arguments: ["release:check"] },
  { label: "Rust release checks", arguments: ["check:rust"] },
  { label: "release frontend and E2E", arguments: ["test:e2e:release"] },
  {
    label: "unsigned Tauri packaging",
    arguments: ["--filter", "@inkshadow/desktop", "tauri:package:unsigned:prebuilt"],
  },
  {
    label: "Windows installer version verification",
    arguments: ["release:verify:installer-version"],
  },
  {
    label: "packaged release provenance verification",
    arguments: ["release:verify:unsigned"],
  },
];

test("0.2.16 authoritative application versions stay aligned", async () => {
  const [rootSource, desktopSource, tauriSource, cargoManifest, cargoLock, runtime] =
    await Promise.all([
      readFile(path.join(workspaceRoot, "package.json"), "utf8"),
      readFile(path.join(workspaceRoot, "apps", "desktop", "package.json"), "utf8"),
      readFile(path.join(workspaceRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
      readFile(path.join(workspaceRoot, "apps", "desktop", "src-tauri", "Cargo.toml"), "utf8"),
      readFile(path.join(workspaceRoot, "apps", "desktop", "src-tauri", "Cargo.lock"), "utf8"),
      readFile(
        path.join(workspaceRoot, "apps", "desktop", "src", "infrastructure", "runtime.ts"),
        "utf8",
      ),
    ]);
  const rootManifest = JSON.parse(rootSource);
  const desktopManifest = JSON.parse(desktopSource);
  const tauriConfiguration = JSON.parse(tauriSource);
  const expectedVersion = "0.2.16";
  assert.equal(rootManifest.version, expectedVersion);
  assert.equal(desktopManifest.version, expectedVersion);
  assert.equal(tauriConfiguration.version, expectedVersion);
  assert.equal(/^\s*version\s*=\s*"([^"]+)"\s*$/mu.exec(cargoManifest)?.[1], expectedVersion);
  assert.match(
    cargoLock,
    /\[\[package\]\]\r?\nname = "inkshadow-desktop"\r?\nversion = "0\.2\.16"/u,
  );
  assert.match(runtime, /appVersion:\s*"0\.2\.16"/u);
  assert.equal(
    rootManifest.scripts["release:verify:installer-version"],
    "node scripts/check-windows-installer-version.mjs",
  );
  assert.deepEqual(UNSIGNED_RELEASE_CANDIDATE_STEPS, expectedUnsignedReleaseCandidateSteps);
});

test("Windows installer contract accepts only the 0.2.16 branded AMD64 unsigned package", () => {
  assert.doesNotThrow(() =>
    validateTauriConfiguration({
      productName: EXPECTED_PRODUCT_NAME,
      version: EXPECTED_RELEASE_VERSION,
    }),
  );
  const validMetadata = {
    ProductName: EXPECTED_PRODUCT_NAME,
    FileDescription: EXPECTED_FILE_DESCRIPTION,
    ProductVersion: `${EXPECTED_RELEASE_VERSION}.0`,
    FileVersion: EXPECTED_RELEASE_VERSION,
    ApplicationMachine: EXPECTED_PE_MACHINE,
    SignatureStatus: "NotSigned",
  };
  assert.doesNotThrow(() => validateInstallerMetadata(validMetadata));
  assert.deepEqual(
    decodeWindowsInstallerMetadata(
      Buffer.from(JSON.stringify(validMetadata), "utf8").toString("base64"),
    ),
    validMetadata,
  );
  assert.throws(() => decodeWindowsInstallerMetadata("īӰ InkShadow"), /canonical Base64/u);
  assert.equal(normalizeWindowsVersion("0.2.16.0"), EXPECTED_RELEASE_VERSION);
  assert.equal(normalizeWindowsVersion("0.2.16"), EXPECTED_RELEASE_VERSION);
});

test("Windows installer inspection does not inherit an incompatible PowerShell module path", () => {
  const environment = createWindowsPowerShellEnvironment(
    {
      Path: "C:\\Windows\\System32",
      PSModulePath: "C:\\Program Files\\PowerShell\\Modules",
      PSMODULEPATH: "C:\\shadowed-module-path",
      INKSHADOW_INSTALLER_PATH: "stale-installer",
      INKSHADOW_APPLICATION_PATH: "stale-application",
    },
    "C:\\release\\墨影 InkShadow_0.2.16_x64-setup.exe",
    "C:\\release\\inkshadow-desktop.exe",
  );

  assert.equal(
    Object.keys(environment).some((key) => key.toLowerCase() === "psmodulepath"),
    false,
  );
  assert.equal(environment.Path, "C:\\Windows\\System32");
  assert.equal(
    environment.INKSHADOW_INSTALLER_PATH,
    "C:\\release\\墨影 InkShadow_0.2.16_x64-setup.exe",
  );
  assert.equal(environment.INKSHADOW_APPLICATION_PATH, "C:\\release\\inkshadow-desktop.exe");
});

test("Windows installer contract rejects wrong identity, version, architecture and signature", () => {
  assert.throws(
    () => validateTauriConfiguration({ productName: "InkShadow", version: "0.2.16" }),
    /product name/u,
  );
  assert.throws(
    () => validateTauriConfiguration({ productName: EXPECTED_PRODUCT_NAME, version: "0.2.14" }),
    /release version/u,
  );
  const validMetadata = {
    ProductName: EXPECTED_PRODUCT_NAME,
    FileDescription: EXPECTED_FILE_DESCRIPTION,
    ProductVersion: "0.2.16.0",
    FileVersion: "0.2.16.0",
    ApplicationMachine: EXPECTED_PE_MACHINE,
    SignatureStatus: "NotSigned",
  };
  for (const [field, value, expectedMessage] of [
    ["ProductName", "InkShadow", /ProductName/u],
    ["FileDescription", "InkShadow installer", /FileDescription/u],
    ["ProductVersion", "0.2.14.0", /ProductVersion and FileVersion/u],
    ["FileVersion", "0.2.14.0", /ProductVersion and FileVersion/u],
    ["ApplicationMachine", "I386", /machine must be AMD64/u],
    ["SignatureStatus", "Valid", /NotSigned/u],
  ]) {
    assert.throws(
      () => validateInstallerMetadata({ ...validMetadata, [field]: value }),
      expectedMessage,
      `${field} must be rejected`,
    );
  }
  assert.equal(normalizeWindowsVersion("0.2.16.1"), null);
  assert.equal(normalizeWindowsVersion("not-a-version"), null);
});

const requiredFiles = [
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
  "apps/desktop/public/favicon.svg",
  "apps/desktop/src-tauri/Cargo.lock",
  "apps/desktop/src-tauri/Cargo.toml",
  "apps/desktop/src-tauri/build.rs",
  "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/tauri.dev.conf.json",
  "apps/desktop/src-tauri/tauri.release-gate.conf.json",
  "apps/desktop/src-tauri/.cargo/config.toml",
  "scripts/capture-desktop-release-source.mjs",
  "scripts/assert-clean-release-head.mjs",
  "scripts/run-unsigned-release-candidate.mjs",
  "scripts/check-desktop-release.mjs",
  "scripts/check-windows-installer-version.mjs",
  "scripts/desktop-release-manifest.mjs",
  "scripts/desktop-release-manifest.test.mjs",
  "scripts/run-e2e.mjs",
  "scripts/serve-e2e.mjs",
  "scripts/write-desktop-release-manifest.mjs",
  "apps/desktop/src/main.ts",
  "apps/desktop/src-tauri/capabilities/default.json",
  "apps/desktop/src-tauri/gen/schemas/acl-manifests.json",
  "apps/desktop/src-tauri/icons/icon.png",
  "apps/desktop/src-tauri/src/lib.rs",
  "packages/access-core/package.json",
  "packages/access-core/tsconfig.json",
  "packages/access-core/src/index.ts",
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
    assert(relativeFiles.has("packages/access-core/package.json"));
    assert(relativeFiles.has("packages/access-core/src/index.ts"));
    assert(relativeFiles.has("apps/desktop/src-tauri/tauri.dev.conf.json"));
    assert(relativeFiles.has("apps/desktop/src-tauri/.cargo/config.toml"));
    assert(relativeFiles.has("apps/desktop/public/favicon.svg"));
    assert(relativeFiles.has(".gitattributes"));
    assert(relativeFiles.has(".github/workflows/ci.yml"));
    assert(relativeFiles.has("eslint.config.mjs"));
    assert(relativeFiles.has("playwright.config.ts"));
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
    const baseline = createDesktopReleaseSourceBaseline(before, environment, releaseCommitSha);
    assert.equal(baseline.schemaVersion, 2);
    assert.equal(baseline.gitCommitSha, releaseCommitSha);
    assert.deepEqual(
      verifyDesktopReleaseSourceBaseline(baseline, repeated, environment, releaseCommitSha),
      baseline,
    );
    assert.throws(
      () =>
        verifyDesktopReleaseSourceBaseline(
          baseline,
          { ...repeated, digest: "f".repeat(64) },
          environment,
          releaseCommitSha,
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
          releaseCommitSha,
        ),
      /changed after baseline capture/u,
    );
    assert.throws(
      () =>
        verifyDesktopReleaseSourceBaseline(baseline, repeated, environment, replacementCommitSha),
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
      "apps/desktop/public/favicon.svg",
      ".gitattributes",
      ".github/workflows/ci.yml",
      "eslint.config.mjs",
      "playwright.config.ts",
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

test("release Git provenance requires one clean, stable, full HEAD", async () => {
  const repository = await createMinimalReleaseRepository();
  try {
    const clean = await inspectCleanReleaseHead(repository.root);
    assert.equal(clean.gitCommitSha, repository.gitCommitSha);

    const packagePath = path.join(repository.root, "package.json");
    const packageSource = await readFile(packagePath, "utf8");
    await writeFile(packagePath, packageSource.replaceAll("\n", "\r\n"), "utf8");
    await verifyReleaseInputsMatchHead(repository.root, [packagePath]);
    await writeFile(packagePath, "changed release input\r\n", "utf8");
    await assert.rejects(
      verifyReleaseInputsMatchHead(repository.root, [packagePath]),
      /HEAD blob/u,
    );
    await assert.rejects(inspectCleanReleaseHead(repository.root), /clean Git worktree|HEAD blob/u);

    const manifest = createDesktopReleaseManifest({}, {}, {}, repository.gitCommitSha);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.gitCommitSha, repository.gitCommitSha);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }

  assert.throws(
    () =>
      verifyReleaseHeadUnchanged(
        { gitCommitSha: releaseCommitSha },
        { gitCommitSha: replacementCommitSha },
      ),
    /HEAD changed during release generation/u,
  );
});

test("release Git provenance accepts an unlinked Windows namespace alias for the same root", async () => {
  if (process.platform !== "win32") {
    return;
  }
  const repository = await createMinimalReleaseRepository();
  try {
    const namespaceRoot = path.toNamespacedPath(repository.root);
    assert.notEqual(namespaceRoot, repository.root);
    const clean = await inspectCleanReleaseHead(namespaceRoot);
    assert.equal(clean.gitCommitSha, repository.gitCommitSha);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("release Git provenance rejects linked workspace roots and linked ancestors", async () => {
  const repository = await createMinimalReleaseRepository();
  const aliasHolder = await mkdtemp(path.join(tmpdir(), "inkshadow-release-root-alias-"));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const linkedRoot = path.join(aliasHolder, "linked-root");
  const linkedParent = path.join(aliasHolder, "linked-parent");
  try {
    await symlink(repository.root, linkedRoot, linkType);
    await assert.rejects(inspectCleanReleaseHead(linkedRoot), /must not contain symbolic links/u);
    await unlink(linkedRoot);

    await symlink(path.dirname(repository.root), linkedParent, linkType);
    await assert.rejects(
      inspectCleanReleaseHead(path.join(linkedParent, path.basename(repository.root))),
      /must not contain symbolic links/u,
    );
  } finally {
    await unlinkIfPresent(linkedRoot);
    await unlinkIfPresent(linkedParent);
    await rm(aliasHolder, { recursive: true, force: true });
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("release Git provenance rejects repository-selection environments and hidden index flags", async () => {
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    assert.throws(
      () => assertReleaseGitEnvironmentSafe({ [name]: "attacker-controlled" }),
      /repository-selection environment variables/u,
      name,
    );
  }
  assert.doesNotThrow(() =>
    assertReleaseGitEnvironmentSafe({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: workspaceRoot,
      GIT_PAGER: "more.com",
    }),
  );
  assert.doesNotThrow(() => assertReleaseGitEnvironmentSafe({ PATH: process.env.PATH }));
  assert.throws(
    () => assertNoHiddenGitIndexFlags("h package.json\0H safe.txt\0"),
    /assume-unchanged/u,
  );
  assert.throws(
    () => assertNoHiddenGitIndexFlags("S package.json\0H safe.txt\0"),
    /skip-worktree/u,
  );

  const repository = await createMinimalReleaseRepository();
  try {
    runGitFixture(["update-index", "--assume-unchanged", "package.json"], repository.root);
    const hiddenFlagResult = runReleaseHeadChild(repository.root);
    assert.equal(hiddenFlagResult.status, 1);
    assert.match(hiddenFlagResult.stderr, /assume-unchanged/u);

    const poisonedEnvironmentResult = runReleaseHeadChild(repository.root, {
      GIT_DIR: path.join(repository.root, ".git"),
    });
    assert.equal(poisonedEnvironmentResult.status, 1);
    assert.match(poisonedEnvironmentResult.stderr, /repository-selection environment variables/u);

    runGitFixture(["update-index", "--no-assume-unchanged", "package.json"], repository.root);
    const globalAttributesPath = path.join(repository.root, ".git", "poison-attributes");
    await writeFile(globalAttributesPath, "* filter=conceal\n", "utf8");
    const sanitizedConfigResult = runReleaseHeadChild(repository.root, {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.attributesfile",
      GIT_CONFIG_VALUE_0: globalAttributesPath,
      GIT_CONFIG_KEY_1: "filter.conceal.clean",
      GIT_CONFIG_VALUE_1: "definitely-not-a-release-filter",
      GIT_CONFIG_KEY_2: "alias.release-probe",
      GIT_CONFIG_VALUE_2: "!exit 97",
      GIT_PAGER: "more.com",
    });
    assert.equal(
      sanitizedConfigResult.status,
      0,
      `${sanitizedConfigResult.stdout}\n${sanitizedConfigResult.stderr}`,
    );

    await writeFile(
      path.join(repository.root, ".gitattributes"),
      "* text\npackage.json filter=conceal\n",
      "utf8",
    );
    runGitFixture(["add", ".gitattributes"], repository.root);
    runGitFixture(
      [
        "-c",
        "user.name=InkShadow Release Test",
        "-c",
        "user.email=release-test@invalid.example",
        "commit",
        "-m",
        "forbidden filter",
      ],
      repository.root,
    );
    const filteredInputResult = runReleaseHeadChild(repository.root);
    assert.equal(filteredInputResult.status, 1);
    assert.match(filteredInputResult.stderr, /forbidden filter=conceal/u);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("unsigned candidate keeps one clean HEAD through Tauri packaging", async () => {
  const initial = Object.freeze({ gitCommitSha: releaseCommitSha });
  const completedSteps = [];
  const output = [];
  const stableStates = [initial, initial, initial, initial, initial, initial, initial];
  const completed = await runUnsignedReleaseCandidate(workspaceRoot, {
    inspectReleaseHead: async () => stableStates.shift(),
    runStep: async (_root, step) => completedSteps.push(step.label),
    writeOutput: (message) => output.push(message),
  });
  assert.deepEqual(completed, initial);
  assert.deepEqual(UNSIGNED_RELEASE_CANDIDATE_STEPS, expectedUnsignedReleaseCandidateSteps);
  assert.deepEqual(
    completedSteps,
    expectedUnsignedReleaseCandidateSteps.map(({ label }) => label),
  );
  assert(output.every((message) => message.includes(releaseCommitSha)));

  const changedAfterPackaging = [
    initial,
    initial,
    initial,
    initial,
    { gitCommitSha: replacementCommitSha },
  ];
  const packagingSteps = [];
  await assert.rejects(
    runUnsignedReleaseCandidate(workspaceRoot, {
      inspectReleaseHead: async () => changedAfterPackaging.shift(),
      runStep: async (_root, step) => packagingSteps.push(step.label),
      writeOutput: () => {},
    }),
    /HEAD changed during release generation/u,
  );
  assert.equal(packagingSteps.at(-1), "unsigned Tauri packaging");

  const persistentArtifactMutationSteps = [];
  let distributionWasMutated = false;
  await assert.rejects(
    runUnsignedReleaseCandidate(workspaceRoot, {
      inspectReleaseHead: async () => initial,
      runStep: async (_root, step) => {
        persistentArtifactMutationSteps.push(step.label);
        if (step.label === "unsigned Tauri packaging") {
          distributionWasMutated = true;
        }
        if (step.label === "packaged release provenance verification" && distributionWasMutated) {
          throw new Error("release source/artifact manifest no longer matches dist-release");
        }
      },
      writeOutput: () => {},
    }),
    /manifest no longer matches dist-release/u,
  );
  assert.equal(persistentArtifactMutationSteps.at(-1), "packaged release provenance verification");

  let inspections = 0;
  await assert.rejects(
    runUnsignedReleaseCandidate(workspaceRoot, {
      inspectReleaseHead: async () => {
        inspections += 1;
        if (inspections === 3) {
          throw new Error("Release candidates require a clean Git worktree and index.");
        }
        return initial;
      },
      runStep: async () => {},
      writeOutput: () => {},
    }),
    /require a clean Git worktree and index/u,
  );
});

test("pnpm CLI resolution accepts absolute npm_execpath and pnpm 11 PATH layouts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-pnpm-cli-"));
  try {
    const explicitCli = path.join(root, "explicit", "pnpm.cjs");
    await mkdir(path.dirname(explicitCli), { recursive: true });
    await writeFile(explicitCli, "// pnpm fixture\n", "utf8");
    assert.equal(
      await resolvePnpmCli({
        npm_execpath: explicitCli,
        npm_config_user_agent: "npm/11.0.0 node/v24.0.0",
        PATH: path.join(root, "untrusted-fallback"),
      }),
      await realpath(explicitCli),
    );

    const pathEntry = path.join(root, "global bin");
    const fallbackCli = path.join(pathEntry, "node_modules", "pnpm", "bin", "pnpm.mjs");
    await mkdir(path.dirname(fallbackCli), { recursive: true });
    await writeFile(fallbackCli, "// pnpm 11 fixture\n", "utf8");
    assert.equal(
      await resolvePnpmCli({
        npm_config_user_agent: "pnpm/11.0.0 npm/? node/v24.0.0 win32 x64",
        PATH: `"${pathEntry}"`,
      }),
      await realpath(fallbackCli),
    );

    const workspaceBin = path.join(root, "workspace", "node_modules", ".bin");
    const workspaceCli = path.join(workspaceBin, "..", "pnpm", "bin", "pnpm.cjs");
    await mkdir(path.dirname(workspaceCli), { recursive: true });
    await writeFile(workspaceCli, "// workspace pnpm fixture\n", "utf8");
    assert.equal(
      await resolvePnpmCli({
        npm_config_user_agent: "pnpm/11.0.0 npm/? node/v24.0.0",
        PATH: workspaceBin,
      }),
      await realpath(workspaceCli),
    );

    if (process.platform !== "win32") {
      const linkedBin = path.join(root, "linked-bin");
      await mkdir(linkedBin);
      await symlink(fallbackCli, path.join(linkedBin, "pnpm"));
      assert.equal(
        await resolvePnpmCli({
          npm_config_user_agent: "pnpm/11.0.0 npm/? node/v24.0.0 linux x64",
          PATH: linkedBin,
        }),
        await realpath(fallbackCli),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pnpm CLI resolution fails closed for untrusted launch contexts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-pnpm-cli-reject-"));
  try {
    const pathEntry = path.join(root, "global-bin");
    const fallbackCli = path.join(pathEntry, "node_modules", "pnpm", "bin", "pnpm.mjs");
    await mkdir(path.dirname(fallbackCli), { recursive: true });
    await writeFile(fallbackCli, "// pnpm fixture\n", "utf8");

    await assert.rejects(
      resolvePnpmCli({ PATH: pathEntry, npm_config_user_agent: "npm/11.0.0 node/v24.0.0" }),
      /through pnpm/u,
    );
    await assert.rejects(
      resolvePnpmCli({
        npm_execpath: path.join("relative", "pnpm.mjs"),
        npm_config_user_agent: "pnpm/11.0.0 npm/? node/v24.0.0",
        PATH: pathEntry,
      }),
      /must be an absolute/u,
    );
    await assert.rejects(
      resolvePnpmCli({
        npm_execpath: path.join(root, "missing", "pnpm.mjs"),
        npm_config_user_agent: "pnpm/11.0.0 npm/? node/v24.0.0",
        PATH: pathEntry,
      }),
      /not a regular/u,
    );
    await assert.rejects(
      resolvePnpmCli({
        npm_config_user_agent: "pnpm/11.0.0 npm/? node/v24.0.0",
        PATH: pathEntry,
        Path: path.join(root, "conflicting-bin"),
      }),
      /Conflicting PATH/u,
    );
    await assert.rejects(
      resolvePnpmCli({
        npm_config_user_agent: "pnpm/11.0.0 npm/? node/v24.0.0",
        PATH: path.join(root, "commands-only"),
      }),
      /Could not resolve/u,
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

test("artifact fingerprint excludes only the root release manifest", async () => {
  const distributionRoot = await mkdtemp(path.join(tmpdir(), "inkshadow-release-artifact-"));
  try {
    await mkdir(path.join(distributionRoot, "nested"));
    await writeFile(path.join(distributionRoot, "index.html"), "release\n", "utf8");
    await writeFile(
      path.join(distributionRoot, "inkshadow-release-manifest.json"),
      "root attestation\n",
      "utf8",
    );
    await writeFile(
      path.join(distributionRoot, "nested", "inkshadow-release-manifest.json"),
      "nested product asset\n",
      "utf8",
    );
    const fingerprint = await createDesktopReleaseArtifactFingerprint(distributionRoot);
    assert.deepEqual(
      fingerprint.files.map(({ path: relativePath }) => relativePath),
      ["index.html", "nested/inkshadow-release-manifest.json"],
    );
  } finally {
    await rm(distributionRoot, { recursive: true, force: true });
  }
});

test("Vite and release attestation share the audited async and aggregate budgets", async () => {
  const [viteConfiguration, releaseChecker] = await Promise.all([
    readFile(path.join(workspaceRoot, "apps", "desktop", "vite.config.ts"), "utf8"),
    readFile(path.join(workspaceRoot, "scripts", "check-desktop-release.mjs"), "utf8"),
  ]);
  const viteAsyncBudget = viteConfiguration.match(/ASYNC_CHUNK_BUDGET_BYTES\s*=\s*([^;]+);/u)?.[1];
  const attestationAsyncBudget = releaseChecker.match(/asyncChunk:\s*([^,\n]+),/u)?.[1];
  const viteBudget = viteConfiguration.match(/TOTAL_FRONTEND_BUDGET_BYTES\s*=\s*([^;]+);/u)?.[1];
  const attestationBudget = releaseChecker.match(/totalFrontend:\s*([^,\n]+),/u)?.[1];
  assert.ok(viteAsyncBudget, "Vite async chunk budget is missing");
  assert.ok(attestationAsyncBudget, "release attestation async chunk budget is missing");
  assert.ok(viteBudget, "Vite aggregate frontend budget is missing");
  assert.ok(attestationBudget, "release attestation aggregate frontend budget is missing");
  assert.equal(viteAsyncBudget.replaceAll(/\s+/gu, ""), "520*1024");
  assert.equal(
    attestationAsyncBudget.replaceAll(/\s+/gu, ""),
    viteAsyncBudget.replaceAll(/\s+/gu, ""),
    "the build and release attestation must reject the same oversized async chunk",
  );
  assert.equal(viteBudget.replaceAll(/\s+/gu, ""), "7*1024*1024+128*1024");
  assert.equal(
    attestationBudget.replaceAll(/\s+/gu, ""),
    viteBudget.replaceAll(/\s+/gu, ""),
    "the build and release attestation must reject the same aggregate payload",
  );
});

test("release configuration requires exact clean-checkout build commands", async () => {
  const releaseWorkspace = await createReleaseCheckerRepository();
  const ciPath = path.join(releaseWorkspace.root, ".github", "workflows", "ci.yml");
  try {
    const original = await readFile(ciPath, "utf8");
    const verified = runConfigChecker(releaseWorkspace.root);
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);

    const qualityMutation = original.replace(
      "- name: Build workspace\n        run: pnpm build",
      "- name: Build workspace\n        run: pnpm build:noop",
    );
    assert.notEqual(qualityMutation, original);
    await writeFile(ciPath, qualityMutation, "utf8");
    const rejectedQuality = runConfigChecker(releaseWorkspace.root);
    assert.equal(rejectedQuality.status, 1);
    assert.match(rejectedQuality.stderr, /CI quality checks must build workspace package entries/u);

    const nativeMutation = original.replace(
      "- name: Build workspace for native checks\n        run: pnpm build",
      "- name: Build workspace for native checks\n        run: pnpm build:noop",
    );
    assert.notEqual(nativeMutation, original);
    await writeFile(ciPath, nativeMutation, "utf8");
    const rejectedNative = runConfigChecker(releaseWorkspace.root);
    assert.equal(rejectedNative.status, 1);
    assert.match(rejectedNative.stderr, /CI must build workspace package entries/u);
  } finally {
    await rm(releaseWorkspace.root, { recursive: true, force: true });
  }
});

test("post-package provenance verification rejects a persistent dist-release mutation", async () => {
  const releaseWorkspace = await createReleaseCheckerRepository();
  const distributionRoot = path.join(
    releaseWorkspace.root,
    "apps",
    "desktop",
    ".tmp",
    "post-package-dist",
  );
  const assetDirectory = path.join(distributionRoot, "assets");
  const chunkPath = path.join(assetDirectory, "main-AbCdEf12.js");
  try {
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(
      path.join(distributionRoot, "index.html"),
      '<!doctype html><html><body><script type="module" src="/assets/main-AbCdEf12.js"></script></body></html>\n',
      "utf8",
    );
    await writeFile(chunkPath, "const releaseArtifact = true;void releaseArtifact;\n", "utf8");
    await writeFixtureManifest(
      distributionRoot,
      releaseWorkspace.gitCommitSha,
      releaseWorkspace.root,
    );
    const verified = runReleaseChecker(distributionRoot, releaseWorkspace.root);
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);

    await writeFile(chunkPath, "const releaseArtifact = false;void releaseArtifact;\n", "utf8");
    const mutated = runReleaseChecker(distributionRoot, releaseWorkspace.root);
    assert.equal(mutated.status, 1);
    assert.match(mutated.stderr, /release source\/artifact manifest/u);
  } finally {
    await rm(releaseWorkspace.root, { recursive: true, force: true });
  }
});

test("release reference scan ignores import text inside regex-adjacent strings but rejects missing modules", async () => {
  const releaseWorkspace = await createReleaseCheckerRepository();
  const temporaryRoot = path.join(releaseWorkspace.root, "apps", "desktop", ".tmp");
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
      await writeFixtureManifest(
        distributionRoot,
        releaseWorkspace.gitCommitSha,
        releaseWorkspace.root,
      );
      return runReleaseChecker(distributionRoot, releaseWorkspace.root);
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
    await rm(releaseWorkspace.root, { recursive: true, force: true });
  }
});

async function writeFixtureManifest(
  distributionRoot,
  gitCommitSha,
  sourceWorkspaceRoot = workspaceRoot,
) {
  const manifest = createDesktopReleaseManifest(
    await createDesktopReleaseSourceFingerprint(sourceWorkspaceRoot),
    createDesktopReleaseEnvironmentFingerprint(),
    await createDesktopReleaseArtifactFingerprint(distributionRoot),
    gitCommitSha,
  );
  await writeFile(
    path.join(distributionRoot, "inkshadow-release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function createReleaseCheckerRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-release-checker-"));
  await Promise.all(
    requiredFiles.map(async (relativePath) => {
      const sourcePath = path.join(workspaceRoot, relativePath);
      const destinationPath = path.join(root, relativePath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      try {
        await copyFile(sourcePath, destinationPath);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }),
  );
  runGitFixture(["init"], root);
  runGitFixture(["add", "-A"], root);
  runGitFixture(
    [
      "-c",
      "user.name=InkShadow Release Test",
      "-c",
      "user.email=release-test@invalid.example",
      "commit",
      "-m",
      "release checker fixture",
    ],
    root,
  );
  const commit = runGitFixture(["rev-parse", "--verify", "HEAD^{commit}"], root);
  return { root, gitCommitSha: commit.stdout.trim() };
}

async function createMinimalReleaseRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-release-git-"));
  await Promise.all(
    requiredFiles.map(async (relativePath) => {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${relativePath}\n`, "utf8");
    }),
  );
  await writeFile(path.join(root, ".gitattributes"), "* text\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), "# release fixture\n", "utf8");
  await copyFile(
    path.join(workspaceRoot, "scripts", "desktop-release-manifest.mjs"),
    path.join(root, "scripts", "desktop-release-manifest.mjs"),
  );
  await copyFile(
    path.join(workspaceRoot, "scripts", "assert-clean-release-head.mjs"),
    path.join(root, "scripts", "assert-clean-release-head.mjs"),
  );
  runGitFixture(["init"], root);
  runGitFixture(["add", "-A"], root);
  runGitFixture(
    [
      "-c",
      "user.name=InkShadow Release Test",
      "-c",
      "user.email=release-test@invalid.example",
      "commit",
      "-m",
      "release fixture",
    ],
    root,
  );
  const commit = runGitFixture(["rev-parse", "--verify", "HEAD^{commit}"], root);
  return { root, gitCommitSha: commit.stdout.trim() };
}

function runReleaseHeadChild(repositoryRoot, environmentOverrides = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => !/^GIT_/iu.test(name) && value !== undefined,
    ),
  );
  return spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "assert-clean-release-head.mjs")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...environment, ...environmentOverrides },
      windowsHide: true,
    },
  );
}

function runReleaseChecker(distributionRoot, releaseWorkspaceRoot) {
  return spawnSync(
    process.execPath,
    [
      path.join(releaseWorkspaceRoot, "scripts", "check-desktop-release.mjs"),
      "--dist",
      path.relative(releaseWorkspaceRoot, distributionRoot),
    ],
    {
      cwd: releaseWorkspaceRoot,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name, value]) => !/^GIT_/iu.test(name) && value !== undefined,
        ),
      ),
    },
  );
}

function runConfigChecker(releaseWorkspaceRoot) {
  return spawnSync(
    process.execPath,
    [path.join(releaseWorkspaceRoot, "scripts", "check-desktop-release.mjs"), "--config-only"],
    {
      cwd: releaseWorkspaceRoot,
      encoding: "utf8",
    },
  );
}

function runGitFixture(arguments_, cwd = workspaceRoot) {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

async function unlinkIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
