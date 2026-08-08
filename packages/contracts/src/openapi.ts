import { z, type ZodType } from "zod";

import {
  CLOUD_API_OPERATIONS,
  getCloudApiComponentSchema,
  type CloudApiComponentSchemaName,
  type CloudApiOperationDefinition,
} from "./cloud-openapi.js";

/**
 * The generated OpenAPI document is intentionally isolated from the runtime
 * contract entry point. Production clients need the operation registry and
 * Zod validators, but they must not pay the cost of turning every validator
 * into JSON Schema during application startup.
 */
export const INKSHADOW_CLOUD_OPENAPI = createOpenApiDocument();

function createOpenApiDocument(): Readonly<Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const definition of CLOUD_API_OPERATIONS) {
    const pathItem = paths[definition.path] ?? {};
    pathItem[definition.method] = createOpenApiOperation(definition);
    paths[definition.path] = pathItem;
  }

  const schemas = Object.fromEntries(
    getOpenApiComponentSchemaNames().map((name) => [
      name,
      createOpenApiComponentSchema(name, getCloudApiComponentSchema(name)),
    ]),
  );

  return Object.freeze({
    openapi: "3.1.1",
    info: {
      title: "InkShadow Cloud Ciphertext API",
      version: "1.0.0",
      description:
        "Replaceable identity, session, public-device-key and ciphertext-sync contract. Creative plaintext and private keys are outside this API.",
    },
    servers: [{ url: "https://api.inkshadow.invalid" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque",
        },
      },
      schemas,
    },
  });
}

function getOpenApiComponentSchemaNames(): readonly CloudApiComponentSchemaName[] {
  // These two schemas are referenced by OpenAPI defaults/nested `$ref`s rather
  // than directly by an operation request or response.
  const names = new Set<CloudApiComponentSchemaName>(["ApiErrorResponse", "DeletionRequest"]);
  for (const definition of CLOUD_API_OPERATIONS) {
    if (definition.requestSchemaName !== null) {
      names.add(definition.requestSchemaName);
    }
    names.add(definition.successSchemaName);
  }
  return [...names];
}

function createOpenApiComponentSchema(
  name: CloudApiComponentSchemaName,
  schema: ZodType,
): Readonly<Record<string, unknown>> {
  const generated = withoutDialectDeclaration(z.toJSONSchema(schema));
  if (name === "AccountDeletionLookupRequest") {
    const variants = Array.isArray(generated.anyOf) ? generated.anyOf : generated.oneOf;
    if (!Array.isArray(variants) || variants.length !== 2) {
      throw new Error("Account deletion lookup must expose a strict two-variant recovery proof.");
    }
    const shared = Object.fromEntries(
      Object.entries(generated).filter(([propertyName]) => propertyName !== "anyOf"),
    );
    return {
      ...shared,
      oneOf: variants,
      "x-inkshadow-proof-selector": "exactly one of deletionRequestId or confirmationId",
    };
  }
  if (name === "DeletionRequest") {
    return {
      ...generated,
      allOf: [
        {
          oneOf: [
            deletionStateVariant({
              title: "Grace period",
              state: "grace_period",
              phases: ["freeze"],
              canCancel: true,
              nullFields: [
                "commitStartedAt",
                "liveDataPurgedAt",
                "backupRetainedUntil",
                "completedAt",
                "blockedReason",
              ],
            }),
            deletionStateVariant({
              title: "Blocked before commit",
              state: "blocked",
              phases: ["freeze"],
              canCancel: true,
              nullFields: [
                "commitStartedAt",
                "liveDataPurgedAt",
                "backupRetainedUntil",
                "completedAt",
              ],
              nonNullFields: ["blockedReason"],
            }),
            deletionStateVariant({
              title: "Purging before the live-data marker",
              state: "purging",
              phases: ["derived", "ciphertext", "keys", "access"],
              canCancel: false,
              nullFields: [
                "liveDataPurgedAt",
                "backupRetainedUntil",
                "completedAt",
                "blockedReason",
              ],
              nonNullFields: ["commitStartedAt"],
            }),
            deletionStateVariant({
              title: "Purging after the live-data marker",
              state: "purging",
              phases: ["marker", "verify"],
              canCancel: false,
              nullFields: ["backupRetainedUntil", "completedAt", "blockedReason"],
              nonNullFields: ["commitStartedAt", "liveDataPurgedAt"],
            }),
            deletionStateVariant({
              title: "Waiting for managed backup retention",
              state: "backup_retention",
              phases: ["backup_wait"],
              canCancel: false,
              nullFields: ["completedAt", "blockedReason"],
              nonNullFields: ["commitStartedAt", "liveDataPurgedAt", "backupRetainedUntil"],
            }),
            deletionStateVariant({
              title: "Purge complete",
              state: "purged",
              phases: ["complete"],
              canCancel: false,
              nullFields: ["blockedReason"],
              nonNullFields: ["commitStartedAt", "liveDataPurgedAt", "completedAt"],
            }),
            deletionStateVariant({
              title: "Cancelled before commit",
              state: "cancelled",
              phases: ["freeze"],
              canCancel: false,
              nullFields: [
                "commitStartedAt",
                "liveDataPurgedAt",
                "backupRetainedUntil",
                "blockedReason",
              ],
              nonNullFields: ["completedAt"],
            }),
          ],
        },
        {
          oneOf: [
            {
              title: "Project target",
              properties: {
                targetKind: { const: "project" },
                impactSummary: {
                  properties: {
                    projectCount: { const: 1 },
                    deviceCount: { const: 0 },
                    sessionCount: { const: 0 },
                  },
                },
              },
            },
            {
              title: "Account target",
              properties: {
                targetKind: { const: "account" },
              },
            },
          ],
        },
      ],
      "x-inkshadow-timestamp-order": [
        "requestedAt <= cancellableUntil <= scheduledFor",
        "scheduledFor <= commitStartedAt",
        "commitStartedAt <= liveDataPurgedAt",
        "liveDataPurgedAt <= backupRetainedUntil",
        "liveDataPurgedAt <= completedAt",
        "backupRetainedUntil <= completedAt when backupRetainedUntil is present",
        "requestedAt <= completedAt <= cancellableUntil when state is cancelled",
      ],
    };
  }
  if (name === "DeletionRequestResponse") {
    const properties = isOpenApiObject(generated.properties) ? generated.properties : {};
    return {
      ...generated,
      properties: {
        ...properties,
        deletionRequest: {
          $ref: "#/components/schemas/DeletionRequest",
        },
      },
    };
  }
  return generated;
}

