import { parseUuidV7 } from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS } from "../infrastructure/creative-opening-service";
import {
  openingJourneySupportNumber,
  readOpeningJourneyRun,
} from "../infrastructure/opening-journey-run";
import {
  readSafeOperationIncidents,
  resetSafeOperationDiagnosticsForTests,
} from "../infrastructure/safe-operation-diagnostics";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { IdeaJourneyPage } from "./idea-journey-page";

const ASYNC_UI_TIMEOUT = Object.freeze({ timeout: 15_000 });

describe("C3 opening journey durability regressions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSafeOperationDiagnosticsForTests();
    window.localStorage.setItem("inkshadow.professional-create-recovery.v1", "{}");
  });

  it("takes a synchronous lock so one commit-cycle double activation creates one provider journey", async () => {
    const harness = createProviderRuntime();
    const createJourney = vi.spyOn(harness.runtime.creativeJourneys, "create");
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "两名修表匠同时收到一只来自明天的怀表。",
    );
    const startButton = screen.getByRole("button", { name: "生成第一段" });

    await act(async () => {
      startButton.click();
      startButton.click();
      await Promise.resolve();
    });

    expect(await screen.findByRole("dialog", { name: "生成首批三个开头" })).toBeVisible();
    expect(createJourney).toHaveBeenCalledTimes(1);
    expect(await harness.runtime.creativeJourneys.listActive("idea")).toHaveLength(1);
  }, 30_000);

  it("safely cancels a confirmation-stage journey after a process restart without dispatch", async () => {
    const firstHarness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(firstHarness.runtime);
    await connectOllama(user);
    firstHarness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一座山城的路灯每天凌晨交换彼此的影子。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    expect(await screen.findByRole("dialog", { name: "生成首批三个开头" })).toBeVisible();
    const [waiting] = await firstHarness.runtime.creativeJourneys.listActive("idea");
    const waitingRun = readOpeningJourneyRun(waiting?.snapshot.openingRun);
    if (waiting === undefined || waitingRun === null) {
      throw new Error("没有保存等待确认的开书旅程。");
    }
    expect(waitingRun.stage).toBe("awaiting_confirmation");
    const persistedAtCrash = new Map<string, string>();
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null) {
        const value = window.localStorage.getItem(key);
        if (value !== null) persistedAtCrash.set(key, value);
      }
    }

    first.unmount();
    await waitFor(async () => {
      const cleanedUp = await firstHarness.runtime.creativeJourneys.findById(waiting.id);
      expect(readOpeningJourneyRun(cleanedUp?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
    });
    window.localStorage.clear();
    for (const [key, value] of persistedAtCrash) window.localStorage.setItem(key, value);

    const restartedHarness = createProviderRuntime();
    restartedHarness.generate.mockClear();
    renderJourney(restartedHarness.runtime);
    const heading = await screen.findByRole("heading", {
      name: "一座山城的路灯每天凌晨交换彼此的影子。",
      level: 3,
    });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("没有找到重启后的开书恢复卡片。");
    await user.click(within(card).getByRole("button", { name: "继续这次构思" }));

    await waitFor(async () => {
      const recovered = await restartedHarness.runtime.creativeJourneys.findById(waiting.id);
      const recoveredRun = readOpeningJourneyRun(recovered?.snapshot.openingRun);
      expect(recoveredRun).toMatchObject({
        stage: "cancelled_before_confirmation",
        supportId: waitingRun.supportId,
        autoRetryCount: 0,
      });
      const task = (await restartedHarness.runtime.taskCenter.load()).tasks.find(
        ({ id }) => id === waitingRun.taskId,
      );
      expect(task).toMatchObject({ status: "cancelled", maxAttempts: 1 });
    });
    expect(screen.getByText("确认前离开，未确认的生成批次已安全终止")).toBeVisible();
    expect(restartedHarness.generate).not.toHaveBeenCalled();
    expect(
      await Promise.all(
        waitingRun.requestIds.map((requestId) =>
          restartedHarness.runtime.modelHub.findInvocation(requestId),
        ),
      ),
    ).toEqual([null, null, null]);
  }, 30_000);

  it("shows the existing support number and preserves a mismatched idempotent task without dispatch", async () => {
    const firstHarness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(firstHarness.runtime);
    await connectOllama(user);
    firstHarness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一间气象站只记录从未抵达这座岛的暴风雨。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    expect(await screen.findByRole("dialog", { name: "生成首批三个开头" })).toBeVisible();
    const [waiting] = await firstHarness.runtime.creativeJourneys.listActive("idea");
    const waitingRun = readOpeningJourneyRun(waiting?.snapshot.openingRun);
    if (waiting === undefined || waitingRun === null) {
      throw new Error("没有保存待恢复的开书旅程。");
    }
    first.unmount();
    await waitFor(async () => {
      const cleanedUp = await firstHarness.runtime.creativeJourneys.findById(waiting.id);
      expect(readOpeningJourneyRun(cleanedUp?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
    });
    const cleanedUp = await firstHarness.runtime.creativeJourneys.findById(waiting.id);
    if (cleanedUp === null) throw new Error("取消后的开书旅程意外缺失。");
    const restoredWaiting = Object.freeze({
      ...waiting,
      revision: cleanedUp.revision + 1,
      updatedAt: firstHarness.runtime.clock.now(),
    });
    await firstHarness.runtime.creativeJourneys.update(restoredWaiting, cleanedUp.revision);

    const wrongSupportId = firstHarness.runtime.ids.next();
    const originalTaskCenter = firstHarness.runtime.taskCenter;
    const mismatchedTaskCenter = new Proxy(originalTaskCenter, {
      get(target, property) {
        if (property === "findTaskByIdempotencyKey") {
          return async (idempotencyKey: string) => {
            const task = await target.findTaskByIdempotencyKey(idempotencyKey);
            return task === null
              ? null
              : Object.freeze({
                  ...task,
                  metadata: Object.freeze({ ...task.metadata, supportId: wrongSupportId }),
                });
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
    const restartedRuntime: DesktopRuntime = Object.freeze({
      ...firstHarness.runtime,
      taskCenter: mismatchedTaskCenter,
    });
    const taskStateBeforeResume = await originalTaskCenter.load();
    const journeyBeforeResume = await firstHarness.runtime.creativeJourneys.findById(waiting.id);

    renderJourney(restartedRuntime);
    const heading = await screen.findByRole("heading", {
      name: "一间气象站只记录从未抵达这座岛的暴风雨。",
      level: 3,
    });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("没有找到任务错配的恢复卡片。");
    await user.click(within(card).getByRole("button", { name: "继续这次构思" }));

    expect(
      await screen.findByText(
        "已有开书任务与当前构思批次不一致。墨影已停止继续处理，不会复用、改写或自动重发。",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(new RegExp(openingJourneySupportNumber(waitingRun), "u")),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent(waitingRun.supportId);
    expect(screen.getByRole("button", { name: "重试读取" })).toBeEnabled();
    expect(screen.queryByText(new RegExp(wrongSupportId, "u"))).not.toBeInTheDocument();
    expect(firstHarness.generate).not.toHaveBeenCalled();
    expect(await originalTaskCenter.load()).toEqual(taskStateBeforeResume);
    expect(await restartedRuntime.creativeJourneys.findById(waiting.id)).toEqual(
      journeyBeforeResume,
    );
    expect(
      await Promise.all(
        waitingRun.requestIds.map((requestId) =>
          restartedRuntime.modelHub.findInvocation(requestId),
        ),
      ),
    ).toEqual([null, null, null]);
  }, 30_000);

  it("finishes confirmation cancellation when the page exits during a preflight checkpoint", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const originalUpdate = harness.runtime.creativeJourneys.update.bind(
      harness.runtime.creativeJourneys,
    );
    let releasePreflight!: () => void;
    let preflightHeld = false;
    let markPreflightReached: (() => void) | null = null;
    const preflightReached = new Promise<void>((resolve) => {
      markPreflightReached = resolve;
    });
    vi.spyOn(harness.runtime.creativeJourneys, "update").mockImplementation(
      (record, expectedRevision, turn) => {
        const run = readOpeningJourneyRun(record.snapshot.openingRun);
        if (run?.stage === "preflight" && !preflightHeld) {
          preflightHeld = true;
          markPreflightReached?.();
          return new Promise<void>((resolve, reject) => {
            releasePreflight = () => {
              originalUpdate(record, expectedRevision, turn).then(resolve, reject);
            };
          });
        }
        return originalUpdate(record, expectedRevision, turn);
      },
    );
    const first = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "海边旅馆每到退潮就多出一间无人登记的客房。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await preflightReached;
    expect(screen.queryByRole("dialog", { name: "生成首批三个开头" })).not.toBeInTheDocument();
    const [waiting] = await harness.runtime.creativeJourneys.listActive("idea");
    const initialRun = readOpeningJourneyRun(waiting?.snapshot.openingRun);
    if (waiting === undefined || initialRun === null) {
      throw new Error("没有形成可控的发送前检查写入。");
    }

    first.unmount();
    releasePreflight();

    await waitFor(async () => {
      const recovered = await harness.runtime.creativeJourneys.findById(waiting.id);
      expect(readOpeningJourneyRun(recovered?.snapshot.openingRun)).toMatchObject({
        stage: "cancelled_before_confirmation",
        supportId: initialRun.supportId,
      });
      const task = (await harness.runtime.taskCenter.load()).tasks.find(
        ({ id }) => id === initialRun.taskId,
      );
      expect(task).toMatchObject({ status: "cancelled", maxAttempts: 1 });
    });
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("recovers an interrupted atomic confirmation cancellation without clearing pending slots first", async () => {
    const firstHarness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(firstHarness.runtime);
    await connectOllama(user);
    firstHarness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一所停课的学校每天仍会响起来自未来的下课铃。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    expect(await screen.findByRole("dialog", { name: "生成首批三个开头" })).toBeVisible();
    const [waiting] = await firstHarness.runtime.creativeJourneys.listActive("idea");
    const waitingRun = readOpeningJourneyRun(waiting?.snapshot.openingRun);
    if (waiting === undefined || waitingRun === null) {
      throw new Error("没有保存待取消的开书旅程。");
    }

    const originalUpdate = firstHarness.runtime.creativeJourneys.update.bind(
      firstHarness.runtime.creativeJourneys,
    );
    let cleanupWriteCount = 0;
    let cancellationWriteFailed = false;
    const update = vi
      .spyOn(firstHarness.runtime.creativeJourneys, "update")
      .mockImplementation((record, expectedRevision, turn) => {
        cleanupWriteCount += 1;
        const run = readOpeningJourneyRun(record.snapshot.openingRun);
        if (!cancellationWriteFailed && run?.stage === "cancelled_before_confirmation") {
          cancellationWriteFailed = true;
          return Promise.reject(new Error("simulated process stop during cancellation write"));
        }
        return originalUpdate(record, expectedRevision, turn);
      });

    first.unmount();
    await waitFor(() => expect(cancellationWriteFailed).toBe(true));
    update.mockRestore();
    expect(cleanupWriteCount).toBe(1);

    const restartedHarness = createProviderRuntime();
    restartedHarness.generate.mockClear();
    renderJourney(restartedHarness.runtime);
    const heading = await screen.findByRole("heading", {
      name: "一所停课的学校每天仍会响起来自未来的下课铃。",
      level: 3,
    });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("没有找到取消中断后的恢复卡片。");
    await user.click(within(card).getByRole("button", { name: "继续这次构思" }));

    await waitFor(async () => {
      const recovered = await restartedHarness.runtime.creativeJourneys.findById(waiting.id);
      expect(readOpeningJourneyRun(recovered?.snapshot.openingRun)).toMatchObject({
        stage: "cancelled_before_confirmation",
        supportId: waitingRun.supportId,
        autoRetryCount: 0,
      });
      const task = (await restartedHarness.runtime.taskCenter.load()).tasks.find(
        ({ id }) => id === waitingRun.taskId,
      );
      expect(task).toMatchObject({ status: "cancelled", maxAttempts: 1 });
    });
    expect(restartedHarness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("persists invocation reservation before waiting and classifies dispatch only from the invocation ledger", async () => {
    const harness = createProviderRuntime();
    const originalUpdate = harness.runtime.creativeJourneys.update.bind(
      harness.runtime.creativeJourneys,
    );
    const observedStages: string[] = [];
    const waitingDispatchReceipts: (readonly (string | null)[])[] = [];
    let reservationCount = 0;
    let releaseFinalReservation!: () => void;
    vi.spyOn(harness.runtime.creativeJourneys, "update").mockImplementation(
      async (record, expectedRevision, turn) => {
        const run = readOpeningJourneyRun(record.snapshot.openingRun);
        if (run !== null) {
          observedStages.push(run.stage);
          if (run.stage === "provider_waiting") {
            const invocations = await Promise.all(
              run.requestIds.map((requestId) => harness.runtime.modelHub.findInvocation(requestId)),
            );
            waitingDispatchReceipts.push(
              Object.freeze(
                invocations
                  .filter((invocation) => invocation !== null)
                  .map((invocation) => invocation.providerDispatchStartedAt),
              ),
            );
          }
        }
        await originalUpdate(record, expectedRevision, turn);
      },
    );
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    const originalStartInvocation = harness.runtime.modelHub.startInvocation.bind(
      harness.runtime.modelHub,
    );
    vi.spyOn(harness.runtime.modelHub, "startInvocation").mockImplementation(async (input) => {
      reservationCount += 1;
      if (reservationCount === 3) {
        await new Promise<void>((resolve) => {
          releaseFinalReservation = resolve;
        });
      }
      return originalStartInvocation(input);
    });
    const releases: (() => void)[] = [];
    harness.generate.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          releases.push(() => {
            resolve({ text: `供应商开头 ${input.generationId}`, usage: null });
          });
        }),
    );
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "沉睡百年的邮局突然开始投递尚未写出的信。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(within(dialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }));
    await waitFor(() => expect(document.body).toHaveTextContent("正在保存本次生成信息"));
    expect(harness.generate).not.toHaveBeenCalled();
    releaseFinalReservation();

    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3), {
      timeout: 15_000,
    });
    await waitFor(() => expect(document.body).toHaveTextContent("已向所选服务发送，正在等待结果"));
    const confirmedIndex = observedStages.indexOf("confirmed");
    const reservingIndex = observedStages.indexOf("invocation_reserving");
    const waitingIndex = observedStages.indexOf("provider_waiting");
    expect(confirmedIndex).toBeGreaterThanOrEqual(0);
    expect(reservingIndex).toBeGreaterThan(confirmedIndex);
    expect(waitingIndex).toBeGreaterThan(reservingIndex);
    expect(waitingDispatchReceipts.length).toBeGreaterThan(0);
    expect(waitingDispatchReceipts[0]?.length).toBeGreaterThan(0);
    expect(waitingDispatchReceipts[0]?.every((receipt) => receipt !== null)).toBe(true);

    const [active] = await harness.runtime.creativeJourneys.listActive("idea");
    const run = readOpeningJourneyRun(active?.snapshot.openingRun);
    const invocations = await Promise.all(
      (run?.requestIds ?? []).map((requestId) =>
        harness.runtime.modelHub.findInvocation(requestId),
      ),
    );
    expect(invocations).toHaveLength(3);
    expect(
      invocations.every(
        (invocation) => invocation !== null && invocation.providerDispatchStartedAt !== null,
      ),
    ).toBe(true);

    releases.forEach((release) => release());
    await waitFor(async () => {
      const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
      expect(readOpeningJourneyRun(settled?.snapshot.openingRun)?.stage).toBe("completed");
    });
  }, 30_000);

  it("settles all three slots with zero sends when the second invocation reservation fails", async () => {
    const harness = createProviderRuntime();
    let reservationCount = 0;
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    const originalStartInvocation = harness.runtime.modelHub.startInvocation.bind(
      harness.runtime.modelHub,
    );
    vi.spyOn(harness.runtime.modelHub, "startInvocation").mockImplementation((input) => {
      reservationCount += 1;
      return reservationCount === 2
        ? Promise.reject(
            Object.assign(new Error("simulated second reservation failure"), {
              code: "MODEL_INVOCATION_RESERVATION_FAILED",
            }),
          )
        : originalStartInvocation(input);
    });
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一列没有终点的夜车只在旧照片里停靠。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(within(dialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }));

    let terminalRun: ReturnType<typeof readOpeningJourneyRun> = null;
    let terminalSuggestions: readonly Readonly<{ status: string }>[] = [];
    await waitFor(async () => {
      const [record] = await harness.runtime.creativeJourneys.listActive("idea");
      terminalRun = readOpeningJourneyRun(record?.snapshot.openingRun);
      terminalSuggestions = (record?.snapshot.openingSuggestions ?? []) as readonly Readonly<{
        status: string;
      }>[];
      expect(terminalRun?.stage).toBe("failed");
      expect(terminalSuggestions).toHaveLength(3);
      expect(terminalSuggestions.every(({ status }) => status === "failed")).toBe(true);
    });
    expect(harness.generate).not.toHaveBeenCalled();
    const [terminalRecord] = await harness.runtime.creativeJourneys.listActive("idea");
    const persistedTerminalRun = readOpeningJourneyRun(terminalRecord?.snapshot.openingRun);
    const invocations = await Promise.all(
      (persistedTerminalRun?.requestIds ?? []).map((requestId: string) =>
        harness.runtime.modelHub.findInvocation(requestId),
      ),
    );
    expect(invocations[0]).toMatchObject({
      status: "failed",
      providerDispatchStartedAt: null,
    });
    expect(invocations[1]).toBeNull();
    expect(invocations[2]).toBeNull();
  }, 30_000);

  it("keeps the run in invocation reservation when the durable dispatch receipt cannot be written", async () => {
    const harness = createProviderRuntime();
    const originalUpdate = harness.runtime.creativeJourneys.update.bind(
      harness.runtime.creativeJourneys,
    );
    const observedStages: string[] = [];
    vi.spyOn(harness.runtime.creativeJourneys, "update").mockImplementation(
      async (record, expectedRevision, turn) => {
        const run = readOpeningJourneyRun(record.snapshot.openingRun);
        if (run !== null) observedStages.push(run.stage);
        return originalUpdate(record, expectedRevision, turn);
      },
    );
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    vi.spyOn(harness.runtime.modelHub, "markInvocationDispatched").mockRejectedValue(
      Object.assign(new Error("simulated durable dispatch receipt failure"), {
        code: "MODEL_INVOCATION_DISPATCH_WRITE_FAILED",
      }),
    );
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一座无人岛的灯塔突然收到来自内陆的靠岸请求。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(within(dialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }));

    await waitFor(async () => {
      const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
      const run = readOpeningJourneyRun(settled?.snapshot.openingRun);
      expect(run?.stage).toBe("failed");
      const task = (await harness.runtime.taskCenter.load()).tasks.find(
        ({ id }) => id === run?.taskId,
      );
      expect(task).toMatchObject({ status: "failed", maxAttempts: 1 });
    });
    expect(observedStages).toContain("invocation_reserving");
    expect(observedStages).not.toContain("provider_waiting");
    expect(harness.generate).not.toHaveBeenCalled();
    const [record] = await harness.runtime.creativeJourneys.listActive("idea");
    const run = readOpeningJourneyRun(record?.snapshot.openingRun);
    const invocations = await Promise.all(
      (run?.requestIds ?? []).map((requestId) =>
        harness.runtime.modelHub.findInvocation(requestId),
      ),
    );
    expect(invocations.every((invocation) => invocation?.providerDispatchStartedAt === null)).toBe(
      true,
    );
  }, 30_000);

  it("terminalizes a restarted unresolved dispatch when the persisted deadline passes without another click", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockImplementation(() => new Promise<never>(() => undefined));
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "末班船靠岸后，所有乘客都收到同一张未来讣告。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(within(dialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }));
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3), {
      timeout: 15_000,
    });
    const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
    const pendingRun = readOpeningJourneyRun(pending?.snapshot.openingRun);
    if (pending === undefined || pendingRun === null) {
      throw new Error("没有保存可恢复的开书旅程。");
    }
    first.unmount();

    let resumedClockMs = Date.parse(pendingRun.deadlineAt) - 1_000;
    const resumedRuntime: DesktopRuntime = Object.freeze({
      ...harness.runtime,
      clock: Object.freeze({
        now: () =>
          new Date(resumedClockMs).toISOString() as ReturnType<DesktopRuntime["clock"]["now"]>,
      }),
    });
    renderJourney(resumedRuntime);
    const heading = await screen.findByRole("heading", {
      name: "末班船靠岸后，所有乘客都收到同一张未来讣告。",
      level: 3,
    });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("没有找到可恢复的开书卡片。");
    await user.click(within(card).getByRole("button", { name: "继续这次构思" }));
    await waitFor(() => expect(screen.getByText(/生成仍在进行，3 个方案尚未返回/u)).toBeVisible());

    resumedClockMs = Date.parse(pendingRun.deadlineAt) + 1_000;
    await waitFor(
      async () => {
        const settled = await resumedRuntime.creativeJourneys.findById(pending.id);
        const settledRun = readOpeningJourneyRun(settled?.snapshot.openingRun);
        expect(settledRun?.stage).toBe("result_pending");
        const task = (await resumedRuntime.taskCenter.load()).tasks.find(
          ({ id }) => id === settledRun?.taskId,
        );
        expect(task).toMatchObject({ status: "failed", maxAttempts: 1 });
      },
      { timeout: 3_500 },
    );
    expect(harness.generate).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("fails closed with zero dispatch when confirmation happens after the persisted deadline", async () => {
    const harness = createProviderRuntime();
    let clockMs = Date.now();
    const runtime: DesktopRuntime = Object.freeze({
      ...harness.runtime,
      clock: Object.freeze({
        now: () => new Date(clockMs).toISOString() as ReturnType<DesktopRuntime["clock"]["now"]>,
      }),
    });
    const user = userEvent.setup();
    renderJourney(runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "观星台收到一封落款为三百年后的值班记录。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    const [pending] = await runtime.creativeJourneys.listActive("idea");
    const pendingRun = readOpeningJourneyRun(pending?.snapshot.openingRun);
    if (pending === undefined || pendingRun === null) {
      throw new Error("没有保存发送前开书旅程。");
    }
    clockMs = Date.parse(pendingRun.deadlineAt) + 1;
    await user.click(within(dialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }));

    await waitFor(
      async () => {
        const settled = await runtime.creativeJourneys.findById(pending.id);
        const settledRun = readOpeningJourneyRun(settled?.snapshot.openingRun);
        expect(settledRun?.stage).toBe("failed");
        const task = (await runtime.taskCenter.load()).tasks.find(
          ({ id }) => id === settledRun?.taskId,
        );
        expect(task).toMatchObject({
          status: "failed",
          maxAttempts: 1,
          failure: { requestId: settledRun?.supportId, retryable: false },
        });
      },
      { timeout: 15_000 },
    );
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("uses the click deadline after a late confirmation and fences every late provider result", async () => {
    const harness = createProviderRuntime();
    let clockMs = Date.now();
    const runtime: DesktopRuntime = Object.freeze({
      ...harness.runtime,
      clock: Object.freeze({
        now: () => new Date(clockMs).toISOString() as ReturnType<DesktopRuntime["clock"]["now"]>,
      }),
    });
    const releases: (() => void)[] = [];
    const user = userEvent.setup();
    renderJourney(runtime);
    await connectOllama(user);
    harness.generate.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          releases.push(() => {
            resolve({ text: `截止后返回 ${input.generationId}`, usage: null });
          });
        }),
    );
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "档案馆在闭馆前收到一份尚未发生的火灾记录。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    const [pending] = await runtime.creativeJourneys.listActive("idea");
    const pendingRun = readOpeningJourneyRun(pending?.snapshot.openingRun);
    if (pending === undefined || pendingRun === null) {
      throw new Error("没有保存带绝对截止时间的开书运行。 ");
    }
    clockMs = Date.parse(pendingRun.deadlineAt) - 1_000;
    await user.click(within(dialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }));
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3), { timeout: 15_000 });

    const originalFindInvocation = runtime.modelHub.findInvocation.bind(runtime.modelHub);
    let invocationReads = 0;
    let markInvocationReadsReached!: () => void;
    let releaseInvocationReads!: () => void;
    const invocationReadsReached = new Promise<void>((resolve) => {
      markInvocationReadsReached = resolve;
    });
    const invocationReadGate = new Promise<void>((resolve) => {
      releaseInvocationReads = resolve;
    });
    vi.spyOn(runtime.modelHub, "findInvocation").mockImplementation(async (invocationId) => {
      const invocation = await originalFindInvocation(invocationId);
      invocationReads += 1;
      if (invocationReads === 3) markInvocationReadsReached();
      await invocationReadGate;
      return invocation;
    });
    releases.forEach((release) => release());
    await invocationReadsReached;
    clockMs = Date.parse(pendingRun.deadlineAt) + 1;
    releaseInvocationReads();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(
      async () => {
        const settled = await runtime.creativeJourneys.findById(pending.id);
        const settledRun = readOpeningJourneyRun(settled?.snapshot.openingRun);
        expect(settledRun?.stage).toBe("result_pending");
        const task = (await runtime.taskCenter.load()).tasks.find(
          ({ id }) => id === pendingRun.taskId,
        );
        expect(task).toMatchObject({
          status: "failed",
          maxAttempts: 1,
          failure: { code: "OPENING_RESULT_PENDING_REVIEW", requestId: pendingRun.supportId },
        });
      },
      { timeout: 4_000 },
    );

    const afterLateResults = await runtime.creativeJourneys.findById(pending.id);
    expect(readOpeningJourneyRun(afterLateResults?.snapshot.openingRun)?.stage).toBe(
      "result_pending",
    );
    expect(afterLateResults?.snapshot.openingSuggestions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ready" })]),
    );
    const lateHistory = afterLateResults?.snapshot.openingResultHistory as
      | readonly Readonly<{
          id: string;
          status: string;
          text: string;
          noticeCode: string | null;
        }>[]
      | undefined;
    expect(lateHistory).toHaveLength(3);
    for (const requestId of pendingRun.requestIds) {
      expect(lateHistory?.find(({ id }) => id === requestId)).toMatchObject({
        status: "review",
        text: `截止后返回 ${requestId}`,
        noticeCode: "OPENING_RESULT_PENDING_REVIEW",
      });
    }
    expect(harness.generate).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("reconciles the one task after a crash between journey terminalization and task settlement", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    const failTask = vi
      .spyOn(harness.runtime.taskCenter, "failTask")
      .mockRejectedValue(new Error("simulated crash before task settlement"));
    vi.spyOn(harness.runtime.modelHub, "findTaskRoute").mockRejectedValueOnce(
      Object.assign(new Error("simulated route failure"), {
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "旧剧院的座位每晚都会少一个名字。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));

    let journeyId = "";
    let taskId = "";
    await waitFor(
      async () => {
        const [terminal] = await harness.runtime.creativeJourneys.listActive("idea");
        const run = readOpeningJourneyRun(terminal?.snapshot.openingRun);
        expect(run?.stage).toBe("failed");
        journeyId = terminal?.id ?? "";
        taskId = run?.taskId ?? "";
        const task = (await harness.runtime.taskCenter.load()).tasks.find(
          ({ id }) => id === taskId,
        );
        expect(task?.status).toBe("running");
      },
      { timeout: 15_000 },
    );

    first.unmount();
    failTask.mockRestore();
    renderJourney(harness.runtime);
    const heading = await screen.findByRole("heading", {
      name: "旧剧院的座位每晚都会少一个名字。",
      level: 3,
    });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("没有找到终态旅程恢复卡片。");
    await user.click(within(card).getByRole("button", { name: "继续这次构思" }));

    await waitFor(async () => {
      const terminal = await harness.runtime.creativeJourneys.findById(journeyId);
      expect(readOpeningJourneyRun(terminal?.snapshot.openingRun)?.stage).toBe("failed");
      const task = (await harness.runtime.taskCenter.load()).tasks.find(({ id }) => id === taskId);
      expect(task).toMatchObject({ status: "failed", maxAttempts: 1 });
    });
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("safely terminalizes confirmation-before-send when the page is left", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const view = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "最后一班电车驶入一座从地图上消失的城市。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    expect(await screen.findByRole("dialog", { name: "生成首批三个开头" })).toBeVisible();

    view.unmount();

    await waitFor(async () => {
      const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
      expect(settled?.currentState).not.toBe("generation_pending");
      expect(settled?.snapshot.pendingRequestId).toBeNull();
      expect(settled?.snapshot.openingSuggestions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "pending" })]),
      );
    });
    expect(harness.generate).not.toHaveBeenCalled();
    const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
    const openingRun = readOpeningJourneyRun(settled?.snapshot.openingRun);
    expect(openingRun).toMatchObject({
      stage: "cancelled_before_confirmation",
      autoRetryCount: 0,
    });
    if (openingRun === null) {
      throw new Error("测试构思旅程缺少开书状态");
    }
    const openingTasks = (await harness.runtime.taskCenter.load()).tasks.filter(
      ({ type }) => type === "ai.opening.generate",
    );
    expect(openingTasks).toEqual([
      expect.objectContaining({
        status: "cancelled",
        maxAttempts: 1,
      }),
    ]);
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByText("确认前离开，未确认的生成批次已安全终止")).toBeVisible();
    expect(
      screen.getByText(new RegExp(openingJourneySupportNumber(openingRun), "u")),
    ).toBeVisible();
  }, 30_000);

  it("keeps a confirmed pre-send run recoverable when its page leaves", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const originalUpdate = harness.runtime.creativeJourneys.update.bind(
      harness.runtime.creativeJourneys,
    );
    let releaseInvocationReservation!: () => void;
    let reservationHeld = false;
    let markReservationReached: (() => void) | null = null;
    const reservationReached = new Promise<void>((resolve) => {
      markReservationReached = resolve;
    });
    vi.spyOn(harness.runtime.creativeJourneys, "update").mockImplementation(
      (record, expectedRevision, turn) => {
        const run = readOpeningJourneyRun(record.snapshot.openingRun);
        if (run?.stage === "invocation_reserving" && !reservationHeld) {
          reservationHeld = true;
          markReservationReached?.();
          return new Promise<void>((resolve, reject) => {
            releaseInvocationReservation = () => {
              originalUpdate(record, expectedRevision, turn).then(resolve, reject);
            };
          });
        }
        return originalUpdate(record, expectedRevision, turn);
      },
    );

    const first = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    const idea = "一座海岛灯塔在雾中收到来自未来船只的求救信号。";
    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), idea);
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(within(dialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }));
    await reservationReached;

    const [confirmed] = await harness.runtime.creativeJourneys.listActive("idea");
    const confirmedRun = readOpeningJourneyRun(confirmed?.snapshot.openingRun);
    if (confirmed === undefined || confirmedRun === null) {
      throw new Error("没有形成可控的确认后发送前状态。");
    }
    expect(confirmedRun.stage).toBe("confirmed");

    first.unmount();
    releaseInvocationReservation();
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    });

    await waitFor(async () => {
      const retained = await harness.runtime.creativeJourneys.findById(confirmed.id);
      expect(readOpeningJourneyRun(retained?.snapshot.openingRun)).toMatchObject({
        stage: "invocation_reserving",
        supportId: confirmedRun.supportId,
        autoRetryCount: 0,
      });
      expect(retained?.snapshot.openingSuggestions).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "pending" })]),
      );
    });
    expect(harness.generate).not.toHaveBeenCalled();

    renderJourney(harness.runtime);
    const heading = await screen.findByRole("heading", { name: idea, level: 3 });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("没有找到确认后离页的恢复卡片。");
    await user.click(within(card).getByRole("button", { name: "继续这次构思" }));

    await waitFor(async () => {
      const recovered = await harness.runtime.creativeJourneys.findById(confirmed.id);
      expect(readOpeningJourneyRun(recovered?.snapshot.openingRun)).toMatchObject({
        stage: "failed",
        supportId: confirmedRun.supportId,
        autoRetryCount: 0,
      });
      expect(recovered?.snapshot.pendingRequestId).toBeNull();
    });
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("projects a preflight failure into one terminal task with a stable support number and no retry", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    vi.spyOn(harness.runtime.modelHub, "findTaskRoute").mockRejectedValueOnce(
      Object.assign(new Error("simulated route failure"), {
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "三张空白车票分别印着昨天、今天和明天。",
    );

    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await waitFor(() => expect(screen.getAllByText("未发送")).toHaveLength(3), {
      timeout: 15_000,
    });

    const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
    const openingTasks = (await harness.runtime.taskCenter.load()).tasks.filter(
      ({ type }) => type === "ai.opening.generate",
    );
    expect(openingTasks).toHaveLength(1);
    expect(openingTasks[0]).toMatchObject({
      status: "failed",
      maxAttempts: 1,
      attempt: 1,
      failure: {
        retryable: false,
        requestId: settled?.snapshot.openingBatchId,
      },
    });
  }, 30_000);

  it("reports and safely retries a local terminal-settlement write failure for initial creation", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    const settlementFailure = failNextOpeningSettlementWrite(harness.runtime);
    vi.spyOn(harness.runtime.modelHub, "findTaskRoute").mockRejectedValueOnce(
      Object.assign(new Error("simulated route failure"), {
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "废弃车站的时刻表开始播报从未存在的列车。",
    );

    await user.click(screen.getByRole("button", { name: "生成第一段" }));

    expect(await screen.findByText("本地收口失败")).toBeVisible();
    const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
    const run = readOpeningJourneyRun(settled?.snapshot.openingRun);
    if (settled === undefined || run === null) throw new Error("没有保存开书终态。 ");
    expect(settlementFailure.didFail()).toBe(true);
    expect(run).toMatchObject({ stage: "failed", autoRetryCount: 0 });
    expect(
      screen.getAllByText(new RegExp(openingJourneySupportNumber(run), "u")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "重新读取" })).toBeEnabled();
    const task = (await harness.runtime.taskCenter.load()).tasks.find(
      ({ id }) => id === run.taskId,
    );
    expect(task).toMatchObject({ status: "failed", maxAttempts: 1 });
    expect(harness.generate).not.toHaveBeenCalled();
    const incident = readSafeOperationIncidents().find(
      ({ stage, requestId, normalizedErrorCode }) =>
        stage === "settle_terminal_state" &&
        requestId === run.supportId &&
        normalizedErrorCode === "OPENING_LOCAL_TERMINAL_SETTLEMENT_FAILED",
    );
    expect(incident?.causeChain.map(({ errorCode }) => errorCode)).toEqual([
      "OPENING_LOCAL_TERMINAL_SETTLEMENT_FAILED",
      "CREATIVE_JOURNEY_STORAGE_WRITE_FAILED",
      "MODEL_HUB_ROUTE_NOT_CONFIGURED",
    ]);
  }, 30_000);

  it("safely terminates a replacement batch when its confirmation page is left", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const view = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "退潮后，海滩上出现了一条通往昨日的铁轨。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const initialDialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(
      within(initialDialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }),
    );
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3), { timeout: 15_000 });
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled(), {
      timeout: 15_000,
    });

    harness.generate.mockClear();
    await user.click(screen.getByRole("button", { name: "换一批" }));
    expect(await screen.findByRole("dialog", { name: "换一批三个开头" })).toBeVisible();
    const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
    const pendingRun = readOpeningJourneyRun(pending?.snapshot.openingRun);
    if (pending === undefined || pendingRun === null) {
      throw new Error("换批确认没有保存开书运行。 ");
    }

    view.unmount();

    await waitFor(async () => {
      const settled = await harness.runtime.creativeJourneys.findById(pending.id);
      expect(readOpeningJourneyRun(settled?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
      const task = (await harness.runtime.taskCenter.load()).tasks.find(
        ({ id }) => id === pendingRun.taskId,
      );
      expect(task?.status).toBe("cancelled");
    });
    expect(harness.generate).not.toHaveBeenCalled();

    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByText("确认前离开，未确认的生成批次已安全终止")).toBeVisible();
    expect(
      screen.getByText(new RegExp(openingJourneySupportNumber(pendingRun), "u")),
    ).toBeVisible();
  }, 30_000);

  it("uses the same local terminal-settlement failure path for replacement batches", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "雨夜的公交总站停着一辆只载未来乘客的末班车。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const initialDialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(
      within(initialDialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled(), {
      timeout: 15_000,
    });

    harness.generate.mockClear();
    const settlementFailure = failNextOpeningSettlementWrite(harness.runtime);
    vi.spyOn(harness.runtime.modelHub, "findTaskRoute").mockRejectedValueOnce(
      Object.assign(new Error("simulated replacement route failure"), {
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      }),
    );
    await user.click(screen.getByRole("button", { name: "换一批" }));

    expect(await screen.findByText("本地收口失败")).toBeVisible();
    const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
    const run = readOpeningJourneyRun(settled?.snapshot.openingRun);
    if (run === null) throw new Error("换批失败后没有开书终态。 ");
    expect(settlementFailure.didFail()).toBe(true);
    expect(run).toMatchObject({ stage: "failed", autoRetryCount: 0 });
    expect(
      screen.getAllByText(new RegExp(openingJourneySupportNumber(run), "u")).length,
    ).toBeGreaterThan(0);
    expect(
      (await harness.runtime.taskCenter.load()).tasks.find(({ id }) => id === run.taskId),
    ).toMatchObject({ status: "failed", maxAttempts: 1 });
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("safely terminates a single-slot retry when its confirmation page is left", async () => {
    const harness = createProviderRuntime();
    let callIndex = 0;
    const user = userEvent.setup();
    const view = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    harness.generate.mockImplementation((input) => {
      callIndex += 1;
      return callIndex === 1
        ? Promise.reject(
            Object.assign(new Error("simulated first-slot failure"), {
              code: "MODEL_PROVIDER_UNAVAILABLE",
            }),
          )
        : Promise.resolve({ text: `可用开头 ${input.generationId}`, usage: null });
    });
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "山城的每扇窗都映着同一个陌生人的童年。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const initialDialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(
      within(initialDialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }),
    );
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3), { timeout: 15_000 });
    await waitFor(
      () => expect(screen.getByRole("button", { name: "重新生成此方案" })).toBeEnabled(),
      { timeout: 15_000 },
    );

    harness.generate.mockClear();
    await user.click(screen.getByRole("button", { name: "重新生成此方案" }));
    expect(await screen.findByRole("dialog", { name: "重新生成这个方案" })).toBeVisible();
    const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
    const pendingRun = readOpeningJourneyRun(pending?.snapshot.openingRun);
    if (pending === undefined || pendingRun === null) {
      throw new Error("单槽重试确认没有保存开书运行。 ");
    }

    view.unmount();

    await waitFor(async () => {
      const settled = await harness.runtime.creativeJourneys.findById(pending.id);
      expect(readOpeningJourneyRun(settled?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
      const task = (await harness.runtime.taskCenter.load()).tasks.find(
        ({ id }) => id === pendingRun.taskId,
      );
      expect(task?.status).toBe("cancelled");
    });
    expect(harness.generate).not.toHaveBeenCalled();

    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByText("确认前离开，未确认的生成批次已安全终止")).toBeVisible();
    expect(
      screen.getByText(new RegExp(openingJourneySupportNumber(pendingRun), "u")),
    ).toBeVisible();
  }, 30_000);
  it("archives a single-slot retry that returns after its persisted deadline without another send", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    let initialCall = 0;
    harness.generate.mockImplementation((input) => {
      initialCall += 1;
      return initialCall === 1
        ? Promise.reject(
            Object.assign(new Error("simulated first-slot failure"), {
              code: "MODEL_PROVIDER_UNAVAILABLE",
            }),
          )
        : Promise.resolve({ text: `初始可用开头 ${input.generationId}`, usage: null });
    });
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一座旧天文台会在雨夜收到来自未来的观测记录。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const initialDialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(
      within(initialDialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }),
    );
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3), { timeout: 15_000 });
    await waitFor(
      () => expect(screen.getByRole("button", { name: "重新生成此方案" })).toBeEnabled(),
      { timeout: 15_000 },
    );

    const [beforeRetry] = await harness.runtime.creativeJourneys.listActive("idea");
    if (beforeRetry?.chapterId === null || beforeRetry?.chapterId === undefined) {
      throw new Error("单槽迟到结果测试没有取得第一章编号。");
    }
    const chapterId = parseUuidV7(beforeRetry.chapterId);
    if (!chapterId.ok) throw chapterId.error;
    const chapterBefore = await harness.runtime.repositories.chapters.findById(chapterId.value);
    if (!chapterBefore.ok || chapterBefore.value === null) {
      throw new Error("单槽迟到结果测试无法读取第一章权威状态。");
    }
    const chapterAuthority = Object.freeze({
      content: chapterBefore.value.content,
      currentVersionId: chapterBefore.value.currentVersionId,
      revision: chapterBefore.value.revision,
    });

    harness.generate.mockClear();
    const lateResult = {
      resolve: null as null | ((value: { text: string; usage: null }) => void),
    };
    harness.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          lateResult.resolve = resolve;
        }),
    );
    const cancelGeneration = vi.spyOn(harness.runtime.modelGateway, "cancelGeneration");
    await user.click(screen.getByRole("button", { name: "重新生成此方案" }));
    expect(await screen.findByRole("dialog", { name: "重新生成这个方案" })).toBeVisible();
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const slotTimeoutCallbacks: (() => void)[] = [];
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      if (
        timeout === CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS &&
        typeof handler === "function"
      ) {
        slotTimeoutCallbacks.push(handler as () => void);
        return realSetTimeout(() => undefined, timeout);
      }
      return realSetTimeout(handler, timeout);
    }) as typeof globalThis.setTimeout);

    try {
      await user.click(
        within(screen.getByRole("dialog", { name: "重新生成这个方案" })).getByRole("button", {
          name: "确认并发送最多 1 个生成请求",
        }),
      );
      await waitFor(() => expect(harness.generate).toHaveBeenCalledOnce(), { timeout: 15_000 });
      expect(slotTimeoutCallbacks.length).toBeGreaterThanOrEqual(2);
      const requestId = harness.generate.mock.calls[0]?.[0].generationId;
      if (requestId === undefined) throw new Error("单槽迟到结果测试没有取得请求编号。");
      expect(harness.generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);

      await act(async () => {
        slotTimeoutCallbacks.at(-1)?.();
        await Promise.resolve();
      });
      await waitFor(async () => {
        const record = await harness.runtime.creativeJourneys.findById(beforeRetry.id);
        expect(readOpeningJourneyRun(record?.snapshot.openingRun)).toMatchObject({
          stage: "result_pending",
          autoRetryCount: 0,
        });
      });
      expect(cancelGeneration).not.toHaveBeenCalled();

      if (lateResult.resolve === null) {
        throw new Error("迟到结果解析器未准备好。");
      }
      lateResult.resolve({ text: "迟到的天文记录在桌面上自行翻到了最后一页。", usage: null });
      await waitFor(async () => {
        const record = await harness.runtime.creativeJourneys.findById(beforeRetry.id);
        const history = record?.snapshot.openingResultHistory as
          | readonly Readonly<{
              id: string;
              status: string;
              text: string;
              providerInvocationId: string | null;
            }>[]
          | undefined;
        expect(history?.find(({ id }) => id === requestId)).toMatchObject({
          status: "review",
          text: "迟到的天文记录在桌面上自行翻到了最后一页。",
          providerInvocationId: requestId,
        });
        const run = readOpeningJourneyRun(record?.snapshot.openingRun);
        if (run === null) throw new Error("单槽迟到结果没有保留开书运行记录。");
        expect(
          (await harness.runtime.taskCenter.load()).tasks.find(({ id }) => id === run.taskId),
        ).toMatchObject({ status: "failed", maxAttempts: 1 });
      });
      expect(harness.generate).toHaveBeenCalledOnce();
      expect(cancelGeneration).not.toHaveBeenCalled();
      const invocation = await harness.runtime.modelHub.findInvocation(requestId);
      expect(invocation).toMatchObject({
        status: "timed_out",
      });
      expect(typeof invocation?.providerDispatchStartedAt).toBe("string");
      const chapterAfter = await harness.runtime.repositories.chapters.findById(chapterId.value);
      expect(chapterAfter.ok && chapterAfter.value).toMatchObject(chapterAuthority);
    } finally {
      timeoutSpy.mockRestore();
    }
  }, 30_000);

  it("uses the same local terminal-settlement failure path for a single-slot retry", async () => {
    const harness = createProviderRuntime();
    let callIndex = 0;
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    harness.generate.mockImplementation((input) => {
      callIndex += 1;
      return callIndex === 1
        ? Promise.reject(
            Object.assign(new Error("simulated first-slot failure"), {
              code: "MODEL_PROVIDER_UNAVAILABLE",
            }),
          )
        : Promise.resolve({ text: `可用开头 ${input.generationId}`, usage: null });
    });
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "海边灯塔每晚照见一座不存在于白昼的港口。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const initialDialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(
      within(initialDialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }),
    );
    await waitFor(
      () => expect(screen.getByRole("button", { name: "重新生成此方案" })).toBeEnabled(),
      { timeout: 15_000 },
    );

    harness.generate.mockClear();
    const settlementFailure = failNextOpeningSettlementWrite(harness.runtime);
    vi.spyOn(harness.runtime.modelHub, "findTaskRoute").mockRejectedValueOnce(
      Object.assign(new Error("simulated single-slot route failure"), {
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      }),
    );
    await user.click(screen.getByRole("button", { name: "重新生成此方案" }));

    expect(await screen.findByText("本地收口失败")).toBeVisible();
    const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
    const run = readOpeningJourneyRun(settled?.snapshot.openingRun);
    if (run === null) throw new Error("单槽失败后没有开书终态。 ");
    expect(settlementFailure.didFail()).toBe(true);
    expect(run).toMatchObject({ stage: "failed", autoRetryCount: 0 });
    expect(
      screen.getAllByText(new RegExp(openingJourneySupportNumber(run), "u")).length,
    ).toBeGreaterThan(0);
    expect(
      (await harness.runtime.taskCenter.load()).tasks.find(({ id }) => id === run.taskId),
    ).toMatchObject({ status: "failed", maxAttempts: 1 });
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps the click support number visible and sends nothing when the local journey cannot be saved", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    const createJourney = vi
      .spyOn(harness.runtime.creativeJourneys, "create")
      .mockRejectedValueOnce(
        Object.assign(new Error("simulated local journey write failure"), {
          code: "CREATIVE_JOURNEY_STORAGE_WRITE_FAILED",
        }),
      );
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一座停摆的钟楼在午夜寄出自己的维修单。",
    );

    await user.click(screen.getByRole("button", { name: "生成第一段" }));

    await waitFor(() => expect(createJourney).toHaveBeenCalledTimes(1));
    const attempted = createJourney.mock.calls[0]?.[0];
    const run = readOpeningJourneyRun(attempted?.snapshot.openingRun);
    if (run === null) throw new Error("创建尝试没有形成内存开书运行编号。");
    expect(await screen.findByText("本地旅程未能保存，本次没有发送")).toBeVisible();
    expect(screen.getByText(new RegExp(openingJourneySupportNumber(run), "u"))).toBeVisible();
    expect(harness.generate).not.toHaveBeenCalled();
    expect(await harness.runtime.creativeJourneys.listActive("idea")).toHaveLength(0);
    expect(
      (await harness.runtime.taskCenter.load()).tasks.filter(
        ({ type }) => type === "ai.opening.generate",
      ),
    ).toHaveLength(0);
  }, 30_000);

  it("keeps one malformed journey visible with a stable support number and content-free diagnostics", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一间旧照相馆只冲洗尚未发生的合影。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    expect(await screen.findByRole("dialog", { name: "生成首批三个开头" })).toBeVisible();
    first.unmount();
    await waitFor(async () => {
      const [good] = await harness.runtime.creativeJourneys.listActive("idea");
      expect(readOpeningJourneyRun(good?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
    });

    const badJourneyId = harness.runtime.ids.next();
    const badTurnId = harness.runtime.ids.next();
    const now = harness.runtime.clock.now();
    const privateMarker = "不可进入诊断的虚构灵感与正文标记";
    await harness.runtime.creativeJourneys.create(
      Object.freeze({
        id: badJourneyId,
        kind: "idea" as const,
        status: "active" as const,
        currentState: "generating_opening",
        projectId: null,
        chapterId: null,
        candidateId: null,
        revision: 1,
        snapshot: Object.freeze({
          version: 1,
          idea: privateMarker,
          preview: privateMarker,
          malformedOpeningRun: true,
        }),
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      }),
      Object.freeze({
        id: badTurnId,
        journeyId: badJourneyId,
        sequence: 1,
        kind: "idea" as const,
        questionKey: null,
        generationSource: null,
        providerId: null,
        modelId: null,
        taskKey: "opening_guidance",
        requestId: null,
        snapshot: Object.freeze({ malformed: true }),
        createdAt: now,
      }),
    );

    const second = renderJourney(harness.runtime);
    expect(await screen.findByRole("heading", { name: "需要恢复的未完成构思" })).toBeVisible();
    expect(screen.getByText("读取本地开书进度")).toBeVisible();
    const incident = readSafeOperationIncidents().find(
      ({ operation, stage, requestId }) =>
        operation === "opening_creation" &&
        stage === "read_local_state" &&
        requestId === badJourneyId,
    );
    if (incident === undefined) throw new Error("坏旅程没有形成脱敏本地诊断。 ");
    expect(screen.getByText(new RegExp(incident.supportId, "u"))).toBeVisible();
    expect(screen.getByRole("button", { name: "重新读取这条构思" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "导出脱敏诊断" })).toHaveAttribute(
      "href",
      "/settings#diagnostics",
    );
    expect(incident).toMatchObject({
      normalizedErrorCode: "OPENING_JOURNEY_SNAPSHOT_INVALID",
      dispatched: "unknown",
      automaticRetryCount: 0,
    });
    expect(JSON.stringify(incident)).not.toContain(privateMarker);
    expect(screen.queryByText(privateMarker)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新读取这条构思" }));
    expect(await screen.findByText(new RegExp(incident.supportId, "u"))).toBeVisible();
    expect((await harness.runtime.creativeJourneys.findById(badJourneyId))?.snapshot).toMatchObject(
      {
        malformedOpeningRun: true,
      },
    );

    second.unmount();
    renderJourney(harness.runtime);
    expect(await screen.findByText(new RegExp(incident.supportId, "u"))).toBeVisible();
    expect(
      readSafeOperationIncidents().filter(({ requestId }) => requestId === badJourneyId),
    ).toHaveLength(1);
  }, 30_000);

  it("isolates opening runs whose journey, batch, request slots, or terminal state disagree", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "旧剧院的每张空座位都保存着一段尚未上演的掌声。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    expect(await screen.findByRole("dialog", { name: "生成首批三个开头" })).toBeVisible();
    const [seed] = await harness.runtime.creativeJourneys.listActive("idea");
    const seedRun = readOpeningJourneyRun(seed?.snapshot.openingRun);
    if (seed === undefined || seedRun === null) throw new Error("没有取得有效开书快照种子。");
    const seedSnapshot = seed.snapshot;
    first.unmount();
    await waitFor(async () => {
      const safeSeed = await harness.runtime.creativeJourneys.findById(seed.id);
      expect(readOpeningJourneyRun(safeSeed?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
    });

    const malformedIds: string[] = [];
    const createMalformed = async (
      label: string,
      makeRun: (journeyId: string) => Readonly<Record<string, unknown>>,
    ) => {
      const journeyId = harness.runtime.ids.next();
      malformedIds.push(journeyId);
      const now = harness.runtime.clock.now();
      await harness.runtime.creativeJourneys.create(
        Object.freeze({
          ...seed,
          id: journeyId,
          revision: 1,
          snapshot: Object.freeze({
            ...seedSnapshot,
            idea: label,
            projectName: label,
            openingRun: makeRun(journeyId),
          }),
          createdAt: now,
          updatedAt: now,
        }),
        Object.freeze({
          id: harness.runtime.ids.next(),
          journeyId,
          sequence: 1,
          kind: "idea" as const,
          questionKey: null,
          generationSource: null,
          providerId: null,
          modelId: null,
          taskKey: "opening_guidance",
          requestId: null,
          snapshot: Object.freeze({ fixture: "cross_field_invariant" }),
          createdAt: now,
        }),
      );
    };
    const scopedRun = (journeyId: string) =>
      Object.freeze({
        ...seedRun,
        journeyId,
        taskId: harness.runtime.ids.next(),
      });
    await createMalformed("旅程编号不一致", (journeyId) =>
      Object.freeze({ ...scopedRun(journeyId), journeyId: seed.id }),
    );
    await createMalformed("批次编号不一致", (journeyId) => {
      const wrongBatchId = harness.runtime.ids.next();
      return Object.freeze({
        ...scopedRun(journeyId),
        batchId: wrongBatchId,
        supportId: wrongBatchId,
      });
    });
    await createMalformed("请求槽位不一致", (journeyId) =>
      Object.freeze({
        ...scopedRun(journeyId),
        requestIds: Object.freeze(seedRun.requestIds.slice(0, 2)),
      }),
    );
    await createMalformed("终态仍有等待槽位", (journeyId) =>
      Object.freeze({
        ...scopedRun(journeyId),
        stage: "completed",
        stageStartedAt: harness.runtime.clock.now(),
        terminalAt: harness.runtime.clock.now(),
        failureCode: null,
      }),
    );

    renderJourney(harness.runtime);
    expect(await screen.findAllByRole("heading", { name: "需要恢复的未完成构思" })).toHaveLength(4);
    const incidents = readSafeOperationIncidents().filter(
      ({ requestId, normalizedErrorCode }) =>
        requestId !== null &&
        malformedIds.includes(requestId) &&
        normalizedErrorCode === "OPENING_JOURNEY_SNAPSHOT_INVALID",
    );
    expect(incidents).toHaveLength(4);
    for (const journeyId of malformedIds) {
      expect(await harness.runtime.creativeJourneys.findById(journeyId)).not.toBeNull();
    }
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);
  it("terminalizes a saved workspace journey when local project creation never returns and the page leaves", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const view = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    vi.spyOn(harness.runtime.useCases.createProject, "execute").mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一座旧桥每天只在无人注视时多出一块石板。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    let journeyId = "";
    let taskId = "";
    await waitFor(async () => {
      const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
      const run = readOpeningJourneyRun(pending?.snapshot.openingRun);
      expect(run?.stage).toBe("workspace_provisioning");
      journeyId = pending?.id ?? "";
      taskId = run?.taskId ?? "";
    });

    view.unmount();

    await waitFor(async () => {
      const terminal = await harness.runtime.creativeJourneys.findById(journeyId);
      expect(readOpeningJourneyRun(terminal?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
      const task = (await harness.runtime.taskCenter.load()).tasks.find(({ id }) => id === taskId);
      expect(task).toMatchObject({ status: "cancelled", maxAttempts: 1 });
    });
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("terminalizes a saved preflight journey even when route preparation never returns", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const view = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    vi.spyOn(harness.runtime.modelHub, "findTaskRoute").mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "停摆的钟楼在雨夜里收到来自明天的报时单。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    let journeyId = "";
    let taskId = "";
    await waitFor(async () => {
      const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
      const run = readOpeningJourneyRun(pending?.snapshot.openingRun);
      expect(run?.stage).toBe("preflight");
      journeyId = pending?.id ?? "";
      taskId = run?.taskId ?? "";
    });

    view.unmount();

    await waitFor(async () => {
      const terminal = await harness.runtime.creativeJourneys.findById(journeyId);
      expect(readOpeningJourneyRun(terminal?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
      const task = (await harness.runtime.taskCenter.load()).tasks.find(({ id }) => id === taskId);
      expect(task).toMatchObject({ status: "cancelled", maxAttempts: 1 });
    });
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("persists isolated provider results after the page leaves without accepting正文", async () => {
    const harness = createProviderRuntime();
    const releases: (() => void)[] = [];
    const user = userEvent.setup();
    const view = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          releases.push(() => {
            resolve({ text: `离页后隔离开头 ${input.generationId}`, usage: null });
          });
        }),
    );
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "最后一间邮局在闭馆后收到三封尚未写出的信。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(within(dialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }));
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3), { timeout: 15_000 });
    const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
    const pendingRun = readOpeningJourneyRun(pending?.snapshot.openingRun);
    if (pending === undefined || pendingRun === null) throw new Error("没有保存发送中的开书旅程。");
    expect(pendingRun.stage).toBe("provider_waiting");

    view.unmount();
    releases.forEach((release) => release());

    await waitFor(async () => {
      const terminal = await harness.runtime.creativeJourneys.findById(pending.id);
      const run = readOpeningJourneyRun(terminal?.snapshot.openingRun);
      expect(run?.stage).toBe("completed");
      expect(terminal?.snapshot.preview).toBe("");
      expect(terminal?.snapshot.openingSuggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "ready", dispatchState: "succeeded" }),
        ]),
      );
      const task = (await harness.runtime.taskCenter.load()).tasks.find(
        ({ id }) => id === pendingRun.taskId,
      );
      expect(task).toMatchObject({ status: "succeeded", maxAttempts: 1 });
    });
    expect(harness.generate).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("settles a dispatched batch at its persisted deadline after the page is gone", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockImplementation(() => new Promise<never>(() => undefined));
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一列夜车驶出隧道后，车上所有钟表都慢了同一分钟。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    await user.click(within(dialog).getByRole("button", { name: "确认并发送最多 3 个生成请求" }));
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3), { timeout: 15_000 });
    const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
    const pendingRun = readOpeningJourneyRun(pending?.snapshot.openingRun);
    if (pending === undefined || pendingRun === null) {
      throw new Error("没有保存已发送的开书旅程。");
    }
    expect(pendingRun.stage).toBe("provider_waiting");

    const deadlineAt = new Date(Date.now() + 5_000).toISOString();
    const shortened = Object.freeze({
      ...pending,
      revision: pending.revision + 1,
      snapshot: Object.freeze({
        ...pending.snapshot,
        openingRun: Object.freeze({ ...pendingRun, deadlineAt }),
      }),
      updatedAt: harness.runtime.clock.now(),
    });
    await harness.runtime.creativeJourneys.update(shortened, pending.revision);
    first.unmount();

    const resumed = renderJourney(harness.runtime);
    const heading = await screen.findByRole("heading", {
      name: "一列夜车驶出隧道后，车上所有钟表都慢了同一分钟。",
      level: 3,
    });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("没有找到后台截止恢复卡片。");
    await user.click(within(card).getByRole("button", { name: "继续这次构思" }));
    await waitFor(() => expect(screen.getByText(/生成仍在进行，3 个方案尚未返回/u)).toBeVisible());
    resumed.unmount();

    await waitFor(
      async () => {
        const terminal = await harness.runtime.creativeJourneys.findById(pending.id);
        const terminalRun = readOpeningJourneyRun(terminal?.snapshot.openingRun);
        expect(terminalRun).toMatchObject({
          stage: "result_pending",
          supportId: pendingRun.supportId,
          autoRetryCount: 0,
        });
        const task = (await harness.runtime.taskCenter.load()).tasks.find(
          ({ id }) => id === pendingRun.taskId,
        );
        expect(task).toMatchObject({ status: "failed", maxAttempts: 1 });
        const invocations = await Promise.all(
          pendingRun.requestIds.map((requestId) =>
            harness.runtime.modelHub.findInvocation(requestId),
          ),
        );
        expect(
          invocations.some(
            (invocation) =>
              invocation?.status === "timed_out" &&
              typeof invocation.providerDispatchStartedAt === "string",
          ),
        ).toBe(true);
      },
      { timeout: 8_000 },
    );
    expect(harness.generate).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("fails closed when a legacy opening contains a pending slot from another batch", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一座沙漠图书馆只收藏被风抹去的城市志。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    expect(await screen.findByRole("dialog", { name: "生成首批三个开头" })).toBeVisible();
    const [seed] = await harness.runtime.creativeJourneys.listActive("idea");
    const seedRun = readOpeningJourneyRun(seed?.snapshot.openingRun);
    if (seed === undefined || seedRun === null) throw new Error("没有取得混合旧批次测试种子。");
    first.unmount();
    await waitFor(async () => {
      const cancelled = await harness.runtime.creativeJourneys.findById(seed.id);
      expect(readOpeningJourneyRun(cancelled?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
    });

    const legacyJourneyId = harness.runtime.ids.next();
    const foreignBatchId = harness.runtime.ids.next();
    const foreignRequestId = harness.runtime.ids.next();
    const now = harness.runtime.clock.now();
    const seedSuggestions = seed.snapshot.openingSuggestions as readonly Readonly<
      Record<string, unknown>
    >[];
    const template = seedSuggestions[0];
    if (template === undefined) throw new Error("混合旧批次测试缺少开头位置模板。");
    const mixedSuggestions = Object.freeze([
      ...seedSuggestions,
      Object.freeze({
        ...template,
        id: foreignRequestId,
        batchId: foreignBatchId,
        slotNumber: 1,
        text: "",
        status: "pending",
        providerInvocationId: null,
        dispatchState: "planned",
      }),
    ]);
    const legacy = Object.freeze({
      ...seed,
      id: legacyJourneyId,
      revision: 1,
      snapshot: Object.freeze({
        ...seed.snapshot,
        idea: "旧版混合批次：沙漠图书馆",
        projectName: "旧版混合批次：沙漠图书馆",
        openingRun: null,
        openingSuggestions: mixedSuggestions,
      }),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    await harness.runtime.creativeJourneys.create(
      legacy,
      Object.freeze({
        id: harness.runtime.ids.next(),
        journeyId: legacyJourneyId,
        sequence: 1,
        kind: "idea" as const,
        questionKey: null,
        generationSource: null,
        providerId: null,
        modelId: null,
        taskKey: "opening_guidance",
        requestId: null,
        snapshot: Object.freeze({ legacyOpeningRun: true, mixedBatch: true }),
        createdAt: now,
      }),
    );
    const before = await harness.runtime.creativeJourneys.findById(legacyJourneyId);
    const tasksBefore = await harness.runtime.taskCenter.load();

    renderJourney(harness.runtime);
    const heading = await screen.findByRole("heading", {
      name: "旧版混合批次：沙漠图书馆",
      level: 3,
    });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("没有找到混合旧批次恢复卡片。");
    await user.click(within(card).getByRole("button", { name: "继续这次构思" }));

    expect(
      await screen.findByText(
        "旧版开书进度混入了其他批次的未完成请求。墨影已停止恢复，不会删除、改写或重新发送。",
      ),
    ).toBeVisible();
    expect(await harness.runtime.creativeJourneys.findById(legacyJourneyId)).toEqual(before);
    expect(await harness.runtime.taskCenter.load()).toEqual(tasksBefore);
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("installs one support-linked task for a legacy provider journey without an opening run", async () => {
    const harness = createProviderRuntime();
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllama(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "旧地图上的一条河流每晚都会改写自己的入海口。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    expect(await screen.findByRole("dialog", { name: "生成首批三个开头" })).toBeVisible();
    const [seed] = await harness.runtime.creativeJourneys.listActive("idea");
    const seedRun = readOpeningJourneyRun(seed?.snapshot.openingRun);
    if (seed === undefined || seedRun === null) throw new Error("没有取得旧版恢复快照种子。");

    const legacyJourneyId = harness.runtime.ids.next();
    const legacyIdea = "旧版挂起：潮汐档案馆";
    const now = harness.runtime.clock.now();
    await harness.runtime.creativeJourneys.create(
      Object.freeze({
        ...seed,
        id: legacyJourneyId,
        revision: 1,
        snapshot: Object.freeze({
          ...seed.snapshot,
          idea: legacyIdea,
          projectName: legacyIdea,
          openingRun: null,
        }),
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      }),
      Object.freeze({
        id: harness.runtime.ids.next(),
        journeyId: legacyJourneyId,
        sequence: 1,
        kind: "idea" as const,
        questionKey: null,
        generationSource: null,
        providerId: null,
        modelId: null,
        taskKey: "opening_guidance",
        requestId: null,
        snapshot: Object.freeze({ legacyOpeningRun: true }),
        createdAt: now,
      }),
    );
    first.unmount();
    await waitFor(async () => {
      const cancelledSeed = await harness.runtime.creativeJourneys.findById(seed.id);
      expect(readOpeningJourneyRun(cancelledSeed?.snapshot.openingRun)?.stage).toBe(
        "cancelled_before_confirmation",
      );
    });

    harness.generate.mockClear();
    renderJourney(harness.runtime);
    const heading = await screen.findByRole("heading", { name: legacyIdea, level: 3 });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("没有找到旧版挂起旅程恢复卡片。");
    await user.click(within(card).getByRole("button", { name: "继续这次构思" }));

    await waitFor(async () => {
      const recovered = await harness.runtime.creativeJourneys.findById(legacyJourneyId);
      const recoveredRun = readOpeningJourneyRun(recovered?.snapshot.openingRun);
      expect(recoveredRun).toMatchObject({
        stage: "failed",
        batchId: seedRun.batchId,
        supportId: seedRun.batchId,
        requestIds: seedRun.requestIds,
        autoRetryCount: 0,
      });
      const task = (await harness.runtime.taskCenter.load()).tasks.find(
        ({ id }) => id === recoveredRun?.taskId,
      );
      expect(task).toMatchObject({ status: "failed", maxAttempts: 1 });
    });
    expect(harness.generate).not.toHaveBeenCalled();
    expect(
      await Promise.all(
        seedRun.requestIds.map((requestId) => harness.runtime.modelHub.findInvocation(requestId)),
      ),
    ).toEqual([null, null, null]);
  }, 30_000);
});

function createProviderRuntime() {
  const base = createDevelopmentRuntime(window.localStorage);
  const generate = vi.fn((input: Parameters<NativeModelGatewayClient["generate"]>[0]) =>
    Promise.resolve({ text: `供应商开头 ${input.generationId}`, usage: null }),
  );
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    checkConnection: (config) =>
      Promise.resolve({
        provider: config.provider,
        endpointOrigin: new URL(config.baseUrl).origin,
        modelCount: 1,
        latencyMs: 5,
      }),
    listModels: (config) =>
      Promise.resolve({
        provider: config.provider,
        models: [{ id: "local-novel", displayName: "Local Novel" }],
      }),
    generate,
    cancelGeneration: () => Promise.resolve(true),
    embed: base.modelGateway.embed.bind(base.modelGateway),
    ...(base.modelGateway.rerank === undefined
      ? {}
      : { rerank: base.modelGateway.rerank.bind(base.modelGateway) }),
  };
  const runtime: DesktopRuntime = Object.freeze({
    ...base,
    mode: "tauri",
    modelGateway,
  });
  return { runtime, generate };
}

function failNextOpeningSettlementWrite(runtime: DesktopRuntime) {
  const originalUpdate = runtime.creativeJourneys.update.bind(runtime.creativeJourneys);
  let failed = false;
  vi.spyOn(runtime.creativeJourneys, "update").mockImplementation(
    async (...args: Parameters<DesktopRuntime["creativeJourneys"]["update"]>) => {
      const [record] = args;
      const run = readOpeningJourneyRun(record.snapshot.openingRun);
      const suggestions: readonly unknown[] = Array.isArray(record.snapshot.openingSuggestions)
        ? record.snapshot.openingSuggestions
        : [];
      const writesFailedSlot = suggestions.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "status" in value &&
          value.status === "failed" &&
          "batchId" in value &&
          value.batchId === run?.batchId,
      );
      if (!failed && run !== null && writesFailedSlot) {
        failed = true;
        throw Object.assign(new Error("simulated local terminal settlement write failure"), {
          code: "CREATIVE_JOURNEY_STORAGE_WRITE_FAILED",
        });
      }
      return originalUpdate(...args);
    },
  );
  return Object.freeze({
    didFail: () => failed,
  });
}

async function connectOllama(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText("AI 还没连接，也可以开始");
  await user.click(screen.getByRole("button", { name: "去连接模型" }));
  await user.click(screen.getByRole("radio", { name: /Ollama/u }));
  await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
  await screen.findByText("连接成功 · 已找到模型");
  await user.click(screen.getByRole("radio", { name: /让 AI 起个头/u }));
  await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));
  expect(await screen.findByText("发送固定验证前确认", undefined, ASYNC_UI_TIMEOUT)).toBeVisible();
  const confirm = await screen.findByRole(
    "button",
    { name: "确认 1 次固定验证并继续" },
    ASYNC_UI_TIMEOUT,
  );
  await waitFor(() => expect(confirm).toBeEnabled(), ASYNC_UI_TIMEOUT);
  await user.click(confirm);
  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: "连接你的 AI" })).not.toBeInTheDocument();
  });
}

function renderJourney(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter initialEntries={["/create/idea"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <Routes>
            <Route path="/create/idea" element={<IdeaJourneyPage />} />
          </Routes>
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
