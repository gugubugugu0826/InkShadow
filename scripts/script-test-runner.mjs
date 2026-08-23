import { spawnSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export async function collectScriptTestFiles(scriptsRoot) {
  const root = path.resolve(scriptsRoot);
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink()) {
    throw new Error("脚本测试目录不允许符号链接。");
  }
  if (!rootMetadata.isDirectory()) {
    throw new Error("脚本测试目录不存在或不是目录。");
  }

  const files = [];
  await visit(root, root, files);
  return files.sort((left, right) => left.localeCompare(right));
}

async function visit(root, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      const relativePath = path.relative(root, target).replaceAll("\\", "/");
      throw new Error(`脚本目录不允许符号链接：${relativePath}`);
    }
    if (metadata.isDirectory()) {
      await visit(root, target, files);
      continue;
    }
    if (metadata.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(target);
    }
  }
}

export function runScriptTests(testFiles, options = {}) {
  if (testFiles.length === 0) {
    throw new Error("没有找到脚本测试；为避免空门禁，本次检查已停止。");
  }
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(process.execPath, ["--test", ...testFiles], {
    cwd: options.cwd,
    stdio: "inherit",
    shell: false,
  });
  if (result.error !== undefined) {
    throw new Error(`无法启动脚本测试：${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`脚本测试未通过，退出码：${String(result.status ?? "未知")}`);
  }
}

async function main() {
  const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
  const testFiles = await collectScriptTestFiles(scriptsRoot);
  process.stdout.write(`已收集 ${testFiles.length} 个脚本测试文件，开始运行。\n`);
  runScriptTests(testFiles, { cwd: path.resolve(scriptsRoot, "..") });
  process.stdout.write("脚本测试全部通过。\n");
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    process.stderr.write(`脚本测试检查失败：${message}\n`);
    process.exitCode = 1;
  }
}