function deletionStateVariant(options: {
  readonly title: string;
  readonly state: string;
  readonly phases: readonly [string, ...string[]];
  readonly canCancel: boolean;
  readonly nullFields: readonly string[];
  readonly nonNullFields?: readonly string[];
}): Readonly<Record<string, unknown>> {
  return {
    title: options.title,
    properties: {
      state: { const: options.state },
      phase:
        options.phases.length === 1 ? { const: options.phases[0] } : { enum: [...options.phases] },
      canCancel: { const: options.canCancel },
      ...Object.fromEntries(options.nullFields.map((field) => [field, { type: "null" }])),
      ...Object.fromEntries(
        (options.nonNullFields ?? []).map((field) => [
          field,
          field === "blockedReason"
            ? {
                enum: [
                  "legal_hold_active",
                  "ownership_transfer_required",
                  "external_purge_pending",
                ],
              }
            : { type: "string", format: "date-time" },
        ]),
      ),
    },
  };
}

function isOpenApiObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createOpenApiOperation(
  definition: CloudApiOperationDefinition,
): Readonly<Record<string, unknown>> {
  const parameters: Record<string, unknown>[] = [
    {
      name: "X-Request-Id",
      in: "header",
      required: true,
      schema: {
        type: "string",
        format: "uuid",
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      },
    },
  ];
  for (const parameterName of pathParameterNames(definition.path)) {
    parameters.push({
      name: parameterName,
      in: "path",
      required: true,
      schema:
        parameterName === "keyVersion"
          ? { type: "integer", minimum: 1, maximum: 2_147_483_647 }
          : {
              type: "string",
              format: "uuid",
              pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            },
    });
  }
  if (definition.requiresIdempotencyKey) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: {
        type: "string",
        minLength: 16,
        maxLength: 200,
        pattern: "^[A-Za-z0-9._~-]+$",
      },
    });
  }
  for (const parameter of definition.queryParameters ?? []) {
    parameters.push({
      name: parameter.name,
      in: "query",
      required: parameter.required,
      schema: parameter.schema,
    });
  }

  return {
    operationId: definition.operationId,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    parameters,
    security: definition.requiresAuthentication ? [{ bearerAuth: [] }] : [],
    ...(definition.requestSchemaName === null
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: `#/components/schemas/${definition.requestSchemaName}`,
                },
              },
            },
          },
        }),
    responses: {
      [String(definition.successStatus)]: {
        description: "Successful response",
        content: {
          "application/json": {
            schema: {
              $ref: `#/components/schemas/${definition.successSchemaName}`,
            },
          },
        },
      },
      default: {
        description: "Stable, redacted error",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ApiErrorResponse",
            },
          },
        },
      },
    },
    "x-inkshadow-authentication-required": definition.requiresAuthentication,
    "x-inkshadow-idempotency-required": definition.requiresIdempotencyKey,
    "x-inkshadow-native-password-boundary": definition.requiresNativePasswordBoundary,
  };
}

function pathParameterNames(path: string): readonly string[] {
  return [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
}

function withoutDialectDeclaration(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(schema).filter(([name]) => name !== "$schema"));
}
