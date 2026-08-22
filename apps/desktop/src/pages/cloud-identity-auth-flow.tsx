import { useState, type SyntheticEvent } from "react";
import { Button, FormField, InlineAlert, Input } from "@inkshadow/ui";

import type { CloudIdentityService } from "../infrastructure/cloud-identity-service";

type CloudIdentityAuthPort = Pick<
  CloudIdentityService,
  "confirmPasswordReset" | "login" | "registerIdentity" | "requestPasswordReset" | "verifyEmail"
>;

type AuthMode =
  | "login"
  | "register"
  | "registration_verification"
  | "password_reset_request"
  | "password_reset_confirmation";

export interface CloudIdentityAuthFlowProps {
  readonly service: CloudIdentityAuthPort;
  readonly onAuthenticated: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
}

const DEFAULT_DEVICE_DISPLAY_NAME = "这台设备";

export function CloudIdentityAuthFlow({
  service,
  onAuthenticated,
  onBusyChange,
}: CloudIdentityAuthFlowProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [deviceDisplayName, setDeviceDisplayName] = useState(DEFAULT_DEVICE_DISPLAY_NAME);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [challengeExpiresAt, setChallengeExpiresAt] = useState<string | null>(null);
  const [oneTimeCode, setOneTimeCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function changeMode(next: AuthMode): void {
    if (submitting) {
      return;
    }
    clearSecrets();
    setErrorMessage(null);
    setNotice(null);
    setChallengeId(null);
    setChallengeExpiresAt(null);
    setMode(next);
  }

  function clearSecrets(): void {
    setPassword("");
    setPasswordConfirmation("");
    setOneTimeCode("");
  }

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setErrorMessage(null);
    setNotice(null);
    setSubmitting(true);
    onBusyChange?.(true);
    try {
      switch (mode) {
        case "login":
          await submitLogin();
          return;
        case "register":
          await submitRegistration();
          return;
        case "registration_verification":
          await submitRegistrationVerification();
          return;
        case "password_reset_request":
          await submitPasswordResetRequest();
          return;
        case "password_reset_confirmation":
          await submitPasswordResetConfirmation();
          return;
      }
    } catch (cause: unknown) {
      setErrorMessage(safeIdentityError(cause));
    } finally {
      setSubmitting(false);
      onBusyChange?.(false);
    }
  }

  async function submitLogin(): Promise<void> {
    const submittedPassword = password;
    setPassword("");
    await service.login({
      email,
      password: submittedPassword,
      deviceDisplayName,
    });
    onAuthenticated();
  }

  async function submitRegistration(): Promise<void> {
    if (password !== passwordConfirmation) {
      setErrorMessage("两次输入的密码不一致，请重新确认。");
      return;
    }
    const submittedPassword = password;
    setPassword("");
    setPasswordConfirmation("");
    const challenge = await service.registerIdentity({
      email,
      password: submittedPassword,
    });
    setChallengeId(challenge.challengeId);
    setChallengeExpiresAt(challenge.expiresAt);
    setMode("registration_verification");
    setNotice("注册请求已接受。请输入发送到该邮箱的 6 位验证码以完成验证。");
  }

  async function submitRegistrationVerification(): Promise<void> {
    if (challengeId === null) {
      throw new Error("Registration challenge is unavailable.");
    }
    const submittedCode = oneTimeCode;
    setOneTimeCode("");
    await service.verifyEmail({
      challengeId,
      code: submittedCode,
      deviceDisplayName,
    });
    onAuthenticated();
  }

  async function submitPasswordResetRequest(): Promise<void> {
    const challenge = await service.requestPasswordReset(email);
    setChallengeId(challenge.challengeId);
    setChallengeExpiresAt(challenge.expiresAt);
    setMode("password_reset_confirmation");
    setNotice("如果该邮箱对应可用账户，验证码会按安全策略发送。请输入验证码并设置新密码。");
  }

  async function submitPasswordResetConfirmation(): Promise<void> {
    if (challengeId === null) {
      throw new Error("Password-reset challenge is unavailable.");
    }
    if (password !== passwordConfirmation) {
      setErrorMessage("两次输入的新密码不一致，请重新确认。");
      return;
    }
    const submittedPassword = password;
    const submittedCode = oneTimeCode;
    clearSecrets();
    await service.confirmPasswordReset({
      challengeId,
      code: submittedCode,
      newPassword: submittedPassword,
    });
    setChallengeId(null);
    setChallengeExpiresAt(null);
    setMode("login");
    setNotice("密码已经更新。旧会话不会恢复，请使用新密码重新登录。");
  }

  const formLabel = authFormLabel(mode);

  return (
    <form
      className="cloud-login-form"
      aria-label={formLabel}
      onSubmit={(event) => void submit(event)}
    >
      {mode === "login" && (
        <>
          <IdentityEmailField value={email} disabled={submitting} onChange={setEmail} />
          <IdentityPasswordField
            label="密码"
            autoComplete="current-password"
            value={password}
            disabled={submitting}
            onChange={setPassword}
          />
          <DeviceNameField
            value={deviceDisplayName}
            disabled={submitting}
            onChange={setDeviceDisplayName}
          />
        </>
      )}

      {mode === "register" && (
        <>
          <IdentityEmailField value={email} disabled={submitting} onChange={setEmail} />
          <IdentityPasswordField
            label="创建密码"
            autoComplete="new-password"
            value={password}
            disabled={submitting}
            onChange={setPassword}
          />
          <IdentityPasswordField
            label="确认密码"
            autoComplete="new-password"
            value={passwordConfirmation}
            disabled={submitting}
            onChange={setPasswordConfirmation}
          />
          <DeviceNameField
            value={deviceDisplayName}
            disabled={submitting}
            onChange={setDeviceDisplayName}
          />
        </>
      )}

      {mode === "registration_verification" && (
        <>
          <ChallengeSummary email={email} expiresAt={challengeExpiresAt} />
          <OneTimeCodeField value={oneTimeCode} disabled={submitting} onChange={setOneTimeCode} />
          <DeviceNameField
            value={deviceDisplayName}
            disabled={submitting}
            onChange={setDeviceDisplayName}
          />
        </>
      )}

      {mode === "password_reset_request" && (
        <IdentityEmailField value={email} disabled={submitting} onChange={setEmail} />
      )}

      {mode === "password_reset_confirmation" && (
        <>
          <ChallengeSummary email={email} expiresAt={challengeExpiresAt} />
          <OneTimeCodeField value={oneTimeCode} disabled={submitting} onChange={setOneTimeCode} />
          <IdentityPasswordField
            label="新密码"
            autoComplete="new-password"
            value={password}
            disabled={submitting}
            onChange={setPassword}
          />
          <IdentityPasswordField
            label="确认新密码"
            autoComplete="new-password"
            value={passwordConfirmation}
            disabled={submitting}
            onChange={setPasswordConfirmation}
          />
        </>
      )}

      {notice !== null && <InlineAlert title="下一步" description={notice} tone="info" />}
      {errorMessage !== null && (
        <InlineAlert title="操作未完成" description={errorMessage} tone="error" />
      )}

      <div className="cloud-login-form__actions">
        <Button
          type="submit"
          loading={submitting}
          loadingLabel={authLoadingLabel(mode)}
          disabled={
            !canSubmit(mode, email, password, passwordConfirmation, oneTimeCode, deviceDisplayName)
          }
        >
          {authSubmitLabel(mode)}
        </Button>

        {mode === "login" && (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={submitting}
              onClick={() => changeMode("register")}
            >
              创建云账户
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={() => changeMode("password_reset_request")}
            >
              忘记密码
            </Button>
          </>
        )}

        {mode !== "login" && (
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => changeMode("login")}
          >
            返回登录
          </Button>
        )}
      </div>
    </form>
  );
}

