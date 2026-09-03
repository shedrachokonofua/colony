#!/usr/bin/env bun
/**
 * colony CLI entry point: parse argv, resolve credentials, dispatch.
 * Exit codes: 0 success, 1 API/network error, 2 usage error.
 */

import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  SUBCOMMANDS,
  UsageError,
  usageFor,
  type ParsedCommand,
} from "./args.js";
import {
  describeTokenSource,
  resolveActor,
  resolveCredentials,
  resolveServer,
} from "./auth.js";
import { ApiError, createClient, type ColonyClient } from "./client.js";
import { colorEnabled } from "./render.js";
import * as scopes from "./commands/scopes.js";
import * as scope from "./commands/scope.js";
import * as scopeMutations from "./commands/scope-mutations.js";
import * as open from "./commands/open.js";
import * as task from "./commands/task.js";
import * as runs from "./commands/runs.js";
import * as runDetail from "./commands/run.js";
import * as logs from "./commands/logs.js";
import * as artifacts from "./commands/artifacts.js";
import { context, run as projects } from "./commands/projects.js";
import * as audit from "./commands/audit.js";
import * as status from "./commands/status.js";
import { createTuiApp } from "./tui/app.js";

export interface CommandIo {
  json: boolean;
  isTty: boolean;
}

export type CommandModule = (
  cmd: ParsedCommand,
  client: ColonyClient,
  io: CommandIo,
) => Promise<number>;

/** Every CLI verb: reads plus the operator mutation commands. */
export const COMMANDS: Record<string, CommandModule> = {
  scopes: scopes.run,
  scope: scope.run,
  open: open.run,
  approve: scopeMutations.run,
  replan: scopeMutations.run,
  abandon: scopeMutations.run,
  revalidate: scopeMutations.run,
  pause: scopeMutations.run,
  resume: scopeMutations.run,
  task: task.run,
  runs: runs.run,
  run: runDetail.run,
  logs: logs.run,
  artifacts: artifacts.run,
  projects,
  project: projects,
  context,
  audit: audit.run,
  status: status.run,
};

export function helpText(): string {
  const lines = [
    "colony — control the colony control plane",
    "",
    "usage: colony [flags] <command> [args]",
    "",
    "commands:",
  ];
  for (const name of SUBCOMMANDS) {
    lines.push(`  ${usageFor(name) ?? name}`);
  }
  lines.push(
    "",
    "global flags:",
    "  --server <url>   colonyd base URL (default $COLONY_URL)",
    "  --token <t>      API token (default $COLONY_TOKEN, then token file)",
    "  --actor <a>      audited actor id (default $COLONY_ACTOR, $USER)",
    "  --json           machine-readable output on stdout",
  );
  return `${lines.join("\n")}\n`;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return usage(err);
  }

  const handler = COMMANDS[parsed.command];
  if (!handler) {
    process.stderr.write(
      `colony: '${parsed.command}' is not implemented yet\n`,
    );
    return 2;
  }

  let credentials;
  try {
    credentials = resolveCredentials(parsed.flags, process.env, homedir());
  } catch (err) {
    return usage(err);
  }

  const client = createClient({
    baseUrl: resolveServer(parsed.flags, process.env),
    token: credentials.token,
    actor: resolveActor(parsed.flags, process.env),
  });
  const io: CommandIo = {
    json: parsed.flags.json === true,
    isTty: colorEnabled(
      process.stdout.isTTY === true,
      process.env.NO_COLOR === undefined ? undefined : true,
    ),
  };

  try {
    return await handler(parsed, client, io);
  } catch (err) {
    if (err instanceof UsageError) return usage(err);
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        process.stderr.write(
          `auth failed (${err.status}): ${describeTokenSource(credentials.source)} — check it, or set --token / ~/.config/colony/token\n`,
        );
        return 1;
      }
      if (err.status === 0) {
        process.stderr.write(`network error: ${err.message}\n`);
        return 1;
      }
      process.stderr.write(`${err.code} (${err.status}): ${err.message}\n`);
      return 1;
    }
    // Command-side I/O (missing --set file, closed stdin, …), keep the
    // original prefix and stack; only the client wraps as ApiError.
    if (err instanceof Error) {
      process.stderr.write(`colony: ${err.stack ?? err.message}\n`);
      return 1;
    }
    process.stderr.write(`colony: ${String(err)}\n`);
    return 1;
  }
}

function usage(err: unknown): number {
  if (err instanceof UsageError) {
    process.stderr.write(`colony: ${err.message}\n\n${helpText()}`);
    return 2;
  }
  throw err;
}

/** True only when this file is the process entry point, not an import. */
function isDirectRun(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText());
    process.exit(0);
  } else if (argv.length === 0) {
    if (process.stdin.isTTY) {
      let credentials;
      try {
        credentials = resolveCredentials({}, process.env, homedir());
      } catch (err) {
        process.exit(usage(err));
      }
      const client = createClient({
        baseUrl: resolveServer({}, process.env),
        token: credentials.token,
        actor: resolveActor({}, process.env),
      });
      const clock = {
        now: () => Date.now(),
        sleep: (ms: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, ms)),
      };
      const app = createTuiApp({
        client,
        clock,
        out: (s) => process.stdout.write(s),
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      });
      await app.start();
      process.exit(0);
    } else {
      process.stderr.write(helpText());
      process.exit(2);
    }
  } else {
    process.exit(await main(argv));
  }
}
