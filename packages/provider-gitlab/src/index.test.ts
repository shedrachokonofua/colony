import { describe, expect, it } from "vitest";
import { GitLabProviderAdapter } from "./index.js";

describe("GitLabProviderAdapter bootstrap", () => {
  it("provisions resources through the GitLab API and returns normalized IDs", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let userId = 30;
    const fetchMock: typeof fetch = (url, init) => {
      const method = init?.method ?? "GET";
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      calls.push({
        url: urlText,
        method,
        body: rawBody ? (JSON.parse(rawBody) as unknown) : undefined,
      });

      const path = urlText.replace("https://gitlab.test/api/v4", "");
      if (method === "GET" && path === "/groups/colony") {
        return Promise.resolve(json(null, 404));
      }
      if (method === "POST" && path === "/groups") {
        return Promise.resolve(json({ id: 10 }));
      }
      if (method === "GET" && path === "/projects/colony%2Fdev") {
        return Promise.resolve(json(null, 404));
      }
      if (method === "POST" && path === "/projects") {
        return Promise.resolve(json({ id: 20 }));
      }
      if (method === "GET" && path.startsWith("/users?username=")) {
        return Promise.resolve(json([]));
      }
      if (method === "POST" && path === "/users") {
        return Promise.resolve(
          json({ id: userId++, username: "bot", name: "Bot" }),
        );
      }
      if (method === "POST" && path.includes("/personal_access_tokens")) {
        return Promise.resolve(
          json({ id: `token-${userId}`, token: `secret-token-${userId}` }),
        );
      }
      if (method === "GET" && path === "/applications") {
        return Promise.resolve(json([]));
      }
      if (method === "POST" && path === "/applications") {
        return Promise.resolve(
          json({
            id: 40,
            application_id: "oauth-client-id",
            secret: "oauth-secret",
          }),
        );
      }
      if (method === "GET" && path === "/projects/20/hooks") {
        return Promise.resolve(json([]));
      }
      if (method === "POST" && path === "/projects/20/hooks") {
        return Promise.resolve(json({ id: 50 }));
      }
      return Promise.resolve(
        json({ error: `unexpected ${method} ${path}` }, 500),
      );
    };

    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      fetch: fetchMock,
    });
    const result = await adapter.bootstrap(
      {
        provider: "gitlab",
        environment: "dev",
        base_url: "https://gitlab.test",
        group: { name: "Colony", path: "colony" },
        project: { name: "Dev", path: "dev" },
        oauth_application: {
          name: "Colony Web",
          redirect_uris: ["https://colony.test/oauth/callback"],
          scopes: ["read_user"],
        },
        webhook: {
          url: "https://colony.test/webhook/gitlab",
          secret: "hook-secret",
        },
      },
      { kind: "admin_pat", token: "admin-token" },
    );

    expect(result.group.id).toBe("10");
    expect(result.project.id).toBe("20");
    expect(result.oauth_application.client_id).toBe("oauth-client-id");
    expect(result.webhook.id).toBe("50");
    expect(result.actions.map((a) => a.resource)).toEqual([
      "group",
      "project",
      "bot:engine",
      "bot:reviewer",
      "bot_token:engine",
      "bot_token:reviewer",
      "oauth_application",
      "webhook",
    ]);
    expect(calls.some((c) => c.url.endsWith("/projects/20/hooks"))).toBe(true);
  });
});

