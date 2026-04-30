#!/usr/bin/env -S tsx
// Developer work-product benchmark for Colony's Pi coding runtime.
//
// This bench deliberately measures code editing, test execution, and diff
// discipline. It does not score the model on Colony's nested terminal envelope
// tool call. After the work loop finishes, the harness builds the
// developer_completion envelope deterministically from the observed repo state.
//
// Examples:
//   COLONY_BENCH_DRY_RUN=1 COLONY_BENCH_MODELS=kimi-k2.6,gpt-5.5 npm run bench:runners
//   COLONY_BENCH_MODELS=kimi-k2.6,glm-5.1,deepseek-v4-pro,gpt-5.5 \
//     COLONY_BENCH_REPEATS=3 npm run bench:runners

import { config as loadDotenv } from "dotenv";
import { execFileSync, execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import {
  buildTaskPacket,
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type AgentRunEnvironment,
  type DeployerRuntimeBinding,
} from "@colony/agent-runtime";
import {
  developerCompletionEnvelopeSchema,
  type DeveloperCompletionEnvelope,
  type Freshness,
} from "@colony/schemas";
import {
  env as loadEnv,
  loadColonyConfig,
  type PiApiKind,
  type ResolvedAgentConfig,
  type ResolvedAuth,
} from "@colony/config";
import {
  createConfigCredentialBroker,
  modelFromConfig,
} from "../apps/worker/src/agent-runtime-factory.js";

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

const env = loadEnv();
const configPath = resolve(
  process.cwd(),
  env.COLONY_CONFIG_PATH ?? "config/colony.yaml",
);
const colonyConfig = loadColonyConfig({
  path: configPath,
  env: process.env,
  agentRuntimeOverride: "pi",
});
const rawConfig = loadRawConfig(configPath);
const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replace(".", "-")
  .replace("Z", `-${process.pid}`);
const outDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "research",
);
mkdirSync(outDir, { recursive: true });

const requestedModels = csv(process.env["COLONY_BENCH_MODELS"] ?? "configured");
const repeats = parsePositiveInt(
  process.env["COLONY_BENCH_REPEATS"] ?? "1",
  "COLONY_BENCH_REPEATS",
);
const dryRun = process.env["COLONY_BENCH_DRY_RUN"] === "1";
const keepRepos = process.env["COLONY_BENCH_KEEP_REPOS"] === "1";

const MODEL_ALIASES: Record<
  string,
  {
    readonly providerKey: string;
    readonly modelId: string;
    readonly name: string;
  }
> = {
  "kimi-k2.6": {
    providerKey: "openai_compatible",
    modelId: "ollama-cloud/kimi-k2.6",
    name: "kimi-k2.6",
  },
  "glm-5.1": {
    providerKey: "openai_compatible",
    modelId: "ollama-cloud/glm-5.1",
    name: "glm-5.1",
  },
  "gemini-3-flash-preview": {
    providerKey: "openai_compatible",
    modelId: "gemini/gemini-3-flash-preview",
    name: "gemini-3-flash-preview",
  },
  "deepseek-v4-pro": {
    providerKey: "openai_compatible",
    modelId: "deepseek/deepseek-v4-pro",
    name: "deepseek-v4-pro",
  },
  "qwen27:code": {
    providerKey: "openai_compatible",
    modelId: "qwen27:code",
    name: "qwen27:code",
  },
  "opus-4.7": {
    providerKey: "openai_compatible",
    modelId: "anthropic/claude-opus-4-7",
    name: "opus-4.7",
  },
};

const FRESHNESS: Omit<Freshness, "packet_hash"> = {
  task_graph_version: "bench:dev-work-product:1",
  provider_event_ts: new Date(0).toISOString(),
  commit_sha: "main",
  policy_version: "policy:1",
  memory_bundle_version: "memory:1",
};

const DEPLOYER_BINDING: DeployerRuntimeBinding = {
  name: "bench",
  environment: "local",
  networkPosture: "permissive",
  env: [],
  configMounts: [],
  credentialBindings: [],
  egress: [],
  serviceAccount: {
    name: "colony-sandbox-bench",
    automountToken: true,
    rbacProfile: "none",
  },
};

const DEVELOPER_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

