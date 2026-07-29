export const EDITOR_CONTENT_LIMIT = 5_000_000;
export const EDITOR_HISTORY_OPERATION_LIMIT = 200;
export const EDITOR_HISTORY_PAYLOAD_LIMIT = 12_000_000;
export const EDITOR_FIND_QUERY_LIMIT = 10_000;
export const EDITOR_REPLACEMENT_LIMIT = 100_000;
export const EDITOR_REPLACE_ALL_LIMIT = 10_000;

export interface EditorSelection {
  readonly start: number;
  readonly end: number;
}

export interface EditorEdit {
  readonly start: number;
  readonly removedText: string;
  readonly insertedText: string;
  readonly selectionBefore: EditorSelection;
  readonly selectionAfter: EditorSelection;
}

export interface EditorHistory {
  readonly past: readonly EditorEdit[];
  readonly future: readonly EditorEdit[];
  readonly payloadUnits: number;
}

export interface EditorHistoryApplication {
  readonly content: string;
  readonly selection: EditorSelection;
  readonly history: EditorHistory;
}

export interface LiteralMatch {
  readonly start: number;
  readonly end: number;
  readonly wrapped: boolean;
}

export type ReplaceAllLiteralResult =
  | {
      readonly ok: true;
      readonly content: string;
      readonly replacements: number;
      readonly selection: EditorSelection;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "EMPTY_QUERY"
        | "QUERY_TOO_LARGE"
        | "REPLACEMENT_TOO_LARGE"
        | "TOO_MANY_MATCHES"
        | "CONTENT_TOO_LARGE";
    };

export function normalizeEditorSelection(
  selection: EditorSelection,
  contentLength: number,
): EditorSelection {
  const safeLength = clampInteger(contentLength, 0, EDITOR_CONTENT_LIMIT);
  const start = clampInteger(selection.start, 0, safeLength);
  const end = clampInteger(selection.end, start, safeLength);
  return Object.freeze({ start, end });
}

export function createEmptyEditorHistory(): EditorHistory {
  return Object.freeze({
    past: Object.freeze([]),
    future: Object.freeze([]),
    payloadUnits: 0,
  });
}

/**
 * Derives a compact edit from a trusted textarea selection transition.
 *
 * Native textarea edits replace one contiguous range. Using the selections lets
 * the hot typing path avoid scanning the unchanged remainder of a long chapter.
 * Call `createEditorEditFromTransition` for non-native or untrusted transitions.
 */
export function createEditorEditFromSelectionTransition(
  before: string,
  after: string,
  selectionBefore: EditorSelection,
  selectionAfter: EditorSelection,
): EditorEdit | null {
  const normalizedBefore = normalizeEditorSelection(selectionBefore, before.length);
  const normalizedAfter = normalizeEditorSelection(selectionAfter, after.length);
  const start = Math.min(normalizedBefore.start, normalizedAfter.start);
  const unchangedTailLength = after.length - normalizedAfter.end;
  const beforeEnd = before.length - unchangedTailLength;

  if (beforeEnd < start || beforeEnd > before.length) {
    return createEditorEditFromTransition(before, after, normalizedBefore, normalizedAfter);
  }

  const edit = Object.freeze({
    start,
    removedText: before.slice(start, beforeEnd),
    insertedText: after.slice(start, normalizedAfter.end),
    selectionBefore: normalizedBefore,
    selectionAfter: normalizedAfter,
  });
  return edit.removedText === edit.insertedText ? null : edit;
}

export function createEditorEditFromTransition(
  before: string,
  after: string,
  selectionBefore: EditorSelection,
  selectionAfter: EditorSelection,
): EditorEdit | null {
  if (before === after) {
    return null;
  }
  let start = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (start < prefixLimit && before.charCodeAt(start) === after.charCodeAt(start)) {
    start += 1;
  }

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return Object.freeze({
    start,
    removedText: before.slice(start, beforeEnd),
    insertedText: after.slice(start, afterEnd),
    selectionBefore: normalizeEditorSelection(selectionBefore, before.length),
    selectionAfter: normalizeEditorSelection(selectionAfter, after.length),
  });
}

export function createEditorRangeEdit(
  content: string,
  selection: EditorSelection,
  replacement: string,
): { readonly content: string; readonly edit: EditorEdit } | null {
  const normalized = normalizeEditorSelection(selection, content.length);
  const projectedLength = content.length - (normalized.end - normalized.start) + replacement.length;
  if (projectedLength > EDITOR_CONTENT_LIMIT) {
    return null;
  }
  const nextContent =
    content.slice(0, normalized.start) + replacement + content.slice(normalized.end);
  const nextCursor = normalized.start + replacement.length;
  return Object.freeze({
    content: nextContent,
    edit: Object.freeze({
      start: normalized.start,
      removedText: content.slice(normalized.start, normalized.end),
      insertedText: replacement,
      selectionBefore: normalized,
      selectionAfter: Object.freeze({ start: nextCursor, end: nextCursor }),
    }),
  });
}

export function recordEditorEdit(history: EditorHistory, edit: EditorEdit): EditorHistory {
  const editPayload = editorEditPayload(edit);
  if (editPayload > EDITOR_HISTORY_PAYLOAD_LIMIT) {
    return createEmptyEditorHistory();
  }

  const retainedPast = [...history.past, edit];
  let retainedPayload =
    history.past.reduce((total, item) => total + editorEditPayload(item), 0) + editPayload;

  while (
    retainedPast.length > EDITOR_HISTORY_OPERATION_LIMIT ||
    retainedPayload > EDITOR_HISTORY_PAYLOAD_LIMIT
  ) {
    const removed = retainedPast.shift();
    if (removed !== undefined) {
      retainedPayload -= editorEditPayload(removed);
    }
  }

  return Object.freeze({
    past: Object.freeze(retainedPast),
    future: Object.freeze([]),
    payloadUnits: retainedPayload,
  });
}

