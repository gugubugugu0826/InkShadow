export const PORTABLE_BUNDLE_FORMAT = "inkshadow-portable-bundle";
export const PORTABLE_BUNDLE_VERSION = 1;

export const IMPORT_LIMITS = Object.freeze({
  maximumFiles: 200,
  maximumFileBytes: 50 * 1024 * 1024,
  maximumTotalBytes: 50 * 1024 * 1024,
  maximumBundleBytes: 50 * 1024 * 1024,
  maximumChapters: 10_000,
  maximumChapterBytes: 2 * 1024 * 1024,
  maximumManifestEntries: 10_000,
  maximumArchiveEntries: 10_000,
  maximumArchiveExpandedBytes: 256 * 1024 * 1024,
  maximumArchiveEntryBytes: 64 * 1024 * 1024,
  maximumArchiveCompressionRatio: 250,
  maximumRelationshipBytes: 2 * 1024 * 1024,
  maximumPdfPages: 5_000,
  maximumTitleCharacters: 200,
  maximumRelativePathCharacters: 240,
});

export const ALLOWED_TEXT_EXTENSIONS = [".htm", ".html", ".md", ".markdown", ".txt"] as const;

export const ALLOWED_BINARY_DOCUMENT_EXTENSIONS = [".docx", ".pdf"] as const;

export const ALLOWED_BUNDLE_EXTENSIONS = [".inkshadow.json", ".json"] as const;

export type AllowedTextExtension = (typeof ALLOWED_TEXT_EXTENSIONS)[number];
export type AllowedBinaryDocumentExtension = (typeof ALLOWED_BINARY_DOCUMENT_EXTENSIONS)[number];
export type AllowedBundleExtension = (typeof ALLOWED_BUNDLE_EXTENSIONS)[number];
