import { serve } from "@hono/node-server";
import { env } from "@colony/config";
import { buildApp } from "./app.js";

const port = env().API_PORT;
const app = buildApp();

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`colony-api listening on http://localhost:${info.port}`);
});
