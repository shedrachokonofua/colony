import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * The SDK's turn recovery treats a reason-less `agent.abort()` as a dropped
 * provider stream and RETRIES the turn (`isRetryableReasonlessAbort`). Only
 * the session-level `abort()` sets the abort-in-progress latch that makes an
 * abort deliberate. Every Colony stop path must go through the session (or a
 * runner-owned abort that does); a bare agent abort produced a child session
 * that spun 1700+ turns and pinned its parent 30 minutes past the wall
 * (2026-09-01). This is an external contract nothing in the type system
 * expresses, so the guard is the source itself.
 */
describe("no bare agent.abort() in the runtime", () => {
  it("every abort goes through a session or a runner-owned abort", () => {
    const dir = join(import.meta.dir);
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const lines = readFileSync(join(dir, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.trimStart();
        if (code.startsWith("//") || code.startsWith("*")) return;
        if (/\bagent\.abort\(\s*\)/.test(code))
          offenders.push(`${file}:${i + 1}: ${code}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
