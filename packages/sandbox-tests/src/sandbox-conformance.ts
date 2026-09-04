import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { buildSandboxLaunchProfile, type SandboxHandle } from "@colony/sandbox";
import { buildSandboxTools } from "@colony/agent-runtime/sandbox-tools";
import type { EngineTestOptions, MakeEngine } from "./describe-engine-tests.js";

/**
 * Conformance checks for what a provisioned sandbox must give an agent run
 * beyond the handle contract `describeEngineTests` covers: a usable git, the
 * pinned toolchain, the unit-test selection the runner uses, and tool
 * messages that come from the real wrappers an agent session actually calls.
 *
 * Every check here is a fact a run depends on at runtime, and each one has
 * already bitten an engine that passed the handle contract: a bare remote
 * outside the workspace is invisible to an engine that snapshots at
 * provision, a wrong bun in the image only shows up once a run shells out,
 * and a tool message that says "truncated" on every windowed read once
 * convinced a model a file was corrupt.
 */

/** Developer profile: the tool checks write, and git commits. */
const PROFILE = buildSandboxLaunchProfile("developer");

/** Repo root: src/ -> sandbox-tests/ -> packages/ -> root. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The single source of truth for the pinned toolchain. */
const VERSIONS_FILE = join(REPO_ROOT, "colony-versions.json");

/**
 * package.json's `test:unit` selection, minus the `xargs bun test` tail: a
 * selection that reaches an e2e spec would hang a run instead of testing it.
 */
const UNIT_TEST_SELECTION =
  "git ls-files 'apps/**/*.test.ts' 'packages/**/*.test.ts' 'scripts/*.test.ts' | grep -v '\\.integration\\.test\\.ts$'";

/**
 * Bytes of exec output the bash wrapper retains, matching the wrapper's own
 * cap: output above it is dropped and named in the message the agent sees.
 */
const EXEC_TAIL_BYTES = 256 * 1024;

const SEEDED_FILE = "README.md";
const COMMITTED_FILE = "conformance-note.txt";
const WINDOW_FILE = "conformance-window.ts";
const WINDOW_FILE_LINES = 40;
const WINDOW_LIMIT = 10;
const TOOL_FILE = "nested/conformance-tools.txt";
const TOOL_FILE_BODY = "conformance-tools-body\n";
const EDIT_FILE = "conformance-edit.txt";
const EDIT_FILE_BODY = "alpha\nbeta\n";

/**
 * The wrapper surface this suite drives. Message shape is a property of the
 * wrapper, so these checks must go through `ToolDefinition.execute` — a
 * conformance check that shells out through `handle.exec` proves nothing
 * about what an agent sees.
 */
interface SandboxToolLike {
  readonly name: string;
  readonly execute: (...args: never[]) => unknown;
}

interface ToolResult {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}

/** The wrappers ignore the extension context; the SDK signature wants one. */
const TOOL_CONTEXT = {};

interface SandboxContext {
  readonly handle: SandboxHandle;
  readonly workspace: string;
}

interface ExecOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

function hostBash(command: string, cwd: string): string {
  const result = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`host command failed (${result.status}): ${command}`);
  }
  return result.stdout ?? "";
}

function gitOnHost(workspace: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `host git ${args.join(" ")} failed (${result.status}): ${result.stderr ?? ""}`,
    );
  }
}

/**
 * Seeds a git workspace whose remote lives INSIDE the workspace.
 *
 * The bare remote is `<workspace>/.scratch-remote.git` on purpose: an engine
 * that transfers the workspace at provision (`seesPostProvisionLocalWrites:
 * false`, e.g. k8s) never sees a host-absolute /tmp remote, so a remote
 * outside the workspace would fail the push check for reasons that have
 * nothing to do with the engine.
 */
async function seedGitWorkspace(workspace: string): Promise<void> {
  gitOnHost(workspace, ["init", "-q"]);
  gitOnHost(workspace, ["config", "user.email", "conformance@colony.local"]);
  gitOnHost(workspace, ["config", "user.name", "Colony Conformance"]);
  await writeFile(join(workspace, SEEDED_FILE), "# conformance workspace\n");
  gitOnHost(workspace, ["add", SEEDED_FILE]);
  gitOnHost(workspace, ["commit", "-q", "-m", "initial commit"]);
  gitOnHost(workspace, ["init", "-q", "--bare", ".scratch-remote.git"]);
  gitOnHost(workspace, ["remote", "add", "scratch", ".scratch-remote.git"]);
}

