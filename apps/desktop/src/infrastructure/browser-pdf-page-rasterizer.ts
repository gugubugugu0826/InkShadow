import {
  PDF_EXPORT_LIMITS,
  PdfExportError,
  exportProjectToPdf,
  type PdfPageRasterizer,
  type PdfPageRasterizerContext,
  type PdfRasterPage,
} from "@inkshadow/import-export/pdf-export";
import type {
  PortablePublication,
  PublicationBlock,
  PublicationImageBlock,
} from "@inkshadow/import-export/core";

export { exportProjectToPdf };

const SERIF_FONT = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, Georgia, serif';
const SANS_FONT = '"Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif';
const MONOSPACE_FONT =
  '"Cascadia Mono", "Noto Sans Mono CJK SC", "Microsoft YaHei", Consolas, monospace';

const PAGE = Object.freeze({
  marginLeft: 112,
  marginRight: 112,
  contentTop: 132,
  contentBottom: 1_610,
  headerBaseline: 70,
  headerRuleY: 94,
  footerRuleY: 1_650,
  footerBaseline: 1_695,
});

const COLORS = Object.freeze({
  paper: "#fbf8f1",
  ink: "#25221f",
  muted: "#6b625b",
  subtle: "#9a8f85",
  rule: "#d8d0c7",
  accent: "#875c49",
  codePaper: "#f0ece5",
});

const MAXIMUM_LAYOUT_LINES = PDF_EXPORT_LIMITS.maximumPages * 64;
const MAXIMUM_GRAPHEME_SCALAR_VALUES = 128;
const UNICODE_MARK = /\p{Mark}/u;

interface TextCommand {
  readonly kind: "text";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly family: string;
  readonly color: string;
  readonly weight: "400" | "600" | "700";
  readonly align?: CanvasTextAlign;
}

interface LineCommand {
  readonly kind: "line";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly color: string;
  readonly width: number;
}

interface RectangleCommand {
  readonly kind: "rectangle";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
}

