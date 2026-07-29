import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(directory, "render-kubernetes.mjs");
const digest = "a".repeat(64);

test("renderer emits an immutable, least-privilege manifest with internal endpoints excluded", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "inkshadow-enterprise-render-"));
  try {
    const output = path.join(temporary, "manifest.yaml");
    const result = render(output);
    assert.equal(result.status, 0, result.stderr);
    const manifest = await readFile(output, "utf8");
    assert.match(manifest, new RegExp(`image: registry.example/inkshadow@sha256:${digest}`, "u"));
    assert.match(manifest, /automountServiceAccountToken: false/u);
    assert.match(manifest, /allowPrivilegeEscalation: false/u);
    assert.match(manifest, /readOnlyRootFilesystem: true/u);
    assert.match(manifest, /topologyKey: kubernetes\.io\/hostname/u);
    assert.match(manifest, /path: \/v1/u);
    assert.doesNotMatch(manifest, /path: \/$/mu);
    assert.match(manifest, /name: inkshadow-enterprise-runtime-secrets/u);
    assert.match(manifest, /name: inkshadow-enterprise-migration-secrets/u);
    assert.match(manifest, /secretName: inkshadow-enterprise-database-ca/u);
    assert.match(manifest, /name: INKSHADOW_APP_ENV\s+value: production/u);
    const initStart = manifest.indexOf("      initContainers:");
    const runtimeStart = manifest.indexOf("      containers:");
    assert.ok(initStart >= 0 && runtimeStart > initStart);
    const initBlock = manifest.slice(initStart, runtimeStart);
    const runtimeBlock = manifest.slice(runtimeStart);
    assert.match(initBlock, /--migrate-only/u);
    assert.match(initBlock, /INKSHADOW_CLOUD_MIGRATION_DATABASE_URL/u);
    assert.doesNotMatch(runtimeBlock, /INKSHADOW_CLOUD_MIGRATION_DATABASE_URL/u);
    assert.doesNotMatch(runtimeBlock, /inkshadow-enterprise-migration-secrets/u);
    assert.match(manifest, /cidr: 10\.30\.4\.0\/24/u);
    assert.match(manifest, /cidr: 10\.40\.1\.0\/24/u);
    assert.doesNotMatch(manifest, /__[A-Z0-9_]+__/u);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("renderer rejects mutable images, broad networks, unknown flags and unsafe resource bounds", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "inkshadow-enterprise-reject-"));
  try {
    assert.notEqual(
      render(path.join(temporary, "mutable.yaml"), ["--image", "registry.example/inkshadow:latest"])
        .status,
      0,
    );
    assert.notEqual(
      render(path.join(temporary, "broad.yaml"), ["--https-egress-cidrs", "0.0.0.0/0"]).status,
      0,
    );
    assert.notEqual(
      render(path.join(temporary, "unknown.yaml"), ["--unreviewed-setting", "value"]).status,
      0,
    );
    assert.notEqual(
      render(path.join(temporary, "resources.yaml"), ["--cpu-request", "4", "--cpu-limit", "500m"])
        .status,
      0,
    );
    const existing = path.join(temporary, "existing.yaml");
    await writeFile(existing, "operator-owned\n", "utf8");
    assert.notEqual(render(existing).status, 0);
    assert.equal(await readFile(existing, "utf8"), "operator-owned\n");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("container and alert assets retain immutable and non-secret operational boundaries", async () => {
  const dockerfile = await readFile(path.join(directory, "docker", "Dockerfile"), "utf8");
  assert.match(dockerfile, /ARG INKSHADOW_NODE_IMAGE/u);
  assert.match(dockerfile, /@sha256:\[a-f0-9\]\{64\}/u);
  assert.match(dockerfile, /USER 10001:10001/u);
  assert.doesNotMatch(dockerfile, /(?:PASSWORD|TOKEN|PRIVATE_KEY)=/u);

  const alerts = await readFile(
    path.join(directory, "monitoring", "prometheus-rules.yaml"),
    "utf8",
  );
  assert.match(alerts, /InkShadowEnterpriseLicenseExpiring/u);
  assert.match(alerts, /InkShadowBackupStale/u);
  assert.doesNotMatch(alerts, /(?:email|prompt|prose|ciphertext|bearer|database_url)\s*[:=]/iu);
});

function render(output, overrides = []) {
  const values = new Map([
    ["image", `registry.example/inkshadow@sha256:${digest}`],
    ["namespace", "inkshadow"],
    ["public-host", "inkshadow.example.com"],
    ["tls-secret", "inkshadow-api-tls"],
    ["trusted-proxy-cidrs", "10.20.0.0/16"],
    ["ingress-namespace", "ingress-nginx"],
    ["monitoring-namespace", "monitoring"],
    ["database-cidr", "10.30.4.0/24"],
    ["https-egress-cidrs", "10.40.1.0/24,10.40.2.0/24"],
    ["output", output],
  ]);
  const extra = [];
  for (let index = 0; index < overrides.length; index += 2) {
    const rawName = overrides[index];
    const value = overrides[index + 1];
    if (rawName === undefined || value === undefined) {
      throw new Error("Test overrides must use complete name/value pairs.");
    }
    const name = rawName.replace(/^--/u, "");
    if (values.has(name)) {
      values.set(name, value);
    } else {
      extra.push(`--${name}`, value);
    }
  }
  const argumentsList = [...values].flatMap(([name, value]) => [`--${name}`, value]);
  return spawnSync(process.execPath, [renderer, ...argumentsList, ...extra], {
    encoding: "utf8",
    shell: false,
  });
}
