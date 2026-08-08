import { AiCandidate, AppError, err, ok, type Result, type UuidV7 } from "@inkshadow/domain";

import { ModelCenterError, type ModelProfile } from "./model-center-store";
import { executeModelHubTextTask, ModelHubExecutionError } from "./model-hub-execution-service";
import {
  resolveFinalModelProfileGatewayConfig,
  resolveModelProfileGatewayConfig,
} from "./model-profile-gateway-config";
import type { DesktopRuntime, NativeModelMessage } from "./runtime";

export interface CreativeOpeningResult {
  readonly requestId: string;
  readonly text: string;
  readonly source: "provider" | "local_fallback";
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly noticeCode: string | null;
}

export type CreativeOpeningAngle = "immediate_action" | "relationship_dialogue" | "mystery_clue";

export type CreativeOpeningDestination =
  Readonly<{ kind: "local" }> | Readonly<{ kind: "provider"; providerId: string; modelId: string }>;

export async function inspectCreativeOpeningDestination(
  runtime: DesktopRuntime,
): Promise<CreativeOpeningDestination> {
  if (runtime.mode === "tauri") {
    const route = await runtime.modelHub.findTaskRoute("book_start_guidance").catch(() => null);
    if (route?.enabled === true) {
      const connections = await runtime.modelHub.listConnections().catch(() => []);
      for (const catalogEntryId of [route.primaryCatalogEntryId, route.fallbackCatalogEntryId]) {
        if (catalogEntryId === null) {
          continue;
        }
        for (const connection of connections) {
          if (
            !connection.enabled ||
            (connection.connectionStatus !== "ready" && connection.connectionStatus !== "degraded")
          ) {
            continue;
          }
          const catalog = await runtime.modelHub.listCatalog(connection.id).catch(() => []);
          const entry = catalog.find(({ id }) => id === catalogEntryId);
          if (entry !== undefined) {
            return {
              kind: "provider",
              providerId: connection.id,
              modelId: entry.providerModelId,
            };
          }
        }
      }
      return { kind: "local" };
    }
  }
  const profile = await resolveOpeningProfile(runtime).catch(() => null);
  return runtime.mode === "tauri" && profile?.selectedModel !== null && profile !== null
    ? { kind: "provider", providerId: profile.providerId, modelId: profile.selectedModel }
    : { kind: "local" };
}

export async function generateCreativeOpening(
  runtime: DesktopRuntime,
  input: Readonly<{
    idea: string;
    direction?: string;
    answers?: Readonly<Record<string, string>>;
    openingAngle?: CreativeOpeningAngle;
    requestId?: string;
    onDelta?: (text: string) => void;
  }>,
): Promise<CreativeOpeningResult> {
  const idea = validateCreativeText(input.idea, 4_000, "idea");
  const direction =
    input.direction === undefined || input.direction.trim().length === 0
      ? null
      : validateCreativeText(input.direction, 1_000, "direction");
  const requestId = input.requestId ?? runtime.ids.next();
  const messages = buildOpeningMessages(
    idea,
    direction,
    input.answers ?? {},
    input.openingAngle ?? null,
  );

  if (runtime.mode === "tauri" && runtime.modelGateway.available) {
    try {
      const generated = await executeModelHubTextTask(runtime, {
        dispatchScope: { kind: "non_project", reason: "creative_opening" },
        task: "book_start_guidance",
        messages,
        maximumOutputTokens: 1_200,
        temperature: 0.85,
        generationId: requestId,
        ...(input.onDelta === undefined ? {} : { onDelta: input.onDelta }),
      });
      const text = generated.text.trim();
      if (text.length === 0) {
        return localOpening(requestId, idea, direction, "MODEL_OUTPUT_EMPTY");
      }
      return Object.freeze({
        requestId,
        text,
        source: "provider",
        providerId: generated.connectionId,
        modelId: generated.modelId,
        noticeCode: generated.costCeilingExceededAfterDispatch
          ? "MODEL_HUB_COST_CEILING_EXCEEDED_AFTER_DISPATCH"
          : null,
      });
    } catch (cause: unknown) {
      if (
        !(cause instanceof ModelHubExecutionError) ||
        cause.code !== "MODEL_HUB_ROUTE_NOT_CONFIGURED"
      ) {
        return localOpening(requestId, idea, direction, safeModelFailureCode(cause));
      }
    }
  }

  const profile = await resolveOpeningProfile(runtime).catch(() => null);

  if (runtime.mode !== "tauri" || profile?.selectedModel === null || profile === null) {
    return localOpening(requestId, idea, direction, "MODEL_NOT_CONNECTED");
  }

  const resolvedEndpoint = await resolveModelProfileGatewayConfig(
    { modelHub: runtime.modelHub, credentials: runtime.credentials },
    profile,
  ).catch(() => null);
  if (resolvedEndpoint === null) {
    return localOpening(requestId, idea, direction, "MODEL_CREDENTIAL_MISSING");
  }

  try {
    const inputBytes = new TextEncoder().encode(
      messages.map(({ content }) => content).join("\n"),
    ).length;
    if (inputBytes > 64_000) {
      return localOpening(requestId, idea, direction, "MODEL_INPUT_TOO_LARGE");
    }
    const listed = await runtime.modelGateway.listModels(resolvedEndpoint.config);
    if (!listed.models.some(({ id }) => id === profile.selectedModel)) {
      return localOpening(requestId, idea, direction, "SELECTED_MODEL_UNAVAILABLE");
    }
    const current = await resolveFinalModelProfileGatewayConfig(
      {
        modelCenter: runtime.modelCenter,
        modelHub: runtime.modelHub,
        credentials: runtime.credentials,
      },
      profile,
      resolvedEndpoint,
    );
    const generated = await runtime.modelGateway.generate({
      dispatchScope: { kind: "non_project", reason: "creative_opening" },
      generationId: requestId,
      config: current.resolution.config,
      model: current.profile.selectedModel ?? profile.selectedModel,
      messages,
      maxOutputTokens: 1_200,
      temperature: 0.85,
      ...(input.onDelta === undefined ? {} : { onDelta: input.onDelta }),
    });
    const text = generated.text.trim();
    if (text.length === 0) {
      return localOpening(requestId, idea, direction, "MODEL_OUTPUT_EMPTY");
    }
    return Object.freeze({
      requestId,
      text,
      source: "provider",
      providerId: profile.providerId,
      modelId: profile.selectedModel,
      noticeCode: null,
    });
  } catch (cause: unknown) {
    return localOpening(requestId, idea, direction, safeModelFailureCode(cause));
  }
}

