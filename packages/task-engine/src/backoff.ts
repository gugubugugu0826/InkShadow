import { TaskEngineError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export interface RandomSource {
  next(): number;
}

export interface BackoffPolicy {
  delayMilliseconds(attempt: number): Result<number, TaskEngineError>;
}

export interface ExponentialBackoffOptions {
  readonly baseDelayMilliseconds: number;
  readonly maximumDelayMilliseconds: number;
  readonly multiplier: number;
  readonly jitterRatio: number;
  readonly random: RandomSource;
}

export class ExponentialBackoffPolicy implements BackoffPolicy {
  public constructor(private readonly options: ExponentialBackoffOptions) {}

  public delayMilliseconds(attempt: number): Result<number, TaskEngineError> {
    if (
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      !Number.isSafeInteger(this.options.baseDelayMilliseconds) ||
      this.options.baseDelayMilliseconds <= 0 ||
      !Number.isSafeInteger(this.options.maximumDelayMilliseconds) ||
      this.options.maximumDelayMilliseconds < this.options.baseDelayMilliseconds ||
      !Number.isFinite(this.options.multiplier) ||
      this.options.multiplier < 1 ||
      !Number.isFinite(this.options.jitterRatio) ||
      this.options.jitterRatio < 0 ||
      this.options.jitterRatio > 1
    ) {
      return err(
        new TaskEngineError({
          code: "TASK_VALIDATION_FAILED",
          message: "Backoff configuration or attempt is invalid.",
        }),
      );
    }

    const random = this.options.random.next();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      return err(
        new TaskEngineError({
          code: "TASK_VALIDATION_FAILED",
          message: "Injected jitter must produce a value between zero and one.",
        }),
      );
    }

    const uncapped = this.options.baseDelayMilliseconds * this.options.multiplier ** (attempt - 1);
    const capped = Math.min(this.options.maximumDelayMilliseconds, uncapped);
    const minimum = capped * (1 - this.options.jitterRatio);
    const jitterRange = capped * this.options.jitterRatio * 2;
    return ok(Math.max(1, Math.round(minimum + jitterRange * random)));
  }
}
