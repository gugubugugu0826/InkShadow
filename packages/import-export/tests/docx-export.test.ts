import JSZip from "jszip";
import mammoth from "mammoth";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DOCX_ENTRY_NAMES,
  DOCX_OUTPUT_LIMIT_BYTES,
  exportProjectToDocx,
  exportPublicationToDocx,
  type DocxExportProgress,
} from "../src/docx-export.js";
import type { PortablePublication } from "../src/publication-model.js";
import type { PortableProjectV1 } from "../src/schemas.js";

const GENERATED_AT = "2026-07-28T00:30:45.123Z";

const project = {
  project: {
    id: "project-docx-1",
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
      markdown: "门外响起三声叩门。\n\n夜色没有回答。",
    },
    {
      id: "chapter-1",
      title: "第一章 雨巷",
      order: 1,
      path: "chapters/0001.md",
      markdown: "雨落在旧城。\n\n灯火未熄。",
    },
  ],
} satisfies PortableProjectV1;

const publication = {
  format: "inkshadow-portable-publication",
  version: 1,
  project: {
    id: "project-semantic-1",
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
        {
          kind: "paragraph",
          text: '雨声里写着 </w:t><w:object> & "不可注入"。',
          sourceLine: 2,
        },
        { kind: "unorderedListItem", depth: 0, text: "一盏灯", sourceLine: 4 },
        {
          kind: "orderedListItem",
          depth: 0,
          ordinal: 3,
          text: "第三次叩门",
          sourceLine: 5,
        },
        { kind: "quote", text: "“别回头。”", sourceLine: 6 },
        {
          kind: "code",
          text: "const shadow = '墨';\nreturn shadow;",
          language: "typescript",
          sourceLine: 7,
        },
        { kind: "sceneBreak", sourceLine: 10 },
        { kind: "paragraph", text: "尾声仍在继续。", sourceLine: 11 },
      ],
    },
  ],
  warnings: [
    {
      code: "PUBLICATION_INLINE_MARKUP_FLATTENED",
      message: "Inline formatting was flattened for portable publication.",
      chapterId: "chapter-semantic-1",
      sourcePath: "chapters/0001.md",
      sourceLine: 2,
    },
  ],
  statistics: {
    chapterCount: 1,
    blockCount: 8,
    textCharacters: 83,
  },
} satisfies PortablePublication;

afterEach(() => {
  vi.doUnmock("jszip");
});

