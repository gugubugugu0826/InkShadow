import type { CloudProjectAssignment, CloudTeamMembership } from "@inkshadow/contracts";
import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import { describe, expect, it, vi } from "vitest";

import type { CloudTeamWorkspacePort } from "./cloud-team-workspace-service";
import type {
  StableEncryptedReviewSource,
  StudioReviewStableSourcePort,
  VerifiedStudioReviewSuggestionApplication,
} from "./studio-review-coordinator";
import { createDevelopmentRuntime } from "./runtime";
import {
  CloudStudioReviewAuthority,
  RepositoryStudioReviewCandidateVersions,
  SqliteStudioReviewStableSource,
} from "./studio-review-runtime";

const TENANT_ID = uuid(1);
const ACCOUNT_ID = uuid(2);
const TEAM_ID = uuid(3);
const PROJECT_ID = uuid(4);
const MEMBERSHIP_ID = uuid(5);
const ASSIGNMENT_ID = uuid(6);
const DEVICE_ID = uuid(7);
const MANIFEST_JOB_ID = uuid(8);
const CHAPTER_JOB_ID = uuid(9);
const NOW = "2026-07-28T04:00:00.000Z";

describe("Studio review runtime authority", () => {
  it("derives the exact active membership and assignment from complete cloud pages", async () => {
    const authority = new CloudStudioReviewAuthority(teamService());

    await expect(authority.resolveContext(TEAM_ID, PROJECT_ID)).resolves.toEqual({
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      membershipId: MEMBERSHIP_ID,
      role: "author",
      membershipState: "active",
      assignmentState: "active",
    });
  });

  it("fails closed on truncated or cross-scope authority responses", async () => {
    const listTeamMembers = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: uuid(20),
      memberships: [membership()],
      nextCursor: "more-members",
    });
    const truncated: CloudTeamWorkspacePort = { ...teamService(), listTeamMembers };
    await expect(
      new CloudStudioReviewAuthority(truncated).resolveContext(TEAM_ID, PROJECT_ID),
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_INCOMPLETE" });

    const listProjectAssignments = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: uuid(21),
      assignments: [assignment({ projectId: uuid(99) })],
      nextCursor: null,
    });
    const crossed: CloudTeamWorkspacePort = { ...teamService(), listProjectAssignments };
    await expect(
      new CloudStudioReviewAuthority(crossed).resolveContext(TEAM_ID, PROJECT_ID),
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_INVALID" });
  });
});

