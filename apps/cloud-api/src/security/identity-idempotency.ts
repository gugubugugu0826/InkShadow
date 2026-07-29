import type {
  CloudAuthenticationRequest,
  CloudIdentityRegistrationRequest,
  CloudIdentityVerificationRequest,
  CloudPasswordResetConfirmationRequest,
  CloudSessionRefreshRequest,
} from "@inkshadow/contracts";

import { hashCanonicalJson } from "./canonical-hash.js";

const IDENTITY_IDEMPOTENCY_FINGERPRINT_VERSION = 2;

export function hashIdentityRegistrationIdempotencyRequest(
  request: CloudIdentityRegistrationRequest,
): string {
  return hashCanonicalJson({
    email: request.email,
    fingerprintVersion: IDENTITY_IDEMPOTENCY_FINGERPRINT_VERSION,
    schemaVersion: request.schemaVersion,
  });
}

export function hashIdentityVerificationIdempotencyRequest(
  request: CloudIdentityVerificationRequest,
  challengeCodeProofHmacSha256: string,
): string {
  return hashCanonicalJson({
    challengeCodeProofHmacSha256,
    challengeId: request.challengeId,
    device: request.device,
    fingerprintVersion: IDENTITY_IDEMPOTENCY_FINGERPRINT_VERSION,
    schemaVersion: request.schemaVersion,
  });
}

export function hashPasswordResetConfirmationIdempotencyRequest(
  request: CloudPasswordResetConfirmationRequest,
  challengeCodeProofHmacSha256: string,
): string {
  return hashCanonicalJson({
    challengeCodeProofHmacSha256,
    challengeId: request.challengeId,
    fingerprintVersion: IDENTITY_IDEMPOTENCY_FINGERPRINT_VERSION,
    schemaVersion: request.schemaVersion,
  });
}

export function hashAuthenticationIdempotencyRequest(request: CloudAuthenticationRequest): string {
  return hashCanonicalJson({
    device: request.device,
    email: request.email,
    fingerprintVersion: IDENTITY_IDEMPOTENCY_FINGERPRINT_VERSION,
    schemaVersion: request.schemaVersion,
  });
}

export function hashSessionRefreshIdempotencyRequest(
  request: CloudSessionRefreshRequest,
  sessionId: string,
): string {
  return hashCanonicalJson({
    deviceId: request.deviceId,
    fingerprintVersion: IDENTITY_IDEMPOTENCY_FINGERPRINT_VERSION,
    schemaVersion: request.schemaVersion,
    sessionId,
  });
}
