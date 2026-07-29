import { sha256Hex, utf8ByteLength } from "./checksum.js";
import { IMPORT_LIMITS } from "./constants.js";
import { ImportExportError, type ImportIssue } from "./errors.js";
import { assertSafeInputFilename, getAllowedImportExtension } from "./filename.js";
import { importExtractedTextDocuments, type ImportedTextDocument } from "./text.js";

export interface BinaryImportProgress {
  readonly stage: "scanning" | "parsing";
  readonly fileName: string;
  readonly completedUnits: number;
  readonly totalUnits: number;
}

export interface BinaryImportOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BinaryImportProgress) => void;
}

interface ZipEntryMetadata {
  readonly name: string;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly encrypted: boolean;
  readonly compressionMethod: number;
}

interface ZipInspection {
  readonly entries: readonly ZipEntryMetadata[];
  readonly names: ReadonlySet<string>;
}

interface MammothRawTextResult {
  readonly value: string;
  readonly messages: readonly {
    readonly type: "error" | "warning";
  }[];
}

interface MammothRawTextParser {
  extractRawText(
    input: { readonly arrayBuffer: ArrayBuffer } | { readonly buffer: unknown },
  ): Promise<MammothRawTextResult>;
}

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export async function importDocxDocuments(
  fileName: string,
  bytes: Uint8Array,
  options: BinaryImportOptions = {},
): Promise<readonly ImportedTextDocument[]> {
  assertSafeInputFilename(fileName);
  if (getAllowedImportExtension(fileName) !== ".docx") {
    throw new ImportExportError(
      "IMPORT_EXTENSION_FORBIDDEN",
      "The DOCX parser only accepts .docx files.",
      { fileName },
    );
  }
  assertBinarySize(fileName, bytes);
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "scanning", fileName, completedUnits: 0, totalUnits: 1 });
  const archive = inspectDocxArchive(fileName, bytes);
  const parserIssues = await inspectDocxXml(fileName, bytes, archive);
  options.onProgress?.({ stage: "scanning", fileName, completedUnits: 1, totalUnits: 1 });
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "parsing", fileName, completedUnits: 0, totalUnits: 1 });

  try {
    const mammothModule = await import("mammoth");
    throwIfAborted(options.signal);
    const mammoth = mammothModule.default as unknown as MammothRawTextParser;
    const result = await mammoth.extractRawText(mammothInput(bytes));
    const parserErrors = result.messages.filter(({ type }) => type === "error");
    if (parserErrors.length > 0) {
      throw new ImportExportError(
        "DOCX_PARSE_FAILED",
        "The DOCX parser reported an unsafe or invalid document structure.",
        { fileName },
      );
    }
    const warningIssues = result.messages
      .filter(({ type }) => type === "warning")
      .map((): ImportIssue => ({
        severity: "warning",
        code: "DOCX_PARSER_WARNING",
        message: "The DOCX parser omitted unsupported document structure.",
        fileName,
      }));
    throwIfAborted(options.signal);
    const documents = importExtractedTextDocuments(fileName, result.value, {
      originalBytes: bytes.byteLength,
      sourceFormat: "docx",
      sourceSha256: await sha256Hex(bytes),
      parserIssues: [...parserIssues, ...warningIssues],
    });
    options.onProgress?.({ stage: "parsing", fileName, completedUnits: 1, totalUnits: 1 });
    return documents;
  } catch (error: unknown) {
    if (error instanceof ImportExportError || isAbortError(error, options.signal)) {
      throw error;
    }
    throw new ImportExportError("DOCX_PARSE_FAILED", "The DOCX file could not be parsed safely.", {
      fileName,
    });
  }
}

