export type ImportExportErrorCode =
  | "IMPORT_EMPTY"
  | "IMPORT_TOO_MANY_FILES"
  | "IMPORT_FILE_TOO_LARGE"
  | "IMPORT_TOTAL_TOO_LARGE"
  | "IMPORT_MIXED_FORMATS"
  | "IMPORT_DUPLICATE_FILE"
  | "IMPORT_EXTENSION_FORBIDDEN"
  | "IMPORT_MACRO_FORMAT_FORBIDDEN"
  | "IMPORT_BINARY_FORMAT_FORBIDDEN"
  | "IMPORT_MAGIC_MISMATCH"
  | "IMPORT_ENCODING_UNCERTAIN"
  | "IMPORT_ARCHIVE_INVALID"
  | "IMPORT_ARCHIVE_LIMIT_EXCEEDED"
  | "IMPORT_ARCHIVE_ENCRYPTED"
  | "IMPORT_ARCHIVE_ACTIVE_CONTENT"
  | "IMPORT_PATH_TRAVERSAL"
  | "IMPORT_UNSAFE_PATH"
  | "IMPORT_UNSAFE_CONTENT"
  | "DOCX_PARSE_FAILED"
  | "DOCX_PARSER_WARNING"
  | "EPUB_PARSE_FAILED"
  | "EPUB_DRM_UNSUPPORTED"
  | "EPUB_CONTENT_UNAVAILABLE"
  | "EPUB_ACTIVE_CONTENT_FORBIDDEN"
  | "PDF_PARSE_FAILED"
  | "PDF_ENCRYPTED_UNSUPPORTED"
  | "PDF_TEXT_UNAVAILABLE"
  | "PDF_PAGE_LIMIT_EXCEEDED"
  | "PDF_ACTIVE_CONTENT_FORBIDDEN"
  | "IMPORT_CHAPTER_BOUNDARY_REVIEW"
  | "IMPORT_CHAPTER_SPLIT"
  | "IMPORT_INVALID_JSON"
  | "BUNDLE_SCHEMA_INVALID"
  | "BUNDLE_VERSION_UNSUPPORTED"
  | "BUNDLE_CHECKSUM_MISMATCH"
  | "BUNDLE_ENTRY_CHECKSUM_MISMATCH"
  | "BUNDLE_MANIFEST_CONTENT_MISMATCH"
  | "BUNDLE_DUPLICATE_ENTRY"
  | "BUNDLE_LIMIT_EXCEEDED"
  | "MARKDOWN_EMPTY"
  | "MARKDOWN_RAW_HTML_ESCAPED"
  | "MARKDOWN_EXTERNAL_REFERENCE_REMOVED"
  | "HTML_MARKUP_REMOVED"
  | "TEXT_BOM_REMOVED";

export type ImportIssueSeverity = "blocking" | "warning" | "info";

export interface ImportIssue {
  readonly severity: ImportIssueSeverity;
  readonly code: ImportExportErrorCode;
  readonly message: string;
  readonly fileName?: string;
  readonly path?: string;
}

export class ImportExportError extends Error {
  readonly fileName: string | undefined;
  readonly path: string | undefined;

  constructor(
    readonly code: ImportExportErrorCode,
    message: string,
    options: {
      readonly fileName?: string;
      readonly path?: string;
    } = {},
  ) {
    super(message);
    this.name = "ImportExportError";
    this.fileName = options.fileName;
    this.path = options.path;
  }

  toIssue(): ImportIssue {
    const base = {
      severity: "blocking",
      code: this.code,
      message: this.message,
    } as const;

    return {
      ...base,
      ...(this.fileName === undefined ? {} : { fileName: this.fileName }),
      ...(this.path === undefined ? {} : { path: this.path }),
    };
  }
}
