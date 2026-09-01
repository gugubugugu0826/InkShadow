import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop bundle policy", () => {
  it("runs after other generateBundle hooks so it measures final artifact bytes", () => {
    const configSource = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

    expect(configSource).toMatch(/generateBundle:\s*\{\s*order:\s*"post"/u);
  });

  it("keeps the reviewed chunk and aggregate limits aligned with the release audit", () => {
    const configSource = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
    const releaseAuditSource = readFileSync(
      resolve(process.cwd(), "../../scripts/check-desktop-release.mjs"),
      "utf8",
    );

    expect(configSource).toMatch(/ASYNC_CHUNK_BUDGET_BYTES = 520 \* 1024/u);
    expect(releaseAuditSource).toMatch(/asyncChunk: 520 \* 1024/u);
    expect(configSource).toMatch(/TOTAL_FRONTEND_BUDGET_BYTES = 7 \* 1024 \* 1024 \+ 160 \* 1024/u);
    expect(releaseAuditSource).toMatch(/totalFrontend: 7 \* 1024 \* 1024 \+ 160 \* 1024/u);
  });
});
