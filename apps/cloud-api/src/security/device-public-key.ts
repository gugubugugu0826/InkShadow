import { createHash, ECDH, timingSafeEqual } from "node:crypto";

export function verifyDevicePublicKey(options: {
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
}): boolean {
  if (
    !/^[A-Za-z0-9_-]{87}$/u.test(options.publicKey) ||
    !/^[a-f0-9]{64}$/u.test(options.publicKeyFingerprint)
  ) {
    return false;
  }
  const publicKey = Buffer.from(options.publicKey, "base64url");
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    publicKey.fill(0);
    return false;
  }
  try {
    const normalized = ECDH.convertKey(
      publicKey,
      "prime256v1",
      undefined,
      undefined,
      "uncompressed",
    );
    const expected = Buffer.from(options.publicKeyFingerprint, "hex");
    const actual = createHash("sha256").update(normalized).digest();
    try {
      return timingSafeEqual(actual, expected);
    } finally {
      actual.fill(0);
      expected.fill(0);
      normalized.fill(0);
    }
  } catch {
    return false;
  } finally {
    publicKey.fill(0);
  }
}
