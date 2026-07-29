import { createHash, timingSafeEqual } from "node:crypto";

import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

import {
  CloudAccountDeletionCancellationRequestSchema,
  CloudAccountDeletionLookupRequestSchema,
  CloudAccountDeletionSubmissionRequestSchema,
  CloudApiErrorResponseSchema,
  CloudAuthenticationRequestSchema,
  CloudCursorSchema,
  CloudDeletionCancellationRequestSchema,
  CloudDeletionRequestResponseSchema,
  CloudDeletionSubmissionRequestSchema,
  CloudDeviceListResponseSchema,
  CloudDeviceRegistrationRequestSchema,
  CloudDeviceResponseSchema,
  CloudIdempotencyKeySchema,
  CloudIdentityChallengeResponseSchema,
  CloudIdentityRegistrationRequestSchema,
  CloudIdentityVerificationRequestSchema,
  CloudMutationAcceptedResponseSchema,
  CloudOpaqueTokenSchema,
  CloudPasswordResetConfirmationRequestSchema,
  CloudPasswordResetRequestSchema,
  CloudProjectKeyPublishRequestSchema,
  CloudProjectKeyResponseSchema,
  CloudProjectStateResponseSchema,
  CloudSessionGrantResponseSchema,
  CloudSessionListResponseSchema,
  CloudSessionLogoutRequestSchema,
  CloudSessionRefreshRequestSchema,
  CloudSyncPullResponseSchema,
  CloudSyncPushRequestSchema,
  CloudSyncPushResponseSchema,
  CloudSyncSnapshotResponseSchema,
  CloudTombstoneAcknowledgementRequestSchema,
  CONTRACT_SCHEMA_VERSION,
  UuidV7Schema,
  type CloudDeletionRequestResponse,
} from "@inkshadow/contracts";

import { hashUtf8 } from "../security/canonical-hash.js";
import type { CloudMetricsRegistry } from "../operations/metrics.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  CloudServiceError,
  accessForbidden,
  invalidCredentials,
  serviceUnavailable,
  sessionExpired,
  validationFailed,
} from "../service/errors.js";
import type {
  CloudIdentityService,
  CloudMutationContext,
  CloudPrincipal,
} from "../service/identity-service.js";
import type { CloudDeletionService } from "../service/deletion-service.js";
import type { CloudProjectSyncService } from "../service/project-sync-service.js";
import type { CloudTeamService } from "../service/team-service.js";
import type { CloudTeamProjectKeyService } from "../service/team-project-key-service.js";
import type { CloudReviewService } from "../service/review-service.js";
import type { CloudAiUsageService } from "../service/usage-service.js";
import type { CloudTeamTemplateService } from "../service/team-template-service.js";
import type { CloudEnterpriseOidcService } from "../service/enterprise-oidc-service.js";
import type { CloudEnterprisePolicyService } from "../service/enterprise-policy-service.js";
import type { CloudMarketplaceService } from "../service/marketplace-service.js";
import type { CloudMarketplaceActor } from "../domain/marketplace-records.js";
import { InMemoryFixedWindowRateLimiter, type CloudRateLimiter } from "./rate-limiter.js";
import { registerCloudEnterpriseRoutes } from "./enterprise-routes.js";
import { registerCloudReviewRoutes } from "./review-routes.js";
import { registerCloudTeamRoutes } from "./team-routes.js";
import { registerCloudAiUsageRoutes } from "./usage-routes.js";
import { registerCloudTeamTemplateRoutes } from "./team-template-routes.js";
import { registerCloudMarketplaceRoutes } from "./marketplace-routes.js";

