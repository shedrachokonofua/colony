import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetEnvCache } from "@colony/config";
import { bootFake, type BootFakeHandle } from "../e2e/boot-fake.js";
import { freePort } from "../e2e/env.js";
import { http, httpRaw, waitFor } from "../e2e/client.js";

// ---------------------------------------------------------------------------
// Helpers for subprocess SIGKILL pattern (mirrors scripts/acceptance.ts)
// ---------------------------------------------------------------------------

function spawnColonyd(env: Record<string, string>): ChildProcess {
  // Bun executes TypeScript directly; Node needs the tsx loader. Spawn whatever
  // runtime is running this suite so the child matches the parent.
  const child = spawn(
    process.execPath,
    process.versions.bun
      ? ["apps/colonyd/e2e/fake-colonyd.ts"]
      : ["--import", "tsx", "apps/colonyd/e2e/fake-colonyd.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  child.stdout?.on("data", (chunk) =>
    process.stdout.write(`[colonyd:${env["COLONYD_PORT"] ?? "?"}] ${chunk}`),
  );
  child.stderr?.on("data", (chunk) =>
    process.stderr.write(
      `[colonyd:${env["COLONYD_PORT"] ?? "?"}:err] ${chunk}`,
    ),
  );
  return child;
}

function killColonyd(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // process group may already be gone
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already dead
  }
}

async function waitForColonydDown(port: number): Promise<void> {
  const down = await waitFor(
    `colonyd :${port} down`,
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        return !response.ok;
      } catch {
        return true;
      }
    },
    15_000,
    200,
  );
  if (!down) throw new Error(`colonyd on :${port} survived SIGKILL`);
}

async function waitForColonydUp(port: number): Promise<void> {
  const up = await waitFor(
    `colonyd :${port} up`,
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        return response.ok;
      } catch {
        return false;
      }
    },
    30_000,
    250,
  );
  if (!up) throw new Error(`colonyd on :${port} never became healthy`);
}

async function waitForExit(
  child: ChildProcess,
  budgetMs = 10_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("child exit timeout")),
      budgetMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// OIDC helpers (mirror apps/colonyd/test/oidc-http.test.ts)
// ---------------------------------------------------------------------------

const OIDC_CLIENT = "colony";
const OIDC_KID = "test-key";

