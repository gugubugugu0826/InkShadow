import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

import {
  CloudEnterprisePolicyEvaluationRequestSchema,
  CloudEnterprisePolicyEvaluationResponseSchema,
  CloudEnterprisePolicyResponseSchema,
  CloudEnterprisePolicyUpdateRequestSchema,
  CloudEnterpriseSsoAuthorizationRequestSchema,
  CloudEnterpriseSsoAuthorizationResponseSchema,
  CloudEnterpriseSsoCallbackRequestSchema,
  CloudEnterpriseSsoSessionResponseSchema,
  CloudEnterpriseSsoStatusResponseSchema,
  UuidV7Schema,
} from "@inkshadow/contracts";

import { serviceUnavailable, validationFailed } from "../service/errors.js";
import type {
  CloudMutationContext,
  CloudPrincipal,
  CloudReadContext,
} from "../service/identity-service.js";
import type { CloudEnterpriseOidcService } from "../service/enterprise-oidc-service.js";
import type { CloudEnterprisePolicyService } from "../service/enterprise-policy-service.js";

const TeamPathSchema = z.object({ teamId: UuidV7Schema }).strict();

export interface CloudEnterpriseRouteRegistrarOptions {
  readonly authenticate: (request: FastifyRequest) => Promise<CloudPrincipal>;
  readonly enforceMutationRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly enforcePublicSsoRate: (
    request: FastifyRequest,
    reply: FastifyReply,
    scope: string,
  ) => Promise<void>;
  readonly enforceReadRate: (reply: FastifyReply, principal: CloudPrincipal) => Promise<void>;
  readonly mutationContext: (request: FastifyRequest) => CloudMutationContext;
  readonly oidcService?: CloudEnterpriseOidcService;
  readonly policyService?: CloudEnterprisePolicyService;
  readonly readContext: (request: FastifyRequest) => CloudReadContext;
}

export function registerCloudEnterpriseRoutes(
  server: FastifyInstance,
  options: CloudEnterpriseRouteRegistrarOptions,
): void {
  server.get("/v1/teams/:teamId/enterprise/policy", async (request, reply) => {
    const principal = await options.authenticate(request);
    const path = parseInput(TeamPathSchema, request.params);
    await options.enforceReadRate(reply, principal);
    const response = await requirePolicyService(options).getPolicy(
      principal,
      path.teamId,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudEnterprisePolicyResponseSchema, response));
  });

  server.put("/v1/teams/:teamId/enterprise/policy", async (request, reply) => {
    const principal = await options.authenticate(request);
    const path = parseInput(TeamPathSchema, request.params);
    const body = parseInput(CloudEnterprisePolicyUpdateRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requirePolicyService(options).updatePolicy(
      principal,
      path.teamId,
      body,
      options.mutationContext(request),
    );
    return reply.status(200).send(validateOutput(CloudEnterprisePolicyResponseSchema, response));
  });

  server.post("/v1/teams/:teamId/enterprise/policy-evaluations", async (request, reply) => {
    const principal = await options.authenticate(request);
    const path = parseInput(TeamPathSchema, request.params);
    const body = parseInput(CloudEnterprisePolicyEvaluationRequestSchema, request.body);
    await options.enforceMutationRate(reply, principal);
    const response = await requirePolicyService(options).evaluatePolicy(
      principal,
      path.teamId,
      body,
      options.mutationContext(request),
    );
    return reply
      .status(200)
      .send(validateOutput(CloudEnterprisePolicyEvaluationResponseSchema, response));
  });

  server.get("/v1/teams/:teamId/enterprise/sso", async (request, reply) => {
    const principal = await options.authenticate(request);
    const path = parseInput(TeamPathSchema, request.params);
    await options.enforceReadRate(reply, principal);
    const response = await requirePolicyService(options).getSsoStatus(
      principal,
      path.teamId,
      options.readContext(request),
    );
    return reply.status(200).send(validateOutput(CloudEnterpriseSsoStatusResponseSchema, response));
  });

  server.post("/v1/enterprise/sso/authorizations", async (request, reply) => {
    const body = parseInput(CloudEnterpriseSsoAuthorizationRequestSchema, request.body);
    await options.enforcePublicSsoRate(request, reply, `authorize:${body.teamId}`);
    const response = await requireOidcService(options).authorize(
      body,
      options.mutationContext(request),
    );
    return reply
      .status(201)
      .send(validateOutput(CloudEnterpriseSsoAuthorizationResponseSchema, response));
  });

  server.post("/v1/enterprise/sso/callbacks", async (request, reply) => {
    const body = parseInput(CloudEnterpriseSsoCallbackRequestSchema, request.body);
    await options.enforcePublicSsoRate(request, reply, `callback:${body.flowId}`);
    const response = await requireOidcService(options).complete(
      body,
      options.mutationContext(request),
    );
    return reply
      .status(200)
      .send(validateOutput(CloudEnterpriseSsoSessionResponseSchema, response));
  });
}

function requirePolicyService(
  options: CloudEnterpriseRouteRegistrarOptions,
): CloudEnterprisePolicyService {
  if (options.policyService === undefined) {
    throw serviceUnavailable();
  }
  return options.policyService;
}

function requireOidcService(
  options: CloudEnterpriseRouteRegistrarOptions,
): CloudEnterpriseOidcService {
  if (options.oidcService === undefined) {
    throw serviceUnavailable();
  }
  return options.oidcService;
}

function parseInput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed("The Enterprise request violated its published contract.");
  }
  return parsed.data;
}

function validateOutput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("The Enterprise service produced an invalid response.");
  }
  return parsed.data;
}