export interface CloudApiServerOptions {
  readonly bodyLimitBytes?: number;
  readonly clock?: () => Date;
  readonly deletionService?: CloudDeletionService;
  readonly enterpriseOidcService?: CloudEnterpriseOidcService;
  readonly enterprisePolicyService?: CloudEnterprisePolicyService;
  readonly identityService: CloudIdentityService;
  readonly metrics?: CloudMetricsRegistry;
  readonly metricsBearerTokenHash?: Buffer | null;
  readonly marketplaceService?: CloudMarketplaceService;
  readonly projectSyncService: CloudProjectSyncService;
  readonly rateLimiter?: CloudRateLimiter;
  readonly readinessCheck?: () => Promise<boolean>;
  readonly reviewService?: CloudReviewService;
  readonly requireHttps?: boolean;
  readonly trustProxy?: boolean | string | string[];
  readonly teamProjectKeyService?: CloudTeamProjectKeyService;
  readonly teamService?: CloudTeamService;
  readonly teamTemplateService?: CloudTeamTemplateService;
  readonly usageService?: CloudAiUsageService;
  readonly uuid: UuidV7Factory;
}

const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;
const ONE_MINUTE_MS = 60 * 1_000;

const CursorQuerySchema = z
  .object({
    cursor: CloudCursorSchema.optional(),
  })
  .strict();
const SessionPathSchema = z.object({ sessionId: UuidV7Schema }).strict();
const DevicePathSchema = z.object({ deviceId: UuidV7Schema }).strict();
const ProjectKeyPathSchema = z
  .object({
    projectId: UuidV7Schema,
    keyVersion: z.coerce.number().int().positive().max(2_147_483_647),
  })
  .strict();
const ProjectPathSchema = z.object({ projectId: UuidV7Schema }).strict();
const SyncPullQuerySchema = z
  .object({
    cursor: CloudCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(256).default(100),
  })
  .strict();

