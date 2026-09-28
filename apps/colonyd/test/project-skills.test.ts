import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createLocalArtifactStore, Store } from "@colony/core";
import { materializeProjectSkills } from "@colony/agent-runtime";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";
import {
  attachSkillsForRun,
  resolveProjectSkills,
  type SkillSourceAccess,
} from "../src/runs/skills.js";

const SHA = "a".repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeSkill(
  root: string,
  rel: string,
  frontmatter: string,
  extra: Record<string, string> = {},
) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n# Body\n\nDo the thing.\n`,
  );
  for (const [name, content] of Object.entries(extra)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

/** A fake source: one checked-out tree, pins record the refs they were asked for. */
function fakeAccess(root: string): SkillSourceAccess & { pinned: string[] } {
  const pinned: string[] = [];
  return {
    pinned,
    async pin(repoPath, ref) {
      pinned.push(`${repoPath}@${ref}`);
      return SHA;
    },
    async checkout() {
      return root;
    },
  };
}

function metaTree(): string {
  const root = tempDir("skills-src-");
  writeSkill(
    root,
    "skills/s30-edge",
    "name: s30-edge\ndescription: >-\n  Use when building the\n  edge Worker.",
    {
      "web-patterns.md": "patterns",
    },
  );
  writeSkill(
    root,
    "skills/s30-shipping",
    "name: s30-shipping\ndescription: Use when shipping.",
    {
      "references/ci.md": "ci",
    },
  );
  writeSkill(root, "skills/other", "name: other\ndescription: Not selected.");
  return root;
}

describe("resolveProjectSkills", () => {
  it("pins the ref, selects matching skill dirs with all their files, and keeps content out of JSON", async () => {
    const access = fakeAccess(metaTree());
    const resolved = await resolveProjectSkills(
      [{ repo_path: "seven30/meta", ref: "main", paths: ["skills/s30-*"] }],
      access,
    );
    expect(access.pinned).toEqual(["seven30/meta@main"]);
    expect(resolved.sources[0]!.resolved_sha).toBe(SHA);
    expect(resolved.skills.map((s) => s.name)).toEqual([
      "s30-edge",
      "s30-shipping",
    ]);
    const edge = resolved.skills[0]!;
    // Folded YAML descriptions are read as text, not the literal ">-".
    expect(edge.description).toBe("Use when building the edge Worker.");
    expect(edge.path).toBe(".colony/skills/project/s30-edge");
    expect(edge.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "web-patterns.md",
    ]);
    expect(resolved.skills[1]!.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "references/ci.md",
    ]);
    const json = JSON.stringify(resolved.skills);
    expect(json).not.toContain("Do the thing");
    // Content stays reachable for materialization (non-enumerable property).
    expect(
      Object.getOwnPropertyDescriptor(edge.files[1], "content")?.value,
    ).toBe("patterns");
  });

  it("fails on a path that matches nothing", async () => {
    await expect(
      resolveProjectSkills(
        [{ repo_path: "seven30/meta", ref: "main", paths: ["skills/nope-*"] }],
        fakeAccess(metaTree()),
      ),
    ).rejects.toThrow('path "skills/nope-*" matched no SKILL.md directory');
  });

  it("fails when a skill collides with a built-in playbook or another source", async () => {
    const root = tempDir("skills-collide-");
    writeSkill(root, "skills/debugging", "name: debugging\ndescription: x");
    await expect(
      resolveProjectSkills(
        [{ repo_path: "g/r", ref: "main", paths: ["skills/*"] }],
        fakeAccess(root),
      ),
    ).rejects.toThrow("collides with a built-in playbook");

    const meta = metaTree();
    await expect(
      resolveProjectSkills(
        [
          { repo_path: "g/a", ref: "main", paths: ["skills/s30-edge"] },
          { repo_path: "g/b", ref: "main", paths: ["skills/s30-edge"] },
        ],
        fakeAccess(meta),
      ),
    ).rejects.toThrow('skill "s30-edge" defined by both g/a@main and g/b@main');
  });

  it("uses a full SHA ref as-is without pinning", async () => {
    const access = fakeAccess(metaTree());
    await resolveProjectSkills(
      [{ repo_path: "g/r", ref: "b".repeat(40), paths: ["skills/other"] }],
      access,
    );
    expect(access.pinned).toEqual([]);
  });
});