describe("SqliteStudioReviewStableSource", () => {
  it("derives a source only from complete acknowledged ciphertext projections", async () => {
    const executor = new ProjectionExecutor(stableRows());
    const source = await new SqliteStudioReviewStableSource(
      executor,
      localSessionAuthority(),
    ).loadStableEncryptedSource({
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
    });

    expect(source).toMatchObject({
      authority: "saved_stable_encrypted_projection",
      projectionState: "settled",
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      projectKeyVersion: 3,
      sourceVersionRevision: 4,
    });
    expect(source?.authoritativeCiphertextSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["queued latest job", { status: "queued" }],
    ["unacknowledged operation", { outbox_status: "queued" }],
    ["mixed key generation", { key_version: 2 }],
    ["missing ciphertext", { position: null, ciphertext_sha256: null }],
    ["cross-account projection job", { account_id: uuid(98) }],
  ])("rejects %s instead of claiming a settled source", async (_label, override) => {
    const rows = stableRows();
    const first = rows[0];
    if (first === undefined) {
      throw new Error("Expected a chapter projection fixture.");
    }
    rows[0] = { ...first, ...override };
    const source = await new SqliteStudioReviewStableSource(
      new ProjectionExecutor(rows),
      localSessionAuthority(),
    ).loadStableEncryptedSource({
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
    });

    expect(source).toBeNull();
  });

  it("fails closed before processing an unbounded stable projection", async () => {
    const row = stableRows()[0];
    if (row === undefined) {
      throw new Error("Expected a stable projection fixture.");
    }
    const source = await new SqliteStudioReviewStableSource(
      new ProjectionExecutor(Array.from({ length: 100_001 }, () => row)),
      localSessionAuthority(),
    ).loadStableEncryptedSource({
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
    });

    expect(source).toBeNull();
  });

  it("rejects a local sync registration owned by another active session", async () => {
    const source = await new SqliteStudioReviewStableSource(new ProjectionExecutor(stableRows()), {
      resolve: () => Promise.resolve({ accountId: uuid(97), deviceId: DEVICE_ID }),
    }).loadStableEncryptedSource({
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
    });

    expect(source).toBeNull();
  });
});

describe("RepositoryStudioReviewCandidateVersions", () => {
  it("commits an accepted suggestion through the real author candidate/version path exactly once", async () => {
    const fixture = await candidateFixture();
    const versions = new RepositoryStudioReviewCandidateVersions({
      stableSources: fixedStableSource(fixture.source),
      chapters: fixture.runtime.repositories.chapters,
      chapterVersions: fixture.runtime.repositories.chapterVersions,
      candidates: fixture.runtime.repositories.aiCandidates,
      acceptCandidate: fixture.runtime.useCases.acceptCandidate,
      clock: fixture.runtime.clock,
      hasher: fixture.runtime.hasher,
    });

    await expect(versions.applyVerifiedSuggestion(fixture.application)).resolves.toMatchObject({
      authority: "local_review_suggestion_version",
      applicationId: fixture.application.itemId,
      result: "created",
      newVersionRevision: 2,
    });
    await expect(versions.applyVerifiedSuggestion(fixture.application)).resolves.toMatchObject({
      result: "already_applied",
      newVersionRevision: 2,
    });

    const chapter = await fixture.runtime.repositories.chapters.findById(fixture.chapterId);
    if (!chapter.ok) {
      throw chapter.error;
    }
    expect(chapter.value?.content).toBe("The sun rose.");
    const chapterVersions = await fixture.runtime.repositories.chapterVersions.listByChapterId(
      fixture.chapterId,
    );
    expect(chapterVersions).toMatchObject({ ok: true });
    if (!chapterVersions.ok) {
      throw chapterVersions.error;
    }
    expect(chapterVersions.value).toHaveLength(2);

    const tampered = {
      ...fixture.application,
      candidate: {
        ...fixture.application.candidate,
        replacement: {
          ...fixture.application.candidate.replacement,
          text: "stars",
        },
      },
    } satisfies VerifiedStudioReviewSuggestionApplication;
    await expect(versions.applyVerifiedSuggestion(tampered)).rejects.toMatchObject({
      code: "REVIEW_SUGGESTION_INVALID",
    });
  });

  it("rechecks the encrypted stable source immediately before acceptance", async () => {
    const fixture = await candidateFixture();
    let reads = 0;
    const stableSources: StudioReviewStableSourcePort = {
      loadStableEncryptedSource: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1
            ? fixture.source
            : {
                ...fixture.source,
                authoritativeCiphertextSha256: "f".repeat(64),
              },
        );
      },
    };
    const versions = new RepositoryStudioReviewCandidateVersions({
      stableSources,
      chapters: fixture.runtime.repositories.chapters,
      chapterVersions: fixture.runtime.repositories.chapterVersions,
      candidates: fixture.runtime.repositories.aiCandidates,
      acceptCandidate: fixture.runtime.useCases.acceptCandidate,
      clock: fixture.runtime.clock,
      hasher: fixture.runtime.hasher,
    });

    await expect(versions.applyVerifiedSuggestion(fixture.application)).rejects.toMatchObject({
      code: "REVIEW_SOURCE_CHANGED",
    });
    const chapter = await fixture.runtime.repositories.chapters.findById(fixture.chapterId);
    if (!chapter.ok) {
      throw chapter.error;
    }
    expect(chapter.value?.content).toBe("The moon rose.");
  });
});

function teamService(): CloudTeamWorkspacePort {
  return {
    getCurrentAccountId: vi.fn().mockResolvedValue(ACCOUNT_ID),
    createTeam: vi.fn(),
    listTeams: vi.fn(),
    listTeamMembers: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: uuid(10),
      memberships: [membership()],
      nextCursor: null,
    }),
    createInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    changeMemberRole: vi.fn(),
    revokeMembership: vi.fn(),
    listProjectAssignments: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: uuid(11),
      assignments: [assignment()],
      nextCursor: null,
    }),
    setProjectAssignment: vi.fn(),
  };
}

