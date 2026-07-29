import { describe, expect, it } from "vitest";

import {
  IMPORT_LIMITS,
  createPortableBundle,
  preflightImport,
  serializePortableBundle,
  type PortableBundleMetadata,
  type PortableBundleV1,
  type PortableProjectInput,
} from "../src/index.js";

const projectInput = {
  project: {
    id: "preflight-project",
    title: "Preflight project",
    language: "en",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:01.000Z",
  },
  chapters: [
    {
      id: "preflight-chapter",
      title: "Chapter",
      order: 0,
      markdown: "Safe local content.",
    },
  ],
} satisfies PortableProjectInput;

const metadata = {
  bundleId: "preflight-bundle",
  exportedAt: "2026-07-27T00:00:02.000Z",
  generatorVersion: "0.1.0",
} satisfies PortableBundleMetadata;

describe("import preflight", () => {
  it("returns a verified, non-mutating bundle candidate", async () => {
    const bundle = await createPortableBundle(projectInput, metadata);
    const report = await preflightImport([
      {
        name: "project.inkshadow.json",
        content: await serializePortableBundle(bundle),
      },
    ]);

    expect(report.status).toBe("ready");
    expect(report.format).toBe("portable_bundle");
    expect(report.summary).toMatchObject({
      fileCount: 1,
      chapterCount: 1,
      checksumVerified: true,
    });
    expect(report.candidate).toEqual({
      kind: "portable_bundle",
      project: bundle.content,
    });
  });

  it("blocks a bundle with a corrupt checksum", async () => {
    const bundle = await createPortableBundle(projectInput, metadata);
    const corrupt: PortableBundleV1 = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        checksum: {
          algorithm: "sha256",
          value: "0".repeat(64),
        },
      },
    };
    const report = await preflightImport([
      {
        name: "project.json",
        content: `${JSON.stringify(corrupt, null, 2)}\n`,
      },
    ]);

    expect(report.status).toBe("blocked");
    expect(report.summary.checksumVerified).toBe(false);
    expect(report.candidate).toBeUndefined();
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "BUNDLE_CHECKSUM_MISMATCH",
        severity: "blocking",
      }),
    );
  });

  it("sanitizes Markdown and reports warnings without blocking", async () => {
    const report = await preflightImport([
      {
        name: "chapter.md",
        content: "# Chapter\n<script>alert(1)</script>\n[leave](https://attacker.example)",
      },
      {
        name: "notes.txt",
        content: "Plain *text* with https://attacker.example.",
      },
    ]);

    expect(report.status).toBe("ready");
    expect(report.format).toBe("mixed");
    expect(report.summary.chapterCount).toBe(2);
    expect(report.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["MARKDOWN_RAW_HTML_ESCAPED", "MARKDOWN_EXTERNAL_REFERENCE_REMOVED"]),
    );
    expect(JSON.stringify(report.candidate)).not.toContain("https://attacker.example");
    expect(JSON.stringify(report.candidate)).not.toContain("<script>");
  });

  it("accepts inert HTML but blocks macro, executable markup, traversal, and binary disguises", async () => {
    const safeHtml = await preflightImport([
      {
        name: "page.html",
        content: "<article><h1>Chapter</h1><p>Local text.</p></article>",
      },
    ]);
    expect(safeHtml.status).toBe("ready");
    expect(safeHtml.format).toBe("html");
    expect(safeHtml.issues).toContainEqual(
      expect.objectContaining({ code: "HTML_MARKUP_REMOVED", severity: "warning" }),
    );

    const report = await preflightImport([
      {
        name: "macro.docm",
        content: "not actually a document",
      },
      {
        name: "unsafe.html",
        content: "<script>alert(1)</script>",
      },
      {
        name: "../escape.md",
        content: "escape",
      },
      {
        name: "archive.md",
        content: "PK\u0003\u0004archive",
      },
    ]);

    expect(report.status).toBe("blocked");
    expect(report.candidate).toBeUndefined();
    expect(report.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "IMPORT_MACRO_FORMAT_FORBIDDEN",
        "IMPORT_UNSAFE_CONTENT",
        "IMPORT_PATH_TRAVERSAL",
        "IMPORT_BINARY_FORMAT_FORBIDDEN",
      ]),
    );
  });

  it("blocks JSON mixed with other files and duplicate chapter targets", async () => {
    const bundle = await createPortableBundle(projectInput, metadata);
    const mixed = await preflightImport([
      {
        name: "project.json",
        content: await serializePortableBundle(bundle),
      },
      {
        name: "chapter.md",
        content: "Chapter.",
      },
    ]);
    expect(mixed.status).toBe("blocked");
    expect(mixed.issues).toContainEqual(
      expect.objectContaining({
        code: "IMPORT_MIXED_FORMATS",
      }),
    );

    const duplicate = await preflightImport([
      {
        name: "same.md",
        content: "One.",
      },
      {
        name: "same.txt",
        content: "Two.",
      },
    ]);
    expect(duplicate.status).toBe("blocked");
    expect(duplicate.issues).toContainEqual(
      expect.objectContaining({
        code: "IMPORT_DUPLICATE_FILE",
      }),
    );
  });

  it("enforces empty, file-count, and per-file size limits", async () => {
    const empty = await preflightImport([]);
    expect(empty.status).toBe("blocked");
    expect(empty.issues[0]?.code).toBe("IMPORT_EMPTY");

    const tooMany = await preflightImport(
      Array.from({ length: IMPORT_LIMITS.maximumFiles + 1 }, (_, index) => ({
        name: `chapter-${String(index)}.md`,
        content: "x",
      })),
    );
    expect(tooMany.issues[0]?.code).toBe("IMPORT_TOO_MANY_FILES");

    const tooLarge = await preflightImport([
      {
        name: "large.md",
        content: "x".repeat(IMPORT_LIMITS.maximumFileBytes + 1),
      },
    ]);
    expect(tooLarge.status).toBe("blocked");
    expect(tooLarge.issues[0]?.code).toBe("IMPORT_FILE_TOO_LARGE");
  });
});
