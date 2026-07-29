import { createHmac, timingSafeEqual } from "node:crypto";

const CURSOR_BYTES = 40;
const SEQUENCE_BYTES = 8;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export class InvalidSyncCursorError extends Error {
  public constructor() {
    super("The sync cursor is invalid.");
    this.name = "InvalidSyncCursorError";
  }
}

export class SyncCursorCodec {
  private readonly key: Buffer;

  public constructor(key: Uint8Array) {
    this.key = Buffer.from(key);
    if (this.key.length < 32 || this.key.length > 64) {
      this.key.fill(0);
      throw new Error("The sync-cursor key must contain between 32 and 64 bytes.");
    }
  }

  public encode(sequence: bigint, scope = ""): string {
    if (sequence < 0n || sequence > MAX_POSTGRES_BIGINT) {
      throw new Error("The sync sequence is outside the PostgreSQL bigint range.");
    }
    const sequenceBytes = Buffer.alloc(SEQUENCE_BYTES);
    sequenceBytes.writeBigUInt64BE(sequence);
    const signature = this.sign(sequenceBytes, scope);
    try {
      return Buffer.concat([sequenceBytes, signature]).toString("base64url");
    } finally {
      sequenceBytes.fill(0);
      signature.fill(0);
    }
  }

  public decode(cursor: string, scope = ""): bigint {
    if (!/^[A-Za-z0-9_-]{54}$/u.test(cursor)) {
      throw new InvalidSyncCursorError();
    }
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length !== CURSOR_BYTES) {
      bytes.fill(0);
      throw new InvalidSyncCursorError();
    }
    const sequenceBytes = Buffer.from(bytes.subarray(0, SEQUENCE_BYTES));
    const suppliedSignature = Buffer.from(bytes.subarray(SEQUENCE_BYTES));
    const expectedSignature = this.sign(sequenceBytes, scope);
    bytes.fill(0);
    try {
      if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
        throw new InvalidSyncCursorError();
      }
      const sequence = sequenceBytes.readBigUInt64BE();
      if (sequence > MAX_POSTGRES_BIGINT) {
        throw new InvalidSyncCursorError();
      }
      return sequence;
    } finally {
      sequenceBytes.fill(0);
      suppliedSignature.fill(0);
      expectedSignature.fill(0);
    }
  }

  private sign(sequenceBytes: Buffer, scope: string): Buffer {
    return createHmac("sha256", this.key)
      .update("inkshadow/cloud/sync-cursor/v1\0", "utf8")
      .update(scope, "utf8")
      .update("\0", "utf8")
      .update(sequenceBytes)
      .digest();
  }
}
