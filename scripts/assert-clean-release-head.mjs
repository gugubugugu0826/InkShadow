import { fileURLToPath, URL } from "node:url";

import { inspectCleanReleaseHead } from "./desktop-release-manifest.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const { gitCommitSha } = await inspectCleanReleaseHead(workspaceRoot);

process.stdout.write(`Release source is clean at Git commit ${gitCommitSha}.\n`);
