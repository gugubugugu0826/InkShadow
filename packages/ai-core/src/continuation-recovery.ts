export interface RecoveredVisiblePartial {
  /** Complete provider-visible text retained in the isolated Candidate. */
  readonly text: string;
  /** Boundary-safe preview; may omit an unfinished trailing fragment. */
  readonly displayText: string;
  readonly preserved: boolean;
  readonly boundary: "complete_sentence" | "complete_paragraph" | "all_visible" | "none";
  readonly droppedTrailingCharacters: number;
}

/** Preserve provider-visible prose after an interrupted response. */
export function recoverVisiblePartialOutput(
  visibleText: string,
  minimumUsefulCharacters = 1,
): RecoveredVisiblePartial {
  if (!Number.isSafeInteger(minimumUsefulCharacters) || minimumUsefulCharacters < 1) {
    throw new RangeError("minimumUsefulCharacters must be a positive safe integer.");
  }
  const normalized = visibleText.trim();
  if (normalized.length === 0) {
    return Object.freeze({
      text: "",
      displayText: "",
      preserved: false,
      boundary: "none",
      droppedTrailingCharacters: 0,
    });
  }
  const sentenceEnd = lastSentenceBoundary(normalized);
  const paragraphEnd = normalized.lastIndexOf("\n\n");
  const preferredEnd = Math.max(sentenceEnd, paragraphEnd < 0 ? -1 : paragraphEnd);
  if (preferredEnd + 1 >= minimumUsefulCharacters) {
    const displayText = normalized.slice(0, preferredEnd + 1).trimEnd();
    return Object.freeze({
      text: normalized,
      displayText,
      preserved: true,
      boundary: sentenceEnd >= paragraphEnd ? "complete_sentence" : "complete_paragraph",
      droppedTrailingCharacters: normalized.length - displayText.length,
    });
  }
  return Object.freeze({
    text: normalized,
    displayText: normalized,
    preserved: true,
    boundary: "all_visible",
    droppedTrailingCharacters: 0,
  });
}

/** Append a resumed response without repeating the prior partial ending. */
export function combineContinuationFragments(previous: string, resumed: string): string {
  const left = previous.trim();
  const right = resumed.trim();
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const prefix = buildPrefixTable(right);
  let overlap = longestSuffixPrefix(left, right, prefix);
  const detectedOverlap = overlap;
  while (overlap >= 4) {
    const length = overlap;
    const candidate = left.slice(-length);
    const preceding = left.at(-(length + 1));
    const startsAtBoundary = preceding === undefined || /[\n。！？!?…]/u.test(preceding);
    const safeShortBoundary = length >= 16 || (startsAtBoundary && /[。！？!?…]$/u.test(candidate));
    if (safeShortBoundary && candidate === right.slice(0, length)) {
      break;
    }
    overlap = prefix[length - 1] ?? 0;
  }
  if (overlap < 4) overlap = 0;
  const suffix = right.slice(overlap).trimStart();
  if (suffix.length === 0) return left;
  const separator =
    overlap === 0 && detectedOverlap >= 4 ? "\n\n" : endsAtCompleteBoundary(left) ? "\n\n" : "";
  return `${left}${separator}${suffix}`;
}

function endsAtCompleteBoundary(value: string): boolean {
  return /(?:[\n.!?\u3002\uff01\uff1f\u2026][\u201d\u2019\u300d\u300f\uff09\u300b]*)$/u.test(value);
}

function buildPrefixTable(pattern: string): number[] {
  const prefix = new Array<number>(pattern.length).fill(0);
  for (let index = 1; index < pattern.length; index += 1) {
    let matched = prefix[index - 1] ?? 0;
    while (matched > 0 && pattern[index] !== pattern[matched]) {
      matched = prefix[matched - 1] ?? 0;
    }
    if (pattern[index] === pattern[matched]) matched += 1;
    prefix[index] = matched;
  }
  return prefix;
}

function longestSuffixPrefix(left: string, right: string, prefix: readonly number[]): number {
  let matched = 0;
  for (let index = 0; index < left.length; index += 1) {
    while (matched > 0 && left[index] !== right[matched]) {
      matched = prefix[matched - 1] ?? 0;
    }
    if (left[index] === right[matched]) matched += 1;
    if (matched === right.length && index < left.length - 1) {
      matched = prefix[matched - 1] ?? 0;
    }
  }
  return matched;
}

function lastSentenceBoundary(value: string): number {
  let result = -1;
  for (const match of value.matchAll(/[。！？!?…](?:[”’」』）】])?/gu)) {
    result = match.index + match[0].length - 1;
  }
  return result;
}
