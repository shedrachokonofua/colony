import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";
import {
  createFileSessionManager,
  readSessionHeader,
  sessionFilePath,
  sessionRunDir,
} from "./session-store.js";

const dataDirs: string[] = [];

afterEach(() => {
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-sessions-test-"));
  dataDirs.push(dir);
  return dir;
}

describe("session-store paths", () => {
  it("sessionFilePath resolves to <dataDir>/sessions/<run_id>/session.jsonl", () => {
    const file = sessionFilePath("/srv/colony", "run-1");
    expect(file).toBe(resolve("/srv/colony", "sessions", "run-1", "session.jsonl"));
    const segments = file.split(sep);
    const i = segments.indexOf("sessions");
    expect(segments.slice(i, i + 3)).toEqual(["sessions", "run-1", "session.jsonl"]);
  });

  it("sessionRunDir is the parent of the session file", () => {
    expect(sessionRunDir("/srv/colony", "run-1")).toBe(
      resolve("/srv/colony", "sessions", "run-1"),
    );
  });
});

describe("readSessionHeader", () => {
  it("ok only when the file exists and the first line is a JSON object", () => {
    const dataDir = newDataDir();

    expect(readSessionHeader(dataDir, "ghost")).toEqual({ ok: false, entries: 0 });

    const file = sessionFilePath(dataDir, "run-ok");
    mkdirSync(sessionRunDir(dataDir, "run-ok"), { recursive: true });
    writeFileSync(
      file,
      ['{"type":"session_title_slot","v":1}', '{"type":"session","id":"s1"}', '{"type":"message"}'].join(
        "\n",
      ),
    );
    expect(readSessionHeader(dataDir, "run-ok")).toEqual({ ok: true, entries: 3 });

    // Non-object first line is not a header; empty file has nothing.
    writeFileSync(file, "[1,2]\n");
    expect(readSessionHeader(dataDir, "run-ok")).toEqual({ ok: false, entries: 0 });
    writeFileSync(file, "not json\n");
    expect(readSessionHeader(dataDir, "run-ok")).toEqual({ ok: false, entries: 0 });
    writeFileSync(file, "");
    expect(readSessionHeader(dataDir, "run-ok")).toEqual({ ok: false, entries: 0 });
  });
});

describe("createFileSessionManager", () => {
  it("persists a parseable JSONL whose first line is a JSON object", async () => {
    const dataDir = newDataDir();
    const cwd = mkdtempSync(join(tmpdir(), "colony-sessions-cwd-"));
    dataDirs.push(cwd);
    const manager = await createFileSessionManager(dataDir, "run-jsonl", cwd);

    // The SDK materializes a fresh session only once an assistant message
    // exists, so cross the lazy gate the same way a completed run does.
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    } as Parameters<typeof manager.appendMessage>[0]);
    manager.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-completions",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
    } as Parameters<typeof manager.appendMessage>[0]);

    const file = sessionFilePath(dataDir, "run-jsonl");
    expect(existsSync(file)).toBe(true);
    expect(readSessionHeader(dataDir, "run-jsonl")).toEqual({ ok: true, entries: 4 });
    const objects = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
    expect(objects.length).toBe(4);
    // Title slot then session header — every line parses as a JSON object.
    expect(objects[0]).toBeTypeOf("object");
  });

  it("appends grow the same file across appends and a resume reopen", async () => {
    const dataDir = newDataDir();
    const cwd = mkdtempSync(join(tmpdir(), "colony-sessions-cwd2-"));
    dataDirs.push(cwd);

    const first = await createFileSessionManager(dataDir, "run-resume", cwd);
    first.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-completions",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
    } as Parameters<typeof first.appendMessage>[0]);

    // The file is the source of truth: a reopened manager resumes the prior
    // session (header held separately, message entries replayed) — what a
    // colonyd restart needs to continue a run.
    const reopened = await createFileSessionManager(dataDir, "run-resume", cwd);
    expect(reopened.getHeader()?.id).toBe(first.getHeader()?.id);
    expect(reopened.getEntries().length).toBe(1);
    expect(readSessionHeader(dataDir, "run-resume")).toEqual({ ok: true, entries: 3 });
  });
});