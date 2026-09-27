import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Store } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp, type Env } from "../src/http.js";
import { SKILL_DIR, loadSkillDocs } from "../src/mcp.js";

const ISSUER = "https://auth.test/realms/aether";
const HOST = "colony.test";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type App = Hono<Env>;

interface FakeCtxOptions {
  oidcIssuer?: string;
  oidcVerifier?: ColonydContext["oidcVerifier"];
  publicHost?: string;
}

function fakeCtx(store: Store, options: FakeCtxOptions = {}): ColonydContext {
  return {
    store,
    provider: {
      repos: {
        getById: (id: string) =>
          Promise.resolve({ id, path: "so/colony", default_branch: "main" }),
        getByPath: (path: string) =>
          Promise.resolve({ id: "1", path, default_branch: "main" }),
      },
    } as unknown as ColonydContext["provider"],
    config: {
      reviewMode: "required",
      hitlMode: "yolo",
    } as ColonydContext["config"],
    agents: {} as ColonydContext["agents"],
    artifacts: {} as ColonydContext["artifacts"],
    logger: { info() {}, warn() {}, error() {} },
    ...(options.oidcVerifier ? { oidcVerifier: options.oidcVerifier } : {}),
    env: {
      gitlabBaseUrl: "https://gitlab.example",
      gitlabToken: "",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 1,
      maxAttempts: 3,
      resumeLeaseTtlMs: 900_000,
      oidcIssuer: options.oidcIssuer ?? "",
      oidcClientId: "colony",
      oidcRequiredRole: "admin",
      publicHost: options.publicHost ?? HOST,
      traceUiBaseUrl: "",
      consoleBaseUrl: "",
    },
    draining: { isDraining: () => false },
    requestTick() {},
  };
}

function setup(options: FakeCtxOptions = {}): { app: App; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-mcp-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  return { app: buildApp(fakeCtx(store, options)), store };
}

/** MCP SDK client wired to the in-process Hono app instead of the network. */
async function connect(app: App): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`https://${HOST}/mcp`),
    {
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(String(input), init);
        request.headers.set("x-actor-id", "human:op-1");
        return await app.request(request);
      },
    },
  );
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** The text of a tool result's single content block. */
function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== "text") {
    throw new Error(
      `tool result has no text content: ${JSON.stringify(result)}`,
    );
  }
  return block.text;
}

const EXPECTED_TOOLS = [
  "colony_status",
  "list_projects",
  "list_scopes",
  "get_scope",
  "get_task",
  "get_run",
  "run_events",
  "open_scope",
  "approve_plan",
  "replan",
  "scope_action",
  "task_action",
  "colony_guide",
];

