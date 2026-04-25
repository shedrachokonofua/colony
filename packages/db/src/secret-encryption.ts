import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * AES-256-GCM symmetric encryption for at-rest secrets (OAuth tokens in
 * `provider_oauth_connections`).
 *
 * Layout of the on-disk byte array:
 *   bytes 0..1   = version magic 0xC0 0x01
 *   bytes 2..13  = 12-byte IV (GCM standard)
 *   bytes 14..29 = 16-byte auth tag
 *   bytes 30..   = ciphertext
 *
 * The master key arrives as a base64 string via env (or, in Aether, a
 * Kubernetes Secret mounted as `COLONY_SECRET_ENCRYPTION_KEY`). When the env
 * var is the literal string `dev-only-not-for-production`, we derive a
 * deterministic key for tests via scrypt; the deploy path forbids that.
 *
 * The repository never logs plaintext, never accepts a key shorter than 32
 * bytes after decoding, and rejects ciphertext whose magic bytes don't match
 * — this surfaces "wrong key" as a clean error rather than corrupt JSON.
 */

const MAGIC = Uint8Array.of(0xc0, 0x01);
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

const TEST_PLACEHOLDER = "dev-only-not-for-production";

export class SecretEncryptionError extends Error {
  constructor(
    readonly code:
      | "MISSING_KEY"
      | "INVALID_KEY"
      | "INVALID_CIPHERTEXT"
      | "DECRYPT_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SecretEncryptionError";
  }
}

export class SecretEncryption {
  private constructor(private readonly key: Buffer) {}

  /**
   * Derive a SecretEncryption instance from an env-style master key string.
   *
   * Accepted forms:
   *   - 32+ raw bytes encoded as base64 (preferred; produced by
   *     `openssl rand -base64 32`).
   *   - 64-character hex string.
   *   - The placeholder `dev-only-not-for-production`, scrypt-stretched to
   *     32 bytes deterministically. Tests + local dev only.
   */
  static fromString(value: string | undefined): SecretEncryption {
    if (!value || value.length === 0) {
      throw new SecretEncryptionError(
        "MISSING_KEY",
        "COLONY_SECRET_ENCRYPTION_KEY is empty; the OAuth credential store cannot operate without it",
      );
    }
    if (value === TEST_PLACEHOLDER) {
      const stretched = scryptSync(
        "colony-dev-master",
        "colony-dev-salt",
        KEY_LEN,
      );
      return new SecretEncryption(stretched);
    }
    const buf = decodeKey(value);
    if (buf.length !== KEY_LEN) {
      throw new SecretEncryptionError(
        "INVALID_KEY",
        `decoded master key is ${buf.length} bytes; need ${KEY_LEN}`,
      );
    }
    return new SecretEncryption(buf);
  }

  encrypt(plaintext: Uint8Array | string): Buffer {
    const plain =
      typeof plaintext === "string"
        ? Buffer.from(plaintext, "utf8")
        : Buffer.from(plaintext);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, iv, tag, body]);
  }

  decryptToBuffer(blob: Uint8Array): Buffer {
    if (blob.length < MAGIC.length + IV_LEN + TAG_LEN) {
      throw new SecretEncryptionError(
        "INVALID_CIPHERTEXT",
        "ciphertext shorter than minimum framed length",
      );
    }
    if (blob[0] !== MAGIC[0] || blob[1] !== MAGIC[1]) {
      throw new SecretEncryptionError(
        "INVALID_CIPHERTEXT",
        "ciphertext magic bytes do not match",
      );
    }
    const buf = Buffer.from(blob);
    const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = buf.subarray(
      MAGIC.length + IV_LEN,
      MAGIC.length + IV_LEN + TAG_LEN,
    );
    const body = buf.subarray(MAGIC.length + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch (e) {
      throw new SecretEncryptionError(
        "DECRYPT_FAILED",
        `ciphertext decryption failed (likely wrong key or tampered blob): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  decryptToString(blob: Uint8Array): string {
    return this.decryptToBuffer(blob).toString("utf8");
  }
}

function decodeKey(value: string): Buffer {
  // Try base64 first; fall back to hex when it doesn't decode to 32 bytes.
  // We don't accept raw plaintext keys — that would tempt operators to set
  // the env var to a 32-character ASCII password, which has far less entropy
  // than 256 random bits.
  const trimmed = value.trim();
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 44) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === KEY_LEN) return decoded;
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_LEN * 2) {
    return Buffer.from(trimmed, "hex");
  }
  throw new SecretEncryptionError(
    "INVALID_KEY",
    "master key must be 32 bytes encoded as base64 (44 chars) or hex (64 chars)",
  );
}
