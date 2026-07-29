import { AccessCoreError } from "./errors.js";
import {
  RELEASE_TIERS,
  assertProductCapability,
  type ProductCapability,
  type ReleaseTier,
  type SubscriptionState,
} from "./entitlements.js";
import {
  hasExactKeys,
  isRecord,
  requireIdentifier,
  requireIsoTimestamp,
  uniqueSortedIdentifiers,
} from "./validation.js";

const PAYLOAD_KEYS = [
  "schemaVersion",
  "licenseId",
  "product",
  "keyId",
  "deviceId",
  "tier",
  "issuedAt",
  "notBefore",
  "validUntil",
  "graceUntil",
  "capabilities",
  "featureFlags",
] as const;
const ENVELOPE_KEYS = ["payload", "signature"] as const;

export interface OfflineLicensePayload {
  readonly schemaVersion: 1;
  readonly licenseId: string;
  readonly product: "inkshadow";
  readonly keyId: string;
  readonly deviceId: string;
  readonly tier: ReleaseTier;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly graceUntil: string;
  readonly capabilities: readonly ProductCapability[];
  readonly featureFlags: readonly string[];
}

export interface SignedOfflineLicense {
  readonly payload: OfflineLicensePayload;
  readonly signature: string;
}

export interface VerifiedOfflineLicense {
  readonly payload: OfflineLicensePayload;
  readonly subscriptionState: Extract<SubscriptionState, "active" | "grace" | "offline_expired">;
  readonly evidence: "offline_license_verified";
}

export interface OfflineLicenseVerificationInput {
  readonly envelope: unknown;
  readonly expectedDeviceId: string;
  readonly now: string;
}

export class OfflineLicenseVerifier {
  public constructor(
    private readonly verificationKeys: ReadonlyMap<string, CryptoKey>,
    private readonly cryptoProvider: Crypto = globalThis.crypto,
  ) {}

  public async verify(input: OfflineLicenseVerificationInput): Promise<VerifiedOfflineLicense> {
    const envelope = parseSignedOfflineLicense(input.envelope);
    const expectedDeviceId = requireIdentifier(input.expectedDeviceId, "expectedDeviceId");
    if (envelope.payload.deviceId !== expectedDeviceId) {
      throw new AccessCoreError(
        "ACCESS_LICENSE_DEVICE_MISMATCH",
        "Offline license is bound to a different device.",
      );
    }
    const key = this.verificationKeys.get(envelope.payload.keyId);
    if (key === undefined) {
      throw new AccessCoreError(
        "ACCESS_LICENSE_KEY_UNKNOWN",
        "Offline license signing key is unknown.",
      );
    }
    validateVerificationKey(key);
    const signature = decodeBase64Url(envelope.signature);
    const valid = await this.cryptoProvider.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      new TextEncoder().encode(canonicalizeOfflineLicensePayload(envelope.payload)),
    );
    if (!valid) {
      throw new AccessCoreError(
        "ACCESS_LICENSE_SIGNATURE_INVALID",
        "Offline license signature is invalid.",
      );
    }

    const now = requireIsoTimestamp(input.now, "now");
    if (Date.parse(now) < Date.parse(envelope.payload.notBefore)) {
      throw new AccessCoreError(
        "ACCESS_LICENSE_NOT_YET_VALID",
        "Offline license is not valid yet.",
      );
    }
    const subscriptionState =
      Date.parse(now) <= Date.parse(envelope.payload.validUntil)
        ? "active"
        : Date.parse(now) <= Date.parse(envelope.payload.graceUntil)
          ? "grace"
          : "offline_expired";
    return Object.freeze({
      payload: envelope.payload,
      subscriptionState,
      evidence: "offline_license_verified",
    });
  }
}

export function parseSignedOfflineLicense(value: unknown): SignedOfflineLicense {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ENVELOPE_KEYS) ||
    !isRecord(value.payload) ||
    !hasExactKeys(value.payload, PAYLOAD_KEYS) ||
    typeof value.signature !== "string"
  ) {
    throw formatError();
  }
  const payload = value.payload;
  if (
    payload.schemaVersion !== 1 ||
    payload.product !== "inkshadow" ||
    typeof payload.licenseId !== "string" ||
    typeof payload.keyId !== "string" ||
    typeof payload.deviceId !== "string" ||
    typeof payload.tier !== "string" ||
    typeof payload.issuedAt !== "string" ||
    typeof payload.notBefore !== "string" ||
    typeof payload.validUntil !== "string" ||
    typeof payload.graceUntil !== "string" ||
    !Array.isArray(payload.capabilities) ||
    !payload.capabilities.every((capability) => typeof capability === "string") ||
    !Array.isArray(payload.featureFlags) ||
    !payload.featureFlags.every((flag) => typeof flag === "string") ||
    !RELEASE_TIERS.includes(payload.tier as ReleaseTier)
  ) {
    throw formatError();
  }

  const issuedAt = requireIsoTimestamp(payload.issuedAt, "issuedAt");
  const notBefore = requireIsoTimestamp(payload.notBefore, "notBefore");
  const validUntil = requireIsoTimestamp(payload.validUntil, "validUntil");
  const graceUntil = requireIsoTimestamp(payload.graceUntil, "graceUntil");
  if (
    Date.parse(notBefore) < Date.parse(issuedAt) ||
    Date.parse(validUntil) < Date.parse(notBefore) ||
    Date.parse(graceUntil) < Date.parse(validUntil)
  ) {
    throw formatError();
  }
  const capabilities = uniqueSortedIdentifiers(payload.capabilities, "capabilities").map(
    assertProductCapability,
  );
  const featureFlags = uniqueSortedIdentifiers(payload.featureFlags, "featureFlags");
  const normalizedPayload: OfflineLicensePayload = Object.freeze({
    schemaVersion: 1,
    licenseId: requireIdentifier(payload.licenseId, "licenseId"),
    product: "inkshadow",
    keyId: requireIdentifier(payload.keyId, "keyId"),
    deviceId: requireIdentifier(payload.deviceId, "deviceId"),
    tier: payload.tier as ReleaseTier,
    issuedAt,
    notBefore,
    validUntil,
    graceUntil,
    capabilities: Object.freeze(capabilities),
    featureFlags,
  });
  decodeBase64Url(value.signature);
  return Object.freeze({ payload: normalizedPayload, signature: value.signature });
}

export function canonicalizeOfflineLicensePayload(payloadValue: OfflineLicensePayload): string {
  const payload = parseSignedOfflineLicense({
    payload: payloadValue,
    signature: "AA",
  }).payload;
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    licenseId: payload.licenseId,
    product: payload.product,
    keyId: payload.keyId,
    deviceId: payload.deviceId,
    tier: payload.tier,
    issuedAt: payload.issuedAt,
    notBefore: payload.notBefore,
    validUntil: payload.validUntil,
    graceUntil: payload.graceUntil,
    capabilities: payload.capabilities,
    featureFlags: payload.featureFlags,
  });
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw formatError();
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw formatError();
  }
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  return decoded;
}

function validateVerificationKey(key: CryptoKey): void {
  if (key.type !== "public" || key.algorithm.name !== "Ed25519" || !key.usages.includes("verify")) {
    throw new AccessCoreError(
      "ACCESS_LICENSE_KEY_UNKNOWN",
      "Offline license verification key is invalid.",
    );
  }
}

function formatError(): AccessCoreError {
  return new AccessCoreError("ACCESS_LICENSE_FORMAT_INVALID", "Offline license format is invalid.");
}