interface ImageCommand {
  readonly kind: "image";
  readonly image: PublicationImageBlock;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type DrawCommand = TextCommand | LineCommand | RectangleCommand | ImageCommand;

interface LoadedImage {
  readonly source: CanvasImageSource;
  readonly release: () => void;
}

interface PageLayout {
  readonly kind: "cover" | "content";
  readonly chapterTitle?: string;
  readonly commands: DrawCommand[];
}

interface TextStyle {
  readonly size: number;
  readonly lineHeight: number;
  readonly family: string;
  readonly color: string;
  readonly weight: TextCommand["weight"];
  readonly before: number;
  readonly after: number;
  readonly x: number;
  readonly maximumWidth: number;
  readonly preserveWhitespace?: boolean;
}

interface LayoutState {
  readonly pages: PageLayout[];
  current: PageLayout;
  y: number;
  chapterTitle: string | undefined;
}

/**
 * Browser-local page renderer for the shared semantic publication model.
 *
 * The implementation never resolves URLs or filesystem paths. Accepted image
 * bytes are decoded from local Blobs only. CJK text is painted with a system
 * font fallback stack and then embedded as pixels, so the receiving PDF viewer
 * does not need the original font.
 */
export const rasterizePublicationToJpegPages: PdfPageRasterizer = async function* (
  publication,
  context,
) {
  throwIfCancelled(context.signal);
  const canvas = createA4Canvas(context);
  const drawingContext = canvas.getContext("2d", { alpha: false });
  if (drawingContext === null) {
    throw new PdfExportError("PDF_RENDER_FAILED", "The local PDF canvas could not be initialized.");
  }

  await awaitLocalFonts(context.signal);
  const loadedImages = await loadPublicationImages(publication, context.signal);
  try {
    const pages = await createPageLayouts(publication, drawingContext, context);
    for (const [index, page] of pages.entries()) {
      throwIfCancelled(context.signal);
      renderPage(
        drawingContext,
        page,
        publication.project.title,
        index,
        pages.length,
        context,
        loadedImages,
      );
      const jpegBytes = await encodeCanvasAsJpeg(canvas, context);
      context.reportProgress({
        stage: "rasterizing",
        completedUnits: index + 1,
        totalUnits: pages.length,
      });
      yield Object.freeze({
        pixelWidth: context.renderSpec.pixelWidth,
        pixelHeight: context.renderSpec.pixelHeight,
        jpegBytes,
      }) satisfies PdfRasterPage;
      if ((index + 1) % 4 === 0) {
        await yieldToBrowser();
      }
    }
  } finally {
    for (const { release } of loadedImages.values()) {
      release();
    }
  }
};

async function createPageLayouts(
  publication: PortablePublication,
  drawingContext: CanvasRenderingContext2D,
  context: PdfPageRasterizerContext,
): Promise<readonly PageLayout[]> {
  const cover = await createCover(publication, drawingContext, context);
  const state: LayoutState = {
    pages: [cover],
    current: cover,
    y: PAGE.contentTop,
    chapterTitle: undefined,
  };
  const totalUnits =
    publication.chapters.length +
    publication.chapters.reduce((total, chapter) => total + chapter.blocks.length, 0);
  let completedUnits = 0;
  context.reportProgress({
    stage: "laying_out",
    completedUnits,
    totalUnits: Math.max(totalUnits, 1),
  });

  for (const chapter of publication.chapters) {
    throwIfCancelled(context.signal);
    startContentPage(state, chapter.title);
    await placeChapterTitle(state, drawingContext, chapter.title, context);
    completedUnits += 1;
    context.reportProgress({
      stage: "laying_out",
      completedUnits,
      totalUnits: Math.max(totalUnits, 1),
    });

    for (const block of chapter.blocks) {
      throwIfCancelled(context.signal);
      await placeBlock(state, drawingContext, block, context);
      completedUnits += 1;
      if (completedUnits % 16 === 0 || completedUnits === totalUnits) {
        context.reportProgress({
          stage: "laying_out",
          completedUnits,
          totalUnits: Math.max(totalUnits, 1),
        });
      }
      if (completedUnits % 128 === 0) {
        await yieldToBrowser();
      }
    }
  }
  context.reportProgress({
    stage: "laying_out",
    completedUnits: Math.max(totalUnits, 1),
    totalUnits: Math.max(totalUnits, 1),
  });
  return Object.freeze(state.pages);
}

async function createCover(
  publication: PortablePublication,
  drawingContext: CanvasRenderingContext2D,
  context: PdfPageRasterizerContext,
): Promise<PageLayout> {
  const commands: DrawCommand[] = [
    {
      kind: "text",
      text: "INKSHADOW · 墨影",
      x: context.renderSpec.pixelWidth / 2,
      y: 305,
      size: 24,
      family: SANS_FONT,
      color: COLORS.accent,
      weight: "600",
      align: "center",
    },
    {
      kind: "line",
      x1: 410,
      y1: 352,
      x2: context.renderSpec.pixelWidth - 410,
      y2: 352,
      color: COLORS.accent,
      width: 2,
    },
  ];
  const titleStyle: TextStyle = {
    size: 58,
    lineHeight: 82,
    family: SERIF_FONT,
    color: COLORS.ink,
    weight: "700",
    before: 0,
    after: 0,
    x: 160,
    maximumWidth: context.renderSpec.pixelWidth - 320,
  };
  const titleLines = await wrapText(
    drawingContext,
    publication.project.title,
    titleStyle,
    titleStyle.maximumWidth,
    context,
  );
  const titleStart = Math.max(470, 620 - ((titleLines.length - 1) * titleStyle.lineHeight) / 2);
  for (const [index, line] of titleLines.entries()) {
    commands.push({
      kind: "text",
      text: line,
      x: context.renderSpec.pixelWidth / 2,
      y: titleStart + index * titleStyle.lineHeight,
      size: titleStyle.size,
      family: titleStyle.family,
      color: titleStyle.color,
      weight: titleStyle.weight,
      align: "center",
    });
  }

  if (publication.project.description !== undefined) {
    const descriptionStyle: TextStyle = {
      size: 27,
      lineHeight: 46,
      family: SERIF_FONT,
      color: COLORS.muted,
      weight: "400",
      before: 0,
      after: 0,
      x: 200,
      maximumWidth: context.renderSpec.pixelWidth - 400,
    };
    const descriptionLines = (
      await wrapText(
        drawingContext,
        publication.project.description,
        descriptionStyle,
        descriptionStyle.maximumWidth,
        context,
      )
    ).slice(0, 8);
    const descriptionStart = Math.max(
      820,
      titleStart + titleLines.length * titleStyle.lineHeight + 80,
    );
    for (const [index, line] of descriptionLines.entries()) {
      commands.push({
        kind: "text",
        text: line,
        x: context.renderSpec.pixelWidth / 2,
        y: descriptionStart + index * descriptionStyle.lineHeight,
        size: descriptionStyle.size,
        family: descriptionStyle.family,
        color: descriptionStyle.color,
        weight: descriptionStyle.weight,
        align: "center",
      });
    }
  }

  commands.push({
    kind: "text",
    text: "本地离线导出 · 图像型 A4 PDF",
    x: context.renderSpec.pixelWidth / 2,
    y: 1_475,
    size: 22,
    family: SANS_FONT,
    color: COLORS.subtle,
    weight: "400",
    align: "center",
  });
  return { kind: "cover", commands };
}

async function placeChapterTitle(
  state: LayoutState,
  drawingContext: CanvasRenderingContext2D,
  title: string,
  context: PdfPageRasterizerContext,
): Promise<void> {
  const style: TextStyle = {
    size: 44,
    lineHeight: 62,
    family: SERIF_FONT,
    color: COLORS.ink,
    weight: "700",
    before: 36,
    after: 52,
    x: PAGE.marginLeft,
    maximumWidth: contentWidth(),
  };
  await placeText(state, drawingContext, title, style, context);
  const ruleY = state.y - 26;
  state.current.commands.push({
    kind: "line",
    x1: PAGE.marginLeft,
    y1: ruleY,
    x2: PAGE.marginLeft + 150,
    y2: ruleY,
    color: COLORS.accent,
    width: 3,
  });
}

async function placeBlock(
  state: LayoutState,
  drawingContext: CanvasRenderingContext2D,
  block: PublicationBlock,
  context: PdfPageRasterizerContext,
): Promise<void> {
  switch (block.kind) {
    case "heading": {
      const sizeByLevel = [0, 36, 33, 30, 28, 26, 24] as const;
      const size = sizeByLevel[block.level];
      await placeText(
        state,
        drawingContext,
        block.text,
        {
          size,
          lineHeight: size + 18,
          family: SERIF_FONT,
          color: COLORS.ink,
          weight: block.level <= 2 ? "700" : "600",
          before: block.level <= 2 ? 34 : 26,
          after: 20,
          x: PAGE.marginLeft,
          maximumWidth: contentWidth(),
        },
        context,
      );
      return;
    }
    case "paragraph":
      await placeText(
        state,
        drawingContext,
        `　　${block.text}`,
        {
          size: 26,
          lineHeight: 44,
          family: SERIF_FONT,
          color: COLORS.ink,
          weight: "400",
          before: 8,
          after: 18,
          x: PAGE.marginLeft,
          maximumWidth: contentWidth(),
        },
        context,
      );
      return;
    case "unorderedListItem": {
      const indent = Math.min(block.depth, 8) * 34;
      await placeText(
        state,
        drawingContext,
        `• ${block.text}`,
        {
          size: 25,
          lineHeight: 42,
          family: SERIF_FONT,
          color: COLORS.ink,
          weight: "400",
          before: 5,
          after: 7,
          x: PAGE.marginLeft + indent,
          maximumWidth: contentWidth() - indent,
        },
        context,
      );
      return;
    }
    case "orderedListItem": {
      const indent = Math.min(block.depth, 8) * 34;
      await placeText(
        state,
        drawingContext,
        `${String(block.ordinal)}. ${block.text}`,
        {
          size: 25,
          lineHeight: 42,
          family: SERIF_FONT,
          color: COLORS.ink,
          weight: "400",
          before: 5,
          after: 7,
          x: PAGE.marginLeft + indent,
          maximumWidth: contentWidth() - indent,
        },
        context,
      );
      return;
    }
    case "quote":
      await placeText(
        state,
        drawingContext,
        `│ ${block.text}`,
        {
          size: 25,
          lineHeight: 43,
          family: SERIF_FONT,
          color: COLORS.muted,
          weight: "400",
          before: 18,
          after: 22,
          x: PAGE.marginLeft + 22,
          maximumWidth: contentWidth() - 44,
        },
        context,
      );
      return;
    case "code":
      if (block.language !== undefined) {
        await placeText(
          state,
          drawingContext,
          `[${block.language}]`,
          {
            size: 19,
            lineHeight: 30,
            family: MONOSPACE_FONT,
            color: COLORS.subtle,
            weight: "600",
            before: 18,
            after: 6,
            x: PAGE.marginLeft + 20,
            maximumWidth: contentWidth() - 40,
            preserveWhitespace: true,
          },
          context,
        );
      }
      await placeText(
        state,
        drawingContext,
        block.text,
        {
          size: 22,
          lineHeight: 36,
          family: MONOSPACE_FONT,
          color: COLORS.ink,
          weight: "400",
          before: block.language === undefined ? 18 : 0,
          after: 22,
          x: PAGE.marginLeft + 20,
          maximumWidth: contentWidth() - 40,
          preserveWhitespace: true,
        },
        context,
      );
      return;
    case "sceneBreak":
      await placeText(
        state,
        drawingContext,
        "* * *",
        {
          size: 22,
          lineHeight: 38,
          family: SERIF_FONT,
          color: COLORS.subtle,
          weight: "400",
          before: 28,
          after: 28,
          x: PAGE.marginLeft,
          maximumWidth: contentWidth(),
        },
        context,
        "center",
      );
      return;
    case "image":
      placeImage(state, block);
  }
}

function placeImage(state: LayoutState, block: PublicationImageBlock): void {
  const maximumWidth = contentWidth();
  const maximumHeight = PAGE.contentBottom - PAGE.contentTop - 64;
  const scale = Math.min(1, maximumWidth / block.pixelWidth, maximumHeight / block.pixelHeight);
  const width = Math.max(1, Math.round(block.pixelWidth * scale));
  const height = Math.max(1, Math.round(block.pixelHeight * scale));
  const before = 24;
  const after = 28;
  if (state.y + before + height + after > PAGE.contentBottom) {
    startContentPage(state, state.chapterTitle);
  }
  state.y += before;
  state.current.commands.push({
    kind: "image",
    image: block,
    x: PAGE.marginLeft + (maximumWidth - width) / 2,
    y: state.y,
    width,
    height,
  });
  state.y += height + after;
}

async function placeText(
  state: LayoutState,
  drawingContext: CanvasRenderingContext2D,
  text: string,
  style: TextStyle,
  context: PdfPageRasterizerContext,
  align: CanvasTextAlign = "left",
): Promise<void> {
  const lines = await wrapText(drawingContext, text, style, style.maximumWidth, context);
  const minimumLines = Math.min(lines.length, 2);
  if (
    state.y + style.before + minimumLines * style.lineHeight > PAGE.contentBottom &&
    state.current.commands.length > 0
  ) {
    startContentPage(state, state.chapterTitle);
  }
  state.y += style.before;

  for (const line of lines) {
    if (state.y + style.lineHeight > PAGE.contentBottom) {
      startContentPage(state, state.chapterTitle);
    }
    if (style.family === MONOSPACE_FONT) {
      state.current.commands.push({
        kind: "rectangle",
        x: style.x - 10,
        y: state.y - style.size - 6,
        width: style.maximumWidth + 20,
        height: style.lineHeight,
        color: COLORS.codePaper,
      });
    }
    state.current.commands.push({
      kind: "text",
      text: line.length === 0 ? " " : line,
      x: align === "center" ? style.x + style.maximumWidth / 2 : style.x,
      y: state.y,
      size: style.size,
      family: style.family,
      color: style.color,
      weight: style.weight,
      ...(align === "left" ? {} : { align }),
    });
    state.y += style.lineHeight;
  }
  state.y += style.after;
}

async function wrapText(
  drawingContext: CanvasRenderingContext2D,
  text: string,
  style: TextStyle,
  maximumWidth: number,
  context: PdfPageRasterizerContext,
): Promise<readonly string[]> {
  drawingContext.font = fontValue(style);
  const output: string[] = [];
  let processedUnits = 0;
  const pushLine = (line: string): void => {
    if (output.length >= MAXIMUM_LAYOUT_LINES) {
      throw new PdfExportError(
        "PDF_COMPLEXITY_LIMIT_EXCEEDED",
        "The PDF layout exceeds the bounded line limit.",
      );
    }
    output.push(line);
  };
  for (const logicalLine of iterateLogicalLines(text)) {
    throwIfCancelled(context.signal);
    processedUnits += 1;
    if (processedUnits % 1_024 === 0) {
      await yieldToBrowser();
      throwIfCancelled(context.signal);
    }
    const source = logicalLine;
    if (source.length === 0) {
      pushLine("");
      continue;
    }
    await assertBoundedGraphemeComplexity(source, context);
    let line = "";
    for (const sourceGrapheme of graphemes(source)) {
      if (processedUnits % 256 === 0) {
        throwIfCancelled(context.signal);
      }
      const grapheme =
        style.preserveWhitespace && sourceGrapheme === "\t" ? "    " : sourceGrapheme;
      const candidate = line + grapheme;
      if (line.length > 0 && drawingContext.measureText(candidate).width > maximumWidth) {
        pushLine(style.preserveWhitespace ? line : line.trimEnd());
        line = style.preserveWhitespace ? grapheme : grapheme.trimStart();
      } else {
        line = candidate;
      }
      processedUnits += 1;
      if (processedUnits % 1_024 === 0) {
        await yieldToBrowser();
        throwIfCancelled(context.signal);
      }
    }
    pushLine(style.preserveWhitespace ? line : line.trimEnd());
  }
  throwIfCancelled(context.signal);
  return output.length === 0 ? [""] : output;
}

async function assertBoundedGraphemeComplexity(
  value: string,
  context: PdfPageRasterizerContext,
): Promise<void> {
  let clusterScalarValues = 0;
  let joinsNext = false;
  let processed = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const continuation =
      joinsNext ||
      UNICODE_MARK.test(character) ||
      codePoint === 0x200d ||
      (codePoint !== undefined &&
        ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
          (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
          (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
          (codePoint >= 0xe0020 && codePoint <= 0xe007f)));
    clusterScalarValues = continuation ? clusterScalarValues + 1 : 1;
    if (clusterScalarValues > MAXIMUM_GRAPHEME_SCALAR_VALUES) {
      throw new PdfExportError(
        "PDF_COMPLEXITY_LIMIT_EXCEEDED",
        "The PDF contains an unsupported pathological grapheme cluster.",
      );
    }
    joinsNext = codePoint === 0x200d;
    processed += 1;
    if (processed % 1_024 === 0) {
      await yieldToBrowser();
      throwIfCancelled(context.signal);
    }
  }
}

function* iterateLogicalLines(value: string): IterableIterator<string> {
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character !== 0x0a && character !== 0x0d) {
      continue;
    }
    yield value.slice(start, index);
    if (character === 0x0d && value.charCodeAt(index + 1) === 0x0a) {
      index += 1;
    }
    start = index + 1;
  }
  yield value.slice(start);
}

