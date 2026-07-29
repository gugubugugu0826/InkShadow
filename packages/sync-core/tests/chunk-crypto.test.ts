import { describe, expect, it } from "vitest";

import {
  AesGcmChunkCipher,
  MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
  SYNC_OBJECT_TYPES,
  SyncCoreError,
  type SyncChunkAad,
} from "../src/index.js";

const AAD: SyncChunkAad = {
  projectId: "project-1",
  objectType: "chapter_version",
  objectId: "chapter-1",
  versionId: "version-1",
  chunkIndex: 0,
  keyVersion: 1,
};

describe("AES-GCM sync chunks", () => {
  it("supports encrypted project manifests for bootstrap discovery", () => {
    expect(SYNC_OBJECT_TYPES).toContain("project_manifest");
  });

  it("round-trips UTF-8 content with authenticated object metadata", async () => {
    const cipher = new AesGcmChunkCipher();
    const key = await cipher.generateProjectDataKey();
    const plaintext = new TextEncoder().encode("雾港正文只应以密文上传。");

    const encrypted = await cipher.encrypt(key, plaintext, AAD);
    const decrypted = await cipher.decrypt(key, encrypted, AAD);

    expect(encrypted).toMatchObject({
      schemaVersion: 1,
      algorithm: "AES-256-GCM",
      plaintextBytes: plaintext.byteLength,
      aad: AAD,
    });
    expect(new TextDecoder().decode(decrypted)).toBe("雾港正文只应以密文上传。");
    expect(encrypted.ciphertext).not.toContain("雾港");
  });

  it("uses a fresh 96-bit nonce for repeated plaintext", async () => {
    const cipher = new AesGcmChunkCipher();
    const key = await cipher.generateProjectDataKey();
    const plaintext = new TextEncoder().encode("相同正文");

    const first = await cipher.encrypt(key, plaintext, AAD);
    const second = await cipher.encrypt(key, plaintext, AAD);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects a different project, object, version, chunk, or key version as AAD mismatch", async () => {
    const cipher = new AesGcmChunkCipher();
    const key = await cipher.generateProjectDataKey();
    const encrypted = await cipher.encrypt(key, new TextEncoder().encode("正文"), AAD);

    await expect(
      cipher.decrypt(key, encrypted, { ...AAD, versionId: "version-2" }),
    ).rejects.toMatchObject({ code: "SYNC_CHUNK_METADATA_MISMATCH" });
  });

  it("detects transport tampering before attempting decryption", async () => {
    const cipher = new AesGcmChunkCipher();
    const key = await cipher.generateProjectDataKey();
    const encrypted = await cipher.encrypt(key, new TextEncoder().encode("正文"), AAD);
    const tampered = {
      ...encrypted,
      ciphertextSha256: "0".repeat(64),
    };

    await expect(cipher.decrypt(key, tampered, AAD)).rejects.toMatchObject({
      code: "SYNC_CHUNK_INTEGRITY_FAILED",
    });
  });

  it("detects authenticated ciphertext tampering even when the transport hash is changed", async () => {
    const cipher = new AesGcmChunkCipher();
    const key = await cipher.generateProjectDataKey();
    const encrypted = await cipher.encrypt(key, new TextEncoder().encode("正文"), AAD);
    const replacementKey = await cipher.generateProjectDataKey();

    await expect(cipher.decrypt(replacementKey, encrypted, AAD)).rejects.toMatchObject({
      code: "SYNC_CHUNK_INTEGRITY_FAILED",
    });
  });

  it("rejects oversized chunks and non-256-bit raw keys", async () => {
    const cipher = new AesGcmChunkCipher();
    await expect(cipher.importProjectDataKey(new Uint8Array(31))).rejects.toBeInstanceOf(
      SyncCoreError,
    );
    const key = await cipher.generateProjectDataKey();
    await expect(
      cipher.encrypt(key, new Uint8Array(MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES + 1), AAD),
    ).rejects.toMatchObject({ code: "SYNC_CHUNK_TOO_LARGE" });
  });
});
