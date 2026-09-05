import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetEnvCache } from "@colony/config";
import {
  FakeAgentRuntimeAdapter,
  type AgentRuntimePacket,
  type AgentRunResumeEnvironment,
} from "@colony/agent-runtime";
import { Store } from "@colony/core";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import { FakeProviderAdapter } from "@colony/provider";
import { boot, type ColonydHandle } from "../src/main.js";
import { adoptOrExpireRuns, type AdoptionResult } from "../src/runs/adoption.js";
import { trackRun } from "../src/runs/registry.js";
import { createDrainController } from "../src/drain.js";
import { readSessionHeader } from "@colony/agent-runtime/session-store";

/**
 * Restart-resume integration: an in-process engine sandbox survives a
 * "restart" (fresh Store + fresh runtime objects, same process), and boot
 * adoption continues the run against the SAME handle.
 */

let root: string;
let provider: FakeProviderAdapter;
let repoId: string;
const handles: ColonydHandle[] = [];

/** Scripted continuation envelope the fake adapter returns on resume. */
let resumeCalls: { runId: string; sandboxId: string }[] = [];

function fakeAdapter(): FakeAgentRuntimeAdapter {
  return new FakeAgentRuntimeAdapter({
    envelopeForResume: (packet, environment: AgentRunResumeEnvironment) => {
      resumeCalls.push({
        runId: environment.runId ?? "?",
        sandboxId: environment.sandboxId,
      });
      return {
        kind: "implementer_completion",
        status: "complete",
        summary: "Resumed and completed.",
        branch: String(packet.branch ?? `colony/${String(packet.task_id)}`),
        head_sha: "c".repeat(40),
        commands: [{ cmd: "npm test", exit_code: 0 }],
      };
    },
  });
}

function createBranch(sha: string): void {
  void provider.branches.create({ id: repoId }, "colony/resume-task", sha);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "restart-resume-"));
  provider = new FakeProviderAdapter();
  const created = await provider.repos.create({
    namespace: "so",
    path: "resume-e2e",
  });
  repoId = created.id;
});

afterAll(async () => {
  await Promise.all(handles.map((h) => h.shutdown().catch(() => undefined)));
  rmSync(root, { recursive: true, force: true });
});

interface World {
  dbPath: string;
  sessionsDir: string;
  workspace: string;
  configPath: string;
}

let world: World;
let dbPath: string;
let sessionsDir: string;
let configPath: string;

