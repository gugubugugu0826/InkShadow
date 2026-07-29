import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PageStateBoundary,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@inkshadow/ui";
import { CloudClientError } from "@inkshadow/cloud-client";
import type {
  CloudProjectAssignment,
  CloudTeam,
  CloudTeamInvitationRole,
  CloudTeamMembership,
} from "@inkshadow/contracts";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useNavigate } from "react-router-dom";

import { CloudSessionCoordinatorError } from "../infrastructure/cloud-session-coordinator";
import type { CloudTeamProjectKeyPublicationState } from "../infrastructure/cloud-team-project-key-envelope-coordinator";
import type { VerifiedTeamProjectKeyEnvelope } from "../infrastructure/project-key-lifecycle";
import {
  activeOwnerCount,
  canChangeMemberRole,
  canCreateInvitation,
  canManageProjectAssignments,
  canRemoveMember,
  canRequestProjectAssignments,
  type PermissionDecision,
  type StudioTeamRole,
} from "../infrastructure/studio-team-permissions";
import { useRuntime } from "../runtime-context";

const MEMBER_ROLES: readonly StudioTeamRole[] = [
  "owner",
  "admin",
  "author",
  "reviewer",
  "read_only",
  "finance_admin",
];
const INVITATION_ROLES: readonly CloudTeamInvitationRole[] = [
  "admin",
  "author",
  "reviewer",
  "read_only",
  "finance_admin",
];

type BootstrapState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "signed_out"; error: VisibleError }>
  | Readonly<{ status: "error"; error: VisibleError }>
  | Readonly<{ status: "ready"; accountId: string; teams: readonly CloudTeam[] }>;

type MembersState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; error: VisibleError }>
  | Readonly<{
      status: "ready";
      memberships: readonly CloudTeamMembership[];
      complete: boolean;
    }>;

type AssignmentState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; projectId: string; error: VisibleError }>
  | Readonly<{
      status: "ready";
      projectId: string;
      assignments: readonly CloudProjectAssignment[];
      complete: boolean;
    }>;

type LocalTeamProjectKeyState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "checking"; projectId: string }>
  | Readonly<{ status: "unavailable"; projectId: string; reason: string }>
  | Readonly<{ status: "available"; projectId: string; keyVersion: number }>
  | Readonly<{
      status: "team_receipt";
      projectId: string;
      keyVersion: number;
      openReady: boolean;
      receiptState: "active" | "superseded" | "authority_unavailable" | "credential_missing";
    }>;

interface VisibleError {
  readonly code: string;
  readonly description: string;
  readonly requestId?: string;
  readonly status?: number;
}

