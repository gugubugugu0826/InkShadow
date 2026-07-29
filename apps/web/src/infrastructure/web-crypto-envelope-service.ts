import type { UuidV7 } from "@inkshadow/domain";

import {
  WEB_GUEST_CIPHER_ALGORITHM,
  WEB_GUEST_KDF_ALGORITHM,
  WEB_GUEST_KDF_ITERATIONS,
  assertEnvelopeBinding,
  type CipherEnvelopeV1,
  type EnvelopeBinding,
  type RecoveryEnvelopeV1,
} from "../contracts/encrypted-guest-project";
import { GuestWorkspaceError } from "../domain/guest-workspace-error";

const AES_GCM_NONCE_BYTES = 12;
const AES_256_KEY_BYTES = 32;
const RECOVERY_SALT_BYTES = 16;
const RECOVERY_MATERIAL_BYTES = 32;
const AES_GCM_TAG_BITS = 128;
const MAX_NONCE_GENERATION_ATTEMPTS = 8;
const ENVELOPE_AAD_DOMAIN = "inkshadow.web.guest-envelope.v1";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface CreatedProjectKey {
  readonly projectKey: CryptoKey;
  readonly recoveryMaterial: string;
  readonly recovery: RecoveryEnvelopeV1;
}

export class WebCryptoEnvelopeService {
  private readonly issuedNonces = new Set<string>();

  public constructor(private readonly cryptoProvider: Crypto = requireWebCrypto()) {}

  public async createProjectKey(projectId: UuidV7, keyVersion: number): Promise<CreatedProjectKey> {
    let rawProjectKey: Uint8Array<ArrayBuffer> | null = null;
    let recoveryBytes: Uint8Array<ArrayBuffer> | null = null;
    let salt: Uint8Array<ArrayBuffer> | null = null;

    try {
      rawProjectKey = this.randomBytes(AES_256_KEY_BYTES);
      recoveryBytes = this.randomBytes(RECOVERY_MATERIAL_BYTES);
      salt = this.randomBytes(RECOVERY_SALT_BYTES);
      const projectKey = await this.cryptoProvider.subtle.importKey(
        "raw",
        rawProjectKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      assertNonExtractableAesGcmKey(projectKey);

      const recoveryKey = await this.deriveRecoveryKey(recoveryBytes, salt);
      const keyEnvelope = await this.encryptBytes(
        recoveryKey,
        {
          projectId,
          objectType: "project-key",
          objectId: projectId,
          keyVersion,
          contentVersion: keyVersion,
        },
        rawProjectKey,
      );

      return {
        projectKey,
        recoveryMaterial: encodeBase64Url(recoveryBytes),
        recovery: {
          format: "inkshadow.web.recovery-envelope",
          schemaVersion: 1,
          kdf: {
            algorithm: WEB_GUEST_KDF_ALGORITHM,
            iterations: WEB_GUEST_KDF_ITERATIONS,
            salt: encodeBase64Url(salt),
          },
          keyEnvelope,
        },
      };
    } catch (error) {
      if (error instanceof GuestWorkspaceError) {
        throw error;
      }
      throw new GuestWorkspaceError(
        "WEB_CRYPTO_UNAVAILABLE",
        "浏览器无法建立不可导出的 AES-256-GCM 项目密钥。",
      );
    } finally {
      rawProjectKey?.fill(0);
      recoveryBytes?.fill(0);
      salt?.fill(0);
    }
  }

  public async unlockProjectKey(
    projectId: UuidV7,
    keyVersion: number,
    recovery: RecoveryEnvelopeV1,
    recoveryMaterial: string,
  ): Promise<CryptoKey> {
    const recoveryBytes = decodeRecoveryMaterial(recoveryMaterial);
    let salt: Uint8Array<ArrayBuffer> | null = null;
    let rawProjectKey: Uint8Array<ArrayBuffer> | null = null;

    try {
      salt = decodeBase64Url(recovery.kdf.salt);
      const recoveryKey = await this.deriveRecoveryKey(recoveryBytes, salt);
      const decrypted = await this.decryptBytes(recoveryKey, recovery.keyEnvelope, {
        projectId,
        objectType: "project-key",
        objectId: projectId,
        keyVersion,
        contentVersion: keyVersion,
      });
      if (decrypted.byteLength !== AES_256_KEY_BYTES) {
        throw new GuestWorkspaceError(
          "WEB_ENVELOPE_AUTHENTICATION_FAILED",
          "恢复材料无法验证此项目，项目仍保持锁定。",
        );
      }

      rawProjectKey = decrypted;
      const projectKey = await this.cryptoProvider.subtle.importKey(
        "raw",
        rawProjectKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      assertNonExtractableAesGcmKey(projectKey);
      return projectKey;
    } finally {
      recoveryBytes.fill(0);
      salt?.fill(0);
      rawProjectKey?.fill(0);
    }
  }

  public async encryptJson(
    key: CryptoKey,
    binding: EnvelopeBinding,
    value: unknown,
  ): Promise<CipherEnvelopeV1> {
    assertNonExtractableAesGcmKey(key);
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    try {
      return await this.encryptBytes(key, binding, encoded);
    } finally {
      encoded.fill(0);
    }
  }

  public async decryptJson(
    key: CryptoKey,
    envelope: CipherEnvelopeV1,
    expected: EnvelopeBinding,
  ): Promise<unknown> {
    assertNonExtractableAesGcmKey(key);
    const decrypted = await this.decryptBytes(key, envelope, expected);
    try {
      const json = new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
      return JSON.parse(json) as unknown;
    } catch {
      throw new GuestWorkspaceError(
        "WEB_ENVELOPE_INVALID",
        "解密后的项目数据格式无效，未载入任何正文。",
      );
    } finally {
      decrypted.fill(0);
    }
  }

  private async encryptBytes(
    key: CryptoKey,
    binding: EnvelopeBinding,
    plaintext: Uint8Array<ArrayBuffer>,
  ): Promise<CipherEnvelopeV1> {
    const nonce = this.uniqueNonce();
    const envelopeMetadata: Omit<CipherEnvelopeV1, "ciphertext"> = {
      schemaVersion: 1,
      algorithm: WEB_GUEST_CIPHER_ALGORITHM,
      ...binding,
      nonce: encodeBase64Url(nonce),
    };
    const additionalData = encodeAad(envelopeMetadata);

    try {
      const ciphertext = await this.cryptoProvider.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData,
          tagLength: AES_GCM_TAG_BITS,
        },
        key,
        plaintext,
      );
      return {
        ...envelopeMetadata,
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      };
    } catch {
      throw new GuestWorkspaceError(
        "WEB_ENVELOPE_AUTHENTICATION_FAILED",
        "浏览器无法加密项目数据，未写入不完整记录。",
        true,
      );
    } finally {
      nonce.fill(0);
      additionalData.fill(0);
    }
  }

