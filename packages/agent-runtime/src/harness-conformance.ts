import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  complete,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Tool,
  type ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import {
  ModelRegistry,
  discoverAuthStorage,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import { buildSandboxLaunchProfile, type SandboxHandle } from "@colony/sandbox";
import type { RunAuditSink } from "./audit-sink.js";
import { buildSandboxTools } from "./sandbox-tools.js";
import {
  createImplementerSubmitTool,
  createReviewerSubmitTool,
} from "./pi-runner-common.js";
import {
  createArchitectSubmitTool,
  createPlanReviewSubmitTool,
} from "./architect-stages.js";

/**
 * Live model-harness conformance: can every model a role may be routed to
 * actually drive Colony's tool harness, through the real gateway?
 *
 * A model that reads a file with `bash cat` instead of the `read` tool, or
 * that submits an envelope the schema rejects and retries, looks healthy on
 * run-level metrics while quietly burning turns, quota, and wall clock. This
 * module measures the capability directly: one scripted mini-task per
 * model x role, each capability asserted against the tool-call log the
 * harness recorded.
 *
 * The result is a REPORT — nothing here edits routing, config, or a model
 * chain. A failing capability is recorded and returned; the caller decides
 * what a failure means (the nightly job fails the pipeline on it).
 */

/** A scripted mini-task must finish well inside a real run's budget. */
export const MAX_HARNESS_TURNS = 20;

/** Wall-clock ceiling for one model x role mini-task, in minutes. */
export const MAX_HARNESS_MINUTES = 10;

/**
 * One capability of the harness a model must exercise with the tool that owns
 * it. `submit` is last: it is the only capability whose tool call ends the
 * run, so a model that never reaches it spent the whole budget for nothing.
 */
export type HarnessCapability =
  | "read"
  | "grep"
  | "edit"
  | "write"
  | "bash"
  | "submit";

export const HARNESS_CAPABILITIES: readonly HarnessCapability[] = [
  "read",
  "grep",
  "edit",
  "write",
  "bash",
  "submit",
];

/**
 * One measured outcome. `turns` is the whole mini-task's turn count, so the
 * table answers how expensive this model is at this harness as well as
 * whether it works at all.
 */
export interface ModelConformanceRow {
  model: string;
  role: string;
  capability: HarnessCapability;
  pass: boolean;
  turns: number;
}

/** Repo root: src/ -> agent-runtime/ -> packages/ -> root. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The production agent config: it owns every role's model chain. */
const DEPLOY_CONFIG_PATH = join(REPO_ROOT, "config", "colony.deploy.yaml");

/** The single source of truth for the pinned toolchain. */
const VERSIONS_FILE = join(REPO_ROOT, "colony-versions.json");

/** Gateway every Colony route goes through. */
const DEFAULT_GATEWAY_BASE_URL = "https://litellm.home.shdr.ch/v1";

/** Provider id Colony registers for the gateway's OpenAI-compatible API. */
const GATEWAY_PROVIDER = "openai_compatible";

/** The roles a nightly conformance run walks. */
export const HARNESS_ROLES: readonly string[] = [
  "developer",
  "reviewer",
  "plan_reviewer",
  "architect",
  "memory_consolidator",
];

/**
 * The memory consolidator has no envelope of its own in this repo; it is a
 * low-thinking summarizer over the developer's harness, so its mini-task
 * borrows the developer's submit tool. Anything else would be inventing a
 * contract the runtime does not have.
 */
const MEMORY_ROLE = "memory_consolidator";

/** File the mini-task reads and edits, and the symbol it greps for. */
const READ_FILE = "harness-notes.txt";
const READ_FILE_BODY = "alpha\nbeta\ngamma\n";
const GREP_SYMBOL = "harness-marker";
const GREP_FILE = "harness-source.ts";
const GREP_FILE_BODY = `export const ${GREP_SYMBOL.replaceAll("-", "_")} = 1;\n`;
const WRITE_FILE = "harness-written.txt";
const WRITE_MARKER = "harness-write-marker";
const BASH_MARKER = "harness-bash-marker";
const EDIT_OLD = "beta";
const EDIT_NEW = "beta-edited";

/** A 40-hex SHA, because the envelope schemas demand one. */
const HEAD_SHA = "0".repeat(40);

interface DeployRoleChain {
  readonly model: string;
  readonly fallbackModels: readonly string[];
}

/**
 * A minimal hand parser for the `agents:` section of colony.deploy.yaml.
 *
 * A YAML dependency would add a bun.lock entry this task does not own, and
 * the section read here is a two-level map (`role:` then `model:` /
 * `fallback_models:`), so a line scanner is sufficient and honest about its
 * scope: it descends into the top-level `agents:` block, treats the next
 * level's keys as role names, and reads only `model:` and `fallback_models:`
 * (block sequence or inline flow sequence) under them.
 */
export function parseDeployRoleChains(
  yaml: string,
): Record<string, DeployRoleChain> {
  const roles: Record<string, DeployRoleChain> = {};
  const lines = yaml.split("\n");
  let start = 0;
  while (start < lines.length && !/^agents:/.test(lines[start]!)) start += 1;
  if (start >= lines.length) return roles;

  const agentsIndent = indentOf(lines[start]!);
  let currentRole: string | undefined;
  let model = "";
  let fallbacks: string[] = [];

  const closeRole = (): void => {
    if (currentRole !== undefined) {
      roles[currentRole] = { model, fallbackModels: [...fallbacks] };
    }
    currentRole = undefined;
    model = "";
    fallbacks = [];
  };

  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    const indent = indentOf(raw);
    const line = stripComment(raw.trim());
    if (line === "") continue;
    // A key at or left of `agents:` ends the block: only the `agents:`
    // section's own children are roles.
    if (indent <= agentsIndent) break;

    if (indent === agentsIndent + ROLE_INDENT) {
      const role = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
      closeRole();
      if (role) currentRole = role[1]!;
      continue;
    }
    if (currentRole === undefined || indent < agentsIndent + ROLE_INDENT) {
      continue;
    }

    const modelMatch = /^model:\s*(.+?)\s*$/.exec(line);
    if (modelMatch) {
      model = unquote(modelMatch[1]!);
      continue;
    }
    const inline = /^fallback_models:\s*(\[.*\])\s*$/.exec(line);
    if (inline) {
      fallbacks.push(...parseFlowSequence(inline[1]!));
      continue;
    }
    if (/^fallback_models:\s*$/.test(line)) {
      // Consume the block sequence that follows, whether it is indented
      // under the key or flush with it (both are legal YAML).
      while (i + 1 < lines.length) {
        const next = stripComment(lines[i + 1]!.trim());
        if (next === "") {
          i += 1;
          continue;
        }
        if (indentOf(lines[i + 1]!) <= indent) break;
        const opened = /^\[(.*)$/.exec(next);
        if (opened) {
          // A multi-line flow sequence: gather until its closing bracket.
          i += 1;
          const parts = [opened[1]!];
          while (i + 1 < lines.length && !parts.join(" ").includes("]")) {
            i += 1;
            parts.push(stripComment(lines[i]!.trim()));
          }
          fallbacks.push(...parseFlowSequence(`[${parts.join(" ")}`));
          continue;
        }
        const item = /^-\s*(.+?)\s*$/.exec(next);
        if (!item) break;
        fallbacks.push(unquote(item[1]!));
        i += 1;
      }
      continue;
    }
  }
  closeRole();
  return roles;
}

/** Indentation of a line, counting only spaces (this file uses spaces). */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Role keys sit one level below `agents:`, which this file indents by 2. */
const ROLE_INDENT = 2;

/** Drops a trailing `#` comment that is not inside quotes. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, i).trimEnd();
  }
  return line;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0]!;
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Entries of a `[a, b, c]` flow sequence, already joined into one string. */
function parseFlowSequence(joined: string): string[] {
  const end = joined.indexOf("]");
  const body = joined.slice(1, end === -1 ? joined.length : end);
  return body
    .split(",")
    .map((entry) => unquote(entry))
    .filter((entry) => entry.length > 0);
}

/**
 * The model chain per role, in failover order and deduplicated. A model that
 * leads the developer chain and also falls back for the reviewer is measured
 * under both roles: the role decides which envelope it must submit.
 */
export function roleModelChains(
  chains: Record<string, DeployRoleChain>,
  roles: readonly string[] = HARNESS_ROLES,
): { role: string; models: readonly string[] }[] {
  return roles.map((role) => {
    const chain = chains[role];
    const models = chain
      ? [chain.model, ...chain.fallbackModels].filter((m) => m.length > 0)
      : [];
    return { role, models: [...new Set(models)] };
  });
}

/** The pinned toolchain, in both spellings the assertions compare. */
export interface PinnedVersions {
  readonly bun: string;
  readonly nodeWithV: string;
}

export async function readPinnedVersions(): Promise<PinnedVersions> {
  const parsed = JSON.parse(await readFile(VERSIONS_FILE, "utf8")) as {
    bun?: unknown;
    node?: unknown;
  };
  const bun = typeof parsed.bun === "string" ? parsed.bun : "";
  const node = typeof parsed.node === "string" ? parsed.node : "";
  return {
    bun,
    // colony-versions.json pins node with the leading v ("v24.20.0"); a
    // runtime reports it without. Normalize to the pinned spelling so the
    // two sides of every comparison read the same.
    nodeWithV: node.startsWith("v") || node === "" ? node : `v${node}`,
  };
}

/**
 * Markdown table: one row per capability, one column per measured
 * model x role, so a reader sees at a glance which capability a model drops
 * in which role.
 *
 * The column key is the model AND its role, not the model alone: the same
 * model leads one role's chain and falls back for another, and collapsing
 * those into one column would report whichever row happened to land last.
 * `turns` is the whole mini-task's count — the cost of that run, not of one
 * capability.
 */
export function writeConformanceTable(
  rows: readonly ModelConformanceRow[],
): string {
  // Column order is first appearance, which is the sweep's own order: roles
  // in config order, models in failover order within each role.
  const columns: string[] = [];
  const passOf = new Map<string, boolean>();
  const turnsOf = new Map<string, number>();
  for (const row of rows) {
    const column = `${row.model} (${row.role})`;
    if (!turnsOf.has(column)) {
      columns.push(column);
      turnsOf.set(column, row.turns);
    }
    passOf.set(`${column}|${row.capability}`, row.pass);
  }
  const header = ["capability", ...columns.map((column) => `\`${column}\``)];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const capability of HARNESS_CAPABILITIES) {
    const cells = columns.map((column) => {
      const pass = passOf.get(`${column}|${capability}`);
      return pass === undefined ? "n/a" : pass ? "PASS" : "FAIL";
    });
    lines.push(`| ${[capability, ...cells].join(" | ")} |`);
  }
  lines.push(
    `| ${[
      "turns",
      ...columns.map((column) => String(turnsOf.get(column) ?? "n/a")),
    ].join(" | ")} |`,
  );
  return `${lines.join("\n")}\n`;
}

