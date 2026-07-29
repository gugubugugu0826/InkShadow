import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

import {
  CloudCursorSchema,
  CloudTeamTemplateApplicationResponseSchema,
  CloudTeamTemplateApplyRequestSchema,
  CloudTeamTemplateArchiveRequestSchema,
  CloudTeamTemplateCloneRequestSchema,
  CloudTeamTemplateCreateRequestSchema,
  CloudTeamTemplateListResponseSchema,
  CloudTeamTemplateMutationResponseSchema,
  CloudTeamTemplatePublishRequestSchema,
  CloudTeamTemplateResponseSchema,
  CloudTeamTemplateVersionCreateRequestSchema,
  CloudTeamTemplateVersionListResponseSchema,
  CloudTeamTemplateVersionResponseSchema,
  UuidV7Schema,
} from "@inkshadow/contracts";

import { serviceUnavailable, validationFailed } from "../service/errors.js";
import type {
  CloudMutationContext,
  CloudPrincipal,
  CloudReadContext,
} from "../service/identity-service.js";
import type { CloudTeamTemplateService } from "../service/team-template-service.js";

const ProjectPathSchema = z
  .object({
    projectId: UuidV7Schema,
    teamId: UuidV7Schema,
  })
  .strict();
const TemplatePathSchema = ProjectPathSchema.extend({
  templateId: UuidV7Schema,
}).strict();
const VersionPathSchema = TemplatePathSchema.extend({
  versionId: UuidV7Schema,
}).strict();
const PageQuerySchema = z
  .object({
    cursor: CloudCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export interface CloudTeamTemplateRouteRegistrarOptions {
  readonly authenticate: (request: FastifyRequest) => Promise<CloudPrincipal>;
  readonly enforceMutationRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly enforceReadRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly mutationContext: (request: FastifyRequest) => CloudMutationContext;
  readonly readContext: (request: FastifyRequest) => CloudReadContext;
  readonly service?: CloudTeamTemplateService;
}

export function registerCloudTeamTemplateRoutes(
  server: FastifyInstance,
  options: CloudTeamTemplateRouteRegistrarOptions,
): void {
  server.post("/v1/teams/:teamId/projects/:projectId/templates", async (request, reply) => {
    const principal = await options.authenticate(request);
    const path = parseInput(ProjectPathSchema, request.params);
    const body = parseInput(CloudTeamTemplateCreateRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requireService(options).createTemplate(
      principal,
      path.teamId,
      path.projectId,
      body,
      options.mutationContext(request),
    );
    return reply
      .status(201)
      .send(validateOutput(CloudTeamTemplateMutationResponseSchema, response));
  });

  server.get("/v1/teams/:teamId/projects/:projectId/templates", async (request, reply) => {
    const principal = await options.authenticate(request);
    const path = parseInput(ProjectPathSchema, request.params);
    const query = parseInput(PageQuerySchema, request.query);
    await options.enforceReadRate(reply, principal);
    const response = await requireService(options).listTemplates(
      principal,
      path.teamId,
      path.projectId,
      query.cursor ?? null,
      query.limit,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudTeamTemplateListResponseSchema, response));
  });

  server.get(
    "/v1/teams/:teamId/projects/:projectId/templates/:templateId",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const path = parseInput(TemplatePathSchema, request.params);
      await options.enforceReadRate(reply, principal);
      const response = await requireService(options).getTemplate(
        principal,
        path.teamId,
        path.projectId,
        path.templateId,
        options.readContext(request),
      );
      return reply.status(200).send(validateOutput(CloudTeamTemplateResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/templates/:templateId/versions",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const path = parseInput(TemplatePathSchema, request.params);
      const body = parseInput(CloudTeamTemplateVersionCreateRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireService(options).createVersion(
        principal,
        path.teamId,
        path.projectId,
        path.templateId,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(201)
        .send(validateOutput(CloudTeamTemplateMutationResponseSchema, response));
    },
  );

  server.get(
    "/v1/teams/:teamId/projects/:projectId/templates/:templateId/versions",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const path = parseInput(TemplatePathSchema, request.params);
      const query = parseInput(PageQuerySchema, request.query);
      await options.enforceReadRate(reply, principal);
      const response = await requireService(options).listVersions(
        principal,
        path.teamId,
        path.projectId,
        path.templateId,
        query.cursor ?? null,
        query.limit,
        options.readContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudTeamTemplateVersionListResponseSchema, response));
    },
  );

  server.get(
    "/v1/teams/:teamId/projects/:projectId/templates/:templateId/versions/:versionId",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const path = parseInput(VersionPathSchema, request.params);
      await options.enforceReadRate(reply, principal);
      const response = await requireService(options).getVersion(
        principal,
        path.teamId,
        path.projectId,
        path.templateId,
        path.versionId,
        options.readContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudTeamTemplateVersionResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/templates/:templateId/clones",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const path = parseInput(TemplatePathSchema, request.params);
      const body = parseInput(CloudTeamTemplateCloneRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireService(options).cloneTemplate(
        principal,
        path.teamId,
        path.projectId,
        path.templateId,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(201)
        .send(validateOutput(CloudTeamTemplateMutationResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/templates/:templateId/publications",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const path = parseInput(TemplatePathSchema, request.params);
      const body = parseInput(CloudTeamTemplatePublishRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireService(options).publishTemplate(
        principal,
        path.teamId,
        path.projectId,
        path.templateId,
        body,
        options.mutationContext(request),
      );
      return reply.status(200).send(validateOutput(CloudTeamTemplateResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/templates/:templateId/archives",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const path = parseInput(TemplatePathSchema, request.params);
      const body = parseInput(CloudTeamTemplateArchiveRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireService(options).archiveTemplate(
        principal,
        path.teamId,
        path.projectId,
        path.templateId,
        body,
        options.mutationContext(request),
      );
      return reply.status(200).send(validateOutput(CloudTeamTemplateResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/templates/:templateId/applications",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const path = parseInput(TemplatePathSchema, request.params);
      const body = parseInput(CloudTeamTemplateApplyRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireService(options).recordApplication(
        principal,
        path.teamId,
        path.projectId,
        path.templateId,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(201)
        .send(validateOutput(CloudTeamTemplateApplicationResponseSchema, response));
    },
  );
}

function requireService(options: CloudTeamTemplateRouteRegistrarOptions): CloudTeamTemplateService {
  if (options.service === undefined) {
    throw serviceUnavailable();
  }
  return options.service;
}

function parseInput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed("The cloud request violated its published contract.");
  }
  return parsed.data;
}

function validateOutput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("The cloud service produced an invalid team-template response.");
  }
  return parsed.data;
}
