import { describe, expect, it } from "vitest";
import {
  supervisorWorkflowId,
  type ProviderEventSignal,
} from "@colony/workflows";
import {
  buildApp,
  classifyGitLabWebhook,
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
          attributes: { action: "open" },
        }) as ProviderEventSignal,
      },
    ]);
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
      kind: "provider_event",
      scope_id: "col-hook",
      event_id: "evt-pipe",
      object_id: "42",
    });
    expect(
      classified.kind === "provider_event" && classified.signal,
    ).toMatchObject({
      attributes: { id: 42, status: "success" },
    });
  });
});
