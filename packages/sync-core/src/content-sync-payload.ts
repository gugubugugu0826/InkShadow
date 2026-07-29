import { MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES } from "./chunk-crypto.js";
import { SyncCoreError } from "./errors.js";
import {
  compareBytesConstantTime,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireSha256,
} from "./validation.js";

export const CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION = 1 as const;
export const MAX_CONTENT_SYNC_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_PROJECT_NAME_LENGTH = 120;
export const MAX_CHAPTER_TITLE_LENGTH = 200;
export const MAX_CHAPTER_CONTENT_LENGTH = 5_000_000;

export const CONTENT_SYNC_OBJECT_TYPES = ["project_manifest", "chapter_version"] as const;
export type ContentSyncObjectType = (typeof CONTENT_SYNC_OBJECT_TYPES)[number];

export const PROJECT_LIFECYCLE_STATUSES = ["active", "archived", "trashed"] as const;
export type ProjectLifecycleStatus = (typeof PROJECT_LIFECYCLE_STATUSES)[number];
export type ProjectStatusBeforeTrash = Exclude<ProjectLifecycleStatus, "trashed">;

export const CHAPTER_LIFECYCLE_STATUSES = ["active", "trashed"] as const;
export type ChapterLifecycleStatus = (typeof CHAPTER_LIFECYCLE_STATUSES)[number];

export const CONTENT_SYNC_CHAPTER_VERSION_REASONS = [
  "created",
  "autosave",
  "manual",
  "candidate_accept",
  "recovery",
  "import",
] as const;
export type ContentSyncChapterVersionReason = (typeof CONTENT_SYNC_CHAPTER_VERSION_REASONS)[number];

/**
 * The complete project row required to deterministically materialize a project
 * manifest. It intentionally mirrors the domain ProjectSnapshot without
 * importing domain runtime code into the transport package.
 */
export interface ContentSyncProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectLifecycleStatus;
  readonly revision: number;
  readonly deletionGeneration: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly trashedAt: string | null;
  readonly retentionUntil: string | null;
  readonly statusBeforeTrash: ProjectStatusBeforeTrash | null;
}

/**
 * The complete current chapter projection required to materialize the chapters
 * row.
 */
export interface ContentSyncChapterSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly content: string;
  readonly status: ChapterLifecycleStatus;
  readonly revision: number;
  readonly currentVersionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly trashedAt: string | null;
}

/**
 * The immutable current chapter_versions row carried alongside its chapter
 * projection.
 */
export interface ContentSyncChapterVersionSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly parentVersionId: string | null;
  readonly sequence: number;
  readonly content: string;
  readonly contentChecksum: string;
  readonly reason: ContentSyncChapterVersionReason;
  readonly sourceCandidateId: string | null;
  readonly createdAt: string;
}

export interface ProjectManifestContentSyncPayload {
  readonly schemaVersion: typeof CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION;
  readonly objectType: "project_manifest";
  readonly projectId: string;
  readonly objectId: string;
  readonly objectGeneration: number;
  readonly project: ContentSyncProjectSnapshot;
}

export interface ChapterVersionContentSyncPayload {
  readonly schemaVersion: typeof CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION;
  readonly objectType: "chapter_version";
  readonly projectId: string;
  /** The logical sync object is the chapter, not one immutable version row. */
  readonly objectId: string;
  readonly versionId: string;
  readonly objectGeneration: number;
  readonly chapter: ContentSyncChapterSnapshot;
  readonly version: ContentSyncChapterVersionSnapshot;
}

export type ContentSyncPayload =
  ProjectManifestContentSyncPayload | ChapterVersionContentSyncPayload;

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROJECT_NAME_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const CHAPTER_TITLE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

