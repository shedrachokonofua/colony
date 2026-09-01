import { readSync } from "node:fs";
import type { ColonyClient } from "../client.js";
import { stringFlag, UsageError, type ParsedCommand } from "../args.js";
import { readText } from "../io.js";
import { ansi } from "../render.js";
import { statusCode, type ScopeRow } from "./scopes.js";

export async function run(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  switch (cmd.command) {
    case "approve":
      return approve(cmd, client, io);
    case "replan":
      return replan(cmd, client, io);
    case "abandon":
      return abandon(cmd, client, io);
    case "revalidate":
      return revalidate(cmd, client, io);
    default:
      throw new UsageError(`unknown command '${cmd.command}'`);
  }
}

/** `approve <scope-id>`: materialize the pending plan into tasks. */
async function approve(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const res = await client.post<{ scope: ScopeRow }>(
    `/scopes/${encodeURIComponent(cmd.positional[0]!)}/approve-plan`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(statusLine(res.scope, io.isTty));
  return 0;
}

/** `replan <scope-id> --feedback <file|->`: reject the plan with feedback. */
async function replan(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const feedback = await readFeedback(cmd, "feedback");
  const scope = await client.post<ScopeRow>(
    `/scopes/${encodeURIComponent(cmd.positional[0]!)}/replan`,
    { feedback },
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(scope, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(statusLine(scope, io.isTty));
  return 0;
}

/** `abandon <scope-id>`: confirm, then abandon the scope and its tasks. */
async function abandon(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const id = cmd.positional[0]!;
  if (cmd.flags.yes !== true) {
    if (!io.isTty) {
      throw new UsageError(
        "abandon is destructive — pass --yes, or run it on a TTY to confirm",
      );
    }
    if (!confirm(`Abandon scope ${id}? [y/N] `)) {
      process.stdout.write("aborted\n");
      return 0;
    }
  }
  const scope = await client.post<ScopeRow>(
    `/scopes/${encodeURIComponent(id)}/abandon`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(scope, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(statusLine(scope, io.isTty));
  return 0;
}

/** `revalidate <scope-id>`: run scope acceptance validation again. */
async function revalidate(
  cmd: ParsedCommand,
  client: ColonyClient,
  io: { json: boolean; isTty: boolean },
): Promise<number> {
  const scope = await client.post<ScopeRow>(
    `/scopes/${encodeURIComponent(cmd.positional[0]!)}/revalidate`,
  );
  if (io.json) {
    process.stdout.write(`${JSON.stringify(scope, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(statusLine(scope, io.isTty));
  return 0;
}

async function readFeedback(cmd: ParsedCommand, flag: string): Promise<string> {
  const source = stringFlag(cmd.flags, flag);
  if (source === undefined) {
    throw new UsageError(`${cmd.command} requires --${flag} <file|->`);
  }
  const text = await readText(source);
  if (text.trim() === "") {
    throw new UsageError(
      `${cmd.command} needs non-empty feedback — the server rejects an empty ${flag}`,
    );
  }
  return text;
}

/** One-line scope outcome with the status colorized on a TTY. */
function statusLine(scope: ScopeRow, isTty: boolean): string {
  const status = ansi(isTty, statusCode(scope.status), scope.status);
  const title = scope.title ? ` — ${scope.title}` : "";
  return `${scope.id}  ${status}${title}\n`;
}

/** Read the operator's y/N answer from the terminal. */
function confirm(prompt: string): boolean {
  process.stdout.write(prompt);
  const buf = Buffer.alloc(256);
  let n = 0;
  try {
    n = readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  const line = buf.subarray(0, n).toString("utf8");
  const answer = (
    line.includes("\n") ? line.slice(0, line.indexOf("\n")) : line
  ).trim();
  return answer === "y" || answer === "Y";
}
