import type { ModelFailureStage } from "./model-hub-store";

export type ModelHubCapabilityFailurePhase = "preparation" | "dispatch" | "result";

export interface ModelHubCapabilityFailurePresentation {
  readonly stageLabel: string;
  readonly reason: string;
  readonly recovery: string;
  readonly diagnosticCode: string;
  readonly httpStatus: number | null;
}

/**
 * Keeps the ordinary explanation evidence-bounded while retaining transport
 * facts for an explicitly opened diagnostic disclosure.
 */
export function describeModelHubCapabilityProbeFailure(
  input: Readonly<{
    phase: ModelHubCapabilityFailurePhase;
    failureStage: ModelFailureStage | null;
    code: string;
    httpStatus: number | null;
  }>,
): ModelHubCapabilityFailurePresentation {
  const ambiguousNotFound =
    input.httpStatus === 404 || /(?:MODEL_HTTP_NOT_FOUND|HTTP_?404|STATUS_?404)/u.test(input.code);
  const modelMissing = /MODEL_HUB_(?:MODEL_NOT_FOUND|CATALOG_ENTRY_UNAVAILABLE)/u.test(input.code);
  const pathInvalid = /(?:MODEL_PROVIDER_API_PATH_INVALID|MODEL_ENDPOINT_PATH_INVALID)/u.test(
    input.code,
  );
  const textUnsupported = /(?:MODEL_TEXT_UNSUPPORTED|MODEL_CHAT_UNSUPPORTED)/u.test(input.code);
  const capabilitySelectionMissing = input.code === "MODEL_HUB_CAPABILITY_SELECTION_REQUIRED";
  const disclosureChanged = input.code === "MODEL_HUB_PROBE_DISCLOSURE_CHANGED";
  const credentialInvalid =
    input.httpStatus === 401 || /UNAUTHORIZED|CREDENTIAL_INVALID/u.test(input.code);
  const permissionDenied = input.httpStatus === 403 || input.code.includes("FORBIDDEN");
  const workspaceMissing = input.code.includes("WORKSPACE_REQUIRED");
  const catalogUnavailable =
    /(?:MODEL_HUB_CATALOG_REFRESH_FAILED|MODEL_HUB_CATALOG_ENDPOINT_UNAVAILABLE|QUICK_MODEL_CATALOG_EMPTY)/u.test(
      input.code,
    );
  const providerTimedOut = /(?:MODEL_TIMEOUT|PROVIDER_TIMEOUT)/u.test(input.code);
  const networkFailed = /(?:MODEL_NETWORK|NETWORK_ERROR|DNS|TLS|TRANSPORT)/u.test(input.code);
  const rateLimited = input.httpStatus === 429;
  const providerUnavailable = input.httpStatus !== null && input.httpStatus >= 500;
  const responseInvalid =
    input.failureStage === "stream_parse" || input.failureStage === "response_normalization";
  const transportFailed = input.failureStage === "transport";

  let reason: string;
  let recovery: string;
  if (input.phase === "result") {
    reason = "请求已经发送，但在取得明确结果前连接中断，因此本次结果仍需核对。";
    recovery = "请先核对服务商记录和模型中心的本次记录；系统不会自动重发；连接和模型目录会保留。";
  } else if (disclosureChanged) {
    reason = "连接、接入地址、凭据、模型或发送范围已经变化。本次没有发送请求。";
    recovery = "请重新查看固定验证说明并再次确认。";
  } else if (capabilitySelectionMissing) {
    reason = "尚未明确选择要检查文字生成还是语义向量能力，因此无法准备固定验证。";
    recovery = "请先选择一种能力，重新查看发送说明后再确认；本次没有发送请求。";
  } else if (workspaceMissing) {
    reason = "当前地域必须填写服务工作区编号，现有连接资料还不完整。";
    recovery = "请填写正确的服务工作区编号并保存，再由你明确重新检查；本次没有发送请求。";
  } else if (pathInvalid) {
    reason = "接口路径格式无效，因此没有组成可安全发送的请求地址。";
    recovery = "请修正接口路径并保存，重新查看发送说明后再确认；本次没有发送请求。";
  } else if (modelMissing) {
    reason = "当前保存的模型已不在可用模型目录中。";
    recovery = "请重新读取模型列表并选择实际可用模型，再由你明确重试。";
  } else if (textUnsupported) {
    reason = "所选模型没有通过文字生成检查；它可能只支持语义向量或其他任务。";
    recovery = "请改选文字生成模型，或把检查类型改为该模型真实支持的能力后再确认。";
  } else if (credentialInvalid) {
    reason = "服务商确认已保存凭据无效或已失效。";
    recovery = "请明确更换凭据并核对账号后，再由你重新检查。";
  } else if (permissionDenied) {
    reason = "服务商确认当前账号没有完成这项检查所需的权限。";
    recovery = "请核对账号权限和模型授权；如需更换凭据，请使用明确的更换动作。";
  } else if (catalogUnavailable) {
    reason = "模型目录端点没有返回可用目录；这不代表文字生成或语义向量接口已经失败。";
    recovery = "请重新读取模型列表；若服务商不提供目录，可在专家设置中手动填写真实模型标识。";
  } else if (providerTimedOut) {
    reason = "服务商未在约定等待时间内返回明确结果。";
    recovery = "请先核对服务商记录；系统不会自动重发，之后再由你决定是否重试。";
  } else if (networkFailed) {
    reason = "网络连接没有到达服务商或在取得响应前中断，本次能力检查没有成功。";
    recovery = "请检查网络和接入地址后再由你明确重试；系统不会自动重发。";
  } else if (input.phase === "preparation") {
    reason = "本机在发送前未能准备好连接、模型或验证资料。";
    recovery = "请重新读取当前连接，核对模型和接入设置后再次确认；本次没有发送请求。";
  } else if (ambiguousNotFound) {
    reason = "服务商没有找到本次请求对应的模型或接口路径；现有证据不足以判断是哪一项不匹配。";
    recovery = "请同时核对模型标识和接口路径，保存后再由你明确重试；系统不会自动重发。";
  } else if (rateLimited) {
    reason = "服务商当前限制了请求频率或可用额度，因此没有完成本次检查。";
    recovery = "请先核对服务商用量和限制，稍后再由你明确重试。";
  } else if (providerUnavailable) {
    reason = "服务商暂时未能完成本次能力检查。";
    recovery = "请核对服务商状态，稍后再由你明确重试；系统不会自动重发。";
  } else if (transportFailed) {
    reason = "连接在取得服务商明确结果前中断，本次能力检查没有成功。";
    recovery = "请检查接入地址和网络状态后再由你明确重试；系统不会自动重发。";
  } else if (responseInvalid) {
    reason = "服务商已经返回内容，但返回格式或可见结果没有通过本次能力检查。";
    recovery = "请核对所选模型是否支持这项能力及当前接口协议，再由你明确重试。";
  } else {
    reason = "服务商没有完成本次能力检查。";
    recovery = "请核对模型、接入设置和服务商状态后再由你明确重试；系统不会自动重发。";
  }

  return Object.freeze({
    stageLabel: capabilityFailureStageLabel(input.phase, input.failureStage),
    reason,
    recovery,
    diagnosticCode: input.code,
    httpStatus: input.httpStatus,
  });
}

function capabilityFailureStageLabel(
  phase: ModelHubCapabilityFailurePhase,
  stage: ModelFailureStage | null,
): string {
  if (phase === "result") return "结果核对";
  if (phase === "preparation" || stage === "request_preparation") return "发送前准备";
  const labels: Partial<Record<ModelFailureStage, string>> = {
    dispatch: "发送确认",
    transport: "连接传输",
    http_response: "服务商响应",
    stream_parse: "流式读取",
    response_normalization: "结果检查",
    capability_commit: "本地保存能力证据",
    invocation_commit: "本地保存调用记录",
    unknown: "请求处理",
  };
  return stage === null ? "请求处理" : (labels[stage] ?? "请求处理");
}
