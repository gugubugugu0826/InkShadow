export type UiRouteIncidentPhase = "lazy_load" | "render";

export interface SafeUiRouteIncident {
  readonly diagnosticId: string;
  readonly routeTransitionId: string;
  readonly timestamp: string;
  readonly fromRoute: null;
  readonly toRoute: string;
  readonly route: string;
  readonly phase: UiRouteIncidentPhase;
  readonly errorBoundaryTriggered: true;
  readonly componentName: "SettingsRouteBoundary";
  readonly webviewReloadDetected: "unknown";
  readonly normalizedErrorCode: string;
  readonly recovered: boolean;
  readonly recoveredAt: string | null;
  readonly recoveryAction: "retry" | "navigate_start" | null;
}

interface MutableUiRouteDiagnosticState {
  nextSequence: number;
  incidents: SafeUiRouteIncident[];
}

const MAX_UI_ROUTE_INCIDENTS = 20;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/u;
const SAFE_ROUTE_PATTERN = /^\/(?:settings(?:\/sync)?)?$/u;
const states = new WeakMap<object, MutableUiRouteDiagnosticState>();

export function safeSettingsRoute(pathname: string, hash: string): string {
  const safePathname = SAFE_ROUTE_PATTERN.test(pathname) ? pathname : "/settings";
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
  }>,
): SafeUiRouteIncident {
  const state = ensureState(owner);
  state.nextSequence += 1;
  const incident = Object.freeze({
    diagnosticId: `UI-${input.timestamp.replace(/[^0-9]/gu, "").slice(-14)}-${String(
      state.nextSequence,
    ).padStart(3, "0")}`,
    routeTransitionId: `UI-ROUTE-${String(state.nextSequence).padStart(6, "0")}`,
    timestamp: input.timestamp,
    fromRoute: null,
    toRoute: safeSettingsRoute(input.route.split("#", 1)[0] ?? "/settings", hashFrom(input.route)),
    route: safeSettingsRoute(input.route.split("#", 1)[0] ?? "/settings", hashFrom(input.route)),
    phase: input.phase,
    errorBoundaryTriggered: true,
    componentName: "SettingsRouteBoundary",
    webviewReloadDetected: "unknown",
    normalizedErrorCode: safeErrorCode(input.cause),
    recovered: false,
    recoveredAt: null,
    recoveryAction: null,
  } satisfies SafeUiRouteIncident);
  state.incidents = [incident, ...state.incidents].slice(0, MAX_UI_ROUTE_INCIDENTS);
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
      ? Object.freeze({ ...incident, recovered: true, recoveredAt: timestamp, recoveryAction })
      : incident,
  );
}

export function readSafeUiRouteIncidents(owner: object): readonly SafeUiRouteIncident[] {
  return Object.freeze([...ensureState(owner).incidents]);
}

export function resetUiRouteDiagnosticsForTests(owner: object): void {
  states.delete(owner);
}

function safeErrorCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    SAFE_ERROR_CODE_PATTERN.test(cause.code)
  ) {
    return cause.code;
  }
  return "UI_RENDER_FAILED";
}

function hashFrom(route: string): string {
  const hashIndex = route.indexOf("#");
  return hashIndex < 0 ? "" : route.slice(hashIndex);
}

function ensureState(owner: object): MutableUiRouteDiagnosticState {
  const existing = states.get(owner);
  if (existing !== undefined) return existing;
  const created: MutableUiRouteDiagnosticState = { nextSequence: 0, incidents: [] };
  states.set(owner, created);
  return created;
}
