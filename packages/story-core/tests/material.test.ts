import { describe, expect, it } from "vitest";

import {
  Material,
  MaterialReference,
  MATERIAL_RETENTION_DAYS,
  type MaterialFieldsInput,
} from "../src/index.js";
import { unwrap, uuid } from "./helpers.js";

const T0 = "2026-07-27T00:00:00.000Z";
const T1 = "2026-07-27T00:01:00.000Z";

describe("material rights and provenance", () => {
  it("defaults unknown permission to no generation or training use", () => {
    const material = makeMaterial(1, {
      license: "permission_unknown",
      rightsConfirmed: false,
      allowGeneration: false,
      allowTraining: false,
    });

    expect(material.canUseFor("generation")).toBe(false);
    expect(material.canUseFor("training")).toBe(false);

    const unsafe = Material.create({
      ...fields({
        license: "permission_unknown",
        rightsConfirmed: true,
        allowGeneration: true,
      }),
      id: uuid(10),
      projectId: uuid(11),
      now: T0,
    });
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) {
      expect(unsafe.error.code).toBe("MATERIAL_RIGHTS_NOT_CONFIRMED");
    }
  });

  it("requires explicit rights confirmation before an allowed use becomes effective", () => {
    const material = makeMaterial(20, {
      license: "licensed",
      rightsConfirmed: true,
      allowGeneration: true,
      allowTraining: false,
    });

    expect(material.canUseFor("generation")).toBe(true);
    expect(material.canUseFor("training")).toBe(false);

    const revoked = unwrap(
      material.edit({
        ...fields({
          license: "licensed",
          rightsConfirmed: false,
          allowGeneration: false,
          allowTraining: false,
        }),
        expectedRevision: 1,
        humanConfirmed: true,
        now: T1,
      }),
    );
    expect(revoked.canUseFor("generation")).toBe(false);
    expect(revoked.toSnapshot().permissions.rightsConfirmedAt).toBeNull();
  });

  it("keeps an immutable minimal provenance snapshot after the material is deleted", () => {
    const material = makeMaterial(30, {
      license: "public_domain",
      rightsConfirmed: true,
      allowGeneration: true,
    });
    const reference = unwrap(
      MaterialReference.create({
        id: uuid(33),
        material,
        targetChapterId: uuid(34),
        targetVersionId: uuid(35),
        excerptStart: 0,
        excerptEnd: 4,
        note: "第一章场景参考",
        now: T0,
      }),
    );
    const deleted = unwrap(
      material.softDelete({
        expectedRevision: 1,
        expectedReferenceCount: 1,
        actualReferenceCount: 1,
        humanConfirmed: true,
        now: T1,
      }),
    );

    expect(deleted.status).toBe("deleted");
    expect(deleted.canUseFor("generation")).toBe(false);
    expect(reference.toSnapshot()).toMatchObject({
      materialId: material.id,
      excerpt: "参考素材",
      provenance: {
        title: "雨夜石板路",
        sourceName: "用户提供笔记",
        license: "public_domain",
        contentFingerprint: "a".repeat(64),
      },
    });
    expect(
      Date.parse(deleted.toSnapshot().retentionUntil ?? "") -
        Date.parse(deleted.toSnapshot().deletedAt ?? ""),
    ).toBe(MATERIAL_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  });

  it("rejects stale delete impact and prevents self-merge", () => {
    const material = makeMaterial(40);
    const staleDelete = material.softDelete({
      expectedRevision: 1,
      expectedReferenceCount: 0,
      actualReferenceCount: 1,
      humanConfirmed: true,
      now: T1,
    });
    expect(staleDelete.ok).toBe(false);
    if (!staleDelete.ok) {
      expect(staleDelete.error.code).toBe("MATERIAL_REFERENCE_IMPACT_CHANGED");
    }

    const selfMerge = material.mergeInto({
      survivorId: material.id,
      expectedRevision: 1,
      expectedReferenceCount: 0,
      actualReferenceCount: 0,
      humanConfirmed: true,
      now: T1,
    });
    expect(selfMerge.ok).toBe(false);
    if (!selfMerge.ok) {
      expect(selfMerge.error.code).toBe("MATERIAL_INVALID_TRANSITION");
    }
  });

  it("marks merged material inactive without rewriting its provenance", () => {
    const source = makeMaterial(50, { allowGeneration: true });
    const survivor = makeMaterial(60, {
      contentFingerprint: "b".repeat(64),
    });
    const merged = unwrap(
      source.mergeInto({
        survivorId: survivor.id,
        expectedRevision: 1,
        expectedReferenceCount: 2,
        actualReferenceCount: 2,
        humanConfirmed: true,
        now: T1,
      }),
    );

    expect(merged.status).toBe("merged");
    expect(merged.toSnapshot().mergedIntoId).toBe(survivor.id);
    expect(merged.toSnapshot().dispositionReferenceCount).toBe(2);
    expect(merged.canUseFor("generation")).toBe(false);
  });
});

function makeMaterial(base: number, overrides: Partial<MaterialFieldsInput> = {}): Material {
  return unwrap(
    Material.create({
      ...fields(overrides),
      id: uuid(base),
      projectId: uuid(base + 1),
      now: T0,
    }),
  );
}

function fields(overrides: Partial<MaterialFieldsInput> = {}): MaterialFieldsInput {
  return {
    title: "雨夜石板路",
    sourceName: "用户提供笔记",
    author: "测试作者",
    sourceUrl: "https://example.test/reference",
    license: "owned",
    rightsBasis: "用户确认拥有并可在当前项目使用。",
    rightsConfirmed: true,
    allowGeneration: false,
    allowTraining: false,
    tags: ["场景", "雨夜"],
    summary: "用于雨夜场景的气氛参考。",
    body: "参考素材：雨夜的石板路泛着微光。",
    contentFingerprint: "a".repeat(64),
    ...overrides,
  };
}
