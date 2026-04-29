import { describe, expect, it } from "vitest";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import type {
  ProviderProjectRepository,
  TaskGraphRepository,
} from "@colony/db";
import type {
  ActorId,
  ProviderMirror,
  ProviderProject,
  Scope,
  ScopeTarget,
  Task,
} from "@colony/domain";
import type { ProviderAdapter } from "@colony/provider";
import {
  createArchitectRun,
  type StartArchitectRunResult,
} from "./architect-run.js";

const SCOPE_ID = "col-arch01" as Scope["id"];
const PROJECT_ID = "proj-1" as ProviderProject["id"];
const TODAY = new Date("2026-04-29T00:00:00.000Z").toISOString();

describe("createArchitectRun (fake runtime)", () => {
  it("submits a decomposition proposal from a fake architect envelope", async () => {
    const stubs = makeStubs();
    const run = createArchitectRun({
      repo: stubs.repo as unknown as TaskGraphRepository,
      providerProjects:
        stubs.providerProjects as unknown as ProviderProjectRepository,
      providerAdapter: stubs.providerAdapter as unknown as ProviderAdapter,
      agentRuntime: new FakeAgentRuntimeAdapter(),
    });

    const result = await run({ scope_id: SCOPE_ID });

    expect(result).toMatchObject({
      started: true,
      scope_id: SCOPE_ID,
      envelope_status: "succeeded",
    });
    expect(
      (result as Extract<StartArchitectRunResult, { started: true }>)
        .proposal_id,
    ).toMatch(/^decomp-/);
    expect(stubs.submittedProposals).toHaveLength(1);
    const submitted = stubs.submittedProposals[0];
    expect(submitted.input.scope_id).toBe(SCOPE_ID);
    expect(submitted.input.scope_state_version).toBe(0);
    expect(submitted.input.proposed_tasks).toHaveLength(1);
    expect(submitted.ctx.actor).toBe("bot:architect");
    expect(submitted.ctx.capability).toBe("graph.write");
    // target_project_mapping must key each proposed_task_id (the repository
    // validator rejects role-keyed maps).
    expect(submitted.input.target_project_mapping).toEqual({
      [`${SCOPE_ID}.1`]: "gitlab-99",
    });
  });

  it("rejects scopes that are not in draft", async () => {
    const stubs = makeStubs({ scopeState: "active" });
    const run = createArchitectRun({
      repo: stubs.repo as unknown as TaskGraphRepository,
      providerProjects:
        stubs.providerProjects as unknown as ProviderProjectRepository,
      providerAdapter: stubs.providerAdapter as unknown as ProviderAdapter,
      agentRuntime: new FakeAgentRuntimeAdapter(),
    });

    const result = await run({ scope_id: SCOPE_ID });
    expect(result).toEqual({
      started: false,
      scope_id: SCOPE_ID,
      reason: "scope_not_draft:active",
    });
    expect(stubs.submittedProposals).toHaveLength(0);
  });

  it("rejects when scope has no provider mirror", async () => {
    const stubs = makeStubs({ omitScopeMirror: true });
    const run = createArchitectRun({
      repo: stubs.repo as unknown as TaskGraphRepository,
      providerProjects:
        stubs.providerProjects as unknown as ProviderProjectRepository,
      providerAdapter: stubs.providerAdapter as unknown as ProviderAdapter,
      agentRuntime: new FakeAgentRuntimeAdapter(),
    });

    const result = await run({ scope_id: SCOPE_ID });
    expect(result).toEqual({
      started: false,
      scope_id: SCOPE_ID,
      reason: "scope_has_no_provider_mirror",
    });
  });

  it("rejects an envelope whose freshness no longer matches the packet", async () => {
    const stubs = makeStubs();
    const adapter = new FakeAgentRuntimeAdapter({
      envelopeForRun: (packet) => ({
        version: 1,
        result: "done",
        confidence: 0.7,
        requires_human: true,
        risk_level: "low",
        artifacts: [],
        policy_flags: [],
        next_action: "propose_decomposition",
        freshness: {
          ...packet.freshness,
          packet_hash: "sha256:tampered",
        },
        rationale: "tampered freshness",
        scope_id: (packet as { scope_id: string }).scope_id,
        role_specific: {
          proposed_tasks: [
            {
              proposed_task_id: `${SCOPE_ID}.1`,
              title: "T1",
              description: "T1",
              acceptance_criteria: ["ok"],
              non_goals: [],
              suggested_role: "developer",
              suggested_capabilities: [],
            },
          ],
          proposed_dependencies: [],
          open_questions: [],
          assumptions: [],
        },
      }),
    });

    const run = createArchitectRun({
      repo: stubs.repo as unknown as TaskGraphRepository,
      providerProjects:
        stubs.providerProjects as unknown as ProviderProjectRepository,
      providerAdapter: stubs.providerAdapter as unknown as ProviderAdapter,
      agentRuntime: adapter,
    });
    const result = await run({ scope_id: SCOPE_ID });
    expect(result).toMatchObject({
      started: true,
      envelope_status: "envelope_rejected",
      reason: "envelope_freshness_mismatch",
    });
    expect(stubs.submittedProposals).toHaveLength(0);
    expect(
      stubs.audits.find((a) => a.action === "architect.envelope.stale"),
    ).toBeTruthy();
  });
});

