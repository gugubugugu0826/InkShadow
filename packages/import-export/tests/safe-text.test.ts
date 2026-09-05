import { describe, expect, it } from "vitest";

import {
  assertSafeBundlePath,
  assertSafeInputFilename,
  createPortableBundle,
  exportProjectToMarkdown,
  exportProjectToPlainText,
  getAllowedImportExtension,
  importHtmlDocument,
  importMarkdownDocument,
  importPlainTextDocument,
  sanitizeFilename,
  sanitizeMarkdown,
  type PortableBundleMetadata,
  type PortableProjectInput,
} from "../src/index.js";

describe("safe text conversion", () => {
  it("converts inert HTML to local plain text without preserving executable markup", () => {
    const document = importHtmlDocument(
      "chapter.html",
      '<!doctype html><html><head><title>remote</title></head><body><h1>雨夜</h1><p>门开了 &amp; 灯亮了。</p><a href="https://attacker.example">外链</a></body></html>',
    );

    expect(document.title).toBe("chapter");
    expect(document.markdown).toContain("雨夜");
    expect(document.markdown).toContain("门开了 &amp; 灯亮了。");
    expect(document.markdown).toContain("外链");
    expect(document.markdown).not.toContain("attacker.example");
    expect(document.markdown).not.toContain("<h1>");
    expect(document.issues.map(({ code }) => code)).toContain("HTML_MARKUP_REMOVED");
  });

  it("rejects active or remote-resource HTML instead of parsing it in a live DOM", () => {
    for (const content of [
      "<script>alert(1)</script>",
      '<img src="https://attacker.example/pixel">',
      "<style>body{background:url(https://attacker.example)}</style>",
      '<svg onload="alert(1)"></svg>',
      '<form action="https://attacker.example"><input></form>',
    ]) {
      expect(() => importHtmlDocument("chapter.html", content)).toThrow(
        expect.objectContaining({ code: "IMPORT_UNSAFE_CONTENT" }),
      );
    }
  });

  it("neutralizes raw HTML, executable schemes, images, and network references", () => {
    const input = [
      "# Safe heading",
      '<script src="https://attacker.example/a.js">run()</script>',
      '<img src=x onerror="javascript:alert(1)">',
      "![tracking](https://attacker.example/pixel)",
      "[leave](https://attacker.example)",
      "<https://attacker.example/auto>",
      "ftp://attacker.example/file",
      "> a normal blockquote",
    ].join("\n");

    const result = sanitizeMarkdown(input, "chapter.md");

    expect(result.markdown).toContain("# Safe heading");
    expect(result.markdown).toContain("&lt;script");
    expect(result.markdown).toContain("&lt;img");
    expect(result.markdown).toContain("> a normal blockquote");
    expect(result.markdown).not.toMatch(/<(?:script|img)\b/i);
    expect(result.markdown).not.toMatch(/\b(?:https?|ftp|javascript):/i);
    expect(result.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["MARKDOWN_EXTERNAL_REFERENCE_REMOVED", "MARKDOWN_RAW_HTML_ESCAPED"]),
    );
  });

  it("treats plain text as text instead of Markdown or HTML", () => {
    const document = importPlainTextDocument(
      "ideas.txt",
      "<b>literal</b>\n# not a heading\n* not emphasis\nhttps://example.test",
    );

    expect(document.markdown).toContain("&lt;b&gt;literal&lt;/b&gt;");
    expect(document.markdown).toContain("\\# not a heading");
    expect(document.markdown).toContain("\\* not emphasis");
    expect(document.markdown).not.toContain("https://");
  });

  it("rejects binary signatures disguised as text", () => {
    expect(() => importMarkdownDocument("archive.md", "PK\u0003\u0004payload")).toThrow(
      expect.objectContaining({
        code: "IMPORT_BINARY_FORMAT_FORBIDDEN",
      }),
    );
    expect(() => importPlainTextDocument("document.txt", "%PDF-1.7")).toThrow(
      expect.objectContaining({
        code: "IMPORT_BINARY_FORMAT_FORBIDDEN",
      }),
    );
    expect(() => importPlainTextDocument("document.txt", "\uFEFF%PDF-1.7")).toThrow(
      expect.objectContaining({
        code: "IMPORT_BINARY_FORMAT_FORBIDDEN",
      }),
    );
  });

  it("does not let direct import APIs bypass extension policy", () => {
    expect(() => importMarkdownDocument("chapter.txt", "Text.")).toThrow(
      expect.objectContaining({
        code: "IMPORT_EXTENSION_FORBIDDEN",
      }),
    );
    expect(() => importPlainTextDocument("chapter.docm", "Text.")).toThrow(
      expect.objectContaining({
        code: "IMPORT_MACRO_FORMAT_FORBIDDEN",
      }),
    );
  });

  it("exports a combined Markdown document without executable or network content", async () => {
    const input = {
      project: {
        id: "project-safe-export",
        title: "CON: project",
        description: "Local notes with https://attacker.example and <iframe>.",
        language: "en",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:01:00.000Z",
      },
      chapters: [
        {
          id: "chapter-safe-export",
          title: "Opening #1",
          order: 0,
          markdown: 'Text [outside](https://attacker.example) <img onerror="alert(1)">',
        },
      ],
    } satisfies PortableProjectInput;
    const metadata = {
      bundleId: "bundle-safe-export",
      exportedAt: "2026-07-27T00:02:00.000Z",
      generatorVersion: "0.1.0",
    } satisfies PortableBundleMetadata;
    const bundle = await createPortableBundle(input, metadata);

    const artifact = exportProjectToMarkdown(bundle.content);

    expect(artifact.fileName).toBe("CON- project.md");
    expect(artifact.content).toContain("# CON: project");
    expect(artifact.content).toContain("## Opening \\#1");
    expect(artifact.content).not.toMatch(/\bhttps?:/i);
    expect(artifact.content).not.toMatch(/<(?:iframe|img)\b/i);
    expect(artifact.byteLength).toBeGreaterThan(0);
  });

  it("exports ordered plain text without Markdown control syntax or network references", async () => {
    const bundle = await createPortableBundle(
      {
        project: {
          id: "project-text-export",
          title: "纯文本长篇",
          language: "zh-CN",
          createdAt: "2026-07-27T00:00:00.000Z",
          updatedAt: "2026-07-27T00:01:00.000Z",
        },
        chapters: [
          {
            id: "chapter-text-export",
            title: "第一章",
            order: 0,
            markdown:
              "## 小节\n\n**雾港** [外链](https://attacker.example) `钟声`。\n\nPUBLIC_LONG_EXPORT_TAIL_终 中文_原文_编号 A__B__C _斜体_ __加重__ \\_保留\\_",
          },
        ],
      },
      {
        bundleId: "bundle-text-export",
        exportedAt: "2026-07-27T00:02:00.000Z",
        generatorVersion: "0.1.0",
      },
    );

    const artifact = exportProjectToPlainText(bundle.content);

    expect(artifact.fileName).toBe("纯文本长篇.txt");
    expect(artifact.content).toContain("纯文本长篇\n\n第一章\n\n小节");
    expect(artifact.content).toContain("雾港 外链 钟声。");
    expect(artifact.content).toContain(
      "PUBLIC_LONG_EXPORT_TAIL_终 中文_原文_编号 A__B__C 斜体 加重 _保留_",
    );
    expect(artifact.content).not.toMatch(/\bhttps?:/iu);
    expect(artifact.content).not.toContain("**");
  });

  it("exports an empty chapter to Markdown and TXT while preserving its title", async () => {
    expect(() => importMarkdownDocument("empty.md", "")).toThrow(
      expect.objectContaining({ code: "MARKDOWN_EMPTY" }),
    );
    const bundle = await createPortableBundle(
      {
        project: {
          id: "project-empty-text-export",
          title: "空白章节项目",
          language: "zh-CN",
          createdAt: "2026-07-27T00:00:00.000Z",
          updatedAt: "2026-07-27T00:01:00.000Z",
        },
        chapters: [
          {
            id: "chapter-empty-text-export",
            title: "待写章节",
            order: 0,
            markdown: "",
          },
        ],
      },
      {
        bundleId: "bundle-empty-text-export",
        exportedAt: "2026-07-27T00:02:00.000Z",
        generatorVersion: "0.1.0",
      },
    );

    const markdown = exportProjectToMarkdown(bundle.content);
    const text = exportProjectToPlainText(bundle.content);
    expect(markdown.content).toContain("## 待写章节");
    expect(text.content).toContain("待写章节");
  });
});

