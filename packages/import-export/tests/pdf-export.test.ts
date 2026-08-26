import { describe, expect, it } from "vitest";

import { importPdfDocuments } from "../src/binary.js";
import {
  PDF_EXPORT_LIMITS,
  PDF_RENDER_SPEC,
  assembleRasterizedPdf,
  exportProjectToPdf,
  exportPublicationToPdf,
  type PdfExportProgress,
  type PdfPageRasterizer,
  type PdfRasterPage,
} from "../src/pdf-export.js";
import type { PortablePublication } from "../src/publication-model.js";
import type { PortableProjectV1 } from "../src/schemas.js";
import { ONE_PIXEL_PNG, ONE_PIXEL_PNG_BASE64 } from "./image-fixture.js";

const GENERATED_AT = "2026-07-28T00:30:45.123Z";

const project = {
  project: {
    id: "project-pdf-1",
    title: "墨影长篇",
    description: "一部关于记忆与旧城的长篇小说。",
    language: "zh-CN",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
  chapters: [
    {
      id: "chapter-2",
      title: "第二章 来客",
      order: 2,
      path: "chapters/0002.md",
      markdown: "门外响起三声叩门。\n\n[外链](https://example.invalid/secret)",
    },
    {
      id: "chapter-1",
      title: "第一章 雨巷",
      order: 1,
      path: "chapters/0001.md",
      markdown: "雨落在旧城。\n\n![远程图](https://example.invalid/image.jpg)",
    },
  ],
} satisfies PortableProjectV1;

const publication = {
  format: "inkshadow-portable-publication",
  version: 1,
  project: {
    id: "project-semantic-pdf-1",
    title: "墨影 <长篇> & 归途",
    description: "安全、离线、可携带。",
    language: "zh-CN",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
  chapters: [
    {
      id: "chapter-semantic-1",
      title: "第一章 风起",
      order: 0,
      sourcePath: "chapters/0001.md",
      blocks: [
        { kind: "heading", level: 1, text: "旧城", sourceLine: 1 },
        { kind: "paragraph", text: "雨声里写着完整的中文正文。", sourceLine: 2 },
        { kind: "quote", text: "别回头。", sourceLine: 3 },
        { kind: "sceneBreak", sourceLine: 4 },
      ],
    },
  ],
  warnings: [],
  statistics: {
    chapterCount: 1,
    blockCount: 4,
    textCharacters: 30,
  },
} satisfies PortablePublication;

describe("image-based PDF export", () => {
  it("normalizes inert publication content and assembles deterministic A4 image pages", async () => {
    const seen: PortablePublication[] = [];
    const progress: PdfExportProgress[] = [];
    const rasterize: PdfPageRasterizer = function* (normalized, context) {
      seen.push(normalized);
      context.reportProgress({ stage: "laying_out", completedUnits: 1, totalUnits: 2 });
      yield rasterPage(0x41);
      context.reportProgress({ stage: "rasterizing", completedUnits: 2, totalUnits: 2 });
      yield rasterPage(0x42);
    };

    const first = await exportProjectToPdf(project, {
      generatedAt: GENERATED_AT,
      rasterize,
      onProgress(value) {
        progress.push(value);
      },
    });
    const second = await exportProjectToPdf(project, { generatedAt: GENERATED_AT, rasterize });
    const decoded = decodeSingleByte(first.bytes);

    expect(first.fileName).toBe("墨影长篇.pdf");
    expect(first.mediaType).toBe("application/pdf");
    expect(first.renderingMode).toBe("image-based");
    expect(first.pageCount).toBe(2);
    expect(first.byteLength).toBe(first.bytes.byteLength);
    expect(first.bytes).toEqual(second.bytes);
    expect([...first.bytes.subarray(0, 8)]).toEqual([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
    ]);
    expect(decoded).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(decoded).toContain("/Count 2");
    expect(decoded).toContain("/Filter /DCTDecode");
    expect(decoded).toContain("/Subject <FEFF0049006D006100670065002D00620061007300650064");
    expect(decoded.endsWith("%%EOF\n")).toBe(true);
    expect(seen[0]?.chapters.map(({ title }) => title)).toEqual(["第一章 雨巷", "第二章 来客"]);
    expect(JSON.stringify(seen[0])).not.toContain("https://");
    expect(JSON.stringify(seen[0])).toContain("[image omitted: 远程图]");
    expect(new Set(progress.map(({ stage }) => stage))).toEqual(
      new Set(["normalizing", "laying_out", "rasterizing", "assembling"]),
    );
  });

  it("passes an empty titled chapter through the PDF publication path", async () => {
    const seen: PortablePublication[] = [];
    const sourceChapter = project.chapters[0];
    if (sourceChapter === undefined) throw new Error("Expected a PDF source chapter.");
    const emptyProject = {
      ...project,
      chapters: [{ ...sourceChapter, order: 0, markdown: "" }],
    } satisfies PortableProjectV1;

    await exportProjectToPdf(emptyProject, {
      generatedAt: GENERATED_AT,
      rasterize(normalized) {
        seen.push(normalized);
        return [rasterPage()];
      },
    });

    expect(seen[0]?.chapters).toMatchObject([{ title: "第二章 来客", blocks: [] }]);
  });

  it("passes a validated source image into the real image-based PDF rasterization contract", async () => {
    const seen: PortablePublication[] = [];
    const longEndToken = "PDF长正文终点令牌";
    const imageProject = {
      ...project,
      chapters: [
        {
          id: "chapter-inline-image",
          title: "第一章 雾港",
          order: 0,
          path: "chapters/0001.md",
          markdown: `中文正文开始。${"长正文内容。".repeat(20_000)}${longEndToken}\n\n![雾港场景](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})\n\n中文正文结束。`,
        },
      ],
    } satisfies PortableProjectV1;
    const artifact = await exportProjectToPdf(imageProject, {
      generatedAt: GENERATED_AT,
      rasterize: function* (normalized) {
        seen.push(normalized);
        yield rasterPage(0x51);
      },
    });
    const image = seen[0]?.chapters[0]?.blocks.find(({ kind }) => kind === "image");

    expect(image).toMatchObject({
      kind: "image",
      altText: "雾港场景",
      mediaType: "image/png",
      pixelWidth: 1,
      pixelHeight: 1,
    });
    expect(image !== undefined && "bytes" in image ? image.bytes : undefined).toEqual(
      ONE_PIXEL_PNG,
    );
    expect(JSON.stringify(seen[0])).toContain(longEndToken);
    expect(artifact.pageCount).toBe(1);
    expect(decodeSingleByte(artifact.bytes)).toContain("/Subtype /Image");
    expect(artifact.issues).toEqual([]);
  });

  it("writes a valid classic xref table whose offsets address every object", () => {
    const bytes = assembleRasterizedPdf({
      title: "交叉引用校验",
      generatedAt: GENERATED_AT,
      pages: [rasterPage(0x31), rasterPage(0x32)],
    });
    const decoded = decodeSingleByte(bytes);
    const startXrefMatch = /startxref\n(\d+)\n%%EOF\n$/u.exec(decoded);
    expect(startXrefMatch).not.toBeNull();
    const xrefOffset = Number(startXrefMatch?.[1]);
    expect(decoded.slice(xrefOffset, xrefOffset + 4)).toBe("xref");

    const xref = decoded.slice(xrefOffset);
    const header = /^xref\n0 (\d+)\n/u.exec(xref);
    expect(header?.[1]).toBe("10");
    const entries = xref.split("\n").slice(3, 12);
    expect(entries).toHaveLength(9);
    for (const [index, entry] of entries.entries()) {
      const offset = Number(entry.slice(0, 10));
      const objectHeader = `${String(index + 1)} 0 obj`;
      expect(decoded.slice(offset, offset + objectHeader.length)).toBe(objectHeader);
    }
  });

  it("encodes CJK and hostile metadata as inert UTF-16 hex strings", () => {
    const bytes = assembleRasterizedPdf({
      title: "墨影) /JavaScript (alert\u202E",
      generatedAt: GENERATED_AT,
      pages: [rasterPage()],
    });
    const decoded = decodeSingleByte(bytes);

    expect(decoded).toContain("/Title <FEFF");
    expect(decoded).toContain("/CreationDate (D:20260728003045Z)");
    expect(decoded).not.toContain("/JavaScript");
    expect(decoded).not.toContain("/OpenAction");
    expect(decoded).not.toContain("/AA");
    expect(decoded).not.toContain("/EmbeddedFiles");
    expect(decoded).not.toContain("example.invalid");
  });

  it("truncates metadata on Unicode scalar boundaries", () => {
    const bytes = assembleRasterizedPdf({
      title: `${"a".repeat(199)}🚀/JavaScript`,
      generatedAt: GENERATED_AT,
      pages: [rasterPage()],
    });
    const titleHex = /\/Title <(FEFF[0-9A-F]+)>/u.exec(decodeSingleByte(bytes))?.[1];

    expect(titleHex).toBeDefined();
    expect(titleHex?.endsWith("D83DDE80")).toBe(true);
    expect(titleHex?.endsWith("D83D")).toBe(false);
  });

  it("replaces pre-existing isolated UTF-16 surrogates in metadata", () => {
    const bytes = assembleRasterizedPdf({
      title: "A\uD800B\uDC00C🚀",
      generatedAt: GENERATED_AT,
      pages: [rasterPage()],
    });
    const titleHex = /\/Title <(FEFF[0-9A-F]+)>/u.exec(decodeSingleByte(bytes))?.[1];

    expect(titleHex).toBe("FEFF0041FFFD0042FFFD0043D83DDE80");
    expect(titleHex).not.toContain("D800");
    expect(titleHex).not.toContain("DC00");
  });

  it("injects JPEG bytes exactly once without exposing publication text in PDF objects", async () => {
    const jpeg = createTestJpeg(0x7f);
    const artifact = await exportPublicationToPdf(publication, {
      generatedAt: GENERATED_AT,
      rasterize: function* () {
        yield {
          pixelWidth: PDF_RENDER_SPEC.pixelWidth,
          pixelHeight: PDF_RENDER_SPEC.pixelHeight,
          jpegBytes: jpeg,
        };
      },
    });

    expect(findSubarray(artifact.bytes, jpeg)).toBeGreaterThan(0);
    expect(findSubarray(artifact.bytes, jpeg, findSubarray(artifact.bytes, jpeg) + 1)).toBe(-1);
    expect(decodeSingleByte(artifact.bytes)).not.toContain("完整的中文正文");
  });

  it("is independently parseable as an inactive image-only PDF", async () => {
    const bytes = assembleRasterizedPdf({
      title: "安全结构检查",
      generatedAt: GENERATED_AT,
      pages: [rasterPage()],
    });

    await expect(importPdfDocuments("安全结构检查.pdf", bytes)).rejects.toMatchObject({
      code: "PDF_TEXT_UNAVAILABLE",
    });
  }, 30_000);

  it("fails closed for invalid timestamps, empty output, and renderer failures", async () => {
    await expect(
      exportPublicationToPdf(publication, {
        generatedAt: "</Info><script>",
        rasterize: function* () {
          yield rasterPage();
        },
      }),
    ).rejects.toMatchObject({ code: "PDF_RENDER_FAILED" });

    await expect(
      exportPublicationToPdf(publication, {
        generatedAt: GENERATED_AT,
        rasterize: () => [],
      }),
    ).rejects.toMatchObject({ code: "PDF_RENDER_FAILED" });

    await expect(
      exportPublicationToPdf(publication, {
        generatedAt: GENERATED_AT,
        rasterize: function* () {
          throw new Error("private renderer detail");
        },
      }),
    ).rejects.toMatchObject({
      code: "PDF_RENDER_FAILED",
      message: "The PDF document could not be rendered safely.",
    });
  });

  it("rejects non-JPEG, structurally incomplete, wrong-size, grayscale, and oversized pages", () => {
    const wrongSize = rasterPage();
    expect(() =>
      assembleRasterizedPdf({
        title: "wrong-size",
        generatedAt: GENERATED_AT,
        pages: [{ ...wrongSize, pixelWidth: 100 }],
      }),
    ).toThrowError(expect.objectContaining({ code: "PDF_RENDER_FAILED" }));

    expect(() =>
      assembleRasterizedPdf({
        title: "not-jpeg",
        generatedAt: GENERATED_AT,
        pages: [
          {
            ...wrongSize,
            jpegBytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "PDF_RENDER_FAILED" }));

    expect(() =>
      assembleRasterizedPdf({
        title: "grayscale",
        generatedAt: GENERATED_AT,
        pages: [{ ...wrongSize, jpegBytes: createTestJpeg(0x20, 1) }],
      }),
    ).toThrowError(expect.objectContaining({ code: "PDF_RENDER_FAILED" }));

    for (const marker of [0xdb, 0xc4, 0xda]) {
      expect(() =>
        assembleRasterizedPdf({
          title: `missing-${marker.toString(16)}`,
          generatedAt: GENERATED_AT,
          pages: [
            {
              ...wrongSize,
              jpegBytes: removeJpegSegment(createTestJpeg(), marker),
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: "PDF_RENDER_FAILED" }));
    }

    const noEntropy = createTestJpeg().slice(0, -5);
    expect(() =>
      assembleRasterizedPdf({
        title: "missing-entropy",
        generatedAt: GENERATED_AT,
        pages: [
          {
            ...wrongSize,
            jpegBytes: Uint8Array.from([...noEntropy, 0xff, 0xd9]),
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "PDF_RENDER_FAILED" }));

    const oversized = new Uint8Array(PDF_EXPORT_LIMITS.maximumPageJpegBytes + 1);
    oversized.set(createTestJpeg().subarray(0, -2));
    oversized.set([0xff, 0xd9], oversized.length - 2);
    expect(() =>
      assembleRasterizedPdf({
        title: "oversized",
        generatedAt: GENERATED_AT,
        pages: [{ ...wrongSize, jpegBytes: oversized }],
      }),
    ).toThrowError(expect.objectContaining({ code: "EXPORT_OUTPUT_TOO_LARGE" }));
  });

  it("enforces the page and publication complexity limits before packaging", async () => {
    expect(() =>
      assembleRasterizedPdf({
        title: "too-many-pages",
        generatedAt: GENERATED_AT,
        pages: Array.from({ length: PDF_EXPORT_LIMITS.maximumPages + 1 }, () => rasterPage()),
      }),
    ).toThrowError(expect.objectContaining({ code: "PDF_COMPLEXITY_LIMIT_EXCEEDED" }));

    const oversizedPublication: PortablePublication = {
      ...publication,
      project: {
        ...publication.project,
        description: "墨".repeat(PDF_EXPORT_LIMITS.maximumTextCharacters + 1),
      },
    };
    await expect(
      exportPublicationToPdf(oversizedPublication, {
        generatedAt: GENERATED_AT,
        rasterize: function* () {
          yield rasterPage();
        },
      }),
    ).rejects.toMatchObject({ code: "PDF_COMPLEXITY_LIMIT_EXCEEDED" });
  });

  it("honors cancellation before rendering and between streamed pages", async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      exportProjectToPdf(project, {
        generatedAt: GENERATED_AT,
        signal: before.signal,
        rasterize: function* () {
          yield rasterPage();
        },
      }),
    ).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });

    const during = new AbortController();
    await expect(
      exportPublicationToPdf(publication, {
        generatedAt: GENERATED_AT,
        signal: during.signal,
        rasterize: function* () {
          yield rasterPage();
          during.abort();
          yield rasterPage();
        },
      }),
    ).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });
  });
});

function rasterPage(marker = 0x20): PdfRasterPage {
  return {
    pixelWidth: PDF_RENDER_SPEC.pixelWidth,
    pixelHeight: PDF_RENDER_SPEC.pixelHeight,
    jpegBytes: createTestJpeg(marker),
  };
}

function createTestJpeg(marker = 0x20, components = 3): Uint8Array {
  const componentTable = Array.from({ length: components }, (_value, index) => [
    index + 1,
    0x11,
    0,
  ]).flat();
  const frameLength = 8 + componentTable.length;
  const scanComponents = Array.from({ length: components }, (_value, index) => [
    index + 1,
    0,
  ]).flat();
  const scanLength = 6 + scanComponents.length;
  const quantizationTable = Array.from({ length: 64 }, () => 1);
  const singleCodeLengths = [1, ...Array.from({ length: 15 }, () => 0)];
  const huffmanTables = [0, ...singleCodeLengths, 0, 0x10, ...singleCodeLengths, 0];
  const huffmanLength = 2 + huffmanTables.length;
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xdb,
    0,
    67,
    0,
    ...quantizationTable,
    0xff,
    0xc4,
    (huffmanLength >> 8) & 0xff,
    huffmanLength & 0xff,
    ...huffmanTables,
    0xff,
    0xc0,
    (frameLength >> 8) & 0xff,
    frameLength & 0xff,
    8,
    (PDF_RENDER_SPEC.pixelHeight >> 8) & 0xff,
    PDF_RENDER_SPEC.pixelHeight & 0xff,
    (PDF_RENDER_SPEC.pixelWidth >> 8) & 0xff,
    PDF_RENDER_SPEC.pixelWidth & 0xff,
    components,
    ...componentTable,
    0xff,
    0xda,
    (scanLength >> 8) & 0xff,
    scanLength & 0xff,
    components,
    ...scanComponents,
    0,
    63,
    0,
    marker,
    0x11,
    0x22,
    0xff,
    0xd9,
  ]);
}

function removeJpegSegment(bytes: Uint8Array, marker: number): Uint8Array {
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset] !== 0xff || bytes[offset + 1] === undefined) {
      throw new Error("The JPEG fixture is malformed.");
    }
    const currentMarker = bytes[offset + 1] as number;
    if (currentMarker === 0xd9) {
      break;
    }
    const length = (bytes[offset + 2] ?? 0) * 256 + (bytes[offset + 3] ?? 0);
    if (length < 2 || offset + 2 + length > bytes.length) {
      throw new Error("The JPEG fixture segment is malformed.");
    }
    if (currentMarker === marker) {
      return Uint8Array.from([
        ...bytes.subarray(0, offset),
        ...bytes.subarray(offset + 2 + length),
      ]);
    }
    offset += 2 + length;
    if (currentMarker === 0xda) {
      break;
    }
  }
  throw new Error(`JPEG fixture marker ${marker.toString(16)} was not found.`);
}

function decodeSingleByte(bytes: Uint8Array): string {
  return new TextDecoder("windows-1252").decode(bytes);
}

function findSubarray(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let index = start; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return index;
  }
  return -1;
}
