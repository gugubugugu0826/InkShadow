import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { assertReleaseGitEnvironmentSafe, resolvePnpmCli } from "./desktop-release-manifest.mjs";

const ROOT_CONFIGURATION_PATHS = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  ".prettierrc.json",
  "eslint.config.mjs",
  "package.json",
  "playwright.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
]);
const LINTABLE_EXTENSION = /\.(?:cjs|js|mjs|ts|tsx)$/u;
const FORMATTABLE_EXTENSION =
  /\.(?:cjs|css|graphql|html|js|json|json5|jsonc|jsx|md|mdx|mjs|scss|svg|ts|tsx|yaml|yml)$/u;
const TEST_FILE = /(?:^|\/)\S+\.test\.(?:cjs|js|mjs|ts|tsx)$/u;

export function createVerificationPlan({ mode, paths, workspaces }) {
  if (mode !== "focus" && mode !== "affected") {
    throw new Error("验证模式必须是聚焦验证或受影响范围验证。");
  }
  if (!Array.isArray(paths) || !Array.isArray(workspaces)) {
    throw new Error("验证规划输入无效。");
  }
  const normalizedPaths = [...new Set(paths.map(normalizeWorkspacePath))].sort((left, right) =>
    left.localeCompare(right),
  );
  if (normalizedPaths.length === 0) {
    if (mode === "focus") {
      throw new Error("聚焦验证至少需要一个工作区内路径。");
    }
    return Object.freeze({
      level: "none",
      paths: Object.freeze([]),
      workspaceNames: Object.freeze([]),
      reasons: Object.freeze(["没有检测到变更；本次不执行测试，也不记录为通过。"]),
      commands: Object.freeze([]),
    });
  }

  const classifications = normalizedPaths.map((changedPath) =>
    classifyPath(changedPath, workspaces),
  );
  const fullReasons = classifications
    .filter(({ kind }) => kind === "full")
    .map(({ path: changedPath, reason }) => `${changedPath}：${reason}`);
  const needsRust = classifications.some(({ rust }) => rust);
  if (fullReasons.length > 0) {
    const commands = [command("release-check", "完整发布前门禁", ["release:check"])];
    if (needsRust) {
      commands.push(command("rust-check", "原生层完整门禁", ["check:rust"]));
    }
    return freezePlan({
      level: "full",
      paths: normalizedPaths,
      workspaceNames: [],
      reasons: ["发现不能安全缩小范围的变更，已升级为完整门禁。", ...fullReasons],
      commands,
    });
  }

  const directWorkspaceNames = classifications
    .map(({ workspaceName }) => workspaceName)
    .filter((value) => value !== null);
  const workspaceNames =
    mode === "affected"
      ? collectDependentClosure(directWorkspaceNames, workspaces)
      : [...new Set(directWorkspaceNames)].sort((left, right) => left.localeCompare(right));
  const hasScripts = classifications.some(({ kind }) => kind === "scripts");
  const hasDocs = classifications.some(({ kind }) => kind === "docs");
  const hasWorkspace = workspaceNames.length > 0;

  if (mode === "focus") {
    return createFocusPlan({
      normalizedPaths,
      classifications,
      workspaceNames,
      workspaces,
      hasScripts,
      hasDocs,
      needsRust,
    });
  }

  const commands = [];
  if (hasWorkspace || hasScripts || hasDocs) {
    commands.push(command("format-all", "全仓格式检查", ["format:check"]));
  }
  if (hasWorkspace || hasScripts) {
    commands.push(command("lint-all", "全仓代码规范检查", ["lint"]));
  }
  if (hasScripts) {
    commands.push(command("script-tests", "全部脚本测试", ["test:scripts"]));
  }
  if (hasWorkspace) {
    commands.push(
      command(
        "typecheck:affected",
        "受影响工作区类型检查",
        affectedWorkspaceArguments(workspaceNames, "typecheck"),
      ),
      command(
        "test:affected",
        "受影响工作区测试",
        affectedWorkspaceArguments(workspaceNames, "test"),
      ),
    );
  }
  if (needsRust) {
    commands.push(command("rust-check", "原生层完整门禁", ["check:rust"]));
  }

  return freezePlan({
    level: "affected",
    paths: normalizedPaths,
    workspaceNames,
    reasons: [
      hasWorkspace
        ? "已包含直接变更工作区及其全部传递依赖方。"
        : "变更仅涉及脚本或文档，不运行无关工作区测试。",
    ],
    commands,
  });
}

