import { StoryCoreError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import {
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type IsoUtcTimestamp,
  type SafeIdentifier,
  type UuidV7,
} from "./value-objects.js";

export const FINE_TUNING_GOVERNANCE_SCHEMA_VERSION = 1 as const;
export const FINE_TUNING_PRIVACY_SCAN_VERSION = "inkshadow.privacy-scan.v1" as const;
export const FINE_TUNING_MINIMUM_INCLUDED_SAMPLES = 3;
export const FINE_TUNING_MAXIMUM_SAMPLES = 20_000;
export const FINE_TUNING_MAXIMUM_SAMPLE_LENGTH = 1_000_000;

export const FINE_TUNING_SOURCE_KINDS = ["chapter_version", "material", "local_import"] as const;
export type FineTuningSourceKind = (typeof FINE_TUNING_SOURCE_KINDS)[number];

export const FINE_TUNING_RIGHTS_KINDS = [
  "user_owned",
  "licensed_for_training",
  "public_domain",
  "unknown",
] as const;
export type FineTuningRightsKind = (typeof FINE_TUNING_RIGHTS_KINDS)[number];

export const FINE_TUNING_SPLITS = ["train", "validation", "test", "excluded"] as const;
export type FineTuningSplit = (typeof FINE_TUNING_SPLITS)[number];

export const FINE_TUNING_DATASET_STATES = [
  "draft",
  "review_required",
  "approved",
  "archived",
] as const;
export type FineTuningDatasetState = (typeof FINE_TUNING_DATASET_STATES)[number];

export const FINE_TUNING_JOB_STATES = [
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "failed_retryable",
  "failed_final",
  "artifact_ready",
] as const;
export type FineTuningJobState = (typeof FINE_TUNING_JOB_STATES)[number];

export const FINE_TUNING_ARTIFACT_STATES = [
  "candidate",
  "evaluation_failed",
  "evaluation_passed",
  "registration_approved",
  "registered",
  "deployment_approved",
  "deployed",
  "rolled_back",
  "revoked",
] as const;
export type FineTuningArtifactState = (typeof FINE_TUNING_ARTIFACT_STATES)[number];

export type FineTuningPrivacyFindingCategory =
  "email" | "phone" | "government_id" | "payment_card" | "credential" | "private_key";

export interface FineTuningPrivacyFinding {
  readonly category: FineTuningPrivacyFindingCategory;
  readonly count: number;
}

export interface FineTuningPrivacyScan {
  readonly version: typeof FINE_TUNING_PRIVACY_SCAN_VERSION;
  readonly piiFindingCount: number;
  readonly sensitiveFindingCount: number;
  readonly findings: readonly FineTuningPrivacyFinding[];
  readonly passed: boolean;
}

export interface FineTuningSourceAuthority {
  readonly kind: FineTuningSourceKind;
  readonly projectId: UuidV7;
  readonly entityId: UuidV7;
  readonly entityRevision: number;
  readonly label: string;
}

export interface FineTuningRightsDeclaration {
  readonly kind: FineTuningRightsKind;
  readonly basis: string;
  readonly confirmedAt: IsoUtcTimestamp | null;
  readonly allowTraining: boolean;
}

export interface FineTuningSampleDraft {
  readonly id: string;
  readonly source: {
    readonly kind: FineTuningSourceKind;
    readonly projectId: string;
    readonly entityId: string;
    readonly entityRevision: number;
    readonly label: string;
  };
  /**
   * Local-only training content. The governance layer hashes and scans it, but
   * never builds a cloud request or a remote upload body.
   */
  readonly content: string;
  readonly expectedContentHash?: string;
  readonly rights: {
    readonly kind: FineTuningRightsKind;
    readonly basis: string;
    readonly confirmedAt: string | null;
    readonly allowTraining: boolean;
  };
}

export interface FineTuningDatasetSample {
  readonly id: UuidV7;
  readonly source: FineTuningSourceAuthority;
  readonly content: string;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly rights: FineTuningRightsDeclaration;
  readonly privacy: FineTuningPrivacyScan;
  readonly split: FineTuningSplit;
  readonly duplicateOfSampleId: UuidV7 | null;
}

export interface FineTuningSplitPolicy {
  readonly seed: SafeIdentifier;
  readonly trainParts: number;
  readonly validationParts: number;
  readonly testParts: number;
}

export interface FineTuningDatasetReadinessIssue {
  readonly code:
    | "FINE_TUNING_SAMPLE_COUNT_TOO_LOW"
    | "FINE_TUNING_RIGHTS_UNCONFIRMED"
    | "FINE_TUNING_TRAINING_NOT_ALLOWED"
    | "FINE_TUNING_PRIVACY_BLOCKED"
    | "FINE_TUNING_SPLIT_INCOMPLETE";
  readonly sampleId: UuidV7 | null;
  readonly detail: string;
}

export interface FineTuningDatasetSnapshot {
  readonly schemaVersion: typeof FINE_TUNING_GOVERNANCE_SCHEMA_VERSION;
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly name: string;
  readonly state: FineTuningDatasetState;
  readonly revision: number;
  readonly splitPolicy: FineTuningSplitPolicy;
  readonly samples: readonly FineTuningDatasetSample[];
  readonly manifestHash: string;
  readonly totalContentBytes: number;
  readonly includedSampleCount: number;
  readonly duplicateSampleCount: number;
  readonly splitCounts: Readonly<Record<Exclude<FineTuningSplit, "excluded">, number>>;
  readonly readinessIssues: readonly FineTuningDatasetReadinessIssue[];
  readonly approvedBy: SafeIdentifier | null;
  readonly approvedAt: IsoUtcTimestamp | null;
  readonly createdBy: SafeIdentifier;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface FineTuningDatasetApproval {
  readonly id: UuidV7;
  readonly datasetId: UuidV7;
  readonly datasetRevision: number;
  readonly manifestHash: string;
  readonly actorId: SafeIdentifier;
  readonly privacyReviewed: true;
  readonly copyrightReviewed: true;
  readonly trainingPurposeConfirmed: true;
  readonly createdAt: IsoUtcTimestamp;
}

export interface FineTuningBaseModelLicense {
  readonly licenseId: SafeIdentifier;
  readonly licenseVersion: string;
  readonly fineTuningAllowed: boolean;
  readonly commercialUseAllowed: boolean;
  readonly redistributionAllowed: boolean;
  readonly confirmedAt: IsoUtcTimestamp;
}

export interface FineTuningTrainingPlan {
  readonly schemaVersion: typeof FINE_TUNING_GOVERNANCE_SCHEMA_VERSION;
  readonly datasetId: UuidV7;
  readonly datasetRevision: number;
  readonly datasetManifestHash: string;
  readonly baseModel: {
    readonly providerId: SafeIdentifier;
    readonly modelId: string;
    readonly revision: string;
    readonly license: FineTuningBaseModelLicense;
  };
  readonly provider: {
    readonly location: "local" | "remote";
    readonly providerId: SafeIdentifier;
    readonly credentialProfileId: SafeIdentifier | null;
    readonly commercialAuthorizationId: SafeIdentifier | null;
  };
  readonly method: "lora" | "qlora";
  readonly hyperparameters: {
    readonly rank: number;
    readonly alpha: number;
    readonly dropout: number;
    readonly learningRate: number;
    readonly epochs: number;
  };
  readonly limits: {
    readonly maximumDurationMs: number;
    readonly maximumCostMicros: number;
    readonly estimatedCostMicros: number;
    readonly estimatedGpuMinutes: number;
    readonly currency: string;
  };
  readonly planHash: string;
}

export interface FineTuningQuotaPolicy {
  readonly allowRemoteTraining: boolean;
  readonly maximumDatasetBytes: number;
  readonly maximumConcurrentJobs: number;
  readonly maximumSingleJobCostMicros: number;
  readonly monthlyCostLimitMicros: number;
  readonly currency: string;
}

export interface FineTuningQuotaUsage {
  readonly activeJobs: number;
  readonly spentMicros: number;
  readonly reservedMicros: number;
}

export interface FineTuningPreflightCheck {
  readonly code:
    | "FINE_TUNING_FEATURE_DISABLED"
    | "FINE_TUNING_PROVIDER_UNAVAILABLE"
    | "FINE_TUNING_DATASET_NOT_APPROVED"
    | "FINE_TUNING_DATASET_CHANGED"
    | "FINE_TUNING_MODEL_LICENSE_BLOCKED"
    | "FINE_TUNING_REMOTE_AUTHORIZATION_REQUIRED"
    | "FINE_TUNING_REMOTE_POLICY_BLOCKED"
    | "FINE_TUNING_DATASET_QUOTA_EXCEEDED"
    | "FINE_TUNING_CONCURRENCY_EXCEEDED"
    | "FINE_TUNING_JOB_COST_EXCEEDED"
    | "FINE_TUNING_MONTHLY_QUOTA_EXCEEDED"
    | "FINE_TUNING_COST_ESTIMATE";
  readonly level: "blocking" | "notice";
  readonly detail: string;
}

export interface FineTuningTrainingPreflight {
  readonly ready: boolean;
  readonly checks: readonly FineTuningPreflightCheck[];
  readonly reservedCostMicros: number;
  readonly costSemantics: "maximum_reservation_not_provider_bill";
}

export interface FineTuningEvaluationMetric {
  /** Untrusted evaluator input; validated and branded before persistence. */
  readonly name: string;
  readonly score: number;
}

export interface FineTuningEvaluationRule {
  /** Untrusted evaluator input; validated and branded before persistence. */
  readonly metric: string;
  readonly direction: "higher_is_better" | "lower_is_better";
  readonly minimumCandidate?: number;
  readonly maximumCandidate?: number;
  readonly minimumImprovement?: number;
  readonly maximumRegression?: number;
}

export interface FineTuningEvaluationGateInput {
  readonly baselineModelId: string;
  readonly candidateArtifactId: string;
  readonly baseline: readonly FineTuningEvaluationMetric[];
  readonly candidate: readonly FineTuningEvaluationMetric[];
  readonly rules: readonly FineTuningEvaluationRule[];
}

export interface FineTuningEvaluationObservation {
  readonly metric: SafeIdentifier;
  readonly baseline: number;
  readonly candidate: number;
  readonly signedImprovement: number;
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

export interface FineTuningEvaluationGateResult {
  readonly passed: boolean;
  readonly baselineModelId: string;
  readonly candidateArtifactId: string;
  readonly observations: readonly FineTuningEvaluationObservation[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const UNSAFE_TEXT_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;
const PRIVACY_PATTERNS: readonly {
  readonly category: FineTuningPrivacyFindingCategory;
  readonly sensitive: boolean;
  readonly pattern: RegExp;
}[] = [
  {
    category: "email",
    sensitive: false,
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  },
  {
    category: "phone",
    sensitive: false,
    pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu,
  },
  {
    category: "government_id",
    sensitive: false,
    pattern: /(?<!\d)\d{17}[\dXx](?!\d)/gu,
  },
  {
    category: "payment_card",
    sensitive: true,
    pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu,
  },
  {
    category: "credential",
    sensitive: true,
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/giu,
  },
  {
    category: "private_key",
    sensitive: true,
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  },
] as const;

export function scanFineTuningPrivacy(content: string): FineTuningPrivacyScan {
  const safeContent = validateContent(content);
  if (!safeContent.ok) {
    return Object.freeze({
      version: FINE_TUNING_PRIVACY_SCAN_VERSION,
      piiFindingCount: 0,
      sensitiveFindingCount: 1,
      findings: Object.freeze([{ category: "credential" as const, count: 1 }]),
      passed: false,
    });
  }
  const findings: FineTuningPrivacyFinding[] = [];
  let piiFindingCount = 0;
  let sensitiveFindingCount = 0;
  for (const definition of PRIVACY_PATTERNS) {
    const count = [...safeContent.value.matchAll(definition.pattern)].length;
    if (count === 0) {
      continue;
    }
    findings.push(Object.freeze({ category: definition.category, count }));
    if (definition.sensitive) {
      sensitiveFindingCount += count;
    } else {
      piiFindingCount += count;
    }
  }
  return Object.freeze({
    version: FINE_TUNING_PRIVACY_SCAN_VERSION,
    piiFindingCount,
    sensitiveFindingCount,
    findings: Object.freeze(findings),
    passed: piiFindingCount === 0 && sensitiveFindingCount === 0,
  });
}

export async function createFineTuningDataset(input: {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly samples: readonly FineTuningSampleDraft[];
  readonly splitPolicy: {
    readonly seed: string;
    readonly trainParts: number;
    readonly validationParts: number;
    readonly testParts: number;
  };
  readonly createdBy: string;
  readonly now: string;
}): Promise<Result<FineTuningDatasetSnapshot, StoryCoreError>> {
  const id = parseUuidV7(input.id);
  const projectId = parseUuidV7(input.projectId);
  const createdBy = parseSafeIdentifier(input.createdBy);
  const now = parseIsoUtcTimestamp(input.now);
  const name = validateText(input.name, 1, 200, "Fine-tuning dataset name");
  const splitPolicy = validateSplitPolicy(input.splitPolicy);
  if (!id.ok) return id;
  if (!projectId.ok) return projectId;
  if (!createdBy.ok) return createdBy;
  if (!now.ok) return now;
  if (!name.ok) return name;
  if (!splitPolicy.ok) return splitPolicy;
  if (input.samples.length === 0 || input.samples.length > FINE_TUNING_MAXIMUM_SAMPLES) {
    return validationError("Fine-tuning sample count is outside the supported boundary.");
  }

  const samples: FineTuningDatasetSample[] = [];
  const ids = new Set<string>();
  for (const draft of input.samples) {
    const parsed = await parseSampleDraft(draft, projectId.value);
    if (!parsed.ok) {
      return parsed;
    }
    if (ids.has(parsed.value.id)) {
      return validationError("Fine-tuning sample identifiers must be unique.");
    }
    ids.add(parsed.value.id);
    samples.push(parsed.value);
  }

  const firstByHash = new Map<string, UuidV7>();
  const unique: FineTuningDatasetSample[] = [];
  const deduplicated = samples.map((sample) => {
    const duplicateOf = firstByHash.get(sample.contentHash) ?? null;
    if (duplicateOf !== null) {
      return Object.freeze({
        ...sample,
        split: "excluded" as const,
        duplicateOfSampleId: duplicateOf,
      });
    }
    firstByHash.set(sample.contentHash, sample.id);
    unique.push(sample);
    return sample;
  });

  const splitAssignments = await assignDeterministicSplits(unique, splitPolicy.value);
  const assigned = deduplicated.map((sample) => {
    if (sample.duplicateOfSampleId !== null) {
      return sample;
    }
    return Object.freeze({
      ...sample,
      split: splitAssignments.get(sample.id) ?? ("excluded" as const),
      duplicateOfSampleId: null,
    });
  });
  const readinessIssues = buildDatasetReadinessIssues(assigned);
  const state: FineTuningDatasetState = readinessIssues.length === 0 ? "review_required" : "draft";
  const splitCounts = countSplits(assigned);
  const manifestHash = await hashCanonicalJson(
    datasetManifestAuthority({
      id: id.value,
      projectId: projectId.value,
      name: name.value,
      revision: 1,
      splitPolicy: splitPolicy.value,
      samples: assigned,
    }),
  );
  return ok(
    deepFreeze({
      schemaVersion: FINE_TUNING_GOVERNANCE_SCHEMA_VERSION,
      id: id.value,
      projectId: projectId.value,
      name: name.value,
      state,
      revision: 1,
      splitPolicy: splitPolicy.value,
      samples: assigned,
      manifestHash,
      totalContentBytes: assigned.reduce((sum, sample) => sum + sample.contentBytes, 0),
      includedSampleCount: assigned.filter(({ split }) => split !== "excluded").length,
      duplicateSampleCount: assigned.filter(
        ({ duplicateOfSampleId }) => duplicateOfSampleId !== null,
      ).length,
      splitCounts,
      readinessIssues,
      approvedBy: null,
      approvedAt: null,
      createdBy: createdBy.value,
      createdAt: now.value,
      updatedAt: now.value,
    }),
  );
}

export function approveFineTuningDataset(
  dataset: FineTuningDatasetSnapshot,
  input: {
    readonly approvalId: string;
    readonly actorId: string;
    readonly expectedRevision: number;
    readonly expectedManifestHash: string;
    readonly privacyReviewed: unknown;
    readonly copyrightReviewed: unknown;
    readonly trainingPurposeConfirmed: unknown;
    readonly humanConfirmed: unknown;
    readonly now: string;
  },
): Result<
  Readonly<{
    dataset: FineTuningDatasetSnapshot;
    approval: FineTuningDatasetApproval;
  }>,
  StoryCoreError
> {
  const approvalId = parseUuidV7(input.approvalId);
  const actorId = parseSafeIdentifier(input.actorId);
  const now = parseIsoUtcTimestamp(input.now);
  if (!approvalId.ok) return approvalId;
  if (!actorId.ok) return actorId;
  if (!now.ok) return now;
  if (
    input.humanConfirmed !== true ||
    input.privacyReviewed !== true ||
    input.copyrightReviewed !== true ||
    input.trainingPurposeConfirmed !== true
  ) {
    return fineTuningError(
      "FINE_TUNING_HUMAN_APPROVAL_REQUIRED",
      "Dataset approval requires explicit privacy, copyright, and training-purpose confirmation.",
      ["REVIEW_FINE_TUNING_GOVERNANCE"],
    );
  }
  if (
    dataset.state !== "review_required" ||
    dataset.readinessIssues.length > 0 ||
    input.expectedRevision !== dataset.revision ||
    input.expectedManifestHash !== dataset.manifestHash
  ) {
    return fineTuningError(
      "FINE_TUNING_DATASET_CHANGED",
      "The dataset is not review-ready or changed after the approval preview.",
      ["RECOMPARE"],
      true,
    );
  }
  const approval = deepFreeze({
    id: approvalId.value,
    datasetId: dataset.id,
    datasetRevision: dataset.revision,
    manifestHash: dataset.manifestHash,
    actorId: actorId.value,
    privacyReviewed: true as const,
    copyrightReviewed: true as const,
    trainingPurposeConfirmed: true as const,
    createdAt: now.value,
  });
  const approvedDataset = deepFreeze({
    ...dataset,
    state: "approved" as const,
    revision: dataset.revision + 1,
    approvedBy: actorId.value,
    approvedAt: now.value,
    updatedAt: now.value,
  });
  return ok({ dataset: approvedDataset, approval });
}

export async function createFineTuningTrainingPlan(input: {
  readonly dataset: FineTuningDatasetSnapshot;
  readonly baseModel: {
    readonly providerId: string;
    readonly modelId: string;
    readonly revision: string;
    readonly license: {
      readonly licenseId: string;
      readonly licenseVersion: string;
      readonly fineTuningAllowed: boolean;
      readonly commercialUseAllowed: boolean;
      readonly redistributionAllowed: boolean;
      readonly confirmedAt: string;
    };
  };
  readonly provider: {
    readonly location: "local" | "remote";
    readonly providerId: string;
    readonly credentialProfileId?: string | null;
    readonly commercialAuthorizationId?: string | null;
  };
  readonly method: "lora" | "qlora";
  readonly hyperparameters: FineTuningTrainingPlan["hyperparameters"];
  readonly limits: FineTuningTrainingPlan["limits"];
}): Promise<Result<FineTuningTrainingPlan, StoryCoreError>> {
  const baseProviderId = parseSafeIdentifier(input.baseModel.providerId);
  const providerId = parseSafeIdentifier(input.provider.providerId);
  const licenseId = parseSafeIdentifier(input.baseModel.license.licenseId);
  const confirmedAt = parseIsoUtcTimestamp(input.baseModel.license.confirmedAt);
  const credentialProfileId = parseNullableIdentifier(input.provider.credentialProfileId);
  const commercialAuthorizationId = parseNullableIdentifier(
    input.provider.commercialAuthorizationId,
  );
  if (!baseProviderId.ok) return baseProviderId;
  if (!providerId.ok) return providerId;
  if (!licenseId.ok) return licenseId;
  if (!confirmedAt.ok) return confirmedAt;
  if (!credentialProfileId.ok) return credentialProfileId;
  if (!commercialAuthorizationId.ok) return commercialAuthorizationId;
  if (
    !MODEL_ID_PATTERN.test(input.baseModel.modelId) ||
    !MODEL_ID_PATTERN.test(input.baseModel.revision) ||
    !MODEL_ID_PATTERN.test(input.baseModel.license.licenseVersion)
  ) {
    return validationError("Base-model identity or license version is invalid.");
  }
  if (!validHyperparameters(input.hyperparameters) || !validLimits(input.limits)) {
    return validationError("Fine-tuning hyperparameters or bounded resource limits are invalid.");
  }
  const authority = {
    schemaVersion: FINE_TUNING_GOVERNANCE_SCHEMA_VERSION,
    datasetId: input.dataset.id,
    datasetRevision: input.dataset.revision,
    datasetManifestHash: input.dataset.manifestHash,
    baseModel: {
      providerId: baseProviderId.value,
      modelId: input.baseModel.modelId,
      revision: input.baseModel.revision,
      license: {
        licenseId: licenseId.value,
        licenseVersion: input.baseModel.license.licenseVersion,
        fineTuningAllowed: input.baseModel.license.fineTuningAllowed,
        commercialUseAllowed: input.baseModel.license.commercialUseAllowed,
        redistributionAllowed: input.baseModel.license.redistributionAllowed,
        confirmedAt: confirmedAt.value,
      },
    },
    provider: {
      location: input.provider.location,
      providerId: providerId.value,
      credentialProfileId: credentialProfileId.value,
      commercialAuthorizationId: commercialAuthorizationId.value,
    },
    method: input.method,
    hyperparameters: { ...input.hyperparameters },
    limits: { ...input.limits },
  } as const;
  return ok(
    deepFreeze({
      ...authority,
      planHash: await hashCanonicalJson(authority),
    }),
  );
}

export function runFineTuningTrainingPreflight(input: {
  readonly featureEnabled: boolean;
  readonly providerAvailable: boolean;
  readonly remoteTrainingAuthorized: boolean;
  readonly dataset: FineTuningDatasetSnapshot;
  readonly plan: FineTuningTrainingPlan;
  readonly policy: FineTuningQuotaPolicy;
  readonly usage: FineTuningQuotaUsage;
}): FineTuningTrainingPreflight {
  const checks: FineTuningPreflightCheck[] = [];
  if (!input.featureEnabled) {
    checks.push(blocking("FINE_TUNING_FEATURE_DISABLED", "微调 Feature Flag 当前关闭。"));
  }
  if (!input.providerAvailable) {
    checks.push(
      blocking("FINE_TUNING_PROVIDER_UNAVAILABLE", "没有已验证的本地训练提供方可执行该计划。"),
    );
  }
  if (input.dataset.state !== "approved") {
    checks.push(blocking("FINE_TUNING_DATASET_NOT_APPROVED", "数据集尚未通过人工治理审批。"));
  }
  if (
    input.plan.datasetId !== input.dataset.id ||
    input.plan.datasetRevision !== input.dataset.revision ||
    input.plan.datasetManifestHash !== input.dataset.manifestHash
  ) {
    checks.push(
      blocking("FINE_TUNING_DATASET_CHANGED", "训练计划绑定的数据集版本或内容清单已变化。"),
    );
  }
  if (
    !input.plan.baseModel.license.fineTuningAllowed ||
    !input.plan.baseModel.license.commercialUseAllowed
  ) {
    checks.push(
      blocking("FINE_TUNING_MODEL_LICENSE_BLOCKED", "基础模型许可证未明确允许微调和商业使用。"),
    );
  }
  if (input.plan.provider.location === "remote") {
    if (
      input.plan.provider.credentialProfileId === null ||
      input.plan.provider.commercialAuthorizationId === null ||
      !input.remoteTrainingAuthorized
    ) {
      checks.push(
        blocking(
          "FINE_TUNING_REMOTE_AUTHORIZATION_REQUIRED",
          "远端训练缺少显式凭据引用、商业授权或本次授权判定。",
        ),
      );
    }
    if (!input.policy.allowRemoteTraining) {
      checks.push(
        blocking("FINE_TUNING_REMOTE_POLICY_BLOCKED", "当前组织策略禁止将训练数据发送到远端。"),
      );
    }
  }
  if (input.dataset.totalContentBytes > input.policy.maximumDatasetBytes) {
    checks.push(blocking("FINE_TUNING_DATASET_QUOTA_EXCEEDED", "数据集字节数超过策略硬上限。"));
  }
  if (input.usage.activeJobs >= input.policy.maximumConcurrentJobs) {
    checks.push(blocking("FINE_TUNING_CONCURRENCY_EXCEEDED", "并发训练作业已达到策略硬上限。"));
  }
  if (
    input.plan.limits.maximumCostMicros > input.policy.maximumSingleJobCostMicros ||
    input.plan.limits.currency !== input.policy.currency
  ) {
    checks.push(blocking("FINE_TUNING_JOB_COST_EXCEEDED", "单次训练费用上限或币种不符合策略。"));
  }
  if (
    input.usage.spentMicros + input.usage.reservedMicros + input.plan.limits.maximumCostMicros >
    input.policy.monthlyCostLimitMicros
  ) {
    checks.push(
      blocking("FINE_TUNING_MONTHLY_QUOTA_EXCEEDED", "月度训练费用硬上限不足以完成预留。"),
    );
  }
  checks.push({
    code: "FINE_TUNING_COST_ESTIMATE",
    level: "notice",
    detail: `最多预留 ${String(input.plan.limits.maximumCostMicros)} 微单位 ${input.plan.limits.currency}；这是内部上界，不是供应商账单。`,
  });
  return deepFreeze({
    ready: !checks.some(({ level }) => level === "blocking"),
    checks,
    reservedCostMicros: input.plan.limits.maximumCostMicros,
    costSemantics: "maximum_reservation_not_provider_bill" as const,
  });
}

export function canTransitionFineTuningJob(
  current: FineTuningJobState,
  next: FineTuningJobState,
): boolean {
  const transitions: Readonly<Record<FineTuningJobState, readonly FineTuningJobState[]>> = {
    queued: ["running", "cancelled"],
    running: ["cancelling", "failed_retryable", "failed_final", "artifact_ready"],
    cancelling: ["cancelled", "failed_retryable"],
    cancelled: [],
    failed_retryable: ["queued", "cancelled"],
    failed_final: [],
    artifact_ready: [],
  };
  return transitions[current].includes(next);
}

export function assertFineTuningJobTransition(
  current: FineTuningJobState,
  next: FineTuningJobState,
): Result<void, StoryCoreError> {
  if (!canTransitionFineTuningJob(current, next)) {
    return fineTuningError(
      "FINE_TUNING_INVALID_TRANSITION",
      `Fine-tuning job cannot move from ${current} to ${next}.`,
      ["OPEN_FINE_TUNING_JOB"],
    );
  }
  return ok(undefined);
}

export function canTransitionFineTuningArtifact(
  current: FineTuningArtifactState,
  next: FineTuningArtifactState,
): boolean {
  const transitions: Readonly<Record<FineTuningArtifactState, readonly FineTuningArtifactState[]>> =
    {
      candidate: ["evaluation_failed", "evaluation_passed", "revoked"],
      evaluation_failed: ["evaluation_passed", "revoked"],
      evaluation_passed: ["registration_approved", "revoked"],
      registration_approved: ["registered", "revoked"],
      registered: ["deployment_approved", "revoked"],
      deployment_approved: ["deployed", "revoked"],
      deployed: ["rolled_back", "revoked"],
      rolled_back: ["revoked"],
      revoked: [],
    };
  return transitions[current].includes(next);
}

export function evaluateFineTuningCandidate(
  input: FineTuningEvaluationGateInput,
): Result<FineTuningEvaluationGateResult, StoryCoreError> {
  if (
    !MODEL_ID_PATTERN.test(input.baselineModelId) ||
    !MODEL_ID_PATTERN.test(input.candidateArtifactId) ||
    input.rules.length === 0 ||
    input.rules.length > 64
  ) {
    return validationError("Fine-tuning evaluation identity or rule count is invalid.");
  }
  const baseline = parseMetrics(input.baseline, "baseline");
  const candidate = parseMetrics(input.candidate, "candidate");
  if (!baseline.ok) return baseline;
  if (!candidate.ok) return candidate;
  if (
    baseline.value.size !== candidate.value.size ||
    [...baseline.value.keys()].some((metric) => !candidate.value.has(metric))
  ) {
    return validationError("Baseline and candidate evaluations must contain the same metrics.");
  }

  const usedRules = new Set<string>();
  const observations: FineTuningEvaluationObservation[] = [];
  for (const rule of input.rules) {
    const metric = parseSafeIdentifier(rule.metric);
    if (!metric.ok || usedRules.has(metric.value)) {
      return validationError("Evaluation rules contain an invalid or duplicate metric.");
    }
    usedRules.add(metric.value);
    const baselineScore = baseline.value.get(metric.value);
    const candidateScore = candidate.value.get(metric.value);
    if (baselineScore === undefined || candidateScore === undefined || !validEvaluationRule(rule)) {
      return validationError("An evaluation rule references an unavailable or invalid metric.");
    }
    const signedImprovement =
      rule.direction === "higher_is_better"
        ? candidateScore - baselineScore
        : baselineScore - candidateScore;
    const reasons: string[] = [];
    if (rule.minimumCandidate !== undefined && candidateScore < rule.minimumCandidate) {
      reasons.push("candidate_below_minimum");
    }
    if (rule.maximumCandidate !== undefined && candidateScore > rule.maximumCandidate) {
      reasons.push("candidate_above_maximum");
    }
    if (rule.minimumImprovement !== undefined && signedImprovement < rule.minimumImprovement) {
      reasons.push("improvement_below_minimum");
    }
    if (rule.maximumRegression !== undefined && signedImprovement < -rule.maximumRegression) {
      reasons.push("regression_above_maximum");
    }
    observations.push(
      deepFreeze({
        metric: metric.value,
        baseline: baselineScore,
        candidate: candidateScore,
        signedImprovement,
        passed: reasons.length === 0,
        reasons,
      }),
    );
  }
  return ok(
    deepFreeze({
      passed: observations.every(({ passed }) => passed),
      baselineModelId: input.baselineModelId,
      candidateArtifactId: input.candidateArtifactId,
      observations,
    }),
  );
}

export async function computeFineTuningEvaluationAuthorityHash(
  input: FineTuningEvaluationGateInput,
  result: FineTuningEvaluationGateResult,
): Promise<string> {
  return hashCanonicalJson({ input, result });
}

/**
 * Hashes an already-minimized governance authority object. Callers must pass
 * hashes and metadata only; sample text is never needed for operation claims,
 * approvals, audit events, or provider commands.
 */
export async function computeFineTuningGovernanceHash(value: unknown): Promise<string> {
  return hashCanonicalJson(value);
}

async function parseSampleDraft(
  draft: FineTuningSampleDraft,
  projectId: UuidV7,
): Promise<Result<FineTuningDatasetSample, StoryCoreError>> {
  const id = parseUuidV7(draft.id);
  const sourceProjectId = parseUuidV7(draft.source.projectId);
  const entityId = parseUuidV7(draft.source.entityId);
  const label = validateText(draft.source.label, 1, 300, "Fine-tuning source label");
  const content = validateContent(draft.content);
  const basis = validateText(draft.rights.basis, 1, 1_000, "Fine-tuning rights basis");
  const confirmedAt =
    draft.rights.confirmedAt === null ? ok(null) : parseIsoUtcTimestamp(draft.rights.confirmedAt);
  if (!id.ok) return id;
  if (!sourceProjectId.ok) return sourceProjectId;
  if (!entityId.ok) return entityId;
  if (!label.ok) return label;
  if (!content.ok) return content;
  if (!basis.ok) return basis;
  if (!confirmedAt.ok) return confirmedAt;
  if (
    sourceProjectId.value !== projectId ||
    !FINE_TUNING_SOURCE_KINDS.includes(draft.source.kind) ||
    !Number.isSafeInteger(draft.source.entityRevision) ||
    draft.source.entityRevision < 1 ||
    !FINE_TUNING_RIGHTS_KINDS.includes(draft.rights.kind) ||
    typeof draft.rights.allowTraining !== "boolean"
  ) {
    return validationError("Fine-tuning source authority or rights declaration is invalid.");
  }
  const contentHash = await sha256Hex(content.value);
  if (
    draft.expectedContentHash !== undefined &&
    (!SHA256_PATTERN.test(draft.expectedContentHash) || draft.expectedContentHash !== contentHash)
  ) {
    return fineTuningError(
      "FINE_TUNING_SOURCE_CHANGED",
      "A fine-tuning source changed before the dataset manifest was created.",
      ["RECOMPARE"],
      true,
    );
  }
  const privacy = scanFineTuningPrivacy(content.value);
  return ok(
    deepFreeze({
      id: id.value,
      source: {
        kind: draft.source.kind,
        projectId: sourceProjectId.value,
        entityId: entityId.value,
        entityRevision: draft.source.entityRevision,
        label: label.value,
      },
      content: content.value,
      contentHash,
      contentBytes: new TextEncoder().encode(content.value).byteLength,
      rights: {
        kind: draft.rights.kind,
        basis: basis.value,
        confirmedAt: confirmedAt.value,
        allowTraining: draft.rights.allowTraining,
      },
      privacy,
      split: "excluded",
      duplicateOfSampleId: null,
    }),
  );
}

function buildDatasetReadinessIssues(
  samples: readonly FineTuningDatasetSample[],
): readonly FineTuningDatasetReadinessIssue[] {
  const issues: FineTuningDatasetReadinessIssue[] = [];
  const included = samples.filter(({ split }) => split !== "excluded");
  if (included.length < FINE_TUNING_MINIMUM_INCLUDED_SAMPLES) {
    issues.push({
      code: "FINE_TUNING_SAMPLE_COUNT_TOO_LOW",
      sampleId: null,
      detail: `At least ${String(FINE_TUNING_MINIMUM_INCLUDED_SAMPLES)} unique samples are required.`,
    });
  }
  for (const sample of included) {
    if (sample.rights.kind === "unknown" || sample.rights.confirmedAt === null) {
      issues.push({
        code: "FINE_TUNING_RIGHTS_UNCONFIRMED",
        sampleId: sample.id,
        detail: "The sample has no confirmed copyright or license basis.",
      });
    } else if (!sample.rights.allowTraining) {
      issues.push({
        code: "FINE_TUNING_TRAINING_NOT_ALLOWED",
        sampleId: sample.id,
        detail: "The source declaration does not allow training.",
      });
    }
    if (!sample.privacy.passed) {
      issues.push({
        code: "FINE_TUNING_PRIVACY_BLOCKED",
        sampleId: sample.id,
        detail: "PII or sensitive data must be redacted at the source before approval.",
      });
    }
  }
  const counts = countSplits(samples);
  if (counts.train === 0 || counts.validation === 0 || counts.test === 0) {
    issues.push({
      code: "FINE_TUNING_SPLIT_INCOMPLETE",
      sampleId: null,
      detail: "Train, validation, and test partitions must all contain a unique sample.",
    });
  }
  return Object.freeze(issues.map((issue) => Object.freeze(issue)));
}

async function assignDeterministicSplits(
  samples: readonly FineTuningDatasetSample[],
  policy: FineTuningSplitPolicy,
): Promise<ReadonlyMap<UuidV7, Exclude<FineTuningSplit, "excluded">>> {
  const ordered = await Promise.all(
    samples.map(async (sample) => ({
      id: sample.id,
      order: await sha256Hex(`${policy.seed}\u0000${sample.contentHash}`),
    })),
  );
  ordered.sort(
    (left, right) => left.order.localeCompare(right.order) || left.id.localeCompare(right.id),
  );
  const totalParts = policy.trainParts + policy.validationParts + policy.testParts;
  const counts = allocateSplitCounts(ordered.length, policy, totalParts);
  const result = new Map<UuidV7, Exclude<FineTuningSplit, "excluded">>();
  ordered.forEach(({ id }, index) => {
    const split =
      index < counts.train
        ? "train"
        : index < counts.train + counts.validation
          ? "validation"
          : "test";
    result.set(id, split);
  });
  return result;
}

function allocateSplitCounts(
  count: number,
  policy: FineTuningSplitPolicy,
  totalParts: number,
): Readonly<Record<Exclude<FineTuningSplit, "excluded">, number>> {
  if (count < 3) {
    return Object.freeze({
      train: Math.min(1, count),
      validation: count >= 2 ? 1 : 0,
      test: count >= 3 ? count - 2 : 0,
    });
  }
  const validation = Math.max(1, Math.floor((count * policy.validationParts) / totalParts));
  const test = Math.max(1, Math.floor((count * policy.testParts) / totalParts));
  return Object.freeze({
    train: Math.max(1, count - validation - test),
    validation,
    test: count - Math.max(1, count - validation - test) - validation,
  });
}

function countSplits(
  samples: readonly FineTuningDatasetSample[],
): Readonly<Record<Exclude<FineTuningSplit, "excluded">, number>> {
  return Object.freeze({
    train: samples.filter(({ split }) => split === "train").length,
    validation: samples.filter(({ split }) => split === "validation").length,
    test: samples.filter(({ split }) => split === "test").length,
  });
}

function datasetManifestAuthority(input: {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly name: string;
  readonly revision: number;
  readonly splitPolicy: FineTuningSplitPolicy;
  readonly samples: readonly FineTuningDatasetSample[];
}): unknown {
  return {
    schemaVersion: FINE_TUNING_GOVERNANCE_SCHEMA_VERSION,
    id: input.id,
    projectId: input.projectId,
    name: input.name,
    revision: input.revision,
    splitPolicy: input.splitPolicy,
    samples: input.samples.map((sample) => ({
      id: sample.id,
      source: sample.source,
      contentHash: sample.contentHash,
      contentBytes: sample.contentBytes,
      rights: sample.rights,
      privacy: sample.privacy,
      split: sample.split,
      duplicateOfSampleId: sample.duplicateOfSampleId,
    })),
  };
}

function validateSplitPolicy(input: {
  readonly seed: string;
  readonly trainParts: number;
  readonly validationParts: number;
  readonly testParts: number;
}): Result<FineTuningSplitPolicy, StoryCoreError> {
  const seed = parseSafeIdentifier(input.seed);
  if (!seed.ok) return seed;
  if (
    ![input.trainParts, input.validationParts, input.testParts].every(
      (part) => Number.isSafeInteger(part) && part >= 1 && part <= 10_000,
    )
  ) {
    return validationError("Fine-tuning split weights must be positive bounded integers.");
  }
  return ok(Object.freeze({ ...input, seed: seed.value }));
}

function validateContent(value: unknown): Result<string, StoryCoreError> {
  return validateText(value, 1, FINE_TUNING_MAXIMUM_SAMPLE_LENGTH, "Fine-tuning sample content");
}

function validateText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  field: string,
): Result<string, StoryCoreError> {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    UNSAFE_TEXT_PATTERN.test(value)
  ) {
    return validationError(`${field} is empty, unsafe, or exceeds its length boundary.`);
  }
  const normalized = value.normalize("NFC");
  if (
    normalized.length < minimumLength ||
    normalized.length > maximumLength ||
    normalized.trim().length === 0
  ) {
    return validationError(`${field} is invalid after Unicode normalization.`);
  }
  return ok(normalized);
}

function parseNullableIdentifier(
  value: string | null | undefined,
): Result<SafeIdentifier | null, StoryCoreError> {
  if (value === null || value === undefined) {
    return ok(null);
  }
  return parseSafeIdentifier(value);
}

function validHyperparameters(value: FineTuningTrainingPlan["hyperparameters"]): boolean {
  return (
    Number.isSafeInteger(value.rank) &&
    value.rank >= 1 &&
    value.rank <= 512 &&
    Number.isSafeInteger(value.alpha) &&
    value.alpha >= 1 &&
    value.alpha <= 4_096 &&
    Number.isFinite(value.dropout) &&
    value.dropout >= 0 &&
    value.dropout <= 0.5 &&
    Number.isFinite(value.learningRate) &&
    value.learningRate > 0 &&
    value.learningRate <= 1 &&
    Number.isSafeInteger(value.epochs) &&
    value.epochs >= 1 &&
    value.epochs <= 100
  );
}

function validLimits(value: FineTuningTrainingPlan["limits"]): boolean {
  return (
    Number.isSafeInteger(value.maximumDurationMs) &&
    value.maximumDurationMs >= 60_000 &&
    value.maximumDurationMs <= 30 * 24 * 60 * 60 * 1_000 &&
    Number.isSafeInteger(value.maximumCostMicros) &&
    value.maximumCostMicros >= 0 &&
    Number.isSafeInteger(value.estimatedCostMicros) &&
    value.estimatedCostMicros >= 0 &&
    value.estimatedCostMicros <= value.maximumCostMicros &&
    Number.isSafeInteger(value.estimatedGpuMinutes) &&
    value.estimatedGpuMinutes >= 0 &&
    value.estimatedGpuMinutes <= 1_000_000 &&
    CURRENCY_PATTERN.test(value.currency)
  );
}

function parseMetrics(
  metrics: readonly FineTuningEvaluationMetric[],
  label: string,
): Result<ReadonlyMap<SafeIdentifier, number>, StoryCoreError> {
  if (metrics.length === 0 || metrics.length > 64) {
    return validationError(`Fine-tuning ${label} metric count is invalid.`);
  }
  const result = new Map<SafeIdentifier, number>();
  for (const metric of metrics) {
    const name = parseSafeIdentifier(metric.name);
    if (
      !name.ok ||
      result.has(name.value) ||
      !Number.isFinite(metric.score) ||
      metric.score < 0 ||
      metric.score > 1
    ) {
      return validationError(`Fine-tuning ${label} metrics are invalid or duplicated.`);
    }
    result.set(name.value, metric.score);
  }
  return ok(result);
}

function validEvaluationRule(rule: FineTuningEvaluationRule): boolean {
  return (
    [rule.minimumCandidate, rule.maximumCandidate].every(
      (value) => value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1),
    ) &&
    [rule.minimumImprovement, rule.maximumRegression].every(
      (value) => value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1),
    )
  );
}

function blocking(
  code: Exclude<FineTuningPreflightCheck["code"], "FINE_TUNING_COST_ESTIMATE">,
  detail: string,
): FineTuningPreflightCheck {
  return Object.freeze({ code, level: "blocking", detail });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashCanonicalJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}

function validationError(message: string): Result<never, StoryCoreError> {
  return fineTuningError("FINE_TUNING_VALIDATION_FAILED", message);
}

function fineTuningError(
  code:
    | "FINE_TUNING_VALIDATION_FAILED"
    | "FINE_TUNING_SOURCE_CHANGED"
    | "FINE_TUNING_DATASET_CHANGED"
    | "FINE_TUNING_HUMAN_APPROVAL_REQUIRED"
    | "FINE_TUNING_INVALID_TRANSITION",
  message: string,
  actions: readonly ("RECOMPARE" | "REVIEW_FINE_TUNING_GOVERNANCE" | "OPEN_FINE_TUNING_JOB")[] = [],
  retryable = false,
): Result<never, StoryCoreError> {
  return err(new StoryCoreError({ code, message, actions, retryable }));
}
