import { Type } from "@oh-my-pi/omptype/typebox";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";

/** One delegated unit of work: a scoped prompt run by a child session. */
export interface SubagentRequest {
  readonly description: string;
  readonly prompt: string;
  /** The absolute cutoff for this child's delegated work. */
  readonly deadline: number;
  /** The child must die with its parent or its own execution budget. */
  readonly signal: AbortSignal;
}

/**
 * Runs a delegated prompt in a child agent session and resolves its final
 * report. The runner supplies the spawner so children inherit the parent
 * run's exact wiring: the same sandbox handle, restricted tool set, broker,
 * and model registry. The SDK's native task tool is NOT used because its
 * child sessions do not inherit customTools or restrictToolNames - a native
 * subagent would receive builtin local-filesystem tools on the daemon.
 */
export type SubagentSpawner = (request: SubagentRequest) => Promise<string>;

export interface SubagentToolBudget {
  /** The parent submission window's absolute cutoff. */
  readonly deadline: number;
  /** Maximum child execution time after admission to the semaphore. */
  readonly timeoutMs: number;
}

/** Cap on concurrently running child sessions per run. */
const MAX_CONCURRENT_SUBAGENTS = 3;

/** Cap on the report size returned into the parent's context. */
const MAX_REPORT_CHARS = 24_000;

interface QueuedSubagent {
  readonly resolve: (admittedAt: number) => void;
  readonly reject: (reason: Error) => void;
  readonly signal: AbortSignal | undefined;
  settled: boolean;
  abortListener?: () => void;
  cutoffTimer?: ReturnType<typeof setTimeout>;
}

const subagentAborted = (): Error => new Error("subagent aborted");
const subagentDeadlineExceeded = (): Error =>
  new Error("subagent delegation deadline exceeded");

/**
 * Colony's `task`: delegate a self-contained unit of work to a subagent that
 * shares this run's workspace and tool set. Multiple calls in one turn run
 * concurrently (bounded); the child's final message is the tool result.
 */
