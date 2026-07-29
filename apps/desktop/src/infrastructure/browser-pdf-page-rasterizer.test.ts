import { PDF_RENDER_SPEC } from "@inkshadow/import-export/pdf-export";
import type { PortablePublication } from "@inkshadow/import-export";
import { describe, expect, it, vi } from "vitest";

import { rasterizePublicationToJpegPages } from "./browser-pdf-page-rasterizer";

const publication = {
  format: "inkshadow-portable-publication",
  version: 1,
  project: {
    id: "project-pdf-cancellation",
    title: "长篇导出取消验收",
    language: "zh-CN",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
  chapters: [
    {
      id: "chapter-pdf-cancellation",
      title: "第一章",
      order: 0,
      sourcePath: "chapters/0001.md",
      blocks: [
        {
          kind: "paragraph",
          text: "墨".repeat(200_000),
          sourceLine: 1,
        },
      ],
    },
  ],
  warnings: [],
  statistics: {
    chapterCount: 1,
    blockCount: 1,
    textCharacters: 200_000,
  },
} satisfies PortablePublication;

describe("browser PDF page rasterizer", () => {
  it("yields during one oversized block so cancellation can interrupt layout", async () => {
    const controller = new AbortController();
    const originalGetContext = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    let measured = 0;
    let abortScheduled = false;
    const drawingContext = {
      measureText(value: string) {
        measured += 1;
        return { width: Array.from(value).length * 20 };
      },
    } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => drawingContext),
    });

    try {
      const source = rasterizePublicationToJpegPages(publication, {
        signal: controller.signal,
        renderSpec: PDF_RENDER_SPEC,
        reportProgress(progress) {
          if (!abortScheduled && progress.stage === "laying_out" && progress.completedUnits === 1) {
            abortScheduled = true;
            globalThis.setTimeout(() => controller.abort(), 0);
          }
        },
      });
      const consume = async (): Promise<void> => {
        for await (const page of source) {
          void page;
        }
      };

      await expect(consume()).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });
      expect(measured).toBeGreaterThan(0);
      expect(measured).toBeLessThan(10_000);
    } finally {
      if (originalGetContext === undefined) {
        Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
      } else {
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
      }
    }
  });

  it("fails closed before newline-heavy content can allocate unbounded layout lines", async () => {
    const originalGetContext = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    const drawingContext = {
      measureText(value: string) {
        return { width: Array.from(value).length * 20 };
      },
    } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => drawingContext),
    });
    const newlineHeavy = {
      ...publication,
      chapters: [
        {
          id: "chapter-pdf-newline-limit",
          title: "换行上限",
          order: 0,
          sourcePath: "chapters/0001.md",
          blocks: [{ kind: "paragraph", text: "\n".repeat(70_000), sourceLine: 1 }],
        },
      ],
    } satisfies PortablePublication;

    try {
      const source = rasterizePublicationToJpegPages(newlineHeavy, {
        renderSpec: PDF_RENDER_SPEC,
        reportProgress: vi.fn(),
      });
      const consume = async (): Promise<void> => {
        for await (const page of source) {
          void page;
        }
      };

      await expect(consume()).rejects.toMatchObject({
        code: "PDF_COMPLEXITY_LIMIT_EXCEEDED",
      });
    } finally {
      if (originalGetContext === undefined) {
        Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
      } else {
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
      }
    }
  });

  it("rejects pathological combining clusters before handing them to canvas text layout", async () => {
    const originalGetContext = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    const drawingContext = {
      measureText(value: string) {
        return { width: Array.from(value).length * 20 };
      },
    } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => drawingContext),
    });
    const pathologicalCluster = {
      ...publication,
      chapters: [
        {
          id: "chapter-pdf-grapheme-limit",
          title: "字素上限",
          order: 0,
          sourcePath: "chapters/0001.md",
          blocks: [
            {
              kind: "paragraph",
              text: `字${"\u0301".repeat(129)}`,
              sourceLine: 1,
            },
          ],
        },
      ],
    } satisfies PortablePublication;

    try {
      const source = rasterizePublicationToJpegPages(pathologicalCluster, {
        renderSpec: PDF_RENDER_SPEC,
        reportProgress: vi.fn(),
      });
      const consume = async (): Promise<void> => {
        for await (const page of source) {
          void page;
        }
      };

      await expect(consume()).rejects.toMatchObject({
        code: "PDF_COMPLEXITY_LIMIT_EXCEEDED",
      });
    } finally {
      if (originalGetContext === undefined) {
        Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
      } else {
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
      }
    }
  });
});
