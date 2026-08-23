import assert from "node:assert/strict";
import test from "node:test";

import { createVerificationPlan } from "./verification-planner.mjs";

const workspaces = [
  {
    name: "@inkshadow/desktop",
    relativePath: "apps/desktop",
    dependencies: [],
    scripts: { test: true, typecheck: true },
  },
];

test("聚焦原生源码或二进制资源时不会交给不支持的格式化器", () => {
  for (const changedPath of [
    "apps/desktop/src-tauri/src/lib.rs",
    "apps/desktop/src/assets/cover.png",
  ]) {
    const plan = createVerificationPlan({
      mode: "focus",
      paths: [changedPath],
      workspaces,
    });
    assert.equal(
      plan.commands.some(({ id }) => id === "format-focus"),
      false,
      changedPath,
    );
  }
});
