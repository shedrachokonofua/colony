import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Store, type Run, type RunEvent } from "@colony/core";
import {
  collectRunModelIds,
  formatColonyModelsTrailer,
  formatModelList,
  parseColonyModelsTrailer,
  buildMergeProvenanceLine,
  appendTrailer,
  amendBranchWithTrailer,
} from "../src/runs/model-provenance.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

let store: Store;

beforeEach(() => {
  store = new Store(join(tempDir("colony-prov-"), "test.db"));
});

afterEach(() => {
  store.close();
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

describe("formatModelList", () => {
  it("sorts and deduplicates a list of model ids", () => {
    expect(formatModelList(["m2", "m1", "m2"])).toBe("m1, m2");
  });

  it("filters empty strings", () => {
    expect(formatModelList(["", "m1", ""])).toBe("m1");
  });

  it("returns empty string for no ids", () => {
    expect(formatModelList([])).toBe("");
    expect(formatModelList([""])).toBe("");
  });
});

describe("formatColonyModelsTrailer", () => {
  it("produces the canonical trailer for one model", () => {
    expect(formatColonyModelsTrailer(["model-a"])).toBe(
      "Colony-Models: model-a",
    );
  });

  it("produces the canonical trailer for multiple models", () => {
    expect(formatColonyModelsTrailer(["model-a", "model-b"])).toBe(
      "Colony-Models: model-a, model-b",
    );
  });

  it("returns empty for no models", () => {
    expect(formatColonyModelsTrailer([])).toBe("");
  });
});

describe("parseColonyModelsTrailer", () => {
  it("extracts model ids from a trailer line", () => {
    const msg = `feat: add the endpoint

Colony-Models: model-a, model-b
`;
    expect(parseColonyModelsTrailer(msg)).toEqual(["model-a", "model-b"]);
  });

  it("case-insensitive", () => {
    expect(parseColonyModelsTrailer("colony-models: M1")).toEqual(["M1"]);
  });

  it("returns empty when no trailer exists", () => {
    expect(parseColonyModelsTrailer("plain message")).toEqual([]);
  });
});

describe("appendTrailer", () => {
  it("appends the trailer after a blank line", () => {
    const result = appendTrailer("feat: stuff", "Colony-Models: m1");
    expect(result).toBe("feat: stuff\n\nColony-Models: m1\n");
  });

  it("idempotent when the trailer already exists with the same models", () => {
    const msg = "feat: stuff\n\nColony-Models: m1\n";
    expect(appendTrailer(msg, "Colony-Models: m1")).toBe(msg);
  });

  it("replaces existing trailer when models differ", () => {
    const msg = "feat: stuff\n\nColony-Models: m1\n";
    const result = appendTrailer(msg, "Colony-Models: m1, m2");
    expect(result).toBe("feat: stuff\n\nColony-Models: m1, m2\n");
  });

  it("no-op with empty trailer", () => {
    expect(appendTrailer("msg", "")).toBe("msg");
  });
});

describe("collectRunModelIds", () => {
  function run(id: string, modelId: string | null): Run {
    return {
      id,
      scope_id: "s1" as Run["scope_id"],
      task_id: "t1" as Run["task_id"],
      kind: "implement",
      status: "succeeded",
      lease_expires_at: "",
      base_sha: null,
      head_sha: null,
      workspace_path: null,
      sandbox_id: null,
      adopted: 0,
      envelope_json: null,
      evidence_json: null,
      token_id: null,
      model_id: modelId,
      trace_id: null,
      error: null,
      fault_json: null,
      started_at: "",
      finished_at: null,
    };
  }

  function event(runId: string, from: string, to: string): RunEvent {
    return {
      id: 1,
      run_id: runId,
      at: "",
      event: "pi_model_fallback",
      detail_json: JSON.stringify({ from, to }),
    };
  }

  it("collects a single model from one run", () => {
    const runs = [run("r1", "model-a")];
    const ids = collectRunModelIds(runs, () => []);
    expect(ids).toEqual(["model-a"]);
  });

  it("collects multiple models including fallback destinations", () => {
    const runs = [run("r1", "fallback-b")];
    const ids = collectRunModelIds(runs, () => [
      event("r1", "model-a", "fallback-b"),
    ]);
    // model-a (from event), fallback-b (run.model_id + event.to)
    expect(ids).toEqual(["fallback-b", "model-a"]);
  });

  it("deduplicates and sorts deterministically", () => {
    const runs = [run("r1", "z"), run("r2", "a")];
    const ids = collectRunModelIds(runs, () => []);
    expect(ids).toEqual(["a", "z"]);
  });

  it("collects from multiple implement runs across request-changes cycles", () => {
    const r1 = run("r1", "primary-1");
    const r2 = run("r2", "primary-2");
    const ids = collectRunModelIds([r1, r2], (rid) => {
      if (rid === "r1") return [event("r1", "primary-1", "fallback-1")];
      if (rid === "r2") return [event("r2", "primary-2", "fallback-2")];
      return [];
    });
    expect(ids).toEqual(["fallback-1", "fallback-2", "primary-1", "primary-2"]);
  });

  it("handles runs with no model_id and no fallback events", () => {
    const runs = [run("r1", null)];
    const ids = collectRunModelIds(runs, () => []);
    expect(ids).toEqual([]);
  });

  it("reads early fallback events beyond the feed page window from a real store", () => {
    const scope = store.createScope({
      goal: "prov busy run",
      title: "prov busy run",
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
    });
    const runRow = store.startRun({
      scope_id: scope.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
      model_id: "fallback-b",
    });
    // The fallback event predates 249 tool_call rows: listRunEvents'
    // newest-200 window hides it, obscuring model-a from provenance.
    store.appendRunEvent(runRow.id, "pi_model_fallback", {
      from: "model-a",
      to: "fallback-b",
    });
    for (let i = 1; i <= 249; i++) {
      store.appendRunEvent(runRow.id, "tool_call", { seq: i });
    }

    const ids = collectRunModelIds([runRow], (rid) =>
      store.listRunEventsByName(rid, "pi_model_fallback"),
    );
    // fallback-b (run.model_id + event.to), model-a (event.from)
    expect(ids).toEqual(["fallback-b", "model-a"]);
  });
});

describe("buildMergeProvenanceLine", () => {
  it("produces role-qualified aggregate for architect, implement, review", () => {
    const line = buildMergeProvenanceLine(
      ["arch-m1"],
      ["dev-m1", "dev-m2"],
      ["rev-m1"],
    );
    expect(line).toBe(
      "Colony-Models: architect=arch-m1; implement=dev-m1, dev-m2; review=rev-m1",
    );
  });

  it("excludes empty roles", () => {
    const line = buildMergeProvenanceLine([], ["dev-m1"], []);
    expect(line).toBe("Colony-Models: implement=dev-m1");
  });

  it("returns empty when no roles have models", () => {
    expect(buildMergeProvenanceLine([], [], [])).toBe("");
  });
});

describe("amendBranchWithTrailer", () => {
  it("rewrites branch commits to carry the Colony-Models trailer and returns the new head", () => {
    const repo = tempDir("colony-provenance-repo-");
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "hello", "utf8");
    commitAll(repo, "init");

    // Create a task branch with one commit.
    git(repo, ["checkout", "-b", "colony/t1"]);
    writeFileSync(join(repo, "feature.txt"), "x", "utf8");
    commitAll(repo, "feat: add feature");
    const originalHead = git(repo, ["rev-parse", "HEAD"]).trim();
    // Switch away from the branch so the local clone can push to it.
    git(repo, ["checkout", "main"]);

    // Amend with a local clone URL (absolute path).
    const newHead = amendBranchWithTrailer({
      cloneUrl: repo,
      branch: "colony/t1",
      defaultBranch: "main",
      expectedHeadSha: originalHead,
      trailer: "Colony-Models: model-a",
    });

    expect(newHead).not.toBe(originalHead);

    // Re-clone and check the rewritten commit carries the trailer.
    const clone = tempDir("colony-provenance-check-");
    git(clone, ["clone", repo, "work", "--branch", "colony/t1"]);
    const log = git(join(clone, "work"), ["log", "--format=%B", "-1"]);
    expect(log).toContain("Colony-Models: model-a");
    expect(log).toContain("feat: add feature");
  }, 30_000);

  it("skips trailing when already present (idempotent)", () => {
    const repo = tempDir("colony-idempotent-repo-");
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "hello", "utf8");
    commitAll(repo, "init");
    git(repo, ["checkout", "-b", "colony/t2"]);
    writeFileSync(join(repo, "a.txt"), "a", "utf8");
    commitAll(repo, "feat: a\n\nColony-Models: m1\n");
    const head1 = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["checkout", "main"]);
    const newHead = amendBranchWithTrailer({
      cloneUrl: repo,
      branch: "colony/t2",
      defaultBranch: "main",
      expectedHeadSha: head1,
      trailer: "Colony-Models: m1",
    });
    // Idempotent: head should be unchanged (same trailer, nothing to amend).
    expect(newHead).toBe(head1);
  }, 30_000);
});
