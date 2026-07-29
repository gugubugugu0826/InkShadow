export type Result<T, E> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>;

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function mapResult<T, U, E>(result: Result<T, E>, map: (value: T) => U): Result<U, E> {
  return result.ok ? ok(map(result.value)) : result;
}

export function flatMapResult<T, U, E>(
  result: Result<T, E>,
  map: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? map(result.value) : result;
}
