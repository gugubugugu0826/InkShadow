import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface CloudSecretKeySet {
  readonly challengeCodeKey: Uint8Array;
  readonly challengeHashKey: Uint8Array;
  readonly sessionTokenKey: Uint8Array;
}

export type SessionTokenKind = "access" | "refresh";

export class CloudTokenService {
  private readonly challengeCodeKey: Buffer;
  private readonly challengeHashKey: Buffer;
  private readonly sessionTokenKey: Buffer;

  public constructor(keys: CloudSecretKeySet) {
    this.challengeCodeKey = copySecretKey(keys.challengeCodeKey, "challenge-code");
    this.challengeHashKey = copySecretKey(keys.challengeHashKey, "challenge-hash");
    this.sessionTokenKey = copySecretKey(keys.sessionTokenKey, "session-token");
  }

  public deriveChallengeCode(challengeId: string): string {
    const digest = createHmac("sha256", this.challengeCodeKey)
      .update("inkshadow/cloud/challenge-code/v1\0", "utf8")
      .update(challengeId, "utf8")
      .digest();
    try {
      const value = digest.readBigUInt64BE(0) % 1_000_000n;
      return value.toString().padStart(6, "0");
    } finally {
      digest.fill(0);
    }
  }

  public hashChallengeCode(challengeId: string, code: string): string {
    return createHmac("sha256", this.challengeHashKey)
      .update("inkshadow/cloud/challenge-hash/v1\0", "utf8")
      .update(challengeId, "utf8")
      .update("\0", "utf8")
      .update(code, "utf8")
      .digest("hex");
  }

  public verifyChallengeCode(challengeId: string, code: string, expectedHash: string): boolean {
    if (!/^[a-f0-9]{64}$/u.test(expectedHash)) {
      return false;
    }
    const actual = Buffer.from(this.hashChallengeCode(challengeId, code), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    try {
      return timingSafeEqual(actual, expected);
    } finally {
      actual.fill(0);
      expected.fill(0);
    }
  }

  public deriveSessionToken(
    kind: SessionTokenKind,
    sessionId: string,
    refreshGeneration: number,
  ): string {
    if (!Number.isSafeInteger(refreshGeneration) || refreshGeneration <= 0) {
      throw new Error("Refresh generation must be a positive integer.");
    }
    const digest = createHmac("sha256", this.sessionTokenKey)
      .update("inkshadow/cloud/session-token/v1\0", "utf8")
      .update(kind, "utf8")
      .update("\0", "utf8")
      .update(sessionId, "utf8")
      .update("\0", "utf8")
      .update(String(refreshGeneration), "utf8")
      .digest("base64url");
    return `isk_${kind === "access" ? "at" : "rt"}_${digest}`;
  }

  public hashBearerToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }
}

export function parseBase64UrlSecret(name: string, value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${name} must be unpadded base64url.`);
  }
  const secret = Buffer.from(value, "base64url");
  if (secret.length < 32 || secret.length > 64) {
    secret.fill(0);
    throw new Error(`${name} must decode to between 32 and 64 bytes.`);
  }
  return secret;
}

function copySecretKey(source: Uint8Array, label: string): Buffer {
  const copy = Buffer.from(source);
  if (copy.length < 32 || copy.length > 64) {
    copy.fill(0);
    throw new Error(`The ${label} key must contain between 32 and 64 bytes.`);
  }
  return copy;
}
