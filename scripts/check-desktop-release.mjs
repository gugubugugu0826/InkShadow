import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  DESKTOP_RELEASE_MANIFEST_NAME,
  createDesktopReleaseArtifactFingerprint,
  createDesktopReleaseEnvironmentFingerprint,
  createDesktopReleaseManifest,
  createDesktopReleaseSourceFingerprint,
} from "./desktop-release-manifest.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopRoot = path.join(workspaceRoot, "apps", "desktop");
const tauriRoot = path.join(desktopRoot, "src-tauri");

const budgets = Object.freeze({
  entryChunk: 300 * 1024,
  asyncChunk: 500 * 1024,
  cssAsset: 128 * 1024,
  workerAsset: 1_536 * 1024,
  generalAsset: 2 * 1024 * 1024,
  totalFrontend: 6 * 1024 * 1024,
  maximumFiles: 200,
});

const expectedProductionCsp = Object.freeze({
  "default-src": ["'self'"],
  "base-uri": ["'none'"],
  "connect-src": ["'self'", "ipc:", "http://ipc.localhost"],
  "font-src": ["'self'", "data:"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
  "frame-src": ["'none'"],
  "img-src": ["'self'", "asset:", "data:", "blob:"],
  "media-src": ["'none'"],
  "object-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "worker-src": ["'self'", "blob:"],
});

const expectedDevCsp = Object.freeze({
  ...expectedProductionCsp,
  "connect-src": [
    "'self'",
    "ipc:",
    "http://ipc.localhost",
    "http://127.0.0.1:1420",
    "ws://127.0.0.1:1420",
  ],
});

const allowedArtifactExtensions = new Set([
  ".avif",
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".mjs",
  ".png",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
]);

const failures = [];
const options = parseArguments(process.argv.slice(2));

await checkConfiguration();
if (!options.configOnly) {
  if (options.dist === null) {
    fail("A release artifact directory is required unless --config-only is used.");
  } else {
    await checkArtifact(options.dist);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Desktop release gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  const artifactMessage =
    options.configOnly || options.dist === null ? "" : ` and ${relative(options.dist)}`;
  process.stdout.write(
    `Desktop release gate passed for production configuration${artifactMessage}.\n`,
  );
}

function parseArguments(arguments_) {
  let configOnly = false;
  let dist = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--config-only") {
      configOnly = true;
      continue;
    }
    if (argument === "--dist") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail("--dist requires a workspace-relative directory.");
      } else {
        dist = path.resolve(workspaceRoot, value);
        index += 1;
      }
      continue;
    }
    fail(`Unknown release-gate argument: ${argument ?? ""}`);
  }
  if (configOnly && dist !== null) {
    fail("--config-only and --dist cannot be used together.");
  }
  return { configOnly, dist };
}