function* graphemes(value: string): IterableIterator<string> {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
    for (const { segment } of segmenter.segment(value)) {
      yield segment;
    }
    return;
  }
  for (const codePoint of value) {
    yield codePoint;
  }
}

function startContentPage(state: LayoutState, chapterTitle: string | undefined): void {
  if (state.pages.length >= PDF_EXPORT_LIMITS.maximumPages) {
    throw new PdfExportError(
      "PDF_COMPLEXITY_LIMIT_EXCEEDED",
      `The PDF export exceeds the ${String(PDF_EXPORT_LIMITS.maximumPages)} page limit.`,
    );
  }
  const page: PageLayout = {
    kind: "content",
    ...(chapterTitle === undefined ? {} : { chapterTitle }),
    commands: [],
  };
  state.pages.push(page);
  state.current = page;
  state.chapterTitle = chapterTitle;
  state.y = PAGE.contentTop;
}

function renderPage(
  drawingContext: CanvasRenderingContext2D,
  page: PageLayout,
  projectTitle: string,
  pageIndex: number,
  pageCount: number,
  context: PdfPageRasterizerContext,
  loadedImages: ReadonlyMap<PublicationImageBlock, LoadedImage>,
): void {
  drawingContext.save();
  drawingContext.setTransform(1, 0, 0, 1, 0, 0);
  drawingContext.fillStyle = COLORS.paper;
  drawingContext.fillRect(0, 0, context.renderSpec.pixelWidth, context.renderSpec.pixelHeight);
  drawingContext.textBaseline = "alphabetic";
  drawingContext.lineCap = "round";
  drawingContext.lineJoin = "round";

  if (page.kind === "content") {
    drawHeaderAndFooter(drawingContext, page, projectTitle, pageIndex, pageCount, context);
  }
  for (const command of page.commands) {
    if (command.kind === "text") {
      drawingContext.font = fontValue(command);
      drawingContext.fillStyle = command.color;
      drawingContext.textAlign = command.align ?? "left";
      drawingContext.fillText(command.text, command.x, command.y);
    } else if (command.kind === "line") {
      drawingContext.strokeStyle = command.color;
      drawingContext.lineWidth = command.width;
      drawingContext.beginPath();
      drawingContext.moveTo(command.x1, command.y1);
      drawingContext.lineTo(command.x2, command.y2);
      drawingContext.stroke();
    } else if (command.kind === "rectangle") {
      drawingContext.fillStyle = command.color;
      drawingContext.fillRect(command.x, command.y, command.width, command.height);
    } else {
      const loaded = loadedImages.get(command.image);
      if (loaded === undefined) {
        throw new PdfExportError(
          "PDF_RENDER_FAILED",
          "An accepted publication image could not be decoded for the PDF page.",
        );
      }
      drawingContext.drawImage(loaded.source, command.x, command.y, command.width, command.height);
    }
  }
  drawingContext.restore();
}