/** Returns the deterministic, clearly labelled local example without contacting a provider. */
export function generateLocalCreativeOpening(
  runtime: Pick<DesktopRuntime, "ids">,
  input: Readonly<{ idea: string; direction?: string; requestId?: string }>,
): CreativeOpeningResult {
  const idea = validateCreativeText(input.idea, 4_000, "idea");
  const direction =
    input.direction === undefined || input.direction.trim().length === 0
      ? null
      : validateCreativeText(input.direction, 1_000, "direction");
  return localOpening(input.requestId ?? runtime.ids.next(), idea, direction, "LOCAL_SAMPLE");
}

export async function persistCreativeOpeningCandidate(
  runtime: DesktopRuntime,
  chapterId: UuidV7,
  textValue: string,
  candidateId?: UuidV7,
): Promise<Result<AiCandidate, AppError | ModelCenterError>> {
  const chapterResult = await runtime.repositories.chapters.findById(chapterId);
  if (!chapterResult.ok) {
    return chapterResult;
  }
  const chapter = chapterResult.value;
  if (chapter === null) {
    return err(
      new AppError({
        code: "CHAPTER_NOT_FOUND",
        message: "The opening chapter no longer exists.",
      }),
    );
  }
  const text = validateCreativeText(textValue, 5_000_000, "opening");
  const streaming = AiCandidate.createStreaming({
    id: candidateId ?? runtime.ids.next(),
    projectId: chapter.projectId,
    chapterId: chapter.id,
    source: "generate",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
  });
  if (!streaming.ok) {
    return streaming;
  }
  const checksum = await runtime.hasher.sha256(text);
  if (!checksum.ok) {
    return checksum;
  }
  const ready = streaming.value.markReady(text, checksum.value, runtime.clock.now());
  if (!ready.ok) {
    return ready;
  }
  const saved = await runtime.repositories.aiCandidates.create(ready.value);
  return saved.ok ? ok(ready.value) : saved;
}

