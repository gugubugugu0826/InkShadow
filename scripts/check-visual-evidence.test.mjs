import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { checkVisualEvidenceManifest } from "./check-visual-evidence.mjs";

const temporaryDirectories = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const sha256 = createHash("sha256").update(png).digest("hex");
const source = Object.freeze({ commit: "a".repeat(40), dirty: true });
const limitation =
  "静态 Chromium 只验证等效 CSS 视口；未测量 Windows 系统缩放，也不是 Tauri WebView 真实 200% DPI 证据。";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

test("accepts two records that share one content-addressed PNG", async () => {
  const manifestPath = await writeFixture([
    evidenceEntry("light-start", "light"),
    evidenceEntry("light-start-copy", "light"),
  ]);

  await assert.doesNotReject(checkVisualEvidenceManifest(manifestPath));
  assert.deepEqual(await checkVisualEvidenceManifest(manifestPath), {
    entryCount: 2,
    uniqueImageCount: 1,
    commit: source.commit,
    dirty: true,
  });
});

test("rejects a screenshot whose bytes no longer match its SHA-256", async () => {
  const manifestPath = await writeFixture([evidenceEntry("dark-editor", "dark")]);
  await writeFile(
    path.join(path.dirname(manifestPath), "images", `${sha256}.png`),
    png.subarray(0, 12),
  );

  await assert.rejects(checkVisualEvidenceManifest(manifestPath), /does not match the PNG/u);
});

test("rejects any static record that claims a Tauri run or measured system scale", async () => {
  const entry = evidenceEntry("dark-checks", "dark");
  const manifestPath = await writeFixture([
    {
      ...entry,
      systemScale: { ...entry.systemScale, status: "measured", value: 2 },
      runtime: { ...entry.runtime, tauriWebView: "run" },
    },
  ]);

  await assert.rejects(checkVisualEvidenceManifest(manifestPath), /must be unmeasured/u);
});

function evidenceEntry(name, surface) {
  return {
    name,
    state: "fixture state",
    route: "/start",
    source,
    dataSurface: {
      selector: "html",
      attributeValue: surface,
      resolvedColorScheme: surface,
    },
    viewportProfile: {
      id: "1x1",
      kind: "css_viewport",
      expectedCssViewport: { width: 1, height: 1 },
      emulatedPhysicalViewport: null,
    },
    cssViewport: { width: 1, height: 1 },
    devicePixelRatio: 1,
    systemScale: { status: "not_measured", value: null, limitation },
    runtime: {
      browser: "chromium",
      shell: "static_web_distribution",
      tauriWebView: "not_run",
    },
    capturedAt: "2026-08-19T00:00:00.000Z",
    sha256,
    byteLength: png.byteLength,
    imagePixels: { width: 1, height: 1 },
    screenshot: `images/${sha256}.png`,
  };
}

async function writeFixture(entries) {
  const directory = await mkdtemp(path.join(tmpdir(), "inkshadow-visual-evidence-"));
  temporaryDirectories.push(directory);
  const imageRoot = path.join(directory, "images");
  await mkdir(imageRoot);
  await writeFile(path.join(imageRoot, `${sha256}.png`), png);
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        startedAt: "2026-08-19T00:00:00.000Z",
        source,
        limitation,
        entries,
        entryCount: entries.length,
        uniqueImageCount: 1,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return manifestPath;
}