  private async decryptBytes(
    key: CryptoKey,
    envelope: CipherEnvelopeV1,
    expected: EnvelopeBinding,
  ): Promise<Uint8Array<ArrayBuffer>> {
    assertEnvelopeBinding(envelope, expected);
    const nonce = decodeBase64Url(envelope.nonce);
    const ciphertext = decodeBase64Url(envelope.ciphertext);
    const additionalData = encodeAad(envelope);

    try {
      const plaintext = await this.cryptoProvider.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData,
          tagLength: AES_GCM_TAG_BITS,
        },
        key,
        ciphertext,
      );
      return new Uint8Array(plaintext);
    } catch {
      throw new GuestWorkspaceError(
        "WEB_ENVELOPE_AUTHENTICATION_FAILED",
        "恢复材料错误，或密文已被篡改。项目仍保持锁定。",
      );
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      additionalData.fill(0);
    }
  }

  private async deriveRecoveryKey(
    recoveryBytes: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
  ): Promise<CryptoKey> {
    try {
      const material = await this.cryptoProvider.subtle.importKey(
        "raw",
        recoveryBytes,
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      return await this.cryptoProvider.subtle.deriveKey(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          iterations: WEB_GUEST_KDF_ITERATIONS,
          salt,
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    } catch {
      throw new GuestWorkspaceError(
        "WEB_CRYPTO_UNAVAILABLE",
        "当前浏览器无法安全派生恢复密钥，请升级浏览器后重试。",
      );
    }
  }

  private uniqueNonce(): Uint8Array<ArrayBuffer> {
    for (let attempt = 0; attempt < MAX_NONCE_GENERATION_ATTEMPTS; attempt += 1) {
      const nonce = this.randomBytes(AES_GCM_NONCE_BYTES);
      const encoded = encodeBase64Url(nonce);
      if (!this.issuedNonces.has(encoded)) {
        this.issuedNonces.add(encoded);
        return nonce;
      }
      nonce.fill(0);
    }
    throw new GuestWorkspaceError(
      "WEB_CRYPTO_UNAVAILABLE",
      "浏览器未能生成唯一加密 nonce，已停止保存。",
    );
  }

  private randomBytes(length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length);
    try {
      this.cryptoProvider.getRandomValues(bytes);
      return bytes;
    } catch {
      bytes.fill(0);
      throw new GuestWorkspaceError(
        "WEB_CRYPTO_UNAVAILABLE",
        "浏览器安全随机数生成器不可用，已停止创建或保存。",
      );
    }
  }
}

