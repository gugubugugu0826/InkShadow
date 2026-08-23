import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("根验证命令保持职责分离且发布门禁包含全部脚本测试", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const scripts = manifest.scripts;

  assert.equal(scripts["test:scripts"], "node scripts/script-test-runner.mjs");
  assert.equal(
    scripts["check:desktop-release"],
    "node scripts/check-desktop-release.mjs --config-only",
  );
  assert.match(scripts["release:check"], /pnpm test:scripts/u);
  assert.match(scripts["test:all"], /pnpm test:scripts/u);
  assert.equal(scripts["verify:focus"], "node scripts/run-verification.mjs focus");
  assert.equal(scripts["verify:affected"], "node scripts/run-verification.mjs affected");
  assert.equal(
    scripts["test:watch"],
    "pnpm --filter @inkshadow/desktop exec vitest --config vitest.config.ts --configLoader runner",
  );
});
