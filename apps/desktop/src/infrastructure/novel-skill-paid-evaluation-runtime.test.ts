/* eslint-disable @typescript-eslint/require-await -- deliberately synchronous in-memory ports */
import {
  createNovelSkillEvaluationExecutionPlan,
  listNovelSkillEvaluationFixtures,
  type NovelSkillEvaluationMetric,
} from "@inkshadow/ai-core";
import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import {
  hashModelHubExactEvaluationMessages,
  hashModelHubExactEvaluationRequestProfile,
  MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
  MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
  type ExecuteModelHubExactEvaluationTargetInput,
  type InspectModelHubExactEvaluationTargetInput,
  type ModelHubExactEvaluationExecutionResult,
  type ModelHubExactEvaluationInspection,
  type ModelHubExactEvaluationPredispatchReceipt,
} from "./model-hub-exact-evaluation-target";
import type {
  NovelSkillEvaluationCellRecord,
  NovelSkillEvaluationRunProgress,
} from "./novel-skill-evaluation-sqlite-store";
import type {
  NovelSkillPaidEvaluationBlindReviewItem as StoredBlindReviewItem,
  NovelSkillPaidEvaluationControlReservation,
  NovelSkillPaidEvaluationControlSnapshot,
  NovelSkillPaidEvaluationControlTarget,
  NovelSkillPaidEvaluationRecoverableRun,
} from "./novel-skill-paid-evaluation-control-sqlite-store";
import type {
  AuthorizeNovelSkillPaidEvaluationRunInput,
  NovelSkillPaidEvaluationQuote,
  NovelSkillPaidEvaluationReservationRecord,
  ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
  SettleNovelSkillPaidEvaluationSuccessInput,
} from "./novel-skill-paid-evaluation-sqlite-store";
import {
  createNovelSkillPaidEvaluationRuntime,
  createRecoverableRuntimeSelection,
  createUnavailableNovelSkillPaidEvaluationPanelPort,
  type NovelSkillPaidEvaluationRuntimeOptions,
} from "./novel-skill-paid-evaluation-runtime";

const RUN_ID = uuid(1);
const SUITE_ID = uuid(2);
const PROJECT_ID = uuid(3);
const AUTHORIZATION_ID = uuid(4);
const NOW_TEXT = "2026-08-11T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW_TEXT);
if (!parsedNow.ok) throw parsedNow.error;
const NOW = parsedNow.value;
const HASH = Object.freeze({
  protocol: "1".repeat(64),
  targetManifest: "2".repeat(64),
  pricingManifest: "3".repeat(64),
  quote: "4".repeat(64),
  capability: "5".repeat(64),
  targetA: "6".repeat(64),
  targetB: "7".repeat(64),
  artifactA: "8".repeat(64),
  artifactB: "9".repeat(64),
  pricingA: "a".repeat(64),
  pricingB: "b".repeat(64),
});
const TARGET_IDS = ["catalog-a", "catalog-b"] as const;

