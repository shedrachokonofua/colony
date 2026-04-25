import { serve } from "@hono/node-server";
import { env } from "@colony/config";
import { buildApp } from "./app.js";

const cfg = env();
const app = buildApp();

serve({ fetch: app.fetch, port: cfg.WEBHOOK_DISPATCHER_PORT }, (info) => {
  console.log(
    `colony-webhook-dispatcher listening on http://localhost:${info.port} ` +
      `(GitLab should POST to http://${cfg.PUBLIC_HOST}:${info.port}/webhook/gitlab)`,
  );
});
