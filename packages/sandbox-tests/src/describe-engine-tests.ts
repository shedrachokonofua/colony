import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildSandboxLaunchProfile,
  type ExecEvent,
  type SandboxEngine,
  type SandboxHandle,
  type SandboxLaunchProfile,
} from "@colony/sandbox";

/**
 * Builds a fresh engine per call. The suite provisions and destroys a handle
 * inside each `it`, so callers may return a singleton or a new engine each
 * time.
 */
export type MakeEngine = () => SandboxEngine | Promise<SandboxEngine>;

const CANARY_ENV = "COLONY_SANDBOX_TEST_CANARY";
const LEAKED_VALUE = "leaked";
const VISIBLE_ENV = "COLONY_RUN_ID";
const VISIBLE_VALUE = "sanbox-tests-visible-run";
const CANARY_CONTENT = "top-secret-canary-payload";
const ROUND_TRIP_COMMAND =
  "printf a1; printf b1 1>&2; printf a2; printf b2 1>&2";

const PROFILE: SandboxLaunchProfile = buildSandboxLaunchProfile("reviewer");

interface ProvisionedContext {
  handle: SandboxHandle;
  workspace: string;
  parentDir: string;
  canaryName: string;
}

/** Provisions a fresh per-test workspace under os.tmpdir() and destroys it on teardown. */
async function withProvisionedHandle<T>(
  makeEngine: MakeEngine,
  run: (ctx: ProvisionedContext) => Promise<T>,
): Promise<T> {
  const parentDir = await mkdtemp(join(tmpdir(), "colony-sandbox-tests-"));
  const workspace = join(parentDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const canaryName = `canary-${randomUUID()}.txt`;
  await writeFile(join(parentDir, canaryName), CANARY_CONTENT);

  const engine = await makeEngine();
  const handle = await engine.provision(PROFILE, workspace);
  try {
    return await run({ handle, workspace, parentDir, canaryName });
  } finally {
    await handle.destroy();
    await rm(parentDir, { recursive: true, force: true });
  }
}

function collectStreamData(
  events: readonly ExecEvent[],
  kind: "stdout" | "stderr",
): string {
  return events
    .filter(
      (event): event is Extract<ExecEvent, { kind: "stdout" | "stderr" }> =>
        event.kind === kind,
    )
    .map((event) => event.data)
    .join("");
}

async function checkExecRoundTrip(makeEngine: MakeEngine): Promise<void> {
  await withProvisionedHandle(makeEngine, async ({ handle }) => {
    const events: ExecEvent[] = [];
    const result = await handle.exec({ command: ROUND_TRIP_COMMAND }, (event) =>
      events.push(event),
    );

    expect(result.exitCode).toBe(0);

    // Every event emitted by the engine carries a strictly increasing `seq`
    // in the order it was surfaced to the consumer.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }

    // Per-stream order is preserved: stdout/stderr are separate pipes, so we
    // assert concatenated data per stream rather than cross-stream
    // interleaving (which the OS and remote transports do not guarantee).
    expect(collectStreamData(events, "stdout")).toBe("a1a2");
    expect(collectStreamData(events, "stderr")).toBe("b1b2");

    // The final surfaced event is the exit notification, and its exit code
    // matches the ExecResult returned by exec().
    const finalEvent = events[events.length - 1];
    expect(finalEvent.kind).toBe("exit");
    expect(finalEvent.kind === "exit" && finalEvent.exitCode).toBe(0);
    expect(finalEvent.kind === "exit" && finalEvent.exitCode).toBe(
      result.exitCode,
    );
  });
}

/**
 * Engine capability switches for the conformance suite.
 *
 * `enforcesExecIsolation`: whether the engine confines what a *shell command*
 * can reach on the filesystem (e.g. a pod-isolated engine). The in-process
 * engine rejects escaping paths at the handle API (readFile/writeFile/cwd)
 * but cannot stop a spawned shell from reading `../` — it is a compatibility
 * engine, not a security boundary. Defaults to true (strict).
 */
export interface EngineTestOptions {
  readonly enforcesExecIsolation?: boolean;
}

async function checkApiContainment(makeEngine: MakeEngine): Promise<void> {
  await withProvisionedHandle(makeEngine, async ({ handle, canaryName }) => {
    const escapedPath = `../${canaryName}`;

    // `readFile`/`writeFile` must reject paths escaping the workspace.
    await expect(handle.readFile(escapedPath)).rejects.toThrow();
    await expect(handle.writeFile(escapedPath, "x")).rejects.toThrow();

    // An exec `cwd` escaping the workspace must be rejected.
    await expect(
      handle.exec({ command: "true", cwd: ".." }, () => undefined),
    ).rejects.toThrow();
  });
}

async function checkExecContainment(makeEngine: MakeEngine): Promise<void> {
  await withProvisionedHandle(makeEngine, async ({ handle, canaryName }) => {
    // `exec` must not surface content outside the workspace to the caller.
    let surfaced = "";
    let exitCode: number | null | undefined;
    await handle.exec({ command: `cat ../${canaryName}` }, (event) => {
      if (event.kind === "stdout" || event.kind === "stderr") {
        surfaced += event.data;
      }
      if (event.kind === "exit") exitCode = event.exitCode;
    });

    expect(surfaced).not.toContain(CANARY_CONTENT);
    expect(exitCode).not.toBe(0);
  });
}

/**
 * The workspace's existing contents must be visible through the handle:
 * exec runs *in* the workspace and readFile resolves against it. This is
 * the regression check for rooting a handle in an empty scratch dir while
 * the run's repo clone sits untouched next to it.
 */
async function checkWorkspaceVisibility(makeEngine: MakeEngine): Promise<void> {
  await withProvisionedHandle(makeEngine, async ({ handle, workspace }) => {
    const seeded = `seed-${randomUUID()}.txt`;
    const content = `workspace-visible-${randomUUID()}`;
    await writeFile(join(workspace, seeded), content);

    expect(String(await handle.readFile(seeded))).toBe(content);

    let surfaced = "";
    let exitCode: number | null | undefined;
    await handle.exec({ command: `cat ${seeded}` }, (event) => {
      if (event.kind === "stdout") surfaced += event.data;
      if (event.kind === "exit") exitCode = event.exitCode;
    });
    expect(exitCode).toBe(0);
    expect(surfaced).toContain(content);
  });
}

async function checkEnvFiltering(makeEngine: MakeEngine): Promise<void> {
  const previousCanary = process.env[CANARY_ENV];
  const previousVisible = process.env[VISIBLE_ENV];
  process.env[CANARY_ENV] = LEAKED_VALUE;
  process.env[VISIBLE_ENV] = VISIBLE_VALUE;
  try {
    await withProvisionedHandle(makeEngine, async ({ handle }) => {
      // A var absent from the profile `envAllowlist` must not be visible.
      let leaked = "";
      let leakedExit: number | null | undefined;
      await handle.exec({ command: `printenv ${CANARY_ENV}` }, (event) => {
        if (event.kind === "stdout" || event.kind === "stderr") {
          leaked += event.data;
        }
        if (event.kind === "exit") leakedExit = event.exitCode;
      });
      expect(leaked).not.toContain(LEAKED_VALUE);
      expect(leakedExit).not.toBe(0);

      // A var present in the profile `envAllowlist` IS visible.
      let visible = "";
      await handle.exec({ command: `printenv ${VISIBLE_ENV}` }, (event) => {
        if (event.kind === "stdout" || event.kind === "stderr") {
          visible += event.data;
        }
      });
      expect(visible).toContain(VISIBLE_VALUE);
    });
  } finally {
    restoreEnv(CANARY_ENV, previousCanary);
    restoreEnv(VISIBLE_ENV, previousVisible);
  }
}

async function checkDestroyIdempotent(makeEngine: MakeEngine): Promise<void> {
  await withProvisionedHandle(makeEngine, async ({ handle }) => {
    await handle.destroy();
    await handle.destroy(); // must not throw
  });
}

async function checkExecAfterDestroy(makeEngine: MakeEngine): Promise<void> {
  await withProvisionedHandle(makeEngine, async ({ handle }) => {
    await handle.destroy();
    await expect(
      handle.exec({ command: "true" }, () => undefined),
    ).rejects.toThrow();
  });
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

/**
 * Runs every conformance check against a single engine factory, throwing on
 * the first failure. Used by the self-test to prove the harness is
 * non-vacuous; `describeEngineTests` registers these as individual `it`s.
 */
export async function runSandboxEngineChecks(
  makeEngine: MakeEngine,
  options: EngineTestOptions = {},
): Promise<void> {
  await checkExecRoundTrip(makeEngine);
  await checkWorkspaceVisibility(makeEngine);
  await checkApiContainment(makeEngine);
  if (options.enforcesExecIsolation !== false) {
    await checkExecContainment(makeEngine);
  }
  await checkEnvFiltering(makeEngine);
  await checkDestroyIdempotent(makeEngine);
  await checkExecAfterDestroy(makeEngine);
}

/**
 * Registers a vitest conformance suite every sandbox engine must pass.
 *
 * Each `it` provisions a fresh engine/workspace and destroys its own handle,
 * so tests are independent and serial-friendly.
 */
export function describeEngineTests(
  name: string,
  makeEngine: MakeEngine,
  options: EngineTestOptions = {},
): void {
  describe(`sandbox engine conformance (${name})`, () => {
    it("exec round-trip surfaces ordered stdout/stderr with strictly increasing seq and exitCode 0", () =>
      checkExecRoundTrip(makeEngine));
    it("workspace contents are visible to exec and readFile", () =>
      checkWorkspaceVisibility(makeEngine));
    it("rejects handle API paths escaping the workspace", () =>
      checkApiContainment(makeEngine));
    if (options.enforcesExecIsolation !== false) {
      it("exec cannot surface content outside the workspace", () =>
        checkExecContainment(makeEngine));
    }
    it("filters env vars not in the launch profile envAllowlist", () =>
      checkEnvFiltering(makeEngine));
    it("destroy() is idempotent", () => checkDestroyIdempotent(makeEngine));
    it("exec() rejects after destroy()", () =>
      checkExecAfterDestroy(makeEngine));
  });
}
