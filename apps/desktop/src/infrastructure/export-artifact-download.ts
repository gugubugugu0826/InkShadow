import { invoke } from "@tauri-apps/api/core";

const DOWNLOAD_URL_RETENTION_MS = 60_000;
const MAX_DOWNLOAD_FILENAME_CHARACTERS = 180;
const MAX_NATIVE_DOWNLOAD_FILENAME_CHARACTERS = 255;
const MAX_EXPORT_BYTES = 64 * 1_024 * 1_024;
const MAX_RECEIPT_PATH_CHARACTERS = 32_767;
const EXPORT_RECEIPT_STORAGE_KEY = "inkshadow.export.last-receipt.v1";
const SAFE_MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;
const UNSAFE_FILENAME_PATTERN = /[/\\\u0000-\u001f\u007f]/u;
const UNSAFE_PATH_PATTERN = /[\u0000-\u001f\u007f]/u;
const TICKET_PATTERN = /^[a-f0-9]{64}$/iu;
const WRITE_RESULT_UNKNOWN_PATH = "保存位置已隐藏（写入结果不明确）";

export type ExportArtifactFormat =
  "text" | "markdown" | "bundle" | "epub" | "docx" | "pdf" | "report";

export type ExportArtifactSaveStatus = "success" | "cancelled" | "failed" | "browser_download";

export type ExportArtifactVerification =
  "verified" | "not_written" | "path_not_available" | "write_result_unknown";

export interface BrowserExportArtifact {
  readonly fileName: string;
  readonly mediaType: string;
  readonly content: string | Uint8Array;
}

export interface BrowserExportDownloadReceipt {
  readonly fileName: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface ExportArtifactSaveReceipt {
  readonly format: ExportArtifactFormat;
  readonly fileName: string;
  readonly path: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly status: ExportArtifactSaveStatus;
  readonly verification: ExportArtifactVerification;
}

export interface SaveExportArtifactOptions {
  readonly format: ExportArtifactFormat;
  readonly mode: "tauri" | "browser-development";
}

export class ExportArtifactSaveError extends Error {
  public constructor(
    message: string,
    public readonly receipt: ExportArtifactSaveReceipt,
  ) {
    super(message);
    this.name = "ExportArtifactSaveError";
  }
}

export function downloadBrowserExportArtifact(
  artifact: BrowserExportArtifact,
): BrowserExportDownloadReceipt {
  validateArtifact(artifact);
  const blobPart =
    typeof artifact.content === "string"
      ? artifact.content
      : new Uint8Array(artifact.content).buffer;
  const blob = new Blob([blobPart], {
    type:
      typeof artifact.content === "string"
        ? `${artifact.mediaType};charset=utf-8`
        : artifact.mediaType,
  });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifact.fileName;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } catch (cause: unknown) {
    URL.revokeObjectURL(url);
    throw cause;
  }
  window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_RETENTION_MS);
  return Object.freeze({
    fileName: artifact.fileName,
    byteLength: blob.size,
    mediaType: artifact.mediaType,
  });
}

export async function saveExportArtifact(
  artifact: BrowserExportArtifact,
  options: SaveExportArtifactOptions,
): Promise<ExportArtifactSaveReceipt> {
  validateArtifact(artifact);
  const byteLength = artifactByteLength(artifact);
  if (byteLength > MAX_EXPORT_BYTES) {
    throw failedSaveError(artifact, options.format, "导出文件超过 64 MiB 安全上限，未写入文件。");
  }
  if (options.mode === "browser-development") {
    try {
      downloadBrowserExportArtifact(artifact);
    } catch {
      throw failedSaveError(
        artifact,
        options.format,
        "浏览器未接受下载请求，导出文件没有被标记为已保存。",
      );
    }
    return Object.freeze({
      format: options.format,
      fileName: artifact.fileName,
      path: "浏览器下载位置（应用无法读取）",
      byteLength,
      mediaType: artifact.mediaType,
      status: "browser_download",
      verification: "path_not_available",
    });
  }

  let destination: NativeExportDestinationReceipt | null;
  try {
    const value = await invoke<unknown>("native_choose_export_destination", {
      request: {
        defaultFileName: artifact.fileName,
        format: options.format,
        mediaType: artifact.mediaType,
      },
    });
    destination = value === null ? null : validateNativeDestination(value);
  } catch {
    throw failedSaveError(artifact, options.format, "无法打开安全保存位置，请检查桌面权限后重试。");
  }
  if (destination === null) {
    return Object.freeze({
      format: options.format,
      fileName: artifact.fileName,
      path: "未选择保存位置",
      byteLength: 0,
      mediaType: artifact.mediaType,
      status: "cancelled",
      verification: "not_written",
    });
  }

  try {
    const value = await invoke<unknown>("native_write_export_artifact", {
      request: {
        destinationTicket: destination.ticket,
        format: options.format,
        mediaType: artifact.mediaType,
        expectedByteLength: byteLength,
        contentBase64: encodeBase64(artifactBytes(artifact)),
      },
    });
    return validateNativeWriteReceipt(value, artifact, options.format);
  } catch {
    throw unknownWriteResultError({ ...artifact, fileName: destination.fileName }, options.format);
  }
}

