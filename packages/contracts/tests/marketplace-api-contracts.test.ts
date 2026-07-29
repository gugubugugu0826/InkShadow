import { describe, expect, it } from "vitest";

import {
  CloudMarketplaceArtifactSummarySchema,
  CloudMarketplaceCatalogResponseSchema,
  CloudMarketplaceStructuredArtifactSchema,
  CloudMarketplaceSubmissionRequestSchema,
  canonicalMarketplaceJson,
  expectedMarketplaceHighRiskConfirmation,
  marketplaceSubmissionSignaturePayload,
} from "../src/marketplace-api-schemas.js";
import { CONTRACT_SCHEMA_VERSION } from "../src/schemas.js";
import { CLOUD_API_OPERATIONS, INKSHADOW_CLOUD_OPENAPI } from "../src/cloud-openapi.js";

const ARTIFACT_ID = "0198b111-0000-7000-8000-000000000001";
const VERSION_ID = "0198b111-0000-7000-8000-000000000002";
const AUTHOR_ID = "0198b111-0000-7000-8000-000000000003";
const REQUEST_ID = "0198b111-0000-7000-8000-000000000004";
const CREATED_AT = "2026-07-29T01:00:00.000Z";

describe("marketplace API contracts", () => {
  it("accepts only data-only structured artifacts", () => {
    expect(CloudMarketplaceStructuredArtifactSchema.parse(structuredArtifact())).toEqual(
      structuredArtifact(),
    );
    expect(() =>
      CloudMarketplaceStructuredArtifactSchema.parse(
        structuredArtifact({
          value: "Run <script>alert('unsafe')</script>",
        }),
      ),
    ).toThrow();
    expect(() =>
      CloudMarketplaceStructuredArtifactSchema.parse(
        structuredArtifact({
          value: "Load the reference from https://example.test/template.json",
        }),
      ),
    ).toThrow();
    expect(() =>
      CloudMarketplaceStructuredArtifactSchema.parse({
        ...structuredArtifact(),
        command: "powershell.exe",
      }),
    ).toThrow();
  });

  it("binds digest and signatures to a deterministic canonical payload", () => {
    const request = submission();
    expect(CloudMarketplaceSubmissionRequestSchema.parse(request)).toEqual(request);
    const canonical = canonicalMarketplaceJson(marketplaceSubmissionSignaturePayload(request));
    expect(canonical).toContain('"purpose":"inkshadow.marketplace.artifact-version"');
    expect(canonical.indexOf('"artifactId"')).toBeLessThan(canonical.indexOf('"versionId"'));
    expect(expectedMarketplaceHighRiskConfirmation("quarantine", VERSION_ID)).toBe(
      `MARKETPLACE:QUARANTINE:${VERSION_ID}`,
    );
  });

  it("rejects inconsistent lifecycle metadata and non-public catalog entries", () => {
    const published = artifactSummary();
    expect(CloudMarketplaceArtifactSummarySchema.parse(published)).toEqual(published);
    expect(() =>
      CloudMarketplaceArtifactSummarySchema.parse({
        ...published,
        publishedVersionId: null,
      }),
    ).toThrow();
    expect(() =>
      CloudMarketplaceCatalogResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        artifacts: [
          {
            ...published,
            state: "quarantined",
            quarantinedAt: CREATED_AT,
            retentionUntil: "2026-10-27T01:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("publishes every marketplace route in the generated OpenAPI contract", () => {
    const operations = CLOUD_API_OPERATIONS.filter(({ operationId }) =>
      operationId.startsWith("marketplace."),
    );
    expect(operations).toHaveLength(10);
    expect(
      operations.map(({ method, operationId, path, requiresIdempotencyKey }) => ({
        method,
        operationId,
        path,
        requiresIdempotencyKey,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          method: "get",
          operationId: "marketplace.listCatalog",
          path: "/v1/marketplace/artifacts",
          requiresIdempotencyKey: false,
        },
        {
          method: "post",
          operationId: "marketplace.download",
          path: "/v1/marketplace/artifacts/{artifactId}/downloads",
          requiresIdempotencyKey: true,
        },
        {
          method: "post",
          operationId: "marketplace.moderateVersion",
          path: "/v1/marketplace/artifacts/{artifactId}/versions/{versionId}/moderation",
          requiresIdempotencyKey: true,
        },
      ]),
    );
    const document = INKSHADOW_CLOUD_OPENAPI as {
      readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      readonly components: {
        readonly schemas: Readonly<Record<string, unknown>>;
      };
    };
    expect(document.paths["/v1/marketplace/artifacts"]?.get).toMatchObject({
      operationId: "marketplace.listCatalog",
      security: [{ bearerAuth: [] }],
    });
    expect(document.components.schemas.MarketplaceDownloadResponse).toBeDefined();
  });
});

function structuredArtifact(override: { readonly value?: string } = {}) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    format: "inkshadow.marketplace.structured-artifact.v1" as const,
    sections: [
      {
        sectionId: "story_seed",
        title: "Story seed",
        items: [
          {
            itemId: "premise",
            kind: "text" as const,
            label: "Premise",
            value: override.value ?? "A cartographer discovers a city erased from every map.",
          },
          {
            itemId: "tones",
            kind: "text_list" as const,
            label: "Tones",
            value: ["mysterious", "hopeful"],
          },
        ],
      },
    ],
  };
}

function submission() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: ARTIFACT_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    semanticVersion: "1.0.0",
    authorAccountId: AUTHOR_ID,
    authorDisplayName: "Ink Cartographer",
    kind: "story_template" as const,
    title: "The Vanished City",
    summary: "A structured story seed for mystery adventures.",
    tags: ["adventure", "mystery"],
    license: "cc-by-4.0" as const,
    content: structuredArtifact(),
    contentDigestSha256: "a".repeat(64),
    authorPublicKeySpki: "A".repeat(60),
    authorSignature: "B".repeat(86),
  };
}

function artifactSummary() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: ARTIFACT_ID,
    authorAccountId: AUTHOR_ID,
    authorDisplayName: "Ink Cartographer",
    kind: "story_template" as const,
    title: "The Vanished City",
    summary: "A structured story seed for mystery adventures.",
    tags: ["adventure", "mystery"],
    license: "cc-by-4.0" as const,
    state: "published" as const,
    revision: 2,
    latestVersionNumber: 1,
    pendingVersionId: null,
    publishedVersionId: VERSION_ID,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    publishedAt: CREATED_AT,
    quarantinedAt: null,
    withdrawnAt: null,
    retentionUntil: null,
  };
}
