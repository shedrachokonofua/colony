import { describe, expect, it } from "vitest";

import {
  FRESHNESS_FIELDS,
  SCHEMAS,
  architectDecompositionEnvelopeSchema,
  blockedEnvelopeSchema,
  developerCompletionEnvelopeSchema,
  discoveredWorkEnvelopeSchema,
  freshnessSchema,
  mergeReadinessEnvelopeSchema,
  reviewerReviewEnvelopeSchema,
  reviewPacketSchema,
  scopeReviewEnvelopeSchema,
  scopeReviewPacketSchema,
  taskPacketSchema,
} from "./index.js";

const validFreshness = {
  packet_hash: "sha256:packet123",
  task_graph_version: "42",
  provider_event_ts: "2026-04-23T15:12:00Z",
  commit_sha: "abc123",
  policy_version: "7",
  memory_bundle_version: "3",
} as const;

const designDeveloperExample = {
  version: 1,
  task_id: "col-csv01.2",
  result: "done",
  confidence: 0.82,
  requires_human: false,
  risk_level: "medium",
  artifacts: [
    {
      kind: "mr",
      id: "!42",
      uri: "https://gitlab.example.com/...",
      hash: "sha:abc123",
    },
    { kind: "commit", id: "abc123", uri: "...", hash: "abc123" },
  ],
  policy_flags: [],
  next_action: "request_review",
  freshness: validFreshness,
  rationale:
    "Implemented CSV export endpoint with streaming and content-type header. Tests cover empty and large datasets.",
  role_specific: {
    tests_added: [
      "export_csv_test.go:TestStreaming",
      "export_csv_test.go:TestEmpty",
    ],
    self_review_notes: "Pagination edge case untested; flagging for reviewer.",
  },
};

const designReviewerExample = {
  version: 1,
  task_id: "col-csv01.2",
  result: "changes_requested",
  confidence: 0.9,
  requires_human: false,
  risk_level: "medium",
  artifacts: [{ kind: "mr", id: "!42", uri: "...", hash: "sha:abc123" }],
  policy_flags: [],
  next_action: "return_to_author",
  freshness: {
    packet_hash: "sha256:reviewpacket456",
    task_graph_version: "45",
    provider_event_ts: "2026-04-23T15:40:00Z",
    commit_sha: "abc123",
    policy_version: "7",
    memory_bundle_version: "3",
  },
  rationale:
    "Pagination edge case is a real bug; streaming closes the writer early on empty results.",
  role_specific: {
    findings: [
      {
        severity: "major",
        evidence: "export_csv.go:L88 — early return before header flush",
        acceptance_criterion_ref: "AC-3",
        suggested_fix:
          "Flush header before early return; or return 204 with no body.",
        confidence: 0.9,
      },
    ],
  },
};

