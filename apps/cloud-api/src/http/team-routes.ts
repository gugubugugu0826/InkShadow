import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

import {
  CloudCursorSchema,
  CloudProjectAssignmentListResponseSchema,
  CloudProjectAssignmentResponseSchema,
  CloudProjectAssignmentSetRequestSchema,
  CloudTeamCreateRequestSchema,
  CloudTeamInvitationAcceptanceResponseSchema,
  CloudTeamInvitationAcceptRequestSchema,
  CloudTeamInvitationCreateRequestSchema,
  CloudTeamInvitationResponseSchema,
  CloudTeamListResponseSchema,
  CloudTeamMemberListResponseSchema,
  CloudTeamMemberRoleChangeRequestSchema,
  CloudTeamMembershipResponseSchema,
  CloudTeamMembershipRevokeRequestSchema,
  CloudTeamProjectCurrentKeyResponseSchema,
  CloudTeamProjectKeyEligibleRecipientListResponseSchema,
  CloudTeamProjectKeyEnvelopePublishRequestSchema,
  CloudTeamProjectKeyEnvelopeResponseSchema,
  CloudTeamResponseSchema,
  UuidV7Schema,
} from "@inkshadow/contracts";

import { serviceUnavailable, validationFailed } from "../service/errors.js";
import type {
  CloudMutationContext,
  CloudPrincipal,
  CloudReadContext,
} from "../service/identity-service.js";
import type { CloudTeamService } from "../service/team-service.js";
import type { CloudTeamProjectKeyService } from "../service/team-project-key-service.js";

const TeamPathSchema = z.object({ teamId: UuidV7Schema }).strict();
const InvitationPathSchema = z.object({ invitationId: UuidV7Schema }).strict();
const TeamMemberPathSchema = z
  .object({
    membershipId: UuidV7Schema,
    teamId: UuidV7Schema,
  })
  .strict();
const TeamProjectPathSchema = z
  .object({
    projectId: UuidV7Schema,
    teamId: UuidV7Schema,
  })
  .strict();
const TeamProjectMemberPathSchema = z
  .object({
    membershipId: UuidV7Schema,
    projectId: UuidV7Schema,
    teamId: UuidV7Schema,
  })
  .strict();
const TeamProjectKeyPathSchema = z
  .object({
    keyVersion: z.coerce.number().int().positive().max(2_147_483_647),
    projectId: UuidV7Schema,
    teamId: UuidV7Schema,
  })
  .strict();
const TeamPageQuerySchema = z
  .object({
    cursor: CloudCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1_024).default(100),
  })
  .strict();

export interface CloudTeamRouteRegistrarOptions {
  readonly authenticate: (request: FastifyRequest) => Promise<CloudPrincipal>;
  readonly enforceMutationRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly enforceReadRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly mutationContext: (request: FastifyRequest) => CloudMutationContext;
  readonly readContext: (request: FastifyRequest) => CloudReadContext;
  readonly teamProjectKeyService?: CloudTeamProjectKeyService;
  readonly teamService?: CloudTeamService;
}