const PROJECT_PAYLOAD_KEYS = [
  "schemaVersion",
  "objectType",
  "projectId",
  "objectId",
  "objectGeneration",
  "project",
] as const;
const PROJECT_KEYS = [
  "id",
  "name",
  "status",
  "revision",
  "deletionGeneration",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "trashedAt",
  "retentionUntil",
  "statusBeforeTrash",
] as const;
const CHAPTER_PAYLOAD_KEYS = [
  "schemaVersion",
  "objectType",
  "projectId",
  "objectId",
  "versionId",
  "objectGeneration",
  "chapter",
  "version",
] as const;
const CHAPTER_KEYS = [
  "id",
  "projectId",
  "title",
  "content",
  "status",
  "revision",
  "currentVersionId",
  "createdAt",
  "updatedAt",
  "trashedAt",
] as const;
const CHAPTER_VERSION_KEYS = [
  "id",
  "projectId",
  "chapterId",
  "parentVersionId",
  "sequence",
  "content",
  "contentChecksum",
  "reason",
  "sourceCandidateId",
  "createdAt",
] as const;

const UTF8_ENCODER = new TextEncoder();

/**
 * Strictly validates and canonicalizes an in-memory payload. The checksum check
 * is asynchronous because it uses the platform Web Crypto implementation.
 */
