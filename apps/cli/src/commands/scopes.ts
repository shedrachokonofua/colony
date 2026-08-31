import type { ColonyClient } from "../client.js";
import { stringFlag, type ParsedCommand } from "../args.js";
import { ansi, renderTable } from "../render.js";

export interface ScopeRow {
  id: string;
  title: string | null;
  status: string;
  project_name: string | null;
  created_at: string;
  goal: string;
  plan_json: string | null;
  acceptance_json?: string | null;
}

interface ScopesResponse {
  scopes: ScopeRow[];
  total: number;
  limit: number;
  offset: number;
  projects: string[];
}

export const SCOPES_PAGE_SIZE = 25;

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const page = Math.max(1, Number(stringFlag(cmd.flags, "page") ?? "1") || 1);
  const project = stringFlag(cmd.flags, "project");
  const res = await client.get<ScopesResponse>("/scopes", {
    limit: SCOPES_PAGE_SIZE,
    offset: (page - 1) * SCOPES_PAGE_SIZE,
    project,
  });
  if (io.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  if (res.scopes.length === 0) {
    process.stdout.write("no scopes\n");
    return 0;
  }
  const rows = res.scopes.map((scope) => [
    scope.id,
    ansi(io.isTty, statusCode(scope.status), scope.status),
    scope.title ?? "(untitled)",
    scope.created_at,
  ]);
  process.stdout.write(
    `${renderTable(["id", "status", "title", "created"], rows)}\n`,
  );
  process.stdout.write(
    `${res.scopes.length} of ${res.total} scopes (page ${page})\n`,
  );
  return 0;
}

export function statusCode(status: string): number {
  switch (status) {
    case "done":
    case "merged":
      return 32; // green
    case "active":
    case "running":
    case "validating":
      return 36; // cyan
    case "blocked":
    case "failed":
      return 31; // red
    case "abandoned":
    case "canceled":
      return 90; // bright black
    default:
      return 33; // yellow: draft / planning
  }
}
