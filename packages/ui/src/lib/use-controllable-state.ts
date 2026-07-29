import { useCallback, useState } from "react";

export interface ControllableStateOptions<T> {
  value?: T | undefined;
  defaultValue: T;
  onChange?: ((value: T) => void) | undefined;
}

export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: ControllableStateOptions<T>): readonly [T, (nextValue: T | ((currentValue: T) => T)) => void] {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const controlled = value !== undefined;
  const currentValue = controlled ? value : internalValue;

  const setValue = useCallback(
    (nextValue: T | ((currentValue: T) => T)): void => {
      const resolvedValue =
        typeof nextValue === "function"
          ? (nextValue as (currentValue: T) => T)(currentValue)
          : nextValue;

      if (!controlled) {
        setInternalValue(resolvedValue);
      }
      onChange?.(resolvedValue);
    },
    [controlled, currentValue, onChange],
  );

  return [currentValue, setValue] as const;
}
