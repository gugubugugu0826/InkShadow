import { TaskEngineError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import {
  cloneSafeMetadata,
  createSafeMetadata,
  safeMetadataEquals,
  type SafeMetadata,
} from "./safety.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseMessageKey,
  parseNotificationDedupeKey,
  parseUuidV7,
  type IsoUtcTimestamp,
  type MessageKey,
  type NotificationDedupeKey,
  type UuidV7,
} from "./value-objects.js";

export const NOTIFICATION_LEVELS = ["toast", "inline", "inbox", "blocking"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const NOTIFICATION_SEVERITIES = ["info", "success", "warning", "error"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_STATUSES = [
  "created",
  "queued",
  "visible",
  "read",
  "acted",
  "dismissed",
  "expired",
  "failed_delivery",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface NotificationRoute {
  readonly entityType: string;
  readonly entityId: UuidV7;
}

export interface NotificationSnapshot {
  readonly id: UuidV7;
  readonly dedupeKey: NotificationDedupeKey;
  readonly messageKey: MessageKey;
  readonly level: NotificationLevel;
  readonly severity: NotificationSeverity;
  readonly status: NotificationStatus;
  readonly route: NotificationRoute | null;
  readonly metadata: SafeMetadata;
  readonly requiresResolution: boolean;
  readonly expiresAt: IsoUtcTimestamp | null;
  readonly sequence: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
  readonly visibleAt: IsoUtcTimestamp | null;
  readonly readAt: IsoUtcTimestamp | null;
  readonly actedAt: IsoUtcTimestamp | null;
  readonly dismissedAt: IsoUtcTimestamp | null;
  readonly expiredAt: IsoUtcTimestamp | null;
}

export interface CreateNotificationInput {
  readonly id: string;
  readonly dedupeKey: string;
  readonly messageKey: string;
  readonly level: NotificationLevel;
  readonly severity: NotificationSeverity;
  readonly route: Readonly<{
    entityType: string;
    entityId: string;
  }> | null;
  readonly metadata: unknown;
  readonly requiresResolution: boolean;
  readonly expiresAt: string | null;
  readonly now: string;
}

const ROUTE_ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;

export class Notification {
  private constructor(private readonly snapshot: NotificationSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(input: CreateNotificationInput): Result<Notification, TaskEngineError> {
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    const dedupeKey = parseNotificationDedupeKey(input.dedupeKey);
    if (!dedupeKey.ok) {
      return dedupeKey;
    }
    const messageKey = parseMessageKey(input.messageKey);
    if (!messageKey.ok) {
      return messageKey;
    }
    const metadata = createSafeMetadata(input.metadata);
    if (!metadata.ok) {
      return metadata;
    }
    const route = parseRoute(input.route);
    if (!route.ok) {
      return route;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const expiresAt = parseOptionalTimestamp(input.expiresAt);
    if (!expiresAt.ok) {
      return expiresAt;
    }
    if (
      !NOTIFICATION_LEVELS.includes(input.level) ||
      !NOTIFICATION_SEVERITIES.includes(input.severity) ||
      ((input.level === "blocking" || input.requiresResolution) && expiresAt.value !== null) ||
      (expiresAt.value !== null && compareTimestamps(expiresAt.value, now.value) <= 0)
    ) {
      return notificationValidationError("Notification delivery or expiration policy is invalid.");
    }

    return ok(
      new Notification({
        id: id.value,
        dedupeKey: dedupeKey.value,
        messageKey: messageKey.value,
        level: input.level,
        severity: input.severity,
        status: "created",
        route: route.value,
        metadata: metadata.value,
        requiresResolution: input.requiresResolution,
        expiresAt: expiresAt.value,
        sequence: 1,
        createdAt: now.value,
        updatedAt: now.value,
        visibleAt: null,
        readAt: null,
        actedAt: null,
        dismissedAt: null,
        expiredAt: null,
      }),
    );
  }

  public static rehydrate(snapshot: NotificationSnapshot): Result<Notification, TaskEngineError> {
    const validated = validateNotificationSnapshot(snapshot);
    return validated.ok ? ok(new Notification(validated.value)) : validated;
  }

  public get id(): UuidV7 {
    return this.snapshot.id;
  }

  public get dedupeKey(): NotificationDedupeKey {
    return this.snapshot.dedupeKey;
  }

  public get status(): NotificationStatus {
    return this.snapshot.status;
  }

  public get sequence(): number {
    return this.snapshot.sequence;
  }

  public toSnapshot(): NotificationSnapshot {
    return cloneNotificationSnapshot(this.snapshot);
  }

  public isSameNotificationAs(other: Notification): boolean {
    return (
      this.snapshot.messageKey === other.snapshot.messageKey &&
      this.snapshot.level === other.snapshot.level &&
      this.snapshot.severity === other.snapshot.severity &&
      routesEqual(this.snapshot.route, other.snapshot.route) &&
      this.snapshot.requiresResolution === other.snapshot.requiresResolution &&
      this.snapshot.expiresAt === other.snapshot.expiresAt &&
      safeMetadataEquals(this.snapshot.metadata, other.snapshot.metadata)
    );
  }

  public queue(nowValue: string): Result<Notification, TaskEngineError> {
    if (this.snapshot.status !== "created") {
      return notificationTransitionError("Only a created notification can be queued.");
    }
    return this.transition("queued", nowValue);
  }

  public markVisible(nowValue: string): Result<Notification, TaskEngineError> {
    if (this.snapshot.status !== "queued") {
      return notificationTransitionError("Only a queued notification can become visible.");
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    return this.evolve({
      status: "visible",
      visibleAt: now.value,
      updatedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public markRead(nowValue: string): Result<Notification, TaskEngineError> {
    if (this.snapshot.status === "read") {
      return ok(this);
    }
    if (this.snapshot.status !== "visible") {
      return notificationTransitionError("Only a visible notification can be marked as read.");
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    return this.evolve({
      status: "read",
      readAt: now.value,
      updatedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public markActed(nowValue: string): Result<Notification, TaskEngineError> {
    if (this.snapshot.status === "acted") {
      return ok(this);
    }
    if (this.snapshot.status !== "visible" && this.snapshot.status !== "read") {
      return notificationTransitionError("Only a visible or read notification can be acted on.");
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    return this.evolve({
      status: "acted",
      actedAt: now.value,
      updatedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public dismiss(nowValue: string): Result<Notification, TaskEngineError> {
    if (this.snapshot.status === "dismissed") {
      return ok(this);
    }
    if (this.snapshot.status !== "visible" && this.snapshot.status !== "read") {
      return notificationTransitionError("Only a visible or read notification can be dismissed.");
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    return this.evolve({
      status: "dismissed",
      dismissedAt: now.value,
      updatedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public failDelivery(nowValue: string): Result<Notification, TaskEngineError> {
    if (this.snapshot.status !== "queued") {
      return notificationTransitionError("Only a queued notification can record delivery failure.");
    }
    return this.transition("failed_delivery", nowValue);
  }

  public expire(nowValue: string): Result<Notification, TaskEngineError> {
    if (this.snapshot.status === "expired") {
      return ok(this);
    }
    if (
      this.snapshot.status !== "visible" &&
      this.snapshot.status !== "read" &&
      this.snapshot.status !== "dismissed"
    ) {
      return notificationTransitionError("Notification is not in an expirable state.");
    }
    if (
      this.snapshot.level === "blocking" ||
      this.snapshot.requiresResolution ||
      this.snapshot.expiresAt === null
    ) {
      return notificationTransitionError(
        "This notification must remain until its source issue is resolved.",
      );
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    if (compareTimestamps(this.snapshot.expiresAt, now.value) > 0) {
      return notificationTransitionError("Notification has not reached its expiration time.");
    }
    return this.evolve({
      status: "expired",
      expiredAt: now.value,
      updatedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  private transition(
    status: NotificationStatus,
    nowValue: string,
  ): Result<Notification, TaskEngineError> {
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    return this.evolve({
      status,
      updatedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  private evolve(changes: Partial<NotificationSnapshot>): Result<Notification, TaskEngineError> {
    return Notification.rehydrate({
      ...this.snapshot,
      ...changes,
    });
  }
}

function validateNotificationSnapshot(
  snapshot: NotificationSnapshot,
): Result<NotificationSnapshot, TaskEngineError> {
  const id = parseUuidV7(snapshot.id);
  if (!id.ok) {
    return id;
  }
  const dedupeKey = parseNotificationDedupeKey(snapshot.dedupeKey);
  if (!dedupeKey.ok) {
    return dedupeKey;
  }
  const messageKey = parseMessageKey(snapshot.messageKey);
  if (!messageKey.ok) {
    return messageKey;
  }
  if (
    !NOTIFICATION_LEVELS.includes(snapshot.level) ||
    !NOTIFICATION_SEVERITIES.includes(snapshot.severity) ||
    !NOTIFICATION_STATUSES.includes(snapshot.status) ||
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence < 1
  ) {
    return notificationValidationError("Persisted notification fields are invalid.");
  }
  const route = parseRoute(snapshot.route);
  if (!route.ok) {
    return route;
  }
  const metadata = createSafeMetadata(snapshot.metadata);
  if (!metadata.ok) {
    return metadata;
  }
  const createdAt = parseIsoUtcTimestamp(snapshot.createdAt);
  if (!createdAt.ok) {
    return createdAt;
  }
  const updatedAt = parseIsoUtcTimestamp(snapshot.updatedAt);
  if (!updatedAt.ok) {
    return updatedAt;
  }
  const expiresAt = parseOptionalTimestamp(snapshot.expiresAt);
  if (!expiresAt.ok) {
    return expiresAt;
  }
  const visibleAt = parseOptionalTimestamp(snapshot.visibleAt);
  if (!visibleAt.ok) {
    return visibleAt;
  }
  const readAt = parseOptionalTimestamp(snapshot.readAt);
  if (!readAt.ok) {
    return readAt;
  }
  const actedAt = parseOptionalTimestamp(snapshot.actedAt);
  if (!actedAt.ok) {
    return actedAt;
  }
  const dismissedAt = parseOptionalTimestamp(snapshot.dismissedAt);
  if (!dismissedAt.ok) {
    return dismissedAt;
  }
  const expiredAt = parseOptionalTimestamp(snapshot.expiredAt);
  if (!expiredAt.ok) {
    return expiredAt;
  }
  if (
    compareTimestamps(updatedAt.value, createdAt.value) < 0 ||
    ((snapshot.level === "blocking" || snapshot.requiresResolution) && expiresAt.value !== null)
  ) {
    return notificationValidationError("Notification timestamps or expiration policy are invalid.");
  }

  const noLifecycleTimes =
    visibleAt.value === null &&
    readAt.value === null &&
    actedAt.value === null &&
    dismissedAt.value === null &&
    expiredAt.value === null;
  const validCreated = snapshot.status === "created" && noLifecycleTimes;
  const validQueued = snapshot.status === "queued" && noLifecycleTimes;
  const validVisible =
    snapshot.status === "visible" &&
    visibleAt.value !== null &&
    readAt.value === null &&
    actedAt.value === null &&
    dismissedAt.value === null &&
    expiredAt.value === null;
  const validRead =
    snapshot.status === "read" &&
    visibleAt.value !== null &&
    readAt.value !== null &&
    actedAt.value === null &&
    dismissedAt.value === null &&
    expiredAt.value === null;
  const validActed =
    snapshot.status === "acted" &&
    visibleAt.value !== null &&
    actedAt.value !== null &&
    dismissedAt.value === null &&
    expiredAt.value === null;
  const validDismissed =
    snapshot.status === "dismissed" &&
    visibleAt.value !== null &&
    actedAt.value === null &&
    dismissedAt.value !== null &&
    expiredAt.value === null;
  const validExpired =
    snapshot.status === "expired" &&
    visibleAt.value !== null &&
    actedAt.value === null &&
    expiredAt.value !== null;
  const validFailedDelivery = snapshot.status === "failed_delivery" && noLifecycleTimes;
  if (
    !validCreated &&
    !validQueued &&
    !validVisible &&
    !validRead &&
    !validActed &&
    !validDismissed &&
    !validExpired &&
    !validFailedDelivery
  ) {
    return notificationValidationError("Notification lifecycle fields do not match its status.");
  }

  return ok({
    id: id.value,
    dedupeKey: dedupeKey.value,
    messageKey: messageKey.value,
    level: snapshot.level,
    severity: snapshot.severity,
    status: snapshot.status,
    route: route.value,
    metadata: metadata.value,
    requiresResolution: snapshot.requiresResolution,
    expiresAt: expiresAt.value,
    sequence: snapshot.sequence,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    visibleAt: visibleAt.value,
    readAt: readAt.value,
    actedAt: actedAt.value,
    dismissedAt: dismissedAt.value,
    expiredAt: expiredAt.value,
  });
}

function parseRoute(
  route: Readonly<{
    entityType: string;
    entityId: string;
  }> | null,
): Result<NotificationRoute | null, TaskEngineError> {
  if (route === null) {
    return ok(null);
  }
  if (!ROUTE_ENTITY_TYPE_PATTERN.test(route.entityType)) {
    return notificationValidationError("Notification route entity type is invalid.");
  }
  const entityId = parseUuidV7(route.entityId);
  if (!entityId.ok) {
    return entityId;
  }
  return ok(
    Object.freeze({
      entityType: route.entityType,
      entityId: entityId.value,
    }),
  );
}

function parseOptionalTimestamp(
  value: string | null,
): Result<IsoUtcTimestamp | null, TaskEngineError> {
  return value === null ? ok(null) : parseIsoUtcTimestamp(value);
}

function routesEqual(left: NotificationRoute | null, right: NotificationRoute | null): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.entityType === right.entityType &&
      left.entityId === right.entityId)
  );
}

function cloneNotificationSnapshot(snapshot: NotificationSnapshot): NotificationSnapshot {
  return {
    ...snapshot,
    route: snapshot.route === null ? null : Object.freeze({ ...snapshot.route }),
    metadata: cloneSafeMetadata(snapshot.metadata),
  };
}

function notificationValidationError(message: string): Result<never, TaskEngineError> {
  return err(
    new TaskEngineError({
      code: "TASK_VALIDATION_FAILED",
      message,
    }),
  );
}

function notificationTransitionError(message: string): Result<never, TaskEngineError> {
  return err(
    new TaskEngineError({
      code: "NOTIFICATION_INVALID_TRANSITION",
      message,
    }),
  );
}
