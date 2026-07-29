import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TOKEN_MAXIMUM_BYTES = 1_024;
const TOKEN_MINIMUM_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface TeamInvitationTokenContext {
  readonly deliveryId: string;
  readonly invitationId: string;
  readonly teamId: string;
  readonly tenantId: string;
}

export interface ProtectedTeamInvitationToken {
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
  readonly encryptionKeyId: string;
  readonly nonce: Buffer;
}

export interface TeamInvitationTokenProtector {
  protect(token: string, context: TeamInvitationTokenContext): ProtectedTeamInvitationToken;
  unprotect(
    protectedToken: ProtectedTeamInvitationToken,
    context: TeamInvitationTokenContext,
  ): string;
}

export interface Aes256GcmTeamInvitationTokenProtectorOptions {
  readonly keys: Readonly<Record<string, Uint8Array>>;
  readonly primaryKeyId: string;
  readonly randomBytesImplementation?: (size: number) => Buffer;
}

export class Aes256GcmTeamInvitationTokenProtector implements TeamInvitationTokenProtector {
  private readonly keys = new Map<string, KeyObject>();
  private readonly primaryKeyId: string;
  private readonly randomBytesImplementation: (size: number) => Buffer;

  public constructor(options: Aes256GcmTeamInvitationTokenProtectorOptions) {
    requireKeyId(options.primaryKeyId);
    for (const [keyId, source] of Object.entries(options.keys)) {
      requireKeyId(keyId);
      if (source.byteLength !== KEY_BYTES) {
        throw new Error("Every team-invitation encryption key must contain exactly 32 bytes.");
      }
      const material = Buffer.from(source);
      try {
        this.keys.set(keyId, createSecretKey(material));
      } finally {
        material.fill(0);
      }
    }
    if (!this.keys.has(options.primaryKeyId)) {
      throw new Error("The primary team-invitation encryption key is not configured.");
    }
    this.primaryKeyId = options.primaryKeyId;
    this.randomBytesImplementation = options.randomBytesImplementation ?? randomBytes;
  }

  public protect(token: string, context: TeamInvitationTokenContext): ProtectedTeamInvitationToken {
    requireContext(context);
    const plaintext = Buffer.from(token, "utf8");
    if (plaintext.byteLength < TOKEN_MINIMUM_BYTES || plaintext.byteLength > TOKEN_MAXIMUM_BYTES) {
      plaintext.fill(0);
      throw new Error("The team-invitation token has an invalid length.");
    }
    const nonce = this.randomBytesImplementation(NONCE_BYTES);
    if (nonce.byteLength !== NONCE_BYTES) {
      plaintext.fill(0);
      nonce.fill(0);
      throw new Error("The team-invitation nonce generator returned an invalid value.");
    }
    try {
      const cipher = createCipheriv("aes-256-gcm", this.requireKey(this.primaryKeyId), nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(createAssociatedData(context), {
        plaintextLength: plaintext.byteLength,
      });
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return {
        authTag,
        ciphertext,
        encryptionKeyId: this.primaryKeyId,
        nonce: Buffer.from(nonce),
      };
    } finally {
      plaintext.fill(0);
      nonce.fill(0);
    }
  }

  public unprotect(
    protectedToken: ProtectedTeamInvitationToken,
    context: TeamInvitationTokenContext,
  ): string {
    requireContext(context);
    if (
      protectedToken.nonce.byteLength !== NONCE_BYTES ||
      protectedToken.authTag.byteLength !== AUTH_TAG_BYTES ||
      protectedToken.ciphertext.byteLength < TOKEN_MINIMUM_BYTES ||
      protectedToken.ciphertext.byteLength > TOKEN_MAXIMUM_BYTES
    ) {
      throw new Error("The protected team-invitation token is invalid.");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.requireKey(protectedToken.encryptionKeyId),
      protectedToken.nonce,
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(createAssociatedData(context), {
      plaintextLength: protectedToken.ciphertext.byteLength,
    });
    decipher.setAuthTag(protectedToken.authTag);
    let plaintext: Buffer | null = null;
    try {
      plaintext = Buffer.concat([decipher.update(protectedToken.ciphertext), decipher.final()]);
      return plaintext.toString("utf8");
    } catch {
      throw new Error("The protected team-invitation token could not be opened.");
    } finally {
      plaintext?.fill(0);
    }
  }

  private requireKey(keyId: string): KeyObject {
    requireKeyId(keyId);
    const key = this.keys.get(keyId);
    if (key === undefined) {
      throw new Error("The protected team-invitation token uses an unavailable key.");
    }
    return key;
  }
}

function createAssociatedData(context: TeamInvitationTokenContext): Buffer {
  return Buffer.from(
    [
      "inkshadow.team-invitation-token.v1",
      context.tenantId,
      context.teamId,
      context.invitationId,
      context.deliveryId,
    ].join("\u001f"),
    "utf8",
  );
}

function requireContext(context: TeamInvitationTokenContext): void {
  for (const value of [
    context.deliveryId,
    context.invitationId,
    context.teamId,
    context.tenantId,
  ]) {
    if (value.length === 0 || value.length > 128 || /[\u001f\r\n]/u.test(value)) {
      throw new Error("The team-invitation token context is invalid.");
    }
  }
}

function requireKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("The team-invitation encryption key id is invalid.");
  }
}