export function StudioTeamPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const service = runtime.cloudTeams ?? null;
  const keyService = runtime.cloudTeamProjectKeys;
  const cloudIdentity = runtime.cloudIdentity;
  const projectKeys = runtime.cloudFoundation?.projectKeys ?? null;
  const projectSecurity = runtime.projectSecurity;
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: "loading" });
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [members, setMembers] = useState<MembersState>({ status: "idle" });
  const [assignments, setAssignments] = useState<AssignmentState>({ status: "idle" });
  const [localTeamProjectKey, setLocalTeamProjectKey] = useState<LocalTeamProjectKeyState>({
    status: "idle",
  });
  const [keyPublication, setKeyPublication] = useState<CloudTeamProjectKeyPublicationState | null>(
    null,
  );
  const [keyPublicationError, setKeyPublicationError] = useState<VisibleError | null>(null);
  const [keyVerification, setKeyVerification] = useState<VerifiedTeamProjectKeyEnvelope | null>(
    null,
  );
  const [keyVerificationError, setKeyVerificationError] = useState<VisibleError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<VisibleError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [inviteeEmail, setInviteeEmail] = useState("");
  const [invitedRole, setInvitedRole] = useState<CloudTeamInvitationRole>("author");
  const [invitationExpiresAt, setInvitationExpiresAt] = useState(defaultInvitationExpiry);
  const [acceptInvitationId, setAcceptInvitationId] = useState("");
  const [acceptExpectedRevision, setAcceptExpectedRevision] = useState("1");
  const [invitationToken, setInvitationToken] = useState("");
  const invitationTokenInput = useRef<HTMLInputElement>(null);
  const keyPublicationAbort = useRef<AbortController | null>(null);
  const keyVerificationAbort = useRef<AbortController | null>(null);
  const [projectId, setProjectId] = useState("");

  const loadWorkspace = useCallback(
    async (signal?: AbortSignal) => {
      if (service === null) {
        return;
      }
      setBootstrap({ status: "loading" });
      try {
        const accountId = await service.getCurrentAccountId(signal);
        const response = await service.listTeams(signal);
        if (isSignalAborted(signal)) {
          return;
        }
        setBootstrap({ status: "ready", accountId, teams: response.teams });
        setSelectedTeamId((current) =>
          response.teams.some((team) => team.teamId === current)
            ? current
            : (response.teams[0]?.teamId ?? null),
        );
      } catch (error: unknown) {
        if (isSignalAborted(signal)) {
          return;
        }
        const visible = normalizeError(error);
        setBootstrap(
          isSignedOutError(error)
            ? { status: "signed_out", error: visible }
            : { status: "error", error: visible },
        );
      }
    },
    [service],
  );

  const loadMembers = useCallback(
    async (teamId: string, signal?: AbortSignal) => {
      if (service === null) {
        return;
      }
      setMembers({ status: "loading" });
      try {
        const response = await service.listTeamMembers(teamId, signal);
        if (signal?.aborted === true) {
          return;
        }
        setMembers({
          status: "ready",
          memberships: response.memberships,
          complete: response.nextCursor === null,
        });
      } catch (error: unknown) {
        if (signal?.aborted !== true) {
          setMembers({ status: "error", error: normalizeError(error) });
        }
      }
    },
    [service],
  );

  const loadLocalTeamProjectKey = useCallback(
    async (nextProjectId: string, signal?: AbortSignal) => {
      setKeyPublication(null);
      setKeyPublicationError(null);
      setKeyVerification(null);
      setKeyVerificationError(null);
      if (keyService === null || cloudIdentity === null || projectKeys === null) {
        setLocalTeamProjectKey({
          status: "unavailable",
          projectId: nextProjectId,
          reason: "当前运行环境未配置团队密钥发放所需的原生云身份与本地密钥存储。",
        });
        return;
      }
      setLocalTeamProjectKey({ status: "checking", projectId: nextProjectId });
      try {
        const status = await cloudIdentity.getStatus();
        if (isSignalAborted(signal)) {
          return;
        }
        if (!status.configured || status.device === null) {
          setLocalTeamProjectKey({
            status: "unavailable",
            projectId: nextProjectId,
            reason: "当前云会话没有可验证的设备身份，不能读取本地项目密钥。",
          });
          return;
        }
        const deviceId = status.device.device.deviceId;
        const loaded = await projectKeys.loadProjectKeyBundle(nextProjectId, deviceId);
        if (isSignalAborted(signal)) {
          return;
        }
        if (!loaded.ok) {
          setLocalTeamProjectKey({
            status: "unavailable",
            projectId: nextProjectId,
            reason: "无法读取本地项目密钥状态；密钥发放保持关闭。",
          });
          return;
        }
        const bundle = loaded.value;
        if (
          bundle?.version.projectId === nextProjectId &&
          bundle.version.state === "active" &&
          bundle.recoveryEnvelope.confirmedAt !== null &&
          bundle.deviceEnvelope.revokedAt === null &&
          bundle.deviceEnvelope.recipientDeviceId === deviceId
        ) {
          setLocalTeamProjectKey({
            status: "available",
            projectId: nextProjectId,
            keyVersion: bundle.version.keyVersion,
          });
          return;
        }
        if (
          selectedTeamId !== null &&
          status.account !== null &&
          status.session !== null &&
          projectSecurity !== null
        ) {
          const received = await projectKeys.loadTeamProjectKeyReceipt({
            teamId: selectedTeamId,
            projectId: nextProjectId,
            accountId: status.account.accountId,
            deviceId,
          });
          if (isSignalAborted(signal)) {
            return;
          }
          if (received.ok && received.value !== null) {
            const receiptStatus = await projectSecurity.inspectTeamManagedProjectKeyReceipt(
              received.value,
              status.session.sessionId,
            );
            if (isSignalAborted(signal)) {
              return;
            }
            setLocalTeamProjectKey({
              status: "team_receipt",
              projectId: nextProjectId,
              keyVersion: receiptStatus.receipt.keyVersion,
              openReady: receiptStatus.openReady,
              receiptState: receiptStatus.receipt.state,
            });
            return;
          }
        }
        if (
          bundle?.version.projectId !== nextProjectId ||
          bundle.version.state !== "active" ||
          bundle.recoveryEnvelope.confirmedAt === null ||
          bundle.deviceEnvelope.revokedAt !== null ||
          bundle.deviceEnvelope.recipientDeviceId !== deviceId
        ) {
          setLocalTeamProjectKey({
            status: "unavailable",
            projectId: nextProjectId,
            reason: "当前设备没有该项目的 active 本地密钥 bundle。",
          });
          return;
        }
      } catch {
        if (signal?.aborted !== true) {
          setLocalTeamProjectKey({
            status: "unavailable",
            projectId: nextProjectId,
            reason: "本地密钥上下文验证失败；密钥发放保持关闭。",
          });
        }
      }
    },
    [cloudIdentity, keyService, projectKeys, projectSecurity, selectedTeamId],
  );

  const loadAssignments = useCallback(
    async (teamId: string, nextProjectId: string, signal?: AbortSignal) => {
      if (service === null) {
        return;
      }
      const normalizedProjectId = nextProjectId.trim();
      if (normalizedProjectId.length === 0) {
        setLocalTeamProjectKey({ status: "idle" });
        setKeyPublication(null);
        setKeyPublicationError(null);
        setKeyVerification(null);
        setKeyVerificationError(null);
        setAssignments({
          status: "error",
          projectId: normalizedProjectId,
          error: {
            code: "PROJECT_ID_REQUIRED",
            description: "请输入项目 ID 后再读取分配。",
          },
        });
        return;
      }
      setLocalTeamProjectKey({ status: "idle" });
      setKeyPublication(null);
      setKeyPublicationError(null);
      setKeyVerification(null);
      setKeyVerificationError(null);
      setAssignments({ status: "loading" });
      try {
        const response = await service.listProjectAssignments(teamId, normalizedProjectId, signal);
        if (signal?.aborted === true) {
          return;
        }
        setAssignments({
          status: "ready",
          projectId: normalizedProjectId,
          assignments: response.assignments,
          complete: response.nextCursor === null,
        });
        await loadLocalTeamProjectKey(normalizedProjectId, signal);
      } catch (error: unknown) {
        if (signal?.aborted !== true) {
          setLocalTeamProjectKey({ status: "idle" });
          setAssignments({
            status: "error",
            projectId: normalizedProjectId,
            error: normalizeError(error),
          });
        }
      }
    },
    [loadLocalTeamProjectKey, service],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      void loadWorkspace(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [loadWorkspace]);

  useEffect(() => {
    if (selectedTeamId === null) {
      return;
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      void loadMembers(selectedTeamId, controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [loadMembers, selectedTeamId]);

  useEffect(
    () => () => {
      keyPublicationAbort.current?.abort();
      keyVerificationAbort.current?.abort();
    },
    [],
  );

  const accountId = bootstrap.status === "ready" ? bootstrap.accountId : null;
  const memberships: readonly CloudTeamMembership[] =
    members.status === "ready" ? members.memberships : [];
  const actor =
    accountId === null
      ? null
      : (memberships.find(
          (membership) => membership.accountId === accountId && membership.state === "active",
        ) ?? null);
  const ownerCount = activeOwnerCount(memberships);
  const inviteManagerDecision =
    members.status === "ready" && members.complete
      ? canCreateInvitation(actor, "author")
      : denied("成员列表尚未完整验证，邀请操作已关闭。");
  const inviteDecision =
    members.status === "ready" && members.complete
      ? canCreateInvitation(actor, invitedRole)
      : denied("成员列表尚未完整验证，邀请操作已关闭。");
  const assignmentReadDecision =
    members.status === "ready" && members.complete
      ? canRequestProjectAssignments(actor)
      : denied("成员列表尚未完整验证，项目分配读取已关闭。");
  const assignmentManageDecision =
    assignments.status === "ready"
      ? canManageProjectAssignments({
          actor,
          assignments: assignments.assignments,
          assignmentsComplete: assignments.complete,
        })
      : denied("请先完整读取项目 assignment，再执行团队密钥发放。");

  const envelopeVerificationDecision: PermissionDecision =
    keyService === null
      ? denied("当前运行环境没有可用的原生项目密钥验收边界。")
      : assignments.status !== "ready" || !assignments.complete
        ? denied("请先完整读取项目 assignment，再验证当前设备的团队密钥信封。")
        : actor === null ||
            !assignments.assignments.some(
              (assignment) =>
                assignment.membershipId === actor.membershipId && assignment.state === "active",
            )
          ? denied("当前成员没有该项目的有效 assignment，不能读取当前设备密钥信封。")
          : { allowed: true, reason: "" };
  const studioReviewDecision: PermissionDecision =
    runtime.studioReview === null
      ? denied("当前运行环境没有完整的原生团队加密审阅能力。")
      : assignments.status !== "ready" || !assignments.complete
        ? denied("请先完整读取项目 assignment，再打开团队审阅。")
        : actor === null ||
            !assignments.assignments.some(
              (assignment) =>
                assignment.membershipId === actor.membershipId && assignment.state === "active",
            )
          ? denied("当前成员没有该项目的有效 assignment，不能打开团队审阅。")
          : { allowed: true, reason: "" };
  const teamTemplateDecision: PermissionDecision =
    runtime.studioTeamTemplates === null
      ? denied("当前运行环境没有完整的项目密钥、云会话与本地模板事务能力。")
      : assignments.status !== "ready" || !assignments.complete
        ? denied("请先完整读取项目 assignment，再打开加密团队模板。")
        : actor === null ||
            actor.role === "finance_admin" ||
            !assignments.assignments.some(
              (assignment) =>
                assignment.membershipId === actor.membershipId && assignment.state === "active",
            )
          ? denied("当前成员没有该项目的模板读取权限或有效 assignment。")
          : { allowed: true, reason: "" };

  if (service === null) {
    return (
      <main className="studio-team-page">
        <PageIntro />
        <EmptyState
          kind="feature_limited"
          title="团队云服务未配置"
          description="当前运行环境没有安全的原生云会话边界。团队操作不会在本地伪造成功，也不会要求前端保存 access token。"
          primaryAction={{
            label: "返回项目",
            onClick: () => void navigate("/projects"),
          }}
        />
      </main>
    );
  }

  if (bootstrap.status === "loading") {
    return (
      <main className="studio-team-page">
        <PageIntro />
        <PageStateBoundary state="loading" loadingLabel="正在读取团队工作区">
          <span />
        </PageStateBoundary>
      </main>
    );
  }

  if (bootstrap.status === "signed_out") {
    return (
      <main className="studio-team-page">
        <PageIntro />
        <EmptyState
          kind="forbidden"
          title="需要登录云账户"
          description={bootstrap.error.description}
          primaryAction={{
            label: "前往登录",
            onClick: () => void navigate("/auth/login"),
          }}
          secondaryAction={{
            label: "重试",
            onClick: () => void loadWorkspace(),
          }}
        />
      </main>
    );
  }

  if (bootstrap.status === "error") {
    return (
      <main className="studio-team-page">
        <PageIntro />
        <VisibleErrorState
          title="无法读取团队列表"
          error={bootstrap.error}
          retry={() => void loadWorkspace()}
        />
      </main>
    );
  }

  const selectedTeam = bootstrap.teams.find((team) => team.teamId === selectedTeamId) ?? null;

  async function createTeam(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy !== null || service === null) {
      return;
    }
    const displayName = teamName.trim();
    if (displayName.length === 0) {
      setOperationError({
        code: "TEAM_NAME_REQUIRED",
        description: "请输入团队名称。",
      });
      return;
    }
    setBusy("create-team");
    setOperationError(null);
    setNotice(null);
    try {
      const response = await service.createTeam(displayName);
      setBootstrap((current) =>
        current.status !== "ready"
          ? current
          : {
              ...current,
              teams: [
                response.team,
                ...current.teams.filter((team) => team.teamId !== response.team.teamId),
              ],
            },
      );
      setAssignments({ status: "idle" });
      setLocalTeamProjectKey({ status: "idle" });
      setKeyPublication(null);
      setKeyPublicationError(null);
      setKeyVerification(null);
      setKeyVerificationError(null);
      setSelectedTeamId(response.team.teamId);
      setTeamName("");
      setNotice("团队已创建。");
    } catch (error: unknown) {
      setOperationError(normalizeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function acceptInvitation(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy !== null || service === null) {
      return;
    }
    const invitationId = acceptInvitationId.trim();
    const expectedRevision = Number(acceptExpectedRevision);
    const submittedToken = invitationToken;

    // Clear the capability before the network request settles. It is never
    // copied to URLs, persistent storage, logs, notices, or rendered errors.
    setInvitationToken("");
    if (invitationTokenInput.current !== null) {
      invitationTokenInput.current.value = "";
    }

    if (
      invitationId.length === 0 ||
      submittedToken.length === 0 ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1
    ) {
      setOperationError({
        code: "INVITATION_INPUT_INVALID",
        description: "请输入邀请 ID、正整数修订号和一次性邀请 token。",
      });
      return;
    }
    setBusy("accept-invitation");
    setOperationError(null);
    setNotice(null);
    try {
      const acceptance = await service.acceptInvitation(
        invitationId,
        expectedRevision,
        submittedToken,
      );
      const response = await service.listTeams();
      setBootstrap((current) =>
        current.status === "ready" ? { ...current, teams: response.teams } : current,
      );
      setAcceptInvitationId("");
      setAcceptExpectedRevision("1");
      setAssignments({ status: "idle" });
      setLocalTeamProjectKey({ status: "idle" });
      setKeyPublication(null);
      setKeyPublicationError(null);
      setKeyVerification(null);
      setKeyVerificationError(null);
      if (response.teams.length === 0) {
        setMembers({ status: "idle" });
      }
      setSelectedTeamId(
        response.teams.some((team) => team.teamId === acceptance.membership.teamId)
          ? acceptance.membership.teamId
          : (response.teams[0]?.teamId ?? null),
      );
      setNotice("邀请已接受；一次性 token 已从输入框清除。");
    } catch (error: unknown) {
      setOperationError(normalizeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function createInvitation(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy !== null || service === null || selectedTeamId === null || !inviteDecision.allowed) {
      return;
    }
    const expiresAtTimestamp = Date.parse(invitationExpiresAt);
    if (!Number.isFinite(expiresAtTimestamp) || expiresAtTimestamp <= Date.now()) {
      setOperationError({
        code: "INVITATION_EXPIRY_INVALID",
        description: "邀请到期时间必须是未来的有效时间。",
      });
      return;
    }
    const expiresAt = new Date(expiresAtTimestamp).toISOString();
    setBusy("create-invitation");
    setOperationError(null);
    setNotice(null);
    try {
      const response = await service.createInvitation(selectedTeamId, {
        inviteeEmail: inviteeEmail.trim(),
        role: invitedRole,
        expiresAt,
      });
      setInviteeEmail("");
      setNotice(
        `邀请已创建（ID：${response.invitation.invitationId}）。邀请 token 由服务端带外发送，本页面不会保存或展示。`,
      );
    } catch (error: unknown) {
      setOperationError(normalizeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function changeRole(target: CloudTeamMembership, nextRole: StudioTeamRole): Promise<void> {
    if (busy !== null || service === null || selectedTeamId === null) {
      return;
    }
    const decision = memberRoleDecision(target, nextRole, actor, ownerCount, members);
    if (!decision.allowed) {
      setOperationError({ code: "ACTION_FORBIDDEN", description: decision.reason });
      return;
    }
    setBusy(`role:${target.membershipId}`);
    setOperationError(null);
    setNotice(null);
    try {
      await service.changeMemberRole(
        selectedTeamId,
        target.membershipId,
        target.revision,
        nextRole,
      );
      await loadMembers(selectedTeamId);
      setNotice("成员角色已更新。");
    } catch (error: unknown) {
      setOperationError(normalizeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(target: CloudTeamMembership): Promise<void> {
    if (busy !== null || service === null || selectedTeamId === null) {
      return;
    }
    const decision =
      members.status === "ready" && members.complete
        ? canRemoveMember({ actor, target, activeOwnerCount: ownerCount })
        : denied("成员列表尚未完整验证，移除操作已关闭。");
    if (!decision.allowed) {
      setOperationError({ code: "ACTION_FORBIDDEN", description: decision.reason });
      return;
    }
    if (!window.confirm(`确认移除成员 ${target.accountId}？此操作会使其团队身份失效。`)) {
      return;
    }
    setBusy(`remove:${target.membershipId}`);
    setOperationError(null);
    setNotice(null);
    try {
      await service.revokeMembership(selectedTeamId, target.membershipId, target.revision);
      await loadMembers(selectedTeamId);
      setNotice("成员已移除。");
    } catch (error: unknown) {
      setOperationError(normalizeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function setAssignment(
    target: CloudTeamMembership,
    existing: CloudProjectAssignment | undefined,
  ): Promise<void> {
    if (
      busy !== null ||
      service === null ||
      selectedTeamId === null ||
      assignments.status !== "ready"
    ) {
      return;
    }
    const decision = canManageProjectAssignments({
      actor,
      assignments: assignments.assignments,
      assignmentsComplete: assignments.complete,
    });
    if (!decision.allowed) {
      setOperationError({ code: "ACTION_FORBIDDEN", description: decision.reason });
      return;
    }
    const desiredState = existing?.state === "active" ? "revoked" : "active";
    setBusy(`assignment:${target.membershipId}`);
    setOperationError(null);
    setNotice(null);
    try {
      await service.setProjectAssignment(
        selectedTeamId,
        assignments.projectId,
        target.membershipId,
        existing?.revision ?? null,
        desiredState,
      );
      await loadAssignments(selectedTeamId, assignments.projectId);
      setNotice(desiredState === "active" ? "项目分配已启用。" : "项目分配已撤销。");
    } catch (error: unknown) {
      setOperationError(normalizeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function publishTeamProjectKeyEnvelopes(): Promise<void> {
    if (
      busy !== null ||
      keyService === null ||
      selectedTeamId === null ||
      assignments.status !== "ready" ||
      localTeamProjectKey.status !== "available" ||
      localTeamProjectKey.projectId !== assignments.projectId ||
      !assignmentManageDecision.allowed
    ) {
      return;
    }
    const authority = {
      teamId: selectedTeamId,
      projectId: assignments.projectId,
      keyVersion: localTeamProjectKey.keyVersion,
    };
    const controller = new AbortController();
    keyPublicationAbort.current?.abort();
    keyPublicationAbort.current = controller;
    setBusy("team-key-publication");
    setOperationError(null);
    setNotice(null);
    setKeyPublication(null);
    setKeyPublicationError(null);
    const pollState = () => {
      const observed = keyService.getPublicationState(
        authority.teamId,
        authority.projectId,
        authority.keyVersion,
      );
      if (observed !== null && !controller.signal.aborted) {
        setKeyPublication(observed);
      }
    };
    const pollId = window.setInterval(pollState, 100);
    try {
      const result = await keyService.publishAllEligibleRecipients(
        authority.teamId,
        authority.projectId,
        authority.keyVersion,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        return;
      }
      setKeyPublication(result);
      if (result.phase === "published" && result.publishedCount === result.recipientCount) {
        setNotice(`团队项目密钥已发放至 ${String(result.publishedCount)} 个合资格设备。`);
      } else {
        setKeyPublicationError({
          code: "TEAM_KEY_PUBLICATION_INCOMPLETE",
          description: "密钥发放尚未全部完成；请根据当前状态安全重试或处理冲突。",
        });
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      pollState();
      const visible = normalizeError(error);
      setKeyPublicationError(visible);
      setOperationError(visible);
    } finally {
      window.clearInterval(pollId);
      if (keyPublicationAbort.current === controller) {
        keyPublicationAbort.current = null;
      }
      if (!controller.signal.aborted) {
        setBusy(null);
      }
    }
  }

  async function verifyCurrentDeviceTeamProjectKeyEnvelope(): Promise<void> {
    if (
      busy !== null ||
      keyService === null ||
      selectedTeamId === null ||
      assignments.status !== "ready" ||
      !envelopeVerificationDecision.allowed
    ) {
      return;
    }
    const controller = new AbortController();
    keyVerificationAbort.current?.abort();
    keyVerificationAbort.current = controller;
    setBusy("team-key-verification");
    setOperationError(null);
    setNotice(null);
    setKeyVerification(null);
    setKeyVerificationError(null);
    try {
      const result = await keyService.verifyCurrentDeviceEnvelope(
        selectedTeamId,
        assignments.projectId,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        return;
      }
      setKeyVerification(result);
      setLocalTeamProjectKey({
        status: "team_receipt",
        projectId: result.receipt.projectId,
        keyVersion: result.receipt.keyVersion,
        openReady: true,
        receiptState: result.receipt.state,
      });
      setNotice("当前设备的团队项目密钥信封已在原生凭据边界内完成验真。");
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      const visible = normalizeError(error);
      setKeyVerificationError(visible);
      setOperationError(visible);
    } finally {
      if (keyVerificationAbort.current === controller) {
        keyVerificationAbort.current = null;
      }
      if (!controller.signal.aborted) {
        setBusy(null);
      }
    }
  }

  return (
    <main className="studio-team-page">
      <PageIntro />

      {operationError !== null && (
        <InlineAlert
          tone="error"
          title={visibleErrorTitle(operationError)}
          description={operationError.description}
          onDismiss={() => setOperationError(null)}
          dismissLabel="关闭错误"
        />
      )}
      {notice !== null && (
        <InlineAlert
          tone="info"
          title="团队工作区已更新"
          description={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel="关闭通知"
        />
      )}

      <div className="studio-team-page__grid">
        <Card>
          <CardHeader>
            <CardTitle>我的团队</CardTitle>
            <CardDescription>创建团队或选择一个团队管理成员。</CardDescription>
          </CardHeader>
          <CardContent className="studio-team-page__stack">
            <form className="studio-team-page__inline-form" onSubmit={createTeam}>
              <FormField label="团队名称" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={teamName}
                    maxLength={120}
                    disabled={busy !== null}
                    onChange={(event) => setTeamName(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <Button
                type="submit"
                loading={busy === "create-team"}
                disabled={busy !== null || teamName.trim().length === 0}
              >
                创建团队
              </Button>
            </form>

            {bootstrap.teams.length === 0 ? (
              <EmptyState
                title="还没有团队"
                description="创建团队，或使用下方的一次性邀请凭据加入已有团队。"
              />
            ) : (
              <div className="studio-team-page__team-list" aria-label="团队列表">
                {bootstrap.teams.map((team) => (
                  <button
                    key={team.teamId}
                    type="button"
                    className="studio-team-page__team-option"
                    data-selected={team.teamId === selectedTeamId || undefined}
                    aria-pressed={team.teamId === selectedTeamId}
                    disabled={busy !== null}
                    onClick={() => {
                      setAssignments({ status: "idle" });
                      setLocalTeamProjectKey({ status: "idle" });
                      setKeyPublication(null);
                      setKeyPublicationError(null);
                      setKeyVerification(null);
                      setKeyVerificationError(null);
                      setSelectedTeamId(team.teamId);
                    }}
                  >
                    <span>{team.displayName}</span>
                    <Badge tone={team.state === "active" ? "success" : "warning"}>
                      {team.state === "active" ? "有效" : "已归档"}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
            {selectedTeamId !== null && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void navigate(`/teams/${selectedTeamId}/usage`)}
              >
                管理 AI 额度与用量
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>手动接受邀请</CardTitle>
            <CardDescription>
              邀请 token 只存在于此输入框的组件内存中，提交开始后立即清空。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="studio-team-page__form" onSubmit={acceptInvitation}>
              <FormField label="邀请 ID" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={acceptInvitationId}
                    autoComplete="off"
                    disabled={busy !== null}
                    onChange={(event) => setAcceptInvitationId(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField label="期望修订号" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="number"
                    min={1}
                    step={1}
                    value={acceptExpectedRevision}
                    disabled={busy !== null}
                    onChange={(event) => setAcceptExpectedRevision(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField
                label="一次性邀请 token"
                hint="不会写入 URL、查询参数、本地存储、日志或错误提示。"
                required
              >
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    ref={invitationTokenInput}
                    type="password"
                    value={invitationToken}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy !== null}
                    onChange={(event) => setInvitationToken(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <Button
                type="submit"
                loading={busy === "accept-invitation"}
                disabled={
                  busy !== null ||
                  acceptInvitationId.trim().length === 0 ||
                  invitationToken.length === 0
                }
              >
                接受邀请
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {selectedTeam !== null && (
        <>
          <Card>
            <CardHeader>
              <div className="studio-team-page__heading-row">
                <div>
                  <CardTitle>{selectedTeam.displayName} · 成员</CardTitle>
                  <CardDescription>
                    服务端角色和修订号共同约束每项变更；无法验证权限时操作会关闭。
                  </CardDescription>
                </div>
                {actor !== null && <Badge tone="info">我的角色：{roleLabel(actor.role)}</Badge>}
              </div>
            </CardHeader>
            <CardContent className="studio-team-page__stack">
              <MembersPanel
                state={members}
                actor={actor}
                ownerCount={ownerCount}
                busy={busy}
                reload={() => void loadMembers(selectedTeam.teamId)}
                changeRole={(target, role) => void changeRole(target, role)}
                remove={(target) => void removeMember(target)}
              />

              <form
                className="studio-team-page__form studio-team-page__invite"
                onSubmit={createInvitation}
              >
                <h3>创建邀请</h3>
                <div className="studio-team-page__form-grid">
                  <FormField label="受邀邮箱" required>
                    {(fieldProps) => (
                      <Input
                        {...fieldProps}
                        type="email"
                        value={inviteeEmail}
                        autoComplete="off"
                        disabled={busy !== null || !inviteManagerDecision.allowed}
                        onChange={(event) => setInviteeEmail(event.currentTarget.value)}
                      />
                    )}
                  </FormField>
                  <FormField label="角色" required>
                    {(fieldProps) => (
                      <Select
                        {...fieldProps}
                        value={invitedRole}
                        options={INVITATION_ROLES.map((role) => ({
                          value: role,
                          label: roleLabel(role),
                          disabled: !canCreateInvitation(actor, role).allowed,
                        }))}
                        disabled={busy !== null || !inviteManagerDecision.allowed}
                        onChange={(event) =>
                          setInvitedRole(event.currentTarget.value as CloudTeamInvitationRole)
                        }
                      />
                    )}
                  </FormField>
                  <FormField label="到期时间" required>
                    {(fieldProps) => (
                      <Input
                        {...fieldProps}
                        type="datetime-local"
                        value={invitationExpiresAt}
                        disabled={busy !== null || !inviteManagerDecision.allowed}
                        onChange={(event) => setInvitationExpiresAt(event.currentTarget.value)}
                      />
                    )}
                  </FormField>
                </div>
                {!inviteDecision.allowed && (
                  <p className="studio-team-page__permission-reason" role="note">
                    {inviteDecision.reason}
                  </p>
                )}
                <Button
                  type="submit"
                  loading={busy === "create-invitation"}
                  disabled={
                    busy !== null || !inviteDecision.allowed || inviteeEmail.trim().length === 0
                  }
                  title={inviteDecision.allowed ? undefined : inviteDecision.reason}
                >
                  创建邀请
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>项目 assignment</CardTitle>
              <CardDescription>
                查看和设置团队成员的项目业务授权。需要当前角色为所有者或管理员，且当前成员已分配到该项目。
              </CardDescription>
            </CardHeader>
            <CardContent className="studio-team-page__stack">
              <form
                className="studio-team-page__inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void loadAssignments(selectedTeam.teamId, projectId);
                }}
              >
                <FormField label="项目 ID" required>
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      value={projectId}
                      autoComplete="off"
                      disabled={
                        busy !== null ||
                        assignments.status === "loading" ||
                        !assignmentReadDecision.allowed
                      }
                      onChange={(event) => {
                        setProjectId(event.currentTarget.value);
                        setAssignments({ status: "idle" });
                        setLocalTeamProjectKey({ status: "idle" });
                        setKeyPublication(null);
                        setKeyPublicationError(null);
                        setKeyVerification(null);
                        setKeyVerificationError(null);
                      }}
                    />
                  )}
                </FormField>
                <Button
                  type="submit"
                  loading={assignments.status === "loading"}
                  disabled={
                    busy !== null ||
                    assignments.status === "loading" ||
                    projectId.trim().length === 0 ||
                    !assignmentReadDecision.allowed
                  }
                  title={assignmentReadDecision.allowed ? undefined : assignmentReadDecision.reason}
                >
                  读取分配
                </Button>
              </form>
              {!assignmentReadDecision.allowed && (
                <p className="studio-team-page__permission-reason" role="note">
                  {assignmentReadDecision.reason}
                </p>
              )}

              <AssignmentPanel
                state={assignments}
                memberships={memberships}
                actor={actor}
                busy={busy}
                reload={() => void loadAssignments(selectedTeam.teamId, projectId)}
                setAssignment={(target, existing) => void setAssignment(target, existing)}
              />

              {assignments.status === "ready" && (
                <section className="studio-team-page__assignment-actions" aria-label="团队加密审阅">
                  <div>
                    <strong>端到端加密审阅</strong>
                    <p className="studio-team-page__permission-reason">
                      从已确认的密文投影发起审阅；正文、意见和建议不会以明文写入云端。
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void navigate(
                        `/teams/${selectedTeam.teamId}/usage?projectId=${encodeURIComponent(assignments.projectId)}`,
                      )
                    }
                  >
                    查看项目 AI 额度
                  </Button>
                  <Button
                    type="button"
                    disabled={!studioReviewDecision.allowed}
                    title={studioReviewDecision.allowed ? undefined : studioReviewDecision.reason}
                    onClick={() => {
                      if (studioReviewDecision.allowed) {
                        void navigate(
                          `/teams/${selectedTeam.teamId}/projects/${assignments.projectId}/reviews`,
                        );
                      }
                    }}
                  >
                    打开加密审阅
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!teamTemplateDecision.allowed}
                    title={teamTemplateDecision.allowed ? undefined : teamTemplateDecision.reason}
                    onClick={() => {
                      if (teamTemplateDecision.allowed) {
                        void navigate(
                          `/teams/${selectedTeam.teamId}/projects/${assignments.projectId}/templates`,
                        );
                      }
                    }}
                  >
                    打开加密团队模板
                  </Button>
                  {!studioReviewDecision.allowed && (
                    <p className="studio-team-page__permission-reason" role="note">
                      {studioReviewDecision.reason}
                    </p>
                  )}
                  {!teamTemplateDecision.allowed && (
                    <p className="studio-team-page__permission-reason" role="note">
                      {teamTemplateDecision.reason}
                    </p>
                  )}
                </section>
              )}

              <TeamProjectKeyEnvelopePanel
                localKey={localTeamProjectKey}
                publication={keyPublication}
                error={keyPublicationError}
                running={busy === "team-key-publication"}
                decision={assignmentManageDecision}
                onPublish={() => void publishTeamProjectKeyEnvelopes()}
                verification={keyVerification}
                verificationError={keyVerificationError}
                verificationRunning={busy === "team-key-verification"}
                verificationDecision={envelopeVerificationDecision}
                onVerify={() => void verifyCurrentDeviceTeamProjectKeyEnvelope()}
              />

              <InlineAlert
                tone="warning"
                title="assignment 不等于端到端密钥授权"
                description={
                  keyService === null || cloudIdentity === null || projectKeys === null
                    ? "当前仅能管理服务端业务访问范围，未配置团队项目密钥 envelope 服务。assignment 不会自动产生端到端密钥授权。"
                    : "assignment 只定义服务端业务访问范围。密钥 envelope 必须通过上方独立操作，按服务端返回的精确合资格设备快照发放。"
                }
              />
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}

function PageIntro() {
  return (
    <header className="studio-team-page__intro">
      <div>
        <p className="studio-team-page__eyebrow">Studio Cloud</p>
        <h1>团队与权限</h1>
        <p>管理团队成员、邀请与项目范围；所有写操作都使用真实云接口和服务端修订检查。</p>
      </div>
    </header>
  );
}

function MembersPanel(props: {
  readonly state: MembersState;
  readonly actor: CloudTeamMembership | null;
  readonly ownerCount: number;
  readonly busy: string | null;
  readonly reload: () => void;
  readonly changeRole: (target: CloudTeamMembership, role: StudioTeamRole) => void;
  readonly remove: (target: CloudTeamMembership) => void;
}) {
  if (props.state.status === "idle" || props.state.status === "loading") {
    return (
      <PageStateBoundary state="loading" loadingLabel="正在读取团队成员">
        <span />
      </PageStateBoundary>
    );
  }
  if (props.state.status === "error") {
    return (
      <VisibleErrorState title="无法读取成员列表" error={props.state.error} retry={props.reload} />
    );
  }
  if (props.state.memberships.length === 0) {
    return (
      <EmptyState
        title="没有可显示的成员"
        description="服务端没有返回该团队的成员；管理操作保持关闭。"
        primaryAction={{ label: "重试", onClick: props.reload }}
      />
    );
  }
  const readyMembers = props.state;

  return (
    <>
      {!readyMembers.complete && (
        <InlineAlert
          tone="warning"
          title="成员列表尚未完整"
          description="服务端返回了下一页游标。为避免基于不完整角色证据执行变更，所有成员写操作已关闭。"
        />
      )}
      <Table scrollLabel="团队成员表">
        <TableHeader>
          <TableRow>
            <TableHead>账户 ID</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {readyMembers.memberships.map((membership) => {
            const anyRoleDecision = memberAnyRoleDecision(
              membership,
              props.actor,
              props.ownerCount,
              readyMembers,
            );
            const removeDecision = readyMembers.complete
              ? canRemoveMember({
                  actor: props.actor,
                  target: membership,
                  activeOwnerCount: props.ownerCount,
                })
              : denied("成员列表尚未完整验证，移除操作已关闭。");
            return (
              <TableRow key={membership.membershipId}>
                <TableCell>
                  <code>{membership.accountId}</code>
                  {membership.membershipId === props.actor?.membershipId && "（你）"}
                </TableCell>
                <TableCell>
                  <Badge tone={membership.state === "active" ? "success" : "warning"}>
                    {membership.state === "active" ? "有效" : "已移除"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Select
                    aria-label={`更改 ${membership.accountId} 的角色`}
                    value={membership.role}
                    options={MEMBER_ROLES.map((role) => ({
                      value: role,
                      label: roleLabel(role),
                      disabled:
                        role !== membership.role &&
                        !memberRoleDecision(
                          membership,
                          role,
                          props.actor,
                          props.ownerCount,
                          readyMembers,
                        ).allowed,
                    }))}
                    disabled={
                      props.busy !== null ||
                      membership.state !== "active" ||
                      !anyRoleDecision.allowed
                    }
                    title={anyRoleDecision.allowed ? undefined : anyRoleDecision.reason}
                    onChange={(event) =>
                      props.changeRole(membership, event.currentTarget.value as StudioTeamRole)
                    }
                  />
                  {!anyRoleDecision.allowed && (
                    <small className="studio-team-page__permission-reason">
                      {anyRoleDecision.reason}
                    </small>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={props.busy === `remove:${membership.membershipId}`}
                    disabled={props.busy !== null || !removeDecision.allowed}
                    title={removeDecision.allowed ? undefined : removeDecision.reason}
                    onClick={() => props.remove(membership)}
                  >
                    移除
                  </Button>
                  {!removeDecision.allowed && (
                    <small className="studio-team-page__permission-reason">
                      {removeDecision.reason}
                    </small>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

function AssignmentPanel(props: {
  readonly state: AssignmentState;
  readonly memberships: readonly CloudTeamMembership[];
  readonly actor: CloudTeamMembership | null;
  readonly busy: string | null;
  readonly reload: () => void;
  readonly setAssignment: (
    target: CloudTeamMembership,
    existing: CloudProjectAssignment | undefined,
  ) => void;
}) {
  if (props.state.status === "idle") {
    return (
      <EmptyState
        title="尚未读取项目分配"
        description="输入项目 ID 后，才能验证当前成员的项目范围并启用安全操作。"
      />
    );
  }
  if (props.state.status === "loading") {
    return (
      <PageStateBoundary state="loading" loadingLabel="正在读取项目分配">
        <span />
      </PageStateBoundary>
    );
  }
  if (props.state.status === "error") {
    return (
      <VisibleErrorState title="无法读取项目分配" error={props.state.error} retry={props.reload} />
    );
  }
  const readyAssignments = props.state;

  const decision = canManageProjectAssignments({
    actor: props.actor,
    assignments: readyAssignments.assignments,
    assignmentsComplete: readyAssignments.complete,
  });

  return (
    <>
      {!decision.allowed && (
        <InlineAlert tone="warning" title="项目分配写操作已关闭" description={decision.reason} />
      )}
      {readyAssignments.assignments.length === 0 ? (
        <EmptyState
          title="该项目没有 assignment"
          description="当前项目尚未返回任何团队成员分配。只有具备已验证项目范围的管理者才能创建首个可见分配。"
          primaryAction={{ label: "重试", onClick: props.reload }}
        />
      ) : (
        <Table scrollLabel="项目分配表">
          <TableHeader>
            <TableRow>
              <TableHead>成员 ID</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>修订</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {readyAssignments.assignments.map((assignment) => (
              <TableRow key={assignment.assignmentId}>
                <TableCell>
                  <code>{assignment.membershipId}</code>
                </TableCell>
                <TableCell>
                  <Badge tone={assignment.state === "active" ? "success" : "warning"}>
                    {assignment.state === "active" ? "有效" : "已撤销"}
                  </Badge>
                </TableCell>
                <TableCell>{assignment.revision}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {props.memberships.length > 0 && (
        <section className="studio-team-page__assignment-actions">
          <h3>设置成员 assignment</h3>
          <div className="studio-team-page__assignment-list">
            {props.memberships
              .filter((membership) => membership.state === "active")
              .map((membership) => {
                const existing = readyAssignments.assignments.find(
                  (assignment) => assignment.membershipId === membership.membershipId,
                );
                const label = existing?.state === "active" ? "撤销分配" : "启用分配";
                return (
                  <div key={membership.membershipId} className="studio-team-page__assignment-row">
                    <span>
                      <code>{membership.accountId}</code> · {roleLabel(membership.role)}
                    </span>
                    <Button
                      size="sm"
                      variant={existing?.state === "active" ? "danger" : "secondary"}
                      loading={props.busy === `assignment:${membership.membershipId}`}
                      disabled={props.busy !== null || !decision.allowed}
                      title={decision.allowed ? undefined : decision.reason}
                      onClick={() => props.setAssignment(membership, existing)}
                    >
                      {label}
                    </Button>
                  </div>
                );
              })}
          </div>
        </section>
      )}
    </>
  );
}

function TeamProjectKeyEnvelopePanel(props: {
  readonly localKey: LocalTeamProjectKeyState;
  readonly publication: CloudTeamProjectKeyPublicationState | null;
  readonly error: VisibleError | null;
  readonly running: boolean;
  readonly decision: PermissionDecision;
  readonly onPublish: () => void;
  readonly verification: VerifiedTeamProjectKeyEnvelope | null;
  readonly verificationError: VisibleError | null;
  readonly verificationRunning: boolean;
  readonly verificationDecision: PermissionDecision;
  readonly onVerify: () => void;
}) {
  const phase = props.publication?.phase ?? (props.running ? "preparing" : null);
  const terminal = phase === "published" || phase === "conflicted";
  const enabled =
    !props.running && !terminal && props.decision.allowed && props.localKey.status === "available";
  const verificationEnabled = !props.verificationRunning && props.verificationDecision.allowed;

  return (
    <section className="studio-team-page__assignment-actions" aria-label="项目密钥 envelope 发放">
      <div className="studio-team-page__heading-row">
        <div>
          <h3>项目密钥 envelope 发放</h3>
          <p>
            发放版本从本地 active key bundle 读取；当前设备验收版本由云端权威 current-key
            元数据自动发现。两者均不接受手动输入。
          </p>
        </div>
        {phase !== null && (
          <Badge tone={publicationPhaseTone(phase)}>{publicationPhaseLabel(phase)}</Badge>
        )}
      </div>

      {props.localKey.status === "idle" && (
        <p role="note">完整读取项目 assignment 后，才能验证用于发放的本地 active 项目密钥。</p>
      )}
      {props.localKey.status === "checking" && (
        <p role="status">正在验证当前云设备与本地 active 项目密钥…</p>
      )}
      {props.localKey.status === "unavailable" && (
        <InlineAlert
          tone="warning"
          title="团队密钥发放不可用"
          description={props.localKey.reason}
        />
      )}
      {props.localKey.status === "available" && (
        <p role="note">已验证本地 active 密钥版本 {String(props.localKey.keyVersion)}。</p>
      )}
      {props.localKey.status === "team_receipt" && (
        <InlineAlert
          tone={props.localKey.openReady ? "info" : "warning"}
          title={props.localKey.openReady ? "团队密钥已持久化且可离线开启" : "团队密钥需重新下载"}
          description={`本机收据版本 ${String(props.localKey.keyVersion)}，状态 ${props.localKey.receiptState}。加密信封仅保存在系统凭据存储中，SQLite 只保留无密钥元数据。`}
        />
      )}
      <p role="note">
        当前设备验收不依赖本地 key bundle：原生命令先读取无密文的权威 current-key
        元数据，拉取对应设备信封后再复核版本、服务端修订与更新时间。密文和明文密钥不会进入 普通
        UI；验真后的加密信封持久化到系统凭据存储，SQLite
        仅记录无密钥收据。恢复方式仅为重新下载当前设备信封。
      </p>
      <p role="note">
        撤销会阻止未来同步与新版本授权，但不能远程擦除已经授权并在本机解密过的内容。
      </p>

      {!props.decision.allowed && (
        <p className="studio-team-page__permission-reason" role="note">
          {props.decision.reason}
        </p>
      )}

      {props.publication !== null && (
        <p role="status">
          已发布 {String(props.publication.publishedCount)} /{" "}
          {String(props.publication.recipientCount)} 个合资格设备
        </p>
      )}
      {props.error !== null && (
        <InlineAlert
          tone="error"
          title={visibleErrorTitle(props.error)}
          description={props.error.description}
        />
      )}
      {!props.verificationDecision.allowed && (
        <p className="studio-team-page__permission-reason" role="note">
          {props.verificationDecision.reason}
        </p>
      )}
      {props.verification !== null && (
        <InlineAlert
          tone="info"
          title="当前设备信封已验真、持久化且可开启"
          description={`权威当前版本 ${String(props.verification.receipt.keyVersion)}（服务端修订 ${String(props.verification.receipt.currentServerRevision)}，更新时间 ${props.verification.receipt.currentKeyUpdatedAt}）；项目密钥指纹 ${props.verification.receipt.projectKeyFingerprint.slice(0, 16)}…；本机写入状态 ${props.verification.nativeWriteState}。`}
        />
      )}
      {props.verificationError !== null && (
        <InlineAlert
          tone="error"
          title={visibleErrorTitle(props.verificationError)}
          description={props.verificationError.description}
        />
      )}

      <Button
        type="button"
        loading={props.running}
        disabled={!enabled}
        title={props.decision.allowed ? undefined : props.decision.reason}
        onClick={props.onPublish}
      >
        为全部合资格设备发放密钥
      </Button>
      <Button
        type="button"
        variant="secondary"
        loading={props.verificationRunning}
        disabled={!verificationEnabled}
        title={
          props.verificationDecision.allowed
            ? "原生发现并复核权威 active 版本；验真后的加密信封仅写入系统凭据存储。"
            : props.verificationDecision.reason
        }
        onClick={props.onVerify}
      >
        验收并保存当前设备云信封
      </Button>
    </section>
  );
}

function VisibleErrorState(props: {
  readonly title: string;
  readonly error: VisibleError;
  readonly retry: () => void;
}) {
  return (
    <ErrorState
      title={props.title}
      description={props.error.description}
      errorCode={visibleErrorTitle(props.error)}
      {...(props.error.requestId === undefined ? {} : { requestId: props.error.requestId })}
      primaryAction={{ label: "重试", onClick: props.retry }}
    />
  );
}

function publicationPhaseLabel(phase: CloudTeamProjectKeyPublicationState["phase"]): string {
  switch (phase) {
    case "preparing":
      return "准备中（preparing）";
    case "publishing":
      return "发布中（publishing）";
    case "partial":
      return "部分完成（partial）";
    case "retryable":
      return "可安全重试（retryable）";
    case "conflicted":
      return "冲突（conflicted）";
    case "published":
      return "已完成（published）";
  }
}

function publicationPhaseTone(
  phase: CloudTeamProjectKeyPublicationState["phase"],
): "danger" | "info" | "success" | "warning" {
  switch (phase) {
    case "published":
      return "success";
    case "conflicted":
      return "danger";
    case "partial":
    case "retryable":
      return "warning";
    case "preparing":
    case "publishing":
      return "info";
  }
}

function memberAnyRoleDecision(
  target: CloudTeamMembership,
  actor: CloudTeamMembership | null,
  ownerCount: number,
  members: MembersState,
): PermissionDecision {
  if (members.status !== "ready" || !members.complete) {
    return denied("成员列表尚未完整验证，角色变更已关闭。");
  }
  const decisions = MEMBER_ROLES.filter((role) => role !== target.role).map((nextRole) =>
    canChangeMemberRole({ actor, target, nextRole, activeOwnerCount: ownerCount }),
  );
  return decisions.find((decision) => decision.allowed) ?? decisions[0] ?? denied("没有可用角色。");
}

function memberRoleDecision(
  target: CloudTeamMembership,
  nextRole: StudioTeamRole,
  actor: CloudTeamMembership | null,
  ownerCount: number,
  members: MembersState,
): PermissionDecision {
  if (members.status !== "ready" || !members.complete) {
    return denied("成员列表尚未完整验证，角色变更已关闭。");
  }
  return canChangeMemberRole({ actor, target, nextRole, activeOwnerCount: ownerCount });
}

function normalizeError(error: unknown): VisibleError {
  if (error instanceof CloudClientError) {
    const common = {
      code: error.code,
      ...(error.requestId === null ? {} : { requestId: error.requestId }),
      ...(error.status === null ? {} : { status: error.status }),
    };
    switch (error.code) {
      case "REVISION_CONFLICT":
        return {
          ...common,
          description: "服务端修订已变化（也可能涉及最后一位所有者保护）。请重新读取列表后再操作。",
        };
      case "IDEMPOTENCY_CONFLICT":
        return {
          ...common,
          description: "服务端检测到幂等键与既有请求不一致。请重新读取状态后再试。",
        };
      case "ACCESS_FORBIDDEN":
        return {
          ...common,
          description: "服务端拒绝了此操作；当前角色或项目范围没有所需权限。",
        };
      case "CLOUD_AUTHENTICATION_REQUIRED":
      case "AUTH_SESSION_EXPIRED":
      case "AUTH_SESSION_REVOKED":
        return {
          ...common,
          description: "云会话不可用，请重新登录。",
        };
      default:
        return {
          ...common,
          description: error.retryable
            ? "云请求暂时未完成，请重试。"
            : "云服务拒绝或无法验证此请求。",
        };
    }
  }
  if (error instanceof CloudSessionCoordinatorError) {
    return {
      code: error.sourceCode,
      description:
        error.reason === "version_incompatible"
          ? "当前桌面版本与云服务不兼容，请先更新应用。"
          : "云会话不可用，请重新登录。",
    };
  }
  return {
    code: "TEAM_WORKSPACE_UNAVAILABLE",
    description: "团队工作区请求未完成；未识别的错误详情不会直接显示。",
  };
}

function isSignedOutError(error: unknown): boolean {
  if (error instanceof CloudSessionCoordinatorError) {
    return error.reason === "reauth_required";
  }
  return (
    error instanceof CloudClientError &&
    [
      "CLOUD_AUTHENTICATION_REQUIRED",
      "AUTH_SESSION_EXPIRED",
      "AUTH_SESSION_REVOKED",
      "AUTH_REFRESH_REPLAYED",
    ].includes(error.code)
  );
}

function visibleErrorTitle(error: VisibleError): string {
  return error.status === undefined ? error.code : `${error.code} · HTTP ${String(error.status)}`;
}

function roleLabel(role: StudioTeamRole | CloudTeamInvitationRole): string {
  switch (role) {
    case "owner":
      return "所有者";
    case "admin":
      return "管理员";
    case "author":
      return "作者";
    case "reviewer":
      return "审阅者";
    case "read_only":
      return "只读";
    case "finance_admin":
      return "财务管理员";
  }
}

function defaultInvitationExpiry(): string {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function denied(reason: string): PermissionDecision {
  return { allowed: false, reason };
}
