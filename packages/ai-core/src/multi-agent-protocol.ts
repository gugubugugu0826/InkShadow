export const MULTI_AGENT_REVIEW_MODES = [
  "brainstorm",
  "outline_review",
  "character_review",
  "world_review",
  "commercial_review",
  "plot_planning",
] as const;

export type MultiAgentReviewMode = (typeof MULTI_AGENT_REVIEW_MODES)[number];

export const MULTI_AGENT_CONCLUSION_CATEGORIES = [
  "must_change",
  "suggested_change",
  "optional_enhancement",
  "disputed_opinion",
  "convertible_task",
] as const;

export type MultiAgentConclusionCategory = (typeof MULTI_AGENT_CONCLUSION_CATEGORIES)[number];

export const MULTI_AGENT_SOURCE_KINDS = [
  "chapter",
  "outline_node",
  "material",
  "project_rule",
  "turn",
] as const;

export type MultiAgentSourceKind = (typeof MULTI_AGENT_SOURCE_KINDS)[number];

export interface MultiAgentSourceReference {
  readonly kind: MultiAgentSourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly sourceVersionId: string | null;
  readonly sourceChecksum: string;
  readonly modelLabel: string;
  readonly excerpt: string | null;
}

export interface MultiAgentTaskProposal {
  readonly title: string;
  readonly description: string;
  readonly priority: "p0" | "p1" | "p2" | "p3";
}

export interface MultiAgentStructuredConclusion {
  readonly category: MultiAgentConclusionCategory;
  readonly title: string;
  readonly explanation: string;
  readonly evidence: readonly string[];
  readonly sourceReferences: readonly MultiAgentSourceReference[];
  readonly taskProposal: MultiAgentTaskProposal | null;
}

export interface MultiAgentOutlinePatchChange {
  readonly nodeId: string;
  readonly expectedNodeRevision: number;
  readonly title: string | null;
  readonly synopsis: string | null;
}

export type MultiAgentCandidatePayload =
  | {
      readonly kind: "chapter_content";
      readonly content: string;
    }
  | {
      readonly kind: "outline_patch";
      readonly changes: readonly MultiAgentOutlinePatchChange[];
    };

export interface MultiAgentPublicResponse {
  readonly schemaVersion: 1;
  readonly publicMessage: string;
  readonly conclusions: readonly MultiAgentStructuredConclusion[];
  readonly candidate: MultiAgentCandidatePayload | null;
  readonly needsInput: { readonly question: string } | null;
}

export type MultiAgentProtocolErrorCode =
  | "AGENT_RESPONSE_TOO_LARGE"
  | "AGENT_RESPONSE_INVALID_JSON"
  | "AGENT_RESPONSE_UNSAFE"
  | "AGENT_RESPONSE_SCHEMA_INVALID";

export class MultiAgentProtocolError extends Error {
  public constructor(
    readonly code: MultiAgentProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MultiAgentProtocolError";
  }
}

const MAX_RESPONSE_CODE_UNITS = 1_000_000;
const MAX_PUBLIC_MESSAGE_CODE_UNITS = 40_000;
const MAX_CONCLUSIONS = 64;
const MAX_EVIDENCE_ITEMS = 16;
const MAX_SOURCE_REFERENCES = 32;
const MAX_CHAPTER_CONTENT_CODE_UNITS = 750_000;
const MAX_OUTLINE_PATCH_CHANGES = 2_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/u;
const PROHIBITED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const UNSAFE_CONTROLS_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;
const UNPAIRED_SURROGATE_PATTERN =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u;

/**
 * Parses the complete provider response. Markdown fences, prefixes, suffixes,
 * hidden reasoning fields, prototype-bearing keys, unsafe controls and
 * unbounded payloads are rejected rather than repaired.
 */
export function parseMultiAgentPublicResponse(serialized: string): MultiAgentPublicResponse {
  if (
    typeof serialized !== "string" ||
    serialized.length === 0 ||
    serialized.length > MAX_RESPONSE_CODE_UNITS
  ) {
    throw protocolError(
      "AGENT_RESPONSE_TOO_LARGE",
      "The agent response is empty or exceeds the public response boundary.",
    );
  }
  const trimmed = serialized.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw protocolError(
      "AGENT_RESPONSE_INVALID_JSON",
      "The agent response must be one complete JSON object without wrappers.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw protocolError(
      "AGENT_RESPONSE_INVALID_JSON",
      "The agent response is not valid complete JSON.",
    );
  }
  assertSafeJsonGraph(parsed);
  const root = requireExactObject(parsed, [
    "schemaVersion",
    "publicMessage",
    "conclusions",
    "candidate",
    "needsInput",
  ]);
  if (root.schemaVersion !== 1) {
    throw schemaError("The agent response schema version is unsupported.");
  }
  const publicMessage = requirePublicText(
    root.publicMessage,
    1,
    MAX_PUBLIC_MESSAGE_CODE_UNITS,
    "publicMessage",
  );
  const conclusionsValue = requireArray(root.conclusions, "conclusions", MAX_CONCLUSIONS);
  const conclusions = conclusionsValue.map(parseConclusion);
  const candidate = root.candidate === null ? null : parseCandidate(root.candidate);
  const needsInput =
    root.needsInput === null
      ? null
      : (() => {
          const value = requireExactObject(root.needsInput, ["question"]);
          return Object.freeze({
            question: requirePublicText(value.question, 1, 4_000, "needsInput.question"),
          });
        })();
  if (needsInput !== null && candidate !== null) {
    throw schemaError("A needs-input response cannot publish candidate content.");
  }
  return Object.freeze({
    schemaVersion: 1,
    publicMessage,
    conclusions: Object.freeze(conclusions),
    candidate,
    needsInput,
  });
}

