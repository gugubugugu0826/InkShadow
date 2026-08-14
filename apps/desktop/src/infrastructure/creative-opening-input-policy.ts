export type CreativeOpeningInputInvalidReason =
  "EMPTY" | "WHITESPACE_ONLY" | "TOO_SHORT" | "TOO_LARGE" | "CONTROL_CHARACTER";

export type CreativeOpeningInputInvalidCode =
  `CREATIVE_INPUT_INVALID_${CreativeOpeningInputInvalidReason}`;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Author-owned natural language is canonically composed, never compatibility
 * folded. This preserves intentional full-width forms and Chinese punctuation
 * across the form, ProjectSeed, provider prompt, and Candidate boundaries.
 */
export function validateCreativeOpeningIdea(value: string): string {
  return validateCreativeAuthorText(value, {
    label: "一句话灵感",
    minimum: 2,
    maximum: 4_000,
  });
}

export function validateCreativeOpeningDirection(value: string): string {
  return validateCreativeAuthorText(value, {
    label: "本轮方向",
    minimum: 1,
    maximum: 1_000,
  });
}

export function validateCreativeOpeningProse(
  value: string,
  maximum = 5_000_000,
  label = "开头正文",
): string {
  return validateCreativeAuthorText(value, { label, minimum: 1, maximum });
}

export function validateCreativeAuthorText(
  value: string,
  policy: Readonly<{ label: string; minimum: number; maximum: number }>,
): string {
  const composed = value.normalize("NFC").replaceAll(/\r\n?/gu, "\n");
  if (composed.length === 0) {
    throw invalid("EMPTY", `${policy.label}不能为空。`);
  }
  const normalized = composed.trim();
  if (normalized.length === 0) {
    throw invalid("WHITESPACE_ONLY", `${policy.label}不能只包含空白字符。`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw invalid("CONTROL_CHARACTER", `${policy.label}包含不可见控制字符。请删除异常字符后重试。`);
  }
  if (normalized.length < policy.minimum) {
    throw invalid(
      "TOO_SHORT",
      `${policy.label}至少需要 ${String(policy.minimum)} 个可读字符；也可以改为直接空白写作。`,
    );
  }
  if (normalized.length > policy.maximum) {
    throw invalid(
      "TOO_LARGE",
      `${policy.label}不能超过 ${String(policy.maximum)} 个字符。当前输入仍保留在页面中。`,
    );
  }
  return normalized;
}

export function isCreativeOpeningInputError(
  cause: unknown,
): cause is CreativeOpeningInputValidationError {
  return cause instanceof CreativeOpeningInputValidationError;
}

export class CreativeOpeningInputValidationError extends Error {
  public readonly code: CreativeOpeningInputInvalidCode;
  public readonly retryable = false;

  public constructor(
    public readonly reason: CreativeOpeningInputInvalidReason,
    message: string,
  ) {
    super(message);
    this.name = "CreativeOpeningInputValidationError";
    this.code = `CREATIVE_INPUT_INVALID_${reason}`;
  }
}

function invalid(
  reason: CreativeOpeningInputInvalidReason,
  message: string,
): CreativeOpeningInputValidationError {
  return new CreativeOpeningInputValidationError(reason, message);
}
