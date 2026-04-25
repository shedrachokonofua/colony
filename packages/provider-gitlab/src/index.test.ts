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
      token: "admin-token",
      fetch: fetchMock,
    });
    const result = await adapter.bootstrap({
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
    });

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

describe("GitLabProviderAdapter projects", () => {
  it("creates a new project under a namespace using the bot PAT (no admin credential)", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
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
      if (method === "GET" && path === "/projects/colony%2Ffrontend") {
        return Promise.resolve(json(null, 404));
      }
      if (method === "POST" && path === "/projects") {
        return Promise.resolve(
          json({
            id: 555,
            path: "frontend",
            path_with_namespace: "colony/frontend",
            default_branch: "main",
            visibility: "private",
            web_url: "https://gitlab.test/colony/frontend",
          }),
        );
      }
      return Promise.resolve(
        json({ error: `unexpected ${method} ${path}` }, 500),
      );
    };
    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot-token",
      fetch: fetchMock,
    });
    const created = await adapter.projects.create({
      name: "Frontend",
      path: "frontend",
      namespace: "colony",
      visibility: "private",
    });
    expect(created.id).toBe("555");
    expect(created.path).toBe("colony/frontend");
    expect(created.default_branch).toBe("main");
    expect(created.visibility).toBe("private");
    // Bot PAT (PRIVATE-TOKEN: bot-token), not an admin credential.
    expect(calls.every((c) => !c.url.includes("admin"))).toBe(true);
  });

  it("returns the existing project when create is called against a path that already exists", async () => {
    const fetchMock: typeof fetch = (url, init) => {
      const method = init?.method ?? "GET";
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const path = urlText.replace("https://gitlab.test/api/v4", "");
      if (method === "GET" && path === "/projects/g%2Fbackend") {
        return Promise.resolve(
          json({
            id: 700,
            path: "backend",
            path_with_namespace: "g/backend",
            default_branch: "main",
            visibility: "internal",
          }),
        );
      }
      return Promise.resolve(
        json({ error: `unexpected ${method} ${path}` }, 500),
      );
    };
    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot-token",
      fetch: fetchMock,
    });
    const result = await adapter.projects.create({
      name: "Backend",
      path: "backend",
      namespace: "g",
    });
    expect(result.id).toBe("700");
    expect(result.visibility).toBe("internal");
  });

  it("looks projects up by id and by path", async () => {
    const fetchMock: typeof fetch = (url) => {
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const path = urlText.replace("https://gitlab.test/api/v4", "");
      if (path === "/projects/42") {
        return Promise.resolve(
          json({
            id: 42,
            path: "x",
            path_with_namespace: "g/x",
            default_branch: "trunk",
            visibility: "public",
          }),
        );
      }
      if (path === "/projects/g%2Fmissing") {
        return Promise.resolve(json(null, 404));
      }
      return Promise.resolve(json({ error: `unexpected ${path}` }, 500));
    };
    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot-token",
      fetch: fetchMock,
    });
    const byId = await adapter.projects.getById("42");
    expect(byId).toMatchObject({
      id: "42",
      default_branch: "trunk",
      visibility: "public",
    });
    expect(await adapter.projects.getByPath("g/missing")).toBeNull();
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
      fetch: fetchMock,
    });
    const project = { id: "20", path: "colony/dev" } as const;

    const created = await adapter.issues.create(project, {
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

    const updated = await adapter.issues.update(project, created.id, {
      title: "Updated task",
      assignee_ids: ["91"],
    });
    expect(updated.title).toBe("Updated task");
    expect(updated.assignee_ids).toEqual(["91"]);

    await expect(
      adapter.issues.addLabel(project, created.id, "agent:developer"),
    ).resolves.toMatchObject({ labels: ["state:ready", "agent:developer"] });
    await expect(
      adapter.issues.removeLabel(project, created.id, "state:ready"),
    ).resolves.toMatchObject({ labels: ["agent:developer"] });

    const comment = await adapter.issues.comment(
      project,
      created.id,
      "Looks good",
    );
    expect(comment).toMatchObject({
      id: "801",
      body: "Looks good",
      author_id: "91",
    });

    await expect(
      adapter.issues.close(project, created.id),
    ).resolves.toMatchObject({ state: "closed" });
    await expect(
      adapter.issues.reopen(project, created.id),
    ).resolves.toMatchObject({ state: "opened" });

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

  it("routes the same iid to different projects when the project ref changes", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock: typeof fetch = (url, init) => {
      const method = init?.method ?? "GET";
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      calls.push({ url: urlText, method });
      const path = urlText.replace("https://gitlab.test/api/v4", "");
      const projectMatch = /^\/projects\/(\d+)\/issues$/.exec(path);
      if (method === "POST" && projectMatch) {
        const projectId = Number(projectMatch[1]);
        return Promise.resolve(
          json({
            id: projectId * 10,
            iid: 1,
            project_id: projectId,
            title: "x",
            description: "",
            state: "opened",
            labels: [],
          }),
        );
      }
      return Promise.resolve(
        json({ error: `unexpected ${method} ${path}` }, 500),
      );
    };
    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot",
      fetch: fetchMock,
    });
    const fe = await adapter.issues.create(
      { id: "100", path: "g/fe" },
      { title: "fe", description: "" },
    );
    const be = await adapter.issues.create(
      { id: "200", path: "g/be" },
      { title: "be", description: "" },
    );
    expect(fe.id).toBe("100:1");
    expect(be.id).toBe("200:1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://gitlab.test/api/v4/projects/100/issues",
      "https://gitlab.test/api/v4/projects/200/issues",
    ]);
  });

});