function createOidcIssuer(): Promise<{
  issuer: string;
  port: number;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  close: () => Promise<void>;
  signToken: (
    claims?: Record<string, unknown>,
    header?: Record<string, unknown>,
  ) => string;
}> {
  return new Promise((resolve, reject) => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      // Need issuer base for discovery
      const host =
        req.headers.host ??
        `127.0.0.1:${(server.address() as { port: number }).port}`;
      const issuerBase = `http://${host}`;
      if (
        url === "/.well-known/openid-configuration" ||
        url.startsWith("/.well-known/openid-configuration")
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jwks_uri: `${issuerBase}/jwks` }));
        return;
      }
      if (url === "/jwks" || url.startsWith("/jwks")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: OIDC_KID }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const port = addr.port;
      const issuer = `http://127.0.0.1:${port}`;
      const signToken = (
        claims: Record<string, unknown> = {},
        header: Record<string, unknown> = {},
      ): string => {
        const encode = (value: object): string =>
          Buffer.from(JSON.stringify(value)).toString("base64url");
        const body = `${encode({ alg: "RS256", kid: OIDC_KID, ...header })}.${encode(
          {
            iss: issuer,
            azp: OIDC_CLIENT,
            aud: "account",
            exp: Math.floor(Date.now() / 1000) + 300,
            preferred_username: "shdrch",
            email: "op@shdr.ch",
            realm_access: { roles: ["admin"] },
            ...claims,
          },
        )}`;
        const signature = cryptoSign(
          "RSA-SHA256",
          Buffer.from(body),
          privateKey,
        );
        return `${body}.${signature.toString("base64url")}`;
      };
      resolve({
        issuer,
        port,
        privateKey,
        close: () =>
          new Promise<void>((resClose) => {
            server.close(() => resClose());
          }),
        signToken,
      });
    });
    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("api e2e auth failures", () => {
  it("public routes return 200 without X-Actor-Id", async () => {
    const env = await bootFake();
    try {
      const health = await httpRaw(env.port, "GET", "/health", undefined, {});
      expect(health.status).toBe(200);

      const root = await httpRaw(env.port, "GET", "/", undefined, {});
      expect(root.status).toBe(200);

      const uiConfig = await httpRaw(
        env.port,
        "GET",
        "/ui/config",
        undefined,
        {},
      );
      expect(uiConfig.status).toBe(200);
      const body = uiConfig.body as { oidc?: unknown };
      expect(body.oidc).toBeNull();
    } finally {
      await env.cleanup();
      resetEnvCache();
    }
  }, 120_000);

  it("POST /scopes without X-Actor-Id → 400 MISSING_ACTOR; blank → 400", async () => {
    const env = await bootFake();
    try {
      const missing = await http(env.port, "POST", "/scopes", {
        body: {
          goal: "hello",
          title: "hello",
          repo: { path: "so/console-e2e" },
        },
        actor: null,
      });
      expect(missing.status).toBe(400);
      expect((missing.body as { error?: { code?: string } })?.error?.code).toBe(
        "MISSING_ACTOR",
      );

      const blank = await httpRaw(
        env.port,
        "POST",
        "/scopes",
        JSON.stringify({
          goal: "hello",
          title: "hello",
          repo: { path: "so/console-e2e" },
        }),
        { "content-type": "application/json", "X-Actor-Id": "   " },
      );
      expect(blank.status).toBe(400);
      expect((blank.body as { error?: { code?: string } })?.error?.code).toBe(
        "MISSING_ACTOR",
      );
    } finally {
      await env.cleanup();
      resetEnvCache();
    }
  }, 120_000);

  it("webhook with GITLAB_WEBHOOK_SECRET enforces BAD_SIGNATURE", async () => {
    const whEnv = await bootFake({ webhookSecret: "test-secret" });
    try {
      const wrong = await httpRaw(
        whEnv.port,
        "POST",
        "/webhook/gitlab",
        JSON.stringify({ hello: "world" }),
        { "content-type": "application/json", "X-Gitlab-Token": "wrong" },
      );
      expect(wrong.status).toBe(401);
      expect((wrong.body as { error?: { code?: string } })?.error?.code).toBe(
        "BAD_SIGNATURE",
      );

      const correctBody = JSON.stringify({ hello: "world", id: 99 });
      const ok = await httpRaw(
        whEnv.port,
        "POST",
        "/webhook/gitlab",
        correctBody,
        {
          "content-type": "application/json",
          "X-Gitlab-Token": "test-secret",
          "X-Gitlab-Event-UUID": "test-uuid-auth-restart",
        },
      );
      expect(ok.status).toBe(200);
      expect((ok.body as { accepted?: boolean })?.accepted).toBe(true);
    } finally {
      await whEnv.cleanup();
      resetEnvCache();
    }
  }, 120_000);
});

