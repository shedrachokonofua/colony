import { instrumentFetch, startTelemetryFromEnv } from "@colony/observability";
import { serve } from "@hono/node-server";
import { env } from "@colony/config";
import { buildApp } from "./app.js";

startTelemetryFromEnv("colony-tool-gateway");

const port = env().TOOL_GATEWAY_PORT;
const app = buildApp();

serve(
  {
    fetch: instrumentFetch("colony-tool-gateway", app.fetch),
    port,
  },
  (info) => {
    console.log(
      `colony-tool-gateway listening on http://localhost:${info.port}`,
    );
  },
);
