import { canonicalJson, checksumEquals, sha256Hex, utf8ByteLength } from "./checksum.js";
import { IMPORT_LIMITS, PORTABLE_BUNDLE_FORMAT, PORTABLE_BUNDLE_VERSION } from "./constants.js";
import { ImportExportError } from "./errors.js";
import { assertSafeBundlePath, sanitizeFilename } from "./filename.js";
import {
  portableBundleMetadataSchema,
  portableBundleV1Schema,
  portableProjectInputSchema,
  type PortableBundleMetadata,
  type PortableBundleV1,
  type PortableChapterV1,
  type PortableManifestEntryV1,
  type PortableProjectInput,
  type PortableProjectV1,
} from "./schemas.js";
import { sanitizeMarkdown } from "./text.js";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaIssueMessage(
  context: string,
  issues: readonly {
    readonly message: string;
    readonly path: readonly PropertyKey[];
  }[],
): string {
  const first = issues[0];
  if (first === undefined) {
    return `${context} does not match the Portable Bundle v1 schema.`;
  }

  const path = first.path.map(String).join(".");
  return `${context} is invalid${path.length === 0 ? "" : ` at ${path}`}: ${first.message}`;
}

function parseProjectInput(input: unknown): PortableProjectInput {
  const result = portableProjectInputSchema.safeParse(input);
  if (!result.success) {
    throw new ImportExportError(
      "BUNDLE_SCHEMA_INVALID",
      schemaIssueMessage("Portable project input", result.error.issues),
    );
  }
  return result.data;
}

function parseBundleMetadata(input: unknown): PortableBundleMetadata {
  const result = portableBundleMetadataSchema.safeParse(input);
  if (!result.success) {
    throw new ImportExportError(
      "BUNDLE_SCHEMA_INVALID",
      schemaIssueMessage("Portable bundle metadata", result.error.issues),
    );
  }
  return result.data;
}

function assertChronology(project: PortableProjectV1["project"]): void {
  if (Date.parse(project.updatedAt) < Date.parse(project.createdAt)) {
    throw new ImportExportError(
      "BUNDLE_MANIFEST_CONTENT_MISMATCH",
      "Project updatedAt must not precede createdAt.",
    );
  }
}

function duplicateKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function assertUniqueAndOrderedChapters(chapters: readonly PortableChapterV1[]): void {
  const identifiers = new Set<string>();
  const paths = new Set<string>();

  chapters.forEach((chapter, index) => {
    if (chapter.order !== index) {
      throw new ImportExportError(
        "BUNDLE_MANIFEST_CONTENT_MISMATCH",
        "Chapter order values must be contiguous and start at zero.",
        { path: chapter.path },
      );
    }
    if (identifiers.has(chapter.id)) {
      throw new ImportExportError(
        "BUNDLE_DUPLICATE_ENTRY",
        `Duplicate chapter identifier: ${chapter.id}.`,
        { path: chapter.path },
      );
    }

    const normalizedPath = duplicateKey(chapter.path);
    if (paths.has(normalizedPath)) {
      throw new ImportExportError(
        "BUNDLE_DUPLICATE_ENTRY",
        `Duplicate chapter path: ${chapter.path}.`,
        { path: chapter.path },
      );
    }

    assertSafeBundlePath(chapter.path);
    identifiers.add(chapter.id);
    paths.add(normalizedPath);
  });
}

async function createManifestEntries(
  chapters: readonly PortableChapterV1[],
): Promise<PortableManifestEntryV1[]> {
  const entries: PortableManifestEntryV1[] = [];
  for (const chapter of chapters) {
    entries.push({
      id: chapter.id,
      kind: "chapter" as const,
      order: chapter.order,
      path: chapter.path,
      mediaType: "text/markdown" as const,
      byteLength: utf8ByteLength(chapter.markdown),
      checksum: {
        algorithm: "sha256" as const,
        value: await sha256Hex(chapter.markdown),
      },
    });
  }
  return entries;
}

function defaultChapterPath(chapter: { readonly order: number; readonly title: string }): string {
  const ordinal = String(chapter.order + 1).padStart(4, "0");
  return `chapters/${ordinal}-${sanitizeFilename(chapter.title, ".md")}`;
}

