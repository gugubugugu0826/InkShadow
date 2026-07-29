import { parseUuidV7, type UuidV7 } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import type { CipherEnvelopeV1, EnvelopeBinding } from "../src/contracts/encrypted-guest-project";
import { SessionProjectKeyring } from "../src/infrastructure/session-project-keyring";
import { WebCryptoEnvelopeService } from "../src/infrastructure/web-crypto-envelope-service";

const PROJECT_ID = uuid("018f1234-5678-7abc-8def-0123456789ab");
const OTHER_PROJECT_ID = uuid("018f1234-5678-7abc-8def-0123456789ac");
const CHAPTER_ID = uuid("018f1234-5678-7abc-8def-0123456789ad");

describe("WebCrypto envelope security", () => {
  it("keeps project keys non-extractable and recovers them only from the recovery envelope", async () => {
    const creator = new WebCryptoEnvelopeService();
    const created = await creator.createProjectKey(PROJECT_ID, 1);

    expect(created.projectKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", created.projectKey)).rejects.toThrow();

    const envelope = await creator.encryptJson(created.projectKey, chapterBinding(PROJECT_ID, 1), {
      content: "only encrypted",
    });
    const recoveredKey = await new WebCryptoEnvelopeService().unlockProjectKey(
      PROJECT_ID,
      1,
      created.recovery,
      created.recoveryMaterial,
    );

    await expect(
      new WebCryptoEnvelopeService().decryptJson(
        recoveredKey,
        envelope,
        chapterBinding(PROJECT_ID, 1),
      ),
    ).resolves.toEqual({ content: "only encrypted" });
    expect(recoveredKey.extractable).toBe(false);
  });

  it("issues a distinct AES-GCM nonce for every envelope", async () => {
    const service = new WebCryptoEnvelopeService();
    const created = await service.createProjectKey(PROJECT_ID, 1);
    const first = await service.encryptJson(created.projectKey, chapterBinding(PROJECT_ID, 1), {
      content: "first",
    });
    const second = await service.encryptJson(created.projectKey, chapterBinding(PROJECT_ID, 2), {
      content: "second",
    });

    expect(first.nonce).not.toBe(second.nonce);
    expect(new Set([created.recovery.keyEnvelope.nonce, first.nonce, second.nonce]).size).toBe(3);
  });

  it("binds AAD to the project, object and content version", async () => {
    const service = new WebCryptoEnvelopeService();
    const created = await service.createProjectKey(PROJECT_ID, 1);
    const envelope = await service.encryptJson(created.projectKey, chapterBinding(PROJECT_ID, 1), {
      content: "bound",
    });

    await expect(
      service.decryptJson(created.projectKey, envelope, chapterBinding(OTHER_PROJECT_ID, 1)),
    ).rejects.toMatchObject({ code: "WEB_ENVELOPE_BINDING_MISMATCH" });

    const metadataTampered: CipherEnvelopeV1 = {
      ...envelope,
      projectId: OTHER_PROJECT_ID,
    };
    await expect(
      service.decryptJson(
        created.projectKey,
        metadataTampered,
        chapterBinding(OTHER_PROJECT_ID, 1),
      ),
    ).rejects.toMatchObject({ code: "WEB_ENVELOPE_AUTHENTICATION_FAILED" });
  });

  it("fails closed when ciphertext or recovery material is changed", async () => {
    const service = new WebCryptoEnvelopeService();
    const created = await service.createProjectKey(PROJECT_ID, 1);
    const envelope = await service.encryptJson(created.projectKey, chapterBinding(PROJECT_ID, 1), {
      content: "tamper canary",
    });
    const tampered: CipherEnvelopeV1 = {
      ...envelope,
      ciphertext: flipBase64UrlCharacter(envelope.ciphertext),
    };

    await expect(
      service.decryptJson(created.projectKey, tampered, chapterBinding(PROJECT_ID, 1)),
    ).rejects.toMatchObject({ code: "WEB_ENVELOPE_AUTHENTICATION_FAILED" });
    await expect(
      service.unlockProjectKey(
        PROJECT_ID,
        1,
        created.recovery,
        flipBase64UrlCharacter(created.recoveryMaterial),
      ),
    ).rejects.toMatchObject({ code: "WEB_ENVELOPE_AUTHENTICATION_FAILED" });
  });

  it("rejects a non-extractable AES-GCM key that is not 256-bit", async () => {
    const weakKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, [
      "encrypt",
      "decrypt",
    ]);

    expect(() => {
      new SessionProjectKeyring().set(PROJECT_ID, weakKey);
    }).toThrow(expect.objectContaining({ code: "WEB_CRYPTO_UNAVAILABLE" }));
    await expect(
      new WebCryptoEnvelopeService().encryptJson(weakKey, chapterBinding(PROJECT_ID, 1), {
        content: "must not encrypt with AES-128",
      }),
    ).rejects.toMatchObject({ code: "WEB_CRYPTO_UNAVAILABLE" });
  });

  it("maps a failed secure random generator to a stable crypto error", async () => {
    const failingCrypto = {
      subtle: crypto.subtle,
      getRandomValues: () => {
        throw new DOMException("generator unavailable", "OperationError");
      },
    } as unknown as Crypto;

    await expect(
      new WebCryptoEnvelopeService(failingCrypto).createProjectKey(PROJECT_ID, 1),
    ).rejects.toMatchObject({ code: "WEB_CRYPTO_UNAVAILABLE" });
  });
});

function chapterBinding(projectId: UuidV7, contentVersion: number): EnvelopeBinding {
  return {
    projectId,
    objectType: "chapter",
    objectId: CHAPTER_ID,
    keyVersion: 1,
    contentVersion,
  };
}

function uuid(value: string): UuidV7 {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw new Error("Test UUID must be UUIDv7.");
  }
  return parsed.value;
}

function flipBase64UrlCharacter(value: string): string {
  const first = value[0];
  if (first === undefined) {
    throw new Error("Test value must not be empty.");
  }
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}
