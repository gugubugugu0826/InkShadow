import { beforeEach, describe, expect, it } from "vitest";

import {
  continuationConfirmationRemembered,
  forgetContinuationConfirmation,
  rememberContinuationConfirmation,
  type ContinuationConfirmationScope,
} from "./continuation-confirmation-session";

const SCOPE: ContinuationConfirmationScope = Object.freeze({
  projectId: "019f9f4a-b3c7-7350-9226-000000000001",
  chapterId: "019f9f4a-b3c7-7350-9226-000000000002",
  bodyVersionId: "019f9f4a-b3c7-7350-9226-000000000003",
  modelId: "writer-model",
  providerDisplayName: "写作服务",
  taskType: "continuation",
  storyDataScope: "当前章节和本次明确选中的故事资料",
  privacyDestination: "remote",
  disclosureFingerprint: "scope-fingerprint-v1",
});

describe("continuation confirmation session", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("remembers only the exact explicitly granted scope in session storage", () => {
    rememberContinuationConfirmation(window.sessionStorage, SCOPE);

    expect(continuationConfirmationRemembered(window.sessionStorage, SCOPE)).toBe(true);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(1);
  });

  it("keeps an opening confirmation distinct from a continuation confirmation", () => {
    const openingScope = Object.freeze({
      ...SCOPE,
      taskType: "prose_generation",
    }) as unknown as ContinuationConfirmationScope;

    rememberContinuationConfirmation(window.sessionStorage, openingScope);

    expect(continuationConfirmationRemembered(window.sessionStorage, openingScope)).toBe(true);
    expect(continuationConfirmationRemembered(window.sessionStorage, SCOPE)).toBe(false);
  });

  it.each([
    ["projectId", "019f9f4a-b3c7-7350-9226-000000000011"],
    ["chapterId", "019f9f4a-b3c7-7350-9226-000000000012"],
    ["bodyVersionId", "019f9f4a-b3c7-7350-9226-000000000013"],
    ["modelId", "another-model"],
    ["providerDisplayName", "另一项写作服务"],
    ["taskType", "selection_rewrite"],
    ["storyDataScope", "仅当前章节"],
    ["privacyDestination", "local"],
    ["disclosureFingerprint", "scope-fingerprint-v2"],
  ] as const)("invalidates the remembered confirmation when %s changes", (field, value) => {
    rememberContinuationConfirmation(window.sessionStorage, SCOPE);
    const changed = Object.freeze({ ...SCOPE, [field]: value }) as ContinuationConfirmationScope;

    expect(continuationConfirmationRemembered(window.sessionStorage, changed)).toBe(false);
    expect(continuationConfirmationRemembered(window.sessionStorage, SCOPE)).toBe(false);
  });

  it("can be explicitly forgotten", () => {
    rememberContinuationConfirmation(window.sessionStorage, SCOPE);
    forgetContinuationConfirmation(window.sessionStorage);

    expect(continuationConfirmationRemembered(window.sessionStorage, SCOPE)).toBe(false);
  });
});
