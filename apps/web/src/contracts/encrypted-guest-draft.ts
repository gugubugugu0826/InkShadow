import { parseUuidV7, type UuidV7 } from "@inkshadow/domain";

import {
  assertEnvelopeBinding,
  parseCipherEnvelope,
  type CipherEnvelopeV1,
} from "./encrypted-guest-project";
import { GuestWorkspaceError } from "../domain/guest-workspace-error";

export const WEB_GUEST_DRAFT_FORMAT = "inkshadow.web.guest-draft";
export const WEB_GUEST_DRAFT_SCHEMA_VERSION = 1;

export interface EncryptedGuestDraftRecordV1 {
  readonly format: typeof WEB_GUEST_DRAFT_FORMAT;
  readonly schemaVersion: typeof WEB_GUEST_DRAFT_SCHEMA_VERSION;
  readonly projectId: UuidV7;
  readonly keyVersion: number;
  readonly baseContentVersion: number;
  readonly chapterEnvelope: CipherEnvelopeV1;
}

export function parseEncryptedGuestDraftRecord(value: unknown): EncryptedGuestDraftRecordV1 {
  if (!isRecord(value)) {
    throw invalidDraft();
  }

  const projectId = parseRequiredUuid(value.projectId);
  const keyVersion = parsePositiveInteger(value.keyVersion);
  const baseContentVersion = parsePositiveInteger(value.baseContentVersion);
  if (
    value.format !== WEB_GUEST_DRAFT_FORMAT ||
    value.schemaVersion !== WEB_GUEST_DRAFT_SCHEMA_VERSION
  ) {
    throw invalidDraft();
  }

  const chapterEnvelope = parseCipherEnvelope(value.chapterEnvelope);
  assertEnvelopeBinding(chapterEnvelope, {
    projectId,
    objectType: "chapter",
    objectId: chapterEnvelope.objectId,
    keyVersion,
    contentVersion: baseContentVersion + 1,
  });

  return {
    format: WEB_GUEST_DRAFT_FORMAT,
    schemaVersion: WEB_GUEST_DRAFT_SCHEMA_VERSION,
    projectId,
    keyVersion,
    baseContentVersion,
    chapterEnvelope,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequiredUuid(value: unknown): UuidV7 {
  if (typeof value !== "string") {
    throw invalidDraft();
  }
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw invalidDraft();
  }
  return parsed.value;
}

function parsePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidDraft();
  }
  return value;
}

function invalidDraft(): GuestWorkspaceError {
  return new GuestWorkspaceError(
    "WEB_ENVELOPE_INVALID",
    "临时恢复密文格式无效或已损坏，未读取其中的正文。",
  );
}
