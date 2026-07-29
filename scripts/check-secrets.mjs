import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const scanRoots = [
  ".github",
  "apps",
  "docs",
  "packages",
  "scripts",
  ".env.example",
  "package.json",
  "pnpm-workspace.yaml",
];
const excludedSegments = new Set([".git", "coverage", "dist", "gen", "node_modules", "target"]);
const textExtensions = new Set([
  "",
  ".css",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".rs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const detectors = [
  {
    label: "AWS access key identifier",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    label: "private key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    label: "credential embedded in URL",
    pattern: /\b(?:https?|postgres(?:ql)?|mysql|redis):\/\/[^/\s:@]+:[^@\s/]+@[^/\s?#]+/gi,
    validate: (match) => {
      const value = (match[0] ?? "").toLowerCase();
      return !value.includes("@example.com") && !value.includes(".example");
    },
  },
  {
    label: "bearer credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
    validate: (match) => !isAllowedExample(match[0] ?? ""),
  },
  {
    label: "assigned secret-like value",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\b\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi,
    validate: (match) => !isAllowedExample(match[1] ?? ""),
  },
];

const findings = [];
for (const scanRoot of scanRoots) {
  const target = path.join(workspaceRoot, scanRoot);
  for (const file of await collectFiles(target)) {
    const source = await readFile(file, "utf8");
    for (const detector of detectors) {
      detector.pattern.lastIndex = 0;
      for (const match of source.matchAll(detector.pattern)) {
        if (detector.validate !== undefined && !detector.validate(match)) {
          continue;
        }
        findings.push({
          file: relative(file),
          line: lineNumber(source, match.index ?? 0),
          label: detector.label,
        });
      }
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Potential credentials found (values intentionally hidden):\n${findings
      .map(({ file, label, line }) => `- ${file}:${String(line)} — ${label}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Secret scan passed; no credential patterns found.\n");
}

async function collectFiles(target) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOTDIR") {
      return shouldScan(target) ? [target] : [];
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (excludedSegments.has(entry.name)) {
      continue;
    }
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(child)));
    } else if (shouldScan(child)) {
      files.push(child);
    }
  }
  return files;
}

function shouldScan(file) {
  return (
    path.basename(file) === ".env.example" || textExtensions.has(path.extname(file).toLowerCase())
  );
}

function isAllowedExample(value) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes("example") ||
    normalized.includes("placeholder") ||
    normalized.includes("redacted") ||
    normalized.includes("dummy") ||
    normalized.includes("not-a-real") ||
    normalized.includes("not-allowed") ||
    normalized.includes("must-not") ||
    normalized.includes("must never") ||
    normalized === "credential" ||
    normalized.startsWith("test-") ||
    normalized.startsWith("<") ||
    normalized.startsWith("${")
  );
}

function lineNumber(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

function relative(file) {
  return path.relative(workspaceRoot, file).replaceAll("\\", "/");
}
