export type CloudStartupMode = "migrate-only" | "runtime";

export function parseCloudStartupMode(argumentsList: readonly string[]): CloudStartupMode {
  if (argumentsList.length === 0) {
    return "runtime";
  }
  if (argumentsList.length === 1 && argumentsList[0] === "--migrate-only") {
    return "migrate-only";
  }
  throw new Error("InkShadow cloud API accepts only the optional --migrate-only argument.");
}
