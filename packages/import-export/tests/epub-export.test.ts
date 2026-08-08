import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { importEpubDocuments } from "../src/binary.js";
import {
  EPUB_MEDIA_TYPE,
  exportProjectToEpub,
  exportPublicationToEpub,
  type EpubExportProgress,
} from "../src/epub-export.js";
import type { PortablePublication } from "../src/publication-model.js";
import type { PortableProjectV1 } from "../src/schemas.js";

const GENERATED_AT = "2026-08-08T12:34:56.789Z";

const project = {
  project: {
    id: "project-epub-1",
    title: "雾港长篇",
    description: "一部关于记忆与旧城的长篇小说。",
    language: "zh-CN",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
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
    id: "project-epub-semantic",
    title: "墨影 <长篇> & 归途",
    description: "安全、离线、可携带。",
    language: "zh-CN",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  },
  chapters: [
    {
      id: "chapter-semantic",
      title: "第一章 风起",
      order: 0,
      sourcePath: "chapters/0001.md",
      blocks: [
        { kind: "heading", level: 1, text: "旧城", sourceLine: 1 },
        {
          kind: "paragraph",
          text: '雨声里写着 </p><script>bad()</script> & "不可注入"。',
          sourceLine: 2,
        },
        { kind: "unorderedListItem", depth: 0, text: "一盏灯", sourceLine: 4 },
        { kind: "unorderedListItem", depth: 0, text: "一封信", sourceLine: 5 },
        { kind: "orderedListItem", depth: 0, ordinal: 3, text: "第三次叩门", sourceLine: 6 },
        { kind: "quote", text: "别回头。", sourceLine: 7 },
        {
          kind: "code",
          text: "const shadow = '<script>';\nreturn shadow;",
          language: "typescript",
          sourceLine: 8,
        },
        { kind: "sceneBreak", sourceLine: 10 },
        { kind: "paragraph", text: "尾声仍在继续。", sourceLine: 11 },
      ],
    },
  ],
  warnings: [],
  statistics: { chapterCount: 1, blockCount: 9, textCharacters: 100 },
} satisfies PortablePublication;

describe("EPUB export", () => {
  it("creates a standards-shaped EPUB 3 package with ordered Chinese chapters", async () => {
    const artifact = await exportProjectToEpub(project, { generatedAt: GENERATED_AT });
    const archive = await JSZip.loadAsync(artifact.bytes);

    expect(artifact.fileName).toBe("雾港长篇.epub");
    expect(artifact.mediaType).toBe(EPUB_MEDIA_TYPE);
    expect(artifact.byteLength).toBe(artifact.bytes.byteLength);
    expect(await requiredText(archive, "mimetype")).toBe(EPUB_MEDIA_TYPE);
    expect(Object.keys(archive.files)[0]).toBe("mimetype");
    expect(readFirstLocalCompressionMethod(artifact.bytes)).toBe(0);

    const container = await requiredText(archive, "META-INF/container.xml");
    const packageDocument = await requiredText(archive, "EPUB/package.opf");
    const navigation = await requiredText(archive, "EPUB/nav.xhtml");
    const first = await requiredText(archive, "EPUB/chapter-00001.xhtml");
    const second = await requiredText(archive, "EPUB/chapter-00002.xhtml");

    expect(container).toContain('full-path="EPUB/package.opf"');
    expect(packageDocument).toContain('version="3.0"');
    expect(packageDocument).toContain('properties="nav"');
    expect(packageDocument).toContain("2026-08-08T12:34:56Z");
    expect(navigation.indexOf("第一章 雨巷")).toBeLessThan(navigation.indexOf("第二章 来客"));
    expect(first).toContain("雨落在旧城。");
    expect(first).toContain("灯火未熄。");
    expect(second).toContain("门外响起三声叩门。");
    expect(second).toContain("夜色没有回答。");
  });

  it("renders semantic blocks as inert XHTML without scripts or remote resources", async () => {
    const artifact = await exportPublicationToEpub(publication, { generatedAt: GENERATED_AT });
    const archive = await JSZip.loadAsync(artifact.bytes);
    const chapter = await requiredText(archive, "EPUB/chapter-00001.xhtml");
    const packageDocument = await requiredText(archive, "EPUB/package.opf");

    expect(chapter).toContain("<h2>旧城</h2>");
    expect(chapter).toContain("&lt;/p&gt;&lt;script&gt;bad()&lt;/script&gt;");
    expect(chapter).toContain("<ul");
    expect(chapter).toContain("<ol");
    expect(chapter).toContain('start="3"');
    expect(chapter).toContain("<blockquote>");
    expect(chapter).toContain("<pre><code");
    expect(chapter).toContain("<hr");
    expect(chapter).not.toMatch(/<script\b/iu);
    expect(packageDocument).not.toMatch(
      /\b(?:href|src)\s*=\s*["'](?:https?:|file:|javascript:|\/\/)|remote-resources|scripted/iu,
    );
    expect(Object.keys(archive.files).some((name) => name.endsWith(".js"))).toBe(false);
  });

  it("round-trips through the hardened local EPUB importer as real chapter documents", async () => {
    const artifact = await exportProjectToEpub(project, { generatedAt: GENERATED_AT });
    const documents = await importEpubDocuments(artifact.fileName, artifact.bytes);

    expect(documents).toHaveLength(2);
    expect(documents.map(({ title }) => title)).toEqual(["第一章 雨巷", "第二章 来客"]);
    expect(documents[0]?.markdown).toContain("雨落在旧城。");
    expect(documents[1]?.markdown).toContain("夜色没有回答。");
    expect(documents.every(({ sourceFormat }) => sourceFormat === "epub")).toBe(true);
  });

  it("uses fixed ZIP metadata and normalized time for deterministic bytes", async () => {
    const first = await exportProjectToEpub(project, {
      generatedAt: "2026-08-08T22:34:56.789+10:00",
    });
    const second = await exportProjectToEpub(project, { generatedAt: GENERATED_AT });

    expect(first.bytes).toEqual(second.bytes);
  });

  it("cancels before packaging completes and never returns a partial artifact", async () => {
    const controller = new AbortController();
    const progress: EpubExportProgress[] = [];

    await expect(
      exportProjectToEpub(project, {
        generatedAt: GENERATED_AT,
        signal: controller.signal,
        onProgress: (event) => {
          progress.push(event);
          if (event.stage === "packaging" && event.completedUnits === 1) {
            controller.abort();
          }
        },
      }),
    ).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });
    expect(progress.some(({ stage }) => stage === "packaging")).toBe(true);
  });

  it("rejects invalid generatedAt metadata before returning a file", async () => {
    await expect(exportProjectToEpub(project, { generatedAt: "2026-08-08" })).rejects.toMatchObject(
      { code: "EPUB_RENDER_FAILED" },
    );
  });
});

async function requiredText(archive: JSZip, name: string): Promise<string> {
  const entry = archive.file(name);
  if (entry === null) {
    throw new Error(`Missing EPUB entry: ${name}`);
  }
  return entry.async("string");
}

function readFirstLocalCompressionMethod(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  return view.getUint16(8, true);
}
