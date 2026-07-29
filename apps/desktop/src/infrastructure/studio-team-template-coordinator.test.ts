import { describe, expect, it, vi } from "vitest";

import type { StudioTeamTemplateRemotePort } from "./studio-team-template-service";
import {
  StudioTeamTemplateCoordinator,
  type StudioTeamTemplateLocalApplicationPort,
  type StudioTeamTemplateLocalApplicationReceipt,
  type StudioTeamTemplateProjectKeyAccessPort,
  type VerifiedStudioTeamTemplateApplication,
} from "./studio-team-template-coordinator";
import {
  StudioTeamTemplateCrypto,
  createStudioTeamTemplateAad,
  type OpenedStudioTeamTemplateProjectKey,
  type StudioTeamTemplatePayload,
} from "./studio-team-template-crypto";
import {
  StudioTeamTemplateService,
  type StudioTeamTemplateSessionContext,
} from "./studio-team-template-service";
import type {
  CloudTeamTemplateSummary,
  CloudTeamTemplateVersion,
  CloudTeamTemplateVersionSummary,
} from "@inkshadow/contracts";

describe("Studio encrypted team-template coordinator", () => {
  it("creates a draft with only ciphertext crossing the remote boundary", async () => {
    const key = await createProjectKey();
    const cloud = remote();
    const create = vi.fn<StudioTeamTemplateRemotePort["createTeamTemplate"]>(
      (
        _teamId: string,
        _projectId: string,
        request: Parameters<StudioTeamTemplateRemotePort["createTeamTemplate"]>[2],
      ) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          requestId: uuid(90),
          template: template({
            templateId: request.templateId,
            state: "draft",
            latestVersionNumber: 1,
            revision: 1,
          }),
          version: versionSummary({
            templateId: request.templateId,
            versionId: request.versionId,
            versionNumber: 1,
            projectKeyVersion: request.projectKeyVersion,
          }),
        }),
    );
    cloud.createTeamTemplate = create;
    const coordinator = coordinatorFixture({
      cloud,
      currentKey: openedKey(key),
      exactKeys: new Map([[1, openedKey(key)]]),
      ids: [uuid(10), uuid(11)],
    });
    const payload = templatePayload("Never leave this device");

    const created = await coordinator.createDraft(CONTEXT, payload);

    expect(created.payload.title).toBe(payload.title);
    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[2];
    expect(request?.authorDeviceId).toBe(CONTEXT.deviceId);
    expect(request?.payload.aad).toMatchObject({
      tenantId: CONTEXT.tenantId,
      teamId: CONTEXT.teamId,
      projectId: CONTEXT.projectId,
      templateId: uuid(10),
      versionId: uuid(11),
      versionNumber: 1,
      projectKeyVersion: 1,
    });
    expect(JSON.stringify(request)).not.toContain(payload.title);
    expect(JSON.stringify(request)).not.toContain(payload.promptRules[0]?.instruction);
    if (request === undefined) {
      throw new Error("Expected encrypted create request.");
    }
    expect(await new StudioTeamTemplateCrypto().decrypt(request.payload, openedKey(key))).toEqual(
      payload,
    );
  });

  it("clones only the published version and re-encrypts it under new target AAD/current key", async () => {
    const oldKey = await createProjectKey();
    const currentKey = await createProjectKey();
    const crypto = new StudioTeamTemplateCrypto();
    const sourceTemplateId = uuid(20);
    const sourceVersionId = uuid(21);
    const sourcePayload = templatePayload("Published source");
    const sourceEnvelope = await crypto.encrypt(
      sourcePayload,
      createStudioTeamTemplateAad({
        tenantId: CONTEXT.tenantId,
        teamId: CONTEXT.teamId,
        projectId: CONTEXT.projectId,
        templateId: sourceTemplateId,
        versionId: sourceVersionId,
        versionNumber: 1,
        projectKeyVersion: 1,
      }),
      openedKey(oldKey),
    );
    const source = template({
      templateId: sourceTemplateId,
      state: "published",
      publishedVersionNumber: 1,
      latestVersionNumber: 1,
      revision: 2,
    });
    const sourceVersion = version({
      templateId: sourceTemplateId,
      versionId: sourceVersionId,
      payload: sourceEnvelope,
    });
    const cloud = readingRemote(source, [sourceVersion]);
    const clone = vi.fn<StudioTeamTemplateRemotePort["cloneTeamTemplate"]>(
      (
        _teamId: string,
        _projectId: string,
        _sourceTemplateId: string,
        request: Parameters<StudioTeamTemplateRemotePort["cloneTeamTemplate"]>[3],
      ) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          requestId: uuid(91),
          template: template({
            templateId: request.targetTemplateId,
            state: "draft",
            latestVersionNumber: 1,
            revision: 1,
          }),
          version: versionSummary({
            templateId: request.targetTemplateId,
            versionId: request.versionId,
            versionNumber: 1,
            projectKeyVersion: request.projectKeyVersion,
          }),
        }),
    );
    cloud.cloneTeamTemplate = clone;
    const coordinator = coordinatorFixture({
      cloud,
      currentKey: openedKey(currentKey, PROJECT_ID, 2),
      exactKeys: new Map([[1, openedKey(oldKey)]]),
      ids: [uuid(22), uuid(23)],
    });

    const cloned = await coordinator.clonePublished(CONTEXT, sourceTemplateId);

    expect(cloned.template.state).toBe("draft");
    const request = clone.mock.calls[0]?.[3];
    expect(request?.sourceVersionId).toBe(sourceVersionId);
    expect(request?.expectedSourceRevision).toBe(2);
    expect(request?.payload.aad).toMatchObject({
      templateId: uuid(22),
      versionId: uuid(23),
      versionNumber: 1,
      projectKeyVersion: 2,
    });
    expect(request?.payload.ciphertext).not.toBe(sourceEnvelope.ciphertext);
    if (request === undefined) {
      throw new Error("Expected encrypted clone request.");
    }
    expect(await crypto.decrypt(request.payload, openedKey(currentKey, PROJECT_ID, 2))).toEqual(
      sourcePayload,
    );
  });

  it("commits the local CAS receipt before cloud metadata and retries without reapplying", async () => {
    const key = await createProjectKey();
    const crypto = new StudioTeamTemplateCrypto();
    const publishedTemplateId = uuid(30);
    const publishedVersionId = uuid(31);
    const payload = templatePayload("Apply once");
    const envelope = await crypto.encrypt(
      payload,
      createStudioTeamTemplateAad({
        tenantId: CONTEXT.tenantId,
        teamId: CONTEXT.teamId,
        projectId: CONTEXT.projectId,
        templateId: publishedTemplateId,
        versionId: publishedVersionId,
        versionNumber: 1,
        projectKeyVersion: 1,
      }),
      openedKey(key),
    );
    const published = template({
      templateId: publishedTemplateId,
      state: "published",
      publishedVersionNumber: 1,
      latestVersionNumber: 1,
      revision: 2,
    });
    const publishedVersion = version({
      templateId: publishedTemplateId,
      versionId: publishedVersionId,
      payload: envelope,
    });
    const cloud = readingRemote(published, [publishedVersion]);
    const order: string[] = [];
    let committed: StudioTeamTemplateLocalApplicationReceipt | null = null;
    const applications = {
      applyAtomically: vi.fn<StudioTeamTemplateLocalApplicationPort["applyAtomically"]>(
        (application) => {
          order.push("local");
          committed = receipt(application);
          return Promise.resolve(committed);
        },
      ),
      findCommitted: vi.fn<StudioTeamTemplateLocalApplicationPort["findCommitted"]>(() =>
        Promise.resolve(committed),
      ),
      listPendingCloudRecords: vi.fn<
        StudioTeamTemplateLocalApplicationPort["listPendingCloudRecords"]
      >(() => Promise.resolve(committed === null ? [] : [committed])),
      markCloudRecorded: vi.fn<StudioTeamTemplateLocalApplicationPort["markCloudRecorded"]>(
        (localReceipt, cloudRecordedAt) =>
          Promise.resolve({
            ...localReceipt,
            cloudRecordedAt,
          }),
      ),
    } satisfies StudioTeamTemplateLocalApplicationPort;
    const record = vi
      .fn<StudioTeamTemplateRemotePort["recordTeamTemplateApplication"]>()
      .mockImplementationOnce(() => {
        order.push("cloud-first");
        return Promise.reject(
          Object.assign(new Error("lost response"), { code: "NETWORK_TIMEOUT" }),
        );
      })
      .mockImplementation(
        (
          _teamId: string,
          _projectId: string,
          templateId: string,
          request: Parameters<StudioTeamTemplateRemotePort["recordTeamTemplateApplication"]>[3],
        ) => {
          order.push("cloud-retry");
          return Promise.resolve({
            schemaVersion: 1 as const,
            requestId: uuid(94),
            applicationId: request.applicationId,
            tenantId: CONTEXT.tenantId,
            teamId: CONTEXT.teamId,
            projectId: CONTEXT.projectId,
            templateId,
            versionId: request.versionId,
            appliedByMembershipId: CONTEXT.membershipId,
            appliedAt: NOW,
            effect: "metadata_only_no_server_content_mutation" as const,
          });
        },
      );
    cloud.recordTeamTemplateApplication = record;
    const coordinator = coordinatorFixture({
      cloud,
      currentKey: openedKey(key),
      exactKeys: new Map([[1, openedKey(key)]]),
      applications,
      ids: [uuid(32)],
    });

    const first = await coordinator.applyPublished(CONTEXT, {
      templateId: publishedTemplateId,
      expectedProjectRevision: 7,
    });
    expect(first.status).toBe("partial_retry");
    expect(order).toEqual(["local", "cloud-first"]);
    expect(applications.applyAtomically).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    if (first.status !== "partial_retry") {
      throw new Error("Expected a retryable cloud receipt.");
    }
    expect(first.receipt).toMatchObject({
      applicationId: uuid(32),
      templateId: publishedTemplateId,
      versionId: publishedVersionId,
      projectRevisionBefore: 7,
      projectRevisionAfter: 8,
      result: "applied",
    });

    const retried = await coordinator.retryApplicationRecord(CONTEXT, first);
    expect(retried.status).toBe("recorded");
    if (retried.status === "recorded") {
      expect(retried.receipt.cloudRecordedAt).toBe(NOW);
    }
    expect(order).toEqual(["local", "cloud-first", "cloud-retry"]);
    expect(applications.applyAtomically).toHaveBeenCalledTimes(1);
    expect(applications.findCommitted).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0]?.[4]?.idempotencyKey).toBe(
      record.mock.calls[1]?.[4]?.idempotencyKey,
    );
  });

  it("recovers bounded pending cloud records after restart without invoking local apply", async () => {
    const key = await createProjectKey();
    const pending: StudioTeamTemplateLocalApplicationReceipt = {
      authority: "local_team_template_application",
      applicationId: uuid(35),
      tenantId: CONTEXT.tenantId,
      teamId: CONTEXT.teamId,
      projectId: CONTEXT.projectId,
      templateId: uuid(36),
      templateRevision: 2,
      versionId: uuid(37),
      versionNumber: 1,
      contentDigest: "d".repeat(64),
      projectRevisionBefore: 3,
      projectRevisionAfter: 4,
      cloudIdempotencyKey: "team-template.recovery.pending.0001",
      requestedByMembershipId: CONTEXT.membershipId,
      appliedAt: NOW,
      cloudRecordedAt: null,
      result: "applied",
    };
    const cloud = remote();
    cloud.recordTeamTemplateApplication = vi.fn<
      StudioTeamTemplateRemotePort["recordTeamTemplateApplication"]
    >((_teamId, _projectId, templateId, request) =>
      Promise.resolve({
        schemaVersion: 1 as const,
        requestId: uuid(98),
        applicationId: request.applicationId,
        tenantId: CONTEXT.tenantId,
        teamId: CONTEXT.teamId,
        projectId: CONTEXT.projectId,
        templateId,
        versionId: request.versionId,
        appliedByMembershipId: CONTEXT.membershipId,
        appliedAt: NOW,
        effect: "metadata_only_no_server_content_mutation" as const,
      }),
    );
    const applications = {
      applyAtomically: vi.fn(),
      findCommitted: vi.fn(),
      listPendingCloudRecords: vi.fn<
        StudioTeamTemplateLocalApplicationPort["listPendingCloudRecords"]
      >(() => Promise.resolve([pending])),
      markCloudRecorded: vi.fn<StudioTeamTemplateLocalApplicationPort["markCloudRecorded"]>(
        (receiptValue, cloudRecordedAt) =>
          Promise.resolve({
            ...receiptValue,
            cloudRecordedAt,
          }),
      ),
    } satisfies StudioTeamTemplateLocalApplicationPort;
    const coordinator = coordinatorFixture({
      cloud,
      currentKey: openedKey(key),
      exactKeys: new Map([[1, openedKey(key)]]),
      applications,
    });

    const outcomes = await coordinator.recoverPendingApplicationRecords(CONTEXT, { limit: 10 });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      status: "recorded",
      receipt: { applicationId: pending.applicationId, cloudRecordedAt: NOW },
    });
    expect(applications.listPendingCloudRecords).toHaveBeenCalledWith(
      {
        tenantId: CONTEXT.tenantId,
        teamId: CONTEXT.teamId,
        projectId: CONTEXT.projectId,
      },
      10,
      undefined,
    );
    expect(applications.applyAtomically).not.toHaveBeenCalled();
    expect(cloud.recordTeamTemplateApplication).toHaveBeenCalledTimes(1);
  });

  it("never records cloud metadata when the local project CAS transaction fails", async () => {
    const fixture = await publishedFixture("CAS failure");
    const applications = {
      applyAtomically: vi.fn<StudioTeamTemplateLocalApplicationPort["applyAtomically"]>(() =>
        Promise.reject(
          Object.assign(new Error("revision changed"), {
            code: "LOCAL_PROJECT_REVISION_CONFLICT",
          }),
        ),
      ),
      findCommitted: vi.fn(),
      listPendingCloudRecords: vi.fn(),
      markCloudRecorded: vi.fn(),
    } satisfies StudioTeamTemplateLocalApplicationPort;
    const coordinator = coordinatorFixture({
      ...fixture,
      applications,
      ids: [uuid(42)],
    });

    await expect(
      coordinator.applyPublished(CONTEXT, {
        templateId: fixture.templateId,
        expectedProjectRevision: 4,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_PROJECT_REVISION_CONFLICT" });
    expect(applications.applyAtomically).toHaveBeenCalledTimes(1);
    expect(fixture.cloud.recordTeamTemplateApplication).not.toHaveBeenCalled();
  });

  it("keeps archived history readable and isolates per-version decryption failures", async () => {
    const key = await createProjectKey();
    const crypto = new StudioTeamTemplateCrypto();
    const templateId = uuid(50);
    const firstId = uuid(51);
    const secondId = uuid(52);
    const firstEnvelope = await encryptVersion(
      crypto,
      key,
      templateId,
      firstId,
      1,
      templatePayload("Readable historical title"),
    );
    const secondEnvelope = await encryptVersion(
      crypto,
      key,
      templateId,
      secondId,
      2,
      templatePayload("Corrupt historical title"),
    );
    const archived = template({
      templateId,
      state: "archived",
      publishedVersionNumber: null,
      latestVersionNumber: 2,
      revision: 3,
    });
    const first = version({
      templateId,
      versionId: firstId,
      versionNumber: 1,
      payload: firstEnvelope,
    });
    const second = version({
      templateId,
      versionId: secondId,
      versionNumber: 2,
      payload: { ...secondEnvelope, ciphertextSha256: "0".repeat(64) },
    });
    const cloud = readingRemote(archived, [first, second]);
    const coordinator = coordinatorFixture({
      cloud,
      currentKey: openedKey(key),
      exactKeys: new Map([[1, openedKey(key)]]),
    });

    const history = await coordinator.exportTemplateHistory(CONTEXT, templateId);

    expect(history.kind).toBe("inkshadow_team_template_history");
    expect(history.template.state).toBe("archived");
    expect(history.versions[0]).toMatchObject({
      state: "ready",
      payload: { title: "Readable historical title" },
    });
    expect(history.versions[1]).toMatchObject({
      state: "decrypt_error",
      errorCode: "TEAM_TEMPLATE_CIPHERTEXT_HASH_MISMATCH",
    });
    expect(history.versions[1]).not.toHaveProperty("payload");
  });

  it("requires an exact committed receipt before a cloud-only retry", async () => {
    const key = await createProjectKey();
    const cloud = remote();
    const applications = {
      applyAtomically: vi.fn(),
      findCommitted: vi.fn<StudioTeamTemplateLocalApplicationPort["findCommitted"]>(() =>
        Promise.resolve(null),
      ),
      listPendingCloudRecords: vi.fn(),
      markCloudRecorded: vi.fn(),
    } satisfies StudioTeamTemplateLocalApplicationPort;
    const coordinator = coordinatorFixture({
      cloud,
      currentKey: openedKey(key),
      exactKeys: new Map([[1, openedKey(key)]]),
      applications,
    });
    const forged: StudioTeamTemplateLocalApplicationReceipt = {
      authority: "local_team_template_application",
      applicationId: uuid(70),
      tenantId: CONTEXT.tenantId,
      teamId: CONTEXT.teamId,
      projectId: CONTEXT.projectId,
      templateId: uuid(71),
      templateRevision: 2,
      versionId: uuid(72),
      versionNumber: 1,
      contentDigest: "a".repeat(64),
      projectRevisionBefore: 3,
      projectRevisionAfter: 4,
      cloudIdempotencyKey: "team-template.forged.0001",
      requestedByMembershipId: CONTEXT.membershipId,
      appliedAt: NOW,
      cloudRecordedAt: null,
      result: "applied",
    };

    await expect(
      coordinator.retryApplicationRecord(CONTEXT, {
        status: "partial_retry",
        receipt: forged,
        failureCode: "NETWORK_TIMEOUT",
      }),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_APPLICATION_RECEIPT_INVALID" });
    expect(cloud.recordTeamTemplateApplication).not.toHaveBeenCalled();
  });
});

const TENANT_ID = uuid(1);
const TEAM_ID = uuid(2);
const PROJECT_ID = uuid(3);
const MEMBERSHIP_ID = uuid(4);
const DEVICE_ID = uuid(5);
const NOW = "2026-07-28T10:00:00.000Z";
const CREATED = "2026-07-28T09:00:00.000Z";

const CONTEXT: StudioTeamTemplateSessionContext = {
  tenantId: TENANT_ID,
  teamId: TEAM_ID,
  projectId: PROJECT_ID,
  membershipId: MEMBERSHIP_ID,
  deviceId: DEVICE_ID,
  role: "owner",
  membershipState: "active",
  assignmentState: "active",
};

function coordinatorFixture(input: {
  cloud: StudioTeamTemplateRemotePort;
  currentKey: OpenedStudioTeamTemplateProjectKey;
  exactKeys: ReadonlyMap<number, OpenedStudioTeamTemplateProjectKey>;
  ids?: readonly string[];
  applications?: StudioTeamTemplateLocalApplicationPort;
}): StudioTeamTemplateCoordinator {
  const ids = [...(input.ids ?? [uuid(80), uuid(81), uuid(82)])];
  const projectKeys = {
    openCurrentTemplateProjectKey: vi.fn<
      StudioTeamTemplateProjectKeyAccessPort["openCurrentTemplateProjectKey"]
    >(() => Promise.resolve(input.currentKey)),
    openTemplateProjectKey: vi.fn<StudioTeamTemplateProjectKeyAccessPort["openTemplateProjectKey"]>(
      ({ keyVersion }) => {
        const key = input.exactKeys.get(keyVersion);
        if (key === undefined) {
          return Promise.reject(new Error("missing key"));
        }
        return Promise.resolve(key);
      },
    ),
  } satisfies StudioTeamTemplateProjectKeyAccessPort;
  return new StudioTeamTemplateCoordinator({
    service: new StudioTeamTemplateService(
      input.cloud,
      { isOnline: () => true },
      { isMutationEnabled: () => true },
    ),
    crypto: new StudioTeamTemplateCrypto(),
    projectKeys,
    applications:
      input.applications ??
      ({
        applyAtomically: vi.fn(),
        findCommitted: vi.fn(),
        listPendingCloudRecords: vi.fn(),
        markCloudRecorded: vi.fn(),
      } satisfies StudioTeamTemplateLocalApplicationPort),
    ids: {
      next: () => {
        const value = ids.shift();
        if (value === undefined) {
          throw new Error("No test UUID remains.");
        }
        return value;
      },
    },
    idempotencyKeys: {
      next: (purpose) => `idem.${purpose}.0000000001`,
    },
  });
}

function remote() {
  return {
    archiveTeamTemplate: vi.fn(),
    cloneTeamTemplate: vi.fn(),
    createTeamTemplate: vi.fn(),
    createTeamTemplateVersion: vi.fn(),
    getTeamTemplate: vi.fn(),
    getTeamTemplateVersion: vi.fn(),
    listTeamTemplates: vi.fn(),
    listTeamTemplateVersions: vi.fn(),
    publishTeamTemplate: vi.fn(),
    recordTeamTemplateApplication: vi.fn(),
  } satisfies StudioTeamTemplateRemotePort;
}

function readingRemote(
  currentTemplate: CloudTeamTemplateSummary,
  versions: readonly CloudTeamTemplateVersion[],
) {
  const cloud = remote();
  cloud.getTeamTemplate = vi.fn<StudioTeamTemplateRemotePort["getTeamTemplate"]>(() =>
    Promise.resolve({
      schemaVersion: 1 as const,
      requestId: uuid(95),
      template: currentTemplate,
    }),
  );
  cloud.listTeamTemplateVersions = vi.fn<StudioTeamTemplateRemotePort["listTeamTemplateVersions"]>(
    () =>
      Promise.resolve({
        schemaVersion: 1 as const,
        requestId: uuid(96),
        versions: versions.map(({ payload, ...summary }) => {
          void payload;
          return summary;
        }),
        nextCursor: null,
      }),
  );
  cloud.getTeamTemplateVersion = vi.fn<StudioTeamTemplateRemotePort["getTeamTemplateVersion"]>(
    (_teamId, _projectId, _templateId, versionId) => {
      const found = versions.find((candidate) => candidate.versionId === versionId);
      return found === undefined
        ? Promise.reject(new Error("version not found"))
        : Promise.resolve({ schemaVersion: 1 as const, requestId: uuid(97), version: found });
    },
  );
  return cloud;
}

async function publishedFixture(title: string): Promise<{
  cloud: ReturnType<typeof readingRemote>;
  currentKey: OpenedStudioTeamTemplateProjectKey;
  exactKeys: ReadonlyMap<number, OpenedStudioTeamTemplateProjectKey>;
  templateId: string;
}> {
  const key = await createProjectKey();
  const crypto = new StudioTeamTemplateCrypto();
  const templateId = uuid(40);
  const versionId = uuid(41);
  const envelope = await encryptVersion(
    crypto,
    key,
    templateId,
    versionId,
    1,
    templatePayload(title),
  );
  const current = template({
    templateId,
    state: "published",
    publishedVersionNumber: 1,
    latestVersionNumber: 1,
    revision: 2,
  });
  const cloudVersion = version({ templateId, versionId, payload: envelope });
  return {
    cloud: readingRemote(current, [cloudVersion]),
    currentKey: openedKey(key),
    exactKeys: new Map([[1, openedKey(key)]]),
    templateId,
  };
}

function receipt(
  application: VerifiedStudioTeamTemplateApplication,
): StudioTeamTemplateLocalApplicationReceipt {
  return {
    authority: "local_team_template_application",
    applicationId: application.applicationId,
    tenantId: application.tenantId,
    teamId: application.teamId,
    projectId: application.projectId,
    templateId: application.templateId,
    templateRevision: application.templateRevision,
    versionId: application.versionId,
    versionNumber: application.versionNumber,
    contentDigest: application.contentDigest,
    projectRevisionBefore: application.expectedProjectRevision,
    projectRevisionAfter: application.expectedProjectRevision + 1,
    cloudIdempotencyKey: application.cloudIdempotencyKey,
    requestedByMembershipId: application.requestedByMembershipId,
    appliedAt: NOW,
    cloudRecordedAt: null,
    result: "applied",
  };
}

function template(input: {
  templateId: string;
  state: CloudTeamTemplateSummary["state"];
  publishedVersionNumber?: number | null;
  latestVersionNumber?: number;
  revision?: number;
}): CloudTeamTemplateSummary {
  const publishedVersionNumber = input.publishedVersionNumber ?? null;
  return {
    schemaVersion: 1,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    templateId: input.templateId,
    state: input.state,
    revision: input.revision ?? 1,
    latestVersionNumber: input.latestVersionNumber ?? 1,
    publishedVersionNumber,
    createdByMembershipId: MEMBERSHIP_ID,
    createdAt: CREATED,
    updatedAt: NOW,
    publishedAt: publishedVersionNumber === null ? null : NOW,
    archivedAt: input.state === "archived" ? NOW : null,
  };
}

function versionSummary(input: {
  templateId: string;
  versionId: string;
  versionNumber?: number;
  projectKeyVersion?: number;
}): CloudTeamTemplateVersionSummary {
  return {
    schemaVersion: 1,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    templateId: input.templateId,
    versionId: input.versionId,
    versionNumber: input.versionNumber ?? 1,
    projectKeyVersion: input.projectKeyVersion ?? 1,
    authorMembershipId: MEMBERSHIP_ID,
    authorDeviceId: DEVICE_ID,
    clonedFromTemplateId: null,
    clonedFromVersionId: null,
    createdAt: CREATED,
  };
}

function version(input: {
  templateId: string;
  versionId: string;
  payload: CloudTeamTemplateVersion["payload"];
  versionNumber?: number;
  projectKeyVersion?: number;
}): CloudTeamTemplateVersion {
  return {
    ...versionSummary(input),
    payload: input.payload,
  };
}

function templatePayload(title: string): StudioTeamTemplatePayload {
  return {
    schemaVersion: 1,
    kind: "team_template",
    title,
    projectSettings: [{ key: "genre", value: "mystery" }],
    promptRegistryRefs: [{ registryId: uuid(6), revision: 1 }],
    promptRules: [
      {
        ruleId: uuid(7),
        label: "Voice",
        instruction: "Private author-only prompt rule.",
      },
    ],
    reviewChecklist: [{ itemId: uuid(8), label: "Continuity", required: true }],
  };
}

async function encryptVersion(
  crypto: StudioTeamTemplateCrypto,
  key: CryptoKey,
  templateId: string,
  versionId: string,
  versionNumber: number,
  payload: StudioTeamTemplatePayload,
) {
  return crypto.encrypt(
    payload,
    createStudioTeamTemplateAad({
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      templateId,
      versionId,
      versionNumber,
      projectKeyVersion: 1,
    }),
    openedKey(key),
  );
}

async function createProjectKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function openedKey(
  key: CryptoKey,
  projectId = PROJECT_ID,
  keyVersion = 1,
): OpenedStudioTeamTemplateProjectKey {
  return { projectId, keyVersion, key };
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