/**
 * Provisions a fresh workspace under os.tmpdir() — seeded on the HOST before
 * `provision()`, because transfer-based engines snapshot it there — and
 * destroys the handle and the scratch tree on the way out.
 */
async function withSandbox<T>(
  makeEngine: MakeEngine,
  seed: ((workspace: string) => Promise<void>) | undefined,
  run: (ctx: SandboxContext) => Promise<T>,
): Promise<T> {
  const parentDir = await mkdtemp(join(tmpdir(), "colony-sandbox-conf-"));
  const workspace = join(parentDir, "workspace");
  await mkdir(workspace, { recursive: true });
  await seed?.(workspace);
  const engine = await makeEngine();
  const handle = await engine.provision(PROFILE, workspace);
  try {
    return await run({ handle, workspace });
  } finally {
    await handle.destroy();
    await rm(parentDir, { recursive: true, force: true });
  }
}

/** Runs a command in the sandbox with a workspace-relative cwd. */
async function execInSandbox(
  handle: SandboxHandle,
  command: string,
): Promise<ExecOutput> {
  let stdout = "";
  let stderr = "";
  const result = await handle.exec({ command, cwd: "." }, (event) => {
    if (event.kind === "stdout") stdout += event.data;
    else if (event.kind === "stderr") stderr += event.data;
  });
  return { stdout, stderr, exitCode: result.exitCode };
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The bare remote baked into the seeded workspace is expected git noise. */
function withoutScratchRemote(text: string): string[] {
  return lines(text).filter((line) => !line.includes(".scratch-remote.git"));
}

function toolText(result: ToolResult): string {
  return result.content
    .map((content) =>
      content.type === "text" && typeof content.text === "string"
        ? content.text
        : "",
    )
    .join("\n");
}

/** Builds the real wrappers against the absolute provisioned workspace. */
function buildTools(
  handle: SandboxHandle,
  workspace: string,
): Record<string, SandboxToolLike> {
  return Object.fromEntries(
    buildSandboxTools(handle, workspace, undefined).map((tool) => [
      tool.name,
      tool,
    ]),
  );
}

/**
 * Invokes a tool through its ToolDefinition, as the agent session would. A
 * missing wrapper is a conformance failure, not a test bug: the agent prompts
 * name these tools.
 */
async function invoke(
  tools: Record<string, SandboxToolLike>,
  name: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = tools[name];
  if (!tool) {
    throw new Error(
      `buildSandboxTools registered no "${name}" tool (have: ${Object.keys(tools).join(", ")})`,
    );
  }
  const execute = tool.execute as (...args: unknown[]) => Promise<ToolResult>;
  return execute("conformance", params, undefined, undefined, TOOL_CONTEXT);
}

/**
 * git must work inside the sandbox with no configuration beyond what the
 * workspace ships: agents push their branch, and a run that cannot do that
 * cannot land anything.
 */
async function checkGitWorkflow(
  engineName: string,
  makeEngine: MakeEngine,
): Promise<void> {
  await withSandbox(makeEngine, seedGitWorkspace, async ({ handle }) => {
    const status = await execInSandbox(handle, "git status --porcelain");
    expect(status.exitCode).toBe(0);
    expect(withoutScratchRemote(status.stdout)).toEqual([]);

    const tracked = await execInSandbox(handle, "git ls-files");
    expect(tracked.exitCode).toBe(0);
    expect(withoutScratchRemote(tracked.stdout)).toContain(SEEDED_FILE);

    await handle.writeFile(COMMITTED_FILE, "written inside the sandbox\n");
    expect(
      (await execInSandbox(handle, `git add ${COMMITTED_FILE}`)).exitCode,
    ).toBe(0);
    const commit = await execInSandbox(
      handle,
      "git commit -q -m conformance-note",
    );
    expect(commit.exitCode).toBe(0);
    expect((await execInSandbox(handle, "git ls-files")).stdout).toContain(
      COMMITTED_FILE,
    );

    const branch = `conformance-${engineName}`;
    const push = await execInSandbox(
      handle,
      `git push scratch HEAD:refs/heads/${branch}`,
    );
    expect(push.exitCode).toBe(0);

    // Non-vacuous: a push that silently no-ops still exits 0, so read the
    // branch back off the remote the workspace seeded.
    const remote = await execInSandbox(
      handle,
      `git ls-remote scratch refs/heads/${branch}`,
    );
    expect(remote.exitCode).toBe(0);
    expect(remote.stdout).toContain(`refs/heads/${branch}`);
  });
}

/**
 * The sandbox image must carry the pinned toolchain: a run that shells out to
 * a different bun or node than the repo pins fails in ways that look like
 * application bugs.
 */
async function checkPinnedVersions(makeEngine: MakeEngine): Promise<void> {
  const pinned = JSON.parse(await readFile(VERSIONS_FILE, "utf8")) as {
    bun?: unknown;
    node?: unknown;
  };
  const expectedBun = pinned.bun;
  const expectedNode = pinned.node;
  expect(typeof expectedBun).toBe("string");
  expect(typeof expectedNode).toBe("string");
  const nodeVersion = String(expectedNode);
  expect(nodeVersion.startsWith("v")).toBe(true);

  await withSandbox(makeEngine, undefined, async ({ handle }) => {
    const bun = await execInSandbox(handle, "bun --version");
    expect(bun.exitCode).toBe(0);
    expect(bun.stdout.trim()).toBe(String(expectedBun));

    const node = await execInSandbox(handle, "node --version");
    expect(node.exitCode).toBe(0);
    expect(node.stdout.trim().replace(/^v/, "")).toBe(
      nodeVersion.replace(/^v/, ""),
    );
  });
}

/**
 * The unit-test selection must stay spec-free and stable: `bun test` on a
 * Playwright spec hangs a run, and a selection whose own line count disagrees
 * has already lost (or duplicated) a file.
 */
function checkUnitTestSelection(): void {
  const selected = lines(hostBash(UNIT_TEST_SELECTION, REPO_ROOT));
  expect(selected.length).toBeGreaterThan(0);
  // The repo's only .spec.ts is an e2e file the globs never reach; a
  // selection that picks it up would hang the runner.
  expect(selected.filter((file) => file.endsWith(".spec.ts"))).toEqual([]);

  const counted = hostBash(`${UNIT_TEST_SELECTION} | wc -l`, REPO_ROOT).trim();
  expect(Number(counted)).toBe(selected.length);
}

async function checkWindowedRead(makeEngine: MakeEngine): Promise<void> {
  await withSandbox(makeEngine, undefined, async ({ handle, workspace }) => {
    await handle.writeFile(
      WINDOW_FILE,
      Array.from(
        { length: WINDOW_FILE_LINES },
        (_, index) => `conformance line ${index + 1}`,
      ).join("\n"),
    );
    const tools = buildTools(handle, workspace);
    const windowed = toolText(
      await invoke(tools, "read", {
        path: WINDOW_FILE,
        offset: 1,
        limit: WINDOW_LIMIT,
      }),
    );
    expect(windowed).toContain(
      `${WINDOW_LIMIT}:conformance line ${WINDOW_LIMIT}`,
    );
    // A window that ends before the file does is not truncation, and calling
    // it one makes models rewrite whole files they never saw the end of.
    expect(windowed).toContain("more line(s) not shown");
    expect(windowed).not.toContain("truncated");

    const whole = toolText(await invoke(tools, "read", { path: WINDOW_FILE }));
    expect(whole).toContain(
      `${WINDOW_FILE_LINES}:conformance line ${WINDOW_FILE_LINES}`,
    );
    expect(whole).not.toContain("more line(s) not shown");
  });
}

async function checkEditRejections(makeEngine: MakeEngine): Promise<void> {
  await withSandbox(makeEngine, undefined, async ({ handle, workspace }) => {
    await handle.writeFile(EDIT_FILE, EDIT_FILE_BODY);
    const tools = buildTools(handle, workspace);

    await expect(
      invoke(tools, "edit", {
        path: EDIT_FILE,
        edits: [{ oldText: "alpha", newText: "alpha" }],
      }),
    ).rejects.toThrow(/oldText equals newText/);

    // Naming the file is what lets an agent find its own mistake instead of
    // guessing which path it meant.
    await expect(
      invoke(tools, "edit", {
        path: EDIT_FILE,
        edits: [{ oldText: "absent-from-the-file", newText: "gamma" }],
      }),
    ).rejects.toThrow(new RegExp(EDIT_FILE));

    expect(String(await handle.readFile(EDIT_FILE))).toBe(EDIT_FILE_BODY);
  });
}

/**
 * bash must surface the exit code the agent branches on, both streams, and a
 * bounded tail: unbounded retention once grew a run to 3 GB RSS and wedged
 * the daemon.
 */
async function checkBashMessages(makeEngine: MakeEngine): Promise<void> {
  await withSandbox(makeEngine, undefined, async ({ handle, workspace }) => {
    const tools = buildTools(handle, workspace);

    // Exit 0 resolves; the numeric exit code is what the agent branches on,
    // and the wrapper turns any other code into a tool error.
    await invoke(tools, "bash", { command: "true" });
    await expect(invoke(tools, "bash", { command: "false" })).rejects.toThrow(
      /Command exited with code 1/,
    );

    const streams = toolText(
      await invoke(tools, "bash", {
        command: "printf 'OUT-MARKER\\n'; printf 'ERR-MARKER\\n' 1>&2",
      }),
    );
    expect(streams).toContain("OUT-MARKER");
    expect(streams).toContain("ERR-MARKER");

    // Under the cap: every byte the command produced is surfaced, with no
    // drop note. Over it: the tail plus a note naming the cap.
    const modest = toolText(
      await invoke(tools, "bash", { command: "seq 1 100" }),
    );
    expect(modest).toContain("1\n2");
    expect(modest).toContain("100");
    expect(modest).not.toContain("earlier output bytes dropped");

    const huge = toolText(
      await invoke(tools, "bash", { command: "seq 1 60000" }),
    );
    expect(huge).toContain("60000");
    expect(huge).toContain("earlier output bytes dropped");
    expect(huge).toContain(String(EXEC_TAIL_BYTES));
    expect(huge.length).toBeLessThanOrEqual(EXEC_TAIL_BYTES);
  });
}

/** Every other wrapper the agent prompts name, driven once through the seam. */
async function checkFileToolWrappers(makeEngine: MakeEngine): Promise<void> {
  await withSandbox(makeEngine, undefined, async ({ handle, workspace }) => {
    const tools = buildTools(handle, workspace);

    const wrote = toolText(
      await invoke(tools, "write", {
        path: TOOL_FILE,
        content: TOOL_FILE_BODY,
      }),
    );
    expect(wrote).toContain(`wrote ${TOOL_FILE}`);
    expect(String(await handle.readFile(TOOL_FILE))).toBe(TOOL_FILE_BODY);

    const grep = toolText(
      await invoke(tools, "grep", { pattern: "conformance-tools-body" }),
    );
    expect(grep).toContain(TOOL_FILE);

    // glob and ls are the SDK's own tools, routed through the sandbox
    // operations seam rather than the local filesystem.
    const glob = toolText(
      await invoke(tools, "find", { pattern: "**/*.txt", path: "." }),
    );
    expect(glob).toContain(TOOL_FILE);

    const ls = toolText(await invoke(tools, "ls", { path: "." }));
    expect(lines(ls)).toContain("nested");
  });
}

/**
 * Registers the sandbox conformance suite for one engine.
 *
 * Each `it` provisions its own workspace and destroys it, so tests are
 * independent; engines that provision real infrastructure pass `timeoutMs`,
 * which is applied per test.
 */
export function describeSandboxConformance(
  engineName: string,
  makeEngine: MakeEngine,
  opts: EngineTestOptions = {},
): void {
  const timeout = opts.timeoutMs;
  describe(`${engineName} sandbox conformance`, () => {
    it(
      "git pushes a branch with no per-command configuration",
      () => checkGitWorkflow(engineName, makeEngine),
      timeout,
    );
    it(
      "ships the pinned bun and node versions",
      () => checkPinnedVersions(makeEngine),
      timeout,
    );
    it(
      "unit-test selection stays spec-free and stable",
      () => checkUnitTestSelection(),
      timeout,
    );
    it(
      "a windowed read reports what remains and never says truncated",
      () => checkWindowedRead(makeEngine),
      timeout,
    );
    it(
      "edit rejects a no-op and names the file when oldText is missing",
      () => checkEditRejections(makeEngine),
      timeout,
    );
    it(
      "bash surfaces exit codes and a bounded stdout/stderr tail",
      () => checkBashMessages(makeEngine),
      timeout,
    );
    it(
      "write, grep, glob, and ls each work through their wrappers",
      () => checkFileToolWrappers(makeEngine),
      timeout,
    );
  });
}
