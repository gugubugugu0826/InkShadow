import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectScriptTestFiles } from "./script-test-runner.mjs";

test("脚本测试收集器递归收集全部测试并保持稳定顺序", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-script-tests-"));
  try {
    await mkdir(path.join(root, "enterprise"), { recursive: true });
    await writeFile(path.join(root, "z.test.mjs"), "", "utf8");
    await writeFile(path.join(root, "enterprise", "a.test.mjs"), "", "utf8");
    await writeFile(path.join(root, "enterprise", "helper.mjs"), "", "utf8");

    const files = await collectScriptTestFiles(root);
    assert.deepEqual(
      files.map((file) => path.relative(root, file).replaceAll("\\", "/")),
      ["enterprise/a.test.mjs", "z.test.mjs"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("脚本测试收集器拒绝目录中的符号链接", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inkshadow-script-symlink-"));
  try {
    const external = await mkdtemp(path.join(tmpdir(), "inkshadow-script-external-"));
    await writeFile(path.join(external, "escaped.test.mjs"), "", "utf8");
    await symlink(
      external,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(collectScriptTestFiles(root), /不允许符号链接/u);
    await rm(external, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
