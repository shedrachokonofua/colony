import type { ColonyClient } from "../client.js";
import type { ParsedCommand } from "../args.js";
import { ansi } from "../render.js";
import {
  formatDuration,
  runDurationMs,
} from "../../../../packages/console/duration.js";
import { statusCode } from "./scopes.js";

export interface RunDetail {
  id: string;
  scope_id: string;
  task_id: string | null;
  kind: string;
  model_id: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  error?: string | null;
  evidence_json?: string | null;
}

interface RunEvidence {
  reason?: unknown;
  error?: unknown;
  results?: { command?: unknown; exit_code?: unknown }[];
}

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const id = cmd.positional[0];
  const r = await client.get<RunDetail>(`/runs/${encodeURIComponent(id)}`);
  if (io.json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }
  const ms = runDurationMs(r, Date.now());
  const lines = [
    `${r.id}  ${ansi(io.isTty, statusCode(r.status), r.status)}`,
    `kind:     ${r.kind}`,
    `model:    ${r.model_id ?? "-"}`,
    `scope:    ${r.scope_id}`,
    `task:     ${r.task_id ?? "-"}`,
    `started:  ${r.started_at}`,
    `duration: ${ms === null ? "-" : formatDuration(ms)}`,
  ];
  const reason = failureReason(r);
  if (reason) lines.push(`failure:  ${reason}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/**
 * The runs table has no failure_reason column; failures land in `error`, and
 * gate/validate failures leave that NULL and put the reason in evidence_json.
 */
function failureReason(run: RunDetail): string | null {
  if (run.error) return run.error;
  const evidence = parseEvidence(run.evidence_json);
  if (!evidence) return null;
  if (typeof evidence.reason === "string" && evidence.reason)
    return evidence.reason;
  if (typeof evidence.error === "string" && evidence.error)
    return evidence.error;
  const failed = (evidence.results ?? []).find(
    (result) => result.exit_code !== 0,
  );
  if (failed && typeof failed.command === "string")
    return `${failed.command} (exit ${failed.exit_code})`;
  return null;
}

function parseEvidence(raw: string | null | undefined): RunEvidence | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as RunEvidence;
  } catch {
    return null;
  }
}
