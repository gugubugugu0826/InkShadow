import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop bundle policy", () => {
  it("runs after other generateBundle hooks so it measures final artifact bytes", () => {
    const configSource = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

    expect(configSource).toMatch(/generateBundle:\s*\{\s*order:\s*"post"/u);
  });
});