async function checkConfiguration() {
  const [base, development, release, desktopManifest, rootManifest, capability, viteSource, ci] =
    await Promise.all([
      readJson(path.join(tauriRoot, "tauri.conf.json")),
      readJson(path.join(tauriRoot, "tauri.dev.conf.json")),
      readJson(path.join(tauriRoot, "tauri.release-gate.conf.json")),
      readJson(path.join(desktopRoot, "package.json")),
      readJson(path.join(workspaceRoot, "package.json")),
      readJson(path.join(tauriRoot, "capabilities", "default.json")),
      readUtf8(path.join(desktopRoot, "vite.config.ts")),
      readUtf8(path.join(workspaceRoot, ".github", "workflows", "ci.yml")),
    ]);

  const production = deepMerge(base, release);
  const dev = deepMerge(base, development);

  expectEqual(base?.build?.beforeBuildCommand, "pnpm build:web", "base beforeBuildCommand");
  expectEqual(base?.build?.frontendDist, "../dist", "base frontendDist");
  expectAbsent(base?.build, "beforeDevCommand", "base build");
  expectAbsent(base?.build, "devUrl", "base build");

  expectEqual(
    development?.build?.beforeDevCommand,
    "pnpm dev:vite",
    "development beforeDevCommand",
  );
  expectEqual(development?.build?.devUrl, "http://127.0.0.1:1420", "development devUrl");
  expectAbsent(development?.build, "beforeBuildCommand", "development build override");
  expectAbsent(development?.build, "frontendDist", "development build override");

  expectEqual(production?.build?.frontendDist, "../dist-release", "release frontendDist");
  expectEqual(
    production?.build?.beforeBuildCommand,
    "node ../../scripts/check-desktop-release.mjs --dist apps/desktop/dist-release",
    "release beforeBuildCommand",
  );
  expectAbsent(release?.build, "beforeDevCommand", "release build override");
  expectAbsent(release?.build, "devUrl", "release build override");

  checkCsp(base?.app?.security?.csp, expectedProductionCsp, "base production CSP");
  checkCsp(production?.app?.security?.csp, expectedProductionCsp, "release CSP");
  checkCsp(dev?.app?.security?.csp, expectedDevCsp, "development CSP");

  expectEqual(base?.bundle?.active, true, "bundle.active");
  expectJsonEqual(base?.bundle?.targets, ["nsis"], "bundle.targets");
  expectEqual(base?.bundle?.windows?.nsis?.installMode, "currentUser", "NSIS install mode");
  expectEqual(base?.identifier, "com.inkshadow.desktop", "desktop identifier");
  expectEqual(base?.version, desktopManifest?.version, "Tauri/package version");
  expectEqual(base?.version, rootManifest?.version, "Tauri/workspace version");
  if (typeof base?.productName !== "string" || base.productName.trim().length === 0) {
    fail("productName must be a non-empty string.");
  }
  for (const descriptionKey of ["shortDescription", "longDescription"]) {
    if (
      typeof base?.bundle?.[descriptionKey] !== "string" ||
      base.bundle[descriptionKey].trim().length === 0
    ) {
      fail(`bundle.${descriptionKey} must be a non-empty string.`);
    }
  }

  const cargoSource = await readUtf8(path.join(tauriRoot, "Cargo.toml"));
  const cargoVersion = /^\s*version\s*=\s*"([^"]+)"\s*$/mu.exec(cargoSource)?.[1];
  expectEqual(base?.version, cargoVersion, "Tauri/Cargo version");

  expectJsonEqual(capability?.windows, ["main"], "native capability windows");
  expectJsonEqual(
    [...(capability?.permissions ?? [])].sort(),
    ["core:default", "core:window:allow-destroy", "log:default"].sort(),
    "native capability allowlist",
  );

  if (!/envPrefix:\s*\[\s*"VITE_INKSHADOW_"\s*\]/u.test(viteSource)) {
    fail("Vite envPrefix must expose only VITE_INKSHADOW_ product variables.");
  }
  if (/envPrefix[\s\S]{0,160}["']TAURI_/u.test(viteSource)) {
    fail("Vite must not expose TAURI_ build or signing variables to the WebView.");
  }
  if (!/sourcemap:\s*false/u.test(viteSource)) {
    fail("Vite production source maps must remain disabled.");
  }
  if (!/target:\s*"es2022"/u.test(viteSource)) {
    fail("The audited desktop browser target must remain explicit.");
  }

  expectEqual(
    desktopManifest?.scripts?.["tauri:dev"],
    "tauri dev --config src-tauri/tauri.dev.conf.json",
    "desktop tauri:dev script",
  );
  expectEqual(
    desktopManifest?.scripts?.["build:workspace-dependencies"],
    'pnpm --filter "@inkshadow/desktop..." --filter "!@inkshadow/desktop" --if-present build',
    "desktop workspace dependency build script",
  );
  expectEqual(
    desktopManifest?.scripts?.["build:web:release"],
    "pnpm build:workspace-dependencies && node ../../scripts/capture-desktop-release-source.mjs --output apps/desktop/.tmp/release-source-baseline.json && tsc --noEmit -p tsconfig.json && vite build --configLoader runner --outDir dist-release --emptyOutDir && node ../../scripts/write-desktop-release-manifest.mjs --dist apps/desktop/dist-release --source-baseline apps/desktop/.tmp/release-source-baseline.json",
    "desktop release web build script",
  );
  expectEqual(
    desktopManifest?.scripts?.["tauri:build"],
    "pnpm build:web:release && tauri build --config src-tauri/tauri.release-gate.conf.json --ci",
    "desktop tauri:build script",
  );
  expectEqual(
    desktopManifest?.scripts?.["tauri:build:unsigned"],
    "pnpm build:web:release && tauri build --config src-tauri/tauri.release-gate.conf.json --ci --no-sign",
    "desktop tauri:build:unsigned script",
  );
  if (rootManifest?.scripts?.["build:desktop:unsigned"] === undefined) {
    fail("The workspace must expose an explicit unsigned desktop build script.");
  }
  if (rootManifest?.scripts?.["release:candidate:unsigned"] === undefined) {
    fail("The workspace must expose a complete unsigned release-candidate gate.");
  }
  if (!/run:\s+pnpm test:e2e:release/u.test(ci)) {
    fail("CI native packaging must exercise the exact release frontend before packaging.");
  }
  if (!/run:\s+pnpm --filter @inkshadow\/desktop tauri:package:unsigned:prebuilt/u.test(ci)) {
    fail("CI native packaging must package the already exercised release frontend.");
  }
}

