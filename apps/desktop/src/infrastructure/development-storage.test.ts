import { describe, expect, it } from "vitest";

import { createDevelopmentRuntime } from "./runtime";

describe("development-only localStorage persistence", () => {
  it("persists application use-case output across runtime instances", async () => {
    const firstRuntime = createDevelopmentRuntime(window.localStorage);
    const created = await firstRuntime.useCases.createProject.execute({
      name: "持久化测试项目",
    });
    expect(created.ok).toBe(true);

    const secondRuntime = createDevelopmentRuntime(window.localStorage);
    const listed = await secondRuntime.useCases.listProjects.execute();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((project) => project.name)).toEqual(["持久化测试项目"]);
    }
  });
});
