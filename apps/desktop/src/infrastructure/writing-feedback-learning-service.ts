import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import {
  WRITING_FEEDBACK_PREFERENCE_TEXT,
  type RecordedCandidateApplicationStrategy,
  type WritingFeedbackAction,
  type WritingFeedbackCode,
  type WritingFeedbackEvent,
  type WritingFeedbackPolicy,
  type WritingFeedbackStore,
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
    const event: WritingFeedbackEvent = Object.freeze({
      id: this.ids.next(),
      projectId: input.projectId,
      chapterId: input.chapterId ?? null,
      candidateId: input.candidateId ?? null,
      action: input.action,
      feedbackCode: null,
      customFeedback: null,
      applicationStrategy: input.applicationStrategy ?? null,
      acceptedChangeCount: input.acceptedChangeCount ?? null,
      rejectedChangeCount: input.rejectedChangeCount ?? null,
      createdAt: this.clock.now(),
    });
    await this.store.recordEvent(event);
    return event;
  }

  public async recordExplicitFeedback(
    input: RecordExplicitWritingFeedbackInput,
  ): Promise<ExplicitFeedbackOutcome> {
    const event: WritingFeedbackEvent = Object.freeze({
      id: this.ids.next(),
      projectId: input.projectId,
      chapterId: input.chapterId ?? null,
      candidateId: input.candidateId ?? null,
      action: "explicit_feedback",
      feedbackCode: input.feedbackCode ?? null,
      customFeedback: input.customFeedback ?? null,
      applicationStrategy: null,
      acceptedChangeCount: null,
      rejectedChangeCount: null,
      createdAt: this.clock.now(),
    });
    await this.store.recordEvent(event);

    const policy = await this.store.getPolicy(input.projectId);
    const learnedPreference =
      policy.learningEnabled && event.feedbackCode !== null
        ? await this.synchronizeFeedbackPreference(input.projectId, event.feedbackCode)
        : null;
    return Object.freeze({ event, learnedPreference });
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

  private async synchronizeFeedbackPreference(
    projectId: string,
    feedbackCode: WritingFeedbackCode,
  ): Promise<WritingPreference | null> {
    const events = await this.store.listEvents(projectId, 500);
    const evidenceCount = events.filter(
      (event) => event.action === "explicit_feedback" && event.feedbackCode === feedbackCode,
    ).length;
    if (evidenceCount < LEARNING_EVIDENCE_THRESHOLD) return null;

    const preferences = await this.store.listPreferences(projectId);
    const existing = preferences.find(
      (preference) =>
        preference.source === "feedback_pattern" && preference.sourceFeedbackCode === feedbackCode,
    );
    if (existing !== undefined) {
      if (existing.evidenceCount === evidenceCount) return existing;
      return this.store.updatePreference({
        preferenceId: existing.id,
        expectedRevision: existing.revision,
        evidenceCount,
        now: this.clock.now(),
      });
    }
    return this.store.createPreference({
      id: this.ids.next(),
      projectId,
      preferenceText: WRITING_FEEDBACK_PREFERENCE_TEXT[feedbackCode],
      source: "feedback_pattern",
      sourceFeedbackCode: feedbackCode,
      evidenceCount,
      now: this.clock.now(),
    });
  }
}
