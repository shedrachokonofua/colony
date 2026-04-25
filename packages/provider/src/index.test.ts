import { describe, expect, it } from "vitest";
import { FakeProviderAdapter, redactBootstrapResult } from "./index.js";

const spec = {
  provider: "gitlab" as const,
  environment: "dev",
  base_url: "https://gitlab.example.test",
  group: { name: "Colony", path: "colony" },
  project: { name: "Colony Dev", path: "dev" },
  oauth_application: {
    name: "Colony Web",
    redirect_uris: ["https://colony.example.test/oauth/callback"],
    scopes: ["read_user"],
  },
  webhook: {
    url: "https://colony.example.test/webhook/gitlab",
    secret: "webhook-secret-value",
  },
};

describe("FakeProviderAdapter", () => {
  it("supports create/update/comment/label flows with stable provider IDs", async () => {
    const adapter = new FakeProviderAdapter();
    const project = { id: "fake-project-dev" } as const;
    const issue = await adapter.issues.create(project, {
      title: "Task",
      description: "Do work",
      labels: ["state:ready"],
    });
    expect(issue.id).toBe("fake-project-dev:issue-1");
    expect(issue.metadata.provider).toBe("fake");

    const labeled = await adapter.issues.addLabel(
      project,
      issue.id,
      "agent:developer",
    );
    expect(labeled.labels).toEqual(["state:ready", "agent:developer"]);

    const updated = await adapter.issues.update(project, issue.id, {
      title: "Updated task",
      assignee_ids: ["fake-user-1"],
    });
    expect(updated.title).toBe("Updated task");
    expect(updated.assignee_ids).toEqual(["fake-user-1"]);

    const comment = await adapter.issues.comment(
      project,
      issue.id,
      "Looks good",
    );
    expect(comment.id).toBe("issue-comment-1");
    expect(comment.body).toBe("Looks good");
  });

  it("creates and resolves provider projects from the projects namespace", async () => {
    const adapter = new FakeProviderAdapter();
    const created = await adapter.projects.create({
      name: "Frontend",
      path: "colony/frontend",
      visibility: "private",
    });
    expect(created.path).toBe("colony/frontend");
    expect(created.default_branch).toBe("main");
    expect(await adapter.projects.getById(created.id)).toMatchObject({
      id: created.id,
    });
    expect(await adapter.projects.getByPath("colony/frontend")).toMatchObject({
      id: created.id,
    });
    // Idempotent on path: re-creating returns the existing project.
    const again = await adapter.projects.create({
      name: "Frontend",
      path: "colony/frontend",
    });
    expect(again.id).toBe(created.id);
  });

  it("self-discovers identity, creates groups, mints sub-bots, and cleans up", async () => {
    const adapter = new FakeProviderAdapter();
    const me = await adapter.identity();
    expect(me.username).toBe("fake-bot");
    expect(me.default_namespace).toBe("fake-bot");

    const group = await adapter.groups.create({
      name: "Colony IT",
      path: "colony-it",
    });
    expect(group.path).toBe("colony-it");
    expect(await adapter.groups.getByPath("colony-it")).toMatchObject({
      id: group.id,
    });

    const subBot = await adapter.users.create({
      username: "colony-it-bot",
      name: "IT Bot",
      email: "it-bot@example.invalid",
      bot: true,
    });
    expect(subBot.bot).toBe(true);
    expect(
      await adapter.users.resolveByUsername("colony-it-bot"),
    ).toMatchObject({ id: subBot.id });

    const project = await adapter.projects.create({
      name: "throwaway",
      path: "throwaway",
      namespace: group.path,
    });
    expect(project.path).toBe("colony-it/throwaway");

    await adapter.groups.delete(group.id);
    expect(await adapter.groups.getByPath("colony-it")).toBeNull();
    // Deleting the group cascades projects (matches GitLab semantics).
    expect(await adapter.projects.getByPath("colony-it/throwaway")).toBeNull();
  });

  it("isolates issues per provider project", async () => {
    const adapter = new FakeProviderAdapter();
    const fe = { id: "proj-fe" } as const;
    const be = { id: "proj-be" } as const;
    const a = await adapter.issues.create(fe, { title: "fe", description: "" });
    const b = await adapter.issues.create(be, { title: "be", description: "" });
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith("proj-fe:")).toBe(true);
    expect(b.id.startsWith("proj-be:")).toBe(true);
  });

  it("bootstraps deterministic IDs and can produce a redacted result", async () => {
    const adapter = new FakeProviderAdapter();
    const result = await adapter.bootstrap(spec);
    expect(result.group.id).toBe("fake-group-dev");
    expect(result.project.id).toBe("fake-project-dev");
    expect(result.bot_users.engine.username).toBe("colony-engine");
    expect(Object.keys(result.bot_users)).toEqual([
      "engine",
      "reviewer",
      "architect",
      "integrator",
      "memory_consolidator",
      "supervisor",
    ]);

    const redacted = redactBootstrapResult(result);
    expect(redacted.bot_tokens.engine).not.toBe(result.bot_tokens.engine);
    expect(redacted.redacted_env).toContain("GITLAB_TOKEN=fake...gine");
  });

  it("accepts custom role-keyed bootstrap bots without adapter code changes", async () => {
    const adapter = new FakeProviderAdapter();
    const result = await adapter.bootstrap({
      ...spec,
      bots: {
        data_steward: {
          username: "colony-data-steward",
          name: "Colony Data Steward",
          email: "colony-data-steward@example.invalid",
          scopes: ["api"],
        },
      },
    });

    expect(Object.keys(result.bot_users)).toEqual(["data_steward"]);
    expect(result.bot_users.data_steward.username).toBe("colony-data-steward");
    expect(result.bot_tokens.data_steward).toBe(
      "fake-token-colony-data-steward",
    );
    expect(result.env.GITLAB_BOT_DATA_STEWARD_TOKEN).toBe(
      "fake-token-colony-data-steward",
    );
  });
});
