import { Connection, Client as TemporalClient } from "@temporalio/client";
import { env } from "@colony/config";
import {
  architectRequestedSignal,
  supervisorWorkflowId,
  type ArchitectRequestedSignal,
  type ScopeId,
} from "@colony/workflows";

let cached: TemporalClient | undefined;

async function getClient(): Promise<TemporalClient> {
  if (cached) return cached;
  const cfg = env();
  const tls =
    cfg.TEMPORAL_TLS_SERVER_NAME !== undefined
      ? { serverNameOverride: cfg.TEMPORAL_TLS_SERVER_NAME }
      : cfg.TEMPORAL_TLS;
  const connection = await Connection.connect({
    address: cfg.TEMPORAL_ADDRESS,
    tls,
  });
  cached = new TemporalClient({
    connection,
    namespace: cfg.TEMPORAL_NAMESPACE,
  });
  return cached;
}

/**
 * Operator-intent kickoff: signal the supervisor workflow that the
 * architect should run. signalWithStart guarantees the supervisor exists
 * even for scopes that have never received a provider webhook (UI-only
 * scopes), then routes the request through the same per-scope queue
 * recovery uses. Callers should still write the audit row first — that
 * remains the durable source of truth if Temporal is unreachable.
 */
export async function signalArchitectRequested(input: {
  readonly scope_id: ScopeId;
  readonly payload: ArchitectRequestedSignal;
}): Promise<{ readonly workflow_id: string }> {
  const client = await getClient();
  const workflow_id = supervisorWorkflowId(input.scope_id);
  await client.workflow.signalWithStart("scopeSupervisorWorkflow", {
    workflowId: workflow_id,
    taskQueue: env().TEMPORAL_TASK_QUEUE,
    args: [input.scope_id],
    signal: architectRequestedSignal,
    signalArgs: [input.payload],
  });
  return { workflow_id };
}