describe("DOCX export", () => {
  it("normalizes a project and preserves Chinese chapter order and complete body text", async () => {
    const artifact = await exportProjectToDocx(project, { generatedAt: GENERATED_AT });
    const rawText = await extractRawText(artifact.bytes);

    expect(artifact.mediaType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(artifact.fileName).toBe("墨影长篇.docx");
    expect(artifact.byteLength).toBe(artifact.bytes.byteLength);
    expect(rawText).toContain("墨影长篇");
    expect(rawText).toContain("第一章 雨巷");
    expect(rawText).toContain("雨落在旧城。");
    expect(rawText).toContain("灯火未熄。");
    expect(rawText).toContain("第二章 来客");
    expect(rawText).toContain("门外响起三声叩门。");
    expect(rawText).toContain("夜色没有回答。");
    expect(rawText.indexOf("第一章 雨巷")).toBeLessThan(rawText.indexOf("第二章 来客"));
  });

  it("exports an empty chapter as a titled DOCX section", async () => {
    const sourceChapter = project.chapters[0];
    if (sourceChapter === undefined) throw new Error("Expected a DOCX source chapter.");
    const emptyProject = {
      ...project,
      chapters: [{ ...sourceChapter, order: 0, markdown: "" }],
    } satisfies PortableProjectV1;

    const artifact = await exportProjectToDocx(emptyProject, { generatedAt: GENERATED_AT });
    expect(await extractRawText(artifact.bytes)).toContain("第二章 来客");
  });

  it("renders every semantic block through native Word styles and numbering", async () => {
    const artifact = await exportPublicationToDocx(publication, { generatedAt: GENERATED_AT });
    const archive = await JSZip.loadAsync(artifact.bytes);
    const documentXml = await requiredText(archive, "word/document.xml");
    const styles = await requiredText(archive, "word/styles.xml");
    const numbering = await requiredText(archive, "word/numbering.xml");
    const header = await requiredText(archive, "word/header1.xml");
    const rawText = await extractRawText(artifact.bytes);

    for (const expected of [
      "第一章 风起",
      "旧城",
      "雨声里写着",
      "一盏灯",
      "第三次叩门",
      "别回头",
      "const shadow = '墨';",
      "return shadow;",
      "＊　＊　＊",
      "尾声仍在继续。",
    ]) {
      expect(rawText).toContain(expected);
    }
    expect(documentXml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(documentXml).toContain('<w:pStyle w:val="Heading2"/>');
    expect(documentXml).toContain('<w:pStyle w:val="Quote"/>');
    expect(documentXml).toContain('<w:pStyle w:val="CodeBlock"/>');
    expect(documentXml).toContain('<w:pStyle w:val="SceneBreak"/>');
    expect(documentXml).toContain("<w:numPr>");
    expect(numbering).toContain('<w:numFmt w:val="bullet"/>');
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>');
    expect(numbering).toContain('<w:startOverride w:val="3"/>');
    expect(styles).toContain('w:styleId="Heading1"');
    expect(styles).toContain('w:name w:val="heading 1"');
    expect(styles).toContain('w:sz w:val="22"');
    expect(styles).toContain('w:firstLine="440"');
    expect(styles).toContain('w:line="378" w:lineRule="auto"');
    expect(styles).toContain('w:ascii="Noto Serif CJK SC"');
    expect(styles).toContain('w:eastAsia="Microsoft YaHei"');
    expect(documentXml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(documentXml).toContain(
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>',
    );
    expect(documentXml).not.toContain('<w:br w:type="page"/>');
    expect(header).toContain("<w:instrText");
    expect(header).toContain(" PAGE ");
    expect(artifact.issues).toEqual(publication.warnings);
  });

  it("emits only the frozen safe OOXML allowlist and no external or active content", async () => {
    const artifact = await exportPublicationToDocx(publication, { generatedAt: GENERATED_AT });
    const archive = await JSZip.loadAsync(artifact.bytes);

    expect(Object.keys(archive.files)).toEqual([...DOCX_ENTRY_NAMES]);
    for (const name of Object.keys(archive.files)) {
      expect(name.toLowerCase()).not.toMatch(
        /(?:vbaproject|macros|embeddings|oleobject|activex|altchunk|customxml)/u,
      );
      const entry = archive.file(name);
      expect(entry).not.toBeNull();
      if (name.endsWith(".xml") || name.endsWith(".rels")) {
        const xml = await requiredText(archive, name);
        expect(xml).not.toMatch(/\bTargetMode\s*=\s*["']External["']/iu);
        expect(xml).not.toMatch(/<(?:w:altChunk|w:object|o:OLEObject)\b/iu);
        expect(xml).not.toMatch(/relationships\/hyperlink/iu);
      }
    }
  });

  it("escapes XML injection and sanitizes title metadata without changing safe Chinese text", async () => {
    const artifact = await exportPublicationToDocx(publication, { generatedAt: GENERATED_AT });
    const archive = await JSZip.loadAsync(artifact.bytes);
    const documentXml = await requiredText(archive, "word/document.xml");
    const coreXml = await requiredText(archive, "docProps/core.xml");

    expect(documentXml).toContain("&lt;/w:t&gt;&lt;w:object&gt;");
    expect(documentXml).not.toContain("</w:t><w:object>");
    expect(documentXml).toContain("&amp; &quot;不可注入&quot;");
    expect(coreXml).toContain("<dc:title>墨影 &lt;长篇&gt; &amp; 归途</dc:title>");
    expect(coreXml).toContain("<dc:creator>InkShadow</dc:creator>");
    expect(coreXml).not.toContain("<长篇>");
  });

  it("uses injected metadata time, fixed ZIP order/timestamps, and deterministic bytes", async () => {
    const first = await exportPublicationToDocx(publication, {
      generatedAt: "2026-07-28T10:30:45.123+10:00",
    });
    const second = await exportPublicationToDocx(publication, {
      generatedAt: "2026-07-28T00:30:45.123Z",
    });
    const archive = await JSZip.loadAsync(first.bytes);
    const coreXml = await requiredText(archive, "docProps/core.xml");

    expect(first.bytes).toEqual(second.bytes);
    expect(coreXml).toContain(
      '<dcterms:created xsi:type="dcterms:W3CDTF">2026-07-28T00:30:45.123Z</dcterms:created>',
    );
    expect(coreXml).toContain(
      '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-07-28T00:30:45.123Z</dcterms:modified>',
    );
    for (const name of DOCX_ENTRY_NAMES) {
      const entry = archive.file(name);
      expect(entry).not.toBeNull();
      expect(entry?.date.getUTCFullYear()).toBe(1980);
      expect(entry?.date.getUTCMonth()).toBe(0);
      expect(entry?.date.getUTCDate()).toBe(1);
      expect(entry?.date.getUTCHours()).toBe(0);
      expect(entry?.date.getUTCMinutes()).toBe(0);
      expect(entry?.date.getUTCSeconds()).toBe(0);
    }
  });

  it("rejects invalid generatedAt without leaking the input into the error", async () => {
    const generatedAt = "</dcterms:created><script>alert(1)</script>";
    await expect(exportPublicationToDocx(publication, { generatedAt })).rejects.toMatchObject({
      name: "DocxExportError",
      code: "DOCX_RENDER_FAILED",
    });
    await expect(exportPublicationToDocx(publication, { generatedAt })).rejects.not.toThrow(
      generatedAt,
    );
  });

  it("cancels before normalization and during semantic rendering", async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      exportProjectToDocx(project, { generatedAt: GENERATED_AT, signal: before.signal }),
    ).rejects.toMatchObject({
      code: "EXPORT_CANCELLED",
    });

    const during = new AbortController();
    await expect(
      exportPublicationToDocx(publication, {
        generatedAt: GENERATED_AT,
        signal: during.signal,
        onProgress(progress) {
          if (progress.stage === "rendering" && progress.completedUnits > 0) {
            during.abort();
          }
        },
      }),
    ).rejects.toMatchObject({
      code: "EXPORT_CANCELLED",
    });
  });

  it("checks cancellation from the JSZip onUpdate callback", async () => {
    let packagingComplete = false;
    let checksAfterPackaging = 0;
    const signal = {
      get aborted() {
        if (!packagingComplete) {
          return false;
        }
        checksAfterPackaging += 1;
        return checksAfterPackaging >= 3;
      },
    } as AbortSignal;

    await expect(
      exportPublicationToDocx(publication, {
        generatedAt: GENERATED_AT,
        signal,
        onProgress(progress: DocxExportProgress) {
          if (progress.stage === "packaging" && progress.completedUnits === progress.totalUnits) {
            packagingComplete = true;
          }
        },
      }),
    ).rejects.toMatchObject({
      code: "EXPORT_CANCELLED",
    });
    expect(checksAfterPackaging).toBeGreaterThanOrEqual(3);
  });

  it("fails closed when the generated ZIP exceeds the 64 MiB output cap", async () => {
    vi.resetModules();
    vi.doMock("jszip", () => ({
      default: class OversizeZip {
        file(): this {
          return this;
        }

        generateAsync(
          _options: unknown,
          onUpdate: () => void,
        ): Promise<{ readonly byteLength: number }> {
          onUpdate();
          return Promise.resolve({ byteLength: DOCX_OUTPUT_LIMIT_BYTES + 1 });
        }
      },
    }));

    try {
      const isolated = await import("../src/docx-export.js");
      await expect(
        isolated.exportProjectToDocx(project, { generatedAt: GENERATED_AT }),
      ).rejects.toMatchObject({
        code: "EXPORT_OUTPUT_TOO_LARGE",
      });
    } finally {
      vi.doUnmock("jszip");
      vi.resetModules();
    }
  });
});

async function requiredText(archive: JSZip, name: string): Promise<string> {
  const entry = archive.file(name);
  if (entry === null) {
    throw new Error(`Required DOCX entry is missing: ${name}`);
  }
  return entry.async("string");
}

async function extractRawText(bytes: Uint8Array): Promise<string> {
  const bufferConstructor = (
    globalThis as unknown as {
      readonly Buffer: {
        from(value: Uint8Array): unknown;
      };
    }
  ).Buffer;
  const parser = mammoth as unknown as {
    extractRawText(input: { readonly buffer: unknown }): Promise<{ readonly value: string }>;
  };
  const result = await parser.extractRawText({ buffer: bufferConstructor.from(bytes) });
  return result.value;
}
