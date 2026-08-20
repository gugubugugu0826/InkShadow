import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { exportProjectToDocx, exportPublicationToDocx } from "../src/docx-export.js";
import { exportProjectToEpub, exportPublicationToEpub } from "../src/epub-export.js";
import { normalizePortablePublication } from "../src/publication-model.js";
import type { PublicationImageAsset } from "../src/publication-images.js";
import type { PortableProjectV1 } from "../src/schemas.js";
import { ONE_PIXEL_PNG } from "./image-fixture.js";

const GENERATED_AT = "2026-08-20T00:02:00.000Z";
const LONG_END_TOKEN = "长正文终点令牌";
const IMAGE_ASSET = {
  path: "assets/harbor.png",
  mediaType: "image/png",
  bytes: ONE_PIXEL_PNG,
} satisfies PublicationImageAsset;

const project = {
  project: {
    id: "project-image-formats",
    title: "墨影图片格式验收",
    description: "验证章节顺序、中文长正文与真实图片。",
    language: "zh-CN",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:01:00.000Z",
  },
  chapters: [
    {
      id: "chapter-second",
      title: "第二章 归途",
      order: 2,
      path: "chapters/0002.md",
      markdown: `潮声渐远。${"长篇中文内容。".repeat(4_000)}${LONG_END_TOKEN}`,
    },
    {
      id: "chapter-first",
      title: "第一章 雾港",
      order: 1,
      path: "chapters/0001.md",
      markdown: "雾中灯塔。\n\n![雾港场景](assets/harbor.png)\n\n她继续前行。",
    },
  ],
} satisfies PortableProjectV1;

describe("DOCX and EPUB publication images", () => {
  it("embeds a parseable image part and relationship in the real DOCX package", async () => {
    const artifact = await exportProjectToDocx(project, {
      generatedAt: GENERATED_AT,
      imageAssets: [IMAGE_ASSET],
    });
    const archive = await JSZip.loadAsync(artifact.bytes);
    const documentXml = await archive.file("word/document.xml")?.async("string");
    const relationships = await archive.file("word/_rels/document.xml.rels")?.async("string");
    const contentTypes = await archive.file("[Content_Types].xml")?.async("string");
    const embedded = await archive.file("word/media/image-0001.png")?.async("uint8array");

    expect(embedded).toEqual(ONE_PIXEL_PNG);
    expect(documentXml).toContain("<w:drawing>");
    expect(documentXml).toContain('descr="雾港场景"');
    expect(documentXml).toContain('r:embed="rId6"');
    expect(relationships).toContain('Target="media/image-0001.png"');
    expect(contentTypes).toContain('Extension="png" ContentType="image/png"');
    expect(documentXml?.indexOf("第一章 雾港")).toBeLessThan(
      documentXml?.indexOf("第二章 归途") ?? -1,
    );
    expect(documentXml).toContain(LONG_END_TOKEN);
    expect(artifact.issues).toEqual([]);
  });

  it("embeds a manifest-declared image and safe XHTML reference in the real EPUB package", async () => {
    const artifact = await exportProjectToEpub(project, {
      generatedAt: GENERATED_AT,
      imageAssets: [IMAGE_ASSET],
    });
    const archive = await JSZip.loadAsync(artifact.bytes);
    const packageXml = await archive.file("EPUB/package.opf")?.async("string");
    const navigation = await archive.file("EPUB/nav.xhtml")?.async("string");
    const firstChapter = await archive.file("EPUB/chapter-00001.xhtml")?.async("string");
    const secondChapter = await archive.file("EPUB/chapter-00002.xhtml")?.async("string");
    const embedded = await archive.file("EPUB/images/image-0001.png")?.async("uint8array");

    expect(embedded).toEqual(ONE_PIXEL_PNG);
    expect(packageXml).toContain('href="images/image-0001.png" media-type="image/png"');
    expect(firstChapter).toContain(
      '<img src="images/image-0001.png" alt="雾港场景" width="1" height="1"/>',
    );
    expect(firstChapter).not.toMatch(/(?:src|href)="(?:https?|file|javascript):/iu);
    expect(navigation?.indexOf("第一章 雾港")).toBeLessThan(
      navigation?.indexOf("第二章 归途") ?? -1,
    );
    expect(secondChapter).toContain(LONG_END_TOKEN);
    expect(artifact.issues).toEqual([]);
  });

  it("fails closed if accepted image bytes are changed before packaging", async () => {
    const forDocx = normalizePortablePublication(project, { imageAssets: [IMAGE_ASSET] });
    const docxImage = forDocx.chapters[0]?.blocks.find(({ kind }) => kind === "image");
    if (docxImage === undefined || docxImage.kind !== "image") {
      throw new Error("Expected a normalized DOCX image fixture.");
    }
    docxImage.bytes[0] = 0;
    await expect(
      exportPublicationToDocx(forDocx, { generatedAt: GENERATED_AT }),
    ).rejects.toMatchObject({ code: "DOCX_RENDER_FAILED" });

    const forEpub = normalizePortablePublication(project, { imageAssets: [IMAGE_ASSET] });
    const epubImage = forEpub.chapters[0]?.blocks.find(({ kind }) => kind === "image");
    if (epubImage === undefined || epubImage.kind !== "image") {
      throw new Error("Expected a normalized EPUB image fixture.");
    }
    epubImage.bytes[0] = 0;
    await expect(
      exportPublicationToEpub(forEpub, { generatedAt: GENERATED_AT }),
    ).rejects.toMatchObject({ code: "EPUB_RENDER_FAILED" });
  });
});
