import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { runVerificationPlan } from "./verification-planner.mjs";

test("验证执行器通过当前 Node 启动已解析的包管理器入口", async () => {
  const calls = [];
  const packageManagerCli = path.resolve("fixture", "pnpm.cjs");
  await runVerificationPlan(
    {
      commands: [
        {
          id: "fixture",
          label: "夹具检查",
          executable: "pnpm",
          arguments: ["test:scripts"],
        },
      ],
    },
    process.cwd(),
    {
      packageManagerCli,
      spawn: (executable, arguments_, options) => {
        calls.push({ executable, arguments_, options });
        return { status: 0 };
      },
    },
  );

  assert.equal(calls[0]?.executable, process.execPath);
  assert.deepEqual(calls[0]?.arguments_, [packageManagerCli, "test:scripts"]);
  assert.equal(calls[0]?.options.shell, false);
});