export function persistLastExportReceipt(
  storage: Storage,
  projectId: string,
  receipt: ExportArtifactSaveReceipt,
): void {
  if (!isSafeProjectId(projectId)) {
    return;
  }
  try {
    storage.setItem(EXPORT_RECEIPT_STORAGE_KEY, JSON.stringify({ projectId, receipt }));
  } catch {
    // A receipt is convenient recovery evidence, not source data. Export success
    // remains defined by the native write/read verification, not localStorage.
  }
}

export function readLastExportReceipt(
  storage: Storage,
  projectId: string,
): ExportArtifactSaveReceipt | null {
  if (!isSafeProjectId(projectId)) {
    return null;
  }
  try {
    const serialized = storage.getItem(EXPORT_RECEIPT_STORAGE_KEY);
    if (serialized === null) {
      return null;
    }
    const value: unknown = JSON.parse(serialized);
    const record = strictObject(value, ["projectId", "receipt"]);
    if (record.projectId !== projectId) {
      return null;
    }
    return validatePersistedReceipt(record.receipt);
  } catch {
    return null;
  }
}

function validateArtifact(artifact: BrowserExportArtifact): void {
  if (
    artifact.fileName.length === 0 ||
    artifact.fileName.length > MAX_DOWNLOAD_FILENAME_CHARACTERS ||
    artifact.fileName === "." ||
    artifact.fileName === ".." ||
    UNSAFE_FILENAME_PATTERN.test(artifact.fileName)
  ) {
    throw new Error("The export file name is unsafe.");
  }
  if (!SAFE_MEDIA_TYPE_PATTERN.test(artifact.mediaType)) {
    throw new Error("The export media type is invalid.");
  }
  if (
    (typeof artifact.content === "string" && artifact.content.length === 0) ||
    (artifact.content instanceof Uint8Array && artifact.content.byteLength === 0)
  ) {
    throw new Error("The export artifact is empty.");
  }
}

interface NativeExportDestinationReceipt {
  readonly ticket: string;
  readonly fileName: string;
}

function validateNativeDestination(value: unknown): NativeExportDestinationReceipt {
  const object = strictObject(value, ["ticket", "fileName"]);
  if (
    typeof object.ticket !== "string" ||
    !TICKET_PATTERN.test(object.ticket) ||
    !isSafeNativeFileName(object.fileName)
  ) {
    throw new Error("Invalid native export destination response.");
  }
  return Object.freeze({ ticket: object.ticket, fileName: object.fileName });
}

function validateNativeWriteReceipt(
  value: unknown,
  artifact: BrowserExportArtifact,
  format: ExportArtifactFormat,
): ExportArtifactSaveReceipt {
  const object = strictObject(value, [
    "format",
    "fileName",
    "path",
    "byteLength",
    "status",
    "verified",
  ]);
  const expectedByteLength = artifactByteLength(artifact);
  if (
    object.format !== format ||
    object.status !== "success" ||
    object.verified !== true ||
    object.byteLength !== expectedByteLength ||
    !isSafeNativeFileName(object.fileName) ||
    !isSafeAbsolutePath(object.path)
  ) {
    throw new Error("Invalid native export write response.");
  }
  return Object.freeze({
    format,
    fileName: object.fileName,
    path: object.path,
    byteLength: expectedByteLength,
    mediaType: artifact.mediaType,
    status: "success",
    verification: "verified",
  });
}

