/** Pure CLI argument parsing: no I/O, no environment reads. */

export interface ParsedCommand {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface CommandSpec {
  readonly usage: string;
  /** Value flags the command itself requires, whatever its verb. */
  readonly required?: readonly string[];
  /** Presence-only flags. */
  readonly boolFlags?: readonly string[];
  /** Value flags; value maps an accepted spelling to its canonical name. */
  readonly valueFlags?: Readonly<Record<string, string>>;
  /** Second-positional verbs (`task <id> retry`). */
  readonly verbs?: Readonly<Record<string, VerbSpec>>;
  /** Alternate spellings mapped to their canonical flag name (`-f` → follow). */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Required positional count, excluding the subcommand. */
  readonly minPositional?: number;
}

interface VerbSpec {
  /** Value flags accepted only for this verb. */
  readonly valueFlags: readonly string[];
  readonly required?: readonly string[];
  readonly minPositional?: number;
}

const GLOBAL_VALUE_FLAGS: Record<string, string> = {
  server: "server",
  token: "token",
  actor: "actor",
};
const GLOBAL_BOOL_FLAGS = ["json"] as const;

const SPECS: Record<string, CommandSpec> = {
  scopes: {
    usage: "scopes [--project P] [--page N]",
    valueFlags: { project: "project", page: "page" },
  },
  scope: { usage: "scope <id>", minPositional: 1 },
  open: {
    usage:
      "open <file|-> [--title T] [--project P] [--repo PATH] [--manual] [--create-project]",
    minPositional: 1,
    valueFlags: { title: "title", project: "project", repo: "repo" },
    boolFlags: ["manual", "create-project"],
  },
  approve: { usage: "approve <id>", minPositional: 1 },
  replan: {
    usage: "replan <id> --feedback <file|->",
    minPositional: 1,
    valueFlags: { feedback: "feedback" },
    required: ["feedback"],
  },
  abandon: {
    usage: "abandon <id> [--yes]",
    minPositional: 1,
    boolFlags: ["yes"],
  },
  revalidate: { usage: "revalidate <id>", minPositional: 1 },
  task: {
    usage:
      "task <id> [retry|stop|cancel|restore|unblock] | task <id> amend --spec <file|-> | task <id> request-changes --feedback <file|-> | task <id> approve-merge --sha <sha>",
    minPositional: 1,
    verbs: {
      retry: { valueFlags: [] },
      stop: { valueFlags: [] },
      cancel: { valueFlags: [] },
      restore: { valueFlags: [] },
      unblock: { valueFlags: [] },
      amend: { valueFlags: ["spec"], required: ["spec"] },
      "request-changes": { valueFlags: ["feedback"], required: ["feedback"] },
      "approve-merge": { valueFlags: ["sha"], required: ["sha"] },
    },
  },
  runs: { usage: "runs <scope-id>", minPositional: 1 },
  run: { usage: "run <run-id>", minPositional: 1 },
  logs: {
    usage: "logs <run-id> [-f]",
    minPositional: 1,
    boolFlags: ["follow"],
    aliases: { f: "follow" },
  },
  artifacts: {
    usage: "artifacts <run-id> [get <artifact-id> -o FILE]",
    minPositional: 1,
    verbs: {
      get: { valueFlags: ["o", "output"], required: ["o"], minPositional: 2 },
    },
  },
  projects: { usage: "projects" },
  project: { usage: "project <name>", minPositional: 1 },
  context: {
    usage: "context <name> [--set <file|->]",
    minPositional: 1,
    valueFlags: { set: "set" },
  },
  audit: {
    usage: "audit [--scope S] [--task T] [-n N]",
    valueFlags: { scope: "scope", task: "task", n: "n" },
  },
  status: { usage: "status" },
};

export const SUBCOMMANDS: readonly string[] = Object.keys(SPECS);

/** Read a string-valued flag; absent, boolean or blank reads as undefined. */
export function stringFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function usageFor(command: string): string | undefined {
  return SPECS[command]?.usage;
}

/**
 * Parse argv into a command, its positionals (subcommand excluded) and flags.
 * Global flags are accepted before or after the subcommand.
 */
export function parseArgs(argv: string[]): ParsedCommand {
  const flags: Record<string, string | boolean> = {};
  const tokens: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-") || arg === "-") {
      tokens.push(arg);
      continue;
    }
    const body = arg.replace(/^--?/, "");
    const eq = body.indexOf("=");
    if (eq !== -1) {
      const key = flagKey(body.slice(0, eq), tokens);
      if (key === null) throw new UsageError(`unknown flag ${arg}`);
      flags[key] = body.slice(eq + 1);
      continue;
    }
    const key = flagKey(body, tokens);
    if (key === null) throw new UsageError(`unknown flag ${arg}`);
    if (isBoolFlag(body, tokens)) {
      flags[key] = true;
      continue;
    }
    // `-` is the stdin spelling for file-valued flags, not a following flag.
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith("-") && value !== "-")) {
      throw new UsageError(`flag ${arg} requires a value`);
    }
    flags[key] = value;
    i += 1;
  }

  return validate(tokens[0] ?? "", tokens.slice(1), flags);
}

/** Map a flag spelling to its canonical name, or null when unknown. */
function flagKey(body: string, tokens: string[]): string | null {
  if (body in GLOBAL_VALUE_FLAGS) return GLOBAL_VALUE_FLAGS[body];
  if ((GLOBAL_BOOL_FLAGS as readonly string[]).includes(body)) return body;
  const spec = SPECS[tokens[0] ?? ""];
  if (!spec) return null;
  if (verbFlags(spec, tokens)?.valueFlags.includes(body)) return body;
  const mapped = spec.valueFlags?.[body] ?? spec.aliases?.[body];
  if (mapped) return mapped;
  if (spec.boolFlags?.includes(body)) return body;
  return null;
}

function isBoolFlag(body: string, tokens: string[]): boolean {
  if ((GLOBAL_BOOL_FLAGS as readonly string[]).includes(body)) return true;
  const spec = SPECS[tokens[0] ?? ""];
  if (!spec) return false;
  const canonical = spec.aliases?.[body] ?? body;
  return spec.boolFlags?.includes(canonical) ?? false;
}

/** Verbs sit after the command's leading positional: `task <id> <verb>`. */
function verbFlags(spec: CommandSpec, tokens: string[]): VerbSpec | undefined {
  const verb = tokens[2];
  if (verb === undefined || !spec.verbs) return undefined;
  return spec.verbs[verb];
}

function validate(
  command: string,
  positional: string[],
  flags: Record<string, string | boolean>,
): ParsedCommand {
  const spec = command ? SPECS[command] : undefined;
  if (command === "") throw new UsageError("no command given");
  if (!spec) throw new UsageError(`unknown command '${command}'`);

  const verb =
    spec.verbs && positional[1] !== undefined
      ? spec.verbs[positional[1]]
      : undefined;
  if (spec.verbs && positional[1] !== undefined && !verb) {
    throw new UsageError(`unknown ${command} verb '${positional[1]}'`);
  }
  const minPositional =
    (spec.minPositional ?? 0) + ((verb?.minPositional ?? verb) ? 1 : 0);
  if (positional.length < minPositional) {
    throw new UsageError(`usage: ${spec.usage}`);
  }
  for (const required of spec.required ?? []) {
    if (flags[required] === undefined) {
      throw new UsageError(`${command} requires --${required}`);
    }
  }
  for (const required of verb?.required ?? []) {
    if (flags[required] === undefined) {
      throw new UsageError(
        `${command} ${positional[1]} requires --${required}`,
      );
    }
  }
  return { command, positional, flags };
}
