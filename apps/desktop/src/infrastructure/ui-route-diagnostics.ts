export type UiRouteIncidentPhase = "lazy_load" | "render";
export type UiRouteBoundaryName = "SettingsRouteBoundary" | "AppErrorBoundary";

export interface SafeUiRouteTriggerIds {
  readonly projectId: string | null;
  readonly chapterId: string | null;
  readonly candidateId: string | null;
}

export interface SafeUiRouteIncident {
  readonly diagnosticId: string;
  readonly routeTransitionId: string;
  readonly timestamp: string;
  readonly fromRoute: null;
  readonly toRoute: string;
  readonly route: string;
  readonly triggerIds: SafeUiRouteTriggerIds;
  readonly phase: UiRouteIncidentPhase;
  readonly errorBoundaryTriggered: true;
  readonly componentName: UiRouteBoundaryName;
  readonly webviewReloadDetected: "unknown";
  readonly normalizedErrorCode: string;
  readonly errorType: string;
  readonly applicationStack: readonly string[];
  readonly reactComponentStack: readonly string[];
  readonly fingerprint: string;
  readonly recovered: boolean;
  readonly recoveredAt: string | null;
  readonly recoveryAction: "retry" | "navigate_start" | null;
}

interface MutableUiRouteDiagnosticState {
  nextSequence: number;
  incidents: SafeUiRouteIncident[];
}

interface PersistedUiRouteDiagnosticState {
  readonly schemaVersion: 2;
  readonly nextSequence: number;
  readonly incidents: readonly SafeUiRouteIncident[];
}

const MAX_UI_ROUTE_INCIDENTS = 20;
const MAX_STACK_FRAMES = 20;
const STORAGE_KEY = "inkshadow.safe-ui-route-incidents.v2";
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/u;
const SAFE_ERROR_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]{0,63}$/u;
const SAFE_ERROR_TYPES = new Set([
  "AggregateError",
  "AppError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "UiActionError",
]);
const SAFE_UI_ERROR_CODES = new Set([
  "LEGACY_CANDIDATE_METADATA_INVALID",
  "LEGACY_VERSION_METADATA_INVALID",
  "TASK_METADATA_INVALID",
  "UI_CHUNK_LOAD_FAILED",
  "UI_LAZY_LOAD_FAILED",
  "UI_RENDER_FAILED",
]);
const SAFE_SETTINGS_ROUTE_PATTERN = /^\/(?:settings(?:\/sync)?)?$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STATIC_ROUTES = new Set([
  "/auth/login",
  "/create/idea",
  "/create/import",
  "/create/professional",
  "/ideation",
  "/marketplace",
  "/projects",
  "/settings",
  "/settings/sync",
  "/start",
  "/tasks",
  "/teams",
  "/usage",
]);
const PROJECT_ROUTE_SUFFIXES = new Set([
  "",
  "/checks",
  "/context",
  "/extraction",
  "/fine-tuning",
  "/graph",
  "/materials",
  "/multi-agent-review",
  "/outline",
  "/search",
  "/story",
  "/sync",
  "/sync/conflicts",
]);
const CHAPTER_ROUTE_SUFFIXES = new Set(["", "/extensions", "/multi-agent-review"]);
const states = new WeakMap<object, MutableUiRouteDiagnosticState>();

export function safeSettingsRoute(pathname: string, hash: string): string {
  const safePathname = SAFE_SETTINGS_ROUTE_PATTERN.test(pathname) ? pathname : "/settings";
  if (safePathname !== "/settings") return safePathname;
  const safeHash = /^#(?:model-center|model-routing|model-evaluation|image-generation)$/u.test(hash)
    ? hash
    : "";
  return `${safePathname}${safeHash}`;
}

