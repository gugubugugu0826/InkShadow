import { describe, expect, it } from "vitest";

import { exportProjectToMarkdown } from "../src/markdown-export.js";
import {
  PUBLICATION_IMAGE_LIMITS,
  createPortableBundle,
  normalizePortablePublication,
  type PublicationImageAsset,
} from "../src/index.js";
import type { PortableProjectV1 } from "../src/schemas.js";
import { sanitizeMarkdown } from "../src/text.js";
import {
  ONE_PIXEL_JPEG,
  ONE_PIXEL_JPEG_BASE64,
  ONE_PIXEL_PNG,
  ONE_PIXEL_PNG_BASE64,
} from "./image-fixture.js";

const project = (markdown: string): PortableProjectV1 => ({
  project: {
    id: "project-images",
    title: "墨影图片导出",
    description: "图片、中文与长正文均保持离线。",
    language: "zh-CN",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:01:00.000Z",
  },
  chapters: [
    {
      id: "chapter-images",
      title: "第一章 雾港",
      order: 0,
      path: "chapters/0001.md",
      markdown,
    },
  ],
});

describe("publication image boundary", () => {
  it("keeps a validated inline PNG as a semantic image and a self-contained Markdown image", () => {
    const source = project(
      `正文开始。 ![雾港像素图](data:image/png;base64,${ONE_PIXEL_PNG_BASE64}) 正文结束。`,
    );

    const publication = normalizePortablePublication(source);
    expect(publication.chapters[0]?.blocks.map(({ kind }) => kind)).toEqual([
      "paragraph",
      "image",
      "paragraph",
    ]);
    expect(publication.chapters[0]?.blocks[1]).toMatchObject({
      kind: "image",
      altText: "雾港像素图",
      mediaType: "image/png",
      pixelWidth: 1,
      pixelHeight: 1,
    });
    const artifact = exportProjectToMarkdown(source);
    expect(artifact.content).toContain(
      `![雾港像素图](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})`,
    );
    expect(artifact.content.indexOf("正文开始。")).toBeLessThan(
      artifact.content.indexOf("正文结束。"),
    );
    expect(artifact.issues).toEqual([]);
  });

  it("keeps a safe inline image through the existing portable-bundle content chain", async () => {
    const source = project(`正文。\n\n![本地图](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})`);
    const bundle = await createPortableBundle(
      {
        project: source.project,
        chapters: source.chapters.map(({ id, markdown, order, title }) => ({
          id,
          markdown,
          order,
          title,
        })),
      },
      {
        bundleId: "bundle-images",
        exportedAt: "2026-08-20T00:02:00.000Z",
        generatorVersion: "0.2.5",
      },
    );

    expect(bundle.content.chapters[0]?.markdown).toContain(
      `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
    );
    expect(normalizePortablePublication(bundle.content).chapters[0]?.blocks[1]).toMatchObject({
      kind: "image",
      altText: "本地图",
    });
  });

  it("accepts a fully structured baseline JPEG whose encoded source exceeds a path limit", () => {
    expect(ONE_PIXEL_JPEG_BASE64.length).toBeGreaterThan(
      PUBLICATION_IMAGE_LIMITS.maximumSourceCharacters,
    );
    const publication = normalizePortablePublication(
      project(`![红色像素](data:image/jpeg;base64,${ONE_PIXEL_JPEG_BASE64})`),
    );
    const image = publication.chapters[0]?.blocks[0];

    expect(image).toMatchObject({
      kind: "image",
      altText: "红色像素",
      mediaType: "image/jpeg",
      pixelWidth: 1,
      pixelHeight: 1,
    });
    expect(image !== undefined && "bytes" in image ? image.bytes : undefined).toEqual(
      ONE_PIXEL_JPEG,
    );
  });

  it("resolves only explicitly supplied project-local bytes and never reads paths", () => {
    const asset = {
      path: "assets/scene.png",
      mediaType: "image/png",
      bytes: ONE_PIXEL_PNG,
    } satisfies PublicationImageAsset;
    const source = project(
      [
        "![本地场景](assets/scene.png)",
        "",
        "![缺失图片](assets/missing.png)",
        "",
        "![越界图片](../secret.png)",
        "",
        "![远程图片](https://example.invalid/image.png)",
      ].join("\n"),
    );

    const publication = normalizePortablePublication(source, { imageAssets: [asset] });
    expect(publication.chapters[0]?.blocks[0]).toMatchObject({
      kind: "image",
      altText: "本地场景",
    });
    const text = publication.chapters[0]?.blocks
      .flatMap((block) => ("text" in block ? [block.text] : []))
      .join("\n");
    expect(text).toContain("[image omitted: 缺失图片]");
    expect(text).toContain("[image omitted: 越界图片]");
    expect(text).toContain("[image omitted: 远程图片]");
    expect(JSON.stringify(publication)).not.toMatch(/https?:|\.\.\/|secret\.png/u);
    expect(publication.warnings.map(({ code }) => code)).toContain(
      "PUBLICATION_IMAGE_REFERENCE_REMOVED",
    );

    const markdown = exportProjectToMarkdown(source, { imageAssets: [asset] });
    expect(markdown.content).toContain(`data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`);
    expect(markdown.content).toContain("[image omitted: 缺失图片]");
    expect(markdown.content).not.toMatch(/https?:|\.\.\/|secret\.png/u);
  });

  it("omits malformed, oversized-count, and executable image sources with readable evidence", () => {
    const invalidPng = `${ONE_PIXEL_PNG_BASE64.slice(0, -4)}AAAA`;
    const repeated = Array.from(
      { length: PUBLICATION_IMAGE_LIMITS.maximumImages + 1 },
      (_unused, index) => `![图${String(index)}](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})`,
    );
    const publication = normalizePortablePublication(
      project(
        [
          `![损坏图](data:image/png;base64,${invalidPng})`,
          "![脚本图](javascript:alert)",
          ...repeated,
        ].join("\n\n"),
      ),
    );

    expect(publication.chapters[0]?.blocks).toHaveLength(
      PUBLICATION_IMAGE_LIMITS.maximumImages + 3,
    );
    expect(publication.warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "PUBLICATION_IMAGE_INVALID",
        "PUBLICATION_IMAGE_REFERENCE_REMOVED",
        "PUBLICATION_IMAGE_LIMIT_REACHED",
      ]),
    );
    expect(
      publication.chapters[0]?.blocks.some(
        (block) => "text" in block && block.text === "[image omitted: 图128]",
      ),
    ).toBe(true);

    const sanitized = sanitizeMarkdown(
      `![安全图](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})\n\n![远程图](file:///secret.png)`,
      "chapter.md",
    );
    expect(sanitized.markdown).toContain(`data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`);
    expect(sanitized.markdown).toContain("[image omitted: 远程图]");
    expect(sanitized.markdown).not.toContain("file:");
  });
});