/** The audit-facing knobs of one sweep. */
export interface HarnessConformanceOptions {
  readonly auditSink?: RunAuditSink;
  readonly runId?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly roles?: readonly string[];
  /** Per-model-request timeout; the outer wall is {@link MAX_HARNESS_MINUTES}. */
  readonly requestTimeoutMs?: number;
  /** Scratch root for the mini-task workspaces; tests shrink it. */
  readonly workspaceRoot?: string;
}

/**
 * Runs the live conformance sweep: one scripted mini-task per model x role
 * through the real gateway, then the audit seam.
 *
 * A failing capability never throws — the failure IS the finding, reported
 * through the returned rows, the `harness.conformance` event, and the
 * artifact. It throws only when the sweep cannot run at all (no credential,
 * unreadable config), because a silently empty table reads as all green.
 */
export async function runHarnessConformance(
  options: HarnessConformanceOptions = {},
): Promise<readonly ModelConformanceRow[]> {
  const versions = await readPinnedVersions();
  const chains = parseDeployRoleChains(
    await readFile(DEPLOY_CONFIG_PATH, "utf8"),
  );
  const rows: ModelConformanceRow[] = [];
  for (const { role, models } of roleModelChains(
    chains,
    options.roles ?? HARNESS_ROLES,
  )) {
    for (const model of models) {
      const outcome = await runMiniTask(model, role, {
        versions,
        baseUrl: options.baseUrl ?? DEFAULT_GATEWAY_BASE_URL,
        apiKey: options.apiKey,
        requestTimeoutMs: options.requestTimeoutMs,
        workspaceRoot: options.workspaceRoot,
      });
      for (const capability of HARNESS_CAPABILITIES) {
        rows.push({
          model,
          role,
          capability,
          pass: outcome.capabilities[capability] === true,
          turns: outcome.turns,
        });
      }
    }
  }
  const runId = options.runId ?? `harness-conformance-${Date.now()}`;
  const table = writeConformanceTable(rows);
  options.auditSink?.appendEvent(runId, "harness.conformance", {
    rows,
    maxTurns: MAX_HARNESS_TURNS,
    maxMinutes: MAX_HARNESS_MINUTES,
  });
  await options.auditSink?.putArtifact(
    runId,
    "harness",
    "harness-conformance-table.md",
    new TextEncoder().encode(table),
    "text/markdown",
  );
  return rows;
}