export function recordUiRouteIncident(
  owner: object,
  input: Readonly<{
    route: string;
    phase: UiRouteIncidentPhase;
    cause: unknown;
    timestamp: string;
    componentName?: UiRouteBoundaryName;
    componentStack?: string | null;
  }>,
): SafeUiRouteIncident {
  const state = ensureState(owner);
  state.nextSequence += 1;
  const timestamp = safeTimestamp(input.timestamp);
  const route = safeUiRoute(input.route);
  const normalizedErrorCode = safeErrorCode(input.cause);
  const errorType = safeErrorType(input.cause);
  const applicationStack = safeApplicationStack(input.cause, normalizedErrorCode, errorType);
  const reactComponentStack = safeReactComponentStack(input.componentStack ?? null);
  const incident = Object.freeze({
    diagnosticId: `UI-${timestamp.replace(/[^0-9]/gu, "").slice(-14)}-${String(
      state.nextSequence,
    ).padStart(3, "0")}`,
    routeTransitionId: `UI-ROUTE-${String(state.nextSequence).padStart(6, "0")}`,
    timestamp,
    fromRoute: null,
    toRoute: route.route,
    route: route.route,
    triggerIds: route.triggerIds,
    phase: input.phase,
    errorBoundaryTriggered: true,
    componentName: input.componentName ?? "SettingsRouteBoundary",
    webviewReloadDetected: "unknown",
    normalizedErrorCode,
    errorType,
    applicationStack,
    reactComponentStack,
    fingerprint: fingerprint([
      normalizedErrorCode,
      errorType,
      route.route,
      applicationStack.join("\n"),
      reactComponentStack.join("\n"),
    ]),
    recovered: false,
    recoveredAt: null,
    recoveryAction: null,
  } satisfies SafeUiRouteIncident);
  state.incidents = [incident, ...state.incidents].slice(0, MAX_UI_ROUTE_INCIDENTS);
  persistState(state);
  return incident;
}

export function recoverUiRouteIncident(
  owner: object,
  diagnosticId: string,
  timestamp: string,
  recoveryAction: "retry" | "navigate_start" = "retry",
): void {
  const state = ensureState(owner);
  state.incidents = state.incidents.map((incident) =>
    incident.diagnosticId === diagnosticId
      ? Object.freeze({
          ...incident,
          recovered: true,
          recoveredAt: safeTimestamp(timestamp),
          recoveryAction,
        })
      : incident,
  );
  persistState(state);
}

export function readSafeUiRouteIncidents(owner: object): readonly SafeUiRouteIncident[] {
  return Object.freeze([...ensureState(owner).incidents]);
}

export function resetUiRouteDiagnosticsForTests(owner: object): void {
  states.delete(owner);
  diagnosticStorage()?.removeItem(STORAGE_KEY);
}

export function forgetUiRouteDiagnosticsMemoryForTests(owner: object): void {
  states.delete(owner);
}

