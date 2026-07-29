import { describe, expect, it } from "vitest";
import { Outline } from "../src/index.js";
import { unwrap, uuid } from "./helpers.js";

describe("three-level outline", () => {
  it("keeps deterministic sibling order through rehydration", () => {
    const projectId = uuid(1);
    const bookId = uuid(2);
    const firstVolumeId = uuid(3);
    const secondVolumeId = uuid(4);
    let outline = unwrap(
      Outline.create({
        projectId,
        bookId,
        title: "Book",
        now: "2026-07-27T00:00:00.000Z",
      }),
    );
    outline = unwrap(
      outline.addNode({
        id: firstVolumeId,
        kind: "volume",
        parentId: bookId,
        title: "First",
        expectedRevision: 1,
        now: "2026-07-27T00:01:00.000Z",
      }),
    );
    outline = unwrap(
      outline.addNode({
        id: secondVolumeId,
        kind: "volume",
        parentId: bookId,
        title: "Second",
        index: 0,
        expectedRevision: 2,
        now: "2026-07-27T00:02:00.000Z",
      }),
    );

    expect(outline.orderedChildren(bookId).map((node) => node.id)).toEqual([
      secondVolumeId,
      firstVolumeId,
    ]);
    expect(outline.orderedChildren(bookId).map((node) => node.position)).toEqual([1_024, 2_048]);

    const snapshot = outline.toSnapshot();
    const restored = unwrap(
      Outline.rehydrate({
        ...snapshot,
        nodes: [...snapshot.nodes].reverse(),
      }),
    );
    expect(restored.orderedChildren(bookId).map((node) => node.id)).toEqual([
      secondVolumeId,
      firstVolumeId,
    ]);
  });

  it("enforces book-volume-chapter hierarchy and aggregate revision", () => {
    const bookId = uuid(11);
    const volumeId = uuid(12);
    const outline = unwrap(
      Outline.create({
        projectId: uuid(10),
        bookId,
        title: "Book",
        now: "2026-07-27T00:00:00.000Z",
      }),
    );

    const invalid = outline.addNode({
      id: uuid(13),
      kind: "chapter",
      parentId: bookId,
      title: "Chapter",
      expectedRevision: 1,
      now: "2026-07-27T00:01:00.000Z",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("OUTLINE_INVALID_HIERARCHY");
    }

    const withVolume = unwrap(
      outline.addNode({
        id: volumeId,
        kind: "volume",
        parentId: bookId,
        title: "Volume",
        expectedRevision: 1,
        now: "2026-07-27T00:02:00.000Z",
      }),
    );
    const stale = withVolume.addNode({
      id: uuid(14),
      kind: "chapter",
      parentId: volumeId,
      title: "Chapter",
      expectedRevision: 1,
      now: "2026-07-27T00:03:00.000Z",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("STORY_REVISION_CONFLICT");
    }

    const withChapter = unwrap(
      withVolume.addNode({
        id: uuid(14),
        kind: "chapter",
        parentId: volumeId,
        title: "Chapter",
        expectedRevision: 2,
        now: "2026-07-27T00:03:00.000Z",
      }),
    );
    expect(withChapter.findNode(uuid(14))?.kind).toBe("chapter");
  });

  it("protects locked nodes, locked parents, and their stable positions", () => {
    const bookId = uuid(21);
    const firstVolumeId = uuid(22);
    const lockedVolumeId = uuid(23);
    let outline = unwrap(
      Outline.create({
        projectId: uuid(20),
        bookId,
        title: "Book",
        now: "2026-07-27T00:00:00.000Z",
      }),
    );
    outline = unwrap(
      outline.addNode({
        id: firstVolumeId,
        kind: "volume",
        parentId: bookId,
        title: "First",
        expectedRevision: 1,
        now: "2026-07-27T00:01:00.000Z",
      }),
    );
    outline = unwrap(
      outline.addNode({
        id: lockedVolumeId,
        kind: "volume",
        parentId: bookId,
        title: "Locked",
        expectedRevision: 2,
        now: "2026-07-27T00:02:00.000Z",
      }),
    );
    outline = unwrap(outline.lockNode(lockedVolumeId, 3, "2026-07-27T00:03:00.000Z"));

    const rename = outline.renameNode(lockedVolumeId, "Changed", 4, "2026-07-27T00:04:00.000Z");
    expect(rename.ok).toBe(false);
    if (!rename.ok) {
      expect(rename.error.code).toBe("OUTLINE_NODE_LOCKED");
    }

    const addChild = outline.addNode({
      id: uuid(24),
      kind: "chapter",
      parentId: lockedVolumeId,
      title: "Blocked child",
      expectedRevision: 4,
      now: "2026-07-27T00:04:00.000Z",
    });
    expect(addChild.ok).toBe(false);
    if (!addChild.ok) {
      expect(addChild.error.code).toBe("OUTLINE_NODE_LOCKED");
    }

    const shiftLockedPosition = outline.addNode({
      id: uuid(25),
      kind: "volume",
      parentId: bookId,
      title: "Inserted before locked",
      index: 1,
      expectedRevision: 4,
      now: "2026-07-27T00:04:00.000Z",
    });
    expect(shiftLockedPosition.ok).toBe(false);
    if (!shiftLockedPosition.ok) {
      expect(shiftLockedPosition.error.code).toBe("OUTLINE_NODE_LOCKED");
    }

    const unlocked = unwrap(outline.unlockNode(lockedVolumeId, 4, "2026-07-27T00:05:00.000Z"));
    const moved = unwrap(unlocked.moveNode(lockedVolumeId, 0, 5, "2026-07-27T00:06:00.000Z"));
    expect(moved.orderedChildren(bookId)[0]?.id).toBe(lockedVolumeId);
  });
});
