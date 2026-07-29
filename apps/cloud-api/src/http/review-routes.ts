import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

import {
  CloudCursorSchema,
  CloudReviewDecisionRequestSchema,
  CloudReviewListResponseSchema,
  CloudReviewResponseSchema,
  CloudReviewSubmissionRequestSchema,
  CloudReviewSuggestionDecisionRequestSchema,
  CloudReviewSuggestionDecisionResponseSchema,
  CloudReviewThreadItemAppendRequestSchema,
  CloudReviewThreadItemListResponseSchema,
  CloudReviewThreadItemResponseSchema,
  CloudReviewThreadListResponseSchema,
  CloudReviewThreadResolutionRequestSchema,
  CloudReviewThreadResponseSchema,
  UuidV7Schema,
} from "@inkshadow/contracts";

import { serviceUnavailable, validationFailed } from "../service/errors.js";
import type {
  CloudMutationContext,
  CloudPrincipal,
  CloudReadContext,
} from "../service/identity-service.js";
import type { CloudReviewService } from "../service/review-service.js";

const ProjectReviewPathSchema = z
  .object({
    projectId: UuidV7Schema,
    reviewId: UuidV7Schema,
    teamId: UuidV7Schema,
  })
  .strict();
const ProjectReviewsPathSchema = z
  .object({
    projectId: UuidV7Schema,
    teamId: UuidV7Schema,
  })
  .strict();
const ReviewThreadPathSchema = ProjectReviewPathSchema.extend({
  threadId: UuidV7Schema,
}).strict();
const ReviewSuggestionPathSchema = ReviewThreadPathSchema.extend({
  itemId: UuidV7Schema,
}).strict();
const ReviewPageQuerySchema = z
  .object({
    cursor: CloudCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export interface CloudReviewRouteRegistrarOptions {
  readonly authenticate: (request: FastifyRequest) => Promise<CloudPrincipal>;
  readonly enforceMutationRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly enforceReadRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly mutationContext: (request: FastifyRequest) => CloudMutationContext;
  readonly readContext: (request: FastifyRequest) => CloudReadContext;
  readonly reviewService?: CloudReviewService;
}

export function registerCloudReviewRoutes(
  server: FastifyInstance,
  options: CloudReviewRouteRegistrarOptions,
): void {
  server.post("/v1/teams/:teamId/projects/:projectId/reviews", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(ProjectReviewsPathSchema, request.params);
    const body = parseInput(CloudReviewSubmissionRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requireReviewService(options).submitReview(
      principal,
      parameters.teamId,
      parameters.projectId,
      body,
      options.mutationContext(request),
    );
    return reply.status(201).send(validateOutput(CloudReviewResponseSchema, response));
  });

  server.get("/v1/teams/:teamId/projects/:projectId/reviews", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(ProjectReviewsPathSchema, request.params);
    const query = parseInput(ReviewPageQuerySchema, request.query);
    await options.enforceReadRate(reply, principal);
    const response = await requireReviewService(options).listReviews(
      principal,
      parameters.teamId,
      parameters.projectId,
      query.cursor ?? null,
      query.limit,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudReviewListResponseSchema, response));
  });

  server.get("/v1/teams/:teamId/projects/:projectId/reviews/:reviewId", async (request, reply) => {
    const principal = await options.authenticate(request);
    const parameters = parseInput(ProjectReviewPathSchema, request.params);
    await options.enforceReadRate(reply, principal);
    const response = await requireReviewService(options).getReview(
      principal,
      parameters.teamId,
      parameters.projectId,
      parameters.reviewId,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudReviewResponseSchema, response));
  });

  server.post(
    "/v1/teams/:teamId/projects/:projectId/reviews/:reviewId/decisions",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(ProjectReviewPathSchema, request.params);
      const body = parseInput(CloudReviewDecisionRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireReviewService(options).decideReview(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.reviewId,
        body,
        options.mutationContext(request),
      );
      return reply.status(200).send(validateOutput(CloudReviewResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/reviews/:reviewId/thread-items",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(ProjectReviewPathSchema, request.params);
      const body = parseInput(CloudReviewThreadItemAppendRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireReviewService(options).appendThreadItem(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.reviewId,
        body,
        options.mutationContext(request),
      );
      return reply.status(201).send(validateOutput(CloudReviewThreadItemResponseSchema, response));
    },
  );

  server.get(
    "/v1/teams/:teamId/projects/:projectId/reviews/:reviewId/threads",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(ProjectReviewPathSchema, request.params);
      const query = parseInput(ReviewPageQuerySchema, request.query);
      await options.enforceReadRate(reply, principal);
      const response = await requireReviewService(options).listThreads(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.reviewId,
        query.cursor ?? null,
        query.limit,
        options.readContext(request),
      );
      return reply.status(200).send(validateOutput(CloudReviewThreadListResponseSchema, response));
    },
  );

  server.get(
    "/v1/teams/:teamId/projects/:projectId/reviews/:reviewId/threads/:threadId/items",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(ReviewThreadPathSchema, request.params);
      const query = parseInput(ReviewPageQuerySchema, request.query);
      await options.enforceReadRate(reply, principal);
      const response = await requireReviewService(options).listThreadItems(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.reviewId,
        parameters.threadId,
        query.cursor ?? null,
        query.limit,
        options.readContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudReviewThreadItemListResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/reviews/:reviewId/threads/:threadId/resolutions",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(ReviewThreadPathSchema, request.params);
      const body = parseInput(CloudReviewThreadResolutionRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireReviewService(options).resolveThread(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.reviewId,
        parameters.threadId,
        body,
        options.mutationContext(request),
      );
      return reply.status(200).send(validateOutput(CloudReviewThreadResponseSchema, response));
    },
  );

  server.post(
    "/v1/teams/:teamId/projects/:projectId/reviews/:reviewId/threads/:threadId/suggestions/:itemId/decisions",
    async (request, reply) => {
      const principal = await options.authenticate(request);
      const parameters = parseInput(ReviewSuggestionPathSchema, request.params);
      const body = parseInput(CloudReviewSuggestionDecisionRequestSchema, request.body);
      await options.enforceMutationRate(reply, principal);
      const response = await requireReviewService(options).decideSuggestion(
        principal,
        parameters.teamId,
        parameters.projectId,
        parameters.reviewId,
        parameters.threadId,
        parameters.itemId,
        body,
        options.mutationContext(request),
      );
      return reply
        .status(200)
        .send(validateOutput(CloudReviewSuggestionDecisionResponseSchema, response));
    },
  );
}

function requireReviewService(options: CloudReviewRouteRegistrarOptions): CloudReviewService {
  if (options.reviewService === undefined) {
    throw serviceUnavailable();
  }
  return options.reviewService;
}

function parseInput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed("The cloud review request is invalid.");
  }
  return parsed.data;
}

function validateOutput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Cloud review service output violated its contract.");
  }
  return parsed.data;
}
