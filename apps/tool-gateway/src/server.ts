import { serve } from "@hono/node-server";
import { env } from "@colony/config";
import { buildApp } from "./app.js";

const port = env().TOOL_GATEWAY_PORT;
const app = buildApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`colony-tool-gateway listening on http://localhost:${info.port}`);
});
