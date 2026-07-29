import { describe, expect, it, vi } from "vitest";

import {
  STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION,
  StudioReviewCrypto,
  StudioReviewCryptoError,
  createStudioReviewAad,
  type OpenedStudioReviewProjectKey,
  type StudioReviewSourceBinding,
  type StudioReviewSuggestionPayload,
  type StudioReviewThreadItemPayload,
} from "./studio-review-crypto";

describe("Studio review client-only crypto", () => {
  it("round-trips canonical payloads with a fresh 12-byte nonce and no plaintext transport", async () => {
    const key = await createProjectKey();
    const crypto = new StudioReviewCrypto();
    const payload = commentPayload("private-review-body");
    const aad = itemAad("comment");
    const envelope = await crypto.encrypt(payload, aad, openedKey(key));

    expect(envelope.algorithm).toBe("AES-256-GCM");
    expect(envelope.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/u);
    expect(decodeBase64Url(envelope.nonce)).toHaveLength(12);
    expect(JSON.stringify(envelope)).not.toContain("private-review-body");
    expect(await crypto.decrypt(envelope, aad, openedKey(key))).toEqual(payload);
    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("raw", key)).rejects.toBeDefined();
  });

  it("authenticates every required AAD scope field and rejects cross-scope replay", async () => {
    const key = await createProjectKey();
    const crypto = new StudioReviewCrypto();
    const payload = suggestionPayload();
    const aad = itemAad("suggestion");
    const envelope = await crypto.encrypt(payload, aad, openedKey(key));
    const changes = [
      { tenantId: uuid(21) },
      { teamId: uuid(22) },
      { projectId: uuid(23) },
      { reviewId: uuid(24) },
      { threadId: uuid(25) },
      { itemId: uuid(26) },
      { sourceVersionId: uuid(27) },
      { sourceVersionRevision: 2 },
      { sourceCiphertextSha256: "b".repeat(64) },
      { projectKeyVersion: 2 },
      { payloadKind: "comment" as const },
    ];

    for (const change of changes) {
      const changedAad = { ...aad, ...change };
      const changedKey = openedKey(key, changedAad.projectId, changedAad.projectKeyVersion);
      await expect(crypto.decrypt(envelope, changedAad, changedKey)).rejects.toBeInstanceOf(
        StudioReviewCryptoError,
      );
    }
  });

  it("rejects ciphertext/hash tampering, the wrong key, wrong key metadata and item replay", async () => {
    const key = await createProjectKey();
    const wrongKey = await createProjectKey();
    const crypto = new StudioReviewCrypto();
    const aad = itemAad("comment");
    const envelope = await crypto.encrypt(commentPayload("authentic"), aad, openedKey(key));
    const flipped = envelope.ciphertext.startsWith("A")
      ? `B${envelope.ciphertext.slice(1)}`
      : `A${envelope.ciphertext.slice(1)}`;

    await expect(
      crypto.decrypt({ ...envelope, ciphertext: flipped }, aad, openedKey(key)),
    ).rejects.toMatchObject({ code: "REVIEW_CIPHERTEXT_HASH_MISMATCH" });
    await expect(
      crypto.decrypt({ ...envelope, ciphertextSha256: "0".repeat(64) }, aad, openedKey(key)),
    ).rejects.toMatchObject({ code: "REVIEW_CIPHERTEXT_HASH_MISMATCH" });
    await expect(crypto.decrypt(envelope, aad, openedKey(wrongKey))).rejects.toMatchObject({
      code: "REVIEW_CIPHERTEXT_CORRUPT",
    });
    await expect(
      crypto.decrypt(envelope, aad, openedKey(key, PROJECT_ID, 2)),
    ).rejects.toMatchObject({ code: "REVIEW_CRYPTO_KEY_INVALID" });
    await expect(
      crypto.decrypt(envelope, { ...aad, itemId: uuid(28) }, openedKey(key)),
    ).rejects.toMatchObject({ code: "REVIEW_CIPHERTEXT_CORRUPT" });
  });

  it("binds replies to their parent item and rejects relinking", async () => {
    const key = await createProjectKey();
    const crypto = new StudioReviewCrypto();
    const aad = { ...itemAad("reply"), parentItemId: uuid(29) };
    const envelope = await crypto.encrypt(
      { ...commentPayload("reply"), kind: "reply" },
      aad,
      openedKey(key),
    );

    await expect(
      crypto.decrypt(envelope, { ...aad, parentItemId: uuid(30) }, openedKey(key)),
    ).rejects.toMatchObject({ code: "REVIEW_CIPHERTEXT_CORRUPT" });
  });

  it("accepts neither string/raw DEKs nor extractable WebCrypto keys", async () => {
    const crypto = new StudioReviewCrypto();
    const extractable = await globalThis.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const aad = itemAad("comment");

    await expect(
      crypto.encrypt(commentPayload("secret"), aad, openedKey(extractable)),
    ).rejects.toMatchObject({ code: "REVIEW_CRYPTO_KEY_INVALID" });
    await expect(
      crypto.encrypt(commentPayload("secret"), aad, {
        projectId: PROJECT_ID,
        keyVersion: 1,
        key: "raw-dek-must-never-enter-review" as unknown as CryptoKey,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_CRYPTO_KEY_INVALID" });
  });

  it("fails strict payload validation, supports cancellation, and never logs plaintext", async () => {
    const key = await createProjectKey();
    const crypto = new StudioReviewCrypto();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invalid = {
      ...commentPayload("never-log-this-plaintext"),
      unexpected: "not-canonical",
    } as unknown as StudioReviewThreadItemPayload;

    await expect(crypto.encrypt(invalid, itemAad("comment"), openedKey(key))).rejects.toMatchObject(
      { code: "REVIEW_PAYLOAD_INVALID" },
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      crypto.encrypt(
        commentPayload("cancelled-secret"),
        itemAad("comment"),
        openedKey(key),
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

const TENANT_ID = uuid(1);
const TEAM_ID = uuid(2);
const PROJECT_ID = uuid(3);
const REVIEW_ID = uuid(4);
const THREAD_ID = uuid(5);
const ITEM_ID = uuid(6);
const SOURCE_VERSION_ID = uuid(7);
const CHAPTER_ID = uuid(8);

const SOURCE: StudioReviewSourceBinding = {
  sourceVersionId: SOURCE_VERSION_ID,
  sourceVersionRevision: 1,
  sourceCiphertextSha256: "a".repeat(64),
};

function commentPayload(body: string): StudioReviewThreadItemPayload {
  return {
    schemaVersion: STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION,
    kind: "comment",
    body,
    source: SOURCE,
    anchor: null,
  };
}

function suggestionPayload(): StudioReviewSuggestionPayload {
  return {
    schemaVersion: STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION,
    kind: "suggestion",
    body: "Replace this sentence.",
    source: SOURCE,
    anchor: {
      chapterId: CHAPTER_ID,
      startUtf16: 10,
      endUtf16: 20,
      selectedTextSha256: "c".repeat(64),
    },
    candidate: {
      candidateId: uuid(9),
      baseSourceVersionId: SOURCE_VERSION_ID,
      baseSourceVersionRevision: 1,
      baseSourceCiphertextSha256: "a".repeat(64),
      replacement: {
        chapterId: CHAPTER_ID,
        startUtf16: 10,
        endUtf16: 20,
        text: "A safer replacement.",
      },
    },
  };
}

function itemAad(payloadKind: "comment" | "suggestion" | "reply") {
  return createStudioReviewAad({
    payloadKind,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    reviewId: REVIEW_ID,
    threadId: THREAD_ID,
    itemId: ITEM_ID,
    parentItemId: payloadKind === "reply" ? uuid(29) : null,
    source: SOURCE,
    projectKeyVersion: 1,
  });
}

async function createProjectKey(): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function openedKey(
  key: CryptoKey,
  projectId = PROJECT_ID,
  keyVersion = 1,
): OpenedStudioReviewProjectKey {
  return { projectId, keyVersion, key };
}

function decodeBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  return Uint8Array.from(globalThis.atob(padded), (character) => character.codePointAt(0) ?? 0);
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