async function resolveOpeningProfile(runtime: DesktopRuntime): Promise<ModelProfile | null> {
  const [profiles, highQuality, fast] = await Promise.all([
    runtime.modelCenter.listProfiles(),
    runtime.modelRouting.findRoute("high_quality"),
    runtime.modelRouting.findRoute("fast"),
  ]);
  for (const route of [highQuality, fast]) {
    if (route === null) {
      continue;
    }
    const primary = profiles.find(
      ({ providerId, selectedModel }) =>
        providerId === route.primaryProviderId && selectedModel === route.primaryModelId,
    );
    if (primary !== undefined) {
      return primary;
    }
    const fallback = profiles.find(
      ({ providerId, selectedModel }) =>
        providerId === route.fallbackProviderId && selectedModel === route.fallbackModelId,
    );
    if (fallback !== undefined) {
      return fallback;
    }
  }
  return profiles.find(({ selectedModel }) => selectedModel !== null) ?? null;
}

function buildOpeningMessages(
  idea: string,
  direction: string | null,
  answers: Readonly<Record<string, string>>,
  openingAngle: CreativeOpeningAngle | null,
): readonly NativeModelMessage[] {
  const known = Object.entries(answers)
    .filter(([, value]) => value.trim().length > 0)
    .slice(0, 12)
    .map(([key, value]) => `${key}：${value}`)
    .join("\n");
  return Object.freeze([
    {
      role: "system",
      content:
        "你是长篇小说开篇助手。根据作者的一句话灵感写一段 500 至 900 字、可直接继续修改的小说开头。只输出正文，不要标题、分析、设定表、Markdown 围栏或元评论。不要把推测写成已经确认的长期设定；聚焦具体场景、人物行动和一个能推动下一段的问题。",
    },
    {
      role: "user",
      content: [
        `作者的一句话灵感：${idea}`,
        direction === null ? "" : `本轮修改方向：${direction}`,
        openingAngle === null ? "" : `本次开头方案侧重：${openingAngleInstruction(openingAngle)}`,
        known.length === 0 ? "" : `作者已经表达的偏好：\n${known}`,
      ]
        .filter((value) => value.length > 0)
        .join("\n\n"),
    },
  ]);
}

function openingAngleInstruction(angle: CreativeOpeningAngle): string {
  switch (angle) {
    case "immediate_action":
      return "从一个正在发生的选择或行动切入，尽快建立场景目标";
    case "relationship_dialogue":
      return "从人物关系与具体对话切入，让关系张力推动读者继续阅读";
    case "mystery_clue":
      return "从一个异常细节或未解线索切入，但不要提前解释真相";
  }
}

function localOpening(
  requestId: string,
  idea: string,
  direction: string | null,
  noticeCode: string,
): CreativeOpeningResult {
  const subject = idea.replaceAll(/\s+/gu, " ").slice(0, 80);
  const directionHint = direction === null ? "" : localDirectionHint(direction);
  const text = [
    `傍晚六点十七分，天光刚从窗沿退下去，${subject}这件事第一次有了真实的重量。`,
    `房间里没有人催促，桌上的水却已经凉了。主角盯着那条刚出现的消息，手指停在屏幕上方，明明只要轻轻一点，原本熟悉的生活就会从这里裂开一道缝${directionHint}。`,
    `门外传来脚步声。对方没有敲门，只隔着薄薄的门板叫了一次名字。那声音太平静，反而让人无法继续假装什么都没有发生。`,
    `主角把手机扣在桌面，站起身时碰倒了椅子。就在门被推开的前一秒，屏幕再次亮起——这次只有一句话：别相信刚才见到的那个人。`,
  ].join("\n\n");
  return Object.freeze({
    requestId,
    text,
    source: "local_fallback",
    providerId: null,
    modelId: null,
    noticeCode,
  });
}

function localDirectionHint(direction: string): string {
  const commonDirections: Readonly<Record<string, string>> = {
    更甜一点: "，而一丝尚未说破的甜意正悄悄靠近",
    更搞笑一点: "，而一个意料之外的误会正把紧张悄悄冲淡",
    增加悬念: "，而那条消息背后显然还藏着另一层真相",
    换一种男女主关系: "，而门外那个人与主角的关系或许并非表面那样",
    更接近日系轻小说: "，而日常与异常的边界正从这一刻开始松动",
  };
  return (
    commonDirections[direction] ??
    `，而“${direction.replaceAll(/[“”"]/gu, "").slice(0, 24)}”会从这一刻改变故事的走向`
  );
}

function validateCreativeText(value: string, maximum: number, label: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ModelCenterError(
      "CREATIVE_INPUT_INVALID",
      `${label} does not satisfy the creative input policy.`,
    );
  }
  return normalized;
}

function safeModelFailureCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/u.test(cause.code)
  ) {
    return cause.code;
  }
  return "MODEL_GENERATION_FAILED";
}
