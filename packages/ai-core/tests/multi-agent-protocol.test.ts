import { describe, expect, it } from "vitest";

import {
  MultiAgentProtocolError,
  parseMultiAgentPublicResponse,
  serializeMultiAgentPublicResponse,
} from "../src/index.js";

function validResponse() {
  return {
    schemaVersion: 1,
    publicMessage: "公开评审结论。",
    conclusions: [
      {
        category: "convertible_task",
        title: "补强动机",
        explanation: "第二幕转折缺少可验证的角色动机。",
        evidence: ["角色在前一场仍明确拒绝该行动。"],
        sourceReferences: [
          {
            kind: "chapter",
            sourceId: "chapter-1",
            sourceRevision: 3,
            sourceVersionId: "version-3",
            sourceChecksum: "a".repeat(64),
            modelLabel: "第二章",
            excerpt: "她拒绝离开。",
          },
        ],
        taskProposal: {
          title: "补写动机铺垫",
          description: "在第二幕转折前增加一次明确选择。",
          priority: "p1",
        },
      },
    ],
    candidate: {
      kind: "outline_patch",
      changes: [
        {
          nodeId: "node-1",
          expectedNodeRevision: 3,
          title: null,
          synopsis: "增加角色主动选择的铺垫。",
        },
      ],
    },
    needsInput: null,
  } as const;
}

describe("multi-agent public response protocol", () => {
  it("accepts and canonically serializes a bounded public response", () => {
    const parsed = parseMultiAgentPublicResponse(JSON.stringify(validResponse()));

    expect(parsed.publicMessage).toBe("公开评审结论。");
    expect(parsed.conclusions[0]).toMatchObject({
      category: "convertible_task",
      taskProposal: { priority: "p1" },
    });
    expect(JSON.parse(serializeMultiAgentPublicResponse(parsed))).toEqual(parsed);
  });

  it("requires one complete JSON object and rejects hidden or unexpected fields", () => {
    expect(() =>
      parseMultiAgentPublicResponse(`\`\`\`json\n${JSON.stringify(validResponse())}\n\`\`\``),
    ).toThrow(expect.objectContaining({ code: "AGENT_RESPONSE_INVALID_JSON" }));
    expect(() =>
      parseMultiAgentPublicResponse(
        JSON.stringify({
          ...validResponse(),
          hiddenReasoning: "private chain of thought",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "AGENT_RESPONSE_SCHEMA_INVALID" }));
  });

  it("rejects prototype-bearing keys, unsafe controls, duplicate patch targets and huge payloads", () => {
    const unsafe = JSON.stringify(validResponse()).replace(
      '"publicMessage":"公开评审结论。"',
      '"publicMessage":"公开\\u202E评审"',
    );
    expect(() => parseMultiAgentPublicResponse(unsafe)).toThrow(
      expect.objectContaining({ code: "AGENT_RESPONSE_UNSAFE" }),
    );
    const polluted = JSON.stringify(validResponse()).replace(
      '"schemaVersion":1',
      '"__proto__":{"polluted":true},"schemaVersion":1',
    );
    expect(() => parseMultiAgentPublicResponse(polluted)).toThrow(MultiAgentProtocolError);
    expect(() =>
      parseMultiAgentPublicResponse(
        JSON.stringify({
          ...validResponse(),
          candidate: {
            kind: "outline_patch",
            changes: [validResponse().candidate.changes[0], validResponse().candidate.changes[0]],
          },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "AGENT_RESPONSE_SCHEMA_INVALID" }));
    expect(() => parseMultiAgentPublicResponse(`{"padding":"${"x".repeat(1_000_001)}"}`)).toThrow(
      expect.objectContaining({ code: "AGENT_RESPONSE_TOO_LARGE" }),
    );
  });

  it("requires task proposals only for convertible-task conclusions", () => {
    const invalid = validResponse();
    expect(() =>
      parseMultiAgentPublicResponse(
        JSON.stringify({
          ...invalid,
          conclusions: [
            {
              ...invalid.conclusions[0],
              category: "must_change",
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "AGENT_RESPONSE_SCHEMA_INVALID" }));
  });

  it("rejects outline revisions that cannot be incremented safely", () => {
    expect(() =>
      parseMultiAgentPublicResponse(
        JSON.stringify({
          ...validResponse(),
          candidate: {
            kind: "outline_patch",
            changes: [
              {
                nodeId: "node-1",
                expectedNodeRevision: Number.MAX_SAFE_INTEGER,
                title: "Unsafe",
                synopsis: null,
              },
            ],
          },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "AGENT_RESPONSE_SCHEMA_INVALID" }));
  });
});
