import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const CIPHER = "aes-256-gcm";
const VERSION = "v1";

export function encryptSecret(value: string, rawKey: string): string {
  if (!value) {
    throw new Error("secret value is required");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, encryptionKey(rawKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptSecret(payload: string, rawKey: string): string {
  const [version, iv, tag, ciphertext] = payload.split(":");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("encrypted secret has an unsupported format");
  }

  const decipher = createDecipheriv(CIPHER, encryptionKey(rawKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function encryptionKey(rawKey: string): Buffer {
  if (!rawKey) {
    throw new Error("OVIRT_INVENTORY_ENCRYPTION_KEY is required");
  }

  const trimmed = rawKey.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const decoded = Buffer.from(trimmed, "base64url");
  if (decoded.length === 32) {
    return decoded;
  }

  if (trimmed.length >= 32) {
    return createHash("sha256").update(trimmed).digest();
  }

  throw new Error("OVIRT_INVENTORY_ENCRYPTION_KEY must be at least 32 characters, 32 base64url bytes, or 64 hex characters");
}
