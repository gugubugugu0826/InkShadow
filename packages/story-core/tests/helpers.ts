import type { Clock, Result, UuidV7Generator } from "../src/index.js";

export function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

export class ManualClock implements Clock {
  public constructor(private current: string) {}

  public now(): string {
    return this.current;
  }

  public set(value: string): void {
    this.current = value;
  }
}

export class SequenceUuidV7Generator implements UuidV7Generator {
  private sequence: number;

  public constructor(start = 1_000) {
    this.sequence = start;
  }

  public next(): string {
    const value = uuid(this.sequence);
    this.sequence += 1;
    return value;
  }
}

export function unwrap<Value, Failure>(result: Result<Value, Failure>): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}