function normalizeProject(input: PortableProjectInput): PortableProjectV1 {
  const sorted = [...input.chapters].sort((left, right) => left.order - right.order);
  const chapters = sorted.map<PortableChapterV1>((chapter) => {
    const path = chapter.path ?? defaultChapterPath(chapter);
    assertSafeBundlePath(path);
    const sanitized = sanitizeMarkdown(chapter.markdown, path);

    return {
      id: chapter.id,
      title: chapter.title,
      order: chapter.order,
      path,
      markdown: sanitized.markdown,
    };
  });

  const project: PortableProjectV1 = {
    project: input.project,
    chapters,
  };
  assertChronology(project.project);
  assertUniqueAndOrderedChapters(project.chapters);
  return project;
}

function assertManifestMatchesContent(bundle: PortableBundleV1): void {
  const { content, manifest } = bundle;
  if (
    manifest.project.id !== content.project.id ||
    manifest.project.title !== content.project.title ||
    manifest.project.language !== content.project.language ||
    manifest.counts.chapters !== content.chapters.length ||
    manifest.entries.length !== content.chapters.length
  ) {
    throw new ImportExportError(
      "BUNDLE_MANIFEST_CONTENT_MISMATCH",
      "The manifest project summary or chapter count does not match bundle content.",
    );
  }
}

async function assertChapterEntriesMatch(bundle: PortableBundleV1): Promise<void> {
  const entryIds = new Set<string>();
  const entryPaths = new Set<string>();

  for (let index = 0; index < bundle.content.chapters.length; index += 1) {
    const chapter = bundle.content.chapters[index];
    const entry = bundle.manifest.entries[index];
    if (chapter === undefined || entry === undefined) {
      throw new ImportExportError(
        "BUNDLE_MANIFEST_CONTENT_MISMATCH",
        "Each chapter must have exactly one manifest entry.",
      );
    }

    const normalizedEntryPath = duplicateKey(entry.path);
    if (entryIds.has(entry.id) || entryPaths.has(normalizedEntryPath)) {
      throw new ImportExportError(
        "BUNDLE_DUPLICATE_ENTRY",
        "Manifest entries must have unique identifiers and paths.",
        { path: entry.path },
      );
    }
    entryIds.add(entry.id);
    entryPaths.add(normalizedEntryPath);
    assertSafeBundlePath(entry.path);

    if (entry.id !== chapter.id || entry.order !== chapter.order || entry.path !== chapter.path) {
      throw new ImportExportError(
        "BUNDLE_MANIFEST_CONTENT_MISMATCH",
        "A manifest entry does not match its chapter.",
        { path: entry.path },
      );
    }

    const byteLength = utf8ByteLength(chapter.markdown);
    if (byteLength > IMPORT_LIMITS.maximumChapterBytes) {
      throw new ImportExportError(
        "BUNDLE_LIMIT_EXCEEDED",
        "A chapter exceeds the Portable Bundle v1 size limit.",
        { path: chapter.path },
      );
    }
    if (entry.byteLength !== byteLength) {
      throw new ImportExportError(
        "BUNDLE_MANIFEST_CONTENT_MISMATCH",
        "A manifest byte length does not match its chapter.",
        { path: entry.path },
      );
    }

    const entryChecksum = await sha256Hex(chapter.markdown);
    if (!checksumEquals(entry.checksum.value, entryChecksum)) {
      throw new ImportExportError(
        "BUNDLE_ENTRY_CHECKSUM_MISMATCH",
        "A chapter checksum does not match its content.",
        { path: entry.path },
      );
    }

    const sanitized = sanitizeMarkdown(chapter.markdown, chapter.path);
    if (sanitized.markdown !== chapter.markdown || sanitized.issues.length > 0) {
      throw new ImportExportError(
        "IMPORT_UNSAFE_CONTENT",
        "Portable bundle Markdown must already be normalized and free of raw HTML or external references.",
        { path: chapter.path },
      );
    }
  }
}

function assertSupportedVersion(input: unknown): void {
  if (!isRecord(input) || !isRecord(input.manifest)) {
    return;
  }
  if (
    input.manifest.format === PORTABLE_BUNDLE_FORMAT &&
    typeof input.manifest.version === "number" &&
    input.manifest.version !== PORTABLE_BUNDLE_VERSION
  ) {
    throw new ImportExportError(
      "BUNDLE_VERSION_UNSUPPORTED",
      `Portable Bundle version ${String(input.manifest.version)} is not supported.`,
    );
  }
}