export function createCloudApiServer(options: CloudApiServerOptions): FastifyInstance {
  const requestIds = new WeakMap<FastifyRequest, string>();
  const requestStartTimes = new WeakMap<FastifyRequest, number>();
  const clock = options.clock ?? (() => new Date());
  const rateLimiter = options.rateLimiter ?? new InMemoryFixedWindowRateLimiter();
  const server = fastify({
    bodyLimit: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    logger: false,
    requestIdHeader: false,
    trustProxy: options.trustProxy ?? false,
  });

  server.addHook("onRequest", async (request, reply) => {
    requestStartTimes.set(request, clock().getTime());
    const supplied = request.headers["x-request-id"];
    let requestId = options.uuid();
    if (supplied !== undefined) {
      if (typeof supplied !== "string" || !UuidV7Schema.safeParse(supplied).success) {
        requestIds.set(request, requestId);
        reply.header("X-Request-Id", requestId);
        throw validationFailed("X-Request-Id must be a UUIDv7 identifier.");
      }
      requestId = supplied;
    }
    requestIds.set(request, requestId);
    reply.header("X-Request-Id", requestId);
    if (
      options.requireHttps === true &&
      request.protocol !== "https" &&
      !isClusterInternalPath(request.url)
    ) {
      throw new CloudServiceError({
        code: "ACCESS_FORBIDDEN",
        httpStatus: 400,
        message: "HTTPS is required for InkShadow cloud requests.",
      });
    }
  });

  server.addHook("onSend", async (request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    if (request.routeOptions.url === "/internal/metrics") {
      reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    } else {
      reply.header("Content-Type", "application/json; charset=utf-8");
    }
    reply.header("X-Content-Type-Options", "nosniff");
    if (options.requireHttps === true) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  server.addHook("onResponse", (request, reply) => {
    const startedAt = requestStartTimes.get(request);
    if (startedAt !== undefined) {
      options.metrics?.observeRequest({
        durationMs: Math.max(0, clock().getTime() - startedAt),
        method: request.method,
        route: request.routeOptions.url ?? "unknown",
        status: reply.statusCode,
      });
    }
    requestStartTimes.delete(request);
    requestIds.delete(request);
    return Promise.resolve();
  });

  server.setErrorHandler((error, request, reply) => {
    const requestId = requestIds.get(request) ?? options.uuid();
    const normalized = normalizeHttpError(error);
    const supportId = normalized.code === "INTERNAL_ERROR" ? options.uuid() : normalized.supportId;
    const response = CloudApiErrorResponseSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        actions: normalized.actions,
        supportId,
      },
    });
    void reply.status(normalized.httpStatus).send(response);
  });

  server.setNotFoundHandler(() => {
    throw new CloudServiceError({
      code: "RESOURCE_NOT_FOUND",
      httpStatus: 404,
      message: "The requested cloud API route was not found.",
    });
  });

  server.get("/health/live", (_request, reply) => reply.status(200).send({ status: "ok" }));

  server.get("/health/ready", async (_request, reply) => {
    const ready = await (options.readinessCheck?.() ?? Promise.resolve(true));
    options.metrics?.setReady(ready);
    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ready" : "unavailable",
    });
  });

  if (options.metrics !== undefined && options.metricsBearerTokenHash != null) {
    server.get("/internal/metrics", (request, reply) => {
      requireMetricsAuthorization(request, options.metricsBearerTokenHash ?? null);
      return reply.status(200).send(options.metrics?.render() ?? "");
    });
  }

  server.post("/v1/identity/registrations", async (request, reply) => {
    const body = parseInput(CloudIdentityRegistrationRequestSchema, request.body);
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `identity.register:ip:${hashUtf8(request.ip)}`,
      limit: 10,
      windowMs: ONE_HOUR_MS,
    });
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `identity.register:email:${hashUtf8(body.email)}`,
      limit: 3,
      windowMs: ONE_HOUR_MS,
    });
    const response = await options.identityService.registerIdentity(
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(202).send(validateOutput(CloudIdentityChallengeResponseSchema, response));
  });

  server.post("/v1/identity/verifications", async (request, reply) => {
    const body = parseInput(CloudIdentityVerificationRequestSchema, request.body);
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `identity.verify:ip:${hashUtf8(request.ip)}`,
      limit: 20,
      windowMs: FIFTEEN_MINUTES_MS,
    });
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `identity.verify:challenge:${hashUtf8(body.challengeId)}`,
      limit: 10,
      windowMs: FIFTEEN_MINUTES_MS,
    });
    const response = await options.identityService.verifyEmail(
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudSessionGrantResponseSchema, response));
  });

  server.post("/v1/identity/password-resets", async (request, reply) => {
    const body = parseInput(CloudPasswordResetRequestSchema, request.body);
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `identity.reset:ip:${hashUtf8(request.ip)}`,
      limit: 10,
      windowMs: ONE_HOUR_MS,
    });
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `identity.reset:email:${hashUtf8(body.email)}`,
      limit: 3,
      windowMs: ONE_HOUR_MS,
    });
    const response = await options.identityService.requestPasswordReset(
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(202).send(validateOutput(CloudIdentityChallengeResponseSchema, response));
  });

  server.post("/v1/identity/password-resets/confirmations", async (request, reply) => {
    const body = parseInput(CloudPasswordResetConfirmationRequestSchema, request.body);
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `identity.reset-confirm:ip:${hashUtf8(request.ip)}`,
      limit: 20,
      windowMs: ONE_HOUR_MS,
    });
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `identity.reset-confirm:challenge:${hashUtf8(body.challengeId)}`,
      limit: 10,
      windowMs: ONE_HOUR_MS,
    });
    const response = await options.identityService.confirmPasswordReset(
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(202).send(validateOutput(CloudMutationAcceptedResponseSchema, response));
  });

  server.post("/v1/auth/sessions", async (request, reply) => {
    const body = parseInput(CloudAuthenticationRequestSchema, request.body);
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `auth.login:ip:${hashUtf8(request.ip)}`,
      limit: 30,
      windowMs: FIFTEEN_MINUTES_MS,
    });
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `auth.login:email:${hashUtf8(body.email)}`,
      limit: 10,
      windowMs: FIFTEEN_MINUTES_MS,
    });
    const response = await options.identityService.login(
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudSessionGrantResponseSchema, response));
  });

  server.post("/v1/auth/session-rotations", async (request, reply) => {
    const body = parseInput(CloudSessionRefreshRequestSchema, request.body);
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `auth.refresh:ip:${hashUtf8(request.ip)}`,
      limit: 60,
      windowMs: FIFTEEN_MINUTES_MS,
    });
    await enforceRateLimit(rateLimiter, reply, {
      clock,
      key: `auth.refresh:token:${hashUtf8(body.refreshToken)}`,
      limit: 10,
      windowMs: FIFTEEN_MINUTES_MS,
    });
    const response = await options.identityService.refresh(
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudSessionGrantResponseSchema, response));
  });

  server.post("/v1/auth/session-revocations", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const body = parseInput(CloudSessionLogoutRequestSchema, request.body);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const response = await options.identityService.logout(
      principal,
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(202).send(validateOutput(CloudMutationAcceptedResponseSchema, response));
  });

  server.get("/v1/auth/sessions", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const query = parseInput(CursorQuerySchema, request.query);
    const response = await options.identityService.listSessions(
      principal,
      query.cursor ?? null,
      readContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudSessionListResponseSchema, response));
  });

  server.delete("/v1/auth/sessions/:sessionId", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(SessionPathSchema, request.params);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const response = await options.identityService.revokeSession(
      principal,
      parameters.sessionId,
      mutationContext(request, requestIds),
    );
    return reply.status(202).send(validateOutput(CloudMutationAcceptedResponseSchema, response));
  });

  server.get("/v1/devices", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const query = parseInput(CursorQuerySchema, request.query);
    const response = await options.identityService.listDevices(
      principal,
      query.cursor ?? null,
      readContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudDeviceListResponseSchema, response));
  });

  server.post("/v1/devices", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const body = parseInput(CloudDeviceRegistrationRequestSchema, request.body);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const response = await options.identityService.registerDevice(
      principal,
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(201).send(validateOutput(CloudDeviceResponseSchema, response));
  });

  server.delete("/v1/devices/:deviceId", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(DevicePathSchema, request.params);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const response = await options.identityService.revokeDevice(
      principal,
      parameters.deviceId,
      mutationContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudDeviceResponseSchema, response));
  });

  server.post("/v1/account/deletion-requests", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const body = parseInput(CloudAccountDeletionSubmissionRequestSchema, request.body);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const context = mutationContext(request, requestIds);
    const response = await requireDeletionService(options).requestAccountDeletion(
      principal,
      body,
      context,
    );
    return reply.status(202).send(
      validateDeletionResponse(response, {
        requestId: context.requestId,
        targetKind: "account",
        targetId: principal.accountId,
      }),
    );
  });

  server.post("/v1/account/deletion-request-lookups", async (request, reply) => {
    const body = parseInput(CloudAccountDeletionLookupRequestSchema, request.body);
    await enforceAccountDeletionCredentialRate(rateLimiter, reply, clock, request, body);
    const context = readContext(request, requestIds);
    const response = await executeAccountDeletionCredentialOperation(() =>
      requireDeletionService(options).lookupAccountDeletion(body, context),
    );
    return reply.status(200).send(
      validateDeletionResponse(response, {
        requestId: context.requestId,
        targetKind: "account",
        ...("deletionRequestId" in body ? { deletionRequestId: body.deletionRequestId } : {}),
      }),
    );
  });

  server.post("/v1/account/deletion-cancellations", async (request, reply) => {
    const body = parseInput(CloudAccountDeletionCancellationRequestSchema, request.body);
    await enforceAccountDeletionCredentialRate(rateLimiter, reply, clock, request, body);
    const context = mutationContext(request, requestIds);
    const response = await executeAccountDeletionCredentialOperation(() =>
      requireDeletionService(options).cancelAccountDeletion(body, context),
    );
    return reply.status(200).send(
      validateDeletionResponse(response, {
        requestId: context.requestId,
        targetKind: "account",
        deletionRequestId: body.deletionRequestId,
        state: "cancelled",
      }),
    );
  });

  server.post("/v1/projects/:projectId/deletion-requests", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectPathSchema, request.params);
    const body = parseInput(CloudDeletionSubmissionRequestSchema, request.body);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const context = mutationContext(request, requestIds);
    const response = await requireDeletionService(options).requestProjectDeletion(
      principal,
      parameters.projectId,
      body,
      context,
    );
    return reply.status(202).send(
      validateDeletionResponse(response, {
        requestId: context.requestId,
        targetKind: "project",
        targetId: parameters.projectId,
      }),
    );
  });

  server.get("/v1/projects/:projectId/deletion-request", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectPathSchema, request.params);
    await enforceAuthenticatedReadRate(rateLimiter, reply, clock, principal);
    const context = readContext(request, requestIds);
    const response = await requireDeletionService(options).getProjectDeletionRequest(
      principal,
      parameters.projectId,
      context,
    );
    return reply.status(200).send(
      validateDeletionResponse(response, {
        requestId: context.requestId,
        targetKind: "project",
        targetId: parameters.projectId,
      }),
    );
  });

  server.post("/v1/projects/:projectId/deletion-cancellations", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectPathSchema, request.params);
    const body = parseInput(CloudDeletionCancellationRequestSchema, request.body);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const context = mutationContext(request, requestIds);
    const response = await requireDeletionService(options).cancelProjectDeletion(
      principal,
      parameters.projectId,
      body,
      context,
    );
    return reply.status(200).send(
      validateDeletionResponse(response, {
        requestId: context.requestId,
        targetKind: "project",
        targetId: parameters.projectId,
        deletionRequestId: body.deletionRequestId,
        state: "cancelled",
      }),
    );
  });

  server.put("/v1/projects/:projectId/keys/:keyVersion", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectKeyPathSchema, request.params);
    const body = parseInput(CloudProjectKeyPublishRequestSchema, request.body);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const response = await options.projectSyncService.publishProjectKey(
      principal,
      parameters.projectId,
      parameters.keyVersion,
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudProjectKeyResponseSchema, response));
  });

  server.get("/v1/projects/:projectId/keys/current", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectPathSchema, request.params);
    const response = await options.projectSyncService.getCurrentProjectKey(
      principal,
      parameters.projectId,
      readContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudProjectKeyResponseSchema, response));
  });

  server.get("/v1/projects/:projectId/keys/:keyVersion", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectKeyPathSchema, request.params);
    const response = await options.projectSyncService.getProjectKey(
      principal,
      parameters.projectId,
      parameters.keyVersion,
      readContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudProjectKeyResponseSchema, response));
  });

  server.get("/v1/projects/:projectId", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectPathSchema, request.params);
    const query = parseInput(CursorQuerySchema, request.query);
    await enforceAuthenticatedReadRate(rateLimiter, reply, clock, principal);
    const response = await options.projectSyncService.getProjectState(
      principal,
      parameters.projectId,
      query.cursor ?? null,
      readContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudProjectStateResponseSchema, response));
  });

  server.post("/v1/projects/:projectId/sync/push", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectPathSchema, request.params);
    const body = parseInput(CloudSyncPushRequestSchema, request.body);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const response = await options.projectSyncService.pushSync(
      principal,
      parameters.projectId,
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudSyncPushResponseSchema, response));
  });

  server.get("/v1/projects/:projectId/sync/pull", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectPathSchema, request.params);
    const query = parseInput(SyncPullQuerySchema, request.query);
    await enforceAuthenticatedReadRate(rateLimiter, reply, clock, principal);
    const response = await options.projectSyncService.pullSync(
      principal,
      parameters.projectId,
      query.cursor ?? null,
      query.limit,
      readContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudSyncPullResponseSchema, response));
  });

  server.get("/v1/projects/:projectId/sync/snapshot", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectPathSchema, request.params);
    const query = parseInput(SyncPullQuerySchema, request.query);
    await enforceAuthenticatedReadRate(rateLimiter, reply, clock, principal);
    const response = await options.projectSyncService.getSyncSnapshot(
      principal,
      parameters.projectId,
      query.cursor ?? null,
      query.limit,
      readContext(request, requestIds),
    );
    return reply.status(200).send(validateOutput(CloudSyncSnapshotResponseSchema, response));
  });

  server.post("/v1/projects/:projectId/sync/tombstone-acknowledgements", async (request, reply) => {
    const principal = await authenticate(request, requestIds, options.identityService);
    const parameters = parseInput(ProjectPathSchema, request.params);
    const body = parseInput(CloudTombstoneAcknowledgementRequestSchema, request.body);
    await enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal);
    const response = await options.projectSyncService.acknowledgeTombstones(
      principal,
      parameters.projectId,
      body,
      mutationContext(request, requestIds),
    );
    return reply.status(202).send(validateOutput(CloudMutationAcceptedResponseSchema, response));
  });

  registerCloudTeamRoutes(server, {
    authenticate: (request) => authenticate(request, requestIds, options.identityService),
    enforceMutationRate: (reply, principal) =>
      enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal),
    enforceReadRate: (reply, principal) =>
      enforceAuthenticatedReadRate(rateLimiter, reply, clock, principal),
    mutationContext: (request) => mutationContext(request, requestIds),
    readContext: (request) => readContext(request, requestIds),
    ...(options.teamProjectKeyService === undefined
      ? {}
      : { teamProjectKeyService: options.teamProjectKeyService }),
    ...(options.teamService === undefined ? {} : { teamService: options.teamService }),
  });

  registerCloudReviewRoutes(server, {
    authenticate: (request) => authenticate(request, requestIds, options.identityService),
    enforceMutationRate: (reply, principal) =>
      enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal),
    enforceReadRate: (reply, principal) =>
      enforceAuthenticatedReadRate(rateLimiter, reply, clock, principal),
    mutationContext: (request) => mutationContext(request, requestIds),
    readContext: (request) => readContext(request, requestIds),
    ...(options.reviewService === undefined ? {} : { reviewService: options.reviewService }),
  });

  registerCloudAiUsageRoutes(server, {
    authenticate: (request) => authenticate(request, requestIds, options.identityService),
    enforceMutationRate: (reply, principal) =>
      enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal),
    enforceReadRate: (reply, principal) =>
      enforceAuthenticatedReadRate(rateLimiter, reply, clock, principal),
    mutationContext: (request) => mutationContext(request, requestIds),
    readContext: (request) => readContext(request, requestIds),
    ...(options.usageService === undefined ? {} : { usageService: options.usageService }),
  });

  registerCloudTeamTemplateRoutes(server, {
    authenticate: (request) => authenticate(request, requestIds, options.identityService),
    enforceMutationRate: (reply, principal) =>
      enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal),
    enforceReadRate: (reply, principal) =>
      enforceAuthenticatedReadRate(rateLimiter, reply, clock, principal),
    mutationContext: (request) => mutationContext(request, requestIds),
    readContext: (request) => readContext(request, requestIds),
    ...(options.teamTemplateService === undefined ? {} : { service: options.teamTemplateService }),
  });

  registerCloudEnterpriseRoutes(server, {
    authenticate: (request) => authenticate(request, requestIds, options.identityService),
    enforceMutationRate: (reply, principal) =>
      enforceAuthenticatedMutationRate(rateLimiter, reply, clock, principal),
    enforcePublicSsoRate: async (request, reply, scope) => {
      await enforceRateLimit(rateLimiter, reply, {
        clock,
        key: `enterprise-sso:ip:${hashUtf8(request.ip)}`,
        limit: 30,
        windowMs: FIFTEEN_MINUTES_MS,
      });
      await enforceRateLimit(rateLimiter, reply, {
        clock,
        key: `enterprise-sso:scope:${hashUtf8(scope)}`,
        limit: 100,
        windowMs: FIFTEEN_MINUTES_MS,
      });
    },
    enforceReadRate: (reply, principal) =>
      enforceAuthenticatedReadRate(rateLimiter, reply, clock, principal),
    mutationContext: (request) => mutationContext(request, requestIds),
    readContext: (request) => readContext(request, requestIds),
    ...(options.enterpriseOidcService === undefined
      ? {}
      : { oidcService: options.enterpriseOidcService }),
    ...(options.enterprisePolicyService === undefined
      ? {}
      : { policyService: options.enterprisePolicyService }),
  });

  registerCloudMarketplaceRoutes(server, {
    authenticate: async (request) =>
      marketplaceActor(await authenticate(request, requestIds, options.identityService)),
    enforceMutationRate: (reply, actor) =>
      enforceAuthenticatedMutationRate(rateLimiter, reply, clock, actor),
    enforceReadRate: (reply, actor) =>
      enforceAuthenticatedReadRate(rateLimiter, reply, clock, actor),
    mutationContext: (request) => mutationContext(request, requestIds),
    readContext: (request) => readContext(request, requestIds),
    ...(options.marketplaceService === undefined
      ? {}
      : { marketplaceService: options.marketplaceService }),
  });

  return server;
}

