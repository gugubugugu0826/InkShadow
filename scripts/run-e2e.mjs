import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(workspaceRoot, "scripts", "serve-e2e.mjs");
const playwrightCli = path.join(workspaceRoot, "node_modules", "@playwright", "test", "cli.js");
const baseUrl = "http://127.0.0.1:1420";
const readinessRequestTimeoutMs = 750;
const { distribution, playwrightArguments } = parseArguments(process.argv.slice(2));
const runToken = randomUUID();
const childEnvironment = {
  ...process.env,
  INKSHADOW_E2E_RUN_TOKEN: runToken,
  ...(distribution === null ? {} : { INKSHADOW_E2E_DIST: distribution }),
};

const server = spawn(process.execPath, [serverEntry], {
  cwd: workspaceRoot,
  env: childEnvironment,
  stdio: "inherit",
  windowsHide: true,
});

let testRunner = null;
let stopping = false;

async function stopChildren() {
  if (stopping) {
    return;
  }
  stopping = true;
  testRunner?.kill();
  if (server.exitCode === null && server.signalCode === null) {
    server.kill();
  }
  await Promise.race([waitForExit(server), delay(2_000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stopChildren().finally(() => process.exit(1));
  });
}

try {
  await waitForServer(baseUrl, runToken, 15_000);
  testRunner = spawn(process.execPath, [playwrightCli, "test", ...playwrightArguments], {
    cwd: workspaceRoot,
    env: childEnvironment,
    stdio: "inherit",
    windowsHide: true,
  });
  const result = await waitForExit(testRunner);
  process.exitCode = result.code ?? 1;
} finally {
  await stopChildren();
}

function parseArguments(arguments_) {
  let distribution = null;
  const playwrightArguments = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--dist") {
      playwrightArguments.push(argument);
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--dist requires a workspace-relative release distribution.");
    }
    if (distribution !== null) {
      throw new Error("--dist may only be specified once.");
    }
    distribution = value;
    index += 1;
  }
  return { distribution, playwrightArguments };
}

async function waitForServer(url, expectedRunToken, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error("The E2E static server exited before becoming ready.");
    }
    try {
      const remainingMs = deadline - Date.now();
      const response = await globalThis.fetch(url, {
        method: "HEAD",
        signal: globalThis.AbortSignal.timeout(
          Math.max(1, Math.min(readinessRequestTimeoutMs, remainingMs)),
        ),
      });
      if (response.ok && response.headers.get("x-inkshadow-e2e-run") === expectedRunToken) {
        return;
      }
    } catch {
      // The server may still be binding the loopback port.
    }
    await delay(100);
  }
  throw new Error("The E2E static server did not become ready in time.");
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
