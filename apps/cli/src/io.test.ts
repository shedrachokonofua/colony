import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";
import { readText } from "./io.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("readText", () => {
  it("reads a file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colony-cli-io-"));
    tempDirs.push(dir);
    const path = join(dir, "goal.md");
    writeFileSync(path, "ship it\n", "utf8");
    expect(await readText(path)).toBe("ship it\n");
  });

  it("reads all of stdin for '-'", async () => {
    const original = process.stdin;
    process.stdin = (async function* () {
      yield Buffer.from("line one\n");
      yield Buffer.from("line two");
    })() as unknown as typeof process.stdin;
    try {
      expect(await readText("-")).toBe("line one\nline two");
    } finally {
      process.stdin = original;
    }
  });
});
