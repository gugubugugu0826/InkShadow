import { parseUuidV7, type UuidV7 } from "@inkshadow/domain";

import { GuestWorkspaceError } from "../domain/guest-workspace-error";

export const WEB_GUEST_RECORD_FORMAT = "inkshadow.web.guest-project";
export const WEB_GUEST_RECORD_SCHEMA_VERSION = 1;
export const WEB_GUEST_CIPHER_ALGORITHM = "AES-256-GCM";
export const WEB_GUEST_KDF_ALGORITHM = "PBKDF2-SHA-256";
export const WEB_GUEST_KDF_ITERATIONS = 310_000;

export const WEB_GUEST_OBJECT_TYPES = ["project-key", "project", "chapter"] as const;
export type WebGuestObjectType = (typeof WEB_GUEST_OBJECT_TYPES)[number];

export interface CipherEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly algorithm: typeof WEB_GUEST_CIPHER_ALGORITHM;
  readonly projectId: UuidV7;
  readonly objectType: WebGuestObjectType;
  readonly objectId: UuidV7;
  readonly keyVersion: number;
  readonly contentVersion: number;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface RecoveryKdfV1 {
  readonly algorithm: typeof WEB_GUEST_KDF_ALGORITHM;
  readonly iterations: typeof WEB_GUEST_KDF_ITERATIONS;
  readonly salt: string;
}

export interface RecoveryEnvelopeV1 {
  readonly format: "inkshadow.web.recovery-envelope";
  readonly schemaVersion: 1;
  readonly kdf: RecoveryKdfV1;
  readonly keyEnvelope: CipherEnvelopeV1;
}

export interface EncryptedGuestProjectRecordV1 {
  readonly format: typeof WEB_GUEST_RECORD_FORMAT;
  readonly schemaVersion: typeof WEB_GUEST_RECORD_SCHEMA_VERSION;
  readonly projectId: UuidV7;
  readonly keyVersion: number;
  readonly recovery: RecoveryEnvelopeV1;
  readonly projectEnvelope: CipherEnvelopeV1;
  readonly chapterEnvelopes: readonly CipherEnvelopeV1[];
}