const describeLive =
  process.env.GITLAB_BASE_URL && process.env.GITLAB_TOKEN
    ? describe
    : describe.skip;

/**
 * Self-bootstrapping multi-repo live integration test (COL-1.2b acceptance).
 *
 * Requires only GITLAB_BASE_URL + GITLAB_TOKEN. The token's scope decides
 * what succeeds; for a homelab admin PAT everything below works. The test:
 *
 *   1. discovers the bot's identity/default namespace,
 *   2. creates a throwaway top-level group `colony-it-<ts>`,
 *   3. provisions two sibling projects `a` and `b` under it,
 *   4. drives the full issue lifecycle on both, asserting that the same
 *      iid in the two projects produces *distinct* namespaced IDs (the
 *      acceptance check that the multi-repo target model holds), and
 *   5. cleans up by deleting the group (cascades to projects).
 *
 * Cleanup is best-effort. If the group delete is delayed/async (default on
 * GitLab), the resources tagged with the run timestamp will eventually be
 * removed; subsequent runs use a fresh timestamp.
 */
describeLive("GitLabProviderAdapter live multi-repo integration", () => {
  it(
    "self-bootstraps a group, two projects, runs issue lifecycle on each, and cleans up",
    async () => {
      const adapter = new GitLabProviderAdapter({
        baseUrl: process.env.GITLAB_BASE_URL!,
        token: process.env.GITLAB_TOKEN!,
      });

      const me = await adapter.identity();
      expect(me.username).toBeTruthy();
      expect(me.default_namespace).toBeTruthy();

      const stamp = Date.now();
      const groupPath = `colony-it-${stamp}`;
      let groupId: string | null = null;

      try {
        const group = await adapter.groups.create({
          name: `Colony IT ${stamp}`,
          path: groupPath,
          visibility: "private",
          description: "Throwaway group created by Colony integration tests.",
        });
        groupId = group.id;
        expect(group.path).toBe(groupPath);

        const projectA = await adapter.projects.create({
          name: "a",
          path: "a",
          namespace: group.id,
          visibility: "private",
        });
        const projectB = await adapter.projects.create({
          name: "b",
          path: "b",
          namespace: group.id,
          visibility: "private",
        });
        expect(projectA.id).not.toBe(projectB.id);
        expect(projectA.path).toBe(`${groupPath}/a`);
        expect(projectB.path).toBe(`${groupPath}/b`);

        // Issue lifecycle on both projects in parallel — same workflow,
        // different project context per call. The IDs returned must be
        // namespaced by project so identical iids don't collide.
        const [issueA, issueB] = await Promise.all([
          adapter.issues.create(projectA, {
            title: "live-it: a",
            description: "Created by Colony integ test.",
            labels: ["colony:integration"],
          }),
          adapter.issues.create(projectB, {
            title: "live-it: b",
            description: "Created by Colony integ test.",
            labels: ["colony:integration"],
          }),
        ]);
        expect(issueA.id).toContain(":");
        expect(issueB.id).toContain(":");
        expect(issueA.id).not.toBe(issueB.id);
        expect(issueA.id.startsWith(`${projectA.id}:`)).toBe(true);
        expect(issueB.id.startsWith(`${projectB.id}:`)).toBe(true);

        const label = `colony:test:${stamp}`;
        const [labeledA, labeledB] = await Promise.all([
          adapter.issues.addLabel(projectA, issueA.id, label),
          adapter.issues.addLabel(projectB, issueB.id, label),
        ]);
        expect(labeledA.labels).toContain(label);
        expect(labeledB.labels).toContain(label);

        await Promise.all([
          adapter.issues
            .comment(projectA, issueA.id, "from-a")
            .then((c) => expect(c.body).toBe("from-a")),
          adapter.issues
            .comment(projectB, issueB.id, "from-b")
            .then((c) => expect(c.body).toBe("from-b")),
        ]);

        await Promise.all([
          adapter.issues.close(projectA, issueA.id),
          adapter.issues.close(projectB, issueB.id),
        ]);

        // Sanity: getByPath round-trips, proving project context is what
        // the registry would store for these mirrors.
        const fetchedA = await adapter.projects.getByPath(`${groupPath}/a`);
        expect(fetchedA?.id).toBe(projectA.id);
      } finally {
        if (groupId) {
          // GitLab delete is async (returns 202); failure here is best-effort.
          await adapter.groups.delete(groupId).catch(() => {});
        }
      }
    },
    120_000,
  );
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