describe("GitLabProviderAdapter issues", () => {
  it("creates, updates, labels, comments, assigns, closes, reopens, and resolves users", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const issue = {
      id: 701,
      iid: 7,
      project_id: 20,
      title: "Task",
      description: "Do work",
      state: "opened",
      labels: ["state:ready"],
      assignees: [] as Array<{ id: number; username: string; name: string }>,
      web_url: "https://gitlab.test/colony/dev/-/issues/7",
    };
    const fetchMock: typeof fetch = (url, init) => {
      const method = init?.method ?? "GET";
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      const body = rawBody
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : {};
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      calls.push({ url: urlText, method, body });

      const path = urlText.replace("https://gitlab.test/api/v4", "");
      if (method === "POST" && path === "/projects/20/issues") {
        issue.title = stringField(body, "title");
        issue.description = stringField(body, "description");
        issue.labels = stringField(body, "labels").split(",");
        return Promise.resolve(json(issue));
      }
      if (method === "PUT" && path === "/projects/20/issues/7") {
        if (body.title) issue.title = stringField(body, "title");
        if (body.description) {
          issue.description = stringField(body, "description");
        }
        if (body.labels) issue.labels = stringField(body, "labels").split(",");
        if (body.add_labels) {
          issue.labels = [
            ...new Set([
              ...issue.labels,
              ...stringField(body, "add_labels").split(","),
            ]),
          ];
        }
        if (body.remove_labels) {
          const removed = new Set(
            stringField(body, "remove_labels").split(","),
          );
          issue.labels = issue.labels.filter((label) => !removed.has(label));
        }
        if (Array.isArray(body.assignee_ids)) {
          issue.assignees = body.assignee_ids.map((id) => ({
            id: Number(id),
            username: `user-${String(id)}`,
            name: `User ${String(id)}`,
          }));
        }
        if (body.state_event === "close") issue.state = "closed";
        if (body.state_event === "reopen") issue.state = "opened";
        return Promise.resolve(json(issue));
      }
      if (method === "POST" && path === "/projects/20/issues/7/notes") {
        return Promise.resolve(
          json({
            id: 801,
            body: stringField(body, "body"),
            author: { id: 91, username: "colony-engine", name: "Engine" },
            created_at: "2026-01-01T00:00:00.000Z",
          }),
        );
      }
      if (method === "GET" && path === "/users/91") {
        return Promise.resolve(
          json({
            id: 91,
            username: "colony-engine",
            name: "Engine",
            bot: true,
          }),
        );
      }
      if (method === "GET" && path === "/users?username=colony-engine") {
        return Promise.resolve(
          json([
            { id: 91, username: "colony-engine", name: "Engine", bot: true },
          ]),
        );
      }
      return Promise.resolve(
        json({ error: `unexpected ${method} ${path}` }, 500),
      );
    };

    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot-token",
      projectId: "20",
      fetch: fetchMock,
    });

    const created = await adapter.issues.create({
      title: "Task",
      description: "Do work",
      labels: ["state:ready"],
    });
    expect(created.id).toBe("20:7");
    expect(created.iid).toBe(7);
    expect(created.metadata.provider).toBe("gitlab");
    expect(created.metadata.web_url).toBe(
      "https://gitlab.test/colony/dev/-/issues/7",
    );

    const updated = await adapter.issues.update(created.id, {
      title: "Updated task",
      assignee_ids: ["91"],
    });
    expect(updated.title).toBe("Updated task");
    expect(updated.assignee_ids).toEqual(["91"]);

    await expect(
      adapter.issues.addLabel(created.id, "agent:developer"),
    ).resolves.toMatchObject({ labels: ["state:ready", "agent:developer"] });
    await expect(
      adapter.issues.removeLabel(created.id, "state:ready"),
    ).resolves.toMatchObject({ labels: ["agent:developer"] });

    const comment = await adapter.issues.comment(created.id, "Looks good");
    expect(comment).toMatchObject({
      id: "801",
      body: "Looks good",
      author_id: "91",
    });

    await expect(adapter.issues.close(created.id)).resolves.toMatchObject({
      state: "closed",
    });
    await expect(adapter.issues.reopen(created.id)).resolves.toMatchObject({
      state: "opened",
    });

    await expect(adapter.users.resolveById("91")).resolves.toMatchObject({
      id: "91",
      username: "colony-engine",
      bot: true,
    });
    await expect(
      adapter.users.resolveByUsername("colony-engine"),
    ).resolves.toMatchObject({ id: "91" });

    expect(calls.some((c) => c.url.endsWith("/projects/20/issues/7"))).toBe(
      true,
    );
  });
});

const describeLive =
  process.env.GITLAB_BASE_URL &&
  process.env.GITLAB_TOKEN &&
  process.env.GITLAB_DEV_PROJECT_ID
    ? describe
    : describe.skip;

describeLive("GitLabProviderAdapter live issue integration", () => {
  it("covers the issue mirror lifecycle against the configured home-lab GitLab", async () => {
    const adapter = new GitLabProviderAdapter({
      baseUrl: process.env.GITLAB_BASE_URL!,
      token: process.env.GITLAB_TOKEN!,
      projectId: process.env.GITLAB_DEV_PROJECT_ID!,
    });
    const label = `colony:test:${Date.now()}`;

    const issue = await adapter.issues.create({
      title: `Colony adapter integration ${new Date().toISOString()}`,
      description: "Created by packages/provider-gitlab integration test.",
      labels: ["colony:integration"],
    });

    try {
      expect(issue.id).toContain(":");
      await expect(
        adapter.issues.update(issue.id, {
          description: "Updated by integration test.",
        }),
      ).resolves.toMatchObject({
        description: "Updated by integration test.",
      });
      const labeled = await adapter.issues.addLabel(issue.id, label);
      expect(labeled.labels).toContain(label);
      await expect(
        adapter.issues.comment(issue.id, "Integration note"),
      ).resolves.toMatchObject({ body: "Integration note" });
    } finally {
      await adapter.issues.close(issue.id);
    }
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stringField(
  body: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new Error(`expected ${field} to be a string`);
  }
  return value;
}
