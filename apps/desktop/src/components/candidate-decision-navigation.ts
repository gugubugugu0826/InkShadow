import "./candidate-decision.css";

const CANDIDATE_SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End"]);

interface CandidateDecisionKeyboardEvent {
  readonly key: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  preventDefault(): void;
}

/** Keeps long Candidate cards keyboard-operable without intercepting keys in nested editors. */
export function handleCandidateDecisionNavigation(event: CandidateDecisionKeyboardEvent): void {
  if (
    !(event.currentTarget instanceof HTMLElement) ||
    event.target !== event.currentTarget ||
    !CANDIDATE_SCROLL_KEYS.has(event.key)
  ) {
    return;
  }

  const scroller = event.currentTarget;
  const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const pageStep = Math.max(1, Math.floor(scroller.clientHeight * 0.85));
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? maximum
        : event.key === "PageDown"
          ? Math.min(maximum, scroller.scrollTop + pageStep)
          : Math.max(0, scroller.scrollTop - pageStep);

  event.preventDefault();
  scroller.scrollTop = next;
}

/** Expands nested Candidate editors so the containing decision body remains the only scroller. */
export function fitCandidateDecisionTextarea(textarea: HTMLTextAreaElement | null): void {
  if (textarea === null) return;
  textarea.style.height = "auto";
  if (textarea.scrollHeight > 0) {
    textarea.style.height = `${String(textarea.scrollHeight)}px`;
  }
}