const BENCH_CLI_TOOLS = [
  {
    name: "node",
    executable: "node",
    resolver: "platform",
    requiredCapabilities: ["tool.cli.execute"],
    envAllowlist: [],
  },
  {
    name: "npm",
    executable: "npm",
    resolver: "platform",
    requiredCapabilities: ["tool.cli.execute"],
    envAllowlist: [],
  },
  {
    name: "git",
    executable: "git",
    resolver: "platform",
    requiredCapabilities: ["tool.cli.execute"],
    envAllowlist: [],
  },
] as const;

interface RawConfig {
  readonly allow_literal_keys?: boolean;
  readonly providers: Record<string, RawProvider>;
}

interface RawProvider {
  readonly api: PiApiKind;
  readonly base_url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth: RawAuth;
  readonly models: readonly RawModel[];
}

type RawAuth =
  | { readonly kind: "api_key"; readonly value: string }
  | { readonly kind: "oauth"; readonly subscription?: string };

interface RawModel {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly context_window?: number;
  readonly max_tokens?: number;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
  };
}

interface BenchResult {
  readonly model: string;
  readonly provider: string;
  readonly model_id: string;
  readonly attempt: number;
  readonly ok: boolean;
  readonly tests_pass: boolean;
  readonly initial_test_failed: boolean;
  readonly unrelated_edits: boolean;
  readonly diff_files: readonly string[];
  readonly lines_added: number;
  readonly lines_deleted: number;
  readonly wall_ms: number;
  readonly approx_usd: number;
  readonly tool_calls: number;
  readonly test_commands: number;
  readonly needed_retries: boolean;
  readonly failed_tool_calls: number;
  readonly deterministic_envelope_valid: boolean;
  readonly quality_score: number;
  readonly status: "succeeded" | "failed" | "exception";
  readonly rejection_reason?: string;
  readonly repo_dir?: string;
}

interface RunMetrics {
  toolCalls: number;
  testCommands: number;
  failedToolCalls: number;
  approxUsd: number;
}

interface TestResult {
  readonly ok: boolean;
  readonly output: string;
}

interface DiffStats {
  readonly files: readonly string[];
  readonly added: number;
  readonly deleted: number;
}

async function buildEnvironment(repoDir: string): Promise<AgentRunEnvironment> {
  const tools = await prepareSandboxToolEnvironment(
    {
      skillMounts: [],
      cliTools: BENCH_CLI_TOOLS,
    },
    {
      kind: "fallback",
      resolveTools: () => ({
        pathEntries: [dirname(process.execPath), "/usr/bin", "/bin"],
        profileHash: "sha256:bench-dev-work-product",
        toolVersions: {
          node: process.version,
          npm: commandVersion("npm", "--version"),
          git: commandVersion("git", "--version"),
        },
      }),
    },
  );
  return {
    role: "developer",
    sandboxProfile: "developer-work-product-bench",
    runtimeBinding: selectRuntimeBinding(DEPLOYER_BINDING),
    runExtensions: { skillMounts: [], cliTools: BENCH_CLI_TOOLS },
    tools: {
      ...tools,
      pathEntries: [repoDir, ...tools.pathEntries],
    },
  };
}

function buildDeveloperPacket(repoDir: string) {
  return buildTaskPacket({
    scope_id: "col-bench",
    task_id: "col-bench.1",
    provider_issue: { kind: "issue", id: "1", uri: "bench://issue/1" },
    repo: {
      url: `file://${repoDir}`,
      branch: "main",
      base_commit: "HEAD",
    },
    goal: "Fix the CSV serializer implementation so the existing test suite passes.",
    acceptance_criteria: [
      "`npm test` passes",
      "`src/csv.js` correctly quotes fields containing comma, quote, CR, LF, or CRLF",
      "Embedded double quotes are escaped by doubling them",
      "The fix is scoped to production source unless a test is demonstrably wrong",
    ],
    non_goals: ["Do not replace the test runner or remove assertions"],
    dependencies: [],
    provider_context: {
      provider: "bench",
      issue_id: "1",
      issue_url: "bench://issue/1",
      labels: ["benchmark", "developer"],
      recent_comments: [],
    },
    memory_bundle: { decisions: [], semantic: [], procedural: [], policy: [] },
    policy: {
      constraints: [],
      protected_paths: ["package.json", "test/**"],
      security_labels: [],
      always_human_review: false,
      review_loop_cap: 1,
    },
    capabilities: [],
    required_outputs: [{ kind: "commit", description: "working tree diff" }],
    tool_permissions: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    sandbox_profile: "developer-work-product-bench",
    known_risks: ["Models may edit tests instead of implementation"],
    time_budget_minutes: 8,
    freshness: FRESHNESS,
  });
}

