import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";

import {
  compareVersions,
  createCanonicalUpdateManifest,
  createSignedUpdateEnvelope,
  parseArguments,
  parseCanonicalUnsignedIntegerArgument,
  parseCanonicalVersion,
  verifyAuthenticodeAttestation,
} from "./secure-update-manifest.mjs";

const NOW = 2_000_000_000;

function input() {
  return {
    manifestUrl: "https://updates.example.com/v1/stable.json",
    channel: "stable",
    signingKeyId: "release-2026-a",
    manifestSequence: 7,
    releaseVersion: "0.2.0",
    minimumUpdaterVersion: "0.1.0",
    securityFloorVersion: "0.1.0",
    publishedAt: NOW - 60,
    expiresAt: NOW + 3_600,
    artifact: {
      target: "windows-x86_64",
      url: "https://updates.example.com/artifacts/inkshadow.exe",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
    },
    allowedFrom: [],
    releaseNotesUrl: "https://updates.example.com/releases/0.2.0",
  };
}

test("creates the exact canonical payload accepted by the native verifier", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const envelope = createSignedUpdateEnvelope(
    input(),
    privateKey.export({ type: "pkcs8", format: "pem" }),
    {
      keyId: "release-2026-a",
      publicKeyPin: publicKey.export({ format: "jwk" }).x,
    },
    NOW,
  );
  const payload = Buffer.from(envelope.payload, "base64url");
  const parsed = JSON.parse(payload.toString("utf8"));

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.keyId, "release-2026-a");
  assert.equal(
    verify(null, payload, publicKey, Buffer.from(envelope.signature, "base64url")),
    true,
  );
  assert.deepEqual(Object.keys(parsed), [
    "schemaVersion",
    "product",
    "channel",
    "signingKeyId",
    "manifestSequence",
    "releaseVersion",
    "minimumUpdaterVersion",
    "securityFloorVersion",
    "publishedAt",
    "expiresAt",
    "artifact",
    "rollback",
    "releaseNotesUrl",
  ]);
  assert.equal(JSON.stringify(parsed), payload.toString("utf8"));
  assert.equal(parsed.artifact.authenticodeRequired, true);
  assert.equal(parsed.rollback.requiresExplicitConfirmation, true);

  const otherKey = generateKeyPairSync("ed25519").publicKey;
  assert.throws(
    () =>
      createSignedUpdateEnvelope(
        input(),
        privateKey.export({ type: "pkcs8", format: "pem" }),
        {
          keyId: "release-2026-a",
          publicKeyPin: otherKey.export({ format: "jwk" }).x,
        },
        NOW,
      ),
    { code: "UPDATE_SIGNING_KEY_PIN_MISMATCH" },
  );
});

test("rejects cross-origin artifacts, query credentials, expiry and unsafe rollback", () => {
  assert.throws(
    () =>
      createCanonicalUpdateManifest(
        {
          ...input(),
          artifact: {
            ...input().artifact,
            url: "https://attacker.example/update.exe",
          },
        },
        NOW,
      ),
    { code: "UPDATE_URL_INVALID" },
  );
  assert.throws(
    () =>
      createCanonicalUpdateManifest(
        {
          ...input(),
          manifestUrl: "https://[::ffff:127.0.0.1]/manifest.json",
          artifact: {
            ...input().artifact,
            url: "https://[::ffff:127.0.0.1]/update.exe",
          },
        },
        NOW,
      ),
    { code: "UPDATE_URL_INVALID" },
  );
  assert.throws(
    () =>
      createCanonicalUpdateManifest(
        {
          ...input(),
          manifestUrl: "https://169.254.169.254/manifest.json",
          artifact: {
            ...input().artifact,
            url: "https://169.254.169.254/update.exe",
          },
        },
        NOW,
      ),
    { code: "UPDATE_URL_INVALID" },
  );
  assert.throws(
    () =>
      createCanonicalUpdateManifest(
        {
          ...input(),
          artifact: {
            ...input().artifact,
            url: "https://updates.example.com/update.exe?token=secret",
          },
        },
        NOW,
      ),
    { code: "UPDATE_URL_INVALID" },
  );
  assert.throws(
    () =>
      createCanonicalUpdateManifest(
        {
          ...input(),
          expiresAt: NOW,
        },
        NOW,
      ),
    { code: "UPDATE_TIME_INVALID" },
  );
  assert.throws(
    () =>
      createCanonicalUpdateManifest(
        {
          ...input(),
          allowedFrom: ["0.1.0"],
        },
        NOW,
      ),
    { code: "UPDATE_ROLLBACK_POLICY_INVALID" },
  );
});