/** One mini-task's measurement. */
export interface MiniTaskOutcome {
  readonly capabilities: Partial<Record<HarnessCapability, boolean>>;
  readonly turns: number;
  readonly wallMs: number;
  readonly submitAttempts: number;
  readonly detail?: string;
}

/**
 * Resolves the role's submit tool: the envelope a model must land on the
 * first try is the one its own role submits in production. The memory
 * consolidator has no envelope of its own in this repo — it is a
 * low-thinking summarizer over the same harness — so it submits the
 * developer's rather than invent a contract the runtime does not have.
 */
function submitForRole(
  role: string,
  capture: (value: unknown) => void,
): ToolDefinition {
  switch (role) {
    case "reviewer":
      return createReviewerSubmitTool(capture);
    case "plan_reviewer":
      return createPlanReviewSubmitTool(capture);
    case "architect":
      return createArchitectSubmitTool(capture);
    case MEMORY_ROLE:
    case "developer":
    default:
      return createImplementerSubmitTool(capture);
  }
}

/**
 * Resolves one gateway model name into the SDK model the transport needs.
 *
 * The registry owns provider compatibility — it is what every production run
 * resolves through — so a model that fails here fails the way a run would.
 * Registering the gateway as a provider is also what routes the request at
 * the real base_url instead of the SDK's bundled catalog.
 */
