import { describe, expect, it } from "vitest";
import {
  supervisorWorkflowId,
  type ApprovalSignal,
  type PipelineUpdateSignal,
  type ProviderEventSignal,
} from "@colony/workflows";
import {
  buildApp,
  classifyGitLabWebhook,
  colonyTargetsFromRef,
  enrichSignalWithMirrorContext,
  type MirrorLookup,
  type WebhookDispatcherDeps,
} from "./app.js";

function testDeps(
  options: {
    readonly verified?: boolean;
    readonly claimed?: boolean;
    readonly signals?: Array<{
      readonly scope_id: string;
      readonly signal: ProviderEventSignal;
    }>;
    readonly approvalSignals?: Array<{
      readonly scope_id: string;
      readonly signal: ApprovalSignal;
    }>;
    readonly pipelineSignals?: Array<{
      readonly scope_id: string;
      readonly signal: PipelineUpdateSignal;
    }>;
  } = {},
): WebhookDispatcherDeps {
  return {
    verifier: {
      verify: () => options.verified ?? true,
    },
    dedup: {
      tryClaimWebhookEvent: () => Promise.resolve(options.claimed ?? true),
    },
    supervisor: {
      signalProviderEvent: (scope_id, signal) => {
        options.signals?.push({ scope_id, signal });
        return Promise.resolve({ workflow_id: supervisorWorkflowId(scope_id) });
      },
      signalApproval: (scope_id, signal) => {
        options.approvalSignals?.push({ scope_id, signal });
        return Promise.resolve({ workflow_id: supervisorWorkflowId(scope_id) });
      },
      signalPipelineUpdate: (scope_id, signal) => {
        options.pipelineSignals?.push({ scope_id, signal });
        return Promise.resolve({ workflow_id: supervisorWorkflowId(scope_id) });
      },
    },
  };
}

