import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  provisionRepoWorkspace,
  type AgentRuntimePacket,
} from "@colony/agent-runtime";
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
    // exfiltrate provider tokens. Scrub both surfaces:
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

  try {
    const timeoutMs = input.perCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const results: ValidateResultEntry[] = [];
    let passed = true;
    for (const [index, acceptance] of input.acceptance.entries()) {
      const { exitCode, output } = runAcceptanceCommand(
        workspace,
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
 * Environment sanitized for acceptance commands: every key matching a
 * provider-credential pattern is removed, and GITLAB_TOKEN is never present.
 * This is a hard safety invariant for validate (credential-free runner).
 *
 * Acceptance commands are CI-like workloads against a fresh checkout, so the
 * daemon's runtime configuration must not leak into them:
 * - NODE_ENV is dropped (production made `npm ci` omit devDependencies —
 *   observed live as "Cannot find package 'vitest'").
 * - The entire COLONY_* namespace is dropped (observed live: the daemon's
 *   COLONY_OIDC_ISSUER booted the checkout's app under OIDC auth and an
 *   acceptance test got 401 where CI gets 200).
 * - CI=true and NO_COLOR=1 match pipeline behavior and keep evidence tails
 *   free of ANSI escapes.
 */
function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|OAUTH|API_KEY/i.test(key))
      continue;
    if (key === "NODE_ENV" || key.startsWith("COLONY")) continue;
    env[key] = value;
  }
  delete env["GITLAB_TOKEN"];
  env["CI"] = "true";
  env["NO_COLOR"] = "1";
  env["FORCE_COLOR"] = "0";
  return env;
}

function runAcceptanceCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
): { exitCode: number; output: string } {
  // Use spawnSync to capture BOTH stdout and stderr (combined). The spec
  // requires combined output for evidence tails — execFileSync only returns
  // stdout on success, losing stderr.
  const result = spawnSync(command, [], {
    cwd,
    shell: true,
    env: sanitizedEnv(),
    timeout: timeoutMs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Use a generous maxBuffer (10 MB) so that large command output
    // does not cause ENOBUFS. The tail is capped downstream by
    // tailOutput; here we just need to avoid killing the child.
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode =
    typeof result.status === "number" ? result.status : result.error ? 1 : 1;
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
