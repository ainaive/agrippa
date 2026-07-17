import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, loadSecretKey } from "./secrets";

describe("secrets encryption", () => {
  const key = randomBytes(32);

  it("round-trips", () => {
    const secret = "ghp_example_token_硅基工坊";
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it("produces distinct ciphertexts for the same plaintext (fresh iv)", () => {
    expect(encryptSecret("x", key)).not.toBe(encryptSecret("x", key));
  });

  it("rejects tampered ciphertext", () => {
    const ct = Buffer.from(encryptSecret("x", key), "base64");
    ct[ct.length - 1] = (ct[ct.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptSecret(ct.toString("base64"), key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const ct = encryptSecret("x", key);
    expect(() => decryptSecret(ct, randomBytes(32))).toThrow();
  });

  it("loadSecretKey validates length and presence", () => {
    expect(() => loadSecretKey(undefined)).toThrow("AGRIPPA_SECRET_KEY is not set");
    expect(() => loadSecretKey(Buffer.from("short").toString("base64"))).toThrow("32 bytes");
    expect(loadSecretKey(randomBytes(32).toString("base64")).length).toBe(32);
  });
});
