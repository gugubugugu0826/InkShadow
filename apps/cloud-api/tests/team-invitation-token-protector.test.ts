import { describe, expect, it } from "vitest";

import { Aes256GcmTeamInvitationTokenProtector } from "../src/security/team-invitation-token-protector.js";

const context = {
  deliveryId: "018f0d7a-3b2c-7abc-8def-000000000001",
  invitationId: "018f0d7a-3b2c-7abc-8def-000000000001",
  teamId: "018f0d7a-3b2c-7abc-8def-000000000002",
  tenantId: "018f0d7a-3b2c-7abc-8def-000000000003",
} as const;

describe("team invitation token protection", () => {
  it("uses AES-256-GCM with a key id and context-bound associated data", () => {
    const protector = new Aes256GcmTeamInvitationTokenProtector({
      keys: { "invite-key-2026-07": Buffer.alloc(32, 0x91) },
      primaryKeyId: "invite-key-2026-07",
      randomBytesImplementation: (size) => Buffer.alloc(size, 0x42),
    });
    const token = "T".repeat(43);
    const protectedToken = protector.protect(token, context);

    expect(protectedToken.encryptionKeyId).toBe("invite-key-2026-07");
    expect(protectedToken.nonce).toEqual(Buffer.alloc(12, 0x42));
    expect(protectedToken.authTag).toHaveLength(16);
    expect(protectedToken.ciphertext.toString("utf8")).not.toContain(token);
    expect(protector.unprotect(protectedToken, context)).toBe(token);
    expect(() =>
      protector.unprotect(protectedToken, {
        ...context,
        invitationId: "018f0d7a-3b2c-7abc-8def-000000000004",
      }),
    ).toThrow("could not be opened");
  });

  it("fails closed for tampering and unavailable rotation keys", () => {
    const originalProtector = new Aes256GcmTeamInvitationTokenProtector({
      keys: { original: Buffer.alloc(32, 0x92) },
      primaryKeyId: "original",
    });
    const protectedToken = originalProtector.protect("S".repeat(43), context);
    const tampered = {
      ...protectedToken,
      ciphertext: Buffer.from(protectedToken.ciphertext),
    };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 1;

    expect(() => originalProtector.unprotect(tampered, context)).toThrow("could not be opened");
    const rotatedProtector = new Aes256GcmTeamInvitationTokenProtector({
      keys: { replacement: Buffer.alloc(32, 0x93) },
      primaryKeyId: "replacement",
    });
    expect(() => rotatedProtector.unprotect(protectedToken, context)).toThrow("unavailable key");
  });

  it("rejects invalid key material, identifiers and token lengths", () => {
    expect(
      () =>
        new Aes256GcmTeamInvitationTokenProtector({
          keys: { short: Buffer.alloc(31) },
          primaryKeyId: "short",
        }),
    ).toThrow("exactly 32 bytes");
    expect(
      () =>
        new Aes256GcmTeamInvitationTokenProtector({
          keys: { configured: Buffer.alloc(32) },
          primaryKeyId: "missing",
        }),
    ).toThrow("not configured");

    const protector = new Aes256GcmTeamInvitationTokenProtector({
      keys: { configured: Buffer.alloc(32) },
      primaryKeyId: "configured",
    });
    expect(() => protector.protect("short", context)).toThrow("invalid length");
    expect(() =>
      protector.protect("T".repeat(43), {
        ...context,
        teamId: "bad\u001fcontext",
      }),
    ).toThrow("context is invalid");
  });
});
