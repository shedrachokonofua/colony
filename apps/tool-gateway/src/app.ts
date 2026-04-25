import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";

const healthResponse = z.object({
  ok: z.literal(true),
  service: z.literal("colony-tool-gateway"),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness",
  responses: {
    200: {
      description: "Service healthy.",
      content: { "application/json": { schema: healthResponse } },
    },
  },
});

export function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(healthRoute, (c) =>
    c.json({ ok: true as const, service: "colony-tool-gateway" as const }),
  );

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Colony Tool Gateway", version: "0.0.0" },
  });

  app.get(
    "/docs",
    Scalar({ url: "/openapi.json", pageTitle: "Colony Tool Gateway" }),
  );

  return app;
}
