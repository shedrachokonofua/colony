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

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