describe("api e2e OIDC bearer enforcement", () => {
  let oidc: Awaited<ReturnType<typeof createOidcIssuer>> | undefined;
  let env: BootFakeHandle | undefined;

  beforeAll(async () => {
    oidc = await createOidcIssuer();
  }, 30_000);

  afterAll(async () => {
    if (env) {
      try {
        await env.cleanup();
      } catch {
        // ignore secondary cleanup error
      }
      env = undefined;
      resetEnvCache();
    }
    if (oidc) {
      try {
        await oidc.close();
      } catch {
        // ignore secondary close error
      }
    }
    // Clear OIDC env pollution for subsequent suites
    delete process.env["COLONY_OIDC_ISSUER"];
    delete process.env["COLONY_OIDC_CLIENT_ID"];
    delete process.env["COLONY_OIDC_REQUIRED_ROLE"];
    resetEnvCache();
  });

  it("enforces OIDC bearer: missing/invalid/valid/service-account/missing-role", async () => {
    if (!oidc) throw new Error("OIDC issuer not started");
    env = await bootFake({
      oidcIssuer: oidc.issuer,
      oidcClientId: OIDC_CLIENT,
      oidcRequiredRole: "admin",
    });

    // No Authorization → 401 Bearer token required
    const noAuth = await http(env.port, "GET", "/scopes", { actor: null });
    expect(noAuth.status).toBe(401);
    expect(
      (noAuth.body as { error?: { code?: string; message?: string } })?.error
        ?.code,
    ).toBe("UNAUTHORIZED");
    expect(
      (noAuth.body as { error?: { message?: string } })?.error?.message,
    ).toMatch(/Bearer token required/);

    // Garbage bearer → 401
    const garbage = await httpRaw(env.port, "GET", "/scopes", undefined, {
      Authorization: "Bearer garbage",
    });
    expect(garbage.status).toBe(401);
    expect((garbage.body as { error?: { code?: string } })?.error?.code).toBe(
      "UNAUTHORIZED",
    );

    // Valid admin token → 200 on GET /scopes
    const validToken = oidc.signToken();
    const ok = await http(env.port, "GET", "/scopes", {
      actor: null,
      token: validToken,
    });
    expect(ok.status).toBe(200);

    // POST /scopes with valid token → 201 and audit actor human:shdrch
    const created = await http(env.port, "POST", "/scopes", {
      actor: null,
      token: validToken,
      body: {
        goal: "oidc valid goal",
        title: "oidc valid goal",
        repo: { path: "so/console-e2e" },
      },
    });
    expect(created.status).toBe(201);
    const scopeId = (created.body as { id: string }).id;
    const audit = await http(
      env.port,
      "GET",
      `/audit?scope_id=${encodeURIComponent(scopeId)}&limit=100`,
      {
        actor: null,
        token: validToken,
      },
    );
    expect(audit.status).toBe(200);
    const rows = (
      audit.body as unknown as {
        events: { actor: string; action: string }[];
      }
    ).events;
    const creation = rows.find((r) => r.action === "scope.created");
    expect(creation?.actor).toBe("human:shdrch");

    // Service-account token → svc:<client>
    const svcToken = oidc.signToken({
      preferred_username: `service-account-${OIDC_CLIENT}`,
    });
    const svcCreated = await http(env.port, "POST", "/scopes", {
      actor: null,
      token: svcToken,
      body: {
        goal: "oidc svc goal",
        title: "oidc svc goal",
        repo: { path: "so/console-e2e" },
      },
    });
    expect(svcCreated.status).toBe(201);
    const svcScopeId = (svcCreated.body as { id: string }).id;
    const svcAudit = await http(
      env.port,
      "GET",
      `/audit?scope_id=${encodeURIComponent(svcScopeId)}&limit=100`,
      {
        actor: null,
        token: svcToken,
      },
    );
    expect(svcAudit.status).toBe(200);
    const svcRows = (
      svcAudit.body as unknown as {
        events: { actor: string; action: string }[];
      }
    ).events;
    const svcCreation = svcRows.find((r) => r.action === "scope.created");
    expect(svcCreation?.actor).toBe(`svc:${OIDC_CLIENT}`);

    // Token missing required role → 401
    const noRoleToken = oidc.signToken({
      realm_access: { roles: ["memos-user"] },
    });
    const noRole = await http(env.port, "GET", "/scopes", {
      actor: null,
      token: noRoleToken,
    });
    expect(noRole.status).toBe(401);
    expect((noRole.body as { error?: { code?: string } })?.error?.code).toBe(
      "UNAUTHORIZED",
    );
  }, 120_000);
});