describe("freshness schema", () => {
  it("accepts a fully populated freshness object", () => {
    expect(() => freshnessSchema.parse(validFreshness)).not.toThrow();
  });

  it.each(FRESHNESS_FIELDS)(
    "rejects an envelope freshness missing %s",
    (field) => {
      const partial: Record<string, unknown> = { ...validFreshness };
      delete partial[field];
      const r = freshnessSchema.safeParse(partial);
      expect(r.success).toBe(false);
      const issues = r.success ? [] : r.error.issues;
      expect(
        issues.some((i) => i.path.includes(field)),
        `expected an issue on ${field}; got ${JSON.stringify(issues)}`,
      ).toBe(true);
    },
  );

  it("rejects empty strings in freshness fields", () => {
    const r = freshnessSchema.safeParse({
      ...validFreshness,
      packet_hash: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-ISO provider_event_ts", () => {
    const r = freshnessSchema.safeParse({
      ...validFreshness,
      provider_event_ts: "yesterday",
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown extra fields", () => {
    const r = freshnessSchema.safeParse({
      ...validFreshness,
      bogus: "x",
    });
    expect(r.success).toBe(false);
  });
});

describe("design.md examples", () => {
  it("validates the developer completion example", () => {
    const r = developerCompletionEnvelopeSchema.safeParse(
      designDeveloperExample,
    );
    expect(
      r.success,
      r.success ? "" : JSON.stringify(r.error.issues, null, 2),
    ).toBe(true);
  });

  it("validates the reviewer review example", () => {
    const r = reviewerReviewEnvelopeSchema.safeParse(designReviewerExample);
    expect(
      r.success,
      r.success ? "" : JSON.stringify(r.error.issues, null, 2),
    ).toBe(true);
  });
});

describe("envelope freshness enforcement", () => {
  it.each(FRESHNESS_FIELDS)(
    "developer completion missing freshness.%s is rejected",
    (field) => {
      const partial: Record<string, unknown> = { ...validFreshness };
      delete partial[field];
      const r = developerCompletionEnvelopeSchema.safeParse({
        ...designDeveloperExample,
        freshness: partial,
      });
      expect(r.success).toBe(false);
    },
  );

  it("rejects a developer completion missing the freshness object entirely", () => {
    const rest: Record<string, unknown> = { ...designDeveloperExample };
    delete rest.freshness;
    const r = developerCompletionEnvelopeSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it("rejects a developer completion with an unknown next_action", () => {
    const r = developerCompletionEnvelopeSchema.safeParse({
      ...designDeveloperExample,
      next_action: "go_for_lunch",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a developer completion with confidence > 1", () => {
    const r = developerCompletionEnvelopeSchema.safeParse({
      ...designDeveloperExample,
      confidence: 2,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a reviewer review with an unknown finding severity", () => {
    const bad = {
      ...designReviewerExample,
      role_specific: {
        findings: [
          {
            severity: "extreme",
            evidence: "x",
            confidence: 0.5,
          },
        ],
      },
    };
    const r = reviewerReviewEnvelopeSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});

describe("other envelopes accept well-formed payloads", () => {
  it("accepts an architect decomposition envelope with at least one proposed task", () => {
    const env = {
      version: 1,
      scope_id: "col-scope01",
      result: "done",
      confidence: 0.7,
      requires_human: true,
      risk_level: "medium",
      artifacts: [],
      policy_flags: [],
      next_action: "propose_decomposition",
      freshness: validFreshness,
      rationale: "Initial decomposition based on the seed scope brief.",
      role_specific: {
        proposed_tasks: [
          {
            proposed_task_id: "col-scope01.1",
            title: "schema",
            description: "Define CSV record format",
            acceptance_criteria: ["records include header row"],
            non_goals: [],
            suggested_role: "developer",
            suggested_capabilities: ["graph.read"],
          },
        ],
        proposed_dependencies: [],
        open_questions: [],
        assumptions: [],
      },
    };
    expect(architectDecompositionEnvelopeSchema.safeParse(env).success).toBe(
      true,
    );
  });

  it("rejects an architect decomposition envelope with zero proposed tasks", () => {
    const env = {
      version: 1,
      scope_id: "col-scope01",
      result: "done",
      confidence: 0.7,
      requires_human: true,
      risk_level: "medium",
      artifacts: [],
      policy_flags: [],
      next_action: "propose_decomposition",
      freshness: validFreshness,
      rationale: "",
      role_specific: {
        proposed_tasks: [],
        proposed_dependencies: [],
        open_questions: [],
        assumptions: [],
      },
    };
    expect(architectDecompositionEnvelopeSchema.safeParse(env).success).toBe(
      false,
    );
  });

  it("accepts a discovered work envelope", () => {
    const env = {
      version: 1,
      scope_id: "col-scope01",
      source_task_id: "col-scope01.2",
      result: "blocked",
      confidence: 0.6,
      requires_human: true,
      risk_level: "high",
      artifacts: [],
      policy_flags: [],
      next_action: "propose_discovered_work",
      freshness: validFreshness,
      rationale: "Found a related auth bug while wiring the export endpoint.",
      role_specific: {
        proposal_kind: "blocker",
        title: "auth middleware drops bearer tokens for streaming responses",
        description: "Streaming export gets 401 from the upstream proxy.",
        evidence: ["export_csv.go:L120"],
        affected_paths: ["pkg/auth/middleware.go"],
        urgency: "high",
        blocks_current_task: true,
      },
    };
    expect(discoveredWorkEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("accepts a blocked envelope", () => {
    const env = {
      version: 1,
      task_id: "col-scope01.3",
      result: "blocked",
      confidence: 0.95,
      requires_human: true,
      risk_level: "low",
      artifacts: [],
      policy_flags: [],
      next_action: "report_blocked",
      freshness: validFreshness,
      rationale: "Pipeline is failing on infra step; needs SRE.",
      role_specific: {
        blocker_class: "failing_pipeline",
        description: "deploy stage timing out on registry pull",
        needs_human: true,
        referenced_artifacts: ["pipeline:9999"],
      },
    };
    expect(blockedEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("accepts a merge readiness envelope", () => {
    const env = {
      version: 1,
      task_id: "col-scope01.2",
      result: "approved",
      confidence: 0.99,
      requires_human: false,
      risk_level: "low",
      artifacts: [
        {
          kind: "commit",
          id: "abc123",
          uri: "...",
          hash: "abc123",
        },
      ],
      policy_flags: [],
      next_action: "open_gate",
      freshness: validFreshness,
      rationale: "All gate inputs reconcile against the head SHA.",
      role_specific: {
        head_commit_sha: "abc123",
        pipeline_status: "success",
        pipeline_artifacts: [],
        approvals: [
          {
            artifact_id: "art-1",
            actor: "actor:human-1",
            commit_sha: "abc123",
            approved_at: "2026-04-23T16:00:00Z",
          },
        ],
        blocking_thread_count: 0,
        open_review_findings: 0,
        human_approval_required: true,
        human_approval_present: true,
      },
    };
    expect(mergeReadinessEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("accepts a scope review envelope", () => {
    const env = {
      version: 1,
      scope_id: "col-scope01",
      result: "approved",
      confidence: 0.85,
      requires_human: true,
      risk_level: "medium",
      artifacts: [],
      policy_flags: [],
      next_action: "open_gate",
      freshness: validFreshness,
      rationale: "All child tasks closed; one minor follow-up filed.",
      role_specific: {
        findings: [],
        unresolved_items: [],
        summary: "ok",
        recommendation: "approve_scope_close",
      },
    };
    expect(scopeReviewEnvelopeSchema.safeParse(env).success).toBe(true);
  });
});

describe("packets", () => {
  const baseTaskPacket = {
    version: 1,
    scope_id: "col-scope01",
    task_id: "col-scope01.2",
    provider_issue: {
      kind: "issue",
      id: "issue-200",
      uri: "https://gitlab.example.com/...",
    },
    repo: {
      url: "https://gitlab.example.com/group/proj.git",
      branch: "feature/csv-export",
      base_commit: "deadbeef",
    },
    goal: "Add CSV export endpoint",
    acceptance_criteria: ["streams bytes", "header in first row"],
    non_goals: ["xlsx support"],
    dependencies: [{ task_id: "col-scope01.1", state: "closed" }],
    provider_context: {
      provider: "gitlab",
      issue_id: "200",
      issue_url: "https://gitlab.example.com/...",
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
      constraints: [],
      protected_paths: [],
      security_labels: [],
      always_human_review: false,
      review_loop_cap: 3,
    },
    capabilities: ["provider.branch.push", "provider.mr.open"],
    required_outputs: [
      { kind: "mr", description: "merge request against main" },
      { kind: "commit", description: "head commit on the feature branch" },
    ],
    tool_permissions: ["git.fetch", "git.push"],
    sandbox_profile: "developer-default",
    known_risks: [],
    time_budget_minutes: 60,
    freshness: validFreshness,
  };

  it("accepts a complete task packet", () => {
    expect(taskPacketSchema.safeParse(baseTaskPacket).success).toBe(true);
  });

  it("rejects a task packet with bad scope_id format", () => {
    const r = taskPacketSchema.safeParse({
      ...baseTaskPacket,
      scope_id: "scope-200",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a task packet missing freshness fields", () => {
    const partialFreshness: Record<string, unknown> = { ...validFreshness };
    delete partialFreshness.policy_version;
    const r = taskPacketSchema.safeParse({
      ...baseTaskPacket,
      freshness: partialFreshness,
    });
    expect(r.success).toBe(false);
  });

  it("accepts a review packet that wraps a developer envelope", () => {
    const r = reviewPacketSchema.safeParse({
      ...baseTaskPacket,
      mr_id: "!42",
      commit_sha: "abc123",
      diff_summary: "+200 -10",
      developer_envelope: designDeveloperExample,
      pipeline_artifacts: [],
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(
      true,
    );
  });

  it("accepts a scope review packet with empty residue", () => {
    const env = {
      version: 1,
      scope_id: "col-scope01",
      provider_scope_artifact: {
        kind: "epic",
        id: "epic-1",
        uri: "https://gitlab.example.com/...",
      },
      repo: {
        url: "https://gitlab.example.com/group/proj.git",
        branch: "main",
        base_commit: "deadbeef",
      },
      scope_goal: "Add CSV export to reporting dashboard",
      scope_acceptance_criteria: ["dashboard exposes export button"],
      provider_context: {
        provider: "gitlab",
        issue_id: "100",
        issue_url: "https://gitlab.example.com/...",
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
        review_loop_cap: 3,
      },
      capabilities: ["graph.read"],
      required_outputs: [
        {
          kind: "scope_review_envelope",
          description: "scope review envelope",
        },
      ],
      tool_permissions: [],
      sandbox_profile: "reviewer-default",
      time_budget_minutes: 30,
      child_task_statuses: [
        { task_id: "col-scope01.1", state: "closed", title: "schema" },
      ],
      merged_artifacts: [],
      unresolved_conflicts: [],
      pending_sync_items: [],
      accepted_followups: [],
      rejected_proposals: [],
      release_deploy_state: { release_required: false },
      freshness: validFreshness,
    };
    const r = scopeReviewPacketSchema.safeParse(env);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(
      true,
    );
  });
});

describe("manifest", () => {
  it("registers all 10 schemas covered by COL-0.5", () => {
    expect(SCHEMAS).toHaveLength(10);
  });

  it("uses unique <kind>/<name>/<version> tuples", () => {
    const seen = new Set<string>();
    for (const s of SCHEMAS) {
      const key = `${s.kind}:${s.name}:v${s.version}`;
      expect(seen.has(key), `duplicate schema spec ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
