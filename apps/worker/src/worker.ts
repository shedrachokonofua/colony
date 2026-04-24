import { NativeConnection, Worker } from "@temporalio/worker";
import { env } from "@colony/config";

async function main(): Promise<void> {
  const cfg = env();

  const connection = await NativeConnection.connect({
    address: cfg.TEMPORAL_ADDRESS,
  });

  const worker = await Worker.create({
    connection,
    namespace: cfg.TEMPORAL_NAMESPACE,
    taskQueue: cfg.TEMPORAL_TASK_QUEUE,
    workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
  });

  // eslint-disable-next-line no-console
  console.log(
    `colony-worker connected to Temporal at ${cfg.TEMPORAL_ADDRESS}, polling queue "${cfg.TEMPORAL_TASK_QUEUE}"`
  );

  await worker.run();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("colony-worker fatal:", err);
  process.exit(1);
});
