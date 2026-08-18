import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  provisionRepoWorkspace,
  type AgentRuntimePacket,
} from "@colony/agent-runtime";
import {
  buildSandboxLaunchProfile,
  type ExecEvent,
  type SandboxEngine,
  type SandboxHandle,
} from "@colony/sandbox";
import { inProcessEngine } from "@colony/sandbox-in-process";
import type { Scope } from "@colony/core";
import type { ProviderProjectRef } from "@colony/provider";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import { buildCloneUrl } from "./merge-gate.js";

const VALIDATE_LEASE_MS = 30 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
const MAX_TAIL_LINES = 40;
const MAX_TAIL_BYTES = 8 * 1024;

export interface AcceptCommand {
  readonly description: string;
  readonly command: string;
}

export interface ValidateExecutionInput {
  readonly workspace: string;
  readonly cloneUrl: string;
  readonly displayUrl: string;
  readonly targetBranch: string;
  readonly acceptance: AcceptCommand[];
  readonly perCommandTimeoutMs?: number;
  /**
   * The default-branch HEAD SHA used as the packet's base_commit. Supplied
   * by runValidation; optional so unit tests may omit it for local clones.
   */
  readonly baseSha?: string;
  /**
   * Scope id that triggered the validation. Supplied by runValidation so
   * scripted fakes can implement per-scope fail-first semantics.
   */
  readonly scopeId?: string;
  /**
   * Sandbox engine used to provision the validate handle. Optional: defaults
   * to the in-process engine so the executor is directly callable from unit
   * tests without boot wiring.
   */
  readonly engine?: SandboxEngine;
}

export interface ValidateResultEntry {
  readonly index: number;
  readonly description: string;
  readonly command: string;
  readonly exit_code: number;
  readonly tail: readonly string[];
}

export interface ValidateResult {
  readonly results: readonly ValidateResultEntry[];
  readonly passed: boolean;
  readonly error?: string;
}

/**
 * Test seam: colonyd accepts an injected `validateExecutor`; the real
 * implementation lives in `defaultValidateExecutor`.
 */
export type ValidateExecutor = (
  input: ValidateExecutionInput,
) => Promise<ValidateResult>;

/**
 * Run the scope-level validation phase: clone the default branch at HEAD,
 * execute each acceptance command in a credential-free environment, and
 * transition the scope validating -> done only when every command passes.
 *
 * The run row is created synchronously before any async provider call so
 * that the tick's guard (hasValidateRun) prevents double dispatch, and any
 * provider/network failure is caught, finishes the run failed, and never
 * rejects the returned promise.
 */
export async function runValidation(
  ctx: ColonydContext,
  scope: Scope,
): Promise<void> {
  // Every dispatch site uses bare `void runValidation(...)`; a synchronous
  // throw anywhere in this function (observed live: startRun rejecting the
  // 'validate' kind on a pre-migration CHECK constraint) becomes an
  // unhandledRejection and kills the process. Nothing here may escape.
  try {
    await dispatchValidation(ctx, scope);
  } catch (err) {
    ctx.store.audit(SERVICE_ACTOR, "scope.validation_failed", {
      scope_id: scope.id,
      detail: {
        error: err instanceof Error ? err.message : String(err),
        stage: "dispatch",
      },
    });
  }
}

async function dispatchValidation(
  ctx: ColonydContext,
  scope: Scope,
): Promise<void> {
  // Materialized scopes always carry acceptance criteria; if one is missing
  // record a failed run so the guard prevents re-dispatch every tick.
  if (scope.acceptance_json === null) {
    const run = ctx.store.startRun({
      scope_id: scope.id,
      task_id: null,
      kind: "validate",
      lease_ttl_ms: VALIDATE_LEASE_MS,
      base_sha: "unknown",
    });
    ctx.store.finishRun(run.id, "failed", {
      error: "no acceptance criteria",
      evidence_json: JSON.stringify({
        head_sha: "unknown",
        results: [],
        passed: false,
        error: "no acceptance criteria",
      }),
    });
    ctx.store.audit(SERVICE_ACTOR, "scope.validation_failed", {
      scope_id: scope.id,
      run_id: run.id,
      detail: { error: "no acceptance criteria" },
    });
    return;
  }

  // Create the run row synchronously so guards see it immediately (prevents
  // double dispatch from concurrent ticks or revalidate POSTs).
  const project: ProviderProjectRef = {
    id: scope.provider_project_id,
    path: scope.provider_project_path,
  };
  let baseSha = "unknown";
  const run = ctx.store.startRun({
    scope_id: scope.id,
    task_id: null,
    kind: "validate",
    lease_ttl_ms: VALIDATE_LEASE_MS,
    base_sha: baseSha,
  });

  try {
    baseSha = (await ctx.provider.commits.get(project, scope.default_branch))
      .sha;
    ctx.store.setRunBaseSha(run.id, baseSha);

    ctx.store.audit(SERVICE_ACTOR, "run.start", {
      scope_id: scope.id,
      task_id: null,
      run_id: run.id,
      detail: { kind: "validate", head_sha: baseSha },
    });

    const execution = executeValidate(ctx, scope, project, run.id, baseSha);
    trackRun(run.id, execution, () => Promise.resolve());
    await execution;
  } catch (err) {
    // Provider or dispatch failure: finish the run failed and audit.
    const error = err instanceof Error ? err.message : String(err);
    ctx.store.finishRun(run.id, "failed", {
      head_sha: baseSha !== "unknown" ? baseSha : undefined,
      error,
      evidence_json: JSON.stringify({
        head_sha: baseSha,
        results: [],
        passed: false,
        error,
      }),
    });
    ctx.store.audit(SERVICE_ACTOR, "scope.validation_failed", {
      scope_id: scope.id,
      run_id: run.id,
      detail: { error, head_sha: baseSha },
    });
  }
}

