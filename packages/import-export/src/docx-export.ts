import { sanitizeFilename } from "./filename.js";
import { normalizePortablePublication, type PortablePublication } from "./publication-model.js";
import {
  isValidatedPublicationImage,
  publicationImageExtension,
  type PublicationImageAsset,
  type ValidatedPublicationImage,
} from "./publication-images.js";
import { isoTimestampSchema, type PortableProjectV1 } from "./schemas.js";

export type DocxExportErrorCode =
  "DOCX_RENDER_FAILED" | "EXPORT_CANCELLED" | "EXPORT_OUTPUT_TOO_LARGE";

export type DocxExportStage = "normalizing" | "rendering" | "packaging";

export interface DocxExportProgress {
  readonly stage: DocxExportStage;
  readonly completedUnits: number;
  readonly totalUnits: number;
}

export interface DocxExportOptions {
  readonly generatedAt: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DocxExportProgress) => void;
  readonly imageAssets?: readonly PublicationImageAsset[];
}

export interface DocxExportArtifact {
  readonly fileName: string;
  readonly mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly issues: PortablePublication["warnings"];
}

export class DocxExportError extends Error {
  constructor(
    readonly code: DocxExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocxExportError";
  }
}

export const DOCX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

export const DOCX_ENTRY_NAMES = Object.freeze([
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/core.xml",
  "docProps/app.xml",
  "word/document.xml",
  "word/styles.xml",
  "word/numbering.xml",
  "word/settings.xml",
  "word/fontTable.xml",
  "word/header1.xml",
  "word/_rels/document.xml.rels",
] as const);

const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ZIP_EPOCH_YEAR = 1980;
const CREATOR = "InkShadow";
const BODY_FONT = "Noto Serif CJK SC";
const BODY_FONT_FALLBACK = "Microsoft YaHei";
const MONOSPACE_FONT = "Consolas";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const XML_INVALID_CHARACTER =
  /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu;
const METADATA_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const ISO_TIMESTAMP_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

type PublicationChapter = PortablePublication["chapters"][number];
type PublicationBlock = PublicationChapter["blocks"][number];

interface OrderedNumberingInstance {
  readonly numId: number;
  readonly level: number;
  readonly ordinal: number;
}

interface RenderedDocument {
  readonly documentXml: string;
  readonly numberingXml: string;
  readonly images: readonly DocxImage[];
}

interface DocxImage {
  readonly name: string;
  readonly relationshipId: string;
  readonly image: ValidatedPublicationImage;
}

export async function exportProjectToDocx(
  input: PortableProjectV1,
  options: DocxExportOptions,
): Promise<DocxExportArtifact> {
  throwIfCancelled(options.signal);
  reportProgress(options, "normalizing", 0, 1);
  const publication = normalizePortablePublication(input, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.imageAssets === undefined ? {} : { imageAssets: options.imageAssets }),
    onProgress: () => {
      throwIfCancelled(options.signal);
    },
  });
  throwIfCancelled(options.signal);
  reportProgress(options, "normalizing", 1, 1);
  return exportPublicationToDocx(publication, options);
}

