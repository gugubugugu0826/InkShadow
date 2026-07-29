import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredDistributionRoot = process.env.INKSHADOW_E2E_DIST?.trim();
const runToken = process.env.INKSHADOW_E2E_RUN_TOKEN?.trim();
const distributionRoot =
  configuredDistributionRoot === undefined || configuredDistributionRoot === ""
    ? path.join(workspaceRoot, "apps", "desktop", "dist")
    : path.resolve(workspaceRoot, configuredDistributionRoot);
const host = "127.0.0.1";
const port = 1420;

if (runToken === undefined || !/^[0-9a-f-]{36}$/u.test(runToken)) {
  throw new Error("The E2E server requires a per-run readiness token.");
}
if (
  distributionRoot !== workspaceRoot &&
  !distributionRoot.startsWith(`${workspaceRoot}${path.sep}`)
) {
  throw new Error("The E2E distribution must stay inside the workspace.");
}
if (!existsSync(path.join(distributionRoot, "index.html"))) {
  throw new Error("Desktop web distribution is missing. Run the web build before E2E tests.");
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", `http://${host}`).pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }

  const requestedPath = path.resolve(distributionRoot, `.${pathname}`);
  const safePath =
    requestedPath === distributionRoot ||
    requestedPath.startsWith(`${distributionRoot}${path.sep}`);
  if (!safePath) {
    response.writeHead(403);
    response.end();
    return;
  }

  const filePath =
    existsSync(requestedPath) && statSync(requestedPath).isFile()
      ? requestedPath
      : path.join(distributionRoot, "index.html");
  const contentType =
    contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-InkShadow-E2E-Run": runToken,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
});

let stopping = false;
function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  server.closeAllConnections();
  server.close(() => process.exit(0));
  const forcedExit = setTimeout(() => process.exit(0), 1_000);
  forcedExit.unref();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
server.once("error", (error) => {
  process.stderr.write(`The E2E static server could not start: ${error.message}\n`);
  process.exit(1);
});
server.listen(port, host);
