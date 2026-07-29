import { describe, expect, it } from "vitest";

import { parseContentChecksum, parseIsoUtcTimestamp, parseUuidV7 } from "../src/index.js";

describe("shared value objects", () => {
  it("accepts UUIDv7 and rejects other UUID versions", () => {
    expect(parseUuidV7("018f0d7a-3b2c-7abc-8def-000000000001").ok).toBe(true);
    expect(parseUuidV7("018f0d7a-3b2c-4abc-8def-000000000001").ok).toBe(false);
  });

  it("requires UTC timestamps and SHA-256 checksums", () => {
    expect(parseIsoUtcTimestamp("2026-07-27T00:00:00.000Z").ok).toBe(true);
    expect(parseIsoUtcTimestamp("2026-07-27T10:00:00+10:00").ok).toBe(false);
    expect(parseContentChecksum("a".repeat(64)).ok).toBe(true);
    expect(parseContentChecksum("not-a-checksum").ok).toBe(false);
  });
});
