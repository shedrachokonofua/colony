import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ColonydContext } from "../src/context.js";
import type { Scope, Store, Task } from "@colony/core";
import { Store as ColonyStore } from "@colony/core";
import { createLocalArtifactStore } from "@colony/core";
import { abortRunAndWait } from "../src/runs/registry.js";
import { FakeProviderAdapter } from "@colony/provider";
import { defaultGateExecutor, runMergeGate } from "../src/runs/merge-gate.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "colony-test",
      GIT_AUTHOR_EMAIL: "colony-test@example.com",
      GIT_COMMITTER_NAME: "colony-test",
      GIT_COMMITTER_EMAIL: "colony-test@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message]);
}

const PASSING_GATE_CONFIG = [
  "commands:",
  '  - "git diff --check HEAD^ HEAD"',
  "",
].join("\n");

function seedRepo(gateConfig: string | null = PASSING_GATE_CONFIG): {
  repo: string;
  leakSha: string;
  cleanSha: string;
} {
  const repo = tempDir("colony-gate-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "colony-test@example.com"]);
  git(repo, ["config", "user.name", "colony-test"]);
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
  if (gateConfig !== null) {
    writeFileSync(join(repo, "colony.gate.yaml"), gateConfig, "utf8");
  }
  commitAll(repo, "init");

  git(repo, ["checkout", "-b", "leak"]);
  writeFileSync(
    join(repo, "credentials.txt"),
    "glpat-AAAABBBBCCCCDDDDEEEEFFFF\n",
    "utf8",
  );
  commitAll(repo, "add leaked token");
  const leakSha = git(repo, ["rev-parse", "HEAD"]).trim();

  git(repo, ["checkout", "main"]);
  git(repo, ["checkout", "-b", "clean"]);
  writeFileSync(join(repo, "note.txt"), "harmless\n", "utf8");
  commitAll(repo, "add harmless file");
  const cleanSha = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "main"]);
  return { repo, leakSha, cleanSha };
}

