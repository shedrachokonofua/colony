import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  SecretEncryption,
  SecretEncryptionError,
} from "../src/secret-encryption.js";

const KEY_B64 = randomBytes(32).toString("base64");

describe("SecretEncryption", () => {
  it("round-trips a payload through encrypt/decrypt", () => {
    const enc = SecretEncryption.fromString(KEY_B64);
    const blob = enc.encrypt("hello world");
    expect(enc.decryptToString(blob)).toBe("hello world");
  });

  it("produces distinct ciphertexts for the same plaintext (random IV)", () => {
    const enc = SecretEncryption.fromString(KEY_B64);
    const a = enc.encrypt("payload");
    const b = enc.encrypt("payload");
    expect(Buffer.compare(a, b)).not.toBe(0);
    expect(enc.decryptToString(a)).toBe("payload");
    expect(enc.decryptToString(b)).toBe("payload");
  });

  it("rejects ciphertext under a different key", () => {
    const enc1 = SecretEncryption.fromString(KEY_B64);
    const enc2 = SecretEncryption.fromString(
      randomBytes(32).toString("base64"),
    );
    const blob = enc1.encrypt("payload");
    expect(() => enc2.decryptToBuffer(blob)).toThrow(SecretEncryptionError);
  });

  it("rejects truncated ciphertext", () => {
    const enc = SecretEncryption.fromString(KEY_B64);
    const blob = enc.encrypt("payload");
    expect(() => enc.decryptToBuffer(blob.subarray(0, 5))).toThrow(
      SecretEncryptionError,
    );
  });

  it("rejects ciphertext with wrong magic bytes", () => {
    const enc = SecretEncryption.fromString(KEY_B64);
    const blob = enc.encrypt("payload");
    blob[0] = 0;
    expect(() => enc.decryptToBuffer(blob)).toThrow(SecretEncryptionError);
  });

  it("rejects an undefined master key", () => {
    expect(() => SecretEncryption.fromString(undefined)).toThrow(
      SecretEncryptionError,
    );
  });

  it("rejects a master key that doesn't decode to 32 bytes", () => {
    expect(() => SecretEncryption.fromString("short")).toThrow(
      SecretEncryptionError,
    );
    // 24 bytes b64 instead of 32
    expect(() =>
      SecretEncryption.fromString(randomBytes(24).toString("base64")),
    ).toThrow(SecretEncryptionError);
  });

  it("accepts hex-encoded keys", () => {
    const hex = randomBytes(32).toString("hex");
    const enc = SecretEncryption.fromString(hex);
    expect(enc.decryptToString(enc.encrypt("ok"))).toBe("ok");
  });

  it("accepts the dev placeholder deterministically", () => {
    const a = SecretEncryption.fromString("dev-only-not-for-production");
    const b = SecretEncryption.fromString("dev-only-not-for-production");
    const blob = a.encrypt("dev");
    expect(b.decryptToString(blob)).toBe("dev");
  });
});
