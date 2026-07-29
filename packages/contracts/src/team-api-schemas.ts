import { z } from "zod";

import { PositivePortableIntegerSchema, TeamRoleSchema } from "./cloud-schemas.js";
import {
  CloudCursorSchema,
  CloudEmailAddressSchema,
  CloudOpaqueTokenSchema,
} from "./cloud-api-schemas.js";
import { CONTRACT_SCHEMA_VERSION, IsoUtcTimestampSchema, UuidV7Schema } from "./schemas.js";

const MAX_PAGE_SIZE = 1_024;

export const CloudTeamDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !/\p{Cc}/u.test(value), {
    message: "Team display name cannot contain control characters",
  });

export const CloudTeamStateSchema = z.enum(["active", "archived"]);
export const CloudTeamMembershipStateSchema = z.enum(["active", "revoked"]);
export const CloudTeamInvitationStateSchema = z.enum(["pending", "accepted", "revoked", "expired"]);
export const CloudProjectAssignmentStateSchema = z.enum(["active", "revoked"]);

/**
 * Ownership is granted through an authenticated, revision-checked role change.
 * It is deliberately impossible to bootstrap an owner through an invitation.
 */
export const CloudTeamInvitationRoleSchema = z.enum([
  "admin",
  "author",
  "reviewer",
  "read_only",
  "finance_admin",
]);

export const CloudTeamSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    teamId: UuidV7Schema,
    tenantId: UuidV7Schema,
    displayName: CloudTeamDisplayNameSchema,
    state: CloudTeamStateSchema,
    revision: PositivePortableIntegerSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
    archivedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((team, context) => {
    requireTimestampOrder(team.createdAt, team.updatedAt, context, ["updatedAt"]);
    if ((team.state === "archived") !== (team.archivedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Archived team state and archivedAt must agree",
        path: ["archivedAt"],
      });
    }
    if (team.archivedAt !== null) {
      requireTimestampOrder(team.createdAt, team.archivedAt, context, ["archivedAt"]);
      requireTimestampOrder(team.archivedAt, team.updatedAt, context, ["updatedAt"]);
    }
  });

export const CloudTeamMembershipSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    membershipId: UuidV7Schema,
    accountId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    role: TeamRoleSchema,
    state: CloudTeamMembershipStateSchema,
    revision: PositivePortableIntegerSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
    revokedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((membership, context) => {
    requireTimestampOrder(membership.createdAt, membership.updatedAt, context, ["updatedAt"]);
    if ((membership.state === "revoked") !== (membership.revokedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Revoked membership state and revokedAt must agree",
        path: ["revokedAt"],
      });
    }
    if (membership.revokedAt !== null) {
      requireTimestampOrder(membership.createdAt, membership.revokedAt, context, ["revokedAt"]);
      requireTimestampOrder(membership.revokedAt, membership.updatedAt, context, ["updatedAt"]);
    }
  });

export const CloudTeamInvitationSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    invitationId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    inviteeEmail: CloudEmailAddressSchema,
    role: CloudTeamInvitationRoleSchema,
    state: CloudTeamInvitationStateSchema,
    revision: PositivePortableIntegerSchema,
    invitedByMembershipId: UuidV7Schema,
    acceptedMembershipId: UuidV7Schema.nullable(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
    acceptedAt: IsoUtcTimestampSchema.nullable(),
    revokedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((invitation, context) => {
    requireTimestampOrder(invitation.createdAt, invitation.updatedAt, context, ["updatedAt"]);
    requireStrictTimestampOrder(invitation.createdAt, invitation.expiresAt, context, ["expiresAt"]);

    const hasAcceptedFields =
      invitation.acceptedAt !== null && invitation.acceptedMembershipId !== null;
    const hasNoAcceptedFields =
      invitation.acceptedAt === null && invitation.acceptedMembershipId === null;

    if (
      (invitation.state === "accepted" && !hasAcceptedFields) ||
      (invitation.state !== "accepted" && !hasNoAcceptedFields)
    ) {
      context.addIssue({
        code: "custom",
        message: "Accepted invitation state, acceptedAt and acceptedMembershipId must agree",
        path: ["acceptedAt"],
      });
    }
    if ((invitation.state === "revoked") !== (invitation.revokedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Revoked invitation state and revokedAt must agree",
        path: ["revokedAt"],
      });
    }

    if (invitation.state === "pending") {
      requireStrictTimestampOrder(invitation.updatedAt, invitation.expiresAt, context, [
        "updatedAt",
      ]);
    }
    if (invitation.state === "accepted" && invitation.acceptedAt !== null) {
      requireTimestampOrder(invitation.createdAt, invitation.acceptedAt, context, ["acceptedAt"]);
      requireTimestampOrder(invitation.acceptedAt, invitation.updatedAt, context, ["updatedAt"]);
      requireTimestampOrder(invitation.acceptedAt, invitation.expiresAt, context, ["acceptedAt"]);
    }
    if (invitation.state === "revoked" && invitation.revokedAt !== null) {
      requireTimestampOrder(invitation.createdAt, invitation.revokedAt, context, ["revokedAt"]);
      requireTimestampOrder(invitation.revokedAt, invitation.updatedAt, context, ["updatedAt"]);
      requireTimestampOrder(invitation.revokedAt, invitation.expiresAt, context, ["revokedAt"]);
    }
    if (invitation.state === "expired") {
      requireTimestampOrder(invitation.expiresAt, invitation.updatedAt, context, ["updatedAt"]);
    }
  });

