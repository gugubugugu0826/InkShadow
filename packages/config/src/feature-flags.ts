import { z } from "zod";

export const featureFlagsSchema = z
  .object({
    localMode: z.boolean(),
    byokModels: z.boolean(),
    localModels: z.boolean(),
    aiCandidateIsolation: z.boolean(),
    localExportWhenUnlicensed: z.boolean(),
    redactedDiagnostics: z.boolean(),
    cloudIdentity: z.boolean(),
    cloudSync: z.boolean(),
    teamCollaboration: z.boolean(),
    advancedModelRouting: z.boolean(),
    graphRag: z.boolean(),
    authoritativeExtraction: z.boolean(),
    multiAgent: z.boolean(),
    whatIf: z.boolean(),
    fineTuning: z.boolean(),
    translation: z.boolean(),
    shortDrama: z.boolean(),
    communityMarketplace: z.boolean(),
    telemetry: z.boolean(),
    operationsAdmin: z.boolean(),
  })
  .strict();

export const featureFlagOverridesSchema = featureFlagsSchema.partial();

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;
export type FeatureFlagOverrides = z.infer<typeof featureFlagOverridesSchema>;
export type FeatureFlagName = Extract<keyof FeatureFlags, string>;

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze({
  localMode: true,
  byokModels: true,
  localModels: true,
  aiCandidateIsolation: true,
  localExportWhenUnlicensed: true,
  redactedDiagnostics: true,
  cloudIdentity: false,
  cloudSync: false,
  teamCollaboration: false,
  advancedModelRouting: false,
  graphRag: false,
  authoritativeExtraction: false,
  multiAgent: false,
  whatIf: false,
  fineTuning: false,
  translation: false,
  shortDrama: false,
  communityMarketplace: false,
  telemetry: false,
  operationsAdmin: false,
});

const SAFETY_CRITICAL_FLAGS = [
  "localMode",
  "aiCandidateIsolation",
  "localExportWhenUnlicensed",
  "redactedDiagnostics",
] as const satisfies readonly FeatureFlagName[];

export class FeatureFlagPolicyError extends Error {
  readonly code = "FEATURE_FLAG_POLICY_VIOLATION";

  constructor(readonly flag: FeatureFlagName) {
    super(`The safety-critical feature flag "${flag}" cannot be disabled.`);
    this.name = "FeatureFlagPolicyError";
  }
}

export class FeatureFlagDependencyError extends Error {
  readonly code = "FEATURE_FLAG_DEPENDENCY_VIOLATION";

  constructor(
    readonly flag: FeatureFlagName,
    readonly dependency: FeatureFlagName,
  ) {
    super(`The feature flag "${flag}" requires "${dependency}".`);
    this.name = "FeatureFlagDependencyError";
  }
}

export function resolveFeatureFlags(input: unknown = {}): Readonly<FeatureFlags> {
  const overrides = featureFlagOverridesSchema.parse(input);

  for (const flag of SAFETY_CRITICAL_FLAGS) {
    if (overrides[flag] === false) {
      throw new FeatureFlagPolicyError(flag);
    }
  }

  const resolved = featureFlagsSchema.parse({
    ...DEFAULT_FEATURE_FLAGS,
    ...overrides,
  });
  if (resolved.cloudSync && !resolved.cloudIdentity) {
    throw new FeatureFlagDependencyError("cloudSync", "cloudIdentity");
  }
  if (resolved.teamCollaboration && !resolved.cloudIdentity) {
    throw new FeatureFlagDependencyError("teamCollaboration", "cloudIdentity");
  }
  if (resolved.communityMarketplace && !resolved.cloudIdentity) {
    throw new FeatureFlagDependencyError("communityMarketplace", "cloudIdentity");
  }
  if (resolved.authoritativeExtraction && !resolved.graphRag) {
    throw new FeatureFlagDependencyError("authoritativeExtraction", "graphRag");
  }
  return Object.freeze(resolved);
}

export function isFeatureEnabled(flags: Readonly<FeatureFlags>, feature: FeatureFlagName): boolean {
  return flags[feature];
}
