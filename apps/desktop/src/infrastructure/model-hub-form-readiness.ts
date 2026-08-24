export type ModelHubFormAction = "save" | "discover" | "verify";

export interface ModelHubFormActionBlocker {
  readonly code:
    | "ACTION_BUSY"
    | "NATIVE_GATEWAY_UNAVAILABLE"
    | "NETWORK_OFFLINE"
    | "CONNECTION_ID_REQUIRED"
    | "BASE_URL_REQUIRED"
    | "CONNECTION_FIELDS_INVALID"
    | "CREDENTIAL_REQUIRED"
    | "MANUAL_MODEL_ID_REQUIRED"
    | "CONNECTION_NOT_READY"
    | "TEXT_MODEL_REQUIRED";
  readonly fieldId: string | null;
  readonly message: string;
}

export interface ModelHubFormActionState {
  readonly enabled: boolean;
  readonly blockers: readonly ModelHubFormActionBlocker[];
}

export interface ModelHubFormReadiness {
  readonly save: ModelHubFormActionState;
  readonly discover: ModelHubFormActionState;
  readonly verify: ModelHubFormActionState;
  readonly credentialAvailable: boolean;
}

export interface ResolveModelHubFormReadinessInput {
  readonly busy: boolean;
  readonly nativeGatewayAvailable: boolean;
  readonly online: boolean;
  readonly endpointCanRunOffline: boolean;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly connectionFieldsValid: boolean;
  readonly authenticationRequired: boolean;
  readonly storedCredentialConfigured: boolean;
  readonly newlyEnteredCredentialValid: boolean;
  readonly automaticDiscovery: boolean;
  readonly selectedModelId: string;
  readonly endpointModelId: string;
  readonly connectionReady: boolean;
}

export function resolveModelHubFormReadiness(
  input: ResolveModelHubFormReadinessInput,
): ModelHubFormReadiness {
  const credentialAvailable =
    !input.authenticationRequired ||
    input.storedCredentialConfigured ||
    input.newlyEnteredCredentialValid;
  const common: ModelHubFormActionBlocker[] = [];
  if (input.busy) {
    common.push(blocker("ACTION_BUSY", null, "请等待当前操作完成。"));
  }
  if (input.providerId.trim().length === 0) {
    common.push(blocker("CONNECTION_ID_REQUIRED", "provider-connection-id", "请填写连接名称。"));
  }
  if (input.baseUrl.trim().length === 0) {
    common.push(
      blocker("BASE_URL_REQUIRED", "provider-base-url", "请使用供应商默认地址，或填写服务根地址。"),
    );
  }
  if (!input.connectionFieldsValid) {
    common.push(
      blocker(
        "CONNECTION_FIELDS_INVALID",
        "provider-connection-fields",
        "请检查认证名称、等待时间和重试次数。",
      ),
    );
  }
  if (!credentialAvailable) {
    common.push(
      blocker(
        "CREDENTIAL_REQUIRED",
        "provider-api-key",
        "请填写接口密钥，或使用已经安全保存的接口密钥。",
      ),
    );
  }

  const discover = [...common];
  if (!input.nativeGatewayAvailable) {
    discover.push(blocker("NATIVE_GATEWAY_UNAVAILABLE", null, "请改用墨影桌面应用。"));
  }
  if (!input.online && !input.endpointCanRunOffline) {
    discover.push(blocker("NETWORK_OFFLINE", null, "请恢复网络连接。"));
  }
  if (
    !input.automaticDiscovery &&
    input.selectedModelId.trim().length === 0 &&
    input.endpointModelId.trim().length === 0
  ) {
    discover.push(blocker("MANUAL_MODEL_ID_REQUIRED", "provider-model-id", "请填写模型编号。"));
  }

  const verify = [...common];
  if (!input.nativeGatewayAvailable) {
    verify.push(blocker("NATIVE_GATEWAY_UNAVAILABLE", null, "请改用墨影桌面应用。"));
  }
  if (!input.online && !input.endpointCanRunOffline) {
    verify.push(blocker("NETWORK_OFFLINE", null, "请恢复网络连接。"));
  }
  if (!input.connectionReady) {
    verify.push(blocker("CONNECTION_NOT_READY", "model-connection-test", "请先完成连接测试。"));
  }
  if (input.selectedModelId.trim().length === 0) {
    verify.push(
      blocker("TEXT_MODEL_REQUIRED", "provider-model-id", "请选择一个要验证的文本模型。"),
    );
  }

  return Object.freeze({
    save: state(common),
    discover: state(discover),
    verify: state(verify),
    credentialAvailable,
  });
}

function blocker(
  code: ModelHubFormActionBlocker["code"],
  fieldId: string | null,
  message: string,
): ModelHubFormActionBlocker {
  return Object.freeze({ code, fieldId, message });
}

function state(blockers: readonly ModelHubFormActionBlocker[]): ModelHubFormActionState {
  return Object.freeze({ enabled: blockers.length === 0, blockers: Object.freeze(blockers) });
}