function checkCsp(value, expected, label) {
  if (typeof value !== "string") {
    fail(`${label} must be a string.`);
    return;
  }
  const directives = new Map();
  for (const rawDirective of value.split(";")) {
    const parts = rawDirective.trim().split(/\s+/u).filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    const [name, ...sources] = parts;
    if (directives.has(name)) {
      fail(`${label} contains duplicate ${name}.`);
      continue;
    }
    directives.set(name, sources);
  }
  expectJsonEqual(Object.fromEntries(directives), expected, `${label} directives`);
  const lower = value.toLowerCase();
  for (const forbidden of [
    "'unsafe-eval'",
    "https:",
    "wss:",
    "http://localhost",
    "ws://localhost",
    "http://0.0.0.0",
    "ws://0.0.0.0",
    "*",
  ]) {
    if (lower.includes(forbidden)) {
      fail(`${label} contains forbidden source ${forbidden}.`);
    }
  }
  if (
    label !== "development CSP" &&
    (lower.includes("127.0.0.1") || lower.includes("ws://") || lower.includes("http://127."))
  ) {
    fail(`${label} must not contain development-server origins.`);
  }
}

async function checkArtifact(distDirectory) {
  const normalizedDist = path.resolve(distDirectory);
  const relativeDist = path.relative(workspaceRoot, normalizedDist);
  if (
    relativeDist.startsWith("..") ||
    path.isAbsolute(relativeDist) ||
    normalizedDist === workspaceRoot
  ) {
    fail("The release artifact directory must remain inside the workspace.");
    return;
  }
  const files = await collectArtifactFiles(normalizedDist);
  if (files.length === 0) {
    fail(`${relative(normalizedDist)} is empty or missing.`);
    return;
  }
  if (files.length > budgets.maximumFiles) {
    fail(
      `${relative(normalizedDist)} contains ${String(files.length)} files; maximum is ${String(budgets.maximumFiles)}.`,
    );
  }

  let totalBytes = 0;
  let safeToFingerprint = files.length <= budgets.maximumFiles;
  const fileSet = new Set();
  for (const file of files) {
    const relativeFile = normalizeSlash(path.relative(normalizedDist, file.path));
    fileSet.add(relativeFile);
    totalBytes += file.bytes;
    const extension = path.extname(file.path).toLowerCase();
    if (!allowedArtifactExtensions.has(extension)) {
      fail(`${relative(file.path)} has a non-runtime release extension.`);
    }
    if (extension === ".map" || relativeFile.endsWith(".map")) {
      fail(`${relative(file.path)} is a forbidden source map.`);
    }
    if (relativeFile.startsWith("assets/") && !/-[A-Za-z0-9_-]{8,}\.[^.]+$/u.test(relativeFile)) {
      fail(`${relative(file.path)} is not content-hashed.`);
    }
    const maximum =
      extension === ".css"
        ? budgets.cssAsset
        : relativeFile.includes(".worker.")
          ? budgets.workerAsset
          : extension === ".js" || extension === ".mjs"
            ? budgets.asyncChunk
            : budgets.generalAsset;
    if (file.bytes > maximum) {
      fail(`${relative(file.path)} is ${String(file.bytes)} bytes; maximum is ${String(maximum)}.`);
      safeToFingerprint = false;
    }
  }
  if (totalBytes > budgets.totalFrontend) {
    fail(
      `${relative(normalizedDist)} totals ${String(totalBytes)} bytes; maximum is ${String(budgets.totalFrontend)}.`,
    );
    safeToFingerprint = false;
  }
  if (safeToFingerprint) {
    await checkReleaseManifest(normalizedDist);
  }

  if (!fileSet.has("index.html")) {
    fail(`${relative(path.join(normalizedDist, "index.html"))} is missing.`);
    return;
  }
  const indexPath = path.join(normalizedDist, "index.html");
  const index = await readUtf8(indexPath);
  checkIndexHtml(index, normalizedDist, fileSet);

  const entryPaths = extractHtmlReferences(index, "script")
    .map((reference) => resolveArtifactReference(reference, normalizedDist))
    .filter((reference) => reference !== null);
  for (const entryPath of entryPaths) {
    const entry = files.find(({ path: filePath }) => filePath === entryPath);
    if (entry !== undefined && entry.bytes > budgets.entryChunk) {
      fail(
        `${relative(entry.path)} is ${String(entry.bytes)} bytes; entry maximum is ${String(budgets.entryChunk)}.`,
      );
    }
  }

  for (const file of files) {
    const extension = path.extname(file.path).toLowerCase();
    if (![".html", ".css", ".js", ".mjs", ".svg"].includes(extension)) {
      continue;
    }
    const source = await readUtf8(file.path);
    for (const marker of ["@vite/client", "vite/hmr", "__vite__hot", "sourceMappingURL="]) {
      if (source.includes(marker)) {
        fail(`${relative(file.path)} contains development or source-map marker ${marker}.`);
      }
    }
    for (const marker of [
      "INKSHADOW_QA_WEBVIEW_STRESS",
      "__QA_WEBVIEW_STRESS_PASS__",
      "QA_PARTIAL_COMPOSITION_PERSISTED",
    ]) {
      if (source.includes(marker)) {
        fail(`${relative(file.path)} contains excluded QA-only runtime marker ${marker}.`);
      }
    }
    if (extension === ".css") {
      for (const reference of extractCssReferences(source)) {
        checkLocalArtifactReference(reference, file.path, normalizedDist, fileSet);
      }
    }
    if (extension === ".js" || extension === ".mjs") {
      const runtimeReferences = new Set([
        ...extractModuleReferences(source),
        ...extractBundledAssetReferences(source),
      ]);
      for (const reference of runtimeReferences) {
        checkLocalArtifactReference(reference, file.path, normalizedDist, fileSet);
      }
    }
  }
}

