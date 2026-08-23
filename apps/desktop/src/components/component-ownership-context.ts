import { createContext, useContext, useMemo } from "react";

const EMPTY_COMPONENT_PATH: readonly string[] = Object.freeze([]);
export const ComponentOwnershipPathContext = createContext<readonly string[]>(EMPTY_COMPONENT_PATH);
const COMPONENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]{0,63}$/u;

export function requireComponentOwnershipName(name: string): string {
  if (!COMPONENT_NAME_PATTERN.test(name)) {
    throw new Error("Component ownership names must be static safe identifiers.");
  }
  return name;
}

/** Returns the mounted ownership path registered by the rendered component tree. */
export function useComponentOwnershipPath(componentName: string): readonly string[] {
  const parentPath = useContext(ComponentOwnershipPathContext);
  const safeName = requireComponentOwnershipName(componentName);
  return useMemo(() => Object.freeze([...parentPath, safeName]), [parentPath, safeName]);
}

/**
 * Async repository failures do not produce React ErrorInfo. This records only
 * the mounted ownership path. Application call frames are captured and stored
 * separately from the original failure cause.
 */
export function captureMountedComponentPath(ownershipPath: readonly string[]): string {
  const componentFrames = ownershipPath.map(
    (name) => `    at ${requireComponentOwnershipName(name)}`,
  );
  return ["Mounted component ownership path", ...componentFrames].join("\n");
}
