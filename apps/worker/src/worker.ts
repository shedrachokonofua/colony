import { startTelemetryFromEnv } from "@colony/observability";
import { NativeConnection, Worker } from "@temporalio/worker";
import { env } from "@colony/config";
import { activities, initializeAgentRuntime } from "./activities.js";

async function main(): Promise<void> {
  const stopTelemetry = startTelemetryFromEnv("colony-worker");
  const cfg = env();
  await initializeAgentRuntime();
  const tls =
    cfg.TEMPORAL_TLS_SERVER_NAME !== undefined
      ? { serverNameOverride: cfg.TEMPORAL_TLS_SERVER_NAME }
      : cfg.TEMPORAL_TLS;

  const connection = await NativeConnection.connect({
    address: cfg.TEMPORAL_ADDRESS,
    tls,
  });

  const worker = await Worker.create({
    connection,
    namespace: cfg.TEMPORAL_NAMESPACE,
    taskQueue: cfg.TEMPORAL_TASK_QUEUE,
    workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
    activities,
  });

  console.log(
    `colony-worker connected to Temporal at ${cfg.TEMPORAL_ADDRESS}, polling queue "${cfg.TEMPORAL_TASK_QUEUE}"`,
  );

  try {
    await worker.run();
  } finally {
    await stopTelemetry();
  }
}

main().catch((err: unknown) => {
  console.error("colony-worker fatal:", err);
  process.exit(1);
});
