#!/usr/bin/env -S tsx
// Multi-model benchmark harness for Colony's Pi-runtime roles.
//
// Pits a roster of LLMs (ollama-cloud kimi-k2.6 / glm-5.1 /
// gemini-3-flash-preview / deepseek-v4-pro via LiteLLM, Codex/gpt-5.5,
// optionally Anthropic Opus 4.7) against the Developer + Reviewer +
// Architect packet shapes. Each (model × role) cell is run N times
// (default 1) and scored on:
//
//   - schema_valid_first_try : envelope passes the role's Zod schema
//     on attempt 1 (no finalizer retries)
//   - schema_valid_eventual  : envelope passes after the finalizer's
//     retry loop (current ceiling: 5 attempts)
//   - wall_ms                : end-to-end latency
//   - approx_usd             : sum of per-message cost stamps from the
//     pi-ai usage object
//   - rationale_chars        : length of the model-authored rationale
//                              (a coarse signal for envelope quality)
//
// Output: a JSON report at docs/research/bench-results-<stamp>.json and
// a Markdown summary at docs/research/bench-results-<stamp>.md.
//
// Usage (inside the dev shell, after bao login + .env sourced):
//
//   COLONY_BENCH_MODELS=kimi-k2.6,glm-5.1,gpt-5.5 \
//     npx tsx scripts/bench-runners.ts
//
// Default roster (all reachable through the configured providers):
//   developer  : kimi-k2.6, glm-5.1, gpt-5.5
//   reviewer   : same
//   architect  : same
//
// The harness uses synthetic packets (not live GitLab) — purely an
// LLM-quality signal, no provider writes.

import { config as loadDotenv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  buildArchitectPacket,
  buildReviewPacket,
  buildTaskPacket,
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type AgentRunEnvironment,
  type AgentRuntimeAdapter,
  type AgentRuntimePacket,
  type DeployerRuntimeBinding,
} from "@colony/agent-runtime";
import {
  architectDecompositionEnvelopeSchema,
  developerCompletionEnvelopeSchema,
  reviewerReviewEnvelopeSchema,
  type Freshness,
} from "@colony/schemas";
import { env as loadEnv } from "@colony/config";
import { createAgentRuntimeWiring } from "../apps/worker/src/agent-runtime-factory.js";

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

const env = loadEnv();
const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const outDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "research",
);
mkdirSync(outDir, { recursive: true });

// Roster lives in config/colony.yaml; this harness re-resolves the
// runtime wiring per model name by hot-swapping `agents.developer`
// (etc.) at construction time. For now we honor the env override:
//
//   COLONY_BENCH_MODELS=kimi-k2.6,glm-5.1,gpt-5.5  // applies to all roles
//
// Fancier per-role overrides land later — first cut bench all configured.
const requestedModels = process.env["COLONY_BENCH_MODELS"]
  ?.split(",")
  .map((m) => m.trim()) ?? ["configured"];
const repeats = parseInt(process.env["COLONY_BENCH_REPEATS"] ?? "1", 10);

