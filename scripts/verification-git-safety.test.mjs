import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { collectChangedPaths } from "./verification-planner.mjs";

test("变更收集器拒绝重定向仓库的 Git 环境", () => {
  let spawned = false;
  assert.throws(
    () =>
      collectChangedPaths(process.cwd(), "HEAD", {
        environment: { GIT_DIR: "attacker-controlled" },
        spawn: () => {
          spawned = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    /repository-selection environment variables/u,
  );
  assert.equal(spawned, false);
});

test("变更收集器移除继承的 Git 配置注入并禁用外部差异程序", () => {
  const calls = [];
  const paths = collectChangedPaths(process.cwd(), "HEAD", {
    environment: {
      PATH: process.env.PATH,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesfile",
      GIT_CONFIG_VALUE_0: "attacker-controlled",
    },
    spawn: (executable, arguments_, options) => {
      calls.push({ executable, arguments_, options });
      return {
        status: 0,
        stdout: calls.length === 1 ? "packages/domain/src/index.ts\0" : "",
        stderr: "",
      };
    },
  });

  assert.deepEqual(paths, ["packages/domain/src/index.ts"]);
  assert(calls[0]?.arguments_.includes("--no-ext-diff"));
  assert(calls[0]?.arguments_.includes("--no-textconv"));
  for (const call of calls) {
    assert.equal(call.options.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(call.options.env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(call.options.env.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, "1");
  }
});
