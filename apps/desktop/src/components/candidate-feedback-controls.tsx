import { useState } from "react";
import { Button, FormField, InlineAlert, Textarea } from "@inkshadow/ui";

import {
  MAXIMUM_LEARNABLE_CUSTOM_FEEDBACK_CHARACTERS,
  WRITING_FEEDBACK_CODE_LABELS,
  type WritingFeedbackCode,
} from "../infrastructure/writing-feedback-store";

const QUICK_CODES: readonly WritingFeedbackCode[] = [
  "smaller_changes",
  "larger_changes",
  "natural_dialogue",
  "more_dialogue",
  "less_environment_description",
  "faster_pacing",
  "preserve_style",
  "avoid_summary_ending",
];

export interface CandidateFeedbackControlsProps {
  readonly busy?: boolean;
  readonly onSubmit: (input: {
    readonly feedbackCode: WritingFeedbackCode | null;
    readonly customFeedback: string | null;
  }) => Promise<void>;
}

export function CandidateFeedbackControls({
  busy = false,
  onSubmit,
}: CandidateFeedbackControlsProps) {
  const [selected, setSelected] = useState<WritingFeedbackCode | null>(null);
  const [custom, setCustom] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (submitted) {
    return (
      <InlineAlert
        tone="info"
        title="这次意见已记下"
        description="同类意见重复出现后，会形成一条可见、可编辑的写作偏好；你可以随时暂停或删除。"
      />
    );
  }

  const disabled = busy || localBusy;

  async function submit(): Promise<void> {
    const customFeedback = custom.trim();
    if (selected === null && customFeedback.length === 0) return;
    setLocalBusy(true);
    setError(null);
    try {
      await onSubmit({
        feedbackCode: selected,
        customFeedback: customFeedback.length === 0 ? null : customFeedback,
      });
      setSubmitted(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "暂时无法保存这次意见，请稍后重试。");
    } finally {
      setLocalBusy(false);
    }
  }

  return (
    <section className="candidate-feedback-controls" aria-labelledby="candidate-feedback-title">
      <h3 id="candidate-feedback-title">哪里不符合你的预期？</h3>
      <p className="candidate-panel__hint">可选一个常用意见，也可以直接说明；这不会修改正文。</p>
      <div className="settings-actions" role="group" aria-label="常用修改意见">
        {QUICK_CODES.map((code) => (
          <Button
            key={code}
            size="sm"
            variant={selected === code ? "primary" : "secondary"}
            aria-pressed={selected === code}
            disabled={disabled}
            onClick={() => setSelected((current) => (current === code ? null : code))}
          >
            {WRITING_FEEDBACK_CODE_LABELS[code]}
          </Button>
        ))}
      </div>
      <FormField label="自定义意见" hint="可跳过，不需要写提示词。">
        {(fieldProps) => (
          <Textarea
            {...fieldProps}
            rows={2}
            maxLength={MAXIMUM_LEARNABLE_CUSTOM_FEEDBACK_CHARACTERS}
            currentLength={custom.length}
            value={custom}
            disabled={disabled}
            onChange={(event) => setCustom(event.currentTarget.value)}
          />
        )}
      </FormField>
      {error !== null && <InlineAlert tone="error" title="意见尚未保存" description={error} />}
      <Button
        size="sm"
        loading={localBusy}
        disabled={disabled || (selected === null && custom.trim().length === 0)}
        onClick={() => void submit()}
      >
        记住这次意见
      </Button>
    </section>
  );
}
