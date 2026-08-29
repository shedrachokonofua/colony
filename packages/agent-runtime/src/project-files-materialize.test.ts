import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { provisionScratchDir } from "./pi-runner-common.js";
import type { AgentRuntimePacket } from "./adapter.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "project-files-"));
  dirs.push(dir);
  return dir;
}

/** Build a minimal implement-style packet with project files. */
function packetWithFiles(
  entries: Array<{
    filename: string;
    content?: string;
    media_type?: string;
    byte_size?: number;
  }>,
): AgentRuntimePacket {
  const files = entries.map((e) => ({
    id: "pf-test",
    filename: e.filename,
    media_type: e.media_type ?? "text/plain",
    byte_size: e.byte_size ?? Buffer.byteLength(e.content ?? ""),
    content: e.content ?? "",
  }));
  return {
    kind: "implement_task",
    task_id: "test-task",
    scope_id: "test-scope",
    goal: "test",
    body: "test task body",
    project: {
      name: "test-project",
      context_doc: "",
      files,
    },
    repo: {
      url: "so/test",
      branch: "main",
      base_commit: "a".repeat(40),
    },
  } as unknown as AgentRuntimePacket;
}

describe("project reference file materialization", () => {
  it("writes files read-only at .colony/project/<filename>", () => {
    const base = scratchDir();
    const packet = packetWithFiles([
      { filename: "guide.md", content: "# Guide", media_type: "text/markdown" },
      { filename: "readme.txt", content: "hello world" },
    ]);
    const dir = provisionScratchDir("test-run", packet, base);
    expect(dir).toBe(base);

    const guidePath = join(base, ".colony", "project", "guide.md");
    const readmePath = join(base, ".colony", "project", "readme.txt");
    expect(existsSync(guidePath)).toBeTrue();
    expect(existsSync(readmePath)).toBeTrue();
    expect(readFileSync(guidePath, "utf8")).toBe("# Guide");
    expect(readFileSync(readmePath, "utf8")).toBe("hello world");

    // Read-only mode.
    expect(statSync(guidePath).mode & 0o777).toBe(0o444);
    expect(statSync(readmePath).mode & 0o777).toBe(0o444);
  });

  it("re-provisioning a dirty dir drops stale files", () => {
    const base = scratchDir();
    const prior = packetWithFiles([{ filename: "stale.txt", content: "old" }]);
    const dir = provisionScratchDir("test-run", prior, base);

    const stalePath = join(base, ".colony", "project", "stale.txt");
    expect(existsSync(stalePath)).toBeTrue();

    // Second provision with different files.
    const packet = packetWithFiles([{ filename: "fresh.md", content: "new" }]);
    provisionScratchDir("test-run", packet, base);

    expect(existsSync(stalePath)).toBeFalse();
    expect(
      readFileSync(join(base, ".colony", "project", "fresh.md"), "utf8"),
    ).toBe("new");
  });

  it("skips dangerous filenames without clobbering protected paths or existing files", () => {
    const base = scratchDir();
    // Protected paths that must survive provisioning untouched.
    writeFileSync(join(base, "PACKET.json"), '{"sentinel":"packet"}', "utf8");
    mkdirSync(join(base, ".git", "info"), { recursive: true });
    writeFileSync(join(base, ".git", "config"), "[core]\n", "utf8");
    writeFileSync(join(base, ".git", "info", "exclude"), "", "utf8");
    mkdirSync(join(base, ".colony", "skills"), { recursive: true });
    writeFileSync(join(base, ".colony", "skills", "keep.md"), "keep", "utf8");

    const packet = packetWithFiles([
      { filename: "../PACKET.json", content: "should-not-write" },
      { filename: "..", content: "should-skip" },
      { filename: "x/y.txt", content: "should-skip" },
      { filename: ".env", content: "should-skip" },
      { filename: ".git/config", content: "should-skip" },
      { filename: "PACKET.json", content: "should-skip" },
      { filename: ".colony", content: "should-skip" },
      { filename: ".git", content: "should-skip" },
      { filename: "a\u0000b.txt", content: "should-skip" },
      { filename: "a/../../etc/passwd", content: "should-skip" },
      { filename: "safe.txt", content: "safe file" },
    ]);
    provisionScratchDir("test-run", packet, base);

    const projectDir = join(base, ".colony", "project");
    // Dangerous filenames were skipped — only safe.txt was written.
    expect(readdirSync(projectDir)).toEqual(["safe.txt"]);

    // No dangerous entry escaped `.colony/project/`: the traversal
    // `a/../../etc/passwd` created nothing outside it, and .git/config and
    // .colony/skills/* were never clobbered.
    expect(existsSync(join(base, "etc"))).toBeFalse();
    expect(readFileSync(join(base, ".git", "config"), "utf8")).toBe("[core]\n");
    expect(
      readFileSync(join(base, ".colony", "skills", "keep.md"), "utf8"),
    ).toBe("keep");

    // Safe file was written.
    expect(readFileSync(join(projectDir, "safe.txt"), "utf8")).toBe(
      "safe file",
    );
  });

  it("includes .colony/project/ in .git/info/exclude", () => {
    const base = scratchDir();
    // Initialize a git repo in base.
    execFileSync("git", ["init", "--quiet"], { cwd: base });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: base });
    execFileSync("git", ["config", "user.name", "test"], { cwd: base });

    const packet = packetWithFiles([{ filename: "a.txt", content: "a" }]);
    provisionScratchDir("test-run", packet, base);

    const excludePath = join(base, ".git", "info", "exclude");
    expect(existsSync(excludePath)).toBeTrue();
    const exclude = readFileSync(excludePath, "utf8");
    expect(exclude).toContain(".colony/project/");
  });

  it("mutating the packet snapshot after provisioning leaves the dir byte-identical", () => {
    const base = scratchDir();
    const packet = packetWithFiles([
      { filename: "stable.txt", content: "original content" },
    ]);
    const dir = provisionScratchDir("test-run", packet, base);

    const filePath = join(base, ".colony", "project", "stable.txt");
    expect(readFileSync(filePath, "utf8")).toBe("original content");

    // Simulate a later store update: the packet snapshot (what colonyd built
    // from the store at provisioning time) changes. Materialization already
    // happened once from the snapshot, so the existing dir must stay
    // byte-identical — nothing re-reads the packet afterwards.
    const project = (packet as Record<string, unknown>)["project"] as Record<
      string,
      unknown
    >;
    const files = project["files"] as Array<Record<string, unknown>>;
    files[0]!["content"] = "mutated content";
    files[0]!["byte_size"] = Buffer.byteLength("mutated content");

    expect(readFileSync(filePath, "utf8")).toBe("original content");
    expect(statSync(filePath).mode & 0o777).toBe(0o444);
  });
});
