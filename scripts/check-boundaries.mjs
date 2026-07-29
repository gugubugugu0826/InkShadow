import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();

const allowedInternalImports = new Map([
  ["@inkshadow/access-core", new Set()],
  ["@inkshadow/contracts", new Set()],
  ["@inkshadow/domain", new Set()],
  [
    "@inkshadow/application",
    new Set([
      "@inkshadow/contracts",
      "@inkshadow/domain",
      "@inkshadow/search-core",
      "@inkshadow/story-core",
    ]),
  ],
  ["@inkshadow/config", new Set()],
  ["@inkshadow/observability", new Set()],
  ["@inkshadow/ai-core", new Set()],
  ["@inkshadow/cloud-client", new Set(["@inkshadow/contracts"])],
  ["@inkshadow/test-utils", new Set()],
  ["@inkshadow/ui", new Set()],
  [
    "@inkshadow/data",
    new Set([
      "@inkshadow/access-core",
      "@inkshadow/application",
      "@inkshadow/contracts",
      "@inkshadow/domain",
      "@inkshadow/search-core",
      "@inkshadow/sync-core",
      "@inkshadow/task-engine",
    ]),
  ],
  ["@inkshadow/platform", new Set(["@inkshadow/application", "@inkshadow/domain"])],
  ["@inkshadow/import-export", new Set(["@inkshadow/contracts", "@inkshadow/domain"])],
  ["@inkshadow/search-core", new Set()],
  ["@inkshadow/story-core", new Set()],
  ["@inkshadow/sync-core", new Set()],
  [
    "@inkshadow/task-engine",
    new Set(["@inkshadow/application", "@inkshadow/contracts", "@inkshadow/domain"]),
  ],
]);

const forbiddenExternalImports = new Map([
  ["@inkshadow/domain", ["react", "react-dom", "@tauri-apps/", "drizzle-orm", "zod", "@radix-ui/"]],
  ["@inkshadow/application", ["react", "react-dom", "@tauri-apps/", "drizzle-orm", "@radix-ui/"]],
]);

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"]);
const importPattern = /(?:from\s*|import\s*\(\s*|import\s+)(["'])([^"']+)\1/g;

const failures = [];
const packageDirectories = await discoverPackageDirectories();

for (const packageDirectory of packageDirectories) {
  const manifestPath = path.join(packageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packageName = manifest.name;
  if (typeof packageName !== "string") {
    failures.push(`${relative(manifestPath)}: package name is missing`);
    continue;
  }

  const declaredDependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const allowed = allowedInternalImports.get(packageName);
  const forbidden = forbiddenExternalImports.get(packageName) ?? [];
  const sourceDirectory = path.join(packageDirectory, "src");

  for (const sourceFile of await collectSourceFiles(sourceDirectory)) {
    const source = await readFile(sourceFile, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[2];
      if (specifier === undefined || specifier.startsWith(".")) {
        continue;
      }

      const internalPackage = resolveInternalPackage(specifier);
      if (internalPackage !== null && internalPackage !== packageName) {
        if (!declaredDependencies.has(internalPackage)) {
          failures.push(
            `${relative(sourceFile)}: imports ${internalPackage} without a runtime dependency`,
          );
        }
        if (allowed !== undefined && !allowed.has(internalPackage)) {
          failures.push(
            `${relative(sourceFile)}: ${packageName} may not depend on ${internalPackage}`,
          );
        }
      }

      const forbiddenPrefix = forbidden.find(
        (prefix) => specifier === prefix || specifier.startsWith(prefix),
      );
      if (forbiddenPrefix !== undefined) {
        failures.push(`${relative(sourceFile)}: ${packageName} may not import ${specifier}`);
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Architecture boundary check failed:\n${failures
      .map((failure) => `- ${failure}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Architecture boundary check passed for ${packageDirectories.length} packages.\n`,
  );
}

async function discoverPackageDirectories() {
  const roots = ["packages", "apps"];
  const directories = [];
  for (const root of roots) {
    const rootDirectory = path.join(workspaceRoot, root);
    const entries = await safeReadDirectory(rootDirectory);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const directory = path.join(rootDirectory, entry.name);
        try {
          await readFile(path.join(directory, "package.json"), "utf8");
          directories.push(directory);
        } catch {
          // A non-package workspace directory is outside this check.
        }
      }
    }
  }
  return directories.sort();
}

async function collectSourceFiles(directory) {
  const files = [];
  for (const entry of await safeReadDirectory(directory)) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(target)));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(target);
    }
  }
  return files;
}

async function safeReadDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function resolveInternalPackage(specifier) {
  if (!specifier.startsWith("@inkshadow/")) {
    return null;
  }
  const [scope, name] = specifier.split("/");
  return name === undefined ? null : `${scope}/${name}`;
}

function relative(filePath) {
  return path.relative(workspaceRoot, filePath).replaceAll("\\", "/");
}
