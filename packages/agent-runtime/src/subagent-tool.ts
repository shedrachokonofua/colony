import { Type } from "@oh-my-pi/omptype/typebox";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";

/** One delegated unit of work: a scoped prompt run by a child session. */
export interface SubagentRequest {
  readonly description: string;
  readonly prompt: string;
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

/** Cap on concurrently running child sessions per run. */
const MAX_CONCURRENT_SUBAGENTS = 3;

/** Cap on the report size returned into the parent's context. */
const MAX_REPORT_CHARS = 24_000;

/**
 * Colony's `task`: delegate a self-contained unit of work to a subagent that
 * shares this run's workspace and tool set. Multiple calls in one turn run
 * concurrently (bounded); the child's final message is the tool result.
 */
export function createSubagentTool(spawn: SubagentSpawner): ToolDefinition {
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
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < MAX_CONCURRENT_SUBAGENTS) {
      active += 1;
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push(() => {
      active += 1;
      resolve();
    });
    return promise;
  };
  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
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
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as SubagentRequest;
      await acquire();
      let report: string;
      try {
        report = await spawn(params);
      } finally {
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