export function undoEditorEdit(
  history: EditorHistory,
  currentContent: string,
): EditorHistoryApplication | null {
  const edit = history.past.at(-1);
  if (edit === undefined) {
    return null;
  }
  if (
    currentContent.slice(edit.start, edit.start + edit.insertedText.length) !== edit.insertedText
  ) {
    return null;
  }

  const content =
    currentContent.slice(0, edit.start) +
    edit.removedText +
    currentContent.slice(edit.start + edit.insertedText.length);
  return Object.freeze({
    content,
    selection: normalizeEditorSelection(edit.selectionBefore, content.length),
    history: Object.freeze({
      past: Object.freeze(history.past.slice(0, -1)),
      future: Object.freeze([...history.future, edit]),
      payloadUnits: history.payloadUnits,
    }),
  });
}

export function redoEditorEdit(
  history: EditorHistory,
  currentContent: string,
): EditorHistoryApplication | null {
  const edit = history.future.at(-1);
  if (edit === undefined) {
    return null;
  }
  if (currentContent.slice(edit.start, edit.start + edit.removedText.length) !== edit.removedText) {
    return null;
  }

  const content =
    currentContent.slice(0, edit.start) +
    edit.insertedText +
    currentContent.slice(edit.start + edit.removedText.length);
  return Object.freeze({
    content,
    selection: normalizeEditorSelection(edit.selectionAfter, content.length),
    history: Object.freeze({
      past: Object.freeze([...history.past, edit]),
      future: Object.freeze(history.future.slice(0, -1)),
      payloadUnits: history.payloadUnits,
    }),
  });
}

export function findLiteral(
  content: string,
  query: string,
  fromOffset: number,
  direction: "next" | "previous",
): LiteralMatch | null {
  if (
    query.length === 0 ||
    query.length > EDITOR_FIND_QUERY_LIMIT ||
    query.length > content.length
  ) {
    return null;
  }
  const offset = clampInteger(fromOffset, 0, content.length);

  if (direction === "next") {
    const direct = content.indexOf(query, offset);
    if (direct >= 0) {
      return Object.freeze({ start: direct, end: direct + query.length, wrapped: false });
    }
    const wrapped = content.indexOf(query);
    return wrapped < 0
      ? null
      : Object.freeze({ start: wrapped, end: wrapped + query.length, wrapped: true });
  }

  const previousStart = Math.min(content.length - query.length, offset - 1);
  const direct = previousStart < 0 ? -1 : content.lastIndexOf(query, previousStart);
  if (direct >= 0) {
    return Object.freeze({ start: direct, end: direct + query.length, wrapped: false });
  }
  const wrapped = content.lastIndexOf(query);
  return wrapped < 0
    ? null
    : Object.freeze({ start: wrapped, end: wrapped + query.length, wrapped: true });
}

export function replaceAllLiteral(
  content: string,
  query: string,
  replacement: string,
): ReplaceAllLiteralResult {
  if (query.length === 0) {
    return Object.freeze({ ok: false, reason: "EMPTY_QUERY" });
  }
  if (query.length > EDITOR_FIND_QUERY_LIMIT) {
    return Object.freeze({ ok: false, reason: "QUERY_TOO_LARGE" });
  }
  if (replacement.length > EDITOR_REPLACEMENT_LIMIT) {
    return Object.freeze({ ok: false, reason: "REPLACEMENT_TOO_LARGE" });
  }

  const matchOffsets: number[] = [];
  let offset = 0;
  while (offset <= content.length - query.length) {
    const match = content.indexOf(query, offset);
    if (match < 0) {
      break;
    }
    matchOffsets.push(match);
    if (matchOffsets.length > EDITOR_REPLACE_ALL_LIMIT) {
      return Object.freeze({ ok: false, reason: "TOO_MANY_MATCHES" });
    }
    offset = match + query.length;
  }

  if (matchOffsets.length === 0) {
    return Object.freeze({
      ok: true,
      content,
      replacements: 0,
      selection: Object.freeze({ start: 0, end: 0 }),
    });
  }

  const projectedLength =
    content.length + matchOffsets.length * (replacement.length - query.length);
  if (projectedLength > EDITOR_CONTENT_LIMIT) {
    return Object.freeze({ ok: false, reason: "CONTENT_TOO_LARGE" });
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const match of matchOffsets) {
    parts.push(content.slice(cursor, match), replacement);
    cursor = match + query.length;
  }
  parts.push(content.slice(cursor));
  const lastMatch = matchOffsets.at(-1) ?? 0;
  const selectionStart =
    lastMatch + (matchOffsets.length - 1) * (replacement.length - query.length);
  return Object.freeze({
    ok: true,
    content: parts.join(""),
    replacements: matchOffsets.length,
    selection: Object.freeze({
      start: selectionStart,
      end: selectionStart + replacement.length,
    }),
  });
}

export function sanitizePlainTextPaste(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, "");
}

function editorEditPayload(edit: EditorEdit): number {
  return edit.removedText.length + edit.insertedText.length;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
