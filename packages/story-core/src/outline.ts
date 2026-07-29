import { StoryCoreError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { MAX_OUTLINE_TEXT_LENGTH, validateBoundedText } from "./safety.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type IsoUtcTimestamp,
  type UuidV7,
} from "./value-objects.js";

export const OUTLINE_NODE_KINDS = ["book", "volume", "chapter"] as const;
export type OutlineNodeKind = (typeof OUTLINE_NODE_KINDS)[number];

export interface OutlineNodeSnapshot {
  readonly id: UuidV7;
  readonly kind: OutlineNodeKind;
  readonly parentId: UuidV7 | null;
  readonly title: string;
  readonly synopsis: string;
  readonly position: number;
  readonly locked: boolean;
  readonly revision: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface OutlineSnapshot {
  readonly projectId: UuidV7;
  readonly revision: number;
  readonly nodes: readonly OutlineNodeSnapshot[];
}

export interface CreateOutlineInput {
  readonly projectId: string;
  readonly bookId: string;
  readonly title: string;
  readonly synopsis?: string;
  readonly now: string;
}

export interface AddOutlineNodeInput {
  readonly id: string;
  readonly kind: Exclude<OutlineNodeKind, "book">;
  readonly parentId: string;
  readonly title: string;
  readonly synopsis?: string;
  readonly index?: number;
  readonly expectedRevision: number;
  readonly now: string;
}

const POSITION_STEP = 1_024;
const MAX_TITLE_LENGTH = 200;

export class Outline {
  private constructor(private readonly snapshot: OutlineSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(input: CreateOutlineInput): Result<Outline, StoryCoreError> {
    const projectId = parseUuidV7(input.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const bookId = parseUuidV7(input.bookId);
    if (!bookId.ok) {
      return bookId;
    }
    const title = validateBoundedText(input.title, MAX_TITLE_LENGTH, "Outline title");
    if (!title.ok) {
      return title;
    }
    const synopsis = validateSynopsis(input.synopsis ?? "");
    if (!synopsis.ok) {
      return synopsis;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    return ok(
      new Outline({
        projectId: projectId.value,
        revision: 1,
        nodes: Object.freeze([
          Object.freeze({
            id: bookId.value,
            kind: "book",
            parentId: null,
            title: title.value,
            synopsis: synopsis.value,
            position: POSITION_STEP,
            locked: false,
            revision: 1,
            createdAt: now.value,
            updatedAt: now.value,
          }),
        ]),
      }),
    );
  }

  public static rehydrate(snapshot: OutlineSnapshot): Result<Outline, StoryCoreError> {
    const validated = validateOutlineSnapshot(snapshot);
    return validated.ok ? ok(new Outline(validated.value)) : validated;
  }

  public get projectId(): UuidV7 {
    return this.snapshot.projectId;
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public toSnapshot(): OutlineSnapshot {
    return cloneOutlineSnapshot(this.snapshot);
  }

  public findNode(id: string): OutlineNodeSnapshot | null {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === id);
    return node === undefined ? null : cloneNode(node);
  }

  public orderedChildren(parentId: string | null): readonly OutlineNodeSnapshot[] {
    return Object.freeze(
      this.snapshot.nodes
        .filter((node) => node.parentId === parentId)
        .sort(compareNodes)
        .map(cloneNode),
    );
  }

  public addNode(input: AddOutlineNodeInput): Result<Outline, StoryCoreError> {
    const revision = this.requireRevision(input.expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    if (this.snapshot.nodes.some((node) => node.id === id.value)) {
      return outlineValidationError("Outline node identifier already exists.");
    }
    const parentId = parseUuidV7(input.parentId);
    if (!parentId.ok) {
      return parentId;
    }
    const parent = this.snapshot.nodes.find((node) => node.id === parentId.value);
    if (
      parent === undefined ||
      (input.kind === "volume" && parent.kind !== "book") ||
      (input.kind === "chapter" && parent.kind !== "volume")
    ) {
      return hierarchyError();
    }
    if (parent.locked) {
      return lockedError(parent.id);
    }
    const title = validateBoundedText(input.title, MAX_TITLE_LENGTH, "Outline title");
    if (!title.ok) {
      return title;
    }
    const synopsis = validateSynopsis(input.synopsis ?? "");
    if (!synopsis.ok) {
      return synopsis;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const chronology = this.requireMutationTime(now.value);
    if (!chronology.ok) {
      return chronology;
    }

    const siblings = this.orderedChildren(parent.id);
    const index = input.index ?? siblings.length;
    if (!Number.isSafeInteger(index) || index < 0 || index > siblings.length) {
      return outlineValidationError("Outline insertion index is invalid.");
    }
    const inserted: OutlineNodeSnapshot = Object.freeze({
      id: id.value,
      kind: input.kind,
      parentId: parent.id,
      title: title.value,
      synopsis: synopsis.value,
      position: 0,
      locked: false,
      revision: 1,
      createdAt: now.value,
      updatedAt: now.value,
    });
    const ordered = [...siblings];
    ordered.splice(index, 0, inserted);
    return this.replaceSiblingOrder(parent.id, ordered, now.value, inserted.id);
  }

  public moveNode(
    nodeIdValue: string,
    newIndex: number,
    expectedRevision: number,
    nowValue: string,
  ): Result<Outline, StoryCoreError> {
    const revision = this.requireRevision(expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    const nodeId = parseUuidV7(nodeIdValue);
    if (!nodeId.ok) {
      return nodeId;
    }
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId.value);
    if (node === undefined) {
      return nodeNotFound();
    }
    if (node.kind === "book" || node.parentId === null) {
      return hierarchyError();
    }
    if (node.locked) {
      return lockedError(node.id);
    }
    const parent = this.snapshot.nodes.find((candidate) => candidate.id === node.parentId);
    if (parent?.locked === true) {
      return lockedError(parent.id);
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    const siblings = [...this.orderedChildren(node.parentId)];
    const currentIndex = siblings.findIndex((candidate) => candidate.id === node.id);
    if (!Number.isSafeInteger(newIndex) || newIndex < 0 || newIndex >= siblings.length) {
      return outlineValidationError("Outline move index is invalid.");
    }
    if (currentIndex === newIndex) {
      return ok(this);
    }
    const chronology = this.requireMutationTime(now.value);
    if (!chronology.ok) {
      return chronology;
    }
    siblings.splice(currentIndex, 1);
    siblings.splice(newIndex, 0, node);
    return this.replaceSiblingOrder(node.parentId, siblings, now.value, null);
  }

  public renameNode(
    nodeIdValue: string,
    titleValue: string,
    expectedRevision: number,
    nowValue: string,
  ): Result<Outline, StoryCoreError> {
    const title = validateBoundedText(titleValue, MAX_TITLE_LENGTH, "Outline title");
    return title.ok
      ? this.updateNode(nodeIdValue, expectedRevision, nowValue, (node, now) => ({
          ...node,
          title: title.value,
          updatedAt: now,
          revision: node.revision + 1,
        }))
      : title;
  }

  public updateSynopsis(
    nodeIdValue: string,
    synopsisValue: string,
    expectedRevision: number,
    nowValue: string,
  ): Result<Outline, StoryCoreError> {
    const synopsis = validateSynopsis(synopsisValue);
    return synopsis.ok
      ? this.updateNode(nodeIdValue, expectedRevision, nowValue, (node, now) => ({
          ...node,
          synopsis: synopsis.value,
          updatedAt: now,
          revision: node.revision + 1,
        }))
      : synopsis;
  }

  public lockNode(
    nodeIdValue: string,
    expectedRevision: number,
    nowValue: string,
  ): Result<Outline, StoryCoreError> {
    return this.setNodeLock(nodeIdValue, true, expectedRevision, nowValue);
  }

  public unlockNode(
    nodeIdValue: string,
    expectedRevision: number,
    nowValue: string,
  ): Result<Outline, StoryCoreError> {
    return this.setNodeLock(nodeIdValue, false, expectedRevision, nowValue);
  }

  private setNodeLock(
    nodeIdValue: string,
    locked: boolean,
    expectedRevision: number,
    nowValue: string,
  ): Result<Outline, StoryCoreError> {
    const revision = this.requireRevision(expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    const nodeId = parseUuidV7(nodeIdValue);
    if (!nodeId.ok) {
      return nodeId;
    }
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId.value);
    if (node === undefined) {
      return nodeNotFound();
    }
    if (node.locked === locked) {
      return ok(this);
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    const chronology = this.requireMutationTime(now.value);
    if (!chronology.ok) {
      return chronology;
    }
    return this.withNodes(
      this.snapshot.nodes.map((candidate) =>
        candidate.id === node.id
          ? Object.freeze({
              ...candidate,
              locked,
              revision: candidate.revision + 1,
              updatedAt: now.value,
            })
          : candidate,
      ),
    );
  }

  private updateNode(
    nodeIdValue: string,
    expectedRevision: number,
    nowValue: string,
    update: (node: OutlineNodeSnapshot, now: IsoUtcTimestamp) => OutlineNodeSnapshot,
  ): Result<Outline, StoryCoreError> {
    const revision = this.requireRevision(expectedRevision);
    if (!revision.ok) {
      return revision;
    }
    const nodeId = parseUuidV7(nodeIdValue);
    if (!nodeId.ok) {
      return nodeId;
    }
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId.value);
    if (node === undefined) {
      return nodeNotFound();
    }
    if (node.locked) {
      return lockedError(node.id);
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    const chronology = this.requireMutationTime(now.value);
    if (!chronology.ok) {
      return chronology;
    }
    return this.withNodes(
      this.snapshot.nodes.map((candidate) =>
        candidate.id === node.id ? Object.freeze(update(candidate, now.value)) : candidate,
      ),
    );
  }

  private replaceSiblingOrder(
    parentId: UuidV7,
    ordered: readonly OutlineNodeSnapshot[],
    now: IsoUtcTimestamp,
    insertedId: UuidV7 | null,
  ): Result<Outline, StoryCoreError> {
    const replacements = new Map<UuidV7, OutlineNodeSnapshot>();
    for (const [index, node] of ordered.entries()) {
      const position = (index + 1) * POSITION_STEP;
      const positionChanged = node.position !== position;
      if (positionChanged && node.locked && node.id !== insertedId) {
        return lockedError(node.id);
      }
      replacements.set(
        node.id,
        Object.freeze({
          ...node,
          parentId,
          position,
          revision:
            node.id === insertedId ? node.revision : node.revision + (positionChanged ? 1 : 0),
          updatedAt: positionChanged ? now : node.updatedAt,
        }),
      );
    }

    const siblingIds = new Set(ordered.map((node) => node.id));
    const untouched = this.snapshot.nodes.filter(
      (node) => node.parentId !== parentId || !siblingIds.has(node.id),
    );
    return this.withNodes([
      ...untouched,
      ...ordered.map((node) => replacements.get(node.id) ?? node),
    ]);
  }

  private withNodes(nodes: readonly OutlineNodeSnapshot[]): Result<Outline, StoryCoreError> {
    return Outline.rehydrate({
      projectId: this.snapshot.projectId,
      revision: this.snapshot.revision + 1,
      nodes,
    });
  }

  private requireRevision(expectedRevision: number): Result<true, StoryCoreError> {
    if (expectedRevision !== this.snapshot.revision) {
      return err(
        new StoryCoreError({
          code: "STORY_REVISION_CONFLICT",
          message: "Outline changed before this edit was applied.",
          retryable: true,
          actions: ["RETRY", "RECOMPARE"],
          details: {
            expectedRevision,
            actualRevision: this.snapshot.revision,
          },
        }),
      );
    }
    return ok(true);
  }

  private requireMutationTime(now: IsoUtcTimestamp): Result<true, StoryCoreError> {
    if (this.snapshot.nodes.some((node) => compareTimestamps(now, node.updatedAt) < 0)) {
      return outlineValidationError(
        "Outline mutation time cannot precede the current aggregate state.",
      );
    }
    return ok(true);
  }
}

function validateOutlineSnapshot(
  snapshot: OutlineSnapshot,
): Result<OutlineSnapshot, StoryCoreError> {
  const projectId = parseUuidV7(snapshot.projectId);
  if (!projectId.ok) {
    return projectId;
  }
  if (
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    snapshot.nodes.length === 0 ||
    snapshot.nodes.length > 100_000 ||
    snapshot.revision < snapshot.nodes.length
  ) {
    return outlineValidationError("Outline revision or size is invalid.");
  }

  const nodes: OutlineNodeSnapshot[] = [];
  const ids = new Set<string>();
  for (const node of snapshot.nodes) {
    const validated = validateNode(node);
    if (!validated.ok) {
      return validated;
    }
    if (ids.has(validated.value.id)) {
      return outlineValidationError("Outline node identifiers must be unique.");
    }
    if (validated.value.revision > snapshot.revision) {
      return outlineValidationError("Outline node revision cannot exceed its aggregate revision.");
    }
    ids.add(validated.value.id);
    nodes.push(validated.value);
  }

  const books = nodes.filter((node) => node.kind === "book");
  if (books.length !== 1 || books[0]?.parentId !== null) {
    return hierarchyError();
  }
  for (const node of nodes) {
    if (node.kind === "book") {
      continue;
    }
    const parent = nodes.find((candidate) => candidate.id === node.parentId);
    if (
      parent === undefined ||
      (node.kind === "volume" && parent.kind !== "book") ||
      (node.kind === "chapter" && parent.kind !== "volume") ||
      compareTimestamps(node.createdAt, parent.createdAt) < 0
    ) {
      return hierarchyError();
    }
  }

  const siblingPositions = new Set<string>();
  for (const node of nodes) {
    const key = `${node.parentId ?? "root"}:${String(node.position)}`;
    if (siblingPositions.has(key)) {
      return outlineValidationError("Sibling positions must be unique and stable.");
    }
    siblingPositions.add(key);
  }

  return ok({
    projectId: projectId.value,
    revision: snapshot.revision,
    nodes: Object.freeze(nodes.map(cloneNode)),
  });
}

function validateNode(node: OutlineNodeSnapshot): Result<OutlineNodeSnapshot, StoryCoreError> {
  const id = parseUuidV7(node.id);
  if (!id.ok) {
    return id;
  }
  const parentId = node.parentId === null ? ok(null) : parseUuidV7(node.parentId);
  if (!parentId.ok) {
    return parentId;
  }
  const title = validateBoundedText(node.title, MAX_TITLE_LENGTH, "Outline title");
  if (!title.ok) {
    return title;
  }
  const synopsis = validateSynopsis(node.synopsis);
  if (!synopsis.ok) {
    return synopsis;
  }
  const createdAt = parseIsoUtcTimestamp(node.createdAt);
  if (!createdAt.ok) {
    return createdAt;
  }
  const updatedAt = parseIsoUtcTimestamp(node.updatedAt);
  if (!updatedAt.ok) {
    return updatedAt;
  }
  if (
    !OUTLINE_NODE_KINDS.includes(node.kind) ||
    !Number.isSafeInteger(node.position) ||
    node.position < 1 ||
    !Number.isSafeInteger(node.revision) ||
    node.revision < 1 ||
    typeof node.locked !== "boolean" ||
    compareTimestamps(updatedAt.value, createdAt.value) < 0
  ) {
    return outlineValidationError("Outline node fields are invalid.");
  }
  return ok(
    Object.freeze({
      id: id.value,
      kind: node.kind,
      parentId: parentId.value,
      title: title.value,
      synopsis: synopsis.value,
      position: node.position,
      locked: node.locked,
      revision: node.revision,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    }),
  );
}

function validateSynopsis(value: string): Result<string, StoryCoreError> {
  return value.length === 0
    ? ok("")
    : validateBoundedText(value, MAX_OUTLINE_TEXT_LENGTH, "Outline synopsis");
}

function cloneOutlineSnapshot(snapshot: OutlineSnapshot): OutlineSnapshot {
  return {
    projectId: snapshot.projectId,
    revision: snapshot.revision,
    nodes: Object.freeze(snapshot.nodes.map(cloneNode)),
  };
}

function cloneNode(node: OutlineNodeSnapshot): OutlineNodeSnapshot {
  return Object.freeze({ ...node });
}

function compareNodes(left: OutlineNodeSnapshot, right: OutlineNodeSnapshot): number {
  return left.position === right.position
    ? left.id.localeCompare(right.id)
    : left.position - right.position;
}

function outlineValidationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
    }),
  );
}

function hierarchyError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "OUTLINE_INVALID_HIERARCHY",
      message: "Outline hierarchy must remain book, volume, chapter.",
    }),
  );
}

function nodeNotFound(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "OUTLINE_NODE_NOT_FOUND",
      message: "Outline node was not found.",
    }),
  );
}

function lockedError(nodeId: UuidV7): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "OUTLINE_NODE_LOCKED",
      message: "Locked outline node must be explicitly unlocked first.",
      actions: ["UNLOCK_NODE"],
      details: { nodeId },
    }),
  );
}
