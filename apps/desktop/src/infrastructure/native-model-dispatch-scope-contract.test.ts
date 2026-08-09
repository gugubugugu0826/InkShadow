import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "..");
const CENTRAL_EXECUTORS = new Set([
  "executeModelHubTextTask",
  "executeModelHubEmbeddingTask",
  "executeModelHubRerankTask",
]);
const DIRECT_GATEWAY_METHODS = new Set(["generate", "embed", "rerank", "executeText"]);
const NON_PROJECT_ALLOWLIST = new Map<
  string,
  Readonly<{ reason: "creative_opening" | "connection_probe"; occurrences: number }>
>([
  ["infrastructure/creative-opening-service.ts", { reason: "creative_opening", occurrences: 2 }],
  [
    "infrastructure/model-hub-local-evaluation-service.ts",
    { reason: "connection_probe", occurrences: 1 },
  ],
  [
    "infrastructure/model-hub-text-capability-probe.ts",
    // Every fixed `只回复：OK` capability check must pass through the shared
    // provider-aware budget, reasoning, truncation and redaction boundary.
    { reason: "connection_probe", occurrences: 1 },
  ],
]);

describe("native model dispatch scope production contract", () => {
  it("classifies every direct literal production text, embedding and rerank dispatch", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
        continue;
      }
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const argumentIndex = dispatchArgumentIndex(node);
          if (argumentIndex !== null) {
            const argument = node.arguments[argumentIndex];
            // Non-literal requests remain protected by the required TypeScript
            // gateway contract. This structural audit covers the literal call
            // sites where a broad or optional contract could otherwise hide an
            // omitted classification.
            if (
              argument !== undefined &&
              ts.isObjectLiteralExpression(argument) &&
              !hasDispatchScope(argument)
            ) {
              const position = source.getLineAndCharacterOfPosition(node.getStart(source));
              missing.push(`${path.relative(SOURCE_ROOT, file)}:${String(position.line + 1)}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(missing).toEqual([]);
  });

  it("allows non-project dispatch only at reviewed content-free entry points", () => {
    const violations: string[] = [];
    const actualOccurrences = new Map<string, number>(
      [...NON_PROJECT_ALLOWLIST.keys()].map((file) => [file, 0] as const),
    );
    for (const file of sourceFiles(SOURCE_ROOT)) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
        continue;
      }
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const relative = path.relative(SOURCE_ROOT, file).replaceAll("\\", "/");
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const kind = stringProperty(node, "kind");
          if (kind === "non_project") {
            const reason = stringProperty(node, "reason");
            const policy = NON_PROJECT_ALLOWLIST.get(relative);
            if (policy !== undefined) {
              actualOccurrences.set(relative, (actualOccurrences.get(relative) ?? 0) + 1);
            }
            if (reason === null || policy?.reason !== reason) {
              const position = source.getLineAndCharacterOfPosition(node.getStart(source));
              violations.push(
                `${relative}:${String(position.line + 1)}:${reason ?? "missing_reason"}`,
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
    expect(Object.fromEntries(actualOccurrences)).toEqual(
      Object.fromEntries(
        [...NON_PROJECT_ALLOWLIST].map(([file, policy]) => [file, policy.occurrences]),
      ),
    );
  });

  it("requires every project-search gateway call to declare project context", () => {
    const file = path.join(SOURCE_ROOT, "infrastructure/project-search-vector-service.ts");
    const sourceText = readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const purposes: string[] = [];
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "this" &&
        node.expression.name.text === "callGateway"
      ) {
        const dispatch = node.arguments[1];
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        if (dispatch === undefined || !ts.isObjectLiteralExpression(dispatch)) {
          violations.push(`line ${String(position.line + 1)}:missing_literal_dispatch`);
        } else {
          const kind = stringProperty(dispatch, "kind");
          purposes.push(kind ?? "missing_kind");
          if (
            kind !== "project_context" ||
            !hasProperty(dispatch, "inputs") ||
            !hasProperty(dispatch, "receipt")
          ) {
            violations.push(`line ${String(position.line + 1)}:${kind ?? "missing_kind"}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(violations).toEqual([]);
    expect(purposes).toEqual([
      "project_context",
      "project_context",
      "project_context",
      "project_context",
    ]);
    expect(sourceText).not.toContain("inputs[0] === CAPABILITY_PROBE");
    expect(sourceText).not.toContain('kind: "non_project"');
  });
});

function stringProperty(object: ts.ObjectLiteralExpression, name: string): string | null {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === name &&
      ts.isStringLiteral(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return null;
}

function dispatchArgumentIndex(call: ts.CallExpression): number | null {
  if (ts.isIdentifier(call.expression) && CENTRAL_EXECUTORS.has(call.expression.text)) {
    return 1;
  }
  if (ts.isPropertyAccessExpression(call.expression)) {
    const method = call.expression.name.text;
    if (!DIRECT_GATEWAY_METHODS.has(method)) {
      return null;
    }
    const receiver = call.expression.expression.getText();
    if (method === "executeText" && receiver === "this") {
      return 1;
    }
    if (!/(^|\.)(modelGateway|gateway)$/u.test(receiver)) {
      return null;
    }
    return call.expression.name.text === "executeText" ? 1 : 0;
  }
  return null;
}

function hasDispatchScope(request: ts.ObjectLiteralExpression): boolean {
  return hasProperty(request, "dispatchScope");
}

function hasProperty(request: ts.ObjectLiteralExpression, name: string): boolean {
  return request.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      property.name.getText() === name,
  );
}

function sourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (absolute.endsWith(".ts") || absolute.endsWith(".tsx")) {
      files.push(absolute);
    }
  }
  return files;
}
