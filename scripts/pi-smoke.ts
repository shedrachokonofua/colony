#!/usr/bin/env tsx
/**
 * One-off credential smoke for Pi runtime wiring.
 *
 * Loads the Colony runtime config + agent runtime factory exactly the way
 * the worker boots, then drives one synthetic packet through the developer
 * adapter (LiteLLM/kimi) and one through the reviewer adapter (Codex
 * OAuth/gpt-5.5). The architect adapter falls back to the developer config
 * by default, so we exercise it on a third packet for completeness.
 *
 * Exits non-zero on any failure with a structured diagnostic. Stays
 * read-only against external services — no GitLab calls, no DB writes.
 *
 * Usage (inside the dev shell, with bao login + .env sourced):
 *   tsx scripts/pi-smoke.ts
 */
import { env as loadEnv } from "@colony/config";
import {
  buildArchitectPacket,
  buildReviewPacket,
  buildTaskPacket,
  type AgentRunEnvironment,
  type AgentRuntimeAdapter,
  type AgentRuntimePacket,
} from "@colony/agent-runtime";
import {
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type DeployerRuntimeBinding,
} from "@colony/agent-runtime";
import { createAgentRuntimeWiring } from "../apps/worker/src/agent-runtime-factory.js";
import {
  developerCompletionEnvelopeSchema,
  reviewerReviewEnvelopeSchema,
  architectDecompositionEnvelopeSchema,
  type Freshness,
} from "@colony/schemas";

const FRESHNESS: Omit<Freshness, "packet_hash"> = {
  task_graph_version: "smoke:1",
  provider_event_ts: new Date(0).toISOString(),
  commit_sha: "main",
  policy_version: "policy:1",
  memory_bundle_version: "memory:1",
};

const DEPLOYER_BINDING: DeployerRuntimeBinding = {
  name: "smoke",
  environment: "local",
  networkPosture: "permissive",
  env: [],
  configMounts: [],
  credentialBindings: [],
  egress: [],
  serviceAccount: {
    name: "colony-sandbox-smoke",
    automountToken: true,
    rbacProfile: "none",
  },
};

async function buildEnv(
  role: AgentRunEnvironment["role"],
): Promise<AgentRunEnvironment> {
  const tools = await prepareSandboxToolEnvironment(
    { skillMounts: [], cliTools: [] },
    {
      kind: "fallback",
      resolveTools: () => ({
        pathEntries: ["/tmp"],
        profileHash: `sha256:smoke-${role}`,
        toolVersions: {},
      }),
    },
  );
  return {
    role,
    sandboxProfile: `${role}-smoke`,
    runtimeBinding: selectRuntimeBinding(DEPLOYER_BINDING),
    runExtensions: { skillMounts: [], cliTools: [] },
    tools,
  };
}

function step(label: string): void {
  console.log(`\n--- ${label} ---`);
}

