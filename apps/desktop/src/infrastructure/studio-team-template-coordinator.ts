import type { CloudQueryOptions } from "@inkshadow/cloud-client";
import {
  CONTRACT_SCHEMA_VERSION,
  CloudIdempotencyKeySchema,
  UuidV7Schema,
  type CloudTeamTemplateApplicationResponse,
  type CloudTeamTemplateMutationResponse,
  type CloudTeamTemplateResponse,
  type CloudTeamTemplateSummary,
  type CloudTeamTemplateVersion,
  type CloudTeamTemplateVersionSummary,
} from "@inkshadow/contracts";

import {
  type OpenedStudioTeamTemplateProjectKey,
  type StudioTeamTemplateCrypto,
  StudioTeamTemplateCryptoError,
  type StudioTeamTemplatePayload,
  createStudioTeamTemplateAad,
} from "./studio-team-template-crypto";
import {
  type StudioTeamTemplateCapabilities,
  type StudioTeamTemplateService,
  type StudioTeamTemplateSessionContext,
} from "./studio-team-template-service";

const MAX_PAGES = 100;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

export interface StudioTeamTemplateProjectKeyAccessPort {
  openCurrentTemplateProjectKey(
    scope: Readonly<{ tenantId: string; teamId: string; projectId: string }>,
    signal?: AbortSignal,
  ): Promise<OpenedStudioTeamTemplateProjectKey>;
  openTemplateProjectKey(
    scope: Readonly<{
      tenantId: string;
      teamId: string;
      projectId: string;
      keyVersion: number;
    }>,
    signal?: AbortSignal,
  ): Promise<OpenedStudioTeamTemplateProjectKey>;
}

export interface StudioTeamTemplateIdPort {
  next(): string;
}

export interface StudioTeamTemplateIdempotencyPort {
  next(purpose: string): string;
}

/**
 * This authority is accepted only by a local implementation that commits the
 * project mutation and its idempotency receipt in one local transaction under
 * expectedProjectRevision CAS.
 */
export interface VerifiedStudioTeamTemplateApplication {
  readonly authority: "verified_encrypted_team_template";
  readonly applicationId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly templateRevision: number;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly expectedProjectRevision: number;
  readonly cloudIdempotencyKey: string;
  readonly requestedByMembershipId: string;
  readonly payload: StudioTeamTemplatePayload;
}

export interface StudioTeamTemplateLocalApplicationReceipt {
  readonly authority: "local_team_template_application";
  readonly applicationId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly templateRevision: number;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly projectRevisionBefore: number;
  readonly projectRevisionAfter: number;
  readonly cloudIdempotencyKey: string;
  readonly requestedByMembershipId: string;
  readonly appliedAt: string;
  readonly cloudRecordedAt: string | null;
  readonly result: "applied" | "already_applied";
}