describe("@colony/webhook-dispatcher", () => {
  it("rejects invalid signatures", async () => {
    const app = buildApp(testDeps({ verified: false }));
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope_id: "col-hook",
        event_id: "evt-1",
        object_id: "issue-1",
      }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      accepted: false,
      error: "invalid or missing X-Gitlab-Token",
    });
  });

  it("ignores duplicate webhook events without signaling Temporal", async () => {
    const signals: Array<{ scope_id: string; signal: ProviderEventSignal }> =
      [];
    const app = buildApp(testDeps({ claimed: false, signals }));
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Issue Hook",
        "X-Gitlab-Event-UUID": "evt-dup",
      },
      body: JSON.stringify({
        scope_id: "col-hook",
        object_kind: "issue",
        object_id: "issue-1",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      event_uuid: "evt-dup",
    });
    expect(signals).toEqual([]);
  });

  it("signals the matching supervisor workflow for a valid synthetic event", async () => {
    const signals: Array<{ scope_id: string; signal: ProviderEventSignal }> =
      [];
    const app = buildApp(testDeps({ signals }));
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Issue Hook",
        "X-Gitlab-Event-UUID": "evt-ok",
      },
      body: JSON.stringify({
        scope_id: "col-hook",
        task_id: "col-hook.1",
        object_kind: "issue",
        object_id: "issue-1",
        actor: "human:op-1",
        attributes: { action: "open", ignored: { nested: true } },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      workflow_id: "supervisor-col-hook",
      event_uuid: "evt-ok",
    });
    expect(signals).toEqual([
      {
        scope_id: "col-hook",
        signal: expect.objectContaining({
          provider: "gitlab",
          event_id: "evt-ok",
          object_id: "issue-1",
          task_id: "col-hook.1",
          attributes: { action: "open", classification: "context_update" },
        }) as ProviderEventSignal,
      },
    ]);
  });

  it("dispatches approval webhooks to the workflow approval signal when the MR mirror resolves the task", async () => {
    const providerSignals: Array<{
      scope_id: string;
      signal: ProviderEventSignal;
    }> = [];
    const approvalSignals: Array<{
      scope_id: string;
      signal: ApprovalSignal;
    }> = [];
    const app = buildApp({
      ...testDeps({ signals: providerSignals, approvalSignals }),
      mirrors: {
        findMirror: (input) => {
          expect(input).toMatchObject({
            provider: "gitlab",
            provider_id: "100:7",
            provider_project_id: "100",
          });
          return Promise.resolve({
            entity_kind: "mr_pr",
            colony_id: "col-hook.1",
            source_version: JSON.stringify({
              head_commit_sha: "abc123",
              envelope_hash: "sha256:developer-envelope",
            }),
          });
        },
      },
    });
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Merge request approvals Hook",
        "X-Gitlab-Event-UUID": "evt-approval",
      },
      body: JSON.stringify({
        object_kind: "merge_request",
        object_attributes: {
          id: 987,
          iid: 7,
          sha: "abc123",
          updated_at: "2026-05-21T11:00:00.000Z",
        },
        user: { username: "human-op" },
        project: { id: 100, path_with_namespace: "colony/dev" },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      classified_as: "approval",
      workflow_id: "supervisor-col-hook",
      event_uuid: "evt-approval",
    });
    expect(providerSignals).toEqual([]);
    expect(approvalSignals).toEqual([
      {
        scope_id: "col-hook",
        signal: expect.objectContaining({
          task_id: "col-hook.1",
          actor: "human:human-op",
          artifact_id: "100:7",
          approval_id: "100:7",
          commit_sha: "abc123",
          envelope_hash: "sha256:developer-envelope",
        }) as ApprovalSignal,
      },
    ]);
  });

  it("dispatches a spec-MR approval as a scope-level approval signal", async () => {
    const approvalSignals: Array<{
      scope_id: string;
      signal: ApprovalSignal;
    }> = [];
    const app = buildApp({
      ...testDeps({ approvalSignals }),
      mirrors: {
        findMirror: () =>
          Promise.resolve({
            entity_kind: "scope",
            colony_id: "col-hook",
            source_version: "sha256:spec-envelope",
          }),
      },
    });
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Merge request approvals Hook",
        "X-Gitlab-Event-UUID": "evt-spec-approval",
      },
      body: JSON.stringify({
        object_kind: "approval",
        object_attributes: {
          iid: 24,
          sha: "spec-head-1",
          action: "approved",
        },
        user: { username: "human-spec-reviewer" },
        project: { id: 100, path_with_namespace: "colony/dev" },
      }),
    });

    expect(res.status).toBe(200);
    expect(approvalSignals).toHaveLength(1);
    expect(approvalSignals[0]?.scope_id).toBe("col-hook");
    expect(approvalSignals[0]?.signal).toMatchObject({
      actor: "human:human-spec-reviewer",
      commit_sha: "spec-head-1",
      envelope_hash: "sha256:spec-envelope",
    });
    expect(approvalSignals[0]?.signal.task_id).toBeUndefined();
  });

  it("does not turn a prose-only comment into a gate approval", async () => {
    const approvalSignals: Array<{
      scope_id: string;
      signal: ApprovalSignal;
    }> = [];
    const providerSignals: Array<{
      scope_id: string;
      signal: ProviderEventSignal;
    }> = [];
    const app = buildApp({
      ...testDeps({ approvalSignals, signals: providerSignals }),
      mirrors: {
        findMirror: () =>
          Promise.resolve({
            entity_kind: "mr_pr",
            colony_id: "col-hook.1",
          }),
      },
    });
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Note Hook",
        "X-Gitlab-Event-UUID": "evt-prose-only",
      },
      body: JSON.stringify({
        object_kind: "note",
        object_attributes: {
          id: 9,
          note: "Looks good to me.",
          noteable_type: "MergeRequest",
          noteable_id: 24,
        },
        user: { username: "human-spec-reviewer" },
        project: { id: 100, path_with_namespace: "colony/dev" },
      }),
    });

    expect(res.status).toBe(200);
    expect(approvalSignals).toEqual([]);
    expect(providerSignals[0]?.signal.attributes?.classification).toBe(
      "review_feedback",
    );
  });

  it("rejects an approval whose SHA is stale against the current MR head", async () => {
    const approvalSignals: Array<{
      scope_id: string;
      signal: ApprovalSignal;
    }> = [];
    const app = buildApp({
      ...testDeps({ approvalSignals }),
      mirrors: {
        findMirror: () =>
          Promise.resolve({
            entity_kind: "mr_pr",
            colony_id: "col-hook.1",
            source_version: JSON.stringify({
              head_commit_sha: "current-head",
              envelope_hash: "sha256:developer-envelope",
            }),
          }),
      },
    });
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Merge request approvals Hook",
        "X-Gitlab-Event-UUID": "evt-stale-approval",
      },
      body: JSON.stringify({
        object_kind: "approval",
        object_attributes: {
          iid: 7,
          sha: "old-head",
          action: "approved",
        },
        user: { username: "human-op" },
        project: { id: 100, path_with_namespace: "colony/dev" },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      accepted: false,
      error: "approval_evidence_invalid_or_stale",
    });
    expect(approvalSignals).toEqual([]);
  });

  it("dispatches pipeline webhooks to the workflow pipeline signal when the related MR mirror resolves the task", async () => {
    const providerSignals: Array<{
      scope_id: string;
      signal: ProviderEventSignal;
    }> = [];
    const pipelineSignals: Array<{
      scope_id: string;
      signal: PipelineUpdateSignal;
    }> = [];
    const app = buildApp({
      ...testDeps({ signals: providerSignals, pipelineSignals }),
      mirrors: {
        findMirror: (input) => {
          expect(input).toMatchObject({
            provider: "gitlab",
            provider_id: "100:7",
            provider_project_id: "100",
          });
          return Promise.resolve({
            entity_kind: "mr_pr",
            colony_id: "col-hook.1",
          });
        },
      },
    });
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Pipeline Hook",
        "X-Gitlab-Event-UUID": "evt-pipeline",
      },
      body: JSON.stringify({
        object_kind: "pipeline",
        object_attributes: {
          id: 42,
          status: "success",
          sha: "def456",
          updated_at: "2026-05-21T11:05:00.000Z",
        },
        merge_request: {
          id: 987,
          iid: 7,
        },
        project: { id: 100, path_with_namespace: "colony/dev" },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      classified_as: "context_update",
      workflow_id: "supervisor-col-hook",
      event_uuid: "evt-pipeline",
    });
    expect(providerSignals).toEqual([]);
    expect(pipelineSignals).toEqual([
      {
        scope_id: "col-hook",
        signal: expect.objectContaining({
          provider: "gitlab",
          task_id: "col-hook.1",
          pipeline_id: "42",
          status: "success",
          commit_sha: "def456",
        }) as PipelineUpdateSignal,
      },
    ]);
  });

  it("enriches provider commands with normalized noteable mirror context before dispatch", async () => {
    const providerSignals: Array<{
      scope_id: string;
      signal: ProviderEventSignal;
    }> = [];
    const app = buildApp({
      ...testDeps({ signals: providerSignals }),
      mirrors: {
        findMirror: (input) => {
          expect(input).toMatchObject({
            provider: "gitlab",
            provider_id: "100:42",
            provider_project_id: "100",
          });
          return Promise.resolve({
            entity_kind: "task",
            colony_id: "col-hook.1",
          });
        },
      },
    });
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Note Hook",
        "X-Gitlab-Event-UUID": "evt-cmd-route",
      },
      body: JSON.stringify({
        object_kind: "note",
        object_attributes: {
          id: 99,
          note: "/changes please add integration coverage",
          noteable_type: "Issue",
          noteable_id: 999,
          created_at: "2026-04-25T16:40:00.000Z",
          url: "https://gitlab.example/colony/dev/-/issues/42#note_99",
        },
        user: { username: "human-op" },
        project: { id: 100, path_with_namespace: "colony/dev" },
      }),
    });

    expect(res.status).toBe(200);
    expect(providerSignals).toHaveLength(1);
    expect(providerSignals[0]?.scope_id).toBe("col-hook");
    expect(providerSignals[0]?.signal.task_id).toBe("col-hook.1");
    expect(providerSignals[0]?.signal.reference?.object_id).toBe("100:42");
    expect(providerSignals[0]?.signal.attributes).toMatchObject({
      command_kind: "changes",
      command_target: "task",
      command_target_colony_id: "col-hook.1",
    });
  });

  it("routes scope-level approve commands to the decomposition gate target", async () => {
    const providerSignals: Array<{
      scope_id: string;
      signal: ProviderEventSignal;
    }> = [];
    const app = buildApp({
      ...testDeps({ signals: providerSignals }),
      mirrors: {
        findMirror: (input) => {
          expect(input).toMatchObject({
            provider: "gitlab",
            provider_id: "100:24",
            provider_project_id: "100",
          });
          return Promise.resolve({
            entity_kind: "scope",
            colony_id: "col-hook",
          });
        },
      },
    });
    const res = await app.request("http://x/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Note Hook",
        "X-Gitlab-Event-UUID": "evt-scope-approve",
      },
      body: JSON.stringify({
        object_kind: "note",
        object_attributes: {
          id: 100,
          note: "/approve",
          noteable_type: "Issue",
          noteable_id: 444,
          created_at: "2026-04-25T17:00:00.000Z",
          url: "https://gitlab.example/colony/dev/-/issues/24#note_100",
        },
        user: { username: "human-op" },
        project: { id: 100, path_with_namespace: "colony/dev" },
      }),
    });

    expect(res.status).toBe(200);
    expect(providerSignals).toHaveLength(1);
    expect(providerSignals[0]?.scope_id).toBe("col-hook");
    expect(providerSignals[0]?.signal.task_id).toBeUndefined();
    expect(providerSignals[0]?.signal.reference?.object_id).toBe("100:24");
    expect(providerSignals[0]?.signal.attributes).toMatchObject({
      command_kind: "approve",
      command_target: "scope_decomposition",
      command_target_colony_id: "col-hook",
    });
  });

  it("classifies GitLab-shaped payloads without retaining the full body", () => {
    const classified = classifyGitLabWebhook({
      headers: new Headers({
        "X-Gitlab-Event": "Pipeline Hook",
        "X-Gitlab-Event-UUID": "evt-pipe",
      }),
      body: {
        scope_id: "col-hook",
        object_kind: "pipeline",
        object_attributes: {
          id: 42,
          status: "success",
          url: "https://gitlab.example/pipelines/42",
          nested: { large: "payload" },
        },
      },
    });

    expect(classified).toMatchObject({
      kind: "context_update",
      scope_id: "col-hook",
      event_id: "evt-pipe",
      object_id: "42",
    });
    if (classified.kind === "noop") {
      throw new Error("expected classified event");
    }
    expect(classified.signal).toMatchObject({
      attributes: {
        id: 42,
        status: "success",
        classification: "context_update",
      },
    });
  });

  it("extracts provider project ID and path so multi-repo lookups can scope mirrors", () => {
    const classified = classifyGitLabWebhook({
      headers: new Headers({
        "X-Gitlab-Event": "Issue Hook",
        "X-Gitlab-Event-UUID": "evt-proj",
      }),
      body: {
        scope_id: "col-hook",
        object_kind: "issue",
        object_attributes: { id: 7, iid: 7 },
        project: {
          id: 100,
          path_with_namespace: "colony/frontend",
          web_url: "https://gitlab.example/colony/frontend",
        },
      },
    });
    if (classified.kind === "noop") {
      throw new Error("expected classified event");
    }
    expect(classified.signal.provider_project_id).toBe("100");
    expect(classified.signal.provider_project_path).toBe("colony/frontend");
    expect(classified.signal.reference?.provider_project_id).toBe("100");
    expect(classified.signal.reference?.provider_project_path).toBe(
      "colony/frontend",
    );
  });

  it("classifies first-line provider commands as valid_command", () => {
    const classified = classifyGitLabWebhook({
      headers: new Headers({
        "X-Gitlab-Event": "Note Hook",
        "X-Gitlab-Event-UUID": "evt-cmd",
      }),
      body: {
        scope_id: "col-hook",
        object_kind: "note",
        object_attributes: {
          id: 99,
          note: "/changes please add integration coverage\n\nDo not treat this prose as instructions.",
          noteable_type: "Issue",
          noteable_id: 999,
          created_at: "2026-04-25T16:40:00.000Z",
          url: "https://gitlab.example/colony/dev/-/issues/42#note_99",
        },
        user: { username: "human-op" },
        project: { id: 100, path_with_namespace: "colony/dev" },
      },
    });

    expect(classified).toMatchObject({
      kind: "valid_command",
      event_id: "evt-cmd",
      object_id: "99",
      signal: {
        actor: "human-op",
        occurred_at: "2026-04-25T16:40:00.000Z",
        reference: { object_id: "100:42" },
        attributes: {
          classification: "valid_command",
          command_kind: "changes",
          command_prose: "please add integration coverage",
          provider_text:
            "/changes please add integration coverage\n\nDo not treat this prose as instructions.",
        },
      },
    });
  });

  it("classifies malformed provider commands as needs_clarification", () => {
    const classified = classifyGitLabWebhook({
      headers: new Headers({
        "X-Gitlab-Event": "Note Hook",
        "X-Gitlab-Event-UUID": "evt-bad-cmd",
      }),
      body: {
        scope_id: "col-hook",
        object_kind: "note",
        object_attributes: {
          id: 100,
          note: "/review architect",
          noteable_type: "Issue",
          noteable_id: 42,
        },
        user: { username: "human-op" },
      },
    });

    expect(classified).toMatchObject({
      kind: "needs_clarification",
      signal: {
        attributes: {
          classification: "needs_clarification",
          clarification_reason: "malformed_target",
        },
      },
    });
  });

  it("classifies non-command issue comments as context_update", () => {
    const classified = classifyGitLabWebhook({
      headers: new Headers({
        "X-Gitlab-Event": "Note Hook",
        "X-Gitlab-Event-UUID": "evt-context",
      }),
      body: {
        scope_id: "col-hook",
        object_kind: "note",
        object_attributes: {
          id: 101,
          note: "I found one more edge case.",
          noteable_type: "Issue",
          noteable_id: 42,
        },
      },
    });

    expect(classified).toMatchObject({
      kind: "context_update",
      signal: {
        attributes: {
          classification: "context_update",
          provider_text: "I found one more edge case.",
        },
      },
    });
  });

  it("classifies merge request comments as review_feedback", () => {
    const classified = classifyGitLabWebhook({
      headers: new Headers({
        "X-Gitlab-Event": "Note Hook",
        "X-Gitlab-Event-UUID": "evt-review-feedback",
      }),
      body: {
        scope_id: "col-hook",
        object_kind: "note",
        object_attributes: {
          id: 102,
          note: "This branch needs a smaller diff.",
          noteable_type: "MergeRequest",
          noteable_id: 11,
        },
      },
    });

    expect(classified.kind).toBe("review_feedback");
    expect(
      classified.kind !== "noop" && classified.signal.attributes,
    ).toMatchObject({
      classification: "review_feedback",
      provider_text: "This branch needs a smaller diff.",
    });
  });

  it("classifies issue edits and label changes as context_update", () => {
    for (const action of ["update", "label"] as const) {
      const classified = classifyGitLabWebhook({
        headers: new Headers({
          "X-Gitlab-Event": "Issue Hook",
          "X-Gitlab-Event-UUID": `evt-issue-${action}`,
        }),
        body: {
          scope_id: "col-hook",
          object_kind: "issue",
          object_attributes: { id: 42, action },
        },
      });

      expect(classified).toMatchObject({
        kind: "context_update",
        signal: { attributes: { classification: "context_update", action } },
      });
    }
  });

  it("classifies close and reopen events as conflict", () => {
    for (const action of ["close", "reopen"] as const) {
      const classified = classifyGitLabWebhook({
        headers: new Headers({
          "X-Gitlab-Event": "Issue Hook",
          "X-Gitlab-Event-UUID": `evt-issue-${action}`,
        }),
        body: {
          scope_id: "col-hook",
          object_kind: "issue",
          object_attributes: { id: 42, action },
        },
      });

      expect(classified).toMatchObject({
        kind: "conflict",
        signal: { attributes: { classification: "conflict", action } },
      });
    }
  });

  it("classifies approval, MR update, and pipeline events", () => {
    const approval = classifyGitLabWebhook({
      headers: new Headers({
        "X-Gitlab-Event": "Merge request approvals Hook",
        "X-Gitlab-Event-UUID": "evt-approval",
      }),
      body: {
        scope_id: "col-hook",
        object_kind: "approval",
        object_attributes: { id: 11, action: "approved" },
      },
    });
    const mrUpdate = classifyGitLabWebhook({
      headers: new Headers({
        "X-Gitlab-Event": "Merge Request Hook",
        "X-Gitlab-Event-UUID": "evt-mr",
      }),
      body: {
        scope_id: "col-hook",
        object_kind: "merge_request",
        object_attributes: { id: 11, action: "update" },
      },
    });
    const pipeline = classifyGitLabWebhook({
      headers: new Headers({
        "X-Gitlab-Event": "Pipeline Hook",
        "X-Gitlab-Event-UUID": "evt-pipeline",
      }),
      body: {
        scope_id: "col-hook",
        object_kind: "pipeline",
        object_attributes: { id: 12, status: "success" },
      },
    });

    expect(approval.kind).toBe("approval");
    expect(mrUpdate.kind).toBe("context_update");
    expect(pipeline.kind).toBe("context_update");
  });

  describe("enrichSignalWithMirrorContext", () => {
    function commandSignal(
      overrides: Partial<ProviderEventSignal> = {},
    ): ProviderEventSignal {
      return {
        provider: "gitlab",
        event_type: "Note Hook",
        event_id: "evt-cmd-1",
        object_kind: "note",
        object_id: "note-7",
        provider_project_id: "49",
        reference: { provider: "gitlab", object_id: "issue-100" },
        attributes: { command_kind: "approve" },
        ...overrides,
      };
    }
    const stubMirrors = (
      result: Awaited<ReturnType<MirrorLookup["findMirror"]>>,
    ): MirrorLookup => ({ findMirror: () => Promise.resolve(result) });

    it("tags scope-level commands with command_target=scope_decomposition", async () => {
      const signal = commandSignal();
      await enrichSignalWithMirrorContext(
        signal,
        stubMirrors({ entity_kind: "scope", colony_id: "col-rt" }),
      );
      expect(signal.attributes?.command_target).toBe("scope_decomposition");
      expect(signal.attributes?.command_target_colony_id).toBe("col-rt");
    });

    it("tags task-level commands with command_target=task", async () => {
      const signal = commandSignal();
      await enrichSignalWithMirrorContext(
        signal,
        stubMirrors({ entity_kind: "task", colony_id: "col-rt.1" }),
      );
      expect(signal.attributes?.command_target).toBe("task");
      expect(signal.attributes?.command_target_colony_id).toBe("col-rt.1");
    });

    it("is a no-op when the mirror lookup returns null", async () => {
      const signal = commandSignal();
      await enrichSignalWithMirrorContext(signal, stubMirrors(null));
      expect(signal.attributes?.command_target).toBeUndefined();
    });

    it("is a no-op when the signal has no command_kind", async () => {
      const signal = commandSignal({ attributes: {} });
      await enrichSignalWithMirrorContext(
        signal,
        stubMirrors({ entity_kind: "scope", colony_id: "col-rt" }),
      );
      expect(signal.attributes?.command_target).toBeUndefined();
    });
  });
});

describe("colonyTargetsFromRef", () => {
  it("resolves task and scope from a developer branch ref", () => {
    expect(colonyTargetsFromRef("colony/col-tempodd7a.1")).toEqual({
      scope_id: "col-tempodd7a",
      task_id: "col-tempodd7a.1",
    });
  });

  it("resolves scope from an architect spec branch ref", () => {
    expect(colonyTargetsFromRef("colony/spec-col-tempodd7a")).toEqual({
      scope_id: "col-tempodd7a",
    });
  });

  it("strips a refs/heads/ prefix", () => {
    expect(
      colonyTargetsFromRef("refs/heads/colony/col-tempodd7a.1").task_id,
    ).toBe("col-tempodd7a.1");
  });

  it("ignores refs outside the colony namespace", () => {
    expect(colonyTargetsFromRef("main")).toEqual({});
    expect(colonyTargetsFromRef("feature/colony-ish")).toEqual({});
    expect(colonyTargetsFromRef(undefined)).toEqual({});
  });

  it("ignores a colony ref whose tail is not a task or scope id", () => {
    expect(colonyTargetsFromRef("colony/not-a-task")).toEqual({});
    expect(colonyTargetsFromRef("colony/spec-nope")).toEqual({});
  });
});
