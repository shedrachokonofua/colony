import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runner } from "node-pg-migrate";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  OAuthCredentialRepository,
  PolicyRepository,
  SecretEncryption,
  TaskGraphRepository,
  createPool,
} from "@colony/db";
import { loadColonyConfig } from "@colony/config";
import { buildApp } from "../app.js";
import { OAuthSessionManager } from "./session-manager.js";
import type { OAuthDriver, OAuthSessionHandle } from "./types.js";

const TEST = process.env.COLONY_TEST_DATABASE_URL;
const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

function tempConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-oauth-cfg-"));
  const path = join(dir, "colony.yaml");
  writeFileSync(path, yaml, "utf8");
  return path;
}

function makeStubDriver() {
  const sessions = new Map<
    string,
    {
      providerKey: string;
      codePromise: Promise<string>;
      resolveCode: (c: string) => void;
    }
  >();
  let nextHandleId = 1;
  let lastBeginInput: {
    providerKey: string;
    providerApi: string;
    initiator: string;
  } | null = null;
  const driver: OAuthDriver = {
    begin(input) {
      lastBeginInput = {
        providerKey: input.providerKey,
        providerApi: input.providerApi,
        initiator: input.initiator,
      };
      const handle: OAuthSessionHandle = {
        id: `stub-${nextHandleId++}`,
        providerKey: input.providerKey,
      };
      let resolveCode: (c: string) => void = () => {};
      const codePromise = new Promise<string>((res) => {
        resolveCode = res;
      });
      sessions.set(handle.id, {
        providerKey: input.providerKey,
        codePromise,
        resolveCode,
      });
      return Promise.resolve({
        result: {
          authorizeUrl: `https://example.test/oauth/authorize?provider=${input.providerKey}`,
          instructions: "stub: paste the code below",
        },
        handle,
      });
    },
    submitCode(handle, input) {
      const session = sessions.get(handle.id);
      if (!session) return Promise.reject(new Error("unknown handle"));
      if (input.code === "boom") {
        return Promise.reject(new Error("upstream rejected code"));
      }
      session.resolveCode(input.code);
      sessions.delete(handle.id);
      return Promise.resolve({
        access: `at-${input.code}`,
        refresh: `rt-${input.code}`,
        expires: Date.now() + 3_600_000,
      });
    },
    cancel(handle) {
      sessions.delete(handle.id);
      return Promise.resolve();
    },
  };
  return {
    driver,
    pendingHandleCount: () => sessions.size,
    getLastBeginInput: () => lastBeginInput,
  };
}

const VALID_YAML = `
agent_runtime: pi
providers:
  openai_codex:
    api: openai-codex-responses
    auth:
      kind: oauth
      subscription: chatgpt_plus
    models:
      - id: gpt-5-codex
        name: gpt-5-codex
  anthropic:
    api: anthropic-messages
    auth: { kind: api_key, value: ANTHROPIC_API_KEY }
    models:
      - id: claude-sonnet-4-20250514
        name: sonnet-4
agents:
  developer:
    provider: openai_codex
    model: gpt-5-codex
`;

