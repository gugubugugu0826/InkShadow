import { describe, expect, it } from "vitest";

import {
  CLOUD_API_OPERATIONS,
  CloudTeamTemplateCreateRequestSchema,
  CloudTeamTemplateMutationResponseSchema,
  CloudTeamTemplateVersionSchema,
  CONTRACT_SCHEMA_VERSION,
  getCloudApiOperation,
} from "../src/index.js";

const ids = {
  device: "018f1a00-0000-7001-8000-000000000001",
  membership: "018f1a00-0000-7001-8000-000000000002",
  project: "018f1a00-0000-7001-8000-000000000003",
  request: "018f1a00-0000-7001-8000-000000000004",
  team: "018f1a00-0000-7001-8000-000000000005",
  template: "018f1a00-0000-7001-8000-000000000006",
  tenant: "018f1a00-0000-7001-8000-000000000007",
  version: "018f1a00-0000-7001-8000-000000000008",
} as const;

const aad = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  purpose: "inkshadow.studio.team-template" as const,
  tenantId: ids.tenant,
  teamId: ids.team,
  projectId: ids.project,
  templateId: ids.template,
  versionId: ids.version,
  versionNumber: 1,
  projectKeyVersion: 3,
};
const payload = {
  aad,
  algorithm: "AES-256-GCM" as const,
  nonce: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  ciphertextSha256: "a".repeat(64),
};

describe("encrypted Studio team-template API contracts", () => {
  it("accepts only bounded ciphertext with exact immutable project/template AAD", () => {
    const request = CloudTeamTemplateCreateRequestSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      templateId: ids.template,
      versionId: ids.version,
      versionNumber: 1,
      projectKeyVersion: 3,
      authorDeviceId: ids.device,
      payload,
    });
    expect(request.payload.aad).toEqual(aad);
    expect(
      CloudTeamTemplateCreateRequestSchema.safeParse({
        ...request,
        title: "must remain encrypted",
      }).success,
    ).toBe(false);
    expect(
      CloudTeamTemplateCreateRequestSchema.safeParse({
        ...request,
        payload: {
          ...payload,
          aad: { ...aad, projectId: ids.team },
        },
      }).success,
    ).toBe(true);
    expect(
      CloudTeamTemplateCreateRequestSchema.safeParse({
        ...request,
        payload: {
          ...payload,
          aad: { ...aad, templateId: ids.team },
        },
      }).success,
    ).toBe(false);
    expect(
      CloudTeamTemplateCreateRequestSchema.safeParse({
        ...request,
        payload: { ...payload, ciphertext: "A".repeat(349_569) },
      }).success,
    ).toBe(false);
  });

  it("keeps responses metadata-only while version reads return the exact opaque envelope", () => {
    const template = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      tenantId: ids.tenant,
      teamId: ids.team,
      projectId: ids.project,
      templateId: ids.template,
      state: "draft" as const,
      revision: 1,
      latestVersionNumber: 1,
      publishedVersionNumber: null,
      createdByMembershipId: ids.membership,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      publishedAt: null,
      archivedAt: null,
    };
    const versionSummary = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      tenantId: ids.tenant,
      teamId: ids.team,
      projectId: ids.project,
      templateId: ids.template,
      versionId: ids.version,
      versionNumber: 1,
      projectKeyVersion: 3,
      authorMembershipId: ids.membership,
      authorDeviceId: ids.device,
      clonedFromTemplateId: null,
      clonedFromVersionId: null,
      createdAt: "2026-07-28T00:00:00.000Z",
    };
    const mutation = CloudTeamTemplateMutationResponseSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: ids.request,
      template,
      version: versionSummary,
    });
    expect(mutation).not.toHaveProperty("title");
    expect(mutation.version).not.toHaveProperty("payload");
    expect(CloudTeamTemplateVersionSchema.parse({ ...versionSummary, payload }).payload).toEqual(
      payload,
    );
    expect(
      CloudTeamTemplateMutationResponseSchema.safeParse({
        ...mutation,
        template: { ...template, title: "plaintext" },
      }).success,
    ).toBe(false);
  });

  it("publishes the complete authenticated/idempotent operation set", () => {
    const operationIds = [
      "teamTemplates.create",
      "teamTemplates.list",
      "teamTemplates.get",
      "teamTemplateVersions.create",
      "teamTemplateVersions.list",
      "teamTemplateVersions.get",
      "teamTemplates.clone",
      "teamTemplates.publish",
      "teamTemplates.archive",
      "teamTemplateApplications.record",
    ] as const;
    expect(CLOUD_API_OPERATIONS.map((operation) => operation.operationId)).toEqual(
      expect.arrayContaining([...operationIds]),
    );
    for (const operationId of operationIds) {
      const operation = getCloudApiOperation(operationId);
      expect(operation.requiresAuthentication).toBe(true);
      expect(operation.requiresIdempotencyKey).toBe(operation.method === "post");
    }
  });
});
