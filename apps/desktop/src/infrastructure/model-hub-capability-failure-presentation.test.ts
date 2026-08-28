import { describe, expect, it } from "vitest";

import { describeModelHubCapabilityProbeFailure } from "./model-hub-capability-failure-presentation";

describe("describeModelHubCapabilityProbeFailure", () => {
  it("does not blame either the model or path when a not-found response is ambiguous", () => {
    const presentation = describeModelHubCapabilityProbeFailure({
      phase: "dispatch",
      failureStage: "http_response",
      code: "MODEL_HTTP_NOT_FOUND",
      httpStatus: 404,
    });

    expect(presentation).toEqual({
      stageLabel: "服务商响应",
      reason: "服务商没有找到本次请求对应的模型或接口路径；现有证据不足以判断是哪一项不匹配。",
      recovery: "请同时核对模型标识和接口路径，保存后再由你明确重试；系统不会自动重发。",
      diagnosticCode: "MODEL_HTTP_NOT_FOUND",
      httpStatus: 404,
    });
    expect(`${presentation.stageLabel}${presentation.reason}${presentation.recovery}`).not.toMatch(
      /404|MODEL_HTTP_NOT_FOUND/u,
    );
  });

  it("separates a local preparation failure from any provider dispatch", () => {
    const presentation = describeModelHubCapabilityProbeFailure({
      phase: "preparation",
      failureStage: "request_preparation",
      code: "MODEL_HUB_CONFIGURATION_CHANGED_BEFORE_DISPATCH",
      httpStatus: null,
    });

    expect(presentation).toMatchObject({
      stageLabel: "发送前准备",
      reason: "本机在发送前未能准备好连接、模型或验证资料。",
      recovery: "请重新读取当前连接，核对模型和接入设置后再次确认；本次没有发送请求。",
    });
  });

  it.each([
    ["transport", "连接传输"],
    ["stream_parse", "流式读取"],
    ["response_normalization", "结果检查"],
  ] as const)("names the %s phase in natural Chinese", (failureStage, stageLabel) => {
    expect(
      describeModelHubCapabilityProbeFailure({
        phase: "dispatch",
        failureStage,
        code: "MODEL_CAPABILITY_PROBE_FAILED",
        httpStatus: null,
      }).stageLabel,
    ).toBe(stageLabel);
  });

  it("marks an uncertain post-dispatch result as a review rather than a normal failure", () => {
    expect(
      describeModelHubCapabilityProbeFailure({
        phase: "result",
        failureStage: "transport",
        code: "PROVIDER_RESULT_AMBIGUOUS",
        httpStatus: null,
      }),
    ).toMatchObject({
      stageLabel: "结果核对",
      reason: "请求已经发送，但在取得明确结果前连接中断，因此本次结果仍需核对。",
      recovery: "请先核对服务商记录和模型中心的本次记录；系统不会自动重发；连接和模型目录会保留。",
    });
  });

  it("keeps a changed disclosure at zero dispatch and asks for a fresh confirmation", () => {
    const presentation = describeModelHubCapabilityProbeFailure({
      phase: "preparation",
      failureStage: "request_preparation",
      code: "MODEL_HUB_PROBE_DISCLOSURE_CHANGED",
      httpStatus: null,
    });

    expect(presentation).toMatchObject({
      stageLabel: "发送前准备",
      recovery: "请重新查看固定验证说明并再次确认。",
    });
    expect(presentation.reason).toMatch(/本次没有发送请求/u);
  });

  it.each([
    ["MODEL_HUB_MODEL_NOT_FOUND", "当前保存的模型已不在可用模型目录中", "重新读取模型列表"],
    ["MODEL_PROVIDER_API_PATH_INVALID", "接口路径格式无效", "修正接口路径并保存"],
    ["MODEL_TEXT_UNSUPPORTED", "所选模型没有通过文字生成检查", "改选文字生成模型"],
    ["MODEL_HTTP_UNAUTHORIZED", "已保存凭据无效或已失效", "明确更换凭据"],
    [
      "MODEL_PROVIDER_WORKSPACE_REQUIRED",
      "当前地域必须填写服务工作区编号",
      "填写正确的服务工作区编号",
    ],
    ["MODEL_HUB_CATALOG_REFRESH_FAILED", "模型目录端点没有返回可用目录", "重新读取模型列表"],
    ["MODEL_NETWORK_ERROR", "网络连接没有到达服务商", "检查网络和接入地址"],
    ["MODEL_TIMEOUT", "服务商未在约定等待时间内返回明确结果", "先核对服务商记录"],
    [
      "MODEL_HUB_CAPABILITY_SELECTION_REQUIRED",
      "尚未明确选择要检查文字生成还是语义向量能力",
      "先选择一种能力",
    ],
  ] as const)("gives %s an evidence-specific reason and recovery", (code, reason, recovery) => {
    const presentation = describeModelHubCapabilityProbeFailure({
      phase: "dispatch",
      failureStage: code.includes("NETWORK") || code === "MODEL_TIMEOUT" ? "transport" : "unknown",
      code,
      httpStatus: code === "MODEL_HTTP_UNAUTHORIZED" ? 401 : null,
    });

    expect(presentation.reason).toContain(reason);
    expect(presentation.recovery).toContain(recovery);
    expect(
      `${presentation.stageLabel}${presentation.reason}${presentation.recovery}`,
    ).not.toContain(code);
  });
});
