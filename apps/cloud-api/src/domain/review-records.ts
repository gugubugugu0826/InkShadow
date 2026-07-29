import type {
  CloudReviewCiphertextEnvelope,
  CloudReviewState,
  CloudReviewSuggestionDecision,
  CloudReviewThreadItemType,
  CloudReviewThreadState,
} from "@inkshadow/contracts";

export interface CloudReviewRecord {
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decisionByMembershipId: string | null;
  readonly payload: CloudReviewCiphertextEnvelope;
  readonly projectId: string;
  readonly projectKeyVersion: number;
  readonly reviewId: string;
  readonly revision: number;
  readonly sourceCiphertextSha256: string;
  readonly sourceVersionId: string;
  readonly sourceVersionRevision: number;
  readonly state: CloudReviewState;
  readonly submittedByMembershipId: string;
  readonly teamId: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface CloudReviewThreadRecord {
  readonly createdAt: Date;
  readonly createdByMembershipId: string;
  readonly itemCount: number;
  readonly projectId: string;
  readonly resolvedAt: Date | null;
  readonly resolvedByMembershipId: string | null;
  readonly reviewId: string;
  readonly revision: number;
  readonly rootItemId: string;
  readonly state: CloudReviewThreadState;
  readonly teamId: string;
  readonly tenantId: string;
  readonly threadId: string;
  readonly updatedAt: Date;
}

export interface CloudReviewThreadItemRecord {
  readonly createdAt: Date;
  readonly createdByMembershipId: string;
  readonly itemId: string;
  readonly itemType: CloudReviewThreadItemType;
  readonly parentItemId: string | null;
  readonly payload: CloudReviewCiphertextEnvelope;
  readonly projectId: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly suggestionDecidedAt: Date | null;
  readonly suggestionDecidedByMembershipId: string | null;
  readonly suggestionDecision: CloudReviewSuggestionDecision | null;
  readonly teamId: string;
  readonly tenantId: string;
  readonly threadId: string;
  readonly updatedAt: Date;
}