export async function importPdfDocuments(
  fileName: string,
  bytes: Uint8Array,
  options: BinaryImportOptions = {},
): Promise<readonly ImportedTextDocument[]> {
  assertSafeInputFilename(fileName);
  if (getAllowedImportExtension(fileName) !== ".pdf") {
    throw new ImportExportError(
      "IMPORT_EXTENSION_FORBIDDEN",
      "The PDF parser only accepts .pdf files.",
      { fileName },
    );
  }
  assertBinarySize(fileName, bytes);
  if (!hasPdfSignature(bytes)) {
    throw new ImportExportError(
      "IMPORT_MAGIC_MISMATCH",
      "The file extension says PDF but the PDF signature is missing.",
      { fileName },
    );
  }
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "scanning", fileName, completedUnits: 1, totalUnits: 1 });

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof Worker !== "undefined" && pdfjs.GlobalWorkerOptions.workerSrc.length === 0) {
    const workerAsset = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = workerAsset.default;
  }
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    disableAutoFetch: true,
    disableFontFace: true,
    disableRange: true,
    disableStream: true,
    enableXfa: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: 1,
    stopAtErrors: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    throwIfAborted(options.signal);
    if (document.numPages > IMPORT_LIMITS.maximumPdfPages) {
      throw new ImportExportError(
        "PDF_PAGE_LIMIT_EXCEEDED",
        "The PDF exceeds the safe page-count limit.",
        { fileName },
      );
    }

    const [attachments, fieldObjects, hasJavaScript] = await Promise.all([
      document.getAttachments(),
      document.getFieldObjects(),
      document.hasJSActions(),
    ]);
    if (document.isPureXfa || attachments !== null || fieldObjects !== null || hasJavaScript) {
      throw new ImportExportError(
        "PDF_ACTIVE_CONTENT_FORBIDDEN",
        "PDF attachments, forms, XFA, and JavaScript are not accepted.",
        { fileName },
      );
    }

    const pages: string[] = [];
    let extractedTextBytes = 0;
    options.onProgress?.({
      stage: "parsing",
      fileName,
      completedUnits: 0,
      totalUnits: document.numPages,
    });
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(options.signal);
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent({
        disableNormalization: false,
        includeMarkedContent: false,
      });
      let pageText = "";
      for (const item of text.items) {
        if (!("str" in item)) {
          continue;
        }
        pageText += item.str;
        if (item.hasEOL) {
          pageText += "\n";
        }
      }
      page.cleanup();
      const normalizedPage = pageText.trim();
      pages.push(normalizedPage);
      extractedTextBytes += utf8ByteLength(normalizedPage) + (pageNumber === 1 ? 0 : 2);
      if (extractedTextBytes > IMPORT_LIMITS.maximumTotalBytes) {
        throw new ImportExportError(
          "IMPORT_TOTAL_TOO_LARGE",
          "The extracted PDF text exceeds the import size limit.",
          { fileName },
        );
      }
      options.onProgress?.({
        stage: "parsing",
        fileName,
        completedUnits: pageNumber,
        totalUnits: document.numPages,
      });
    }
    const extracted = pages.filter((page) => page.length > 0).join("\n\n");
    if (extracted.length === 0) {
      throw new ImportExportError(
        "PDF_TEXT_UNAVAILABLE",
        "The PDF has no extractable text; scanned PDF and OCR import are not supported.",
        { fileName },
      );
    }
    throwIfAborted(options.signal);
    return importExtractedTextDocuments(fileName, extracted, {
      originalBytes: bytes.byteLength,
      sourceFormat: "pdf",
      sourceSha256: await sha256Hex(bytes),
    });
  } catch (error: unknown) {
    if (error instanceof ImportExportError || isAbortError(error, options.signal)) {
      throw error;
    }
    if (isPdfPasswordError(error)) {
      throw new ImportExportError(
        "PDF_ENCRYPTED_UNSUPPORTED",
        "Encrypted or password-protected PDF files are not supported.",
        { fileName },
      );
    }
    throw new ImportExportError("PDF_PARSE_FAILED", "The PDF file could not be parsed safely.", {
      fileName,
    });
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

function assertBinarySize(fileName: string, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) {
    throw new ImportExportError("IMPORT_UNSAFE_CONTENT", "The import file is empty.", {
      fileName,
    });
  }
  if (bytes.byteLength > IMPORT_LIMITS.maximumFileBytes) {
    throw new ImportExportError(
      "IMPORT_FILE_TOO_LARGE",
      "The import file exceeds the per-file size limit.",
      { fileName },
    );
  }
}