function requireDeletionService(options: CloudApiServerOptions): CloudDeletionService {
  if (options.deletionService === undefined) {
    throw serviceUnavailable();
  }
  return options.deletionService;
}

async function executeAccountDeletionCredentialOperation<Output>(
  operation: () => Promise<Output>,
): Promise<Output> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (
      error instanceof CloudServiceError &&
      [
        "ACCESS_FORBIDDEN",
        "AUTH_ACCOUNT_FROZEN",
        "AUTH_ACCOUNT_LOCKED",
        "AUTH_EMAIL_UNVERIFIED",
        "AUTH_INVALID_CREDENTIALS",
        "RESOURCE_NOT_FOUND",
      ].includes(error.code)
    ) {
      throw invalidCredentials();
    }
    throw error;
  }
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
    throw new Error("A cloud service response violated its public contract.");
  }
  return parsed.data;
}

function validateDeletionResponse(
  value: unknown,
  expected: {
    readonly requestId: string;
    readonly targetKind: "account" | "project";
    readonly targetId?: string;
    readonly deletionRequestId?: string;
    readonly state?: "cancelled";
  },
): CloudDeletionRequestResponse {
  const response = validateOutput(CloudDeletionRequestResponseSchema, value);
  if (
    response.requestId !== expected.requestId ||
    response.deletionRequest.targetKind !== expected.targetKind ||
    (expected.targetId !== undefined && response.deletionRequest.targetId !== expected.targetId) ||
    (expected.deletionRequestId !== undefined &&
      response.deletionRequest.deletionRequestId !== expected.deletionRequestId) ||
    (expected.state !== undefined && response.deletionRequest.state !== expected.state)
  ) {
    throw new Error("A cloud deletion service response violated its request scope.");
  }
  return response;
}

