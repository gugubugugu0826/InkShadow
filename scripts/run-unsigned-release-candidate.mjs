import { fileURLToPath, URL } from "node:url";

import { runUnsignedReleaseCandidate } from "./desktop-release-manifest.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
await runUnsignedReleaseCandidate(workspaceRoot);
