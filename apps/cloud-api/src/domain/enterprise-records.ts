import type {
  CloudEnterpriseDeviceApprovalModeSchema,
  CloudEnterpriseExportModeSchema,
  CloudEnterpriseExternalEgressModeSchema,
  CloudEnterpriseSsoModeSchema,
  CloudEnterpriseSupportBundleModeSchema,
} from "@inkshadow/contracts";
import type { z } from "zod";

export interface CloudEnterprisePolicyRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly revision: number;
  readonly ssoMode: z.infer<typeof CloudEnterpriseSsoModeSchema>;
  readonly allowedEmailDomains: readonly string[];
  readonly sessionMaximumMinutes: number;
  readonly maximumTrustedDevices: number;
  readonly deviceApprovalMode: z.infer<typeof CloudEnterpriseDeviceApprovalModeSchema>;
  readonly approvedDeviceFingerprints: readonly string[];
  readonly exportMode: z.infer<typeof CloudEnterpriseExportModeSchema>;
  readonly externalEgressMode: z.infer<typeof CloudEnterpriseExternalEgressModeSchema>;
  readonly allowedExternalHosts: readonly string[];
  readonly supportBundleMode: z.infer<typeof CloudEnterpriseSupportBundleModeSchema>;
  readonly createdByMembershipId: string;
  readonly updatedByMembershipId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CloudEnterprisePublicSsoPolicyRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly revision: number;
  readonly ssoMode: CloudEnterprisePolicyRecord["ssoMode"];
  readonly allowedEmailDomains: readonly string[];
  readonly sessionMaximumMinutes: number;
  readonly maximumTrustedDevices: number;
  readonly deviceApprovalMode: CloudEnterprisePolicyRecord["deviceApprovalMode"];
  readonly approvedDeviceFingerprints: readonly string[];
}

export interface CloudEnterpriseOidcFlowRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly flowId: string;
  readonly policyRevision: number;
  readonly sessionMaximumMinutes: number;
  readonly maximumTrustedDevices: number;
  readonly flowSecretHashSha256: string;
  readonly stateHashSha256: string;
  readonly redirectUri: string;
  readonly deviceBindingHashSha256: string;
  readonly exchangeClaimId: string | null;
  readonly exchangeStartedAt: Date | null;
  readonly attemptCount: number;
  readonly verifiedAccountId: string | null;
  readonly verifiedMembershipId: string | null;
  readonly subjectHashSha256: string | null;
  readonly completionIdempotencyKeyHashSha256: string | null;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface CloudEnterpriseOidcBindingRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly issuerHashSha256: string;
  readonly subjectHashSha256: string;
  readonly accountId: string;
  readonly membershipId: string;
  readonly createdAt: Date;
  readonly lastAuthenticatedAt: Date;
}

export interface CloudEnterpriseMemberRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly accountId: string;
  readonly membershipId: string;
  readonly role: "owner" | "admin" | "author" | "reviewer" | "read_only" | "finance_admin";
}
