import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

import {
  CloudMarketplaceAppealDispositionRequestSchema,
  CloudMarketplaceAppealRequestSchema,
  CloudMarketplaceAppealResponseSchema,
  CloudMarketplaceArtifactKindSchema,
  CloudMarketplaceCatalogResponseSchema,
  CloudMarketplaceDownloadRequestSchema,
  CloudMarketplaceDownloadResponseSchema,
  CloudMarketplaceModerationQueueResponseSchema,
  CloudMarketplaceModerationRequestSchema,
  CloudMarketplaceReportDispositionRequestSchema,
  CloudMarketplaceReportRequestSchema,
  CloudMarketplaceReportResponseSchema,
  CloudMarketplaceSubmissionRequestSchema,
  CloudMarketplaceSubmissionResponseSchema,
  CloudMarketplaceWithdrawalRequestSchema,
} from "@inkshadow/contracts/marketplace";
import { CloudCursorSchema, UuidV7Schema } from "@inkshadow/contracts";

import type { CloudMarketplaceActor } from "../domain/marketplace-records.js";
import { serviceUnavailable, validationFailed } from "../service/errors.js";
import type { CloudMutationContext, CloudReadContext } from "../service/identity-service.js";
import type { CloudMarketplaceService } from "../service/marketplace-service.js";