async function runOne(
  label: string,
  adapter: AgentRuntimeAdapter,
  packet: AgentRuntimePacket,
  envEnv: AgentRunEnvironment,
  validate: (envelope: unknown) => string | null,
): Promise<void> {
  step(label);
  const started = Date.now();
  const meta = await adapter.startRun(packet, envEnv);
  const elapsedMs = Date.now() - started;
  console.log(
    `run_id=${meta.runId} status=${meta.status} packet_hash=${meta.packetHash.slice(0, 16)}… elapsed_ms=${elapsedMs}`,
  );
  if (meta.status !== "succeeded") {
    console.error(
      `FAIL: ${label} status=${meta.status} reason=${meta.rejectionReason}`,
    );
    process.exitCode = 2;
    return;
  }
  const out = await adapter.getRunOutput(meta.runId);
  const err = out ? validate(out.envelope) : "no-output";
  if (err) {
    console.error(`FAIL: ${label} envelope_invalid: ${err}`);
    process.exitCode = 2;
    return;
  }
  console.log(`OK: ${label} envelope hash=${out!.envelopeHash.slice(0, 16)}…`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  step("Load runtime wiring (AGENT_RUNTIME=pi)");
  const wiring = await createAgentRuntimeWiring(
    { ...env, AGENT_RUNTIME: "pi" },
    process.env,
  );
  console.log("developer/reviewer/architect adapters constructed");

  // Developer (kimi via LiteLLM).
  const devPacket = buildTaskPacket({
    scope_id: "col-smoke",
    task_id: "col-smoke.1",
    provider_issue: { kind: "issue", id: "1", uri: "smoke://issue/1" },
    repo: {
      url: "smoke://repo",
      branch: "main",
      base_commit: "deadbeef",
    },
    goal: "Smoke test: produce a developer_completion envelope.",
    acceptance_criteria: ["envelope is schema-valid"],
    non_goals: [],
    dependencies: [],
    provider_context: {
      provider: "smoke",
      issue_id: "1",
      issue_url: "smoke://issue/1",
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
      { kind: "commit", description: "smoke commit" },
      { kind: "mr", description: "smoke MR" },
    ],
    tool_permissions: [],
    sandbox_profile: "developer-smoke",
    known_risks: [],
    time_budget_minutes: 5,
    freshness: FRESHNESS,
  });
  await runOne(
    "developer / configured developer provider",
    wiring.developer,
    devPacket,
    await buildEnv("developer"),
    (e) => {
      const r = developerCompletionEnvelopeSchema.safeParse(e);
      return r.success ? null : r.error.message;
    },
  );

  // Reviewer (gpt-5.5 via Codex OAuth).
  const reviewPacket = buildReviewPacket({
    ...({
      scope_id: devPacket.scope_id,
      task_id: devPacket.task_id,
      provider_issue: devPacket.provider_issue,
      repo: devPacket.repo,
      goal: "Smoke review",
      acceptance_criteria: ["approved or empty findings array"],
      non_goals: [],
      dependencies: [],
      provider_context: {
        provider: "smoke",
        issue_id: "1",
        issue_url: "smoke://issue/1",
        labels: [],
        recent_comments: [],
      },
      memory_bundle: devPacket.memory_bundle,
      policy: devPacket.policy,
      capabilities: [],
      required_outputs: [
        { kind: "review_envelope", description: "review envelope" },
      ],
      tool_permissions: [],
      sandbox_profile: "reviewer-smoke",
      known_risks: [],
      time_budget_minutes: 5,
      freshness: FRESHNESS,
    } as Parameters<typeof buildReviewPacket>[0]),
    mr_id: "smoke-mr",
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
          uri: "smoke://commit/c1",
          hash: "deadbeef",
        },
      ],
      policy_flags: [],
      next_action: "request_review",
      freshness: { ...FRESHNESS, packet_hash: "sha256:placeholder" },
      rationale: "smoke",
      task_id: "col-smoke.1",
      role_specific: { tests_added: [], self_review_notes: "smoke" },
    }),
    pipeline_artifacts: [],
  });
  await runOne(
    "reviewer / gpt-5.5 via Codex OAuth",
    wiring.reviewer,
    reviewPacket,
    await buildEnv("reviewer"),
    (e) => {
      const r = reviewerReviewEnvelopeSchema.safeParse(e);
      return r.success ? null : r.error.message;
    },
  );

  // Architect (falls back to developer config in this dev YAML; piggybacks
  // on Codex OAuth in the canonical config — both paths exercised by the
  // two prior runs, but we still call the adapter to verify the wiring).
  const archPacket = buildArchitectPacket({
    scope_id: "col-smoke",
    provider_scope_artifact: {
      kind: "issue",
      id: "1",
      uri: "smoke://issue/1",
    },
    repo: { url: "smoke://repo", branch: "main", base_commit: "main" },
    scope_goal: "Smoke architect: propose a single-task decomposition.",
    scope_acceptance_criteria: ["one proposed task"],
    scope_non_goals: [],
    scope_brief_version: "smoke:1",
    target_projects: [
      {
        role: "primary",
        provider: "smoke",
        project_id: "p1",
        project_path: "smoke/p1",
        default_branch: "main",
      },
    ],
    existing_tasks: [],
    provider_context: {
      provider: "smoke",
      issue_id: "1",
      issue_url: "smoke://issue/1",
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
    sandbox_profile: "architect-smoke",
    known_risks: [],
    time_budget_minutes: 5,
    freshness: FRESHNESS,
  });
  await runOne(
    "architect / configured architect provider",
    wiring.architect,
    archPacket,
    await buildEnv("architect"),
    (e) => {
      const r = architectDecompositionEnvelopeSchema.safeParse(e);
      return r.success ? null : r.error.message;
    },
  );

  if (process.exitCode && process.exitCode !== 0) {
    console.error("\nSMOKE: at least one path failed.");
  } else {
    console.log("\nSMOKE: all paths returned schema-valid envelopes.");
  }
}

main().catch((err) => {
  console.error("smoke fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
