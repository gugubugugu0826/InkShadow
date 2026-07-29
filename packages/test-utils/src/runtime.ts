const TEST_CONTEXT_BRAND: unique symbol = Symbol("inkshadow.test-only");

export interface TestOnlyContext {
  readonly runtime: "test";
  readonly [TEST_CONTEXT_BRAND]: true;
}

export class UnsafeTestUtilityUsageError extends Error {
  readonly code = "TEST_UTILS_OUTSIDE_TEST_RUNTIME";

  constructor(runtime: string | undefined) {
    super(
      `@inkshadow/test-utils requires the explicit "test" runtime, received "${runtime ?? "undefined"}".`,
    );
    this.name = "UnsafeTestUtilityUsageError";
  }
}

export function assertTestRuntime(runtime: string | undefined): asserts runtime is "test" {
  if (runtime !== "test") {
    throw new UnsafeTestUtilityUsageError(runtime);
  }
}

export function createTestOnlyContext(runtime: string | undefined): TestOnlyContext {
  assertTestRuntime(runtime);
  return Object.freeze({
    runtime,
    [TEST_CONTEXT_BRAND]: true as const,
  });
}
