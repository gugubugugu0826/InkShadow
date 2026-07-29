import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

const PRODUCT_ID = "com.inkshadow.desktop";
const SCHEMA_VERSION = 1;
const ATTESTATION_SCHEMA_VERSION = 1;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const MAX_ATTESTATION_AGE_SECONDS = 24 * 60 * 60;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_LIFETIME_SECONDS = 31 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_MANIFEST_SEQUENCE = BigInt(Number.MAX_SAFE_INTEGER);
const SINGLE_VALUE_ARGUMENTS = new Set([
  "artifact",
  "output",
  "authenticode-attestation",
  "manifest-url",
  "channel",
  "key-id",
  "public-key-pin",
  "manifest-sequence",
  "release-version",
  "minimum-updater-version",
  "security-floor-version",
  "published-at",
  "expires-at",
  "target",
  "artifact-url",
  "release-notes-url",
]);
const REPEATABLE_ARGUMENTS = new Set(["allow-rollback-from"]);

export function createSignedUpdateEnvelope(
  input,
  privateKeyPem,
  keyPolicy,
  nowSeconds = unixTimeNow(),
) {
  const manifest = createCanonicalUpdateManifest(input, nowSeconds);
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw updateManifestError("UPDATE_SIGNING_KEY_INVALID");
  }
  if (!isRecord(keyPolicy) || requireKeyId(keyPolicy.keyId) !== manifest.signingKeyId) {
    throw updateManifestError("UPDATE_SIGNING_KEY_POLICY_INVALID");
  }
  const expectedPublicKey = requireCanonicalBase64url(
    keyPolicy.publicKeyPin,
    32,
    "UPDATE_SIGNING_KEY_POLICY_INVALID",
  );
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (publicJwk.kty !== "OKP" || publicJwk.crv !== "Ed25519" || publicJwk.x !== expectedPublicKey) {
    throw updateManifestError("UPDATE_SIGNING_KEY_PIN_MISMATCH");
  }
  const payload = Buffer.from(JSON.stringify(manifest), "utf8");
  const signature = signBytes(null, payload, privateKey);
  if (signature.length !== 64) {
    throw updateManifestError("UPDATE_SIGNATURE_INVALID");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    keyId: manifest.signingKeyId,
    payload: payload.toString("base64url"),
    signature: signature.toString("base64url"),
  });
}

export function createCanonicalUpdateManifest(input, nowSeconds = unixTimeNow()) {
  if (!isRecord(input)) {
    throw updateManifestError("UPDATE_INPUT_INVALID");
  }
  const manifestUrl = parsePinnedHttpsUrl(input.manifestUrl);
  const channel = requireEnum(input.channel, ["stable", "beta"], "UPDATE_CHANNEL_INVALID");
  const signingKeyId = requireKeyId(input.signingKeyId);
  const manifestSequence = requireManifestSequence(input.manifestSequence);
  const releaseVersion = parseCanonicalVersion(input.releaseVersion);
  const minimumUpdaterVersion = parseCanonicalVersion(input.minimumUpdaterVersion);
  const securityFloorVersion = parseCanonicalVersion(input.securityFloorVersion);
  if (
    compareVersions(minimumUpdaterVersion, releaseVersion) > 0 ||
    compareVersions(securityFloorVersion, releaseVersion) > 0 ||
    (channel === "stable" && releaseVersion.prerelease.length > 0)
  ) {
    throw updateManifestError("UPDATE_VERSION_POLICY_INVALID");
  }

  const publishedAt = requireSafeInteger(input.publishedAt, "UPDATE_TIME_INVALID");
  const expiresAt = requireSafeInteger(input.expiresAt, "UPDATE_TIME_INVALID");
  if (
    publishedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
    expiresAt <= nowSeconds ||
    expiresAt <= publishedAt ||
    expiresAt - publishedAt > MAX_MANIFEST_LIFETIME_SECONDS
  ) {
    throw updateManifestError("UPDATE_TIME_INVALID");
  }

  if (!isRecord(input.artifact)) {
    throw updateManifestError("UPDATE_ARTIFACT_INVALID");
  }
  const target = requireEnum(
    input.artifact.target,
    ["windows-x86_64", "windows-aarch64"],
    "UPDATE_TARGET_INVALID",
  );
  const artifactUrl = parsePinnedHttpsUrl(input.artifact.url, manifestUrl);
  const sizeBytes = requireSafeInteger(input.artifact.sizeBytes, "UPDATE_ARTIFACT_INVALID");
  const sha256 = requireString(input.artifact.sha256, "UPDATE_ARTIFACT_INVALID");
  if (sizeBytes <= 0 || sizeBytes > MAX_ARTIFACT_BYTES || !LOWER_SHA256.test(sha256)) {
    throw updateManifestError("UPDATE_ARTIFACT_INVALID");
  }

  const allowedFromInput = input.allowedFrom ?? [];
  if (!Array.isArray(allowedFromInput) || allowedFromInput.length > 32) {
    throw updateManifestError("UPDATE_ROLLBACK_POLICY_INVALID");
  }
  const allowedFrom = [];
  const seenRollbackVersions = new Set();
  for (const value of allowedFromInput) {
    const parsed = parseCanonicalVersion(value);
    if (compareVersions(parsed, releaseVersion) <= 0 || seenRollbackVersions.has(parsed.source)) {
      throw updateManifestError("UPDATE_ROLLBACK_POLICY_INVALID");
    }
    seenRollbackVersions.add(parsed.source);
    allowedFrom.push(parsed.source);
  }

  const releaseNotesUrl =
    input.releaseNotesUrl === undefined
      ? undefined
      : parsePinnedHttpsUrl(input.releaseNotesUrl, manifestUrl).toString();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    product: PRODUCT_ID,
    channel,
    signingKeyId,
    manifestSequence,
    releaseVersion: releaseVersion.source,
    minimumUpdaterVersion: minimumUpdaterVersion.source,
    securityFloorVersion: securityFloorVersion.source,
    publishedAt,
    expiresAt,
    artifact: Object.freeze({
      target,
      kind: "nsis",
      url: artifactUrl.toString(),
      sizeBytes,
      sha256,
      authenticodeRequired: true,
    }),
    rollback: Object.freeze({
      allowedFrom: Object.freeze(allowedFrom),
      requiresExplicitConfirmation: true,
    }),
    ...(releaseNotesUrl === undefined ? {} : { releaseNotesUrl }),
  });
}