async function checkReleaseManifest(distDirectory) {
  const manifestPath = path.join(distDirectory, DESKTOP_RELEASE_MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(
      `${relative(manifestPath)} is missing or invalid; rebuild the release frontend (${safeError(
        error,
      )}).`,
    );
    return;
  }
  try {
    const [sourceFingerprint, artifactFingerprint] = await Promise.all([
      createDesktopReleaseSourceFingerprint(workspaceRoot),
      createDesktopReleaseArtifactFingerprint(distDirectory),
    ]);
    expectJsonEqual(
      manifest,
      createDesktopReleaseManifest(
        sourceFingerprint,
        createDesktopReleaseEnvironmentFingerprint(),
        artifactFingerprint,
      ),
      "release source/artifact manifest",
    );
  } catch (error) {
    fail(`Could not verify the release source/artifact manifest: ${safeError(error)}.`);
  }
}

function checkIndexHtml(source, distDirectory, fileSet) {
  if (!/<!doctype html>/iu.test(source)) {
    fail("Release index.html must declare an HTML doctype.");
  }
  for (const forbidden of [
    /<base\b/iu,
    /<iframe\b/iu,
    /<object\b/iu,
    /<embed\b/iu,
    /\son[a-z]+\s*=/iu,
    /(?:https?|wss?):\/\//iu,
  ]) {
    if (forbidden.test(source)) {
      fail(`Release index.html violates offline markup policy (${String(forbidden)}).`);
    }
  }
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    const attributes = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    if (!/\bsrc\s*=/iu.test(attributes) || body.length > 0) {
      fail("Release index.html must use external local scripts only.");
    }
    if (!/\btype\s*=\s*["']module["']/iu.test(attributes)) {
      fail("Release index.html scripts must be ES modules.");
    }
  }
  for (const reference of extractHtmlReferences(source)) {
    checkLocalArtifactReference(
      reference,
      path.join(distDirectory, "index.html"),
      distDirectory,
      fileSet,
    );
  }
}

function extractHtmlReferences(source, element = null) {
  const references = [];
  const pattern =
    element === "script"
      ? /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu
      : /<(?:script|link|img)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/giu;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) {
      references.push(match[1]);
    }
  }
  return references;
}

