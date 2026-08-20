import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { expect, type CDPSession, type Page } from "@playwright/test";

const workspaceRoot = path.resolve(process.cwd());
const evidenceRoot = path.join(workspaceRoot, "test-results", "visual-evidence");
const imageRoot = path.join(evidenceRoot, "images");
const manifestPath = path.join(evidenceRoot, "manifest.json");

export const STATIC_CHROMIUM_DPI_LIMITATION =
  "静态 Chromium 只验证等效 CSS 视口；未测量 Windows 系统缩放，也不是 Tauri WebView 真实 200% DPI 证据。";

export interface VisualViewportProfile {
  readonly id: string;
  readonly kind: "css_viewport" | "equivalent_200_percent";
  readonly expectedCssViewport: Readonly<{ width: number; height: number }>;
  readonly emulatedPhysicalViewport: Readonly<{ width: number; height: number }> | null;
}

export interface VisualEvidenceCaptureInput {
  readonly name: string;
  readonly state: string;
  readonly surfaceSelector: string;
  readonly viewportProfile: VisualViewportProfile;
  readonly captureSession: CDPSession;
}

interface VisualEvidenceSource {
  readonly commit: string;
  readonly dirty: boolean;
}

interface VisualEvidenceEntry {
  readonly name: string;
  readonly state: string;
  readonly route: string;
  readonly source: VisualEvidenceSource;
  readonly dataSurface: Readonly<{
    selector: string;
    attributeValue: "light" | "dark";
    resolvedColorScheme: "light" | "dark";
  }>;
  readonly viewportProfile: VisualViewportProfile;
  readonly cssViewport: Readonly<{ width: number; height: number }>;
  readonly devicePixelRatio: number;
  readonly systemScale: Readonly<{
    status: "not_measured";
    value: null;
    limitation: string;
  }>;
  readonly runtime: Readonly<{
    browser: "chromium";
    shell: "static_web_distribution";
    tauriWebView: "not_run";
  }>;
  readonly capturedAt: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly imagePixels: Readonly<{ width: number; height: number }>;
  readonly screenshot: string;
}

interface VisualEvidenceManifest {
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly source: VisualEvidenceSource;
  readonly limitation: string;
  readonly entries: VisualEvidenceEntry[];
}

let manifest: VisualEvidenceManifest | null = null;

export async function startVisualEvidenceRun(): Promise<void> {
  await rm(evidenceRoot, { force: true, recursive: true });
  await mkdir(imageRoot, { recursive: true });
  const source = readSourceIdentity();
  manifest = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    source,
    limitation: STATIC_CHROMIUM_DPI_LIMITATION,
    entries: [],
  };
  await persistManifest(manifest);
}

export async function captureVisualEvidence(
  page: Page,
  input: VisualEvidenceCaptureInput,
): Promise<void> {
  if (manifest === null) {
    throw new Error("Visual evidence run was not initialized.");
  }
  if (manifest.entries.some(({ name }) => name === input.name)) {
    throw new Error(`Visual evidence name is duplicated: ${input.name}`);
  }

  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const surface = page.locator(input.surfaceSelector);
  await expect(surface).toHaveCount(1);
  const attributeValue = await surface.getAttribute("data-surface");
  if (attributeValue !== "light" && attributeValue !== "dark") {
    throw new Error(
      `${input.surfaceSelector} must expose an actual light/dark data-surface attribute.`,
    );
  }

  const browserProjection = await page.evaluate(() => ({
    cssViewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    resolvedColorScheme: matchMedia("(prefers-color-scheme: dark)").matches
      ? ("dark" as const)
      : ("light" as const),
  }));
  expect(browserProjection.cssViewport).toEqual(input.viewportProfile.expectedCssViewport);

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const captured = await input.captureSession.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(captured.data, "base64");
  const imagePixels = readPngDimensions(bytes);
  expect(imagePixels).toEqual({
    width: Math.round(browserProjection.cssViewport.width * browserProjection.devicePixelRatio),
    height: Math.round(browserProjection.cssViewport.height * browserProjection.devicePixelRatio),
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const screenshot = path.posix.join("images", `${sha256}.png`);
  await writeUniqueImage(path.join(imageRoot, `${sha256}.png`), bytes);

  const entry: VisualEvidenceEntry = {
    name: input.name,
    state: input.state,
    route: routeFromUrl(page.url()),
    source: manifest.source,
    dataSurface: {
      selector: input.surfaceSelector,
      attributeValue,
      resolvedColorScheme: browserProjection.resolvedColorScheme,
    },
    viewportProfile: input.viewportProfile,
    cssViewport: browserProjection.cssViewport,
    devicePixelRatio: browserProjection.devicePixelRatio,
    systemScale: {
      status: "not_measured",
      value: null,
      limitation: STATIC_CHROMIUM_DPI_LIMITATION,
    },
    runtime: {
      browser: "chromium",
      shell: "static_web_distribution",
      tauriWebView: "not_run",
    },
    capturedAt: new Date().toISOString(),
    sha256,
    byteLength: bytes.byteLength,
    imagePixels,
    screenshot,
  };
  manifest.entries.push(entry);
  await persistManifest(manifest);
}

function readSourceIdentity(): VisualEvidenceSource {
  return {
    commit: runGit(["rev-parse", "HEAD"]),
    dirty: runGit(["status", "--porcelain", "--untracked-files=no"]).length > 0,
  };
}

function runGit(arguments_: readonly string[]): string {
  return execFileSync("git", ["-c", `safe.directory=${workspaceRoot}`, ...arguments_], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function routeFromUrl(value: string): string {
  const url = new URL(value);
  const hashRoute = url.hash.replace(/^#/u, "");
  return hashRoute === "" ? url.pathname : hashRoute;
}

async function writeUniqueImage(filePath: string, bytes: Buffer): Promise<void> {
  try {
    await access(filePath);
  } catch {
    await writeFile(filePath, bytes, { flag: "wx" });
  }
}

async function persistManifest(value: VisualEvidenceManifest): Promise<void> {
  const uniqueImageCount = new Set(value.entries.map(({ sha256 }) => sha256)).size;
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...value,
        entryCount: value.entries.length,
        uniqueImageCount,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function readPngDimensions(bytes: Buffer): Readonly<{ width: number; height: number }> {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("Visual evidence capture did not return a PNG.");
  }
  return Object.freeze({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
}
