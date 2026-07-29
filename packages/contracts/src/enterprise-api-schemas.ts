import { z } from "zod";

import {
  CloudDeviceRegistrationInputSchema,
  CloudOpaqueTokenSchema,
  CloudSessionGrantResponseSchema,
} from "./cloud-api-schemas.js";
import { CONTRACT_SCHEMA_VERSION, IsoUtcTimestampSchema, UuidV7Schema } from "./schemas.js";

export const CloudEnterpriseDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
  );

export const CloudEnterpriseExternalHostSchema = CloudEnterpriseDomainSchema;
export const CloudEnterpriseDeviceFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const CloudEnterpriseSsoModeSchema = z.enum(["optional", "required"]);
export const CloudEnterpriseDeviceApprovalModeSchema = z.enum([
  "trusted_device",
  "approved_fingerprint",
]);
export const CloudEnterpriseExportModeSchema = z.enum(["allowed", "owners_and_admins", "blocked"]);
export const CloudEnterpriseExternalEgressModeSchema = z.enum(["allowlisted", "blocked"]);
export const CloudEnterpriseSupportBundleModeSchema = z.enum(["owners_and_admins", "all_members"]);

const SortedUniqueDomainsSchema = z
  .array(CloudEnterpriseDomainSchema)
  .min(1)
  .max(64)
  .refine(isStrictlySortedUnique, {
    message: "Enterprise domains must be unique and sorted",
  });

const SortedUniqueHostsSchema = z
  .array(CloudEnterpriseExternalHostSchema)
  .max(128)
  .refine(isStrictlySortedUnique, {
    message: "Enterprise external hosts must be unique and sorted",
  });

const SortedUniqueFingerprintsSchema = z
  .array(CloudEnterpriseDeviceFingerprintSchema)
  .max(1_024)
  .refine(isStrictlySortedUnique, {
    message: "Enterprise device fingerprints must be unique and sorted",
  });

const EnterprisePolicyFieldsSchema = z
  .object({
    ssoMode: CloudEnterpriseSsoModeSchema,
    allowedEmailDomains: SortedUniqueDomainsSchema,
    sessionMaximumMinutes: z.number().int().min(15).max(43_200),
    maximumTrustedDevices: z.number().int().min(1).max(100),
    deviceApprovalMode: CloudEnterpriseDeviceApprovalModeSchema,
    approvedDeviceFingerprints: SortedUniqueFingerprintsSchema,
    exportMode: CloudEnterpriseExportModeSchema,
    externalEgressMode: CloudEnterpriseExternalEgressModeSchema,
    allowedExternalHosts: SortedUniqueHostsSchema,
    supportBundleMode: CloudEnterpriseSupportBundleModeSchema,
  })
  .strict()
  .superRefine(validatePolicyCombination);

export const CloudEnterprisePolicySchema = EnterprisePolicyFieldsSchema.extend({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  tenantId: UuidV7Schema,
  teamId: UuidV7Schema,
  revision: z.number().int().positive().max(2_147_483_647),
  createdAt: IsoUtcTimestampSchema,
  updatedAt: IsoUtcTimestampSchema,
}).strict();

export const CloudEnterprisePolicyUpdateRequestSchema = EnterprisePolicyFieldsSchema.extend({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  expectedRevision: z.number().int().positive().max(2_147_483_647).nullable(),
}).strict();

export const CloudEnterprisePolicyResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    policy: CloudEnterprisePolicySchema,
  })
  .strict();

export const CloudEnterprisePolicyActionSchema = z.enum([
  "create_session",
  "export",
  "external_egress",
  "support_bundle",
]);

export const CloudEnterprisePolicyEvaluationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    action: CloudEnterprisePolicyActionSchema,
    externalHost: CloudEnterpriseExternalHostSchema.nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.action === "external_egress") !== (request.externalHost !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only external-egress evaluations accept an external host",
        path: ["externalHost"],
      });
    }
  });

export const CloudEnterprisePolicyDecisionReasonSchema = z.enum([
  "allowed",
  "device_not_approved",
  "device_limit_exceeded",
  "export_blocked",
  "export_role_forbidden",
  "external_egress_blocked",
  "external_host_not_allowlisted",
  "support_role_forbidden",
]);

export const CloudEnterprisePolicyEvaluationResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    policyRevision: z.number().int().positive().max(2_147_483_647),
    action: CloudEnterprisePolicyActionSchema,
    allowed: z.boolean(),
    reason: CloudEnterprisePolicyDecisionReasonSchema,
  })
  .strict()
  .refine((response) => response.allowed === (response.reason === "allowed"), {
    message: "Enterprise policy decision and reason must agree",
    path: ["reason"],
  });

export const CloudEnterpriseRedirectUriSchema = z
  .string()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Redirect URI is invalid" });
      return;
    }
    if (
      !["https:", "inkshadow:"].includes(parsed.protocol) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        message: "Redirect URI must use HTTPS or the InkShadow private-use scheme",
      });
    }
  });

export const CloudEnterpriseSsoAuthorizationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    teamId: UuidV7Schema,
    redirectUri: CloudEnterpriseRedirectUriSchema,
    device: CloudDeviceRegistrationInputSchema,
  })
  .strict();

export const CloudEnterpriseSsoAuthorizationResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    teamId: UuidV7Schema,
    flowId: UuidV7Schema,
    flowSecret: CloudOpaqueTokenSchema,
    authorizationUrl: z.url().max(4_096),
    expiresAt: IsoUtcTimestampSchema,
  })
  .strict()
  .refine((response) => new URL(response.authorizationUrl).protocol === "https:", {
    message: "OIDC authorization URL must use HTTPS",
    path: ["authorizationUrl"],
  });

export const CloudEnterpriseAuthorizationCodeSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Authorization code cannot contain control characters",
  });

export const CloudEnterpriseOidcStateSchema = z.string().regex(/^[A-Za-z0-9_-]{43,512}$/u);

export const CloudEnterpriseSsoCallbackRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    flowId: UuidV7Schema,
    flowSecret: CloudOpaqueTokenSchema,
    state: CloudEnterpriseOidcStateSchema,
    code: CloudEnterpriseAuthorizationCodeSchema,
    redirectUri: CloudEnterpriseRedirectUriSchema,
    device: CloudDeviceRegistrationInputSchema,
  })
  .strict();

export const CloudEnterpriseSsoSessionResponseSchema = CloudSessionGrantResponseSchema.extend({
  enterprise: z
    .object({
      teamId: UuidV7Schema,
      policyRevision: z.number().int().positive().max(2_147_483_647),
      authenticationMethod: z.literal("oidc"),
    })
    .strict(),
}).strict();

export const CloudEnterpriseSsoStatusResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    teamId: UuidV7Schema,
    configured: z.literal(true),
    issuer: z.url().max(2_048),
    allowedRedirectUris: z.array(CloudEnterpriseRedirectUriSchema).min(1).max(16),
    metadataCacheSeconds: z.number().int().min(60).max(3_600),
    licenseValidUntil: IsoUtcTimestampSchema,
  })
  .strict()
  .refine((response) => new URL(response.issuer).protocol === "https:", {
    message: "OIDC issuer must use HTTPS",
    path: ["issuer"],
  });

export type CloudEnterprisePolicy = z.infer<typeof CloudEnterprisePolicySchema>;
export type CloudEnterprisePolicyUpdateRequest = z.infer<
  typeof CloudEnterprisePolicyUpdateRequestSchema
>;
export type CloudEnterprisePolicyResponse = z.infer<typeof CloudEnterprisePolicyResponseSchema>;
export type CloudEnterprisePolicyAction = z.infer<typeof CloudEnterprisePolicyActionSchema>;
export type CloudEnterprisePolicyEvaluationRequest = z.infer<
  typeof CloudEnterprisePolicyEvaluationRequestSchema
>;
export type CloudEnterprisePolicyEvaluationResponse = z.infer<
  typeof CloudEnterprisePolicyEvaluationResponseSchema
>;
export type CloudEnterprisePolicyDecisionReason = z.infer<
  typeof CloudEnterprisePolicyDecisionReasonSchema
>;
export type CloudEnterpriseSsoAuthorizationRequest = z.infer<
  typeof CloudEnterpriseSsoAuthorizationRequestSchema
>;
export type CloudEnterpriseSsoAuthorizationResponse = z.infer<
  typeof CloudEnterpriseSsoAuthorizationResponseSchema
>;
export type CloudEnterpriseSsoCallbackRequest = z.infer<
  typeof CloudEnterpriseSsoCallbackRequestSchema
>;
export type CloudEnterpriseSsoSessionResponse = z.infer<
  typeof CloudEnterpriseSsoSessionResponseSchema
>;
export type CloudEnterpriseSsoStatusResponse = z.infer<
  typeof CloudEnterpriseSsoStatusResponseSchema
>;

function validatePolicyCombination(
  policy: z.infer<typeof EnterprisePolicyFieldsSchema>,
  context: z.RefinementCtx,
): void {
  if (
    policy.deviceApprovalMode === "approved_fingerprint" &&
    policy.approvedDeviceFingerprints.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Fingerprint approval requires at least one approved device",
      path: ["approvedDeviceFingerprints"],
    });
  }
  if (policy.externalEgressMode === "allowlisted" && policy.allowedExternalHosts.length === 0) {
    context.addIssue({
      code: "custom",
      message: "Allowlisted external egress requires at least one host",
      path: ["allowedExternalHosts"],
    });
  }
  if (policy.externalEgressMode === "blocked" && policy.allowedExternalHosts.length !== 0) {
    context.addIssue({
      code: "custom",
      message: "Blocked external egress cannot retain allowed hosts",
      path: ["allowedExternalHosts"],
    });
  }
  if (
    policy.deviceApprovalMode === "trusted_device" &&
    policy.approvedDeviceFingerprints.length !== 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Trusted-device mode cannot retain approved fingerprints",
      path: ["approvedDeviceFingerprints"],
    });
  }
}

function isStrictlySortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous >= current) {
      return false;
    }
  }
  return true;
}