export async function exportPublicationToDocx(
  publication: PortablePublication,
  options: DocxExportOptions,
): Promise<DocxExportArtifact> {
  try {
    throwIfCancelled(options.signal);
    const generatedAt = normalizeGeneratedAt(options.generatedAt);
    const title = sanitizeMetadata(publication.project.title, "Untitled", 200);
    const description =
      publication.project.description === undefined
        ? undefined
        : sanitizeMetadata(publication.project.description, "", 1_024);

    const rendered = renderDocument(publication, options);
    throwIfCancelled(options.signal);

    const entries = createEntries({
      title,
      description,
      generatedAt,
      documentXml: rendered.documentXml,
      numberingXml: rendered.numberingXml,
      images: rendered.images,
    });
    const { default: JSZip } = await import("jszip");
    throwIfCancelled(options.signal);
    const zip = new JSZip();
    reportProgress(options, "packaging", 0, entries.size);
    for (const [index, [name, content]] of [...entries.entries()].entries()) {
      throwIfCancelled(options.signal);
      zip.file(name, content, {
        binary: content instanceof Uint8Array,
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
        createFolders: false,
        date: fixedZipDate(),
      });
      reportProgress(options, "packaging", index + 1, entries.size);
    }
    throwIfCancelled(options.signal);

    const bytes = await zip.generateAsync(
      {
        type: "uint8array",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
        platform: "DOS",
        streamFiles: false,
        mimeType: DOCX_MEDIA_TYPE,
      },
      () => {
        throwIfCancelled(options.signal);
      },
    );
    throwIfCancelled(options.signal);
    if (bytes.byteLength > DOCX_OUTPUT_LIMIT_BYTES) {
      throw new DocxExportError(
        "EXPORT_OUTPUT_TOO_LARGE",
        "The DOCX export exceeds the 64 MiB output limit.",
      );
    }

    return {
      fileName: sanitizeFilename(title, ".docx"),
      mediaType: DOCX_MEDIA_TYPE,
      bytes,
      byteLength: bytes.byteLength,
      issues: publication.warnings,
    };
  } catch (error: unknown) {
    if (error instanceof DocxExportError) {
      throw error;
    }
    if (options.signal?.aborted === true) {
      throw new DocxExportError("EXPORT_CANCELLED", "The DOCX export was cancelled.");
    }
    throw new DocxExportError(
      "DOCX_RENDER_FAILED",
      "The DOCX document could not be rendered safely.",
    );
  }
}

function renderDocument(
  publication: PortablePublication,
  options: DocxExportOptions,
): RenderedDocument {
  const chapters = [...publication.chapters].sort(compareChapters);
  const totalUnits = 1 + chapters.reduce((total, chapter) => total + 1 + chapter.blocks.length, 0);
  let completedUnits = 0;
  let nextOrderedNumId = 2;
  const orderedNumbering: OrderedNumberingInstance[] = [];
  const images: DocxImage[] = [];
  const body: string[] = [];

  reportProgress(options, "rendering", completedUnits, totalUnits);
  body.push(renderCover(publication));
  completedUnits += 1;
  reportProgress(options, "rendering", completedUnits, totalUnits);

  for (const chapter of chapters) {
    throwIfCancelled(options.signal);
    body.push(renderParagraph(chapter.title, "Heading1"));
    completedUnits += 1;
    reportProgress(options, "rendering", completedUnits, totalUnits);

    for (const block of chapter.blocks) {
      throwIfCancelled(options.signal);
      if (block.kind === "orderedListItem") {
        const numId = nextOrderedNumId;
        nextOrderedNumId += 1;
        orderedNumbering.push({
          numId,
          level: clampListDepth(block.depth),
          ordinal: block.ordinal,
        });
        body.push(renderOrderedListItem(block, numId));
      } else if (block.kind === "image") {
        if (!isValidatedPublicationImage(block)) {
          throw new DocxExportError(
            "DOCX_RENDER_FAILED",
            "An accepted publication image no longer matches its validated local bytes.",
          );
        }
        const imageIndex = images.length + 1;
        const image: DocxImage = {
          name: `word/media/image-${String(imageIndex).padStart(4, "0")}.${publicationImageExtension(
            block.mediaType,
          )}`,
          relationshipId: `rId${String(imageIndex + 5)}`,
          image: block,
        };
        images.push(image);
        body.push(renderImage(block.altText, image, imageIndex));
      } else {
        body.push(renderBlock(block));
      }
      completedUnits += 1;
      reportProgress(options, "rendering", completedUnits, totalUnits);
    }
  }
  throwIfCancelled(options.signal);

  body.push(renderSectionProperties());
  const documentXml = `${XML_DECLARATION}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join("")}</w:body></w:document>`;
  return {
    documentXml,
    numberingXml: renderNumbering(orderedNumbering),
    images,
  };
}

function renderCover(publication: PortablePublication): string {
  const title = sanitizeXmlText(publication.project.title);
  const description = publication.project.description?.trim();
  return [
    '<w:p><w:pPr><w:pStyle w:val="Title"/><w:spacing w:before="3600"/></w:pPr>',
    renderTextRun(title),
    "</w:p>",
    '<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr>',
    renderTextRun(CREATOR),
    "</w:p>",
    description === undefined || description.length === 0
      ? ""
      : `<w:p><w:pPr><w:pStyle w:val="BookDescription"/></w:pPr>${renderTextRun(
          description,
        )}</w:p>`,
  ].join("");
}

