import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifest = path.join(
  workspaceRoot,
  "test-results",
  "visual-evidence",
  "manifest.json",
);
const expectedLimitation =
  "静态 Chromium 只验证等效 CSS 视口；未测量 Windows 系统缩放，也不是 Tauri WebView 真实 200% DPI 证据。";

export async function checkVisualEvidenceManifest(manifestFile = defaultManifest) {
  const resolvedManifest = path.resolve(workspaceRoot, manifestFile);
  const evidenceRoot = path.dirname(resolvedManifest);
  const manifest = JSON.parse(await readFile(resolvedManifest, "utf8"));
  assertRecord(manifest, "manifest");
  assert(manifest.schemaVersion === 1, "schemaVersion must be 1");
  assertIsoTimestamp(manifest.startedAt, "startedAt");
  assertSource(manifest.source, "source");
  assert(manifest.limitation === expectedLimitation, "the static Chromium limitation is missing");
  assert(Array.isArray(manifest.entries), "entries must be an array");
  assert(manifest.entryCount === manifest.entries.length, "entryCount does not match entries");

  const names = new Set();
  const hashes = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    const label = `entries[${String(index)}]`;
    assertRecord(entry, label);
    assertNonEmptyString(entry.name, `${label}.name`);
    assert(!names.has(entry.name), `${label}.name is duplicated`);
    names.add(entry.name);
    assertNonEmptyString(entry.state, `${label}.state`);
    assertRoute(entry.route, `${label}.route`);
    assertSource(entry.source, `${label}.source`);
    assert(entry.source.commit === manifest.source.commit, `${label}.source.commit drifted`);
    assert(entry.source.dirty === manifest.source.dirty, `${label}.source.dirty drifted`);
    assertDataSurface(entry.dataSurface, `${label}.dataSurface`);
    assertViewport(entry.viewportProfile, entry.cssViewport, `${label}.viewport`);
    assertPositiveNumber(entry.devicePixelRatio, `${label}.devicePixelRatio`);
    assertRecord(entry.systemScale, `${label}.systemScale`);
    assert(entry.systemScale.status === "not_measured", `${label}.systemScale must be unmeasured`);
    assert(entry.systemScale.value === null, `${label}.systemScale.value must be null`);
    assert(
      entry.systemScale.limitation === expectedLimitation,
      `${label}.systemScale limitation is missing`,
    );
    assertRecord(entry.runtime, `${label}.runtime`);
    assert(entry.runtime.browser === "chromium", `${label} is not Chromium evidence`);
    assert(
      entry.runtime.shell === "static_web_distribution",
      `${label} must identify the static distribution`,
    );
    assert(entry.runtime.tauriWebView === "not_run", `${label} must not claim Tauri coverage`);
    assertIsoTimestamp(entry.capturedAt, `${label}.capturedAt`);
    assertSha256(entry.sha256, `${label}.sha256`);
    assertPositiveNumber(entry.byteLength, `${label}.byteLength`);
    assertDimensions(entry.imagePixels, `${label}.imagePixels`);
    assert(
      entry.screenshot === `images/${entry.sha256}.png`,
      `${label}.screenshot must be content addressed`,
    );

    const imagePath = path.resolve(evidenceRoot, entry.screenshot);
    assert(
      imagePath.startsWith(`${evidenceRoot}${path.sep}`),
      `${label}.screenshot escapes the evidence directory`,
    );
    const bytes = await readFile(imagePath);
    assert(
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      `${label}.screenshot is not a PNG`,
    );
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    assert(actualHash === entry.sha256, `${label}.sha256 does not match the PNG`);
    assert(bytes.byteLength === entry.byteLength, `${label}.byteLength does not match the PNG`);
    const imagePixels = {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
    assert(
      imagePixels.width === entry.imagePixels.width &&
        imagePixels.height === entry.imagePixels.height,
      `${label}.imagePixels does not match the PNG`,
    );
    assert(
      imagePixels.width === Math.round(entry.cssViewport.width * entry.devicePixelRatio) &&
        imagePixels.height === Math.round(entry.cssViewport.height * entry.devicePixelRatio),
      `${label}.screenshot dimensions do not match CSS viewport × DPR`,
    );
    hashes.add(entry.sha256);
  }

  assert(manifest.uniqueImageCount === hashes.size, "uniqueImageCount does not match the hashes");
  return Object.freeze({
    entryCount: manifest.entries.length,
    uniqueImageCount: hashes.size,
    commit: manifest.source.commit,
    dirty: manifest.source.dirty,
  });
}

