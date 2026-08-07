import {
  AiCandidate,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
} from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { evaluateGeneratedCandidateQuality } from "./candidate-quality-evaluator";

function readyCandidate(content: string): AiCandidate {
  const id = parseUuidV7("019f9f4a-b3c7-7350-9226-000000000001");
  const projectId = parseUuidV7("019f9f4a-b3c7-7350-9226-000000000002");
  const chapterId = parseUuidV7("019f9f4a-b3c7-7350-9226-000000000003");
  const versionId = parseUuidV7("019f9f4a-b3c7-7350-9226-000000000004");
  const now = parseIsoUtcTimestamp("2026-08-01T00:00:00.000Z");
  const checksum = parseContentChecksum("a".repeat(64));
  if (!id.ok || !projectId.ok || !chapterId.ok || !versionId.ok || !now.ok || !checksum.ok) {
    throw new Error("fixture invalid");
  }
  const streaming = AiCandidate.createStreaming({
    id: id.value,
    projectId: projectId.value,
    chapterId: chapterId.value,
    source: "generate",
    baseVersionId: versionId.value,
    now: now.value,
  });
  if (!streaming.ok) throw streaming.error;
  const ready = streaming.value.markReady(content, checksum.value, now.value);
  if (!ready.ok) throw ready.error;
  return ready.value;
}

describe("candidate quality evaluator", () => {
  it("passes a candidate without sentence-level repetition", () => {
    const result = evaluateGeneratedCandidateQuality({
      candidate: readyCandidate("雨停后，城门终于打开。她没有回头，沿着新铺的石路走向灯火。"),
      promptTraceId: "019f9f4a-b3c7-7350-9226-000000000005",
      promptContentHashSha256: "b".repeat(64),
      measuredAt: "2026-08-01T00:00:00.000Z",
    });
    expect(result.outcome).toBe("pass");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.metric).toBe("repetition");
  });

  it("blocks obviously repeated candidate text without inventing other scores", () => {
    const repeated = "他推开生锈的门，听见走廊尽头传来脚步声。";
    const result = evaluateGeneratedCandidateQuality({
      candidate: readyCandidate(`${repeated}${repeated}${repeated}${repeated}`),
      promptTraceId: "019f9f4a-b3c7-7350-9226-000000000005",
      promptContentHashSha256: "b".repeat(64),
      measuredAt: "2026-08-01T00:00:00.000Z",
    });
    expect(result.outcome).toBe("block");
    expect(result.blockingCodes).toContain("quality.repetition.below_threshold");
    expect(result.results.map(({ metric }) => metric)).toEqual(["repetition"]);
  });

  it("scores only newly generated text when a full candidate includes the saved baseline", () => {
    const repeatedBaseline = "旧句反复出现。旧句反复出现。旧句反复出现。旧句反复出现。";
    const result = evaluateGeneratedCandidateQuality({
      candidate: readyCandidate(
        `${repeatedBaseline}\n\n雨停后，她把钥匙放回口袋，沿着河岸继续前行。`,
      ),
      baselineContent: repeatedBaseline,
      promptTraceId: "019f9f4a-b3c7-7350-9226-000000000005",
      promptContentHashSha256: "b".repeat(64),
      measuredAt: "2026-08-01T00:00:00.000Z",
    });
    expect(result.outcome).toBe("pass");
  });
});
