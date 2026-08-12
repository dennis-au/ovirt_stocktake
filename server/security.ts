import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";

const KEY_LENGTH = 32;
const DEFAULT_COST = 16384;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELISM = 1;

export async function hashPassword(password: string, salt: Buffer = randomBytes(16)): Promise<string> {
  if (!password) {
    throw new Error("password is required");
  }

  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: DEFAULT_COST,
    r: DEFAULT_BLOCK_SIZE,
    p: DEFAULT_PARALLELISM
  });

  return [
    "scrypt",
    "v1",
    DEFAULT_COST,
    DEFAULT_BLOCK_SIZE,
    DEFAULT_PARALLELISM,
    salt.toString("base64url"),
    derived.toString("base64url")
  ].join("$");
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parsePasswordHash(storedHash);
  if (!parsed) {
    return false;
  }

  const derived = await scrypt(password, parsed.salt, parsed.hash.length, {
    N: parsed.cost,
    r: parsed.blockSize,
    p: parsed.parallelism
  });

  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

function scrypt(password: BinaryLike, salt: BinaryLike, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function parsePasswordHash(storedHash: string):
  | {
      cost: number;
      blockSize: number;
      parallelism: number;
      salt: Buffer;
      hash: Buffer;
    }
  | undefined {
  const [algorithm, version, cost, blockSize, parallelism, salt, hash] = storedHash.split("$");
  if (algorithm !== "scrypt" || version !== "v1" || !cost || !blockSize || !parallelism || !salt || !hash) {
    return undefined;
  }

  const parsedCost = Number.parseInt(cost, 10);
  const parsedBlockSize = Number.parseInt(blockSize, 10);
  const parsedParallelism = Number.parseInt(parallelism, 10);
  if (![parsedCost, parsedBlockSize, parsedParallelism].every((value) => Number.isInteger(value) && value > 0)) {
    return undefined;
  }

  return {
    cost: parsedCost,
    blockSize: parsedBlockSize,
    parallelism: parsedParallelism,
    salt: Buffer.from(salt, "base64url"),
    hash: Buffer.from(hash, "base64url")
  };
}