async function resolveGatewayModel(
  model: string,
  baseUrl: string,
  apiKey: string,
): Promise<Model<"openai-completions">> {
  const registry = new ModelRegistry(await discoverAuthStorage());
  registry.registerProvider(GATEWAY_PROVIDER, {
    apiKey,
    api: "openai-completions",
    baseUrl,
    models: [
      {
        id: model,
        name: model,
        reasoning: false,
        input: ["text"],
        // Every Colony route is an OpenAI-compatible gateway that speaks
        // native tool calls; left unset the SDK may inline the tool catalog
        // as prompt text and send no `tools` array.
        supportsTools: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  });
  const resolved = registry.find(GATEWAY_PROVIDER, model);
  if (!resolved) {
    throw new Error(
      `gateway model ${model} did not resolve through ${baseUrl}`,
    );
  }
  return resolved as Model<"openai-completions">;
}

/**
 * Builds the mini-task prompt: five tool steps, then the role's envelope.
 *
 * The `bash` step runs `bun --version` and `node --version` on purpose — it
 * is the one step whose output is a fact the harness can check rather than a
 * fact it supplied — so the toolchain the sweep asserts on is the one the
 * sandbox actually gives the model.
 */
function buildMiniTaskPrompt(
  submitName: string,
  versions: PinnedVersions,
): string {
  return [
    "You are driving a scripted tool check in a scratch workspace. Use the named tool for each step; do not substitute another tool.",
    `1. read: call the \`read\` tool on ${READ_FILE}.`,
    `2. grep: call the \`grep\` tool for the symbol ${GREP_SYMBOL}.`,
    `3. edit: call the \`edit\` tool to change the line "${EDIT_OLD}" to "${EDIT_NEW}" in ${READ_FILE}.`,
    `4. write: call the \`write\` tool to create ${WRITE_FILE} containing exactly the line "${WRITE_MARKER}".`,
    `5. bash: call the \`bash\` tool to run: printf ${BASH_MARKER}; bun --version; node --version`,
    `6. submit: call \`${submitName}\` once with the envelope its own schema describes (for the developer envelope: kind "implementer_completion", status "complete", summary one line, branch "harness-conformance", head_sha "${HEAD_SHA}", commands [{cmd: "bun test", exit_code: 0}]).`,
    "Call the submit tool exactly once, only after steps 1-5. Do not ask questions and do not add steps.",
    "",
    `The workspace pins bun ${versions.bun} and node ${versions.nodeWithV}; step 5 must report exactly those.`,
  ].join("\n");
}

interface ToolResult {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}

/**
 * The wrappers ignore the extension context; the SDK signature wants one.
 * `never` because no real ExtensionContext exists outside a session — the
 * same escape callers use when driving a tool definition directly.
 */
const TOOL_CONTEXT = undefined as never;

/**
 * Runs one model x role mini-task: provisions a scratch sandbox, drives the
 * six capabilities through the real gateway, and scores them from the
 * tool-call log it recorded.
 */
async function runMiniTask(
  model: string,
  role: string,
  options: {
    readonly versions: PinnedVersions;
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly requestTimeoutMs?: number;
    readonly workspaceRoot?: string;
  },
): Promise<MiniTaskOutcome> {
  const startedAt = Date.now();
  const capabilities: Partial<Record<HarnessCapability, boolean>> = {};
  const apiKey = options.apiKey ?? process.env.COLONY_OPENAI_COMPATIBLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "harness conformance needs a gateway credential: set COLONY_OPENAI_COMPATIBLE_API_KEY or pass apiKey",
    );
  }
  const parentDir = await mkdtemp(
    join(options.workspaceRoot ?? tmpdir(), "colony-harness-"),
  );
  let handle: SandboxHandle | undefined;
  try {
    const engine = createInProcessEngine();
    handle = await engine.provision(
      buildSandboxLaunchProfile(
        role === "developer" ? "developer" : "reviewer",
      ),
      parentDir,
    );
    await writeFile(join(parentDir, READ_FILE), READ_FILE_BODY);
    await writeFile(join(parentDir, GREP_FILE), GREP_FILE_BODY);

    const tools = buildSandboxTools(handle, parentDir);
    let captured: unknown;
    let submitAttempts = 0;
    const submit = submitForRole(role, (value) => {
      captured = value;
    });
    const submitTool: ToolDefinition = {
      ...submit,
      execute: async (...args) => {
        submitAttempts += 1;
        return submit.execute(...args);
      },
    };
    const allTools = [...tools, submitTool];

    const calledTools: string[] = [];
    const messages: Message[] = [
      {
        role: "user",
        content: buildMiniTaskPrompt(submitTool.name, options.versions),
        timestamp: Date.now(),
      },
    ];
    const deadline = startedAt + MAX_HARNESS_MINUTES * 60_000;
    // One resolution per mini-task: the registry build walks the auth store,
    // and the model it returns does not change between turns.
    const resolvedModel = await resolveGatewayModel(
      model,
      options.baseUrl,
      apiKey,
    );
    let turns = 0;
    let lastText = "no assistant message";

    while (turns < MAX_HARNESS_TURNS && Date.now() < deadline) {
      const assistant = await complete(
        resolvedModel,
        { messages, tools: allTools as readonly Tool[] } as Context,
        {
          apiKey,
          signal: AbortSignal.timeout(options.requestTimeoutMs ?? 120_000),
        },
      );
      turns += 1;
      messages.push(assistant);
      // A transport or leg failure ends the mini-task: retrying a dead route
      // would spend the whole turn budget proving nothing, and the failure
      // is already the finding this row must report. Only `stop` (text) and
      // `toolUse` are productive; `error` and `aborted` are terminal.
      if (
        assistant.stopReason !== "stop" &&
        assistant.stopReason !== "toolUse"
      ) {
        lastText =
          assistant.errorMessage ?? `stop reason: ${assistant.stopReason}`;
        break;
      }
      const toolCalls = assistant.content.filter(
        (
          part,
        ): part is Extract<
          AssistantMessage["content"][number],
          { type: "toolCall" }
        > => part.type === "toolCall",
      );
      const text = assistant.content
        .filter(
          (
            part,
          ): part is Extract<
            AssistantMessage["content"][number],
            { type: "text" }
          > => part.type === "text",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) lastText = text;

      if (toolCalls.length === 0) {
        if (captured !== undefined) break;
        messages.push({
          role: "user",
          content: `No tool call in that message. Call the next tool in the list; step 6 is \`${submitTool.name}\` and it ends the check.`,
          timestamp: Date.now(),
        });
        continue;
      }

      const results: ToolResultMessage[] = [];
      for (const call of toolCalls) {
        calledTools.push(call.name);
        const tool = allTools.find((candidate) => candidate.name === call.name);
        if (!tool) {
          results.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: `unknown tool: ${call.name}` }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }
        try {
          const result = await tool.execute(
            call.id,
            call.arguments,
            undefined,
            undefined,
            // The wrappers ignore the extension context; the SDK signature
            // wants one.
            TOOL_CONTEXT,
          );
          results.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: (result as ToolResult)
              .content as ToolResultMessage["content"],
            isError: false,
            timestamp: Date.now(),
          });
        } catch (err) {
          results.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
            isError: true,
            timestamp: Date.now(),
          });
        }
      }
      for (const result of results) messages.push(result);
      if (captured !== undefined) break;
    }

    score(capabilities, calledTools, {
      submitAcceptedFirstTry: captured !== undefined && submitAttempts === 1,
      turns,
      wallMinutes: (Date.now() - startedAt) / 60_000,
    });
    const failed = HARNESS_CAPABILITIES.filter(
      (capability) => capabilities[capability] !== true,
    );
    return {
      capabilities,
      turns,
      wallMs: Date.now() - startedAt,
      submitAttempts,
      ...(failed.length > 0
        ? {
            detail:
              `tools called: ${calledTools.join(", ") || "none"}; ` +
              `last assistant text: ${lastText.slice(0, 300)}`,
          }
        : {}),
    };
  } catch (err) {
    // A transport or provisioning failure is a harness result, not a sweep
    // abort: every capability is unproven, which is exactly what a model
    // that cannot answer at all should look like in the table.
    return {
      capabilities,
      turns: 0,
      wallMs: Date.now() - startedAt,
      submitAttempts: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await handle?.destroy();
    await rm(parentDir, { recursive: true, force: true });
  }
}

