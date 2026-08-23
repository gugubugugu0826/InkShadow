import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverWorkspaces } from "./verification-planner.mjs";

test("工作区发现会跳过没有清单的应用目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-workspace-discovery-"));
  try {
    await mkdir(path.join(root, "apps", "android"), { recursive: true });
    await mkdir(path.join(root, "packages", "domain"), { recursive: true });
    await writeFile(
      path.join(root, "packages", "domain", "package.json"),
      JSON.stringify({
        name: "@inkshadow/domain",
        scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
      }),
      "utf8",
    );

    const discovered = await discoverWorkspaces(root);
    assert.deepEqual(
      discovered.map(({ name }) => name),
      ["@inkshadow/domain"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