function renderBlock(
  block: Exclude<
    PublicationBlock,
    { readonly kind: "orderedListItem" } | { readonly kind: "image" }
  >,
): string {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(block.level + 1, 6);
      return renderParagraph(block.text, `Heading${String(level)}`);
    }
    case "paragraph":
      return renderParagraph(block.text, "Normal");
    case "unorderedListItem":
      return renderListItem(block.text, clampListDepth(block.depth), 1);
    case "quote":
      return renderParagraph(block.text, "Quote");
    case "code":
      return renderParagraph(block.text, "CodeBlock");
    case "sceneBreak":
      return renderParagraph("＊　＊　＊", "SceneBreak");
  }
}

function renderImage(altText: string, entry: DocxImage, imageIndex: number): string {
  const maximumWidthEmu = 6_000_000;
  const maximumHeightEmu = 7_000_000;
  const naturalWidthEmu = Math.max(1, Math.round((entry.image.pixelWidth / 96) * 914_400));
  const naturalHeightEmu = Math.max(1, Math.round((entry.image.pixelHeight / 96) * 914_400));
  const scale = Math.min(1, maximumWidthEmu / naturalWidthEmu, maximumHeightEmu / naturalHeightEmu);
  const width = Math.max(1, Math.round(naturalWidthEmu * scale));
  const height = Math.max(1, Math.round(naturalHeightEmu * scale));
  const safeAlt = escapeXml(sanitizeXmlText(altText || "Image"));
  return [
    '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr><w:r><w:drawing>',
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${String(width)}" cy="${String(height)}"/>`,
    `<wp:docPr id="${String(1_000 + imageIndex)}" name="Image ${String(imageIndex)}" descr="${safeAlt}"/>`,
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>',
    `<pic:nvPicPr><pic:cNvPr id="${String(imageIndex)}" name="${safeAlt}"/><pic:cNvPicPr/></pic:nvPicPr>`,
    `<pic:blipFill><a:blip r:embed="${entry.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`,
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${String(width)}" cy="${String(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`,
    "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",
  ].join("");
}

function renderOrderedListItem(
  block: Extract<PublicationBlock, { readonly kind: "orderedListItem" }>,
  numId: number,
): string {
  return renderListItem(block.text, clampListDepth(block.depth), numId);
}

function renderListItem(text: string, level: number, numId: number): string {
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${String(
    level,
  )}"/><w:numId w:val="${String(numId)}"/></w:numPr></w:pPr>${renderTextRun(text)}</w:p>`;
}

function renderParagraph(text: string, style: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${renderTextRun(text)}</w:p>`;
}

function renderTextRun(value: string): string {
  const parts = normalizeLineEndings(sanitizeXmlText(value)).split("\n");
  const content = parts
    .map(
      (part, index) =>
        `${index === 0 ? "" : "<w:br/>"}<w:t xml:space="preserve">${escapeXml(part)}</w:t>`,
    )
    .join("");
  return `<w:r>${content}</w:r>`;
}

function renderSectionProperties(): string {
  return [
    "<w:sectPr>",
    '<w:headerReference w:type="default" r:id="rId5"/>',
    "<w:titlePg/>",
    '<w:pgSz w:w="11906" w:h="16838"/>',
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>',
    '<w:cols w:space="720"/>',
    '<w:docGrid w:type="lines" w:linePitch="378"/>',
    "</w:sectPr>",
  ].join("");
}

function renderNumbering(instances: readonly OrderedNumberingInstance[]): string {
  const bulletLevels = Array.from({ length: 9 }, (_, level) => {
    const left = 720 + level * 360;
    const marker = level % 3 === 0 ? "•" : level % 3 === 1 ? "◦" : "▪";
    return `<w:lvl w:ilvl="${String(level)}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${marker}"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${String(left)}"/></w:tabs><w:ind w:left="${String(left)}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="${BODY_FONT_FALLBACK}" w:hAnsi="${BODY_FONT_FALLBACK}" w:eastAsia="${BODY_FONT_FALLBACK}"/></w:rPr></w:lvl>`;
  }).join("");
  const decimalLevels = Array.from({ length: 9 }, (_, level) => {
    const left = 720 + level * 360;
    return `<w:lvl w:ilvl="${String(level)}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${String(level + 1)}."/><w:lvlJc w:val="right"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${String(left)}"/></w:tabs><w:ind w:left="${String(left)}" w:hanging="360"/></w:pPr></w:lvl>`;
  }).join("");
  const nums = instances
    .map(
      ({ numId, level, ordinal }) =>
        `<w:num w:numId="${String(numId)}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${String(
          level,
        )}"><w:startOverride w:val="${String(ordinal)}"/></w:lvlOverride></w:num>`,
    )
    .join("");
  return `${XML_DECLARATION}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bulletLevels}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimalLevels}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${nums}</w:numbering>`;
}

function createEntries(input: {
  readonly title: string;
  readonly description: string | undefined;
  readonly generatedAt: string;
  readonly documentXml: string;
  readonly numberingXml: string;
  readonly images: readonly DocxImage[];
}): ReadonlyMap<string, string | Uint8Array> {
  return new Map<string, string | Uint8Array>([
    ["[Content_Types].xml", contentTypesXml(input.images)],
    ["_rels/.rels", packageRelationshipsXml()],
    ["docProps/core.xml", corePropertiesXml(input)],
    ["docProps/app.xml", applicationPropertiesXml()],
    ["word/document.xml", input.documentXml],
    ["word/styles.xml", stylesXml()],
    ["word/numbering.xml", input.numberingXml],
    ["word/settings.xml", settingsXml()],
    ["word/fontTable.xml", fontTableXml()],
    ["word/header1.xml", headerXml(input.title)],
    ["word/_rels/document.xml.rels", documentRelationshipsXml(input.images)],
    ...input.images.map(({ name, image }) => [name, image.bytes] as const),
  ]);
}

function contentTypesXml(images: readonly DocxImage[]): string {
  const imageTypes = [
    ...(images.some(({ image }) => image.mediaType === "image/png")
      ? ['<Default Extension="png" ContentType="image/png"/>']
      : []),
    ...(images.some(({ image }) => image.mediaType === "image/jpeg")
      ? ['<Default Extension="jpg" ContentType="image/jpeg"/>']
      : []),
  ].join("");
  return `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageTypes}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`;
}

function packageRelationshipsXml(): string {
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function documentRelationshipsXml(images: readonly DocxImage[]): string {
  const imageRelationships = images
    .map(
      ({ name, relationshipId }) =>
        `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${escapeXml(name.slice("word/media/".length))}"/>`,
    )
    .join("");
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>${imageRelationships}</Relationships>`;
}

function corePropertiesXml(input: {
  readonly title: string;
  readonly description: string | undefined;
  readonly generatedAt: string;
}): string {
  const description =
    input.description === undefined || input.description.length === 0
      ? ""
      : `<dc:description>${escapeXml(input.description)}</dc:description>`;
  return `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(input.title)}</dc:title><dc:creator>${CREATOR}</dc:creator><cp:lastModifiedBy>${CREATOR}</cp:lastModifiedBy>${description}<dcterms:created xsi:type="dcterms:W3CDTF">${input.generatedAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${input.generatedAt}</dcterms:modified></cp:coreProperties>`;
}

function applicationPropertiesXml(): string {
  return `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${CREATOR}</Application><AppVersion>1.0</AppVersion><Company>${CREATOR}</Company><DocSecurity>0</DocSecurity><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged></Properties>`;
}

function settingsXml(): string {
  return `${XML_DECLARATION}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:updateFields w:val="true"/></w:settings>`;
}

function fontTableXml(): string {
  return `${XML_DECLARATION}<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="${BODY_FONT}"><w:altName w:val="${BODY_FONT_FALLBACK}"/><w:family w:val="roman"/><w:charset w:val="86"/></w:font><w:font w:name="${BODY_FONT_FALLBACK}"><w:family w:val="swiss"/><w:charset w:val="86"/></w:font><w:font w:name="${MONOSPACE_FONT}"><w:altName w:val="${BODY_FONT_FALLBACK}"/><w:family w:val="modern"/><w:charset w:val="00"/></w:font></w:fonts>`;
}

function headerXml(title: string): string {
  return `${XML_DECLARATION}<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Header"/><w:tabs><w:tab w:val="right" w:pos="9638"/></w:tabs></w:pPr>${renderTextRun(title)}<w:r><w:tab/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:hdr>`;
}

function stylesXml(): string {
  const headings = Array.from({ length: 6 }, (_, index) => {
    const level = index + 1;
    const size = [36, 32, 28, 26, 24, 24][index] ?? 24;
    const alignment = level === 1 ? '<w:jc w:val="center"/>' : "";
    const pageBreak = level === 1 ? "<w:pageBreakBefore/>" : "";
    return `<w:style w:type="paragraph" w:styleId="Heading${String(level)}"><w:name w:val="heading ${String(level)}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:uiPriority w:val="${String(8 + level)}"/><w:pPr><w:keepNext/><w:keepLines/>${pageBreak}${alignment}<w:spacing w:before="${level === 1 ? "480" : "240"}" w:after="240"/><w:outlineLvl w:val="${String(index)}"/></w:pPr><w:rPr><w:rFonts w:ascii="${BODY_FONT}" w:hAnsi="${BODY_FONT}" w:eastAsia="${BODY_FONT_FALLBACK}"/><w:b/><w:color w:val="1F2937"/><w:sz w:val="${String(size)}"/><w:szCs w:val="${String(size)}"/></w:rPr></w:style>`;
  }).join("");
  return `${XML_DECLARATION}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${BODY_FONT}" w:hAnsi="${BODY_FONT}" w:eastAsia="${BODY_FONT_FALLBACK}"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="378" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl/><w:spacing w:line="378" w:lineRule="auto" w:after="0"/><w:ind w:firstLine="440"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/><w:qFormat/><w:uiPriority w:val="10"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="360"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:rFonts w:ascii="${BODY_FONT}" w:hAnsi="${BODY_FONT}" w:eastAsia="${BODY_FONT_FALLBACK}"/><w:b/><w:color w:val="111827"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="BookDescription"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:after="480"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="BookDescription"><w:name w:val="Book Description"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:left="1440" w:right="1440" w:firstLine="0"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="4B5563"/></w:rPr></w:style>${headings}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:contextualSpacing/><w:ind w:firstLine="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="360" w:firstLine="0"/><w:spacing w:before="120" w:after="120" w:line="378" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="9CA3AF"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="374151"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360" w:right="360" w:firstLine="0"/><w:spacing w:before="120" w:after="120" w:line="300" w:lineRule="exact"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:pPr><w:rPr><w:rFonts w:ascii="${MONOSPACE_FONT}" w:hAnsi="${MONOSPACE_FONT}" w:eastAsia="${BODY_FONT_FALLBACK}"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="1F2937"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="SceneBreak"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="360" w:after="360"/></w:pPr><w:rPr><w:color w:val="6B7280"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLine="0"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D1D5DB"/></w:pBdr></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style></w:styles>`;
}

function normalizeGeneratedAt(value: string): string {
  if (!ISO_TIMESTAMP_WITH_OFFSET.test(value) || !isoTimestampSchema.safeParse(value).success) {
    throw new DocxExportError(
      "DOCX_RENDER_FAILED",
      "generatedAt must be a valid ISO 8601 timestamp with a time-zone offset.",
    );
  }
  return new Date(value).toISOString();
}

function sanitizeMetadata(value: string, fallback: string, maximumCharacters: number): string {
  const normalized = sanitizeXmlText(value)
    .replaceAll(METADATA_CONTROL, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const bounded = Array.from(normalized).slice(0, maximumCharacters).join("");
  return bounded.length === 0 ? fallback : bounded;
}

function sanitizeXmlText(value: string): string {
  return value.replaceAll(XML_INVALID_CHARACTER, "\uFFFD");
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll(/\r\n?/g, "\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function clampListDepth(depth: number): number {
  return Math.max(0, Math.min(8, depth));
}

function compareChapters(left: PublicationChapter, right: PublicationChapter): number {
  if (left.order !== right.order) {
    return left.order - right.order;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function fixedZipDate(): Date {
  return new Date(Date.UTC(ZIP_EPOCH_YEAR, 0, 1, 0, 0, 0, 0));
}

function reportProgress(
  options: DocxExportOptions,
  stage: DocxExportStage,
  completedUnits: number,
  totalUnits: number,
): void {
  throwIfCancelled(options.signal);
  options.onProgress?.({ stage, completedUnits, totalUnits });
  throwIfCancelled(options.signal);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DocxExportError("EXPORT_CANCELLED", "The DOCX export was cancelled.");
  }
}
