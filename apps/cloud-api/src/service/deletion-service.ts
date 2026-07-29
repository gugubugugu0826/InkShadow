import type {
  CloudAccountDeletionCancellationRequest,
  CloudAccountDeletionLookupRequest,
  CloudAccountDeletionSubmissionRequest,
  CloudDeletionCancellationRequest,
  CloudDeletionRequestResponse,
  CloudDeletionSubmissionRequest,
} from "@inkshadow/contracts";

import type { CloudMutationContext, CloudPrincipal, CloudReadContext } from "./identity-service.js";

/**
 * HTTP-facing boundary for permanent deletion. Implementations must make account
 * lookup/cancellation credential failures indistinguishable from an unknown
 * deletion request and must never log or return the supplied password.
 */
export interface CloudDeletionService {
  requestProjectDeletion(
    principal: CloudPrincipal,
    projectId: string,
    request: CloudDeletionSubmissionRequest,
    context: CloudMutationContext,
  ): Promise<CloudDeletionRequestResponse>;

  getProjectDeletionRequest(
    principal: CloudPrincipal,
    projectId: string,
    context: CloudReadContext,
  ): Promise<CloudDeletionRequestResponse>;

  cancelProjectDeletion(
    principal: CloudPrincipal,
    projectId: string,
    request: CloudDeletionCancellationRequest,
    context: CloudMutationContext,
  ): Promise<CloudDeletionRequestResponse>;

  /**
   * Must freeze new account cloud writes and revoke every account session
   * before the successful response is returned.
   */
  requestAccountDeletion(
    principal: CloudPrincipal,
    request: CloudAccountDeletionSubmissionRequest,
    context: CloudMutationContext,
  ): Promise<CloudDeletionRequestResponse>;

  /** This recovery path authenticates only with the supplied deletion proof. */
  lookupAccountDeletion(
    request: CloudAccountDeletionLookupRequest,
    context: CloudReadContext,
  ): Promise<CloudDeletionRequestResponse>;

  /** This recovery path authenticates only with the supplied deletion proof. */
  cancelAccountDeletion(
    request: CloudAccountDeletionCancellationRequest,
    context: CloudMutationContext,
  ): Promise<CloudDeletionRequestResponse>;
}