export const CloudProjectAssignmentSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    assignmentId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    membershipId: UuidV7Schema,
    state: CloudProjectAssignmentStateSchema,
    revision: PositivePortableIntegerSchema,
    grantedByMembershipId: UuidV7Schema,
    revokedByMembershipId: UuidV7Schema.nullable(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
    revokedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((assignment, context) => {
    requireTimestampOrder(assignment.createdAt, assignment.updatedAt, context, ["updatedAt"]);
    const hasRevocation =
      assignment.revokedAt !== null && assignment.revokedByMembershipId !== null;
    const hasNoRevocation =
      assignment.revokedAt === null && assignment.revokedByMembershipId === null;
    if (
      (assignment.state === "revoked" && !hasRevocation) ||
      (assignment.state === "active" && !hasNoRevocation)
    ) {
      context.addIssue({
        code: "custom",
        message: "Project-assignment state and revocation fields must agree",
        path: ["revokedAt"],
      });
    }
    if (assignment.revokedAt !== null) {
      requireTimestampOrder(assignment.createdAt, assignment.revokedAt, context, ["revokedAt"]);
      requireTimestampOrder(assignment.revokedAt, assignment.updatedAt, context, ["updatedAt"]);
    }
  });

export const CloudTeamCreateRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    displayName: CloudTeamDisplayNameSchema,
  })
  .strict();

export const CloudTeamResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    team: CloudTeamSchema,
  })
  .strict();

export const CloudTeamListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    teams: z.array(CloudTeamSchema).max(MAX_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueIds(response.teams, "teamId", context, ["teams"]);
  });

export const CloudTeamMemberListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    memberships: z.array(CloudTeamMembershipSchema).max(MAX_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueIds(response.memberships, "membershipId", context, ["memberships"]);
  });

export const CloudTeamMembershipResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    membership: CloudTeamMembershipSchema,
  })
  .strict();

export const CloudTeamInvitationCreateRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    inviteeEmail: CloudEmailAddressSchema,
    role: CloudTeamInvitationRoleSchema,
    expiresAt: IsoUtcTimestampSchema,
  })
  .strict();

export const CloudTeamInvitationAcceptRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
    invitationToken: CloudOpaqueTokenSchema,
  })
  .strict();

export const CloudTeamInvitationResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    invitation: CloudTeamInvitationSchema,
  })
  .strict();

export const CloudTeamInvitationAcceptanceResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    invitation: CloudTeamInvitationSchema,
    membership: CloudTeamMembershipSchema,
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.invitation.state !== "accepted" ||
      response.invitation.acceptedMembershipId !== response.membership.membershipId ||
      response.invitation.tenantId !== response.membership.tenantId ||
      response.invitation.teamId !== response.membership.teamId ||
      response.invitation.role !== response.membership.role ||
      response.membership.state !== "active"
    ) {
      context.addIssue({
        code: "custom",
        message: "Accepted invitation and resulting membership must agree",
        path: ["membership"],
      });
    }
  });

export const CloudTeamMemberRoleChangeRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
    role: TeamRoleSchema,
  })
  .strict();

export const CloudTeamMembershipRevokeRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
  })
  .strict();

export const CloudProjectAssignmentSetRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema.nullable(),
    desiredState: CloudProjectAssignmentStateSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.expectedRevision === null && request.desiredState !== "active") {
      context.addIssue({
        code: "custom",
        message: "A new project assignment must begin active",
        path: ["desiredState"],
      });
    }
  });