export async function parseContentSyncPayload(
  value: unknown,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<ContentSyncPayload> {
  const record = requirePlainRecord(value, "payload");
  if (record.schemaVersion !== CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION) {
    throw validationError("Content payload schema version is unsupported.");
  }

  let payload: ContentSyncPayload;
  if (record.objectType === "project_manifest") {
    payload = parseProjectManifestPayload(record);
  } else if (record.objectType === "chapter_version") {
    payload = await parseChapterVersionPayload(record, cryptoProvider);
  } else {
    throw validationError("Content payload object type is unsupported.");
  }

  assertPayloadSize(canonicalBytes(payload));
  return payload;
}

/**
 * Produces one deterministic JSON representation with a fixed property order
 * and UTF-8 encoding.
 */
export async function encodeContentSyncPayload(
  value: unknown,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<Uint8Array> {
  const payload = await parseContentSyncPayload(value, cryptoProvider);
  return canonicalBytes(payload);
}

/**
 * Decodes only the canonical wire representation. Rejecting alternate key
 * orders, whitespace, duplicate keys, and non-canonical normalized values keeps
 * ciphertext production reproducible.
 */
export async function decodeContentSyncPayload(
  value: Uint8Array,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<ContentSyncPayload> {
  const bytes = copyBytes(value, "payload");
  assertPayloadSize(bytes);
  if (bytes.byteLength === 0) {
    throw validationError("Content payload must not be empty.");
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw validationError("Content payload is not valid UTF-8.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw validationError("Content payload is not valid JSON.");
  }

  const payload = await parseContentSyncPayload(parsed, cryptoProvider);
  const expected = canonicalBytes(payload);
  if (!equalBytes(bytes, expected)) {
    throw validationError("Content payload JSON is not in canonical form.");
  }
  return payload;
}

/**
 * Computes the checksum stored by chapter_versions: SHA-256 over the exact
 * UTF-8 bytes of the chapter content.
 */
export async function sha256Utf8Content(
  contentValue: string,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<string> {
  const content = requireContent(contentValue, "content");
  const digest = new Uint8Array(
    await cryptoProvider.subtle.digest("SHA-256", ownedBytes(UTF8_ENCODER.encode(content))),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Splits canonical payload bytes at valid UTF-8 code-point boundaries. Every
 * returned chunk is independently valid UTF-8 and no larger than the encryption
 * layer's 4 MiB plaintext limit.
 */
export function splitContentSyncPayloadBytes(
  value: Uint8Array,
  maxChunkBytes = MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
): readonly Uint8Array[] {
  const bytes = copyBytes(value, "payload");
  assertPayloadSize(bytes);
  const maximum = requireChunkLimit(maxChunkBytes);
  if (bytes.byteLength === 0) {
    throw validationError("Content payload must not be empty.");
  }
  assertValidUtf8(bytes, "Content payload");

  const chunks: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.byteLength) {
    let end = Math.min(start + maximum, bytes.byteLength);
    if (end < bytes.byteLength) {
      while (end > start && isUtf8ContinuationByte(bytes[end] ?? 0)) {
        end -= 1;
      }
    }
    if (end === start) {
      throw validationError("The chunk limit cannot contain one UTF-8 code point.");
    }
    chunks.push(bytes.slice(start, end));
    start = end;
  }
  return Object.freeze(chunks);
}

/**
 * Reassembles chunks without decoding them first, preserving the exact canonical
 * payload bytes.
 */
export function reassembleContentSyncPayloadBytes(
  chunksValue: readonly Uint8Array[],
  maxChunkBytes = MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
): Uint8Array {
  if (!Array.isArray(chunksValue) || chunksValue.length === 0) {
    throw validationError("At least one content payload chunk is required.");
  }
  const maximum = requireChunkLimit(maxChunkBytes);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (let index = 0; index < chunksValue.length; index += 1) {
    const chunkValue: unknown = chunksValue[index];
    if (!(chunkValue instanceof Uint8Array)) {
      throw validationError(`chunks[${String(index)}] must be a byte array.`);
    }
    const chunk = copyBytes(chunkValue, `chunks[${String(index)}]`);
    if (chunk.byteLength === 0 || chunk.byteLength > maximum) {
      throw validationError("Content payload chunks must be non-empty and bounded.");
    }
    assertValidUtf8(chunk, `Content payload chunk ${String(index)}`);
    totalBytes += chunk.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CONTENT_SYNC_PAYLOAD_BYTES) {
      throw validationError("Reassembled content payload exceeds the supported size.");
    }
    chunks.push(chunk);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assertValidUtf8(combined, "Reassembled content payload");
  return combined;
}

export async function encodeContentSyncPayloadChunks(
  value: unknown,
  maxChunkBytes = MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<readonly Uint8Array[]> {
  return splitContentSyncPayloadBytes(
    await encodeContentSyncPayload(value, cryptoProvider),
    maxChunkBytes,
  );
}

export async function decodeContentSyncPayloadChunks(
  chunks: readonly Uint8Array[],
  maxChunkBytes = MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<ContentSyncPayload> {
  return decodeContentSyncPayload(
    reassembleContentSyncPayloadBytes(chunks, maxChunkBytes),
    cryptoProvider,
  );
}

function parseProjectManifestPayload(
  record: Record<string, unknown>,
): ProjectManifestContentSyncPayload {
  requireExactKeys(record, PROJECT_PAYLOAD_KEYS, "project manifest payload");
  const project = parseProjectSnapshot(record.project);
  const projectId = requireUuidV7(record.projectId, "projectId");
  const objectId = requireUuidV7(record.objectId, "objectId");
  const objectGeneration = requirePositiveSafeInteger(record.objectGeneration, "objectGeneration");

  if (projectId !== project.id || objectId !== project.id) {
    throw validationError("Project manifest transport identifiers must match project.id.");
  }
  if (objectGeneration !== project.deletionGeneration + 1) {
    throw validationError(
      "Project manifest generation must immediately follow its deletion generation.",
    );
  }

  return Object.freeze({
    schemaVersion: CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
    objectType: "project_manifest",
    projectId,
    objectId,
    objectGeneration,
    project,
  });
}

async function parseChapterVersionPayload(
  record: Record<string, unknown>,
  cryptoProvider: Crypto,
): Promise<ChapterVersionContentSyncPayload> {
  requireExactKeys(record, CHAPTER_PAYLOAD_KEYS, "chapter version payload");
  const projectId = requireUuidV7(record.projectId, "projectId");
  const objectId = requireUuidV7(record.objectId, "objectId");
  const versionId = requireUuidV7(record.versionId, "versionId");
  const objectGeneration = requirePositiveSafeInteger(record.objectGeneration, "objectGeneration");
  const chapter = parseChapterSnapshot(record.chapter);
  const version = parseChapterVersionSnapshot(record.version);

  if (projectId !== chapter.projectId || projectId !== version.projectId) {
    throw validationError("Chapter payload project identifiers do not match.");
  }
  if (objectId !== chapter.id || chapter.id !== version.chapterId) {
    throw validationError("Chapter payload logical object identifiers do not match.");
  }
  if (
    versionId !== version.id ||
    chapter.currentVersionId !== version.id ||
    version.chapterId !== chapter.id
  ) {
    throw validationError("Chapter payload current version identifiers do not match.");
  }
  if (chapter.content !== version.content) {
    throw validationError("Chapter projection and current version content must match exactly.");
  }
  if (chapter.revision !== version.sequence) {
    throw validationError("Chapter revision must equal its current immutable version sequence.");
  }
  if (compareIsoTimestamps(version.createdAt, chapter.createdAt) < 0) {
    throw validationError("Current chapter version cannot predate its chapter.");
  }
  if (compareIsoTimestamps(version.createdAt, chapter.updatedAt) > 0) {
    throw validationError("Current chapter version cannot postdate the chapter projection.");
  }
  if (version.sequence === 1 && version.createdAt !== chapter.createdAt) {
    throw validationError("An initial chapter version must share its chapter creation timestamp.");
  }
  if (
    chapter.trashedAt !== null &&
    compareIsoTimestamps(version.createdAt, chapter.trashedAt) > 0
  ) {
    throw validationError("A chapter version cannot postdate the chapter trash timestamp.");
  }

  const actualChecksum = await sha256Utf8Content(version.content, cryptoProvider);
  if (!compareBytesConstantTime(actualChecksum, version.contentChecksum)) {
    throw validationError("Chapter version content checksum does not match its UTF-8 content.");
  }

  return Object.freeze({
    schemaVersion: CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
    objectType: "chapter_version",
    projectId,
    objectId,
    versionId,
    objectGeneration,
    chapter,
    version,
  });
}

function parseProjectSnapshot(value: unknown): ContentSyncProjectSnapshot {
  const record = requirePlainRecord(value, "project");
  requireExactKeys(record, PROJECT_KEYS, "project");
  const id = requireUuidV7(record.id, "project.id");
  const name = requireBoundedVisibleText(
    record.name,
    "project.name",
    MAX_PROJECT_NAME_LENGTH,
    PROJECT_NAME_CONTROL_PATTERN,
  );
  const status = requireEnum(record.status, PROJECT_LIFECYCLE_STATUSES, "project.status");
  const revision = requirePositiveSafeInteger(record.revision, "project.revision");
  const deletionGeneration = requireNonNegativeSafeInteger(
    record.deletionGeneration,
    "project.deletionGeneration",
  );
  const createdAt = requireCanonicalTimestamp(record.createdAt, "project.createdAt");
  const updatedAt = requireCanonicalTimestamp(record.updatedAt, "project.updatedAt");
  const archivedAt = requireNullableTimestamp(record.archivedAt, "project.archivedAt");
  const trashedAt = requireNullableTimestamp(record.trashedAt, "project.trashedAt");
  const retentionUntil = requireNullableTimestamp(record.retentionUntil, "project.retentionUntil");
  const statusBeforeTrash = requireNullableEnum(
    record.statusBeforeTrash,
    ["active", "archived"] as const,
    "project.statusBeforeTrash",
  );

  if (compareIsoTimestamps(createdAt, updatedAt) > 0) {
    throw validationError("Project updatedAt cannot predate createdAt.");
  }
  for (const [field, timestamp] of [
    ["archivedAt", archivedAt],
    ["trashedAt", trashedAt],
  ] as const) {
    if (
      timestamp !== null &&
      (compareIsoTimestamps(timestamp, createdAt) < 0 ||
        compareIsoTimestamps(timestamp, updatedAt) > 0)
    ) {
      throw validationError(`Project ${field} must fall within its persisted lifetime.`);
    }
  }

  const activeLifecycle =
    status === "active" &&
    archivedAt === null &&
    trashedAt === null &&
    retentionUntil === null &&
    statusBeforeTrash === null;
  const archivedLifecycle =
    status === "archived" &&
    archivedAt !== null &&
    trashedAt === null &&
    retentionUntil === null &&
    statusBeforeTrash === null;
  const trashedLifecycle =
    status === "trashed" &&
    trashedAt !== null &&
    retentionUntil !== null &&
    statusBeforeTrash !== null &&
    ((statusBeforeTrash === "active" && archivedAt === null) ||
      (statusBeforeTrash === "archived" &&
        archivedAt !== null &&
        compareIsoTimestamps(archivedAt, trashedAt) <= 0)) &&
    compareIsoTimestamps(retentionUntil, trashedAt) > 0;
  if (!activeLifecycle && !archivedLifecycle && !trashedLifecycle) {
    throw validationError("Project lifecycle fields do not match its status.");
  }

  if (
    revision < deletionGeneration + 1 ||
    (status === "trashed" && (deletionGeneration < 1 || deletionGeneration % 2 !== 1)) ||
    (status !== "trashed" && deletionGeneration % 2 !== 0)
  ) {
    throw validationError("Project revision and deletion generation do not match its lifecycle.");
  }

  return Object.freeze({
    id,
    name,
    status,
    revision,
    deletionGeneration,
    createdAt,
    updatedAt,
    archivedAt,
    trashedAt,
    retentionUntil,
    statusBeforeTrash,
  });
}

function parseChapterSnapshot(value: unknown): ContentSyncChapterSnapshot {
  const record = requirePlainRecord(value, "chapter");
  requireExactKeys(record, CHAPTER_KEYS, "chapter");
  const id = requireUuidV7(record.id, "chapter.id");
  const projectId = requireUuidV7(record.projectId, "chapter.projectId");
  const title = requireBoundedVisibleText(
    record.title,
    "chapter.title",
    MAX_CHAPTER_TITLE_LENGTH,
    CHAPTER_TITLE_CONTROL_PATTERN,
  );
  const content = requireContent(record.content, "chapter.content");
  const status = requireEnum(record.status, CHAPTER_LIFECYCLE_STATUSES, "chapter.status");
  const revision = requirePositiveSafeInteger(record.revision, "chapter.revision");
  const currentVersionId = requireUuidV7(record.currentVersionId, "chapter.currentVersionId");
  const createdAt = requireCanonicalTimestamp(record.createdAt, "chapter.createdAt");
  const updatedAt = requireCanonicalTimestamp(record.updatedAt, "chapter.updatedAt");
  const trashedAt = requireNullableTimestamp(record.trashedAt, "chapter.trashedAt");

  if (compareIsoTimestamps(createdAt, updatedAt) > 0) {
    throw validationError("Chapter updatedAt cannot predate createdAt.");
  }
  const lifecycleIsCoherent =
    (status === "active" && trashedAt === null) ||
    (status === "trashed" &&
      trashedAt !== null &&
      compareIsoTimestamps(trashedAt, createdAt) >= 0 &&
      compareIsoTimestamps(trashedAt, updatedAt) <= 0);
  if (!lifecycleIsCoherent) {
    throw validationError("Chapter lifecycle fields do not match its status.");
  }

  return Object.freeze({
    id,
    projectId,
    title,
    content,
    status,
    revision,
    currentVersionId,
    createdAt,
    updatedAt,
    trashedAt,
  });
}

function parseChapterVersionSnapshot(value: unknown): ContentSyncChapterVersionSnapshot {
  const record = requirePlainRecord(value, "version");
  requireExactKeys(record, CHAPTER_VERSION_KEYS, "chapter version");
  const id = requireUuidV7(record.id, "version.id");
  const projectId = requireUuidV7(record.projectId, "version.projectId");
  const chapterId = requireUuidV7(record.chapterId, "version.chapterId");
  const parentVersionId = requireNullableUuidV7(record.parentVersionId, "version.parentVersionId");
  const sequence = requirePositiveSafeInteger(record.sequence, "version.sequence");
  const content = requireContent(record.content, "version.content");
  const contentChecksum = requireChecksum(record.contentChecksum, "version.contentChecksum");
  const reason = requireEnum(record.reason, CONTENT_SYNC_CHAPTER_VERSION_REASONS, "version.reason");
  const sourceCandidateId = requireNullableUuidV7(
    record.sourceCandidateId,
    "version.sourceCandidateId",
  );
  const createdAt = requireCanonicalTimestamp(record.createdAt, "version.createdAt");

  if ((sequence === 1 && parentVersionId !== null) || (sequence > 1 && parentVersionId === null)) {
    throw validationError("Chapter version sequence and parentVersionId are inconsistent.");
  }
  if (parentVersionId === id) {
    throw validationError("A chapter version cannot be its own parent.");
  }
  if ((reason === "candidate_accept") !== (sourceCandidateId !== null)) {
    throw validationError(
      "Candidate-accepted versions must retain exactly one source candidate identifier.",
    );
  }

  return Object.freeze({
    id,
    projectId,
    chapterId,
    parentVersionId,
    sequence,
    content,
    contentChecksum,
    reason,
    sourceCandidateId,
    createdAt,
  });
}

function requirePlainRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(`${field} must be a JSON object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw validationError(`${field} must be a plain JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw validationError(`${field} contains missing or unknown fields.`);
  }
}

function requireUuidV7(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) {
    throw validationError(`${field} must be a UUIDv7 identifier.`);
  }
  return value.toLowerCase();
}

function requireNullableUuidV7(value: unknown, field: string): string | null {
  return value === null ? null : requireUuidV7(value, field);
}

function requireBoundedVisibleText(
  value: unknown,
  field: string,
  maximumLength: number,
  controlPattern: RegExp,
): string {
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string.`);
  }
  requireUnicodeScalarString(value, field);
  const normalized = value.trim();
  if (
    normalized !== value ||
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    controlPattern.test(normalized)
  ) {
    throw validationError(`${field} must be normalized, visible, and bounded.`);
  }
  return normalized;
}

function requireContent(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string.`);
  }
  if (value.length > MAX_CHAPTER_CONTENT_LENGTH || value.includes("\u0000")) {
    throw validationError(`${field} exceeds its supported size or contains NUL.`);
  }
  requireUnicodeScalarString(value, field);
  return value;
}

function requireUnicodeScalarString(value: string, field: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw validationError(`${field} contains an unpaired UTF-16 surrogate.`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw validationError(`${field} contains an unpaired UTF-16 surrogate.`);
    }
  }
}

function requireCanonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw validationError(`${field} must be an ISO UTC timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw validationError(`${field} must be a canonical ISO UTC timestamp.`);
  }
  return value;
}

function requireNullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : requireCanonicalTimestamp(value, field);
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw validationError(`${field} must be a positive safe integer.`);
  }
  return requirePositiveInteger(value, field);
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw validationError(`${field} must be a non-negative safe integer.`);
  }
  return requireNonNegativeInteger(value, field);
}

function requireChecksum(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw validationError(`${field} must be a SHA-256 checksum.`);
  }
  return requireSha256(value, field);
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw validationError(`${field} is unsupported.`);
  }
  return value;
}

function requireNullableEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] | null {
  return value === null ? null : requireEnum(value, values, field);
}

function compareIsoTimestamps(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function canonicalBytes(payload: ContentSyncPayload): Uint8Array {
  return UTF8_ENCODER.encode(JSON.stringify(payload));
}

function assertPayloadSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_CONTENT_SYNC_PAYLOAD_BYTES) {
    throw validationError(
      `Content payload exceeds ${String(MAX_CONTENT_SYNC_PAYLOAD_BYTES)} UTF-8 bytes.`,
    );
  }
}

function requireChunkLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 4 || value > MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES) {
    throw validationError(
      `Chunk size must be 4-${String(MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES)} bytes.`,
    );
  }
  return value;
}

function copyBytes(value: Uint8Array, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw validationError(`${field} must be a byte array.`);
  }
  return value.slice();
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function assertValidUtf8(value: Uint8Array, field: string): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw validationError(`${field} is not valid UTF-8.`);
  }
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function validationError(message: string): SyncCoreError {
  return new SyncCoreError("SYNC_VALIDATION_FAILED", message);
}
