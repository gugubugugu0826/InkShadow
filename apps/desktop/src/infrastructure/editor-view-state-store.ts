import {
  EDITOR_CONTENT_LIMIT,
  normalizeEditorSelection,
  type EditorSelection,
} from "./editor-text-operations";

export const EDITOR_VIEW_STATE_STORAGE_KEY = "inkshadow.editor.view-state.v1";
export const EDITOR_VIEW_STATE_ENTRY_LIMIT = 100;
export const EDITOR_VIEW_STATE_SERIALIZED_LIMIT = 262_144;

const MAX_SCROLL_TOP = 50_000_000;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type EditorFontFamily = "serif" | "sans" | "mono";
export type EditorMeasure = "narrow" | "comfortable" | "wide";

export interface EditorTypography {
  readonly fontFamily: EditorFontFamily;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly measure: EditorMeasure;
}

export interface EditorViewState {
  readonly projectId: string;
  readonly chapterId: string;
  readonly selection: EditorSelection;
  readonly scrollTop: number;
  readonly updatedAt: number;
}

export interface LoadedEditorView {
  readonly view: EditorViewState | null;
  readonly typography: EditorTypography;
}

interface EditorViewStateDatabase {
  readonly schemaVersion: 1;
  readonly typography: EditorTypography;
  readonly entries: readonly EditorViewState[];
}

export const DEFAULT_EDITOR_TYPOGRAPHY: EditorTypography = Object.freeze({
  fontFamily: "serif",
  fontSize: 17,
  lineHeight: 1.95,
  measure: "comfortable",
});

export function loadEditorView(
  storage: Storage,
  projectId: string,
  chapterId: string,
  contentLength: number,
): LoadedEditorView {
  const database = readAndCleanDatabase(storage);
  const entry =
    database.entries.find(
      (candidate) => candidate.projectId === projectId && candidate.chapterId === chapterId,
    ) ?? null;
  if (entry === null) {
    return Object.freeze({ view: null, typography: database.typography });
  }
  const safeLength = Math.min(Math.max(0, Math.trunc(contentLength)), EDITOR_CONTENT_LIMIT);
  return Object.freeze({
    view: Object.freeze({
      ...entry,
      selection: normalizeEditorSelection(entry.selection, safeLength),
    }),
    typography: database.typography,
  });
}

export function saveEditorView(
  storage: Storage,
  input: {
    readonly projectId: string;
    readonly chapterId: string;
    readonly selection: EditorSelection;
    readonly scrollTop: number;
    readonly typography: EditorTypography;
    readonly updatedAt?: number;
  },
): void {
  if (!isUuidV7(input.projectId) || !isUuidV7(input.chapterId)) {
    return;
  }
  const database = readAndCleanDatabase(storage);
  const entry: EditorViewState = Object.freeze({
    projectId: input.projectId,
    chapterId: input.chapterId,
    selection: normalizeEditorSelection(input.selection, EDITOR_CONTENT_LIMIT),
    scrollTop: clampInteger(input.scrollTop, 0, MAX_SCROLL_TOP),
    updatedAt: clampInteger(input.updatedAt ?? Date.now(), 0, Number.MAX_SAFE_INTEGER),
  });
  const entries = [
    entry,
    ...database.entries.filter(
      (candidate) =>
        candidate.projectId !== input.projectId || candidate.chapterId !== input.chapterId,
    ),
  ]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, EDITOR_VIEW_STATE_ENTRY_LIMIT);
  writeDatabase(storage, {
    schemaVersion: 1,
    typography: normalizeTypography(input.typography),
    entries,
  });
}

export function saveEditorTypography(storage: Storage, typography: EditorTypography): void {
  const database = readAndCleanDatabase(storage);
  writeDatabase(storage, {
    ...database,
    typography: normalizeTypography(typography),
  });
}

function readAndCleanDatabase(storage: Storage): EditorViewStateDatabase {
  let serialized: string | null;
  try {
    serialized = storage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY);
  } catch {
    return emptyDatabase();
  }
  if (serialized === null) {
    return emptyDatabase();
  }
  if (serialized.length > EDITOR_VIEW_STATE_SERIALIZED_LIMIT) {
    removeCorruptDatabase(storage);
    return emptyDatabase();
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    const cleaned = cleanDatabase(parsed);
    writeDatabase(storage, cleaned);
    return cleaned;
  } catch {
    removeCorruptDatabase(storage);
    return emptyDatabase();
  }
}