function safeUiRoute(rawRoute: string): Readonly<{
  route: string;
  triggerIds: SafeUiRouteTriggerIds;
}> {
  const routeWithQuery = routeFromLocation(rawRoute);
  const [pathname = "/unknown", rawQuery = ""] = routeWithQuery.split("?", 2);
  let projectId: string | null = null;
  let chapterId: string | null = null;
  let safePath = STATIC_ROUTES.has(pathname) ? pathname : "/unknown";

  const projectMatch = /^\/projects\/([^/]+)(.*)$/u.exec(pathname);
  if (projectMatch !== null) {
    const rawProjectId = safeDecode(projectMatch[1] ?? "");
    const suffix = projectMatch[2] ?? "";
    if (
      (isUuid(rawProjectId) || rawProjectId === ":projectId") &&
      PROJECT_ROUTE_SUFFIXES.has(suffix)
    ) {
      projectId = isUuid(rawProjectId) ? rawProjectId.toLowerCase() : null;
      safePath = `/projects/:projectId${suffix}`;
    }
  }

  const chapterMatch = /^\/projects\/([^/]+)\/chapters\/([^/]+)(.*)$/u.exec(pathname);
  if (chapterMatch !== null) {
    const rawProjectId = safeDecode(chapterMatch[1] ?? "");
    const rawChapterId = safeDecode(chapterMatch[2] ?? "");
    const suffix = chapterMatch[3] ?? "";
    const validProject = isUuid(rawProjectId) || rawProjectId === ":projectId";
    const validChapter = isUuid(rawChapterId) || rawChapterId === ":chapterId";
    if (validProject && validChapter && CHAPTER_ROUTE_SUFFIXES.has(suffix)) {
      projectId = isUuid(rawProjectId) ? rawProjectId.toLowerCase() : null;
      chapterId = isUuid(rawChapterId) ? rawChapterId.toLowerCase() : null;
      safePath = `/projects/:projectId/chapters/:chapterId${suffix}`;
    }
  }

  const teamUsageMatch = /^\/teams\/([^/]+)\/usage$/u.exec(pathname);
  if (teamUsageMatch !== null) {
    const teamId = safeDecode(teamUsageMatch[1] ?? "");
    if (isUuid(teamId) || teamId === ":id") safePath = "/teams/:id/usage";
  }
  const teamProjectMatch = /^\/teams\/([^/]+)\/projects\/([^/]+)\/(reviews|templates)$/u.exec(
    pathname,
  );
  if (teamProjectMatch !== null) {
    const teamId = safeDecode(teamProjectMatch[1] ?? "");
    const rawProjectId = safeDecode(teamProjectMatch[2] ?? "");
    const destination = teamProjectMatch[3];
    if (
      (isUuid(teamId) || teamId === ":id") &&
      (isUuid(rawProjectId) || rawProjectId === ":projectId") &&
      destination !== undefined
    ) {
      projectId = isUuid(rawProjectId) ? rawProjectId.toLowerCase() : null;
      safePath = `/teams/:id/projects/:projectId/${destination}`;
    }
  }

  const query = new URLSearchParams(rawQuery);
  const candidate = query.get("candidate");
  const parsedCandidateId =
    candidate !== null && isUuid(candidate) ? candidate.toLowerCase() : null;
  const candidateId = safePath.includes("/chapters/:chapterId") ? parsedCandidateId : null;
  const hasPersistedCandidatePlaceholder =
    safePath.includes("/chapters/:chapterId") && candidate === ":candidateId";
  const settingsHash = hashFrom(rawRoute);
  const route =
    safePath === "/settings" || safePath === "/settings/sync"
      ? safeSettingsRoute(safePath, settingsHash)
      : `${safePath}${
          (candidateId === null && !hasPersistedCandidatePlaceholder) ||
          !safePath.includes("/chapters/:chapterId")
            ? ""
            : "?candidate=:candidateId"
        }`;
  return Object.freeze({
    route,
    triggerIds: Object.freeze({ projectId, chapterId, candidateId }),
  });
}
function routeFromLocation(rawRoute: string): string {
  const trimmed = rawRoute.trim();
  const hashRouteIndex = trimmed.indexOf("#/");
  const route =
    hashRouteIndex >= 0 ? trimmed.slice(hashRouteIndex + 1) : (trimmed.split("#", 1)[0] ?? "");
  if (!route.startsWith("/") || route.includes("://")) return "/unknown";
  return route.slice(0, 2048);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "unknown";
  }
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function safeErrorCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    SAFE_ERROR_CODE_PATTERN.test(cause.code) &&
    SAFE_UI_ERROR_CODES.has(cause.code)
  ) {
    return cause.code;
  }
  return "UI_RENDER_FAILED";
}

function safeErrorType(cause: unknown): string {
  if (cause instanceof Error) {
    const name = cause.name;
    if (SAFE_ERROR_TYPE_PATTERN.test(name) && SAFE_ERROR_TYPES.has(name)) return name;
    const constructorName = cause.constructor.name;
    if (SAFE_ERROR_TYPE_PATTERN.test(constructorName) && SAFE_ERROR_TYPES.has(constructorName)) {
      return constructorName;
    }
  }
  return "Error";
}

