import type { ColonyClient } from "../client.js";
import type { ParsedCommand } from "../args.js";
import { ansi, renderTable } from "../render.js";
import { statusCode, type ScopeRow } from "./scopes.js";

export interface TaskRow {
  id: string;
  index: number;
  title: string;
  state: string;
  attempt: number;
  mr_iid: number | null;
  branch: string | null;
  model?: string | null;
}

export interface RunsRow {
  id: string;
  kind: string;
  model: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
}

interface ScopeDetail {
  scope: ScopeRow;
  project: { name: string; context_doc: string | null } | null;
  tasks: TaskRow[];
  deps: string[];
  runs: RunsRow[];
}

interface Plan {
  summary?: string;
  tasks?: { title?: string }[];
}

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const id = cmd.positional[0];
  const detail = await client.get<ScopeDetail>(
    `/scopes/${encodeURIComponent(id)}`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
    return 0;
  }
  const { scope, tasks, runs } = detail;

  process.stdout.write(
    `${scope.id}  ${ansi(io.isTty, statusCode(scope.status), scope.status)}  ${scope.title ?? "(untitled)"}\n`,
  );
  if (scope.project_name)
    process.stdout.write(`project: ${scope.project_name}\n`);
  process.stdout.write(`\ngoal: ${scope.goal}\n`);

  const plan = parsePlan(scope.plan_json);
  if (plan?.summary) {
    process.stdout.write(`\nplan: ${plan.summary}\n`);
    for (const [i, task] of (plan.tasks ?? []).entries()) {
      process.stdout.write(`  ${i + 1}. ${task.title ?? "(untitled)"}\n`);
    }
  } else if (scope.plan_json) {
    process.stdout.write(`\nplan (raw): ${scope.plan_json}\n`);
  }

  const acceptance = parseAcceptance(scope.acceptance_json);
  if (acceptance.length > 0) {
    process.stdout.write("\nacceptance:\n");
    for (const item of acceptance) process.stdout.write(`  - ${item}\n`);
  }
  const verdict = latestVerdict(runs);
  if (verdict) process.stdout.write(`\nvalidation: ${verdict}\n`);

  if (tasks.length > 0) {
    process.stdout.write("\n");
    const rows = tasks.map((task) => [
      task.id,
      ansi(io.isTty, statusCode(task.state), task.state),
      String(task.attempt),
      task.mr_iid === null ? "-" : `!${task.mr_iid}`,
      task.model ?? "-",
      task.title,
    ]);
    process.stdout.write(
      `${renderTable(["task", "state", "attempt", "mr", "model", "title"], rows)}\n`,
    );
  }
  if (runs.length > 0) {
    process.stdout.write("\nrecent runs:\n");
    const rows = runs
      .slice(-5)
      .map((r) => [
        r.id,
        r.kind,
        r.model ?? "-",
        ansi(io.isTty, statusCode(r.status), r.status),
      ]);
    process.stdout.write(
      `${renderTable(["run", "kind", "model", "status"], rows)}\n`,
    );
  }
  return 0;
}

function parsePlan(raw: string | null): Plan | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Plan;
  } catch {
    return null;
  }
}

function parseAcceptance(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item === "object" && item !== null) {
      const row = item as { description?: unknown; command?: unknown };
      if (typeof row.description === "string") return row.description;
      if (typeof row.command === "string") return row.command;
    }
    return String(item);
  });
}

/**
 * Validate runs carry their verdict in the scope's run rows only as status;
 * the per-criterion results live in the run's evidence, so surface the
 * coarse outcome here and let `run <id>` show the detail.
 */
function latestVerdict(runs: RunsRow[]): string | null {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i]!;
    if (run.kind !== "validate") continue;
    if (run.status === "running") return "validating...";
    return run.status === "succeeded" ? "passed" : `failed (${run.status})`;
  }
  return null;
}