export interface EnvelopeBinding {
  readonly projectId: UuidV7;
  readonly objectType: WebGuestObjectType;
  readonly objectId: UuidV7;
  readonly keyVersion: number;
  readonly contentVersion: number;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function parseEncryptedGuestProjectRecord(value: unknown): EncryptedGuestProjectRecordV1 {
  if (!isRecord(value)) {
    throw invalidEnvelope();
  }

  const projectId = parseRequiredUuid(value.projectId);
  const keyVersion = parsePositiveInteger(value.keyVersion);
  if (
    value.format !== WEB_GUEST_RECORD_FORMAT ||
    value.schemaVersion !== WEB_GUEST_RECORD_SCHEMA_VERSION ||
    !isRecord(value.recovery) ||
    value.recovery.format !== "inkshadow.web.recovery-envelope" ||
    value.recovery.schemaVersion !== 1 ||
    !isRecord(value.recovery.kdf) ||
    value.recovery.kdf.algorithm !== WEB_GUEST_KDF_ALGORITHM ||
    value.recovery.kdf.iterations !== WEB_GUEST_KDF_ITERATIONS ||
    !isBase64Url(value.recovery.kdf.salt, 22) ||
    !Array.isArray(value.chapterEnvelopes) ||
    value.chapterEnvelopes.length === 0
  ) {
    throw invalidEnvelope();
  }

  const keyEnvelope = parseCipherEnvelope(value.recovery.keyEnvelope);
  const projectEnvelope = parseCipherEnvelope(value.projectEnvelope);
  const chapterEnvelopes = value.chapterEnvelopes.map(parseCipherEnvelope);

  assertEnvelopeBinding(keyEnvelope, {
    projectId,
    objectType: "project-key",
    objectId: projectId,
    keyVersion,
    contentVersion: keyVersion,
  });
  assertEnvelopeBinding(projectEnvelope, {
    projectId,
    objectType: "project",
    objectId: projectId,
    keyVersion,
    contentVersion: 1,
  });

  let previousVersion = 0;
  let chapterId: UuidV7 | null = null;
  for (const envelope of chapterEnvelopes) {
    if (
      envelope.projectId !== projectId ||
      envelope.objectType !== "chapter" ||
      envelope.keyVersion !== keyVersion ||
      envelope.contentVersion !== previousVersion + 1 ||
      (chapterId !== null && envelope.objectId !== chapterId)
    ) {
      throw invalidEnvelope();
    }
    chapterId = envelope.objectId;
    previousVersion = envelope.contentVersion;
  }

  const allNonces = [keyEnvelope, projectEnvelope, ...chapterEnvelopes].map(
    (envelope) => envelope.nonce,
  );
  if (new Set(allNonces).size !== allNonces.length) {
    throw invalidEnvelope();
  }

  return {
    format: WEB_GUEST_RECORD_FORMAT,
    schemaVersion: WEB_GUEST_RECORD_SCHEMA_VERSION,
    projectId,
    keyVersion,
    recovery: {
      format: "inkshadow.web.recovery-envelope",
      schemaVersion: 1,
      kdf: {
        algorithm: WEB_GUEST_KDF_ALGORITHM,
        iterations: WEB_GUEST_KDF_ITERATIONS,
        salt: value.recovery.kdf.salt,
      },
      keyEnvelope,
    },
    projectEnvelope,
    chapterEnvelopes,
  };
}

export function parseCipherEnvelope(value: unknown): CipherEnvelopeV1 {
  if (!isRecord(value)) {
    throw invalidEnvelope();
  }

  const projectId = parseRequiredUuid(value.projectId);
  const objectId = parseRequiredUuid(value.objectId);
  const keyVersion = parsePositiveInteger(value.keyVersion);
  const contentVersion = parsePositiveInteger(value.contentVersion);
  if (
    value.schemaVersion !== 1 ||
    value.algorithm !== WEB_GUEST_CIPHER_ALGORITHM ||
    !isWebGuestObjectType(value.objectType) ||
    !isBase64Url(value.nonce, 16) ||
    !isBase64Url(value.ciphertext)
  ) {
    throw invalidEnvelope();
  }

  return {
    schemaVersion: 1,
    algorithm: WEB_GUEST_CIPHER_ALGORITHM,
    projectId,
    objectType: value.objectType,
    objectId,
    keyVersion,
    contentVersion,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
  };
}

export function assertEnvelopeBinding(envelope: CipherEnvelopeV1, expected: EnvelopeBinding): void {
  if (
    envelope.projectId !== expected.projectId ||
    envelope.objectType !== expected.objectType ||
    envelope.objectId !== expected.objectId ||
    envelope.keyVersion !== expected.keyVersion ||
    envelope.contentVersion !== expected.contentVersion
  ) {
    throw new GuestWorkspaceError(
      "WEB_ENVELOPE_BINDING_MISMATCH",
      "密文不属于所请求的项目、对象或版本，已拒绝解密。",
    );
  }
}

export function appendChapterEnvelope(
  record: EncryptedGuestProjectRecordV1,
  expectedContentVersion: number,
  envelope: CipherEnvelopeV1,
): EncryptedGuestProjectRecordV1 {
  const latest = record.chapterEnvelopes.at(-1);
  if (
    latest?.contentVersion !== expectedContentVersion ||
    envelope.contentVersion !== expectedContentVersion + 1
  ) {
    throw new GuestWorkspaceError(
      "WEB_REVISION_CONFLICT",
      "浏览器中的章节版本已变化。请重新解锁后再保存。",
      true,
    );
  }

  assertEnvelopeBinding(envelope, {
    projectId: record.projectId,
    objectType: "chapter",
    objectId: latest.objectId,
    keyVersion: record.keyVersion,
    contentVersion: expectedContentVersion + 1,
  });

  const updated = {
    ...record,
    chapterEnvelopes: [...record.chapterEnvelopes, envelope],
  };
  return parseEncryptedGuestProjectRecord(updated);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequiredUuid(value: unknown): UuidV7 {
  if (typeof value !== "string") {
    throw invalidEnvelope();
  }
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw invalidEnvelope();
  }
  return parsed.value;
}

function parsePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
    throw invalidEnvelope();
  }
  return value;
}

function isWebGuestObjectType(value: unknown): value is WebGuestObjectType {
  return typeof value === "string" && WEB_GUEST_OBJECT_TYPES.includes(value as WebGuestObjectType);
}

function isBase64Url(value: unknown, exactLength?: number): value is string {
  return (
    typeof value === "string" &&
    (exactLength === undefined || value.length === exactLength) &&
    value.length > 0 &&
    BASE64URL_PATTERN.test(value)
  );
}

function invalidEnvelope(): GuestWorkspaceError {
  return new GuestWorkspaceError(
    "WEB_ENVELOPE_INVALID",
    "浏览器中的加密项目格式无效或已损坏，未读取任何正文。",
  );
}
