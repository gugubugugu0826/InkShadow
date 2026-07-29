import type {
  CloudProjectAssignmentState,
  CloudTeamInvitationRole,
  CloudTeamInvitationState,
  CloudTeamMembership,
  CloudTeamMembershipState,
  CloudTeamState,
} from "@inkshadow/contracts";

export interface CloudTeamRecord {
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly displayName: string;
  readonly revision: number;
  readonly state: CloudTeamState;
  readonly teamId: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface CloudTeamMembershipRecord {
  readonly accountId: string;
  readonly createdAt: Date;
  readonly membershipId: string;
  readonly revision: number;
  readonly revokedAt: Date | null;
  readonly role: CloudTeamMembership["role"];
  readonly state: CloudTeamMembershipState;
  readonly teamId: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface CloudTeamInvitationRecord {
  readonly acceptedAt: Date | null;
  readonly acceptedMembershipId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly invitationId: string;
  readonly invitedByMembershipId: string;
  readonly inviteeEmail: string;
  readonly revision: number;
  readonly revokedAt: Date | null;
  readonly role: CloudTeamInvitationRole;
  readonly state: CloudTeamInvitationState;
  readonly teamId: string;
  readonly tenantId: string;
  readonly tokenHashSha256: string;
  readonly updatedAt: Date;
}

export interface CloudProjectAssignmentRecord {
  readonly assignmentId: string;
  readonly createdAt: Date;
  readonly grantedByMembershipId: string;
  readonly membershipId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly revokedAt: Date | null;
  readonly revokedByMembershipId: string | null;
  readonly state: CloudProjectAssignmentState;
  readonly teamId: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface CloudTeamAuditEventRecord {
  readonly action: string;
  readonly actorAccountId: string;
  readonly actorMembershipId: string | null;
  readonly createdAt: Date;
  readonly eventId: string;
  readonly reason: string;
  readonly redactedDiff: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly resourceId: string | null;
  readonly resourceType:
    | "invitation"
    | "membership"
    | "project_assignment"
    | "project_key_envelope"
    | "review_submission"
    | "review_thread"
    | "review_thread_item"
    | "team_template"
    | "team_template_application"
    | "team_template_version"
    | "team";
  readonly result: "allowed" | "denied" | "failed";
  readonly teamId: string;
  readonly tenantId: string;
}

export interface CloudTeamProjectKeyVersionRecord {
  readonly keyVersion: number;
  readonly projectId: string;
  readonly serverRevision: number;
  readonly state: "active" | "retired" | "retiring";
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface CloudTeamProjectKeyEnvelopeRecord {
  readonly algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM";
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly ciphertext: string;
  readonly createdAt: Date;
  readonly encapsulatedKey: string;
  readonly envelopeId: string;
  readonly invalidatedAt: Date | null;
  readonly invalidationReason:
    | "assignment_changed"
    | "membership_changed"
    | "project_changed"
    | "project_key_changed"
    | "recipient_device_changed"
    | "team_changed"
    | null;
  readonly keyVersion: number;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly projectId: string;
  readonly recipientAccountId: string;
  readonly recipientDeviceId: string;
  readonly recipientDeviceRevision: number;
  readonly recipientPublicKey: string;
  readonly recipientPublicKeyFingerprint: string;
  readonly senderAccountId: string;
  readonly senderDeviceId: string;
  readonly senderDeviceRevision: number;
  readonly senderMembershipId: string;
  readonly senderMembershipRevision: number;
  readonly senderPublicKey: string;
  readonly senderPublicKeyFingerprint: string;
  readonly serverRevision: number;
  readonly teamId: string;
  readonly tenantId: string;
}