beforeEach(() => {
  dbPath = join(root, `case-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  sessionsDir = join(root, `sessions-${Date.now()}`);
  mkdirSync(sessionsDir, { recursive: true });
  configPath = join(root, `colony-${Date.now()}.yaml`);
  writeFileSync(
    configPath,
    [
      "agent_runtime: fake",
      "allow_literal_keys: true",
      "hitl:",
      "  mode: yolo",
      `sessions_dir: ${sessionsDir}`,
      "providers:",
      "  fake_llm:",
      "    api: openai-completions",
      "    base_url: http://localhost:9/v1",
      "    auth:",
      "      kind: api_key",
      "      value: fake-key",
      "    models:",
      "      - id: fake-model",
      "        name: fake-model",
      "agents:",
      "  architect:",
      "    provider: fake_llm",
      "    model: fake-model",
      "  developer:",
      "    provider: fake_llm",
      "    model: fake-model",
    ].join("\n"),
    "utf8",
  );
});

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    await handle?.shutdown().catch(() => undefined);
  }
  resumeCalls = [];
});

async function bootHeadless(
  db: string,
  drainTimeoutMs = "600000",
): Promise<ColonydHandle> {
  process.env["NODE_ENV"] = "test";
  process.env["AGENT_RUNTIME"] = "fake";
  process.env["GITLAB_TOKEN"] = "";
  process.env["GITLAB_WEBHOOK_SECRET"] = "";
  process.env["COLONYD_DB_PATH"] = db;
  process.env["COLONY_CONFIG_PATH"] = configPath;
  process.env["COLONY_DRAIN_TIMEOUT_MS"] = drainTimeoutMs;
  resetEnvCache();
  const scripted = fakeAdapter();
  const handle = await boot({
    provider,
    headless: true,
    agents: {
      runtime: "fake",
      architect: scripted,
      developer: scripted,
      reviewer: scripted,
      planReviewer: scripted,
    },
  });
  handles.push(handle);
  return handle;
}

/**
 * Seed a scope + task, dispatch an implement run that parks mid-flight:
 * a real in-process sandbox, a written session journal, sandbox_id on the
 * row, and a marker file inside the sandbox workspace. The scripted
 * adapter's startRun resolves immediately, so this drives runImplement to
 * completion for the FIRST segment; the "crash" is simulated by dropping
 * every runtime object afterwards — the run row is manually rewound to
 * `running` exactly as a SIGKILL mid-run would have left it.
 */
async function seedMidFlightRun(
  drainTimeoutMs = "600000",
): Promise<{
  handle: ColonydHandle;
  runId: string;
  taskId: string;
  scopeId: string;
  sandboxId: string;
  markerPath: string;
}> {
  const handle = await bootHeadless(dbPath, drainTimeoutMs);
  const store = handle.ctx.store;
  const scope = store.createScope({
    goal: "restart resume proof",
    title: "restart resume proof",
    provider_repo_id: repoId,
    provider_repo_path: "so/resume-e2e",
  });
  // Create the task directly through the store's task insert (the same
  // insert materializePlan uses): a scope cannot reach `active` without a
  // full plan round-trip, and the seed only needs one queued implement task.
  store.db
    .prepare(
      `INSERT INTO tasks (id, scope_id, title, spec, state, cost_prediction_json)
       VALUES (?, ?, ?, ?, 'running', NULL)`,
    )
    .run(`${scope.id}.1`, scope.id, "resume-task", "Prove resume.");
  const task = store.getTask(`${scope.id}.1`)!;

  createBranch("b".repeat(40));

  const runId = crypto.randomUUID();
  store.startRun({
    id: runId,
    scope_id: scope.id,
    task_id: task.id,
    kind: "implement",
    lease_ttl_ms: 30 * 60_000,
    model_id: "fake-model",
  });

  // The workspace the sandbox is rooted at: a plain directory (the fake
  // runtime never clones) whose marker the second segment must still read.
  const workspace = join(root, `ws-${runId}`);
  mkdirSync(workspace, { recursive: true });

  const engine = createInProcessEngine();
  const handle2 = await engine.provision(
    {
      runtimeClass: "gvisor",
      envAllowlist: ["PATH"],
      podLabels: {},
    },
    workspace,
  );
  const sandboxId = handle2.sandboxId;
  await handle2.writeFile("marker.txt", "written-before-restart");
  store.setRunSandboxId(runId, sandboxId);

  // The first segment's session journal: one parseable header line.
  const runSessionDir = join(sessionsDir, "sessions", runId);
  mkdirSync(runSessionDir, { recursive: true });
  writeFileSync(
    join(runSessionDir, "session.jsonl"),
    '{"title":"resume-task"}\n{"role":"user"}\n',
    "utf8",
  );

  return {
    handle,
    runId,
    taskId: task.id,
    scopeId: scope.id,
    sandboxId,
    markerPath: "marker.txt",
  };
}

/** Fresh Store on the SAME db file + boot adoption against the SAME sessionsDir. */
async function adoptAfterRestart(
  runId: string,
  resumeImpl?: (run: { id: string }) => Promise<void>,
): Promise<AdoptionResult> {
  const store = new Store(dbPath);
  try {
    return await adoptOrExpireRuns({
      store,
      provider,
      logger: console.error as never,
      sessionsDir,
      connect: (id) => createInProcessEngine().connect(id),
      resume:
        resumeImpl ??
        (async () => {
          throw new Error("resume must be provided");
        }),
      resumeLeaseTtlMs: 60_000,
    });
  } finally {
    store.close();
  }
}

describe("restart resume integration", () => {
  it(
    "case 1: crash restart adopts the run and resumes against the SAME sandbox",
    async () => {
      const seeded = await seedMidFlightRun();
      const { runId, taskId, sandboxId, markerPath } = seeded;
      await seeded.handle.shutdown();

      // --- the "crash": every runtime object dropped, run row left running.
      // The restarted process's BOOT adoption (main.ts) does the rest.
      expect(readSessionHeader(sessionsDir, runId).ok).toBe(true);
      const preRestart = new Store(dbPath);
      expect(preRestart.getRun(runId)!.status).toBe("running");
      expect(preRestart.getRun(runId)!.sandbox_id).toBe(sandboxId);
      preRestart.close();

      const resumed = await bootHeadless(dbPath);
      const store = resumed.ctx.store;

      // Boot claimed and resumed the run against the SAME sandbox.
      expect(resumeCalls).toEqual([{ runId, sandboxId }]);

      const run = store.getRun(runId)!;
      expect(run.status).toBe("succeeded");
      expect(run.adopted).toBe(1);
      expect(run.envelope_json).toContain("implementer_completion");

      const events = store.listRunEventsByName(runId, "run_resumed");
      expect(events).toHaveLength(1);
      const detail = JSON.parse(events[0]!.detail_json) as Record<string, unknown>;
      expect(detail.sandbox_id).toBe(sandboxId);
      expect(detail.entries_loaded).toBe(2);

      const adoptedAudit = store
        .listAudit({ run_id: runId, limit: 100 })
        .events.some((row) => row.action === "run.adopted");
      expect(adoptedAudit).toBe(true);

      // The marker written by the first segment is still readable through a
      // fresh connect: the SAME live sandbox instance.
      const again = await createInProcessEngine().connect(sandboxId);
      const marker = await again.readFile(markerPath);
      expect(marker.toString("utf8")).toBe("written-before-restart");

      // A second adoption attempt of the same run is refused.
      const second = await adoptOrExpireRuns({
        store,
        provider,
        logger: console.error as never,
        sessionsDir,
        connect: (id) => createInProcessEngine().connect(id),
        resume: async () => {
          throw new Error("must not resume twice");
        },
        resumeLeaseTtlMs: 60_000,
      });
      expect(second.adoptable).toEqual([]);
      await resumed.shutdown();
    },
    60_000,
  );

  it(
    "case 2: a missing session journal degrades to fail + revoke + requeue",
    async () => {
      const seeded = await seedMidFlightRun();
      const { runId, taskId } = seeded;
      await seeded.handle.shutdown();

      rmSync(join(sessionsDir, "sessions", runId, "session.jsonl"));

      const minted = await provider.accessTokens.mint(
        { id: repoId, path: "so/resume-e2e" },
        { name: `colony-task-${taskId}`, scopes: ["api"], access_level: 30, expires_at: "2099-01-01" },
      );

      const store = new Store(dbPath);
      const result = await adoptOrExpireRuns({
        store,
        provider,
        logger: console.error as never,
        sessionsDir,
        connect: (id) => createInProcessEngine().connect(id),
        resume: async () => {
          throw new Error("must not resume");
        },
        resumeLeaseTtlMs: 60_000,
      });

      expect(result.orphans.map((r) => r.id)).toEqual([runId]);
      const run = store.getRun(runId)!;
      expect(run.status).toBe("failed");
      expect(run.error).toBe("process_restart");
      expect(
        provider.listAccessTokens().some((token) => token.id === minted.id),
      ).toBe(false);
      // Requeue is the tick's job: the task is out of `running` because the
      // run failed (the tick reconciler sees no active run and requeues).
      expect(resumeCalls).toEqual([]);
      store.close();
    },
    60_000,
  );

  it(
    "case 3: drain-cap shutdown heartbeats (never adopts), and the next boot resumes",
    async () => {
      // The seed handle is booted with the drain cap at 0; its boot adoption
      // is a no-op because the run row is seeded AFTER boot — exactly the
      // shape of a first process that started a run and then hits the cap.
      const seeded = await seedMidFlightRun("0");
      const { runId, sandboxId } = seeded;

      // A live in-flight run for the drain to find: the registry entry
      // parks on an unresolved promise, so abortAll sees it at the cap.
      let release!: () => void;
      const parked = new Promise<void>((resolve) => {
        release = resolve;
      });
      trackRun(runId, parked, () => release());

      // Shutdown at the cap: drain.wait() returns "aborted" with the run
      // still alive. main.ts's partition fires inside drainDeps.abortAll.
      await seeded.handle.shutdown();
      release();

      const store = new Store(dbPath);
      const after = store.getRun(runId)!;
      // NOT aborted, NOT finishRun'ed, lease pushed out by the resume TTL,
      // adopted still 0: the next boot's claim must be the winner.
      expect(after.status).toBe("running");
      expect(after.adopted).toBe(0);
      expect(after.error).toBeNull();
      const afterLease = Date.parse(after.lease_expires_at);
      expect(afterLease).toBeGreaterThan(Date.now() + 900_000 - 5_000);
      const finished = store
        .listAudit({ run_id: runId, limit: 100 })
        .events.filter((row) => row.action === "run.finished");
      expect(finished).toEqual([]);
      const tokenRevoked = store
        .listAudit({ run_id: runId, limit: 100 })
        .events.some((row) => row.action === "agent_token.revoked");
      expect(tokenRevoked).toBe(false);
      store.close();

      // --- next boot: the claim wins, resume runs against the SAME sandbox.
      // (The run row was still `running` with adopted = 0 and a live lease,
      // so the boot-time adoptRun claim is the winner.)
      const resumed = await bootHeadless(dbPath);
      const fresh = resumed.ctx.store;
      expect(resumeCalls).toEqual([{ runId, sandboxId }]);
      const run = fresh.getRun(runId)!;
      expect(run.status).toBe("succeeded");
      expect(run.adopted).toBe(1);
      expect(
        fresh
          .listAudit({ run_id: runId, limit: 100 })
          .events.some((row) => row.action === "run.adopted"),
      ).toBe(true);
      await resumed.shutdown();
    },
    60_000,
  );

  it(
    "safety net: an adopted run whose lease lapses is failed by expireDeadLeases",
    async () => {
      const seeded = await seedMidFlightRun();
      const { runId } = seeded;
      const store = new Store(dbPath);
      // Adopt (claim) then age the lease past expiry.
      expect(store.adoptRun(runId, 60_000)).toBe(true);
      store.db
        .prepare(`UPDATE runs SET lease_expires_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - 5_000).toISOString(), runId);

      const expired = store.expireDeadLeases(new Date());
      expect(expired.map((r) => r.id)).toEqual([runId]);
      const run = store.getRun(runId)!;
      expect(run.status).toBe("failed");
      expect(run.error).toBe("lease_expired");
      store.close();
    },
    60_000,
  );
});