export async function verifyPortableBundle(input: unknown): Promise<PortableBundleV1> {
  assertSupportedVersion(input);
  const result = portableBundleV1Schema.safeParse(input);
  if (!result.success) {
    throw new ImportExportError(
      "BUNDLE_SCHEMA_INVALID",
      schemaIssueMessage("Portable bundle", result.error.issues),
    );
  }

  const bundle = result.data;
  assertChronology(bundle.content.project);
  assertUniqueAndOrderedChapters(bundle.content.chapters);
  assertManifestMatchesContent(bundle);
  await assertChapterEntriesMatch(bundle);

  const canonicalContent = canonicalJson(bundle.content);
  const contentBytes = utf8ByteLength(canonicalContent);
  if (contentBytes > IMPORT_LIMITS.maximumTotalBytes) {
    throw new ImportExportError(
      "BUNDLE_LIMIT_EXCEEDED",
      "Portable bundle content exceeds the total size limit.",
    );
  }
  if (bundle.manifest.contentBytes !== contentBytes) {
    throw new ImportExportError(
      "BUNDLE_MANIFEST_CONTENT_MISMATCH",
      "The manifest content byte length does not match bundle content.",
    );
  }

  const checksum = await sha256Hex(canonicalContent);
  if (!checksumEquals(bundle.manifest.checksum.value, checksum)) {
    throw new ImportExportError(
      "BUNDLE_CHECKSUM_MISMATCH",
      "The bundle content checksum does not match the manifest.",
    );
  }

  return bundle;
}

export async function createPortableBundle(
  input: PortableProjectInput,
  metadata: PortableBundleMetadata,
): Promise<PortableBundleV1> {
  const projectInput = parseProjectInput(input);
  const bundleMetadata = parseBundleMetadata(metadata);
  const content = normalizeProject(projectInput);
  const entries = await createManifestEntries(content.chapters);
  const canonicalContent = canonicalJson(content);
  const contentBytes = utf8ByteLength(canonicalContent);

  if (contentBytes > IMPORT_LIMITS.maximumTotalBytes) {
    throw new ImportExportError(
      "BUNDLE_LIMIT_EXCEEDED",
      "Portable bundle content exceeds the total size limit.",
    );
  }

  const bundle: PortableBundleV1 = {
    manifest: {
      format: PORTABLE_BUNDLE_FORMAT,
      version: PORTABLE_BUNDLE_VERSION,
      bundleId: bundleMetadata.bundleId,
      exportedAt: bundleMetadata.exportedAt,
      generator: {
        name: "InkShadow",
        version: bundleMetadata.generatorVersion,
      },
      project: {
        id: content.project.id,
        title: content.project.title,
        language: content.project.language,
      },
      counts: {
        chapters: content.chapters.length,
      },
      contentBytes,
      checksum: {
        algorithm: "sha256",
        value: await sha256Hex(canonicalContent),
      },
      entries,
    },
    content,
  };

  return verifyPortableBundle(bundle);
}

export async function serializePortableBundle(bundle: PortableBundleV1): Promise<string> {
  const verified = await verifyPortableBundle(bundle);
  const json = `${JSON.stringify(verified, null, 2)}\n`;
  if (utf8ByteLength(json) > IMPORT_LIMITS.maximumBundleBytes) {
    throw new ImportExportError(
      "BUNDLE_LIMIT_EXCEEDED",
      "The serialized Portable Bundle exceeds the bundle size limit.",
    );
  }
  return json;
}

export async function exportPortableBundle(
  input: PortableProjectInput,
  metadata: PortableBundleMetadata,
): Promise<string> {
  const bundle = await createPortableBundle(input, metadata);
  return serializePortableBundle(bundle);
}

export async function parsePortableBundle(json: string): Promise<PortableBundleV1> {
  if (utf8ByteLength(json) > IMPORT_LIMITS.maximumBundleBytes) {
    throw new ImportExportError(
      "BUNDLE_LIMIT_EXCEEDED",
      "The Portable Bundle exceeds the bundle size limit.",
    );
  }

  const normalized = json.startsWith("\uFEFF") ? json.slice(1) : json;
  if (normalized.trim().length === 0) {
    throw new ImportExportError("IMPORT_INVALID_JSON", "The Portable Bundle JSON is empty.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    throw new ImportExportError("IMPORT_INVALID_JSON", "The Portable Bundle is not valid JSON.");
  }
  return verifyPortableBundle(parsed);
}

export async function importPortableBundle(json: string): Promise<PortableProjectV1> {
  const bundle = await parsePortableBundle(json);
  return bundle.content;
}