async function loadPublicationImages(
  publication: PortablePublication,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<PublicationImageBlock, LoadedImage>> {
  const loaded = new Map<PublicationImageBlock, LoadedImage>();
  try {
    for (const chapter of publication.chapters) {
      for (const block of chapter.blocks) {
        if (block.kind === "image") {
          throwIfCancelled(signal);
          loaded.set(block, await decodeLocalImage(block, signal));
        }
      }
    }
    return loaded;
  } catch (error: unknown) {
    for (const { release } of loaded.values()) {
      release();
    }
    if (error instanceof PdfExportError) {
      throw error;
    }
    throw new PdfExportError(
      signal?.aborted === true ? "EXPORT_CANCELLED" : "PDF_RENDER_FAILED",
      signal?.aborted === true
        ? "The PDF export was cancelled."
        : "A publication image could not be decoded from its local bytes.",
    );
  }
}

async function decodeLocalImage(
  block: PublicationImageBlock,
  signal: AbortSignal | undefined,
): Promise<LoadedImage> {
  const imageBuffer = new ArrayBuffer(block.bytes.byteLength);
  new Uint8Array(imageBuffer).set(block.bytes);
  const blob = new Blob([imageBuffer], { type: block.mediaType });
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await globalThis.createImageBitmap(blob);
    if (signal?.aborted === true) {
      bitmap.close();
      throw new PdfExportError("EXPORT_CANCELLED", "The PDF export was cancelled.");
    }
    if (bitmap.width !== block.pixelWidth || bitmap.height !== block.pixelHeight) {
      bitmap.close();
      throw new PdfExportError(
        "PDF_RENDER_FAILED",
        "The decoded publication image dimensions do not match its validated header.",
      );
    }
    return { source: bitmap, release: () => bitmap.close() };
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = document.createElement("img");
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      const abort = (): void =>
        reject(new PdfExportError("EXPORT_CANCELLED", "The PDF export was cancelled."));
      const finish = (callback: () => void): void => {
        signal?.removeEventListener("abort", abort);
        callback();
      };
      image.addEventListener("load", () => finish(resolve), { once: true });
      image.addEventListener(
        "error",
        () =>
          finish(() =>
            reject(
              new PdfExportError(
                "PDF_RENDER_FAILED",
                "A publication image could not be decoded from its local bytes.",
              ),
            ),
          ),
        { once: true },
      );
      signal?.addEventListener("abort", abort, { once: true });
      image.src = objectUrl;
    });
    throwIfCancelled(signal);
    if (image.naturalWidth !== block.pixelWidth || image.naturalHeight !== block.pixelHeight) {
      throw new PdfExportError(
        "PDF_RENDER_FAILED",
        "The decoded publication image dimensions do not match its validated header.",
      );
    }
    return { source: image, release: () => undefined };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function drawHeaderAndFooter(
  drawingContext: CanvasRenderingContext2D,
  page: PageLayout,
  projectTitle: string,
  pageIndex: number,
  pageCount: number,
  context: PdfPageRasterizerContext,
): void {
  drawingContext.font = `400 19px ${SANS_FONT}`;
  drawingContext.fillStyle = COLORS.subtle;
  drawingContext.textAlign = "left";
  drawingContext.fillText(
    truncateToWidth(drawingContext, projectTitle, contentWidth() * 0.52),
    PAGE.marginLeft,
    PAGE.headerBaseline,
  );
  if (page.chapterTitle !== undefined) {
    drawingContext.textAlign = "right";
    drawingContext.fillText(
      truncateToWidth(drawingContext, page.chapterTitle, contentWidth() * 0.42),
      context.renderSpec.pixelWidth - PAGE.marginRight,
      PAGE.headerBaseline,
    );
  }
  drawingContext.strokeStyle = COLORS.rule;
  drawingContext.lineWidth = 1;
  drawingContext.beginPath();
  drawingContext.moveTo(PAGE.marginLeft, PAGE.headerRuleY);
  drawingContext.lineTo(context.renderSpec.pixelWidth - PAGE.marginRight, PAGE.headerRuleY);
  drawingContext.moveTo(PAGE.marginLeft, PAGE.footerRuleY);
  drawingContext.lineTo(context.renderSpec.pixelWidth - PAGE.marginRight, PAGE.footerRuleY);
  drawingContext.stroke();
  drawingContext.textAlign = "center";
  drawingContext.fillText(
    `${String(pageIndex + 1)} / ${String(pageCount)}`,
    context.renderSpec.pixelWidth / 2,
    PAGE.footerBaseline,
  );
}

