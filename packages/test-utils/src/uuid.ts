import type { TestOnlyContext } from "./runtime.js";

export type DeterministicUuidFactory = () => string;

function timestampToHex(instant: Date | string | number): string {
  const milliseconds = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 0xffffffffffff) {
    throw new Error("UUIDv7 test timestamps must fit in 48 bits.");
  }
  return milliseconds.toString(16).padStart(12, "0");
}

export function createDeterministicUuidFactory(
  context: TestOnlyContext,
  options: {
    readonly timestamp?: Date | string | number;
    readonly initialCounter?: bigint;
  } = {},
): DeterministicUuidFactory {
  void context;
  const timestampHex = timestampToHex(options.timestamp ?? "2026-01-01T00:00:00.000Z");
  let counter = options.initialCounter ?? 0n;
  if (counter < 0n || counter > 0x3fffffffffffffffffn) {
    throw new Error("UUIDv7 test counters must fit in 70 bits.");
  }

  return () => {
    if (counter > 0x3fffffffffffffffffn) {
      throw new Error("Deterministic UUID counter exhausted.");
    }
    const counterHex = counter.toString(16).padStart(18, "0");
    counter += 1n;
    return [
      timestampHex.slice(0, 8),
      timestampHex.slice(8, 12),
      `7${counterHex.slice(0, 3)}`,
      `8${counterHex.slice(3, 6)}`,
      counterHex.slice(6, 18),
    ].join("-");
  };
}
