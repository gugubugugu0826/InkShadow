import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  DESKTOP_RELEASE_MANIFEST_NAME,
  createDesktopReleaseArtifactFingerprint,
  createDesktopReleaseEnvironmentFingerprint,
  createDesktopReleaseManifest,
  createDesktopReleaseSourceFingerprint,
  inspectCleanReleaseHead,
  requireSafeReleasePath,
  verifyDesktopReleaseSourceBaseline,
  verifyReleaseHeadUnchanged,
} from "./desktop-release-manifest.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const options = parseArguments(process.argv.slice(2));
await requireSafeReleasePath(
  workspaceRoot,
  options.distributionRoot,
  "directory",
  "Release distribution",
);
await requireSafeReleasePath(
  workspaceRoot,
  options.sourceBaseline,
  "file",
  "Release source baseline",
);
const baseline = await readBaseline(options.sourceBaseline);
const initialHead = await inspectCleanReleaseHead(workspaceRoot);
const sourceFingerprint = await createDesktopReleaseSourceFingerprint(workspaceRoot);
const environmentFingerprint = createDesktopReleaseEnvironmentFingerprint();
verifyDesktopReleaseSourceBaseline(
  baseline,
  sourceFingerprint,
  environmentFingerprint,
  initialHead.gitCommitSha,
);
const artifactFingerprint = await createDesktopReleaseArtifactFingerprint(options.distributionRoot);
const finalSourceFingerprint = await createDesktopReleaseSourceFingerprint(workspaceRoot);
const finalEnvironmentFingerprint = createDesktopReleaseEnvironmentFingerprint();
const finalHead = await inspectCleanReleaseHead(workspaceRoot);
verifyReleaseHeadUnchanged(initialHead, finalHead);
verifyDesktopReleaseSourceBaseline(
  baseline,
  finalSourceFingerprint,
  finalEnvironmentFingerprint,
  finalHead.gitCommitSha,
);
const manifest = createDesktopReleaseManifest(
  baseline.sourceFingerprint,
  baseline.environmentFingerprint,
  artifactFingerprint,
  baseline.gitCommitSha,
);
await writeFile(
  path.join(options.distributionRoot, DESKTOP_RELEASE_MANIFEST_NAME),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `Wrote ${DESKTOP_RELEASE_MANIFEST_NAME} for ${String(
    artifactFingerprint.fileCount,
  )} release files at Git commit ${baseline.gitCommitSha}.\n`,
);

async function readBaseline(filePath) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The release source baseline must be a regular file.");
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error("The release source baseline is not valid JSON.", { cause: error });
  }
}

function parseArguments(arguments_) {
  let distributionRoot = null;
  let sourceBaseline = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if ((argument === "--dist" || argument === "--source-baseline") && value !== undefined) {
      const resolved = parseWorkspacePath(value, argument);
      if (argument === "--dist") {
        if (distributionRoot !== null) {
          throw new Error("--dist may only be provided once.");
        }
        distributionRoot = resolved;
      } else {
        if (sourceBaseline !== null) {
          throw new Error("--source-baseline may only be provided once.");
        }
        sourceBaseline = resolved;
      }
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: write-desktop-release-manifest.mjs --dist <workspace directory> --source-baseline <workspace file>",
    );
  }
  if (distributionRoot === null || sourceBaseline === null) {
    throw new Error(
      "Usage: write-desktop-release-manifest.mjs --dist <workspace directory> --source-baseline <workspace file>",
    );
  }
  return { distributionRoot, sourceBaseline };
}

function parseWorkspacePath(value, label) {
  const resolved = path.resolve(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, resolved);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    resolved === workspaceRoot
  ) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
  return resolved;
}
