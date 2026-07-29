import type {
  TeamTemplateApplicationSqliteStore,
  TeamTemplateApplicationReceipt,
} from "@inkshadow/data";

import type {
  StudioTeamTemplateLocalApplicationPort,
  StudioTeamTemplateLocalApplicationReceipt,
  VerifiedStudioTeamTemplateApplication,
} from "./studio-team-template-coordinator";

/**
 * Production adapter from the encrypted desktop coordinator to the local
 * SQLite unit of work. The data store owns the BEGIN IMMEDIATE transaction;
 * this adapter only narrows the decrypted payload to the four project domains
 * that a team template is allowed to replace.
 */
export class StudioTeamTemplateSqliteApplication implements StudioTeamTemplateLocalApplicationPort {
  public constructor(private readonly store: TeamTemplateApplicationSqliteStore) {}

  public async applyAtomically(
    application: VerifiedStudioTeamTemplateApplication,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateLocalApplicationReceipt> {
    throwIfAborted(signal);
    const receipt = await this.store.applyAtomically({
      applicationId: application.applicationId,
      tenantId: application.tenantId,
      teamId: application.teamId,
      projectId: application.projectId,
      templateId: application.templateId,
      templateRevision: application.templateRevision,
      versionId: application.versionId,
      versionNumber: application.versionNumber,
      contentDigest: application.contentDigest,
      expectedProjectRevision: application.expectedProjectRevision,
      cloudIdempotencyKey: application.cloudIdempotencyKey,
      requestedByMembershipId: application.requestedByMembershipId,
      payload: {
        projectSettings: application.payload.projectSettings,
        promptRegistryRefs: application.payload.promptRegistryRefs,
        promptRules: application.payload.promptRules,
        reviewChecklist: application.payload.reviewChecklist,
      },
    });
    // Do not throw on cancellation after this point: the transaction is
    // durable and the coordinator must return a cloud-only retry receipt.
    return mapReceipt(receipt);
  }

  public async findCommitted(
    scope: Readonly<{
      tenantId: string;
      teamId: string;
      projectId: string;
      applicationId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateLocalApplicationReceipt | null> {
    throwIfAborted(signal);
    const receipt = await this.store.findCommitted(scope);
    return receipt === null ? null : mapReceipt(receipt);
  }

  public async listPendingCloudRecords(
    scope: Readonly<{ tenantId: string; teamId: string; projectId: string }>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly StudioTeamTemplateLocalApplicationReceipt[]> {
    throwIfAborted(signal);
    const receipts = await this.store.listPendingCloudRecords({ ...scope, limit });
    return Object.freeze(receipts.map(mapReceipt));
  }

  public async markCloudRecorded(
    receipt: StudioTeamTemplateLocalApplicationReceipt,
    cloudRecordedAt: string,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateLocalApplicationReceipt> {
    throwIfAborted(signal);
    const checkpointed = await this.store.markCloudRecorded({
      applicationId: receipt.applicationId,
      cloudRecordedAt,
    });
    return mapReceipt(checkpointed);
  }
}

function mapReceipt(
  receipt: TeamTemplateApplicationReceipt,
): StudioTeamTemplateLocalApplicationReceipt {
  return Object.freeze({
    authority: "local_team_template_application",
    applicationId: receipt.applicationId,
    tenantId: receipt.tenantId,
    teamId: receipt.teamId,
    projectId: receipt.projectId,
    templateId: receipt.templateId,
    templateRevision: receipt.templateRevision,
    versionId: receipt.versionId,
    versionNumber: receipt.versionNumber,
    contentDigest: receipt.contentDigest,
    projectRevisionBefore: receipt.projectRevisionBefore,
    projectRevisionAfter: receipt.projectRevisionAfter,
    cloudIdempotencyKey: receipt.cloudIdempotencyKey,
    requestedByMembershipId: receipt.requestedByMembershipId,
    appliedAt: receipt.appliedAt,
    cloudRecordedAt: receipt.cloudRecordedAt,
    result: receipt.result,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The Studio team-template operation was cancelled.", "AbortError");
  }
}