function makeStubs(
  opts: {
    readonly scopeState?: Scope["state"];
    readonly omitScopeMirror?: boolean;
  } = {},
) {
  const submittedProposals: Array<{
    readonly input: Record<string, unknown> & {
      readonly scope_id: string;
      readonly scope_state_version: number;
      readonly proposed_tasks: ReadonlyArray<unknown>;
      readonly target_project_mapping: Readonly<Record<string, string>>;
    };
    readonly ctx: { readonly actor: string; readonly capability: string };
  }> = [];
  const audits: Array<Record<string, unknown> & { readonly action: string }> =
    [];

  const scope: Scope = {
    id: SCOPE_ID,
    title: "Architect smoke scope",
    description: "- Provide CSV export\n- Cover empty rows",
    state: opts.scopeState ?? "draft",
    state_version: 0,
    created_at: TODAY,
    updated_at: TODAY,
  };
  const project: ProviderProject = {
    id: PROJECT_ID,
    provider: "gitlab",
    provider_id: "gitlab-99",
    path: "shdr/colony",
    default_branch: "main",
    visibility: "private",
    metadata: {},
    created_at: TODAY,
    updated_at: TODAY,
  };
  const scopeTarget: ScopeTarget = {
    id: "st-1" as ScopeTarget["id"],
    scope_id: SCOPE_ID,
    provider_project_id: PROJECT_ID,
    role: "primary",
    created_at: TODAY,
  };
  const scopeMirror: ProviderMirror = {
    id: "mirror-1" as ProviderMirror["id"],
    colony_id: SCOPE_ID,
    entity_kind: "scope",
    provider: "gitlab",
    provider_id: "issue-100",
    provider_project_id: PROJECT_ID,
    provider_project_path: "shdr/colony",
  };

  const repo = {
    getScope: (id: string) => Promise.resolve(id === SCOPE_ID ? scope : null),
    listTasks: () => Promise.resolve<Task[]>([]),
    submitDecompositionProposal: (
      input: (typeof submittedProposals)[number]["input"],
      ctx: { actor: ActorId; capability: string; reason?: string },
    ) => {
      submittedProposals.push({
        input,
        ctx: { actor: ctx.actor, capability: ctx.capability },
      });
      return Promise.resolve({
        id: `decomp-${submittedProposals.length}`,
        scope_id: input.scope_id,
        scope_state_version: input.scope_state_version,
        scope_brief_version: "scope:0",
        status: "proposed" as const,
        proposed_tasks: input.proposed_tasks as never,
        proposed_dependencies: [],
        target_project_mapping: input.target_project_mapping,
        assumptions: [],
        open_questions: [],
        packet_hash: "sha256:packet",
        envelope_hash: "sha256:envelope",
        created_at: TODAY,
        updated_at: TODAY,
      });
    },
    writeAudit: (input: Record<string, unknown> & { action: string }) => {
      audits.push(input);
      return Promise.resolve("audit-id");
    },
  };

  const providerProjects = {
    listScopeTargets: () => Promise.resolve([scopeTarget]),
    getProject: () => Promise.resolve(project),
    listMirrorsForColony: (input: {
      readonly colony_id: string;
      readonly entity_kind?: string;
    }) => {
      if (opts.omitScopeMirror) return Promise.resolve([]);
      if (input.entity_kind && input.entity_kind !== "scope")
        return Promise.resolve([]);
      return Promise.resolve([scopeMirror]);
    },
  };

  const providerAdapter = { provider: "gitlab" };

  return {
    submittedProposals,
    audits,
    repo,
    providerProjects,
    providerAdapter,
  };
}