export const CloudProjectAssignmentResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    assignment: CloudProjectAssignmentSchema,
  })
  .strict();

export const CloudProjectAssignmentListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    assignments: z.array(CloudProjectAssignmentSchema).max(MAX_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueIds(response.assignments, "assignmentId", context, ["assignments"]);
    const membershipIds = response.assignments.map((assignment) => assignment.membershipId);
    if (new Set(membershipIds).size !== membershipIds.length) {
      context.addIssue({
        code: "custom",
        message: "A project-assignment page cannot repeat a membership",
        path: ["assignments"],
      });
    }
  });

/**
 * Ciphertext-free discovery metadata for the one authoritative active
 * project-key version in a team project. The optional envelope signal is only
 * a boolean for the authenticated session device; no envelope, public key,
 * recovery material or other recipient metadata is admitted by this schema.
 */
export const CloudTeamProjectCurrentKeyResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    keyVersion: z.number().int().positive().max(2_147_483_647),
    state: z.literal("active"),
    serverRevision: PositivePortableIntegerSchema,
    updatedAt: IsoUtcTimestampSchema,
    currentDeviceEnvelopeAvailable: z.boolean(),
  })
  .strict();

/**
 * This is a public-key distribution record for an active team member that is
 * actively assigned to a project. It intentionally contains no key envelope,
 * invitation credential, recovery ciphertext or creative plaintext.
 */
export const CloudTeamProjectKeyEligibleRecipientSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    recipientKind: z.literal("active_assigned_team_member_device"),
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    keyVersion: z.number().int().positive().max(2_147_483_647),
    membershipId: UuidV7Schema,
    membershipRevision: PositivePortableIntegerSchema,
    assignmentId: UuidV7Schema,
    assignmentRevision: PositivePortableIntegerSchema,
    deviceId: UuidV7Schema,
    algorithm: z.literal("DHKEM-P256-HKDF-SHA256"),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const CloudTeamProjectKeyEligibleRecipientListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    keyVersion: z.number().int().positive().max(2_147_483_647),
    recipients: z.array(CloudTeamProjectKeyEligibleRecipientSchema).max(10_000),
  })
  .strict()
  .superRefine((response, context) => {
    const deviceIds = new Set<string>();
    for (const [index, recipient] of response.recipients.entries()) {
      if (
        recipient.teamId !== response.teamId ||
        recipient.projectId !== response.projectId ||
        recipient.keyVersion !== response.keyVersion
      ) {
        context.addIssue({
          code: "custom",
          message: "Eligible recipient does not match its team-project-key scope",
          path: ["recipients", index],
        });
      }
      if (deviceIds.has(recipient.deviceId)) {
        context.addIssue({
          code: "custom",
          message: "Eligible recipient devices must be unique",
          path: ["recipients", index, "deviceId"],
        });
      }
      deviceIds.add(recipient.deviceId);
    }
  });

/**
 * A team-project member-device envelope is deliberately disjoint from both
 * personal device envelopes and recovery envelopes. The server must verify
 * every echoed recipient revision and public-key fingerprint before storing
 * this client-created HPKE ciphertext.
 */
export const CloudTeamProjectKeyEnvelopePublishRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    envelopeKind: z.literal("team_project_member_device"),
    envelopeId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    keyVersion: z.number().int().positive().max(2_147_483_647),
    membershipId: UuidV7Schema,
    membershipRevision: PositivePortableIntegerSchema,
    assignmentId: UuidV7Schema,
    assignmentRevision: PositivePortableIntegerSchema,
    algorithm: z.literal("HPKE-AUTH-P256-HKDF-SHA256-AES128GCM"),
    senderDeviceId: UuidV7Schema,
    senderPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    senderPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    recipientDeviceId: UuidV7Schema,
    recipientPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    recipientPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    encapsulatedKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{64}$/u),
  })
  .strict();

export const CloudTeamProjectKeyEnvelopeSchema =
  CloudTeamProjectKeyEnvelopePublishRequestSchema.extend({
    createdAt: IsoUtcTimestampSchema,
  }).strict();

/**
 * Both publication and current-device lookup return exactly one envelope.
 * The route authorization additionally binds recipientDeviceId to the
 * authenticated session device; an array shape is intentionally unsupported.
 */
export const CloudTeamProjectKeyEnvelopeResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    envelope: CloudTeamProjectKeyEnvelopeSchema,
  })
  .strict();

export type CloudTeamState = z.infer<typeof CloudTeamStateSchema>;
export type CloudTeamMembershipState = z.infer<typeof CloudTeamMembershipStateSchema>;
export type CloudTeamInvitationState = z.infer<typeof CloudTeamInvitationStateSchema>;
export type CloudProjectAssignmentState = z.infer<typeof CloudProjectAssignmentStateSchema>;
export type CloudTeamInvitationRole = z.infer<typeof CloudTeamInvitationRoleSchema>;
export type CloudTeam = z.infer<typeof CloudTeamSchema>;
export type CloudTeamMembership = z.infer<typeof CloudTeamMembershipSchema>;
export type CloudTeamInvitation = z.infer<typeof CloudTeamInvitationSchema>;
export type CloudProjectAssignment = z.infer<typeof CloudProjectAssignmentSchema>;
export type CloudTeamCreateRequest = z.infer<typeof CloudTeamCreateRequestSchema>;
export type CloudTeamResponse = z.infer<typeof CloudTeamResponseSchema>;
export type CloudTeamListResponse = z.infer<typeof CloudTeamListResponseSchema>;
export type CloudTeamMemberListResponse = z.infer<typeof CloudTeamMemberListResponseSchema>;
export type CloudTeamMembershipResponse = z.infer<typeof CloudTeamMembershipResponseSchema>;
export type CloudTeamInvitationCreateRequest = z.infer<
  typeof CloudTeamInvitationCreateRequestSchema
>;
export type CloudTeamInvitationAcceptRequest = z.infer<
  typeof CloudTeamInvitationAcceptRequestSchema
>;
export type CloudTeamInvitationResponse = z.infer<typeof CloudTeamInvitationResponseSchema>;
export type CloudTeamInvitationAcceptanceResponse = z.infer<
  typeof CloudTeamInvitationAcceptanceResponseSchema
>;
export type CloudTeamMemberRoleChangeRequest = z.infer<
  typeof CloudTeamMemberRoleChangeRequestSchema
>;
export type CloudTeamMembershipRevokeRequest = z.infer<
  typeof CloudTeamMembershipRevokeRequestSchema
>;
export type CloudProjectAssignmentSetRequest = z.infer<
  typeof CloudProjectAssignmentSetRequestSchema
>;
export type CloudProjectAssignmentResponse = z.infer<typeof CloudProjectAssignmentResponseSchema>;
export type CloudProjectAssignmentListResponse = z.infer<
  typeof CloudProjectAssignmentListResponseSchema
>;
export type CloudTeamProjectCurrentKeyResponse = z.infer<
  typeof CloudTeamProjectCurrentKeyResponseSchema
>;
export type CloudTeamProjectKeyEligibleRecipient = z.infer<
  typeof CloudTeamProjectKeyEligibleRecipientSchema
>;
export type CloudTeamProjectKeyEligibleRecipientListResponse = z.infer<
  typeof CloudTeamProjectKeyEligibleRecipientListResponseSchema
>;
export type CloudTeamProjectKeyEnvelopePublishRequest = z.infer<
  typeof CloudTeamProjectKeyEnvelopePublishRequestSchema
>;
export type CloudTeamProjectKeyEnvelope = z.infer<typeof CloudTeamProjectKeyEnvelopeSchema>;
export type CloudTeamProjectKeyEnvelopeResponse = z.infer<
  typeof CloudTeamProjectKeyEnvelopeResponseSchema
>;

function requireTimestampOrder(
  earlier: string,
  later: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  if (Date.parse(earlier) > Date.parse(later)) {
    context.addIssue({
      code: "custom",
      message: "Timestamp chronology is invalid",
      path: [...path],
    });
  }
}

function requireStrictTimestampOrder(
  earlier: string,
  later: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  if (Date.parse(earlier) >= Date.parse(later)) {
    context.addIssue({
      code: "custom",
      message: "Timestamp chronology is invalid",
      path: [...path],
    });
  }
}

function requireUniqueIds<Key extends string>(
  records: readonly Readonly<Record<Key, string>>[],
  key: Key,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  if (new Set(records.map((record) => record[key])).size !== records.length) {
    context.addIssue({
      code: "custom",
      message: `A page cannot contain duplicate ${key} values`,
      path: [...path],
    });
  }
}