describe("mcp tools", () => {
  it("lists exactly the Colony tools with destructive and read-only hints", async () => {
    const { app } = setup();
    const { client, close } = await connect(app);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...EXPECTED_TOOLS].sort(),
      );
      const byName: Record<
        string,
        { annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } }
      > = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      expect(byName["scope_action"]?.annotations?.destructiveHint).toBe(true);
      expect(byName["task_action"]?.annotations?.destructiveHint).toBe(true);
      for (const name of [
        "colony_status",
        "list_projects",
        "list_scopes",
        "get_scope",
        "get_task",
        "get_run",
        "run_events",
        "colony_guide",
      ]) {
        expect(byName[name]?.annotations?.readOnlyHint).toBe(true);
      }
    } finally {
      await close();
    }
  });

  it("returns route data from read tools", async () => {
    const { app, store } = setup();
    const scope = store.createScope({
      goal: "read me",
      title: "read me",
      project: "demo",
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
    });
    const { client, close } = await connect(app);
    try {
      const status = await client.callTool({
        name: "colony_status",
        arguments: {},
      });
      const summary = JSON.parse(textOf(status as CallToolResult)) as {
        window: string;
      };
      expect(summary.window).toBe("24h");

      const scopes = await client.callTool({
        name: "list_scopes",
        arguments: { project: "demo" },
      });
      expect(textOf(scopes as CallToolResult)).toContain(scope.id);

      const one = await client.callTool({
        name: "get_scope",
        arguments: { scope_id: scope.id },
      });
      expect(textOf(one as CallToolResult)).toContain('"read me"');
    } finally {
      await close();
    }
  });

  it("runs open_scope through the real POST /scopes route and audits the caller", async () => {
    const { app, store } = setup();
    const { client, close } = await connect(app);
    try {
      const opened = await client.callTool({
        name: "open_scope",
        arguments: {
          goal: "ship it",
          title: "ship it",
          project: "demo",
          repo_path: "so/colony",
        },
      });
      const body = JSON.parse(textOf(opened as CallToolResult)) as {
        id: string;
        status: string;
      };
      expect(body.status).toBe("draft");
      expect(store.getScope(body.id)?.provider_repo_path).toBe("so/colony");

      const audit = store.listAudit({ limit: 50 }).events as {
        actor: string;
        action: string;
      }[];
      expect(
        audit.some(
          (row) => row.action === "scope.created" && row.actor === "human:op-1",
        ),
      ).toBe(true);
    } finally {
      await close();
    }
  });

  it("surfaces the real state guard as isError (scope_action pause on a draft)", async () => {
    const { app, store } = setup();
    const scope = store.createScope({
      goal: "guard",
      title: "guard",
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
    });
    const { client, close } = await connect(app);
    try {
      const paused = await client.callTool({
        name: "scope_action",
        arguments: { scope_id: scope.id, action: "pause" },
      });
      const result = paused as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("NOT_PAUSABLE");
    } finally {
      await close();
    }
  });

  it("validates open_scope input before calling a route", async () => {
    const { app } = setup();
    const { client, close } = await connect(app);
    try {
      const opened = await client.callTool({
        name: "open_scope",
        arguments: { goal: "no repo", title: "no repo" },
      });
      const result = opened as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("INVALID_BODY");
    } finally {
      await close();
    }
  });

  it("rejects task_action verbs missing their required input", async () => {
    const { app } = setup();
    const { client, close } = await connect(app);
    try {
      const amended = await client.callTool({
        name: "task_action",
        arguments: { task_id: "col-d4bed30a.7", action: "amend" },
      });
      const result = amended as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("spec");
    } finally {
      await close();
    }
  });

  it("returns SKILL.md from colony_guide and references by topic", async () => {
    const { app } = setup();
    const { client, close } = await connect(app);
    try {
      const guide = await client.callTool({
        name: "colony_guide",
        arguments: {},
      });
      expect(textOf(guide as CallToolResult)).toBe(
        readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"),
      );
      const deploy = await client.callTool({
        name: "colony_guide",
        arguments: { topic: "deploy" },
      });
      expect(textOf(deploy as CallToolResult)).toContain(
        "tofu/home/kubernetes/colony.tf",
      );
    } finally {
      await close();
    }
  });

  it("serves every skill file as a skill://colony resource", async () => {
    const { app } = setup();
    const { client, close } = await connect(app);
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain("skill://colony/SKILL.md");
      expect(uris).toContain("skill://colony/references/lifecycle.md");
      const read = await client.readResource({
        uri: "skill://colony/references/deploy.md",
      });
      const block = read.contents[0];
      const text = block && "text" in block ? block.text : "";
      expect(text).toContain("kubectl set image");
    } finally {
      await close();
    }
  });
});

describe("mcp auth and metadata", () => {
  it("answers unauthenticated /mcp with 401 and the RFC 9728 challenge", async () => {
    const { app } = setup({
      oidcIssuer: ISSUER,
      oidcVerifier: {
        verify: () => Promise.reject(new Error("stub verifier")),
      },
    });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="https://${HOST}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
    );
  });

  it("publishes the protected-resource metadata document", async () => {
    const { app } = setup({ oidcIssuer: ISSUER });
    const res = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: `https://${HOST}/mcp`,
      authorization_servers: [ISSUER],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  });

  it("falls back to the request origin when PUBLIC_HOST is empty", async () => {
    const { app } = setup({ oidcIssuer: ISSUER, publicHost: "" });
    const res = await app.request("/.well-known/oauth-protected-resource/mcp");
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe("http://localhost/mcp");
  });

  it("answers 404 when no OIDC issuer is configured", async () => {
    const { app } = setup();
    const res = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(404);
  });
});

describe("skill lint", () => {
  it("frontmatter name matches the skill directory", () => {
    const text = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    const frontmatter = text.split(/^---$/m)[1] ?? "";
    const name = /^name:\s*(\S+)\s*$/m.exec(frontmatter)?.[1];
    expect(name).toBe(basename(SKILL_DIR));
  });

  it("relative links in skill files resolve", () => {
    for (const doc of loadSkillDocs()) {
      const file = join(SKILL_DIR, doc.rel);
      for (const match of doc.text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = match[1]!;
        if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
        const relPath = target.split("#")[0]!;
        expect(existsSync(resolve(dirname(file), relPath))).toBe(true);
      }
    }
  });
});
