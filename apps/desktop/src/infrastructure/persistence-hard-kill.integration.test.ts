import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const WORKSPACE_ROOT = findWorkspaceRoot(process.cwd());
const WRITER_PATH = resolve(
  WORKSPACE_ROOT,
  "apps",
  "desktop",
  "src",
  "test",
  "fixtures",
  "recovery-crash-writer.mjs",
);
const MIGRATION_PATH = resolve(WORKSPACE_ROOT, "packages", "data", "migrations", "0001_core.sql");
const DRILL_DIRECTORY = resolve(WORKSPACE_ROOT, ".tmp", "persistence-drills");

describe("hard-kill recovery integration", () => {
  it("reopens the real SQLite file with stable text untouched and the committed recovery draft present", async () => {
    mkdirSync(DRILL_DIRECTORY, { recursive: true });
    const databasePath = resolve(DRILL_DIRECTORY, `hard-kill-${randomUUID()}.sqlite`);
    closeSync(openSync(databasePath, "wx"));
    const child = spawn(process.execPath, [WRITER_PATH, databasePath, MIGRATION_PATH], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stderr: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));

    try {
      await waitForMarker(child, "RECOVERY_DRAFT_COMMITTED", 10_000, stderr, databasePath);
      expect(child.kill("SIGKILL")).toBe(true);
      await waitForExit(child, 10_000);

      const database = new DatabaseSync(databasePath);
      try {
        const integrity = database.prepare("PRAGMA integrity_check").get() as {
          readonly integrity_check: string;
        };
        const chapter = database
          .prepare("SELECT content, revision FROM chapters LIMIT 1")
          .get() as {
          readonly content: string;
          readonly revision: number;
        };
        const draft = database
          .prepare("SELECT content, base_revision FROM recovery_drafts LIMIT 1")
          .get() as { readonly content: string; readonly base_revision: number };

        expect(integrity.integrity_check).toBe("ok");
        expect(chapter).toEqual({
          content: "stable-before-hard-kill",
          revision: 1,
        });
        expect(draft).toEqual({
          content: "recovery-survives-hard-kill",
          base_revision: 1,
        });
      } finally {
        database.close();
      }
      expect(stderr.join("")).toBe("");
    } finally {
      await terminateChildIfRunning(child);
    }
    // The database is intentionally retained under workspace .tmp/persistence-drills
    // as inspectable evidence; this test never deletes user or prior data.
  }, 30_000);
});

function findWorkspaceRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  for (;;) {
    if (
      existsSync(resolve(current, "pnpm-workspace.yaml")) &&
      existsSync(resolve(current, "apps", "desktop", "vite.config.ts"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate the InkShadow workspace from ${startDirectory}.`);
    }
    current = parent;
  }
}

async function waitForMarker(
  child: ReturnType<typeof spawn>,
  marker: string,
  timeoutMs: number,
  stderr: readonly string[],
  databasePath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let settled = false;
    const stdout = child.stdout;
    const timeout = setTimeout(() => {
      finish(new Error(`Crash writer did not emit ${marker} within ${String(timeoutMs)}ms.`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout?.off("data", handleData);
      child.off("error", handleError);
      child.off("exit", handleExit);
    };
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const handleData = (chunk: string): void => {
      output += chunk;
      if (output.includes(marker)) {
        finish();
      }
    };
    const handleError = (error: Error): void => {
      finish(error);
    };
    const handleExit = (code: number | null): void => {
      if (!output.includes(marker)) {
        const detail = stderr.join("").trim();
        finish(
          new Error(
            `Crash writer exited early with code ${String(code)} for ${databasePath} via ${process.execPath} from ${process.cwd()} (NODE_OPTIONS=${process.env.NODE_OPTIONS ?? "<unset>"}).${detail === "" ? "" : ` ${detail}`}`,
          ),
        );
      }
    };

    stdout?.setEncoding("utf8");
    stdout?.on("data", handleData);
    child.once("error", handleError);
    child.once("exit", handleExit);
  });
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Crash writer did not terminate within ${String(timeoutMs)}ms.`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
      child.off("error", handleError);
    };
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const handleExit = (): void => finish();
    const handleError = (error: Error): void => finish(error);

    child.once("exit", handleExit);
    child.once("error", handleError);
  });
}

async function terminateChildIfRunning(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  try {
    await waitForExit(child, 5_000);
  } catch {
    // The test retains the original failure. This cleanup is best-effort and
    // targets only the exact child handle created for this drill.
  }
}
