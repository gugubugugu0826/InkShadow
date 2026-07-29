export type ClassValue =
  | string
  | false
  | null
  | undefined
  | Readonly<Record<string, boolean | null | undefined>>
  | readonly ClassValue[];

function isClassValueArray(value: ClassValue): value is readonly ClassValue[] {
  return Array.isArray(value);
}

function appendClassValue(target: string[], value: ClassValue): void {
  if (!value) {
    return;
  }

  if (typeof value === "string") {
    target.push(value);
    return;
  }

  if (isClassValueArray(value)) {
    for (const item of value) {
      appendClassValue(target, item);
    }
    return;
  }

  for (const [className, enabled] of Object.entries(value)) {
    if (enabled) {
      target.push(className);
    }
  }
}

export function cn(...values: readonly ClassValue[]): string {
  const classNames: string[] = [];

  for (const value of values) {
    appendClassValue(classNames, value);
  }

  return classNames.join(" ");
}