describe("NovelSkillPaidEvaluationRuntime", () => {
  it("exports a dependency-free browser fail-closed port and never picks one of many recoverable runs", async () => {
    const browser = createUnavailableNovelSkillPaidEvaluationPanelPort("desktop only");
    const snapshots = await Promise.all([
      browser.prepareAndQuote({ exactTargetIds: TARGET_IDS }),
      browser.authorizeCommercialRun({
        runId: RUN_ID,
        quoteId: HASH.quote,
        commercialUseAcknowledged: true,
      }),
      browser.startAuthorizedRun({
        runId: RUN_ID,
        authorizationId: AUTHORIZATION_ID,
        onProgress: vi.fn(),
      }),
      browser.cancelRun({ runId: RUN_ID }),
      browser.beginBlindReview({ runId: RUN_ID }),
      browser.sealBlindScores({ runId: RUN_ID, blindItemId: uuid(99), scores: scores(3) }),
    ]);

    expect(snapshots).toHaveLength(6);
    expect(snapshots.every(({ phase, runId }) => phase === "unavailable" && runId === null)).toBe(
      true,
    );
    expect(snapshots[0].unavailableReason).toBe("desktop only");

    expect(createRecoverableRuntimeSelection([])).toEqual({ kind: "create_new" });
    expect(createRecoverableRuntimeSelection([recoverable(RUN_ID)])).toEqual({
      kind: "resume_existing",
      runId: RUN_ID,
    });
    const multiple = createRecoverableRuntimeSelection([recoverable(RUN_ID), recoverable(uuid(5))]);
    expect(multiple.kind).toBe("requires_user_selection");
    if (multiple.kind === "requires_user_selection") {
      expect(multiple.recoverableRuns.map(({ runId }) => runId)).toEqual([RUN_ID, uuid(5)]);
    }
  });

  it("prepares, quotes, authorizes and explicitly recovers with zero exact-target execution", async () => {
    const harness = await PaidRuntimeHarness.create();
    const runtime = createNovelSkillPaidEvaluationRuntime(harness.options());

    await expect(runtime.initialize()).resolves.toMatchObject({ phase: "not_prepared" });
    const quoted = await runtime.prepareAndQuote(TARGET_IDS);
    expect(quoted).toMatchObject({ phase: "awaiting_authorization" });
    expect(quoted.quote).toMatchObject({ quoteId: HASH.quote, exactTargetIds: TARGET_IDS });
    expect(harness.preparationCalls).toEqual([{ runId: RUN_ID, exactTargetIds: TARGET_IDS }]);
    const restartedBeforeAuthorization = createNovelSkillPaidEvaluationRuntime(harness.options());
    await expect(restartedBeforeAuthorization.initialize()).resolves.toMatchObject({
      phase: "awaiting_authorization",
      quote: { quoteId: HASH.quote, exactTargetIds: TARGET_IDS },
    });

    await expect(
      runtime.authorizeCommercialRun({
        runId: RUN_ID,
        quoteId: HASH.quote,
        commercialUseAcknowledged: false,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_RUNTIME_INVALID" });
    expect(harness.authorizationInput).toBeNull();

    const authorized = await runtime.authorizeCommercialRun({
      runId: RUN_ID,
      quoteId: HASH.quote,
      commercialUseAcknowledged: true,
    });
    expect(authorized).toMatchObject({
      phase: "authorized_not_started",
      authorizationId: AUTHORIZATION_ID,
    });
    expect(harness.authorizationInput?.hardCeilings).toEqual([
      { currency: "USD", hardCeilingMicros: "192000" },
    ]);

    await expect(runtime.recoverAfterRestart()).resolves.toMatchObject({
      phase: "authorized_not_started",
    });
    expect(harness.recoveryCalls).toBe(1);
    expect(harness.inspectCalls).toBe(0);
    expect(harness.providerCalls).toBe(0);
    expect(harness.reserveInputs).toHaveLength(0);
  });

  it("starts only explicitly, dispatches authority messages, and resumes a running run without requoting", async () => {
    const harness = await PaidRuntimeHarness.create();
    const runtime = createNovelSkillPaidEvaluationRuntime(harness.options());
    await runtime.prepareAndQuote(TARGET_IDS);
    await runtime.authorizeCommercialRun({
      runId: RUN_ID,
      quoteId: HASH.quote,
      commercialUseAcknowledged: true,
    });
    expect(harness.providerCalls).toBe(0);

    const firstCancellations: Promise<unknown>[] = [];
    const first = await runtime.startAuthorizedRun({
      runId: RUN_ID,
      authorizationId: AUTHORIZATION_ID,
      onProgress: (snapshot) => {
        if (snapshot.completedProviderCalls >= 1) {
          firstCancellations.push(runtime.cancelRun(RUN_ID));
        }
      },
    });
    await Promise.all(firstCancellations);
    expect(first).toMatchObject({ phase: "running_waiting", completedProviderCalls: 1 });
    expect(harness.providerCalls).toBe(1);
    expect(harness.reserveInputs).toHaveLength(1);
    expect(harness.reserveInputs[0]?.payloadAuthority.messages).toBe(harness.executedMessages[0]);
    expect(harness.reserveInputs[0]?.trace.id).toBe(
      harness.reserveInputs[0]?.reservation.plannedContextTraceId,
    );
    expect(harness.executedMessages[0]).toBe(harness.inspectedMessages[0]);
    expect(harness.skillSnapshotCommits).toHaveLength(1);

    const quoteCallsAtRunning = harness.quoteCalls;
    const firstCell = harness.firstObservedCell();
    firstCell.evidenceCollected = false;
    firstCell.state = "planned";
    const restarted = createNovelSkillPaidEvaluationRuntime(harness.options());
    await expect(restarted.initialize()).resolves.toMatchObject({
      phase: "running_waiting",
      completedProviderCalls: 1,
    });
    await expect(restarted.recoverAfterRestart()).resolves.toMatchObject({
      phase: "running_waiting",
      completedProviderCalls: 1,
    });
    expect(firstCell.evidenceCollected).toBe(true);
    expect(harness.repairCalls).toBeGreaterThanOrEqual(2);
    expect(harness.providerCalls).toBe(1);
    expect(harness.quoteCalls).toBe(quoteCallsAtRunning);

    const resumedCancellations: Promise<unknown>[] = [];
    await restarted.startAuthorizedRun({
      runId: RUN_ID,
      authorizationId: AUTHORIZATION_ID,
      onProgress: (snapshot) => {
        if (snapshot.completedProviderCalls >= 2) {
          resumedCancellations.push(restarted.cancelRun(RUN_ID));
        }
      },
    });
    await Promise.all(resumedCancellations);
    expect(harness.providerCalls).toBe(2);
    expect(harness.quoteCalls).toBe(quoteCallsAtRunning);
    expect(harness.executedMessages[1]).toBe(harness.inspectedMessages[1]);
  });

  it("honors cancellation while the explicit start authorization read is still pending", async () => {
    const harness = await PaidRuntimeHarness.create();
    const runtime = createNovelSkillPaidEvaluationRuntime(harness.options());
    await runtime.prepareAndQuote(TARGET_IDS);
    await runtime.authorizeCommercialRun({
      runId: RUN_ID,
      quoteId: HASH.quote,
      commercialUseAcknowledged: true,
    });
    const gate = deferred();
    harness.executionAuthorityGate = gate.promise;

    const starting = runtime.startAuthorizedRun({
      runId: RUN_ID,
      authorizationId: AUTHORIZATION_ID,
      onProgress: vi.fn(),
    });
    await Promise.resolve();
    const cancelling = runtime.cancelRun(RUN_ID);
    gate.resolve();

    await expect(starting).resolves.toMatchObject({ phase: "authorized_not_started" });
    await cancelling;
    expect(harness.providerCalls).toBe(0);
    expect(harness.status).toBe("planned");
  });

  it("opens and scores only reviewer-safe randomized items without provider work", async () => {
    const harness = await PaidRuntimeHarness.create();
    harness.markAllReviewReady();
    const runtime = createNovelSkillPaidEvaluationRuntime(harness.options());

    await expect(runtime.initialize()).resolves.toMatchObject({
      phase: "awaiting_blind_review",
      completedProviderCalls: 192,
    });
    const opened = await runtime.beginBlindReview(RUN_ID);
    expect(opened.phase).toBe("blind_reviewing");
    expect(opened.blindItem).toEqual({
      blindItemId: "blind-review-item-0001",
      randomizedPosition: 1,
      fixtureLabel: "fixture task 1",
      boundaries: ["keep boundary"],
      lockedFacts: ["keep fact"],
      requestedOutcome: "continue scene",
      candidateText: "candidate output 1",
    });
    expect(Object.keys(opened.blindItem ?? {}).sort()).toEqual([
      "blindItemId",
      "boundaries",
      "candidateText",
      "fixtureLabel",
      "lockedFacts",
      "randomizedPosition",
      "requestedOutcome",
    ]);

    const next = await runtime.sealBlindScores({
      runId: RUN_ID,
      blindItemId: "blind-review-item-0001",
      scores: scores(0.75),
    });
    expect(next.blindItem?.blindItemId).toBe("blind-review-item-0002");
    expect(harness.providerCalls).toBe(0);
    expect(harness.sealedBlindIds).toEqual(new Set(["blind-review-item-0001"]));
  });

  it("completes locally when all blinded receipts were sealed before a restart", async () => {
    const harness = await PaidRuntimeHarness.create();
    harness.markAllReviewReady();
    harness.blindItems.forEach(({ blindItemId }) => harness.sealedBlindIds.add(blindItemId));
    const runtime = createNovelSkillPaidEvaluationRuntime(harness.options());

    await expect(runtime.beginBlindReview(RUN_ID)).resolves.toMatchObject({
      phase: "completed",
      blindItem: null,
      completedProviderCalls: 192,
      sealedManualScores: 2_496,
    });
    expect(harness.providerCalls).toBe(0);
    expect(harness.status).toBe("completed");
  });
});

type MutableCell = Omit<NovelSkillEvaluationCellRecord, "state" | "evidenceCollected"> & {
  state: NovelSkillEvaluationCellRecord["state"];
  evidenceCollected: boolean;
};

class PaidRuntimeHarness {
  public runExists = false;
  public status: NovelSkillPaidEvaluationControlSnapshot["status"] = "planned";
  public protocolConfigured = false;
  public authorizationId: string | null = null;
  public authorizationInput: AuthorizeNovelSkillPaidEvaluationRunInput | null = null;
  public preparationCalls: Readonly<{
    runId: string;
    exactTargetIds: readonly [string, string];
  }>[] = [];
  public readonly reservations: NovelSkillPaidEvaluationControlReservation[] = [];
  public readonly reserveInputs: ReserveAndBindNovelSkillPaidEvaluationDispatchInput[] = [];
  public readonly inspectedMessages: InspectModelHubExactEvaluationTargetInput["messages"][] = [];
  public readonly executedMessages: ExecuteModelHubExactEvaluationTargetInput["messages"][] = [];
  public readonly skillSnapshotCommits: unknown[] = [];
  public readonly blindItems: readonly StoredBlindReviewItem[] = createBlindItems();
  public readonly sealedBlindIds = new Set<string>();
  public quoteCalls = 0;
  public recoveryCalls = 0;
  public repairCalls = 0;
  public inspectCalls = 0;
  public providerCalls = 0;
  public executionAuthorityGate: Promise<void> | null = null;
  private idCounter = 1000;

  private constructor(public readonly cells: MutableCell[]) {}

  public static async create(): Promise<PaidRuntimeHarness> {
    return new PaidRuntimeHarness(await fixedCells());
  }

  public options(): NovelSkillPaidEvaluationRuntimeOptions {
    const evaluationStore = {
      beginAttempt: async () => 1,
      completeRun: async () => {
        this.status = "completed";
      },
      finishAttempt: async () => undefined,
      getRunProgress: async () => this.progress(),
      invalidateRun: async () => {
        this.status = "invalidated";
      },
      listRunCells: async () => this.cells,
      repairSettledObservation: async (input: { readonly cellId: string }) => {
        this.repairCalls += 1;
        const cell = this.cells.find(({ id }) => id === input.cellId);
        if (cell === undefined) throw new Error("cell missing");
        const settled = this.reservations.some(
          (reservation) => reservation.cellId === cell.id && reservation.state === "settled",
        );
        if (!settled) throw new Error("settlement missing");
        cell.evidenceCollected = true;
        cell.state = "observed";
      },
    } as unknown as NovelSkillPaidEvaluationRuntimeOptions["evaluationStore"];
    const paidStore = {
      authorizeCommercialRun: async (input: AuthorizeNovelSkillPaidEvaluationRunInput) => {
        this.authorizationInput = input;
        this.authorizationId = input.authorizationId;
        return QUOTE;
      },
      markDispatchAmbiguous: async (reservationId: string) =>
        this.transitionReservation(reservationId, "ambiguous"),
      markDispatchStarted: async (reservationId: string) =>
        this.transitionReservation(reservationId, "dispatched"),
      markNotDispatched: async (reservationId: string) =>
        this.transitionReservation(reservationId, "not_dispatched"),
      quoteCommercialRun: async () => {
        this.quoteCalls += 1;
        if (this.status !== "planned") throw new Error("running runs cannot be quoted");
        return QUOTE;
      },
      recoverInterruptedDispatches: async () => {
        this.recoveryCalls += 1;
        return { released: 0, ambiguous: 0 };
      },
      reserveAndBindAttemptDispatch: async (
        input: ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
      ) => {
        this.reserveInputs.push(input);
        const reservation: NovelSkillPaidEvaluationControlReservation = {
          reservationId: input.reservation.reservationId,
          runId: input.reservation.runId,
          cellId: input.reservation.cellId,
          attemptId: input.reservation.attemptId,
          modelSlotId: input.reservation.modelSlotId,
          dispatchGeneration: input.reservation.dispatchGeneration,
          state: "bound",
          plannedContextTraceId: input.reservation.plannedContextTraceId,
          plannedModelInvocationId: input.reservation.plannedModelInvocationId,
          plannedCandidateId: input.reservation.plannedCandidateId,
          currency: input.reservation.receipt.currency,
          reservedMaximumCostMicros: input.reservation.receipt.estimatedMaximumCostMicros,
          exactPredispatchEstimatedMaximumCostMicros:
            input.reservation.receipt.estimatedMaximumCostMicros,
          authoritySnapshotHash: HASH.quote,
          providerReceiptShapeHash: HASH.artifactA,
          finalDispatchAuthorityHash: HASH.artifactB,
          actualCostMicros: null,
          settlementOutcome: null,
          settlementReceiptHash: null,
          visibleOutputHash: null,
          outputCandidateId: null,
          reservedAt: input.reservation.reservedAt,
          boundAt: input.boundAt,
          dispatchedAt: null,
          terminalAt: null,
          revision: 2,
        };
        this.reservations.push(reservation);
        return reservationRecord(reservation);
      },
      settleDispatchSuccess: async (input: SettleNovelSkillPaidEvaluationSuccessInput) => {
        const reservation = this.requiredReservation(input.reservationId);
        Object.assign(reservation, {
          state: "settled" as const,
          revision: reservation.revision + 1,
          actualCostMicros: input.result.estimatedActualCostMicros,
          settlementOutcome: "succeeded" as const,
          settlementReceiptHash: input.result.visibleOutputHash,
          visibleOutputHash: input.result.visibleOutputHash,
          outputCandidateId: input.candidate.id,
          terminalAt: input.completedAt,
        });
        return reservationRecord(reservation);
      },
      startAuthorizedRun: async () => {
        if (this.authorizationId === null || this.status !== "planned") {
          throw new Error("not startable");
        }
        this.status = "running";
      },
    } as unknown as NovelSkillPaidEvaluationRuntimeOptions["paidStore"];
    const controlStore = {
      createBlindReviewBatch: async () => undefined,
      getControlSnapshot: async () => (this.runExists ? this.controlSnapshot() : null),
      getNextBlindReviewItem: async () =>
        this.blindItems.find(({ blindItemId }) => !this.sealedBlindIds.has(blindItemId)) ?? null,
      listReservations: async () => this.reservations,
      listTargets: async () => TARGETS,
      readExecutionAuthority: async () => {
        if (this.executionAuthorityGate !== null) await this.executionAuthorityGate;
        return this.protocolConfigured
          ? {
              runId: RUN_ID,
              status: this.status,
              protocolHash: HASH.protocol,
              authorizationId: this.authorizationId,
              quoteHash: this.authorizationId === null ? null : HASH.quote,
            }
          : null;
      },
      readBlindReviewBatch: async () => this.blindItems,
      sealBlindScores: async (input: { readonly blindItemId: string }) => {
        this.sealedBlindIds.add(input.blindItemId);
      },
    } as unknown as NovelSkillPaidEvaluationRuntimeOptions["controlStore"];
    return {
      runId: RUN_ID,
      reviewerId: "local-reviewer",
      clock: { now: () => NOW },
      ids: {
        next: (kind) => (kind === "authorization" ? AUTHORIZATION_ID : uuid(this.idCounter++)),
      },
      evaluationStore,
      paidStore,
      controlStore,
      novelSkillStore: {
        commitInvocationBeforeDispatch: async (input: unknown) => {
          this.skillSnapshotCommits.push(input);
        },
      } as unknown as NovelSkillPaidEvaluationRuntimeOptions["novelSkillStore"],
      exactTargetDependencies: {
        modelHub: {},
        modelGateway: { available: true, generate: vi.fn() },
        credentials: { getSummary: async () => ({ configured: true }) },
        clock: { now: () => NOW },
      } as unknown as NovelSkillPaidEvaluationRuntimeOptions["exactTargetDependencies"],
      requestProfileForTask: (task) => ({
        version: MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
        task,
        maximumInputTokens: 100_000,
        maximumOutputTokens: 64,
        temperatureBasisPoints: 0,
        topPBasisPoints: 10_000,
        reasoningMode: "disabled",
        responseFormat: "text",
        streaming: true,
        stopPolicyHash: MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
        providerCallPolicy: "single_attempt",
      }),
      contextBaselineTokenBudget: 100_000,
      preferencePort: {
        listFrozenPreferenceSources: async () => [
          {
            sourceId: "evaluation-preference",
            sourceVersionId: null,
            preferenceText: "保持克制的叙述语气，并保留明确的动作因果。",
          },
        ],
      },
      preparationPort: {
        preparePersistedRun: async (input) => {
          this.preparationCalls.push(input);
          this.runExists = true;
          this.protocolConfigured = true;
        },
      },
      exactTargetPort: {
        inspect: async (_dependencies, input) => this.inspect(input),
        execute: async (_dependencies, input) => this.execute(input),
      },
    };
  }

  public firstObservedCell(): MutableCell {
    const cell = this.cells.find(({ evidenceCollected }) => evidenceCollected);
    if (cell === undefined) throw new Error("observed cell missing");
    return cell;
  }

  public markAllReviewReady(): void {
    this.runExists = true;
    this.protocolConfigured = true;
    this.authorizationId = AUTHORIZATION_ID;
    this.status = "running";
    this.reservations.splice(0, this.reservations.length);
    this.cells.forEach((cell, index) => {
      cell.evidenceCollected = true;
      cell.state = "observed";
      this.reservations.push({
        reservationId: uuid(30_000 + index),
        runId: RUN_ID,
        cellId: cell.id,
        attemptId: uuid(40_000 + index),
        modelSlotId: cell.modelSlotId,
        dispatchGeneration: 1,
        state: "settled",
        plannedContextTraceId: uuid(50_000 + index),
        plannedModelInvocationId: uuid(60_000 + index),
        plannedCandidateId: uuid(70_000 + index),
        currency: "USD",
        reservedMaximumCostMicros: "1000",
        exactPredispatchEstimatedMaximumCostMicros: "1000",
        authoritySnapshotHash: HASH.quote,
        providerReceiptShapeHash: HASH.artifactA,
        finalDispatchAuthorityHash: HASH.artifactB,
        actualCostMicros: "100",
        settlementOutcome: "succeeded",
        settlementReceiptHash: HASH.quote,
        visibleOutputHash: HASH.quote,
        outputCandidateId: uuid(70_000 + index),
        reservedAt: NOW,
        boundAt: NOW,
        dispatchedAt: NOW,
        terminalAt: NOW,
        revision: 4,
      });
    });
  }

  private async inspect(
    input: InspectModelHubExactEvaluationTargetInput,
  ): Promise<ModelHubExactEvaluationInspection> {
    this.inspectCalls += 1;
    this.inspectedMessages.push(input.messages);
    const target = TARGETS.find(({ connectionId }) => connectionId === input.target.connectionId);
    if (target === undefined) throw new Error("target missing");
    const requestProfileHash = await hashModelHubExactEvaluationRequestProfile(
      input.requestProfile,
    );
    const messagePayloadHash = await hashModelHubExactEvaluationMessages(input.messages);
    return {
      target: {
        ...input.target,
        connectionRevision: target.connectionRevision,
        catalogRevision: target.catalogRevision,
        costPrivacyRevision: 1,
        capabilityEvidenceHash: HASH.capability,
        costProfileHash: target.pricingSnapshotHash,
        targetIdentityHash: target.targetHash,
      },
      requestProfile: input.requestProfile,
      requestProfileHash,
      messagePayloadHash,
      payloadHash: await sha256Hex(`payload/${messagePayloadHash}/${target.targetHash}`),
      executionLockHash: await sha256Hex(`lock/${messagePayloadHash}/${target.targetHash}`),
      requiredCapabilities: ["text_generation"],
      dataDestination: "remote",
      estimatedInputTokens: 100,
      estimatedTotalTokens: 164,
      inputTokenLimit: 100_000,
      outputTokenLimit: 64,
      pricing: {
        currency: target.currency,
        estimatedMaximumCostMicros: "1000",
        pricingVersion: target.pricingVersion,
        priceUpdatedAt: NOW,
        evidenceSource: "provider_metadata",
        evidenceVersion: "fixture@1",
        evidenceUpdatedAt: NOW,
      },
    };
  }

  private async execute(
    input: ExecuteModelHubExactEvaluationTargetInput,
  ): Promise<ModelHubExactEvaluationExecutionResult> {
    this.executedMessages.push(input.messages);
    const receipt: ModelHubExactEvaluationPredispatchReceipt = {
      generationId: input.generationId,
      target: input.inspection.target,
      requestProfileHash: input.inspection.requestProfileHash,
      messagePayloadHash: input.inspection.messagePayloadHash,
      payloadHash: input.inspection.payloadHash,
      executionLockHash: input.inspection.executionLockHash,
      currency: input.inspection.pricing.currency,
      estimatedMaximumCostMicros: input.inspection.pricing.estimatedMaximumCostMicros,
      dataDestination: input.inspection.dataDestination,
    };
    await input.reserveAndBindBeforeDispatch(receipt);
    input.assertBeforeProviderDispatch();
    await input.markDispatchStarted(receipt);
    input.assertBeforeProviderDispatch();
    this.providerCalls += 1;
    const text = `candidate-${String(this.providerCalls)}`;
    return {
      text,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
      streamed: true,
      visibleOutputHash: await sha256Hex(text),
      visibleContentLength: text.length,
      estimatedActualCostMicros: "100",
      currency: input.inspection.pricing.currency,
      dataDestination: input.inspection.dataDestination,
      target: input.inspection.target,
      requestProfileHash: input.inspection.requestProfileHash,
      messagePayloadHash: input.inspection.messagePayloadHash,
      payloadHash: input.inspection.payloadHash,
      executionLockHash: input.inspection.executionLockHash,
    };
  }

  private controlSnapshot(): NovelSkillPaidEvaluationControlSnapshot {
    const counts = {
      reserved: this.reservations.filter(({ state }) => state === "reserved").length,
      bound: this.reservations.filter(({ state }) => state === "bound").length,
      dispatched: this.reservations.filter(({ state }) => state === "dispatched").length,
      settled: this.reservations.filter(({ state }) => state === "settled").length,
      ambiguous: this.reservations.filter(({ state }) => state === "ambiguous").length,
      notDispatched: this.reservations.filter(({ state }) => state === "not_dispatched").length,
    };
    const observed = this.cells.filter(({ evidenceCollected }) => evidenceCollected).length;
    return {
      runId: RUN_ID,
      suiteId: SUITE_ID,
      status: this.status,
      evaluationStatus: "NOT_EVALUATED",
      revision: 1,
      protocolConfigured: this.protocolConfigured,
      exactTargetCount: this.protocolConfigured ? 2 : 0,
      authorizationId: this.authorizationId,
      authorizedCallCount: this.authorizationId === null ? null : 192,
      totalCells: this.cells.length,
      observedCells: observed,
      observationCount: observed,
      reservationCounts: counts,
      authoritySnapshotCount: this.reservations.length,
      missingAuthoritySnapshotCount: 0,
      successfulSettlements: counts.settled,
      blindItemCount: this.sealedBlindIds.size > 0 ? 192 : 0,
      blindReceiptCount: this.sealedBlindIds.size,
      sealedScoreCount: this.sealedBlindIds.size * 13,
      startedAt: this.status === "running" ? NOW : null,
      completedAt: this.status === "completed" ? NOW : null,
      createdAt: NOW,
    };
  }

  private progress(): NovelSkillEvaluationRunProgress {
    const observed = this.cells.filter(({ evidenceCollected }) => evidenceCollected).length;
    return {
      id: RUN_ID,
      suiteId: SUITE_ID,
      status: this.status,
      evaluationStatus: "NOT_EVALUATED",
      evaluationResultHash: null,
      revision: 1,
      evaluationProjectId: PROJECT_ID,
      totalCells: this.cells.length,
      evidenceCollectedCells: observed,
      scoredCells: 0,
    };
  }

  private transitionReservation(
    reservationId: string,
    state: NovelSkillPaidEvaluationControlReservation["state"],
  ): NovelSkillPaidEvaluationReservationRecord {
    const reservation = this.requiredReservation(reservationId);
    Object.assign(reservation, { state, revision: reservation.revision + 1 });
    if (state === "ambiguous") this.status = "invalidated";
    return reservationRecord(reservation);
  }

  private requiredReservation(id: string): NovelSkillPaidEvaluationControlReservation {
    const reservation = this.reservations.find(({ reservationId }) => reservationId === id);
    if (reservation === undefined) throw new Error("reservation missing");
    return reservation;
  }
}

const QUOTE: NovelSkillPaidEvaluationQuote = Object.freeze({
  runId: RUN_ID,
  protocolHash: HASH.protocol,
  targetManifestHash: HASH.targetManifest,
  pricingManifestHash: HASH.pricingManifest,
  quoteHash: HASH.quote,
  authorizedCallCount: 192,
  currencies: Object.freeze([
    Object.freeze({ currency: "USD", estimatedMaximumCostMicros: "192000" }),
  ]),
});

const TARGETS: readonly NovelSkillPaidEvaluationControlTarget[] = Object.freeze([
  target(
    "text_tier_a",
    "connection-a",
    "catalog-a",
    "model-a",
    HASH.targetA,
    HASH.artifactA,
    HASH.pricingA,
  ),
  target(
    "text_tier_b",
    "connection-b",
    "catalog-b",
    "model-b",
    HASH.targetB,
    HASH.artifactB,
    HASH.pricingB,
  ),
]);

function target(
  modelSlotId: "text_tier_a" | "text_tier_b",
  connectionId: string,
  catalogEntryId: string,
  providerModelId: string,
  targetHash: string,
  modelArtifactHash: string,
  pricingSnapshotHash: string,
): NovelSkillPaidEvaluationControlTarget {
  return Object.freeze({
    runId: RUN_ID,
    modelSlotId,
    connectionId,
    catalogEntryId,
    providerKind: "deepseek",
    connectionProtocol: "openai_compatible",
    connectionRevision: 1,
    catalogRevision: 1,
    providerModelId,
    modelIdentityHash: targetHash,
    modelArtifactHash,
    targetHash,
    currency: "USD",
    inputMicrosPerMillionTokens: "1000",
    outputMicrosPerMillionTokens: "2000",
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "fixture@1",
    pricingSnapshotHash,
  });
}

async function fixedCells(): Promise<MutableCell[]> {
  const fixtures = new Map(
    listNovelSkillEvaluationFixtures().map((fixture) => [fixture.fixtureId, fixture]),
  );
  const plan = createNovelSkillEvaluationExecutionPlan([
    { slotId: "text_tier_a", modelTier: "tier-a" },
    { slotId: "text_tier_b", modelTier: "tier-b" },
  ]);
  return Promise.all(
    plan.cells.map(async (planned, index) => {
      const fixture = fixtures.get(planned.fixtureId);
      if (fixture === undefined) throw new Error("fixture missing");
      return {
        id: uuid(10_000 + index),
        fixtureId: fixture.fixtureId,
        taskType: fixture.taskType,
        invocationMode: fixture.invocationMode,
        genreTags: fixture.genreTags,
        fixtureInputContentHash: await sha256Hex(fixture.input),
        arm: planned.arm,
        modelSlotId: planned.modelSlotId,
        modelTier: planned.modelTier,
        repetition: planned.repetition,
        state: "planned",
        evidenceCollected: false,
        attemptCount: 0,
        latestAttemptId: null,
        latestAttemptStatus: null,
        latestAttemptStartedAt: null,
        latestAttemptContextTraceId: null,
        latestAttemptModelInvocationId: null,
      } satisfies MutableCell;
    }),
  );
}

function reservationRecord(
  reservation: NovelSkillPaidEvaluationControlReservation,
): NovelSkillPaidEvaluationReservationRecord {
  return {
    id: reservation.reservationId,
    runId: reservation.runId,
    cellId: reservation.cellId,
    attemptId: reservation.attemptId,
    state: reservation.state,
    plannedContextTraceId: reservation.plannedContextTraceId,
    plannedModelInvocationId: reservation.plannedModelInvocationId,
    plannedCandidateId: reservation.plannedCandidateId,
    revision: reservation.revision,
  };
}

function recoverable(runId: string): NovelSkillPaidEvaluationRecoverableRun {
  return {
    runId,
    status: "planned",
    revision: 1,
    authorizationId: null,
    authorizedCallCount: null,
    completedProviderCalls: 0,
    observationCount: 0,
    blindReceiptCount: 0,
    reservationCounts: {
      reserved: 0,
      bound: 0,
      dispatched: 0,
      settled: 0,
      ambiguous: 0,
      notDispatched: 0,
    },
    recoveryKind: "preflight_or_authorization",
    requiresManualDispatchDecision: false,
    startedAt: null,
    createdAt: NOW,
  };
}

function scores(value: number): Readonly<Record<NovelSkillEvaluationMetric, number>> {
  return {
    instruction_following: value,
    canon_preservation: value,
    character_consistency: value,
    pov_preservation: value,
    causal_progression: value,
    scene_function: value,
    dialogue_distinction: value,
    specificity: value,
    repetition_cliche_control: value,
    pacing: value,
    user_preference: value,
    unnecessary_rewrite_avoidance: value,
    evidence_completeness: value,
  };
}

function createBlindItems(): readonly StoredBlindReviewItem[] {
  const emptyScores = Object.fromEntries(
    Object.keys(scores(0)).map((metric) => [metric, null]),
  ) as Readonly<Record<NovelSkillEvaluationMetric, null>>;
  return Object.freeze(
    Array.from({ length: 192 }, (_, index) => {
      const position = index + 1;
      return Object.freeze({
        blindItemId: `blind-review-item-${String(position).padStart(4, "0")}`,
        position,
        fixtureTaskContent: `fixture task ${String(position)}`,
        boundaries: Object.freeze(["keep boundary"]),
        lockedFacts: Object.freeze(["keep fact"]),
        requestedOutcome: "continue scene",
        candidateOutput: `candidate output ${String(position)}`,
        scores: emptyScores,
      });
    }),
  );
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
