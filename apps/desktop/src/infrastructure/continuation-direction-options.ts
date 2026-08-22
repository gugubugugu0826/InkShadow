const DIRECTION_ORDINALS = ["一", "二", "三"] as const;
const MINIMUM_DIRECTION_CHARACTERS = 4;
const MAXIMUM_DIRECTION_CHARACTERS = 160;
const MAXIMUM_RAW_RESPONSE_CHARACTERS = 1_200;
const DISALLOWED_CONTROL_OR_FORMAT_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

export const CONTINUATION_DIRECTIONS_FORMAT_INSTRUCTION = [
  "只返回三行，不要输出正文、标题、序号、项目符号、解释或其他内容。",
  "每行必须分别使用以下格式：",
  "方向一：用一句具体中文说明第一种后续走向",
  "方向二：用一句具体中文说明第二种后续走向",
  "方向三：用一句具体中文说明第三种后续走向",
  "三个方向必须都承接当前正文、彼此明显不同，并且每项为 4 到 160 个字符。",
].join("\n");

export type ContinuationDirectionOptionId =
  "continuation-direction-1" | "continuation-direction-2" | "continuation-direction-3";

export interface ContinuationDirectionOption {
  readonly id: ContinuationDirectionOptionId;
  readonly ordinal: 1 | 2 | 3;
  readonly label: "方向一" | "方向二" | "方向三";
  /** Complete, normalized instruction used by a subsequent continuation call. */
  readonly text: string;
  /** A bounded label suitable for a button or compact option card. */
  readonly displayText: string;
  readonly accessibleLabel: string;
}

export type ContinuationDirectionParseFailureReason =
  | "empty"
  | "response_too_long"
  | "unsafe_character"
  | "wrong_line_count"
  | "invalid_line_format"
  | "invalid_length"
  | "duplicate";

export type ContinuationDirectionParseResult =
  | Readonly<{
      readonly ok: true;
      readonly options: readonly ContinuationDirectionOption[];
    }>
  | Readonly<{
      readonly ok: false;
      readonly reason: ContinuationDirectionParseFailureReason;
      readonly message: string;
    }>;

export function parseContinuationDirectionOptions(raw: string): ContinuationDirectionParseResult {
  if (raw.trim().length === 0) {
    return parseFailure("empty", "没有收到可用的创作方向，请重新生成。");
  }
  if (Array.from(raw).length > MAXIMUM_RAW_RESPONSE_CHARACTERS) {
    return parseFailure("response_too_long", "返回内容过长，无法作为三个简明创作方向使用。");
  }
  if (DISALLOWED_CONTROL_OR_FORMAT_CHARACTERS.test(raw)) {
    return parseFailure("unsafe_character", "返回内容包含不可见字符，已停止展示这些方向。");
  }

  const lines = raw.trim().split(/\r?\n/u);
  if (lines.length !== DIRECTION_ORDINALS.length) {
    return parseFailure("wrong_line_count", "需要恰好三个创作方向，请重新生成。");
  }

  const options: ContinuationDirectionOption[] = [];
  const uniqueTexts = new Set<string>();
  for (const [index, rawLine] of lines.entries()) {
    const expectedOrdinal = DIRECTION_ORDINALS[index];
    if (expectedOrdinal === undefined) {
      return parseFailure("wrong_line_count", "需要恰好三个创作方向，请重新生成。");
    }
    const normalizedLine = rawLine.normalize("NFKC");
    const match = /^方向([一二三]):\s*(.+)$/u.exec(normalizedLine);
    if (match?.[1] !== expectedOrdinal || match[2] === undefined) {
      return parseFailure(
        "invalid_line_format",
        `第 ${String(index + 1)} 个方向格式不完整，请重新生成。`,
      );
    }
    const text = match[2].trim().replace(/[ \u00a0]+/gu, " ");
    const length = Array.from(text).length;
    if (length < MINIMUM_DIRECTION_CHARACTERS || length > MAXIMUM_DIRECTION_CHARACTERS) {
      return parseFailure("invalid_length", `方向${expectedOrdinal}需要保持在 4 到 160 个字符内。`);
    }
    const uniquenessKey = text.normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (uniqueTexts.has(uniquenessKey)) {
      return parseFailure("duplicate", "三个创作方向不能重复，请重新生成。");
    }
    uniqueTexts.add(uniquenessKey);
    const ordinal = (index + 1) as 1 | 2 | 3;
    const label: ContinuationDirectionOption["label"] = `方向${expectedOrdinal}`;
    options.push(
      Object.freeze({
        id: `continuation-direction-${String(ordinal)}` as ContinuationDirectionOptionId,
        ordinal,
        label,
        text,
        displayText: compactDirectionText(text),
        accessibleLabel: `${label}：${text}`,
      }),
    );
  }

  return Object.freeze({ ok: true, options: Object.freeze(options) });
}

function compactDirectionText(text: string): string {
  const characters = Array.from(text);
  return characters.length <= 72 ? text : `${characters.slice(0, 71).join("")}…`;
}

function parseFailure(
  reason: ContinuationDirectionParseFailureReason,
  message: string,
): ContinuationDirectionParseResult {
  return Object.freeze({ ok: false, reason, message });
}