async function runOne(
  agentConfig: ResolvedAgentConfig,
  attempt: number,
): Promise<BenchResult> {
  const repoDir = seedTempRepo();
  const environment = await buildEnvironment(repoDir);
  const packet = buildDeveloperPacket(repoDir);
  const initial = runTests(repoDir);
  const metrics: RunMetrics = {
    toolCalls: 0,
    testCommands: 0,
    failedToolCalls: 0,
    approxUsd: 0,
  };

  const model = modelFromConfig(agentConfig);
  const broker = createConfigCredentialBroker([agentConfig], env, process.env);
  const authStorage = AuthStorage.inMemory();
  const apiKey = await broker.resolve({
    provider: model.provider,
    capability: `agent.llm.${model.provider}.invoke`,
    bindingName: environment.runtimeBinding.binding.name,
    environment,
  });
  if (apiKey) authStorage.setRuntimeApiKey(model.provider, apiKey);

  const started = Date.now();
  let status: BenchResult["status"] = "succeeded";
  let rejectionReason: string | undefined;
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  let clearTimer: (() => void) | undefined;

  try {
    const result = await createAgentSession({
      cwd: repoDir,
      model,
      thinkingLevel: agentConfig.thinkingLevel ?? "medium",
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1 },
      }),
      resourceLoader: noOpResourceLoader(buildDeveloperBenchSystemPrompt()),
      sessionManager: SessionManager.inMemory(repoDir),
      tools: [...DEVELOPER_TOOLS],
    });
    session = result.session;
    session.agent.getApiKey = async (provider) =>
      broker.resolve({
        provider,
        capability: `agent.llm.${provider}.invoke`,
        bindingName: environment.runtimeBinding.binding.name,
        environment,
      });
    const unsubscribe = session.agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        metrics.approxUsd += event.message.usage?.cost.total ?? 0;
      }
    });
    const previousAfterToolCall = session.agent.afterToolCall;
    session.agent.afterToolCall = async (context, signal) => {
      const base = await previousAfterToolCall?.(context, signal);
      metrics.toolCalls += 1;
      if (context.isError) metrics.failedToolCalls += 1;
      if (
        context.toolCall.name === "bash" &&
        looksLikeTestCommand(context.args)
      ) {
        metrics.testCommands += 1;
      }
      return base;
    };
    clearTimer = withTimeout(agentConfig.ceilings.timeoutMs, () =>
      session?.abort(),
    );

    await session.prompt(buildDeveloperBenchPrompt(packet), {
      expandPromptTemplates: false,
      source: "extension",
    });
    await session.agent.waitForIdle();
    unsubscribe();
  } catch (err) {
    status = "exception";
    rejectionReason = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimer?.();
    session?.dispose();
  }

  const wall = Date.now() - started;
  const finalTest = runTests(repoDir);
  const diff = readDiffStats(repoDir);
  const unrelatedEdits = diff.files.some((file) => !allowedDiffFile(file));
  const deterministicEnvelope = buildDeterministicEnvelope({
    packet,
    testsPass: finalTest.ok,
    diff,
    repoDir,
  });
  const envelopeValid = developerCompletionEnvelopeSchema.safeParse(
    deterministicEnvelope,
  ).success;
  const ok =
    status === "succeeded" &&
    initial.ok === false &&
    finalTest.ok &&
    !unrelatedEdits &&
    envelopeValid;

  if (!keepRepos) {
    rmSync(repoDir, { recursive: true, force: true });
  }

  return {
    model: agentConfig.model.name,
    provider: agentConfig.providerKey,
    model_id: agentConfig.model.id,
    attempt,
    ok,
    tests_pass: finalTest.ok,
    initial_test_failed: !initial.ok,
    unrelated_edits: unrelatedEdits,
    diff_files: diff.files,
    lines_added: diff.added,
    lines_deleted: diff.deleted,
    wall_ms: wall,
    approx_usd: roundMoney(metrics.approxUsd),
    tool_calls: metrics.toolCalls,
    test_commands: metrics.testCommands,
    needed_retries: metrics.testCommands > 1 || metrics.failedToolCalls > 0,
    failed_tool_calls: metrics.failedToolCalls,
    deterministic_envelope_valid: envelopeValid,
    quality_score: qualityScore({
      initialTestFailed: !initial.ok,
      testsPass: finalTest.ok,
      unrelatedEdits,
      diff,
      metrics,
    }),
    status: ok ? "succeeded" : status === "succeeded" ? "failed" : status,
    rejection_reason: ok
      ? undefined
      : (rejectionReason ??
        failureReason(initial, finalTest, diff, unrelatedEdits)),
    repo_dir: keepRepos ? repoDir : undefined,
  };
}

