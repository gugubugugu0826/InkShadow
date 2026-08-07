import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, InlineAlert } from "@inkshadow/ui";
import { Link, Navigate, useNavigate } from "react-router-dom";

import { useRuntime } from "../runtime-context";
import { normalizeUiError } from "../infrastructure/ui-error";
import { CloudIdentityAuthFlow } from "./cloud-identity-auth-flow";

export function CloudLoginPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState<unknown>(null);
  const sessionRequestRef = useRef(0);
  const cloudIdentity =
    runtime.featureFlags.cloudIdentity && runtime.cloudIdentity?.available === true
      ? runtime.cloudIdentity
      : null;

  const checkSession = useCallback(async (): Promise<void> => {
    if (cloudIdentity === null) {
      return;
    }
    const requestId = sessionRequestRef.current + 1;
    sessionRequestRef.current = requestId;
    setCheckingSession(true);
    setSessionError(null);
    try {
      const status = await cloudIdentity.getStatus();
      if (requestId !== sessionRequestRef.current) {
        return;
      }
      if (status.configured) {
        void navigate("/projects", { replace: true });
        return;
      }
    } catch (reason: unknown) {
      if (requestId === sessionRequestRef.current) {
        setSessionError(reason);
      }
    } finally {
      if (requestId === sessionRequestRef.current) {
        setCheckingSession(false);
      }
    }
  }, [cloudIdentity, navigate]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        void checkSession();
      }
    });
    return () => {
      active = false;
      sessionRequestRef.current += 1;
    };
  }, [checkSession]);

  if (cloudIdentity === null) {
    return <Navigate to="/start" replace />;
  }
  const activeCloudIdentity = cloudIdentity;
  const normalizedSessionError = sessionError === null ? null : normalizeUiError(sessionError);

  if (checkingSession) {
    return (
      <main className="cloud-login-page">
        <p className="desktop-route-loading" role="status">
          正在检查本机云会话
        </p>
      </main>
    );
  }

  return (
    <main className="cloud-login-page">
      <section className="cloud-login-page__intro" aria-labelledby="cloud-login-heading">
        <Link
          className="back-link"
          to="/start"
          aria-disabled={submitting}
          tabIndex={submitting ? -1 : undefined}
          onClick={(event) => {
            if (submitting) {
              event.preventDefault();
            }
          }}
        >
          返回本地开始
        </Link>
        <div className="start-page__brand" aria-label="InkShadow 墨影">
          <span className="start-page__mark" aria-hidden="true">
            墨
          </span>
          <span>InkShadow 墨影</span>
        </div>
        <h1 id="cloud-login-heading">登录云账户</h1>
        <p>登录只用于启用你选择的云服务。本地项目和导出不会因账户、订阅或网络状态而被锁定。</p>
      </section>

      <Card className="cloud-login-page__card">
        <CardContent>
          {normalizedSessionError !== null && (
            <InlineAlert
              tone="error"
              title="无法检查云会话"
              description={`${normalizedSessionError.description} 本地项目仍可正常使用。`}
              action={{ label: "重新检查", onClick: () => void checkSession() }}
            />
          )}
          <CloudIdentityAuthFlow
            service={activeCloudIdentity}
            onAuthenticated={() => void navigate("/projects", { replace: true })}
            onBusyChange={setSubmitting}
          />
          <div className="cloud-login-form__actions">
            <Link
              className="button-link button-link--secondary"
              to="/projects"
              aria-disabled={submitting}
              tabIndex={submitting ? -1 : undefined}
              onClick={(event) => {
                if (submitting) {
                  event.preventDefault();
                }
              }}
            >
              暂不登录，继续本地使用
            </Link>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
