import type { TestOnlyContext } from "./runtime.js";

export interface TestBuilder<T extends object> {
  build(overrides?: Partial<T>): Readonly<T>;
  buildList(count: number, overrides?: (index: number) => Partial<T>): readonly Readonly<T>[];
}

export function createTestBuilder<T extends object>(
  context: TestOnlyContext,
  defaults: (sequence: number) => T,
): TestBuilder<T> {
  void context;
  let sequence = 0;

  const build = (overrides: Partial<T> = {}): Readonly<T> => {
    const value = Object.freeze({
      ...defaults(sequence),
      ...overrides,
    });
    sequence += 1;
    return value;
  };

  return {
    build,
    buildList(count, overrides) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("Builder list counts must be non-negative integers.");
      }
      return Object.freeze(Array.from({ length: count }, (_, index) => build(overrides?.(index))));
    },
  };
}
