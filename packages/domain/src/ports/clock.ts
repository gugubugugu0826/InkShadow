import type { IsoUtcTimestamp } from "../shared/value-objects.js";

export interface Clock {
  now(): IsoUtcTimestamp;
}
