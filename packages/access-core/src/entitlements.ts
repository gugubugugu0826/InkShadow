import { AccessCoreError } from "./errors.js";
import { requireIdentifier, uniqueSortedIdentifiers } from "./validation.js";

export const RELEASE_TIERS = ["community", "pro", "studio", "enterprise"] as const;
export type ReleaseTier = (typeof RELEASE_TIERS)[number];

export const SUBSCRIPTION_STATES = [
  "none",
  "trialing",
  "active",
  "past_due",
  "grace",
  "expired",
  "canceled",
  "refunded",
  "offline_expired",
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export const PRODUCT_CAPABILITIES = [
  "local.read",
  "local.edit",
  "local.version",
  "local.backup",
  "local.export",
  "ai.local",
  "ai.byok",
  "sync.e2ee",
  "ai.advanced",
  "story.graphrag",
  "team.workspace",
  "team.review",
  "team.audit",
  "team.budget",
  "enterprise.sso",
  "enterprise.private_deployment",
  "enterprise.policy",
] as const;
export type ProductCapability = (typeof PRODUCT_CAPABILITIES)[number];

export const LOCAL_CAPABILITIES: readonly ProductCapability[] = Object.freeze([
  "local.read",
  "local.edit",
  "local.version",
  "local.backup",
  "local.export",
  "ai.local",
  "ai.byok",
]);

export type EntitlementEvidence = "server_verified" | "offline_license_verified" | "unverified";

export interface EntitlementEvaluationInput {
  readonly tier: ReleaseTier;
  readonly subscriptionState: SubscriptionState;
  readonly evidence: EntitlementEvidence;
  readonly grantedCapabilities: readonly string[];
  readonly enabledFlags: readonly string[];
}

export interface CapabilityDecision {
  readonly capability: ProductCapability;
  readonly allowed: boolean;
  readonly reason:
    | "local_always_available"
    | "verified_entitlement"
    | "subscription_unavailable"
    | "evidence_unverified"
    | "tier_unavailable"
    | "entitlement_missing"
    | "feature_flag_disabled";
}

export interface EntitlementEvaluation {
  readonly tier: ReleaseTier;
  readonly subscriptionState: SubscriptionState;
  readonly decisions: Readonly<Record<ProductCapability, CapabilityDecision>>;
  can(capability: ProductCapability): boolean;
}

const TIER_CAPABILITIES: Readonly<Record<ReleaseTier, ReadonlySet<ProductCapability>>> = {
  community: new Set(LOCAL_CAPABILITIES),
  pro: new Set([...LOCAL_CAPABILITIES, "sync.e2ee", "ai.advanced", "story.graphrag"]),
  studio: new Set([
    ...LOCAL_CAPABILITIES,
    "sync.e2ee",
    "ai.advanced",
    "story.graphrag",
    "team.workspace",
    "team.review",
    "team.audit",
    "team.budget",
  ]),
  enterprise: new Set(PRODUCT_CAPABILITIES),
};

const SUBSCRIPTION_ALLOWS_REMOTE = new Set<SubscriptionState>(["trialing", "active", "grace"]);

export function evaluateEntitlements(input: EntitlementEvaluationInput): EntitlementEvaluation {
  if (
    !RELEASE_TIERS.includes(input.tier) ||
    !SUBSCRIPTION_STATES.includes(input.subscriptionState)
  ) {
    throw new AccessCoreError(
      "ACCESS_VALIDATION_FAILED",
      "Release or subscription state is invalid.",
    );
  }
  const granted = new Set(
    uniqueSortedIdentifiers(input.grantedCapabilities, "grantedCapabilities"),
  );
  const flags = new Set(uniqueSortedIdentifiers(input.enabledFlags, "enabledFlags"));
  const tierCapabilities = TIER_CAPABILITIES[input.tier];
  const decisions = Object.fromEntries(
    PRODUCT_CAPABILITIES.map((capability) => [
      capability,
      decideCapability({
        capability,
        input,
        granted,
        flags,
        tierCapabilities,
      }),
    ]),
  ) as Record<ProductCapability, CapabilityDecision>;

  return Object.freeze({
    tier: input.tier,
    subscriptionState: input.subscriptionState,
    decisions: Object.freeze(decisions),
    can(capability: ProductCapability): boolean {
      return decisions[capability].allowed;
    },
  });
}

function decideCapability(context: {
  readonly capability: ProductCapability;
  readonly input: EntitlementEvaluationInput;
  readonly granted: ReadonlySet<string>;
  readonly flags: ReadonlySet<string>;
  readonly tierCapabilities: ReadonlySet<ProductCapability>;
}): CapabilityDecision {
  const { capability, input, granted, flags, tierCapabilities } = context;
  if (LOCAL_CAPABILITIES.includes(capability)) {
    return { capability, allowed: true, reason: "local_always_available" };
  }
  if (input.evidence === "unverified") {
    return { capability, allowed: false, reason: "evidence_unverified" };
  }
  if (!SUBSCRIPTION_ALLOWS_REMOTE.has(input.subscriptionState)) {
    return { capability, allowed: false, reason: "subscription_unavailable" };
  }
  if (!tierCapabilities.has(capability)) {
    return { capability, allowed: false, reason: "tier_unavailable" };
  }
  if (!granted.has(capability)) {
    return { capability, allowed: false, reason: "entitlement_missing" };
  }
  if (!flags.has(capability)) {
    return { capability, allowed: false, reason: "feature_flag_disabled" };
  }
  return { capability, allowed: true, reason: "verified_entitlement" };
}

export function assertProductCapability(value: string): ProductCapability {
  const normalized = requireIdentifier(value, "capability");
  if (!PRODUCT_CAPABILITIES.includes(normalized as ProductCapability)) {
    throw new AccessCoreError("ACCESS_VALIDATION_FAILED", "Product capability is unsupported.");
  }
  return normalized as ProductCapability;
}