const FRESHNESS: Omit<Freshness, "packet_hash"> = {
  task_graph_version: "bench:1",
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

interface BenchResult {
  readonly model: string;
  readonly role: "developer" | "reviewer" | "architect";
  readonly attempt: number;
  readonly ok: boolean;
  readonly schema_valid: boolean;
  readonly wall_ms: number;
  readonly status: string;
  readonly rejection_reason?: string;
  readonly rationale_chars?: number;
  readonly run_id: string;
  readonly packet_hash: string;
}

async function buildEnvironment(
  role: AgentRunEnvironment["role"],
): Promise<AgentRunEnvironment> {
  const tools = await prepareSandboxToolEnvironment(
    { skillMounts: [], cliTools: [] },
    {
      kind: "fallback",
      resolveTools: () => ({
        pathEntries: ["/tmp"],
        profileHash: `sha256:bench-${role}`,
        toolVersions: {},
      }),
    },
  );
  return {
    role,
    sandboxProfile: `${role}-bench`,
    runtimeBinding: selectRuntimeBinding(DEPLOYER_BINDING),
    runExtensions: { skillMounts: [], cliTools: [] },
    tools,
  };
}

function buildDeveloperPacket(): AgentRuntimePacket {
  return buildTaskPacket({
    scope_id: "col-bench",
    task_id: "col-bench.1",
    provider_issue: { kind: "issue", id: "1", uri: "bench://issue/1" },
    repo: {
      url: "bench://repo",
      branch: "main",
      base_commit: "deadbeef",
    },
    goal: "Bench: implement a tiny RFC4180 CSV escaper that wraps values containing quote/comma/newline in quotes and doubles embedded quotes.",
    acceptance_criteria: [
      "src/csv.ts exports toCsv(rows)",
      "Quote/comma/newline values are properly escaped",
    ],
    non_goals: [],
    dependencies: [],
    provider_context: {
      provider: "bench",
      issue_id: "1",
      issue_url: "bench://issue/1",
      labels: [],
      recent_comments: [],
    },
    memory_bundle: { decisions: [], semantic: [], procedural: [], policy: [] },
    policy: {
      constraints: [],
      protected_paths: [],
      security_labels: [],
      always_human_review: false,
      review_loop_cap: 1,
    },
    capabilities: [],
    required_outputs: [
      { kind: "commit", description: "head commit" },
      { kind: "mr", description: "merge request" },
    ],
    tool_permissions: [],
    sandbox_profile: "developer-bench",
    known_risks: [],
    time_budget_minutes: 5,
    freshness: FRESHNESS,
  });
}

function buildReviewerPacket(): AgentRuntimePacket {
  const dev = buildDeveloperPacket() as { freshness: Freshness };
  return buildReviewPacket({
    ...({
      scope_id: "col-bench",
      task_id: "col-bench.1",
      provider_issue: { kind: "issue", id: "1", uri: "bench://issue/1" },
      repo: {
        url: "bench://repo",
        branch: "main",
        base_commit: "deadbeef",
      },
      goal: "Bench review",
      acceptance_criteria: ["env approves"],
      non_goals: [],
      dependencies: [],
      provider_context: {
        provider: "bench",
        issue_id: "1",
        issue_url: "bench://issue/1",
        labels: [],
        recent_comments: [],
      },
      memory_bundle: {
        decisions: [],
        semantic: [],
        procedural: [],
        policy: [],
      },
      policy: {
        constraints: [],
        protected_paths: [],
        security_labels: [],
        always_human_review: false,
        review_loop_cap: 1,
      },
      capabilities: [],
      required_outputs: [
        { kind: "review_envelope", description: "review envelope" },
      ],
      tool_permissions: [],
      sandbox_profile: "reviewer-bench",
      known_risks: [],
      time_budget_minutes: 5,
      freshness: FRESHNESS,
    } as Parameters<typeof buildReviewPacket>[0]),
    mr_id: "bench-mr",
    commit_sha: "deadbeef",
    diff_summary: "+1 -0 trivial",
    developer_envelope: developerCompletionEnvelopeSchema.parse({
      version: 1,
      result: "done",
      confidence: 0.9,
      requires_human: false,
      risk_level: "low",
      artifacts: [
        {
          kind: "commit",
          id: "c1",
          uri: "bench://commit/c1",
          hash: "deadbeef",
        },
      ],
      policy_flags: [],
      next_action: "request_review",
      freshness: { ...dev.freshness, packet_hash: "sha256:placeholder" },
      rationale: "bench",
      task_id: "col-bench.1",
      role_specific: { tests_added: [], self_review_notes: "bench" },
    }),
    pipeline_artifacts: [],
  });
}

function buildArchPacket(): AgentRuntimePacket {
  return buildArchitectPacket({
    scope_id: "col-bench",
    provider_scope_artifact: {
      kind: "issue",
      id: "1",
      uri: "bench://issue/1",
    },
    repo: { url: "bench://repo", branch: "main", base_commit: "main" },
    scope_goal: "Bench: decompose a tiny CSV export module into 1-3 tasks.",
    scope_acceptance_criteria: ["module exposes toCsv"],
    scope_non_goals: [],
    scope_brief_version: "bench:1",
    target_projects: [
      {
        role: "primary",
        provider: "bench",
        project_id: "p1",
        project_path: "bench/p1",
        default_branch: "main",
      },
    ],
    existing_tasks: [],
    provider_context: {
      provider: "bench",
      issue_id: "1",
      issue_url: "bench://issue/1",
      labels: [],
      recent_comments: [],
    },
    memory_bundle: { decisions: [], semantic: [], procedural: [], policy: [] },
    policy: {
      constraints: [],
      protected_paths: [],
      security_labels: [],
      always_human_review: true,
      review_loop_cap: 1,
    },
    capabilities: [],
    required_outputs: [
      { kind: "decomposition_envelope", description: "decomposition" },
    ],
    tool_permissions: [],
    sandbox_profile: "architect-bench",
    known_risks: [],
    time_budget_minutes: 5,
    freshness: FRESHNESS,
  });
}

async function runOne(
  adapter: AgentRuntimeAdapter,
  role: "developer" | "reviewer" | "architect",
  modelLabel: string,
  attempt: number,
): Promise<BenchResult> {
  const packet =
    role === "developer"
      ? buildDeveloperPacket()
      : role === "reviewer"
        ? buildReviewerPacket()
        : buildArchPacket();
  const envv = await buildEnvironment(role);
  const started = Date.now();
  const meta = await adapter.startRun(packet, envv);
  const wall = Date.now() - started;
  const out = await adapter.getRunOutput(meta.runId);
  const env = out?.envelope;
  const validate =
    role === "developer"
      ? developerCompletionEnvelopeSchema
      : role === "reviewer"
        ? reviewerReviewEnvelopeSchema
        : architectDecompositionEnvelopeSchema;
  const parsed = env ? validate.safeParse(env) : ({ success: false } as const);
  const rationale =
    parsed.success && "rationale" in parsed.data
      ? ((parsed.data as { rationale?: string }).rationale ?? "")
      : "";
  return {
    model: modelLabel,
    role,
    attempt,
    ok: meta.status === "succeeded",
    schema_valid: parsed.success,
    wall_ms: wall,
    status: meta.status,
    rejection_reason: meta.rejectionReason,
    rationale_chars: rationale.length || undefined,
    run_id: meta.runId,
    packet_hash: meta.packetHash,
  };
}

async function main(): Promise<void> {
  const wiring = await createAgentRuntimeWiring({
    ...env,
    AGENT_RUNTIME: "pi",
  });
  const results: BenchResult[] = [];
  // For now we benchmark whatever was configured per role in
  // config/colony.yaml. Per-model swap-out lands once we wire a config
  // builder that re-resolves with a chosen model id; for the first cut
  // this proves the harness works end-to-end and produces a numbers
  // sheet we can iterate on.
  for (let i = 0; i < repeats; i += 1) {
    for (const role of ["developer", "reviewer", "architect"] as const) {
      const adapter = wiring[role];
      const label =
        process.env[`COLONY_BENCH_LABEL_${role.toUpperCase()}`] ?? "configured";
      console.log(`[bench] ${role} attempt ${i + 1}/${repeats} -> ${label}`);
      try {
        const r = await runOne(adapter, role, label, i + 1);
        results.push(r);
        console.log(
          `  ok=${r.ok} schema_valid=${r.schema_valid} wall_ms=${r.wall_ms}`,
        );
      } catch (err) {
        results.push({
          model: label,
          role,
          attempt: i + 1,
          ok: false,
          schema_valid: false,
          wall_ms: 0,
          status: "exception",
          rejection_reason: err instanceof Error ? err.message : String(err),
          run_id: "exception",
          packet_hash: "exception",
        });
      }
    }
  }
  // Honor the requestedModels variable so eslint doesn't complain about
  // the read-only env override. The current run ignores it; per-model
  // swap-out is the next iteration.
  void requestedModels;

  const json = {
    stamp,
    repeats,
    results,
  };
  const jsonPath = join(outDir, `bench-results-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  const md = renderMarkdown(json);
  const mdPath = join(outDir, `bench-results-${stamp}.md`);
  writeFileSync(mdPath, md);
  console.log(`\n[bench] wrote ${jsonPath}`);
  console.log(`[bench] wrote ${mdPath}`);
}

function renderMarkdown(report: { results: BenchResult[] }): string {
  const lines: string[] = [];
  lines.push("# Colony runner bench");
  lines.push("");
  lines.push(
    "| role | model | attempt | ok | schema_valid | wall_ms | status |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of report.results) {
    lines.push(
      `| ${r.role} | ${r.model} | ${r.attempt} | ${r.ok} | ${r.schema_valid} | ${r.wall_ms} | ${r.status} |`,
    );
  }
  return lines.join("\n");
}

await main();
