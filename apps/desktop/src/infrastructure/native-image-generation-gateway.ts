import { invoke } from "@tauri-apps/api/core";

import type { NativeGatewayEndpointConfig } from "./native-model-gateway-contract";

export type NativeImageEndpointConfig = NativeGatewayEndpointConfig;

export interface NativeImageDestinationReceipt {
  readonly ticket: string;
  readonly fileName: string;
}

export interface NativeImageGenerationInput {
  readonly destinationTicket: string;
  readonly config: NativeImageEndpointConfig;
  readonly model: string;
  readonly prompt: string;
}

export interface NativeImageGenerationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
}

export interface NativeImageFileReceipt {
  readonly provider: "open_ai_compatible";
  readonly endpointOrigin: string;
  readonly model: string;
  readonly fileName: string;
  readonly mediaType: "image/png";
  readonly bytesWritten: number;
  readonly usage: NativeImageGenerationUsage | null;
}

export interface NativeImageGenerationGateway {
  readonly available: boolean;
  chooseDestination(): Promise<NativeImageDestinationReceipt | null>;
  generateToFile(input: NativeImageGenerationInput): Promise<NativeImageFileReceipt>;
}

export class TauriNativeImageGenerationGateway implements NativeImageGenerationGateway {
  public readonly available = true;

  public async chooseDestination(): Promise<NativeImageDestinationReceipt | null> {
    try {
      const value = await invoke<unknown>("choose_native_image_destination");
      return value === null ? null : validateDestination(value);
    } catch (cause: unknown) {
      throw normalizeGatewayError(cause);
    }
  }

  public async generateToFile(input: NativeImageGenerationInput): Promise<NativeImageFileReceipt> {
    try {
      const value = await invoke<unknown>("generate_native_image_to_file", { request: input });
      return validateImageReceipt(value, input);
    } catch (cause: unknown) {
      throw normalizeGatewayError(cause);
    }
  }
}

export class UnavailableNativeImageGenerationGateway implements NativeImageGenerationGateway {
  public readonly available = false;

  public chooseDestination(): Promise<null> {
    return Promise.resolve(null);
  }

  public generateToFile(): Promise<never> {
    return Promise.reject(
      new NativeImageGenerationError(
        "MODEL_IMAGE_DESKTOP_REQUIRED",
        "图片生成与本地保存只在桌面版可用。",
        false,
      ),
    );
  }
}

export class NativeImageGenerationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NativeImageGenerationError";
  }
}

function validateDestination(value: unknown): NativeImageDestinationReceipt {
  const object = strictObject(value, ["ticket", "fileName"]);
  const ticket = safeString(object.ticket, 64);
  const fileName = safeString(object.fileName, 255);
  if (!/^[a-f0-9]{64}$/iu.test(ticket) || !isSafePngFileName(fileName)) {
    throw invalidResponse();
  }
  return Object.freeze({ ticket, fileName });
}

function validateImageReceipt(
  value: unknown,
  input: NativeImageGenerationInput,
): NativeImageFileReceipt {
  const object = strictObject(value, [
    "provider",
    "endpointOrigin",
    "model",
    "fileName",
    "mediaType",
    "bytesWritten",
    "usage",
  ]);
  if (
    object.provider !== "open_ai_compatible" ||
    object.mediaType !== "image/png" ||
    object.model !== input.model
  ) {
    throw invalidResponse();
  }
  const endpointOrigin = safeString(object.endpointOrigin, 2_048);
  const fileName = safeString(object.fileName, 255);
  const bytesWritten = safeInteger(object.bytesWritten, 1, 48 * 1_024 * 1_024);
  if (!isSafeOrigin(endpointOrigin) || !isSafePngFileName(fileName)) {
    throw invalidResponse();
  }
  return Object.freeze({
    provider: "open_ai_compatible",
    endpointOrigin,
    model: input.model,
    fileName,
    mediaType: "image/png",
    bytesWritten,
    usage: validateUsage(object.usage),
  });
}

function validateUsage(value: unknown): NativeImageGenerationUsage | null {
  if (value === null) {
    return null;
  }
  const object = strictObject(value, ["inputTokens", "outputTokens", "cachedInputTokens"]);
  if (object.cachedInputTokens !== null) {
    throw invalidResponse();
  }
  return Object.freeze({
    inputTokens: safeInteger(object.inputTokens, 0, 100_000_000),
    outputTokens: safeInteger(object.outputTokens, 0, 100_000_000),
    cachedInputTokens: null,
  });
}

function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse();
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidResponse();
  }
  return object;
}

function safeString(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidResponse();
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidResponse();
  }
  return value as number;
}

function isSafePngFileName(value: string): boolean {
  return (
    value.toLowerCase().endsWith(".png") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== ".png"
  );
}

function isSafeOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const local =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return (
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (url.protocol === "https:" || (local && url.protocol === "http:"))
    );
  } catch {
    return false;
  }
}

function normalizeGatewayError(cause: unknown): NativeImageGenerationError {
  if (cause instanceof NativeImageGenerationError) {
    return cause;
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/u.test(cause.code)
  ) {
    return new NativeImageGenerationError(
      cause.code,
      friendlyErrorMessage(cause.code),
      "retryable" in cause && cause.retryable === true,
    );
  }
  return new NativeImageGenerationError(
    "MODEL_IMAGE_GATEWAY_FAILED",
    "图片生成未完成，未创建图片文件。请检查连接后重试。",
    true,
  );
}

function friendlyErrorMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    MODEL_IMAGE_DESTINATION_INVALID: "保存位置无效或文件已存在，请选择一个新的 PNG 文件名。",
    MODEL_IMAGE_URL_RESPONSE_UNSUPPORTED:
      "这个模型只返回临时图片链接，当前版本不会代替你下载不受信任的链接。请换用能返回图片数据的模型。",
    MODEL_IMAGE_SAVE_FAILED: "图片已经生成，但未能写入所选位置。请检查磁盘空间和文件权限。",
    MODEL_HTTP_UNAUTHORIZED: "供应商拒绝了 API Key，请在设置中重新保存密钥。",
    MODEL_HTTP_FORBIDDEN: "当前账号没有这个图片模型的访问权限，请更换模型或检查供应商权限。",
    MODEL_HTTP_RATE_LIMITED: "供应商当前限流，请稍后重试。",
    MODEL_HTTP_BAD_REQUEST: "供应商不接受这次图片请求，请更换已验证的图片模型。",
    MODEL_HTTP_NOT_FOUND: "供应商找不到图片接口或模型，请重新同步模型并检查连接。",
    MODEL_TIMEOUT: "图片生成等待超时，未创建文件。请稍后重试。",
    MODEL_RESPONSE_INVALID: "供应商没有返回可安全保存的 PNG 图片，请更换模型。",
  };
  return messages[code] ?? "图片生成未完成，未创建图片文件。请检查供应商连接后重试。";
}

function invalidResponse(): NativeImageGenerationError {
  return new NativeImageGenerationError(
    "MODEL_IMAGE_RESPONSE_INVALID",
    "原生图片网关返回了无法验证的结果，未继续使用该结果。",
    false,
  );
}