export function parseCanonicalVersion(value) {
  const source = requireString(value, "UPDATE_VERSION_INVALID");
  if (source.length > 64 || source.includes("+")) {
    throw updateManifestError("UPDATE_VERSION_INVALID");
  }
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
      source,
    );
  if (match === null) {
    throw updateManifestError("UPDATE_VERSION_INVALID");
  }
  const prerelease =
    match[4] === undefined
      ? []
      : match[4].split(".").map((identifier) => {
          if (/^[0-9]+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
            throw updateManifestError("UPDATE_VERSION_INVALID");
          }
          if (/^[0-9]+$/u.test(identifier) && BigInt(identifier) > MAX_U64) {
            throw updateManifestError("UPDATE_VERSION_INVALID");
          }
          return identifier;
        });
  const major = BigInt(match[1]);
  const minor = BigInt(match[2]);
  const patch = BigInt(match[3]);
  if (major > MAX_U64 || minor > MAX_U64 || patch > MAX_U64) {
    throw updateManifestError("UPDATE_VERSION_INVALID");
  }
  return Object.freeze({
    source,
    major,
    minor,
    patch,
    prerelease: Object.freeze(prerelease),
  });
}

export function compareVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^[0-9]+$/u.test(leftIdentifier);
    const rightNumeric = /^[0-9]+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function verifyAuthenticodeAttestation(
  envelopeSource,
  artifact,
  policy,
  nowSeconds = unixTimeNow(),
) {
  if (!isRecord(artifact) || !isRecord(policy)) {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_INVALID");
  }
  const artifactSha256 = requireLowerSha256(
    artifact.sha256,
    "UPDATE_AUTHENTICODE_ATTESTATION_INVALID",
  );
  const artifactSizeBytes = requireSafeInteger(
    artifact.sizeBytes,
    "UPDATE_AUTHENTICODE_ATTESTATION_INVALID",
  );
  if (artifactSizeBytes <= 0 || artifactSizeBytes > MAX_ARTIFACT_BYTES) {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_INVALID");
  }
  const encoded =
    typeof envelopeSource === "string" ? Buffer.from(envelopeSource, "utf8") : envelopeSource;
  if (!Buffer.isBuffer(encoded) || encoded.length === 0 || encoded.length > MAX_ATTESTATION_BYTES) {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_INVALID");
  }
  let envelope;
  try {
    envelope = JSON.parse(encoded.toString("utf8"));
  } catch {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_INVALID");
  }
  requireExactKeys(
    envelope,
    ["schemaVersion", "payload", "signature"],
    "UPDATE_AUTHENTICODE_ATTESTATION_INVALID",
  );
  if (
    envelope.schemaVersion !== ATTESTATION_SCHEMA_VERSION ||
    !Buffer.from(JSON.stringify(envelope), "utf8").equals(encoded)
  ) {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_INVALID");
  }
  const payload = decodeCanonicalBase64url(
    envelope.payload,
    MAX_ATTESTATION_BYTES,
    "UPDATE_AUTHENTICODE_ATTESTATION_INVALID",
  );
  const signature = decodeCanonicalBase64url(
    envelope.signature,
    64,
    "UPDATE_AUTHENTICODE_ATTESTATION_INVALID",
  );
  if (signature.length !== 64) {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_INVALID");
  }
  const verifierPublicKeyPin = requireCanonicalBase64url(
    policy.verifierPublicKeyPin,
    32,
    "UPDATE_AUTHENTICODE_POLICY_INVALID",
  );
  const verifierPublicKey = createPublicKey({
    format: "jwk",
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: verifierPublicKeyPin,
    },
  });
  if (!verifyBytes(null, payload, verifierPublicKey, signature)) {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_SIGNATURE_INVALID");
  }

  let attestation;
  try {
    attestation = JSON.parse(payload.toString("utf8"));
  } catch {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_INVALID");
  }
  requireExactKeys(
    attestation,
    [
      "schemaVersion",
      "artifactSha256",
      "artifactSizeBytes",
      "publisherFingerprintSha256",
      "verifiedAt",
      "verifierId",
      "authenticodeChainValid",
      "timestampValid",
      "exactPublisherMatched",
      "revocationStatus",
    ],
    "UPDATE_AUTHENTICODE_ATTESTATION_INVALID",
  );
  if (!Buffer.from(JSON.stringify(attestation), "utf8").equals(payload)) {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_NOT_CANONICAL");
  }
  const expectedVerifierId = requireVerifierId(policy.verifierId);
  const expectedPublisher = requireLowerSha256(
    policy.approvedPublisherFingerprintSha256,
    "UPDATE_AUTHENTICODE_POLICY_INVALID",
  );
  const verifiedAt = requireSafeInteger(
    attestation.verifiedAt,
    "UPDATE_AUTHENTICODE_ATTESTATION_INVALID",
  );
  if (
    attestation.schemaVersion !== ATTESTATION_SCHEMA_VERSION ||
    requireLowerSha256(attestation.artifactSha256, "UPDATE_AUTHENTICODE_ATTESTATION_INVALID") !==
      artifactSha256 ||
    requireSafeInteger(attestation.artifactSizeBytes, "UPDATE_AUTHENTICODE_ATTESTATION_INVALID") !==
      artifactSizeBytes ||
    requireLowerSha256(
      attestation.publisherFingerprintSha256,
      "UPDATE_AUTHENTICODE_ATTESTATION_INVALID",
    ) !== expectedPublisher ||
    requireVerifierId(attestation.verifierId) !== expectedVerifierId ||
    attestation.authenticodeChainValid !== true ||
    attestation.timestampValid !== true ||
    attestation.exactPublisherMatched !== true ||
    attestation.revocationStatus !== "good" ||
    verifiedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
    nowSeconds - Math.min(nowSeconds, verifiedAt) > MAX_ATTESTATION_AGE_SECONDS
  ) {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_REJECTED");
  }
  return Object.freeze(attestation);
}