function mutationContext(
  request: FastifyRequest,
  requestIds: WeakMap<FastifyRequest, string>,
): CloudMutationContext {
  const supplied = request.headers["idempotency-key"];
  const parsed = CloudIdempotencyKeySchema.safeParse(supplied);
  if (!parsed.success) {
    throw validationFailed("Idempotency-Key is required for this operation.");
  }
  return {
    idempotencyKey: parsed.data,
    requestId: requireRequestId(request, requestIds),
  };
}

function readContext(request: FastifyRequest, requestIds: WeakMap<FastifyRequest, string>) {
  return { requestId: requireRequestId(request, requestIds) };
}

async function authenticate(
  request: FastifyRequest,
  requestIds: WeakMap<FastifyRequest, string>,
  identityService: CloudIdentityService,
): Promise<CloudPrincipal> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    throw sessionExpired();
  }
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(authorization);
  const token = match?.[1];
  if (token === undefined || !CloudOpaqueTokenSchema.safeParse(token).success) {
    throw sessionExpired();
  }
  return identityService.authenticateAccessToken(token, {
    requestId: requireRequestId(request, requestIds),
  });
}

function requireRequestId(
  request: FastifyRequest,
  requestIds: WeakMap<FastifyRequest, string>,
): string {
  const requestId = requestIds.get(request);
  if (requestId === undefined) {
    throw serviceUnavailable();
  }
  return requestId;
}

