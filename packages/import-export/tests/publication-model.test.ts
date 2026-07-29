import { describe, expect, it } from "vitest";

import {
  normalizePortablePublication,
  PUBLICATION_FORMAT,
  PUBLICATION_LIMITS,
  PUBLICATION_VERSION,
  type PortableProjectV1,
  type PublicationBlock,
  type PublicationNormalizationProgress,
} from "../src/index.js";

const BASE_PROJECT: PortableProjectV1["project"] = {
  id: "project-publication",
  title: "墨影 Publication",
  description: "中文与 Latin text.",
  language: "zh-CN",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T01:00:00.000Z",
};

function portableProject(
  chapters: PortableProjectV1["chapters"],
  project: PortableProjectV1["project"] = BASE_PROJECT,
): PortableProjectV1 {
  return { project, chapters };
}

function chapter(
  id: string,
  order: number,
  markdown: string,
): PortableProjectV1["chapters"][number] {
  return {
    id,
    title: `Chapter ${id}`,
    order,
    path: `chapters/${id}.md`,
    markdown,
  };
}

function blockText(block: PublicationBlock): string {
  return "text" in block ? block.text : "";
}

describe("portable publication normalization", () => {
  it("revalidates input and applies a deterministic chapter order", () => {
    const source = portableProject([
      chapter("z-last-tie", 1, "Z"),
      chapter("chapter-two", 2, "Two"),
      chapter("a-first-tie", 1, "A"),
      chapter("chapter-zero", 0, "Zero"),
    ]);

    const first = normalizePortablePublication(source);
    const second = normalizePortablePublication(source);

    expect(first).toEqual(second);
    expect(first.format).toBe(PUBLICATION_FORMAT);
    expect(first.version).toBe(PUBLICATION_VERSION);
    expect(first.chapters.map(({ id }) => id)).toEqual([
      "chapter-zero",
      "a-first-tie",
      "z-last-tie",
      "chapter-two",
    ]);
    expect(first.statistics).toEqual({
      chapterCount: 4,
      blockCount: 4,
      textCharacters:
        first.project.title.length +
        (first.project.description?.length ?? 0) +
        first.chapters.reduce(
          (total, item) =>
            total +
            item.title.length +
            item.blocks.reduce((blockTotal, block) => blockTotal + blockText(block).length, 0),
          0,
        ),
    });

    expect(() =>
      normalizePortablePublication({
        ...source,
        project: {
          ...source.project,
          unexpected: true,
        },
      } as unknown as PortableProjectV1),
    ).toThrow(
      expect.objectContaining({
        code: "PUBLICATION_INPUT_INVALID",
      }),
    );
  });

  it("normalizes CRLF Markdown into the finite Chinese/Latin publication block set", () => {
    const source = portableProject([
      chapter(
        "mixed-blocks",
        0,
        [
          "# 雾港 Opening",
          "",
          "中文 **夜色** and *Latin emphasis*.",
          "- 无序 item",
          "  + nested item",
          "3. ordered item",
          "> 引文 quote",
          "* * *",
          "```ts",
          'const greeting = "<你好>";',
          "```",
        ].join("\r\n"),
      ),
    ]);

    const publication = normalizePortablePublication(source);
    const blocks = publication.chapters[0]?.blocks;

    expect(blocks?.map(({ kind }) => kind)).toEqual([
      "heading",
      "paragraph",
      "unorderedListItem",
      "unorderedListItem",
      "orderedListItem",
      "quote",
      "sceneBreak",
      "code",
    ]);
    expect(blocks?.[0]).toMatchObject({
      kind: "heading",
      level: 1,
      text: "雾港 Opening",
      sourceLine: 1,
    });
    expect(blocks?.[1]).toMatchObject({
      kind: "paragraph",
      text: "中文 夜色 and Latin emphasis.",
      sourceLine: 3,
    });
    expect(blocks?.[2]).toMatchObject({
      kind: "unorderedListItem",
      depth: 0,
      text: "无序 item",
    });
    expect(blocks?.[3]).toMatchObject({
      kind: "unorderedListItem",
      depth: 1,
      text: "nested item",
    });
    expect(blocks?.[4]).toMatchObject({
      kind: "orderedListItem",
      depth: 0,
      ordinal: 3,
      text: "ordered item",
    });
    expect(blocks?.[5]).toMatchObject({
      kind: "quote",
      text: "引文 quote",
    });
    expect(blocks?.[6]).toEqual({
      kind: "sceneBreak",
      sourceLine: 8,
    });
    expect(blocks?.[7]).toMatchObject({
      kind: "code",
      language: "ts",
      text: 'const greeting = "<你好>";',
      sourceLine: 9,
    });
    expect(blocks?.some((block) => "text" in block && block.text.includes("\r"))).toBe(false);
    expect(publication.warnings.map(({ code }) => code)).toContain(
      "PUBLICATION_INLINE_MARKUP_FLATTENED",
    );
  });

  it("keeps every visible body token while neutralizing HTML, links, and images", () => {
    const source = portableProject([
      chapter(
        "hostile-markup",
        0,
        [
          '<script src="https://attacker.example/payload.js">正文 alertToken()</script>',
          "",
          "![像素图](https://attacker.example/pixel.png) [保留标签](https://attacker.example/go)",
          "",
          "直接地址 https://attacker.example/direct。",
          "",
          "| 表格正文A | tableBodyB |",
          "",
          "unsupported ~~仍然保留~~ and `inlineToken`",
        ].join("\n"),
      ),
    ]);

    const publication = normalizePortablePublication(source);
    const visibleText = publication.chapters[0]?.blocks.map(blockText).join("\n") ?? "";

    for (const token of [
      "script",
      "正文",
      "alertToken",
      "像素图",
      "保留标签",
      "直接地址",
      "表格正文A",
      "tableBodyB",
      "仍然保留",
      "inlineToken",
    ]) {
      expect(visibleText).toContain(token);
    }
    expect(visibleText).toContain("[image omitted: 像素图]");
    expect(visibleText).not.toMatch(/\bhttps?:\/\//iu);
    expect(publication.chapters[0]?.blocks.map(({ kind }) => kind)).not.toContain("image");
    expect(publication.warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "PUBLICATION_RAW_HTML_PRESERVED_AS_TEXT",
        "PUBLICATION_EXTERNAL_REFERENCE_FLATTENED",
        "PUBLICATION_IMAGE_REFERENCE_REMOVED",
        "PUBLICATION_INLINE_MARKUP_FLATTENED",
      ]),
    );
  });

  it("preserves fenced code literally and safely closes an unfinished fence at EOF", () => {
    const source = portableProject([
      chapter(
        "code",
        0,
        [
          "```not/a/language",
          "const markdown = '**not emphasis**';",
          '<img src="https://example.test/literal">',
        ].join("\n"),
      ),
    ]);

    const publication = normalizePortablePublication(source);
    const code = publication.chapters[0]?.blocks[0];

    expect(code).toEqual({
      kind: "code",
      sourceLine: 1,
      text: [
        "const markdown = '**not emphasis**';",
        '<img src="https://example.test/literal">',
      ].join("\n"),
    });
    expect(publication.warnings.map(({ code: warningCode }) => warningCode)).toEqual(
      expect.arrayContaining([
        "PUBLICATION_CODE_LANGUAGE_REMOVED",
        "PUBLICATION_RAW_HTML_PRESERVED_AS_TEXT",
        "PUBLICATION_UNCLOSED_CODE_FENCE",
      ]),
    );
  });

  it("accepts the exact per-chapter block cap and rejects cap plus one without truncation", () => {
    const atCap = Array.from(
      { length: PUBLICATION_LIMITS.maximumBlocksPerChapter },
      (_unused, index) => `- token-${String(index)}`,
    ).join("\n");
    const publication = normalizePortablePublication(
      portableProject([chapter("at-cap", 0, atCap)]),
    );

    expect(publication.chapters[0]?.blocks).toHaveLength(
      PUBLICATION_LIMITS.maximumBlocksPerChapter,
    );
    expect(
      blockText(publication.chapters[0]?.blocks.at(-1) ?? { kind: "sceneBreak", sourceLine: 1 }),
    ).toBe(`token-${String(PUBLICATION_LIMITS.maximumBlocksPerChapter - 1)}`);

    const aboveCap = `${atCap}\n- token-over-cap`;
    expect(() =>
      normalizePortablePublication(portableProject([chapter("above-cap", 0, aboveCap)])),
    ).toThrow(
      expect.objectContaining({
        code: "PUBLICATION_LIMIT_EXCEEDED",
        limit: PUBLICATION_LIMITS.maximumBlocksPerChapter,
      }),
    );
  });

  it("supports pre-flight and cooperative in-progress cancellation with progress", () => {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    expect(() =>
      normalizePortablePublication(portableProject([chapter("cancelled", 0, "body")]), {
        signal: alreadyCancelled.signal,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PUBLICATION_ABORTED",
      }),
    );

    const controller = new AbortController();
    const progress: PublicationNormalizationProgress[] = [];
    const manyBlocks = Array.from(
      { length: 300 },
      (_unused, index) => `- item-${String(index)}`,
    ).join("\n");
    expect(() =>
      normalizePortablePublication(portableProject([chapter("cancel-midway", 0, manyBlocks)]), {
        signal: controller.signal,
        onProgress: (update) => {
          progress.push(update);
          if (update.completedBlocks >= 128) {
            controller.abort();
          }
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PUBLICATION_ABORTED",
      }),
    );
    expect(progress.some(({ completedBlocks }) => completedBlocks >= 128)).toBe(true);
    expect(progress.at(-1)?.phase).toBe("normalizing");
  });

  it("reports deterministic completion progress for an empty publication", () => {
    const progress: PublicationNormalizationProgress[] = [];
    const publication = normalizePortablePublication(portableProject([]), {
      onProgress: (update) => {
        progress.push(update);
      },
    });

    expect(publication.chapters).toEqual([]);
    expect(progress.map(({ phase }) => phase)).toEqual(["validating", "normalizing", "complete"]);
    expect(progress.at(-1)).toEqual({
      phase: "complete",
      completedChapters: 0,
      totalChapters: 0,
      completedBlocks: 0,
    });
  });
});
