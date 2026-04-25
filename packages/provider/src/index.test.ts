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
    const issue = await adapter.issues.create({
      title: "Task",
      description: "Do work",
      labels: ["state:ready"],
    });
    expect(issue.id).toBe("issue-1");
    expect(issue.metadata.provider).toBe("fake");

    const labeled = await adapter.issues.addLabel(issue.id, "agent:developer");
    expect(labeled.labels).toEqual(["state:ready", "agent:developer"]);

    const updated = await adapter.issues.update(issue.id, {
      title: "Updated task",
      assignee_ids: ["fake-user-1"],
    });
    expect(updated.title).toBe("Updated task");
    expect(updated.assignee_ids).toEqual(["fake-user-1"]);

    const comment = await adapter.issues.comment(issue.id, "Looks good");
    expect(comment.id).toBe("issue-comment-1");
    expect(comment.body).toBe("Looks good");
  });

  it("bootstraps deterministic IDs and can produce a redacted result", async () => {
    const adapter = new FakeProviderAdapter();
    const result = await adapter.bootstrap(spec, {
      kind: "admin_pat",
      token: "admin-secret",
    });
    expect(result.group.id).toBe("fake-group-dev");
    expect(result.project.id).toBe("fake-project-dev");
    expect(result.bot_users.engine.username).toBe("colony-engine");

    const redacted = redactBootstrapResult(result);
    expect(redacted.bot_tokens.engine).not.toBe(result.bot_tokens.engine);
    expect(redacted.redacted_env).toContain("GITLAB_TOKEN=fake...gine");
    expect(JSON.stringify(redacted)).not.toContain("admin-secret");
  });
});