test("implements canonical SemVer precedence without accepting build metadata", () => {
  assert.equal(
    compareVersions(parseCanonicalVersion("1.0.0-beta.2"), parseCanonicalVersion("1.0.0-beta.11")),
    -1,
  );
  assert.equal(
    compareVersions(parseCanonicalVersion("1.0.0-rc.1"), parseCanonicalVersion("1.0.0")),
    -1,
  );
  assert.throws(() => parseCanonicalVersion("01.0.0"), {
    code: "UPDATE_VERSION_INVALID",
  });
  assert.throws(() => parseCanonicalVersion("1.0.0+build"), {
    code: "UPDATE_VERSION_INVALID",
  });
  assert.equal(
    compareVersions(
      parseCanonicalVersion("9007199254740992.0.0"),
      parseCanonicalVersion("9007199254740993.0.0"),
    ),
    -1,
  );
  assert.throws(() => parseCanonicalVersion("18446744073709551616.0.0"), {
    code: "UPDATE_VERSION_INVALID",
  });
  assert.throws(
    () =>
      createCanonicalUpdateManifest(
        {
          ...input(),
          releaseVersion: "9007199254740992.0.0",
          minimumUpdaterVersion: "9007199254740993.0.0",
        },
        NOW,
      ),
    { code: "UPDATE_VERSION_POLICY_INVALID" },
  );
});

test("verifies an independent canonical Authenticode attestation", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      artifactSha256: "a".repeat(64),
      artifactSizeBytes: 1024,
      publisherFingerprintSha256: "b".repeat(64),
      verifiedAt: NOW - 30,
      verifierId: "inkshadow-winverify-v1",
      authenticodeChainValid: true,
      timestampValid: true,
      exactPublisherMatched: true,
      revocationStatus: "good",
    }),
    "utf8",
  );
  const envelope = JSON.stringify({
    schemaVersion: 1,
    payload: payload.toString("base64url"),
    signature: sign(null, payload, privateKey).toString("base64url"),
  });
  const policy = {
    approvedPublisherFingerprintSha256: "b".repeat(64),
    verifierId: "inkshadow-winverify-v1",
    verifierPublicKeyPin: publicKey.export({ format: "jwk" }).x,
  };
  assert.equal(
    verifyAuthenticodeAttestation(
      envelope,
      { sha256: "a".repeat(64), sizeBytes: 1024 },
      policy,
      NOW,
    ).verifierId,
    "inkshadow-winverify-v1",
  );

  const tampered = JSON.parse(envelope);
  tampered.signature = Buffer.alloc(64, 1).toString("base64url");
  assert.throws(
    () =>
      verifyAuthenticodeAttestation(
        JSON.stringify(tampered),
        { sha256: "a".repeat(64), sizeBytes: 1024 },
        policy,
        NOW,
      ),
    { code: "UPDATE_AUTHENTICODE_ATTESTATION_SIGNATURE_INVALID" },
  );
  assert.throws(
    () =>
      verifyAuthenticodeAttestation(
        envelope,
        { sha256: "c".repeat(64), sizeBytes: 1024 },
        policy,
        NOW,
      ),
    { code: "UPDATE_AUTHENTICODE_ATTESTATION_REJECTED" },
  );
  assert.throws(
    () =>
      verifyAuthenticodeAttestation(
        `${envelope}\n`,
        { sha256: "a".repeat(64), sizeBytes: 1024 },
        policy,
        NOW,
      ),
    { code: "UPDATE_AUTHENTICODE_ATTESTATION_INVALID" },
  );

  const stalePayload = Buffer.from(
    JSON.stringify({
      ...JSON.parse(payload.toString("utf8")),
      verifiedAt: NOW - 86_401,
    }),
    "utf8",
  );
  const staleEnvelope = JSON.stringify({
    schemaVersion: 1,
    payload: stalePayload.toString("base64url"),
    signature: sign(null, stalePayload, privateKey).toString("base64url"),
  });
  assert.throws(
    () =>
      verifyAuthenticodeAttestation(
        staleEnvelope,
        { sha256: "a".repeat(64), sizeBytes: 1024 },
        policy,
        NOW,
      ),
    { code: "UPDATE_AUTHENTICODE_ATTESTATION_REJECTED" },
  );
});

test("rejects unknown, duplicate and non-canonical CLI arguments", () => {
  assert.throws(() => parseArguments(["--unknown", "value"]), {
    code: "UPDATE_ARGUMENTS_INVALID",
  });
  assert.throws(() => parseArguments(["--channel", "stable", "--channel", "beta"]), {
    code: "UPDATE_ARGUMENTS_INVALID",
  });
  assert.deepEqual(parseArguments(["--allow-rollback-from", "1.0.0"]).get("allow-rollback-from"), [
    "1.0.0",
  ]);
  assert.equal(parseCanonicalUnsignedIntegerArgument("7"), 7);
  for (const value of ["07", "7.0", "1e3", "0x10", "-1", "9007199254740992"]) {
    assert.throws(() => parseCanonicalUnsignedIntegerArgument(value), {
      code: "UPDATE_ARGUMENTS_INVALID",
    });
  }
});