function inspectDocxArchive(fileName: string, bytes: Uint8Array): ZipInspection {
  if (bytes.byteLength < 4 || readUint32(bytes, 0) !== ZIP_LOCAL_FILE_HEADER) {
    throw new ImportExportError(
      "IMPORT_MAGIC_MISMATCH",
      "The file extension says DOCX but the ZIP signature is missing.",
      { fileName },
    );
  }
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw archiveInvalid(fileName);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const commentBytes = view.getUint16(eocdOffset + 20, true);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === ZIP64_SENTINEL_16 ||
    centralBytes === ZIP64_SENTINEL_32 ||
    centralOffset === ZIP64_SENTINEL_32 ||
    entryCount > IMPORT_LIMITS.maximumArchiveEntries ||
    eocdOffset + 22 + commentBytes !== bytes.byteLength ||
    centralOffset + centralBytes !== eocdOffset
  ) {
    throw archiveInvalid(fileName);
  }

  const entries: ZipEntryMetadata[] = [];
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_HEADER) {
      throw archiveInvalid(fileName);
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const entryCommentBytes = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      compressedBytes === ZIP64_SENTINEL_32 ||
      uncompressedBytes === ZIP64_SENTINEL_32 ||
      localOffset === ZIP64_SENTINEL_32 ||
      nameBytes === 0 ||
      nextOffset > eocdOffset ||
      ![0, 8].includes(compressionMethod)
    ) {
      throw archiveInvalid(fileName);
    }
    let name: string;
    try {
      name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameBytes));
    } catch {
      throw archiveInvalid(fileName);
    }
    const normalizedName = name.replaceAll("\\", "/").normalize("NFKC");
    const comparisonName = normalizedName.toLocaleLowerCase();
    const pathSegments = normalizedName.split("/");
    const contentSegments = normalizedName.endsWith("/") ? pathSegments.slice(0, -1) : pathSegments;
    if (
      normalizedName !== name ||
      normalizedName.startsWith("/") ||
      /^[a-z]:/iu.test(normalizedName) ||
      /[\u0000-\u001f\u007f:?*<>|%]/u.test(normalizedName) ||
      contentSegments.some(
        (segment) => segment.length === 0 || segment === "." || segment === "..",
      ) ||
      names.has(comparisonName) ||
      localOffsets.has(localOffset)
    ) {
      throw new ImportExportError(
        "IMPORT_UNSAFE_PATH",
        "The DOCX archive contains an unsafe or duplicate path.",
        { fileName },
      );
    }
    names.add(comparisonName);
    localOffsets.add(localOffset);
    assertMatchingLocalZipHeader({
      bytes,
      centralOffset,
      compressedBytes,
      compressionMethod,
      fileName,
      flags,
      localOffset,
      name,
      view,
    });
    totalCompressed += compressedBytes;
    totalUncompressed += uncompressedBytes;
    if (
      uncompressedBytes > IMPORT_LIMITS.maximumArchiveEntryBytes ||
      totalUncompressed > IMPORT_LIMITS.maximumArchiveExpandedBytes ||
      (uncompressedBytes > 0 &&
        uncompressedBytes / Math.max(compressedBytes, 1) >
          IMPORT_LIMITS.maximumArchiveCompressionRatio)
    ) {
      throw new ImportExportError(
        "IMPORT_ARCHIVE_LIMIT_EXCEEDED",
        "The DOCX archive exceeds safe expansion limits.",
        { fileName },
      );
    }
    if ((flags & (0x1 | 0x40 | 0x2000)) !== 0) {
      throw new ImportExportError(
        "IMPORT_ARCHIVE_ENCRYPTED",
        "Encrypted DOCX archive entries are not supported.",
        { fileName },
      );
    }
    if (
      /(?:^|\/)(?:vbaproject\.bin|activex\/|embeddings\/|customui\/)/iu.test(comparisonName) ||
      comparisonName.endsWith(".bin")
    ) {
      throw new ImportExportError(
        "IMPORT_ARCHIVE_ACTIVE_CONTENT",
        "Macro, embedded object, ActiveX, and binary DOCX content is not accepted.",
        { fileName },
      );
    }
    entries.push({
      name: normalizedName,
      compressedBytes,
      uncompressedBytes,
      encrypted: false,
      compressionMethod,
    });
    offset = nextOffset;
  }
  if (
    offset !== eocdOffset ||
    totalCompressed > bytes.byteLength ||
    !names.has("[content_types].xml") ||
    !names.has("_rels/.rels") ||
    !names.has("word/document.xml")
  ) {
    throw archiveInvalid(fileName);
  }
  return { entries, names };
}

function assertMatchingLocalZipHeader({
  bytes,
  centralOffset,
  compressedBytes,
  compressionMethod,
  fileName,
  flags,
  localOffset,
  name,
  view,
}: {
  readonly bytes: Uint8Array;
  readonly centralOffset: number;
  readonly compressedBytes: number;
  readonly compressionMethod: number;
  readonly fileName: string;
  readonly flags: number;
  readonly localOffset: number;
  readonly name: string;
  readonly view: DataView;
}): void {
  if (
    localOffset + 30 > centralOffset ||
    view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE_HEADER
  ) {
    throw archiveInvalid(fileName);
  }
  const localFlags = view.getUint16(localOffset + 6, true);
  const localMethod = view.getUint16(localOffset + 8, true);
  const localNameBytes = view.getUint16(localOffset + 26, true);
  const localExtraBytes = view.getUint16(localOffset + 28, true);
  const payloadOffset = localOffset + 30 + localNameBytes + localExtraBytes;
  if (
    localFlags !== flags ||
    localMethod !== compressionMethod ||
    payloadOffset + compressedBytes > centralOffset
  ) {
    throw archiveInvalid(fileName);
  }
  let localName: string;
  try {
    localName = textDecoder.decode(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameBytes),
    );
  } catch {
    throw archiveInvalid(fileName);
  }
  if (localName !== name) {
    throw archiveInvalid(fileName);
  }
}

