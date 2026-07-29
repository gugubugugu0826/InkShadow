import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

import {
  CloudAiProjectBudgetResponseSchema,
  CloudAiProjectBudgetUpdateRequestSchema,
  CloudAiTeamBudgetResponseSchema,
  CloudAiTeamBudgetUpdateRequestSchema,
  CloudAiUsageCancellationRequestSchema,
  CloudAiUsageEventListResponseSchema,
  CloudAiUsageReservationRequestSchema,
  CloudAiUsageReservationResponseSchema,
  CloudAiUsageSettlementRequestSchema,
  CloudAiUsageSummaryResponseSchema,
  CloudCursorSchema,
  UuidV7Schema,
} from "@inkshadow/contracts";

import { serviceUnavailable, validationFailed } from "../service/errors.js";
import type {
  CloudMutationContext,
  CloudPrincipal,
  CloudReadContext,
} from "../service/identity-service.js";
import type { CloudAiUsageService } from "../service/usage-service.js";

const TeamPathSchema = z.object({ teamId: UuidV7Schema }).strict();
const ProjectPathSchema = z
  .object({
    projectId: UuidV7Schema,
    teamId: UuidV7Schema,
  })
  .strict();
const ReservationPathSchema = ProjectPathSchema.extend({
  reservationId: UuidV7Schema,
}).strict();
const UsageSummaryQuerySchema = z
  .object({
    projectId: UuidV7Schema.optional(),
  })
  .strict();
const UsageEventQuerySchema = UsageSummaryQuerySchema.extend({
  cursor: CloudCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export interface CloudAiUsageRouteRegistrarOptions {
  readonly authenticate: (request: FastifyRequest) => Promise<CloudPrincipal>;
  readonly enforceMutationRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly enforceReadRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly mutationContext: (request: FastifyRequest) => CloudMutationContext;
  readonly readContext: (request: FastifyRequest) => CloudReadContext;
  readonly usageService?: CloudAiUsageService;
}

export function registerCloudAiUsageRoutes(
  server: FastifyInstance,
  options: CloudAiUsageRouteRegistrarOptions,
): void {
  server.put("/v1/teams/:teamId/ai-budget", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(TeamPathSchema, request.params);
    const body = parseInput(CloudAiTeamBudgetUpdateRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requireUsageService(options).updateTeamBudget(
      principal,
      parameters.teamId,
      body,
      options.mutationContext(request),
    );
    return reply.status(200).send(validateOutput(CloudAiTeamBudgetResponseSchema, response));
  });

  server.put("/v1/teams/:teamId/projects/:projectId/ai-budget", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(ProjectPathSchema, request.params);
    const body = parseInput(CloudAiProjectBudgetUpdateRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requireUsageService(options).updateProjectBudget(
      principal,
      parameters.teamId,
      parameters.projectId,
      body,
      options.mutationContext(request),
    );
    return reply.status(200).send(validateOutput(CloudAiProjectBudgetResponseSchema, response));
  });

  server.get("/v1/teams/:teamId/ai-usage", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(TeamPathSchema, request.params);
    const query = parseInput(UsageSummaryQuerySchema, request.query);
    await options.enforceReadRate(reply, principal);
    const response = await requireUsageService(options).getUsageSummary(
      principal,
      parameters.teamId,
      query.projectId ?? null,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudAiUsageSummaryResponseSchema, response));
  });

  server.get("/v1/teams/:teamId/ai-usage/events", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(TeamPathSchema, request.params);
    const query = parseInput(UsageEventQuerySchema, request.query);
    await options.enforceReadRate(reply, principal);
    const response = await requireUsageService(options).listUsageEvents(
      principal,
      parameters.teamId,
      query.projectId ?? null,
      query.cursor ?? null,
      query.limit,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudAiUsageEventListResponseSchema, response));
  });

  server.post(
    "/v1/teams/:teamId/projects/:projectId/ai-usage/reservations",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(ProjectPathSchema, request.params);
      const body = parseInput(CloudAiUsageReservationRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireUsageService(options).reserveUsage(
        principal,
        parameters.teamId,
        parameters.projectId,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(201)
        .send(validateOutput(CloudAiUsageReservationResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/ai-usage/reservations/:reservationId/settlements",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(ReservationPathSchema, request.params);
      const body = parseInput(CloudAiUsageSettlementRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireUsageService(options).settleUsage(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.reservationId,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudAiUsageReservationResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/ai-usage/reservations/:reservationId/cancellations",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(ReservationPathSchema, request.params);
      const body = parseInput(CloudAiUsageCancellationRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireUsageService(options).cancelUsage(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.reservationId,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudAiUsageReservationResponseSchema, response));
    },
  );
}

function requireUsageService(options: CloudAiUsageRouteRegistrarOptions): CloudAiUsageService {
  if (options.usageService === undefined) {
    throw serviceUnavailable();
  }
  return options.usageService;
}

function parseInput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed("The cloud AI usage request is invalid.");
  }
  return parsed.data;
}

function validateOutput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Cloud AI usage service output violated its contract.");
  }
  return parsed.data;
}