const ArtifactPathSchema = z.object({ artifactId: UuidV7Schema }).strict();
const ArtifactVersionPathSchema = ArtifactPathSchema.extend({
  versionId: UuidV7Schema,
}).strict();
const ReportPathSchema = z.object({ reportId: UuidV7Schema }).strict();
const AppealPathSchema = z.object({ appealId: UuidV7Schema }).strict();
const CatalogQuerySchema = z
  .object({
    cursor: CloudCursorSchema.optional(),
    kind: CloudMarketplaceArtifactKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const PageQuerySchema = z
  .object({
    cursor: CloudCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type CloudMarketplaceRouteService = Pick<
  CloudMarketplaceService,
  | "appealVersion"
  | "disposeAppeal"
  | "disposeReport"
  | "download"
  | "listCatalog"
  | "listModerationQueue"
  | "moderateVersion"
  | "reportVersion"
  | "submitVersion"
  | "withdrawVersion"
>;

export interface CloudMarketplaceRouteRegistrarOptions {
  readonly authenticate: (request: FastifyRequest) => Promise<CloudMarketplaceActor>;
  readonly enforceMutationRate: (
    reply: FastifyReply,
    actor: CloudMarketplaceActor,
  ) => Promise<void>;
  readonly enforceReadRate: (reply: FastifyReply, actor: CloudMarketplaceActor) => Promise<void>;
  readonly marketplaceService?: CloudMarketplaceRouteService;
  readonly mutationContext: (request: FastifyRequest) => CloudMutationContext;
  readonly readContext: (request: FastifyRequest) => CloudReadContext;
}

export function registerCloudMarketplaceRoutes(
  server: FastifyInstance,
  options: CloudMarketplaceRouteRegistrarOptions,
): void {
  server.get("/v1/marketplace/artifacts", async (request, reply) => {
    const actor = await options.authenticate(request);
    const query = parseInput(CatalogQuerySchema, request.query);
    await options.enforceReadRate(reply, actor);
    const response = await requireService(options).listCatalog(
      actor,
      query.kind ?? null,
      query.cursor ?? null,
      query.limit,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudMarketplaceCatalogResponseSchema, response));
  });

  server.post("/v1/marketplace/artifacts/submissions", async (request, reply) => {
    const actor = await options.authenticate(request);
    const body = parseInput(CloudMarketplaceSubmissionRequestSchema, request.body);
    await options.enforceMutationRate(reply, actor);
    const response = await requireService(options).submitVersion(
      actor,
      body,
      options.mutationContext(request),
    );
    return reply
      .status(201)
      .send(validateOutput(CloudMarketplaceSubmissionResponseSchema, response));
  });

  server.post(
    "/v1/marketplace/artifacts/:artifactId/versions/:versionId/moderation",
    async (request, reply) => {
      const actor = await options.authenticate(request);
      const path = parseInput(ArtifactVersionPathSchema, request.params);
      const body = parseInput(CloudMarketplaceModerationRequestSchema, request.body);
      await options.enforceMutationRate(reply, actor);
      const response = await requireService(options).moderateVersion(
        actor,
        path.artifactId,
        path.versionId,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudMarketplaceSubmissionResponseSchema, response));
    },
  );

  server.post(
    "/v1/marketplace/artifacts/:artifactId/versions/:versionId/reports",
    async (request, reply) => {
      const actor = await options.authenticate(request);
      const path = parseInput(ArtifactVersionPathSchema, request.params);
      const body = parseInput(CloudMarketplaceReportRequestSchema, request.body);
      await options.enforceMutationRate(reply, actor);
      const response = await requireService(options).reportVersion(
        actor,
        path.artifactId,
        path.versionId,
        body,
        options.mutationContext(request),
      );
      return reply.status(201).send(validateOutput(CloudMarketplaceReportResponseSchema, response));
    },
  );

  server.post(
    "/v1/marketplace/artifacts/:artifactId/versions/:versionId/withdrawals",
    async (request, reply) => {
      const actor = await options.authenticate(request);
      const path = parseInput(ArtifactVersionPathSchema, request.params);
      const body = parseInput(CloudMarketplaceWithdrawalRequestSchema, request.body);
      await options.enforceMutationRate(reply, actor);
      const response = await requireService(options).withdrawVersion(
        actor,
        path.artifactId,
        path.versionId,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudMarketplaceSubmissionResponseSchema, response));
    },
  );

  server.post(
    "/v1/marketplace/artifacts/:artifactId/versions/:versionId/appeals",
    async (request, reply) => {
      const actor = await options.authenticate(request);
      const path = parseInput(ArtifactVersionPathSchema, request.params);
      const body = parseInput(CloudMarketplaceAppealRequestSchema, request.body);
      await options.enforceMutationRate(reply, actor);
      const response = await requireService(options).appealVersion(
        actor,
        path.artifactId,
        path.versionId,
        body,
        options.mutationContext(request),
      );
      return reply.status(201).send(validateOutput(CloudMarketplaceAppealResponseSchema, response));
    },
  );

  server.post("/v1/marketplace/reports/:reportId/dispositions", async (request, reply) => {
    const actor = await options.authenticate(request);
    const path = parseInput(ReportPathSchema, request.params);
    const body = parseInput(CloudMarketplaceReportDispositionRequestSchema, request.body);
    await options.enforceMutationRate(reply, actor);
    const response = await requireService(options).disposeReport(
      actor,
      path.reportId,
      body,
      options.mutationContext(request),
    );
    return reply.status(200).send(validateOutput(CloudMarketplaceReportResponseSchema, response));
  });

  server.post("/v1/marketplace/appeals/:appealId/dispositions", async (request, reply) => {
    const actor = await options.authenticate(request);
    const path = parseInput(AppealPathSchema, request.params);
    const body = parseInput(CloudMarketplaceAppealDispositionRequestSchema, request.body);
    await options.enforceMutationRate(reply, actor);
    const response = await requireService(options).disposeAppeal(
      actor,
      path.appealId,
      body,
      options.mutationContext(request),
    );
    return reply.status(200).send(validateOutput(CloudMarketplaceAppealResponseSchema, response));
  });

  server.post("/v1/marketplace/artifacts/:artifactId/downloads", async (request, reply) => {
    const actor = await options.authenticate(request);
    const path = parseInput(ArtifactPathSchema, request.params);
    const body = parseInput(CloudMarketplaceDownloadRequestSchema, request.body);
    await options.enforceMutationRate(reply, actor);
    const response = await requireService(options).download(
      actor,
      path.artifactId,
      body,
      options.mutationContext(request),
    );
    return reply.status(200).send(validateOutput(CloudMarketplaceDownloadResponseSchema, response));
  });

  server.get("/v1/marketplace/moderation/queue", async (request, reply) => {
    const actor = await options.authenticate(request);
    const query = parseInput(PageQuerySchema, request.query);
    await options.enforceReadRate(reply, actor);
    const response = await requireService(options).listModerationQueue(
      actor,
      query.cursor ?? null,
      query.limit,
      options.readContext(request),
    );
    return reply
      .status(200)
      .send(validateOutput(CloudMarketplaceModerationQueueResponseSchema, response));
  });
}

function requireService(
  options: CloudMarketplaceRouteRegistrarOptions,
): CloudMarketplaceRouteService {
  if (options.marketplaceService === undefined) {
    throw serviceUnavailable();
  }
  return options.marketplaceService;
}

function parseInput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed("The marketplace request violated its published contract.");
  }
  return parsed.data;
}

function validateOutput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Marketplace service output violated its published contract.");
  }
  return parsed.data;
}