export interface StudioTeamTemplateLocalApplicationPort {
  /**
   * Implementations must apply all template settings/rules and insert the
   * receipt in one transaction. Throwing must retain the original project and
   * must not leave a receipt.
   */
  applyAtomically(
    application: VerifiedStudioTeamTemplateApplication,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateLocalApplicationReceipt>;
  findCommitted(
    scope: Readonly<{
      tenantId: string;
      teamId: string;
      projectId: string;
      applicationId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateLocalApplicationReceipt | null>;
  listPendingCloudRecords(
    scope: Readonly<{
      tenantId: string;
      teamId: string;
      projectId: string;
    }>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly StudioTeamTemplateLocalApplicationReceipt[]>;
  markCloudRecorded(
    receipt: StudioTeamTemplateLocalApplicationReceipt,
    cloudRecordedAt: string,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateLocalApplicationReceipt>;
}

export interface StudioTeamTemplateCoordinatorOptions {
  readonly service: StudioTeamTemplateService;
  readonly crypto: StudioTeamTemplateCrypto;
  readonly projectKeys: StudioTeamTemplateProjectKeyAccessPort;
  readonly applications: StudioTeamTemplateLocalApplicationPort;
  readonly ids: StudioTeamTemplateIdPort;
  readonly idempotencyKeys: StudioTeamTemplateIdempotencyPort;
}

export type DecryptedStudioTeamTemplateListItem =
  | Readonly<{
      state: "ready";
      template: CloudTeamTemplateSummary;
      displayVersion: CloudTeamTemplateVersionSummary;
      payload: StudioTeamTemplatePayload;
    }>
  | Readonly<{
      state: "decrypt_error";
      template: CloudTeamTemplateSummary;
      displayVersion: CloudTeamTemplateVersionSummary;
      errorCode: string;
    }>;

export interface StudioTeamTemplateListView {
  readonly requestId: string;
  readonly items: readonly DecryptedStudioTeamTemplateListItem[];
  readonly nextCursor: string | null;
}

export type DecryptedStudioTeamTemplateVersion =
  | Readonly<{
      state: "ready";
      version: CloudTeamTemplateVersion;
      payload: StudioTeamTemplatePayload;
    }>
  | Readonly<{
      state: "decrypt_error";
      version: CloudTeamTemplateVersion;
      errorCode: string;
    }>;

export interface StudioTeamTemplateHistory {
  readonly template: CloudTeamTemplateSummary;
  readonly versions: readonly DecryptedStudioTeamTemplateVersion[];
}

export interface StudioTeamTemplateHistoryExport extends StudioTeamTemplateHistory {
  readonly schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  readonly kind: "inkshadow_team_template_history";
}

export interface StudioTeamTemplateMutationResult {
  readonly template: CloudTeamTemplateSummary;
  readonly version: CloudTeamTemplateVersionSummary;
  readonly payload: StudioTeamTemplatePayload;
}

export interface ApplyPublishedStudioTeamTemplateInput {
  readonly templateId: string;
  readonly expectedProjectRevision: number;
}

export interface StudioTeamTemplateApplicationRecorded {
  readonly status: "recorded";
  readonly receipt: StudioTeamTemplateLocalApplicationReceipt;
  readonly cloud: CloudTeamTemplateApplicationResponse;
}

export interface StudioTeamTemplateApplicationAlreadyRecorded {
  readonly status: "already_recorded";
  readonly receipt: StudioTeamTemplateLocalApplicationReceipt;
}

export interface StudioTeamTemplateApplicationPartialRetry {
  readonly status: "partial_retry";
  readonly receipt: StudioTeamTemplateLocalApplicationReceipt;
  readonly failureCode: string;
}

export type ApplyPublishedStudioTeamTemplateOutcome =
  | StudioTeamTemplateApplicationRecorded
  | StudioTeamTemplateApplicationAlreadyRecorded
  | StudioTeamTemplateApplicationPartialRetry;

export type StudioTeamTemplateCoordinatorErrorCode =
  | "TEAM_TEMPLATE_APPLICATION_RECEIPT_INVALID"
  | "TEAM_TEMPLATE_KEY_MISSING"
  | "TEAM_TEMPLATE_PAGINATION_INVALID"
  | "TEAM_TEMPLATE_REMOTE_RESPONSE_INVALID"
  | "TEAM_TEMPLATE_REVISION_CONFLICT"
  | "TEAM_TEMPLATE_STATE_INVALID"
  | "TEAM_TEMPLATE_VERSION_NOT_FOUND";

export class StudioTeamTemplateCoordinatorError extends Error {
  public constructor(
    public readonly code: StudioTeamTemplateCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioTeamTemplateCoordinatorError";
  }
}

/**
 * Coordinates project-DEK encrypted templates without giving the cloud
 * plaintext or any key material.
 *
 * Local application is deliberately ordered before the metadata-only cloud
 * receipt. A committed local receipt carries the stable cloud idempotency key,
 * so retry can never execute the project mutation a second time.
 */
export class StudioTeamTemplateCoordinator {
  public constructor(private readonly options: StudioTeamTemplateCoordinatorOptions) {}

  public capabilities(context: StudioTeamTemplateSessionContext): StudioTeamTemplateCapabilities {
    return this.options.service.capabilities(context);
  }

  public async listTemplates(
    context: StudioTeamTemplateSessionContext,
    options: CloudQueryOptions = {},
  ): Promise<StudioTeamTemplateListView> {
    const response = await this.options.service.listTemplates(context, {
      limit: options.limit ?? 50,
      ...options,
    });
    requireUnique(
      response.templates.map((template) => template.templateId),
      "template",
    );
    const items: DecryptedStudioTeamTemplateListItem[] = [];
    for (const template of response.templates) {
      requireTemplateScope(template, context, template.templateId);
      const displayNumber =
        template.state === "draft"
          ? template.latestVersionNumber
          : (template.publishedVersionNumber ?? template.latestVersionNumber);
      const summary = await this.findVersionByNumber(
        context,
        template.templateId,
        displayNumber,
        options.signal,
      );
      const version = await this.loadVersion(
        context,
        template.templateId,
        summary.versionId,
        options.signal,
      );
      try {
        const payload = await this.decryptVersion(context, version, options.signal);
        items.push(Object.freeze({ state: "ready", template, displayVersion: summary, payload }));
      } catch (error: unknown) {
        if (!isIsolatedDecryptFailure(error)) {
          throw error;
        }
        items.push(
          Object.freeze({
            state: "decrypt_error",
            template,
            displayVersion: summary,
            errorCode: error.code,
          }),
        );
      }
    }
    return Object.freeze({
      requestId: response.requestId,
      items: Object.freeze(items),
      nextCursor: response.nextCursor,
    });
  }

  public async readVersion(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ version: CloudTeamTemplateVersion; payload: StudioTeamTemplatePayload }>> {
    const version = await this.loadVersion(context, templateId, versionId, signal);
    const payload = await this.decryptVersion(context, version, signal);
    return Object.freeze({ version, payload });
  }

  public async readTemplateHistory(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateHistory> {
    const template = await this.loadCurrentTemplate(context, templateId, signal);
    const summaries = await this.listAllVersionSummaries(context, template.templateId, signal);
    const versions: DecryptedStudioTeamTemplateVersion[] = [];
    for (const summary of summaries) {
      const version = await this.loadVersion(
        context,
        template.templateId,
        summary.versionId,
        signal,
      );
      try {
        const payload = await this.decryptVersion(context, version, signal);
        versions.push(Object.freeze({ state: "ready", version, payload }));
      } catch (error: unknown) {
        if (!isIsolatedDecryptFailure(error)) {
          throw error;
        }
        versions.push(Object.freeze({ state: "decrypt_error", version, errorCode: error.code }));
      }
    }
    return Object.freeze({ template, versions: Object.freeze(versions) });
  }

  public async exportTemplateHistory(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateHistoryExport> {
    const history = await this.readTemplateHistory(context, templateId, signal);
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "inkshadow_team_template_history",
      ...history,
    });
  }

  public async createDraft(
    context: StudioTeamTemplateSessionContext,
    payload: StudioTeamTemplatePayload,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateMutationResult> {
    this.options.service.assertAvailable(context, "create", signal);
    const templateId = nextUuid(this.options.ids);
    const versionId = nextUuid(this.options.ids);
    const key = await this.openCurrentKey(context, signal);
    const aad = createStudioTeamTemplateAad({
      tenantId: context.tenantId,
      teamId: context.teamId,
      projectId: context.projectId,
      templateId,
      versionId,
      versionNumber: 1,
      projectKeyVersion: key.keyVersion,
    });
    const encrypted = await this.options.crypto.encrypt(payload, aad, key, signal);
    const response = await this.options.service.createTemplate(
      context,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        templateId,
        versionId,
        versionNumber: 1,
        projectKeyVersion: key.keyVersion,
        authorDeviceId: context.deviceId,
        payload: encrypted,
      },
      mutationOptions(this.options.idempotencyKeys, "team-template.create", signal),
    );
    return requireMutationResult(response, context, templateId, versionId, payload, "draft");
  }

  public async createDraftVersion(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    payload: StudioTeamTemplatePayload,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateMutationResult> {
    this.options.service.assertAvailable(context, "create_version", signal);
    const template = await this.loadCurrentTemplate(context, templateId, signal);
    if (template.state !== "draft") {
      throw invalidState("Only a draft team template can receive a new immutable version.");
    }
    const versionId = nextUuid(this.options.ids);
    const versionNumber = nextPositive(template.latestVersionNumber);
    const key = await this.openCurrentKey(context, signal);
    const aad = createStudioTeamTemplateAad({
      tenantId: context.tenantId,
      teamId: context.teamId,
      projectId: context.projectId,
      templateId: template.templateId,
      versionId,
      versionNumber,
      projectKeyVersion: key.keyVersion,
    });
    const encrypted = await this.options.crypto.encrypt(payload, aad, key, signal);
    const response = await this.options.service.createVersion(
      context,
      template.templateId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: template.revision,
        versionId,
        versionNumber,
        projectKeyVersion: key.keyVersion,
        authorDeviceId: context.deviceId,
        payload: encrypted,
      },
      mutationOptions(this.options.idempotencyKeys, "team-template.version.create", signal),
    );
    return requireMutationResult(
      response,
      context,
      template.templateId,
      versionId,
      payload,
      "draft",
    );
  }

  public async clonePublished(
    context: StudioTeamTemplateSessionContext,
    sourceTemplateId: string,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateMutationResult> {
    this.options.service.assertAvailable(context, "clone", signal);
    const source = await this.loadCurrentTemplate(context, sourceTemplateId, signal);
    if (source.state !== "published" || source.publishedVersionNumber === null) {
      throw invalidState("Only the exact published version can be cloned as a new draft.");
    }
    const sourceSummary = await this.findVersionByNumber(
      context,
      source.templateId,
      source.publishedVersionNumber,
      signal,
    );
    const sourceVersion = await this.loadVersion(
      context,
      source.templateId,
      sourceSummary.versionId,
      signal,
    );
    const payload = await this.decryptVersion(context, sourceVersion, signal);

    const targetTemplateId = nextUuid(this.options.ids);
    const targetVersionId = nextUuid(this.options.ids);
    const targetKey = await this.openCurrentKey(context, signal);
    const aad = createStudioTeamTemplateAad({
      tenantId: context.tenantId,
      teamId: context.teamId,
      projectId: context.projectId,
      templateId: targetTemplateId,
      versionId: targetVersionId,
      versionNumber: 1,
      projectKeyVersion: targetKey.keyVersion,
    });
    const encrypted = await this.options.crypto.encrypt(payload, aad, targetKey, signal);
    const response = await this.options.service.cloneTemplate(
      context,
      source.templateId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedSourceRevision: source.revision,
        sourceVersionId: sourceVersion.versionId,
        targetTemplateId,
        versionId: targetVersionId,
        versionNumber: 1,
        projectKeyVersion: targetKey.keyVersion,
        authorDeviceId: context.deviceId,
        payload: encrypted,
      },
      mutationOptions(this.options.idempotencyKeys, "team-template.clone", signal),
    );
    return requireMutationResult(
      response,
      context,
      targetTemplateId,
      targetVersionId,
      payload,
      "draft",
    );
  }

  public async publishDraft(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    signal?: AbortSignal,
  ): Promise<CloudTeamTemplateSummary> {
    this.options.service.assertAvailable(context, "publish", signal);
    const template = await this.loadCurrentTemplate(context, templateId, signal);
    if (template.state !== "draft") {
      throw invalidState("Only a draft team template can be published.");
    }
    const latest = await this.findVersionByNumber(
      context,
      template.templateId,
      template.latestVersionNumber,
      signal,
    );
    const response = await this.options.service.publishTemplate(
      context,
      template.templateId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: template.revision,
        versionId: latest.versionId,
      },
      mutationOptions(this.options.idempotencyKeys, "team-template.publish", signal),
    );
    const published = requireTemplateResponse(response, context, template.templateId, "published");
    if (published.publishedVersionNumber !== latest.versionNumber) {
      throw remoteInvalid("Published template returned a different immutable version.");
    }
    return published;
  }

  public async archiveTemplate(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    signal?: AbortSignal,
  ): Promise<CloudTeamTemplateSummary> {
    this.options.service.assertAvailable(context, "archive", signal);
    const template = await this.loadCurrentTemplate(context, templateId, signal);
    if (template.state === "archived") {
      throw invalidState("The team template is already archived.");
    }
    const response = await this.options.service.archiveTemplate(
      context,
      template.templateId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: template.revision,
      },
      mutationOptions(this.options.idempotencyKeys, "team-template.archive", signal),
    );
    return requireTemplateResponse(response, context, template.templateId, "archived");
  }

  public async applyPublished(
    context: StudioTeamTemplateSessionContext,
    input: ApplyPublishedStudioTeamTemplateInput,
    signal?: AbortSignal,
  ): Promise<ApplyPublishedStudioTeamTemplateOutcome> {
    this.options.service.assertAvailable(context, "apply", signal);
    const expectedProjectRevision = requirePositive(input.expectedProjectRevision);
    const template = await this.loadCurrentTemplate(context, input.templateId, signal);
    if (template.state !== "published" || template.publishedVersionNumber === null) {
      throw invalidState("Only the exact current published template can be applied.");
    }
    const summary = await this.findVersionByNumber(
      context,
      template.templateId,
      template.publishedVersionNumber,
      signal,
    );
    const version = await this.loadVersion(context, template.templateId, summary.versionId, signal);
    const payload = await this.decryptVersion(context, version, signal);
    const applicationId = nextUuid(this.options.ids);
    const contentDigest = await this.options.crypto.digestPayload(payload);
    const cloudIdempotencyKey = nextIdempotency(
      this.options.idempotencyKeys,
      "team-template.apply.record",
    );
    const application: VerifiedStudioTeamTemplateApplication = Object.freeze({
      authority: "verified_encrypted_team_template",
      applicationId,
      tenantId: context.tenantId,
      teamId: context.teamId,
      projectId: context.projectId,
      templateId: template.templateId,
      templateRevision: template.revision,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      contentDigest,
      expectedProjectRevision,
      cloudIdempotencyKey,
      requestedByMembershipId: context.membershipId,
      payload,
    });

    // This is the authoritative commit point. Any rejection/throw must happen
    // before the cloud metadata-only application endpoint is called.
    const receipt = requireApplicationReceipt(
      await this.options.applications.applyAtomically(application, signal),
      application,
    );
    if (signal?.aborted === true) {
      return partialRetry(receipt, "CLOUD_REQUEST_ABORTED");
    }
    return this.recordCommittedApplication(context, receipt, signal);
  }

  public async retryApplicationRecord(
    context: StudioTeamTemplateSessionContext,
    partial: StudioTeamTemplateApplicationPartialRetry,
    signal?: AbortSignal,
  ): Promise<ApplyPublishedStudioTeamTemplateOutcome> {
    this.options.service.authorize(context, "apply");
    requirePartialRetryScope(context, partial);
    const committed = await this.options.applications.findCommitted(
      {
        tenantId: context.tenantId,
        teamId: context.teamId,
        projectId: context.projectId,
        applicationId: partial.receipt.applicationId,
      },
      signal,
    );
    if (committed === null || !sameReceipt(committed, partial.receipt)) {
      throw invalidReceipt();
    }
    return this.recordCommittedApplication(context, committed, signal);
  }

  public async recoverPendingApplicationRecords(
    context: StudioTeamTemplateSessionContext,
    options: Readonly<{ limit?: number; signal?: AbortSignal }> = {},
  ): Promise<readonly ApplyPublishedStudioTeamTemplateOutcome[]> {
    this.options.service.authorize(context, "apply");
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw remoteInvalid("The pending team-template recovery limit is invalid.");
    }
    const pending = await this.options.applications.listPendingCloudRecords(
      {
        tenantId: context.tenantId,
        teamId: context.teamId,
        projectId: context.projectId,
      },
      limit,
      options.signal,
    );
    const outcomes: ApplyPublishedStudioTeamTemplateOutcome[] = [];
    for (const receipt of pending) {
      if (options.signal?.aborted === true) {
        break;
      }
      requireReceiptScope(context, receipt);
      outcomes.push(await this.recordCommittedApplication(context, receipt, options.signal));
    }
    return Object.freeze(outcomes);
  }

  private async recordCommittedApplication(
    context: StudioTeamTemplateSessionContext,
    receipt: StudioTeamTemplateLocalApplicationReceipt,
    signal?: AbortSignal,
  ): Promise<ApplyPublishedStudioTeamTemplateOutcome> {
    if (receipt.cloudRecordedAt !== null) {
      return Object.freeze({ status: "already_recorded", receipt });
    }
    if (receipt.requestedByMembershipId !== context.membershipId) {
      return partialRetry(receipt, "TEAM_TEMPLATE_APPLICATION_OWNER_MISMATCH");
    }
    try {
      const cloud = await this.options.service.recordApplication(
        context,
        receipt.templateId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          applicationId: receipt.applicationId,
          expectedRevision: receipt.templateRevision,
          versionId: receipt.versionId,
        },
        {
          idempotencyKey: receipt.cloudIdempotencyKey,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      requireApplicationResponse(cloud, context, receipt);
      let checkpointed: StudioTeamTemplateLocalApplicationReceipt;
      try {
        checkpointed = await this.options.applications.markCloudRecorded(
          receipt,
          cloud.appliedAt,
          signal,
        );
        requireCloudCheckpoint(receipt, checkpointed, cloud.appliedAt);
      } catch (error: unknown) {
        return partialRetry(receipt, errorCode(error));
      }
      return Object.freeze({ status: "recorded", receipt: checkpointed, cloud });
    } catch (error: unknown) {
      return partialRetry(receipt, errorCode(error));
    }
  }

  private async loadCurrentTemplate(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    signal?: AbortSignal,
  ): Promise<CloudTeamTemplateSummary> {
    const normalizedId = requireUuid(templateId);
    const response = await this.options.service.getTemplate(context, normalizedId, signal);
    return requireTemplateResponse(response, context, normalizedId);
  }

  private async loadVersion(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<CloudTeamTemplateVersion> {
    const normalizedTemplateId = requireUuid(templateId);
    const normalizedVersionId = requireUuid(versionId);
    const response = await this.options.service.getVersion(
      context,
      normalizedTemplateId,
      normalizedVersionId,
      signal,
    );
    requireVersionScope(response.version, context, normalizedTemplateId, normalizedVersionId);
    return response.version;
  }

  private async decryptVersion(
    context: StudioTeamTemplateSessionContext,
    version: CloudTeamTemplateVersion,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplatePayload> {
    const key = await this.openExactKey(context, version.projectKeyVersion, signal);
    return this.options.crypto.decrypt(version.payload, key, signal);
  }

  private async findVersionByNumber(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    versionNumber: number,
    signal?: AbortSignal,
  ): Promise<CloudTeamTemplateVersionSummary> {
    const versions = await this.listAllVersionSummaries(context, templateId, signal);
    const found = versions.find((version) => version.versionNumber === versionNumber);
    if (found === undefined) {
      throw new StudioTeamTemplateCoordinatorError(
        "TEAM_TEMPLATE_VERSION_NOT_FOUND",
        "The immutable team-template version referenced by its metadata was not found.",
      );
    }
    return found;
  }

  private async listAllVersionSummaries(
    context: StudioTeamTemplateSessionContext,
    templateId: string,
    signal?: AbortSignal,
  ): Promise<readonly CloudTeamTemplateVersionSummary[]> {
    const normalizedTemplateId = requireUuid(templateId);
    const versions: CloudTeamTemplateVersionSummary[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.options.service.listVersions(context, normalizedTemplateId, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
        ...(signal === undefined ? {} : { signal }),
      });
      for (const version of response.versions) {
        requireVersionScope(version, context, normalizedTemplateId, version.versionId);
        if (ids.has(version.versionId)) {
          throw paginationInvalid("Team-template version pagination repeated an immutable ID.");
        }
        ids.add(version.versionId);
        versions.push(version);
      }
      if (response.nextCursor === null) {
        return Object.freeze(
          versions.sort((left, right) => left.versionNumber - right.versionNumber),
        );
      }
      if (cursors.has(response.nextCursor)) {
        throw paginationInvalid("Team-template version pagination repeated an opaque cursor.");
      }
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw paginationInvalid("Team-template version pagination exceeded the local safety bound.");
  }

  private async openCurrentKey(
    context: StudioTeamTemplateSessionContext,
    signal?: AbortSignal,
  ): Promise<OpenedStudioTeamTemplateProjectKey> {
    try {
      const opened = await this.options.projectKeys.openCurrentTemplateProjectKey(
        {
          tenantId: context.tenantId,
          teamId: context.teamId,
          projectId: context.projectId,
        },
        signal,
      );
      if (
        opened.projectId !== context.projectId ||
        !Number.isSafeInteger(opened.keyVersion) ||
        opened.keyVersion < 1
      ) {
        throw keyMissing();
      }
      return opened;
    } catch (error: unknown) {
      if (isAbortError(error) || error instanceof StudioTeamTemplateCoordinatorError) {
        throw error;
      }
      throw keyMissing();
    }
  }

  private async openExactKey(
    context: StudioTeamTemplateSessionContext,
    keyVersion: number,
    signal?: AbortSignal,
  ): Promise<OpenedStudioTeamTemplateProjectKey> {
    try {
      const opened = await this.options.projectKeys.openTemplateProjectKey(
        {
          tenantId: context.tenantId,
          teamId: context.teamId,
          projectId: context.projectId,
          keyVersion,
        },
        signal,
      );
      if (opened.projectId !== context.projectId || opened.keyVersion !== keyVersion) {
        throw keyMissing();
      }
      return opened;
    } catch (error: unknown) {
      if (isAbortError(error) || error instanceof StudioTeamTemplateCoordinatorError) {
        throw error;
      }
      throw keyMissing();
    }
  }
}

function requireMutationResult(
  response: CloudTeamTemplateMutationResponse,
  context: StudioTeamTemplateSessionContext,
  templateId: string,
  versionId: string,
  payload: StudioTeamTemplatePayload,
  expectedState: CloudTeamTemplateSummary["state"],
): StudioTeamTemplateMutationResult {
  requireTemplateScope(response.template, context, templateId);
  requireVersionScope(response.version, context, templateId, versionId);
  if (response.template.state !== expectedState) {
    throw remoteInvalid("Team-template mutation returned an unexpected lifecycle state.");
  }
  return Object.freeze({ template: response.template, version: response.version, payload });
}

function requireTemplateResponse(
  response: CloudTeamTemplateResponse,
  context: StudioTeamTemplateSessionContext,
  templateId: string,
  expectedState?: CloudTeamTemplateSummary["state"],
): CloudTeamTemplateSummary {
  requireTemplateScope(response.template, context, templateId);
  if (expectedState !== undefined && response.template.state !== expectedState) {
    throw remoteInvalid("Team-template response returned an unexpected lifecycle state.");
  }
  return response.template;
}

function requireTemplateScope(
  template: CloudTeamTemplateSummary,
  context: StudioTeamTemplateSessionContext,
  templateId: string,
): void {
  if (
    template.tenantId !== context.tenantId ||
    template.teamId !== context.teamId ||
    template.projectId !== context.projectId ||
    template.templateId !== templateId
  ) {
    throw remoteInvalid("Team-template metadata crossed its tenant, team or project scope.");
  }
}

function requireVersionScope(
  version: CloudTeamTemplateVersionSummary | CloudTeamTemplateVersion,
  context: StudioTeamTemplateSessionContext,
  templateId: string,
  versionId: string,
): void {
  if (
    version.tenantId !== context.tenantId ||
    version.teamId !== context.teamId ||
    version.projectId !== context.projectId ||
    version.templateId !== templateId ||
    version.versionId !== versionId
  ) {
    throw remoteInvalid("Team-template version crossed its immutable project scope.");
  }
}

function requireApplicationReceipt(
  receipt: StudioTeamTemplateLocalApplicationReceipt,
  application: VerifiedStudioTeamTemplateApplication,
): StudioTeamTemplateLocalApplicationReceipt {
  const commonInvalid =
    !isValidReceiptShape(receipt) ||
    receipt.tenantId !== application.tenantId ||
    receipt.teamId !== application.teamId ||
    receipt.projectId !== application.projectId ||
    receipt.templateId !== application.templateId ||
    receipt.templateRevision !== application.templateRevision ||
    receipt.versionId !== application.versionId ||
    receipt.versionNumber !== application.versionNumber ||
    receipt.contentDigest !== application.contentDigest;
  const freshInvalid =
    receipt.result === "applied" &&
    (receipt.applicationId !== application.applicationId ||
      receipt.projectRevisionBefore !== application.expectedProjectRevision ||
      receipt.cloudIdempotencyKey !== application.cloudIdempotencyKey ||
      receipt.requestedByMembershipId !== application.requestedByMembershipId);
  if (commonInvalid || freshInvalid) {
    throw invalidReceipt();
  }
  return Object.freeze({ ...receipt });
}

function requireApplicationResponse(
  response: CloudTeamTemplateApplicationResponse,
  context: StudioTeamTemplateSessionContext,
  receipt: StudioTeamTemplateLocalApplicationReceipt,
): void {
  if (
    response.tenantId !== context.tenantId ||
    response.teamId !== context.teamId ||
    response.projectId !== context.projectId ||
    response.templateId !== receipt.templateId ||
    response.versionId !== receipt.versionId ||
    response.applicationId !== receipt.applicationId ||
    response.appliedByMembershipId !== context.membershipId ||
    (response as { readonly effect?: unknown }).effect !==
      "metadata_only_no_server_content_mutation"
  ) {
    throw remoteInvalid("Cloud application metadata crossed its committed local receipt scope.");
  }
}

function requirePartialRetryScope(
  context: StudioTeamTemplateSessionContext,
  partial: StudioTeamTemplateApplicationPartialRetry,
): void {
  if (
    (partial as { readonly status?: unknown }).status !== "partial_retry" ||
    !isValidReceiptShape(partial.receipt) ||
    partial.receipt.cloudRecordedAt !== null ||
    partial.receipt.tenantId !== context.tenantId ||
    partial.receipt.teamId !== context.teamId ||
    partial.receipt.projectId !== context.projectId ||
    !CloudIdempotencyKeySchema.safeParse(partial.receipt.cloudIdempotencyKey).success
  ) {
    throw invalidReceipt();
  }
}

function requireReceiptScope(
  context: StudioTeamTemplateSessionContext,
  receipt: StudioTeamTemplateLocalApplicationReceipt,
): void {
  if (
    !isValidReceiptShape(receipt) ||
    receipt.tenantId !== context.tenantId ||
    receipt.teamId !== context.teamId ||
    receipt.projectId !== context.projectId ||
    receipt.cloudRecordedAt !== null
  ) {
    throw invalidReceipt();
  }
}

function isValidReceiptShape(receipt: StudioTeamTemplateLocalApplicationReceipt): boolean {
  return (
    (receipt as { readonly authority?: unknown }).authority === "local_team_template_application" &&
    ["applied", "already_applied"].includes(receipt.result) &&
    SHA256_HEX_PATTERN.test(receipt.contentDigest) &&
    CloudIdempotencyKeySchema.safeParse(receipt.cloudIdempotencyKey).success &&
    UuidV7Schema.safeParse(receipt.applicationId).success &&
    UuidV7Schema.safeParse(receipt.tenantId).success &&
    UuidV7Schema.safeParse(receipt.teamId).success &&
    UuidV7Schema.safeParse(receipt.projectId).success &&
    UuidV7Schema.safeParse(receipt.templateId).success &&
    UuidV7Schema.safeParse(receipt.versionId).success &&
    UuidV7Schema.safeParse(receipt.requestedByMembershipId).success &&
    isCanonicalTimestamp(receipt.appliedAt) &&
    (receipt.cloudRecordedAt === null || isCanonicalTimestamp(receipt.cloudRecordedAt)) &&
    Number.isSafeInteger(receipt.templateRevision) &&
    receipt.templateRevision >= 1 &&
    Number.isSafeInteger(receipt.versionNumber) &&
    receipt.versionNumber >= 1 &&
    Number.isSafeInteger(receipt.projectRevisionBefore) &&
    receipt.projectRevisionBefore >= 1 &&
    receipt.projectRevisionAfter === receipt.projectRevisionBefore + 1
  );
}

function requireCloudCheckpoint(
  before: StudioTeamTemplateLocalApplicationReceipt,
  after: StudioTeamTemplateLocalApplicationReceipt,
  cloudRecordedAt: string,
): void {
  if (
    !sameReceiptIgnoringCloudCheckpoint(before, after) ||
    after.cloudRecordedAt !== cloudRecordedAt
  ) {
    throw invalidReceipt();
  }
}

function sameReceipt(
  left: StudioTeamTemplateLocalApplicationReceipt,
  right: StudioTeamTemplateLocalApplicationReceipt,
): boolean {
  return (
    sameReceiptIgnoringCloudCheckpoint(left, right) &&
    left.cloudRecordedAt === right.cloudRecordedAt
  );
}

function sameReceiptIgnoringCloudCheckpoint(
  left: StudioTeamTemplateLocalApplicationReceipt,
  right: StudioTeamTemplateLocalApplicationReceipt,
): boolean {
  return (
    left.applicationId === right.applicationId &&
    left.tenantId === right.tenantId &&
    left.teamId === right.teamId &&
    left.projectId === right.projectId &&
    left.templateId === right.templateId &&
    left.templateRevision === right.templateRevision &&
    left.versionId === right.versionId &&
    left.versionNumber === right.versionNumber &&
    left.contentDigest === right.contentDigest &&
    left.projectRevisionBefore === right.projectRevisionBefore &&
    left.projectRevisionAfter === right.projectRevisionAfter &&
    left.cloudIdempotencyKey === right.cloudIdempotencyKey &&
    left.requestedByMembershipId === right.requestedByMembershipId &&
    left.appliedAt === right.appliedAt
  );
}

function partialRetry(
  receipt: StudioTeamTemplateLocalApplicationReceipt,
  failureCode: string,
): StudioTeamTemplateApplicationPartialRetry {
  return Object.freeze({ status: "partial_retry", receipt, failureCode });
}

function mutationOptions(
  source: StudioTeamTemplateIdempotencyPort,
  purpose: string,
  signal?: AbortSignal,
): Readonly<{ idempotencyKey: string; signal?: AbortSignal }> {
  return {
    idempotencyKey: nextIdempotency(source, purpose),
    ...(signal === undefined ? {} : { signal }),
  };
}

function nextIdempotency(source: StudioTeamTemplateIdempotencyPort, purpose: string): string {
  const value = source.next(purpose);
  if (!CloudIdempotencyKeySchema.safeParse(value).success) {
    throw remoteInvalid("The local team-template idempotency source returned an invalid key.");
  }
  return value;
}

function nextUuid(source: StudioTeamTemplateIdPort): string {
  return requireUuid(source.next());
}

function requireUuid(value: unknown): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw remoteInvalid("A local or remote team-template identifier is invalid.");
  }
  return parsed.data.toLowerCase();
}

function requirePositive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw remoteInvalid("A team-template or project revision is invalid.");
  }
  return value;
}

function nextPositive(value: number): number {
  const normalized = requirePositive(value);
  if (normalized >= Number.MAX_SAFE_INTEGER) {
    throw revisionConflict();
  }
  return normalized + 1;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw paginationInvalid(`Team-template pagination repeated a ${label} identifier.`);
  }
}

