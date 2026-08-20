import { spawnSync } from "node:child_process";

const sourceRevision = process.env.INKSHADOW_SOURCE_REVISION;
if (
  sourceRevision === undefined ||
  sourceRevision === "WORKTREE_UNBOUND" ||
  !/^[0-9a-f]{40}$/u.test(sourceRevision)
) {
  process.stderr.write(
    "INKSHADOW_SOURCE_REVISION must be the lowercase 40-hex SHA of the frozen source commit; WORKTREE_UNBOUND is forbidden.\n",
  );
  process.exit(1);
}

const gitHead = runGit(["rev-parse", "HEAD"]);
if (gitHead !== sourceRevision) {
  process.stderr.write(
    `INKSHADOW_SOURCE_REVISION does not match the checked-out HEAD (${gitHead || "unavailable"}).\n`,
  );
  process.exit(1);
}
const gitStatus = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
if (gitStatus.length > 0) {
  process.stderr.write(
    "The production long-form benchmark requires a clean frozen worktree before it can emit commit-bound evidence.\n",
  );
  process.exit(1);
}

const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  executable,
  [
    "--filter",
    "@inkshadow/desktop",
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.config.ts",
    "src/infrastructure/production-long-form-benchmark.test.ts",
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      INKSHADOW_WRITE_LONG_FORM_BENCHMARK: "1",
    },
    shell: process.platform === "win32",
    stdio: "inherit",
  },
);

if (result.error !== undefined) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);

function runGit(arguments_) {
  const result = spawnSync("git", ["-c", `safe.directory=${process.cwd()}`, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined || result.status !== 0) {
    process.stderr.write(
      `Unable to inspect the frozen Git source: ${result.error?.message ?? (result.stderr ?? "").trim()}\n`,
    );
    process.exit(1);
  }
  return result.stdout.trim();
}