function validatePersistedReceipt(value: unknown): ExportArtifactSaveReceipt {
  const object = strictObject(value, [
    "format",
    "fileName",
    "path",
    "byteLength",
    "mediaType",
    "status",
    "verification",
  ]);
  if (
    !isExportFormat(object.format) ||
    !isSafeNativeFileName(object.fileName) ||
    typeof object.path !== "string" ||
    object.path.length === 0 ||
    object.path.length > MAX_RECEIPT_PATH_CHARACTERS ||
    UNSAFE_PATH_PATTERN.test(object.path) ||
    !Number.isSafeInteger(object.byteLength) ||
    (object.byteLength as number) < 0 ||
    (object.byteLength as number) > MAX_EXPORT_BYTES ||
    typeof object.mediaType !== "string" ||
    !SAFE_MEDIA_TYPE_PATTERN.test(object.mediaType) ||
    !isSaveStatus(object.status) ||
    !isVerification(object.verification) ||
    !receiptStateIsConsistent(object)
  ) {
    throw new Error("Invalid persisted export receipt.");
  }
  return Object.freeze({
    format: object.format,
    fileName: object.fileName,
    path: object.path,
    byteLength: object.byteLength as number,
    mediaType: object.mediaType,
    status: object.status,
    verification: object.verification,
  });
}

function receiptStateIsConsistent(object: Readonly<Record<string, unknown>>): boolean {
  if (object.status === "success") {
    return (
      object.verification === "verified" &&
      (object.byteLength as number) > 0 &&
      isSafeAbsolutePath(object.path)
    );
  }
  if (object.status === "browser_download") {
    return (
      object.verification === "path_not_available" &&
      (object.byteLength as number) > 0 &&
      object.path === "浏览器下载位置（应用无法读取）"
    );
  }
  if (object.status === "cancelled") {
    return (
      object.verification === "not_written" &&
      object.byteLength === 0 &&
      object.path === "未选择保存位置"
    );
  }
  if (object.status === "failed" && object.verification === "write_result_unknown") {
    return (object.byteLength as number) > 0 && object.path === WRITE_RESULT_UNKNOWN_PATH;
  }
  return (
    object.status === "failed" &&
    object.verification === "not_written" &&
    object.byteLength === 0 &&
    object.path === "未写入（保存失败）"
  );
}

function artifactBytes(artifact: BrowserExportArtifact): Uint8Array {
  return typeof artifact.content === "string"
    ? new TextEncoder().encode(artifact.content)
    : new Uint8Array(artifact.content);
}

function artifactByteLength(artifact: BrowserExportArtifact): number {
  return artifactBytes(artifact).byteLength;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 24 * 1_024;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    let binary = "";
    for (const byte of chunk) {
      binary += String.fromCharCode(byte);
    }
    chunks.push(globalThis.btoa(binary));
  }
  return chunks.join("");
}

function failedSaveError(
  artifact: BrowserExportArtifact,
  format: ExportArtifactFormat,
  message: string,
): ExportArtifactSaveError {
  return new ExportArtifactSaveError(
    message,
    Object.freeze({
      format,
      fileName: artifact.fileName,
      path: "未写入（保存失败）",
      byteLength: 0,
      mediaType: artifact.mediaType,
      status: "failed",
      verification: "not_written",
    }),
  );
}

function unknownWriteResultError(
  artifact: BrowserExportArtifact,
  format: ExportArtifactFormat,
): ExportArtifactSaveError {
  return new ExportArtifactSaveError(
    "导出写入请求已经开始，但最终结果无法核验；文件可能已经写入。请先检查刚才选择的位置，再决定是否重试。",
    Object.freeze({
      format,
      fileName: artifact.fileName,
      path: WRITE_RESULT_UNKNOWN_PATH,
      byteLength: artifactByteLength(artifact),
      mediaType: artifact.mediaType,
      status: "failed",
      verification: "write_result_unknown",
    }),
  );
}

function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid export receipt response.");
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Invalid export receipt response.");
  }
  return object;
}

function isSafeNativeFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NATIVE_DOWNLOAD_FILENAME_CHARACTERS &&
    value !== "." &&
    value !== ".." &&
    !UNSAFE_FILENAME_PATTERN.test(value)
  );
}

function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RECEIPT_PATH_CHARACTERS &&
    !UNSAFE_PATH_PATTERN.test(value) &&
    (/^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\") || value.startsWith("/"))
  );
}

function isSafeProjectId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !UNSAFE_PATH_PATTERN.test(value);
}

function isExportFormat(value: unknown): value is ExportArtifactFormat {
  return ["text", "markdown", "bundle", "epub", "docx", "pdf", "report"].includes(value as string);
}

function isSaveStatus(value: unknown): value is ExportArtifactSaveStatus {
  return ["success", "cancelled", "failed", "browser_download"].includes(value as string);
}

function isVerification(value: unknown): value is ExportArtifactVerification {
  return ["verified", "not_written", "path_not_available", "write_result_unknown"].includes(
    value as string,
  );
}
