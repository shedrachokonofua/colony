import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ColonydContext } from "./context.js";
import type { Env } from "./http.js";
import { OPERATOR_SUMMARY_WINDOWS } from "./operator-summary.js";

/**
 * MCP (Model Context Protocol) adapter for the operator API.
 *
 * A thin, stateless surface over the existing HTTP routes: every tool
 * validates its input and then calls the very same route in-process through
 * `app.request`, forwarding the caller's credentials. Same state guards,
 * same audit actor, same deployed version — no business logic lives here.
 *
 * Skill files under `skills/colony/` are served both as the `colony_guide`
 * tool and as `skill://colony/...` resources.
 */

/** The tracked skill directory (repo root `skills/colony`). */
export const SKILL_DIR = fileURLToPath(
  new URL("../../../skills/colony", import.meta.url),
);

export interface SkillDoc {
  /** Path relative to the skill root, e.g. `references/lifecycle.md`. */
  readonly rel: string;
  readonly text: string;
}

let skillCache: SkillDoc[] | undefined;

/** SKILL.md plus every `references/*.md`, ordered; cached after first read. */
export function loadSkillDocs(skillDir: string = SKILL_DIR): SkillDoc[] {
  if (skillCache && skillDir === SKILL_DIR) return skillCache;
  const docs: SkillDoc[] = [];
  const skillMd = join(skillDir, "SKILL.md");
  if (existsSync(skillMd)) {
    docs.push({ rel: "SKILL.md", text: readFileSync(skillMd, "utf8") });
  }
  const references = join(skillDir, "references");
  if (existsSync(references)) {
    for (const name of readdirSync(references).sort()) {
      if (!name.endsWith(".md")) continue;
      docs.push({
        rel: `references/${name}`,
        text: readFileSync(join(references, name), "utf8"),
      });
    }
  }
  if (skillDir === SKILL_DIR) skillCache = docs;
  return docs;
}

/**
 * The public origin of this colonyd: PUBLIC_HOST when configured (the name
 * external clients reach us by), otherwise the origin of the request.
 */
export function publicOrigin(
  publicHost: string | undefined,
  requestUrl?: string,
): string {
  const host = publicHost?.trim();
  if (host) {
    return /^https?:\/\//.test(host)
      ? host.replace(/\/+$/, "")
      : `https://${host}`;
  }
  if (requestUrl === undefined) {
    throw new Error("no public origin: PUBLIC_HOST unset and no request URL");
  }
  return new URL(requestUrl).origin;
}

export const mcpResourceUrl = (origin: string): string => `${origin}/mcp`;

export const mcpMetadataUrl = (origin: string): string =>
  `${origin}/.well-known/oauth-protected-resource/mcp`;

/**
 * RFC 9728 protected-resource metadata (public route). Answers 404 while no
 * OIDC issuer is configured: without one there is no authorization server to
 * advertise and clients authenticate with pre-shared bearer tokens.
 */
export function handleProtectedResourceMetadata(
  ctx: ColonydContext,
  c: Context<Env>,
): Response {
  const issuer = ctx.env.oidcIssuer;
  if (!issuer) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "OIDC is not configured" } },
      404,
    );
  }
  const origin = publicOrigin(ctx.env.publicHost, c.req.url);
  return c.json({
    resource: mcpResourceUrl(origin),
    authorization_servers: [issuer],
    scopes_supported: ["mcp", "offline_access"],
    bearer_methods_supported: ["header"],
  });
}

const SERVER_INSTRUCTIONS = [
  "Colony runs software work as a factory: project -> scope -> plan -> tasks -> runs -> merge requests -> merge.",
  "A scope is one goal against one repository; an architect drafts a plan of tasks; approving the plan materializes the tasks; each task delivers as a merge request that merges after review and merge gate.",
  "",
  "Read first, act second: colony_status shows what needs you; read get_scope/get_task/get_run/run_events before any mutation. State guards refuse stale actions with 409 CONFLICT — re-read, then retry deliberately.",
  "",
  "Safety: scope_action abandon and task_action cancel discard work permanently; pause is the reversible hold, prefer it. approve_plan starts real work and spend. Never stop, cancel, or unblock work without run/event evidence. Every action is audited under your identity.",
  "",
  "Call colony_guide for depth: lifecycle (states and blocked reasons), playbooks (operator procedures), investigation (failure analysis), deploy (rolling out Colony).",
].join("\n");

