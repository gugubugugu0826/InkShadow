import { describe, expect, it } from "vitest";

import { collectDesktopDiagnosticArtifact } from "./diagnostics";
import { createDevelopmentRuntime } from "./runtime";

describe("desktop diagnostics", () => {
  it("exports bounded runtime health without project text, prompts, or credentials", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "诊断测试项目" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "敏感章节",
      content: "绝不能进入诊断包的正文标记。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    window.localStorage.setItem("unrelated-secret", "sk-never-include-this-value");
    await runtime.modelCenter.save({
      providerId: "private-provider",
      provider: "open_ai_compatible",
      baseUrl: "https://private.example/v1",
      authentication: "bearer_keyring",
      selectedModel: "proprietary-model-42",
      expectedRevision: null,
    });
    const search = await runtime.search.search(project.value.id, "绝不能进入");
    if (!search.ok) {
      throw search.error;
    }

    const artifact = await collectDesktopDiagnosticArtifact(runtime);

    expect(artifact.fileName).toMatch(/^InkShadow-diagnostics-\d{4}-\d{2}-\d{2}-/u);
    expect(artifact.bundle).toMatchObject({
      schemaVersion: 1,
      summary: {
        appVersion: "0.1.0",
        databaseHealth: "unknown",
        indexHealth: "healthy",
        syncState: "local_only",
      },
      privacy: {
        projectContentIncluded: false,
        promptContentIncluded: false,
        credentialsIncluded: false,
        uploadedFilesIncluded: false,
      },
      localCloudFoundation: null,
    });
    expect(artifact.content).not.toContain("绝不能进入诊断包的正文标记");
    expect(artifact.content).not.toContain("sk-never-include-this-value");
    expect(artifact.content).not.toContain("敏感章节");
    expect(artifact.content).not.toContain("private-provider");
    expect(artifact.content).not.toContain("private.example");
    expect(artifact.content).not.toContain("proprietary-model-42");
    expect(artifact.bundle.summary.configuration).toMatchObject({
      indexIntegrated: true,
      indexPersistence: "runtime_rebuild",
      indexedDocumentCount: 1,
      vectorStatus: "disabled",
      modelProfileCount: 1,
      modelProfilesWithSelection: 1,
      nativeModelGatewayAvailable: false,
      cloudIdentityEnabled: false,
      cloudSyncEnabled: false,
      encryptedSyncStore: "unavailable",
      entitlementCacheTrust: "unverified_only",
    });
  });
});
