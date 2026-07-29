import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const allowedRuntimeLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 OR MIT",
  "BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MIT OR GPL-3.0-or-later",
  "MIT OR Apache-2.0",
]);

const workspaceRoot = process.cwd();
const workspacePackages = discoverWorkspacePackages();
const visitedWorkspacePackages = new Set();
const visited = new Map();
const resolutionFailures = [];

for (const workspacePackage of workspacePackages.values()) {
  inspectWorkspacePackage(workspacePackage);
}

if (resolutionFailures.length > 0) {
  process.stderr.write(
    `Runtime license inventory could not resolve installed dependencies:\n${resolutionFailures
      .map(({ dependency, from }) => `- ${dependency} (from ${from})`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  const denied = [...visited.values()]
    .filter(({ license }) => !allowedRuntimeLicenses.has(license))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (denied.length > 0) {
    process.stderr.write(
      `Runtime license policy failed:\n${denied
        .map(({ license, name, version }) => `- ${name}@${version}: ${license}`)
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    const distribution = summarizeLicenses(visited.values());
    process.stdout.write(
      `Runtime license policy passed for ${String(visited.size)} installed dependency entries (${distribution}).\n`,
    );
  }
}

function summarizeLicenses(entries) {
  const counts = new Map();
  for (const { license } of entries) {
    counts.set(license, (counts.get(license) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([license, count]) => `${license}: ${String(count)}`)
    .join(", ");
}

function discoverWorkspacePackages() {
  const manifests = new Map();
  for (const relativeRoot of [".", "apps", "packages"]) {
    const absoluteRoot = path.join(workspaceRoot, relativeRoot);
    const candidateDirectories =
      relativeRoot === "."
        ? [absoluteRoot]
        : readdirSync(absoluteRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(absoluteRoot, entry.name));
    for (const directory of candidateDirectories) {
      const manifestPath = path.join(directory, "package.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = readManifest(manifestPath);
      if (typeof manifest.name === "string") {
        manifests.set(manifest.name, { directory, manifest });
      }
    }
  }
  return manifests;
}

function inspectDependencyMap(fromDirectory, dependencies, options = {}) {
  if (dependencies === undefined) {
    return;
  }
  for (const dependency of Object.keys(dependencies)) {
    const workspacePackage = workspacePackages.get(dependency);
    if (workspacePackage !== undefined) {
      inspectWorkspacePackage(workspacePackage);
      continue;
    }

    const manifestPath = resolvePackageManifest(dependency, fromDirectory);
    if (manifestPath === null) {
      if (!options.optional) {
        resolutionFailures.push({
          dependency,
          from: path.relative(workspaceRoot, fromDirectory) || ".",
        });
      }
      continue;
    }
    inspectExternalManifest(manifestPath);
  }
}

function inspectWorkspacePackage(workspacePackage) {
  if (visitedWorkspacePackages.has(workspacePackage.directory)) {
    return;
  }
  visitedWorkspacePackages.add(workspacePackage.directory);
  inspectDependencyMap(workspacePackage.directory, workspacePackage.manifest.dependencies);
  inspectDependencyMap(workspacePackage.directory, workspacePackage.manifest.optionalDependencies, {
    optional: true,
  });
}

function inspectExternalManifest(manifestPath) {
  const canonicalPath = realpathSync(manifestPath);
  if (visited.has(canonicalPath)) {
    return;
  }
  const manifest = readManifest(canonicalPath);
  const license = normalizeLicense(manifest.license);
  visited.set(canonicalPath, {
    name: typeof manifest.name === "string" ? manifest.name : "(unnamed)",
    version: typeof manifest.version === "string" ? manifest.version : "(unknown)",
    license,
  });
  const directory = path.dirname(canonicalPath);
  inspectDependencyMap(directory, manifest.dependencies);
  inspectDependencyMap(directory, manifest.optionalDependencies, { optional: true });
}

function resolvePackageManifest(packageName, fromDirectory) {
  const requireFromPackage = createRequire(path.join(fromDirectory, "__license_check__.cjs"));
  try {
    return requireFromPackage.resolve(`${packageName}/package.json`);
  } catch {
    try {
      let current = path.dirname(requireFromPackage.resolve(packageName));
      while (current !== path.dirname(current)) {
        const candidate = path.join(current, "package.json");
        if (existsSync(candidate)) {
          const manifest = readManifest(candidate);
          if (manifest.name === packageName) {
            return candidate;
          }
        }
        current = path.dirname(current);
      }
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().replace(/^\((.*)\)$/u, "$1");
  }
  if (value !== null && typeof value === "object" && typeof value.type === "string") {
    return value.type.trim();
  }
  return "UNKNOWN";
}

function readManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}
