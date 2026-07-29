import { createHmac, timingSafeEqual } from "node:crypto";

import { UuidV7Schema } from "@inkshadow/contracts";

import type { CloudPageAnchor } from "../domain/records.js";

const SIGNATURE_BYTES = 32;

export type CloudPageCursorKind =
  | "ai_usage_events"
  | "devices"
  | "project_assignments"
  | "review_thread_items"
  | "review_threads"
  | "reviews"
  | "sessions"
  | "team_members"
  | "team_template_versions"
  | "team_templates"
  | "teams";

export class InvalidPageCursorError extends Error {
  public constructor() {
    super("The page cursor is invalid.");
    this.name = "InvalidPageCursorError";
  }
}

export class CloudPageCursorCodec {
  private readonly key: Buffer;

  public constructor(key: Uint8Array) {
    this.key = Buffer.from(key);
    if (this.key.length < 32 || this.key.length > 64) {
      this.key.fill(0);
      throw new Error("The page-cursor key must contain between 32 and 64 bytes.");
    }
  }

  public encode(kind: CloudPageCursorKind, anchor: CloudPageAnchor): string {
    if (
      !Number.isSafeInteger(anchor.createdAt.getTime()) ||
      !UuidV7Schema.safeParse(anchor.id).success
    ) {
      throw new Error("The page anchor is invalid.");
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

  public decode(kind: CloudPageCursorKind, cursor: string): CloudPageAnchor {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(cursor)) {
      throw new InvalidPageCursorError();
    }
    const combined = Buffer.from(cursor, "base64url");
    if (combined.length <= SIGNATURE_BYTES) {
      combined.fill(0);
      throw new InvalidPageCursorError();
    }
    const payload = Buffer.from(combined.subarray(0, -SIGNATURE_BYTES));
    const suppliedSignature = Buffer.from(combined.subarray(-SIGNATURE_BYTES));
    const expectedSignature = this.sign(payload);
    combined.fill(0);
    try {
      if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
        throw new InvalidPageCursorError();
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
        throw new InvalidPageCursorError();
      }
      const createdAt = new Date(createdAtText);
      if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== createdAtText) {
        throw new InvalidPageCursorError();
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
      .update("inkshadow/cloud/page-cursor/v1\0", "utf8")
      .update(payload)
      .digest();
  }
}
