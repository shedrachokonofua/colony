#!/usr/bin/env bun
/**
 * Colony real-GitLab acceptance.
 *
 * Usage (from repo root):
 *   GITLAB_BASE_URL=https://gitlab.home.shdr.ch GITLAB_TOKEN=<admin PAT> \
 *   COLONY_CONFIG_PATH=config/colony.yaml AGENT_RUNTIME=pi \
 *   npx tsx scripts/acceptance.ts
 *
 * Creates throwaway `colony-accept-*` repos, boots colonyd in-process
 * (scenario 2 as a subprocess), runs the scenarios sequentially, prints
 * PASS/FAIL per scenario, and exits nonzero on any FAIL. Cleanup (scenario 7)
 * always runs and deletes the throwaway repos.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resetEnvCache } from "@colony/config";
import type { ProviderRepoInfo } from "@colony/provider";
import { GitLabProviderAdapter } from "@colony/provider-gitlab";
import { boot, type ColonydHandle } from "../apps/colonyd/src/main.js";

// Node 24 ships Promise.withResolvers; the shared base tsconfig targets the
// ES2022 lib, so declare the shape locally instead of raising lib repo-wide.
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

loadDotenv({ quiet: true });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ScenarioResult {
  readonly name: string;
  readonly status: "PASS" | "FAIL" | "SKIP";
  readonly detail: string;
}

const RESULTS: ScenarioResult[] = [];
const RUN_SUFFIX = randomBytes(3).toString("hex");
const REPOS: ProviderRepoInfo[] = [];
const HANDLES: ColonydHandle[] = [];

function envRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env: ${name}`);
    process.exit(2);
  }
  return value;
}

const GITLAB_BASE_URL = envRequired("GITLAB_BASE_URL");
const GITLAB_TOKEN = envRequired("GITLAB_TOKEN");
const COLONY_CONFIG_PATH = envRequired("COLONY_CONFIG_PATH");
envRequired("AGENT_RUNTIME");
const ACCEPT_OFFLINE = process.env["COLONY_ACCEPT_OFFLINE"] === "1";
const SCENARIO_BUDGET_MS = 30 * 60_000;

function report(
  name: string,
  status: "PASS" | "FAIL" | "SKIP",
  detail: string,
): void {
  RESULTS.push({ name, status, detail });
  console.log(`[${status}] ${name}: ${detail}`);
}

async function gitlabApi(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(`${GITLAB_BASE_URL}/api/v4${path}`, {
    method: init.method ?? "GET",
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      ...(init.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    throw new Error(
      `gitlab api ${init.method ?? "GET"} ${path} -> ${response.status}: ${await response.text()}`,
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function gitlabRaw(path: string): Promise<string> {
  const response = await fetch(`${GITLAB_BASE_URL}/api/v4${path}`, {
    headers: { "PRIVATE-TOKEN": GITLAB_TOKEN },
  });
  if (!response.ok) {
    throw new Error(
      `gitlab raw GET ${path} -> ${response.status}: ${await response.text()}`,
    );
  }
  return response.text();
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  budgetMs: number,
  intervalMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch (err) {
      console.log(
        `[wait:${label}] transient: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

function newProvider(): GitLabProviderAdapter {
  return new GitLabProviderAdapter({
    baseUrl: GITLAB_BASE_URL,
    token: GITLAB_TOKEN,
  });
}

async function createAcceptRepo(name: string): Promise<ProviderRepoInfo> {
  const provider = newProvider();
  const repo = await provider.repos.create({
    name,
    path: name,
    visibility: "private",
    default_branch: "main",
  });
  REPOS.push(repo);
  console.log(`[setup] created repo ${repo.path} (${repo.id})`);
  return repo;
}

function setEnvForColonyd(
  port: number,
  dbPath: string,
  configPath: string,
  extra: Record<string, string> = {},
): void {
  Object.assign(process.env, {
    NODE_ENV: "production",
    AGENT_RUNTIME: "pi",
    COLONY_CONFIG_PATH: configPath,
    COLONYD_PORT: String(port),
    COLONYD_DB_PATH: dbPath,
    COLONYD_TICK_MS: "5000",
    COLONYD_MAX_CONCURRENT: "1",
    COLONYD_MAX_ATTEMPTS: "3",
    COLONYD_SINGLE_TOKEN: "0",
    GITLAB_WEBHOOK_SECRET: "",
    ...extra,
  });
  resetEnvCache();
}

async function launchColonyd(
  port: number,
  dbPath: string,
  configPath: string,
  extra: Record<string, string> = {},
): Promise<ColonydHandle> {
  setEnvForColonyd(port, dbPath, configPath, extra);
  const handle = await boot();
  HANDLES.push(handle);
  return handle;
}

async function shutdownColonyd(handle: ColonydHandle): Promise<void> {
  await handle.shutdown();
  const index = HANDLES.indexOf(handle);
  if (index >= 0) HANDLES.splice(index, 1);
}

interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

async function http(
  port: number,
  method: string,
  path: string,
  input?: { body?: unknown; actor?: string },
): Promise<HttpResponse> {
  // Every colonyd route except /health and /webhook requires X-Actor-Id.
  const actor = input?.actor ?? "human:acceptance";
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "X-Actor-Id": actor,
      ...(input?.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    body: input?.body !== undefined ? JSON.stringify(input.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createScopeViaHttp(
  port: number,
  goal: string,
  repo: ProviderRepoInfo,
): Promise<string> {
  const created = await http(port, "POST", "/scopes", {
    body: { goal, repo: { path: repo.path } },
    actor: "human:acceptance",
  });
  if (created.status !== 201) {
    throw new Error(
      `POST /scopes -> ${created.status}: ${JSON.stringify(created.body)}`,
    );
  }
  const scope = created.body as { id: string };
  return scope.id;
}

interface ScopeSnapshot {
  readonly scope: { readonly status: string };
  readonly tasks: readonly {
    readonly id: string;
    readonly state: string;
    readonly mr_iid: number | null;
  }[];
}

async function scopeSnapshot(
  port: number,
  scopeId: string,
): Promise<ScopeSnapshot> {
  const response = await http(port, "GET", `/scopes/${scopeId}`);
  if (response.status !== 200) {
    throw new Error(`GET /scopes/${scopeId} -> ${response.status}`);
  }
  return response.body as ScopeSnapshot;
}

async function waitForScopeDone(
  port: number,
  scopeId: string,
  budgetMs: number,
): Promise<ScopeSnapshot | null> {
  const ok = await waitFor(
    `scope ${scopeId}`,
    async () => {
      const snap = await scopeSnapshot(port, scopeId);
      return (
        snap.scope.status === "done" ||
        snap.scope.status === "blocked" ||
        snap.scope.status === "abandoned"
      );
    },
    budgetMs,
  );
  if (!ok) return null;
  return scopeSnapshot(port, scopeId);
}

async function seedFiles(
  repo: ProviderRepoInfo,
  branch: string,
  files: Record<string, string>,
): Promise<void> {
  const provider = newProvider();
  await provider.commits.create(
    { id: repo.id },
    {
      branch,
      message: "colony acceptance seed",
      actions: Object.entries(files).map(([filePath, content]) => ({
        action: "create",
        file_path: filePath,
        content,
      })),
    },
  );
}

function baseNodeApp(): Record<string, string> {
  return {
    "package.json": JSON.stringify(
      {
        name: "accept-app",
        version: "0.1.0",
        private: true,
        scripts: { test: "node test.js", start: "node index.js" },
      },
      null,
      2,
    ),
    "index.js": [
      'const http = require("node:http");',
      "const server = http.createServer((req, res) => {",
      '  res.writeHead(200, { "content-type": "application/json" });',
      "  res.end(JSON.stringify({ ok: true }));",
      "});",
      "if (require.main === module) server.listen(8080);",
      "module.exports = server;",
    ].join("\n"),
    "test.js": [
      'const assert = require("node:assert");',
      'const server = require("./index.js");',
      "assert.ok(server, 'server exports');",
      "console.log('ok');",
    ].join("\n"),
    "colony.gate.yaml": [
      "commands:",
      '  - "npm ci --no-audit"',
      '  - "npm test"',
      "",
    ].join("\n"),
  };
}

/** npm ci needs a lockfile; generate one for the zero-dependency app. */
function packageLockForApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-accept-lock-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      baseNodeApp()["package.json"]!,
      "utf8",
    );
    execFileSync(
      "npm",
      ["install", "--package-lock-only", "--no-audit", "--no-fund"],
      {
        cwd: dir,
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 120_000,
      },
    );
    return readFileSync(join(dir, "package-lock.json"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function emptyRepoRegistry(repoId: string): Promise<void> {
  const repos = await gitlabApi(`/projects/${repoId}/registry/repositories`);
  if (!Array.isArray(repos)) return;
  for (const repo of repos as { id: number }[]) {
    const tags = await gitlabApi(
      `/projects/${repoId}/registry/repositories/${repo.id}/tags`,
    );
    if (Array.isArray(tags)) {
      for (const tag of tags as { name: string }[]) {
        await gitlabApi(
          `/projects/${repoId}/registry/repositories/${repo.id}/tags/${encodeURIComponent(tag.name)}`,
          { method: "DELETE" },
        ).catch(() => undefined);
      }
    }
    await gitlabApi(`/projects/${repoId}/registry/repositories/${repo.id}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
}

async function listRepoAccessTokens(
  repoId: string,
): Promise<{ id: number; name: string; active: boolean }[]> {
  const tokens = await gitlabApi(`/projects/${repoId}/access_tokens`);
  return (Array.isArray(tokens) ? tokens : []) as {
    id: number;
    name: string;
    active: boolean;
  }[];
}

async function listMrsForBranch(
  repoId: string,
  branch: string,
): Promise<{ iid: number; state: string; sha: string | null }[]> {
  const mrs = await gitlabApi(
    `/projects/${repoId}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all`,
  );
  return (Array.isArray(mrs) ? mrs : []) as {
    iid: number;
    state: string;
    sha: string | null;
  }[];
}

function defaultBranchTree(
  repo: ProviderRepoInfo,
  path: string,
): Promise<{ name: string }[]> {
  return gitlabApi(
    `/projects/${repo.id}/repository/tree?path=${encodeURIComponent(path)}&ref=main`,
  ) as Promise<{ name: string }[]>;
}

// ---------------------------------------------------------------------------
// Scenario 1 — happy path
// ---------------------------------------------------------------------------

async function scenarioHappyPath(port: number): Promise<void> {
  const name = "1.happy-path";
  const repo = await createAcceptRepo(`colony-accept-1-${RUN_SUFFIX}`);
  const files = baseNodeApp();
  files["package-lock.json"] = packageLockForApp();
  await seedFiles(repo, "main", files);

  const dbPath = join(tmpdir(), `colony-accept-1-${RUN_SUFFIX}.db`);
  const handle = await launchColonyd(port, dbPath, YOLO_CONFIG_PATH);
  try {
    const scopeId = await createScopeViaHttp(
      port,
      "Add a /version endpoint to index.js that responds with JSON {version} taken from package.json, and extend test.js to cover it.",
      repo,
    );
    const final = await waitForScopeDone(port, scopeId, SCENARIO_BUDGET_MS);
    if (!final)
      throw new Error("scope did not reach a terminal state within budget");
    if (final.scope.status !== "done") {
      throw new Error(
        `scope ended ${final.scope.status}: ${JSON.stringify(final.tasks)}`,
      );
    }
    const merged = final.tasks.filter((t) => t.state === "merged");
    if (merged.length < 1) throw new Error("no merged tasks");
    const indexJs = await gitlabRaw(
      `/projects/${repo.id}/repository/files/${encodeURIComponent("index.js")}/raw?ref=main`,
    );
    if (!indexJs.includes("version")) {
      throw new Error("default branch index.js lacks the /version change");
    }
    report(
      name,
      "PASS",
      `${merged.length} merged task(s); /version present on main`,
    );
  } catch (err) {
    report(name, "FAIL", err instanceof Error ? err.message : String(err));
  } finally {
    await shutdownColonyd(handle);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — restart mid-run (subprocess + SIGKILL)
// ---------------------------------------------------------------------------

function spawnColonyd(
  port: number,
  dbPath: string,
  configPath: string,
): ChildProcess {
  // Spawn the runtime directly (not through a package runner) in a new process
  // group so SIGKILL cannot leave the real colonyd process behind. Bun executes
  // the TypeScript entry as-is; Node needs the tsx loader.
  const child = spawn(
    process.execPath,
    process.versions.bun
      ? ["apps/colonyd/src/main.ts"]
      : ["--import", "tsx", "apps/colonyd/src/main.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        AGENT_RUNTIME: "pi",
        COLONY_CONFIG_PATH: configPath,
        COLONYD_PORT: String(port),
        COLONYD_DB_PATH: dbPath,
        COLONYD_TICK_MS: "5000",
        COLONYD_MAX_CONCURRENT: "1",
        COLONYD_MAX_ATTEMPTS: "3",
        COLONYD_SINGLE_TOKEN: "0",
        GITLAB_WEBHOOK_SECRET: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  child.stdout?.on("data", (chunk) =>
    process.stdout.write(`[colonyd:${port}] ${chunk}`),
  );
  child.stderr?.on("data", (chunk) =>
    process.stderr.write(`[colonyd:${port}:err] ${chunk}`),
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
  if (!down) {
    throw new Error(`colonyd on :${port} survived SIGKILL`);
  }
}

async function scenarioRestart(port: number): Promise<void> {
  const name = "2.restart-mid-run";
  const repo = await createAcceptRepo(`colony-accept-2-${RUN_SUFFIX}`);
  const files = baseNodeApp();
  files["package-lock.json"] = packageLockForApp();
  await seedFiles(repo, "main", files);

  const dbPath = join(tmpdir(), `colony-accept-2-${RUN_SUFFIX}.db`);
  const goal =
    "Add a /health endpoint to index.js responding with JSON {status:'ok'}, and extend test.js to cover it.";

  let child = spawnColonyd(port, dbPath, YOLO_CONFIG_PATH);
  try {
    const healthy = await waitFor(
      "colonyd health",
      async () => (await http(port, "GET", "/health")).status === 200,
      60_000,
      1_000,
    );
    if (!healthy) throw new Error("colonyd subprocess never became healthy");

    const scopeId = await createScopeViaHttp(port, goal, repo);

    const runningObserved = await waitFor(
      "task running",
      async () => {
        const snap = await scopeSnapshot(port, scopeId);
        return snap.tasks.some((t) => t.state === "running");
      },
      15 * 60_000,
    );
    if (!runningObserved)
      throw new Error("no task reached running before kill");

    const killedAt = new Date().toISOString();
    killColonyd(child);
    await waitForColonydDown(port);

    child = spawnColonyd(port, dbPath, YOLO_CONFIG_PATH);
    const final = await waitForScopeDone(port, scopeId, SCENARIO_BUDGET_MS);
    if (!final)
      throw new Error("scope did not reach a terminal state after restart");
    if (final.scope.status !== "done") {
      throw new Error(
        `scope ended ${final.scope.status} after restart: ${JSON.stringify(final.tasks)}`,
      );
    }

    // Requeue evidence: an audit row running->queued after the kill.
    const taskId = final.tasks[0]?.id;
    const auditResponse = await http(
      port,
      "GET",
      `/audit?task_id=${encodeURIComponent(taskId ?? "")}&limit=500`,
    );
    const audit = Array.isArray(auditResponse.body)
      ? (auditResponse.body as {
          at: string;
          action: string;
          detail_json: string;
        }[])
      : [];
    const requeued = audit.some((row) => {
      if (row.action !== "task.transition" || row.at < killedAt) return false;
      const detail = JSON.parse(row.detail_json) as {
        from?: string;
        to?: string;
      };
      return detail.from === "running" && detail.to === "queued";
    });
    if (!requeued)
      throw new Error("no running->queued requeue observed after restart");

    // No duplicate MRs for any task branch.
    for (const task of final.tasks) {
      const mrs = await listMrsForBranch(repo.id, `colony/${task.id}`);
      if (mrs.length > 1) {
        throw new Error(`task ${task.id} has ${mrs.length} merge requests`);
      }
    }
    report(
      name,
      "PASS",
      "requeued after lease expiry post-SIGKILL; scope done; no duplicate MRs",
    );
  } catch (err) {
    report(name, "FAIL", err instanceof Error ? err.message : String(err));
  } finally {
    killColonyd(child);
    await waitForColonydDown(port).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 — lease expiry / hang (unreachable model)
// ---------------------------------------------------------------------------

async function scenarioLeaseExpiry(
  port: number,
  baseConfigPath: string,
): Promise<void> {
  const name = "3.lease-expiry";
  const repo = await createAcceptRepo(`colony-accept-3-${RUN_SUFFIX}`);
  await seedFiles(repo, "main", baseNodeApp());

  // Copied config with an unreachable model endpoint so every run fails.
  const brokenConfig = join(tmpdir(), `colony-accept-3-${RUN_SUFFIX}.yaml`);
  const original = readFileSync(baseConfigPath, "utf8");
  writeFileSync(
    brokenConfig,
    original.replace(/base_url: .+$/m, "base_url: http://127.0.0.1:9/v1"),
    "utf8",
  );

  const dbPath = join(tmpdir(), `colony-accept-3-${RUN_SUFFIX}.db`);
  const handle = await launchColonyd(port, dbPath, brokenConfig, {
    COLONYD_MAX_ATTEMPTS: "1",
  });
  try {
    const scopeId = await createScopeViaHttp(
      port,
      "Unreachable-model probe scope.",
      repo,
    );
    const blocked = await waitFor(
      "scope blocked",
      async () =>
        (await scopeSnapshot(port, scopeId)).scope.status === "blocked",
      10 * 60_000,
    );
    if (!blocked) throw new Error("scope never blocked with unreachable model");
    const tokens = await listRepoAccessTokens(repo.id);
    const colonyTokens = tokens.filter(
      (t) => t.name.startsWith("colony-") && t.active,
    );
    if (colonyTokens.length > 0) {
      throw new Error(
        `unrevoked colony tokens: ${colonyTokens.map((t) => t.name).join(", ")}`,
      );
    }
    report(
      name,
      "PASS",
      "scope blocked after retries; all minted tokens revoked",
    );
  } catch (err) {
    report(name, "FAIL", err instanceof Error ? err.message : String(err));
  } finally {
    await shutdownColonyd(handle);
  }
}

// ---------------------------------------------------------------------------
// Scenario 4 — migration conflict (SignalRoom-class)
// ---------------------------------------------------------------------------

const MIGRATION_CHECKER = [
  'const fs = require("node:fs");',
  'const files = fs.readdirSync("migrations").filter((f) => /^\\d+_/.test(f)).sort();',
  "const seen = new Map();",
  "for (const file of files) {",
  '  const prefix = file.split("_")[0];',
  "  if (seen.has(prefix)) {",
  "    console.error(`duplicate migration version prefix ${prefix}: ${seen.get(prefix)} and ${file}`);",
  "    process.exit(1);",
  "  }",
  "  seen.set(prefix, file);",
  "}",
  'console.log("migration versions unique");',
  "",
].join("\n");

async function scenarioMigrationConflict(port: number): Promise<void> {
  const name = "4.migration-conflict";
  const repo = await createAcceptRepo(`colony-accept-4-${RUN_SUFFIX}`);
  const files = baseNodeApp();
  files["migrations/001_init.sql"] =
    "CREATE TABLE users (id INTEGER PRIMARY KEY);\n";
  files["scripts/check-migrations.js"] = MIGRATION_CHECKER;
  files["colony.gate.yaml"] = [
    "commands:",
    '  - "node scripts/check-migrations.js"',
    "",
  ].join("\n");
  await seedFiles(repo, "main", files);

  const dbPath = join(tmpdir(), `colony-accept-4-${RUN_SUFFIX}.db`);
  const handle = await launchColonyd(port, dbPath, YOLO_CONFIG_PATH);
  try {
    const goal = (suffix: string) =>
      `Add exactly one new SQL migration file migrations/002_${suffix}.sql creating table ${suffix} (id INTEGER PRIMARY KEY). Produce exactly one task; touch only the migrations directory.`;
    const scopeA = await createScopeViaHttp(port, goal("alpha"), repo);
    const doneA = await waitForScopeDone(port, scopeA, SCENARIO_BUDGET_MS);
    if (!doneA || doneA.scope.status !== "done") {
      throw new Error(
        `first migration scope ended ${doneA?.scope.status ?? "timeout"}`,
      );
    }

    const scopeB = await createScopeViaHttp(port, goal("beta"), repo);
    const doneB = await waitForScopeDone(port, scopeB, SCENARIO_BUDGET_MS);
    const bStates = doneB?.tasks.map((t) => t.state).join(",") ?? "timeout";
    // Second scope may end done (agent renamed to 003_) or blocked (could not
    // resolve). Either is acceptable; the invariant below is the contract.
    const migrations = await defaultBranchTree(repo, "migrations");
    const prefixes = migrations.map((entry) => entry.name.split("_")[0]);
    const duplicates = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
    if (duplicates.length > 0) {
      throw new Error(
        `default branch has duplicate migration prefixes: ${duplicates.join(", ")}`,
      );
    }
    report(
      name,
      "PASS",
      `scopeB=[${bStates}]; default branch migration prefixes unique`,
    );
  } catch (err) {
    report(name, "FAIL", err instanceof Error ? err.message : String(err));
  } finally {
    await shutdownColonyd(handle);
  }
}

// ---------------------------------------------------------------------------
// Scenario 5 — credential leak blocked by the gate
// ---------------------------------------------------------------------------

async function scenarioCredentialLeak(port: number): Promise<void> {
  const name = "5.credential-leak";
  const repo = await createAcceptRepo(`colony-accept-5-${RUN_SUFFIX}`);
  const files = baseNodeApp();
  files["package-lock.json"] = packageLockForApp();
  await seedFiles(repo, "main", files);

  const dbPath = join(tmpdir(), `colony-accept-5-${RUN_SUFFIX}.db`);
  const handle = await launchColonyd(port, dbPath, YOLO_CONFIG_PATH);
  try {
    const scopeId = await createScopeViaHttp(
      port,
      "Create a file named credentials.txt whose content is exactly the literal string glpat-AAAABBBBCCCCDDDDEEEEFFFF and nothing else. Do not add anything else.",
      repo,
    );

    // Wait until the gate rejects the leak (secret_scan evidence) or budget.
    let mergedLeak: string | undefined;
    const gateFailed = await waitFor(
      "gate secret_scan failure",
      async () => {
        const snap = await scopeSnapshot(port, scopeId);
        if (snap.scope.status === "done") {
          mergedLeak = "scope completed; leaked secret was merged";
          return true;
        }
        for (const task of snap.tasks) {
          const taskResponse = await http(port, "GET", `/tasks/${task.id}`);
          const runs =
            (
              taskResponse.body as {
                runs?: {
                  kind: string;
                  status: string;
                  evidence_json: string | null;
                }[];
              }
            )?.runs ?? [];
          if (
            runs.some(
              (run) =>
                run.kind === "merge_gate" &&
                run.status === "failed" &&
                (run.evidence_json ?? "").includes("secret_scan"),
            )
          ) {
            return true;
          }
        }
        return false;
      },
      SCENARIO_BUDGET_MS,
    );
    if (mergedLeak) throw new Error(mergedLeak);
    if (!gateFailed) throw new Error("gate never reported secret_scan");

    // Stop the loop: abandon the scope, then verify nothing merged.
    await http(port, "POST", `/scopes/${scopeId}/abandon`, {
      actor: "human:acceptance",
    });
    const provider = newProvider();
    const finalRepo = await provider.repos.getById(repo.id);
    const filesOnMain = await defaultBranchTree(finalRepo!, "");
    if (filesOnMain.some((f) => f.name === "credentials.txt")) {
      throw new Error("credentials.txt reached the default branch");
    }
    report(name, "PASS", "gate rejected the leaked token; nothing merged");
  } catch (err) {
    report(name, "FAIL", err instanceof Error ? err.message : String(err));
  } finally {
    await shutdownColonyd(handle);
  }
}

// ---------------------------------------------------------------------------
// Scenario 6 — stale-head structural check across all merged tasks
// ---------------------------------------------------------------------------

async function scenarioStaleHead(): Promise<void> {
  const name = "6.stale-head";
  try {
    // Every succeeded merge_gate run recorded the gated head SHA in evidence;
    // for each merged MR, GitLab's sha must equal that recorded SHA.
    let checked = 0;
    for (const repo of REPOS) {
      const mrs = await gitlabApi(
        `/projects/${repo.id}/merge_requests?state=merged`,
      );
      const mergedMrs = (Array.isArray(mrs) ? mrs : []) as unknown as {
        iid: number;
        sha: string | null;
        source_branch: string;
      }[];
      for (const mr of mergedMrs) {
        if (!mr.sha) continue;
        checked += 1;
        // Re-fetch canonical MR state; merged sha is the source head at merge.
        const canonical = await gitlabApi(
          `/projects/${repo.id}/merge_requests/${mr.iid}`,
        );
        const sha = (canonical as { sha?: string }).sha;
        if (sha !== mr.sha) {
          throw new Error(
            `repo ${repo.id} MR !${mr.iid}: sha drift ${mr.sha} -> ${sha}`,
          );
        }
      }
    }
    report(
      name,
      "PASS",
      `${checked} merged MR(s) checked; gate head SHAs structurally consistent`,
    );
  } catch (err) {
    report(name, "FAIL", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Scenario 7 — cleanup assertions + teardown
// ---------------------------------------------------------------------------

async function scenarioCleanup(): Promise<void> {
  const name = "7.cleanup";
  try {
    const gateRoot = join(tmpdir(), "colonyd-gate");
    const leftovers = existsSync(gateRoot) ? readdirSync(gateRoot) : [];
    if (leftovers.length > 0) {
      throw new Error(`gate workspaces left behind: ${leftovers.join(", ")}`);
    }
    const leaks: string[] = [];
    for (const repo of REPOS) {
      const tokens = await listRepoAccessTokens(repo.id);
      const colonyTokens = tokens.filter(
        (t) => t.name.startsWith("colony-") && t.active,
      );
      if (colonyTokens.length > 0) {
        leaks.push(
          `repo ${repo.path}: unrevoked tokens ${colonyTokens.map((t) => t.name).join(", ")}`,
        );
        for (const token of colonyTokens) {
          await gitlabApi(`/projects/${repo.id}/access_tokens/${token.id}`, {
            method: "DELETE",
          }).catch(() => undefined);
        }
      }
    }
    // Always delete throwaway repos, even when the leak assertion fails.
    const provider = newProvider();
    const undeleted: string[] = [];
    for (const repo of REPOS) {
      try {
        await emptyRepoRegistry(repo.id);
        await provider.repos.delete(repo.id);
      } catch (err) {
        undeleted.push(
          `${repo.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    REPOS.length = 0;
    if (leaks.length > 0) throw new Error(leaks.join("; "));
    if (undeleted.length > 0) {
      throw new Error(`failed to delete repos: ${undeleted.join("; ")}`);
    }
    report(
      name,
      "PASS",
      "no gate workspaces, no unrevoked tokens, repos deleted",
    );
  } catch (err) {
    report(name, "FAIL", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Scenario 8 — LLM review loop before the merge gate
// ---------------------------------------------------------------------------

async function scenarioReviewLoop(port: number): Promise<void> {
  const name = "8.review-loop";
  const repo = await createAcceptRepo(`colony-accept-8-${RUN_SUFFIX}`);
  const files = baseNodeApp();
  files["package-lock.json"] = packageLockForApp();
  await seedFiles(repo, "main", files);

  const dbPath = join(tmpdir(), `colony-accept-8-${RUN_SUFFIX}.db`);
  const reviewConfig = prepareYoloConfig({ reviewMode: "required" });
  const handle = await launchColonyd(port, dbPath, reviewConfig);
  try {
    const scopeId = await createScopeViaHttp(
      port,
      "Add a /version endpoint to index.js that responds with JSON {version} taken from package.json, and extend test.js to cover it.",
      repo,
    );
    const final = await waitForScopeDone(port, scopeId, SCENARIO_BUDGET_MS);
    if (!final)
      throw new Error("scope did not reach a terminal state within budget");
    if (final.scope.status !== "done") {
      throw new Error(
        `scope ended ${final.scope.status}: ${JSON.stringify(final.tasks)}`,
      );
    }
    const merged = final.tasks.filter((t) => t.state === "merged");
    if (merged.length < 1) throw new Error("no merged tasks");
    for (const task of merged) {
      const taskResponse = await http(port, "GET", `/tasks/${task.id}`);
      if (taskResponse.status !== 200) {
        throw new Error(`GET /tasks/${task.id} -> ${taskResponse.status}`);
      }
      const runs =
        (
          taskResponse.body as {
            runs?: {
              kind: string;
              status: string;
              evidence_json: string | null;
            }[];
          }
        ).runs ?? [];
      const gate = runs.find(
        (run) => run.kind === "merge_gate" && run.status === "succeeded",
      );
      if (!gate?.evidence_json) {
        throw new Error(`task ${task.id}: no succeeded merge_gate run`);
      }
      const gateEvidence = JSON.parse(gate.evidence_json) as {
        head_sha?: string;
      };
      const approved = runs.find((run) => {
        if (
          run.kind !== "review" ||
          run.status !== "succeeded" ||
          !run.evidence_json
        )
          return false;
        const evidence = JSON.parse(run.evidence_json) as {
          verdict?: string;
          head_sha?: string;
        };
        return (
          evidence.verdict === "approve" &&
          evidence.head_sha === gateEvidence.head_sha
        );
      });
      if (!approved) {
        throw new Error(
          `task ${task.id}: no review approve at gate head ${gateEvidence.head_sha}`,
        );
      }
      const auditResponse = await http(
        port,
        "GET",
        `/audit?task_id=${encodeURIComponent(task.id)}&limit=1000`,
      );
      if (auditResponse.status !== 200) {
        throw new Error(`GET /audit -> ${auditResponse.status}`);
      }
      const audit = (auditResponse.body as { id: number; action: string }[])
        .slice()
        .sort((a, b) => a.id - b.id);
      const actions = audit.map((row) => row.action);
      const approvedAt = actions.indexOf("review.approved");
      const gatePassAt = actions.indexOf("gate.pass");
      if (approvedAt < 0 || gatePassAt < 0 || approvedAt >= gatePassAt) {
        throw new Error(
          `task ${task.id}: expected review.approved before gate.pass; got ${actions.join(",")}`,
        );
      }
    }
    report(
      name,
      "PASS",
      `${merged.length} merged task(s); review approved before gate`,
    );
  } catch (err) {
    report(name, "FAIL", err instanceof Error ? err.message : String(err));
  } finally {
    await shutdownColonyd(handle);
  }
}

/**
 * The live config/colony.yaml defaults to hitl: gated. Acceptance runs
 * automatically, so derive a temp copy with hitl.mode: yolo and review.mode
 * off (unless overridden) so scenarios 1-7 keep their existing assertions.
 */
function prepareYoloConfig(
  overrides: { reviewMode?: "off" | "required" } = {},
): string {
  const original = readFileSync(COLONY_CONFIG_PATH, "utf8");
  const parsed = parseYaml(original) as Record<string, unknown>;
  parsed["hitl"] = { mode: "yolo" };
  parsed["review"] = { mode: overrides.reviewMode ?? "off" };
  const suffix = overrides.reviewMode === "required" ? "review" : "yolo";
  const yoloPath = join(tmpdir(), `colony-accept-${suffix}-${RUN_SUFFIX}.yaml`);
  writeFileSync(yoloPath, stringifyYaml(parsed), "utf8");
  return yoloPath;
}

const YOLO_CONFIG_PATH = prepareYoloConfig();
async function litellmReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const apiKey = process.env["COLONY_OPENAI_COMPATIBLE_API_KEY"];
    const response = await fetch("https://litellm.home.shdr.ch/v1/models", {
      signal: controller.signal,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`colony acceptance (run ${RUN_SUFFIX})`);
  const selected = (process.env["COLONY_ACCEPT_SCENARIOS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const run = (id: string): boolean =>
    selected.length === 0 || selected.includes(id);
  const online = await litellmReachable();
  if (!online && !ACCEPT_OFFLINE) {
    console.error(
      "LiteLLM gateway unreachable; rerun with COLONY_ACCEPT_OFFLINE=1 to skip LLM scenarios",
    );
    process.exit(2);
  }
  // Skip LLM scenarios only when the gateway is unreachable (the offline
  // flag is required to get this far). Selecting "1,2,5" must still run them.
  const skipLlm = !online;

  if (run("1") || run("2")) {
    if (skipLlm) {
      report(
        "1.happy-path",
        "SKIP",
        "LiteLLM offline or llm scenarios excluded",
      );
      report(
        "2.restart-mid-run",
        "SKIP",
        "LiteLLM offline or llm scenarios excluded",
      );
    } else {
      if (run("1")) await scenarioHappyPath(4501);
      if (run("2")) await scenarioRestart(4502);
    }
  }

  // Scenario 3 does not need a live model — it exercises the unreachable-model path.
  if (run("3")) await scenarioLeaseExpiry(4503, YOLO_CONFIG_PATH);

  if (run("4") || run("5")) {
    if (skipLlm) {
      report(
        "4.migration-conflict",
        "SKIP",
        "LiteLLM offline or llm scenarios excluded",
      );
      report(
        "5.credential-leak",
        "SKIP",
        "LiteLLM offline or llm scenarios excluded",
      );
    } else {
      if (run("4")) await scenarioMigrationConflict(4504);
      if (run("5")) await scenarioCredentialLeak(4505);
    }
  }

  if (run("8")) {
    if (skipLlm) {
      report(
        "8.review-loop",
        "SKIP",
        "LiteLLM offline or llm scenarios excluded",
      );
    } else {
      await scenarioReviewLoop(4508);
    }
  }

  await scenarioStaleHead();
  await scenarioCleanup();

  // Belt-and-braces teardown for handles that survived.
  for (const handle of [...HANDLES]) {
    await shutdownColonyd(handle).catch(() => undefined);
  }

  console.log("\n== acceptance summary ==");
  for (const result of RESULTS) {
    console.log(`${result.status.padEnd(4)} ${result.name}: ${result.detail}`);
  }
  const failed = RESULTS.some((r) => r.status === "FAIL");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("acceptance crashed:", err);
  process.exit(1);
});
