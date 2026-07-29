import type {
  CloudTeamInvitationRole,
  CloudTeamInvitationState,
  CloudTeamState,
} from "@inkshadow/contracts";

export type TeamInvitationOutboxState =
  "cancelled" | "dead_letter" | "delivered" | "leased" | "pending";

export interface TeamInvitationOutboxRecord {
  readonly attemptCount: number;
  readonly availableAt: Date;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  readonly deliveryId: string;
  readonly encryptionKeyId: string;
  readonly invitationId: string;
  readonly lastErrorCode: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly leaseOwner: string | null;
  readonly revision: number;
  readonly state: TeamInvitationOutboxState;
  readonly teamId: string;
  readonly tenantId: string;
  readonly tokenAuthTag: Buffer;
  readonly tokenCiphertext: Buffer;
  readonly tokenNonce: Buffer;
  readonly updatedAt: Date;
}

export interface ClaimedTeamInvitationOutboxRecord extends TeamInvitationOutboxRecord {
  readonly invitationExpiresAt: Date;
  readonly invitationRole: CloudTeamInvitationRole;
  readonly invitationState: CloudTeamInvitationState;
  readonly inviteeEmail: string;
  readonly teamDisplayName: string;
  readonly teamState: CloudTeamState;
}