/**
 * Scores one mini-task from its tool-call log.
 *
 * Each capability is proven only by a call to the tool that owns it: a bash
 * probe that cats the file proves nothing about `read`, which is precisely
 * the substitution this sweep exists to catch. The envelope is accepted only
 * when it passed on the first attempt — a retry means the first envelope was
 * invalid, and the run paid for it.
 */
function score(
  capabilities: Partial<Record<HarnessCapability, boolean>>,
  calledTools: readonly string[],
  facts: {
    readonly submitAcceptedFirstTry: boolean;
    readonly turns: number;
    readonly wallMinutes: number;
  },
): void {
  for (const capability of HARNESS_CAPABILITIES) {
    if (capability === "submit") {
      capabilities.submit = facts.submitAcceptedFirstTry;
      continue;
    }
    capabilities[capability] = calledTools.includes(capability);
  }
  // Budget compliance is a property of the whole mini-task, not of one tool,
  // so it lands on every row: a model that needs 40 turns to pass six
  // capabilities is not conformant however green each capability looks.
  const withinBudget =
    facts.turns <= MAX_HARNESS_TURNS &&
    facts.wallMinutes <= MAX_HARNESS_MINUTES;
  if (!withinBudget) {
    for (const capability of HARNESS_CAPABILITIES) {
      capabilities[capability] = false;
    }
  }
}
