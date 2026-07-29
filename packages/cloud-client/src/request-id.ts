export type CloudRequestIdFactory = () => string;

const MAX_TIMESTAMP = 0xffffffffffff;
const MAX_SEQUENCE = 0x0fff;

export function createMonotonicCloudRequestIdFactory(
  now: () => number = Date.now,
  fillRandom: (target: Uint8Array) => void = (target) => {
    globalThis.crypto.getRandomValues(target);
  },
): CloudRequestIdFactory {
  let lastTimestamp = -1;
  let sequence = 0;

  return () => {
    const random = new Uint8Array(10);
    fillRandom(random);
    const hostTimestamp = Math.trunc(now());
    if (
      !Number.isSafeInteger(hostTimestamp) ||
      hostTimestamp < 0 ||
      hostTimestamp > MAX_TIMESTAMP
    ) {
      throw new Error("The host clock is outside the UUIDv7 timestamp range.");
    }

    let timestamp = Math.max(hostTimestamp, lastTimestamp);
    if (timestamp > lastTimestamp) {
      sequence = ((((random[0] ?? 0) << 8) | (random[1] ?? 0)) & MAX_SEQUENCE) >>> 0;
    } else if (sequence < MAX_SEQUENCE) {
      sequence += 1;
    } else {
      timestamp += 1;
      sequence = 0;
    }
    lastTimestamp = timestamp;

    const bytes = new Uint8Array(16);
    let remaining = BigInt(timestamp);
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
    bytes[7] = sequence & 0xff;
    bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
    for (let index = 9; index < bytes.length; index += 1) {
      bytes[index] = random[index - 6] ?? 0;
    }

    const hexadecimal = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return [
      hexadecimal.slice(0, 8),
      hexadecimal.slice(8, 12),
      hexadecimal.slice(12, 16),
      hexadecimal.slice(16, 20),
      hexadecimal.slice(20),
    ].join("-");
  };
}