function isIsolatedDecryptFailure(
  error: unknown,
): error is StudioTeamTemplateCryptoError | StudioTeamTemplateCoordinatorError {
  return (
    error instanceof StudioTeamTemplateCryptoError ||
    (error instanceof StudioTeamTemplateCoordinatorError &&
      error.code === "TEAM_TEMPLATE_KEY_MISSING")
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isCanonicalTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return isAbortError(error) ? "CLOUD_REQUEST_ABORTED" : "CLOUD_APPLICATION_RECORD_FAILED";
}

function invalidReceipt(): StudioTeamTemplateCoordinatorError {
  return new StudioTeamTemplateCoordinatorError(
    "TEAM_TEMPLATE_APPLICATION_RECEIPT_INVALID",
    "The local team-template application receipt is missing or does not match the committed work.",
  );
}

function invalidState(message: string): StudioTeamTemplateCoordinatorError {
  return new StudioTeamTemplateCoordinatorError("TEAM_TEMPLATE_STATE_INVALID", message);
}

function keyMissing(): StudioTeamTemplateCoordinatorError {
  return new StudioTeamTemplateCoordinatorError(
    "TEAM_TEMPLATE_KEY_MISSING",
    "The exact non-exportable project key required by this team template is unavailable.",
  );
}

function paginationInvalid(message: string): StudioTeamTemplateCoordinatorError {
  return new StudioTeamTemplateCoordinatorError("TEAM_TEMPLATE_PAGINATION_INVALID", message);
}

function remoteInvalid(message: string): StudioTeamTemplateCoordinatorError {
  return new StudioTeamTemplateCoordinatorError("TEAM_TEMPLATE_REMOTE_RESPONSE_INVALID", message);
}

function revisionConflict(): StudioTeamTemplateCoordinatorError {
  return new StudioTeamTemplateCoordinatorError(
    "TEAM_TEMPLATE_REVISION_CONFLICT",
    "The team-template revision changed before this action completed.",
  );
}
