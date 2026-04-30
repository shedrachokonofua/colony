import { describe, expect, it } from "vitest";
import type { ScopeId, TaskId } from "@colony/domain";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
} from "@mariozechner/pi-ai";
import {
  PiAgentRuntimeAdapter,
  buildReviewPacket,
  buildTaskPacket,
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type AgentRunEnvironment,
  type DeployerRuntimeBinding,
} from "./index.js";
import { PiCodingAgentRunner } from "./pi-coding-agent-runner.js";
import { PiMonoRunner } from "./pi-mono-runner.js";
import {
  developerCompletionEnvelopeSchema,
  reviewerReviewEnvelopeSchema,
  type DeveloperCompletionEnvelope,
} from "@colony/schemas";
import {
  buildDeveloperCompletionEnvelopeTemplate,
  buildDeveloperFinalizerPrompt,
  createPostProgressNoteTool,
} from "./pi-runner-common.js";

const SCOPE_ID = "col-pirun" as ScopeId;
const TASK_ID = "col-pirun.15" as TaskId;

const freshnessBase = {
  task_graph_version: "task:1",
  provider_event_ts: "2026-04-25T12:00:00.000Z",
  commit_sha: "abc123",
  policy_version: "policy:1",
  memory_bundle_version: "memory:1",
};

const provider_issue = {
  kind: "issue" as const,
  id: "issue-15",
  uri: "https://gitlab.example.com/so/colony/-/issues/15",
};

const repo = {
  url: "https://gitlab.example.com/so/colony.git",
  branch: "feature/col-2-15",
  base_commit: "abc123",
};

const localBinding: DeployerRuntimeBinding = {
  name: "local-permissive",
  environment: "local",
  networkPosture: "permissive",
  env: [],
  configMounts: [],
  credentialBindings: [
    {
      name: "llm",
      capability: "agent.llm.invoke",
      env: "COLONY_LLM_TOKEN",
      broker: "tool-gateway",
    },
  ],
  egress: [
    { name: "tool-gateway", kind: "service", target: "colony-tool-gateway" },
  ],
  serviceAccount: {
    name: "colony-sandbox-local",
    automountToken: true,
    rbacProfile: "none",
  },
};

