import { EvidenceRefValidationError, createEvidenceRef, type EvidenceRef } from "../src/index.js";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-18T00:00:00.000Z";

describe("canonical EvidenceRef", () => {
  it("keeps a content-free immutable UTF-16 evidence identity", () => {
    const reference = createEvidenceRef({
      ...validReference(),
      content: "must not cross the canonical DTO boundary",
      excerpt: "must not cross the canonical DTO boundary",
      locator: {
        ...validReference().locator,
        content: "must not cross the canonical locator boundary",
      },
    } as unknown as EvidenceRef);

    expect(reference).toEqual({
      projectId: "project-1",
      chapterId: "chapter-1",
      immutableVersionId: "version-1",
      sourceKind: "chapter",
      locator: { kind: "utf16", startOffset: 4, endOffset: 12, sourceLength: 20 },
      excerptDigest: "a".repeat(64),
      sourceCreatedAt: NOW,
      observedAt: NOW,
      currentness: "current",
      branchId: null,
      privacy: "standard",
    });
    expect(Object.keys(reference)).not.toContain("content");
    expect(Object.keys(reference)).not.toContain("excerpt");
    expect(Object.keys(reference.locator)).not.toContain("content");
    expect(Object.isFrozen(reference)).toBe(true);
    expect(Object.isFrozen(reference.locator)).toBe(true);
  });

  it("requires exact immutable authority for offsets", () => {
    expect(() =>
      createEvidenceRef({
        ...validReference(),
        immutableVersionId: null,
      }),
    ).toThrow(EvidenceRefValidationError);
    expect(() =>
      createEvidenceRef({
        ...validReference(),
        locator: { kind: "utf16", startOffset: 12, endOffset: 4, sourceLength: 20 },
      }),
    ).toThrow(EvidenceRefValidationError);
  });

  it("rejects non-digests, non-canonical timestamps and backwards observation", () => {
    expect(() => createEvidenceRef({ ...validReference(), excerptDigest: "not-a-digest" })).toThrow(
      EvidenceRefValidationError,
    );
    expect(() =>
      createEvidenceRef({ ...validReference(), observedAt: "2026-08-17T23:59:59.999Z" }),
    ).toThrow(EvidenceRefValidationError);
  });
});

function validReference(): EvidenceRef {
  return {
    projectId: "project-1",
    chapterId: "chapter-1",
    immutableVersionId: "version-1",
    sourceKind: "chapter",
    locator: { kind: "utf16", startOffset: 4, endOffset: 12, sourceLength: 20 },
    excerptDigest: "a".repeat(64),
    sourceCreatedAt: NOW,
    observedAt: NOW,
    currentness: "current",
    branchId: null,
    privacy: "standard",
  };
}
