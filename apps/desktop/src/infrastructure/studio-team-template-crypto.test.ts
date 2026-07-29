import { describe, expect, it, vi } from "vitest";

import {
  STUDIO_TEAM_TEMPLATE_PAYLOAD_SCHEMA_VERSION,
  StudioTeamTemplateCrypto,
  createStudioTeamTemplateAad,
  type OpenedStudioTeamTemplateProjectKey,
  type StudioTeamTemplatePayload,
} from "./studio-team-template-crypto";

describe("Studio encrypted team-template crypto", () => {
  it("round-trips every private field with a non-exportable AES-256-GCM project key", async () => {
    const key = await createProjectKey();
    const crypto = new StudioTeamTemplateCrypto();
    const payload = templatePayload();
    const envelope = await crypto.encrypt(payload, aad(), openedKey(key));

    expect(envelope.algorithm).toBe("AES-256-GCM");
    expect(envelope.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/u);
    expect(JSON.stringify(envelope)).not.toContain(payload.title);
    expect(JSON.stringify(envelope)).not.toContain(payload.promptRules[0]?.instruction);
    expect(await crypto.decrypt(envelope, openedKey(key))).toEqual(payload);
    expect(await crypto.digestPayload(payload)).toMatch(/^[a-f0-9]{64}$/u);
    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("raw", key)).rejects.toBeDefined();
  });

  it("rejects ciphertext tampering, the wrong key and cross-project AAD replay", async () => {
    const key = await createProjectKey();
    const wrongKey = await createProjectKey();
    const crypto = new StudioTeamTemplateCrypto();
    const envelope = await crypto.encrypt(templatePayload(), aad(), openedKey(key));
    const flipped = envelope.ciphertext.startsWith("A")
      ? `B${envelope.ciphertext.slice(1)}`
      : `A${envelope.ciphertext.slice(1)}`;

    await expect(
      crypto.decrypt({ ...envelope, ciphertext: flipped }, openedKey(key)),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_CIPHERTEXT_HASH_MISMATCH" });
    await expect(crypto.decrypt(envelope, openedKey(wrongKey))).rejects.toMatchObject({
      code: "TEAM_TEMPLATE_CIPHERTEXT_CORRUPT",
    });

    const otherProjectId = uuid(10);
    await expect(
      crypto.decrypt(
        { ...envelope, aad: { ...envelope.aad, projectId: otherProjectId } },
        openedKey(key, otherProjectId),
      ),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_CIPHERTEXT_CORRUPT" });
  });

  it("accepts neither extractable keys, raw secrets nor mismatched key metadata", async () => {
    const crypto = new StudioTeamTemplateCrypto();
    const extractable = await globalThis.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );

    await expect(
      crypto.encrypt(templatePayload(), aad(), openedKey(extractable)),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_CRYPTO_KEY_INVALID" });
    await expect(
      crypto.encrypt(templatePayload(), aad(), openedKey(await createProjectKey(), PROJECT_ID, 2)),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_CRYPTO_KEY_INVALID" });
    await expect(
      crypto.encrypt(templatePayload(), aad(), {
        projectId: PROJECT_ID,
        keyVersion: 1,
        key: "raw-project-dek" as unknown as CryptoKey,
      }),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_CRYPTO_KEY_INVALID" });
  });

  it("fails closed on unknown fields, oversized plaintext, cancellation and logging", async () => {
    const key = await createProjectKey();
    const crypto = new StudioTeamTemplateCrypto();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      crypto.encrypt(
        { ...templatePayload(), unexpected: "never-transport" } as StudioTeamTemplatePayload,
        aad(),
        openedKey(key),
      ),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_PAYLOAD_INVALID" });

    const oversized = {
      ...templatePayload(),
      promptRules: Array.from({ length: 64 }, (_, index) => ({
        ruleId: uuid(100 + index),
        label: `Rule ${String(index)}`,
        instruction: "x".repeat(16 * 1024),
      })),
    };
    await expect(crypto.encrypt(oversized, aad(), openedKey(key))).rejects.toMatchObject({
      code: "TEAM_TEMPLATE_PAYLOAD_TOO_LARGE",
    });

    const abort = new AbortController();
    abort.abort();
    await expect(
      crypto.encrypt(templatePayload(), aad(), openedKey(key), abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

const TENANT_ID = uuid(1);
const TEAM_ID = uuid(2);
const PROJECT_ID = uuid(3);
const TEMPLATE_ID = uuid(4);
const VERSION_ID = uuid(5);

function templatePayload(): StudioTeamTemplatePayload {
  return {
    schemaVersion: STUDIO_TEAM_TEMPLATE_PAYLOAD_SCHEMA_VERSION,
    kind: "team_template",
    title: "Private launch template",
    projectSettings: [
      { key: "genre", value: "mystery" },
      { key: "review.required", value: true },
    ],
    promptRegistryRefs: [{ registryId: uuid(6), revision: 3 }],
    promptRules: [
      {
        ruleId: uuid(7),
        label: "Voice",
        instruction: "Keep the narrator precise and restrained.",
      },
    ],
    reviewChecklist: [{ itemId: uuid(8), label: "Continuity checked", required: true }],
  };
}

function aad() {
  return createStudioTeamTemplateAad({
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    templateId: TEMPLATE_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    projectKeyVersion: 1,
  });
}

async function createProjectKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function openedKey(
  key: CryptoKey,
  projectId = PROJECT_ID,
  keyVersion = 1,
): OpenedStudioTeamTemplateProjectKey {
  return { projectId, keyVersion, key };
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
