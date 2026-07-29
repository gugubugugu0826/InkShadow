export const GENERATION_STATES = [
  "prechecking",
  "blocked",
  "queued",
  "retrieving",
  "generating",
  "validating",
  "candidate_ready",
  "failed_retryable",
  "failed_final",
  "cancelled",
  "completed",
] as const;

export type GenerationState = (typeof GENERATION_STATES)[number];

const ALLOWED_TRANSITIONS = {
  prechecking: ["blocked", "queued", "failed_retryable", "failed_final", "cancelled"],
  blocked: ["prechecking", "cancelled"],
  queued: ["retrieving", "failed_retryable", "failed_final", "cancelled"],
  retrieving: ["generating", "failed_retryable", "failed_final", "cancelled"],
  generating: ["validating", "failed_retryable", "failed_final", "cancelled"],
  validating: ["candidate_ready", "failed_retryable", "failed_final", "cancelled"],
  candidate_ready: ["completed", "failed_retryable", "cancelled"],
  failed_retryable: ["queued", "failed_final", "cancelled"],
  failed_final: [],
  cancelled: [],
  completed: [],
} as const satisfies Readonly<Record<GenerationState, readonly GenerationState[]>>;

export class IllegalGenerationTransitionError extends Error {
  readonly code = "GENERATION_ILLEGAL_TRANSITION";

  constructor(
    readonly from: GenerationState,
    readonly to: GenerationState,
  ) {
    super(`Generation cannot transition from "${from}" to "${to}".`);
    this.name = "IllegalGenerationTransitionError";
  }
}

export function canTransitionGenerationState(from: GenerationState, to: GenerationState): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly GenerationState[]).includes(to);
}

export function transitionGenerationState(
  from: GenerationState,
  to: GenerationState,
): GenerationState {
  if (!canTransitionGenerationState(from, to)) {
    throw new IllegalGenerationTransitionError(from, to);
  }
  return to;
}

export function isTerminalGenerationState(state: GenerationState): boolean {
  return ["failed_final", "cancelled", "completed"].includes(state);
}
