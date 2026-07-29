import { parseUuidV7, type UuidV7, type UuidV7Generator } from "@inkshadow/domain";

export type MillisecondClock = () => number;
export type RandomByteFiller = (buffer: Uint8Array) => void;

const MAX_TIMESTAMP = 0xffffffffffff;
const MAX_SEQUENCE = 0x0fff;

export class CryptoUuidV7Generator implements UuidV7Generator {
  private lastTimestamp = -1;
  private sequence = 0;

  public constructor(
    private readonly now: MillisecondClock = Date.now,
    private readonly fillRandom: RandomByteFiller = (buffer) => {
      globalThis.crypto.getRandomValues(buffer);
    },
  ) {}

  public next(): UuidV7 {
    const random = new Uint8Array(10);
    this.fillRandom(random);

    const hostTimestamp = Math.trunc(this.now());
    if (
      !Number.isSafeInteger(hostTimestamp) ||
      hostTimestamp < 0 ||
      hostTimestamp > MAX_TIMESTAMP
    ) {
      throw new Error("The host clock is outside the UUIDv7 timestamp range.");
    }

    let timestamp = Math.max(hostTimestamp, this.lastTimestamp);
    if (timestamp > this.lastTimestamp) {
      this.sequence = (((random[0] ?? 0) << 8) | (random[1] ?? 0)) & MAX_SEQUENCE;
    } else if (this.sequence < MAX_SEQUENCE) {
      this.sequence += 1;
    } else {
      timestamp += 1;
      this.sequence = 0;
    }
    this.lastTimestamp = timestamp;

    const bytes = new Uint8Array(16);
    let remainingTimestamp = BigInt(timestamp);
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(remainingTimestamp & 0xffn);
      remainingTimestamp >>= 8n;
    }

    bytes[6] = 0x70 | ((this.sequence >> 8) & 0x0f);
    bytes[7] = this.sequence & 0xff;
    bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
    for (let index = 9; index < bytes.length; index += 1) {
      bytes[index] = random[index - 6] ?? 0;
    }

    const hexadecimal = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    const value = [
      hexadecimal.slice(0, 8),
      hexadecimal.slice(8, 12),
      hexadecimal.slice(12, 16),
      hexadecimal.slice(16, 20),
      hexadecimal.slice(20),
    ].join("-");

    const parsed = parseUuidV7(value);
    if (!parsed.ok) {
      throw new Error("UUIDv7 generation violated its format invariant.");
    }
    return parsed.value;
  }
}
