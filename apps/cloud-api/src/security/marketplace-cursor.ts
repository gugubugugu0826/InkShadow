import { createHmac, timingSafeEqual } from "node:crypto";

import { UuidV7Schema } from "@inkshadow/contracts";

import type { CloudMarketplacePageAnchor } from "../domain/marketplace-records.js";

const SIGNATURE_BYTES = 32;

export type CloudMarketplaceCursorKind = "catalog" | "moderation_queue";

export class InvalidMarketplaceCursorError extends Error {
  public constructor() {
    super("The marketplace page cursor is invalid.");
    this.name = "InvalidMarketplaceCursorError";
  }
}

export class CloudMarketplaceCursorCodec {
  private readonly key: Buffer;

  public constructor(key: Uint8Array) {
    this.key = Buffer.from(key);
    if (this.key.length < 32 || this.key.length > 64) {
      this.key.fill(0);
      throw new Error("The marketplace cursor key must contain between 32 and 64 bytes.");
    }
  }

  public encode(kind: CloudMarketplaceCursorKind, anchor: CloudMarketplacePageAnchor): string {
    if (
      !Number.isSafeInteger(anchor.createdAt.getTime()) ||
      !UuidV7Schema.safeParse(anchor.id).success
    ) {
      throw new Error("The marketplace page anchor is invalid.");
    }
    const payload = Buffer.from(`${kind}\0${anchor.createdAt.toISOString()}\0${anchor.id}`, "utf8");
    const signature = this.sign(payload);
    try {
      return Buffer.concat([payload, signature]).toString("base64url");
    } finally {
      payload.fill(0);
      signature.fill(0);
    }
  }

  public decode(kind: CloudMarketplaceCursorKind, cursor: string): CloudMarketplacePageAnchor {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(cursor)) {
      throw new InvalidMarketplaceCursorError();
    }
    const combined = Buffer.from(cursor, "base64url");
    if (combined.length <= SIGNATURE_BYTES) {
      combined.fill(0);
      throw new InvalidMarketplaceCursorError();
    }
    const payload = Buffer.from(combined.subarray(0, -SIGNATURE_BYTES));
    const suppliedSignature = Buffer.from(combined.subarray(-SIGNATURE_BYTES));
    const expectedSignature = this.sign(payload);
    combined.fill(0);
    try {
      if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
        throw new InvalidMarketplaceCursorError();
      }
      const parts = payload.toString("utf8").split("\0");
      const suppliedKind = parts[0];
      const createdAtText = parts[1];
      const id = parts[2];
      if (
        parts.length !== 3 ||
        suppliedKind !== kind ||
        createdAtText === undefined ||
        id === undefined ||
        !UuidV7Schema.safeParse(id).success
      ) {
        throw new InvalidMarketplaceCursorError();
      }
      const createdAt = new Date(createdAtText);
      if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== createdAtText) {
        throw new InvalidMarketplaceCursorError();
      }
      return { createdAt, id };
    } finally {
      payload.fill(0);
      suppliedSignature.fill(0);
      expectedSignature.fill(0);
    }
  }

  private sign(payload: Buffer): Buffer {
    return createHmac("sha256", this.key)
      .update("inkshadow/cloud/marketplace-cursor/v1\0", "utf8")
      .update(payload)
      .digest();
  }
}