describe.runIf(TEST)("OAuth admin routes", () => {
  const url = TEST!;
  let admin: Pool;
  let pool: Pool;
  let oauthRepo: OAuthCredentialRepository;
  let policyRepo: PolicyRepository;
  let auditRepo: TaskGraphRepository;
  let driverHarness: ReturnType<typeof makeStubDriver>;
  let app: ReturnType<typeof buildApp>;

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
    const crypto = SecretEncryption.fromString("dev-only-not-for-production");
    oauthRepo = new OAuthCredentialRepository(pool, crypto);
    policyRepo = new PolicyRepository(pool);
    auditRepo = new TaskGraphRepository(pool);
    driverHarness = makeStubDriver();
    const cfg = loadColonyConfig({
      path: tempConfig(VALID_YAML),
      env: { ANTHROPIC_API_KEY: "x" },
    });
    app = buildApp({
      providerAdmin: false,
      oauthAdmin: {
        config: cfg,
        oauthRepo,
        sessionManager: new OAuthSessionManager(driverHarness.driver),
        policyRepo,
        auditRepo,
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query(
      `TRUNCATE
         provider_oauth_connections, provider_oauth_pending_state,
         capability_grants, provider_identities, audit_log
       RESTART IDENTITY CASCADE`,
    );
    // human:op-1 has the oauth-connect capability via the standard seed.
    await admin.query(
      `INSERT INTO capability_grants (id, actor, role, capability, scope_id, task_id, granted_by)
       VALUES ('cgr-hm-oauth', 'human:op-1', 'human', 'provider.oauth.connect', NULL, NULL, 'human:op-1')`,
    );
  });

  function admin1Headers() {
    return { "X-Actor-Id": "human:op-1", "Content-Type": "application/json" };
  }

  it("GET /admin/providers lists oauth providers and 'never' connection state", async () => {
    const res = await app.request("/admin/providers", {
      method: "GET",
      headers: admin1Headers(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{
        key: string;
        api: string;
        connection: unknown;
        models: Array<{ id: string }>;
      }>;
    };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].key).toBe("openai_codex");
    expect(body.providers[0].api).toBe("openai-codex-responses");
    expect(body.providers[0].connection).toBeNull();
    expect(body.providers[0].models[0].id).toBe("gpt-5-codex");
  });

  it("denies the list call without provider.oauth.connect", async () => {
    const res = await app.request("/admin/providers", {
      method: "GET",
      headers: { "X-Actor-Id": "actor:no-grant" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("POLICY_DENY");
  });

  it("rejects start for a non-oauth provider", async () => {
    const res = await app.request("/admin/providers/anthropic/oauth/start", {
      method: "POST",
      headers: admin1Headers(),
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROVIDER_NOT_OAUTH");
  });

  it("walks the full start → submit-code → connection flow", async () => {
    const before = driverHarness.pendingHandleCount();
    const startRes = await app.request(
      "/admin/providers/openai_codex/oauth/start",
      {
        method: "POST",
        headers: admin1Headers(),
        body: "{}",
      },
    );
    expect(startRes.status).toBe(200);
    const start = (await startRes.json()) as {
      session_id: string;
      authorize_url: string;
    };
    expect(start.authorize_url).toContain("openai_codex");
    expect(driverHarness.getLastBeginInput()).toEqual({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      initiator: "human:op-1",
    });
    expect(driverHarness.pendingHandleCount()).toBe(before + 1);

    const submitRes = await app.request(
      "/admin/providers/openai_codex/oauth/submit-code",
      {
        method: "POST",
        headers: admin1Headers(),
        body: JSON.stringify({
          session_id: start.session_id,
          code: "auth-code-xyz",
        }),
      },
    );
    expect(submitRes.status).toBe(200);
    const submit = (await submitRes.json()) as {
      provider_key: string;
      status: string;
    };
    expect(submit.provider_key).toBe("openai_codex");
    expect(submit.status).toBe("active");
    expect(driverHarness.pendingHandleCount()).toBe(before);

    const conn = await oauthRepo.getActiveConnection<{ access: string }>(
      "openai_codex",
    );
    expect(conn?.payload.access).toBe("at-auth-code-xyz");

    const auditRows = await admin.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_kind IN ('oauth_session','provider_oauth_connection') ORDER BY recorded_at`,
    );
    const actions = auditRows.rows.map((r) => r.action);
    expect(actions).toContain("provider.oauth.start");
    expect(actions).toContain("provider.oauth.connected");
  });

  it("submit-code on an unknown session returns 404", async () => {
    const res = await app.request(
      "/admin/providers/openai_codex/oauth/submit-code",
      {
        method: "POST",
        headers: admin1Headers(),
        body: JSON.stringify({
          session_id: "oauth-session-bogus",
          code: "x",
        }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("submit-code from a different actor returns 403", async () => {
    const startRes = await app.request(
      "/admin/providers/openai_codex/oauth/start",
      { method: "POST", headers: admin1Headers(), body: "{}" },
    );
    const start = (await startRes.json()) as { session_id: string };

    // Grant the second actor the cap so they can pass the cap check; the
    // session-manager-side initiator check should still reject.
    await admin.query(
      `INSERT INTO capability_grants (id, actor, role, capability, scope_id, task_id, granted_by)
       VALUES ('cgr-hm-oauth-2', 'human:op-2', 'human', 'provider.oauth.connect', NULL, NULL, 'human:op-1')`,
    );
    const res = await app.request(
      "/admin/providers/openai_codex/oauth/submit-code",
      {
        method: "POST",
        headers: {
          "X-Actor-Id": "human:op-2",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session_id: start.session_id, code: "x" }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("submit-code reports driver errors as 400 OAUTH_EXCHANGE_FAILED", async () => {
    const startRes = await app.request(
      "/admin/providers/openai_codex/oauth/start",
      { method: "POST", headers: admin1Headers(), body: "{}" },
    );
    const start = (await startRes.json()) as { session_id: string };
    const res = await app.request(
      "/admin/providers/openai_codex/oauth/submit-code",
      {
        method: "POST",
        headers: admin1Headers(),
        body: JSON.stringify({ session_id: start.session_id, code: "boom" }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("OAUTH_EXCHANGE_FAILED");
  });

  it("DELETE /admin/providers/:key/oauth/connection revokes the active row", async () => {
    // Seed an active connection
    await oauthRepo.upsertConnection({
      providerKey: "openai_codex",
      providerApi: "openai-codex-responses",
      payload: { access: "x", refresh: "y", expires: 1 },
      grantedBy: "human:op-1",
    });
    const res = await app.request(
      "/admin/providers/openai_codex/oauth/connection",
      { method: "DELETE", headers: admin1Headers() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("revoked");

    const conn = await oauthRepo.getActiveConnection("openai_codex");
    expect(conn).toBeNull();
  });

  it("DELETE returns 404 when no active connection", async () => {
    const res = await app.request(
      "/admin/providers/openai_codex/oauth/connection",
      { method: "DELETE", headers: admin1Headers() },
    );
    expect(res.status).toBe(404);
  });

  it("cancel removes the in-flight session", async () => {
    const before = driverHarness.pendingHandleCount();
    const startRes = await app.request(
      "/admin/providers/openai_codex/oauth/start",
      { method: "POST", headers: admin1Headers(), body: "{}" },
    );
    const start = (await startRes.json()) as { session_id: string };
    expect(driverHarness.pendingHandleCount()).toBe(before + 1);
    const res = await app.request(
      "/admin/providers/openai_codex/oauth/cancel",
      {
        method: "POST",
        headers: admin1Headers(),
        body: JSON.stringify({ session_id: start.session_id }),
      },
    );
    expect(res.status).toBe(200);
    expect(driverHarness.pendingHandleCount()).toBe(before);
  });
});