function encodeAad(
  envelope: Pick<
    CipherEnvelopeV1,
    | "schemaVersion"
    | "algorithm"
    | "projectId"
    | "objectType"
    | "objectId"
    | "keyVersion"
    | "contentVersion"
    | "nonce"
  >,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      domain: ENVELOPE_AAD_DOMAIN,
      schemaVersion: envelope.schemaVersion,
      algorithm: envelope.algorithm,
      projectId: envelope.projectId,
      objectType: envelope.objectType,
      objectId: envelope.objectId,
      keyVersion: envelope.keyVersion,
      contentVersion: envelope.contentVersion,
      nonce: envelope.nonce,
    }),
  );
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new GuestWorkspaceError(
      "WEB_ENVELOPE_INVALID",
      "加密 envelope 使用了无效编码，未尝试解密。",
    );
  }

  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = globalThis.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (encodeBase64Url(bytes) !== value) {
      bytes.fill(0);
      throw new GuestWorkspaceError(
        "WEB_ENVELOPE_INVALID",
        "加密 envelope 使用了非规范 Base64URL 编码，未尝试解密。",
      );
    }
    return bytes;
  } catch {
    throw new GuestWorkspaceError(
      "WEB_ENVELOPE_INVALID",
      "加密 envelope 使用了无效编码，未尝试解密。",
    );
  }
}

function decodeRecoveryMaterial(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decodeBase64Url(normalized);
  } catch {
    throw new GuestWorkspaceError(
      "WEB_RECOVERY_MATERIAL_INVALID",
      "恢复材料格式不正确。请粘贴创建项目时保存的完整内容。",
    );
  }
  if (bytes.byteLength !== RECOVERY_MATERIAL_BYTES) {
    bytes.fill(0);
    throw new GuestWorkspaceError(
      "WEB_RECOVERY_MATERIAL_INVALID",
      "恢复材料格式不正确。请粘贴创建项目时保存的完整内容。",
    );
  }
  return bytes;
}

function assertNonExtractableAesGcmKey(key: CryptoKey): void {
  if (
    key.extractable ||
    key.type !== "secret" ||
    key.algorithm.name !== "AES-GCM" ||
    Reflect.get(key.algorithm, "length") !== 256 ||
    !key.usages.includes("encrypt") ||
    !key.usages.includes("decrypt")
  ) {
    throw new GuestWorkspaceError(
      "WEB_CRYPTO_UNAVAILABLE",
      "项目密钥未满足不可导出的 AES-GCM 会话密钥要求。",
    );
  }
}

function requireWebCrypto(): Crypto {
  const provider: unknown = Reflect.get(globalThis, "crypto");
  if (
    typeof provider !== "object" ||
    provider === null ||
    !("getRandomValues" in provider) ||
    typeof provider.getRandomValues !== "function" ||
    !("subtle" in provider) ||
    typeof provider.subtle !== "object" ||
    provider.subtle === null ||
    !hasCryptoFunction(provider.subtle, "importKey") ||
    !hasCryptoFunction(provider.subtle, "deriveKey") ||
    !hasCryptoFunction(provider.subtle, "encrypt") ||
    !hasCryptoFunction(provider.subtle, "decrypt")
  ) {
    throw new GuestWorkspaceError(
      "WEB_CRYPTO_UNAVAILABLE",
      "当前浏览器不支持安全 WebCrypto，无法打开 Guest 工作区。",
    );
  }
  return provider as Crypto;
}

function hasCryptoFunction(provider: object, name: string): boolean {
  return typeof Reflect.get(provider, name) === "function";
}
