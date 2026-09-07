import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readSessionHeader } from "@colony/agent-runtime/session-store";
import { Store, type Run } from "@colony/core";
import { FakeProviderAdapter } from "@colony/provider";
import type { ExecEvent, ExecResult, SandboxHandle } from "@colony/sandbox";
import { classifyRuns, adoptOrExpireRuns } from "../src/runs/adoption.js";
import type { AdoptionDeps } from "../src/runs/adoption.js";
import { consoleLogger } from "../src/logging.js";
import {
  abortRunAndWait,
  awaitPendingRuns,
  detachRun,
} from "../src/runs/registry.js";

const logger = consoleLogger("adoption-test");

let dir: string;
let sessionsDir: string;
let store: Store;
let provider: FakeProviderAdapter;
let scopeId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adoption-test-"));
  sessionsDir = join(dir, "sessions-root");
  store = new Store(join(dir, "test.db"));
  provider = new FakeProviderAdapter();
  const scope = store.createScope({
    goal: "adoption unit",
    title: "adoption unit",
    provider_repo_id: "repo-1",
    provider_repo_path: "so/adoption",
  });
  scopeId = scope.id;
});

afterEach(async () => {
  await awaitPendingRuns();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A run that passes every gate by default. */
function seedRun(
  overrides: {
    id?: string;
    kind?: Run["kind"];
    lease_ttl_ms?: number;
    withSession?: boolean;
    withSandbox?: boolean;
    parseableSession?: boolean;
  } = {},
): Run {
  const id = overrides.id ?? crypto.randomUUID();
  store.startRun({
    id,
    scope_id: scopeId,
    kind: overrides.kind ?? "implement",
    lease_ttl_ms: overrides.lease_ttl_ms ?? 30 * 60_000,
  });
  if (overrides.withSession ?? true) {
    const runDir = join(sessionsDir, "sessions", id);
    mkdirSync(runDir, { recursive: true });
    const header =
      (overrides.parseableSession ?? true)
        ? '{"title":"adoption-test"}\n'
        : "not-json-at-all\n";
    writeFileSync(join(runDir, "session.jsonl"), header, "utf8");
  }
  if (overrides.withSandbox ?? true) {
    store.setRunSandboxId(id, `sandbox-${id}`);
  }
  return store.getRun(id)!;
}

function expireLease(runId: string): void {
  store.db
    .prepare(`UPDATE runs SET lease_expires_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 1_000).toISOString(), runId);
}

type ProbeMode = "ok" | "hang" | "reject" | "nonzero";

function fakeConnect(mode: ProbeMode): AdoptionDeps["connect"] {
  return async (sandboxId: string): Promise<SandboxHandle> => {
    if (mode === "reject") throw new Error(`sandbox ${sandboxId} gone`);
    return {
      sandboxId,
      async exec(
        _request,
        _onEvent: (event: ExecEvent) => void,
      ): Promise<ExecResult> {
        if (mode === "hang") {
          return new Promise<ExecResult>(() => {});
        }
        return mode === "nonzero"
          ? { exitCode: 1, timedOut: false }
          : { exitCode: 0, timedOut: false };
      },
      readFile: () => Promise.reject(new Error("unused")),
      writeFile: () => Promise.reject(new Error("unused")),
      destroy: () => Promise.resolve(),
    };
  };
}

function deps(
  mode: ProbeMode = "ok",
  probeTimeoutMs?: number,
): AdoptionDeps & {
  cancel: (run: Run) => Promise<void>;
} {
  return {
    store,
    provider,
    logger,
    sessionsDir,
    connect: fakeConnect(mode),
    cancel: async () => {},
    ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }),
  };
}

function mintInto(repo: { id: string; path: string }, name: string) {
  return provider.accessTokens.mint(repo, {
    name,
    scopes: ["api"],
    access_level: 30,
    expires_at: "2099-01-01",
  });
}

describe("classifyRuns gates", () => {
  it("an expired lease is non-adoptable", async () => {
    const run = seedRun();
    expireLease(run.id);
    const result = await classifyRuns(deps(), [store.getRun(run.id)!]);
    expect(result.adoptable).toEqual([]);
    expect(result.orphans.map((r) => r.id)).toEqual([run.id]);
  });

  it("a merge_gate run is non-adoptable", async () => {
    const run = seedRun({ kind: "merge_gate" });
    const result = await classifyRuns(deps(), [run]);
    expect(result.adoptable).toEqual([]);
    expect(result.orphans).toHaveLength(1);
  });

  it("a validate run is non-adoptable", async () => {
    const run = seedRun({ kind: "validate" });
    const result = await classifyRuns(deps(), [run]);
    expect(result.adoptable).toEqual([]);
    expect(result.orphans).toHaveLength(1);
  });

  it("a missing session file is non-adoptable", async () => {
    const run = seedRun({ withSession: false });
    const result = await classifyRuns(deps(), [run]);
    expect(result.adoptable).toEqual([]);
    expect(result.orphans).toHaveLength(1);
  });

  it("an unparseable session file is non-adoptable", async () => {
    const run = seedRun({ parseableSession: false });
    expect(readSessionHeader(sessionsDir, run.id).ok).toBe(false);
    const result = await classifyRuns(deps(), [run]);
    expect(result.adoptable).toEqual([]);
    expect(result.orphans).toHaveLength(1);
  });

  it("a null sandbox_id is non-adoptable", async () => {
    const run = seedRun({ withSandbox: false });
    const result = await classifyRuns(deps(), [run]);
    expect(result.adoptable).toEqual([]);
    expect(result.orphans).toHaveLength(1);
  });

  it("a sandbox probe that never answers inside the timeout is non-adoptable", async () => {
    const run = seedRun();
    const result = await classifyRuns(deps("hang", 50), [run]);
    expect(result.adoptable).toEqual([]);
    expect(result.orphans).toHaveLength(1);
  });

  it("a rejected connect is non-adoptable", async () => {
    const run = seedRun();
    const result = await classifyRuns(deps("reject"), [run]);
    expect(result.adoptable).toEqual([]);
    expect(result.orphans).toHaveLength(1);
  });

  it("all gates passing yields the run adoptable", async () => {
    const run = seedRun();
    const result = await classifyRuns(deps(), [run]);
    expect(result.adoptable.map((r) => r.id)).toEqual([run.id]);
    expect(result.orphans).toEqual([]);
  });
});

describe("adoptOrExpireRuns", () => {
  it("admits without waiting for resumed work", async () => {
    const run = seedRun();
    const completion = Promise.withResolvers<void>();
    const admission = adoptOrExpireRuns({
      ...deps(),
      resume: async () => {
        await completion.promise;
        store.finishRun(run.id, "succeeded");
      },
      resumeLeaseTtlMs: 60_000,
    });
    let admittedBeforeCompletion = false;
    try {
      admittedBeforeCompletion = await Promise.race([
        admission.then(() => true),
        Bun.sleep(250).then(() => false),
      ]);
    } finally {
      completion.resolve();
      await admission;
      await awaitPendingRuns();
    }
    expect(admittedBeforeCompletion).toBe(true);
    expect(store.getRun(run.id)?.status).toBe("succeeded");
  });

  it("cancels adopted execution and revokes its credential", async () => {
    const run = seedRun();
    const minted = await mintInto({ id: "repo-1", path: "so/adoption" }, "x");
    store.setRunToken(run.id, minted.id);
    const completion = Promise.withResolvers<void>();
    await adoptOrExpireRuns({
      ...deps(),
      resume: async () => completion.promise,
      cancel: async () => completion.resolve(),
      resumeLeaseTtlMs: 60_000,
    });
    try {
      expect(await abortRunAndWait(run.id)).toBe(true);
      expect(store.getRun(run.id)?.status).toBe("canceled");
      expect(
        provider.listAccessTokens().some((token) => token.id === minted.id),
      ).toBe(false);
    } finally {
      completion.resolve();
      await awaitPendingRuns();
    }
  });

  it("hands off without waiting or mutating the lease and credential", async () => {
    const run = seedRun();
    const minted = await mintInto({ id: "repo-1", path: "so/adoption" }, "x");
    store.setRunToken(run.id, minted.id);
    const started = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    await adoptOrExpireRuns({
      ...deps(),
      resume: async (_run, signal) => {
        started.resolve();
        try {
          await completion.promise;
          signal.throwIfAborted();
        } finally {
          returned.resolve();
        }
      },
      resumeLeaseTtlMs: 30,
    });
    await started.promise;
    store.heartbeatRun(run.id, 60_000);
    const handoffLease = store.getRun(run.id)?.lease_expires_at;
    try {
      expect(detachRun(run.id)).toBe(true);
      const drained = await Promise.race([
        awaitPendingRuns().then(() => true),
        Bun.sleep(250).then(() => false),
      ]);
      expect(drained).toBe(true);
      await Bun.sleep(50);
      expect(store.getRun(run.id)?.lease_expires_at).toBe(handoffLease);
    } finally {
      completion.resolve();
      await returned.promise;
      await Bun.sleep(0);
    }
    expect(store.getRun(run.id)?.status).toBe("running");
    expect(store.getRun(run.id)?.error).toBeNull();
    expect(
      provider.listAccessTokens().some((token) => token.id === minted.id),
    ).toBe(true);
  });

  it("crash-reaped runs carry the colonyd crash_reaped fault", async () => {
    const run = seedRun({ kind: "validate" });
    await adoptOrExpireRuns({
      ...deps("ok", 200),
      resume: async () => {
        throw new Error("must not resume an orphan");
      },
      resumeLeaseTtlMs: 60_000,
    });

    const after = store.getRun(run.id)!;
    expect(after.error).toBe("crash_reaped");
    expect(JSON.parse(after.fault_json!)).toMatchObject({
      layer: "colonyd",
      code: "crash_reaped",
    });
  });

  it("a broken resume carries process_restart, not crash_reaped", async () => {
    // Both are colonyd faults and both requeue free; only the reap that
    // never got to run is 'reaped', while a resume that threw is a
    // 'restart'. Conflating them would hide which recovery path fired.
    const run = seedRun();
    await adoptOrExpireRuns({
      ...deps(),
      resume: async () => {
        throw new Error("resume exploded");
      },
      resumeLeaseTtlMs: 60_000,
    });
    await awaitPendingRuns();

    const after = store.getRun(run.id)!;
    expect(after.error).toBe("process_restart");
    expect(JSON.parse(after.fault_json!)).toMatchObject({
      layer: "colonyd",
      code: "process_restart",
    });
  });

  it("orphans take today's fail+revoke path", async () => {
    const run = seedRun({ kind: "validate" });
    const minted = await mintInto({ id: "repo-1", path: "so/adoption" }, "x");
    store.setRunToken(run.id, minted.id);

    const resumeCalls: string[] = [];
    await adoptOrExpireRuns({
      ...deps("ok", 200),
      resume: async () => {
        resumeCalls.push(run.id);
      },
      resumeLeaseTtlMs: 60_000,
    });

    expect(resumeCalls).toEqual([]);
    const after = store.getRun(run.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("crash_reaped");
    expect(
      provider.listAccessTokens().some((token) => token.id === minted.id),
    ).toBe(false);
  });

  it("an adoptable run is claimed BEFORE resume runs, and the resume sees adopted = 1", async () => {
    const run = seedRun();
    let adoptedAtResume: 0 | 1 | undefined;
    const resumeCalls: string[] = [];
    const result = await adoptOrExpireRuns({
      ...deps(),
      resume: async (resumed) => {
        adoptedAtResume = store.getRun(resumed.id)!.adopted;
        resumeCalls.push(resumed.id);
      },
      resumeLeaseTtlMs: 60_000,
    });
    await awaitPendingRuns();
    expect(result.adoptable.map((r) => r.id)).toEqual([run.id]);
    expect(resumeCalls).toEqual([run.id]);
    expect(adoptedAtResume).toBe(1);
    expect(store.getRun(run.id)!.adopted).toBe(1);
  });

  it("a second pass over the same run is refused by the claim and does not resume again", async () => {
    const run = seedRun();
    const resumeCalls: string[] = [];
    const call = () =>
      adoptOrExpireRuns({
        ...deps(),
        resume: async (resumed) => {
          resumeCalls.push(resumed.id);
        },
        resumeLeaseTtlMs: 60_000,
      });
    await call();
    await call();
    await awaitPendingRuns();
    expect(resumeCalls).toEqual([run.id]);
    expect(store.getRun(run.id)!.status).toBe("running");
  });

  it("a shutdown-style heartbeat leaves adopted = 0 so a later pass still resumes", async () => {
    const run = seedRun();
    store.heartbeatRun(run.id, 600_000);
    expect(store.getRun(run.id)!.adopted).toBe(0);

    const resumeCalls: string[] = [];
    await adoptOrExpireRuns({
      ...deps(),
      resume: async (resumed) => {
        resumeCalls.push(resumed.id);
      },
      resumeLeaseTtlMs: 60_000,
    });
    await awaitPendingRuns();
    expect(resumeCalls).toEqual([run.id]);
  });

  it("a resume that throws falls back to fail + revoke + run.restart_failed audit", async () => {
    const run = seedRun();
    const minted = await mintInto({ id: "repo-1", path: "so/adoption" }, "x");
    store.setRunToken(run.id, minted.id);

    await adoptOrExpireRuns({
      ...deps(),
      resume: async () => {
        throw new Error("resume exploded");
      },
      resumeLeaseTtlMs: 60_000,
    });
    await awaitPendingRuns();

    const after = store.getRun(run.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("process_restart");
    const events = store.listRunEventsByName(run.id, "run_resume_failed");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detail_json).error).toBe("resume exploded");
    const audits = store
      .listAudit({ run_id: run.id, limit: 100 })
      .events.map((row) => row.action);
    expect(audits).toContain("run.restart_failed");
    expect(
      provider.listAccessTokens().some((token) => token.id === minted.id),
    ).toBe(false);
  });
});