function safeApplicationStack(
  cause: unknown,
  normalizedErrorCode: string,
  errorType: string,
): readonly string[] {
  const identity = `${errorType}: ${normalizedErrorCode}`;
  if (!(cause instanceof Error) || typeof cause.stack !== "string") {
    return Object.freeze([identity]);
  }
  const frames = safeStackFrames(cause.stack, false);
  return Object.freeze([identity, ...frames].slice(0, MAX_STACK_FRAMES));
}

function safeReactComponentStack(componentStack: string | null): readonly string[] {
  if (componentStack === null) return Object.freeze([]);
  return Object.freeze(safeStackFrames(componentStack, true).slice(0, MAX_STACK_FRAMES));
}

function safeStackFrames(stack: string, allowComponentOnly: boolean): string[] {
  const result: string[] = [];
  for (const rawLine of stack.split(/\r?\n/gu).slice(1)) {
    const line = rawLine.trim().replaceAll("\\", "/");
    const functionName = /^at\s+([A-Za-z_$<>][A-Za-z0-9_$<>.]*)/u.exec(line)?.[1] ?? null;
    const path =
      /((?:apps\/desktop\/src|packages\/[A-Za-z0-9_-]+\/src|src)\/[A-Za-z0-9_./-]+:\d+:\d+)/u.exec(
        line,
      )?.[1];
    if (path !== undefined) {
      result.push(`at ${functionName ?? "anonymous"} (${path})`);
    } else if (allowComponentOnly && functionName !== null) {
      result.push(`at ${functionName}`);
    }
    if (result.length >= MAX_STACK_FRAMES - 1) break;
  }
  return result;
}