function seedCombinedTreeRepo(command = "test ! -e target-only.txt"): {
  repo: string;
  sourceSha: string;
} {
  const repo = tempDir("colony-gate-combined-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "colony-test@example.com"]);
  git(repo, ["config", "user.name", "colony-test"]);
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
  writeFileSync(
    join(repo, "colony.gate.yaml"),
    ["commands:", `  - "${command}"`, ""].join("\n"),
    "utf8",
  );
  commitAll(repo, "init");

  git(repo, ["checkout", "-b", "source"]);
  writeFileSync(join(repo, "source-only.txt"), "source\n", "utf8");
  commitAll(repo, "source change");
  const sourceSha = git(repo, ["rev-parse", "HEAD"]).trim();

  git(repo, ["checkout", "main"]);
  writeFileSync(join(repo, "target-only.txt"), "target\n", "utf8");
  commitAll(repo, "target change");
  return { repo, sourceSha };
}

async function executeGate(
  repo: string,
  taskBranch: string,
  headSha: string,
  signal?: AbortSignal,
) {
  const workspace = tempDir("colony-gate-ws-");
  mkdirSync(workspace, { recursive: true });
  rmSync(workspace, { recursive: true, force: true });
  return defaultGateExecutor({
    workspace,
    cloneUrl: repo,
    displayUrl: repo,
    targetBranch: "main",
    taskBranch,
    headSha,
    signal,
  });
}

describe("defaultGateExecutor gate configuration", () => {
  const invalidConfigs: Array<[string, string | null]> = [
    ["missing", null],
    ["malformed YAML", "commands: ["],
    ["non-object", "[]"],
    ["empty commands", "commands: []\n"],
    ["mixed-invalid commands", 'commands:\n  - true\n  - "true"\n'],
    ["blank command", 'commands:\n  - "  "\n'],
    ["invalid timeout", 'commands:\n  - "true"\ntimeout_seconds: 0\n'],
  ];

  for (const [name, config] of invalidConfigs) {
    it(`rejects ${name} configuration`, async () => {
      const { repo, cleanSha } = seedRepo(config);
      const result = await executeGate(repo, "clean", cleanSha);
      if (!result || !("reason" in result)) {
        expect.unreachable("invalid gate configuration must fail closed");
      }
      expect(result.reason).toBe("no_gate_config");
    });
  }
  it.each([0, 7])(
    "isolates gate commands from daemon settings and cleans scratch after exit %i",
    async (exitCode) => {
      const settings = {
        COLONY_GATE_ENV_SENTINEL: "must-not-reach-checks",
        COLONY_OIDC_ISSUER: "https://must-not-reach-checks.invalid",
        GITLAB_TOKEN: "synthetic-gate-token",
        NODE_ENV: "production",
        CI: "false",
      };
      const previous = Object.fromEntries(
        Object.keys(settings).map((key) => [key, process.env[key]]),
      );
      const marker = join(tempDir("colony-gate-env-"), "home");
      const command = [
        'test -z "${COLONY_GATE_ENV_SENTINEL+x}"',
        'test -z "${COLONY_OIDC_ISSUER+x}"',
        'test -z "${GITLAB_TOKEN+x}"',
        'test -z "${NODE_ENV+x}"',
        'test "$CI" = true',
        'test "$HOME" = "$TMPDIR"',
        'test "$HOME" != "$PWD"',
        'test -w "$HOME"',
        `printf '%s' "$HOME" > ${JSON.stringify(marker)}`,
        `exit ${exitCode}`,
      ].join(" && ");
      Object.assign(process.env, settings);
      try {
        const { repo, cleanSha } = seedRepo(
          `commands:\n  - ${JSON.stringify(command)}\n`,
        );
        const result = await executeGate(repo, "clean", cleanSha);
        if (exitCode === 0) {
          expect(result).toEqual({ files_changed: ["note.txt"] });
        } else {
          expect(result).toMatchObject({
            reason: "command_failed",
            commands: [{ exit_code: exitCode }],
          });
        }
        expect(existsSync(readFileSync(marker, "utf8"))).toBe(false);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );

  it("rejects a real failing command after the prospective merge", async () => {
    const { repo, cleanSha } = seedRepo(
      ["commands:", '  - "echo out; echo err >&2; exit 7"', ""].join("\n"),
    );
    const result = await executeGate(repo, "clean", cleanSha);
    if (!result || !("reason" in result)) {
      expect.unreachable("a failing gate command must reject the merge");
    }
    expect(result.reason).toBe("command_failed");
    expect(result.commands).toEqual([
      {
        cmd: "echo out; echo err >&2; exit 7",
        exit_code: 7,
        tail: expect.arrayContaining(["err", "out"]),
      },
    ]);
  });

  it("cancels descendants even when their shell exits first", async () => {
    const processDir = tempDir("colony-gate-process-");
    const ready = join(processDir, "ready");
    const progress = join(processDir, "progress");
    const command = [
      "trap 'exit 0' TERM;",
      `(trap '' TERM; printf '%s' "$$" > ${JSON.stringify(ready)};`,
      `while :; do printf . >> ${JSON.stringify(progress)}; sleep 0.02; done)`,
      ">/dev/null 2>&1 & wait",
    ].join(" ");
    const { repo, cleanSha } = seedRepo(
      `commands:\n  - ${JSON.stringify(command)}\ntimeout_seconds: 5\n`,
    );
    const controller = new AbortController();
    const outcome = executeGate(
      repo,
      "clean",
      cleanSha,
      controller.signal,
    ).then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      const deadline = Date.now() + 4_000;
      while (!existsSync(progress) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(existsSync(progress)).toBe(true);
      controller.abort();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      const stopped = readFileSync(progress, "utf8");
      await Bun.sleep(100);
      expect(readFileSync(progress, "utf8")).toBe(stopped);
    } finally {
      controller.abort();
      if (existsSync(ready)) {
        // This PID belongs to the shell created by this test.
        try {
          process.kill(-Number(readFileSync(ready, "utf8")), "SIGKILL");
        } catch {}
      }
      await outcome;
    }
  }, 10_000);

  it("reports a timeout as command failure even when TERM exits zero", async () => {
    const { repo, cleanSha } = seedRepo(
      [
        "commands:",
        `  - "trap 'exit 0' TERM; sleep 30"`,
        "timeout_seconds: 0.1",
        "",
      ].join("\n"),
    );
    const result = await executeGate(repo, "clean", cleanSha);
    if (!result || !("reason" in result)) {
      expect.unreachable("a timed-out command must fail the gate");
    }
    expect(result.reason).toBe("command_failed");
    expect(result.commands?.[0]?.exit_code).not.toBe(0);
  });
  it("runs valid checks against the combined target and source tree", async () => {
    const { repo, sourceSha } = seedCombinedTreeRepo(
      "test -f source-only.txt && test -f target-only.txt",
    );
    const result = await executeGate(repo, "source", sourceSha);
    if (result && !("reason" in result)) {
      expect(result.files_changed).toEqual(["source-only.txt"]);
    } else {
      expect.unreachable("the combined prospective tree should pass");
    }
  });

  it("rejects when the source passes but the merged tree fails", async () => {
    const { repo, sourceSha } = seedCombinedTreeRepo();
    expect(
      git(repo, ["ls-tree", "-r", "--name-only", sourceSha]).split("\n"),
    ).not.toContain("target-only.txt");
    const result = await executeGate(repo, "source", sourceSha);
    if (!result || !("reason" in result)) {
      expect.unreachable("the merged tree must fail its gate");
    }
    expect(result.reason).toBe("command_failed");
  });
});

describe("defaultGateExecutor secret scan", () => {
  it("rejects an incoming glpat token before merge", async () => {
    const { repo, leakSha } = seedRepo();
    const workspace = tempDir("colony-gate-ws-");
    mkdirSync(workspace, { recursive: true });
    rmSync(workspace, { recursive: true, force: true });
    const result = await defaultGateExecutor({
      workspace,
      cloneUrl: repo,
      displayUrl: repo,
      targetBranch: "main",
      taskBranch: "leak",
      headSha: leakSha,
    });
    if (result && "reason" in result) {
      expect(result.reason).toBe("secret_scan");
    } else {
      expect.unreachable("leaked token must fail the gate");
    }
  });

  it("reports the incoming diff's files on success", async () => {
    const { repo, cleanSha } = seedRepo();
    const workspace = tempDir("colony-gate-ws-");
    mkdirSync(workspace, { recursive: true });
    rmSync(workspace, { recursive: true, force: true });
    const result = await defaultGateExecutor({
      workspace,
      cloneUrl: repo,
      displayUrl: repo,
      targetBranch: "main",
      taskBranch: "clean",
      headSha: cleanSha,
    });
    // Success payload carries the pre-merge diff (target...head); after the
    // prospective merge the same three-dot diff is empty, so this cannot be
    // recomputed later by the caller.
    if (result && !("reason" in result)) {
      expect(result.files_changed).toEqual(["note.txt"]);
    } else {
      expect.unreachable("gate should have succeeded");
    }
  });
});

/**
 * Full gate flow over a local file:// repo: a passing gate must record the
 * changed-file list in the run's merge_accepted evidence_json — the fact the
 * offline task-cost heuristic joins against implement wall-clock.
 */
describe("runMergeGate success evidence", () => {
  function testCtx(store: Store, repoParent: string): ColonydContext {
    return {
      store,
      provider: new FakeProviderAdapter(),
      config: { reviewMode: "required", hitlMode: "yolo" },
      agents: {},
      artifacts: createLocalArtifactStore(
        mkdtempSync(join(tmpdir(), "colonyd-artifacts-")),
      ),
      logger: { info() {}, warn() {}, error() {} },
      gateExecutor: undefined, // real deterministic executor over file:// clone
      env: {
        gitlabBaseUrl: `file://${repoParent}`,
        gitlabToken: "",
        webhookSecret: "",
        singleToken: true,
        maxConcurrent: 1,
        maxAttempts: 3,
        oidcIssuer: "",
        oidcClientId: "colony",
        oidcRequiredRole: "",
        traceUiBaseUrl: "",
      },
      requestTick() {},
      draining: { isDraining: () => false },
    } as unknown as ColonydContext;
  }

  async function setupFlow(gateConfig: string | null = PASSING_GATE_CONFIG) {
    // Clone URL = <gitlabBaseUrl>/<provider_repo_path>.git; mirror that
    // layout under the temp dir so the deterministic executor can clone.
    const repoParent = tempDir("colony-gate-flow-");
    const repoDir = join(repoParent, "so", "proj.git");
    mkRepoAt(repoDir, gateConfig);
    const headSha = git(repoDir, ["rev-parse", "clean"]).trim();

    const dbDir = tempDir("colony-gate-db-");
    const store = new ColonyStore(join(dbDir, "test.db"));
    const provider = new FakeProviderAdapter();
    const repoInfo = await provider.repos.create({
      name: "proj",
      path: "so/proj",
    });
    const repoRef = { id: repoInfo.id, path: repoInfo.path };
    await provider.branches.create(repoRef, "clean", headSha);
    const mr = await provider.mergeRequests.open(repoRef, {
      title: "task",
      description: "",
      source_branch: "clean",
      target_branch: "main",
    });

    const scope = store.createScope({
      goal: "gate evidence",
      title: "gate evidence",
      provider_repo_id: repoInfo.id,
      provider_repo_path: repoInfo.path,
      default_branch: "main",
    });
    store.setScopeStatus(scope.id, "planning", "svc:test");
    const [task] = store.materializePlan(
      scope.id,
      {
        kind: "architect_decomposition",
        summary: "one task",
        requirements: [{ id: "R1", text: "holds", tasks: [0] }],
        journey: [{ after_task: 0, working_state: "holds" }],
        acceptance: [{ description: "holds", command: "true" }],
        tasks: [
          {
            title: "t",
            spec: "touch note.txt",
            depends_on: [],
            files: ["note.txt"],
            evidence: ["true"],
          },
        ],
      },
      "svc:test",
    );
    store.transitionTask(task!.id, task!.state_version, "running", "svc:test");
    const opened = store.transitionTask(
      task!.id,
      store.getTask(task!.id)!.state_version,
      "mr_open",
      "svc:test",
      { branch: "clean", mr_iid: mr.iid },
    );
    const ctx = {
      ...(testCtx(store, repoParent) as unknown as Record<string, unknown>),
      provider,
    } as unknown as ColonydContext;
    return { ctx, scope, task, opened, headSha, store };
  }

  it("records files_changed in merge_accepted evidence_json", async () => {
    const { ctx, scope, task, opened, headSha, store } = await setupFlow();
    await runMergeGate(ctx, scope as Scope, opened as Task, headSha);

    const gateRuns = store
      .runsForTask(task!.id)
      .filter((r) => r.kind === "merge_gate");
    expect(gateRuns).toHaveLength(1);
    expect(gateRuns[0]!.status).toBe("succeeded");
    expect(JSON.parse(gateRuns[0]!.evidence_json!)).toEqual({
      reason: "merge_accepted",
      head_sha: headSha,
      files_changed: ["note.txt"],
    });
    store.close();
  });

  it("blocks invalid configuration without an implement retry", async () => {
    const { ctx, scope, task, opened, headSha, store } = await setupFlow(null);
    await runMergeGate(ctx, scope as Scope, opened as Task, headSha);

    const current = store.getTask(task!.id)!;
    const gate = store
      .runsForTask(task!.id)
      .find((run) => run.kind === "merge_gate")!;
    expect(current.state).toBe("blocked");
    expect(current.attempt).toBe(0);
    expect(JSON.parse(gate.evidence_json!)).toMatchObject({
      reason: "no_gate_config",
    });
    store.close();
  });

  it("records cancellation without requeueing the task", async () => {
    const { ctx, scope, task, opened, headSha, store } = await setupFlow();
    const { promise: started, resolve: markStarted } =
      Promise.withResolvers<void>();
    const mutableContext = ctx as unknown as { gateExecutor: unknown };
    mutableContext.gateExecutor = async ({
      signal,
    }: {
      signal?: AbortSignal;
    }) => {
      markStarted();
      const { promise, resolve } = Promise.withResolvers<null>();
      signal?.addEventListener("abort", () => resolve(null), { once: true });
      return promise;
    };
    const pending = runMergeGate(ctx, scope as Scope, opened as Task, headSha);
    await started;
    const run = store
      .runsForTask(task!.id)
      .find((candidate) => candidate.kind === "merge_gate")!;
    expect(await abortRunAndWait(run.id)).toBe(true);
    await pending;

    const current = store.getTask(task!.id)!;
    expect(current.state).toBe("mr_open");
    expect(current.attempt).toBe(0);
    expect(store.getRun(run.id)!.status).toBe("canceled");
    store.close();
  });
  /** git needs an existing cwd even for creating the repo itself. */
  function mkRepoAt(
    path: string,
    gateConfig: string | null = PASSING_GATE_CONFIG,
  ): string {
    mkdirSync(path, { recursive: true });
    git(path, ["init", "-b", "main"]);
    git(path, ["config", "user.email", "colony-test@example.com"]);
    git(path, ["config", "user.name", "colony-test"]);
    writeFileSync(join(path, "README.md"), "hello\n", "utf8");
    if (gateConfig !== null) {
      writeFileSync(join(path, "colony.gate.yaml"), gateConfig, "utf8");
    }
    commitAll(path, "init");
    git(path, ["checkout", "-b", "clean"]);
    writeFileSync(join(path, "note.txt"), "harmless\n", "utf8");
    commitAll(path, "add harmless file");
    git(path, ["checkout", "main"]);
    return path;
  }
});
