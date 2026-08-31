#!/usr/bin/env bun
/**
 * colony CLI entry point: parse argv, resolve credentials, dispatch.
 * Exit codes: 0 success, 1 API/network error, 2 usage error.
 */

import { homedir } from "node:os";
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
import * as runs from "./commands/runs.js";
import * as runDetail from "./commands/run.js";
import * as logs from "./commands/logs.js";
import * as artifacts from "./commands/artifacts.js";
import { context, run as projects } from "./commands/projects.js";
import * as audit from "./commands/audit.js";
import * as status from "./commands/status.js";

export interface CommandIo {
  json: boolean;
  isTty: boolean;
}

export type CommandModule = (
  cmd: ParsedCommand,
  client: ColonyClient,
  io: CommandIo,
) => Promise<number>;

/** Read commands only; mutation handlers land in a later slice. */
export const COMMANDS: Record<string, CommandModule> = {
  scopes: scopes.run,
  scope: scope.run,
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
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        process.stderr.write(
          `auth failed (${err.status}): ${describeTokenSource(credentials.source)} — check it, or set --token / ~/.config/colony/token\n`,
        );
        return 1;
      }
      process.stderr.write(`${err.code} (${err.status}): ${err.message}\n`);
      return 1;
    }
    if (err instanceof UsageError) return usage(err);
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`network error: ${message}\n`);
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

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(helpText());
  process.exit(0);
} else if (argv.length === 0) {
  process.stderr.write(helpText());
  process.exit(2);
} else {
  process.exit(await main(argv));
}
