import { context, type Context } from "@opentelemetry/api";
import type { AgentRunEnvironment } from "./adapter.js";

/**
 * Run `fn` inside the run root's span context when one was bound, so SDK
 * GenAI spans (invoke_agent/chat/execute_tool) nest under it. Without a
 * traceContext this is a plain call — no tracing code path activates.
 *
 * Shared by the run and resume paths: both must nest their prompts under the
 * run's root span, and a resumed segment's span is a FRESH root supplied as
 * `override`, never the trace the pre-restart process was emitting into.
 */
export function inTraceContext<T>(
  environment: AgentRunEnvironment,
  fn: () => T,
  override?: Context,
): T {
  const traceContext = override ?? environment.traceContext;
  return traceContext ? context.with(traceContext, fn) : fn();
}
