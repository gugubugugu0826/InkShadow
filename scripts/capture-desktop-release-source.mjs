import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  createDesktopReleaseEnvironmentFingerprint,
  createDesktopReleaseSourceBaseline,
  createDesktopReleaseSourceFingerprint,
  inspectCleanReleaseHead,
  verifyReleaseHeadUnchanged,
} from "./desktop-release-manifest.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const outputPath = parseOutput(process.argv.slice(2));
await ensureSafeParent(path.dirname(outputPath));
await ensureSafeOutput(outputPath);
const initialHead = await inspectCleanReleaseHead(workspaceRoot);
const baseline = createDesktopReleaseSourceBaseline(
  await createDesktopReleaseSourceFingerprint(workspaceRoot),
  createDesktopReleaseEnvironmentFingerprint(),
  initialHead.gitCommitSha,
);
verifyReleaseHeadUnchanged(initialHead, await inspectCleanReleaseHead(workspaceRoot));
await writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
process.stdout.write(
  `Captured desktop release source baseline for ${String(
    baseline.sourceFingerprint.fileCount,
  )} files at Git commit ${baseline.gitCommitSha}.\n`,
);

function parseOutput(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || arguments_[1] === undefined) {
    throw new Error("Usage: capture-desktop-release-source.mjs --output <workspace file>");
  }
  const resolved = path.resolve(workspaceRoot, arguments_[1]);
  const relative = path.relative(workspaceRoot, resolved);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    resolved === workspaceRoot
  ) {
    throw new Error("The release source baseline must stay inside the workspace.");
  }
  return resolved;
}

async function ensureSafeParent(directory) {
  const relative = path.relative(workspaceRoot, directory);
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      await mkdir(current);
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("The release source baseline parent must not contain symlinks.");
    }
  }
}

async function ensureSafeOutput(filePath) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The release source baseline output must be a regular file.");
  }
}
