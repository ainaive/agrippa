import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for the `secrets` table. The key is the 32-byte
 * AGRIPPA_SECRET_KEY (base64) — losing it orphans stored credentials.
 * Ciphertext layout (base64): iv(12) ∥ authTag(16) ∥ data.
 */
export function loadSecretKey(env: string | undefined = process.env.AGRIPPA_SECRET_KEY): Buffer {
  if (!env) throw new Error("AGRIPPA_SECRET_KEY is not set");
  const key = Buffer.from(env, "base64");
  if (key.length !== 32) {
    throw new Error("AGRIPPA_SECRET_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decryptSecret(ciphertext: string, key: Buffer): string {
  const raw = Buffer.from(ciphertext, "base64");
  if (raw.length < 29) throw new Error("secret ciphertext is malformed");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
