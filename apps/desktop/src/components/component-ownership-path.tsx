import { useContext, useMemo, type ReactNode } from "react";

import {
  ComponentOwnershipPathContext,
  requireComponentOwnershipName,
} from "./component-ownership-context";

export function ComponentOwnershipBoundary({
  name,
  children,
}: Readonly<{ name: string; children: ReactNode }>) {
  const parentPath = useContext(ComponentOwnershipPathContext);
  const safeName = requireComponentOwnershipName(name);
  const path = useMemo(() => Object.freeze([...parentPath, safeName]), [parentPath, safeName]);
  return (
    <ComponentOwnershipPathContext.Provider value={path}>
      {children}
    </ComponentOwnershipPathContext.Provider>
  );
}
