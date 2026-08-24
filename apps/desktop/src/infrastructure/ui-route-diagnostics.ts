export type UiRouteIncidentPhase = "lazy_load" | "render" | "data_read";
export type UiRouteBoundaryName =
  | "SettingsRouteBoundary"
  | "AppErrorBoundary"
  | "EditorPage"
  | "ProjectChecksPage"
  | "StoryGovernancePage"
  | "StoryOutlinePage"
  | "WorkspacePage";
export type EditorReadStage =
  | "route_identity"
  | "project"
  | "chapter"
  | "chapter_list"
  | "recovery_draft"
  | "chapter_versions"
  | "ai_candidates"
  | "outline"
  | "story_governance";
export type ProjectAreaReadStage =
  "route_identity" | "project" | "chapter_list" | "outline" | "story_governance";
export type ProjectAreaReadComponentName =
  "ProjectChecksPage" | "StoryGovernancePage" | "StoryOutlinePage" | "WorkspacePage";

export type SafeUiRouteRowReference =
  | Readonly<{
      table: "ai_candidates";
      candidateId: string | null;
      rowFingerprint: string;
    }>
  | Readonly<{
      table: "chapter_versions";
      versionId: string | null;
      sequence: number | null;
      rowFingerprint: string;
    }>;

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
  readonly errorBoundaryTriggered: boolean;
  readonly componentName: UiRouteBoundaryName;
  readonly webviewReloadDetected: "unknown";
  readonly normalizedErrorCode: string;
  readonly errorType: string;
  readonly applicationStack: readonly string[];
  readonly reactComponentStack: readonly string[];
  readonly readStage: EditorReadStage | null;
  readonly rowReferences: readonly SafeUiRouteRowReference[];
  readonly reasonCodeChain: readonly string[];
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
  "EDITOR_AUTHORITY_READ_FAILED",
  "LEGACY_CANDIDATE_METADATA_INVALID",
  "LEGACY_VERSION_METADATA_INVALID",
  "PROJECT_AREA_READ_FAILED",
  "TASK_METADATA_INVALID",
  "UI_CHUNK_LOAD_FAILED",
  "UI_LAZY_LOAD_FAILED",
  "UI_RENDER_FAILED",
]);
const SAFE_EDITOR_READ_STAGES = new Set<EditorReadStage>([
  "route_identity",
  "project",
  "chapter",
  "chapter_list",
  "recovery_draft",
  "chapter_versions",
  "ai_candidates",
  "outline",
  "story_governance",
]);
const SAFE_EDITOR_REASON_CODES = new Set([
  "AI_CANDIDATE_BASE_VERSION_ID_INVALID",
  "AI_CANDIDATE_CHAPTER_ID_INVALID",
  "AI_CANDIDATE_CONTENT_CHECKSUM_INVALID",
  "AI_CANDIDATE_CREATED_AT_INVALID",
  "AI_CANDIDATE_DECIDED_AT_INVALID",
  "AI_CANDIDATE_ENTITY_INVALID",
  "AI_CANDIDATE_ID_INVALID",
  "AI_CANDIDATE_METADATA_INVALID",
  "AI_CANDIDATE_PROJECT_ID_INVALID",
  "AI_CANDIDATE_UPDATED_AT_INVALID",
  "CHAPTER_NOT_FOUND",
  "CURRENT_VERSION_SCOPE_MISMATCH",
  "CURRENT_VERSION_CONTENT_MISMATCH",
  "CURRENT_VERSION_CHECKSUM_MISMATCH",
  "CURRENT_VERSION_CHECKSUM_UNAVAILABLE",
  "CURRENT_VERSION_MISSING",
  "CURRENT_VERSION_NOT_CHAIN_TIP",
  "EDITOR_AUTHORITY_READ_FAILED",
  "EDITOR_ROUTE_IDENTITY_INVALID",
  "INVALID_CHECKSUM",
  "INVALID_STATE_TRANSITION",
  "INVALID_TIMESTAMP",
  "INVALID_UUID",
  "LEGACY_CANDIDATE_METADATA_INVALID",
  "LEGACY_VERSION_METADATA_INVALID",
  "PROJECT_NOT_FOUND",
  "PROJECT_AREA_READ_FAILED",
  "REPOSITORY_ERROR",
  "UNKNOWN_CANDIDATE_VALIDATION_FAILURE",
  "VERSION_PARENT_CHAIN_INVALID",
  "VERSION_SEQUENCE_CHAIN_INVALID",
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
    readStage: null,
    rowReferences: Object.freeze([]),
    reasonCodeChain: Object.freeze([normalizedErrorCode]),
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

export function recordEditorReadIncident(
  owner: object,
  input: Readonly<{
    route: string;
    readStage: EditorReadStage;
    cause: unknown;
    timestamp: string;
    normalizedErrorCode: string;
    rowReferences?: readonly SafeUiRouteRowReference[];
    reasonCodeChain?: readonly string[];
    applicationStack?: readonly string[];
    componentStack?: string | null;
  }>,
): SafeUiRouteIncident {
  const state = ensureState(owner);
  const timestamp = safeTimestamp(input.timestamp);
  const route = safeUiRoute(input.route);
  const readStage = safeEditorReadStage(input.readStage);
  const normalizedErrorCode = safeEditorErrorCode(input.normalizedErrorCode);
  const errorType = safeErrorType(input.cause);
  const rowReferences = safeUiRouteRowReferences([
    ...(input.rowReferences ?? []),
    ...rowReferencesFromCause(input.cause),
  ]);
  const reasonCodeChain = safeEditorReasonCodeChain(
    normalizedErrorCode,
    input.cause,
    input.reasonCodeChain ?? [],
  );
  const applicationStack = mergeApplicationStacks(
    safeApplicationStack(input.cause, normalizedErrorCode, errorType),
    input.applicationStack ?? [],
  );
  const reactComponentStack = safeReactComponentStack(input.componentStack ?? null);
  const incidentFingerprint = editorReadFingerprint({
    normalizedErrorCode,
    errorType,
    route: route.route,
    triggerIds: route.triggerIds,
    readStage,
    rowReferences,
    reasonCodeChain,
  });
  const existing = state.incidents.find(
    (incident) =>
      incident.componentName === "EditorPage" &&
      !incident.recovered &&
      incident.fingerprint === incidentFingerprint,
  );
  if (existing !== undefined) return existing;

  state.nextSequence += 1;
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
    phase: "data_read" as const,
    errorBoundaryTriggered: false,
    componentName: "EditorPage" as const,
    webviewReloadDetected: "unknown" as const,
    normalizedErrorCode,
    errorType,
    applicationStack,
    reactComponentStack,
    readStage,
    rowReferences,
    reasonCodeChain,
    fingerprint: incidentFingerprint,
    recovered: false,
    recoveredAt: null,
    recoveryAction: null,
  } satisfies SafeUiRouteIncident);
  state.incidents = [incident, ...state.incidents].slice(0, MAX_UI_ROUTE_INCIDENTS);
  persistState(state);
  return incident;
}

