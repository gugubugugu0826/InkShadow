import { createECDH, createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { hashCanonicalJson } from "../src/security/canonical-hash.js";
import { verifyDevicePublicKey } from "../src/security/device-public-key.js";

const KEY = Buffer.alloc(32, 0x51);

describe("cloud security boundaries", () => {
  it("hashes JSON independently of object key insertion order", () => {
    expect(hashCanonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashCanonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it("validates a P-256 device key and its exact fingerprint", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const publicKey = ecdh.getPublicKey(undefined, "uncompressed");
    const encoded = publicKey.toString("base64url");
    const fingerprint = createHash("sha256").update(publicKey).digest("hex");

    expect(verifyDevicePublicKey({ publicKey: encoded, publicKeyFingerprint: fingerprint })).toBe(
      true,
    );
    expect(
      verifyDevicePublicKey({
        publicKey: encoded,
        publicKeyFingerprint: "00".repeat(32),
      }),
    ).toBe(false);
  });

  it("binds page cursors to their collection and rejects tampering", () => {
    const codec = new CloudPageCursorCodec(KEY);
    const anchor = {
      createdAt: new Date("2026-07-27T10:00:00.000Z"),
      id: "018f0d7a-3b2c-7abc-8def-000000000001",
    };
    const cursor = codec.encode("devices", anchor);

    expect(codec.decode("devices", cursor)).toEqual(anchor);
    expect(() => codec.decode("sessions", cursor)).toThrow("invalid");
    expect(() => codec.decode("devices", `${cursor.slice(0, -1)}A`)).toThrow("invalid");
  });

  it("binds both encrypted team-template cursor kinds without changing cursor semantics", () => {
    const codec = new CloudPageCursorCodec(KEY);
    const anchor = {
      createdAt: new Date("2026-07-28T10:00:00.000Z"),
      id: "019f9f4a-b3c7-7350-9226-000000000001",
    };
    const templates = codec.encode("team_templates", anchor);
    const versions = codec.encode("team_template_versions", anchor);

    expect(codec.decode("team_templates", templates)).toEqual(anchor);
    expect(codec.decode("team_template_versions", versions)).toEqual(anchor);
    expect(() => codec.decode("team_template_versions", templates)).toThrow("invalid");
    expect(() => codec.decode("team_templates", versions)).toThrow("invalid");
  });
});