function createFocusPlan({
  normalizedPaths,
  classifications,
  workspaceNames,
  workspaces,
  hasScripts,
  hasDocs,
  needsRust,
}) {
  const commands = [];
  if (hasScripts) {
    commands.push(
      command("format-all", "全仓格式检查", ["format:check"]),
      command("lint-all", "全仓代码规范检查", ["lint"]),
      command("script-tests", "全部脚本测试", ["test:scripts"]),
    );
  } else if (workspaceNames.length > 0 || hasDocs) {
    const formattablePaths = normalizedPaths.filter((changedPath) =>
      FORMATTABLE_EXTENSION.test(changedPath),
    );
    if (formattablePaths.length > 0) {
      commands.push(
        command("format-focus", "聚焦文件格式检查", [
          "exec",
          "prettier",
          "--check",
          ...formattablePaths,
        ]),
      );
    }
    const lintablePaths = normalizedPaths.filter((changedPath) =>
      LINTABLE_EXTENSION.test(changedPath),
    );
    if (lintablePaths.length > 0) {
      commands.push(
        command("lint-focus", "聚焦文件代码规范检查", [
          "exec",
          "eslint",
          ...lintablePaths,
          "--max-warnings",
          "0",
        ]),
      );
    }
  }

  for (const workspaceName of workspaceNames) {
    const workspace = workspaces.find(({ name }) => name === workspaceName);
    if (workspace?.scripts?.typecheck) {
      commands.push(
        command(`typecheck:${workspaceName}`, `${workspaceName} 类型检查`, [
          "--filter",
          workspaceName,
          "run",
          "typecheck",
        ]),
      );
    }
    if (workspace?.scripts?.test) {
      const ownedClassifications = classifications.filter(
        ({ workspaceName: owner }) => owner === workspaceName,
      );
      const onlyTests =
        ownedClassifications.length > 0 &&
        ownedClassifications.every(({ path: changedPath }) => TEST_FILE.test(changedPath));
      const testPaths = onlyTests
        ? ownedClassifications.map(({ workspaceRelativePath }) => workspaceRelativePath)
        : [];
      commands.push(
        command(`test:${workspaceName}`, `${workspaceName} 测试`, [
          "--filter",
          workspaceName,
          "run",
          "test",
          ...(testPaths.length > 0 ? ["--", ...testPaths] : []),
        ]),
      );
    }
  }
  if (needsRust) {
    commands.push(command("rust-check", "原生层完整门禁", ["check:rust"]));
  }

  return freezePlan({
    level: "focus",
    paths: normalizedPaths,
    workspaceNames,
    reasons: ["只验证明确指定的文件和所属工作区；提交前仍需运行受影响范围验证。"],
    commands,
  });
}

