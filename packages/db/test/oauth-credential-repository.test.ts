import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  OAuthCredentialRepository,
  SecretEncryption,
  createPool,
} from "../src/index.js";

const TEST_URL = process.env.COLONY_TEST_DATABASE_URL;

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

interface FakePiAuthPayload {
  readonly access_token: string;
  readonly refresh_token: string;
}

describe.runIf(TEST_URL)("OAuthCredentialRepository", () => {
  const url = TEST_URL!;
  let admin: Pool;
  let pool: Pool;
  let repo: OAuthCredentialRepository;
  const crypto = SecretEncryption.fromString("dev-only-not-for-production");

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query("DROP SCHEMA public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await admin.query("GRANT ALL ON SCHEMA public TO public");
    await runner({
      databaseUrl: url,
      dir: MIGRATIONS_DIR,
      migrationsTable: "pgmigrations",
      direction: "up",
      log: () => {},
    });
    pool = createPool({ connectionString: url, role: "colony_writer" });
    repo = new OAuthCredentialRepository(pool, crypto);
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query(
      `TRUNCATE provider_oauth_connections, provider_oauth_pending_state RESTART IDENTITY CASCADE`,
    );
  });

  it("upserts a connection and reads the payload back through decrypt", async () => {
    const meta = await repo.upsertConnection<FakePiAuthPayload>({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: {
        access_token: "at-1",
        refresh_token: "rt-1",
      },
      grantedBy: "human:op-1",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(meta.providerKey).toBe("openai_codex");
    expect(meta.status).toBe("active");

    const conn =
      await repo.getActiveConnection<FakePiAuthPayload>("openai_codex");
    expect(conn?.payload).toEqual({
      access_token: "at-1",
      refresh_token: "rt-1",
    });
  });

  it("never stores plaintext in the row's ciphertext column", async () => {
    await repo.upsertConnection<FakePiAuthPayload>({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "secret-token", refresh_token: "rt" },
      grantedBy: "human:op-1",
    });
    const { rows } = await admin.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM provider_oauth_connections WHERE provider_key = $1`,
      ["openai_codex"],
    );
    expect(rows[0].ciphertext.includes(Buffer.from("secret-token"))).toBe(
      false,
    );
  });

  it("upsertConnection replaces a prior active row (one row per provider)", async () => {
    const first = await repo.upsertConnection<FakePiAuthPayload>({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "v1", refresh_token: "rt" },
      grantedBy: "human:op-1",
    });
    const second = await repo.upsertConnection<FakePiAuthPayload>({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "v2", refresh_token: "rt2" },
      grantedBy: "human:op-1",
    });
    expect(second.id).not.toBe(first.id);
    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*) FROM provider_oauth_connections WHERE provider_key = $1 AND status <> 'revoked'`,
      ["openai_codex"],
    );
    expect(rows[0].count).toBe("1");
    const conn =
      await repo.getActiveConnection<FakePiAuthPayload>("openai_codex");
    expect(conn?.payload.access_token).toBe("v2");
  });

  it("recordRefresh rewrites payload + bumps refreshed_at without changing the id", async () => {
    const meta = await repo.upsertConnection<FakePiAuthPayload>({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "v1", refresh_token: "rt" },
      grantedBy: "human:op-1",
    });
    const newExpires = new Date(Date.now() + 7_200_000);
    const refreshed = await repo.recordRefresh<FakePiAuthPayload>({
      id: meta.id,
      payload: { access_token: "v2", refresh_token: "rt2" },
      expiresAt: newExpires,
    });
    expect(refreshed?.id).toBe(meta.id);
    expect(refreshed?.refreshedAt).not.toBeNull();
    expect(refreshed?.expiresAt).toBe(newExpires.toISOString());
    const conn =
      await repo.getActiveConnection<FakePiAuthPayload>("openai_codex");
    expect(conn?.payload.access_token).toBe("v2");
  });

  it("revokeConnection flips status and getActive returns null afterwards", async () => {
    await repo.upsertConnection<FakePiAuthPayload>({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "v1", refresh_token: "rt" },
      grantedBy: "human:op-1",
    });
    const revoked = await repo.revokeConnection("openai_codex");
    expect(revoked?.status).toBe("revoked");
    const conn =
      await repo.getActiveConnection<FakePiAuthPayload>("openai_codex");
    expect(conn).toBeNull();
  });

  it("listConnectionMetadata returns one row per provider, latest first", async () => {
    await repo.upsertConnection<FakePiAuthPayload>({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "x", refresh_token: "rt" },
      grantedBy: "human:op-1",
    });
    await repo.upsertConnection<FakePiAuthPayload>({
      providerKey: "anthropic_pro",
      providerApi: "anthropic-messages",
      payload: { access_token: "y", refresh_token: "rt" },
      grantedBy: "human:op-1",
    });
    const list = await repo.listConnectionMetadata();
    expect(list.map((m) => m.providerKey).sort()).toEqual([
      "anthropic_pro",
      "openai_codex",
    ]);
  });

  it("createPendingState then consumePendingState succeeds exactly once", async () => {
    const created = await repo.createPendingState({
      providerKey: "openai_codex",
      initiator: "human:op-1",
      redirectUri:
        "https://colony.local/admin/providers/openai_codex/oauth/callback",
      pkceVerifier: "pkce-verifier-xyz",
    });
    const first = await repo.consumePendingState(created.stateToken);
    expect(first?.providerKey).toBe("openai_codex");
    expect(first?.pkceVerifier).toBe("pkce-verifier-xyz");
    const second = await repo.consumePendingState(created.stateToken);
    expect(second).toBeNull();
  });

  it("consumePendingState rejects expired state tokens", async () => {
    const created = await repo.createPendingState({
      providerKey: "openai_codex",
      initiator: "human:op-1",
      redirectUri: "https://x/callback",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    const consumed = await repo.consumePendingState(created.stateToken);
    expect(consumed).toBeNull();
  });

  it("sweepExpiredPendingState deletes only expired rows", async () => {
    const expired = await repo.createPendingState({
      providerKey: "openai_codex",
      initiator: "human:op-1",
      redirectUri: "https://x/callback",
      ttlMs: 1,
    });
    const live = await repo.createPendingState({
      providerKey: "anthropic_pro",
      initiator: "human:op-1",
      redirectUri: "https://x/callback",
      ttlMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 10));
    const swept = await repo.sweepExpiredPendingState();
    expect(swept).toBe(1);
    const stillThere = await repo.consumePendingState(live.stateToken);
    expect(stillThere?.providerKey).toBe("anthropic_pro");
    const gone = await repo.consumePendingState(expired.stateToken);
    expect(gone).toBeNull();
  });

  it("getActiveConnection raises a structured error when ciphertext is corrupt", async () => {
    await repo.upsertConnection<FakePiAuthPayload>({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access_token: "x", refresh_token: "rt" },
      grantedBy: "human:op-1",
    });
    // Corrupt the ciphertext directly through admin pool.
    await admin.query(
      `UPDATE provider_oauth_connections
         SET ciphertext = decode('c001000000', 'hex')
       WHERE provider_key = $1`,
      ["openai_codex"],
    );
    await expect(() =>
      repo.getActiveConnection("openai_codex"),
    ).rejects.toThrow();
  });
});
