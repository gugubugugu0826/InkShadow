import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  collectChangedPaths,
  createVerificationPlan,
  discoverWorkspaces,
  runVerificationPlan,
} from "./verification-planner.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else {
    const workspaces = await discoverWorkspaces(workspaceRoot);
    const paths =
      options.mode === "focus"
        ? await resolveFocusPaths(options.paths)
        : collectChangedPaths(workspaceRoot, options.base);
    const plan = createVerificationPlan({ mode: options.mode, paths, workspaces });
    printPlan(plan, options.dryRun);
    if (!options.dryRun && plan.commands.length > 0) {
      await runVerificationPlan(plan, workspaceRoot);
      process.stdout.write("本层验证全部通过。\n");
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "未知错误";
  process.stderr.write(`验证流程已停止：${message}\n`);
  process.exitCode = 1;
}

function parseArguments(arguments_) {
  const mode = arguments_[0];
  if (mode !== "focus" && mode !== "affected") {
    throw new Error("请指定 focus 或 affected 验证模式。");
  }
  const paths = [];
  let base = "HEAD";
  let dryRun = false;
  let help = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--base") {
      const value = arguments_[index + 1];
      if (mode !== "affected" || value === undefined) {
        throw new Error("只有受影响范围验证可使用 --base，并且必须提供基线。");
      }
      base = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("-")) {
      throw new Error(`不支持的验证参数：${argument}`);
    }
    paths.push(argument);
  }
  if (mode === "affected" && paths.length > 0) {
    throw new Error("受影响范围验证会从 Git 读取变更，不接受手工路径。");
  }
  return { mode, paths, base, dryRun, help };
}

async function resolveFocusPaths(values) {
  if (values.length === 0) {
    throw new Error("聚焦验证至少需要一个文件或目录路径。");
  }
  const root = await realpath(workspaceRoot);
  const relativePaths = [];
  for (const value of values) {
    const target = path.resolve(workspaceRoot, value);
    const relative = path.relative(root, target);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`聚焦路径超出工作区：${value}`);
    }
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      throw new Error(`聚焦路径不允许符号链接：${value}`);
    }
    const resolved = await realpath(target);
    const resolvedRelative = path.relative(root, resolved);
    if (resolvedRelative === ".." || resolvedRelative.startsWith(`..${path.sep}`)) {
      throw new Error(`聚焦路径解析后超出工作区：${value}`);
    }
    relativePaths.push(relative.replaceAll("\\", "/"));
  }
  return relativePaths;
}

function printPlan(plan, dryRun) {
  const levelLabels = {
    none: "无变更",
    focus: "聚焦验证",
    affected: "受影响范围验证",
    full: "完整门禁",
  };
  process.stdout.write(`验证层级：${levelLabels[plan.level]}\n`);
  for (const reason of plan.reasons) {
    process.stdout.write(`- ${reason}\n`);
  }
  if (plan.workspaceNames.length > 0) {
    process.stdout.write(`涉及工作区：${plan.workspaceNames.join("、")}\n`);
  }
  if (plan.commands.length === 0) {
    return;
  }
  process.stdout.write(`${dryRun ? "计划" : "将要执行"}：\n`);
  for (const item of plan.commands) {
    process.stdout.write(`- ${item.label}\n`);
  }
}

function printHelp() {
  process.stdout.write(
    [
      "三层验证用法：",
      "  pnpm verify:focus -- <文件或目录...>",
      "  pnpm verify:affected [--base <Git 引用>] [--dry-run]",
      "聚焦验证用于开发中的快速反馈；受影响范围验证会包含传递依赖方；发布前仍需完整门禁。",
      "",
    ].join("\n"),
  );
}