export function serializeMultiAgentPublicResponse(response: MultiAgentPublicResponse): string {
  return JSON.stringify(parseMultiAgentPublicResponse(JSON.stringify(response)));
}

function parseConclusion(value: unknown): MultiAgentStructuredConclusion {
  const conclusion = requireExactObject(value, [
    "category",
    "title",
    "explanation",
    "evidence",
    "sourceReferences",
    "taskProposal",
  ]);
  if (
    typeof conclusion.category !== "string" ||
    !MULTI_AGENT_CONCLUSION_CATEGORIES.includes(conclusion.category as MultiAgentConclusionCategory)
  ) {
    throw schemaError("A conclusion category is invalid.");
  }
  const evidence = requireArray(conclusion.evidence, "conclusion.evidence", MAX_EVIDENCE_ITEMS).map(
    (item) => requirePublicText(item, 1, 4_000, "conclusion.evidence item"),
  );
  const sourceReferences = requireArray(
    conclusion.sourceReferences,
    "conclusion.sourceReferences",
    MAX_SOURCE_REFERENCES,
  ).map(parseSourceReference);
  const taskProposal =
    conclusion.taskProposal === null ? null : parseTaskProposal(conclusion.taskProposal);
  if (conclusion.category === "convertible_task" && taskProposal === null) {
    throw schemaError("A convertible-task conclusion must include a task proposal.");
  }
  if (conclusion.category !== "convertible_task" && taskProposal !== null) {
    throw schemaError("Only a convertible-task conclusion may include a task proposal.");
  }
  return Object.freeze({
    category: conclusion.category as MultiAgentConclusionCategory,
    title: requirePublicText(conclusion.title, 1, 240, "conclusion.title"),
    explanation: requirePublicText(conclusion.explanation, 1, 12_000, "conclusion.explanation"),
    evidence: Object.freeze(evidence),
    sourceReferences: Object.freeze(sourceReferences),
    taskProposal,
  });
}

function parseSourceReference(value: unknown): MultiAgentSourceReference {
  const reference = requireExactObject(value, [
    "kind",
    "sourceId",
    "sourceRevision",
    "sourceVersionId",
    "sourceChecksum",
    "modelLabel",
    "excerpt",
  ]);
  if (
    typeof reference.kind !== "string" ||
    !MULTI_AGENT_SOURCE_KINDS.includes(reference.kind as MultiAgentSourceKind)
  ) {
    throw schemaError("A source reference kind is invalid.");
  }
  if (!Number.isSafeInteger(reference.sourceRevision) || (reference.sourceRevision as number) < 1) {
    throw schemaError("A source reference revision is invalid.");
  }
  const sourceVersionId =
    reference.sourceVersionId === null
      ? null
      : requireIdentifier(reference.sourceVersionId, "sourceReference.sourceVersionId");
  if (
    (reference.kind === "chapter") !== (sourceVersionId !== null) ||
    typeof reference.sourceChecksum !== "string" ||
    !/^[a-f0-9]{64}$/u.test(reference.sourceChecksum)
  ) {
    throw schemaError("A source reference authority receipt is invalid.");
  }
  return Object.freeze({
    kind: reference.kind as MultiAgentSourceKind,
    sourceId: requireIdentifier(reference.sourceId, "sourceReference.sourceId"),
    sourceRevision: reference.sourceRevision as number,
    sourceVersionId,
    sourceChecksum: reference.sourceChecksum,
    modelLabel: requirePublicText(reference.modelLabel, 1, 240, "sourceReference.modelLabel"),
    excerpt:
      reference.excerpt === null
        ? null
        : requirePublicText(reference.excerpt, 1, 2_000, "sourceReference.excerpt"),
  });
}

function parseTaskProposal(value: unknown): MultiAgentTaskProposal {
  const task = requireExactObject(value, ["title", "description", "priority"]);
  if (typeof task.priority !== "string" || !["p0", "p1", "p2", "p3"].includes(task.priority)) {
    throw schemaError("A task proposal priority is invalid.");
  }
  return Object.freeze({
    title: requirePublicText(task.title, 1, 240, "taskProposal.title"),
    description: requirePublicText(task.description, 1, 8_000, "taskProposal.description"),
    priority: task.priority as MultiAgentTaskProposal["priority"],
  });
}