function classifyPath(changedPath, workspaces) {
  if (isMigrationPath(changedPath)) {
    return {
      kind: "full",
      path: changedPath,
      reason: "数据库迁移必须经过完整门禁",
      rust: changedPath.startsWith("apps/desktop/src-tauri/"),
      workspaceName: null,
      workspaceRelativePath: null,
    };
  }
  if (isRootConfigurationPath(changedPath)) {
    return {
      kind: "full",
      path: changedPath,
      reason: "根配置或持续集成配置会影响全部工作区",
      rust: isRustConfigurationPath(changedPath),
      workspaceName: null,
      workspaceRelativePath: null,
    };
  }
  if (changedPath.startsWith("scripts/")) {
    return simpleClassification("scripts", changedPath);
  }
  if (isDocumentationPath(changedPath)) {
    return simpleClassification("docs", changedPath);
  }

  const workspace = [...workspaces]
    .sort((left, right) => right.relativePath.length - left.relativePath.length)
    .find(
      ({ relativePath }) =>
        changedPath === relativePath || changedPath.startsWith(`${relativePath}/`),
    );
  if (workspace !== undefined) {
    const workspaceRelativePath = changedPath
      .slice(workspace.relativePath.length)
      .replace(/^\//u, "");
    if (isRustConfigurationPath(changedPath)) {
      return {
        kind: "full",
        path: changedPath,
        reason: "原生依赖或打包配置会影响完整候选",
        rust: true,
        workspaceName: workspace.name,
        workspaceRelativePath,
      };
    }
    return {
      kind: "workspace",
      path: changedPath,
      reason: "",
      rust: changedPath.startsWith("apps/desktop/src-tauri/"),
      workspaceName: workspace.name,
      workspaceRelativePath,
    };
  }

  return {
    kind: "full",
    path: changedPath,
    reason: "路径不属于已知验证范围",
    rust: false,
    workspaceName: null,
    workspaceRelativePath: null,
  };
}

function simpleClassification(kind, changedPath) {
  return {
    kind,
    path: changedPath,
    reason: "",
    rust: false,
    workspaceName: null,
    workspaceRelativePath: null,
  };
}

function isMigrationPath(changedPath) {
  return changedPath.split("/").includes("migrations");
}

function isRootConfigurationPath(changedPath) {
  return ROOT_CONFIGURATION_PATHS.has(changedPath) || changedPath.startsWith(".github/");
}

function isRustConfigurationPath(changedPath) {
  return (
    /(?:^|\/)Cargo\.(?:lock|toml)$/u.test(changedPath) ||
    changedPath === "apps/desktop/src-tauri/build.rs" ||
    /^apps\/desktop\/src-tauri\/(?:tauri|capabilities\/|\.cargo\/|gen\/)/u.test(changedPath)
  );
}

function isDocumentationPath(changedPath) {
  return (
    changedPath.startsWith("docs/") ||
    changedPath === "README.md" ||
    changedPath === "AGENTS.md" ||
    changedPath.endsWith("/README.md")
  );
}

function collectDependentClosure(initialNames, workspaces) {
  const selected = new Set(initialNames);
  let changed = true;
  while (changed) {
    changed = false;
    for (const workspace of workspaces) {
      if (
        !selected.has(workspace.name) &&
        workspace.dependencies.some((dependency) => selected.has(dependency))
      ) {
        selected.add(workspace.name);
        changed = true;
      }
    }
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
}

function affectedWorkspaceArguments(workspaceNames, scriptName) {
  return [
    ...workspaceNames.flatMap((workspaceName) => ["--filter", workspaceName]),
    "--workspace-concurrency=1",
    "--if-present",
    "run",
    scriptName,
  ];
}

function command(id, label, arguments_) {
  return { id, label, executable: "pnpm", arguments: arguments_ };
}

function freezePlan(plan) {
  return Object.freeze({
    ...plan,
    paths: Object.freeze([...plan.paths]),
    workspaceNames: Object.freeze([...plan.workspaceNames]),
    reasons: Object.freeze([...plan.reasons]),
    commands: Object.freeze(
      plan.commands.map((item) =>
        Object.freeze({ ...item, arguments: Object.freeze([...item.arguments]) }),
      ),
    ),
  });
}

export function normalizeWorkspacePath(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error("验证路径不能为空或包含非法字符。");
  }
  const slashPath = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (path.posix.isAbsolute(slashPath) || /^[A-Za-z]:\//u.test(slashPath)) {
    throw new Error(`验证路径必须相对于工作区：${value}`);
  }
  const normalized = path.posix.normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`验证路径超出工作区：${value}`);
  }
  return normalized;
}

