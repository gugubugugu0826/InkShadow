import type {
  CloudTeamTemplateCiphertextEnvelope,
  CloudTeamTemplateState,
} from "@inkshadow/contracts";

export interface CloudTeamTemplateRecord {
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly createdByMembershipId: string;
  readonly latestVersionNumber: number;
  readonly projectId: string;
  readonly publishedAt: Date | null;
  readonly publishedVersionNumber: number | null;
  readonly revision: number;
  readonly state: CloudTeamTemplateState;
  readonly teamId: string;
  readonly templateId: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface CloudTeamTemplateVersionRecord {
  readonly authorAccountId: string;
  readonly authorDeviceId: string;
  readonly authorMembershipId: string;
  readonly clonedFromTemplateId: string | null;
  readonly clonedFromVersionId: string | null;
  readonly createdAt: Date;
  readonly payload: CloudTeamTemplateCiphertextEnvelope;
  readonly projectId: string;
  readonly projectKeyVersion: number;
  readonly teamId: string;
  readonly templateId: string;
  readonly tenantId: string;
  readonly versionId: string;
  readonly versionNumber: number;
}

export interface CloudTeamTemplateApplicationRecord {
  readonly applicationId: string;
  readonly appliedAt: Date;
  readonly appliedByAccountId: string;
  readonly appliedByMembershipId: string;
  readonly projectId: string;
  readonly teamId: string;
  readonly templateId: string;
  readonly tenantId: string;
  readonly versionId: string;
}