async function main() {
  const argumentsByName = parseArguments(process.argv.slice(2));
  const required = (name) => {
    const value = argumentsByName.get(name);
    if (value === undefined || value.length !== 1) {
      throw updateManifestError(`UPDATE_ARGUMENT_${name.toUpperCase().replaceAll("-", "_")}`);
    }
    return value[0];
  };
  const artifactPath = required("artifact");
  const outputPath = required("output");
  const keyPath = process.env.INKSHADOW_UPDATE_SIGNING_PRIVATE_KEY_FILE?.trim();
  if (keyPath === undefined || keyPath.length === 0) {
    throw updateManifestError("UPDATE_SIGNING_KEY_FILE_MISSING");
  }

  const artifact = await inspectArtifact(artifactPath);
  const manifestSequence = parseCanonicalUnsignedIntegerArgument(
    required("manifest-sequence"),
    "UPDATE_MANIFEST_SEQUENCE_INVALID",
  );
  const publishedAt = parseCanonicalUnsignedIntegerArgument(
    required("published-at"),
    "UPDATE_TIME_INVALID",
  );
  const expiresAt = parseCanonicalUnsignedIntegerArgument(
    required("expires-at"),
    "UPDATE_TIME_INVALID",
  );
  const attestationPath = required("authenticode-attestation");
  const attestationMetadata = await lstat(attestationPath);
  if (
    !attestationMetadata.isFile() ||
    attestationMetadata.isSymbolicLink() ||
    attestationMetadata.size <= 0 ||
    attestationMetadata.size > MAX_ATTESTATION_BYTES
  ) {
    throw updateManifestError("UPDATE_AUTHENTICODE_ATTESTATION_INVALID");
  }
  const attestation = verifyAuthenticodeAttestation(await readFile(attestationPath), artifact, {
    approvedPublisherFingerprintSha256: requiredEnvironment(
      "INKSHADOW_AUTHENTICODE_APPROVED_PUBLISHER_SHA256",
    ),
    verifierId: requiredEnvironment("INKSHADOW_AUTHENTICODE_ATTESTATION_VERIFIER_ID"),
    verifierPublicKeyPin: requiredEnvironment(
      "INKSHADOW_AUTHENTICODE_ATTESTATION_PUBLIC_KEY_B64URL",
    ),
  });

  const keyMetadata = await lstat(keyPath);
  if (
    !keyMetadata.isFile() ||
    keyMetadata.isSymbolicLink() ||
    (process.platform !== "win32" && (keyMetadata.mode & 0o077) !== 0)
  ) {
    throw updateManifestError("UPDATE_SIGNING_KEY_FILE_UNSAFE");
  }
  const privateKeyPem = await readFile(keyPath);
  const allowedFrom = argumentsByName.get("allow-rollback-from") ?? [];
  const envelope = createSignedUpdateEnvelope(
    {
      manifestUrl: required("manifest-url"),
      channel: argumentsByName.get("channel")?.[0] ?? "stable",
      signingKeyId: required("key-id"),
      manifestSequence,
      releaseVersion: required("release-version"),
      minimumUpdaterVersion: required("minimum-updater-version"),
      securityFloorVersion: required("security-floor-version"),
      publishedAt,
      expiresAt,
      artifact: {
        target: argumentsByName.get("target")?.[0] ?? "windows-x86_64",
        url: required("artifact-url"),
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      },
      allowedFrom,
      ...(argumentsByName.get("release-notes-url")?.[0] === undefined
        ? {}
        : { releaseNotesUrl: argumentsByName.get("release-notes-url")[0] }),
    },
    privateKeyPem,
    {
      keyId: required("key-id"),
      publicKeyPin: required("public-key-pin"),
    },
  );
  await writeFile(outputPath, `${JSON.stringify(envelope)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  process.stdout.write(
    `${JSON.stringify({
      output: outputPath,
      releaseVersion: required("release-version"),
      manifestSequence,
      signingKeyId: required("key-id"),
      artifactSha256: artifact.sha256,
      authenticodePublisherSha256: attestation.publisherFingerprintSha256,
      authenticodeVerifierId: attestation.verifierId,
    })}\n`,
  );
}

async function inspectArtifact(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARTIFACT_BYTES) {
    throw updateManifestError("UPDATE_ARTIFACT_INVALID");
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return Object.freeze({
    sizeBytes: metadata.size,
    sha256: digest.digest("hex"),
  });
}

export function parseArguments(values) {
  const output = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw updateManifestError("UPDATE_ARGUMENTS_INVALID");
    }
    const normalized = name.slice(2);
    if (!SINGLE_VALUE_ARGUMENTS.has(normalized) && !REPEATABLE_ARGUMENTS.has(normalized)) {
      throw updateManifestError("UPDATE_ARGUMENTS_INVALID");
    }
    const current = output.get(normalized) ?? [];
    if (SINGLE_VALUE_ARGUMENTS.has(normalized) && current.length > 0) {
      throw updateManifestError("UPDATE_ARGUMENTS_INVALID");
    }
    current.push(value);
    output.set(normalized, current);
  }
  return output;
}

export function parseCanonicalUnsignedIntegerArgument(value, code = "UPDATE_ARGUMENTS_INVALID") {
  const source = requireString(value, code);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(source)) {
    throw updateManifestError(code);
  }
  const parsed = Number(source);
  return requireSafeInteger(parsed, code);
}

function requireExactKeys(value, expected, code) {
  if (!isRecord(value)) {
    throw updateManifestError(code);
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw updateManifestError(code);
  }
}

function decodeCanonicalBase64url(value, maxDecodedBytes, code) {
  const source = requireString(value, code);
  if (
    source.includes("=") ||
    !CANONICAL_BASE64URL.test(source) ||
    source.length > Math.ceil((maxDecodedBytes * 4) / 3)
  ) {
    throw updateManifestError(code);
  }
  const decoded = Buffer.from(source, "base64url");
  if (decoded.length > maxDecodedBytes || decoded.toString("base64url") !== source) {
    throw updateManifestError(code);
  }
  return decoded;
}

function requireCanonicalBase64url(value, exactDecodedBytes, code) {
  const decoded = decodeCanonicalBase64url(value, exactDecodedBytes, code);
  if (decoded.length !== exactDecodedBytes) {
    throw updateManifestError(code);
  }
  return decoded.toString("base64url");
}

function requireKeyId(value) {
  const source = requireString(value, "UPDATE_KEY_ID_INVALID");
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(source)) {
    throw updateManifestError("UPDATE_KEY_ID_INVALID");
  }
  return source;
}

function requireVerifierId(value) {
  const source = requireString(value, "UPDATE_AUTHENTICODE_POLICY_INVALID");
  if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(source)) {
    throw updateManifestError("UPDATE_AUTHENTICODE_POLICY_INVALID");
  }
  return source;
}

function requireManifestSequence(value) {
  const sequence = requireSafeInteger(value, "UPDATE_MANIFEST_SEQUENCE_INVALID");
  if (sequence <= 0 || BigInt(sequence) > MAX_MANIFEST_SEQUENCE) {
    throw updateManifestError("UPDATE_MANIFEST_SEQUENCE_INVALID");
  }
  return sequence;
}

function requireLowerSha256(value, code) {
  const source = requireString(value, code);
  if (!LOWER_SHA256.test(source)) {
    throw updateManifestError(code);
  }
  return source;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw updateManifestError("UPDATE_RELEASE_TRUST_POLICY_MISSING");
  }
  return value;
}

function parsePinnedHttpsUrl(value, sameOriginAs) {
  const source = requireString(value, "UPDATE_URL_INVALID");
  if (source.length > 2048 || source.trim() !== source) {
    throw updateManifestError("UPDATE_URL_INVALID");
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    throw updateManifestError("UPDATE_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    unsafeLiteralOrLocalHost(url.hostname) ||
    (sameOriginAs !== undefined && url.origin !== sameOriginAs.origin)
  ) {
    throw updateManifestError("UPDATE_URL_INVALID");
  }
  return url;
}

function unsafeLiteralOrLocalHost(hostname) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (host.includes(":")) {
    return !ipv6LiteralIsPublic(host);
  }
  const ipv4 = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/u.exec(host);
  if (ipv4 === null) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true;
  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function ipv6LiteralIsPublic(host) {
  const segments = parseIpv6Segments(host);
  if (segments === null) {
    return false;
  }
  const globalUnicast = (segments[0] & 0xe000) === 0x2000;
  const documentation = segments[0] === 0x2001 && segments[1] === 0x0db8;
  const benchmarking = segments[0] === 0x2001 && segments[1] === 0x0002 && segments[2] === 0x0000;
  return globalUnicast && !documentation && !benchmarking;
}

function parseIpv6Segments(host) {
  const halves = host.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parseHalf = (half) => {
    if (half.length === 0) {
      return [];
    }
    const pieces = half.split(":");
    if (pieces.some((piece) => !/^[0-9a-f]{1,4}$/u.test(piece))) {
      return null;
    }
    return pieces.map((piece) => Number.parseInt(piece, 16));
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (left === null || right === null) {
    return null;
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - left.length - right.length;
  if (missing <= 0) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function requireString(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw updateManifestError(code);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw updateManifestError(code);
  }
  return value;
}

function requireEnum(value, allowed, code) {
  if (!allowed.includes(value)) {
    throw updateManifestError(code);
  }
  return value;
}

function updateManifestError(code) {
  return Object.assign(new Error(code), { code });
}

function unixTimeNow() {
  return Math.floor(Date.now() / 1000);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "UPDATE_MANIFEST_TOOL_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
