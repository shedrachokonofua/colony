import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
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
 */
export async function runValidation(
  ctx: ColonydContext,
  scope: Scope,
): Promise<void> {
  // Materialized scopes always carry acceptance criteria; if one is missing
  // record the failure and leave the scope validating for the operator.
  if (scope.acceptance_json === null) {
    ctx.store.audit(SERVICE_ACTOR, "scope.validation_failed", {
      scope_id: scope.id,
      detail: { error: "no acceptance criteria" },
    });
    return;
  }

  const project: ProviderProjectRef = {
    id: scope.provider_project_id,
    path: scope.provider_project_path,
  };
  const baseSha = (
    await ctx.provider.commits.get(project, scope.default_branch)
  ).sha;

  const run = ctx.store.startRun({
    scope_id: scope.id,
    task_id: null,
    kind: "validate",
    lease_ttl_ms: VALIDATE_LEASE_MS,
    base_sha: baseSha,
  });
  ctx.store.audit(SERVICE_ACTOR, "run.start", {
    scope_id: scope.id,
    task_id: null,
    run_id: run.id,
    detail: { kind: "validate", head_sha: baseSha },
  });

  const execution = executeValidate(ctx, scope, project, run.id, baseSha);
  trackRun(run.id, execution, () => Promise.resolve());
  await execution;
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
    ctx.store.finishRun(runId, "succeeded", { evidence_json: evidenceJson });
    ctx.store.audit(SERVICE_ACTOR, "scope.validated", {
      scope_id: scope.id,
      run_id: runId,
      detail: { head_sha: baseSha, results: result.results },
    });
    ctx.store.setScopeStatus(scope.id, "done", SERVICE_ACTOR);
    return;
  }

  ctx.store.finishRun(runId, "failed", { evidence_json: evidenceJson });
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
  } catch (err) {
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
 * Environment sanitized for acceptance commands: every key matching a
 * provider-credential pattern is removed, and GITLAB_TOKEN is never present.
 * This is a hard safety invariant for validate (credential-free runner).
 */
function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|OAUTH|API_KEY/i.test(key))
      continue;
    env[key] = value;
  }
  delete env["GITLAB_TOKEN"];
  return env;
}

function runAcceptanceCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
): { exitCode: number; output: string } {
  try {
    const stdout = execFileSync(command, {
      cwd,
      shell: true,
      env: sanitizedEnv(),
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_TAIL_BYTES * 8,
    });
    return { exitCode: 0, output: String(stdout ?? "") };
  } catch (err) {
    const e = err as {
      status?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      timedOut?: boolean;
    };
    const stdout =
      typeof e.stdout === "string"
        ? e.stdout
        : e.stdout instanceof Buffer
          ? e.stdout.toString("utf8")
          : "";
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr instanceof Buffer
          ? e.stderr.toString("utf8")
          : "";
    const exitCode =
      typeof e.status === "number"
        ? e.status
        : e.timedOut
          ? 124
          : err instanceof Error
            ? 1
            : 1;
    return { exitCode, output: `${stdout}${stderr}` };
  }
}

function tailOutput(output: string): string[] {
  const capped =
    output.length > MAX_TAIL_BYTES ? output.slice(-MAX_TAIL_BYTES) : output;
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
