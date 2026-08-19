import { describe, expect, it } from "bun:test";
import { GitLabProviderAdapter, GitLabProviderError } from "./index.js";

describe("GitLabProviderAdapter bootstrap", () => {
  it("provisions resources through the GitLab API and returns normalized IDs", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let userId = 30;
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
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
      "bot:architect",
      "bot:integrator",
      "bot:memory_consolidator",
      "bot:supervisor",
      "bot_token:engine",
      "bot_token:reviewer",
      "bot_token:architect",
      "bot_token:integrator",
      "bot_token:memory_consolidator",
      "bot_token:supervisor",
      "oauth_application",
      "webhook",
    ]);
    expect(result.bot_tokens.architect).toMatch(/^secret-token-/);
    expect(result.env.GITLAB_BOT_ARCHITECT_TOKEN).toMatch(/^secret-token-/);
    expect(calls.some((c) => c.url.endsWith("/projects/20/hooks"))).toBe(true);
  });
});

describe("GitLabProviderAdapter projects", () => {
  it("creates a new project under a namespace using the bot PAT (no admin credential)", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
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
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
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
    const fetchMock = (url: string | URL | Request) => {
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

describe("GitLabProviderAdapter accessTokens", () => {
  it("mints and revokes project access tokens", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const body = rawBody ? (JSON.parse(rawBody) as unknown) : undefined;
      calls.push({ url: urlText, method, body });
      const path = urlText.replace("https://gitlab.test/api/v4", "");
      if (method === "POST" && path === "/projects/20/access_tokens") {
        return Promise.resolve(
          json({
            id: 901,
            project_id: 20,
            name: "colony-task-col-demo.1",
            token: "glpat-task-token",
            scopes: ["api", "write_repository"],
            expires_at: "2026-05-02",
          }),
        );
      }
      if (method === "DELETE" && path === "/projects/20/access_tokens/901") {
        return Promise.resolve(new Response(null, { status: 204 }));
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

    const minted = await adapter.accessTokens.mint(project, {
      name: "colony-task-col-demo.1",
      scopes: ["api", "write_repository"],
      access_level: 30,
      expires_at: "2026-05-02",
    });
    expect(minted).toMatchObject({
      id: "901",
      project_id: "20",
      token: "glpat-task-token",
      scopes: ["api", "write_repository"],
      expires_at: "2026-05-02",
    });
    await expect(adapter.accessTokens.revoke(project, minted.id)).resolves.toBe(
      undefined,
    );
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://gitlab.test/api/v4/projects/20/access_tokens",
      "DELETE https://gitlab.test/api/v4/projects/20/access_tokens/901",
    ]);
    expect(calls[0]?.body).toEqual({
      name: "colony-task-col-demo.1",
      scopes: ["api", "write_repository"],
      access_level: 30,
      expires_at: "2026-05-02",
    });
  });

  it("lists active project access tokens without requiring the secret", async () => {
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const path = urlText.replace("https://gitlab.test/api/v4", "");
      if (method === "GET" && path === "/projects/20/access_tokens") {
        return Promise.resolve(
          json([
            {
              id: 901,
              project_id: 20,
              name: "colony-task-col-demo.1",
              scopes: ["api"],
              expires_at: "2026-05-02",
              active: true,
            },
            {
              id: 902,
              project_id: 20,
              name: "colony-task-old",
              scopes: ["api"],
              expires_at: "2026-05-02",
              active: false,
            },
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
    const listed = await adapter.accessTokens.list({ id: "20" });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: "901",
      name: "colony-task-col-demo.1",
      token: "",
    });
  });

  it("treats revoke 404 as already revoked", async () => {
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const path = urlText.replace("https://gitlab.test/api/v4", "");
      if (method === "DELETE" && path === "/projects/20/access_tokens/901") {
        return Promise.resolve(json({ message: "404 Token Not Found" }, 404));
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

    await expect(
      adapter.accessTokens.revoke({ id: "20" }, "901"),
    ).resolves.toBeUndefined();
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
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
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
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
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

describe("GitLabProviderAdapter mergeRequests", () => {
  it("opens, updates, comments, approves, unapproves, merges, closes, and adds review threads", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const mr = {
      id: 1001,
      iid: 5,
      project_id: 20,
      title: "Add CSV export",
      description: "draft",
      source_branch: "feature/csv",
      target_branch: "main",
      state: "opened",
      web_url: "https://gitlab.test/colony/dev/-/merge_requests/5",
    };
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
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

      if (method === "POST" && path === "/projects/20/merge_requests") {
        mr.title = stringField(body, "title");
        mr.description = stringField(body, "description");
        mr.source_branch = stringField(body, "source_branch");
        mr.target_branch = stringField(body, "target_branch");
        return Promise.resolve(json(mr));
      }
      if (method === "PUT" && path === "/projects/20/merge_requests/5") {
        if (body.title) mr.title = stringField(body, "title");
        if (body.description) mr.description = stringField(body, "description");
        if (body.state_event === "close") mr.state = "closed";
        return Promise.resolve(json(mr));
      }
      if (
        method === "POST" &&
        path === "/projects/20/merge_requests/5/approve"
      ) {
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      if (
        method === "POST" &&
        path === "/projects/20/merge_requests/5/unapprove"
      ) {
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      if (
        method === "GET" &&
        (path === "/projects/20/merge_requests/5" ||
          path.startsWith("/projects/20/merge_requests/5?"))
      ) {
        return Promise.resolve(json(mr));
      }
      if (method === "PUT" && path === "/projects/20/merge_requests/5/merge") {
        mr.state = "merged";
        return Promise.resolve(json(mr));
      }
      if (method === "POST" && path === "/projects/20/merge_requests/5/notes") {
        return Promise.resolve(
          json({
            id: 901,
            body: stringField(body, "body"),
            author: { id: 91, username: "colony-engine", name: "Engine" },
            created_at: "2026-04-25T00:00:00.000Z",
          }),
        );
      }
      if (
        method === "POST" &&
        path === "/projects/20/merge_requests/5/discussions"
      ) {
        return Promise.resolve(
          json({
            id: "discussion-1",
            notes: [
              {
                id: 902,
                body: stringField(body, "body"),
                author: { id: 92, username: "colony-reviewer", name: "Rev" },
                created_at: "2026-04-25T00:01:00.000Z",
              },
            ],
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
    const project = { id: "20", path: "colony/dev" } as const;

    const opened = await adapter.mergeRequests.open(project, {
      title: "Add CSV export",
      description: "draft",
      source_branch: "feature/csv",
      target_branch: "main",
    });
    expect(opened.id).toBe("20:5");
    expect(opened.iid).toBe(5);
    expect(opened.state).toBe("opened");

    const updated = await adapter.mergeRequests.update(project, opened.id, {
      title: "Add CSV export (v2)",
    });
    expect(updated.title).toBe("Add CSV export (v2)");

    const approved = await adapter.mergeRequests.approve(project, opened.id);
    expect(approved.id).toBe("20:5");

    const unapproved = await adapter.mergeRequests.unapprove(
      project,
      opened.id,
    );
    expect(unapproved.id).toBe("20:5");

    const note = await adapter.mergeRequests.comment(
      project,
      opened.id,
      "looks good",
    );
    expect(note).toMatchObject({ id: "901", body: "looks good" });

    const thread = await adapter.mergeRequests.addReviewThread(
      project,
      opened.id,
      "nit: rename helper",
    );
    expect(thread).toMatchObject({ id: "902", body: "nit: rename helper" });

    const merged = await adapter.mergeRequests.merge(project, opened.id);
    expect(merged.state).toBe("merged");

    mr.state = "opened";
    const closed = await adapter.mergeRequests.close(project, opened.id);
    expect(closed.state).toBe("closed");

    expect(
      calls.some((c) => c.url.endsWith("/projects/20/merge_requests/5/merge")),
    ).toBe(true);
  });
});

describe("GitLabProviderAdapter merge preflight and transport failures", () => {
  const project = { id: "20", path: "colony/dev" } as const;
  const urlPath = (url: Parameters<typeof fetch>[0]): string =>
    (typeof url === "string"
      ? url
      : url instanceof URL
        ? url.href
        : url.url
    ).replace("https://gitlab.test/api/v4", "");

  it("short-circuits a known conflict without attempting PUT", async () => {
    const calls: string[] = [];
    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot",
      fetch: (url, init) => {
        const method = init?.method ?? "GET";
        const path = urlPath(url);
        calls.push(`${method} ${path}`);
        return Promise.resolve(
          method === "GET"
            ? json({
                id: 1,
                iid: 1,
                project_id: 20,
                title: "MR",
                state: "opened",
                detailed_merge_status: "conflicts",
              })
            : json({ error: "PUT must not be attempted" }, 405),
        );
      },
    });

    const result = await adapter.mergeRequests.merge(project, "20:1");
    expect(result.reason).toBe("conflicts");
    expect(calls.every((call) => !call.startsWith("PUT "))).toBe(true);
  });

  it("polls checking merge status until GitLab reports mergeable", async () => {
    let checks = 0;
    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot",
      fetch: (url, init) => {
        const path = urlPath(url);
        if (
          (init?.method ?? "GET") === "GET" &&
          path.includes("with_merge_status_recheck")
        ) {
          checks += 1;
          return Promise.resolve(
            json({
              id: 1,
              iid: 1,
              project_id: 20,
              title: "MR",
              state: "opened",
              detailed_merge_status: checks === 1 ? "checking" : "mergeable",
            }),
          );
        }
        return Promise.resolve(
          json({ id: 1, iid: 1, project_id: 20, title: "MR", state: "merged" }),
        );
      },
    });

    const result = await adapter.mergeRequests.merge(project, "20:1");
    expect(checks).toBe(2);
    expect(result.state).toBe("merged");
  });

  it("rechecks after a 405 and returns the typed mergeability reason", async () => {
    let putAttempts = 0;
    let preflightChecks = 0;
    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot",
      fetch: (url, init) => {
        const method = init?.method ?? "GET";
        const path = urlPath(url);
        if (method === "GET" && path.includes("with_merge_status_recheck")) {
          preflightChecks += 1;
          return Promise.resolve(
            json({
              id: 1,
              iid: 1,
              project_id: 20,
              title: "MR",
              state: "opened",
              detailed_merge_status:
                preflightChecks === 1 ? "mergeable" : "not_approved",
            }),
          );
        }
        if (method === "PUT") {
          putAttempts += 1;
          return Promise.resolve(json({ error: "cannot merge" }, 405));
        }
        return Promise.resolve(json({ error: "unexpected request" }, 500));
      },
    });

    const result = await adapter.mergeRequests.merge(project, "20:1");
    expect(result).toMatchObject({
      reason: "not_approved",
      detailed_merge_status: "not_approved",
    });
    expect(putAttempts).toBe(1);
  });

  it("retries a rate-limited request once using Retry-After", async () => {
    let attempts = 0;
    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot",
      fetch: () => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? new Response(JSON.stringify({ message: "slow down" }), {
                status: 429,
                headers: { "Retry-After": "0" },
              })
            : json({ id: 20, path: "dev", path_with_namespace: "colony/dev" }),
        );
      },
    });

    await adapter.projects.getById("20");
    expect(attempts).toBe(2);
  });

  it("propagates non-empty diff endpoint errors", async () => {
    const adapter = new GitLabProviderAdapter({
      baseUrl: "https://gitlab.test",
      token: "bot",
      fetch: () => Promise.resolve(json({ message: "server exploded" }, 500)),
    });

    await expect(
      adapter.mergeRequests.diff(project, "20:1"),
    ).rejects.toBeInstanceOf(GitLabProviderError);
  });
});

describe("GitLabProviderAdapter branches", () => {
  it("creates, deletes, and idempotently protects a branch", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let protectedExists = false;
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      calls.push({ url: urlText, method });
      const path = urlText.replace("https://gitlab.test/api/v4", "");

      if (
        method === "POST" &&
        path.startsWith("/projects/20/repository/branches?")
      ) {
        return Promise.resolve(
          json({
            name: "feature/csv",
            commit: { id: "abc123" },
            protected: false,
            web_url: "https://gitlab.test/colony/dev/-/tree/feature/csv",
            id: 0,
          }),
        );
      }
      if (
        method === "DELETE" &&
        path === "/projects/20/repository/branches/feature%2Fcsv"
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === "GET" && path === "/projects/20/protected_branches/main") {
        return Promise.resolve(
          protectedExists ? json({ id: 7, name: "main" }) : json(null, 404),
        );
      }
      if (
        method === "POST" &&
        path === "/projects/20/protected_branches?name=main"
      ) {
        protectedExists = true;
        return Promise.resolve(json({ id: 7, name: "main" }));
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
    const project = { id: "20" } as const;

    const branch = await adapter.branches.create(
      project,
      "feature/csv",
      "main",
    );
    expect(branch).toMatchObject({
      name: "feature/csv",
      commit_sha: "abc123",
      protected: false,
    });

    await adapter.branches.delete(project, "feature/csv");
    expect(
      calls.some(
        (c) =>
          c.method === "DELETE" &&
          c.url.endsWith("/projects/20/repository/branches/feature%2Fcsv"),
      ),
    ).toBe(true);

    const first = await adapter.branches.protect(project, "main");
    expect(first.protected).toBe(true);
    const second = await adapter.branches.protect(project, "main");
    // Second call hits the GET path and short-circuits — proves idempotency.
    expect(second.protected).toBe(true);
    expect(
      calls.filter(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/projects/20/protected_branches?name=main"),
      ),
    ).toHaveLength(1);
  });
});

describe("GitLabProviderAdapter commits and pipelines", () => {
  it("gets a commit, fetches its diff, gets a pipeline, and triggers a pipeline", async () => {
    const fetchMock = (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const urlText =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const path = urlText.replace("https://gitlab.test/api/v4", "");

      if (
        method === "GET" &&
        path === "/projects/20/repository/commits/abc123"
      ) {
        return Promise.resolve(
          json({ id: "abc123", title: "feat: csv export" }),
        );
      }
      if (
        method === "GET" &&
        path === "/projects/20/repository/commits/abc123/diff"
      ) {
        return Promise.resolve(
          json([
            {
              old_path: "src/csv.ts",
              new_path: "src/csv.ts",
              diff: "@@ -0,0 +1 @@\n+export const csv = '';\n",
            },
          ]),
        );
      }
      if (method === "GET" && path === "/projects/20/pipelines/77") {
        return Promise.resolve(
          json({ id: 77, status: "success", sha: "abc123" }),
        );
      }
      if (method === "POST" && path === "/projects/20/pipeline?ref=main") {
        return Promise.resolve(
          json({ id: 78, status: "pending", sha: "abc123" }),
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
    const project = { id: "20" } as const;

    const commit = await adapter.commits.get(project, "abc123");
    expect(commit).toMatchObject({ sha: "abc123", title: "feat: csv export" });

    const diff = await adapter.commits.diff(project, "abc123");
    expect(diff).toHaveLength(1);

    const pipeline = await adapter.pipelines.getStatus(project, "77");
    expect(pipeline).toMatchObject({
      id: "77",
      status: "success",
      commit_sha: "abc123",
    });

    const triggered = await adapter.pipelines.trigger(project, "main");
    expect(triggered.status).toBe("pending");
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
  it("self-bootstraps a group, two projects, runs issue lifecycle on each, and cleans up", async () => {
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
  }, 120_000);
});

/**
 * Live end-to-end MR / branch / commit / pipeline lifecycle (COL-2.10).
 *
 * Provisions a throwaway group + project, seeds an initial commit on the
 * default branch via GitLab's repository-commits API, then exercises every
 * adapter method added in COL-2.10:
 *
 *   - branches.create + delete
 *   - commits.get + diff
 *   - mergeRequests.open / update / comment / addReviewThread / approve /
 *     unapprove / close
 *   - pipelines.getStatus (best-effort: only asserted when a pipeline exists,
 *     which it won't on a project without a .gitlab-ci.yml).
 *
 * Cleanup deletes the throwaway group at the end of the run.
 */
describeLive("GitLabProviderAdapter live MR/branch/commit lifecycle", () => {
  it("walks branch -> commit -> MR -> review -> approve -> close end-to-end", async () => {
    const baseUrl = process.env.GITLAB_BASE_URL!;
    const token = process.env.GITLAB_TOKEN!;
    const adapter = new GitLabProviderAdapter({ baseUrl, token });

    const stamp = Date.now();
    const groupPath = `colony-it-mr-${stamp}`;
    let groupId: string | null = null;

    try {
      const group = await adapter.groups.create({
        name: `Colony MR IT ${stamp}`,
        path: groupPath,
        visibility: "private",
      });
      groupId = group.id;

      // Seed the project with an initial commit on `main` so we have a ref
      // to branch from. `initialize_with_readme` on `projects.create` would
      // also work but the adapter doesn't expose it; using a direct API
      // call here keeps the adapter surface clean and minimal.
      const project = await adapter.projects.create({
        name: "csv-export",
        path: "csv-export",
        namespace: group.id,
        visibility: "private",
        default_branch: "main",
      });

      await rawCommit({
        baseUrl,
        token,
        projectId: project.id,
        branch: "main",
        startBranch: undefined,
        message: "chore: initial commit",
        actions: [
          { action: "create", file_path: "README.md", content: "# csv-export" },
        ],
      });

      const featureBranch = "feature/csv-export";
      const branch = await adapter.branches.create(
        { id: project.id, path: project.path },
        featureBranch,
        "main",
      );
      expect(branch.name).toBe(featureBranch);
      expect(branch.commit_sha).toMatch(/^[0-9a-f]{40}$/);

      // Push a real commit on the feature branch so commits.get/diff and
      // the MR diff have content to return.
      const headCommit = await rawCommit({
        baseUrl,
        token,
        projectId: project.id,
        branch: featureBranch,
        startBranch: undefined,
        message: "feat: csv export",
        actions: [
          {
            action: "create",
            file_path: "src/csv.ts",
            content: "export const csv = '';\n",
          },
        ],
      });
      expect(headCommit.id).toMatch(/^[0-9a-f]{40}$/);

      const projectRef = { id: project.id, path: project.path } as const;

      const commit = await adapter.commits.get(projectRef, headCommit.id);
      expect(commit.sha).toBe(headCommit.id);
      expect(commit.title).toMatch(/csv export/);

      const diff = await adapter.commits.diff(projectRef, headCommit.id);
      expect(diff.length).toBeGreaterThan(0);

      const mr = await adapter.mergeRequests.open(projectRef, {
        title: "Add CSV export",
        description: "Live integration test",
        source_branch: featureBranch,
        target_branch: "main",
      });
      expect(mr.id).toBe(`${project.id}:${mr.iid}`);
      expect(mr.state).toBe("opened");
      expect(mr.source_branch).toBe(featureBranch);

      const updated = await adapter.mergeRequests.update(projectRef, mr.id, {
        title: "Add CSV export (renamed)",
      });
      expect(updated.title).toBe("Add CSV export (renamed)");

      const note = await adapter.mergeRequests.comment(
        projectRef,
        mr.id,
        "looks good from live IT",
      );
      expect(note.body).toBe("looks good from live IT");

      const thread = await adapter.mergeRequests.addReviewThread(
        projectRef,
        mr.id,
        "thread: please rename helper",
      );
      expect(thread.body).toBe("thread: please rename helper");

      // Approve/unapprove. Self-approval works for a homelab admin PAT;
      // managed instances may reject it (the project's MR approval rules
      // can require non-author approval). If approval fails on the
      // instance under test, wrap with a soft-skip rather than failing.
      try {
        const approved = await adapter.mergeRequests.approve(projectRef, mr.id);
        expect(approved.id).toBe(mr.id);
        const unapproved = await adapter.mergeRequests.unapprove(
          projectRef,
          mr.id,
        );
        expect(unapproved.id).toBe(mr.id);
      } catch (err) {
        if (
          !(err instanceof GitLabProviderError) ||
          (err.status !== 401 && err.status !== 403)
        ) {
          throw err;
        }
      }

      // pipelines.getStatus only when one exists. The live project has
      // no .gitlab-ci.yml so we expect zero pipelines and skip — what we
      // care about is that the adapter call shape is right when called.
      const pipelinesList = await rawApi<readonly { id: number }[]>({
        baseUrl,
        token,
        path: `/projects/${encodeURIComponent(project.id)}/pipelines?per_page=1`,
      });
      if (pipelinesList[0]) {
        const pipeline = await adapter.pipelines.getStatus(
          projectRef,
          String(pipelinesList[0].id),
        );
        expect(pipeline.id).toBe(String(pipelinesList[0].id));
      }

      const closed = await adapter.mergeRequests.close(projectRef, mr.id);
      expect(closed.state).toBe("closed");

      await adapter.branches.delete(projectRef, featureBranch);
    } finally {
      if (groupId) {
        await adapter.groups.delete(groupId).catch(() => {});
      }
    }
  }, 180_000);
});

interface RawCommitArgs {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly branch: string;
  readonly startBranch?: string;
  readonly message: string;
  readonly actions: ReadonlyArray<{
    readonly action: "create" | "update" | "delete";
    readonly file_path: string;
    readonly content?: string;
  }>;
}

async function rawCommit(args: RawCommitArgs): Promise<{ id: string }> {
  return rawApi<{ id: string }>({
    baseUrl: args.baseUrl,
    token: args.token,
    method: "POST",
    path: `/projects/${encodeURIComponent(args.projectId)}/repository/commits`,
    body: {
      branch: args.branch,
      start_branch: args.startBranch,
      commit_message: args.message,
      actions: args.actions,
    },
  });
}

async function rawApi<T>(args: {
  readonly baseUrl: string;
  readonly token: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}): Promise<T> {
  const res = await fetch(`${args.baseUrl}/api/v4${args.path}`, {
    method: args.method ?? "GET",
    headers: {
      "PRIVATE-TOKEN": args.token,
      "Content-Type": "application/json",
    },
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `raw GitLab call ${args.method ?? "GET"} ${args.path} -> ${res.status}: ${text}`,
    );
  }
  return text ? (JSON.parse(text) as T) : (null as T);
}

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