async function enforceAuthenticatedMutationRate(
  rateLimiter: CloudRateLimiter,
  reply: FastifyReply,
  clock: () => Date,
  principal: Pick<CloudPrincipal, "accountId">,
): Promise<void> {
  await enforceRateLimit(rateLimiter, reply, {
    clock,
    key: `authenticated-mutation:${hashUtf8(principal.accountId)}`,
    limit: 120,
    windowMs: ONE_MINUTE_MS,
  });
}

async function enforceAuthenticatedReadRate(
  rateLimiter: CloudRateLimiter,
  reply: FastifyReply,
  clock: () => Date,
  principal: Pick<CloudPrincipal, "accountId">,
): Promise<void> {
  await enforceRateLimit(rateLimiter, reply, {
    clock,
    key: `authenticated-read:${hashUtf8(principal.accountId)}`,
    limit: 300,
    windowMs: ONE_MINUTE_MS,
  });
}

function marketplaceActor(principal: CloudPrincipal): CloudMarketplaceActor {
  return Object.freeze({
    accountId: principal.accountId,
    deviceId: principal.deviceId,
    // Platform operations and strong-MFA authority must come from a separately
    // audited server-side identity source. Ordinary cloud sessions cannot
    // self-assert either property through request headers.
    platformRole: "member",
    strongMfa: false,
  });
}