export function recordProjectAreaReadIncident(
  owner: object,
  input: Readonly<{
    route: string;
    readStage: ProjectAreaReadStage;
    cause: unknown;
    timestamp: string;
    componentName: ProjectAreaReadComponentName;
    reasonCodeChain?: readonly string[];
    applicationStack?: readonly string[];
    componentStack?: string | null;
  }>,
): SafeUiRouteIncident {
  const state = ensureState(owner);
  const timestamp = safeTimestamp(input.timestamp);
  const route = safeUiRoute(input.route);
  const readStage = safeEditorReadStage(input.readStage);
  const normalizedErrorCode = "PROJECT_AREA_READ_FAILED";
  const errorType = safeErrorType(input.cause);
  const reasonCodeChain = safeEditorReasonCodeChain(
    normalizedErrorCode,
    input.cause,
    input.reasonCodeChain ?? [],
  );
  const applicationStack = mergeApplicationStacks(
    safeApplicationStack(input.cause, normalizedErrorCode, errorType),
    input.applicationStack ?? [],
  );
  const reactComponentStack = safeReactComponentStack(input.componentStack ?? null);
  const rowReferences = Object.freeze([]) as readonly SafeUiRouteRowReference[];
  const incidentFingerprint = editorReadFingerprint({
    normalizedErrorCode,
    errorType,
    route: route.route,
    triggerIds: route.triggerIds,
    readStage,
    rowReferences,
    reasonCodeChain,
  });
  const existing = state.incidents.find(
    (incident) =>
      incident.componentName === input.componentName &&
      !incident.recovered &&
      incident.fingerprint === incidentFingerprint,
  );
  if (existing !== undefined) return existing;

  state.nextSequence += 1;
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
    phase: "data_read" as const,
    errorBoundaryTriggered: false,
    componentName: input.componentName,
    webviewReloadDetected: "unknown" as const,
    normalizedErrorCode,
    errorType,
    applicationStack,
    reactComponentStack,
    readStage,
    rowReferences,
    reasonCodeChain,
    fingerprint: incidentFingerprint,
    recovered: false,
    recoveredAt: null,
    recoveryAction: null,
  } satisfies SafeUiRouteIncident);
  state.incidents = [incident, ...state.incidents].slice(0, MAX_UI_ROUTE_INCIDENTS);
  persistState(state);
  return incident;
}

