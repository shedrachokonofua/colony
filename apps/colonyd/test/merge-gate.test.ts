import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ColonydContext } from "../src/context.js";
import type { Scope, Store, Task } from "@colony/core";
import { Store as ColonyStore } from "@colony/core";
import { FakeProviderAdapter } from "@colony/provider";
import {
  defaultGateExecutor,
  runMergeGate,
} from "../src/runs/merge-gate.js";

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

function seedRepo(): { repo: string; leakSha: string; cleanSha: string } {
  const repo = tempDir("colony-gate-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "colony-test@example.com"]);
  git(repo, ["config", "user.name", "colony-test"]);
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
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
    expect(result?.reason).toBe("secret_scan");
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
    expect(result).not.toHaveProperty("reason");
    expect(result && "files_changed" in result ? result.files_changed : []).toEqual([
      "note.txt",
    ]);
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
    } as unknown as ColonydContext;
  }

  it("records files_changed in merge_accepted evidence_json", async () => {
    // Clone URL = <gitlabBaseUrl>/<provider_repo_path>.git; mirror that
    // layout under the temp dir so the deterministic executor can clone.
    const repoParent = tempDir("colony-gate-flow-");
    const repoDir = join(repoParent, "so", "proj.git");
    mkRepoAt(repoDir);
    const headSha = git(repoDir, ["rev-parse", "clean"]).trim();

    const dbDir = tempDir("colony-gate-db-");
    const store = new ColonyStore(join(dbDir, "test.db"));
    const provider = new FakeProviderAdapter();
    const repoInfo = await provider.repos.create({ path: "so/proj" });
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
      provider_repo_id: repoInfo.id,
      provider_repo_path: repoInfo.path,
      default_branch: "main",
    });
    store.setScopeStatus(scope.id, "planning", "svc:test");
    const [task] = store.materializePlan(scope.id, {
      kind: "architect_decomposition",
      summary: "one task",
      acceptance: [{ description: "holds", command: "true" }],
      tasks: [{ title: "t", spec: "touch note.txt", depends_on: [] }],
    }, "svc:test");
    store.transitionTask(task!.id, task!.state_version, "running", "svc:test");
    const opened = store.transitionTask(task!.id, store.getTask(task!.id)!
      .state_version, "mr_open", "svc:test", { branch: "clean", mr_iid: mr.iid });

    const ctx = {
      ...(testCtx(store, repoParent) as unknown as Record<string, unknown>),
      provider,
    };
    await runMergeGate(
      ctx as unknown as ColonydContext,
      scope as Scope,
      opened as Task,
      headSha,
    );

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

  /** git needs an existing cwd even for creating the repo itself. */
  function mkRepoAt(path: string): string {
    mkdirSync(path, { recursive: true });
    git(path, ["init", "-b", "main"]);
    git(path, ["config", "user.email", "colony-test@example.com"]);
    git(path, ["config", "user.name", "colony-test"]);
    writeFileSync(join(path, "README.md"), "hello\n", "utf8");
    commitAll(path, "init");
    git(path, ["checkout", "-b", "clean"]);
    writeFileSync(join(path, "note.txt"), "harmless\n", "utf8");
    commitAll(path, "add harmless file");
    git(path, ["checkout", "main"]);
    return path;
  }
});