async function enforceAccountDeletionCredentialRate(
  rateLimiter: CloudRateLimiter,
  reply: FastifyReply,
  clock: () => Date,
  request: FastifyRequest,
  credential:
    | { readonly deletionRequestId: string; readonly email: string }
    | { readonly confirmationId: string; readonly email: string },
): Promise<void> {
  await enforceRateLimit(rateLimiter, reply, {
    clock,
    key: `account-deletion-credential:ip:${hashUtf8(request.ip)}`,
    limit: 20,
    windowMs: FIFTEEN_MINUTES_MS,
  });
  await enforceRateLimit(rateLimiter, reply, {
    clock,
    key: `account-deletion-credential:proof:${hashUtf8(
      "deletionRequestId" in credential ? credential.deletionRequestId : credential.confirmationId,
    )}`,
    limit: 10,
    windowMs: FIFTEEN_MINUTES_MS,
  });
  await enforceRateLimit(rateLimiter, reply, {
    clock,
    key: `account-deletion-credential:email:${hashUtf8(credential.email)}`,
    limit: 10,
    windowMs: FIFTEEN_MINUTES_MS,
  });
}

async function enforceRateLimit(
  rateLimiter: CloudRateLimiter,
  reply: FastifyReply,
  options: {
    readonly clock: () => Date;
    readonly key: string;
    readonly limit: number;
    readonly windowMs: number;
  },
): Promise<void> {
  const decision = await rateLimiter.consume({
    key: options.key,
    limit: options.limit,
    now: options.clock(),
    windowMs: options.windowMs,
  });
  if (!decision.allowed) {
    reply.header("Retry-After", String(decision.retryAfterSeconds));
    throw new CloudServiceError({
      actions: ["RETRY", "USE_LOCAL"],
      code: "AUTH_RATE_LIMITED",
      httpStatus: 429,
      message: "Too many cloud requests were received. Try again later.",
      retryable: true,
    });
  }
}