interface RouteCall {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

type RouteFn = (call: RouteCall) => Promise<CallToolResult>;

/** Headers forwarded to the underlying routes: the caller's credentials. */
function authHeadersOf(mcpRequest: Request): Headers {
  const headers = new Headers();
  for (const name of ["authorization", "x-actor-id"]) {
    const value = mcpRequest.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/** Call one existing route in-process; its JSON body is the tool's text. */
async function callRoute(
  app: Hono<Env>,
  forwarded: Headers,
  call: RouteCall,
): Promise<CallToolResult> {
  const headers = new Headers(forwarded);
  let body: string | undefined;
  if (call.body !== undefined) {
    body = JSON.stringify(call.body);
    headers.set("content-type", "application/json");
  }
  const res = await app.request(call.path, {
    method: call.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = (await res.text()) || `HTTP ${res.status}`;
  const ok = res.status >= 200 && res.status < 300;
  return ok
    ? { content: [{ type: "text", text }] }
    : { isError: true, content: [{ type: "text", text }] };
}

const toolError = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

const id = (label: string): z.ZodString => z.string().min(1).describe(label);

const limit = z.coerce
  .number()
  .int()
  .positive()
  .max(100)
  .optional()
  .describe("Page size (1-100, default 25).");
const offset = z.coerce
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("Rows to skip for pagination.");

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** The guide topics: `overview` plus the stem of each reference file. */
function guideTopics(docs: SkillDoc[]): [string, ...string[]] {
  const stems = docs
    .filter((doc) => doc.rel.startsWith("references/"))
    .map((doc) => doc.rel.slice("references/".length, -".md".length));
  return ["overview", ...stems];
}

function registerTools(
  server: McpServer,
  route: RouteFn,
  docs: SkillDoc[],
): void {
  server.registerTool(
    "colony_status",
    {
      title: "Colony status",
      description:
        "Fleet health in one call: what needs you now (plan approvals, merges awaiting sign-off, blocked tasks and scopes), live runs with stall detection, run/model metrics, fault classification and deployment info for a bounded window. Computed from colonyd's own store — safe during provider outages. Start every session here.",
      inputSchema: {
        window: z
          .enum(OPERATOR_SUMMARY_WINDOWS)
          .optional()
          .describe("Metrics window (default 24h)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ window: win }) =>
      route({
        method: "GET",
        path: `/operator/summary${query({ window: win })}`,
      }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "Page through Colony projects (most recently updated first) with scope counts and brief status. Use to find which project a scope belongs to before opening work.",
      inputSchema: {
        limit,
        offset,
        archived: z
          .boolean()
          .optional()
          .describe("Include archived projects (default false)."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      route({
        method: "GET",
        path: `/projects${query({
          limit: args.limit,
          offset: args.offset,
          ...(args.archived ? { archived: 1 } : {}),
        })}`,
      }),
  );

  server.registerTool(
    "list_scopes",
    {
      title: "List scopes",
      description:
        "Page through scopes, optionally filtered by project. A scope is one goal decomposed into tasks that deliver as merge requests. Use to find scope IDs before get_scope or any scope_action.",
      inputSchema: {
        limit,
        offset,
        project: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe("Only scopes of this project."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      route({
        method: "GET",
        path: `/scopes${query({
          limit: args.limit,
          offset: args.offset,
          project: args.project,
        })}`,
      }),
  );

  server.registerTool(
    "get_scope",
    {
      title: "Get scope",
      description:
        "Full scope detail: status, goal, project, plan state and any plan-review block, tasks with delivery status, dependencies and runs. Read this before approve_plan, replan or scope_action.",
      inputSchema: { scope_id: id("Scope id, e.g. col-d4bed30a.") },
      annotations: { readOnlyHint: true },
    },
    ({ scope_id }) =>
      route({ method: "GET", path: `/scopes/${encodeURIComponent(scope_id)}` }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "Task detail: state, attempt, blocked reason, MR iid/branch, spec and acceptance, delivery status, dependencies and every run. Read before any task_action — the state guards refuse stale actions.",
      inputSchema: { task_id: id("Task id, e.g. col-d4bed30a.7.") },
      annotations: { readOnlyHint: true },
    },
    ({ task_id }) =>
      route({ method: "GET", path: `/tasks/${encodeURIComponent(task_id)}` }),
  );

  server.registerTool(
    "get_run",
    {
      title: "Get run",
      description:
        "One agent run (architect, implement, review, merge_gate, validate, plan_review): status, model, timing, terminal error and fault classification. Use run_events for the decision timeline.",
      inputSchema: { run_id: id("Run id from get_task / list runs.") },
      annotations: { readOnlyHint: true },
    },
    ({ run_id }) =>
      route({ method: "GET", path: `/runs/${encodeURIComponent(run_id)}` }),
  );

  server.registerTool(
    "run_events",
    {
      title: "Run events",
      description:
        "Paged event timeline of a run. Walk every page before concluding an event is absent: page backwards with before_id until exhausted.",
      inputSchema: {
        run_id: id("Run id."),
        before_id: z.coerce
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Return events before this event id (for pagination)."),
        limit: z.coerce
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Page size (max 1000)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ run_id, before_id, limit: page }) =>
      route({
        method: "GET",
        path: `/runs/${encodeURIComponent(run_id)}/events${query({
          before_id,
          limit: page,
        })}`,
      }),
  );

  server.registerTool(
    "open_scope",
    {
      title: "Open scope",
      description:
        "Open a new scope: one goal against one repository. An architect drafts a plan of tasks; with approvals=manual nothing executes until approve_plan. Provide exactly one of repo_id / repo_path. Set project so the scope shows up on the project page (a scope without a project is only visible in the global list).",
      inputSchema: {
        goal: z.string().min(1).describe("The goal, in the operator's words."),
        title: z
          .string()
          .min(1)
          .max(120)
          .describe("Short human title for the scope."),
        project: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe("Project to attach (created on demand)."),
        approvals: z
          .enum(["auto", "manual"])
          .optional()
          .describe(
            "auto: merges proceed automatically; manual: each MR needs approve_merge (default auto).",
          ),
        repo_id: z
          .string()
          .min(1)
          .optional()
          .describe("Provider repository id (use this or repo_path)."),
        repo_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Provider repository path, e.g. group/repo (use this or repo_id).",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => {
      const repo =
        args.repo_id !== undefined
          ? { id: args.repo_id }
          : args.repo_path !== undefined
            ? { path: args.repo_path }
            : undefined;
      return route({
        method: "POST",
        path: "/scopes",
        body: {
          goal: args.goal,
          title: args.title,
          ...(args.project === undefined ? {} : { project: args.project }),
          ...(args.approvals === undefined
            ? {}
            : { approvals: args.approvals }),
          ...(repo === undefined ? {} : { repo }),
        },
      });
    },
  );

  server.registerTool(
    "approve_plan",
    {
      title: "Approve plan",
      description:
        "Approve the scope's pending plan: materializes its task graph and starts implementation. Only valid while the scope is in planning with a plan held (otherwise 409 NO_PLAN_PENDING). This starts real work and spend — approve only what the user asked for.",
      inputSchema: {
        scope_id: id("Scope id holding a plan awaiting approval."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ scope_id }) =>
      route({
        method: "POST",
        path: `/scopes/${encodeURIComponent(scope_id)}/approve-plan`,
        body: {},
      }),
  );

  server.registerTool(
    "replan",
    {
      title: "Request replan",
      description:
        "Reject the scope's pending plan with durable feedback; the architect revises it. Use when the plan is wrong or unsafe — do not approve a plan you intend to fix later. Only valid with a plan held (otherwise 409 NO_PLAN_PENDING).",
      inputSchema: {
        scope_id: id("Scope id holding a plan."),
        feedback: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "What is wrong with the plan and what a revision must address.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ scope_id, feedback }) =>
      route({
        method: "POST",
        path: `/scopes/${encodeURIComponent(scope_id)}/replan`,
        body: { feedback },
      }),
  );

  server.registerTool(
    "scope_action",
    {
      title: "Scope action",
      description:
        "Lifecycle control on a scope. pause: reversible hold — aborts live runs, requeues their tasks and parks the scope (planning/active/validating/blocked only). resume: return a paused scope to the status it left. revalidate: retry acceptance validation (validating only). unblock: retry a blocked scope. abandon: PERMANENT — discards the scope and cancels every task in it; cannot be undone. Prefer pause over abandon; get_scope first — state guards answer 409 with the reason.",
      inputSchema: {
        scope_id: id("Scope id."),
        action: z
          .enum(["pause", "resume", "abandon", "revalidate", "unblock"])
          .describe(
            "pause|resume (reversible hold), revalidate|unblock (retry), abandon (PERMANENT discard).",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ scope_id, action }) =>
      route({
        method: "POST",
        path: `/scopes/${encodeURIComponent(scope_id)}/${action}`,
      }),
  );

  server.registerTool(
    "task_action",
    {
      title: "Task action",
      description:
        "Task controls. retry: clear a queued task's retry delay (run now). stop: abort the running attempt and requeue it without spending an attempt. unblock: requeue a blocked task (attempt resets) — only after run/event evidence says the blocker is gone. restore: bring back a canceled task. cancel: PERMANENT discard of the task's work. amend: append an authoritative spec amendment (spec=) — running implementers are steered onto it or requeued, reviews restart. request-changes: send review feedback (feedback=) on the open MR and requeue the implementer; branch and MR stay. approve-merge: approve merging at the MR head for manual-approval scopes; pass sha= to pin the exact head (409 HEAD_MOVED if it moved).",
      inputSchema: {
        task_id: id("Task id, e.g. col-d4bed30a.7."),
        action: z
          .enum([
            "retry",
            "stop",
            "cancel",
            "restore",
            "unblock",
            "amend",
            "request-changes",
            "approve-merge",
          ])
          .describe("The verb; see the tool description for semantics."),
        spec: z
          .string()
          .min(1)
          .optional()
          .describe("For amend: the authoritative spec amendment text."),
        feedback: z
          .string()
          .min(1)
          .optional()
          .describe("For request-changes: feedback for the implementer."),
        sha: z
          .string()
          .regex(/^[0-9a-f]{7,40}$/)
          .optional()
          .describe(
            "For approve-merge: pin approval to this MR head SHA (recommended).",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (args) => {
      const base = `/tasks/${encodeURIComponent(args.task_id)}`;
      switch (args.action) {
        case "amend":
          if (args.spec === undefined) {
            return toolError("action amend requires spec (the amendment text)");
          }
          return route({
            method: "POST",
            path: `${base}/amend-spec`,
            body: { feedback: args.spec },
          });
        case "request-changes":
          if (args.feedback === undefined) {
            return toolError(
              "action request-changes requires feedback for the implementer",
            );
          }
          return route({
            method: "POST",
            path: `${base}/request-changes`,
            body: { feedback: args.feedback },
          });
        case "approve-merge":
          return route({
            method: "POST",
            path: `${base}/approve-merge`,
            body: args.sha === undefined ? {} : { sha: args.sha },
          });
        default:
          return route({ method: "POST", path: `${base}/${args.action}` });
      }
    },
  );

  server.registerTool(
    "colony_guide",
    {
      title: "Colony guide",
      description:
        "The Colony operating guide (the same text as the skill://colony/... resources). overview (default): mental model, workflows and safety rules. lifecycle: states, transitions and blocked reasons. playbooks: operator procedures. investigation: diagnosing failed or blocked work. deploy: rolling Colony out to Aether via IaC.",
      inputSchema: {
        topic: z
          .enum(guideTopics(docs))
          .optional()
          .describe("Guide section (default overview)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ topic }) => {
      const rel =
        topic === undefined || topic === "overview"
          ? "SKILL.md"
          : `references/${topic}.md`;
      const doc = docs.find((d) => d.rel === rel);
      return doc
        ? { content: [{ type: "text", text: doc.text }] }
        : toolError(
            `guide not found: ${rel} (available: ${guideTopics(docs).join(", ")})`,
          );
    },
  );
}

function registerSkillResources(server: McpServer, docs: SkillDoc[]): void {
  for (const doc of docs) {
    const stem = doc.rel.slice(0, -".md".length).replace(/\//g, "-");
    server.registerResource(
      `colony-${stem}`,
      `skill://colony/${doc.rel}`,
      {
        title: `Colony guide: ${doc.rel}`,
        description:
          doc.rel === "SKILL.md"
            ? "Colony operating guide: mental model, golden workflows, safety rules."
            : `Colony guide reference (${doc.rel}).`,
        mimeType: "text/markdown",
      },
      (uri) =>
        Promise.resolve({
          contents: [
            { uri: uri.toString(), mimeType: "text/markdown", text: doc.text },
          ],
        }),
    );
  }
}

/**
 * Handle one streamable-HTTP MCP request. Stateless: a fresh server and
 * transport per request (the SDK requires a fresh transport per request in
 * stateless mode), so any replica can answer any request.
 */
export async function handleMcp(
  ctx: ColonydContext,
  app: Hono<Env>,
  c: Context<Env>,
): Promise<Response> {
  const docs = loadSkillDocs();
  const forwarded = authHeadersOf(c.req.raw);
  const server = new McpServer(
    { name: "colony", version: process.env["COLONY_VERSION"] ?? "0.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, (call) => callRoute(app, forwarded, call), docs);
  registerSkillResources(server, docs);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } finally {
    // The JSON-mode response is complete when handleRequest resolves; the
    // per-request server holds nothing else worth keeping.
    await server.close().catch(() => {});
  }
}