function extractCssReferences(source) {
  const references = [];
  for (const match of source.matchAll(/url\(\s*(?:["']([^"']+)["']|([^)"'\s]+))\s*\)/giu)) {
    const reference = match[1] ?? match[2];
    if (reference !== undefined && !reference.startsWith("data:")) {
      references.push(reference);
    }
  }
  return references;
}

function extractModuleReferences(source) {
  const references = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipJavaScriptQuotedValue(source, index, character);
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === "/" && canStartJavaScriptRegularExpression(source, index)) {
      const end = skipJavaScriptRegularExpression(source, index);
      if (end !== null) {
        index = end;
        continue;
      }
    }
    if (
      source.startsWith("import", index) &&
      !isIdentifierCharacter(source[index - 1]) &&
      !isIdentifierCharacter(source[index + 6])
    ) {
      const imported = readImportReference(source, index + 6);
      if (imported !== null) {
        references.push(imported.reference);
        index = imported.end;
        continue;
      }
    }
    index += 1;
  }
  return references;
}

function extractBundledAssetReferences(source) {
  const references = [];
  const pattern =
    /(["'`])((?:\/|\.{1,2}\/)?assets\/[A-Za-z0-9_./-]+\.(?:avif|css|gif|html|ico|jpe?g|js|mjs|png|svg|webp|woff2?)(?:[?#][^"'`]*)?)\1/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[2] !== undefined) {
      references.push(match[2].startsWith("assets/") ? `/${match[2]}` : match[2]);
    }
  }
  return references;
}

function readImportReference(source, start) {
  let index = skipWhitespace(source, start);
  if (source[index] === "(") {
    index = skipWhitespace(source, index + 1);
    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    const value = readJavaScriptString(source, index, quote);
    return value === null ? null : { reference: value.value, end: value.end };
  }
  const directQuote = source[index];
  if (directQuote === '"' || directQuote === "'") {
    const value = readJavaScriptString(source, index, directQuote);
    return value === null || !hasValidSideEffectImportSuffix(source, value.end)
      ? null
      : { reference: value.value, end: value.end };
  }
  const declarationEnd = source.indexOf(";", index);
  const searchEnd =
    declarationEnd < 0
      ? Math.min(source.length, index + 2_000)
      : Math.min(declarationEnd, index + 2_000);
  const declaration = source.slice(index, searchEnd);
  const from = /\bfrom\s*(["'])/gu.exec(declaration);
  if (from === null || from.index === undefined || from[1] === undefined) {
    return null;
  }
  const quoteIndex = index + from.index + from[0].length - 1;
  const value = readJavaScriptString(source, quoteIndex, from[1]);
  return value === null ? null : { reference: value.value, end: value.end };
}

function readJavaScriptString(source, start, quote) {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) {
        return null;
      }
      value += escaped;
      index += 1;
      continue;
    }
    if (character === quote) {
      return { value, end: index + 1 };
    }
    if (character === "\n" || character === "\r") {
      return null;
    }
    value += character;
  }
  return null;
}

function hasValidSideEffectImportSuffix(source, start) {
  const trivia = skipJavaScriptTrivia(source, start);
  if (
    trivia === null ||
    trivia.sawLineBreak ||
    trivia.end >= source.length ||
    source[trivia.end] === ";"
  ) {
    return trivia !== null;
  }
  return ["assert", "with"].some(
    (keyword) =>
      source.startsWith(keyword, trivia.end) &&
      !isIdentifierCharacter(source[trivia.end + keyword.length]),
  );
}

function skipJavaScriptTrivia(source, start) {
  let index = start;
  let sawLineBreak = false;
  while (index < source.length) {
    if (/\s/u.test(source[index] ?? "")) {
      sawLineBreak ||= isJavaScriptLineBreak(source[index]);
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      let lineEnd = index + 2;
      while (lineEnd < source.length && !isJavaScriptLineBreak(source[lineEnd])) {
        lineEnd += 1;
      }
      if (lineEnd >= source.length) {
        return { end: source.length, sawLineBreak };
      }
      sawLineBreak = true;
      index = lineEnd + 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      if (commentEnd < 0) {
        return null;
      }
      const comment = source.slice(index + 2, commentEnd);
      sawLineBreak ||= /[\n\r\u2028\u2029]/u.test(comment);
      index = commentEnd + 2;
      continue;
    }
    break;
  }
  return { end: index, sawLineBreak };
}

function isJavaScriptLineBreak(character) {
  return (
    character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029"
  );
}

function skipJavaScriptQuotedValue(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) {
      return index + 1;
    }
  }
  return source.length;
}