function requireMetricsAuthorization(request: FastifyRequest, expectedHash: Buffer | null): void {
  const authorization = request.headers.authorization;
  const token =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
  const suppliedHash = createHash("sha256").update(token, "utf8").digest();
  if (expectedHash === null) {
    throw accessForbidden("Metrics access is not permitted.");
  }
  if (
    expectedHash.length !== suppliedHash.length ||
    token.length < 32 ||
    token.length > 4_096 ||
    /[\r\n]/u.test(token) ||
    !timingSafeEqual(expectedHash, suppliedHash)
  ) {
    throw accessForbidden("Metrics access is not permitted.");
  }
}

function isClusterInternalPath(url: string): boolean {
  return url === "/health/live" || url === "/health/ready" || url === "/internal/metrics";
}

function normalizeHttpError(error: unknown): CloudServiceError {
  if (error instanceof CloudServiceError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return validationFailed("The request does not match the InkShadow cloud API contract.");
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return new CloudServiceError({
        code: "VALIDATION_FAILED",
        httpStatus: 413,
        message: "The request body exceeds the supported size.",
      });
    }
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return new CloudServiceError({
        code: "VALIDATION_FAILED",
        httpStatus: 415,
        message: "The request body must use application/json.",
      });
    }
    if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return validationFailed("The request body is not valid JSON.");
    }
  }
  return new CloudServiceError({
    actions: ["RETRY", "CONTACT_SUPPORT"],
    code: "INTERNAL_ERROR",
    httpStatus: 500,
    message: "The cloud service could not complete the request.",
    retryable: false,
  });
}