async function executeValidate(
  ctx: ColonydContext,
  scope: Scope,
  project: ProviderProjectRef,
  runId: string,
  baseSha: string,
): Promise<void> {
  let result: ValidateResult;
  try {
    let acceptance: AcceptCommand[];
    try {
      const parsed = JSON.parse(scope.acceptance_json!);
      acceptance = Array.isArray(parsed)
        ? (parsed.filter(
            (c): c is AcceptCommand =>
              c &&
              typeof c === "object" &&
              typeof c.description === "string" &&
              typeof c.command === "string",
          ) as AcceptCommand[])
        : [];
    } catch {
      acceptance = [];
    }
    if (acceptance.length === 0) {
      throw new Error("acceptance criteria unparseable or empty");
    }

    const clone = buildCloneUrl(ctx, scope.provider_project_path);
    const executor = ctx.validateExecutor ?? defaultValidateExecutor;
    result = await executor({
      workspace: join("colonyd-validate", runId),
      cloneUrl: clone.cloneUrl,
      displayUrl: clone.displayUrl,
      targetBranch: scope.default_branch,
      acceptance,
      baseSha,
      scopeId: scope.id,
      engine: ctx.validateEngine,
    });
  } catch (err) {
    result = {
      results: [],
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const evidenceJson = JSON.stringify({
    head_sha: baseSha,
    results: result.results,
    passed: result.passed,
    error: result.error,
  });

  if (result.passed) {
    ctx.store.finishRun(runId, "succeeded", {
      head_sha: baseSha,
      evidence_json: evidenceJson,
    });
    ctx.store.audit(SERVICE_ACTOR, "scope.validated", {
      scope_id: scope.id,
      run_id: runId,
      detail: { head_sha: baseSha, results: result.results },
    });
    // Re-fetch the scope to avoid acting on a stale snapshot: the
    // operator may have restored/abandoned the scope while the
    // validation run was in flight. Only transition validating->done;
    // if the scope moved to a different status in the meantime, leave
    // it alone (the operator's action takes precedence).
    const currentScope = ctx.store.getScope(scope.id);
    if (currentScope && currentScope.status === "validating") {
      ctx.store.setScopeStatus(scope.id, "done", SERVICE_ACTOR);
    }
    return;
  }

  ctx.store.finishRun(runId, "failed", {
    head_sha: baseSha,
    evidence_json: evidenceJson,
  });
  const failing = result.results.find((r) => r.exit_code !== 0);
  ctx.store.audit(SERVICE_ACTOR, "scope.validation_failed", {
    scope_id: scope.id,
    run_id: runId,
    detail: {
      head_sha: baseSha,
      passed: false,
      error: result.error ?? null,
      failing_command: failing ?? null,
    },
  });
  // The scope stays `validating`. Validation is credential-free and there is
  // no automatic re-dispatch: the operator re-triggers via the revalidate
  // endpoint. No provider token is minted or revoked here.
}

// ---------------------------------------------------------------------------
// Real validate executor: fresh clone + credential-free acceptance command
// execution. DANGER: acceptance commands must never see provider credentials.
// ---------------------------------------------------------------------------

export const defaultValidateExecutor: ValidateExecutor = async (input) => {
  const engine = input.engine ?? inProcessEngine;
  let workspace = "";
  try {
    // Provision a fresh clone of the default branch at HEAD. Passing no
    // scratchDir (and a repo ref with credentials) makes provisionRepoWorkspace
    // clone rather than fall back to a scratch dir.
    const token = extractPassword(input.cloneUrl);
    const packet: AgentRuntimePacket = {
      repo: {
        url: input.cloneUrl,
        branch: input.targetBranch,
        base_commit: input.baseSha ?? input.targetBranch,
        credentials: token ? { token } : undefined,
      },
    };
    workspace = provisionRepoWorkspace(input.workspace, packet, {});

    // --- Credential scrubbing (hard safety invariant) ---
    // provisionRepoWorkspace writes PACKET.json containing credentials and
    // the clone's .git/config remote.origin.url carries the embedded token.
    // Acceptance commands run with cwd=workspace and MUST NOT be able to
    // exfiltrate provider tokens. Scrub both surfaces BEFORE the workspace
    // reaches the sandbox handle (k8s transfers the workspace tar inside
    // engine.provision, so a pre-provision leak would ship the token):
    scrubWorkspaceCredentials(workspace, input.displayUrl);
  } catch (err) {
    // Clean up a provisioned-but-unscrubbed workspace: it may still hold
    // credential artifacts and must never survive a scrub failure.
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    return {
      results: [],
      passed: false,
      error: `workspace_provision_failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let handle: SandboxHandle | undefined;
  try {
    // Provision the sandbox handle from the engine seam. The validate launch
    // profile's envAllowlist is what keeps the daemon's environment out of
    // acceptance commands (credential cleanliness by construction).
    handle = await engine.provision(
      buildSandboxLaunchProfile("validate"),
      workspace,
    );
  } catch (err) {
    // Provision or transfer failure: record evidence, never reject.
    await handle?.destroy().catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
    return {
      results: [],
      passed: false,
      error: `workspace_provision_failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  try {
    const timeoutMs = input.perCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const results: ValidateResultEntry[] = [];
    let passed = true;
    for (const [index, acceptance] of input.acceptance.entries()) {
      const { exitCode, output } = await runAcceptanceViaHandle(
        handle,
        acceptance.command,
        timeoutMs,
      );
      results.push({
        index,
        description: acceptance.description,
        command: acceptance.command,
        exit_code: exitCode,
        tail: tailOutput(output),
      });
      if (exitCode !== 0) passed = false;
    }
    return { results, passed };
  } catch (err) {
    return {
      results: [],
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await handle?.destroy().catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
  }
};

/**
 * Remove credential-bearing artifacts from the workspace so acceptance
 * commands cannot exfiltrate tokens:
 * - Delete PACKET.json (contains credential-embedded URLs).
 * - Rewrite .git/config remote.origin.url to the display URL (no token).
 * - Delete .git/credentials or any credential helper cache files.
 */
export function scrubWorkspaceCredentials(
  workspace: string,
  displayUrl: string,
): void {
  const packetPath = join(workspace, "PACKET.json");
  if (existsSync(packetPath)) {
    rmSync(packetPath, { force: true });
  }

  // Scrub the git remote URL: replace the credential-embedded origin URL
  // with the display URL (no username/password). Using git remote set-url
  // also updates the reflog/config cleanly.
  try {
    execFileSync("git", ["remote", "set-url", "origin", displayUrl], {
      cwd: workspace,
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    // If git is unavailable or the remote doesn't exist, fall through —
    // the credential-free env sanitization is the primary barrier.
  }

  // Remove any credential store files git might have written.
  const credPaths = [
    join(workspace, ".git", "credentials"),
    join(workspace, ".git", "credential"),
  ];
  for (const p of credPaths) {
    if (existsSync(p)) {
      rmSync(p, { force: true });
    }
  }
}

/**
 * Run one acceptance command through a provisioned SandboxHandle.
 *
 * Env cleanliness is by construction: the validate launch profile's
 * envAllowlist governs what reaches the child (the engine's buildEnv drops
 * every daemon env var not on the allowlist), so no regex scrubbing is
 * needed. The request overrides CI/NO_COLOR/FORCE_COLOR, all of which are
 * on the validate allowlist, to match pipeline behavior and keep evidence
 * tails free of ANSI escapes.
 */
async function runAcceptanceViaHandle(
  handle: SandboxHandle,
  command: string,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  let stdout = "";
  let stderr = "";
  const onEvent = (event: ExecEvent): void => {
    if (event.kind === "stdout") stdout += event.data;
    else if (event.kind === "stderr") stderr += event.data;
  };
  const result = await handle.exec(
    {
      command,
      timeoutMs,
      env: { CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" },
    },
    onEvent,
  );
  // null exitCode means the process never exited (timeout / kill).
  const exitCode = result.exitCode ?? 1;
  return { exitCode, output: `${stdout}${stderr}` };
}

/** Strip ANSI escape sequences so evidence tails stay readable in the console. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

function tailOutput(output: string): string[] {
  const stripped = stripAnsi(output);
  const capped =
    stripped.length > MAX_TAIL_BYTES
      ? stripped.slice(-MAX_TAIL_BYTES)
      : stripped;
  const lines = capped.split("\n");
  return lines.slice(Math.max(0, lines.length - MAX_TAIL_LINES));
}

function extractPassword(url: string): string | undefined {
  try {
    return new URL(url).password || undefined;
  } catch {
    return undefined;
  }
}