describe("file and path boundaries", () => {
  it("cleans output file names and protects Windows reserved names", () => {
    expect(sanitizeFilename(' CON <>:"/\\|?* .', ".md")).toBe("_CON.md");
    expect(sanitizeFilename("../unsafe", ".md")).toBe("unsafe.md");
    expect(sanitizeFilename("", ".md")).toBe("untitled.md");
  });

  it("rejects input file paths and encoded bundle traversal", () => {
    expect(() => assertSafeInputFilename("../chapter.md")).toThrow(
      expect.objectContaining({
        code: "IMPORT_PATH_TRAVERSAL",
      }),
    );
    expect(() => assertSafeInputFilename("%25252e%25252e%25252fsecret.md")).toThrow(
      expect.objectContaining({
        code: "IMPORT_PATH_TRAVERSAL",
      }),
    );
    expect(() => assertSafeBundlePath("chapters/%252e%252e/secret.md")).toThrow(
      expect.objectContaining({
        code: "IMPORT_PATH_TRAVERSAL",
      }),
    );
  });

  it("allows only JSON bundles, inert HTML, Markdown, and plain text", () => {
    expect(getAllowedImportExtension("draft.inkshadow.json")).toBe(".inkshadow.json");
    expect(getAllowedImportExtension("draft.markdown")).toBe(".markdown");
    expect(getAllowedImportExtension("payload.html")).toBe(".html");
    expect(() => getAllowedImportExtension("payload.docm")).toThrow(
      expect.objectContaining({
        code: "IMPORT_MACRO_FORMAT_FORBIDDEN",
      }),
    );
    expect(() => getAllowedImportExtension("payload.exe")).toThrow(
      expect.objectContaining({
        code: "IMPORT_EXTENSION_FORBIDDEN",
      }),
    );
  });
});
