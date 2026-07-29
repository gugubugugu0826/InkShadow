import { createHmac, timingSafeEqual } from "node:crypto";

import { UuidV7Schema } from "@inkshadow/contracts";

const SIGNATURE_BYTES = 32;
const MAX_CURSOR_CHARACTERS = 512;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export interface SyncSnapshotCursor {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly highWaterSequence: bigint;
  readonly afterSequence: bigint;
  readonly compactionEpoch: bigint;
  readonly minimumAvailableSequence: bigint;
  readonly expiresAt: Date;
}

interface EncodedSyncSnapshotCursor {
  readonly v: 1;
  readonly p: string;
  readonly s: string;
  readonly h: string;
  readonly a: string;
  readonly e: string;
  readonly f: string;
  readonly x: string;
}

export class InvalidSyncSnapshotCursorError extends Error {
  public constructor() {
    super("The sync snapshot cursor is invalid or expired.");
    this.name = "InvalidSyncSnapshotCursorError";
  }
}

export class SyncSnapshotCursorCodec {
  private readonly key: Buffer;

  public constructor(key: Uint8Array) {
    this.key = Buffer.from(key);
    if (this.key.length < 32 || this.key.length > 64) {
      this.key.fill(0);
      throw new Error("The sync-snapshot cursor key must contain between 32 and 64 bytes.");
    }
  }

  public encode(cursor: SyncSnapshotCursor): string {
    assertCursor(cursor);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        p: cursor.projectId,
        s: cursor.snapshotId,
        h: cursor.highWaterSequence.toString(),
        a: cursor.afterSequence.toString(),
        e: cursor.compactionEpoch.toString(),
        f: cursor.minimumAvailableSequence.toString(),
        x: cursor.expiresAt.toISOString(),
      } satisfies EncodedSyncSnapshotCursor),
      "utf8",
    );
    const signature = this.sign(payload);
    try {
      const encoded = Buffer.concat([payload, signature]).toString("base64url");
      if (encoded.length > MAX_CURSOR_CHARACTERS) {
        throw new Error("The sync-snapshot cursor exceeds the public API limit.");
      }
      return encoded;
    } finally {
      payload.fill(0);
      signature.fill(0);
    }
  }

  public decode(cursor: string, expectedProjectId: string, now: Date): SyncSnapshotCursor {
    if (
      !/^[A-Za-z0-9_-]{1,512}$/u.test(cursor) ||
      !UuidV7Schema.safeParse(expectedProjectId).success ||
      !Number.isFinite(now.getTime())
    ) {
      throw new InvalidSyncSnapshotCursorError();
    }
    const combined = Buffer.from(cursor, "base64url");
    if (combined.length <= SIGNATURE_BYTES) {
      combined.fill(0);
      throw new InvalidSyncSnapshotCursorError();
    }
    const payload = Buffer.from(combined.subarray(0, -SIGNATURE_BYTES));
    const suppliedSignature = Buffer.from(combined.subarray(-SIGNATURE_BYTES));
    const expectedSignature = this.sign(payload);
    combined.fill(0);
    try {
      if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
        throw new InvalidSyncSnapshotCursorError();
      }
      const decoded = parsePayload(payload);
      if (decoded.projectId !== expectedProjectId || decoded.expiresAt.getTime() <= now.getTime()) {
        throw new InvalidSyncSnapshotCursorError();
      }
      return decoded;
    } finally {
      payload.fill(0);
      suppliedSignature.fill(0);
      expectedSignature.fill(0);
    }
  }

  private sign(payload: Buffer): Buffer {
    return createHmac("sha256", this.key)
      .update("inkshadow/cloud/sync-snapshot-cursor/v1\0", "utf8")
      .update(payload)
      .digest();
  }
}

function parsePayload(payload: Buffer): SyncSnapshotCursor {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    throw new InvalidSyncSnapshotCursorError();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "a,e,f,h,p,s,v,x"
  ) {
    throw new InvalidSyncSnapshotCursorError();
  }
  const record = value as Partial<Record<keyof EncodedSyncSnapshotCursor, unknown>>;
  if (
    record.v !== 1 ||
    typeof record.p !== "string" ||
    typeof record.s !== "string" ||
    typeof record.h !== "string" ||
    typeof record.a !== "string" ||
    typeof record.e !== "string" ||
    typeof record.f !== "string" ||
    typeof record.x !== "string"
  ) {
    throw new InvalidSyncSnapshotCursorError();
  }
  const expiresAt = new Date(record.x);
  if (
    ![record.h, record.a, record.e, record.f].every((item) => /^(0|[1-9]\d*)$/u.test(item)) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString() !== record.x
  ) {
    throw new InvalidSyncSnapshotCursorError();
  }
  let decoded: SyncSnapshotCursor;
  try {
    decoded = {
      projectId: record.p,
      snapshotId: record.s,
      highWaterSequence: BigInt(record.h),
      afterSequence: BigInt(record.a),
      compactionEpoch: BigInt(record.e),
      minimumAvailableSequence: BigInt(record.f),
      expiresAt,
    };
  } catch {
    throw new InvalidSyncSnapshotCursorError();
  }
  try {
    assertCursor(decoded);
  } catch {
    throw new InvalidSyncSnapshotCursorError();
  }
  return decoded;
}

function assertCursor(cursor: SyncSnapshotCursor): void {
  if (
    !UuidV7Schema.safeParse(cursor.projectId).success ||
    !UuidV7Schema.safeParse(cursor.snapshotId).success ||
    !isPostgresSequence(cursor.highWaterSequence) ||
    !isPostgresSequence(cursor.afterSequence) ||
    !isPostgresSequence(cursor.compactionEpoch) ||
    !isPostgresSequence(cursor.minimumAvailableSequence) ||
    cursor.afterSequence > cursor.highWaterSequence ||
    cursor.minimumAvailableSequence > cursor.highWaterSequence ||
    !Number.isFinite(cursor.expiresAt.getTime())
  ) {
    throw new Error("The sync-snapshot cursor payload is invalid.");
  }
}

function isPostgresSequence(value: bigint): boolean {
  return value >= 0n && value <= MAX_POSTGRES_BIGINT;
}
