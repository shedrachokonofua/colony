import { NOTIFICATION_SEVERITY_ORDER, type ResolvedNotificationsConfig } from "@colony/config";
import type { AuditRow, Store } from "@colony/core";
import type { Logger } from "../logging.js";
import { SERVICE_ACTOR } from "../context.js";
import { classifyAuditRow, type ClassifyContext } from "./classify.js";
import { createCoalescer } from "./coalesce.js";
import { buildPayload } from "./payload.js";
import { NOTIFICATION_SINKS } from "./sinks.js";
import type { NotificationEvent } from "./types.js";

export const NOTIFIER_CURSOR_KEY = "notifier_cursor";
const DEFAULT_BATCH_SIZE = 100;

export interface NotifierLoop {
  run(): Promise<void>;
}

export function createNotifierLoop(deps: {
  readonly store: Store;
  readonly logger: Logger;
  readonly notifications: ResolvedNotificationsConfig;
  readonly consoleBaseUrl: string;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly batchSize?: number;
}): NotifierLoop {
  const coalescer = deps.notifications.enabled
    ? createCoalescer({
        cooldownS: deps.notifications.cooldownS,
        digestWindowS: deps.notifications.digestWindowS,
      })
    : null;

  const classifyCtx: ClassifyContext = {
    isManualApprovals: (scopeId: string) => {
      const scope = deps.store.getScope(scopeId);
      return scope?.approvals === "manual";
    },
    blockedReason: (taskId: string) => {
      const task = deps.store.getTask(taskId);
      return task?.blocked_reason ?? null;
    },
  };

  const deliverEvent = async (event: NotificationEvent): Promise<void> => {
    if (!deps.notifications.enabled) return;
    const payload = buildPayload(event, deps.consoleBaseUrl);
    const payloadSeverityRank = NOTIFICATION_SEVERITY_ORDER[payload.severity];

    for (const sink of deps.notifications.sinks) {
      const minSeverityRank = NOTIFICATION_SEVERITY_ORDER[sink.minSeverity];
      if (payloadSeverityRank < minSeverityRank) {
        continue;
      }
      const sinkFn = NOTIFICATION_SINKS[sink.kind];
      if (!sinkFn) {
        deps.logger.warn({ kind: sink.kind }, "notifier.unknown_sink_kind");
        continue;
      }
      try {
        await sinkFn(payload, sink, deps.fetchImpl);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        deps.logger.error(
          { sink: sink.kind, url: sink.url, error },
          "notifier.sink_delivery_failed",
        );
      }
    }
  };

  const runPass = async (): Promise<void> => {
    if (!deps.notifications.enabled || !coalescer) return;

    const cursorStr = deps.store.getMetaValue(NOTIFIER_CURSOR_KEY);
    const afterId = cursorStr !== null ? Number.parseInt(cursorStr, 10) : null;
    const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

    const rows: AuditRow[] = deps.store.auditRowsAfter(
      Number.isFinite(afterId) ? afterId : null,
      batchSize,
    );

    const nowFn = deps.now ?? (() => Date.now());

    for (const row of rows) {
      const now = nowFn();
      const event = classifyAuditRow(row, classifyCtx);
      if (event) {
        const { emit, event: finalEvent } = coalescer.offer(event, now);
        if (emit) {
          await deliverEvent(finalEvent);
        }
      }
      deps.store.setMetaValue(NOTIFIER_CURSOR_KEY, String(row.id));
    }

    const dueDigests = coalescer.dueDigests(nowFn());
    for (const digestEvent of dueDigests) {
      await deliverEvent(digestEvent);
    }
  };

  return {
    async run(): Promise<void> {
      try {
        await runPass();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.error({ phase: "notifier", error: message }, "tick.phase_error");
        try {
          deps.store.audit(SERVICE_ACTOR, "tick.phase_error", {
            detail: { phase: "notifier", error: message },
          });
        } catch {
          // audit failure must not break the notifier
        }
      }
    },
  };
}
