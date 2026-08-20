import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLONY_SKILLS, playbookPrompt } from "./colony-skills.js";
import {
  provisionScratchDir,
  provisionRepoWorkspace,
} from "./pi-runner-common.js";

const PACKET = { goal: "g", body: "b" } as never;

describe("colony playbooks", () => {
  it("provisions playbooks into scratch workspaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "colony-skills-"));
    try {
      const ws = provisionScratchDir("run-skills-1", PACKET, dir);
      for (const skill of COLONY_SKILLS) {
        const path = join(ws, ".colony", "skills", skill.file);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(skill.content);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("provisions playbooks into repo workspaces and git-excludes them", () => {
    const root = mkdtempSync(join(tmpdir(), "colony-skills-repo-"));
    try {
      // Local origin repo with one commit on main.
      const origin = join(root, "origin");
      execFileSync("git", ["init", "-q", "-b", "main", origin]);
      execFileSync(
        "git",
        ["-C", origin, "commit", "-q", "--allow-empty", "-m", "init"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        },
      );
      const sha = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const packet = {
        goal: "g",
        body: "b",
        repo: { url: origin, branch: "colony/x", base_commit: sha },
      } as never;
      const ws = provisionRepoWorkspace(`run-skills-${Date.now()}`, packet, {});
      try {
        expect(existsSync(join(ws, ".colony", "skills", "debugging.md"))).toBe(
          true,
        );
        const exclude = readFileSync(
          join(ws, ".git", "info", "exclude"),
          "utf8",
        );
        expect(exclude).toContain("PACKET.json");
        expect(exclude).toContain(".colony/");
        const status = execFileSync(
          "git",
          ["-C", ws, "status", "--porcelain"],
          {
            encoding: "utf8",
          },
        );
        expect(status).toBe("");
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("playbookPrompt lists only the requested files", () => {
    const prompt = playbookPrompt(["debugging.md"]);
    expect(prompt).toContain(".colony/skills/debugging.md");
    expect(prompt).not.toContain("code-review.md");
  });
});
