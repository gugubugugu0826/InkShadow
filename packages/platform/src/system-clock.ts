import { parseIsoUtcTimestamp, type Clock, type IsoUtcTimestamp } from "@inkshadow/domain";

export type DateFactory = () => Date;

export class SystemClock implements Clock {
  public constructor(private readonly createDate: DateFactory = () => new Date()) {}

  public now(): IsoUtcTimestamp {
    const parsed = parseIsoUtcTimestamp(this.createDate().toISOString());
    if (!parsed.ok) {
      throw new Error("The host clock produced an invalid UTC timestamp.");
    }
    return parsed.value;
  }
}