function fingerprint(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const codePoint of Array.from(parts.join("\u001f"))) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ui-${hash.toString(16).padStart(8, "0")}`;
}

function safeTimestamp(timestamp: string): string {
  return ISO_TIMESTAMP_PATTERN.test(timestamp) ? timestamp : "1970-01-01T00:00:00.000Z";
}

function hashFrom(route: string): string {
  const hashIndex = route.indexOf("#");
  return hashIndex < 0 ? "" : route.slice(hashIndex);
}

function ensureState(owner: object): MutableUiRouteDiagnosticState {
  const existing = states.get(owner);
  const persisted = readPersistedState();
  if (existing !== undefined) {
    if (persisted !== null && persisted.nextSequence > existing.nextSequence) {
      existing.nextSequence = persisted.nextSequence;
      existing.incidents = mergeIncidents(existing.incidents, persisted.incidents);
    }
    return existing;
  }
  const created: MutableUiRouteDiagnosticState = persisted ?? { nextSequence: 0, incidents: [] };
  states.set(owner, created);
  return created;
}

function mergeIncidents(
  current: readonly SafeUiRouteIncident[],
  persisted: readonly SafeUiRouteIncident[],
): SafeUiRouteIncident[] {
  const byId = new Map<string, SafeUiRouteIncident>();
  for (const incident of [...current, ...persisted]) byId.set(incident.diagnosticId, incident);
  return [...byId.values()]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, MAX_UI_ROUTE_INCIDENTS);
}

function persistState(state: MutableUiRouteDiagnosticState): void {
  const storage = diagnosticStorage();
  if (storage === null) return;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 2,
        nextSequence: state.nextSequence,
        incidents: state.incidents,
      } satisfies PersistedUiRouteDiagnosticState),
    );
  } catch {
    // A full or unavailable local store must never replace the recovery UI.
  }
}

function readPersistedState(): MutableUiRouteDiagnosticState | null {
  const storage = diagnosticStorage();
  if (storage === null) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 2 ||
      !Number.isSafeInteger(parsed.nextSequence)
    ) {
      return null;
    }
    if (!Array.isArray(parsed.incidents)) return null;
    const incidents = parsed.incidents
      .map(parsePersistedIncident)
      .filter((incident): incident is SafeUiRouteIncident => incident !== null)
      .slice(0, MAX_UI_ROUTE_INCIDENTS);
    return { nextSequence: Math.max(0, Number(parsed.nextSequence)), incidents };
  } catch {
    return null;
  }
}

function parsePersistedIncident(value: unknown): SafeUiRouteIncident | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.diagnosticId !== "string" ||
    !/^UI-[0-9]{14}-[0-9]{3,}$/u.test(value.diagnosticId) ||
    typeof value.routeTransitionId !== "string" ||
    !/^UI-ROUTE-[0-9]{6,}$/u.test(value.routeTransitionId) ||
    typeof value.timestamp !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value.timestamp) ||
    typeof value.route !== "string" ||
    value.route.length > 512 ||
    typeof value.normalizedErrorCode !== "string" ||
    !SAFE_ERROR_CODE_PATTERN.test(value.normalizedErrorCode) ||
    !SAFE_UI_ERROR_CODES.has(value.normalizedErrorCode) ||
    typeof value.errorType !== "string" ||
    !SAFE_ERROR_TYPE_PATTERN.test(value.errorType) ||
    !SAFE_ERROR_TYPES.has(value.errorType) ||
    typeof value.fingerprint !== "string" ||
    !/^ui-[0-9a-f]{8}$/u.test(value.fingerprint) ||
    !Array.isArray(value.applicationStack) ||
    !Array.isArray(value.reactComponentStack) ||
    !isRecord(value.triggerIds)
  ) {
    return null;
  }
  const sanitizedRoute = safeUiRoute(value.route);
  const triggerIds = Object.freeze({
    projectId: sanitizedRoute.route.includes(":projectId")
      ? safePersistedUuid(value.triggerIds.projectId)
      : null,
    chapterId: sanitizedRoute.route.includes(":chapterId")
      ? safePersistedUuid(value.triggerIds.chapterId)
      : null,
    candidateId: sanitizedRoute.route.includes("candidate=:candidateId")
      ? safePersistedUuid(value.triggerIds.candidateId)
      : null,
  });
  const applicationStack = Object.freeze(
    [
      `${value.errorType}: ${value.normalizedErrorCode}`,
      ...value.applicationStack
        .filter((frame): frame is string => typeof frame === "string")
        .slice(1)
        .flatMap((frame) => safeStackFrames(`header\n${frame}`, false)),
    ].slice(0, MAX_STACK_FRAMES),
  );
  const reactComponentStack = Object.freeze(
    value.reactComponentStack
      .filter((frame): frame is string => typeof frame === "string")
      .flatMap((frame) => safeStackFrames(`header\n${frame}`, true))
      .slice(0, MAX_STACK_FRAMES),
  );
  return Object.freeze({
    diagnosticId: value.diagnosticId,
    routeTransitionId: value.routeTransitionId,
    timestamp: value.timestamp,
    fromRoute: null,
    toRoute: sanitizedRoute.route,
    route: sanitizedRoute.route,
    triggerIds,
    phase: value.phase === "lazy_load" ? "lazy_load" : "render",
    errorBoundaryTriggered: true,
    componentName:
      value.componentName === "AppErrorBoundary" ? "AppErrorBoundary" : "SettingsRouteBoundary",
    webviewReloadDetected: "unknown",
    normalizedErrorCode: value.normalizedErrorCode,
    errorType: value.errorType,
    applicationStack,
    reactComponentStack,
    fingerprint: fingerprint([
      value.normalizedErrorCode,
      value.errorType,
      sanitizedRoute.route,
      applicationStack.join("\n"),
      reactComponentStack.join("\n"),
    ]),
    recovered: value.recovered === true,
    recoveredAt:
      typeof value.recoveredAt === "string" && ISO_TIMESTAMP_PATTERN.test(value.recoveredAt)
        ? value.recoveredAt
        : null,
    recoveryAction:
      value.recoveryAction === "retry" || value.recoveryAction === "navigate_start"
        ? value.recoveryAction
        : null,
  });
}

function safePersistedUuid(value: unknown): string | null {
  return typeof value === "string" && isUuid(value) ? value.toLowerCase() : null;
}

function diagnosticStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