export function recoverEditorReadIncidents(
  owner: object,
  input: Readonly<{
    projectId: string;
    chapterId: string;
    timestamp: string;
    readStages?: readonly EditorReadStage[];
  }>,
): void {
  const projectId = safePersistedUuid(input.projectId);
  const chapterId = safePersistedUuid(input.chapterId);
  if (projectId === null || chapterId === null) return;
  const readStages =
    input.readStages === undefined
      ? null
      : new Set(input.readStages.filter((stage) => SAFE_EDITOR_READ_STAGES.has(stage)));
  const state = ensureState(owner);
  state.incidents = state.incidents.map((incident) => {
    if (
      incident.componentName !== "EditorPage" ||
      incident.recovered ||
      incident.triggerIds.projectId !== projectId ||
      incident.triggerIds.chapterId !== chapterId ||
      (readStages !== null && (incident.readStage === null || !readStages.has(incident.readStage)))
    ) {
      return incident;
    }
    return Object.freeze({
      ...incident,
      recovered: true,
      recoveredAt: safeTimestamp(input.timestamp),
      recoveryAction: "retry" as const,
    });
  });
  persistState(state);
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

function safeEditorReadStage(value: EditorReadStage): EditorReadStage {
  return SAFE_EDITOR_READ_STAGES.has(value) ? value : "route_identity";
}

function parseEditorReadStage(value: unknown): EditorReadStage | null {
  return typeof value === "string" && SAFE_EDITOR_READ_STAGES.has(value as EditorReadStage)
    ? (value as EditorReadStage)
    : null;
}

function safeEditorErrorCode(value: string): string {
  return SAFE_UI_ERROR_CODES.has(value) ? value : "EDITOR_AUTHORITY_READ_FAILED";
}

function safeUiRouteRowReferences(values: readonly unknown[]): readonly SafeUiRouteRowReference[] {
  const references = new Map<string, SafeUiRouteRowReference>();
  for (const value of values) {
    if (!isRecord(value)) continue;
    if (value.table === "chapter_versions") {
      const versionId = value.versionId === null ? null : safePersistedUuid(value.versionId);
      const sequence =
        value.sequence === null
          ? null
          : Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
            ? Number(value.sequence)
            : null;
      if (
        (value.versionId !== null && versionId === null) ||
        (value.sequence !== null && sequence === null) ||
        typeof value.rowFingerprint !== "string" ||
        !/^version(?:-row)?-[0-9a-f]{8}$/u.test(value.rowFingerprint)
      ) {
        continue;
      }
      const reference = Object.freeze({
        table: "chapter_versions" as const,
        versionId,
        sequence,
        rowFingerprint: value.rowFingerprint,
      });
      references.set(
        `${reference.table}:${reference.versionId ?? "none"}:${String(reference.sequence)}:${reference.rowFingerprint}`,
        reference,
      );
      if (references.size >= 20) break;
      continue;
    }
    if (value.table !== "ai_candidates") continue;
    const candidateId =
      value.candidateId === null
        ? null
        : typeof value.candidateId === "string" && isUuid(value.candidateId)
          ? value.candidateId.toLowerCase()
          : null;
    if (
      typeof value.rowFingerprint !== "string" ||
      !/^candidate-[0-9a-f]{8}$/u.test(value.rowFingerprint)
    ) {
      continue;
    }
    const reference = Object.freeze({
      table: "ai_candidates" as const,
      candidateId,
      rowFingerprint: value.rowFingerprint,
    });
    references.set(`${reference.rowFingerprint}:${reference.candidateId ?? "none"}`, reference);
    if (references.size >= 20) break;
  }
  return Object.freeze([...references.values()]);
}

function rowReferencesFromCause(cause: unknown): readonly unknown[] {
  const references: unknown[] = [];
  for (const current of causeChain(cause)) {
    if (!isRecord(current) || !isRecord(current.details)) continue;
    if (Array.isArray(current.details.rowReferences)) {
      references.push(...(current.details.rowReferences as readonly unknown[]));
    } else if (current.details.rowReference !== undefined) {
      references.push(current.details.rowReference);
    }
  }
  return Object.freeze(references.slice(0, 20));
}

function safeEditorReasonCodeChain(
  normalizedErrorCode: string,
  cause: unknown,
  inputReasonCodes: readonly string[],
): readonly string[] {
  const reasonCodes = [
    normalizedErrorCode,
    ...inputReasonCodes,
    ...reasonCodesFromCause(cause),
  ].flatMap((value) => {
    const safe = safeEditorReasonCode(value);
    return safe === null ? [] : [safe];
  });
  return Object.freeze([...new Set(reasonCodes)].slice(0, 16));
}

function reasonCodesFromCause(cause: unknown): string[] {
  const reasonCodes: string[] = [];
  for (const current of causeChain(cause)) {
    if (!isRecord(current)) continue;
    if (typeof current.code === "string") reasonCodes.push(current.code);
    if (!isRecord(current.details)) continue;
    if (typeof current.details.validationCode === "string") {
      reasonCodes.push(current.details.validationCode);
    }
    const fieldReason = safeEditorFieldReasonCode(current.details.field);
    if (fieldReason !== null) reasonCodes.push(fieldReason);
  }
  return reasonCodes;
}

function safeEditorFieldReasonCode(field: unknown): string | null {
  switch (field) {
    case "aiCandidate.id":
      return "AI_CANDIDATE_ID_INVALID";
    case "aiCandidate.projectId":
      return "AI_CANDIDATE_PROJECT_ID_INVALID";
    case "aiCandidate.chapterId":
      return "AI_CANDIDATE_CHAPTER_ID_INVALID";
    case "aiCandidate.baseVersionId":
      return "AI_CANDIDATE_BASE_VERSION_ID_INVALID";
    case "aiCandidate.contentChecksum":
      return "AI_CANDIDATE_CONTENT_CHECKSUM_INVALID";
    case "aiCandidate.createdAt":
      return "AI_CANDIDATE_CREATED_AT_INVALID";
    case "aiCandidate.updatedAt":
      return "AI_CANDIDATE_UPDATED_AT_INVALID";
    case "aiCandidate.decidedAt":
      return "AI_CANDIDATE_DECIDED_AT_INVALID";
    default:
      return null;
  }
}

function safeEditorReasonCode(value: unknown): string | null {
  return typeof value === "string" &&
    SAFE_ERROR_CODE_PATTERN.test(value) &&
    SAFE_EDITOR_REASON_CODES.has(value)
    ? value
    : null;
}

function mergeApplicationStacks(
  primary: readonly string[],
  supplemental: readonly string[],
): readonly string[] {
  const identity = primary[0] ?? "Error: EDITOR_AUTHORITY_READ_FAILED";
  const frames = [
    ...primary.slice(1),
    ...supplemental.flatMap((frame) =>
      typeof frame === "string" ? safeStackFrames(`header\n${frame}`, false) : [],
    ),
  ];
  return Object.freeze([identity, ...new Set(frames)].slice(0, MAX_STACK_FRAMES));
}

function editorReadFingerprint(
  input: Readonly<{
    normalizedErrorCode: string;
    errorType: string;
    route: string;
    triggerIds: SafeUiRouteTriggerIds;
    readStage: EditorReadStage;
    rowReferences: readonly SafeUiRouteRowReference[];
    reasonCodeChain: readonly string[];
  }>,
): string {
  return fingerprint([
    input.normalizedErrorCode,
    input.errorType,
    input.route,
    input.triggerIds.projectId ?? "none",
    input.triggerIds.chapterId ?? "none",
    input.readStage,
    ...input.rowReferences.map((reference) =>
      reference.table === "ai_candidates"
        ? `${reference.table}:${reference.candidateId ?? "none"}:${reference.rowFingerprint}`
        : `${reference.table}:${reference.versionId ?? "none"}:${String(reference.sequence)}:${reference.rowFingerprint}`,
    ),
    ...input.reasonCodeChain,
  ]);
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
  const frames = causeChain(cause).flatMap((current) =>
    current instanceof Error && typeof current.stack === "string"
      ? safeStackFrames(current.stack, false)
      : [],
  );
  return Object.freeze([identity, ...new Set(frames)].slice(0, MAX_STACK_FRAMES));
}

function causeChain(cause: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current = cause;
  while (isRecord(current) && chain.length < 8 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return Object.freeze(chain);
}

function safeReactComponentStack(componentStack: string | null): readonly string[] {
  if (componentStack === null) return Object.freeze([]);
  return Object.freeze(
    safeStackFrames(componentStack, true)
      .filter((frame) => frame.includes("(") || /^at [A-Z][A-Za-z0-9_$<>]{1,63}$/u.test(frame))
      .slice(0, MAX_STACK_FRAMES),
  );
}

function safeStackFrames(stack: string, allowComponentOnly: boolean): string[] {
  const result: string[] = [];
  for (const rawLine of stack.split(/\r?\n/gu).slice(1)) {
    const line = rawLine.trim().replaceAll("\\", "/");
    const functionName = /^at\s+([A-Za-z_$<>][A-Za-z0-9_$<>.]*)/u.exec(line)?.[1] ?? null;
    const path =
      /((?:(?:apps\/desktop\/src|packages\/[A-Za-z0-9_-]+\/src|src)\/[A-Za-z0-9_./-]+|assets\/[A-Za-z0-9_.-]+\.js):\d+:\d+)/u.exec(
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
  const componentName: UiRouteBoundaryName =
    value.componentName === "EditorPage"
      ? "EditorPage"
      : value.componentName === "ProjectChecksPage"
        ? "ProjectChecksPage"
        : value.componentName === "StoryGovernancePage"
          ? "StoryGovernancePage"
          : value.componentName === "StoryOutlinePage"
            ? "StoryOutlinePage"
            : value.componentName === "WorkspacePage"
              ? "WorkspacePage"
              : value.componentName === "AppErrorBoundary"
                ? "AppErrorBoundary"
                : "SettingsRouteBoundary";
  const dataReadComponent =
    componentName === "EditorPage" ||
    componentName === "ProjectChecksPage" ||
    componentName === "StoryGovernancePage" ||
    componentName === "StoryOutlinePage" ||
    componentName === "WorkspacePage";
  const persistedReadStage = parseEditorReadStage(value.readStage);
  if (dataReadComponent && (value.phase !== "data_read" || persistedReadStage === null)) {
    return null;
  }
  const readStage = dataReadComponent ? persistedReadStage : null;
  const rowReferences =
    componentName === "EditorPage" && Array.isArray(value.rowReferences)
      ? safeUiRouteRowReferences(value.rowReferences)
      : Object.freeze([]);
  const reasonCodeChain = dataReadComponent
    ? safeEditorReasonCodeChain(
        value.normalizedErrorCode,
        null,
        Array.isArray(value.reasonCodeChain)
          ? value.reasonCodeChain.filter(
              (reasonCode): reasonCode is string => typeof reasonCode === "string",
            )
          : [],
      )
    : Object.freeze([value.normalizedErrorCode]);
  const incidentFingerprint =
    dataReadComponent && readStage !== null
      ? editorReadFingerprint({
          normalizedErrorCode: value.normalizedErrorCode,
          errorType: value.errorType,
          route: sanitizedRoute.route,
          triggerIds,
          readStage,
          rowReferences,
          reasonCodeChain,
        })
      : fingerprint([
          value.normalizedErrorCode,
          value.errorType,
          sanitizedRoute.route,
          applicationStack.join("\n"),
          reactComponentStack.join("\n"),
        ]);

  return Object.freeze({
    diagnosticId: value.diagnosticId,
    routeTransitionId: value.routeTransitionId,
    timestamp: value.timestamp,
    fromRoute: null,
    toRoute: sanitizedRoute.route,
    route: sanitizedRoute.route,
    triggerIds,
    phase: dataReadComponent ? "data_read" : value.phase === "lazy_load" ? "lazy_load" : "render",
    errorBoundaryTriggered: !dataReadComponent,
    componentName,
    webviewReloadDetected: "unknown",
    normalizedErrorCode: value.normalizedErrorCode,
    errorType: value.errorType,
    applicationStack,
    reactComponentStack,
    readStage,
    rowReferences,
    reasonCodeChain,
    fingerprint: incidentFingerprint,
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