describe("api e2e restart recovery (subprocess SIGKILL)", () => {
  let restartDir: string;
  let dbPath: string;
  let port: number;
  let child: ChildProcess | undefined;
  let scopeId: string | undefined;

  beforeAll(async () => {
    restartDir = mkdtempSync(join(tmpdir(), "colonyd-restart-e2e-"));
    dbPath = join(restartDir, "restart.db");
    port = await freePort();
  }, 30_000);

  afterAll(async () => {
    // SIGTERM the surviving child, waitFor exit, assert health refuses and DB removable
    // Guard: do not mask the real failure if the DB was never created
    const dbExistedAtCleanup = (() => {
      try {
        return existsSync(dbPath);
      } catch {
        return false;
      }
    })();
    if (child) {
      const pid = child.pid;
      try {
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already dead
          }
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // ignore
      }
      try {
        await waitForExit(child, 10_000);
      } catch {
        // force kill if still alive
        if (child) killColonyd(child);
        try {
          await waitForExit(child, 5_000);
        } catch {
          // ignore
        }
      }
      // Guard: if a child somehow survives, killColonyd again
      try {
        if (child.exitCode === null && child.signalCode === null) {
          killColonyd(child);
          await waitForExit(child, 5_000);
        }
      } catch {
        // ignore
      }
      const down = await waitFor(
        "health down after SIGTERM",
        async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/health`);
            return !r.ok;
          } catch {
            return true;
          }
        },
        10_000,
        200,
      );
      expect(down).toBe(true);
      // DB removable — only assert if DB was created; otherwise just clean up
      if (dbExistedAtCleanup || existsSync(dbPath)) {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
      }
    } else if (dbExistedAtCleanup || existsSync(dbPath)) {
      // No child but leaked DB file (e.g. test died after mkdtemp)
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
    // Clean restart dir
    try {
      rmSync(restartDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    // Guard: kill any leaked child again
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        killColonyd(child);
      } catch {
        // ignore
      }
    }
    child = undefined;
  }, 120_000);

  it("killed mid-run (SIGKILL) then relaunched on SAME DB requeues exactly once", async () => {
    // Spawn fake-colonyd with stall-implementer
    child = spawnColonyd({
      COLONY_E2E_MODE: "stall-implementer",
      COLONY_E2E_DB_PATH: dbPath,
      COLONY_E2E_PORT: String(port),
      COLONYD_TICK_MS: "100",
      COLONY_OIDC_ISSUER: "",
      COLONY_OIDC_CLIENT_ID: "",
      COLONY_OIDC_REQUIRED_ROLE: "",
      GITLAB_WEBHOOK_SECRET: "",
    });
    await waitForColonydUp(port);

    // POST /scopes via http
    const created = await http(port, "POST", "/scopes", {
      body: {
        goal: "restart recovery goal",
        title: "restart recovery goal",
        repo: { path: "so/console-e2e" },
      },
    });
    expect(created.status).toBe(201);
    scopeId = (created.body as { id: string }).id;

    // Poll until a task is running with an implement run in status running
    const runningObserved = await waitFor(
      "task running with implement running",
      async () => {
        const res = await http(port, "GET", `/scopes/${scopeId}`);
        if (res.status !== 200) return false;
        const data = res.body as {
          scope: { status: string };
          tasks: { id: string; state: string }[];
          runs: { kind: string; status: string; task_id: string | null }[];
        };
        const runningTask = data.tasks.find((t) => t.state === "running");
        if (!runningTask) return false;
        const hasRunningImplement = data.runs.some(
          (r) =>
            r.kind === "implement" &&
            r.status === "running" &&
            r.task_id === runningTask.id,
        );
        return hasRunningImplement;
      },
      90_000,
      250,
    );
    expect(runningObserved).toBe(true);

    const killedAt = new Date().toISOString();
    // SIGKILL the process group
    if (child) killColonyd(child);
    await waitForColonydDown(port);
    // Wait for exit
    if (child) {
      try {
        await waitForExit(child, 10_000);
      } catch {
        // continue
      }
    }

    // Relaunch SAME db path with COLONY_E2E_MODE=default (no stall)
    child = spawnColonyd({
      COLONY_E2E_MODE: "default",
      COLONY_E2E_DB_PATH: dbPath,
      COLONY_E2E_PORT: String(port),
      COLONYD_TICK_MS: "100",
      COLONY_OIDC_ISSUER: "",
      COLONY_OIDC_CLIENT_ID: "",
      COLONY_OIDC_REQUIRED_ROLE: "",
      GITLAB_WEBHOOK_SECRET: "",
    });
    await waitForColonydUp(port);

    // Poll until scope done and tasks merged
    const done = await waitFor(
      "scope done and tasks merged",
      async () => {
        const res = await http(port, "GET", `/scopes/${scopeId}`);
        if (res.status !== 200) return false;
        const data = res.body as {
          scope: { status: string };
          tasks: { id: string; state: string; mr_iid: number | null }[];
          runs: { kind: string; status: string; error: string | null }[];
        };
        if (data.scope.status !== "done") return false;
        if (data.tasks.length === 0) return false;
        if (!data.tasks.every((t) => t.state === "merged")) return false;
        // also check expired implement run is failed process_restart visible
        const hasFailedRestart = data.runs.some(
          (r) =>
            r.kind === "implement" &&
            r.status === "failed" &&
            r.error === "process_restart",
        );
        if (!hasFailedRestart) return false;
        return true;
      },
      90_000,
      250,
    );
    expect(done).toBe(true);

    // Final assertions on audit and task attempt
    const final = await http(port, "GET", `/scopes/${scopeId}`);
    expect(final.status).toBe(200);
    const finalData = final.body as {
      scope: { status: string };
      tasks: {
        id: string;
        state: string;
        attempt: number;
        mr_iid: number | null;
      }[];
      runs: { kind: string; status: string; error: string | null }[];
    };
    expect(finalData.scope.status).toBe("done");
    let totalRequeues = 0;
    for (const task of finalData.tasks) {
      // attempt === 0 (process_restart does NOT consume an attempt)
      expect(task.attempt).toBe(0);

      const auditRes = await http(
        port,
        "GET",
        `/audit?task_id=${encodeURIComponent(task.id)}&limit=1000`,
      );
      expect(auditRes.status).toBe(200);
      const auditRows = (
        auditRes.body as {
          events: {
            id: number;
            at: string;
            action: string;
            detail_json: string;
          }[];
        }
      ).events;

      const requeues = auditRows.filter((row) => {
        if (row.action !== "task.transition") return false;
        if (row.at <= killedAt) return false;
        try {
          const detail = JSON.parse(row.detail_json) as {
            from?: string;
            to?: string;
          };
          return detail.from === "running" && detail.to === "queued";
        } catch {
          return false;
        }
      });
      totalRequeues += requeues.length;
      // At most one requeue per task; only the stalled task requeues
      expect(requeues.length).toBeLessThanOrEqual(1);

      // mr.opened count === 1 per task (no duplicate MRs)
      const mrOpened = auditRows.filter((r) => r.action === "mr.opened");
      expect(mrOpened).toHaveLength(1);
    }
    // Exactly ONE requeue overall (lease-expiry requeue happens exactly once)
    expect(totalRequeues).toBe(1);

    // The expired implement run is status failed error process_restart (visible in runs)
    const failedRestart = finalData.runs.find(
      (r) =>
        r.kind === "implement" &&
        r.status === "failed" &&
        r.error === "process_restart",
    );
    expect(failedRestart).toBeTruthy();
  }, 120_000);
});
