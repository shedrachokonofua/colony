import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { env } from "@colony/config";
import { timingSafeEqual } from "node:crypto";

const healthResponse = z.object({
  ok: z.literal(true),
  service: z.literal("colony-webhook-dispatcher"),
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

const webhookAckResponse = z.object({
  accepted: z.boolean(),
  event_kind: z.string().optional(),
  event_uuid: z.string().optional(),
});

const webhookErrorResponse = z.object({
  accepted: z.literal(false),
  error: z.string(),
});

const gitlabWebhookRoute = createRoute({
  method: "post",
  path: "/webhook/gitlab",
  summary: "GitLab webhook ingress",
  responses: {
    200: {
      description: "Accepted.",
      content: { "application/json": { schema: webhookAckResponse } },
    },
    401: {
      description: "Missing or invalid X-Gitlab-Token.",
      content: { "application/json": { schema: webhookErrorResponse } },
    },
  },
});

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(healthRoute, (c) =>
    c.json({
      ok: true as const,
      service: "colony-webhook-dispatcher" as const,
    }),
  );

  app.openapi(gitlabWebhookRoute, async (c) => {
    const cfg = env();
    const token = c.req.header("X-Gitlab-Token");

    if (!tokenMatches(token, cfg.GITLAB_WEBHOOK_SECRET)) {
      return c.json(
        {
          accepted: false as const,
          error: "invalid or missing X-Gitlab-Token",
        },
        401,
      );
    }

    const eventKind = c.req.header("X-Gitlab-Event") ?? "unknown-gitlab-event";
    const eventUuid =
      c.req.header("X-Gitlab-Event-UUID") ?? crypto.randomUUID();

    // Placeholder: in COL-0.6 this becomes a Task Graph `events` row (with dedup).
    // For COL-0.3, stdout proves the webhook round-trip completed.
    const body = await c.req
      .json<{ object_kind?: string }>()
      .catch((): { object_kind?: string } => ({}));
    console.log(
      JSON.stringify({
        event_kind: eventKind,
        event_uuid: eventUuid,
        object_kind: body.object_kind,
        at: new Date().toISOString(),
      }),
    );

    return c.json(
      { accepted: true, event_kind: eventKind, event_uuid: eventUuid },
      200,
    );
  });

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Colony Webhook Dispatcher", version: "0.0.0" },
  });

  return app;
}
