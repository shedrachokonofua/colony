import type { ColonyClient } from "../client.js";
import { stringFlag, type ParsedCommand } from "../args.js";
import { renderTable } from "../render.js";

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  scope_id: string | null;
  task_id: string | null;
  run_id: string | null;
  detail_json: string;
}

interface AuditPage {
  events: AuditRow[];
  has_more: boolean;
  oldest_id: number | null;
  newest_id: number | null;
}

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const limit = Math.max(1, Number(stringFlag(cmd.flags, "n") ?? "25") || 25);
  const page = await client.get<AuditPage>("/audit", {
    scope_id: stringFlag(cmd.flags, "scope"),
    task_id: stringFlag(cmd.flags, "task"),
    limit,
  });
  const rows = page.events.slice(0, limit);
  if (io.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("no audit entries\n");
    return 0;
  }
  process.stdout.write(
    `${renderTable(
      ["id", "at", "actor", "action", "scope", "task"],
      rows.map((row) => [
        String(row.id),
        row.at,
        row.actor,
        row.action,
        row.scope_id ?? "-",
        row.task_id ?? "-",
      ]),
    )}\n`,
  );
  return 0;
}