function canStartJavaScriptRegularExpression(source, start) {
  let index = start - 1;
  while (index >= 0 && /\s/u.test(source[index] ?? "")) {
    index -= 1;
  }
  if (index < 0) {
    return true;
  }
  const previous = source[index];
  if (previous !== undefined && "([{:;,=!?&|%^~<>".includes(previous)) {
    return true;
  }
  if ((previous === "+" || previous === "-") && source[index - 1] !== previous) {
    return true;
  }
  if (!isIdentifierCharacter(previous)) {
    return false;
  }
  let identifierStart = index;
  while (identifierStart > 0 && isIdentifierCharacter(source[identifierStart - 1])) {
    identifierStart -= 1;
  }
  return new Set([
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ]).has(source.slice(identifierStart, index + 1));
}

function skipJavaScriptRegularExpression(source, start) {
  let inCharacterClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\r") {
      return null;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]") {
      inCharacterClass = false;
      continue;
    }
    if (character === "/" && !inCharacterClass) {
      let end = index + 1;
      while (/[A-Za-z]/u.test(source[end] ?? "")) {
        end += 1;
      }
      return end;
    }
  }
  return null;
}

function skipWhitespace(source, start) {
  let index = start;
  while (index < source.length && /\s/u.test(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

function isIdentifierCharacter(character) {
  return character !== undefined && /[A-Za-z0-9_$]/u.test(character);
}

function checkLocalArtifactReference(reference, fromFile, distDirectory, fileSet) {
  if (reference.startsWith("data:") || reference.startsWith("blob:") || reference.startsWith("#")) {
    return;
  }
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(reference) || /^[a-z][a-z0-9+.-]*:/iu.test(reference)) {
    fail(`${relative(fromFile)} contains external runtime reference ${reference}.`);
    return;
  }
  const resolved = resolveArtifactReference(reference, distDirectory, fromFile);
  if (resolved === null) {
    fail(`${relative(fromFile)} contains unsafe runtime reference ${reference}.`);
    return;
  }
  const relativeResolved = normalizeSlash(path.relative(distDirectory, resolved));
  if (!fileSet.has(relativeResolved)) {
    fail(`${relative(fromFile)} references missing local asset ${relativeResolved}.`);
  }
}

function resolveArtifactReference(reference, distDirectory, fromFile = null) {
  let decoded;
  try {
    decoded = decodeURIComponent(reference.split(/[?#]/u, 1)[0] ?? "");
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.includes("\0")) {
    return null;
  }
  const candidate = decoded.startsWith("/")
    ? path.resolve(distDirectory, `.${decoded}`)
    : path.resolve(path.dirname(fromFile ?? path.join(distDirectory, "index.html")), decoded);
  const relativeCandidate = path.relative(distDirectory, candidate);
  if (
    relativeCandidate.startsWith("..") ||
    path.isAbsolute(relativeCandidate) ||
    candidate === distDirectory
  ) {
    return null;
  }
  return candidate;
}

async function collectArtifactFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return files;
    }
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      fail(`${relative(target)} is a symbolic link; release artifacts must be self-contained.`);
      continue;
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectArtifactFiles(target)));
      continue;
    }
    if (!metadata.isFile()) {
      fail(`${relative(target)} is not a regular release file.`);
      continue;
    }
    files.push({ path: target, bytes: metadata.size });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readUtf8(filePath));
  } catch (error) {
    fail(`${relative(filePath)} is not valid JSON: ${safeError(error)}`);
    return {};
  }
}

async function readUtf8(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    fail(`Could not read ${relative(filePath)}: ${safeError(error)}`);
    return "";
  }
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] =
      isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return merged;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectAbsent(value, key, label) {
  if (isPlainObject(value) && Object.hasOwn(value, key)) {
    fail(`${label} must not declare ${key}.`);
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} must be ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`);
  }
}

function expectJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} does not match the audited release policy.`);
  }
}

function fail(message) {
  failures.push(message);
}

function relative(filePath) {
  return normalizeSlash(path.relative(workspaceRoot, filePath));
}

function normalizeSlash(value) {
  return value.replaceAll("\\", "/");
}

function safeError(error) {
  return error instanceof Error ? error.message : "unknown error";
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