interface TextFieldProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}

function IdentityEmailField({ value, disabled, onChange }: TextFieldProps) {
  return (
    <FormField label="邮箱" required>
      {(fieldProps) => (
        <Input
          {...fieldProps}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={320}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </FormField>
  );
}

function IdentityPasswordField({
  label,
  autoComplete,
  value,
  disabled,
  onChange,
}: TextFieldProps & {
  readonly label: string;
  readonly autoComplete: "current-password" | "new-password";
}) {
  return (
    <FormField
      label={label}
      hint="至少 12 个字符；仅用于当前安全请求，不写入页面存储、日志或诊断。"
      required
    >
      {(fieldProps) => (
        <Input
          {...fieldProps}
          type="password"
          autoComplete={autoComplete}
          minLength={12}
          maxLength={256}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </FormField>
  );
}

function DeviceNameField({ value, disabled, onChange }: TextFieldProps) {
  return (
    <FormField label="设备名称" hint="用于在可信设备列表中识别这台设备。" required>
      {(fieldProps) => (
        <Input
          {...fieldProps}
          type="text"
          autoComplete="off"
          minLength={1}
          maxLength={80}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </FormField>
  );
}

function OneTimeCodeField({ value, disabled, onChange }: TextFieldProps) {
  return (
    <FormField label="6 位验证码" required>
      {(fieldProps) => (
        <Input
          {...fieldProps}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value.replace(/\D/gu, "").slice(0, 6))}
        />
      )}
    </FormField>
  );
}

function ChallengeSummary({
  email,
  expiresAt,
}: {
  readonly email: string;
  readonly expiresAt: string | null;
}) {
  return (
    <InlineAlert
      title="验证邮箱"
      description={`验证码用于 ${email.trim()}，${
        expiresAt === null
          ? "请在收到后尽快完成。"
          : `有效期至 ${new Date(expiresAt).toLocaleString("zh-CN")}。`
      }`}
      tone="info"
    />
  );
}

function canSubmit(
  mode: AuthMode,
  email: string,
  password: string,
  passwordConfirmation: string,
  oneTimeCode: string,
  deviceDisplayName: string,
): boolean {
  switch (mode) {
    case "login":
      return (
        email.trim().length > 0 && password.length >= 12 && deviceDisplayName.trim().length > 0
      );
    case "register":
      return (
        email.trim().length > 0 &&
        password.length >= 12 &&
        passwordConfirmation.length >= 12 &&
        deviceDisplayName.trim().length > 0
      );
    case "registration_verification":
      return /^\d{6}$/u.test(oneTimeCode) && deviceDisplayName.trim().length > 0;
    case "password_reset_request":
      return email.trim().length > 0;
    case "password_reset_confirmation":
      return (
        /^\d{6}$/u.test(oneTimeCode) && password.length >= 12 && passwordConfirmation.length >= 12
      );
  }
}

function authFormLabel(mode: AuthMode): string {
  const labels: Record<AuthMode, string> = {
    login: "云账户登录",
    register: "创建云账户",
    registration_verification: "验证云账户邮箱",
    password_reset_request: "申请重置云账户密码",
    password_reset_confirmation: "确认重置云账户密码",
  };
  return labels[mode];
}

function authSubmitLabel(mode: AuthMode): string {
  const labels: Record<AuthMode, string> = {
    login: "登录",
    register: "提交注册",
    registration_verification: "验证并登录",
    password_reset_request: "发送重置验证码",
    password_reset_confirmation: "确认新密码",
  };
  return labels[mode];
}

function authLoadingLabel(mode: AuthMode): string {
  const labels: Record<AuthMode, string> = {
    login: "正在安全登录",
    register: "正在提交注册",
    registration_verification: "正在验证邮箱",
    password_reset_request: "正在申请验证码",
    password_reset_confirmation: "正在更新密码",
  };
  return labels[mode];
}

function safeIdentityError(cause: unknown): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : null;

  switch (code) {
    case "AUTH_INVALID_CREDENTIALS":
      return "邮箱或密码不正确，请重新输入。";
    case "AUTH_EMAIL_UNVERIFIED":
      return "该邮箱尚未完成验证，请先完成邮箱验证后再登录。";
    case "AUTH_RATE_LIMITED":
    case "RATE_LIMITED":
      return "请求过于频繁，请等待一段时间后再试。";
    case "AUTH_ACCOUNT_LOCKED":
      return "账户已被临时保护，请稍后再试。";
    case "AUTH_ACCOUNT_FROZEN":
      return "该账户当前不可用，请联系支持人员。";
    case "AUTH_DEVICE_REVOKED":
      return "这台设备的云访问已被撤销。你仍可继续本地使用。";
    case "AUTH_UPGRADE_REQUIRED":
      return "当前版本无法使用云服务，请先更新墨影。";
    case "AUTH_NETWORK_UNAVAILABLE":
    case "CLOUD_NETWORK_UNAVAILABLE":
    case "CLOUD_REQUEST_TIMEOUT":
    case "SERVICE_UNAVAILABLE":
      return "暂时无法连接云服务。你仍可继续本地使用，稍后再试。";
    default:
      return "无法完成云账户操作。请重试，或返回本地工作区继续创作。";
  }
}
