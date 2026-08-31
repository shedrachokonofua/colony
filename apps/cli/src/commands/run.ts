import type { ColonyClient } from "../client.js";
import type { ParsedCommand } from "../args.js";
import { ansi } from "../render.js";
import { formatDuration, runDurationMs } from "../../../../packages/console/duration.js";
import { statusCode } from "./scopes.js";

export interface RunDetail {
  id: string;
  scope_id: string;
  task_id: string | null;
  kind: string;
  model: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  failure_reason?: string | null;
  error?: string | null;
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
    `model:    ${r.model ?? "-"}`,
    `scope:    ${r.scope_id}`,
    `task:     ${r.task_id ?? "-"}`,
    `started:  ${r.started_at}`,
    `duration: ${ms === null ? "-" : formatDuration(ms)}`,
  ];
  const reason = r.failure_reason ?? r.error ?? null;
  if (reason) lines.push(`failure:  ${reason}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
