import assert from "node:assert/strict";
import test from "node:test";

import { createVerificationPlan } from "./verification-planner.mjs";

const workspaces = [
  {
    name: "@inkshadow/domain",
    relativePath: "packages/domain",
    dependencies: [],
    scripts: { test: true, typecheck: true },
  },
  {
    name: "@inkshadow/application",
    relativePath: "packages/application",
    dependencies: ["@inkshadow/domain"],
    scripts: { test: true, typecheck: true },
  },
  {
    name: "@inkshadow/desktop",
    relativePath: "apps/desktop",
    dependencies: ["@inkshadow/application"],
    scripts: { test: true, typecheck: true },
  },
];

test("聚焦层只运行目标测试文件及所属工作区类型检查", () => {
  const plan = createVerificationPlan({
    mode: "focus",
    paths: ["packages/domain/tests/content-entities.test.ts"],
    workspaces,
  });

  assert.equal(plan.level, "focus");
  assert.deepEqual(plan.workspaceNames, ["@inkshadow/domain"]);
  assert.deepEqual(
    plan.commands.map(({ id }) => id),
    ["format-focus", "lint-focus", "typecheck:@inkshadow/domain", "test:@inkshadow/domain"],
  );
  assert.deepEqual(plan.commands.at(-1)?.arguments.slice(-2), [
    "--",
    "tests/content-entities.test.ts",
  ]);
});

test("受影响层包含传递依赖方，但不扩成全仓测试", () => {
  const plan = createVerificationPlan({
    mode: "affected",
    paths: ["packages/domain/src/entities/ai-candidate.ts"],
    workspaces,
  });

  assert.equal(plan.level, "affected");
  assert.deepEqual(plan.workspaceNames, [
    "@inkshadow/application",
    "@inkshadow/desktop",
    "@inkshadow/domain",
  ]);
  assert(plan.commands.some(({ id }) => id === "test:affected"));
  assert(plan.commands.every(({ id }) => id !== "release-check"));
});

test("根配置、数据库迁移和未知路径都会升级到完整门禁", () => {
  for (const changedPath of [
    "package.json",
    "packages/data/migrations/0099_future.sql",
    "unclassified/input.bin",
  ]) {
    const plan = createVerificationPlan({
      mode: "affected",
      paths: [changedPath],
      workspaces,
    });
    assert.equal(plan.level, "full", changedPath);
    assert.deepEqual(
      plan.commands.map(({ id }) => id),
      ["release-check"],
    );
  }
});

test("原生层变更在工作区验证之外增加原生门禁", () => {
  const plan = createVerificationPlan({
    mode: "affected",
    paths: ["apps/desktop/src-tauri/src/lib.rs"],
    workspaces,
  });

  assert.equal(plan.level, "affected");
  assert(plan.commands.some(({ id }) => id === "rust-check"));
});

test("脚本变更运行全部脚本测试，纯文档变更只检查格式", () => {
  const scriptsPlan = createVerificationPlan({
    mode: "affected",
    paths: ["scripts/check-secrets.mjs"],
    workspaces,
  });
  assert.deepEqual(
    scriptsPlan.commands.map(({ id }) => id),
    ["format-all", "lint-all", "script-tests"],
  );

  const docsPlan = createVerificationPlan({
    mode: "affected",
    paths: ["docs/execution/TEST_RESULTS.md"],
    workspaces,
  });
  assert.deepEqual(
    docsPlan.commands.map(({ id }) => id),
    ["format-all"],
  );
});

test("空变更不会伪造测试通过", () => {
  const plan = createVerificationPlan({ mode: "affected", paths: [], workspaces });
  assert.equal(plan.level, "none");
  assert.deepEqual(plan.commands, []);
  assert.match(plan.reasons.join(" "), /没有检测到变更/u);
});
