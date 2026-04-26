import { serve } from "@hono/node-server";
import { env } from "@colony/config";
import { buildApp } from "./app.js";
import { getOAuthAdminDeps } from "./oauth/deps.js";

const port = env().API_PORT;
const app = buildApp({ oauthAdmin: getOAuthAdminDeps() });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`colony-api listening on http://localhost:${info.port}`);
});
