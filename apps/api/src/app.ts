import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { pingDatabase } from "./db.js";
import {
  getTaskGraphDeps,
  registerTaskGraph,
  type TaskGraphDeps,
} from "./task-graph.js";
import {
  getProviderAdminDeps,
  registerProviderAdmin,
  type ProviderAdminDeps,
} from "./provider-admin.js";
import {
  registerOAuthAdmin,
  type OAuthAdminDeps,
} from "./oauth/admin-routes.js";

const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal("colony-api"),
  db: z.object({
    ok: z.boolean(),
    version: z.string().optional(),
    error: z.string().optional(),
  }),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness + Postgres reachability check",
  responses: {
    200: {
      description: "Service healthy and DB reachable.",
      content: { "application/json": { schema: healthResponseSchema } },
    },
    503: {
      description: "DB unreachable.",
      content: { "application/json": { schema: healthResponseSchema } },
    },
  },
});

export function buildApp(options?: {
  taskGraph?: TaskGraphDeps;
  providerAdmin?: ProviderAdminDeps | false;
  oauthAdmin?: OAuthAdminDeps | false;
}): OpenAPIHono<{ Variables: { actor: string } }> {
  const app = new OpenAPIHono<{ Variables: { actor: string } }>();

  app.use(async (c, next) => {
    const p = c.req.path;
    if (p === "/health" || p === "/openapi.json" || p.startsWith("/docs")) {
      return next();
    }
    const id = c.req.header("X-Actor-Id");
    if (!id || !id.trim()) {
      return c.json(
        {
          error: {
            code: "MISSING_ACTOR",
            message: "X-Actor-Id header is required for task graph routes",
          },
        },
        400,
      );
    }
    c.set("actor", id.trim());
    return next();
  });

  app.openapi(healthRoute, async (c) => {
    const db = await pingDatabase();
    const body = { ok: db.ok, service: "colony-api" as const, db };
    return c.json(body, db.ok ? 200 : 503);
  });

  registerTaskGraph(app, options?.taskGraph ?? getTaskGraphDeps());
  if (options?.providerAdmin !== false) {
    const providerAdmin = options?.providerAdmin ?? getProviderAdminDeps();
    registerProviderAdmin(app, {
      ...providerAdmin,
      repo: options?.taskGraph?.repo ?? providerAdmin.repo,
      providerProjects:
        options?.taskGraph?.providerProjects ?? providerAdmin.providerProjects,
      policyRepo: options?.taskGraph?.policyRepo ?? providerAdmin.policyRepo,
    });
  }
  if (options?.oauthAdmin) {
    registerOAuthAdmin(app, options.oauthAdmin);
  }

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Colony API", version: "0.0.0" },
  });

  app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "Colony API" }));

  return app;
}