export function registerCloudTeamRoutes(
  server: FastifyInstance,
  options: CloudTeamRouteRegistrarOptions,
): void {
  server.post("/v1/teams", async (request, reply) => {
    const principal = await options.authenticate(request);
    const body = parseInput(CloudTeamCreateRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requireTeamService(options).createTeam(
      principal,
      body,
      options.mutationContext(request),
    );
    return reply.status(201).send(validateOutput(CloudTeamResponseSchema, response));
  });

  server.get("/v1/teams", async (request, reply) => {
    const principal = await options.authenticate(request);
    const query = parseInput(TeamPageQuerySchema, request.query);
    await options.enforceReadRate(reply, principal);
    const response = await requireTeamService(options).listTeams(
      principal,
      query.cursor ?? null,
      query.limit,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudTeamListResponseSchema, response));
  });

  server.get("/v1/teams/:teamId/members", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(TeamPathSchema, request.params);
    const query = parseInput(TeamPageQuerySchema, request.query);
    await options.enforceReadRate(reply, principal);
    const response = await requireTeamService(options).listMembers(
      principal,
      parameters.teamId,
      query.cursor ?? null,
      query.limit,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudTeamMemberListResponseSchema, response));
  });

  server.post("/v1/teams/:teamId/invitations", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(TeamPathSchema, request.params);
    const body = parseInput(CloudTeamInvitationCreateRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requireTeamService(options).createInvitation(
      principal,
      parameters.teamId,
      body,
      options.mutationContext(request),
    );
    return reply.status(201).send(validateOutput(CloudTeamInvitationResponseSchema, response));
  });

  server.post("/v1/team-invitations/:invitationId/acceptances", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(InvitationPathSchema, request.params);
    const body = parseInput(CloudTeamInvitationAcceptRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requireTeamService(options).acceptInvitation(
      principal,
      parameters.invitationId,
      body,
      options.mutationContext(request),
    );
    return reply
      .status(200)
      .send(validateOutput(CloudTeamInvitationAcceptanceResponseSchema, response));
  });

  server.post("/v1/teams/:teamId/members/:membershipId/role-changes", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(TeamMemberPathSchema, request.params);
    const body = parseInput(CloudTeamMemberRoleChangeRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requireTeamService(options).changeMemberRole(
      principal,
      parameters.teamId,
      parameters.membershipId,
      body,
      options.mutationContext(request),
    );
    return reply.status(200).send(validateOutput(CloudTeamMembershipResponseSchema, response));
  });

  server.post("/v1/teams/:teamId/members/:membershipId/revocations", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(TeamMemberPathSchema, request.params);
    const body = parseInput(CloudTeamMembershipRevokeRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requireTeamService(options).revokeMembership(
      principal,
      parameters.teamId,
      parameters.membershipId,
      body,
      options.mutationContext(request),
    );
    return reply.status(200).send(validateOutput(CloudTeamMembershipResponseSchema, response));
  });

  server.get("/v1/teams/:teamId/projects/:projectId/assignments", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(TeamProjectPathSchema, request.params);
    const query = parseInput(TeamPageQuerySchema, request.query);
    await options.enforceReadRate(reply, principal);
    const response = await requireTeamService(options).listProjectAssignments(
      principal,
      parameters.teamId,
      parameters.projectId,
      query.cursor ?? null,
      query.limit,
      options.readContext(request),
    );
    return reply
      .status(200)
      .send(validateOutput(CloudProjectAssignmentListResponseSchema, response));
  });

  server.put(
    "/v1/teams/:teamId/projects/:projectId/assignments/:membershipId",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(TeamProjectMemberPathSchema, request.params);
      const body = parseInput(CloudProjectAssignmentSetRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireTeamService(options).setProjectAssignment(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.membershipId,
        body,
        options.mutationContext(request),
      );
      return reply.status(200).send(validateOutput(CloudProjectAssignmentResponseSchema, response));
    },
  );

  server.get("/v1/teams/:teamId/projects/:projectId/keys/current", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(TeamProjectPathSchema, request.params);
    await options.enforceReadRate(reply, principal);
    const response = await requireTeamProjectKeyService(options).getCurrentKeyMetadata(
      principal,
      parameters.teamId,
      parameters.projectId,
      options.readContext(request),
    );
    return reply
      .status(200)
      .send(validateOutput(CloudTeamProjectCurrentKeyResponseSchema, response));
  });

  server.get(
    "/v1/teams/:teamId/projects/:projectId/keys/:keyVersion/recipients",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(TeamProjectKeyPathSchema, request.params);
      await options.enforceReadRate(reply, principal);
      const response = await requireTeamProjectKeyService(options).listEligibleRecipients(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.keyVersion,
        options.readContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudTeamProjectKeyEligibleRecipientListResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/keys/:keyVersion/envelopes",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(TeamProjectKeyPathSchema, request.params);
      const body = parseInput(CloudTeamProjectKeyEnvelopePublishRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireTeamProjectKeyService(options).publishEnvelope(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.keyVersion,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(201)
        .send(validateOutput(CloudTeamProjectKeyEnvelopeResponseSchema, response));
    },
  );

  server.get(
    "/v1/teams/:teamId/projects/:projectId/keys/:keyVersion/envelopes/current-device",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(TeamProjectKeyPathSchema, request.params);
      await options.enforceReadRate(reply, principal);
      const response = await requireTeamProjectKeyService(options).getCurrentDeviceEnvelope(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.keyVersion,
        options.readContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudTeamProjectKeyEnvelopeResponseSchema, response));
    },
  );
}

function requireTeamService(options: CloudTeamRouteRegistrarOptions): CloudTeamService {
  if (options.teamService === undefined) {
    throw serviceUnavailable();
  }
  return options.teamService;
}

function requireTeamProjectKeyService(
  options: CloudTeamRouteRegistrarOptions,
): CloudTeamProjectKeyService {
  if (options.teamProjectKeyService === undefined) {
    throw serviceUnavailable();
  }
  return options.teamProjectKeyService;
}

function parseInput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed("The request does not match the InkShadow cloud API contract.");
  }
  return parsed.data;
}

function validateOutput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("A cloud team service response violated its public contract.");
  }
  return parsed.data;
}
