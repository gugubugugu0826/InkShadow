import { PDF_RENDER_SPEC } from "@inkshadow/import-export/pdf-export";
import type { PortablePublication } from "@inkshadow/import-export/core";
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
  it("decodes accepted local bytes and paints the source image into a PDF page canvas", async () => {
    const originalGetContext = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    const originalToBlob = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toBlob");
    const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(
      globalThis,
      "createImageBitmap",
    );
    const drawImage = vi.fn();
    const close = vi.fn();
    const drawingContext = {
      beginPath: vi.fn(),
      drawImage,
      fillRect: vi.fn(),
      fillText: vi.fn(),
      lineTo: vi.fn(),
      measureText(value: string) {
        return { width: Array.from(value).length * 20 };
      },
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => drawingContext),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: vi.fn((callback: BlobCallback) => {
        callback(new Blob([Uint8Array.of(1, 2, 3)], { type: "image/jpeg" }));
      }),
    });
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(() => Promise.resolve({ width: 1, height: 1, close })),
    });
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (value) => value.charCodeAt(0),
    );
    const imagePublication = {
      ...publication,
      chapters: [
        {
          id: "chapter-pdf-image",
          title: "第一章 雾港",
          order: 0,
          sourcePath: "chapters/0001.md",
          blocks: [
            {
              kind: "image",
              altText: "雾港场景",
              mediaType: "image/png",
              bytes: png,
              pixelWidth: 1,
              pixelHeight: 1,
              sourceLine: 1,
            },
          ],
        },
      ],
      statistics: { chapterCount: 1, blockCount: 1, textCharacters: 4 },
    } satisfies PortablePublication;

    try {
      const pages = [];
      for await (const page of rasterizePublicationToJpegPages(imagePublication, {
        renderSpec: PDF_RENDER_SPEC,
        reportProgress: vi.fn(),
      })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(globalThis.createImageBitmap).toHaveBeenCalledTimes(1);
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(drawImage).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        expect.any(Number),
        1,
        1,
      );
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      restoreProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
      restoreProperty(HTMLCanvasElement.prototype, "toBlob", originalToBlob);
      restoreProperty(globalThis, "createImageBitmap", originalCreateImageBitmap);
    }
  });

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

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, descriptor);
  }
}
