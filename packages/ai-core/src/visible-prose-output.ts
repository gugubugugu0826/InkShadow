const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const CODE_FENCE_PATTERN = /(?:^|\n)[ \t]*(?:```|~~~)/u;
const INTERNAL_TAG_PATTERN =
  /<\s*\/?\s*(?:analysis|assistant|context|final|reasoning|selected_source|system|think|thinking|tool|tool_call|user)\b[^>]*>/iu;
const INTERNAL_BRACKET_PATTERN =
  /(?:^|\n)[ \t]*[\[【](?:analysis|reasoning|thinking|分析|思考|推理|系统|工具调用)[\]】][ \t]*/iu;
const LEADING_META_PATTERN =
  /^(?:(?:下面|以下)(?:是|为).{0,24}(?:续写|改写|润色|扩写|缩写|正文|内容|版本)|(?:续写|改写|润色|扩写|缩写)(?:内容|结果|版本)?|(?:创作|写作)?(?:分析|思路|说明)|作为(?:一个)?(?:AI|人工智能|语言模型))[：:\s]/iu;
const LEADING_STANDALONE_META_NARRATION_PATTERN =
  /^(?:我决定让(?:主角|主人公).{0,120}|我的(?:创作|写作)(?:思路|安排|计划|意图)(?:是|为|[：:]).{0,120})(?:[。！？!?]|…{1,2})$/u;
const META_SECTION_PATTERN =
  /(?:^|\n)[ \t]*(?:(?:创作|写作)(?:分析|思路|说明)|(?:续写|改写|润色|扩写|缩写)(?:说明|分析)|分析|说明|备注|analysis|explanation|note)[：:][ \t]*/iu;
const DEFAULT_MAXIMUM_VISIBLE_CHARACTERS = 500_000;

export type VisibleProseOutputErrorCode =
  | "MODEL_VISIBLE_PROSE_OUTPUT_EMPTY"
  | "MODEL_VISIBLE_PROSE_OUTPUT_TOO_LONG"
  | "MODEL_VISIBLE_PROSE_OUTPUT_INVALID_CONTROL"
  | "MODEL_VISIBLE_PROSE_OUTPUT_CODE_FENCE"
  | "MODEL_VISIBLE_PROSE_OUTPUT_INTERNAL_TAG"
  | "MODEL_VISIBLE_PROSE_OUTPUT_STRUCTURED"
  | "MODEL_VISIBLE_PROSE_OUTPUT_META";

export interface VisibleProseOutputInspection {
  /** The exact provider-visible text. This function never repairs or rewrites it. */
  readonly text: string;
  readonly visibleCharacters: number;
}

export interface VisibleProseOutputOptions {
  readonly maximumVisibleCharacters?: number;
}

/**
 * Validates the complete visible response at the Candidate isolation boundary.
 * Rejected text remains the caller's raw provider result; this helper never
 * trims technical wrappers into something that could be mistaken for正文.
 */
export function assertVisibleProseOutput(
  text: string,
  options: VisibleProseOutputOptions = {},
): VisibleProseOutputInspection {
  const maximumVisibleCharacters =
    options.maximumVisibleCharacters ?? DEFAULT_MAXIMUM_VISIBLE_CHARACTERS;
  if (
    !Number.isSafeInteger(maximumVisibleCharacters) ||
    maximumVisibleCharacters < 1 ||
    maximumVisibleCharacters > DEFAULT_MAXIMUM_VISIBLE_CHARACTERS
  ) {
    throw new RangeError("maximumVisibleCharacters must be a bounded positive integer.");
  }
  const trimmed = text.trim();
  const visibleCharacters = Array.from(text).length;
  if (trimmed.length === 0) {
    fail(
      "MODEL_VISIBLE_PROSE_OUTPUT_EMPTY",
      "模型没有返回可供审阅的正文；本次结果不会写入正文。",
      visibleCharacters,
    );
  }
  if (visibleCharacters > maximumVisibleCharacters) {
    fail(
      "MODEL_VISIBLE_PROSE_OUTPUT_TOO_LONG",
      "模型返回内容超过本次任务的安全上限；原始结果不会被裁剪后冒充完整正文。",
      visibleCharacters,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(text)) {
    fail(
      "MODEL_VISIBLE_PROSE_OUTPUT_INVALID_CONTROL",
      "模型返回内容包含无法安全显示的控制字符；本次结果不会写入正文。",
      visibleCharacters,
    );
  }
  if (CODE_FENCE_PATTERN.test(text)) {
    fail(
      "MODEL_VISIBLE_PROSE_OUTPUT_CODE_FENCE",
      "模型返回了代码块，不符合正文输出要求；本次结果不会写入正文。",
      visibleCharacters,
    );
  }
  if (INTERNAL_TAG_PATTERN.test(text) || INTERNAL_BRACKET_PATTERN.test(text)) {
    fail(
      "MODEL_VISIBLE_PROSE_OUTPUT_INTERNAL_TAG",
      "模型返回内容混入了内部标签或推理标记；本次结果不会写入正文。",
      visibleCharacters,
    );
  }
  if (isStructuredPayload(trimmed)) {
    fail(
      "MODEL_VISIBLE_PROSE_OUTPUT_STRUCTURED",
      "模型返回了结构化数据而不是小说正文；本次结果不会写入正文。",
      visibleCharacters,
    );
  }
  const firstLine = trimmed.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (
    LEADING_META_PATTERN.test(firstLine) ||
    LEADING_STANDALONE_META_NARRATION_PATTERN.test(firstLine) ||
    META_SECTION_PATTERN.test(text)
  ) {
    fail(
      "MODEL_VISIBLE_PROSE_OUTPUT_META",
      "模型返回了创作说明或元叙述，不符合正文输出要求；本次结果不会写入正文。",
      visibleCharacters,
    );
  }
  return Object.freeze({ text, visibleCharacters });
}

export class VisibleProseOutputError extends Error {
  public constructor(
    readonly code: VisibleProseOutputErrorCode,
    message: string,
    readonly visibleCharacters: number,
  ) {
    super(message);
    this.name = "VisibleProseOutputError";
  }
}

function isStructuredPayload(value: string): boolean {
  if (!(value.startsWith("{") || value.startsWith("["))) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function fail(
  code: VisibleProseOutputErrorCode,
  message: string,
  visibleCharacters: number,
): never {
  throw new VisibleProseOutputError(code, message, visibleCharacters);
}
