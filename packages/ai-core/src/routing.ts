import type { ModelTask } from "./model.js";

export const MODEL_ROUTE_ROLES = [
  "fast",
  "high_quality",
  "long_context",
  "embedding",
  "validation",
  "translation",
  "local_private",
] as const satisfies readonly ModelTask[];

export type ModelRouteRole = (typeof MODEL_ROUTE_ROLES)[number];
export type ModelRouteLocation = "local" | "remote";
export type ModelRouteVerification = "verified" | "not_checked" | "unavailable";

export interface ModelRouteReference {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ModelRouteDefinition {
  readonly role: ModelRouteRole;
  readonly primary: ModelRouteReference;
  readonly fallback: ModelRouteReference | null;
}

export interface ModelRouteCandidate extends ModelRouteReference {
  readonly location: ModelRouteLocation;
  readonly verification: ModelRouteVerification;
  readonly capabilities: readonly ModelRouteRole[];
}

export type ModelRouteReason =
  "primary_verified" | "primary_pending_verification" | "fallback_verified" | "no_eligible_target";

export type ModelRouteResolution =
  | Readonly<{
      status: "resolved";
      role: ModelRouteRole;
      selected: ModelRouteCandidate;
      fallback: ModelRouteCandidate | null;
      reason: Exclude<ModelRouteReason, "no_eligible_target">;
      requiresConfirmation: boolean;
    }>
  | Readonly<{
      status: "blocked";
      role: ModelRouteRole;
      preferred: ModelRouteCandidate | null;
      fallback: ModelRouteCandidate | null;
      reason: "no_eligible_target";
    }>;

export class ModelRoutingInputError extends Error {
  public readonly code = "MODEL_ROUTING_INVALID_INPUT";

  public constructor(message: string) {
    super(message);
    this.name = "ModelRoutingInputError";
  }
}

/**
 * Resolves only exact, explicitly configured provider/model pairs. A fallback
 * is never hidden: selecting it always requires the caller to obtain a fresh
 * user confirmation before data egress or local execution begins.
 */
export function resolveModelRoute(
  route: ModelRouteDefinition,
  candidates: readonly ModelRouteCandidate[],
): ModelRouteResolution {
  validateRoute(route);
  const normalizedCandidates = candidates.map(validateCandidate);
  const primary = findCandidate(route.primary, normalizedCandidates);
  const fallback =
    route.fallback === null ? null : findCandidate(route.fallback, normalizedCandidates);

  if (isVerifiedForRole(primary, route.role)) {
    return Object.freeze({
      status: "resolved",
      role: route.role,
      selected: primary,
      fallback: isEligibleForRole(fallback, route.role) ? fallback : null,
      reason: "primary_verified",
      requiresConfirmation: false,
    });
  }

  if (isVerifiedForRole(fallback, route.role)) {
    return Object.freeze({
      status: "resolved",
      role: route.role,
      selected: fallback,
      fallback: null,
      reason: "fallback_verified",
      requiresConfirmation: true,
    });
  }

  if (isPendingForRole(primary, route.role)) {
    return Object.freeze({
      status: "resolved",
      role: route.role,
      selected: primary,
      fallback: isEligibleForRole(fallback, route.role) ? fallback : null,
      reason: "primary_pending_verification",
      requiresConfirmation: true,
    });
  }

  return Object.freeze({
    status: "blocked",
    role: route.role,
    preferred: primary,
    fallback,
    reason: "no_eligible_target",
  });
}

export function isModelRouteRole(value: unknown): value is ModelRouteRole {
  return MODEL_ROUTE_ROLES.includes(value as ModelRouteRole);
}

function findCandidate(
  reference: ModelRouteReference,
  candidates: readonly ModelRouteCandidate[],
): ModelRouteCandidate | null {
  return (
    candidates.find(
      ({ providerId, modelId }) =>
        providerId === reference.providerId && modelId === reference.modelId,
    ) ?? null
  );
}

function isVerifiedForRole(
  candidate: ModelRouteCandidate | null,
  role: ModelRouteRole,
): candidate is ModelRouteCandidate {
  return candidate?.verification === "verified" && candidate.capabilities.includes(role);
}

function isPendingForRole(
  candidate: ModelRouteCandidate | null,
  role: ModelRouteRole,
): candidate is ModelRouteCandidate {
  return candidate?.verification === "not_checked" && candidate.capabilities.includes(role);
}

function isEligibleForRole(
  candidate: ModelRouteCandidate | null,
  role: ModelRouteRole,
): candidate is ModelRouteCandidate {
  return (
    candidate !== null &&
    candidate.verification !== "unavailable" &&
    candidate.capabilities.includes(role)
  );
}

function validateRoute(route: ModelRouteDefinition): void {
  if (!isModelRouteRole(route.role)) {
    throw new ModelRoutingInputError("Route role is invalid.");
  }
  validateReference(route.primary);
  if (route.fallback !== null) {
    validateReference(route.fallback);
    if (
      route.fallback.providerId === route.primary.providerId &&
      route.fallback.modelId === route.primary.modelId
    ) {
      throw new ModelRoutingInputError("Primary and fallback targets must differ.");
    }
  }
}

function validateCandidate(candidate: ModelRouteCandidate): ModelRouteCandidate {
  validateReference(candidate);
  if (
    !(["local", "remote"] as readonly string[]).includes(candidate.location) ||
    !(["verified", "not_checked", "unavailable"] as readonly string[]).includes(
      candidate.verification,
    ) ||
    candidate.capabilities.some((role) => !isModelRouteRole(role)) ||
    new Set(candidate.capabilities).size !== candidate.capabilities.length
  ) {
    throw new ModelRoutingInputError("Route candidate metadata is invalid.");
  }
  return Object.freeze({
    ...candidate,
    capabilities: Object.freeze([...candidate.capabilities]),
  });
}

function validateReference(reference: ModelRouteReference): void {
  if (
    !/^[a-z][a-z0-9._-]{0,127}$/u.test(reference.providerId) ||
    reference.modelId.length < 1 ||
    reference.modelId.length > 512 ||
    reference.modelId.trim() !== reference.modelId ||
    /[\u0000-\u001f\u007f]/u.test(reference.modelId)
  ) {
    throw new ModelRoutingInputError("Route target reference is invalid.");
  }
}