function membership(): CloudTeamMembership {
  return {
    schemaVersion: 1,
    membershipId: MEMBERSHIP_ID,
    accountId: ACCOUNT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    role: "author",
    state: "active",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function assignment(overrides: Readonly<{ projectId?: string }> = {}): CloudProjectAssignment {
  return {
    schemaVersion: 1,
    assignmentId: ASSIGNMENT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: overrides.projectId ?? PROJECT_ID,
    membershipId: MEMBERSHIP_ID,
    state: "active",
    revision: 1,
    grantedByMembershipId: MEMBERSHIP_ID,
    revokedByMembershipId: null,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

interface ProjectionRow {
  readonly job_id: string;
  readonly account_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly projection_kind: "upsert" | "delete";
  readonly source_revision: number;
  readonly key_version: number;
  readonly status: string;
  readonly operation_id: string | null;
  readonly outbox_status: string | null;
  readonly position: number | null;
  readonly ciphertext_sha256: string | null;
}

function stableRows(): ProjectionRow[] {
  return [
    {
      job_id: CHAPTER_JOB_ID,
      account_id: ACCOUNT_ID,
      object_type: "chapter_version",
      object_id: uuid(30),
      object_generation: 1,
      projection_kind: "upsert",
      source_revision: 4,
      key_version: 3,
      status: "completed",
      operation_id: uuid(31),
      outbox_status: "acknowledged",
      position: 0,
      ciphertext_sha256: "b".repeat(64),
    },
    {
      job_id: MANIFEST_JOB_ID,
      account_id: ACCOUNT_ID,
      object_type: "project_manifest",
      object_id: PROJECT_ID,
      object_generation: 1,
      projection_kind: "upsert",
      source_revision: 2,
      key_version: 3,
      status: "completed",
      operation_id: uuid(32),
      outbox_status: "acknowledged",
      position: 0,
      ciphertext_sha256: "a".repeat(64),
    },
  ];
}

class ProjectionExecutor implements SqlExecutor {
  public constructor(private readonly projections: readonly ProjectionRow[]) {}

  public select<Row extends object>(query: string): Promise<Row[]> {
    if (query.includes("FROM project_sync_registrations")) {
      return Promise.resolve([
        {
          project_id: PROJECT_ID,
          account_id: ACCOUNT_ID,
          device_id: DEVICE_ID,
          state: "enabled",
          consent_revision: 1,
          key_version: 3,
          revision: 2,
          plaintext_bootstrap_completed: 1,
          last_error_code: null,
          created_at: NOW,
          updated_at: NOW,
          enabled_at: NOW,
          paused_at: null,
        } as unknown as Row,
      ]);
    }
    if (query.includes("WITH ranked AS")) {
      return Promise.resolve(this.projections.map((row) => ({ ...row }) as unknown as Row));
    }
    throw new Error(`Unexpected Studio review SQL: ${query}`);
  }

  public execute(): Promise<{ rowsAffected: number }> {
    throw new Error("Studio review stable-source tests are read-only.");
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return operation(this);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function uuid(index: number): string {
  return `019f9f4a-b3c7-7350-9226-${String(index).padStart(12, "0")}`;
}

async function candidateFixture() {
  const runtime = createDevelopmentRuntime(new EphemeralStorage());
  const project = await runtime.useCases.createProject.execute({ name: "Review candidate" });
  if (!project.ok) {
    throw project.error;
  }
  const created = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "Stable chapter",
    content: "The moon rose.",
  });
  if (!created.ok) {
    throw created.error;
  }
  const selectedHash = await runtime.hasher.sha256("moon");
  if (!selectedHash.ok) {
    throw selectedHash.error;
  }
  const source: StableEncryptedReviewSource = {
    authority: "saved_stable_encrypted_projection",
    projectionState: "settled",
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: project.value.id,
    sourceVersionId: MANIFEST_JOB_ID,
    sourceVersionRevision: 4,
    authoritativeCiphertextSha256: "a".repeat(64),
    projectKeyVersion: 3,
  };
  const itemId = uuid(900);
  const application: VerifiedStudioReviewSuggestionApplication = {
    authority: "verified_encrypted_review_suggestion",
    applicationId: itemId,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: project.value.id,
    reviewId: uuid(901),
    threadId: uuid(902),
    itemId,
    anchor: {
      chapterId: created.value.chapter.id,
      startUtf16: 4,
      endUtf16: 8,
      selectedTextSha256: selectedHash.value,
    },
    candidate: {
      candidateId: itemId,
      baseSourceVersionId: source.sourceVersionId,
      baseSourceVersionRevision: source.sourceVersionRevision,
      baseSourceCiphertextSha256: source.authoritativeCiphertextSha256,
      replacement: {
        chapterId: created.value.chapter.id,
        startUtf16: 4,
        endUtf16: 8,
        text: "sun",
      },
    },
    expectedBase: {
      sourceVersionId: source.sourceVersionId,
      sourceVersionRevision: source.sourceVersionRevision,
      sourceCiphertextSha256: source.authoritativeCiphertextSha256,
    },
    requestedByMembershipId: MEMBERSHIP_ID,
  };
  return {
    runtime,
    chapterId: created.value.chapter.id,
    source,
    application,
  };
}

function fixedStableSource(source: StableEncryptedReviewSource): StudioReviewStableSourcePort {
  return {
    loadStableEncryptedSource: () => Promise.resolve(source),
  };
}

function localSessionAuthority() {
  return {
    resolve: () => Promise.resolve({ accountId: ACCOUNT_ID, deviceId: DEVICE_ID }),
  };
}

class EphemeralStorage implements Storage {
  readonly #values = new Map<string, string>();

  public get length(): number {
    return this.#values.size;
  }

  public clear(): void {
    this.#values.clear();
  }

  public getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.#values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}
