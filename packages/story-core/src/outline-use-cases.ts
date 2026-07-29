import { StoryCoreError } from "./errors.js";
import { Outline } from "./outline.js";
import type { OutlineRepository } from "./ports.js";
import { err, ok, type Result } from "./result.js";
import { parseUuidV7, type Clock, type UuidV7Generator } from "./value-objects.js";

export interface OutlineApplicationOptions {
  readonly outlines: OutlineRepository;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export interface CreateOutlineCommand {
  readonly projectId: string;
  readonly title: string;
  readonly synopsis?: string;
}

export type ChangeOutlineCommand =
  | Readonly<{
      kind: "add";
      nodeKind: "volume" | "chapter";
      parentId: string;
      title: string;
      synopsis?: string;
      index?: number;
    }>
  | Readonly<{
      kind: "move";
      nodeId: string;
      newIndex: number;
    }>
  | Readonly<{
      kind: "rename";
      nodeId: string;
      title: string;
    }>
  | Readonly<{
      kind: "update_synopsis";
      nodeId: string;
      synopsis: string;
    }>
  | Readonly<{
      kind: "lock";
      nodeId: string;
    }>
  | Readonly<{
      kind: "unlock";
      nodeId: string;
    }>;

export interface ApplyOutlineChangeCommand {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly change: ChangeOutlineCommand;
}

export class OutlineApplicationService {
  public constructor(private readonly options: OutlineApplicationOptions) {}

  public async create(command: CreateOutlineCommand): Promise<Result<Outline, StoryCoreError>> {
    const outline = Outline.create({
      projectId: command.projectId,
      bookId: this.options.ids.next(),
      title: command.title,
      now: this.options.clock.now(),
      ...(command.synopsis === undefined ? {} : { synopsis: command.synopsis }),
    });
    if (!outline.ok) {
      return outline;
    }
    const saved = await this.options.outlines.create(outline.value);
    return saved.ok ? ok(outline.value) : saved;
  }

  public async apply(command: ApplyOutlineChangeCommand): Promise<Result<Outline, StoryCoreError>> {
    const projectId = parseUuidV7(command.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const loaded = await this.options.outlines.findByProjectId(projectId.value);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      return err(
        new StoryCoreError({
          code: "OUTLINE_NOT_FOUND",
          message: "Project outline was not found.",
        }),
      );
    }

    const outline = loaded.value;
    const now = this.options.clock.now();
    let changed: Result<Outline, StoryCoreError>;
    switch (command.change.kind) {
      case "add":
        changed = outline.addNode({
          id: this.options.ids.next(),
          kind: command.change.nodeKind,
          parentId: command.change.parentId,
          title: command.change.title,
          expectedRevision: command.expectedRevision,
          now,
          ...(command.change.synopsis === undefined ? {} : { synopsis: command.change.synopsis }),
          ...(command.change.index === undefined ? {} : { index: command.change.index }),
        });
        break;
      case "move":
        changed = outline.moveNode(
          command.change.nodeId,
          command.change.newIndex,
          command.expectedRevision,
          now,
        );
        break;
      case "rename":
        changed = outline.renameNode(
          command.change.nodeId,
          command.change.title,
          command.expectedRevision,
          now,
        );
        break;
      case "update_synopsis":
        changed = outline.updateSynopsis(
          command.change.nodeId,
          command.change.synopsis,
          command.expectedRevision,
          now,
        );
        break;
      case "lock":
        changed = outline.lockNode(command.change.nodeId, command.expectedRevision, now);
        break;
      case "unlock":
        changed = outline.unlockNode(command.change.nodeId, command.expectedRevision, now);
        break;
    }
    if (!changed.ok) {
      return changed;
    }
    if (changed.value.revision === outline.revision) {
      return changed;
    }
    const saved = await this.options.outlines.save(changed.value, outline.revision);
    return saved.ok ? changed : saved;
  }
}