describe("pi runners", () => {
  it("builds a schema-shaped developer completion template for finalization", () => {
    const packet = taskPacket();
    const template = buildDeveloperCompletionEnvelopeTemplate(packet);

    expect(developerCompletionEnvelopeSchema.safeParse(template).success).toBe(
      true,
    );
    expect(template).toMatchObject({
      version: 1,
      task_id: packet.task_id,
      freshness: packet.freshness,
      next_action: "request_review",
      role_specific: {
        tests_added: [],
      },
    });

    const prompt = buildDeveloperFinalizerPrompt(packet);
    expect(prompt).toContain("canonical developer_completion envelope");
    expect(prompt).toContain(`"task_id": "${packet.task_id}"`);
    expect(prompt).toContain(
      `"packet_hash": "${packet.freshness.packet_hash}"`,
    );
    expect(prompt).toContain("Do not add wrapper keys");
  });

  it("imports pi-coding-agent in-process and captures a developer envelope", async () => {
    const registration = registerFauxProvider({
      provider: "colony-faux-dev",
      models: [{ id: "colony-faux-dev-model" }],
    });
    const packet = taskPacket();
    const envelope = developerEnvelope(packet);
    registration.setResponses([
      fauxAssistantMessage(
        [
          fauxText("Submitting the completion envelope."),
          fauxToolCall("submit_developer_completion", envelope),
        ],
        { stopReason: "toolUse" },
      ),
    ]);

    try {
      const adapter = new PiAgentRuntimeAdapter(
        new PiCodingAgentRunner({
          broker: { resolve: () => "test-api-key" },
          model: registration.getModel(),
          runTimeoutMs: 2_000,
          developerTools: [],
        }),
      );
      const metadata = await adapter.startRun(packet, await runEnvironment());
      const output = await adapter.getRunOutput(metadata.runId);

      expect(metadata.status).toBe("succeeded");
      expect(output?.envelope).toEqual(
        developerCompletionEnvelopeSchema.parse(envelope),
      );
    } finally {
      registration.unregister();
    }
  });

  it("imports pi-agent-core in-process and captures a reviewer envelope", async () => {
    const registration = registerFauxProvider({
      provider: "colony-faux-review",
      models: [{ id: "colony-faux-review-model" }],
    });
    const packet = reviewPacket();
    const envelope = {
      version: 1,
      result: "approved",
      confidence: 0.91,
      requires_human: false,
      risk_level: "low",
      artifacts: [
        { kind: "mr", id: "!15", uri: "https://gitlab.example.com/mr/15" },
      ],
      policy_flags: [],
      next_action: "merge",
      freshness: packet.freshness,
      rationale: "Synthetic review found no blocking issues.",
      task_id: packet.task_id,
      role_specific: {
        findings: [],
        summary: "No findings.",
      },
    };
    registration.setResponses([
      fauxAssistantMessage(
        [
          fauxText("Submitting the review envelope."),
          fauxToolCall("submit_reviewer_review", envelope),
        ],
        { stopReason: "toolUse" },
      ),
    ]);

    try {
      const adapter = new PiAgentRuntimeAdapter(
        new PiMonoRunner({
          model: registration.getModel(),
          runTimeoutMs: 2_000,
        }),
      );
      const metadata = await adapter.startRun(
        packet,
        await runEnvironment("reviewer"),
      );
      const output = await adapter.getRunOutput(metadata.runId);

      expect(metadata.status).toBe("succeeded");
      expect(output?.envelope).toEqual(
        reviewerReviewEnvelopeSchema.parse(envelope),
      );
    } finally {
      registration.unregister();
    }
  });

  it("cancels an in-flight pi run without producing output", async () => {
    const registration = registerFauxProvider({
      provider: "colony-faux-cancel",
      models: [{ id: "colony-faux-cancel-model" }],
      tokensPerSecond: 1,
    });
    registration.setResponses([
      fauxAssistantMessage("This response is intentionally slow."),
    ]);

    try {
      const adapter = new PiAgentRuntimeAdapter(
        new PiMonoRunner({
          model: registration.getModel(),
          runTimeoutMs: 10_000,
        }),
      );
      const started = adapter.startRun(
        reviewPacket(),
        await runEnvironment("reviewer"),
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      const canceled = await adapter.cancelRun("pi-mono-1");
      const metadata = await started;

      expect(canceled?.status).toBe("canceled");
      expect(metadata.status).toBe("canceled");
      await expect(adapter.getRunOutput("pi-mono-1")).resolves.toBeNull();
    } finally {
      registration.unregister();
    }
  }, 10_000);

  it("posts sanitized progress notes to the issue and MR with a rate limit", async () => {
    const token = "task-token-secret";
    const shapedToken = `glpat-${"A".repeat(24)}`;
    const packet = {
      ...reviewPacket(),
      provider_issue: {
        ...provider_issue,
        id: "20:15",
      },
      provider_context: {
        ...reviewPacket().provider_context,
        issue_id: "20:15",
      },
      repo: {
        ...repo,
        credentials: { token },
      },
      mr_id: "20:5",
    };
    const calls: {
      readonly url: string;
      readonly token: string | null;
      readonly body: string;
    }[] = [];
    const fetchMock: typeof fetch = (input, init) => {
      const body = fetchBodyText(init);
      calls.push({
        url: fetchInputUrl(input),
        token: new Headers(init?.headers).get("PRIVATE-TOKEN"),
        body,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: calls.length,
            body: parsedNoteBody(body),
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    };

    const handle = createPostProgressNoteTool({
      packet,
      baseUrl: "https://gitlab.test",
      fetch: fetchMock,
      maxNotes: 1,
    });
    expect(handle).not.toBeNull();
    if (!handle) throw new Error("progress note tool was not created");

    const posted = await handle.tool.execute("note-1", {
      body: `Checking clone auth ${token} ${encodeURIComponent(token)} ${shapedToken}`,
    });
    expect(posted.details).toMatchObject({ ok: true, remaining: 0 });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual([
      "https://gitlab.test/api/v4/projects/20/issues/15/notes",
      "https://gitlab.test/api/v4/projects/20/merge_requests/5/notes",
    ]);
    expect(calls.every((call) => call.token === token)).toBe(true);
    const postedBody = parsedNoteBody(calls[0]?.body ?? "");
    expect(postedBody).toContain("[colony:col-pirun.15]");
    expect(postedBody).not.toContain(token);
    expect(postedBody).not.toContain(encodeURIComponent(token));
    expect(postedBody).not.toContain(shapedToken);

    const limited = await handle.tool.execute("note-2", {
      body: "another update",
    });
    expect(limited.details).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
    expect(calls).toHaveLength(2);
  });
});

function taskPacket() {
  return buildTaskPacket({
    scope_id: SCOPE_ID,
    task_id: TASK_ID,
    provider_issue,
    repo,
    goal: "Implement Pi runner",
    acceptance_criteria: ["Pi runner emits a schema-valid envelope"],
    non_goals: [],
    dependencies: [],
    provider_context: {
      provider: "gitlab",
      issue_id: "15",
      issue_url: provider_issue.uri,
      labels: ["agent:developer"],
      recent_comments: [],
    },
    memory_bundle: {
      decisions: [],
      semantic: [],
      procedural: [],
      policy: [],
    },
    policy: {
      constraints: ["Stay inside the task acceptance criteria."],
      protected_paths: [],
      security_labels: [],
      always_human_review: false,
      review_loop_cap: 3,
    },
    capabilities: ["tool.cli.execute"],
    required_outputs: [
      { kind: "commit", description: "head commit" },
      { kind: "mr", description: "merge request" },
    ],
    tool_permissions: ["git"],
    sandbox_profile: "developer-default",
    known_risks: [],
    time_budget_minutes: 30,
    freshness: freshnessBase,
  });
}

function developerEnvelope(
  packet: ReturnType<typeof taskPacket>,
): DeveloperCompletionEnvelope {
  return developerCompletionEnvelopeSchema.parse({
    version: 1,
    result: "done",
    confidence: 0.86,
    requires_human: false,
    risk_level: "medium",
    artifacts: [
      { kind: "commit", id: "commit-15", uri: "git:def456", hash: "def456" },
      { kind: "mr", id: "!15", uri: "https://gitlab.example.com/mr/15" },
    ],
    policy_flags: [],
    next_action: "request_review",
    freshness: packet.freshness,
    rationale: "Synthetic Pi developer run completed.",
    task_id: packet.task_id,
    role_specific: {
      tests_added: ["pi-runner.test.ts"],
      self_review_notes: "Synthetic run.",
    },
  });
}

function reviewPacket() {
  const task = taskPacket();
  return buildReviewPacket({
    ...task,
    provider_context: {
      ...task.provider_context,
      recent_comments: [],
    },
    freshness: freshnessBase,
    mr_id: "!15",
    commit_sha: "def456",
    diff_summary: "+10 -1",
    developer_envelope: developerEnvelope(task),
    pipeline_artifacts: [],
  });
}

async function runEnvironment(
  role: AgentRunEnvironment["role"] = "developer",
): Promise<AgentRunEnvironment> {
  const tools = await prepareSandboxToolEnvironment(
    {
      skillMounts: [],
      cliTools: [],
    },
    {
      kind: "fallback",
      resolveTools: () => ({
        pathEntries: [process.cwd()],
        profileHash: "sha256:pi-test-tool-profile",
      }),
    },
  );

  return {
    role,
    sandboxProfile: `${role}-default`,
    runtimeBinding: selectRuntimeBinding(localBinding),
    runExtensions: {
      skillMounts: [],
      cliTools: [],
    },
    tools,
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function fetchBodyText(init: Parameters<typeof fetch>[1]): string {
  return typeof init?.body === "string" ? init.body : "";
}

function parsedNoteBody(body: string): string {
  const parsed = JSON.parse(body) as { readonly body?: unknown };
  return typeof parsed.body === "string" ? parsed.body : "";
}
