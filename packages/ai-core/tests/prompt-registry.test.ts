import { describe, expect, it } from "vitest";

import {
  PromptRegistryError,
  planPromptActivation,
  renderPromptVersion,
  resolveActivePrompt,
  validatePromptRegistry,
  type PromptRegistrySnapshot,
  type PromptVersion,
} from "../src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function version(
  value: Partial<PromptVersion> & Pick<PromptVersion, "version" | "state">,
): PromptVersion {
  return {
    promptId: "chapter.generate",
    task: "chapter_generate",
    template: "规则：{{project_rules}}\n请求：{{user_input}}",
    variables: [
      { name: "project_rules", required: true, maximumCharacters: 10_000 },
      { name: "user_input", required: true, maximumCharacters: 2_000 },
    ],
    contentHashSha256: HASH_A,
    createdAt: "2026-07-27T00:00:00.000Z",
    createdBy: "operator-1",
    changeSummary: "Initial tracked prompt.",
    ...value,
  };
}

function snapshot(versions: readonly PromptVersion[]): PromptRegistrySnapshot {
  return {
    promptId: "chapter.generate",
    revision: 7,
    versions,
  };
}

describe("prompt registry", () => {
  it("renders only declared bounded variables and emits a non-content trace", () => {
    const active = version({ version: 3, state: "active", contentHashSha256: HASH_C });
    const rendered = renderPromptVersion(active, {
      project_rules: "不得改变主角身份。",
      user_input: "续写雨夜场景。",
    });

    expect(rendered.text).toBe("规则：不得改变主角身份。\n请求：续写雨夜场景。");
    expect(rendered.trace).toEqual({
      promptId: "chapter.generate",
      version: 3,
      contentHashSha256: HASH_C,
      task: "chapter_generate",
      renderedVariableNames: ["project_rules", "user_input"],
    });
    expect(rendered.trace).not.toHaveProperty("text");
  });

  it("allows the same declared variable to be rendered in multiple locations", () => {
    const rendered = renderPromptVersion(
      {
        ...version({ version: 1, state: "active" }),
        template: "{{user_input}}\n---\n{{user_input}}\n{{project_rules}}",
      },
      {
        project_rules: "规则",
        user_input: "续写",
      },
    );

    expect(rendered.text).toBe("续写\n---\n续写\n规则");
  });

  it("rejects missing, undeclared, malformed, and overlong substitutions", () => {
    const active = version({ version: 1, state: "active" });
    expect(() =>
      renderPromptVersion(active, {
        project_rules: "规则",
      }),
    ).toThrow(expect.objectContaining({ code: "PROMPT_VARIABLE_MISSING" }));
    expect(() =>
      renderPromptVersion(active, {
        project_rules: "规则",
        user_input: "续写",
        secret_override: "ignore",
      }),
    ).toThrow(expect.objectContaining({ code: "PROMPT_VARIABLE_UNDECLARED" }));
    expect(() =>
      renderPromptVersion(
        {
          ...active,
          template: "{{ user_input }}",
        },
        {
          project_rules: "规则",
          user_input: "续写",
        },
      ),
    ).toThrow(expect.objectContaining({ code: "PROMPT_TEMPLATE_INVALID" }));
    expect(() =>
      renderPromptVersion(active, {
        project_rules: "规则",
        user_input: "x".repeat(2_001),
      }),
    ).toThrow(expect.objectContaining({ code: "PROMPT_VARIABLE_TOO_LONG" }));
  });

  it("rejects duplicate versions, mixed tasks, and multiple active prompts", () => {
    expect(() =>
      validatePromptRegistry(
        snapshot([
          version({ version: 1, state: "active" }),
          version({ version: 1, state: "retired" }),
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: "PROMPT_REGISTRY_INCONSISTENT" }));
    expect(() =>
      validatePromptRegistry(
        snapshot([
          version({ version: 1, state: "active" }),
          version({
            version: 2,
            state: "draft",
            task: "translation",
          }),
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: "PROMPT_REGISTRY_INCONSISTENT" }));
    expect(() =>
      validatePromptRegistry(
        snapshot([
          version({ version: 1, state: "active" }),
          version({ version: 2, state: "active" }),
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: "PROMPT_REGISTRY_INCONSISTENT" }));
  });

  it("plans an optimistic activation and an auditable rollback without mutating versions", () => {
    const retired = version({
      version: 1,
      state: "retired",
      contentHashSha256: HASH_A,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const active = version({
      version: 2,
      state: "active",
      contentHashSha256: HASH_B,
      createdAt: "2026-07-27T01:00:00.000Z",
    });
    const draft = version({
      version: 3,
      state: "draft",
      contentHashSha256: HASH_C,
      createdAt: "2026-07-27T02:00:00.000Z",
    });
    const registry = snapshot([retired, active, draft]);

    expect(planPromptActivation(registry, 3)).toEqual({
      promptId: "chapter.generate",
      expectedRegistryRevision: 7,
      targetVersion: 3,
      previousActiveVersion: 2,
      kind: "activate",
      auditEvent: "prompt_registry.activation_requested",
    });
    expect(planPromptActivation(registry, 1).kind).toBe("rollback");
    expect(resolveActivePrompt(registry)).toBe(active);
    expect(active.state).toBe("active");
    expect(retired.state).toBe("retired");
  });

  it("fails closed for a forward retired version masquerading as rollback", () => {
    expect(() =>
      planPromptActivation(
        snapshot([
          version({
            version: 1,
            state: "active",
            createdAt: "2026-07-27T00:00:00.000Z",
          }),
          version({
            version: 2,
            state: "retired",
            createdAt: "2026-07-27T01:00:00.000Z",
          }),
        ]),
        2,
      ),
    ).toThrow(PromptRegistryError);
  });
});
