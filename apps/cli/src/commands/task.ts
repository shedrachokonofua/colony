import type { ColonyClient } from "../client.js";
import { stringFlag, UsageError, type ParsedCommand } from "../args.js";
import { readText } from "../io.js";
import { ansi, renderTable } from "../render.js";

export interface TaskRow {
  id: string;
  scope_id: string;
  title: string;
  spec: string;
  state: string;
  attempt: number;
  mr_iid: number | null;
  branch: string | null;
  blocked_reason: string | null;
}

interface TaskDetail {
  task: TaskRow;
  runs: {
    id: string;
    kind: string;
    model_id: string | null;
    status: string;
    started_at: string;
    finished_at: string | null;
  }[];
}

/** The task mutation verbs and the path segment each one posts to. */
const VERB_PATHS: Record<string, string> = {
  retry: "retry",
  stop: "stop",
  cancel: "cancel",
  restore: "restore",
  unblock: "unblock",
};

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const id = cmd.positional[0]!;
  const verb = cmd.positional[1];
  if (verb === undefined) return show(cmd, client, io, id);
  if (verb in VERB_PATHS) return mutate(cmd, client, io, id, VERB_PATHS[verb]!);
  if (verb === "amend") return amend(cmd, client, io, id);
  if (verb === "request-changes") return requestChanges(cmd, client, io, id);
  if (verb === "approve-merge") return approveMerge(cmd, client, io, id);
  throw new UsageError(`unknown task verb '${verb}'`);
}

/** `task <id>`: the task's state, attempt, MR and latest model. */
async function show(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
  id: string,
): Promise<number> {
  const detail = await client.get<TaskDetail>(
    `/tasks/${encodeURIComponent(id)}`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
    return 0;
  }
  const { task, runs } = detail;
  process.stdout.write(
    `${task.id}  ${ansi(io.isTty, stateCode(task.state), task.state)}  attempt ${task.attempt}${title(task)}\n`,
  );
  const lines = [
    ["scope", task.scope_id],
    ["branch", task.branch ?? "-"],
    ["mr", task.mr_iid === null ? "-" : `!${task.mr_iid}`],
    ["model", latestModel(runs)],
    ["blocked", task.blocked_reason ?? "-"],
  ];
  process.stdout.write(`${renderTable(["field", "value"], lines)}\n`);
  process.stdout.write(`\nspec: ${specSummary(task.spec)}\n`);
  return 0;
}

async function mutate(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
  id: string,
  path: string,
): Promise<number> {
  const task = await client.post<TaskRow>(
    `/tasks/${encodeURIComponent(id)}/${path}`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `${task.id}  ${ansi(io.isTty, stateCode(task.state), task.state)}  attempt ${task.attempt}\n`,
  );
  return 0;
}

/** `task <id> amend --spec <file|->`: append an authoritative spec amendment. */
async function amend(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
  id: string,
): Promise<number> {
  const spec = await readText(requiredFlag(cmd, "spec"));
  if (spec.trim() === "") {
    throw new UsageError("task amend needs non-empty --spec content");
  }
  const task = await client.post<TaskRow>(
    `/tasks/${encodeURIComponent(id)}/amend-spec`,
    // The server's amend-spec route shares the feedback body schema.
    { feedback: spec },
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `amended spec of ${task.id}  ${ansi(io.isTty, stateCode(task.state), task.state)}  attempt ${task.attempt}\n`,
  );
  return 0;
}

/** `task <id> request-changes --feedback <file|->`: requeue with feedback. */
async function requestChanges(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
  id: string,
): Promise<number> {
  const feedback = await readText(requiredFlag(cmd, "feedback"));
  if (feedback.trim() === "") {
    throw new UsageError("task request-changes needs non-empty --feedback");
  }
  const task = await client.post<TaskRow>(
    `/tasks/${encodeURIComponent(id)}/request-changes`,
    { feedback },
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `changes requested on ${task.id}  ${ansi(io.isTty, stateCode(task.state), task.state)}  attempt ${task.attempt}\n`,
  );
  return 0;
}

/**
 * `task <id> approve-merge --sha <sha>`: record the operator's approval to
 * merge at the MR head. The server reads the true MR head SHA from the
 * provider and takes no body; `--sha` stays in the parser as the operator's
 * recorded intent and is echoed here.
 */
async function approveMerge(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
  id: string,
): Promise<number> {
  const sha = stringFlag(cmd.flags, "sha");
  if (sha === undefined) {
    throw new UsageError("task approve-merge requires --sha <sha>");
  }
  const task = await client.post<TaskRow>(
    `/tasks/${encodeURIComponent(id)}/approve-merge`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `merge approved at ${sha}: ${task.id}  ${ansi(io.isTty, stateCode(task.state), task.state)}\n`,
  );
  return 0;
}

function requiredFlag(cmd: ParsedCommand, flag: string): string {
  const value = stringFlag(cmd.flags, flag);
  if (value === undefined) {
    throw new UsageError(
      `task ${cmd.positional[1]} requires --${flag} <file|->`,
    );
  }
  return value;
}

function title(task: TaskRow): string {
  return task.title ? `  ${task.title}` : "";
}

/** At most two lines of the spec; the full packet lives in `run <run-id>`. */
function specSummary(spec: string): string {
  const first = spec.split("\n").find((line) => line.trim() !== "");
  if (first === undefined) return "(empty)";
  const trimmed = first.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function latestModel(
  runs: { kind: string; model_id: string | null; finished_at: string | null }[],
): string {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i]!;
    if (run.model_id) return run.model_id;
  }
  return "-";
}

function stateCode(state: string): number {
  switch (state) {
    case "merged":
      return 32; // green
    case "running":
    case "mr_open":
      return 36; // cyan
    case "blocked":
    case "canceled":
      return 31; // red
    default:
      return 33; // yellow: queued
  }
}