function cleanDatabase(value: unknown): EditorViewStateDatabase {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported editor view-state schema.");
  }
  const typography = normalizeTypography(value.typography);
  const sourceEntries = Array.isArray(value.entries) ? value.entries : [];
  const entries: EditorViewState[] = [];
  const seen = new Set<string>();
  for (const candidate of sourceEntries) {
    const entry = cleanEntry(candidate);
    if (entry === null) {
      continue;
    }
    const key = `${entry.projectId}:${entry.chapterId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }
  entries.sort((left, right) => right.updatedAt - left.updatedAt);
  return Object.freeze({
    schemaVersion: 1,
    typography,
    entries: Object.freeze(entries.slice(0, EDITOR_VIEW_STATE_ENTRY_LIMIT)),
  });
}

function cleanEntry(value: unknown): EditorViewState | null {
  if (
    !isRecord(value) ||
    !isUuidV7(value.projectId) ||
    !isUuidV7(value.chapterId) ||
    !isRecord(value.selection) ||
    typeof value.selection.start !== "number" ||
    typeof value.selection.end !== "number" ||
    typeof value.scrollTop !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    return null;
  }
  return Object.freeze({
    projectId: value.projectId,
    chapterId: value.chapterId,
    selection: normalizeEditorSelection(
      { start: value.selection.start, end: value.selection.end },
      EDITOR_CONTENT_LIMIT,
    ),
    scrollTop: clampInteger(value.scrollTop, 0, MAX_SCROLL_TOP),
    updatedAt: clampInteger(value.updatedAt, 0, Number.MAX_SAFE_INTEGER),
  });
}

function normalizeTypography(value: unknown): EditorTypography {
  if (!isRecord(value)) {
    return DEFAULT_EDITOR_TYPOGRAPHY;
  }
  const fontFamily = isFontFamily(value.fontFamily)
    ? value.fontFamily
    : DEFAULT_EDITOR_TYPOGRAPHY.fontFamily;
  const measure = isMeasure(value.measure) ? value.measure : DEFAULT_EDITOR_TYPOGRAPHY.measure;
  const fontSize =
    typeof value.fontSize === "number"
      ? clampInteger(value.fontSize, 14, 24)
      : DEFAULT_EDITOR_TYPOGRAPHY.fontSize;
  const lineHeight =
    typeof value.lineHeight === "number" && Number.isFinite(value.lineHeight)
      ? Math.min(2.4, Math.max(1.4, Math.round(value.lineHeight * 100) / 100))
      : DEFAULT_EDITOR_TYPOGRAPHY.lineHeight;
  return Object.freeze({ fontFamily, fontSize, lineHeight, measure });
}

function writeDatabase(storage: Storage, database: EditorViewStateDatabase): void {
  try {
    const serialized = JSON.stringify(database);
    if (serialized.length <= EDITOR_VIEW_STATE_SERIALIZED_LIMIT) {
      storage.setItem(EDITOR_VIEW_STATE_STORAGE_KEY, serialized);
    }
  } catch {
    // View state is optional and must never block chapter editing.
  }
}

function removeCorruptDatabase(storage: Storage): void {
  try {
    storage.removeItem(EDITOR_VIEW_STATE_STORAGE_KEY);
  } catch {
    // View state is optional and must never block chapter editing.
  }
}

function emptyDatabase(): EditorViewStateDatabase {
  return Object.freeze({
    schemaVersion: 1,
    typography: DEFAULT_EDITOR_TYPOGRAPHY,
    entries: Object.freeze([]),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_PATTERN.test(value);
}

function isFontFamily(value: unknown): value is EditorFontFamily {
  return value === "serif" || value === "sans" || value === "mono";
}

function isMeasure(value: unknown): value is EditorMeasure {
  return value === "narrow" || value === "comfortable" || value === "wide";
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