export function createSubagentTool(
  spawn: SubagentSpawner,
  budget: SubagentToolBudget,
): ToolDefinition {
  const parameters = Type.Object(
    {
      description: Type.String({
        description: "Short label for this delegated task (3-8 words).",
        minLength: 1,
      }),
      prompt: Type.String({
        description:
          "Complete, self-contained instructions for the subagent. It shares " +
          "your workspace but none of your conversation - include every " +
          "path, symbol, and acceptance criterion it needs.",
        minLength: 1,
      }),
    },
    { additionalProperties: false },
  );

  let active = 0;
  const waiters: QueuedSubagent[] = [];

  const cleanupWaiter = (waiter: QueuedSubagent): void => {
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.abortListener = undefined;
    }
    if (waiter.cutoffTimer !== undefined) {
      clearTimeout(waiter.cutoffTimer);
      waiter.cutoffTimer = undefined;
    }
  };

  const cancelWaiter = (waiter: QueuedSubagent, reason: Error): void => {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    cleanupWaiter(waiter);
    waiter.reject(reason);
  };

  const dispatch = (): void => {
    while (active < MAX_CONCURRENT_SUBAGENTS && waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiter.settled) continue;
      if (waiter.signal?.aborted) {
        cancelWaiter(waiter, subagentAborted());
        continue;
      }
      if (Date.now() >= budget.deadline) {
        cancelWaiter(waiter, subagentDeadlineExceeded());
        continue;
      }
      waiter.settled = true;
      cleanupWaiter(waiter);
      active += 1;
      waiter.resolve(Date.now());
    }
  };

  const acquire = async (signal: AbortSignal | undefined): Promise<number> => {
    if (signal?.aborted) throw subagentAborted();
    const now = Date.now();
    if (now >= budget.deadline) throw subagentDeadlineExceeded();
    if (active < MAX_CONCURRENT_SUBAGENTS) {
      active += 1;
      return now;
    }

    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const waiter: QueuedSubagent = {
      resolve,
      reject,
      signal,
      settled: false,
    };
    waiter.abortListener = () => cancelWaiter(waiter, subagentAborted());
    waiters.push(waiter);
    if (signal) {
      signal.addEventListener("abort", waiter.abortListener);
      if (signal.aborted) {
        cancelWaiter(waiter, subagentAborted());
        return promise;
      }
    }
    const delay = budget.deadline - Date.now();
    if (delay <= 0) {
      cancelWaiter(waiter, subagentDeadlineExceeded());
    } else if (Number.isFinite(delay)) {
      waiter.cutoffTimer = setTimeout(() => {
        cancelWaiter(waiter, subagentDeadlineExceeded());
      }, delay);
    }
    return promise;
  };

  const release = (): void => {
    active -= 1;
    dispatch();
  };

  return {
    name: "task",
    label: "Delegate to subagent",
    description:
      "Delegate a self-contained sub-task (research, a scoped edit, running " +
      "checks) to a subagent working in this same workspace with the same " +
      "tools. It has no access to this conversation; its final report is " +
      "returned here. Issue several task calls in one turn to parallelize " +
      "independent work.",
    parameters,
    // Custom tools receive (id, params, onUpdate, ctx, signal) - the
    // CustomTool contract - not ToolDefinition's (id, params, signal, ...).
    // The declared type lies; the fifth argument is the turn's abort.
    execute: async (_toolCallId, rawParams, ...runtimeArgs: unknown[]) => {
      const parentSignal = runtimeArgs.find(
        (value): value is AbortSignal => value instanceof AbortSignal,
      );
      const params = rawParams as Omit<SubagentRequest, "signal" | "deadline">;
      const admittedAt = await acquire(parentSignal);
      const childDeadline = Math.min(
        admittedAt + budget.timeoutMs,
        budget.deadline,
      );
      const childController = new AbortController();
      let removeParentAbort = (): void => {};
      if (parentSignal) {
        const onParentAbort = () => {
          childController.abort(subagentAborted());
        };
        if (parentSignal.aborted) {
          onParentAbort();
        } else {
          parentSignal.addEventListener("abort", onParentAbort, { once: true });
          removeParentAbort = () =>
            parentSignal.removeEventListener("abort", onParentAbort);
        }
      }

      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      if (!childController.signal.aborted) {
        const delay = childDeadline - Date.now();
        if (delay <= 0) {
          childController.abort(subagentDeadlineExceeded());
        } else if (Number.isFinite(delay)) {
          deadlineTimer = setTimeout(() => {
            childController.abort(subagentDeadlineExceeded());
          }, delay);
        }
      }

      let removeCancellationListener = (): void => {};
      let report: string;
      try {
        childController.signal.throwIfAborted();
        const spawned = spawn({
          ...params,
          deadline: childDeadline,
          signal: childController.signal,
        });
        const { promise: cancellation, reject: rejectCancellation } =
          Promise.withResolvers<never>();
        const onCancellation = () => {
          const reason = childController.signal.reason;
          rejectCancellation(
            reason instanceof Error ? reason : subagentAborted(),
          );
        };
        childController.signal.addEventListener("abort", onCancellation, {
          once: true,
        });
        removeCancellationListener = () =>
          childController.signal.removeEventListener("abort", onCancellation);
        if (childController.signal.aborted) onCancellation();

        report = await Promise.race([spawned, cancellation]);
        childController.signal.throwIfAborted();
      } finally {
        clearTimeout(deadlineTimer);
        removeCancellationListener();
        removeParentAbort();
        release();
      }
      const text = report.trim() || "(subagent produced no output)";
      return {
        content: [
          {
            type: "text" as const,
            text:
              text.length > MAX_REPORT_CHARS
                ? `${text.slice(0, MAX_REPORT_CHARS)}\n[report truncated]`
                : text,
          },
        ],
        details: { description: params.description },
      };
    },
  };
}
