import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { pingDatabase } from "./db.js";

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

export function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(healthRoute, async (c) => {
    const db = await pingDatabase();
    const body = { ok: db.ok, service: "colony-api" as const, db };
    return c.json(body, db.ok ? 200 : 503);
  });

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Colony API", version: "0.0.0" },
  });

  app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "Colony API" }));

  return app;
}