function truncateToWidth(
  drawingContext: CanvasRenderingContext2D,
  value: string,
  maximumWidth: number,
): string {
  if (drawingContext.measureText(value).width <= maximumWidth) {
    return value;
  }
  let output = "";
  for (const grapheme of graphemes(value)) {
    const candidate = `${output}${grapheme}…`;
    if (drawingContext.measureText(candidate).width > maximumWidth) {
      return `${output}…`;
    }
    output += grapheme;
  }
  return output;
}

function fontValue(style: Pick<TextStyle, "weight" | "size" | "family">): string {
  return `${style.weight} ${String(style.size)}px ${style.family}`;
}

function contentWidth(): number {
  return 1_240 - PAGE.marginLeft - PAGE.marginRight;
}

function createA4Canvas(context: PdfPageRasterizerContext): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new PdfExportError(
      "PDF_RENDER_FAILED",
      "The browser-local PDF renderer is unavailable outside the desktop WebView.",
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = context.renderSpec.pixelWidth;
  canvas.height = context.renderSpec.pixelHeight;
  canvas.setAttribute("aria-hidden", "true");
  return canvas;
}

async function encodeCanvasAsJpeg(
  canvas: HTMLCanvasElement,
  context: PdfPageRasterizerContext,
): Promise<Uint8Array> {
  throwIfCancelled(context.signal);
  const blob = await new Promise<Blob>((resolve, reject) => {
    const handleAbort = (): void => {
      reject(new PdfExportError("EXPORT_CANCELLED", "The PDF export was cancelled."));
    };
    context.signal?.addEventListener("abort", handleAbort, { once: true });
    canvas.toBlob(
      (value) => {
        context.signal?.removeEventListener("abort", handleAbort);
        if (value?.type !== "image/jpeg") {
          reject(
            new PdfExportError(
              "PDF_RENDER_FAILED",
              "The local canvas could not encode a supported JPEG page.",
            ),
          );
          return;
        }
        resolve(value);
      },
      "image/jpeg",
      context.renderSpec.jpegQuality,
    );
  });
  throwIfCancelled(context.signal);
  if (blob.size > PDF_EXPORT_LIMITS.maximumPageJpegBytes) {
    throw new PdfExportError(
      "EXPORT_OUTPUT_TOO_LARGE",
      "A rasterized PDF page exceeds the 8 MiB page limit.",
    );
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  throwIfCancelled(context.signal);
  return bytes;
}

async function awaitLocalFonts(signal: AbortSignal | undefined): Promise<void> {
  throwIfCancelled(signal);
  if (typeof document !== "undefined" && "fonts" in document) {
    await document.fonts.ready;
  }
  throwIfCancelled(signal);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PdfExportError("EXPORT_CANCELLED", "The PDF export was cancelled.");
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}
