import type { UuidV7 } from "../shared/value-objects.js";

export interface UuidV7Generator {
  next(): UuidV7;
}
