import type {
  ClaimedTeamInvitationOutboxRecord,
  TeamInvitationOutboxRecord,
} from "../domain/team-invitation-outbox-record.js";

export interface ClaimTeamInvitationOutboxOptions {
  readonly leaseExpiresAt: Date;
  readonly limit: number;
  readonly now: Date;
  readonly workerId: string;
}

export interface CompleteTeamInvitationOutboxOptions {
  readonly deliveryId: string;
  readonly expectedRevision: number;
  readonly now: Date;
  readonly workerId: string;
}

export interface RetryTeamInvitationOutboxOptions extends CompleteTeamInvitationOutboxOptions {
  readonly availableAt: Date;
  readonly deadLetter: boolean;
  readonly errorCode: string;
}

export interface CancelTeamInvitationOutboxOptions extends CompleteTeamInvitationOutboxOptions {
  readonly errorCode: string;
}

export type TeamInvitationOutboxExecutionDecision =
  | {
      readonly kind: "cancel";
      readonly errorCode: string;
    }
  | {
      readonly kind: "delivered";
    }
  | {
      readonly kind: "retry";
      readonly availableAt: Date;
      readonly deadLetter: boolean;
      readonly errorCode: string;
    };

export type TeamInvitationOutboxExecutionResult =
  | {
      readonly kind: "applied";
      readonly decision: TeamInvitationOutboxExecutionDecision;
    }
  | {
      readonly kind: "claim_lost";
    };

export interface ExecuteTeamInvitationOutboxOptions extends CompleteTeamInvitationOutboxOptions {
  readonly operation: (
    record: ClaimedTeamInvitationOutboxRecord,
  ) => Promise<TeamInvitationOutboxExecutionDecision>;
}

export interface TeamInvitationOutboxStore {
  cancel(options: CancelTeamInvitationOutboxOptions): Promise<boolean>;
  claim(
    options: ClaimTeamInvitationOutboxOptions,
  ): Promise<readonly ClaimedTeamInvitationOutboxRecord[]>;
  enqueue(record: TeamInvitationOutboxRecord): Promise<void>;
  executeWithFence(
    options: ExecuteTeamInvitationOutboxOptions,
  ): Promise<TeamInvitationOutboxExecutionResult>;
  markDelivered(options: CompleteTeamInvitationOutboxOptions): Promise<boolean>;
  retry(options: RetryTeamInvitationOutboxOptions): Promise<boolean>;
}
