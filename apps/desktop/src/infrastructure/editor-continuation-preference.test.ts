import { describe, expect, it } from "vitest";

import {
  clearEditorContinuationPreference,
  DEFAULT_EDITOR_CONTINUATION_PREFERENCE,
  loadEditorContinuationPreference,
  saveEditorContinuationPreference,
} from "./editor-continuation-preference";

describe("editor continuation preference", () => {
  it("partitions preferences by project and migrates the old custom profile into advanced target", () => {
    const storage = memoryStorage();
    saveEditorContinuationPreference(storage, "project-a", {
      schemaVersion: 1,
      profile: "custom",
      customTargetVisibleCharacters: 3_300,
      destination: "custom_instruction",
      customDestinationInstruction: "写到主角发现密信为止。",
    });

    expect(loadEditorContinuationPreference(storage, "project-a")).toMatchObject({
      profile: "standard",
      customTargetVisibleCharacters: 3_300,
      destination: "custom_instruction",
      customDestinationInstruction: "写到主角发现密信为止。",
    });
    expect(loadEditorContinuationPreference(storage, "project-b")).toEqual(
      DEFAULT_EDITOR_CONTINUATION_PREFERENCE,
    );
  });

  it("degrades invalid or cleared state to the visible standard default", () => {
    const storage = memoryStorage();
    storage.setItem("inkshadow.editor-continuation-preference.v1:project-a", "{broken");
    expect(loadEditorContinuationPreference(storage, "project-a")).toEqual(
      DEFAULT_EDITOR_CONTINUATION_PREFERENCE,
    );
    saveEditorContinuationPreference(storage, "project-a", {
      schemaVersion: 1,
      profile: "long",
      customTargetVisibleCharacters: null,
      destination: "next_segment",
      customDestinationInstruction: null,
    });
    clearEditorContinuationPreference(storage, "project-a");
    expect(loadEditorContinuationPreference(storage, "project-a")).toEqual(
      DEFAULT_EDITOR_CONTINUATION_PREFERENCE,
    );
  });

  it("upgrades the earlier length-only device preference with a visible destination default", () => {
    const storage = memoryStorage();
    storage.setItem(
      "inkshadow.editor-continuation-preference.v1:project-a",
      JSON.stringify({
        schemaVersion: 1,
        profile: "short",
        customTargetVisibleCharacters: null,
      }),
    );

    expect(loadEditorContinuationPreference(storage, "project-a")).toMatchObject({
      profile: "short",
      destination: "complete_scene",
      customDestinationInstruction: null,
    });
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}
