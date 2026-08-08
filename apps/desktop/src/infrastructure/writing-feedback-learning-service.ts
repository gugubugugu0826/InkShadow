import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import {
  MAXIMUM_LEARNABLE_CUSTOM_FEEDBACK_CHARACTERS,
  type RecordedCandidateApplicationStrategy,
  type WritingFeedbackAction,
  type WritingFeedbackCode,
  type WritingFeedbackEvent,
  type NewWritingFeedbackEvent,
  type WritingFeedbackPolicy,
  type WritingFeedbackStore,
  WritingFeedbackStoreError,
  type WritingPreference,
} from "./writing-feedback-store";

export interface RecordWritingActionInput {
  readonly projectId: string;
  readonly chapterId?: string | null;
  readonly candidateId?: string | null;
  readonly action: Exclude<WritingFeedbackAction, "explicit_feedback">;
  readonly applicationStrategy?: RecordedCandidateApplicationStrategy | null;
  readonly acceptedChangeCount?: number | null;
  readonly rejectedChangeCount?: number | null;
}

export interface RecordExplicitWritingFeedbackInput {
  /** Stable identity reused for retries of this one explicit feedback action. */
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly chapterId?: string | null;
  readonly candidateId?: string | null;
  readonly feedbackCode?: WritingFeedbackCode | null;
  readonly customFeedback?: string | null;
}

export interface WritingPreferenceDashboard {
  readonly policy: WritingFeedbackPolicy;
  readonly preferences: readonly WritingPreference[];
  readonly recentEvents: readonly WritingFeedbackEvent[];
}

export interface ExplicitFeedbackOutcome {
  readonly event: WritingFeedbackEvent;
  readonly learnedPreference: WritingPreference | null;
}

const LEARNING_EVIDENCE_THRESHOLD = 2;

/**
 * Turns explicit, local user decisions into visible preferences. Raw chapter
 * and candidate text is never copied into the event ledger. A preference is
 * learned only after the same explicit option is chosen twice and while the
 * project policy is enabled.
 */
export class WritingFeedbackLearningService {
  public constructor(
    private readonly store: WritingFeedbackStore,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
  ) {}

  public async loadDashboard(projectId: string): Promise<WritingPreferenceDashboard> {
    const [policy, preferences, recentEvents] = await Promise.all([
      this.store.getPolicy(projectId),
      this.store.listPreferences(projectId),
      this.store.listEvents(projectId, 100),
    ]);
    return Object.freeze({ policy, preferences, recentEvents });
  }

  public async recordAction(input: RecordWritingActionInput): Promise<WritingFeedbackEvent> {
    const event: NewWritingFeedbackEvent = Object.freeze({
      id: this.ids.next(),
      projectId: input.projectId,
      chapterId: input.chapterId ?? null,
      candidateId: input.candidateId ?? null,
      action: input.action,
      feedbackCode: null,
      customFeedback: null,
      customFeedbackNormalizedHash: null,
      idempotencyKey: null,
      applicationStrategy: input.applicationStrategy ?? null,
      acceptedChangeCount: input.acceptedChangeCount ?? null,
      rejectedChangeCount: input.rejectedChangeCount ?? null,
      createdAt: this.clock.now(),
    });
    return this.store.recordEvent(event);
  }

  public async recordExplicitFeedback(
    input: RecordExplicitWritingFeedbackInput,
  ): Promise<ExplicitFeedbackOutcome> {
    const customFeedback = normalizeCustomFeedback(input.customFeedback ?? null);
    const customFeedbackNormalizedHash =
      customFeedback === null ? null : await customFeedbackHash(customFeedback);
    const idempotencyKey = await explicitFeedbackIdempotencyHash(
      input.projectId,
      normalizeIdempotencyIdentity(input.idempotencyKey),
    );
    const now = this.clock.now();
    const eventInput: NewWritingFeedbackEvent = Object.freeze({
      id: this.ids.next(),
      projectId: input.projectId,
      chapterId: input.chapterId ?? null,
      candidateId: input.candidateId ?? null,
      action: "explicit_feedback",
      feedbackCode: input.feedbackCode ?? null,
      customFeedback,
      customFeedbackNormalizedHash,
      idempotencyKey,
      applicationStrategy: null,
      acceptedChangeCount: null,
      rejectedChangeCount: null,
      createdAt: now,
    });
    return this.store.recordExplicitFeedbackAndSynchronize({
      event: eventInput,
      feedbackCodePreferenceId: eventInput.feedbackCode === null ? null : this.ids.next(),
      customFeedbackPreferenceId:
        eventInput.customFeedbackNormalizedHash === null ? null : this.ids.next(),
      evidenceThreshold: LEARNING_EVIDENCE_THRESHOLD,
    });
  }

  public async addManualPreference(
    projectId: string,
    preferenceText: string,
  ): Promise<WritingPreference> {
    return this.store.createPreference({
      id: this.ids.next(),
      projectId,
      preferenceText,
      source: "manual",
      now: this.clock.now(),
    });
  }

  public async editPreference(
    preference: WritingPreference,
    preferenceText: string,
  ): Promise<WritingPreference> {
    return this.store.updatePreference({
      preferenceId: preference.id,
      expectedRevision: preference.revision,
      preferenceText,
      now: this.clock.now(),
    });
  }

  public async setPreferenceEnabled(
    preference: WritingPreference,
    enabled: boolean,
  ): Promise<WritingPreference> {
    return this.store.updatePreference({
      preferenceId: preference.id,
      expectedRevision: preference.revision,
      enabled,
      now: this.clock.now(),
    });
  }

  public async deletePreference(preference: WritingPreference): Promise<WritingPreference> {
    return this.store.updatePreference({
      preferenceId: preference.id,
      expectedRevision: preference.revision,
      delete: true,
      now: this.clock.now(),
    });
  }

  public clearPreferences(projectId: string): Promise<number> {
    return this.store.clearPreferences(projectId, this.clock.now());
  }

  public setLearningEnabled(
    policy: WritingFeedbackPolicy,
    enabled: boolean,
  ): Promise<WritingFeedbackPolicy> {
    return this.store.setLearningEnabled(
      policy.projectId,
      enabled,
      policy.revision,
      this.clock.now(),
    );
  }
}

function normalizeCustomFeedback(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length > MAXIMUM_LEARNABLE_CUSTOM_FEEDBACK_CHARACTERS) {
    throw new WritingFeedbackStoreError(
      "WRITING_FEEDBACK_INVALID",
      `自定义反馈不能超过 ${String(MAXIMUM_LEARNABLE_CUSTOM_FEEDBACK_CHARACTERS)} 个字符。`,
    );
  }
  return normalized.length === 0 ? null : normalized;
}

function normalizeIdempotencyIdentity(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 1 || normalized.length > 2_000 || normalized.includes("\0")) {
    throw new WritingFeedbackStoreError("WRITING_FEEDBACK_INVALID", "明确反馈的重试身份无效。");
  }
  return normalized;
}

async function explicitFeedbackIdempotencyHash(
  projectId: string,
  identity: string,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `inkshadow/writing-feedback-explicit/v1\u0000${projectId}\u0000${identity}`,
    ),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function customFeedbackHash(value: string): Promise<string> {
  const clusterIdentity = value.toLocaleLowerCase("zh-CN");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(clusterIdentity),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