function parseCandidate(value: unknown): MultiAgentCandidatePayload {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw schemaError("The candidate payload is invalid.");
  }
  if (value.kind === "chapter_content") {
    const candidate = requireExactObject(value, ["kind", "content"]);
    return Object.freeze({
      kind: "chapter_content",
      content: requirePublicText(
        candidate.content,
        1,
        MAX_CHAPTER_CONTENT_CODE_UNITS,
        "candidate.content",
      ),
    });
  }
  if (value.kind === "outline_patch") {
    const candidate = requireExactObject(value, ["kind", "changes"]);
    const changes = requireArray(
      candidate.changes,
      "candidate.changes",
      MAX_OUTLINE_PATCH_CHANGES,
      1,
    ).map(parseOutlinePatchChange);
    const nodeIds = new Set<string>();
    for (const change of changes) {
      if (nodeIds.has(change.nodeId)) {
        throw schemaError("An outline patch cannot update the same node twice.");
      }
      nodeIds.add(change.nodeId);
    }
    return Object.freeze({
      kind: "outline_patch",
      changes: Object.freeze(changes),
    });
  }
  throw schemaError("The candidate kind is invalid.");
}

function parseOutlinePatchChange(value: unknown): MultiAgentOutlinePatchChange {
  const change = requireExactObject(value, ["nodeId", "expectedNodeRevision", "title", "synopsis"]);
  if (
    !Number.isSafeInteger(change.expectedNodeRevision) ||
    (change.expectedNodeRevision as number) < 1 ||
    (change.expectedNodeRevision as number) > Number.MAX_SAFE_INTEGER - 1
  ) {
    throw schemaError("An outline patch node revision is invalid.");
  }
  const title =
    change.title === null
      ? null
      : requirePublicText(change.title, 1, 200, "candidate.change.title");
  const synopsis =
    change.synopsis === null
      ? null
      : requirePublicText(change.synopsis, 0, 50_000, "candidate.change.synopsis");
  if (title === null && synopsis === null) {
    throw schemaError("An outline patch change must update a title or synopsis.");
  }
  return Object.freeze({
    nodeId: requireIdentifier(change.nodeId, "candidate.change.nodeId"),
    expectedNodeRevision: change.expectedNodeRevision as number,
    title,
    synopsis,
  });
}

function assertSafeJsonGraph(root: unknown): void {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: root, depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    nodeCount += 1;
    if (nodeCount > 20_000 || current.depth > 12) {
      throw protocolError("AGENT_RESPONSE_UNSAFE", "The agent response graph is too complex.");
    }
    if (typeof current.value === "string") {
      assertSafeUnicode(current.value);
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      typeof current.value === "number"
    ) {
      if (typeof current.value === "number" && !Number.isFinite(current.value)) {
        throw protocolError(
          "AGENT_RESPONSE_UNSAFE",
          "The agent response contains a non-finite number.",
        );
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        stack.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) {
      throw protocolError("AGENT_RESPONSE_UNSAFE", "The agent response contains a non-JSON value.");
    }
    for (const [key, entry] of Object.entries(current.value)) {
      if (PROHIBITED_KEYS.has(key)) {
        throw protocolError(
          "AGENT_RESPONSE_UNSAFE",
          "The agent response contains a prohibited object key.",
        );
      }
      assertSafeUnicode(key);
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
}

function requireExactObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw schemaError("An agent response object is invalid.");
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw schemaError("An agent response object contains missing or unexpected fields.");
  }
  return value;
}

function requireArray(
  value: unknown,
  field: string,
  maximumLength: number,
  minimumLength = 0,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumLength) {
    throw schemaError(`${field} has an invalid item count.`);
  }
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw schemaError(`${field} must be a bounded portable identifier.`);
  }
  return value;
}

function requirePublicText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  field: string,
): string {
  if (typeof value !== "string" || value.length < minimumLength || value.length > maximumLength) {
    throw schemaError(`${field} has an invalid length.`);
  }
  assertSafeUnicode(value);
  const normalized = value.normalize("NFC");
  if (normalized.length < minimumLength || normalized.length > maximumLength) {
    throw schemaError(`${field} has an invalid normalized length.`);
  }
  return normalized;
}

function assertSafeUnicode(value: string): void {
  if (UNSAFE_CONTROLS_PATTERN.test(value) || UNPAIRED_SURROGATE_PATTERN.test(value)) {
    throw protocolError(
      "AGENT_RESPONSE_UNSAFE",
      "The agent response contains unsafe Unicode controls.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaError(message: string): MultiAgentProtocolError {
  return protocolError("AGENT_RESPONSE_SCHEMA_INVALID", message);
}

function protocolError(
  code: MultiAgentProtocolErrorCode,
  message: string,
): MultiAgentProtocolError {
  return new MultiAgentProtocolError(code, message);
}
