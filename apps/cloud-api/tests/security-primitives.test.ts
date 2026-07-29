import { describe, expect, it } from "vitest";

import { UuidV7Schema } from "@inkshadow/contracts";

import { ScryptPasswordHasher } from "../src/security/passwords.js";
import { SyncCursorCodec } from "../src/security/sync-cursor.js";
import { SyncSnapshotCursorCodec } from "../src/security/sync-snapshot-cursor.js";
import { CloudTokenService, parseBase64UrlSecret } from "../src/security/tokens.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";

const TEST_KEY = Buffer.alloc(32, 0x42);

describe("cloud security primitives", () => {
  it("hashes passwords with a random salt and rejects malformed hashes", async () => {
    let seed = 0;
    const hasher = new ScryptPasswordHasher({
      cost: 1_024,
      maximumMemoryBytes: 16 * 1024 * 1024,
      fillRandom: (target) => {
        target.fill(seed);
        seed += 1;
      },
    });

    const first = await hasher.hash("correct horse battery staple");
    const second = await hasher.hash("correct horse battery staple");

    expect(first).not.toBe(second);
    await expect(hasher.verify("correct horse battery staple", first)).resolves.toBe(true);
    await expect(hasher.verify("incorrect password", first)).resolves.toBe(false);
    await expect(
      hasher.verify("correct horse battery staple", "not-a-password-hash"),
    ).resolves.toBe(false);
  });

  it("derives reproducible challenge codes and device-bound rotating tokens", () => {
    const tokens = new CloudTokenService({
      challengeCodeKey: TEST_KEY,
      challengeHashKey: Buffer.alloc(32, 0x43),
      sessionTokenKey: Buffer.alloc(32, 0x44),
    });
    const challengeId = "018f0d7a-3b2c-7abc-8def-000000000001";
    const sessionId = "018f0d7a-3b2c-7abc-8def-000000000002";
    const code = tokens.deriveChallengeCode(challengeId);
    const codeHash = tokens.hashChallengeCode(challengeId, code);

    expect(code).toMatch(/^\d{6}$/u);
    expect(tokens.verifyChallengeCode(challengeId, code, codeHash)).toBe(true);
    expect(tokens.verifyChallengeCode(challengeId, "000000", codeHash)).toBe(code === "000000");
    expect(tokens.deriveSessionToken("access", sessionId, 1)).not.toBe(
      tokens.deriveSessionToken("refresh", sessionId, 1),
    );
    expect(tokens.deriveSessionToken("refresh", sessionId, 1)).not.toBe(
      tokens.deriveSessionToken("refresh", sessionId, 2),
    );
    expect(tokens.hashBearerToken("secret")).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("signs opaque sync cursors and rejects tampering", () => {
    const codec = new SyncCursorCodec(TEST_KEY);
    const cursor = codec.encode(42n);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]{54}$/u);
    expect(codec.decode(cursor)).toBe(42n);
    expect(() => codec.decode(`${cursor.slice(0, -1)}A`)).toThrow("invalid");
    expect(() => codec.decode("42")).toThrow("invalid");
    const scoped = codec.encode(42n, "project-a");
    expect(codec.decode(scoped, "project-a")).toBe(42n);
    expect(() => codec.decode(scoped, "project-b")).toThrow("invalid");
  });

  it("binds snapshot cursors to one project, compaction epoch and expiry", () => {
    const codec = new SyncSnapshotCursorCodec(TEST_KEY);
    const projectId = "018f0d7a-3b2c-7abc-8def-000000000001";
    const snapshotId = "018f0d7a-3b2c-7abc-8def-000000000002";
    const now = new Date("2026-07-27T00:00:00.000Z");
    const expiresAt = new Date("2026-07-27T00:15:00.000Z");
    const cursor = codec.encode({
      projectId,
      snapshotId,
      highWaterSequence: 42n,
      afterSequence: 20n,
      compactionEpoch: 3n,
      minimumAvailableSequence: 10n,
      expiresAt,
    });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/u);
    expect(codec.decode(cursor, projectId, now)).toEqual({
      projectId,
      snapshotId,
      highWaterSequence: 42n,
      afterSequence: 20n,
      compactionEpoch: 3n,
      minimumAvailableSequence: 10n,
      expiresAt,
    });
    expect(() => codec.decode(cursor, "018f0d7a-3b2c-7abc-8def-000000000003", now)).toThrow(
      "invalid",
    );
    expect(() => codec.decode(cursor, projectId, expiresAt)).toThrow("expired");
    expect(() => codec.decode(`${cursor.slice(0, -1)}A`, projectId, now)).toThrow("invalid");
  });

  it("generates monotonic UUIDv7 values while the clock is stationary", () => {
    const factory = createMonotonicUuidV7Factory(
      () => 1_715_000_000_000,
      (target) => target.fill(0x11),
    );
    const first = factory();
    const second = factory();

    expect(UuidV7Schema.safeParse(first).success).toBe(true);
    expect(UuidV7Schema.safeParse(second).success).toBe(true);
    expect(first < second).toBe(true);
  });

  it("accepts only bounded base64url deployment secrets", () => {
    expect(parseBase64UrlSecret("TEST", TEST_KEY.toString("base64url"))).toHaveLength(32);
    expect(() => parseBase64UrlSecret("TEST", "not+base64")).toThrow("base64url");
    expect(() => parseBase64UrlSecret("TEST", Buffer.alloc(16).toString("base64url"))).toThrow(
      "between 32 and 64",
    );
  });
});