function assertSource(value, label) {
  assertRecord(value, label);
  assertSha256(value.commit, `${label}.commit`, 40);
  assert(typeof value.dirty === "boolean", `${label}.dirty must be boolean`);
}

function assertDataSurface(value, label) {
  assertRecord(value, label);
  assertNonEmptyString(value.selector, `${label}.selector`);
  assert(
    value.attributeValue === "light" || value.attributeValue === "dark",
    `${label}.attributeValue must come from data-surface`,
  );
  assert(
    value.resolvedColorScheme === "light" || value.resolvedColorScheme === "dark",
    `${label}.resolvedColorScheme is invalid`,
  );
  assert(
    value.attributeValue === value.resolvedColorScheme,
    `${label} disagrees with Chromium's resolved color scheme`,
  );
}

function assertViewport(profile, cssViewport, label) {
  assertRecord(profile, `${label}Profile`);
  assertNonEmptyString(profile.id, `${label}Profile.id`);
  assert(
    profile.kind === "css_viewport" || profile.kind === "equivalent_200_percent",
    `${label}Profile.kind is invalid`,
  );
  assertDimensions(profile.expectedCssViewport, `${label}Profile.expectedCssViewport`);
  if (profile.kind === "equivalent_200_percent") {
    assertDimensions(profile.emulatedPhysicalViewport, `${label}Profile.emulatedPhysicalViewport`);
  } else {
    assert(
      profile.emulatedPhysicalViewport === null,
      `${label}Profile.emulatedPhysicalViewport must be null`,
    );
  }
  assertDimensions(cssViewport, `${label}.cssViewport`);
  assert(
    cssViewport.width === profile.expectedCssViewport.width &&
      cssViewport.height === profile.expectedCssViewport.height,
    `${label}.cssViewport does not match the profile`,
  );
}

function assertDimensions(value, label) {
  assertRecord(value, label);
  assertPositiveNumber(value.width, `${label}.width`);
  assertPositiveNumber(value.height, `${label}.height`);
}

function assertRoute(value, label) {
  assertNonEmptyString(value, label);
  assert(value.startsWith("/"), `${label} must be a hash-router path`);
}

function assertIsoTimestamp(value, label) {
  assertNonEmptyString(value, label);
  assert(new Date(value).toISOString() === value, `${label} must be an ISO timestamp`);
}

function assertSha256(value, label, length = 64) {
  assert(
    typeof value === "string" && new RegExp(`^[0-9a-f]{${String(length)}}$`, "u").test(value),
    `${label} must be ${String(length)} lowercase hexadecimal characters`,
  );
}

function assertPositiveNumber(value, label) {
  assert(typeof value === "number" && Number.isFinite(value) && value > 0, `${label} is invalid`);
}

function assertNonEmptyString(value, label) {
  assert(typeof value === "string" && value.trim().length > 0, `${label} is empty`);
}

function assertRecord(value, label) {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} is invalid`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await checkVisualEvidenceManifest(process.argv[2]);
  process.stdout.write(
    `视觉证据清单通过：${String(result.entryCount)} 条记录，${String(result.uniqueImageCount)} 个唯一 PNG，commit ${result.commit}${result.dirty ? "（工作树有未提交修改）" : ""}。\n`,
  );
}