async function inspectDocxXml(
  fileName: string,
  bytes: Uint8Array,
  archive: ZipInspection,
): Promise<readonly ImportIssue[]> {
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(bytes, {
      checkCRC32: false,
      createFolders: false,
    });
    const issues: ImportIssue[] = [];
    const xmlEntries = archive.entries.filter(
      ({ name }) =>
        name.toLocaleLowerCase().endsWith(".rels") ||
        ["[content_types].xml", "word/document.xml"].includes(name.toLocaleLowerCase()),
    );
    for (const { name, uncompressedBytes } of xmlEntries) {
      const normalizedName = name.toLocaleLowerCase();
      const xmlLimit =
        normalizedName === "word/document.xml"
          ? IMPORT_LIMITS.maximumArchiveEntryBytes
          : IMPORT_LIMITS.maximumRelationshipBytes;
      if (uncompressedBytes > xmlLimit) {
        throw new ImportExportError(
          "IMPORT_ARCHIVE_ACTIVE_CONTENT",
          "The DOCX contains oversized XML control data.",
          { fileName },
        );
      }
      const entry = zip.file(name);
      if (entry === null) {
        throw archiveInvalid(fileName);
      }
      const xml = await entry.async("string");
      if (utf8ByteLength(xml) > xmlLimit || /<!\s*(?:doctype|entity)\b/iu.test(xml)) {
        throw new ImportExportError(
          "IMPORT_ARCHIVE_ACTIVE_CONTENT",
          "The DOCX contains oversized or unsafe XML declarations.",
          { fileName },
        );
      }
      if (
        normalizedName === "[content_types].xml" &&
        /(?:macroEnabled|activeX|oleObject)/iu.test(xml)
      ) {
        throw new ImportExportError(
          "IMPORT_ARCHIVE_ACTIVE_CONTENT",
          "Macro-enabled, ActiveX, and embedded-object DOCX content is not accepted.",
          { fileName },
        );
      }
      if (normalizedName === "word/document.xml" && /<w:altChunk\b/iu.test(xml)) {
        throw new ImportExportError(
          "IMPORT_ARCHIVE_ACTIVE_CONTENT",
          "Alternative embedded DOCX content is not accepted.",
          { fileName },
        );
      }
      if (normalizedName.endsWith(".rels") && hasExternalRelationship(xml)) {
        issues.push({
          severity: "warning",
          code: "MARKDOWN_EXTERNAL_REFERENCE_REMOVED",
          message: "External DOCX relationships were ignored and were not requested.",
          fileName,
        });
      }
    }
    return issues;
  } catch (error: unknown) {
    if (error instanceof ImportExportError) {
      throw error;
    }
    throw archiveInvalid(fileName);
  }
}

function hasExternalRelationship(xml: string): boolean {
  return /<Relationship\b(?=[^>]*\bTargetMode\s*=\s*["']External["'])[^>]*>/giu.test(xml);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUint32(bytes, offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return -1;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    return -1;
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function archiveInvalid(fileName: string): ImportExportError {
  return new ImportExportError(
    "IMPORT_ARCHIVE_INVALID",
    "The DOCX archive structure is invalid or unsupported.",
    { fileName },
  );
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const clone = new Uint8Array(bytes.byteLength);
  clone.set(bytes);
  return clone.buffer;
}

function mammothInput(
  bytes: Uint8Array,
): { readonly arrayBuffer: ArrayBuffer } | { readonly buffer: unknown } {
  const maybeBuffer = (
    globalThis as unknown as {
      readonly Buffer?: {
        from(value: Uint8Array): unknown;
      };
    }
  ).Buffer;
  return maybeBuffer === undefined
    ? { arrayBuffer: exactArrayBuffer(bytes) }
    : { buffer: maybeBuffer.from(bytes) };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new DOMException("The import was aborted.", "AbortError");
  }
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (signal?.aborted === true && error === signal.reason)
  );
}

function isPdfPasswordError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "PasswordException"
  );
}
