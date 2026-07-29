import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
}

export interface ScryptPasswordHasherOptions {
  readonly cost?: number;
  readonly blockSize?: number;
  readonly parallelism?: number;
  readonly keyLength?: number;
  readonly saltLength?: number;
  readonly maximumMemoryBytes?: number;
  readonly fillRandom?: (target: Uint8Array) => void;
}

interface ParsedScryptHash {
  readonly blockSize: number;
  readonly cost: number;
  readonly key: Buffer;
  readonly keyLength: number;
  readonly parallelism: number;
  readonly salt: Buffer;
}

const DEFAULT_COST = 65_536;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELISM = 1;
const DEFAULT_KEY_LENGTH = 32;
const DEFAULT_SALT_LENGTH = 16;
const DEFAULT_MAXIMUM_MEMORY_BYTES = 96 * 1024 * 1024;
const MINIMUM_PASSWORD_BYTES = 12;
const MAXIMUM_PASSWORD_BYTES = 1_024;

export class ScryptPasswordHasher implements PasswordHasher {
  private readonly blockSize: number;
  private readonly cost: number;
  private readonly fillRandom: (target: Uint8Array) => void;
  private readonly keyLength: number;
  private readonly maximumMemoryBytes: number;
  private readonly parallelism: number;
  private readonly saltLength: number;

  public constructor(options: ScryptPasswordHasherOptions = {}) {
    this.cost = options.cost ?? DEFAULT_COST;
    this.blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    this.parallelism = options.parallelism ?? DEFAULT_PARALLELISM;
    this.keyLength = options.keyLength ?? DEFAULT_KEY_LENGTH;
    this.saltLength = options.saltLength ?? DEFAULT_SALT_LENGTH;
    this.maximumMemoryBytes = options.maximumMemoryBytes ?? DEFAULT_MAXIMUM_MEMORY_BYTES;
    this.fillRandom =
      options.fillRandom ??
      ((target) => {
        randomBytes(target.length).copy(target);
      });
    validateParameters({
      blockSize: this.blockSize,
      cost: this.cost,
      keyLength: this.keyLength,
      maximumMemoryBytes: this.maximumMemoryBytes,
      parallelism: this.parallelism,
      saltLength: this.saltLength,
    });
  }

  public async hash(password: string): Promise<string> {
    const passwordBytes = encodePassword(password);
    const salt = Buffer.allocUnsafe(this.saltLength);
    try {
      this.fillRandom(salt);
      const key = await deriveScryptKey(passwordBytes, salt, {
        blockSize: this.blockSize,
        cost: this.cost,
        keyLength: this.keyLength,
        maximumMemoryBytes: this.maximumMemoryBytes,
        parallelism: this.parallelism,
      });
      try {
        return [
          "scrypt",
          "v=1",
          `n=${String(this.cost)},r=${String(this.blockSize)},p=${String(this.parallelism)}`,
          salt.toString("base64url"),
          key.toString("base64url"),
        ].join("$");
      } finally {
        key.fill(0);
      }
    } finally {
      passwordBytes.fill(0);
      salt.fill(0);
    }
  }

  public async verify(password: string, encodedHash: string): Promise<boolean> {
    const parsed = parseScryptHash(encodedHash);
    if (parsed === null) {
      return false;
    }
    const passwordBytes = encodePassword(password);
    try {
      const candidate = await deriveScryptKey(passwordBytes, parsed.salt, {
        blockSize: parsed.blockSize,
        cost: parsed.cost,
        keyLength: parsed.keyLength,
        maximumMemoryBytes: this.maximumMemoryBytes,
        parallelism: parsed.parallelism,
      });
      try {
        return timingSafeEqual(candidate, parsed.key);
      } finally {
        candidate.fill(0);
      }
    } catch {
      return false;
    } finally {
      passwordBytes.fill(0);
      parsed.key.fill(0);
      parsed.salt.fill(0);
    }
  }
}

function encodePassword(password: string): Buffer {
  const encoded = Buffer.from(password, "utf8");
  if (encoded.length < MINIMUM_PASSWORD_BYTES || encoded.length > MAXIMUM_PASSWORD_BYTES) {
    encoded.fill(0);
    throw new Error("Password length is outside the supported security boundary.");
  }
  return encoded;
}

function parseScryptHash(encodedHash: string): ParsedScryptHash | null {
  const match = /^scrypt\$v=1\$n=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/u.exec(
    encodedHash,
  );
  if (match === null) {
    return null;
  }
  const cost = Number(match[1]);
  const blockSize = Number(match[2]);
  const parallelism = Number(match[3]);
  const saltText = match[4];
  const keyText = match[5];
  if (saltText === undefined || keyText === undefined) {
    return null;
  }
  const salt = Buffer.from(saltText, "base64url");
  const key = Buffer.from(keyText, "base64url");
  try {
    validateParameters({
      blockSize,
      cost,
      keyLength: key.length,
      maximumMemoryBytes: DEFAULT_MAXIMUM_MEMORY_BYTES,
      parallelism,
      saltLength: salt.length,
    });
  } catch {
    salt.fill(0);
    key.fill(0);
    return null;
  }
  return {
    blockSize,
    cost,
    key,
    keyLength: key.length,
    parallelism,
    salt,
  };
}

function validateParameters(parameters: {
  readonly blockSize: number;
  readonly cost: number;
  readonly keyLength: number;
  readonly maximumMemoryBytes: number;
  readonly parallelism: number;
  readonly saltLength: number;
}): void {
  const { blockSize, cost, keyLength, maximumMemoryBytes, parallelism, saltLength } = parameters;
  if (
    !Number.isSafeInteger(cost) ||
    cost < 1_024 ||
    cost > 1_048_576 ||
    (cost & (cost - 1)) !== 0
  ) {
    throw new Error("Scrypt cost must be a supported power of two.");
  }
  if (!Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 32) {
    throw new Error("Scrypt block size is outside the supported range.");
  }
  if (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 16) {
    throw new Error("Scrypt parallelism is outside the supported range.");
  }
  if (!Number.isSafeInteger(keyLength) || keyLength < 32 || keyLength > 64) {
    throw new Error("Scrypt output length is outside the supported range.");
  }
  if (!Number.isSafeInteger(saltLength) || saltLength < 16 || saltLength > 64) {
    throw new Error("Scrypt salt length is outside the supported range.");
  }
  const requiredMemory = 128 * cost * blockSize + 1024 * 1024;
  if (
    !Number.isSafeInteger(maximumMemoryBytes) ||
    maximumMemoryBytes < requiredMemory ||
    maximumMemoryBytes > 1024 * 1024 * 1024
  ) {
    throw new Error("Scrypt memory boundary cannot satisfy the configured work factor.");
  }
}

function deriveScryptKey(
  password: Buffer,
  salt: Buffer,
  parameters: {
    readonly blockSize: number;
    readonly cost: number;
    readonly keyLength: number;
    readonly maximumMemoryBytes: number;
    readonly parallelism: number;
  },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      parameters.keyLength,
      {
        N: parameters.cost,
        maxmem: parameters.maximumMemoryBytes,
        p: parameters.parallelism,
        r: parameters.blockSize,
      },
      (error, derivedKey) => {
        if (error === null) {
          resolve(derivedKey);
          return;
        }
        reject(error);
      },
    );
  });
}