describe("attachSkillsForRun", () => {
  function storeWithRun() {
    const store = new Store(join(tempDir("skills-store-"), "test.db"));
    const scope = store.createScope({
      goal: "g",
      title: "t",
      provider_repo_id: "1",
      provider_repo_path: "seven30/brink",
    });
    store.ensureProject("brink");
    const runId = crypto.randomUUID();
    store.startRun({
      id: runId,
      scope_id: scope.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    return { store, runId };
  }

  it("is a no-op when the project declares no skills", async () => {
    const { store, runId } = storeWithRun();
    const packet = { body: "spec", project: null };
    await attachSkillsForRun({ store }, runId, "brink", packet);
    expect(packet).toEqual({ body: "spec", project: null });
  });

  it("records pinned evidence, attaches the manifest and lists skills in the body", async () => {
    const { store, runId } = storeWithRun();
    store.setProjectSkillSources("brink", [
      { repo_path: "seven30/meta", ref: "main", paths: ["skills/s30-*"] },
    ]);
    const packet: { body: string; project: unknown } = {
      body: "spec",
      project: null,
    };
    await attachSkillsForRun(
      { store, skillAccess: fakeAccess(metaTree()) },
      runId,
      "brink",
      packet,
    );

    expect(packet.body).toContain("## Project skills");
    expect(packet.body).toContain(
      "`.colony/skills/project/s30-edge/SKILL.md` (s30-edge) — Use when building the edge Worker.",
    );
    const project = packet.project as {
      name: string;
      skills: { name: string }[];
    };
    expect(project.name).toBe("brink");
    expect(project.skills.map((s) => s.name)).toEqual([
      "s30-edge",
      "s30-shipping",
    ]);

    const events = store.listRunEventsByName(runId, "skills_resolved");
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0]!.detail_json) as {
      sources: {
        resolved_sha: string;
        skills: { name: string; hash: string }[];
      }[];
    };
    expect(detail.sources[0]!.resolved_sha).toBe(SHA);
    expect(detail.sources[0]!.skills[0]!.hash).toMatch(/^sha256:/);
  });

  it("fails the run when skills are declared but cannot be resolved", async () => {
    const { store, runId } = storeWithRun();
    store.setProjectSkillSources("brink", [
      { repo_path: "seven30/meta", ref: "main", paths: ["skills/s30-*"] },
    ]);
    await expect(
      attachSkillsForRun({ store }, runId, "brink", { body: "" }),
    ).rejects.toThrow("no skill source access");
  });
});

describe("materializeProjectSkills", () => {
  it("writes each skill directory read-only and drops stale skills", async () => {
    const resolved = await resolveProjectSkills(
      [{ repo_path: "seven30/meta", ref: "main", paths: ["skills/s30-*"] }],
      fakeAccess(metaTree()),
    );
    const workspace = tempDir("skills-ws-");
    const stale = join(workspace, ".colony/skills/project/old-skill");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "SKILL.md"), "stale");

    materializeProjectSkills(workspace, {
      project: { skills: resolved.skills },
    } as never);

    const ci = join(
      workspace,
      ".colony/skills/project/s30-shipping/references/ci.md",
    );
    expect(readFileSync(ci, "utf8")).toBe("ci");
    expect(statSync(ci).mode & 0o777).toBe(0o444);
    expect(
      existsSync(join(workspace, ".colony/skills/project/s30-edge/SKILL.md")),
    ).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});

describe("project skills HTTP", () => {
  function app() {
    const store = new Store(join(tempDir("skills-http-"), "test.db"));
    const ctx = {
      store,
      provider: {} as ColonydContext["provider"],
      config: {
        reviewMode: "required",
        hitlMode: "yolo",
      } as ColonydContext["config"],
      agents: {} as ColonydContext["agents"],
      artifacts: createLocalArtifactStore(tempDir("skills-art-")),
      logger: { info() {}, warn() {}, error() {} },
      env: {
        gitlabBaseUrl: "https://gitlab.example",
        gitlabToken: "",
        webhookSecret: "",
        singleToken: true,
        maxConcurrent: 1,
        maxAttempts: 3,
        resumeLeaseTtlMs: 900_000,
        oidcIssuer: "",
        oidcClientId: "colony",
        oidcRequiredRole: "",
        traceUiBaseUrl: "",
        consoleBaseUrl: "",
      },
      draining: { isDraining: () => false },
      requestTick() {},
    } as unknown as ColonydContext;
    return { store, app: buildApp(ctx) };
  }
  const headers = {
    "X-Actor-Id": "human:op-1",
    "content-type": "application/json",
  };

  it("sets, reads and audits skill sources; rejects bad declarations", async () => {
    const { store, app: http } = app();
    const sources = [
      { repo_path: "seven30/meta", ref: "main", paths: ["skills/s30-*"] },
    ];
    const put = await http.request("/projects/brink/skills", {
      method: "PUT",
      headers,
      body: JSON.stringify({ skill_sources: sources }),
    });
    expect(put.status).toBe(200);
    const get = await http.request("/projects/brink/skills", { headers });
    expect(await get.json()).toEqual({ skill_sources: sources });
    expect(store.getProjectSkillSources("brink")).toEqual(sources);

    const bad = await http.request("/projects/brink/skills", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        skill_sources: [{ repo_path: "meta", ref: "main", paths: ["x"] }],
      }),
    });
    expect(bad.status).toBe(400);
    expect(store.getProjectSkillSources("brink")).toEqual(sources);

    const clear = await http.request("/projects/brink/skills", {
      method: "PUT",
      headers,
      body: JSON.stringify({ skill_sources: [] }),
    });
    expect(clear.status).toBe(200);
    expect(store.getProjectSkillSources("brink")).toEqual([]);
  });
});
