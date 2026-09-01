import type { ColonyClient } from "../client.js";
import type { ParsedCommand } from "../args.js";
import { ansi, renderTable } from "../render.js";
import {
  formatDuration,
  runDurationMs,
} from "../../../../packages/console/duration.js";
import { statusCode } from "./scopes.js";
import type { RunsRow } from "./scope.js";

interface ScopeDetail {
  runs: RunsRow[];
}

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const scopeId = cmd.positional[0];
  const detail = await client.get<ScopeDetail>(
    `/scopes/${encodeURIComponent(scopeId)}`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(detail.runs, null, 2)}\n`);
    return 0;
  }
  if (detail.runs.length === 0) {
    process.stdout.write("no runs\n");
    return 0;
  }
  const now = Date.now();
  const rows = detail.runs.map((r) => {
    const ms = runDurationMs(r, now);
    return [
      r.id,
      r.kind,
      r.model_id ?? "-",
      ansi(io.isTty, statusCode(r.status), r.status),
      ms === null ? "-" : formatDuration(ms),
    ];
  });
  process.stdout.write(
    `${renderTable(["run", "kind", "model", "status", "age"], rows)}\n`,
  );
  return 0;
}