export async function discoverWorkspaces(workspaceRoot) {
  const workspaces = [];
  for (const group of ["apps", "packages"]) {
    const groupRoot = path.join(workspaceRoot, group);
    const entries = await readdir(groupRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const directory = path.join(groupRoot, entry.name);
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink()) {
        throw new Error(`工作区目录不允许符号链接：${group}/${entry.name}`);
      }
      if (!metadata.isDirectory()) {
        continue;
      }
      let manifestSource;
      try {
        manifestSource = await readFile(path.join(directory, "package.json"), "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const manifest = JSON.parse(manifestSource);
      if (typeof manifest.name !== "string" || manifest.name.length === 0) {
        throw new Error(`工作区缺少有效名称：${group}/${entry.name}`);
      }
      const dependencyNames = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);
      workspaces.push({
        name: manifest.name,
        relativePath: `${group}/${entry.name}`,
        dependencies: [...dependencyNames],
        scripts: {
          test: typeof manifest.scripts?.test === "string",
          typecheck: typeof manifest.scripts?.typecheck === "string",
        },
      });
    }
  }
  const workspaceNames = new Set(workspaces.map(({ name }) => name));
  return workspaces
    .map((workspace) => ({
      ...workspace,
      dependencies: workspace.dependencies
        .filter((dependency) => workspaceNames.has(dependency))
        .sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function collectChangedPaths(workspaceRoot, base = "HEAD", options = {}) {
  if (!/^(?!-)[A-Za-z0-9._/@~^{}:+-]+$/u.test(base)) {
    throw new Error("变更基线不是安全的 Git 引用。");
  }
  const environment = options.environment ?? process.env;
  assertReleaseGitEnvironmentSafe(environment);
  const gitEnvironment = createVerificationGitEnvironment(environment);
  const run = options.spawn ?? spawnSync;
  const common = ["-c", `safe.directory=${path.resolve(workspaceRoot)}`];
  const tracked = run(
    "git",
    [
      ...common,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      "--diff-filter=ACDMRTUXB",
      base,
      "--",
    ],
    { cwd: workspaceRoot, encoding: "utf8", env: gitEnvironment, shell: false },
  );
  assertGitResult(tracked, "读取已跟踪变更");
  const untracked = run("git", [...common, "ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: gitEnvironment,
    shell: false,
  });
  assertGitResult(untracked, "读取未跟踪变更");
  return [...new Set([...splitNull(tracked.stdout), ...splitNull(untracked.stdout)])]
    .map(normalizeWorkspacePath)
    .sort((left, right) => left.localeCompare(right));
}

function assertGitResult(result, action) {
  if (result.error !== undefined) {
    throw new Error(`${action}失败：${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim().slice(0, 400) : "";
    throw new Error(`${action}失败${detail === "" ? "" : `：${detail}`}`);
  }
}

function splitNull(value) {
  return String(value ?? "")
    .split("\0")
    .filter((item) => item.length > 0);
}

function createVerificationGitEnvironment(environment) {
  const controlledNames = new Set([
    "GIT_ATTR_NOSYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIFF_OPTS",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
  ]);
  const sanitized = {};
  for (const [name, value] of Object.entries(environment)) {
    const normalizedName = name.toUpperCase();
    if (
      controlledNames.has(normalizedName) ||
      /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/u.test(normalizedName)
    ) {
      continue;
    }
    sanitized[name] = value;
  }
  sanitized.GIT_ATTR_NOSYSTEM = "1";
  sanitized.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  sanitized.GIT_DIFF_OPTS = "";
  sanitized.GIT_EXTERNAL_DIFF = "";
  sanitized.GIT_NO_REPLACE_OBJECTS = "1";
  sanitized.GIT_OPTIONAL_LOCKS = "0";
  sanitized.GIT_PAGER = "";
  return sanitized;
}

export async function runVerificationPlan(plan, workspaceRoot, options = {}) {
  const run = options.spawn ?? spawnSync;
  const packageManagerCli = options.packageManagerCli ?? (await resolvePnpmCli(process.env));
  for (const item of plan.commands) {
    if (item.executable !== "pnpm") {
      throw new Error(`不支持的验证程序：${item.executable}`);
    }
    process.stdout.write(`开始：${item.label}\n`);
    const result = run(process.execPath, [packageManagerCli, ...item.arguments], {
      cwd: workspaceRoot,
      stdio: "inherit",
      shell: false,
    });
    if (result.error !== undefined) {
      throw new Error(`${item.label}无法启动：${result.error.message}`, { cause: result.error });
    }
    if (result.status !== 0) {
      throw new Error(`${item.label}未通过，退出码：${String(result.status ?? "未知")}`);
    }
  }
}