async function main(): Promise<void> {
  const plan = requestedModels.map((modelRef) => resolveBenchAgent(modelRef));

  console.log("[bench] developer work-product plan");
  for (const agentConfig of plan) {
    console.log(
      `  developer: ${agentConfig.model.name} (${agentConfig.providerKey}/${agentConfig.model.id})`,
    );
  }
  if (dryRun) return;

  const results: BenchResult[] = [];
  for (const agentConfig of plan) {
    for (let i = 0; i < repeats; i += 1) {
      console.log(
        `[bench] developer ${agentConfig.model.name} attempt ${i + 1}/${repeats}`,
      );
      try {
        const result = await runOne(agentConfig, i + 1);
        results.push(result);
        console.log(
          `  ok=${result.ok} tests=${result.tests_pass} files=${result.diff_files.length} added=${result.lines_added} deleted=${result.lines_deleted} wall_ms=${result.wall_ms} test_cmds=${result.test_commands}`,
        );
      } catch (err) {
        results.push({
          model: agentConfig.model.name,
          provider: agentConfig.providerKey,
          model_id: agentConfig.model.id,
          attempt: i + 1,
          ok: false,
          tests_pass: false,
          initial_test_failed: false,
          unrelated_edits: false,
          diff_files: [],
          lines_added: 0,
          lines_deleted: 0,
          wall_ms: 0,
          approx_usd: 0,
          tool_calls: 0,
          test_commands: 0,
          needed_retries: false,
          failed_tool_calls: 0,
          deterministic_envelope_valid: false,
          quality_score: 0,
          status: "exception",
          rejection_reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const report = {
    stamp,
    repeats,
    models: requestedModels,
    mode: "developer-work-product",
    task: "csv-serializer",
    results,
    summary: summarize(results),
  };
  const suffix = `dev-work-product-${stamp}`;
  const jsonPath = join(outDir, `bench-results-${suffix}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const mdPath = join(outDir, `bench-results-${suffix}.md`);
  writeFileSync(mdPath, renderMarkdown(report));
  console.log(`\n[bench] wrote ${jsonPath}`);
  console.log(`[bench] wrote ${mdPath}`);
}

function seedTempRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "colony-dev-bench-"));
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, "test"), { recursive: true });
  writeFileSync(
    join(repoDir, "package.json"),
    `${JSON.stringify(
      {
        name: "colony-dev-bench-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(repoDir, "src", "csv.js"),
    [
      "export function toCsv(rows) {",
      "  return rows.map((row) => row.join(',')).join('\\n');",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(repoDir, "test", "csv.test.js"),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { toCsv } from '../src/csv.js';",
      "",
      "test('serializes simple rows', () => {",
      "  assert.equal(toCsv([['name', 'age'], ['Ada', 37]]), 'name,age\\nAda,37');",
      "});",
      "",
      "test('quotes commas, quotes, and newlines using RFC4180 escaping', () => {",
      "  const rows = [",
      "    ['name', 'note'],",
      "    ['Ada, Lovelace', 'said \"hello\"'],",
      "    ['Grace', 'line one\\nline two'],",
      "    ['Katherine', 'carriage\\rreturn'],",
      "  ];",
      "  assert.equal(",
      "    toCsv(rows),",
      '    \'name,note\\n"Ada, Lovelace","said ""hello"""\\nGrace,"line one\\nline two"\\nKatherine,"carriage\\rreturn"\',',
      "  );",
      "});",
      "",
      "test('preserves nullish and primitive values consistently', () => {",
      "  assert.equal(toCsv([[null, undefined, true, false, 42]]), ',,true,false,42');",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  git(repoDir, "init", "-q");
  git(repoDir, "config", "user.email", "bench@example.invalid");
  git(repoDir, "config", "user.name", "Colony Bench");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "seed failing csv fixture");
  return repoDir;
}

function runTests(repoDir: string): TestResult {
  try {
    return {
      ok: true,
      output: execFileSync("npm", ["test", "--", "--test-reporter=spec"], {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      output: processOutput(err),
    };
  }
}

function readDiffStats(repoDir: string): DiffStats {
  const files = git(repoDir, "diff", "--name-only")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const numstat = git(repoDir, "diff", "--numstat");
  let added = 0;
  let deleted = 0;
  for (const line of numstat.split("\n")) {
    const [a, d] = line.split("\t");
    const add = Number.parseInt(a ?? "0", 10);
    const del = Number.parseInt(d ?? "0", 10);
    if (Number.isFinite(add)) added += add;
    if (Number.isFinite(del)) deleted += del;
  }
  return { files, added, deleted };
}

function buildDeterministicEnvelope(input: {
  readonly packet: ReturnType<typeof buildDeveloperPacket>;
  readonly testsPass: boolean;
  readonly diff: DiffStats;
  readonly repoDir: string;
}): DeveloperCompletionEnvelope {
  const status = input.testsPass ? "done" : "blocked";
  return developerCompletionEnvelopeSchema.parse({
    version: 1,
    result: status,
    confidence: input.testsPass ? 0.85 : 0.35,
    requires_human: !input.testsPass,
    risk_level: input.diff.files.some((file) => file.startsWith("test/"))
      ? "medium"
      : "low",
    artifacts: [
      {
        kind: "commit",
        id: "working-tree",
        uri: `file://${input.repoDir}`,
        hash: git(input.repoDir, "rev-parse", "--short", "HEAD"),
      },
    ],
    policy_flags: input.diff.files
      .filter((file) => !allowedDiffFile(file))
      .map((file) => `unrelated_edit:${file}`),
    next_action: input.testsPass ? "request_review" : "report_blocked",
    freshness: input.packet.freshness,
    rationale: input.testsPass
      ? "The benchmark harness observed a passing test suite after the developer run."
      : "The benchmark harness observed a failing test suite after the developer run.",
    task_id: input.packet.task_id,
    role_specific: {
      tests_added: [],
      tests_modified: input.diff.files.filter((file) =>
        file.startsWith("test/"),
      ),
      self_review_notes: [
        `Changed files: ${input.diff.files.join(", ") || "none"}.`,
        `Diff size: +${input.diff.added}/-${input.diff.deleted}.`,
      ].join(" "),
    },
  });
}

function buildDeveloperBenchSystemPrompt(): string {
  return [
    "You are the Colony Developer runner in a work-product benchmark.",
    "Complete the task in the current working directory using the available tools.",
    "Do not read or write outside the current directory. Do not use absolute paths.",
    "Prefer minimal production-code edits. Do not change tests unless the test is factually wrong.",
    "Run `npm test` before finishing.",
    "Do not submit a structured Colony envelope; the benchmark harness will build it deterministically after your work is done.",
  ].join("\n");
}

function buildDeveloperBenchPrompt(
  packet: ReturnType<typeof buildDeveloperPacket>,
): string {
  return [
    "Fix this repository so the existing failing test passes.",
    "",
    "Task packet:",
    JSON.stringify(packet, null, 2),
    "",
    "Scoring:",
    "- `npm test` must pass.",
    "- Keep the diff small and scoped.",
    "- Avoid unrelated edits, especially package metadata and tests.",
    "- Use the tools to inspect, edit, and test the repo. No JSON final answer is needed.",
  ].join("\n");
}

function noOpResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function resolveBenchAgent(modelRef: string): ResolvedAgentConfig {
  const template = colonyConfig.forAgent("developer");
  if (modelRef === "configured") return template;

  const configured = findConfiguredModel(modelRef);
  if (configured) {
    return buildAgentConfig(
      template,
      configured.providerKey,
      configured.model.id,
    );
  }

  const alias = MODEL_ALIASES[modelRef];
  if (alias) {
    return buildAgentConfig(template, alias.providerKey, alias.modelId, {
      name: alias.name,
    });
  }

  const explicit = modelRef.includes(":") ? modelRef.split(":", 2) : null;
  if (explicit && rawConfig.providers[explicit[0]]) {
    return buildAgentConfig(template, explicit[0], explicit[1]);
  }

  if (modelRef.includes("/") || modelRef.includes(":")) {
    return buildAgentConfig(template, "openai_compatible", modelRef);
  }

  throw new Error(
    `Unknown bench model "${modelRef}". Use a configured model name, provider:model, or full LiteLLM id.`,
  );
}

function buildAgentConfig(
  template: ResolvedAgentConfig,
  providerKey: string,
  modelRef: string,
  fallback?: { readonly name?: string },
): ResolvedAgentConfig {
  const provider = rawConfig.providers[providerKey];
  if (!provider)
    throw new Error(`provider ${providerKey} not found in ${configPath}`);
  const model =
    provider.models.find(
      (m) => (m.name ?? m.id) === modelRef || m.id === modelRef,
    ) ??
    ({
      id: modelRef,
      name: fallback?.name ?? modelRef.split("/").at(-1),
    } satisfies RawModel);
  return {
    role: "developer",
    providerKey,
    api: provider.api,
    baseUrl: provider.base_url,
    headers: provider.headers,
    model: {
      id: model.id,
      name: model.name ?? model.id,
      reasoning: model.reasoning,
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
      cost: model.cost
        ? {
            input: model.cost.input,
            output: model.cost.output,
            cacheRead: model.cost.cache_read,
            cacheWrite: model.cost.cache_write,
          }
        : undefined,
    },
    auth: resolveAuth(providerKey, provider.auth),
    thinkingLevel: template.thinkingLevel,
    ceilings: {
      timeoutMs:
        parseOptionalInt(process.env["COLONY_BENCH_TIMEOUT_MS"]) ??
        template.ceilings.timeoutMs,
      maxTurns:
        parseOptionalInt(process.env["COLONY_BENCH_MAX_TURNS"]) ??
        template.ceilings.maxTurns,
      maxUsdPerRun:
        parseOptionalFloat(process.env["COLONY_BENCH_MAX_USD"]) ??
        template.ceilings.maxUsdPerRun,
    },
  };
}

function resolveAuth(providerKey: string, auth: RawAuth): ResolvedAuth {
  if (auth.kind === "oauth") {
    return {
      kind: "oauth",
      subscription: auth.subscription,
      providerKey,
    };
  }
  return {
    kind: "api_key",
    apiKey: resolveApiKey(auth.value, providerKey),
  };
}

function resolveApiKey(value: string, providerKey: string): string {
  if (value.startsWith("!")) {
    const out = execSync(value.slice(1).trim(), { encoding: "utf8" }).trim();
    if (!out)
      throw new Error(
        `provider ${providerKey} api_key command returned empty output`,
      );
    return out;
  }
  if (/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    const out = process.env[value];
    if (!out)
      throw new Error(
        `provider ${providerKey} api_key env var ${value} is unset`,
      );
    return out;
  }
  if (!rawConfig.allow_literal_keys) {
    throw new Error(
      `provider ${providerKey} api_key is literal but allow_literal_keys is false`,
    );
  }
  return value;
}

function findConfiguredModel(
  modelRef: string,
): { readonly providerKey: string; readonly model: RawModel } | null {
  for (const [providerKey, provider] of Object.entries(rawConfig.providers)) {
    const model = provider.models.find(
      (m) => (m.name ?? m.id) === modelRef || m.id === modelRef,
    );
    if (model) return { providerKey, model };
  }
  return null;
}

function summarize(results: readonly BenchResult[]) {
  return [...groupBy(results, (r) => r.model).entries()].map(
    ([model, rows]) => ({
      model,
      attempt_count: rows.length,
      successes: rows.filter((r) => r.ok).length,
      tests_passed: rows.filter((r) => r.tests_pass).length,
      unrelated_edits: rows.filter((r) => r.unrelated_edits).length,
      mean_wall_ms: mean(rows.map((r) => r.wall_ms)),
      p95_wall_ms: percentile(
        rows.map((r) => r.wall_ms),
        0.95,
      ),
      mean_lines_changed: mean(
        rows.map((r) => r.lines_added + r.lines_deleted),
      ),
      mean_test_commands: mean(rows.map((r) => r.test_commands)),
      retries_needed: rows.filter((r) => r.needed_retries).length,
      total_usd: roundMoney(sum(rows.map((r) => r.approx_usd))),
      mean_quality_score: mean(rows.map((r) => r.quality_score)),
    }),
  );
}

function renderMarkdown(report: {
  readonly stamp: string;
  readonly repeats: number;
  readonly models: readonly string[];
  readonly mode: string;
  readonly task: string;
  readonly results: readonly BenchResult[];
  readonly summary: ReturnType<typeof summarize>;
}): string {
  const lines: string[] = [];
  lines.push("# Colony developer work-product bench");
  lines.push("");
  lines.push(`Stamp: \`${report.stamp}\``);
  lines.push(`Mode: \`${report.mode}\``);
  lines.push(`Task: \`${report.task}\``);
  lines.push(`Repeats: \`${report.repeats}\``);
  lines.push(`Models: \`${report.models.join(", ")}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    "| model | attempts | successes | tests_passed | unrelated_edits | mean_ms | p95_ms | mean_lines | mean_test_cmds | retries | usd | quality |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of report.summary) {
    lines.push(
      `| ${r.model} | ${r.attempt_count} | ${r.successes} | ${r.tests_passed} | ${r.unrelated_edits} | ${r.mean_wall_ms} | ${r.p95_wall_ms} | ${r.mean_lines_changed} | ${r.mean_test_commands} | ${r.retries_needed} | ${r.total_usd} | ${r.mean_quality_score} |`,
    );
  }
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  lines.push(
    "| model | attempt | ok | tests | files | + | - | wall_ms | tool_calls | test_cmds | retries | status | reason |",
  );
  lines.push("|---|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|---|");
  for (const r of report.results) {
    lines.push(
      `| ${r.model} | ${r.attempt} | ${r.ok} | ${r.tests_pass} | ${r.diff_files.length} | ${r.lines_added} | ${r.lines_deleted} | ${r.wall_ms} | ${r.tool_calls} | ${r.test_commands} | ${r.needed_retries} | ${r.status} | ${escapeCell(r.rejection_reason ?? "")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function qualityScore(input: {
  readonly initialTestFailed: boolean;
  readonly testsPass: boolean;
  readonly unrelatedEdits: boolean;
  readonly diff: DiffStats;
  readonly metrics: RunMetrics;
}): number {
  let score = 0;
  if (input.initialTestFailed) score += 1;
  if (input.testsPass) score += 4;
  if (!input.unrelatedEdits) score += 2;
  if (input.diff.files.length === 1 && input.diff.files[0] === "src/csv.js") {
    score += 2;
  }
  if (input.diff.added + input.diff.deleted <= 40) score += 1;
  if (input.metrics.testCommands > 0) score += 1;
  return score;
}

function failureReason(
  initial: TestResult,
  finalTest: TestResult,
  diff: DiffStats,
  unrelatedEdits: boolean,
): string {
  if (initial.ok) return "fixture did not fail before model run";
  if (!finalTest.ok) return truncate(`tests failed: ${finalTest.output}`);
  if (unrelatedEdits) {
    return `unrelated edits: ${diff.files.filter((file) => !allowedDiffFile(file)).join(", ")}`;
  }
  if (diff.files.length === 0) return "no diff produced";
  return "benchmark success criteria not met";
}

function allowedDiffFile(file: string): boolean {
  return file === "src/csv.js";
}

function looksLikeTestCommand(args: unknown): boolean {
  const text = JSON.stringify(args).toLowerCase();
  return text.includes("npm test") || text.includes("node --test");
}

function processOutput(err: unknown): string {
  const maybe = err as {
    readonly stdout?: Buffer | string;
    readonly stderr?: Buffer | string;
    readonly message?: string;
  };
  return truncate(
    [
      bufferText(maybe.stdout),
      bufferText(maybe.stderr),
      maybe.message ?? String(err),
    ]
      .filter(Boolean)
      .join("\n"),
    4000,
  );
}

function bufferText(value: Buffer | string | undefined): string {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function withTimeout(ms: number | undefined, abort: () => void): () => void {
  const timer = setTimeout(abort, ms ?? 10 * 60_000);
  return () => clearTimeout(timer);
}

function commandVersion(command: string, arg: string): string {
  try {
    return execFileSync(command, [arg], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function git(repoDir: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function loadRawConfig(path: string): RawConfig {
  const raw = parseYaml(readFileSync(path, "utf8")) as RawConfig;
  if (!raw.providers) throw new Error(`config ${path} has no providers`);
  return raw;
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseOptionalFloat(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(sum(values) / values.length);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function groupBy<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(value);
    } else {
      groups.set(key, [value]);
    }
  }
  return groups;
}

function truncate(value: string, max = 800): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
